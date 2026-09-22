# Module role: poll option parsing and result extraction (backend-plan §3 `polls.py`). The
# legacy app parsed options in three places and walked provider result payloads in the
# campaign controller; this module is the single implementation for Templates, Campaign
# messages, Notifications, Quick Send and `api.campaigns.get_poll_results`.

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, cstr

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.providers.schemas import Poll

MIN_OPTIONS = 2
MAX_OPTIONS = 12
MAX_OPTION_LENGTH = 100
MAX_QUESTION_LENGTH = 255
RESULT_BATCH = 100  # provider `get_poll_results` cap (MAX_POLL_IDS)

_SPLIT_RE = re.compile(r"[\n,]")

# Keys (normalized: lower-case, no `_`/`-`/space) recognised in provider result payloads.
_LABEL_KEYS = ("option", "optionname", "name", "text", "title", "label")
_ID_KEYS = ("optionid", "id", "value")
_EXPLICIT_KEYS = frozenset(
	{"selectedoptions", "selectedoptionids", "selectedchoices", "selectedanswers", "selections"}
)
_VOTE_CONTAINER_KEYS = frozenset({"votes", "responses", "answers"})
_TRUTHY_KEYS = frozenset({"selected", "isselected", "voted", "isvoted", "checked"})
_COUNT_KEYS = frozenset({"votecount", "votescount", "totalvotes", "count"})
_LIST_KEYS = frozenset({"votes", "voters", "selectedby", "selections"})


def parse_options(value: Any) -> list[str]:
	"""Options from a JSON list, a list/tuple, or newline / comma separated text.

	Trims, drops empties, de-duplicates case-insensitively keeping first spelling and order."""
	if value is None:
		return []
	if isinstance(value, list | tuple | set):
		raw: list[Any] = list(value)
	else:
		text = cstr(value).strip()
		if not text:
			return []
		try:
			parsed = json.loads(text)
			raw = parsed if isinstance(parsed, list) else _SPLIT_RE.split(text)
		except (TypeError, ValueError):
			raw = _SPLIT_RE.split(text)
	out: list[str] = []
	seen: set[str] = set()
	for item in raw:
		option = cstr(item).strip()
		key = option.casefold()
		if option and key not in seen:
			seen.add(key)
			out.append(option)
	return out


def validate(question: str | None, options: Any, allow_multiple: Any = False) -> Poll:
	"""Validate and build the provider `Poll` (question required, 2–12 options ≤ 100 chars)."""
	q = cstr(question).strip()
	if not q:
		frappe.throw(_("Poll question is required"), WAValidationError)
	if len(q) > MAX_QUESTION_LENGTH:
		frappe.throw(
			_("Poll question is longer than {0} characters").format(MAX_QUESTION_LENGTH), WAValidationError
		)
	opts = parse_options(options)
	if len(opts) < MIN_OPTIONS:
		frappe.throw(_("A poll needs at least {0} distinct options").format(MIN_OPTIONS), WAValidationError)
	if len(opts) > MAX_OPTIONS:
		frappe.throw(_("A poll can have at most {0} options").format(MAX_OPTIONS), WAValidationError)
	too_long = [o for o in opts if len(o) > MAX_OPTION_LENGTH]
	if too_long:
		frappe.throw(
			_("Poll option is longer than {0} characters: {1}").format(MAX_OPTION_LENGTH, too_long[0][:30]),
			WAValidationError,
		)
	return Poll(question=q, options=tuple(opts), allow_multiple=bool(cint(allow_multiple)))


def to_json(options: Any) -> str:
	"""Canonical storage form for `poll_options` JSON fields."""
	return json.dumps(parse_options(options), ensure_ascii=False)


# --------------------------------------------------------------------------------------------
# Result extraction
# --------------------------------------------------------------------------------------------


def _norm_key(key: Any) -> str:
	return re.sub(r"[\s_\-]+", "", cstr(key)).lower()


def _record_value(record: dict, keys: tuple[str, ...]) -> Any:
	wanted = {_norm_key(k) for k in keys}
	for k, v in record.items():
		if _norm_key(k) in wanted and v not in (None, ""):
			return v
	return None


def _label(record: dict) -> str:
	value = _record_value(record, _LABEL_KEYS)
	if isinstance(value, dict):
		return _label(value)
	return cstr(value).strip()


def _option_id(record: dict) -> str:
	return cstr(_record_value(record, _ID_KEYS)).strip()


def _has_vote(record: dict) -> bool:
	for key, value in (record or {}).items():
		n = _norm_key(key)
		if n in _TRUTHY_KEYS and cstr(value).strip().lower() in {"1", "true", "yes"}:
			return True
		if n in _COUNT_KEYS or n in _LIST_KEYS:
			if isinstance(value, list | tuple | dict):
				if len(value) > 0:
					return True
				continue
			try:
				if float(value or 0) > 0:
					return True
			except (TypeError, ValueError):
				pass
	return False


def extract_selected(payload: Any, options: list[str] | tuple[str, ...] | None = None) -> list[str]:
	"""Selected option labels from a provider poll-result payload of any of the shapes the
	platform has used (explicit `selected_options`, per-option `votes`/`selected` flags, id→label
	maps). Ordered like `options` first, then unknown labels as they appeared."""
	label_by_id: dict[str, str] = {}
	tokens: list[str] = []

	def add_explicit(value: Any) -> None:
		if isinstance(value, dict):
			token = _label(value) or _option_id(value)
			if token:
				tokens.append(token)
			else:
				for nested in value.values():
					add_explicit(nested)
		elif isinstance(value, list | tuple | set):
			for nested in value:
				add_explicit(nested)
		elif value not in (None, ""):
			tokens.append(cstr(value).strip())

	def walk(value: Any, parent_key: str = "") -> None:
		if isinstance(value, dict):
			label, oid = _label(value), _option_id(value)
			if label and oid:
				label_by_id[oid] = label
			explicit_ref = bool(_record_value(value, ("option", "option_name", "option_id", "optionId")))
			if (label or oid) and (_has_vote(value) or (parent_key in _VOTE_CONTAINER_KEYS and explicit_ref)):
				tokens.append(label or oid)
			for key, nested in value.items():
				n = _norm_key(key)
				if n in _EXPLICIT_KEYS:
					add_explicit(nested)
				walk(nested, n)
		elif isinstance(value, list | tuple):
			for nested in value:
				walk(nested, parent_key)

	walk(payload)
	selected: list[str] = []
	seen: set[str] = set()
	for token in tokens:
		label = label_by_id.get(cstr(token), cstr(token).strip())
		if label and label.casefold() not in seen:
			seen.add(label.casefold())
			selected.append(label)
	configured = list(options or [])
	by_key = {s.casefold(): s for s in selected}
	ordered = [o for o in configured if o.casefold() in by_key]
	configured_keys = {o.casefold() for o in configured}
	ordered += [s for s in selected if s.casefold() not in configured_keys]
	return ordered


@dataclass
class PollResults:
	"""Aggregated results for one poll definition across many sent messages."""

	options: list[str]
	counts: dict[str, int] = field(default_factory=dict)
	responses: int = 0
	errors: int = 0
	by_poll_id: dict[str, dict[str, Any]] = field(default_factory=dict)

	def as_dict(self) -> dict[str, Any]:
		return {
			"options": self.options,
			"counts": [{"option": o, "count": self.counts.get(o, 0)} for o in self.options],
			"responses": self.responses,
			"errors": self.errors,
			"by_poll_id": self.by_poll_id,
		}


def fetch_results(
	platform_device: str, poll_ids: list[str], options: list[str] | None = None, *, provider=None
) -> PollResults:
	"""Ask the provider for `poll_ids` (batched) and aggregate selected options per option.

	`by_poll_id[poll_id] = {selected: [...], error: str|None, raw: payload}`; provider failures
	for a batch are recorded as errors on each of its ids — never raised."""
	from whatsapp_next.providers import registry

	provider = provider or registry.get_provider()
	options = list(options or [])
	result = PollResults(options=options, counts={o: 0 for o in options})
	ids = list(dict.fromkeys(p for p in poll_ids if p))
	for start in range(0, len(ids), RESULT_BATCH):
		batch = ids[start : start + RESULT_BATCH]
		try:
			payloads = provider.get_poll_results(platform_device, batch) or {}
		except Exception as exc:
			frappe.log_error(title="WhatsApp poll results", message=frappe.get_traceback())
			payloads = {p: {"error": cstr(exc)[:300]} for p in batch}
		for poll_id in batch:
			raw = payloads.get(poll_id)
			if raw is None:
				raw = {"error": _("The provider returned no result for this poll")}
			if isinstance(raw, dict) and raw.get("error") and set(raw) <= {"error", "poll_id", "ok"}:
				result.errors += 1
				result.by_poll_id[poll_id] = {"selected": [], "error": cstr(raw["error"])[:300], "raw": None}
				continue
			selected = extract_selected(raw, options)
			if selected:
				result.responses += 1
			for s in selected:
				result.counts[s] = result.counts.get(s, 0) + 1
			result.by_poll_id[poll_id] = {"selected": selected, "error": None, "raw": raw}
	return result
