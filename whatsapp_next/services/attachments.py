# Module role: attachment handling for outbound messages (backend-plan §3 `attachments.py`).
# Reads File rows (private or public) as bytes, renders Print Formats to PDF with
# `frappe.get_print(as_pdf=True)` (the engine the Print Format or Print Settings chose, as Frappe's
# own PDF button; WeasyPrint dropped, D-029 OQ-2), makes a PNG of
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

from whatsapp_next.exceptions import WAFileError, WAPermissionError
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


def require_readable(file_url: str) -> None:
	"""Refuse a file the session user may not open. Sending a File hands its bytes to whoever
	the message goes to, so a user-composed message may only carry files its author can read
	(Frappe's File rules: public, owned, or attached to a record the user can read).

	Frappe keeps one File row per attachment and reuses the same `file_url` across them, so the
	file is readable when ANY of its rows is: judging one arbitrary row refused a legitimate send
	whenever the row picked happened to hang off a deleted or unreadable record."""
	_file_doc(file_url)  # missing file: its own error, before any permission question
	for name in frappe.get_all("File", filters={"file_url": file_url}, pluck="name", order_by="creation asc"):
		if frappe.has_permission("File", "read", doc=frappe.get_doc("File", name)):
			return
	frappe.throw(_("Not permitted to send file {0}").format(file_url), WAPermissionError)


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


def print_language(doctype: str, name: str, print_format: str | None = None) -> str | None:
	"""The language a document prints in, as the Desk's print view picks it: the Print Format's
	default print language, else the document's own `language` (ERPNext copies the customer's
	there), else `None` — the caller's language. Without it a PDF sent from a background job came
	out in the language of whoever happened to submit the document."""
	meta = frappe.get_meta(doctype)
	print_format = print_format or meta.default_print_format
	language = (
		frappe.db.get_value("Print Format", print_format, "default_print_language") if print_format else None
	)
	if not language and meta.has_field("language"):
		language = frappe.db.get_value(doctype, name, "language")
	return language or None


def _render_error(exc: Exception) -> str:
	"""What went wrong in a print, in one line: Frappe wraps a print format's failure in an HTML
	traceback, and its last line is the only part a reader can act on."""
	import html

	from frappe.utils import strip_html

	text = html.unescape(strip_html(cstr(exc)))
	lines = [line.strip() for line in text.splitlines() if line.strip()]
	if "Traceback" in text and lines:
		return lines[-1][:300]
	return " ".join(lines)[:300]


def render_print_pdf(
	doctype: str,
	name: str,
	print_format: str | None = None,
	letter_head: str | None = None,
	language: str | None = None,
	file_name: str | None = None,
) -> RenderedPdf:
	"""Render a document's Print Format to PDF bytes through `frappe.get_print`, so it works on a
	server as it is (owner, 2026-11-09):

	* the PDF engine is the one Frappe's own button uses — the Print Format's choice, else Print
	  Settings', else wkhtmltopdf;
	* when that engine is not wkhtmltopdf and fails (Chromium not installed, or too slow to
	  start: "Chromium took too long to start"), the document is rendered again with wkhtmltopdf;
	* for wkhtmltopdf, a CSS `@import` whose link is not a full `https://` one is completed
	  first (`complete_css_imports`). Frappe completes `src`/`href`/`url()` links but not those,
	  and wkhtmltopdf stops on them with "ProtocolUnknownError".

	`language` switches `frappe.local.lang` for the render only; without one the print's own
	language is used (`print_language`). `letter_head=None` means the document/default letter
	head, `""` means none."""
	if not frappe.db.exists(doctype, name):
		frappe.throw(_("{0} {1} not found").format(doctype, name), WAFileError)
	# the document type's default format, named: Frappe picks the PDF engine from the format it
	# is given, before the print view falls back to the default one
	print_format = print_format or frappe.get_meta(doctype).default_print_format or None
	previous_lang = frappe.local.lang
	language = language or print_language(doctype, name, print_format)
	if language:
		frappe.local.lang = language

	def render(engine: str | None):
		# wkhtmltopdf reads the page size only from Print Settings: the format's own size is
		# handed to it here. Chrome reads the format's size itself.
		wkhtmltopdf = (engine or pdf_engine(print_format)) == "wkhtmltopdf"
		options = page_options(print_format) if wkhtmltopdf else {}
		return frappe.get_print(
			doctype,
			name,
			print_format=print_format,
			as_pdf=True,
			no_letterhead=1 if letter_head == "" else 0,
			letterhead=letter_head or None,
			**({"pdf_generator": engine} if engine else {}),
			**({"pdf_options": options} if options else {}),
		)

	try:
		with _css_imports_completed():
			try:
				pdf = render(None)
			except Exception as first:
				if pdf_engine(print_format) == "wkhtmltopdf":
					raise
				frappe.logger("whatsapp_next").warning(
					f"PDF engine of {print_format!r} failed ({_render_error(first)}); retried with wkhtmltopdf"
				)
				try:
					pdf = render("wkhtmltopdf")
				except Exception as second:
					raise frappe.ValidationError(
						f"{_render_error(first)} — wkhtmltopdf: {_render_error(second)}"
					) from second
	except Exception as exc:
		frappe.throw(
			_("PDF rendering failed for {0} {1}: {2}").format(doctype, name, _render_error(exc)), WAFileError
		)
	finally:
		frappe.local.lang = previous_lang
	if isinstance(pdf, str):
		pdf = pdf.encode("latin-1")
	return RenderedPdf(content=pdf, file_name=safe_file_name(file_name or name, ext="pdf"))


# what wkhtmltopdf (Qt) knows by name, keyed by the lower-case spelling
_PAGE_NAMES = {
	n.lower(): n
	for n in [f"A{i}" for i in range(10)]
	+ [f"B{i}" for i in range(11)]
	+ ["C5E", "Comm10E", "DLE", "Executive", "Folio", "Ledger", "Legal", "Letter", "Tabloid"]
}
_RECEIPT_WIDTHS = {"Receipt 80 mm": "80mm", "Receipt 58 mm": "58mm"}  # Frappe 16's paper sizes
_PAGE_RULE = re.compile(r"@page\s*(?::[a-z-]+\s*)?\{([^}]*)\}", re.IGNORECASE)
_PAGE_SIZE = re.compile(r"(?:^|;)\s*size\s*:\s*([^;!]+)", re.IGNORECASE)
_LENGTH = re.compile(r"\d+(?:\.\d+)?(?:mm|cm|in)", re.IGNORECASE)


def page_options(print_format: str | None) -> dict[str, str]:
	"""The page size a Print Format sets, as wkhtmltopdf options (owner, 2026-11-10): its "Paper
	size" (Frappe 16; a receipt is its width on an A4-high page), else a CSS `@page { size: … }`
	in its own CSS or HTML — a page name (A5, Letter…), two lengths in mm / cm / in, and
	`landscape`. `{}` when it sets none, and Print Settings decides as before."""
	if not print_format or not frappe.db.exists("Print Format", print_format):
		return {}
	pf = frappe.get_cached_doc("Print Format", print_format)
	paper = pf.get("paper_size")
	if paper in _RECEIPT_WIDTHS:
		return {"page-size": "Custom", "page-width": _RECEIPT_WIDTHS[paper], "page-height": "297mm"}
	if paper and paper.lower() in _PAGE_NAMES:
		return {"page-size": _PAGE_NAMES[paper.lower()]}
	size = None
	for rule in _PAGE_RULE.findall(f"{pf.get('css') or ''}\n{pf.get('html') or ''}"):
		for value in _PAGE_SIZE.findall(rule):
			size = value.strip()  # the last one wins, as in CSS
	if not size:
		return {}
	options: dict[str, str] = {}
	parts = size.lower().split()
	lengths = [p for p in parts if _LENGTH.fullmatch(p)]
	if lengths:
		options = {"page-size": "Custom", "page-width": lengths[0], "page-height": lengths[-1]}
	elif named := next((_PAGE_NAMES[p] for p in parts if p in _PAGE_NAMES), None):
		options = {"page-size": named}
	if "landscape" in parts:
		options["orientation"] = "Landscape"
	return options


def pdf_engine(print_format: str | None) -> str:
	"""The PDF engine Frappe uses for `print_format`: the format's own choice, else Print
	Settings' (Frappe 16 only), else wkhtmltopdf."""
	engine = None
	if print_format and frappe.get_meta("Print Format").has_field("pdf_generator"):
		engine = frappe.db.get_value("Print Format", print_format, "pdf_generator")
	if not engine and frappe.get_meta("Print Settings").has_field("pdf_generator"):
		engine = frappe.db.get_single_value("Print Settings", "pdf_generator")
	return engine or "wkhtmltopdf"


# `@import url("…")`, `@import url(…)` and `@import "…"`: group 2 is the link
_CSS_IMPORT = re.compile(r"""(@import\s+(?:url\(\s*)?["']?)([^"')\s;]+)""", re.IGNORECASE)


def complete_css_imports(html: str) -> str:
	"""Make every CSS `@import` link a full one: `//host/x` → `https://host/x`, `/x` and `x` →
	the site's own address. A full or `data:` link is left as it is."""
	site = frappe.utils.get_url().rstrip("/")

	def full(match: re.Match) -> str:
		link = match.group(2)
		if re.match(r"^[a-z][a-z0-9+.-]*:", link, re.IGNORECASE):
			return match.group(0)
		if link.startswith("//"):
			link = "https:" + link
		else:
			link = f"{site}/{link.lstrip('/')}"
		return match.group(1) + link

	return _CSS_IMPORT.sub(full, html or "")


class _css_imports_completed:
	"""While rendering, Frappe's own link completion (`frappe.utils.pdf.scrub_urls`, which wkhtmltopdf
	output goes through) also completes CSS `@import` links. Installed once per process and never
	removed: two renders at once must not undo each other, and the extra step only fixes links."""

	def __enter__(self):
		import frappe.utils.pdf as pdf

		if not getattr(pdf.scrub_urls, "_wa_css_imports", False):
			original = pdf.scrub_urls

			def scrub_urls(html):
				return complete_css_imports(original(html))

			scrub_urls._wa_css_imports = True
			pdf.scrub_urls = scrub_urls
		return self

	def __exit__(self, *exc):
		return False


def _pymupdf():
	"""PyMuPDF under its current name (`pymupdf`), else its old one (`fitz`); `None` when missing."""
	try:
		import pymupdf

		return pymupdf
	except ImportError:
		pass
	try:
		import fitz

		return fitz
	except ImportError:
		return None


def pdf_first_page_png(pdf_bytes: bytes) -> bytes | None:
	"""PNG of the first page (PyMuPDF). `None` when PyMuPDF is missing or the PDF is unreadable."""
	fitz = _pymupdf()
	if fitz is None:
		return None
	try:
		with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
			if doc.page_count == 0:
				return None
			pix = doc[0].get_pixmap(matrix=fitz.Matrix(PNG_ZOOM, PNG_ZOOM), alpha=False)
			return pix.tobytes("png")
	except Exception:
		return None


def single_page_pdf_png(pdf_bytes: bytes) -> bytes | None:
	"""PNG of a PDF that has exactly one page; `None` for a longer or unreadable PDF, or when
	PyMuPDF is missing."""
	fitz = _pymupdf()
	if fitz is None:
		return None
	try:
		with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
			if doc.page_count != 1:
				return None
			pix = doc[0].get_pixmap(matrix=fitz.Matrix(PNG_ZOOM, PNG_ZOOM), alpha=False)
			return pix.tobytes("png")
	except Exception:
		return None


def is_pdf(file_name: str | None, mime_type: str | None) -> bool:
	"""A PDF by its type or, when the type is missing or generic, by its name."""
	return (mime_type or "").lower() == "application/pdf" or (file_name or "").lower().endswith(".pdf")


def single_page_pdf_as_image_enabled() -> bool:
	"""WhatsApp Settings → Policy → "Send a one-page PDF as an image"; on when never saved (its
	default)."""
	value = frappe.get_cached_doc("WhatsApp Settings").get("single_page_pdf_as_image")
	return True if value is None else bool(int(value or 0))


def _png_name(file_name: str | None) -> str:
	stem = re.sub(r"\.pdf$", "", file_name or "", flags=re.IGNORECASE) or "document"
	return safe_file_name(stem, ext="png")


def as_sent(pdf: RenderedPdf) -> tuple[RenderedPdf, str]:
	"""What a freshly printed PDF goes out as: `(file, message_type)`. A one-page PDF becomes a
	PNG `Image` while the setting is on, before anything is stored, so the site keeps one file per
	message and not a PDF beside its picture; anything else stays a PDF `Document`."""
	if single_page_pdf_as_image_enabled():
		png = single_page_pdf_png(pdf.content)
		if png:
			return RenderedPdf(
				content=png, file_name=_png_name(pdf.file_name), mime_type="image/png"
			), "Image"
	return pdf, "Document"


def pdf_as_image(file_url: str, file_name: str | None) -> dict[str, str] | None:
	"""A stored one-page PDF (an uploaded file) stored again as a PNG, so WhatsApp shows it in the
	chat instead of as a file to open (owner 2026-11-09). The PNG is attached where the PDF is, and
	the PDF itself is left alone. Returns `{attachment, file_name, mime_type}` of the image, or
	`None` to send the PDF as it is: a longer PDF, one that cannot be read, PyMuPDF missing. Never
	raises — a PDF that goes out beats a message that does not."""
	try:
		png = single_page_pdf_png(as_bytes(file_url))
		if not png:
			return None
		source = frappe.db.get_value(
			"File", {"file_url": file_url}, ["attached_to_doctype", "attached_to_name"], as_dict=True
		)
		attached_to = (
			(source.attached_to_doctype, source.attached_to_name)
			if source and source.attached_to_doctype and source.attached_to_name
			else None
		)
		name = _png_name(file_name)
		return {
			"attachment": save_private_file(png, name, attached_to),
			"file_name": name,
			"mime_type": "image/png",
		}
	except Exception:
		frappe.log_error(
			title="WhatsApp: one-page PDF not turned into an image", message=frappe.get_traceback()
		)
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
	require_readable(attachment)
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
