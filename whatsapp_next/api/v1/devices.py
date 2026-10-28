# Module role: whitelisted endpoints of the Devices screen (backend-plan §4.3 `api.devices`,
# screen 3). Thin wrappers over `services.devices` (the device status writer) and
# `read_layer.device_stats`; pairing payloads come from the 60 s cache and are never stored.

from __future__ import annotations

from dataclasses import asdict
from typing import Any

import frappe
from frappe import _

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import AGENT_UP, MANAGER, VIEWER_UP
from whatsapp_next.exceptions import WANotFoundError
from whatsapp_next.services import devices, read_layer

DEVICE_FIELDS = (
	"name",
	"device_name",
	"phone_e164",
	"platform_device",
	"wa_device_id",
	"status",
	"is_default",
	"disabled",
	"notes",
	"last_seen",
	"connected_at",
	"disconnected_at",
	"logged_out_at",
	"webhook_registered",
	"last_error",
	"last_status_event_at",
	"history_status",
	"history_imported",
	"history_total",
	"history_started_at",
	"history_finished_at",
	"history_error",
	"creation",
	"modified",
)


def _row(device: str) -> dict[str, Any]:
	return frappe.db.get_value("WhatsApp Device", device, list(DEVICE_FIELDS), as_dict=True) or {}


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def list_devices(refresh: bool = False) -> dict[str, Any]:
	"""Local device rows; `refresh=1` first mirrors the provider's live state (`sync_from_provider`)."""
	# the refresh writes the devices' state: never on a GET (a link or an image tag could send one)
	by_get = bool(getattr(frappe.local, "request", None)) and frappe.request.method == "GET"
	synced = devices.sync_from_provider() if refresh and not by_get else None
	# `get_list`: a User Permission on WhatsApp Device limits which devices a user sees
	rows = frappe.get_list("WhatsApp Device", fields=list(DEVICE_FIELDS), order_by="is_default desc, name")
	from whatsapp_next.services import history_import

	return {"rows": rows, "total": len(rows), "synced": synced, "history_allowed": history_import.allowed()}


@api_endpoint(roles=MANAGER, schema={"pairing_mode": {"enum": ["QR", "Code"]}})
def create_device(device_name: str, phone: str | None = None, pairing_mode: str = "QR") -> dict[str, Any]:
	"""Create the device on the provider and locally (`Pending QR`); audited `Device Created`."""
	name = devices.create(device_name, phone=phone, pairing_mode=pairing_mode, user=frappe.session.user)
	row = _row(name)
	return {"name": name, "platform_device": row.get("platform_device"), "status": row.get("status")}


@api_endpoint(roles=MANAGER, schema={"mode": {"enum": ["QR", "Code"]}})
def start_pairing(device: str, mode: str = "QR", phone: str | None = None) -> dict[str, Any]:
	"""QR image or 8-digit code for pairing (60 s cache, never persisted). `phone` (Code only) is
	saved on the device first, for a device that has no number yet."""
	return asdict(devices.start_pairing(device, mode, phone=phone or None))


@api_endpoint(roles=AGENT_UP)
def poll_status(device: str) -> dict[str, Any]:
	"""Ask the provider for the live state and apply it → `{status, changed, previous, wrong_number}`;
	`wrong_number` ({expected, connected}) when the platform unlinked another WhatsApp number."""
	change = devices.poll(device)
	return {"status": change.status, "changed": change.changed, "previous": change.previous, "wrong_number": change.wrong_number}


@api_endpoint(roles=MANAGER)
def disconnect_device(device: str) -> dict[str, Any]:
	"""Provider logout → `Logged Out`; audited `Device Disconnected`."""
	return {"status": devices.disconnect(device, user=frappe.session.user).status}


@api_endpoint(roles=MANAGER)
def delete_device(device: str, delete_remote: bool = True) -> dict[str, Any]:
	"""Delete the device (provider + local); the default device cannot go while others exist."""
	devices.delete(device, delete_remote=delete_remote, user=frappe.session.user)
	return {"deleted": device}


@api_endpoint(roles=MANAGER)
def update_device(device: str, device_name: str | None = None, phone: str | None = None) -> dict[str, Any]:
	"""Rename / re-phone through the provider (`WANotSupportedError` until platform A-05)."""
	devices.update(device, device_name=device_name, phone=phone, user=frappe.session.user)
	return _row(device)


@api_endpoint(roles=MANAGER)
def set_default(device: str) -> dict[str, Any]:
	"""Make `device` the default device (Settings.default_device follows)."""
	devices.set_default(device, user=frappe.session.user)
	return {"ok": True}


@api_endpoint(roles=MANAGER)
def set_disabled(device: str, disabled: bool) -> dict[str, Any]:
	"""Disable / enable a device for dispatch."""
	devices.set_disabled(device, disabled, user=frappe.session.user)
	return {"ok": True}


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"), schema={"days": {"min": 1, "max": 365}})
def get_device_stats(device: str, days: int = 30) -> dict[str, Any]:
	"""`{sent, failed, fail_rate, outbound, inbound, last_message_at}` over the last `days`."""
	return asdict(read_layer.device_stats(device, days))


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def get_device_impact(device: str) -> dict[str, Any]:
	"""What disconnecting or deleting `device` touches, for the confirm dialogs of the Devices
	screen → `{queued, notifications, campaigns, messages}`: queue items still waiting for it
	(Queued · Paused · Held), the templates and campaigns bound to it, and its logged messages."""
	if not frappe.db.exists("WhatsApp Device", device):
		frappe.throw(_("WhatsApp Device {0} not found").format(device), WANotFoundError)
	return {
		"queued": frappe.db.count(
			"WhatsApp Queue Item", {"device": device, "status": ("in", ["Queued", "Paused", "Held"])}
		),
		"notifications": frappe.db.count("WhatsApp Notification", {"device": device}),
		"campaigns": frappe.db.count("WhatsApp Campaign", {"device": device}),
		"messages": frappe.db.count("WhatsApp Log", {"device": device}),
	}


@api_endpoint(roles=MANAGER)
def import_history(device: str, restart: bool = False) -> dict[str, Any]:
	"""Bring in `device`'s past conversations (services.history_import); `restart` reads them from
	the start again, skipping what is already here. Audited."""
	from whatsapp_next.services import audit, history_import

	if not frappe.db.exists("WhatsApp Device", device):
		frappe.throw(_("WhatsApp Device {0} not found").format(device), WANotFoundError)
	history_import.start(device, restart=bool(restart))
	audit.log("Settings Changed", reference=("WhatsApp Device", device), details={"action": "import_history", "restart": bool(restart)},
		user=frappe.session.user)
	return {"ok": True, **_history(device)}


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def get_history_status(device: str) -> dict[str, Any]:
	"""Progress of `device`'s history import → `{status, imported, total, started_at, finished_at, error}`."""
	if not frappe.db.exists("WhatsApp Device", device):
		frappe.throw(_("WhatsApp Device {0} not found").format(device), WANotFoundError)
	return _history(device)


def _history(device: str) -> dict[str, Any]:
	row = frappe.db.get_value("WhatsApp Device", device, ["history_status", "history_imported", "history_total",
		"history_started_at", "history_finished_at", "history_error"], as_dict=True)
	return {"status": row.history_status or "Not Started", "imported": row.history_imported or 0,
		"total": row.history_total or 0, "started_at": row.history_started_at,
		"finished_at": row.history_finished_at, "error": row.history_error}
