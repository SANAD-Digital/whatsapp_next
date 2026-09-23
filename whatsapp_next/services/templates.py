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
from frappe.utils.jinja import get_jenv, validate_template
from jinja2 import TemplateError

from whatsapp_next.exceptions import WAValidationError

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
		return self.error is None


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
		# Same sandbox as `frappe.render_template` (SandboxedEnvironment + Frappe globals), but the
		# raw Jinja exception is kept instead of Frappe's HTML-wrapped ValidationError.
		if ".__" in source:
			raise TemplateError(_("Illegal template"))
		text = get_jenv().from_string(source).render(ctx)
	except Exception as exc:
		message = f"{type(exc).__name__}: {cstr(exc)}"[:_MAX_ERROR]
		if strict:
			frappe.throw(_("Template render failed: {0}").format(message), WAValidationError)
		return RenderResult(text="", error=message)
	return RenderResult(text=(text or "").strip())


def render_text(source: str | None, context: dict[str, Any] | None = None, *, fallback: str = "") -> str:
	"""Convenience: rendered text, or `fallback` on error (never raises)."""
	result = render(source, context)
	return result.text if result.ok else fallback


def context_for(
	reference_doctype: str | None = None,
	reference_name: str | None = None,
	extra: dict[str, Any] | None = None,
	*,
	doc=None,
	recipient: dict[str, Any] | None = None,
) -> dict[str, Any]:
	"""Build the render context: `doc` (loaded document or `frappe._dict`), `recipient`
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
		"doc": doc if doc is not None else frappe._dict(),
		"recipient": frappe._dict(recipient or {}),
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
	"""Preview context: the latest record of `reference_doctype` (if any) overlaid with
	`sample_context` JSON values from the template."""
	import json

	doc = None
	if (
		reference_doctype
		and frappe.db.exists("DocType", reference_doctype)
		and not frappe.get_meta(reference_doctype).issingle
	):
		latest = frappe.get_all(
			reference_doctype, pluck="name", order_by="modified desc", limit=1, ignore_permissions=True
		)
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
				base = doc.as_dict() if doc is not None else {}
				base.update(doc_values)
				doc = frappe._dict(base)
			extra = parsed
	ctx = context_for(reference_doctype, getattr(doc, "name", None), extra, doc=doc)
	if not ctx.get("recipient"):  # `context_for` always sets an (empty) recipient; fill the sample one
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
