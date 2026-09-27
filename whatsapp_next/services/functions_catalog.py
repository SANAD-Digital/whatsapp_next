# Module role: the function catalog / versioning subsystem (backend-plan §3 `functions_catalog.py`,
# screens spec §5.6, D-048). Loads `functions/catalog/vN/catalog.json` from this app plus any app
# listed in the `whatsapp_function_catalogs` hook, exposes versions and a diff-before-install /
# update, and performs install / update / remove on `WhatsApp Function` rows (settings / outputs
# copied from the manifest, manifest snapshot + sha256 checksum kept for later diffs).

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from typing import Any

import frappe
from frappe import _
from frappe.utils import now_datetime, nowdate

from whatsapp_next.exceptions import WANotFoundError, WAStateConflictError, WAValidationError
from whatsapp_next.functions import registry
from whatsapp_next.services import audit

CATALOG_HOOK = "whatsapp_function_catalogs"
DEFAULT_CATALOG_MODULE = "whatsapp_next.functions.catalog"
CATALOG_FILE = "catalog.json"
_VERSION_DIR = re.compile(r"^v\d+$")
_CACHE_KEY = "wa:functions:catalog"

SETTING_FIELDS = ("key", "label", "fieldtype", "choices", "default_value", "notes")
OUTPUT_FIELDS = (
	"output_key",
	"label",
	"output_type",
	"default_template",
	"condition",
	"print_format",
	"file_name_template",
	"variables",
	"notes",
)
MANIFEST_KEYS = (
	"inputs",
	"outputs",
	"settings",
	"example",
	"suggested_commands",
	"changelog",
	"released",
	"party_types",
)


@dataclass
class CatalogFunction:
	function_key: str
	function_name: str
	category: str | None
	description: str | None
	when_to_use: str | None
	party_types: list[str]
	versions: dict[str, dict[str, Any]]
	source: str

	def latest_version(self) -> str | None:
		return sort_versions(list(self.versions))[-1] if self.versions else None


@dataclass
class Catalog:
	functions: dict[str, CatalogFunction] = field(default_factory=dict)
	sources: list[str] = field(default_factory=list)
	errors: list[str] = field(default_factory=list)


@dataclass
class Diff:
	function_key: str
	installed_version: str | None
	target_version: str
	settings: dict[str, list[Any]]
	outputs: dict[str, list[Any]]
	manifest: dict[str, list[str]]
	commands_impacted: list[str]
	handler_registered: bool

	def as_dict(self) -> dict[str, Any]:
		return self.__dict__


# ---- loading -------------------------------------------------------------------------------


def version_tuple(v: str) -> tuple[int, ...]:
	return tuple(int(p) if p.isdigit() else 0 for p in re.split(r"[.\-]", str(v)))


def sort_versions(versions: list[str]) -> list[str]:
	"""Ascending semantic order (`1.0.0 < 1.2.0 < 1.10.0`)."""
	return sorted(versions, key=version_tuple)


def _catalog_modules() -> list[str]:
	mods = [DEFAULT_CATALOG_MODULE]
	for m in frappe.get_hooks(CATALOG_HOOK) or []:
		if m not in mods:
			mods.append(m)
	return mods


def _catalog_files(module: str) -> list[tuple[str, str]]:
	"""`(version_dir, path)` for every `vN/catalog.json` under the module's directory."""
	try:
		root = frappe.get_module(module).__path__[0]
	except Exception:
		return []
	out = []
	for entry in sorted(os.listdir(root)):
		if _VERSION_DIR.match(entry) and os.path.isfile(os.path.join(root, entry, CATALOG_FILE)):
			out.append((entry, os.path.join(root, entry, CATALOG_FILE)))
	return out


def load_catalog(*, use_cache: bool = True) -> Catalog:
	"""Merge every catalog file; later sources / versions extend earlier ones per function key."""
	cached = frappe.cache.get_value(_CACHE_KEY) if use_cache else None
	if cached:
		return _from_cache(cached)
	catalog = Catalog()
	for module in _catalog_modules():
		for version_dir, path in _catalog_files(module):
			source = f"{module}/{version_dir}"
			try:
				with open(path, encoding="utf-8") as fh:
					data = json.load(fh)
			except (OSError, ValueError) as exc:
				catalog.errors.append(f"{source}: {exc}")
				frappe.log_error(title="WhatsApp functions: catalog unreadable", message=f"{path}: {exc}")
				continue
			catalog.sources.append(source)
			for fn in data.get("functions") or []:
				key = str(fn.get("function_key") or "").strip()
				if not key or not isinstance(fn.get("versions"), dict):
					catalog.errors.append(f"{source}: function without key/versions skipped")
					continue
				entry = catalog.functions.get(key)
				if entry is None:
					entry = CatalogFunction(
						function_key=key,
						function_name=fn.get("function_name") or key,
						category=fn.get("category"),
						description=fn.get("description"),
						when_to_use=fn.get("when_to_use"),
						party_types=list(fn.get("party_types") or []),
						versions={},
						source=source,
					)
					catalog.functions[key] = entry
				for v, manifest in fn["versions"].items():
					entry.versions[str(v)] = dict(manifest or {})
	if use_cache:
		frappe.cache.set_value(_CACHE_KEY, _to_cache(catalog), expires_in_sec=300)
	return catalog


def clear_cache() -> None:
	frappe.cache.delete_value(_CACHE_KEY)


def _to_cache(c: Catalog) -> dict:
	return {
		"functions": {k: v.__dict__ for k, v in c.functions.items()},
		"sources": c.sources,
		"errors": c.errors,
	}


def _from_cache(d: dict) -> Catalog:
	return Catalog(
		functions={k: CatalogFunction(**v) for k, v in d["functions"].items()},
		sources=d["sources"],
		errors=d["errors"],
	)


def get_function(function_key: str) -> CatalogFunction:
	fn = load_catalog().functions.get(function_key)
	if not fn:
		frappe.throw(_("Function {0} is not in the catalog").format(function_key), WANotFoundError)
	return fn


def versions(function_key: str) -> list[str]:
	"""Ascending versions of a catalog function."""
	return sort_versions(list(get_function(function_key).versions))


def manifest_for(function_key: str, version: str | None = None) -> tuple[str, dict[str, Any]]:
	fn = get_function(function_key)
	version = version or fn.latest_version()
	if version not in fn.versions:
		frappe.throw(_("Function {0} has no version {1}").format(function_key, version), WANotFoundError)
	return version, fn.versions[version]


def checksum(manifest: dict[str, Any]) -> str:
	return hashlib.sha256(
		json.dumps(manifest, sort_keys=True, ensure_ascii=False).encode("utf-8")
	).hexdigest()


def validate_handler(function_key: str) -> bool:
	"""True when the registry has a handler for the function (install refuses otherwise)."""
	return registry.is_registered(function_key)


# ---- diff ----------------------------------------------------------------------------------


def _rows_by_key(rows: list[dict], key: str) -> dict[str, dict]:
	return {str(r.get(key)): r for r in rows or [] if r.get(key)}


def _table_diff(
	current: list[dict], target: list[dict], key: str, fields: tuple[str, ...]
) -> dict[str, list[Any]]:
	cur, tgt = _rows_by_key(current, key), _rows_by_key(target, key)
	changed = []
	for k in cur.keys() & tgt.keys():
		delta = {
			f: (cur[k].get(f), tgt[k].get(f))
			for f in fields
			if (cur[k].get(f) or None) != (tgt[k].get(f) or None)
		}
		if delta:
			changed.append({key: k, "fields": delta})
	return {
		"added": sorted(tgt.keys() - cur.keys()),
		"removed": sorted(cur.keys() - tgt.keys()),
		"changed": changed,
	}


def diff(function_key: str, target_version: str | None = None) -> Diff:
	"""What install / update would change: settings rows, output rows, manifest keys, commands."""
	version, manifest = manifest_for(function_key, target_version)
	installed = frappe.db.get_value(
		"WhatsApp Function", function_key, ["installed_version", "manifest"], as_dict=True
	)
	if installed:
		current_settings = frappe.get_all(
			"WhatsApp Function Setting",
			filters={"parent": function_key, "parenttype": "WhatsApp Function"},
			fields=list(SETTING_FIELDS),
		)
		current_outputs = frappe.get_all(
			"WhatsApp Function Output",
			filters={"parent": function_key, "parenttype": "WhatsApp Function"},
			fields=list(OUTPUT_FIELDS),
		)
		current_manifest = json.loads(installed.manifest) if installed.manifest else {}
		commands = frappe.get_all("WhatsApp Command", filters={"function": function_key}, pluck="name")
	else:
		current_settings, current_outputs, current_manifest, commands = [], [], {}, []
	m_added = sorted(k for k in MANIFEST_KEYS if manifest.get(k) and not current_manifest.get(k))
	m_removed = sorted(k for k in MANIFEST_KEYS if current_manifest.get(k) and not manifest.get(k))
	m_changed = sorted(
		k
		for k in MANIFEST_KEYS
		if manifest.get(k) and current_manifest.get(k) and manifest.get(k) != current_manifest.get(k)
	)
	return Diff(
		function_key=function_key,
		installed_version=installed.installed_version if installed else None,
		target_version=version,
		settings=_table_diff(current_settings, manifest.get("settings") or [], "key", SETTING_FIELDS),
		outputs=_table_diff(current_outputs, manifest.get("outputs") or [], "output_key", OUTPUT_FIELDS),
		manifest={"added": m_added, "removed": m_removed, "changed": m_changed},
		commands_impacted=commands,
		handler_registered=validate_handler(function_key),
	)


# ---- install / update / remove -------------------------------------------------------------


def _apply_manifest(
	doc, fn: CatalogFunction, version: str, manifest: dict[str, Any], *, keep_values: bool
) -> None:
	"""Write manifest-driven fields onto a Function doc. `keep_values` preserves the site's
	setting values and customised output templates for keys that still exist."""
	old_settings = {r.key: r for r in doc.get("settings") or []}
	old_outputs = {r.output_key: r for r in doc.get("outputs") or []}
	doc.function_name = fn.function_name
	doc.category = fn.category
	doc.description = fn.description
	doc.when_to_use = fn.when_to_use
	doc.installed_version = version
	doc.catalog_source = fn.source
	doc.manifest = json.dumps(
		{k: manifest.get(k) for k in MANIFEST_KEYS if manifest.get(k) is not None}, ensure_ascii=False
	)
	doc.checksum = checksum(manifest)
	doc.latest_version = fn.latest_version()
	doc.latest_version_date = (fn.versions.get(fn.latest_version()) or {}).get("released") or nowdate()
	doc.set("party_types", [])
	for pt in fn.party_types or manifest.get("party_types") or []:
		doc.append("party_types", {"party_type": pt})
	doc.set("settings", [])
	for row in manifest.get("settings") or []:
		values = {f: row.get(f) for f in SETTING_FIELDS}
		values["fieldtype"] = values.get("fieldtype") or "Data"
		old = old_settings.get(row.get("key")) if keep_values else None
		values["value"] = (
			old.value if old is not None and old.value not in (None, "") else values.get("default_value")
		)
		doc.append("settings", values)
	doc.set("outputs", [])
	for row in manifest.get("outputs") or []:
		values = {f: row.get(f) for f in OUTPUT_FIELDS}
		old = old_outputs.get(row.get("output_key")) if keep_values else None
		customised = old is not None and (old.template or "") not in ("", old.default_template or "")
		values["template"] = old.template if customised else values.get("default_template")
		doc.append("outputs", values)


def install(function_key: str, version: str | None = None, user: str | None = None) -> str:
	"""Create the `WhatsApp Function` row from the catalog; refuses without a registered handler."""
	if frappe.db.exists("WhatsApp Function", function_key):
		frappe.throw(
			_("Function {0} is already installed; use update").format(function_key), WAStateConflictError
		)
	if not validate_handler(function_key):
		frappe.throw(
			_("Function {0} has no registered handler on this site").format(function_key), WAValidationError
		)
	fn = get_function(function_key)
	version, manifest = manifest_for(function_key, version)
	doc = frappe.get_doc(
		{
			"doctype": "WhatsApp Function",
			"function_key": function_key,
			"status": "Active",
			"installed_at": now_datetime(),
			"installed_by": user or frappe.session.user,
		}
	)
	_apply_manifest(doc, fn, version, manifest, keep_values=False)
	doc.flags.ignore_permissions = True
	doc.insert(ignore_permissions=True)
	audit.log(
		"Function Installed",
		reference=("WhatsApp Function", doc.name),
		user=user,
		details={"version": version},
	)
	return doc.name


def update(function_key: str, version: str | None = None, user: str | None = None) -> str:
	"""Move an installed function to `version` (default latest), keeping site values and
	customised templates for keys that survive; snapshots the new manifest."""
	if not frappe.db.exists("WhatsApp Function", function_key):
		frappe.throw(_("Function {0} is not installed").format(function_key), WANotFoundError)
	fn = get_function(function_key)
	version, manifest = manifest_for(function_key, version)
	doc = frappe.get_doc("WhatsApp Function", function_key)
	previous = doc.installed_version
	_apply_manifest(doc, fn, version, manifest, keep_values=True)
	doc.flags.ignore_permissions = True
	doc.save(ignore_permissions=True)
	audit.log(
		"Function Updated",
		reference=("WhatsApp Function", doc.name),
		user=user,
		details={"from": previous, "to": version},
	)
	return doc.name


def remove(function_key: str, user: str | None = None) -> None:
	"""Delete the Function row; refused while an Active command references it."""
	if not frappe.db.exists("WhatsApp Function", function_key):
		frappe.throw(_("Function {0} is not installed").format(function_key), WANotFoundError)
	active = frappe.get_all(
		"WhatsApp Command", filters={"function": function_key, "status": "Active"}, pluck="name"
	)
	if active:
		frappe.throw(
			_("Deactivate commands {0} before removing the function").format(", ".join(active)),
			WAStateConflictError,
		)
	audit.log("Function Removed", reference=("WhatsApp Function", function_key), user=user)
	frappe.delete_doc("WhatsApp Function", function_key, ignore_permissions=True)


def installed(function_key: str):
	"""The installed `WhatsApp Function` document. E: `WANotFoundError`."""
	if not frappe.db.exists("WhatsApp Function", function_key):
		frappe.throw(_("Function {0} is not installed").format(function_key), WANotFoundError)
	return frappe.get_doc("WhatsApp Function", function_key)


def set_status(function_key: str, status: str) -> str:
	"""Activate / deactivate an installed function; returns the status it now has."""
	doc = installed(function_key)
	if doc.status != status:
		doc.status = status
		doc.save()
	return doc.status


def save_settings(function_key: str, values: dict | None) -> dict[str, Any]:
	"""Write setting values by key (validated by the row's `fieldtype` / `choices` in the
	controller); unknown keys are rejected. Returns `{key: value}` of every setting."""
	doc = installed(function_key)
	rows = {r.key: r for r in doc.get("settings") or []}
	unknown = sorted(set(values or {}) - set(rows))
	if unknown:
		frappe.throw(
			_("Unknown setting keys for function {0}: {1}").format(function_key, ", ".join(unknown)),
			WAValidationError,
		)
	for key, value in (values or {}).items():
		rows[key].value = "" if value is None else str(value)
	doc.save()
	return {r.key: r.value for r in doc.get("settings") or []}


def check_updates() -> dict[str, int]:
	"""Daily: refresh `latest_version` / `update_available` on installed functions."""
	catalog = load_catalog(use_cache=False)
	counts = {"checked": 0, "updates": 0, "missing": 0}
	for row in frappe.get_all("WhatsApp Function", fields=["name", "installed_version", "latest_version"]):
		fn = catalog.functions.get(row.name)
		counts["checked"] += 1
		if not fn:
			counts["missing"] += 1
			continue
		latest = fn.latest_version()
		available = 1 if latest and version_tuple(latest) > version_tuple(row.installed_version or "0") else 0
		counts["updates"] += available
		frappe.db.set_value(
			"WhatsApp Function",
			row.name,
			{
				"latest_version": latest,
				"latest_version_date": (fn.versions.get(latest) or {}).get("released"),
				"update_available": available,
				"catalog_checked_at": now_datetime(),
			},
			update_modified=False,
		)
	return counts


def storefront() -> list[dict[str, Any]]:
	"""Catalog entries merged with install state, for the Functions Center."""
	catalog = load_catalog()
	installed = {
		r.name: r
		for r in frappe.get_all(
			"WhatsApp Function",
			fields=["name", "installed_version", "status", "update_available", "handler_registered"],
		)
	}
	out = []
	for key, fn in sorted(catalog.functions.items()):
		row = installed.get(key)
		out.append(
			{
				"function_key": key,
				"function_name": fn.function_name,
				"category": fn.category,
				"description": fn.description,
				"when_to_use": fn.when_to_use,
				"party_types": fn.party_types,
				"latest_version": fn.latest_version(),
				"versions": sort_versions(list(fn.versions)),
				"installed": bool(row),
				"installed_version": row.installed_version if row else None,
				"status": row.status if row else None,
				"update_available": bool(row and row.update_available),
				"handler_registered": validate_handler(key),
				"source": fn.source,
			}
		)
	return out
