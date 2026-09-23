# Module role: whitelisted endpoints of the Devices screen (backend-plan §4.3 `api.devices`,
# screen 3). Thin wrappers over `services.devices` (the device status writer) and
# `read_layer.device_stats`; pairing payloads come from the 60 s cache and are never stored.

from __future__ import annotations

from dataclasses import asdict
from typing import Any

import frappe

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import AGENT_UP, MANAGER, VIEWER_UP
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
	"creation",
	"modified",
)


def _row(device: str) -> dict[str, Any]:
	return frappe.db.get_value("WhatsApp Device", device, list(DEVICE_FIELDS), as_dict=True) or {}


@api_endpoint(roles=VIEWER_UP, methods=("GET", "POST"))
def list_devices(refresh: bool = False) -> dict[str, Any]:
	"""Local device rows; `refresh=1` first mirrors the provider's live state (`sync_from_provider`)."""
	synced = devices.sync_from_provider() if refresh else None
	rows = frappe.get_all("WhatsApp Device", fields=list(DEVICE_FIELDS), order_by="is_default desc, name")
	return {"rows": rows, "total": len(rows), "synced": synced}


@api_endpoint(roles=MANAGER, schema={"pairing_mode": {"enum": ["QR", "Code"]}})
def create_device(device_name: str, phone: str | None = None, pairing_mode: str = "QR") -> dict[str, Any]:
	"""Create the device on the provider and locally (`Pending QR`); audited `Device Created`."""
	name = devices.create(device_name, phone=phone, pairing_mode=pairing_mode, user=frappe.session.user)
	row = _row(name)
	return {"name": name, "platform_device": row.get("platform_device"), "status": row.get("status")}


@api_endpoint(roles=MANAGER, schema={"mode": {"enum": ["QR", "Code"]}})
def start_pairing(device: str, mode: str = "QR") -> dict[str, Any]:
	"""QR image or 8-digit code for pairing (60 s cache, never persisted)."""
	return asdict(devices.start_pairing(device, mode))


@api_endpoint(roles=AGENT_UP)
def poll_status(device: str) -> dict[str, Any]:
	"""Ask the provider for the live state and apply it → `{status, changed, previous}`."""
	change = devices.poll(device)
	return {"status": change.status, "changed": change.changed, "previous": change.previous}


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
