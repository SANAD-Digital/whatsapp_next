# Module role: ContactPicker backend (backend-plan §3 `picker.py`, §4.7; screens spec §3.2).
# Six sources produce rows of one shape `{phone, phone_e164, display_name, contact, source_type,
# source_doctype, source_name, valid, error}`; `preview` compares them with the target child
# table (Campaign recipients / Contact Group members) and `commit_add` / `commit_remove` write
# in bulk with an audit row. Every phone goes through `phone.normalize`; duplicates are decided
# on `phone_e164` only.

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, now_datetime

from whatsapp_next.exceptions import WAFileError, WAPermissionError, WAStateConflictError, WAValidationError
from whatsapp_next.services import attachments, audit, permissions, read_layer
from whatsapp_next.services.phone import classify, normalize

SOURCES = (
	("Contact Group", "Contact Groups"),
	("Contact", "Contacts"),
	("DocType", "System screen"),
	("Excel", "Excel upload"),
	("vCard", "Phone export (vCard / CSV)"),
	("Manual", "Manual entry"),
)
SOURCE_TYPES = frozenset(k for k, _l in SOURCES)
TARGETS = {
	"WhatsApp Campaign": ("recipients", "WhatsApp Campaign Recipient"),
	"WhatsApp Contact Group": ("members", "WhatsApp Contact Group Member"),
}
MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_UPLOAD_ROWS = 20_000
MAX_PAGE = 200

_PHONE_HEADER = re.compile(r"(phone|mobile|whatsapp|tel|cell|جوال|هاتف|رقم|واتس)", re.IGNORECASE)
_NAME_HEADER = re.compile(r"(^name$|full.?name|customer|contact|الاسم|اسم|العميل)", re.IGNORECASE)


@dataclass
class ParseResult:
	rows: list[dict[str, Any]] = field(default_factory=list)
	invalid: list[dict[str, Any]] = field(default_factory=list)
	columns: list[str] = field(default_factory=list)
	total: int = 0

	def as_dict(self) -> dict[str, Any]:
		return {"rows": self.rows, "invalid": self.invalid, "columns": self.columns, "total": self.total}


@dataclass
class Preview:
	available: list[dict[str, Any]] = field(default_factory=list)
	already_added: list[dict[str, Any]] = field(default_factory=list)
	invalid: list[dict[str, Any]] = field(default_factory=list)
	duplicates_in_selection: list[dict[str, Any]] = field(default_factory=list)
	known_count: int = 0

	def as_dict(self) -> dict[str, Any]:
		return dict(self.__dict__)


# ---- rows --------------------------------------------------------------------------------


def make_row(
	phone: Any,
	display_name: str | None = None,
	*,
	contact: str | None = None,
	source_type: str | None = "Manual",
	source_doctype: str | None = None,
	source_name: str | None = None,
) -> dict[str, Any]:
	"""Normalize one candidate into the common row shape (`valid=False` + `error` when bad).
	`source_type=None` leaves it for `commit_add` to fill from its argument."""
	raw = str(phone or "").strip()
	kind, key = classify(raw) if raw else (None, None)
	row = {
		"phone": raw or None,
		"phone_e164": key,
		"display_name": (display_name or "").strip() or None,
		"contact": contact,
		"source_type": source_type,
		"source_doctype": source_doctype,
		"source_name": source_name,
		"valid": bool(kind),
		"error": None if kind else (_("Invalid phone number") if raw else _("Missing phone number")),
	}
	if kind and kind != "Individual":
		row["recipient_type"] = "Group"
	return row


def _page(page, page_length) -> tuple[int, int]:
	length = min(max(cint(page_length) or 20, 1), MAX_PAGE)
	return (max(cint(page) or 1, 1) - 1) * length, length


# ---- sources -----------------------------------------------------------------------------


def list_sources(target_doctype: str | None = None) -> list[dict[str, Any]]:
	"""Sources with enablement (source 3 lists the enabled Picker Sources; 5 lists vcf/csv)."""
	settings = frappe.get_cached_doc("WhatsApp Settings")
	doctypes = [
		{"document_type": r.document_type, "label": r.label or r.document_type}
		for r in settings.get("picker_sources") or []
		if cint(r.enabled)
	]
	out = []
	for key, label in SOURCES:
		entry: dict[str, Any] = {"key": key, "label": _(label), "enabled": True}
		if key == "DocType":
			entry["doctypes"] = doctypes
			entry["enabled"] = bool(doctypes)
		if key == "vCard":
			entry["kinds"] = ["vcf", "csv"]
		if key == "Excel":
			entry["kinds"] = ["excel"]
		out.append(entry)
	return out


def search_groups(
	txt: str | None = None,
	kind: str | None = None,
	exclude: str | None = None,
	page: int = 1,
	page_length: int = 20,
) -> dict[str, Any]:
	"""Source 1: Contact Groups by name (optionally by kind), excluding one group (the target)."""
	filters: dict[str, Any] = {"disabled": 0}
	if kind:
		filters["kind"] = kind
	if exclude:
		filters["name"] = ("!=", exclude)
	if txt:
		filters["group_name"] = ("like", f"%{txt.strip()}%")
	start, length = _page(page, page_length)
	rows = frappe.get_all(
		"WhatsApp Contact Group",
		filters=filters,
		fields=["name", "kind", "member_count", "description"],
		order_by="group_name asc",
		start=start,
		page_length=length,
	)
	return {"rows": rows, "total": frappe.db.count("WhatsApp Contact Group", filters)}


def get_group_members(group: str, page: int = 1, page_length: int = 50) -> dict[str, Any]:
	"""Source 1: members of one group as picker rows."""
	if not frappe.has_permission("WhatsApp Contact Group", "read", doc=group):
		frappe.throw(_("Not permitted"), WAPermissionError)
	start, length = _page(page, page_length)
	filters = {"parent": group, "parenttype": "WhatsApp Contact Group"}
	members = frappe.get_all(
		"WhatsApp Contact Group Member",
		filters=filters,
		fields=["phone", "phone_e164", "display_name", "contact"],
		order_by="idx asc",
		start=start,
		page_length=length,
	)
	rows = [
		make_row(
			m.phone_e164 or m.phone,
			m.display_name,
			contact=m.contact,
			source_type="Contact Group",
			source_doctype="WhatsApp Contact Group",
			source_name=group,
		)
		for m in members
	]
	return {"rows": rows, "total": frappe.db.count("WhatsApp Contact Group Member", filters)}


def search_contacts(
	txt: str | None = None, link_doctype: str | None = None, page: int = 1, page_length: int = 20
) -> list[dict[str, Any]]:
	"""Source 2: contacts through the contextual layer; one row per WhatsApp phone."""
	if link_doctype:
		found = permissions.list_contacts(
			search=txt, link_doctype=link_doctype, page=page, page_length=page_length
		)["rows"]
	else:
		found = permissions.search_contacts(txt, page=page, page_length=page_length)
	rows = []
	for c in found:
		phones = [p for p in c.get("phone_nos") or [] if p.get("wa_phone_e164")]
		if not phones:
			rows.append(
				{
					**make_row(
						None,
						c.get("full_name"),
						contact=c["name"],
						source_type="Contact",
						source_doctype="Contact",
						source_name=c["name"],
					),
					"error": _("Contact has no phone number"),
				}
			)
			continue
		primary = next((p for p in phones if cint(p.get("is_primary_mobile_no"))), phones[0])
		rows.append(
			make_row(
				primary["wa_phone_e164"],
				c.get("full_name"),
				contact=c["name"],
				source_type="Contact",
				source_doctype="Contact",
				source_name=c["name"],
			)
		)
	return rows


def list_doctype_rows(
	document_type: str, filters: Any = None, page: int = 1, page_length: int = 50
) -> dict[str, Any]:
	"""Source 3: rows of an enabled picker DocType through the contextual layer."""
	result = permissions.list_doctype_rows(document_type, filters, page=page, page_length=page_length)
	rows = [
		make_row(
			r.get("phone"),
			r.get("label"),
			contact=r.get("contact"),
			source_type="DocType",
			source_doctype=document_type,
			source_name=r["name"],
		)
		for r in result["rows"]
	]
	return {"rows": rows, "total": len(rows), "page": result["page"], "page_length": result["page_length"]}


def parse_manual(text: str | None) -> ParseResult:
	"""Source 6: one per line, `phone`, `name;phone`, `name,phone` or `phone name`."""
	result = ParseResult()
	for line in (text or "").splitlines():
		line = line.strip()
		if not line:
			continue
		name = None
		phone = line
		for sep in (";", ",", "\t"):
			if sep in line:
				a, b = (p.strip() for p in line.split(sep, 1))
				name, phone = (a, b) if normalize(b) else (b, a)
				break
		else:
			parts = line.split()
			if len(parts) > 1:
				if normalize(parts[0]):
					phone, name = parts[0], " ".join(parts[1:])
				elif normalize(parts[-1]):
					phone, name = parts[-1], " ".join(parts[:-1])
		row = make_row(phone, name, source_type="Manual")
		(result.rows if row["valid"] else result.invalid).append(row)
	result.total = len(result.rows) + len(result.invalid)
	return result


# ---- uploads -----------------------------------------------------------------------------


def _upload_bytes(file_url: str) -> bytes:
	meta = attachments.file_meta(file_url)
	if not meta["is_private"]:
		frappe.throw(_("Upload the file as a private file"), WAFileError)
	owner = frappe.db.get_value("File", {"file_url": file_url}, "owner")
	if owner != frappe.session.user and not frappe.has_permission(
		"File", "write", doc=frappe.db.get_value("File", {"file_url": file_url}, "name")
	):
		frappe.throw(_("You can only import files you uploaded"), WAPermissionError)
	if (meta["size"] or 0) > MAX_UPLOAD_BYTES:
		frappe.throw(_("File is larger than {0} MB").format(MAX_UPLOAD_BYTES // (1024 * 1024)), WAFileError)
	return attachments.as_bytes(file_url)


def _guess_columns(columns: list[str]) -> tuple[str | None, str | None]:
	phone = next((c for c in columns if _PHONE_HEADER.search(str(c))), None)
	name = next((c for c in columns if c != phone and _NAME_HEADER.search(str(c))), None)
	return phone, name


def _tabular(
	records: list[dict[str, Any]], columns: list[str], mapping: dict[str, str] | None, source_type: str
) -> ParseResult:
	result = ParseResult(columns=columns)
	mapping = mapping or {}
	phone_col = mapping.get("phone") or _guess_columns(columns)[0]
	name_col = mapping.get("name") or _guess_columns(columns)[1]
	if not phone_col or phone_col not in columns:
		frappe.throw(_("Choose the column that holds the phone number"), WAValidationError)
	if len(records) > MAX_UPLOAD_ROWS:
		frappe.throw(_("The file has more than {0} rows").format(MAX_UPLOAD_ROWS), WAFileError)
	for rec in records:
		row = make_row(
			rec.get(phone_col), str(rec.get(name_col) or "") if name_col else None, source_type=source_type
		)
		(result.rows if row["valid"] else result.invalid).append(row)
	result.total = len(records)
	return result


def parse_excel(file_url: str, mapping: dict[str, str] | None = None) -> ParseResult:
	"""Source 4: first sheet, first row = headers; `mapping = {phone: <col>, name: <col>}`."""
	try:
		import openpyxl
	except ImportError as exc:
		raise WAFileError(_("Excel import needs the openpyxl package")) from exc
	content = _upload_bytes(file_url)
	try:
		wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
	except Exception as exc:
		frappe.throw(_("Cannot read the Excel file: {0}").format(str(exc)[:120]), WAFileError)
	ws = wb.worksheets[0]
	rows_iter = ws.iter_rows(values_only=True)
	header = next(rows_iter, None) or ()
	columns = [str(h).strip() if h is not None else f"col{i + 1}" for i, h in enumerate(header)]
	records = []
	for values in rows_iter:
		if values is None or all(v in (None, "") for v in values):
			continue
		records.append({columns[i]: values[i] for i in range(min(len(columns), len(values)))})
		if len(records) > MAX_UPLOAD_ROWS:
			break
	return _tabular(records, columns, mapping, "Excel")


def parse_csv(file_url: str, mapping: dict[str, str] | None = None) -> ParseResult:
	"""Source 5 (CSV phone export)."""
	content = _upload_bytes(file_url)
	text = content.decode("utf-8-sig", errors="replace")
	reader = csv.DictReader(io.StringIO(text))
	columns = [c.strip() for c in reader.fieldnames or []]
	records = []
	for rec in reader:
		records.append({(k or "").strip(): v for k, v in rec.items()})
		if len(records) > MAX_UPLOAD_ROWS:
			break
	return _tabular(records, columns, mapping, "vCard")


def parse_vcard(file_url: str) -> ParseResult:
	"""Source 5 (vCard phone export): `FN` + every `TEL` (one row per number)."""
	try:
		import vobject
	except ImportError as exc:
		raise WAFileError(_("vCard import needs the vobject package")) from exc
	content = _upload_bytes(file_url).decode("utf-8", errors="replace")
	result = ParseResult(columns=["FN", "TEL"])
	count = 0
	try:
		components = list(vobject.readComponents(content))
	except Exception as exc:
		frappe.throw(_("Cannot read the vCard file: {0}").format(str(exc)[:120]), WAFileError)
	for card in components:
		name = getattr(getattr(card, "fn", None), "value", None)
		tels = [t.value for t in getattr(card, "tel_list", [])] if hasattr(card, "tel_list") else []
		if not tels:
			result.invalid.append(
				{**make_row(None, name, source_type="vCard"), "error": _("No phone number")}
			)
			count += 1
			continue
		for tel in tels:
			row = make_row(tel, name, source_type="vCard")
			(result.rows if row["valid"] else result.invalid).append(row)
			count += 1
		if count > MAX_UPLOAD_ROWS:
			frappe.throw(_("The file has more than {0} contacts").format(MAX_UPLOAD_ROWS), WAFileError)
	result.total = count
	return result


def parse_upload(file_url: str, kind: str, mapping: dict[str, str] | None = None) -> ParseResult:
	"""Dispatch on `kind ∈ excel | csv | vcf`."""
	kind = (kind or "").lower()
	if kind == "excel":
		return parse_excel(file_url, mapping)
	if kind == "csv":
		return parse_csv(file_url, mapping)
	if kind == "vcf":
		return parse_vcard(file_url)
	frappe.throw(_("Unknown upload kind {0}").format(kind), WAValidationError)


# ---- targets -----------------------------------------------------------------------------


def _target(target_doctype: str, target_name: str, ptype: str = "write"):
	if target_doctype not in TARGETS:
		frappe.throw(_("Unsupported picker target {0}").format(target_doctype), WAValidationError)
	if not frappe.db.exists(target_doctype, target_name):
		frappe.throw(_("{0} {1} not found").format(_(target_doctype), target_name), WAValidationError)
	if not frappe.has_permission(target_doctype, ptype, doc=target_name):
		frappe.throw(_("Not permitted to change {0}").format(target_name), WAPermissionError)
	return frappe.get_doc(target_doctype, target_name)


def _existing_keys(doc, child_field: str) -> dict[str, Any]:
	out = {}
	for r in doc.get(child_field) or []:
		if getattr(r, "status", None) == "Removed":
			continue
		if r.phone_e164:
			out[r.phone_e164] = r
	return out


def preview(target_doctype: str, target_name: str, rows: list[dict[str, Any]]) -> Preview:
	"""Classify candidate rows against the target: available / already added / invalid /
	duplicates within the selection; `known_count` from the read layer."""
	doc = _target(target_doctype, target_name, "read")
	child_field, _child_dt = TARGETS[target_doctype]
	existing = _existing_keys(doc, child_field)
	p = Preview()
	seen: set[str] = set()
	for raw in rows or []:
		row = make_row(
			raw.get("phone_e164") or raw.get("phone"),
			raw.get("display_name"),
			contact=raw.get("contact"),
			source_type=raw.get("source_type"),
			source_doctype=raw.get("source_doctype"),
			source_name=raw.get("source_name"),
		)
		if not row["valid"]:
			p.invalid.append(row)
			continue
		key = row["phone_e164"]
		if key in seen:
			p.duplicates_in_selection.append(row)
			continue
		seen.add(key)
		if key in existing:
			p.already_added.append(row)
		else:
			p.available.append(row)
	p.known_count = len(read_layer.known_keys([r["phone_e164"] for r in p.available]))
	return p


def _campaign_guard(doc) -> None:
	if doc.doctype == "WhatsApp Campaign" and doc.status in ("Completed", "Partially Failed", "Cancelled"):
		frappe.throw(
			_("Campaign {0} is {1}; recipients cannot change").format(doc.name, _(doc.status)),
			WAStateConflictError,
		)


def commit_add(
	target_doctype: str,
	target_name: str,
	rows: list[dict[str, Any]],
	source_type: str = "Manual",
	source_ref: str | None = None,
	user: str | None = None,
) -> dict[str, int]:
	"""Append the available rows to the target child table in one save; audited with counts.
	On a Running/Paused campaign the new recipients are materialized by a job."""
	if source_type not in SOURCE_TYPES:
		frappe.throw(_("Unknown source type {0}").format(source_type), WAValidationError)
	doc = _target(target_doctype, target_name, "write")
	_campaign_guard(doc)
	child_field, _child_dt = TARGETS[target_doctype]
	p = preview(target_doctype, target_name, rows)
	now = now_datetime()
	for row in p.available:
		values: dict[str, Any] = {
			"phone": row["phone_e164"],
			"phone_e164": row["phone_e164"],
			"display_name": row["display_name"],
			"contact": row["contact"] or permissions.resolve_contact_by_phone(row["phone_e164"]),
			"source_type": row.get("source_type") or source_type,
			"source_doctype": row.get("source_doctype"),
			"source_name": row.get("source_name"),
		}
		if target_doctype == "WhatsApp Campaign":
			values.update(
				{
					"recipient_type": row.get("recipient_type") or "Individual",
					"jid": row["phone_e164"] if row.get("recipient_type") == "Group" else None,
					"status": "Pending",
					"added_by": user or frappe.session.user,
					"added_at": now,
					"contact_group": source_ref if source_type == "Contact Group" else None,
				}
			)
		else:
			values.update({"added_by": user or frappe.session.user, "added_on": now})
		doc.append(child_field, values)
	if p.available:
		doc.flags.ignore_permissions = True
		if target_doctype == "WhatsApp Campaign":
			from whatsapp_next.services.guards import status_writer

			with status_writer():
				doc.save(ignore_permissions=True)
			frappe.db.set_value(
				"WhatsApp Campaign",
				target_name,
				"added_count",
				cint(doc.added_count) + len(p.available),
				update_modified=False,
			)
			if doc.status in ("Running", "Paused"):
				frappe.enqueue(
					"whatsapp_next.services.campaign_runner.materialize_pending",
					campaign=target_name,
					queue="long",
					job_id=f"wa-campaign-add-{target_name}",
					deduplicate=True,
					enqueue_after_commit=True,
					timeout=3600,
				)
		else:
			doc.save(ignore_permissions=True)
	audit.log(
		"Campaign Recipients Changed"
		if target_doctype == "WhatsApp Campaign"
		else "Contact Group Members Changed",
		reference=(target_doctype, target_name),
		count=len(p.available),
		user=user,
		details={
			"action": "add",
			"source_type": source_type,
			"source_ref": source_ref,
			"skipped_duplicates": len(p.already_added) + len(p.duplicates_in_selection),
			"skipped_invalid": len(p.invalid),
		},
	)
	return {
		"added": len(p.available),
		"skipped_duplicates": len(p.already_added) + len(p.duplicates_in_selection),
		"skipped_invalid": len(p.invalid),
	}


def commit_remove(
	target_doctype: str,
	target_name: str,
	phone_e164s: list[str] | None = None,
	filters: dict[str, Any] | None = None,
	user: str | None = None,
) -> dict[str, int]:
	"""Remove rows by key or by `{source_type, source_ref}`: Group rows are deleted; Campaign
	rows in Running/Paused become `Removed` (their open queue rows are deleted-as-state)."""
	doc = _target(target_doctype, target_name, "write")
	_campaign_guard(doc)
	child_field, _child_dt = TARGETS[target_doctype]
	keys = {normalize(k) or k for k in (phone_e164s or []) if k}
	f = filters or {}
	victims = []
	for r in doc.get(child_field) or []:
		if getattr(r, "status", None) == "Removed":
			continue
		if keys and r.phone_e164 in keys:
			victims.append(r)
		elif (
			f
			and (not f.get("source_type") or r.source_type == f.get("source_type"))
			and (
				not f.get("source_ref")
				or f.get("source_ref") in (r.source_name, getattr(r, "contact_group", None))
			)
		):
			victims.append(r)
	if not victims:
		return {"removed": 0}
	from whatsapp_next.services import dispatch
	from whatsapp_next.services.guards import status_writer

	if target_doctype == "WhatsApp Campaign" and doc.status in ("Running", "Paused", "Queued"):
		outbound = [r.outbound_message for r in victims if r.outbound_message]
		if outbound:
			items = frappe.get_all(
				"WhatsApp Queue Item",
				filters={"outbound_message": ("in", outbound), "status": ("in", ["Queued", "Paused"])},
				pluck="name",
			)
			if items:
				dispatch.delete_items(items, user=user, reason=f"recipient removed from {target_name}")
		with status_writer():
			for r in victims:
				r.status = "Removed"
				r.removed_by = user or frappe.session.user
				r.removed_at = now_datetime()
			doc.flags.ignore_permissions = True
			doc.save(ignore_permissions=True)
		frappe.db.set_value(
			"WhatsApp Campaign",
			target_name,
			"removed_count",
			cint(doc.removed_count) + len(victims),
			update_modified=False,
		)
	else:
		for r in victims:
			doc.remove(r)
		with status_writer():
			doc.flags.ignore_permissions = True
			doc.save(ignore_permissions=True)
	audit.log(
		"Campaign Recipients Changed"
		if target_doctype == "WhatsApp Campaign"
		else "Contact Group Members Changed",
		reference=(target_doctype, target_name),
		count=len(victims),
		user=user,
		details={"action": "remove", "filters": list(f) if f else None},
	)
	return {"removed": len(victims)}
