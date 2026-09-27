# Tests for the composer's "+" (D-137): `attachments.message_parts` turns a picked kind into the
# outbound fields — text, a location, a contact card stored as a .vcf, an uploaded file with the
# typed text as its caption — and refuses what cannot be sent; the simulator's test send and the
# bulk send carry the kind through.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import bulk_send as bulk_api
from whatsapp_next.api.v1 import simulator as sim_api
from whatsapp_next.exceptions import WAFileError, WAValidationError
from whatsapp_next.services import attachments
from whatsapp_next.tests.conftest_frappe import as_user, delete_all, ensure_contact, ensure_device

PHONE = "+966500950001"
PNG = bytes.fromhex(
	"89504e470d0a1a0a0000000d4948445200000001000000010806000000"
	"1f15c4890000000d49444154789c6360000002000100e221bc330000000049454e44ae426082"
)


class TestMessageKinds(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("KindsTest Device", "WAD-TEST-KIND", phone="+966500950000")
		frappe.db.set_value("WhatsApp Device", cls.device, "status", "Connected")
		cls.contact = ensure_contact("KindsTest Contact", PHONE)
		cls.image = attachments.save_private_file(PNG, "kinds-test.png")

	@classmethod
	def tearDownClass(cls):
		delete_all("WhatsApp Log", {"device": cls.device})
		for name in frappe.get_all("WhatsApp Campaign", filters={"device": cls.device}, pluck="name"):
			delete_all("WhatsApp Audit Log", {"reference_name": name})
			delete_all("WhatsApp Campaign", {"name": name})
		delete_all("File", {"file_name": ("like", "kinds-test%")})
		delete_all("File", {"file_name": ("like", "KindsTest%")})
		delete_all("Contact", {"first_name": "KindsTest Contact"})
		super().tearDownClass()

	def test_message_parts(self):
		self.assertEqual(attachments.message_parts("text", body=" hi ")["body"], "hi")
		with self.assertRaises(WAValidationError):
			attachments.message_parts("text", body="  ")
		loc = attachments.message_parts(
			"location", location={"latitude": "24.7", "longitude": 46.6, "name": "Warehouse"}
		)
		self.assertEqual(
			(loc["message_type"], loc["location"]["latitude"], loc["location"]["name"]),
			("Location", 24.7, "Warehouse"),
		)
		with self.assertRaises(WAValidationError):
			attachments.message_parts("location", location={"latitude": 124, "longitude": 1})
		img = attachments.message_parts("image", body="the receipt", attachment=self.image)
		self.assertEqual(
			(img["message_type"], img["caption"], img["body"], img["mime_type"]),
			("Image", "the receipt", None, "image/png"),
		)
		with self.assertRaises(WAFileError):  # a PNG is not a video
			attachments.message_parts("video", attachment=self.image)
		with self.assertRaises(WAValidationError):
			attachments.message_parts("sticker-pack")
		card = attachments.message_parts("contact", contact=self.contact)
		self.assertEqual((card["message_type"], card["mime_type"]), ("Document", "text/vcard"))
		vcf = attachments.as_bytes(card["attachment"]).decode()
		self.assertIn("FN:KindsTest Contact", vcf)
		self.assertIn(f"waid={PHONE.lstrip('+')}", vcf)

	def test_send_test_and_bulk_carry_the_kind(self):
		with as_user("WhatsApp Manager"), patch.object(frappe, "enqueue"):
			out = sim_api.send_test(
				device=self.device,
				phone=PHONE,
				kind="location",
				location={"latitude": 24.7, "longitude": 46.6},
			)
			log = frappe.db.get_value(
				"WhatsApp Log", out["outbound"], ["message_type", "location_name", "is_test"], as_dict=True
			)
			self.assertEqual((log.message_type, log.is_test), ("Location", 1))
			out = sim_api.send_test(
				device=self.device, phone=PHONE, body="look", kind="image", attachment=self.image
			)
			self.assertEqual(
				frappe.db.get_value("WhatsApp Log", out["outbound"], ["message_type", "caption"]),
				("Image", "look"),
			)
			res = bulk_api.send(
				payload={
					"numbers": [PHONE],
					"body": "cap",
					"kind": "image",
					"attachment": self.image,
					"device": self.device,
				}
			)
			msg = frappe.get_doc("WhatsApp Campaign", res["campaign"]).messages[0]
			self.assertEqual((msg.message_type, msg.caption, msg.attachment), ("Image", "cap", self.image))
			with self.assertRaises(WAValidationError):
				bulk_api.send(payload={"numbers": [PHONE], "kind": "location", "device": self.device})
