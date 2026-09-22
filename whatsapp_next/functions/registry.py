# Module role: the allow-list of command handlers (D-012). Inbound commands resolve
# `WhatsApp Function.function_key` here and nowhere else — never a dotted path from data.
# Other apps extend it through the `whatsapp_function_handlers` hook (a dict
# `{function_key: "dotted.path.to.handle"}`), resolved once and cached per process.

from __future__ import annotations

from collections.abc import Callable

import frappe

from whatsapp_next.functions.handlers import document_info, ping

BUILTIN_HANDLERS: dict[str, Callable] = {
	"ping": ping.handle,
	"document_info": document_info.handle,
}

FUNCTION_HANDLERS: dict[str, Callable] = dict(BUILTIN_HANDLERS)
_hooks_loaded = False


def _load_hook_handlers() -> None:
	"""Merge handlers other apps declare via `whatsapp_function_handlers` (once per process)."""
	global _hooks_loaded
	if _hooks_loaded:
		return
	try:
		hooked = frappe.get_hooks("whatsapp_function_handlers") or {}
	except Exception:  # no site context (import time, tooling)
		return
	for key, paths in hooked.items():
		path = paths[-1] if isinstance(paths, list | tuple) else paths
		try:
			FUNCTION_HANDLERS[key] = frappe.get_attr(path)
		except Exception:
			frappe.log_error(title="WhatsApp functions: handler hook unresolved", message=f"{key} -> {path}")
	_hooks_loaded = True


def get_handler(function_key: str) -> Callable | None:
	"""The handler for `function_key`, or `None` (callers treat that as Function Inactive)."""
	_load_hook_handlers()
	return FUNCTION_HANDLERS.get(function_key)


def is_registered(function_key: str) -> bool:
	"""True when a handler exists for `function_key`."""
	return get_handler(function_key) is not None
