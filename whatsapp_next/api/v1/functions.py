# Module role: API of the Functions Center (backend-plan §4.10, screen 7): catalog storefront,
# diff-before-install, install / update / remove, status and setting values of installed
# `WhatsApp Function` rows. Thin wrappers over `services/functions_catalog.py`.

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import now_datetime

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1 import _bulk
from whatsapp_next.api.v1._roles import MANAGER, VIEWER_UP
from whatsapp_next.exceptions import WANotFoundError, WAValidationError
from whatsapp_next.services import functions_catalog

STATUS_SCHEMA = {"status": {"enum": ["Active", "Inactive"]}}


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_catalog() -> dict[str, Any]:
	"""`{entries[], catalog_source[], checked_at}`: every catalog function merged with its install
	state (`installed_version`, `update_available`, `handler_registered`, `commands_count`).
	P: Viewer+."""
	entries = functions_catalog.storefront()
	counts = {
		r.function: r.n
		for r in frappe.get_all(
			"WhatsApp Command", fields=["function", {"COUNT": "name", "as": "n"}], group_by="function"
		)
	}
	for e in entries:
		e["commands_count"] = counts.get(e["function_key"], 0)
		versions = functions_catalog.get_function(e["function_key"]).versions
		e["changelog"] = {v: (m or {}).get("changelog") for v, m in versions.items()}
		e["releases"] = {
			v: {"released": (m or {}).get("released"), "changelog": (m or {}).get("changelog")}
			for v, m in versions.items()
		}
	catalog = functions_catalog.load_catalog()
	return {
		"entries": entries,
		"catalog_source": catalog.sources,
		"catalog_errors": catalog.errors,
		"checked_at": now_datetime(),
	}


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_manifest(function_key: str, version: str | None = None) -> dict[str, Any]:
	"""What one version of a catalog function is made of, for the storefront's detail:
	`{version, released, changelog, inputs[], settings[], outputs[], example, suggested_commands[],
	party_types[], installed{}}`. `version` defaults to the installed version, else the latest.
	When the function is installed, each setting row carries its site `value` and `installed`
	holds the record's own facts (`installed_at`, `installed_by`, `call_count`, `avg_ms`,
	`error_count`, `last_error`). P: Viewer+. E: `WANotFoundError`."""
	installed: dict[str, Any] = {}
	values: dict[str, str] = {}
	if frappe.db.exists("WhatsApp Function", function_key):
		doc = frappe.get_doc("WhatsApp Function", function_key)
		version = version or doc.installed_version
		values = {r.key: r.value for r in doc.get("settings") or []}
		installed = {
			"installed_version": doc.installed_version,
			"installed_at": doc.installed_at,
			"installed_by": doc.installed_by,
			"catalog_source": doc.catalog_source,
			"call_count": doc.call_count,
			"avg_ms": doc.avg_ms,
			"error_count": doc.error_count,
			"last_called_at": doc.last_called_at,
			"last_error": doc.last_error,
		}
	version, manifest = functions_catalog.manifest_for(function_key, version)
	fn = functions_catalog.get_function(function_key)
	settings = [dict(row) for row in manifest.get("settings") or []]
	for row in settings:
		if row.get("key") in values:
			row["value"] = values[row["key"]]
	return {
		"function_key": function_key,
		"version": version,
		"released": manifest.get("released"),
		"changelog": manifest.get("changelog"),
		"inputs": list(manifest.get("inputs") or []),
		"settings": settings,
		"outputs": list(manifest.get("outputs") or []),
		"example": manifest.get("example"),
		"suggested_commands": list(manifest.get("suggested_commands") or []),
		"party_types": list(manifest.get("party_types") or fn.party_types or []),
		"installed": installed,
	}


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def preview_install(function_key: str, version: str | None = None) -> dict[str, Any]:
	"""`{diff{settings, outputs, manifest}, commands_impacted[], handler_registered, installed_version,
	target_version}` for installing / moving to `version` (default latest). P: Manager.
	E: `WANotFoundError`."""
	d = functions_catalog.diff(function_key, version)
	return {
		"diff": {"settings": d.settings, "outputs": d.outputs, "manifest": d.manifest},
		"commands_impacted": d.commands_impacted,
		"handler_registered": d.handler_registered,
		"installed_version": d.installed_version,
		"target_version": d.target_version,
	}


@api_endpoint(roles=MANAGER)
def install(function_key: str, version: str | None = None) -> dict[str, str]:
	"""Install from the catalog. P: Manager. E: `WANotFoundError`, `WAValidationError` (no
	handler), `WAStateConflictError` (already installed); audited `Function Installed`."""
	name = functions_catalog.install(function_key, version)
	return {
		"name": name,
		"installed_version": frappe.db.get_value("WhatsApp Function", name, "installed_version"),
	}


@api_endpoint(roles=MANAGER)
def update(function_key: str, version: str | None = None) -> dict[str, str | None]:
	"""Move to `version` (default latest; an older version is a rollback). P: Manager.
	E: `WANotFoundError`; audited `Function Updated`."""
	previous = frappe.db.get_value("WhatsApp Function", function_key, "installed_version")
	name = functions_catalog.update(function_key, version)
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
def save_settings(function_key: str, values: dict) -> dict[str, Any]:
	"""Write setting values by key; unknown keys are rejected. Returns `{values}`. P: Manager.
	E: `WANotFoundError`, `WAValidationError`."""
	return {"values": functions_catalog.save_settings(function_key, values)}


@api_endpoint(roles=MANAGER)
def update_many(function_keys: list[str]) -> dict[str, Any]:
	"""Bulk update to the latest version; functions already on the latest version are `skipped`.
	P: Manager."""

	def one(function_key: str) -> None:
		row = frappe.db.get_value(
			"WhatsApp Function", function_key, ["installed_version", "latest_version"], as_dict=True
		)
		if not row:
			frappe.throw(_("Function {0} is not installed").format(function_key), WANotFoundError)
		latest = functions_catalog.get_function(function_key).latest_version()
		if row.installed_version == latest:
			raise _bulk.Skip("already latest")
		functions_catalog.update(function_key, latest)

	return _bulk.run_bulk(function_keys, one)


@api_endpoint(roles=MANAGER, schema=STATUS_SCHEMA)
def set_status_many(function_keys: list[str], status: str) -> dict[str, Any]:
	"""Bulk activate / deactivate; rows already in `status` are `skipped`. P: Manager."""

	def one(function_key: str) -> None:
		if functions_catalog.installed(function_key).status == status:
			raise _bulk.Skip(f"already {status}")
		functions_catalog.set_status(function_key, status)

	return _bulk.run_bulk(function_keys, one)
