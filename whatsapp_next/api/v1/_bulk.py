# Module role: the one loop behind every bulk API variant (09 G-01, R-022). Runs a single-record
# service call per name inside its own savepoint so one failure never rolls back the others, and
# returns the uniform `{count, done, failed, skipped}` shape.

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any

import frappe


# A selection is a screen's checked rows (a page is at most 200): a request naming more is not a
# selection, and one call must not hold a worker for minutes.
MAX_BULK = 1000


def require_bounded(names: Iterable[str] | None) -> list[str]:
	"""Distinct non-empty names, refused past `MAX_BULK`."""
	unique = list(dict.fromkeys(n for n in names or [] if n))
	if len(unique) > MAX_BULK:
		from frappe import _

		from whatsapp_next.exceptions import WAValidationError

		frappe.throw(_("At most {0} records per request").format(MAX_BULK), WAValidationError)
	return unique


class Skip(Exception):
	"""Raised by a bulk callback to report a row whose state does not apply (not a failure)."""


def run_bulk(names: Iterable[str], fn: Callable[[str], Any]) -> dict[str, Any]:
	"""Call `fn(name)` for every distinct name inside its own savepoint (rolled back on any
	exception, released on success); collect done / failed / skipped. A permission error aborts
	the whole call, every other failure is reported per row."""
	done: list[str] = []
	failed: list[dict[str, str]] = []
	skipped: list[dict[str, str]] = []
	for index, name in enumerate(require_bounded(names)):
		point = f"wa_bulk_{index}"
		frappe.db.savepoint(point)
		try:
			fn(name)
		except Skip as exc:
			frappe.db.rollback(save_point=point)
			skipped.append({"name": name, "reason": str(exc)})
		except frappe.PermissionError:
			frappe.db.rollback(save_point=point)
			raise
		except Exception as exc:  # reported per row, never aborts the loop
			frappe.db.rollback(save_point=point)
			failed.append({"name": name, "error": str(exc)[:300]})
		else:
			frappe.db.release_savepoint(point)
			done.append(name)
	return {"count": len(done), "done": done, "failed": failed, "skipped": skipped}
