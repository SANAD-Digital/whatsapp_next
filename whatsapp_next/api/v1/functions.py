# Module role: API of the Functions Center (backend-plan §4.10, screen 7, WHATSAPP_NEXT_INTEGRATION §4):
# the function scripts of the site with their install state, one function's header for the detail and
# its settings form, diff-before-install, install / update / remove, status, the site's values and the
# "Try" run. Thin wrappers over `services/functions_catalog.py` and `services/function_runner.py`.

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import now_datetime

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1 import _bulk
from whatsapp_next.api.v1._roles import MANAGER, VIEWER_UP
from whatsapp_next.services import command_router, function_runner, functions_catalog
from whatsapp_next.services import function_header as fh

STATUS_SCHEMA = {"status": {"enum": ["Active", "Inactive"]}}


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_catalog() -> dict[str, Any]:
	"""`{entries[], checked_at}`: every function script of the site with its state (`available`,
	`unavailable` with reasons, `invalid` with the header error, `update`, `missing`), merged with its
	install state, `commands_count` and `calls_30d`. P: Viewer+."""
	entries = functions_catalog.storefront()
	counts: dict[str, int] = {}
	calls: dict[str, int] = {}
	commands = frappe.get_all("WhatsApp Command", fields=["name", "function"])
	runs = command_router.recent_run_counts([c.name for c in commands], days=30)
	for c in commands:
		counts[c.function] = counts.get(c.function, 0) + 1
		calls[c.function] = calls.get(c.function, 0) + runs.get(c.name, 0)
	for e in entries:
		e["commands_count"] = counts.get(e["function_key"], 0)
		e["calls_30d"] = calls.get(e["function_key"], 0)
	return {"entries": entries, "checked_at": now_datetime()}


def _detail(spec: dict[str, Any], values: dict[str, Any]) -> dict[str, Any]:
	"""A header as the detail and its settings form read it."""
	return {
		"function_key": spec["function"],
		"function_name": spec.get("title") or spec["function"],
		"description": spec.get("description"),
		"version": spec.get("version"),
		"party_types": spec.get("party_types"),
		"party_types_text": fh.party_types_text(spec),
		"requires": spec.get("requires") or [],
		"params": [
			{
				**p,
				"value": values.get(p["name"]),
				"vars": fh.vars_for(spec, p["name"]) if p["fieldtype"] == "Template" else [],
			}
			for p in fh.command_params(spec)
		],
		"sender_params": [p for p in spec.get("params") or [] if p["source"] == "sender"],
		"replies": spec.get("replies") or [],
		"vars": spec.get("vars") or [],
	}


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_manifest(function_key: str | None = None, server_script: str | None = None) -> dict[str, Any]:
	"""One function's header for the detail: an installed function by `function_key` (its saved
	header, with the site's `value` of each parameter and its own figures under `installed`), or a
	script not installed yet by `server_script`. P: Viewer+. E: `WANotFoundError`, `WAValidationError`."""
	if function_key and frappe.db.exists("WhatsApp Function", function_key):
		doc = functions_catalog.installed(function_key)
		spec = functions_catalog.manifest_of(doc)
		out = _detail(spec, functions_catalog.values_of(doc))
		available, reasons = fh.function_availability(spec)
		out.update(
			server_script=doc.server_script,
			available=available,
			reasons=reasons,
			installed={
				"installed_version": doc.installed_version,
				"installed_at": doc.installed_at,
				"installed_by": doc.installed_by,
				"status": doc.status,
				"update_available": bool(doc.update_available),
				"call_count": doc.call_count,
				"avg_ms": doc.avg_ms,
				"error_count": doc.error_count,
				"last_called_at": doc.last_called_at,
				"last_error": doc.last_error,
			},
		)
		return out
	if not server_script:
		frappe.throw(_("Function {0} is not installed").format(function_key or ""), frappe.DoesNotExistError)
	spec, _checksum = functions_catalog.script_spec(server_script)
	out = _detail(spec, {})
	available, reasons = fh.function_availability(spec)
	out.update(server_script=server_script, available=available, reasons=reasons, installed={})
	return out


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def preview_install(server_script: str) -> dict[str, Any]:
	"""What installing / updating from `server_script` changes: `{params{added, removed, changed},
	replies{…}, commands_impacted[], available, reasons[], installed_version, target_version}`.
	P: Manager."""
	return functions_catalog.diff(server_script)


@api_endpoint(roles=MANAGER)
def install(server_script: str) -> dict[str, str]:
	"""Install the function the script declares. P: Manager. E: `WAValidationError` (not a
	function, header, availability, guard, duplicate), `WAStateConflictError` (installed); audited."""
	name = functions_catalog.install(server_script)
	return {
		"name": name,
		"installed_version": frappe.db.get_value("WhatsApp Function", name, "installed_version"),
	}


@api_endpoint(roles=MANAGER)
def update(function_key: str) -> dict[str, str | None]:
	"""Re-read the function's script header; the site's values stay for parameters that kept their
	name. P: Manager. E: `WANotFoundError`, `WAValidationError`; audited `Function Updated`."""
	previous = frappe.db.get_value("WhatsApp Function", function_key, "installed_version")
	name = functions_catalog.update(function_key)
	return {
		"installed_version": frappe.db.get_value("WhatsApp Function", name, "installed_version"),
		"previous_version": previous,
	}


@api_endpoint(roles=MANAGER)
def remove(function_key: str) -> dict[str, bool]:
	"""Delete the installed function. P: Manager. E: `WANotFoundError`, `WAStateConflictError`
	(Active commands); audited `Function Removed`."""
	functions_catalog.remove(function_key)
	return {"removed": True}


@api_endpoint(roles=MANAGER, schema=STATUS_SCHEMA)
def set_status(function_key: str, status: str) -> dict[str, str]:
	"""Activate / deactivate an installed function. P: Manager. E: `WANotFoundError`."""
	return {"status": functions_catalog.set_status(function_key, status)}


@api_endpoint(roles=MANAGER)
def save_values(function_key: str, values: dict) -> dict[str, Any]:
	"""Write the site's values of the function's parameters (a template: a text or
	`{language: text}`); an empty value returns to the header's default. P: Manager.
	E: `WANotFoundError`, `WAValidationError`."""
	return {"values": functions_catalog.save_values(function_key, values)}


@api_endpoint(roles=MANAGER)
def try_function(
	function_key: str, party_type: str | None = None, party: str | None = None, values: dict | None = None
) -> dict[str, Any]:
	"""Run the function as a command would — nothing sent, nothing kept — and show each step and the
	messages it would send. P: Manager."""
	return function_runner.trial(function_key, party_type=party_type, party=party, values=values)


@api_endpoint(roles=MANAGER)
def check_updates() -> dict[str, int]:
	"""Re-read every installed function's script now. P: Manager."""
	functions_catalog.clear_cache()
	return functions_catalog.check_updates()


@api_endpoint(roles=MANAGER)
def update_many(function_keys: list[str]) -> dict[str, Any]:
	"""Bulk update from the scripts; functions whose header did not change are `skipped`. P: Manager."""

	def one(function_key: str) -> None:
		doc = functions_catalog.installed(function_key)
		_spec, checksum = functions_catalog.script_spec(doc.server_script)
		if checksum == doc.manifest_checksum:
			raise _bulk.Skip("already latest")
		functions_catalog.update(function_key)

	return _bulk.run_bulk(function_keys, one)


@api_endpoint(roles=MANAGER, schema=STATUS_SCHEMA)
def set_status_many(function_keys: list[str], status: str) -> dict[str, Any]:
	"""Bulk activate / deactivate; rows already in `status` are `skipped`. P: Manager."""

	def one(function_key: str) -> None:
		if functions_catalog.installed(function_key).status == status:
			raise _bulk.Skip(f"already {status}")
		functions_catalog.set_status(function_key, status)

	return _bulk.run_bulk(function_keys, one)
