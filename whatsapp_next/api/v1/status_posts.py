# Module role: whitelisted actions of a WhatsApp Status Post (services.status_posts).

from __future__ import annotations

from typing import Any

import frappe

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import MANAGER, VIEWER_UP
from whatsapp_next.services import status_posts


def _check(name: str, ptype: str = "write") -> None:
	frappe.has_permission("WhatsApp Status Post", ptype, name, throw=True)


@api_endpoint(roles=MANAGER)
def post_now(name: str) -> dict[str, Any]:
	"""Post the status now → `{status_id}`."""
	_check(name)
	return {"status_id": status_posts.post_now(name, user=frappe.session.user)}


@api_endpoint(roles=MANAGER)
def schedule(name: str, scheduled_at: str | None = None) -> dict[str, Any]:
	"""Post at `scheduled_at` (default: the post's own time)."""
	_check(name)
	status_posts.schedule(name, scheduled_at)
	return {"ok": True}


@api_endpoint(roles=MANAGER)
def unschedule(name: str) -> dict[str, Any]:
	"""Take a scheduled status post back to draft → `{ok}`."""
	_check(name)
	status_posts.unschedule(name)
	return {"ok": True}


@api_endpoint(roles=MANAGER)
def delete_post(name: str) -> dict[str, Any]:
	"""Take the status down from WhatsApp (it stays here as Deleted, with its views)."""
	_check(name)
	status_posts.delete_post(name, user=frappe.session.user)
	return {"ok": True}


@api_endpoint(roles=VIEWER_UP)  # POST: it asks the platform and writes the counts
def refresh_views(name: str) -> dict[str, Any]:
	"""Read the views now → `{view_count, viewers}`."""
	_check(name, "read")
	status_posts.refresh_views([name])
	row = frappe.db.get_value("WhatsApp Status Post", name, ["view_count", "viewers"], as_dict=True)
	return {"view_count": row.view_count or 0, "viewers": frappe.parse_json(row.viewers) if row.viewers else []}
