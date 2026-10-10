# Module role: API of the Test Lab page (`wa-test-lab`). Thin wrappers over services/testlab.py:
# the page's opening read, the health checks, the pickers' reads and previews, and the run itself
# (`start_run` → `run_check` per check → `get_status`). The page sends real messages, so every
# function is Manager-only; the run's cap, pacing and recipients are enforced by the service.

from __future__ import annotations

from typing import Any

import frappe

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import MANAGER
from whatsapp_next.services import testlab

KIND_SCHEMA = {"kind": {"enum": list(testlab.KINDS)}}
PREVIEW_SCHEMA = {"kind": {"enum": ["template", "notification", "alert", "campaign"]}}


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def get_context() -> dict[str, Any]:
	"""`{devices[], default_device, me{phone}, limits{}, templates[], notifications[], alerts[],
	commands[], commands_enabled, samples{}, history[]}`. P: Manager."""
	return testlab.context()


@api_endpoint(roles=MANAGER)
def get_health(device: str | None = None, live: bool = False) -> dict[str, Any]:
	"""The setup's health checks → `{ok, checks[{key, title, status, detail, fix, route,
	route_label}], checked_at, live}`. `live` tests the platform connection now (audited
	`Connection Tested`); otherwise nothing leaves the site. P: Manager."""
	return testlab.health(device or None, live=bool(live))


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def identify(phones: list[str]) -> list[dict[str, Any]]:
	"""Who each target number is (contact, party, blacklist) → `[{input, valid, phone_e164, name,
	contact, party_type, party, link_status, blacklisted}]`. P: Manager."""
	return testlab.identify(phones)


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def search_documents(doctype: str, txt: str | None = None) -> dict[str, Any]:
	"""The newest records of `doctype` the caller may read → `{rows[{name, title}], no_access}`.
	P: Manager + read on the DocType (`frappe.get_list`)."""
	return testlab.documents(doctype, txt)


@api_endpoint(roles=MANAGER, schema=PREVIEW_SCHEMA)
def preview(kind: str, params: dict | None = None, target: str | None = None) -> dict[str, Any]:
	"""What a check would send, without sending (`testlab.preview`). P: Manager + read on the
	template / notification / alert and on the record it renders."""
	return testlab.preview(kind, params, target)


@api_endpoint(roles=MANAGER, schema={"cap": {"min": 1, "max": testlab.CAP_MAX}, "pacing": {"min": testlab.PACING_MIN, "max": testlab.PACING_MAX}})
def start_run(device: str, targets: list[str], cap: int | None = None, pacing: int | None = None) -> dict[str, Any]:
	"""Open a test run → `{id, user, device, targets[], cap, pacing, started_at, used}`; audited
	`Test Send`. E: `WAInvalidPhoneError`, `WABlacklistedError`, `WAValidationError`. P: Manager."""
	return testlab.start_run(device, targets, cap, pacing, user=frappe.session.user)


@api_endpoint(roles=MANAGER, schema=KIND_SCHEMA)
def run_check(run: str, kind: str, target: str | None = None, params: dict | None = None) -> dict[str, Any]:
	"""Run one check of a run → the recorded step, or `{wait}` seconds while the pacing holds the
	next message back. Real messages; only to the run's targets, within its cap. P: Manager, and
	only the user who started the run. E: `WANotFoundError`, `WAPermissionError`, `WAValidationError`."""
	return testlab.run_check(run, kind, target, params, user=frappe.session.user)


@api_endpoint(roles=MANAGER)
def get_status(run: str) -> dict[str, Any]:
	"""Where a run stands: its steps with their messages' statuses and timings, the summary, the
	receipts and the real inbound messages of its targets. P: Manager."""
	return testlab.status(run)


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def list_runs() -> list[dict[str, Any]]:
	"""The newest test runs, newest first. P: Manager."""
	return testlab.runs()
