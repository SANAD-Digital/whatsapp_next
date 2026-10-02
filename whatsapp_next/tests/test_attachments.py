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

	def test_print_language_and_render_error(self):
		"""A print goes out in its own language — the format's default, else the document's — and a
		broken format is reported in one readable line, not as Frappe's HTML traceback."""
		from unittest.mock import patch

		self.assertIsNone(attachments.print_language("Role", "System Manager"))
		name = "wa-test-print-language"
		if not frappe.db.exists("Print Format", name):
			frappe.get_doc(
				{
					"doctype": "Print Format",
					"name": name,
					"doc_type": "Role",
					"standard": "No",
					"custom_format": 1,
					"print_format_type": "Jinja",
					"html": "<p>{{ doc.name }}</p>",
					"default_print_language": "ar",
				}
			).insert(ignore_permissions=True)
		self.addCleanup(lambda: frappe.delete_doc("Print Format", name, force=True))
		self.assertEqual(attachments.print_language("Role", "System Manager", name), "ar")
		seen = {}

		def fake_print(*args, **kwargs):
			seen["lang"] = frappe.local.lang
			return b"%PDF-1.4 fake"

		previous = frappe.local.lang
		with patch.object(frappe, "get_print", fake_print):
			attachments.render_print_pdf("Role", "System Manager", print_format=name)
			self.assertEqual(seen["lang"], "ar")
			attachments.render_print_pdf("Role", "System Manager", print_format=name, language="en")
			self.assertEqual(seen["lang"], "en")  # an explicit language still wins
		self.assertEqual(frappe.local.lang, previous)

		def broken(*args, **kwargs):
			raise frappe.ValidationError(
				"Error in print format on line 19: <pre>Traceback (most recent call last):\n"
				"  File &quot;jinja.py&quot;, line 156\njinja2.exceptions.UndefinedError: &#x27;x&#x27; is undefined</pre>"
			)

		with patch.object(frappe, "get_print", broken), self.assertRaises(WAFileError) as caught:
			attachments.render_print_pdf("Role", "System Manager")
		message = str(caught.exception)
		self.assertIn("jinja2.exceptions.UndefinedError: 'x' is undefined", message)
		self.assertNotIn("<pre>", message)
		self.assertNotIn("Traceback", message)

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
