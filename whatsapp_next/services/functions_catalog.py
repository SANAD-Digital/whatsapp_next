# Module role: the functions a site offers and the ones it installed (WHATSAPP_NEXT_INTEGRATION §2–§4).
# A function is a Server Script of type API whose method starts with `wa_fn_`, enabled, with a valid
# WA-FUNCTION header — nothing else (no handler in code, no catalog file). Discovery reads those
# scripts (cached by name + modified, cleared when a Server Script is saved); install / update /
# remove keep a `WhatsApp Function` row per installed one: the header's spec as `manifest`, the
# header's sha256 as `manifest_checksum` (a different header is an update), and the site's values
# of its parameters as `values`.

from __future__ import annotations

import json
from typing import Any

import frappe
from frappe import _
from frappe.utils import now_datetime

from whatsapp_next.exceptions import WANotFoundError, WAStateConflictError, WAValidationError
from whatsapp_next.services import audit
from whatsapp_next.services import function_header as fh

_CACHE_KEY = "wa:functions:scripts"
DT = "WhatsApp Function"


# ---- discovery --------------------------------------------------------------------------------


def _scripts() -> list[frappe._dict]:
	return frappe.get_all(
		"Server Script",
		filters={"script_type": "API", "api_method": ("like", f"{fh.API_PREFIX}%"), "disabled": 0},
		fields=["name", "api_method", "script", "modified"],
		order_by="name asc",
	)


def _read(script: frappe._dict) -> dict[str, Any]:
	"""One script as the Functions Center sees it: its spec, or the header error (with its line)."""
	entry: dict[str, Any] = {
		"server_script": script.name,
		"api_method": script.api_method,
		"modified": str(script.modified),
		"spec": None,
		"error": None,
		"checksum": None,
		"guarded": fh.guard_present(script.script),
	}
	try:
		entry["spec"] = fh.parse_function_header(script.script)
		entry["checksum"] = fh.header_checksum(script.script)
	except fh.HeaderError as exc:
		entry["error"] = str(exc)
	return entry


def discover(*, use_cache: bool = True) -> list[dict[str, Any]]:
	"""Every function script on the site, read (and cached per `name + modified`). Two scripts that
	declare the same `@function` are both marked with the error."""
	cache = (frappe.cache.get_value(_CACHE_KEY) or {}) if use_cache else {}
	fresh: dict[str, dict[str, Any]] = {}
	out = []
	for script in _scripts():
		key = f"{script.name}|{script.modified}"
		entry = cache.get(key) or _read(script)
		fresh[key] = entry
		out.append(dict(entry))
	by_key: dict[str, list[dict[str, Any]]] = {}
	for e in out:
		if e["spec"]:
			by_key.setdefault(e["spec"]["function"], []).append(e)
	for key, same in by_key.items():
		if len(same) > 1:
			names = ", ".join(e["server_script"] for e in same)
			for e in same:
				e["error"] = _("Function {0} is declared by more than one script: {1}").format(key, names)
	if use_cache:
		frappe.cache.set_value(_CACHE_KEY, fresh, expires_in_sec=3600)
	return out


def clear_cache(doc=None, method=None) -> None:
	"""Forget the read scripts (doc_event of Server Script: saved or deleted)."""
	frappe.cache.delete_value(_CACHE_KEY)


def script_spec(server_script: str) -> tuple[dict[str, Any], str]:
	"""`(spec, checksum)` of one function script. E: `WANotFoundError`, `WAValidationError`."""
	row = frappe.db.get_value(
		"Server Script",
		server_script,
		["name", "script_type", "api_method", "disabled", "script"],
		as_dict=True,
	)
	if not row:
		frappe.throw(_("Server Script {0} not found").format(server_script), WANotFoundError)
	if row.script_type != "API" or not (row.api_method or "").startswith(fh.API_PREFIX):
		frappe.throw(
			_(
				"Server Script {0} is not a function: it must be an API script whose method starts with {1}"
			).format(server_script, fh.API_PREFIX),
			WAValidationError,
		)
	try:
		return fh.parse_function_header(row.script), fh.header_checksum(row.script)
	except fh.HeaderError as exc:
		frappe.throw(_("Invalid header in {0}: {1}").format(server_script, exc), WAValidationError)


def manifest_of(function: str | Any) -> dict[str, Any]:
	"""The spec saved on an installed function (its `manifest`)."""
	raw = (
		function.manifest if hasattr(function, "manifest") else frappe.db.get_value(DT, function, "manifest")
	)
	if isinstance(raw, dict):
		return raw
	try:
		return json.loads(raw) if raw else {}
	except ValueError:
		return {}


def values_of(function: str | Any) -> dict[str, Any]:
	"""The site's values of an installed function's parameters (its `values`)."""
	raw = function.get("values") if hasattr(function, "get") else frappe.db.get_value(DT, function, "values")
	if isinstance(raw, dict):
		return raw
	try:
		return json.loads(raw) if raw else {}
	except ValueError:
		return {}


# ---- diff ---------------------------------------------------------------------------------------

PARAM_FIELDS = (
	"fieldtype",
	"options",
	"required",
	"source",
	"default",
	"defaults_by_lang",
	"label",
	"select_options",
	"depends_on",
)
REPLY_FIELDS = ("type", "report_name", "format", "label")


def _rows_diff(current: list[dict], target: list[dict], key: str, fields: tuple[str, ...]) -> dict[str, list]:
	cur = {r[key]: r for r in current or []}
	tgt = {r[key]: r for r in target or []}
	changed = []
	for k in cur.keys() & tgt.keys():
		delta = {f: (cur[k].get(f), tgt[k].get(f)) for f in fields if cur[k].get(f) != tgt[k].get(f)}
		if delta:
			changed.append({key: k, "fields": delta})
	return {
		"added": sorted(tgt.keys() - cur.keys()),
		"removed": sorted(cur.keys() - tgt.keys()),
		"changed": changed,
	}


def diff(server_script: str) -> dict[str, Any]:
	"""What installing / updating from `server_script` would change: params, replies, the commands
	bound to the function, and whether the site can run it."""
	spec, checksum = script_spec(server_script)
	key = spec["function"]
	row = frappe.db.get_value(DT, key, ["installed_version", "manifest", "manifest_checksum"], as_dict=True)
	current = manifest_of(key) if row else {}
	available, reasons = fh.function_availability(spec)
	return {
		"function_key": key,
		"server_script": server_script,
		"installed_version": row.installed_version if row else None,
		"target_version": spec.get("version"),
		"changed": bool(not row or row.manifest_checksum != checksum),
		"params": _rows_diff(current.get("params") or [], spec["params"], "name", PARAM_FIELDS),
		"replies": _rows_diff(current.get("replies") or [], spec["replies"], "key", REPLY_FIELDS),
		"commands_impacted": frappe.get_all("WhatsApp Command", filters={"function": key}, pluck="name")
		if row
		else [],
		"available": available,
		"reasons": reasons,
	}


# ---- install / update / remove -----------------------------------------------------------------


def _check_installable(server_script: str, spec: dict[str, Any]) -> None:
	"""Refuse a script the router could not run safely: disabled, not available here, without the
	direct-URL guard, or whose `@function` another script also declares."""
	row = frappe.db.get_value("Server Script", server_script, ["disabled", "script"], as_dict=True)
	if row.disabled:
		frappe.throw(_("Server Script {0} is disabled").format(server_script), WAValidationError)
	available, reasons = fh.function_availability(spec)
	if not available:
		frappe.throw(
			_("Function {0} is not available: {1}").format(spec["function"], "; ".join(reasons)),
			WAValidationError,
		)
	if not fh.guard_present(row.script):
		frappe.throw(
			_(
				"Server Script {0} does not refuse the direct URL: its code must start with the {1} guard"
			).format(server_script, fh.API_PREFIX),
			WAValidationError,
		)
	others = [
		e["server_script"]
		for e in discover(use_cache=False)
		if e["spec"] and e["spec"]["function"] == spec["function"] and e["server_script"] != server_script
	]
	if others:
		frappe.throw(
			_("Function {0} is also declared by {1}").format(spec["function"], ", ".join(others)),
			WAValidationError,
		)


def _apply(doc, server_script: str, spec: dict[str, Any], checksum: str, *, keep_values: bool) -> None:
	"""Write the header onto the function: its names, spec, checksum; values kept for parameters
	that still exist (when `keep_values`), dropped for the ones that do not."""
	doc.server_script = server_script
	doc.function_name = spec.get("title") or spec["function"]
	doc.description = spec.get("description")
	doc.installed_version = spec.get("version") or "0"
	doc.manifest = json.dumps(spec, ensure_ascii=False)
	doc.manifest_checksum = checksum
	doc.update_available = 0
	names = {p["name"] for p in fh.command_params(spec)}
	old = values_of(doc) if keep_values else {}
	kept = {k: v for k, v in old.items() if k in names}
	doc.values = json.dumps(kept, ensure_ascii=False) if kept else None


def install(server_script: str, user: str | None = None) -> str:
	"""Install the function a Server Script declares. E: `WANotFoundError`, `WAValidationError`
	(not a function, header, availability, guard, duplicate key), `WAStateConflictError` (installed)."""
	spec, checksum = script_spec(server_script)
	key = spec["function"]
	if frappe.db.exists(DT, key):
		frappe.throw(_("Function {0} is already installed; use update").format(key), WAStateConflictError)
	_check_installable(server_script, spec)
	doc = frappe.get_doc(
		{
			"doctype": DT,
			"function_key": key,
			"status": "Active",
			"installed_at": now_datetime(),
			"installed_by": user or frappe.session.user,
		}
	)
	_apply(doc, server_script, spec, checksum, keep_values=False)
	doc.insert(ignore_permissions=True)
	audit.log(
		"Function Installed",
		reference=(DT, doc.name),
		user=user,
		details={"version": doc.installed_version, "server_script": server_script},
	)
	return doc.name


def update(function_key: str, user: str | None = None) -> str:
	"""Re-read the function's Server Script: the new header replaces the old, the site's values stay
	for parameters that kept their name. E: `WANotFoundError`, `WAValidationError`."""
	doc = installed(function_key)
	spec, checksum = script_spec(doc.server_script)
	if spec["function"] != doc.function_key:
		frappe.throw(
			_("Server Script {0} now declares function {1}, not {2}").format(
				doc.server_script, spec["function"], doc.function_key
			),
			WAValidationError,
		)
	_check_installable(doc.server_script, spec)
	previous = doc.installed_version
	_apply(doc, doc.server_script, spec, checksum, keep_values=True)
	doc.save(ignore_permissions=True)
	audit.log(
		"Function Updated",
		reference=(DT, doc.name),
		user=user,
		details={"from": previous, "to": doc.installed_version},
	)
	return doc.name


def remove(function_key: str, user: str | None = None) -> None:
	"""Delete the Function row; refused while any command (Active or not) is bound to it — the
	command would point at nothing. E: `WANotFoundError`, `WAStateConflictError`."""
	installed(function_key)
	bound = frappe.get_all("WhatsApp Command", filters={"function": function_key}, pluck="name")
	if bound:
		frappe.throw(
			_("Move or delete commands {0} before removing the function").format(", ".join(bound)), WAStateConflictError
		)
	audit.log("Function Removed", reference=(DT, function_key), user=user)
	frappe.delete_doc(DT, function_key, ignore_permissions=True)


def installed(function_key: str):
	"""The installed `WhatsApp Function` document. E: `WANotFoundError`."""
	if not frappe.db.exists(DT, function_key):
		frappe.throw(_("Function {0} is not installed").format(function_key), WANotFoundError)
	return frappe.get_doc(DT, function_key)


def set_status(function_key: str, status: str) -> str:
	"""Activate / deactivate an installed function; returns the status it now has."""
	doc = installed(function_key)
	if doc.status != status:
		doc.status = status
		doc.save()
	return doc.status


def save_values(function_key: str, values: dict | None) -> dict[str, Any]:
	"""Write the site's values of the function's parameters (not the sender's party). A template
	takes one text or `{language: text}` (`""` for every language). Empty clears to the default.
	E: `WAValidationError` (unknown parameter, wrong value)."""
	doc = installed(function_key)
	spec = manifest_of(doc)
	params = {p["name"]: p for p in fh.command_params(spec)}
	if not isinstance(values, dict):
		frappe.throw(_("values must be an object"), WAValidationError)
	unknown = sorted(set(values) - set(params))
	if unknown:
		frappe.throw(
			_("Unknown parameters of function {0}: {1}").format(function_key, ", ".join(unknown)),
			WAValidationError,
		)
	current = values_of(doc)
	for name, value in values.items():
		p = params[name]
		if p["fieldtype"] == "Template":
			if isinstance(value, dict):
				value = {str(k): str(v) for k, v in value.items() if not fh.is_empty(v)}
			value = value or None
		elif not fh.is_empty(value) and not (p["fieldtype"] == "Date" and isinstance(value, str)):
			try:
				value = fh.coerce(p, value)
			except ValueError as exc:
				frappe.throw(str(exc), WAValidationError)
		if fh.is_empty(value) if not isinstance(value, dict) else not value:
			current.pop(name, None)
		else:
			current[name] = value
	doc.values = json.dumps(current, ensure_ascii=False) if current else None
	doc.save()
	return current


def check_updates() -> dict[str, int]:
	"""Daily (and on demand): flag installed functions whose script's header changed, and the
	ones whose script is gone or no longer a valid function."""
	scripts = {e["server_script"]: e for e in discover(use_cache=False)}
	counts = {"checked": 0, "updates": 0, "missing": 0}
	for row in frappe.get_all(DT, fields=["name", "server_script", "manifest_checksum"]):
		counts["checked"] += 1
		entry = scripts.get(row.server_script)
		if not entry or not entry["spec"]:
			counts["missing"] += 1
			continue
		available = 1 if entry["checksum"] != row.manifest_checksum else 0
		counts["updates"] += available
		frappe.db.set_value(DT, row.name, "update_available", available, update_modified=False)
	return counts


# ---- the Functions Center ----------------------------------------------------------------------


def storefront() -> list[dict[str, Any]]:
	"""Every function script merged with its install state, for the Functions Center. A script
	with an invalid header is listed with its error; an unavailable one with its reasons."""
	rows = {
		r.server_script: r
		for r in frappe.get_all(
			DT,
			fields=[
				"name",
				"server_script",
				"installed_version",
				"status",
				"manifest_checksum",
				"function_name",
			],
		)
	}
	out = []
	for e in discover():
		spec = e["spec"] or {}
		row = rows.pop(e["server_script"], None)
		available, reasons = fh.function_availability(spec) if spec else (False, [])
		state = (
			"invalid"
			if e["error"]
			else "unavailable"
			if not available
			else "update"
			if row and row.manifest_checksum != e["checksum"]
			else "available"
		)
		out.append(
			{
				"function_key": spec.get("function") or (row.name if row else None),
				"function_name": spec.get("title") or (row.function_name if row else e["server_script"]),
				"description": spec.get("description"),
				"version": spec.get("version"),
				"server_script": e["server_script"],
				"party_types": spec.get("party_types"),
				"party_types_text": fh.party_types_text(spec) if spec else None,
				"requires": spec.get("requires") or [],
				"replies": spec.get("replies") or [],
				"state": state,
				"error": e["error"],
				"available": bool(spec) and available,
				"reasons": reasons,
				"guarded": e["guarded"],
				"installed": bool(row),
				"installed_version": row.installed_version if row else None,
				"status": row.status if row else None,
				"update_available": state == "update",
			}
		)
	for row in rows.values():  # installed, but its script is gone or no longer a function
		out.append(
			{
				"function_key": row.name,
				"function_name": row.function_name,
				"server_script": row.server_script,
				"state": "missing",
				"error": _("Server Script {0} is missing, disabled or no longer a function").format(
					row.server_script
				),
				"available": False,
				"reasons": [],
				"installed": True,
				"installed_version": row.installed_version,
				"status": row.status,
				"update_available": False,
				"replies": [],
				"requires": [],
			}
		)
	return sorted(out, key=lambda r: (r["function_name"] or "").casefold())
