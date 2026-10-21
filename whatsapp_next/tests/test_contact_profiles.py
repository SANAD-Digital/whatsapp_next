# WhatsApp profiles (services/contact_profiles): stored on the number, the photo saved from
# WhatsApp's CDN only, an unchanged photo not fetched again, and a contact without a photo given one.

from __future__ import annotations

from unittest.mock import MagicMock, patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.providers.schemas import ContactProfile
from whatsapp_next.services import contact_profiles


def _png() -> bytes:
	import io

	from PIL import Image

	buf = io.BytesIO()
	Image.new("RGB", (8, 8), (20, 120, 80)).save(buf, format="PNG")
	return buf.getvalue()


PNG = _png()


class Provider:
	def __init__(self, profile):
		self.profile, self.known = profile, []

	def get_contact_profiles(self, platform_device, numbers, known_pictures=None):
		self.known.append(dict(known_pictures or {}))
		return [self.profile]


def _photo_response():
	r = MagicMock(status_code=200, headers={"Content-Type": "image/jpeg"})
	r.iter_content.return_value = [PNG]
	r.__enter__ = lambda s: s
	r.__exit__ = lambda s, *a: None
	return r


class TestContactProfiles(IntegrationTestCase):
	def setUp(self):
		if not frappe.db.get_value("WhatsApp Device", {"status": "Connected"}, "name"):
			self.skipTest("needs a connected device")
		tag = frappe.generate_hash(length=4).translate(str.maketrans("abcdef", "123456"))
		self.key = f"+96773300{tag}"
		self.contact = frappe.get_doc({"doctype": "Contact", "first_name": f"Profile {tag}",
			"phone_nos": [{"phone": self.key, "is_primary_mobile_no": 1}]}).insert(ignore_permissions=True)
		frappe.get_doc({"doctype": "WhatsApp Number", "phone_e164": self.key, "number_type": "Individual",
			"link_status": "Linked", "contact": self.contact.name}).insert(ignore_permissions=True)

	def _refresh(self, profile, **kw):
		provider = Provider(profile)
		with patch("whatsapp_next.providers.registry.get_provider", return_value=provider), \
			patch("whatsapp_next.services.contact_profiles.requests.get", return_value=_photo_response()) as get:
			stats = contact_profiles.refresh([self.key], force=True, **kw)
		return stats, provider, get

	def test_profile_and_photo_are_stored_and_the_contact_gets_the_photo(self):
		profile = ContactProfile(phone_e164=self.key, on_whatsapp=True, about="Hello", verified_name="Shop",
			is_business=True, picture_state="set", picture_id="P1", picture_url="https://pps.whatsapp.net/v/t61/x.jpg",
			business={"categories": ["Retail"], "email": "a@b.c", "hours": [{"day": "sun", "mode": "open_24h"}]})
		stats, _p, _g = self._refresh(profile)
		self.assertEqual((stats["updated"], stats["photos"]), (1, 1))
		row = frappe.db.get_value("WhatsApp Number", self.key, ["about", "verified_name", "is_business",
			"business_categories", "picture_id", "picture_state", "profile_picture", "business_hours"], as_dict=True)
		self.assertEqual((row.about, row.verified_name, row.is_business, row.business_categories, row.picture_id, row.picture_state),
			("Hello", "Shop", 1, "Retail", "P1", "Shown"))
		self.assertTrue(row.profile_picture and "24" in row.business_hours)
		self.assertEqual(frappe.db.get_value("Contact", self.contact.name, "image"), row.profile_picture)
		# next time the photo id is sent, and an unchanged photo is not downloaded again
		unchanged = ContactProfile(phone_e164=self.key, on_whatsapp=True, picture_state="unchanged", picture_id="P1")
		stats, provider, get = self._refresh(unchanged)
		self.assertEqual(provider.known, [{self.key: "P1"}])
		get.assert_not_called()
		self.assertEqual(frappe.db.get_value("WhatsApp Number", self.key, "profile_picture"), row.profile_picture)

	def test_a_photo_from_another_host_is_refused_and_a_contact_photo_never_replaced(self):
		frappe.db.set_value("Contact", self.contact.name, "image", "/files/own.png")
		profile = ContactProfile(phone_e164=self.key, on_whatsapp=True, picture_state="set", picture_id="P2",
			picture_url="https://evil.example.com/x.jpg")
		stats, _p, get = self._refresh(profile)
		get.assert_not_called()
		self.assertEqual(stats["photos"], 0)
		self.assertEqual(frappe.db.get_value("Contact", self.contact.name, "image"), "/files/own.png")
