# Module role: the phone-number metadata the browser needs, taken from the same library the server
# validates with. `PhoneField` used to carry a hand-written table of sixty-eight countries with
# invented lengths and groupings; it reads this instead, so a number the field accepts is a number
# `services.phone.normalize()` accepts — by construction, not by agreement. Thin wrapper over
# `services.phone`; no logic here.

from __future__ import annotations

from typing import Any

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import CONTACT_USER, VIEWER_UP
from whatsapp_next.services import phone


@api_endpoint(roles=VIEWER_UP + CONTACT_USER, methods=("GET", "POST"))
def get_countries() -> dict[str, Any]:
	"""`{default, countries: [{iso, dial, example, trunk, len}]}` — every calling region
	libphonenumber knows.

	`example` is the region's own sample mobile number in national form: the field shows it as the
	placeholder and derives its grouping from it, which is how a phone input is supposed to get its
	mask. `trunk` is the national prefix that form carries (`0` in Saudi Arabia) so the field can
	drop it the way the library does. `default` is the site's own region, from
	Settings → Country code.

	Region names are not here on purpose: the browser names a region in the reader's own language
	with `Intl.DisplayNames`, which is localised for free and never goes stale.
	"""
	return {"default": phone.default_region(), "countries": phone.country_catalog()}
