# Module role: whitelisted endpoint of the Home dashboard (backend-plan §4.2 `api.home`,
# screen 2). Pure composition of existing service reads — devices, campaigns sending now, queue
# summary, today's counters, plan cache, webhook state and onboarding status. No new logic.

from __future__ import annotations

from typing import Any

import frappe
from frappe.utils import get_datetime, nowdate

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import VIEWER_UP
from whatsapp_next.services import campaign_runner, dispatch, home, onboarding, usage_sync, webhook_setup

DEVICE_FIELDS = (
	"name",
	"device_name",
	"status",
	"last_seen",
	"is_default",
	"disabled",
	"connected_at",
	"disconnected_at",
	"last_error",
)


def _today_counts() -> dict[str, int]:
	since = get_datetime(nowdate())
	return {
		"sent": frappe.db.count("WhatsApp Log", {"sent_at": (">=", since)}),
		"delivered": frappe.db.count("WhatsApp Log", {"delivered_at": (">=", since)}),
		"failed": frappe.db.count("WhatsApp Log", {"failed_at": (">=", since)}),
		"inbound": frappe.db.count("WhatsApp Inbound Message", {"received_at": (">=", since)}),
	}


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_dashboard() -> dict[str, Any]:
	"""Everything the Home page renders in one call (see backend-plan §4.2 for the shape)."""
	summary = dispatch.queue_summary()
	webhook = webhook_setup.summary()
	return {
		"devices": frappe.get_all(
			"WhatsApp Device", fields=list(DEVICE_FIELDS), order_by="is_default desc, name"
		),
		"campaigns_sending": campaign_runner.sending_now(),
		"queue": {
			"queued": summary["queued"],
			"sending": summary["sending"],
			"paused": summary["paused"],
			"held": summary["held"],
			"dead_letter": summary["dead_letter"],
			"paused_globally": summary["paused_globally"],
			"paused_by": summary["paused_by"],
			"paused_at": summary["paused_at"],
			"reason": summary["pause_reason"],
			"rate": summary["rate"],
		},
		"today": _today_counts(),
		"plan": usage_sync.snapshot(),
		"webhook_status": webhook.status,
		"last_webhook_event_at": webhook.last_event_at,
		"setup": onboarding.status(),
	}


@api_endpoint(
	roles=VIEWER_UP, methods=("GET", "POST"), schema={"period": {"enum": list(home.PERIODS)}}
)
def get_activity(period: str = "today") -> dict[str, Any]:
	"""One period of the Home page: `{period, traffic{from, now, previous, errors}, series[{key,
	status, count}], scheduled, last_sent, feed}` — grouped in the database (A-3)."""
	return home.activity(period)
