# Module role: attachment handling for outbound messages (backend-plan §3 `attachments.py`).
# Reads File rows (private or public) as bytes, renders Print Formats to PDF with
# `frappe.get_print(as_pdf=True)` (wkhtmltopdf; WeasyPrint dropped, D-029 OQ-2), makes a PNG of
# the first PDF page with PyMuPDF when available, saves private files and builds the provider
# `AttachmentRef`. Rendering is job-time work (campaign materialize, notification job, command
# outputs) — never in a web request path.

from __future__ import annotations

import base64
import mimetypes
import os
import re
from dataclasses import dataclass
from typing import Any

import frappe
from frappe import _
from frappe.utils import cstr

from whatsapp_next.exceptions import WAFileError
from whatsapp_next.providers.schemas import AttachmentRef

MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024  # provider hard limit is lower per type; guard runaway files
PNG_ZOOM = 2.0  # ~144 dpi first-page preview

# Message type → accepted top-level mime family (fields.md OQ-A message types).
MIME_FAMILY_BY_TYPE: dict[str, tuple[str, ...]] = {
	"Image": ("image/",),
	"Video": ("video/",),
	"Audio": ("audio/",),
	"Sticker": ("image/webp",),
	"Document": ("",),  # anything
}

_SAFE_NAME_RE = re.compile(r"[^\w.\-() ؀-ۿ]+", re.UNICODE)


@dataclass(frozen=True)
class RenderedPdf:
	content: bytes
	file_name: str
	mime_type: str = "application/pdf"


def mime_for(file_name: str | None, default: str = "application/octet-stream") -> str:
	"""Mime type from the extension (`application/octet-stream` when unknown)."""
	if not file_name:
		return default
	guessed, _enc = mimetypes.guess_type(file_name)
	if not guessed and file_name.lower().endswith(".webp"):
		return "image/webp"
	return guessed or default


def safe_file_name(name: str | None, default: str = "attachment", ext: str | None = None) -> str:
	"""Strip path parts and unsafe characters; keep Arabic letters; ensure an extension."""
	base = os.path.basename(cstr(name or "")).strip() or default
	base = _SAFE_NAME_RE.sub("_", base).strip(" ._") or default
	if ext and not base.lower().endswith(f".{ext.lower()}"):
		base = f"{base}.{ext.lower()}"
	return base[:140]


def check_mime_for_type(message_type: str, mime_type: str) -> None:
	"""Raise `WAFileError` when `mime_type` cannot be sent as `message_type`."""
	families = MIME_FAMILY_BY_TYPE.get(message_type)
	if families is None:
		return
	if not any(mime_type.startswith(f) for f in families):
		frappe.throw(
			_("A {0} message cannot carry a file of type {1}").format(_(message_type), mime_type),
			WAFileError,
		)


def _file_doc(file_url: str):
	"""The File row for `file_url` (private or public); raises `WAFileError` when missing."""
	name = frappe.db.get_value("File", {"file_url": file_url}, "name")
	if not name:
		frappe.throw(_("File {0} not found").format(file_url), WAFileError)
	return frappe.get_doc("File", name)


def as_bytes(file_url: str | None) -> bytes:
	"""Bytes of a File (`/private/files/...` or `/files/...`) through the File controller, so
	private-file access rules and the storage backend are respected."""
	if not file_url:
		frappe.throw(_("No file to read"), WAFileError)
	doc = _file_doc(file_url)
	# `File.get_content()` (and the in-memory `content` of a just-saved row) decodes anything that
	# happens to be valid text — latin-1 accepts every byte sequence — which corrupts binaries, so
	# the stored file is always read from disk in binary mode.
	try:
		doc.validate_file_url()
		with open(doc.get_full_path(), "rb") as fh:
			content = fh.read()
	except Exception as exc:
		frappe.throw(_("Cannot read file {0}: {1}").format(file_url, cstr(exc)[:200]), WAFileError)
	if isinstance(content, str):
		content = content.encode("utf-8")
	if len(content) > MAX_ATTACHMENT_BYTES:
		frappe.throw(_("File {0} is too large to send").format(file_url), WAFileError)
	return content


def file_meta(file_url: str) -> dict[str, Any]:
	"""`{file_name, mime_type, size, is_private}` of a File row."""
	doc = _file_doc(file_url)
	return {
		"file_name": doc.file_name or os.path.basename(file_url),
		"mime_type": doc.get("content_type") or mime_for(doc.file_name or file_url),
		"size": doc.file_size,
		"is_private": int(doc.is_private or 0),
	}


def render_print_pdf(
	doctype: str,
	name: str,
	print_format: str | None = None,
	letter_head: str | None = None,
	language: str | None = None,
	file_name: str | None = None,
) -> RenderedPdf:
	"""Render a document's Print Format to PDF bytes (wkhtmltopdf via `frappe.get_print`).

	`language` switches `frappe.local.lang` for the render only; `letter_head=None` means the
	document/default letter head, `""` means none."""
	if not frappe.db.exists(doctype, name):
		frappe.throw(_("{0} {1} not found").format(doctype, name), WAFileError)
	previous_lang = frappe.local.lang
	if language:
		frappe.local.lang = language
	try:
		pdf = frappe.get_print(
			doctype,
			name,
			print_format=print_format or None,
			as_pdf=True,
			no_letterhead=1 if letter_head == "" else 0,
			letterhead=letter_head or None,
			pdf_generator="wkhtmltopdf",
		)
	except Exception as exc:
		frappe.throw(
			_("PDF rendering failed for {0} {1}: {2}").format(doctype, name, cstr(exc)[:300]), WAFileError
		)
	finally:
		frappe.local.lang = previous_lang
	if isinstance(pdf, str):
		pdf = pdf.encode("latin-1")
	return RenderedPdf(content=pdf, file_name=safe_file_name(file_name or name, ext="pdf"))


def pdf_first_page_png(pdf_bytes: bytes) -> bytes | None:
	"""PNG of the first page (PyMuPDF). `None` when PyMuPDF is missing or the PDF is unreadable."""
	try:
		import fitz  # PyMuPDF — optional dependency
	except ImportError:
		return None
	try:
		with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
			if doc.page_count == 0:
				return None
			pix = doc[0].get_pixmap(matrix=fitz.Matrix(PNG_ZOOM, PNG_ZOOM), alpha=False)
			return pix.tobytes("png")
	except Exception:
		return None


def save_private_file(content: bytes, file_name: str, attached_to: tuple[str, str] | None = None) -> str:
	"""Store bytes as a private File (optionally attached to a document); returns `file_url`."""
	if not content:
		frappe.throw(_("Cannot save an empty file"), WAFileError)
	doctype, docname = attached_to or (None, None)
	# `frappe.utils.file_manager.save_file` text-decodes binary content before writing (verified:
	# a PNG comes back as UTF-8 "‰PNG"); inserting a File document stores the bytes intact.
	doc = frappe.get_doc(
		{
			"doctype": "File",
			"file_name": safe_file_name(file_name),
			"content": content,
			"is_private": 1,
			"attached_to_doctype": doctype,
			"attached_to_name": docname,
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert(ignore_permissions=True)
	return doc.file_url


def attachment_ref(outbound, *, inline: bool = True) -> AttachmentRef | None:
	"""The provider `AttachmentRef` for a `WhatsApp Log` row (or dict): inline base64 of the
	stored file by default, or a URL reference. `None` when the row has no attachment."""
	get = outbound.get if hasattr(outbound, "get") else lambda k: getattr(outbound, k, None)
	file_url = get("attachment")
	if not file_url:
		return None
	meta = file_meta(file_url)
	file_name = get("file_name") or meta["file_name"]
	mime_type = get("mime_type") or meta["mime_type"]
	check_mime_for_type(get("message_type") or "Document", mime_type)
	if inline:
		return AttachmentRef(
			file_name=file_name,
			mime_type=mime_type,
			content_b64=base64.b64encode(as_bytes(file_url)).decode("ascii"),
		)
	from frappe.utils import get_url

	return AttachmentRef(file_name=file_name, mime_type=mime_type, url=get_url(file_url))


# ---- a message's kind, as the composer's "+" picks it (D-137) ---------------------------------

KIND_TYPES: dict[str, str] = {
	"text": "Text",
	"image": "Image",
	"video": "Video",
	"document": "Document",
	"audio": "Audio",
	"location": "Location",
	"contact": "Document",  # a contact card travels as a .vcf document
}


def _vcard_escape(value: Any) -> str:
	return cstr(value).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def contact_vcard(contact: str) -> tuple[bytes, str]:
	"""A vCard 3.0 of one Contact (name, organisation, WhatsApp numbers, email) and its file name.
	Read through the contextual permission layer. E: `WAFileError` when the contact is missing."""
	from whatsapp_next.services import permissions

	permissions.require("read")
	row = frappe.db.get_value(
		"Contact", contact, ["full_name", "first_name", "last_name", "company_name", "email_id"], as_dict=True
	)
	if not row:
		frappe.throw(_("Contact {0} not found").format(contact), WAFileError)
	phones = frappe.get_all(
		"Contact Phone",
		filters={"parenttype": "Contact", "parent": contact},
		fields=["phone", "wa_phone_e164"],
		order_by="is_primary_mobile_no desc, idx asc",
		ignore_permissions=True,
	)
	name = row.full_name or " ".join(filter(None, [row.first_name, row.last_name])) or contact
	lines = [
		"BEGIN:VCARD",
		"VERSION:3.0",
		f"FN:{_vcard_escape(name)}",
		f"N:{_vcard_escape(row.last_name)};{_vcard_escape(row.first_name or name)};;;",
	]
	if row.company_name:
		lines.append(f"ORG:{_vcard_escape(row.company_name)}")
	for p in phones:
		number = p.wa_phone_e164 or p.phone
		if number:
			digits = number.lstrip("+")
			lines.append(f"TEL;type=CELL;waid={digits}:{number}")
	if row.email_id:
		lines.append(f"EMAIL:{_vcard_escape(row.email_id)}")
	lines.append("END:VCARD")
	return ("\r\n".join(lines) + "\r\n").encode("utf-8"), safe_file_name(name, "contact", "vcf")


def message_parts(
	kind: str | None,
	*,
	body: str | None = None,
	attachment: str | None = None,
	contact: str | None = None,
	location: dict | None = None,
	attached_to: tuple[str, str] | None = None,
) -> dict[str, Any]:
	"""The outbound fields for one composed message: `{message_type, body, caption, attachment,
	file_name, mime_type, location}`. Text needs a body; a file kind needs an uploaded File; a
	contact becomes a stored .vcf; a location needs a latitude and a longitude. The typed text is
	the caption of a file. E: `WAValidationError`, `WAFileError`."""
	from whatsapp_next.exceptions import WAValidationError

	kind = (kind or "text").lower()
	if kind not in KIND_TYPES:
		frappe.throw(_("Unknown message kind {0}").format(kind), WAValidationError)
	message_type = KIND_TYPES[kind]
	body = (body or "").strip() or None
	out: dict[str, Any] = {
		"message_type": message_type,
		"body": body,
		"caption": None,
		"attachment": None,
		"file_name": None,
		"mime_type": None,
		"location": None,
	}
	if kind == "text":
		if not body:
			frappe.throw(_("Message text is required"), WAValidationError)
		return out
	if kind == "location":
		loc = location if isinstance(location, dict) else {}
		try:
			lat, lng = float(loc.get("latitude")), float(loc.get("longitude"))
		except (TypeError, ValueError):
			frappe.throw(_("A location needs a latitude and a longitude"), WAValidationError)
		if not (-90 <= lat <= 90 and -180 <= lng <= 180):
			frappe.throw(_("The latitude or longitude is out of range"), WAValidationError)
		out.update(
			body=None,
			location={
				"latitude": lat,
				"longitude": lng,
				"name": cstr(loc.get("name")).strip() or None,
				"address": cstr(loc.get("address")).strip() or None,
			},
		)
		return out
	if kind == "contact":
		if not contact:
			frappe.throw(_("Pick the contact to share"), WAValidationError)
		content, file_name = contact_vcard(contact)
		url = save_private_file(content, file_name, attached_to)
		out.update(body=None, caption=body, attachment=url, file_name=file_name, mime_type="text/vcard")
		return out
	if not attachment:
		frappe.throw(_("Upload the file to send"), WAValidationError)
	meta = file_meta(attachment)
	check_mime_for_type(message_type, meta["mime_type"])
	out.update(
		body=None,
		caption=body,
		attachment=attachment,
		file_name=meta["file_name"],
		mime_type=meta["mime_type"],
	)
	return out
