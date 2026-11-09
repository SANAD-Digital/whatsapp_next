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

	def test_the_pdf_engine_is_the_one_frappes_own_button_uses(self):
		"""A format made for Chrome (Print Format → PDF Generator) failed when the app pinned
		wkhtmltopdf ("ProtocolUnknownError" on a CSS `@import`). The app no longer names an engine,
		and names the document type's default format, from which Frappe picks it."""
		from unittest.mock import patch

		calls = []

		def fake_print(*args, **kwargs):
			calls.append(kwargs)
			return b"%PDF-1.4 fake"

		meta = frappe._dict(default_print_format="WN Chrome Format", has_field=lambda fieldname: False)
		with (
			patch.object(frappe, "get_print", fake_print),
			patch.object(frappe, "get_meta", return_value=meta),
		):
			attachments.render_print_pdf("Role", "System Manager", print_format="Given Format")
			attachments.render_print_pdf("Role", "System Manager")
		self.assertTrue(all("pdf_generator" not in kwargs for kwargs in calls))
		self.assertEqual([kwargs["print_format"] for kwargs in calls], ["Given Format", "WN Chrome Format"])

	def test_a_failed_chrome_falls_back_to_wkhtmltopdf(self):
		"""A server whose Chromium does not start ("Chromium took too long to start") still sends the
		PDF: the document is rendered again with wkhtmltopdf (owner, 2026-11-09)."""
		from unittest.mock import patch

		calls = []

		def chrome_down(*args, **kwargs):
			calls.append(kwargs.get("pdf_generator"))
			if kwargs.get("pdf_generator") != "wkhtmltopdf":
				raise TimeoutError("Chromium took too long to start.")
			return b"%PDF-1.4 from wkhtmltopdf"

		with patch.object(frappe, "get_print", chrome_down):
			with patch.object(attachments, "pdf_engine", return_value="chrome"):
				pdf = attachments.render_print_pdf("Role", "System Manager", print_format="Any")
			self.assertEqual((calls, pdf.content), ([None, "wkhtmltopdf"], b"%PDF-1.4 from wkhtmltopdf"))
			# a format that is wkhtmltopdf already has nothing to fall back to: one try, then the error
			calls.clear()
			with (
				patch.object(attachments, "pdf_engine", return_value="wkhtmltopdf"),
				patch.object(frappe, "get_print", side_effect=TimeoutError("x")),
				self.assertRaises(WAFileError),
			):
				attachments.render_print_pdf("Role", "System Manager", print_format="Any")

	def test_css_imports_are_completed_for_wkhtmltopdf(self):
		"""Frappe completes `src`/`href`/`url()` links but not a CSS `@import`, and wkhtmltopdf stops
		on one that is not a full link ("ProtocolUnknownError")."""
		site = frappe.utils.get_url().rstrip("/")
		html = (
			"<style>@import url(\"/assets/a.css\"); @import url('//fonts.example.com/b.css');"
			' @import "c.css"; @import url(https://cdn.example.com/d.css);</style>'
		)
		self.assertEqual(
			attachments.complete_css_imports(html),
			f"<style>@import url(\"{site}/assets/a.css\"); @import url('https://fonts.example.com/b.css');"
			f' @import "{site}/c.css"; @import url(https://cdn.example.com/d.css);</style>',
		)
		# and a real render with one: wkhtmltopdf failed on it before
		name = "WA Test Import Format"
		if not frappe.db.exists("Print Format", name):
			frappe.get_doc(
				{
					"doctype": "Print Format",
					"name": name,
					"doc_type": "Role",
					"standard": "No",
					"custom_format": 1,
					"print_format_type": "Jinja",
					"html": '<style>@import url("/assets/frappe/css/fonts/inter/inter.css");</style><p>{{ doc.name }}</p>',
				}
			).insert(ignore_permissions=True)
		self.addCleanup(lambda: frappe.delete_doc("Print Format", name, force=True))
		pdf = attachments.render_print_pdf("Role", "System Manager", print_format=name)
		self.assertTrue(pdf.content.startswith(b"%PDF"))

	def test_a_site_that_never_saved_the_option_has_it_on(self):
		"""Customer servers after the update (owner, 2026-11-10): Settings were never saved with the
		new field, and Frappe reads that Check as 0, so one-page PDFs went out as PDFs while the
		Settings page showed the option on. Its default (on) is what counts until it is saved."""
		frappe.db.savepoint("wa_never_saved")
		self.addCleanup(
			lambda: (
				frappe.db.rollback(save_point="wa_never_saved"),
				frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings"),
			)
		)
		frappe.db.delete("Singles", {"doctype": "WhatsApp Settings", "field": "single_page_pdf_as_image"})
		frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
		self.assertEqual(frappe.get_cached_doc("WhatsApp Settings").get("single_page_pdf_as_image"), 0)
		self.assertTrue(attachments.single_page_pdf_as_image_enabled())
		frappe.db.set_single_value("WhatsApp Settings", "single_page_pdf_as_image", 0)
		frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
		self.assertFalse(attachments.single_page_pdf_as_image_enabled())

	def test_the_print_formats_page_size_reaches_wkhtmltopdf(self):
		"""wkhtmltopdf takes the page size from Print Settings only; the format's own size — its
		"Paper size" (Frappe 16) or a CSS `@page { size }` — is handed to it (owner, 2026-11-10)."""
		from unittest.mock import patch

		def fmt(**values):
			return frappe._dict({"paper_size": None, "format_data": None, "css": "", "html": "", **values})

		cases = [
			(fmt(paper_size="A5"), {"page-size": "A5"}),
			# the Frappe 16 builder keeps the paper size in the layout
			(
				fmt(format_data='{"page": {"size": "A5", "orientation": "Landscape"}, "sections": []}'),
				{"page-size": "A5", "orientation": "Landscape"},
			),
			(fmt(format_data='[{"fieldname": "x"}]'), {}),
			(
				fmt(paper_size="Receipt 80 mm"),
				{"page-size": "Custom", "page-width": "80mm", "page-height": "297mm"},
			),
			(
				fmt(css="@page { margin: 0; size: a5 landscape; }"),
				{"page-size": "A5", "orientation": "Landscape"},
			),
			(
				fmt(html="<style>@page{size:148mm 210mm}</style><p>x</p>"),
				{"page-size": "Custom", "page-width": "148mm", "page-height": "210mm"},
			),
			(fmt(css="@page { size: auto; }"), {}),
			(fmt(css=".print-format { color: red; }"), {}),
		]
		with patch.object(frappe.db, "exists", return_value=True):
			for doc, expected in cases:
				with patch.object(frappe, "get_cached_doc", return_value=doc):
					self.assertEqual(attachments.page_options("Any"), expected, doc)
		self.assertEqual(attachments.page_options(None), {})

		# and a real render: an A5 format comes out A5 (420 × 595 pt), not the A4 of Print Settings
		pymupdf = attachments._pymupdf()
		name = "WA Test A5 Format"
		if not frappe.db.exists("Print Format", name):
			frappe.get_doc(
				{
					"doctype": "Print Format",
					"name": name,
					"doc_type": "Role",
					"standard": "No",
					"custom_format": 1,
					"print_format_type": "Jinja",
					"pdf_generator": "wkhtmltopdf",
					"html": "<style>@page { size: A5; }</style><p>{{ doc.name }}</p>",
				}
			).insert(ignore_permissions=True)
		self.addCleanup(lambda: frappe.delete_doc("Print Format", name, force=True))
		pdf = attachments.render_print_pdf("Role", "System Manager", print_format=name)
		if pymupdf is not None:
			with pymupdf.open(stream=pdf.content, filetype="pdf") as doc:
				self.assertEqual((round(doc[0].rect.width), round(doc[0].rect.height)), (420, 595))

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
