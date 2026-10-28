# Module role: message-body rendering (backend-plan §3 `templates.py`). One sandboxed Jinja
# render for Templates, Notifications, Campaign messages and Command outputs. Render errors are
# returned / logged for the caller to store (`Notification.last_error`, Template preview) and
# never raised at send time (legacy finding F2) unless the caller asks with `strict=True`.

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import frappe
from frappe import _
from frappe.utils import cstr, get_url_to_form
from frappe.utils.jinja import validate_template
from jinja2 import TemplateError

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.services.wa_format import tidy_markers

# Fieldtypes offered as `doc.<fieldname>` hints in the editor (layout / table / code excluded).
_HINT_EXCLUDED_TYPES = frozenset(
	{
		"Section Break",
		"Column Break",
		"Tab Break",
		"HTML",
		"Button",
		"Fold",
		"Heading",
		"Table",
		"Table MultiSelect",
		"Code",
		"JSON",
		"Password",
		"Signature",
		"Barcode",
		"Geolocation",
	}
)
# Always-available context names (besides `doc`).
BASE_VARIABLES: tuple[str, ...] = (
	"doc",
	"recipient",
	"now",
	"today",
	"site_url",
	"doc_url",
	"_",
	"frappe.utils",
	"frappe.format_value",
)

_MAX_ERROR = 500


@dataclass(frozen=True)
class RenderResult:
	"""Outcome of a render: `text` is `""` when `error` is set."""

	text: str = ""
	error: str | None = None
	warnings: tuple[str, ...] = field(default_factory=tuple)

	@property
	def ok(self) -> bool:
		"""True when the template rendered without an error."""
		return self.error is None


# Callables a template may use on a Document (`doc`, its child rows). Everything else that is
# callable — `save`, `db_set`, `delete`, `run_method`, `submit` … — would let whoever writes the
# text (an Agent's quick-send body) write the record, so the sandbox refuses it.
_DOC_READ_METHODS = frozenset({"get", "get_formatted", "is_new", "as_dict", "get_title", "get_url"})
# Frappe's safe data utils minus the two that read beyond the message's own data.
_UTILS_EXCLUDED = frozenset({"get_thumbnail_base64_for_image", "get_user_info_for_avatar"})


class SampleDoc(frappe._dict):
	"""`doc` when a preview has no record to read: sample values only, read in a template the way a
	record is read — `get_formatted` gives the value as text, and a field the dict type also names
	(`items`, the usual child table) is the field, not the dict method (see `_message_jenv`)."""

	def get_formatted(self, fieldname, *args, **kwargs):
		value = self.get(fieldname)
		return "" if value is None else cstr(value)


# names a `dict` answers with a method but a record with a field (`doc.items` is a child table)
_FIELD_NOT_METHOD = frozenset({"items", "values", "keys"})


def _message_jenv():
	"""The Jinja environment every message body renders in.

	Frappe's `get_jenv()` hands a template `frappe.get_doc`, `frappe.get_all`, `frappe.db.*`
	(and, unless `disable_render_safe_exec` is set, `frappe.db.set_value`, `frappe.call` …):
	fine for a System Manager's print format, not for a message body an Agent types in quick
	send. A message needs what the documented context gives (`BASE_VARIABLES`): `doc`,
	`recipient`, dates, links, `_`, `frappe.utils` and `frappe.format_value` — nothing that reads
	another record or writes."""
	env = getattr(frappe.local, "wa_message_jenv", None)
	if env is not None:
		return env
	from frappe.model.document import Document
	from frappe.utils.jinja import _get_jenv
	from frappe.utils.safe_exec import SAFE_DATA_UTILS, NamespaceDict

	base = _get_jenv()  # the sandboxed environment and Frappe's filters, before any globals

	class MessageEnvironment(type(base)):
		def is_safe_attribute(self, obj, attr, value):
			if isinstance(obj, Document) and callable(value) and attr not in _DOC_READ_METHODS:
				return False
			return super().is_safe_attribute(obj, attr, value)

		def getattr(self, obj, attribute):
			# a sample's `doc.items` is its child table (empty without sample rows), never dict.items
			if isinstance(obj, SampleDoc) and attribute in _FIELD_NOT_METHOD:
				return obj.get(attribute) or []
			return super().getattr(obj, attribute)

	env = MessageEnvironment(undefined=base.undefined, cache_size=0)
	env.filters = base.filters.copy()
	utils = NamespaceDict({k: v for k, v in SAFE_DATA_UTILS.items() if k not in _UTILS_EXCLUDED})
	env.globals.update(
		frappe=NamespaceDict(utils=utils, format_value=frappe.format_value, format=frappe.format_value, _=_),
		_=_,
	)
	frappe.local.wa_message_jenv = env
	return env


def compile_check(source: str | None) -> list[str]:
	"""Return a list of compile errors (empty when the Jinja source compiles)."""
	if not (source or "").strip():
		return []
	try:
		validate_template(source)
	except frappe.ValidationError as exc:
		return [cstr(exc)[:_MAX_ERROR]]
	except Exception as exc:
		return [f"{type(exc).__name__}: {cstr(exc)[:_MAX_ERROR]}"]
	return []


def render(
	source: str | None, context: dict[str, Any] | None = None, *, strict: bool = False
) -> RenderResult:
	"""Render `source` with Frappe's sandboxed Jinja.

	Returns a `RenderResult`; with `strict=True` a failure raises `WAValidationError` instead
	(used by previews, where the user wants to see the error)."""
	if not (source or "").strip():
		return RenderResult(text="")
	ctx = dict(context or {})
	try:
		# Frappe's sandbox, but with the message globals only (see `_message_jenv`); the raw
		# Jinja exception is kept instead of Frappe's HTML-wrapped ValidationError.
		if ".__" in source:
			raise TemplateError(_("Illegal template"))
		text = _message_jenv().from_string(source).render(ctx)
	except Exception as exc:
		message = f"{type(exc).__name__}: {cstr(exc)}"[:_MAX_ERROR]
		if strict:
			frappe.throw(_("Template render failed: {0}").format(message), WAValidationError)
		return RenderResult(text="", error=message)
	# what the preview shows is what is sent: markers repaired as `dispatch.create_outbound` does
	return RenderResult(text=tidy_markers((text or "").strip()) or "")


def render_text(source: str | None, context: dict[str, Any] | None = None, *, fallback: str = "") -> str:
	"""Convenience: rendered text, or `fallback` on error (never raises)."""
	result = render(source, context)
	return result.text if result.ok else fallback


def _recipient(recipient: dict[str, Any] | None) -> frappe._dict:
	"""The `recipient` a body may name. Its usual fields are always there and never `None`: a
	template saying `{{ recipient.display_name }}` to a number nobody has named must print
	nothing, not the word "None" (which a real customer received, live E2E 2026-10-01)."""
	who = frappe._dict(phone_e164="", display_name="", contact="")
	who.update({k: ("" if v is None else v) for k, v in (recipient or {}).items()})
	return who


def readable_only(doc) -> None:
	"""Drop the values of fields above the caller's permission levels (and mask masked ones), as
	the form does: record-level read is not field-level read."""
	if not isinstance(doc, frappe.model.document.Document):
		return
	doc.apply_fieldlevel_read_permissions()
	# Frappe drops the attribute; a template reading it would print Jinja's "no such element":
	# the hidden value reads as empty instead
	for row in [doc, *(c for t in doc.meta.get_table_fields() for c in doc.get(t.fieldname) or [])]:
		for df in row.meta.fields:
			if df.fieldname and df.fieldtype not in frappe.model.table_fields and not hasattr(row, df.fieldname):
				setattr(row, df.fieldname, "")


def context_for(
	reference_doctype: str | None = None,
	reference_name: str | None = None,
	extra: dict[str, Any] | None = None,
	*,
	doc=None,
	recipient: dict[str, Any] | None = None,
) -> dict[str, Any]:
	"""Build the render context: `doc` (loaded document or a `SampleDoc`), `recipient`
	(`{phone_e164, display_name, contact, ...}`), `now`, `today`, `site_url`, `doc_url` and the
	Frappe Jinja globals (`frappe._`, `frappe.utils`, `frappe.format_value`, ...) come from the
	sandboxed environment itself; the sandbox refuses attribute names starting with `_` on
	non-dict objects, so nothing here shadows them."""
	from frappe.utils import get_url, now_datetime, nowdate

	if doc is None and reference_doctype and reference_name:
		try:
			doc = frappe.get_doc(reference_doctype, reference_name)
		except frappe.DoesNotExistError:
			doc = None
	ctx: dict[str, Any] = {
		"doc": doc if doc is not None else SampleDoc(),
		"recipient": _recipient(recipient),
		"now": now_datetime(),
		"today": nowdate(),
		"site_url": get_url(),
		"doc_url": get_url_to_form(reference_doctype, reference_name)
		if reference_doctype and reference_name
		else "",
	}
	if extra:
		ctx.update(extra)
	return ctx


def sample_context(reference_doctype: str | None, sample_json: str | dict | None = None) -> dict[str, Any]:
	"""Preview context: the latest record of `reference_doctype` the session user can read (if any) overlaid with
	`sample_context` JSON values from the template."""
	import json

	doc = None
	if (
		reference_doctype
		and frappe.db.exists("DocType", reference_doctype)
		and not frappe.get_meta(reference_doctype).issingle
		# a caller who may not read the DocType at all gets the general sample, not an error
		and frappe.has_permission(reference_doctype, "read")
	):
		# the caller's own permissions: a preview must never show a record they cannot read
		latest = frappe.get_list(reference_doctype, pluck="name", order_by="modified desc", limit=1)
		if latest:
			doc = frappe.get_doc(reference_doctype, latest[0])
	extra: dict[str, Any] = {}
	if sample_json:
		try:
			parsed = json.loads(sample_json) if isinstance(sample_json, str) else dict(sample_json)
		except (TypeError, ValueError):
			parsed = {}
		if isinstance(parsed, dict):
			doc_values = parsed.pop("doc", None)
			if isinstance(doc_values, dict):
				if doc is not None:
					# in memory only, never saved: the record keeps its methods and child tables
					doc.update(doc_values)
				else:
					doc = SampleDoc(doc_values)
			extra = parsed
	ctx = context_for(reference_doctype, getattr(doc, "name", None), extra, doc=doc)
	# `context_for` always sets a recipient with blank fields; a sample has nobody, so name one
	if not any((ctx.get("recipient") or {}).values()):
		ctx["recipient"] = frappe._dict(phone_e164="+966500000000", display_name=_("Recipient"))
	return ctx


def variables(reference_doctype: str | None) -> list[str]:
	"""`doc.<fieldname>` hints for the editor, plus the base context names."""
	names = [f"{v}" for v in BASE_VARIABLES]
	if reference_doctype and frappe.db.exists("DocType", reference_doctype):
		meta = frappe.get_meta(reference_doctype)
		names += ["doc.name", "doc.owner", "doc.creation", "doc.modified"]
		names += [
			f"doc.{f.fieldname}"
			for f in meta.fields
			if f.fieldtype not in _HINT_EXCLUDED_TYPES and f.fieldname
		]
		names += [
			f"doc.{t.fieldname}[0].{c.fieldname}"
			for t in meta.get_table_fields()
			for c in frappe.get_meta(t.options).fields[:8]
			if c.fieldtype not in _HINT_EXCLUDED_TYPES and c.fieldname
		]
	return list(dict.fromkeys(names))


_VAR_RE = re.compile(r"{{\s*([a-zA-Z_][\w.]*)")


def referenced_names(source: str | None) -> list[str]:
	"""Top-level names a template references (`{{ doc.x }}` → `doc`), for validation hints."""
	if not source:
		return []
	return list(dict.fromkeys(m.group(1).split(".")[0] for m in _VAR_RE.finditer(source)))
