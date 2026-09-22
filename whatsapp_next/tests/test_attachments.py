# Tests for services/attachments.py (build order B-9): File bytes (private), mime / name
# helpers, type guards, Print Format → PDF through wkhtmltopdf, PNG preview, AttachmentRef.

from __future__ import annotations

import base64

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAFileError
from whatsapp_next.services import attachments

PNG_1PX = base64.b64decode(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


class TestAttachments(IntegrationTestCase):
	def setUp(self):
		self.file_url = attachments.save_private_file(
			PNG_1PX, "wa test/../pixel.png", ("Role", "System Manager")
		)

	def tearDown(self):
		for name in frappe.get_all("File", filters={"file_name": ("like", "%pixel%")}, pluck="name"):
			frappe.delete_doc("File", name, ignore_permissions=True, force=True)
		for name in frappe.get_all("File", filters={"file_name": ("like", "%wa-test-%")}, pluck="name"):
			frappe.delete_doc("File", name, ignore_permissions=True, force=True)

	def test_helpers(self):
		self.assertEqual(attachments.mime_for("a.pdf"), "application/pdf")
		self.assertEqual(attachments.mime_for("a.webp"), "image/webp")
		self.assertEqual(attachments.mime_for("weird.zzz"), "application/octet-stream")
		self.assertEqual(attachments.mime_for(None), "application/octet-stream")
		self.assertEqual(attachments.safe_file_name("../../x/فاتورة 1.pdf"), "فاتورة 1.pdf")
		self.assertEqual(attachments.safe_file_name("inv", ext="pdf"), "inv.pdf")
		self.assertEqual(attachments.safe_file_name("", ext="pdf"), "attachment.pdf")
		attachments.check_mime_for_type("Image", "image/png")
		attachments.check_mime_for_type("Document", "application/zip")
		with self.assertRaises(WAFileError):
			attachments.check_mime_for_type("Image", "application/pdf")
		with self.assertRaises(WAFileError):
			attachments.check_mime_for_type("Sticker", "image/png")

	def test_private_file_roundtrip_and_ref(self):
		self.assertTrue(self.file_url.startswith("/private/files/"))
		self.assertEqual(attachments.as_bytes(self.file_url), PNG_1PX)
		meta = attachments.file_meta(self.file_url)
		self.assertEqual(
			(meta["mime_type"], meta["is_private"], meta["size"]), ("image/png", 1, len(PNG_1PX))
		)
		ref = attachments.attachment_ref({"attachment": self.file_url, "message_type": "Image"})
		self.assertTrue(ref.file_name.startswith("pixel") and ref.file_name.endswith(".png"))
		self.assertEqual(ref.mime_type, "image/png")
		self.assertEqual(base64.b64decode(ref.content_b64), PNG_1PX)
		url_ref = attachments.attachment_ref(
			{"attachment": self.file_url, "message_type": "Image"}, inline=False
		)
		self.assertTrue(url_ref.url.endswith(self.file_url) and url_ref.content_b64 is None)
		self.assertIsNone(attachments.attachment_ref({"attachment": None}))
		with self.assertRaises(WAFileError):
			attachments.attachment_ref({"attachment": self.file_url, "message_type": "Video"})
		with self.assertRaises(WAFileError):
			attachments.as_bytes("/private/files/does-not-exist.bin")
		with self.assertRaises(WAFileError):
			attachments.save_private_file(b"", "x.bin")

	def test_render_print_pdf_and_png(self):
		pdf = attachments.render_print_pdf("Role", "System Manager", language="ar", file_name="wa-test-role")
		self.assertTrue(pdf.content.startswith(b"%PDF"))
		self.assertEqual((pdf.file_name, pdf.mime_type), ("wa-test-role.pdf", "application/pdf"))
		self.assertEqual(frappe.local.lang, frappe.local.lang)  # restored
		png = attachments.pdf_first_page_png(pdf.content)
		if png is not None:  # PyMuPDF optional
			self.assertTrue(png.startswith(b"\x89PNG"))
		self.assertIsNone(attachments.pdf_first_page_png(b"not a pdf"))
		with self.assertRaises(WAFileError):
			attachments.render_print_pdf("Role", "no-such-role")
		url = attachments.save_private_file(pdf.content, "wa-test-role.pdf", ("Role", "System Manager"))
		self.assertEqual(attachments.as_bytes(url)[:4], b"%PDF")
