# Module role: the single E.164 phone normalization service (architecture.md, spec §6.2).
# Every phone written into a DocType and every phone comparison goes through `normalize`.
# Group / LID JIDs pass through untouched (fields.md gap F-05); `+` is stripped only at the
# provider boundary (`to_provider`, backend-plan-platform RC-3).

from __future__ import annotations

import re
from collections.abc import Iterable

import frappe
import phonenumbers

from whatsapp_next.exceptions import WAInvalidPhoneError

GROUP_SUFFIX = "@g.us"
LID_SUFFIX = "@lid"
INDIVIDUAL_SUFFIXES = ("@c.us", "@s.whatsapp.net")
FALLBACK_REGION = "SA"

_STRIP_CHARS = re.compile("[\\s\\-().\\u00a0\\u200f\\u200e]+")
_ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")


def default_region() -> str:
	"""Return the ISO-3166 alpha-2 region used for national numbers (Settings → Country code)."""
	region = None
	if getattr(frappe.local, "site", None) and frappe.db:
		region = frappe.local.cache.get("wa_default_region") if hasattr(frappe.local, "cache") else None
		if region is None:
			region = _region_from_settings() or ""
			if hasattr(frappe.local, "cache"):
				frappe.local.cache["wa_default_region"] = region
	return region or FALLBACK_REGION


def _region_from_settings() -> str | None:
	country = None
	try:
		if frappe.db.exists("DocType", "WhatsApp Settings"):
			country = frappe.db.get_single_value("WhatsApp Settings", "default_country")
		if not country:
			country = frappe.db.get_single_value("System Settings", "country")
	except Exception:
		return None
	if not country:
		return None
	code = frappe.db.get_value("Country", country, "code")
	return (code or "").upper() or None


def country_catalog() -> list[dict[str, object]]:
	"""Every calling region libphonenumber knows, as `[{iso, dial, main, example, international, trunk, len}]`.

	The browser had been carrying a hand-written table of sixty-eight countries with invented
	lengths and groupings; this is the same metadata Google publishes, for all two hundred and
	forty-five regions, taken from the library the server already validates with — so a number the
	field accepts is a number `normalize()` will accept, by construction rather than by agreement.

	`example` is the region's own sample **mobile** number in national form. It is what the field
	shows as a placeholder and what it derives its grouping from, which is how every serious phone
	input does it: the mask is the example's own shape, not a rule somebody typed in. `trunk` is
	the national prefix the example carries (Saudi Arabia writes `050 123 4567` nationally but
	`+966 50 123 4567` internationally) so the field can strip it the way the library does.

	Region *names* are deliberately absent: the browser names a region in the reader's own language
	with `Intl.DisplayNames`, which is localised for free and always current.
	"""
	cached = frappe.cache().get_value("wa_country_catalog")
	if cached:
		return cached
	rows: list[dict[str, object]] = []
	for iso in sorted(phonenumbers.SUPPORTED_REGIONS):
		dial = phonenumbers.country_code_for_region(iso)
		if not dial:
			continue
		example = phonenumbers.example_number_for_type(iso, phonenumbers.PhoneNumberType.MOBILE)
		if example is None:
			example = phonenumbers.example_number_for_type(iso, phonenumbers.PhoneNumberType.FIXED_LINE)
		national = ""
		significant = ""
		international = ""
		if example is not None:
			national = phonenumbers.format_number(example, phonenumbers.PhoneNumberFormat.NATIONAL)
			international = phonenumbers.format_number(
				example, phonenumbers.PhoneNumberFormat.INTERNATIONAL
			)
			significant = phonenumbers.national_significant_number(example)
		rows.append(
			{
				"iso": iso,
				"dial": dial,
				# Twenty-five regions share `+1` and six share `+7`. libphonenumber names one of
				# each as the code's main region, which is the one a bare `+1…` should resolve to;
				# without it the browser picks whichever sorts first, and a US number came out
				# Antiguan.
				"main": phonenumbers.region_code_for_country_code(dial) == iso,
				"example": national,
				# what the number looks like beside its dial code — `+966 50 123 4567`. This is the
				# grouping a field next to a country picker must use, and it is the library's, not
				# a rule derived from the length.
				"international": international,
				# what the national form adds in front of the significant digits, if anything
				"trunk": _trunk_prefix(national, significant),
				"len": len(significant),
			}
		)
	# a day: the metadata only changes when the library is upgraded, and a stale copy outliving a
	# `pip install -U phonenumbers` is exactly the bug nobody would look for
	frappe.cache().set_value("wa_country_catalog", rows, expires_in_sec=86400)
	return rows


def _trunk_prefix(national: str, significant: str) -> str:
	"""The digits a national form puts before the significant number — Saudi Arabia's `0`."""
	digits = re.sub(r"\D", "", national or "")
	if significant and digits.endswith(significant) and len(digits) > len(significant):
		return digits[: len(digits) - len(significant)]
	return ""


def clear_region_cache() -> None:
	"""Forget the cached default region (called by the Settings controller on save)."""
	if hasattr(frappe.local, "cache"):
		frappe.local.cache.pop("wa_default_region", None)


def is_jid(value: str | None) -> bool:
	"""True when `value` looks like a WhatsApp JID (`…@g.us`, `…@lid`, `…@c.us`, `…@s.whatsapp.net`)."""
	return bool(value) and "@" in value


def is_group_or_lid(value: str | None) -> bool:
	"""True for the two JID kinds that never map to an E.164 number."""
	v = (value or "").strip().lower()
	return v.endswith(GROUP_SUFFIX) or v.endswith(LID_SUFFIX)


def _clean(raw: str) -> str:
	value = str(raw).strip().translate(_ARABIC_DIGITS)
	if "@" in value:
		# JID: clean only the local part; the domain keeps its dots (`@g.us`, `@s.whatsapp.net`).
		local, _, domain = value.partition("@")
		return _STRIP_CHARS.sub("", local) + "@" + domain.strip().lower()
	return _STRIP_CHARS.sub("", value)


def normalize(raw: str | None, region: str | None = None) -> str | None:
	"""Normalize a phone or individual JID to E.164 (`+9665…`); return None when invalid.

	Rules: strip spaces/`-`/`()`/`.`; Arabic-Indic digits → ASCII; `00` → `+`; `@c.us` /
	`@s.whatsapp.net` → digits → international; digits-only → international first, then the
	default region; leading `0` → default region. Group and LID JIDs are returned unchanged.
	"""
	if raw is None:
		return None
	value = _clean(raw)
	if not value:
		return None
	lower = value.lower()
	if lower.endswith(GROUP_SUFFIX) or lower.endswith(LID_SUFFIX):
		return value
	for suffix in INDIVIDUAL_SUFFIXES:
		if lower.endswith(suffix):
			value = "+" + re.sub(r"\D", "", value[: -len(suffix)])
			break
	if value.startswith("00"):
		value = "+" + value[2:]
	if value.startswith("+"):
		return _parse(value, None)
	if not value.isdigit():
		return None
	if value.startswith("0"):
		return _parse(value, region or default_region())
	# Digits without prefix: try as international first, then as national.
	international = _parse("+" + value, None)
	if international:
		return international
	return _parse(value, region or default_region())


def _parse(value: str, region: str | None) -> str | None:
	try:
		number = phonenumbers.parse(value, region)
	except phonenumbers.NumberParseException:
		return None
	if not phonenumbers.is_possible_number(number):
		return None
	return phonenumbers.format_number(number, phonenumbers.PhoneNumberFormat.E164)


def classify(value: str | None) -> tuple[str | None, str | None]:
	"""Return `(kind, key)`: `("Individual", e164)`, `("Group", jid)`, `("LID", jid)` or `(None, None)`."""
	if not value:
		return None, None
	v = _clean(value)
	lower = v.lower()
	if lower.endswith(GROUP_SUFFIX):
		return "Group", v
	if lower.endswith(LID_SUFFIX):
		return "LID", v
	e164 = normalize(v)
	return ("Individual", e164) if e164 else (None, None)


def key_for(phone_e164: str | None, jid: str | None = None) -> str | None:
	"""The WhatsApp Number key: the JID for groups/LIDs, otherwise the E.164 value."""
	if jid and is_group_or_lid(jid):
		return _clean(jid)
	return phone_e164 or None


def to_jid(key: str | None) -> str | None:
	"""E.164 → `digits@s.whatsapp.net`; JIDs unchanged."""
	if not key:
		return None
	if is_jid(key):
		return key
	return re.sub(r"\D", "", key) + "@s.whatsapp.net"


def to_provider(key: str | None) -> str | None:
	"""Provider boundary form: E.164 digits **without** `+`; JIDs unchanged (platform PB-05)."""
	if not key:
		return None
	if is_jid(key):
		return key
	return re.sub(r"\D", "", key)


def is_valid_key(value: str | None) -> bool:
	"""True when `value` is a group/LID JID or a normalizable individual number."""
	kind, _key = classify(value)
	return kind is not None


def mask(value: str | None) -> str:
	"""Mask a number for logs and audit details: keep the country code and the last two digits."""
	if not value:
		return ""
	if is_jid(value):
		local, _, domain = value.partition("@")
		return f"{local[:3]}***@{domain}"
	digits = re.sub(r"\D", "", value)
	if len(digits) <= 5:
		return "*" * len(digits)
	return f"+{digits[:3]}{'*' * (len(digits) - 5)}{digits[-2:]}"


def set_phone_pair(
	doc,
	phone_field: str = "phone",
	e164_field: str = "phone_e164",
	*,
	required: bool = False,
	jid_field: str | None = None,
) -> str | None:
	"""Controller helper: fill `e164_field` from `phone_field` (or keep a valid existing E.164).

	Raises WAInvalidPhoneError when `required` and no valid value can be derived.
	"""
	raw = doc.get(phone_field)
	current = doc.get(e164_field)
	e164 = normalize(raw) if raw else None
	if not e164 and current:
		e164 = normalize(current)
	if not e164 and jid_field and doc.get(jid_field):
		e164 = normalize(doc.get(jid_field))
	if e164:
		doc.set(e164_field, e164)
	elif current or raw:
		doc.set(e164_field, None)
	if required and not e164:
		frappe.throw(
			frappe._("Invalid phone number: {0}").format(mask(raw or current)),
			WAInvalidPhoneError,
		)
	return e164


def normalize_many(values: Iterable[str | None]) -> list[str | None]:
	"""Normalize an iterable; positions are preserved so callers can flag invalid rows."""
	return [normalize(v) for v in values]


def sync_contact_phones(doc, method: str | None = None) -> None:
	"""`Contact.validate` hook: keep `Contact Phone.wa_phone_e164` normalized (D-028)."""
	if not doc.meta.get_field("phone_nos"):
		return
	for row in doc.get("phone_nos") or []:
		if not row.meta.get_field("wa_phone_e164"):
			return
		row.wa_phone_e164 = normalize(row.phone) if row.phone else None
