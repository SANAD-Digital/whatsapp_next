# Module role: the allow-list of command handlers (D-012). Inbound commands resolve
# `WhatsApp Function.function_key` here and nowhere else — never a dotted path from data.
# Handlers are registered in phase 4 (B-14); the registry ships empty so `WhatsApp Function`
# can compute `handler_registered` from day one.

from __future__ import annotations

from collections.abc import Callable

FUNCTION_HANDLERS: dict[str, Callable] = {}


def is_registered(function_key: str) -> bool:
	"""True when a handler exists for `function_key`."""
	return function_key in FUNCTION_HANDLERS
