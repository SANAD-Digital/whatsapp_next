# Module role: a function's `report` reply printed as a file (WHATSAPP_NEXT_INTEGRATION §9). Runs the
# report the header declared with the filters the function chose, and lays its columns and rows out
# as a PDF table or an Excel sheet. The router sends the file as a Document, like any other.

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import cstr, escape_html
from frappe.utils.formatters import format_value

FORMATS = ("PDF", "Excel")
MIME = {
	"PDF": "application/pdf",
	"Excel": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}
EXT = {"PDF": "pdf", "Excel": "xlsx"}


def _columns(raw: list[Any]) -> list[dict[str, Any]]:
	"""Report columns as dicts (`fieldname`, `label`, `fieldtype`, `options`), hidden ones dropped."""
	out = []
	for i, col in enumerate(raw or []):
		if isinstance(col, str):
			# legacy "Label:Fieldtype/Options:Width"
			label, _sep, rest = col.partition(":")
			fieldtype = rest.split(":")[0].split("/")[0] or "Data"
			col = {"label": label, "fieldtype": fieldtype, "fieldname": frappe.scrub(label) or f"col_{i}"}
		if not isinstance(col, dict) or col.get("hidden"):
			continue
		out.append(
			{
				"fieldname": col.get("fieldname") or f"col_{i}",
				"label": cstr(col.get("label") or col.get("fieldname") or ""),
				"fieldtype": col.get("fieldtype") or "Data",
				"options": col.get("options"),
				"index": i,
			}
		)
	return out


def _cell(row: Any, col: dict[str, Any]) -> Any:
	if isinstance(row, dict):
		return row.get(col["fieldname"])
	if isinstance(row, list | tuple) and col["index"] < len(row):
		return row[col["index"]]
	return None


def run_report(report_name: str, filters: dict[str, Any]) -> tuple[list[dict[str, Any]], list[Any]]:
	"""`(columns, rows)` of a query or script report, as the current user."""
	from frappe.desk.query_report import run

	result = run(report_name, filters=filters or {}) or {}
	rows = [r for r in result.get("result") or [] if isinstance(r, dict | list | tuple)]
	return _columns(result.get("columns")), rows


def _pdf(title: str, columns: list[dict[str, Any]], rows: list[Any]) -> bytes:
	from frappe.utils.pdf import get_pdf

	rtl = frappe.local.lang in ("ar", "fa", "he", "ur")
	head = "".join(f"<th>{escape_html(_(c['label']))}</th>" for c in columns)
	body = []
	for row in rows:
		cells = []
		for c in columns:
			value = _cell(row, c)
			shown = (
				format_value(value, {"fieldtype": c["fieldtype"], "options": c["options"]})
				if value not in (None, "")
				else ""
			)
			cells.append(f"<td>{escape_html(cstr(shown))}</td>")
		body.append("<tr>" + "".join(cells) + "</tr>")
	html = f"""<!doctype html><html dir="{"rtl" if rtl else "ltr"}"><head><meta charset="utf-8">
<style>
body{{font-family:sans-serif;font-size:10px}}
h1{{font-size:14px;margin:0 0 8px}}
table{{width:100%;border-collapse:collapse}}
th,td{{border:1px solid #ccc;padding:3px 5px;text-align:{"right" if rtl else "left"}}}
th{{background:#f2f2f2}}
</style></head><body><h1>{escape_html(_(title))}</h1>
<table><thead><tr>{head}</tr></thead><tbody>{"".join(body)}</tbody></table></body></html>"""
	return get_pdf(html, {"orientation": "Landscape" if len(columns) > 6 else "Portrait"})


def _xlsx(title: str, columns: list[dict[str, Any]], rows: list[Any]) -> bytes:
	from frappe.utils.xlsxutils import make_xlsx

	data = [[_(c["label"]) for c in columns]]
	data += [[_cell(row, c) for c in columns] for row in rows]
	return make_xlsx(data, (_(title) or "Report")[:31]).getvalue()


def render_report_file(msg: dict[str, Any]) -> tuple[str, bytes, str]:
	"""`(file name, bytes, mime)` for a validated `report` message
	(`report_name`, `filters`, `format`, `file_name`). E: `frappe.ValidationError`."""
	fmt = msg.get("format") or "PDF"
	if fmt not in FORMATS:
		frappe.throw(_("Unknown report format {0}").format(fmt))
	report_name = msg["report_name"]
	columns, rows = run_report(report_name, msg.get("filters") or {})
	content = _pdf(report_name, columns, rows) if fmt == "PDF" else _xlsx(report_name, columns, rows)
	name = cstr(msg.get("file_name") or report_name).strip() or report_name
	if not name.lower().endswith("." + EXT[fmt]):
		name = f"{name}.{EXT[fmt]}"
	return name, content, MIME[fmt]
