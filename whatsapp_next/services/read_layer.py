# Module role: the one cross-direction read layer (backend-plan §3 `read_layer`, §6.1; D-043).
# Outbound (`WhatsApp Log`) and inbound (`WhatsApp Inbound Message`) rows are projected onto one
# common column set and combined with a single `frappe.qb` UNION ALL. Every other module that
# needs "messages regardless of direction" — the Numbers materializer, the picker's known-number
# flag, the conversation drawer, device cards, reports — calls this module; nobody else unions.
#
# Rules: both branches are filtered on the indexed key / device / time columns *before* the
# union (risks R-9); paging is keyset on `(ts, name)`; nothing here writes.

from __future__ import annotations

import datetime as dt
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from typing import Any

import frappe
from frappe import _
from frappe.query_builder.functions import Coalesce, Count, Max, Min
from frappe.utils import add_days, flt, get_datetime, now_datetime
from pypika import Case, Field, Order
from pypika.terms import NullValue, ValueWrapper

from whatsapp_next.services.phone import is_group_or_lid

OUTBOUND = "Outbound"
INBOUND = "Inbound"

# Outbound statuses that count as "sent" on device cards (backend-plan §3 `device_stats`).
SENT_STATUSES: tuple[str, ...] = ("Sent", "Delivered", "Read")
FAILED_STATUSES: tuple[str, ...] = ("Failed",)

# Common columns emitted by both branches (fixed order; the union relies on it).
COLUMNS: tuple[str, ...] = (
	"direction",
	"name",
	"key",
	"device",
	"ts",
	"creation",
	"status",
	"message_type",
	"body",
	"caption",
	"display_name",
	"contact",
	"provider_message_id",
	"attachment",
	"reference_doctype",
	"reference_name",
	# a reaction row names the message it reacts to and who reacted (several people in a group)
	"reaction_to",
	"sender",
	# a sent poll: what the bubble shows before its results are fetched
	"poll_question",
	"poll_options",
	# a received message the sender edited or deleted
	"edited_at",
	"original_body",
	"deleted_at",
	"deleted_by",
	# buttons / a list sent, and a recipient's tap on them
	"interactive",
	"selected_id",
	"quoted_id",
	# a received file not fetched yet (past messages are fetched when opened)
	"media_pending",
)

# `reference_amount`: first present field wins; never stored (backend-plan §3).
AMOUNT_FIELDS: tuple[str, ...] = ("grand_total", "rounded_total", "amount", "total")

# Keys per `IN (...)` clause; keeps statements small on the 5 000-key nightly batches.
IN_CHUNK = 500


@dataclass(frozen=True, slots=True)
class MessageRow:
	"""One message of either direction, as the union emits it."""

	direction: str
	name: str
	key: str | None
	device: str | None
	ts: dt.datetime
	creation: dt.datetime
	status: str | None
	message_type: str | None
	body: str | None
	caption: str | None
	display_name: str | None
	contact: str | None
	provider_message_id: str | None
	attachment: str | None
	reference_doctype: str | None
	reference_name: str | None
	reaction_to: str | None = None
	sender: str | None = None
	poll_question: str | None = None
	poll_options: str | None = None
	edited_at: dt.datetime | None = None
	original_body: str | None = None
	deleted_at: dt.datetime | None = None
	deleted_by: str | None = None
	interactive: str | None = None
	selected_id: str | None = None
	quoted_id: str | None = None
	media_pending: int | None = None

	@property
	def cursor(self) -> str:
		"""Opaque keyset cursor for `conversation(before=...)` / `cross_direction_rows`."""
		return encode_cursor(self.ts, self.name)


@dataclass(frozen=True, slots=True)
class ConversationPage:
	rows: list[MessageRow]
	has_more: bool

	@property
	def next_cursor(self) -> str | None:
		"""The cursor of the next page, or None on the last one."""
		return self.rows[-1].cursor if self.rows and self.has_more else None


@dataclass(slots=True)
class KeyStats:
	"""Per-key aggregates consumed by the Numbers materializer (backend-plan §10)."""

	outbound_count: int = 0
	inbound_count: int = 0
	first_seen: dt.datetime | None = None
	last_seen: dt.datetime | None = None
	last_direction: str | None = None
	last_device: str | None = None
	display_name: str | None = None


@dataclass(frozen=True, slots=True)
class DeviceStats:
	"""Device-card numbers (09 row 3): sent / failed / fail_rate / outbound / inbound / last."""

	device: str
	days: int
	sent: int
	failed: int
	fail_rate: float
	outbound: int
	inbound: int
	last_message_at: dt.datetime | None


# --------------------------------------------------------------------------------------------
# Cursors
# --------------------------------------------------------------------------------------------


def encode_cursor(ts: dt.datetime, name: str) -> str:
	"""A page cursor from a row's time and name (`decode_cursor` reads it back)."""
	return f"{get_datetime(ts).isoformat()}|{name}"


def decode_cursor(cursor: str | dt.datetime | None) -> tuple[dt.datetime, str | None] | None:
	"""Accept an encoded cursor, a datetime or a datetime string; `None` means "from the top"."""
	if cursor is None or cursor == "":
		return None
	if isinstance(cursor, dt.datetime):
		return cursor, None
	text = str(cursor)
	timestamp_text, _sep, name = text.partition("|")
	try:
		parsed = get_datetime(timestamp_text)
	except Exception:
		parsed = None
	if not isinstance(parsed, dt.datetime):
		from whatsapp_next.exceptions import WAValidationError

		frappe.throw(_("Invalid cursor"), WAValidationError)
	return parsed, name or None


# --------------------------------------------------------------------------------------------
# Branch builders
# --------------------------------------------------------------------------------------------


def _null_column(alias: str):
	return NullValue().as_(alias)


def _constant_column(value: str, alias: str):
	return ValueWrapper(value).as_(alias)


def _outbound_key(L):
	# Group recipients are keyed by the JID; everything else by E.164 (phone.key_for).
	return Case().when(L.recipient_type == "Group", L.jid).else_(L.phone_e164)


def _inbound_key(I):
	# Group chats by chat JID; LID senders have no E.164 so fall back to the sender JID.
	return Case().when(I.is_group == 1, I.chat_jid).else_(Coalesce(I.phone_e164, I.sender_jid))


def _outbound_branch(L):
	return frappe.qb.from_(L).select(
		_constant_column(OUTBOUND, "direction"),
		L.name.as_("name"),
		_outbound_key(L).as_("key"),
		L.device.as_("device"),
		L.creation.as_("ts"),
		L.creation.as_("creation"),
		L.status.as_("status"),
		L.message_type.as_("message_type"),
		L.body.as_("body"),
		L.caption.as_("caption"),
		L.display_name.as_("display_name"),
		L.contact.as_("contact"),
		L.provider_message_id.as_("provider_message_id"),
		L.attachment.as_("attachment"),
		L.reference_doctype.as_("reference_doctype"),
		L.reference_name.as_("reference_name"),
		_null_column("reaction_to"),
		_null_column("sender"),
		L.poll_question.as_("poll_question"),
		L.poll_options.as_("poll_options"),
		_null_column("edited_at"),
		_null_column("original_body"),
		_null_column("deleted_at"),
		_null_column("deleted_by"),
		L.interactive.as_("interactive"),
		_null_column("selected_id"),
		L.reply_to_provider_message_id.as_("quoted_id"),
		_null_column("media_pending"),
	)


def _inbound_branch(I):
	return frappe.qb.from_(I).select(
		_constant_column(INBOUND, "direction"),
		I.name.as_("name"),
		_inbound_key(I).as_("key"),
		I.device.as_("device"),
		I.received_at.as_("ts"),
		I.creation.as_("creation"),
		I.command_status.as_("status"),
		I.message_type.as_("message_type"),
		I.body.as_("body"),
		I.caption.as_("caption"),
		I.display_name.as_("display_name"),
		I.contact.as_("contact"),
		I.provider_message_id.as_("provider_message_id"),
		# the platform's link needs this site's credentials, so a browser is never given it
		I.attachment.as_("attachment"),
		_null_column("reference_doctype"),
		_null_column("reference_name"),
		I.reaction_to_provider_message_id.as_("reaction_to"),
		I.sender_jid.as_("sender"),
		_null_column("poll_question"),
		_null_column("poll_options"),
		I.edited_at.as_("edited_at"),
		I.original_body.as_("original_body"),
		I.deleted_at.as_("deleted_at"),
		I.deleted_by.as_("deleted_by"),
		_null_column("interactive"),
		I.selected_option_id.as_("selected_id"),
		I.quoted_provider_message_id.as_("quoted_id"),
		Case()
		.when(I.media_url.notnull() & (I.media_url != "") & I.attachment.isnull(), 1)
		.else_(0)
		.as_("media_pending"),
	)


def _key_condition_outbound(L, keys: list[str]):
	# `phone_e164` is indexed; the JID branch only matters for group/LID keys.
	e164 = [k for k in keys if not is_group_or_lid(k)]
	jids = [k for k in keys if is_group_or_lid(k)]
	key_condition = None
	if e164:
		key_condition = L.phone_e164.isin(e164)
	if jids:
		jid_condition = L.jid.isin(jids)
		key_condition = jid_condition if key_condition is None else (key_condition | jid_condition)
	# The indexed columns only narrow the scan; the row belongs to a key only when its key
	# expression is that key (a group row can carry a member's number in `phone_e164`).
	return None if key_condition is None else key_condition & _outbound_key(L).isin(keys)


def _key_condition_inbound(I, keys: list[str]):
	e164 = [k for k in keys if not is_group_or_lid(k)]
	jids = [k for k in keys if is_group_or_lid(k)]
	key_condition = None
	if e164:
		key_condition = I.phone_e164.isin(e164)
	if jids:
		jid_condition = I.chat_jid.isin(jids) | I.sender_jid.isin(jids)
		key_condition = jid_condition if key_condition is None else (key_condition | jid_condition)
	# A member's message in a group matches `phone_e164` / `sender_jid` but is the group's
	# (keyed by `chat_jid`), and a LID sender with a known number is keyed by that number: without
	# this, a person's 1:1 thread showed their group messages and a LID key's aggregate overwrote
	# the number's counters and last direction.
	return None if key_condition is None else key_condition & _inbound_key(I).isin(keys)


def _apply_filters(query, table, timestamp_column, key_condition, filters: dict[str, Any]):
	"""Shared WHERE for both branches. `key_condition` is the branch-specific key predicate."""
	if key_condition is not None:
		query = query.where(key_condition)
	if filters.get("device"):
		devices = filters["device"]
		query = query.where(
			table.device.isin(list(devices)) if isinstance(devices, list | tuple | set) else table.device == devices
		)
	if filters.get("contact"):
		query = query.where(table.contact == filters["contact"])
	if filters.get("message_type"):
		query = query.where(table.message_type == filters["message_type"])
	if filters.get("from"):
		query = query.where(timestamp_column >= get_datetime(filters["from"]))
	if filters.get("to"):
		query = query.where(timestamp_column <= get_datetime(filters["to"]))
	before = decode_cursor(filters.get("before"))
	if before:
		before_timestamp, before_name = before
		if before_name:
			query = query.where((timestamp_column < before_timestamp) | ((timestamp_column == before_timestamp) & (table.name < before_name)))
		else:
			query = query.where(timestamp_column < before_timestamp)
	return query


def _build_messages_union_query(
	filters: dict[str, Any],
	*,
	keys: list[str] | None = None,
	limit: int | None = None,
	order: Order = Order.desc,
):
	"""Build **the** UNION ALL of both branches with `filters` pushed into each branch.

	`filters["direction"]` restricts to one branch (then no union is built at all — a plain
	query on that table — so callers still get one statement)."""
	log_table = frappe.qb.DocType("WhatsApp Log")
	inbound_message_table = frappe.qb.DocType("WhatsApp Inbound Message")
	direction = filters.get("direction")
	branches = []
	for T, d, ts_col, build, key_cond_for in (
		(log_table, OUTBOUND, log_table.creation, _outbound_branch, _key_condition_outbound),
		(
			inbound_message_table,
			INBOUND,
			inbound_message_table.received_at,
			_inbound_branch,
			_key_condition_inbound,
		),
	):
		if direction not in (None, "", d):
			continue
		key_condition = key_cond_for(T, keys) if keys else None
		if keys and key_condition is None:
			continue  # every requested key is of a kind this branch cannot hold
		branch_query = _apply_filters(build(T), T, ts_col, key_condition, filters)
		if limit:
			# Per-branch ORDER/LIMIT lets each side stop at `limit` rows before the union.
			branch_query = branch_query.orderby(ts_col, order=order).orderby(T.name, order=order).limit(limit)
		branches.append(branch_query)
	if not branches:
		return None
	query = branches[0]
	for b in branches[1:]:
		query = query * b  # pypika: `*` = UNION ALL
	query = query.orderby(Field("ts"), order=order).orderby(Field("name"), order=order)
	if limit:
		query = query.limit(limit)
	return query


def _run_query_as_dicts(query) -> list[dict[str, Any]]:
	if query is None:
		return []
	return query.run(as_dict=True)


def _to_message_row(d: dict[str, Any]) -> MessageRow:
	return MessageRow(**{c: d.get(c) for c in COLUMNS})


# --------------------------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------------------------


def conversation(
	key: str,
	device: str | None = None,
	before: str | dt.datetime | None = None,
	limit: int = 50,
) -> ConversationPage:
	"""Newest-first messages of both directions exchanged with `key` (E.164 or group/LID JID).

	`before` is a `MessageRow.cursor` (or a datetime) for keyset paging; `has_more` tells the
	caller whether another page exists. Used by `api.messages.get_conversation`."""
	if not key:
		return ConversationPage([], False)
	limit = max(1, min(int(limit or 50), 500))
	filters: dict[str, Any] = {"before": before}
	if device:
		filters["device"] = device
	rows = [
		_to_message_row(d)
		for d in _run_query_as_dicts(_build_messages_union_query(filters, keys=[key], limit=limit + 1))
	]
	return ConversationPage(rows[:limit], len(rows) > limit)


def cross_direction_rows(
	filters: dict[str, Any] | None = None, page: dict[str, Any] | None = None
) -> list[MessageRow]:
	"""Generic paged read over both directions for reports and drawers.

	`filters`: `key`/`keys`, `device` (one or many), `contact`, `message_type`, `direction`,
	`from`, `to`, `before` (cursor). `page`: `{"limit": 50, "order": "desc"|"asc"}`."""
	filters = dict(filters or {})
	page = page or {}
	keys = filters.pop("keys", None) or ([filters.pop("key")] if filters.get("key") else None)
	filters.pop("key", None)
	limit = max(1, min(int(page.get("limit") or 50), 1000))
	order = Order.asc if str(page.get("order", "desc")).lower() == "asc" else Order.desc
	return [
		_to_message_row(d)
		for d in _run_query_as_dicts(
			_build_messages_union_query(filters, keys=list(keys) if keys else None, limit=limit, order=order)
		)
	]


def iter_keys_since(
	watermark: dt.datetime | str | None,
	upper: dt.datetime | str | None = None,
	batch: int = 5000,
) -> Iterator[set[str]]:
	"""Yield sets of keys of messages created in `(watermark, upper]`, `batch` rows at a time.

	Keyset on `(creation, name)` across both tables via the union, ascending, so a run can be
	resumed by the Numbers nightly job (backend-plan §10). An empty `watermark` means everything."""
	upper = get_datetime(upper) if upper else now_datetime()
	# First pass: strictly after the watermark; later passes: keyset after the last (creation, name).
	cursor: tuple[dt.datetime, str | None] | None = (get_datetime(watermark), None) if watermark else None
	batch = max(1, int(batch))
	log_table = frappe.qb.DocType("WhatsApp Log")
	inbound_message_table = frappe.qb.DocType("WhatsApp Inbound Message")
	while True:
		branches = []
		for T in (log_table, inbound_message_table):
			branch_query = (
				frappe.qb.from_(T)
				.select(
					(_outbound_key(T) if T is log_table else _inbound_key(T)).as_("key"),
					T.creation.as_("creation"),
					T.name.as_("name"),
				)
				.where(T.creation <= upper)
			)
			if cursor:
				cursor_timestamp, c_name = cursor
				if c_name:
					branch_query = branch_query.where(
						(T.creation > cursor_timestamp)
						| ((T.creation == cursor_timestamp) & (T.name > c_name))
					)
				else:
					branch_query = branch_query.where(T.creation > cursor_timestamp)
			branches.append(branch_query.orderby(T.creation).orderby(T.name).limit(batch))
		query = (branches[0] * branches[1]).orderby(Field("creation")).orderby(Field("name")).limit(batch)
		rows = query.run(as_dict=True)
		if not rows:
			return
		yield {r["key"] for r in rows if r.get("key")}
		last = rows[-1]
		cursor = (get_datetime(last["creation"]), last["name"])
		if len(rows) < batch:
			return


def _split_keys_into_chunks(values: Iterable[str]) -> Iterator[list[str]]:
	items = sorted({v for v in values if v})
	for i in range(0, len(items), IN_CHUNK):
		yield items[i : i + IN_CHUNK]


def known_keys(keys: Iterable[str]) -> set[str]:
	"""Subset of `keys` that has at least one message in either direction (picker `known_count`)."""
	found: set[str] = set()
	log_table = frappe.qb.DocType("WhatsApp Log")
	inbound_message_table = frappe.qb.DocType("WhatsApp Inbound Message")
	for chunk in _split_keys_into_chunks(keys):
		key_condition = _key_condition_outbound(log_table, chunk)
		if key_condition is not None:
			found |= {
				r[0]
				for r in frappe.qb.from_(log_table)
				.select(_outbound_key(log_table))
				.distinct()
				.where(key_condition)
				.run()
			}
		key_condition = _key_condition_inbound(inbound_message_table, chunk)
		if key_condition is not None:
			found |= {
				r[0]
				for r in frappe.qb.from_(inbound_message_table)
				.select(_inbound_key(inbound_message_table))
				.distinct()
				.where(key_condition)
				.run()
			}
	return found & {k for k in keys if k}


def stats_by_key(keys: Iterable[str]) -> dict[str, KeyStats]:
	"""Grouped COUNT/MIN/MAX per key and direction, joined in Python, plus the latest row's
	device / display name (backend-plan §10 `refresh_keys`). Keys without messages are absent."""
	out: dict[str, KeyStats] = {}
	log_table = frappe.qb.DocType("WhatsApp Log")
	inbound_message_table = frappe.qb.DocType("WhatsApp Inbound Message")
	for chunk in _split_keys_into_chunks(keys):
		latest: dict[str, tuple[dt.datetime, str]] = {}  # key -> (max_ts, direction)
		for T, direction, ts_col, cond in (
			(log_table, OUTBOUND, log_table.creation, _key_condition_outbound(log_table, chunk)),
			(
				inbound_message_table,
				INBOUND,
				inbound_message_table.received_at,
				_key_condition_inbound(inbound_message_table, chunk),
			),
		):
			if cond is None:
				continue
			key_expr = _outbound_key(T) if T is log_table else _inbound_key(T)
			grouped = (
				frappe.qb.from_(T)
				.select(
					key_expr.as_("key"),
					Count("*").as_("n"),
					Min(ts_col).as_("first"),
					Max(ts_col).as_("last"),
				)
				.where(cond)
				.groupby(key_expr)
				.run(as_dict=True)
			)
			maxima: dict[str, dt.datetime] = {}
			for grouped_row in grouped:
				if not grouped_row["key"]:
					continue
				key_stats = out.setdefault(grouped_row["key"], KeyStats())
				if direction == OUTBOUND:
					key_stats.outbound_count = int(grouped_row["n"])
				else:
					key_stats.inbound_count = int(grouped_row["n"])
				first, last = get_datetime(grouped_row["first"]), get_datetime(grouped_row["last"])
				key_stats.first_seen = (
					first
					if key_stats.first_seen is None or first < key_stats.first_seen
					else key_stats.first_seen
				)
				key_stats.last_seen = (
					last if key_stats.last_seen is None or last > key_stats.last_seen else key_stats.last_seen
				)
				maxima[grouped_row["key"]] = last
				if grouped_row["key"] not in latest or last >= latest[grouped_row["key"]][0]:
					latest[grouped_row["key"]] = (last, direction)
			if not maxima:
				continue
			# Detail rows for the latest message per key: device + display name. A group's
			# conversation is named after the group, not after whoever wrote last in it.
			name_expr = (
				Case().when(T.is_group == 1, Coalesce(T.group_name, T.display_name)).else_(T.display_name)
				if T is inbound_message_table and _has_group_name()
				else T.display_name
			)
			detail = (
				frappe.qb.from_(T)
				.select(
					key_expr.as_("key"),
					ts_col.as_("ts"),
					T.device.as_("device"),
					name_expr.as_("display_name"),
				)
				.where(cond & ts_col.isin(sorted(set(maxima.values()))))
				.run(as_dict=True)
			)
			for d in detail:
				key = d["key"]
				if key in maxima and get_datetime(d["ts"]) == maxima[key]:
					key_stats = out[key]
					if latest.get(key, (None, None))[1] == direction:
						key_stats.last_device = d["device"] or key_stats.last_device
					if direction == INBOUND and d["display_name"]:
						key_stats.display_name = d["display_name"]
					elif direction == OUTBOUND and d["display_name"] and not key_stats.display_name:
						key_stats.display_name = d["display_name"]
		for key, (_ts, direction) in latest.items():
			out[key].last_direction = direction
	return out


def _has_group_name() -> bool:
	"""`WhatsApp Inbound Message.group_name` exists on this site: the code is shared by every site
	of a bench, and one not migrated yet must keep naming its conversations as before."""
	if not hasattr(frappe.local, "wa_has_group_name"):
		frappe.local.wa_has_group_name = frappe.db.has_column("WhatsApp Inbound Message", "group_name")
	return frappe.local.wa_has_group_name


def device_stats(device: str, days: int = 30) -> DeviceStats:
	"""Counts for one device card over the last `days` (backend-plan §3 / 09 row 3)."""
	days = max(1, int(days or 30))
	since = add_days(now_datetime(), -days)
	log_table = frappe.qb.DocType("WhatsApp Log")
	inbound_message_table = frappe.qb.DocType("WhatsApp Inbound Message")
	out_rows = (
		frappe.qb.from_(log_table)
		.select(log_table.status.as_("status"), Count("*").as_("n"), Max(log_table.creation).as_("last"))
		.where((log_table.device == device) & (log_table.creation >= since))
		.groupby(log_table.status)
		.run(as_dict=True)
	)
	in_row = (
		frappe.qb.from_(inbound_message_table)
		.select(Count("*").as_("n"), Max(inbound_message_table.received_at).as_("last"))
		.where((inbound_message_table.device == device) & (inbound_message_table.received_at >= since))
		.run(as_dict=True)
	)[0]
	outbound = sum(int(r["n"]) for r in out_rows)
	sent = sum(int(r["n"]) for r in out_rows if r["status"] in SENT_STATUSES)
	failed = sum(int(r["n"]) for r in out_rows if r["status"] in FAILED_STATUSES)
	attempted = sent + failed
	lasts = [get_datetime(r["last"]) for r in out_rows if r["last"]]
	if in_row.get("last"):
		lasts.append(get_datetime(in_row["last"]))
	return DeviceStats(
		device=device,
		days=days,
		sent=sent,
		failed=failed,
		fail_rate=round(failed / attempted, 4) if attempted else 0.0,
		outbound=outbound,
		inbound=int(in_row.get("n") or 0),
		last_message_at=max(lasts) if lasts else None,
	)


def reference_amount(doctype: str | None, name: str | None) -> float | None:
	"""Amount of the referenced document (first of `grand_total`, `rounded_total`, `amount`,
	`total` the DocType has), for template context and drawers. Never stored."""
	if not doctype or not name or not frappe.db.exists("DocType", doctype):
		return None
	meta = frappe.get_meta(doctype)
	fields = [f for f in AMOUNT_FIELDS if meta.has_field(f)]
	if not fields:
		return None
	values = frappe.db.get_value(doctype, name, fields, as_dict=True)
	if not values:
		return None
	for f in fields:
		if values.get(f) is not None:
			return flt(values[f])
	return None
