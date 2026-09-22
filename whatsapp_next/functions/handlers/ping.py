# Module role: built-in `ping` function — echoes the parsed arguments back. Exists so a fresh site
# has one installable, runnable function to verify the command pipeline end to end.

from __future__ import annotations

from frappe.utils import now_datetime

from whatsapp_next.functions.context import FunctionContext, FunctionResult


def handle(ctx: FunctionContext) -> FunctionResult:
	"""`#ping [text]` → `{echo, at, sender_known, dry_run}`."""
	return FunctionResult(
		data={
			"echo": ctx.args.get("text") or "pong",
			"at": now_datetime().strftime("%Y-%m-%d %H:%M"),
			"sender_known": bool(ctx.sender.contact),
			"display_name": ctx.sender.display_name,
			"dry_run": ctx.dry_run,
		}
	)
