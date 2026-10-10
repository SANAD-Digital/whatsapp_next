# Module role: whitelisted "Check on WhatsApp" for the screens (services.number_check).

from __future__ import annotations

from typing import Any

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import AGENT_UP
from whatsapp_next.services import contact_profiles, number_check


@api_endpoint(roles=AGENT_UP, schema={"source_doctype": {"enum": ["Contact", "WhatsApp Contact Group", "WhatsApp Number"]}})
def check_selection(source_doctype: str, names: list) -> dict[str, Any]:
	"""Check the numbers behind the selected records with WhatsApp → `{checked, on_whatsapp,
	not_on, results[{phone_e164, display_name, on_whatsapp}]}`."""
	return number_check.check_for(source_doctype, [str(n) for n in names or []])


@api_endpoint(roles=AGENT_UP, schema={"source_doctype": {"enum": ["Contact", "WhatsApp Contact Group", "WhatsApp Number"]}})
def refresh_profiles(source_doctype: str, names: list) -> dict[str, Any]:
	"""Read the WhatsApp profiles (photo, about, business details) of the numbers behind the
	selected records now → `{asked, updated, photos}`."""
	return contact_profiles.refresh_for(source_doctype, [str(n) for n in names or []])
