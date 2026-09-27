# Module role: API of the WhatsApp Simulator page (backend-plan §4.4 `simulator.*`, screen 11).
# Thin wrappers over services/simulator.py: page context, "message on behalf" (persisted as
# `is_simulated` rows, never sent), the single test send (`is_test`, job) and the dry-run
# command route shared with `commands.test_command`.

from __future__ import annotations

from typing import Any

import frappe

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import AGENT_UP, MANAGER
from whatsapp_next.services import simulator


@api_endpoint(roles=AGENT_UP, methods=("GET", "POST"))
def get_context() -> dict[str, Any]:
	"""`{devices[], default_device, commands[], commands_enabled, sample_contacts[]}`."""
	return simulator.get_context()


@api_endpoint(roles=AGENT_UP)
def simulate_inbound(device: str, sender_phone: str, text: str, run_commands: bool = True) -> dict[str, Any]:
	"""Store `text` as an `is_simulated` inbound from `sender_phone` on `device`, optionally run
	the command router (dry-run, replies stored as `is_simulated` outbound rows, never sent) →
	`{inbound, command_status, command, block_reason, reply_outbound, reply_body, replies[], error,
	function_ms}`. `WAInvalidPhoneError` for a bad sender."""
	res = simulator.simulate_inbound(
		device, sender_phone, text, run_commands=run_commands, persist=True, user=frappe.session.user
	)
	bodies = [r["body"] for r in res.replies if r.get("body")]
	return {
		"inbound": res.inbound,
		"command_status": res.status,
		"command": res.command,
		"block_reason": res.block_reason,
		"args": res.args,
		"reply_outbound": res.outbound[0] if res.outbound else None,
		"reply_outbounds": res.outbound,
		"reply_body": "\n\n".join(bodies) if bodies else None,
		"replies": res.replies,
		"error": res.error,
		"function_ms": res.elapsed_ms,
	}


@api_endpoint(roles=AGENT_UP)
def send_test(device: str, phone: str, body: str) -> dict[str, Any]:
	"""Create an `is_test` outbound and start `dispatch.send_test_message` (job) → `{outbound}`;
	audited `Test Send`. Raises like `quick_send.send` (invalid phone, empty body)."""
	return {"outbound": simulator.send_test(device, phone, body, user=frappe.session.user)}


@api_endpoint(roles=MANAGER)
def dry_run_command(text: str, sender_phone: str, device: str | None = None) -> dict[str, Any]:
	"""Alias of `commands.test_command`: `command_router.route(dry_run=True)` on an in-memory
	inbound — nothing persisted, nothing sent → `{matched, status, command, block_reason, args,
	reply_body, replies[], error, function_ms}`."""
	return simulator.dry_run_command(text, sender_phone, device)


@api_endpoint(roles=AGENT_UP, methods=("GET", "POST"))
def list_conversations(txt: str | None = None, limit: int = 30) -> dict[str, Any]:
	"""The conversation list: individual numbers with party type and last-message preview →
	`{rows[{phone_e164, display_name, contact, link_status, party_type, last_body, last_at}], total}`."""
	return simulator.conversations(txt, limit)
