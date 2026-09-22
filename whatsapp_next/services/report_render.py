# Module role: HTML / PDF / PNG rendering of a report result for Notification Alerts
# (backend-plan §11). Replaces the legacy 1 550-line builder with Frappe's own print CSS,
# the site letter head and `frappe.utils.pdf.get_pdf` (wkhtmltopdf); PNG through
# `wkhtmltoimage` when the binary exists (D-029 OQ-E).

from __future__ import annotations

import base64
import html
import re
import shutil
import subprocess
import tempfile
from typing import Any

import frappe
from frappe import _, format_value
from frappe.utils import cstr, now_datetime

MAX_ROWS = 2000
PNG_BINARY = "wkhtmltoimage"


_IMG_SRC = re.compile(r'src="(/(?:private/)?files/[^"]+)"')
_IMG_TAG = re.compile(r"<img\b[^>]*>", re.IGNORECASE)


def _inline_images(html_text: str) -> str:
	"""Embed site files referenced by `<img src="/files/...">` as data URIs, and drop every other
	`<img>` (site URLs are unreachable from workers on many deployments and make wkhtmltopdf fail
	with "broken image links")."""

	def repl(m: re.Match) -> str:
		url = m.group(1)
		try:
			from whatsapp_next.services import attachments

			data = attachments.as_bytes(url)
			mime = attachments.mime_for(url, "image/png")
			return f'src="data:{mime};base64,{base64.b64encode(data).decode("ascii")}"'
		except Exception:
			return 'src=""'

	html_text = _IMG_SRC.sub(repl, html_text)
	return _IMG_TAG.sub(lambda m: m.group(0) if 'src="data:' in m.group(0) else "", html_text)


def _letter_head_html(letter_head: str | None) -> str:
	"""Rendered Letter Head content (they are Jinja: `{{ frappe.utils.get_url(company_logo) }}`),
	with images inlined or removed."""
	if not letter_head or not frappe.db.exists("Letter Head", letter_head):
		return ""
	row = frappe.db.get_value("Letter Head", letter_head, ["content", "image"], as_dict=True)
	content = row.content or ""
	try:
		content = frappe.render_template(content, {"company_logo": row.image, "doc": frappe._dict()})
	except Exception:
		content = ""
	return _inline_images(content)


def _cell(value: Any, column: dict[str, Any]) -> str:
	if value is None:
		return ""
	fieldtype = column.get("fieldtype")
	if fieldtype in ("Currency", "Float", "Int", "Percent", "Date", "Datetime"):
		try:
			return html.escape(
				cstr(format_value(value, {"fieldtype": fieldtype, "options": column.get("options")}))
			)
		except Exception:
			pass
	return html.escape(cstr(value))


def normalize_columns(columns: list[Any]) -> list[dict[str, Any]]:
	"""Query-report columns (dicts or `label:Fieldtype:width` strings) → dicts with `label`,
	`fieldname`, `fieldtype`."""
	out = []
	for i, c in enumerate(columns or []):
		if isinstance(c, dict):
			out.append(
				{
					"label": c.get("label") or c.get("fieldname") or f"col{i}",
					"fieldname": c.get("fieldname") or frappe.scrub(c.get("label") or f"col{i}"),
					"fieldtype": c.get("fieldtype") or "Data",
					"options": c.get("options"),
					"align": "right"
					if c.get("fieldtype") in ("Currency", "Float", "Int", "Percent")
					else "left",
				}
			)
		else:
			parts = str(c).split(":")
			label = parts[0]
			ftype = parts[1].split("/")[0] if len(parts) > 1 and parts[1] else "Data"
			out.append(
				{
					"label": label,
					"fieldname": frappe.scrub(label),
					"fieldtype": ftype,
					"options": None,
					"align": "right" if ftype in ("Currency", "Float", "Int", "Percent") else "left",
				}
			)
	return out


def report_html(
	columns: list[Any],
	rows: list[Any],
	alert,
	*,
	filters: dict[str, Any] | None = None,
	title: str | None = None,
) -> str:
	"""Print-styled table (RTL aware) with the alert's letter head and a filters line."""
	cols = normalize_columns(columns)
	lang = getattr(alert, "language", None) or frappe.local.lang or "en"
	rtl = lang.startswith("ar")
	body_rows = []
	for row in (rows or [])[:MAX_ROWS]:
		if isinstance(row, dict):
			cells = [_cell(row.get(c["fieldname"]), c) for c in cols]
		else:
			cells = [_cell(row[i] if i < len(row) else None, c) for i, c in enumerate(cols)]
		body_rows.append(
			"<tr>"
			+ "".join(
				f'<td style="text-align:{c["align"]}">{v}</td>' for c, v in zip(cols, cells, strict=False)
			)
			+ "</tr>"
		)
	head = "".join(f'<th style="text-align:{c["align"]}">{html.escape(_(c["label"]))}</th>' for c in cols)
	filter_line = ""
	if filters:
		filter_line = (
			"<p class='filters'>"
			+ " · ".join(
				f"{html.escape(str(k))}: {html.escape(cstr(v))}"
				for k, v in filters.items()
				if v not in (None, "")
			)
			+ "</p>"
		)
	truncated = (
		f"<p class='filters'>{_('Showing the first {0} rows').format(MAX_ROWS)}</p>"
		if rows and len(rows) > MAX_ROWS
		else ""
	)
	return f"""<!DOCTYPE html><html lang="{lang}" dir="{"rtl" if rtl else "ltr"}"><head><meta charset="utf-8">
<style>
body {{ font-family: "Noto Sans Arabic", "Noto Sans", Arial, sans-serif; font-size: 11px; color: #1f272e; }}
h2 {{ font-size: 16px; margin: 0 0 4px; }}
.meta, .filters {{ color: #6c7680; font-size: 10px; margin: 0 0 8px; }}
table {{ border-collapse: collapse; width: 100%; }}
th, td {{ border: 1px solid #d1d8dd; padding: 4px 6px; vertical-align: top; }}
th {{ background: #f4f5f6; font-weight: 600; }}
tr:nth-child(even) td {{ background: #fafbfc; }}
</style></head><body>
{_letter_head_html(getattr(alert, "letter_head", None))}
<h2>{html.escape(title or getattr(alert, "report", None) or getattr(alert, "alert_name", "") or "")}</h2>
<p class="meta">{html.escape(_("Generated"))}: {now_datetime().strftime("%Y-%m-%d %H:%M")}</p>
{filter_line}
<table><thead><tr>{head}</tr></thead><tbody>{"".join(body_rows) or f'<tr><td colspan="{max(len(cols), 1)}">{html.escape(_("No data"))}</td></tr>'}</tbody></table>
{truncated}
</body></html>"""


def report_pdf(html_text: str, alert=None) -> bytes:
	"""PDF bytes via wkhtmltopdf (landscape when the alert asks or the table is wide)."""
	from frappe.utils.pdf import get_pdf

	options = {"orientation": "Landscape"} if html_text.count("<th") > 6 else None
	return get_pdf(html_text, options=options)


def report_png(html_text: str, *, width: int = 1200) -> bytes | None:
	"""PNG via `wkhtmltoimage`; `None` when the binary is missing (the alert falls back to PDF)."""
	binary = shutil.which(PNG_BINARY)
	if not binary:
		return None
	with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as src:
		src.write(html_text)
		src_path = src.name
	out_path = src_path[:-5] + ".png"
	try:
		subprocess.run(
			[binary, "--quiet", "--width", str(width), "--encoding", "utf-8", src_path, out_path],
			check=True,
			timeout=60,
			capture_output=True,
		)
		with open(out_path, "rb") as fh:
			return fh.read()
	except (subprocess.SubprocessError, OSError):
		return None
	finally:
		for p in (src_path, out_path):
			try:
				import os

				os.remove(p)
			except OSError:
				pass
