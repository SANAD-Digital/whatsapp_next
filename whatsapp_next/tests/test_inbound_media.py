# Received media from the platform: `media.download_url` is parsed, fetched with the integration's
# credentials (only from the configured platform) and attached to the Inbound as a private File.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.providers import exceptions as pex
from whatsapp_next.providers.schemas import ProviderSettings
from whatsapp_next.providers.snd_platform import SndPlatformProvider, _parse_inbound

BASE = "https://platform.invalid/"
MEDIA_URL = BASE + "api/method/snd_whatsapp_platform.snd_whatsapp_platform.api.v1.get_inbound_media_api?device=WAD-1&file_id=f1"


class _Resp:
	def __init__(self, status, content=b"", headers=None):
		self.status_code = status
		self.content = content
		self.headers = headers or {}

	def json(self):
		raise ValueError("binary")

	def iter_content(self, chunk_size=1):
		for i in range(0, len(self.content), chunk_size):
			yield self.content[i : i + chunk_size]

	def __enter__(self):
		return self

	def __exit__(self, *exc):
		return False


def _provider():
	return SndPlatformProvider(
		ProviderSettings(
			provider_key="snd_platform",
			base_url=BASE,
			timeout=5,
			credentials={"customer_api_key": "ck", "customer_api_secret": "cs", "api_key": "k", "api_secret": "s"},
		)
	)


class TestInboundMedia(IntegrationTestCase):
	def test_platform_media_object_is_parsed(self):
		p = _parse_inbound(
			{
				"message_id": "M1",
				"message_type": "Image",
				"text": "look",
				"media": {
					"media_type": "image",
					"mime_type": "image/jpeg",
					"file_name": "M1.jpg",
					"caption": "look",
					"download_url": MEDIA_URL,
				},
			},
			None,
		)
		self.assertEqual((p.media_url, p.media_mime_type, p.media_file_name, p.caption), (MEDIA_URL, "image/jpeg", "M1.jpg", "look"))

	def test_download_sends_credentials_only_to_the_platform(self):
		provider = _provider()
		with patch.object(provider._session, "get", return_value=_Resp(200, b"JPEGDATA", {"Content-Type": "image/jpeg"})) as get:
			content, ctype = provider.download_media(MEDIA_URL)
		self.assertEqual((content, ctype), (b"JPEGDATA", "image/jpeg"))
		headers = get.call_args.kwargs["headers"]
		self.assertEqual((headers["X-SND-API-Key"], headers["X-SND-API-Secret"]), ("ck", "cs"))
		with patch.object(provider._session, "get") as get:
			with self.assertRaises(pex.ValidationError):
				provider.download_media("https://evil.invalid/steal")
			get.assert_not_called()

	def test_fetch_media_attaches_a_private_file(self):
		from whatsapp_next.services import inbound

		doc = frappe.get_doc(
			{
				"doctype": "WhatsApp Inbound Message",
				"message_type": "Image",
				"provider_message_id": f"MEDIA-{frappe.generate_hash(length=6)}",
				"media_url": MEDIA_URL,
				"command_status": "None",
			}
		)
		doc.flags.ignore_mandatory = True
		doc.insert(ignore_permissions=True)
		provider = _provider()
		with patch("whatsapp_next.providers.registry.get_provider", return_value=provider), patch.object(
			provider, "download_media", return_value=(b"plain text file", "text/plain")
		):
			url = inbound.fetch_media(doc.name, file_name="note.txt")
		self.assertTrue(url.startswith("/private/files/"))
		self.assertEqual(frappe.db.get_value("WhatsApp Inbound Message", doc.name, "attachment"), url)
		f = frappe.get_doc("File", {"file_url": url})
		self.assertEqual((f.attached_to_doctype, f.attached_to_name, f.is_private), ("WhatsApp Inbound Message", doc.name, 1))
		# a second run is a no-op
		with patch("whatsapp_next.providers.registry.get_provider", return_value=provider), patch.object(provider, "download_media") as again:
			inbound.fetch_media(doc.name)
			again.assert_not_called()

	def test_oversized_media_is_refused(self):
		provider = _provider()
		with patch.object(provider._session, "get", return_value=_Resp(200, b"x" * 2048)):
			with self.assertRaises(pex.ValidationError):
				provider.download_media(MEDIA_URL, max_bytes=1024)
		with patch.object(provider._session, "get", return_value=_Resp(200, b"x", {"Content-Length": "999999"})):
			with self.assertRaises(pex.ValidationError):
				provider.download_media(MEDIA_URL, max_bytes=1024)

	def test_file_names_that_a_browser_could_run_are_neutralised(self):
		from whatsapp_next.services.inbound import safe_file_name

		cases = {
			"invoice.pdf": "invoice.pdf",
			"photo.JPG": "photo.JPG",
			"x.xhtml": "x.xhtml.bin",
			"page.html": "page.html.bin",
			"logo.svg": "logo.svg.bin",
			"../../etc/passwd": "passwd.bin",
			"a\\b\\evil.htm": "evil.htm.bin",
			"bad\x00name.pdf": "badname.pdf",
			"": "M1.bin",
			"...": "M1.bin",
		}
		for raw, want in cases.items():
			self.assertEqual(safe_file_name(raw, fallback="M1"), want, raw)
		self.assertLessEqual(len(safe_file_name("a" * 500 + ".pdf")), 140)

	def test_gateway_reaction_names_its_own_message_and_the_target(self):
		p = _parse_inbound(
			{
				"event": "message.reaction",
				"message_id": "IMG1",
				"reaction_message_id": "REACT1",
				"reaction": "👍",
				"reacted_by": "155512209424618@lid",
				"reacted_by_number": "967770788938",
				"reacted_by_name": "Ali",
				"chat": "155512209424618@lid",
				"from": "155512209424618@lid",
			},
			None,
		)
		self.assertEqual(
			(p.message_type, p.provider_message_id, p.reaction_to, p.reaction, p.sender_phone, p.push_name),
			("Reaction", "REACT1", "IMG1", "👍", "967770788938", "Ali"),
		)
