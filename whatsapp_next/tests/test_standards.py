# Tests for the standard content (`fixtures/standard_*.json`, `services/standards.py`).
#
# The shipped files: every record loads, links only to what a site with ERPNext has, ships
# switched off with no device / phone / site value, and renders against a minimal document.
# The sync rules, on synthetic records imported the way `sync_fixtures` imports a file: a new
# record is created switched off; site-owned state survives; shipped content reaches a record
# the owner has not edited and never overwrites one he has.

from __future__ import annotations

import copy
import json
import os
import re
import tempfile
from unittest.mock import patch

import frappe
from frappe.modules.import_file import import_file_by_path
from frappe.tests import IntegrationTestCase

from whatsapp_next.services import alerts, notifications, standards, templates
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_device, ensure_settings

T, N, A = "WhatsApp Template", "WhatsApp Notification", "WhatsApp Notification Alert"
NAME_FIELD = {T: "template_name", N: "notification_name", A: "alert_name"}
# what a rendered message must never show
LEFTOVER = re.compile(r"None|Undefined|\{\{|\}\}|\{%|%\}")
PHONE = "+966500931777"


def sample_document(doctype: str):
	"""A minimal unsaved document of an ERPNext DocType: only what the standard texts read."""
	doc = frappe.new_doc(doctype)
	values = {
		"name": "TEST-0001",
		"company": "شركة تجريبية",
		"customer": None,
		"supplier": None,
		"customer_name": "عميل تجريبي",
		"supplier_name": "مورد تجريبي",
		"party_name": "عميل تجريبي",
		"party_type": "Customer",
		"payment_type": "Receive",
		"currency": "USD",
		"paid_from_account_currency": "USD",
		"posting_date": "2026-01-10",
		"transaction_date": "2026-01-10",
		"due_date": "2026-01-01",
		"delivery_date": "2026-01-20",
		"schedule_date": "2026-01-20",
		"valid_till": "2026-01-25",
		"grand_total": 1500,
		"rounded_total": 1500,
		"outstanding_amount": 500,
		"paid_amount": 1000,
		"mode_of_payment": "Cash",
		"reference_no": "TR-1",
		"status": "Paid",
		"is_return": 0,
		"is_pos": 0,
		"per_delivered": 0,
		"contact_mobile": PHONE,
		"contact_person": None,
	}
	meta = doc.meta
	doc.update({k: v for k, v in values.items() if k == "name" or meta.has_field(k)})
	if meta.has_field("items"):
		doc.append("items", {"item_name": "صنف تجريبي", "qty": 2, "uom": "Nos"})
		doc.append("items", {"item_name": "صنف بالوزن", "qty": 2.5, "uom": "Kg"})
	if doctype == "Payment Entry":
		doc.append(
			"references",
			{"reference_doctype": "Sales Invoice", "reference_name": "INV-1", "allocated_amount": 1000, "outstanding_amount": 500},
		)
	return doc


class TestStandardFixtures(IntegrationTestCase):
	"""The files as shipped — read only, nothing is written to the site."""

	def records(self, doctype):
		rows = standards.records(doctype)
		self.assertTrue(rows, f"{standards.FILES[doctype]} is empty or missing")
		return rows

	def test_hooks_declare_exactly_the_shipped_records(self):
		declared = {
			f.get("dt") or f.get("doctype"): f
			for f in frappe.get_hooks("fixtures", app_name="whatsapp_next")
			if isinstance(f, dict)
		}
		for doctype, file_name in standards.FILES.items():
			with self.subTest(doctype=doctype):
				entry = declared.get(doctype)
				self.assertTrue(entry, f"{doctype} is not declared in hooks.fixtures")
				# the file name Frappe's export would write is the one the app ships
				self.assertEqual(f"{entry['prefix']}_{frappe.scrub(doctype)}.json", file_name)
				self.assertEqual(entry["filters"], [["name", "in", standards.names(doctype)]])
		# the three standard entries are last: Frappe's export carries a prefix over to later ones
		order = [f.get("dt") for f in frappe.get_hooks("fixtures", app_name="whatsapp_next") if isinstance(f, dict)]
		self.assertEqual(order[-3:], list(standards.FILES))
		# the import order: templates before what links to them, all after the roles
		files = sorted(f for f in os.listdir(frappe.get_app_path("whatsapp_next", "fixtures")) if f.endswith(".json"))
		self.assertLess(files.index("role.json"), files.index(standards.FILES[T]))
		self.assertLess(files.index(standards.FILES[T]), files.index(standards.FILES[N]))
		self.assertLess(files.index(standards.FILES[T]), files.index(standards.FILES[A]))

	def test_names_are_the_identity(self):
		for doctype in standards.FILES:
			for name, row in self.records(doctype).items():
				with self.subTest(doctype=doctype, name=name):
					self.assertEqual(row["doctype"], doctype)
					self.assertEqual(row[NAME_FIELD[doctype]], name)
					self.assertEqual(name, name.strip())
					self.assertLessEqual(len(standards._key(doctype, name)), 140)

	def test_nothing_ships_switched_on_or_bound_to_a_site(self):
		"""No standard notification or alert can send after an install or a migrate: off, no
		device, no number, no user, no counters — and nothing that names a site's own records."""
		for doctype in (N, A):
			for name, row in self.records(doctype).items():
				with self.subTest(doctype=doctype, name=name):
					self.assertEqual(row.get("enabled"), 0)
					for field in ("device", "print_format", "letter_head", "last_sent_at", "next_run_at", "last_error", "last_error_at"):
						self.assertFalse(row.get(field), field)
					self.assertFalse(row.get("send_count"))
					self.assertTrue(row.get("recipients"))
					for r in row["recipients"]:
						self.assertIn(r["recipient_type"], ("Document Field", "Linked Document Field", "Role"))
						for field in ("phone", "phone_e164", "user"):
							self.assertFalse(r.get(field), field)
		for name, row in self.records(T).items():
			with self.subTest(template=name):
				for field in ("attachment", "print_format", "letter_head", "use_count", "last_used_at"):
					self.assertFalse(row.get(field), field)
				self.assertEqual(row["message_type"], "Text")
		for name, row in self.records(A).items():
			with self.subTest(alert=name):
				filters = json.loads(row.get("filters_json") or "{}")
				self.assertIn(filters.get("company"), (None, standards.COMPANY_TOKEN))
				self.assertFalse({"party", "customer", "supplier", "account", "cost_center"} & set(filters))

	def test_every_link_exists_on_a_site_with_erpnext(self):
		shipped_by = {"frappe", "erpnext"}

		def app_of(doctype):
			return frappe.db.get_value("Module Def", frappe.db.get_value("DocType", doctype, "module"), "app_name")

		templates_shipped = set(standards.names(T))
		for name, row in self.records(T).items():
			with self.subTest(template=name):
				self.assertTrue(frappe.db.exists("Language", row["language"]))
				if row.get("reference_doctype"):
					self.assertIn(app_of(row["reference_doctype"]), shipped_by)
		for name, row in self.records(N).items():
			with self.subTest(notification=name):
				self.assertIn(app_of(row["document_type"]), shipped_by)
				self.assertIn(row["template"], templates_shipped)
				self.assertEqual(self.records(T)[row["template"]]["reference_doctype"], row["document_type"])
				meta = frappe.get_meta(row["document_type"])
				for field in (row.get("date_changed"), row.get("value_changed"), row.get("attach_field")):
					if field:
						self.assertTrue(meta.has_field(field), field)
				for r in row["recipients"]:
					self.assertTrue(meta.has_field(r["receiver_by_document_field"]), r["receiver_by_document_field"])
		for name, row in self.records(A).items():
			with self.subTest(alert=name):
				report = frappe.db.get_value("Report", row["report"], ["is_standard", "module", "disabled"], as_dict=True)
				self.assertTrue(report, row["report"])
				self.assertEqual((report.is_standard, report.disabled), ("Yes", 0))
				self.assertIn(frappe.db.get_value("Module Def", report.module, "app_name"), shipped_by)
				self.assertTrue(frappe.db.exists("Language", row["language"]))
				for r in row["recipients"]:
					self.assertEqual(frappe.db.get_value("Role", r["role"], "is_custom"), 0, r["role"])

	def test_every_record_passes_its_controller(self):
		"""`sync_fixtures` validates what it inserts: a record its controller refuses breaks migrate."""
		for doctype in standards.FILES:
			for name, row in self.records(doctype).items():
				with self.subTest(doctype=doctype, name=name):
					doc = frappe.get_doc(copy.deepcopy(row))
					if doctype == A:
						doc.filters_json = standards._site_filters(doc.filters_json)
					doc.run_method("validate")

	def test_templates_render_on_a_minimal_document(self):
		for name, row in self.records(T).items():
			for who in ("أحمد", ""):
				with self.subTest(template=name, recipient=who):
					doc = sample_document(row["reference_doctype"]) if row.get("reference_doctype") else None
					ctx = templates.context_for(doc=doc, recipient={"display_name": who, "phone_e164": PHONE})
					result = templates.render(row["body"], ctx)
					self.assertIsNone(result.error)
					self.assertTrue(result.text)
					self.assertIsNone(LEFTOVER.search(result.text), result.text)
					if doc is not None:
						self.assertIn("TEST-0001", result.text)
						self.assertIn("شركة تجريبية", result.text)
					self.assertEqual("أحمد" in result.text, bool(who))

	def test_notifications_evaluate_and_resolve_on_a_minimal_document(self):
		ensure_settings()
		for name, row in self.records(N).items():
			with self.subTest(notification=name):
				notif = frappe.get_doc(copy.deepcopy(row))
				doc = sample_document(row["document_type"])
				errors: list[str] = []
				# the condition is an expression this DocType can answer (a failure lands in `errors`)
				notifications.evaluate(notif, doc, notif.event, errors)
				self.assertEqual(errors, [])
				recipients = notifications.resolve_recipients(notif, doc, errors)
				if doc.meta.has_field("contact_mobile"):
					self.assertEqual(([r.phone_e164 for r in recipients], errors), ([PHONE], []))
				# a document with no number at all: nobody, said in words, and no exception
				doc.contact_mobile = None
				errors = []
				self.assertEqual(notifications.resolve_recipients(notif, doc, errors), [])
				self.assertTrue(errors and all("no valid number" in e for e in errors), errors)

	def test_alert_messages_render_with_and_without_rows(self):
		rows = [
			{"party": "عميل أ", "outstanding": 1200.0, "currency": "USD", "voucher_no": "V-1", "customer_name": "عميل أ", "grand_total": 1200.0, "outstanding_amount": 200.0, "debit": 1200.0, "credit": 0.0},
			{"party": "عميل ب", "outstanding": 300.0, "currency": "USD", "voucher_no": "V-2", "customer_name": "عميل ب", "grand_total": 300.0, "outstanding_amount": 0.0, "debit": 0.0, "credit": 300.0},
			# reports end with a totals row that is a list, not a dict
			["Total", "", "", 1500.0],
		]
		for name, row in self.records(A).items():
			for data in (rows, []):
				with self.subTest(alert=name, rows=len(data)):
					alert = frappe.get_doc(copy.deepcopy(row))
					filters = alerts.resolve_filters(alert)
					for token in json.loads(row["dynamic_filters_json"]).values():
						self.assertIn(token.split(":")[0], [t.split(":")[0] for t in alerts.alerts_dates.TOKENS])
					ctx = templates.context_for(
						None, None, {"rows": data, "columns": [], "report": alert.report, "filters": filters, "row_count": len(data)},
						doc=frappe._dict(), recipient={"phone_e164": PHONE},
					)
					result = templates.render(row["message"], ctx)
					self.assertIsNone(result.error)
					self.assertTrue(result.text)
					self.assertIsNone(LEFTOVER.search(result.text), result.text)

	def test_company_token(self):
		shipped = json.dumps({"company": standards.COMPANY_TOKEN, "range": "30"})
		with patch.object(standards, "default_company", return_value="ACME"):
			self.assertEqual(json.loads(standards._site_filters(shipped)), {"company": "ACME", "range": "30"})
			# the site's own filters stay; only a company it never chose is filled in
			own = json.dumps({"company": "Other", "range": "60"})
			self.assertEqual(standards._site_filters(shipped, own), own)
			self.assertEqual(json.loads(standards._site_filters(shipped, json.dumps({"range": "60"}))), {"company": "ACME", "range": "60"})
		with patch.object(standards, "default_company", return_value=None):
			self.assertEqual(json.loads(standards._site_filters(shipped)), {"range": "30"})


# ---- the sync rules, on synthetic records ----------------------------------------------------

TPL = "WA-TEST Standard Template"
NOTIF = "WA-TEST Standard Notification"
ALERT = "WA-TEST Standard Alert"


def shipped() -> dict[str, dict[str, dict]]:
	"""A small standard set as a fixture file would hold it — deliberately shipped *enabled* with a
	device and counters, which no file may do: the import must not trust it."""
	return {
		T: {TPL: {"doctype": T, "name": TPL, "template_name": TPL, "message_type": "Text", "body": "shipped v1 {{ doc.name }}", "category": "Test", "use_count": 9}},
		N: {
			NOTIF: {
				"doctype": N, "name": NOTIF, "notification_name": NOTIF, "enabled": 1, "device": "WAD-TEST-STANDARDS",
				"document_type": "ToDo", "event": "New", "condition_type": "Python", "condition": "doc.status == 'Open'",
				"template": TPL, "message_type": "Text", "send_count": 4, "last_sent_at": "2026-01-01 10:00:00",
				"recipients": [{"recipient_type": "Document Field", "receiver_by_document_field": "description"}],
			}
		},
		A: {
			ALERT: {
				"doctype": A, "name": ALERT, "alert_name": ALERT, "enabled": 1, "device": "WAD-TEST-STANDARDS",
				"periodicity": "Daily", "notification_time": "08:00:00", "content_type": "Static Message",
				"message": "shipped alert v1", "attachment_format": "None", "send_count": 2,
				"recipients": [{"recipient_type": "Role", "role": "System Manager"}],
			}
		},
	}


class TestStandardSync(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("Standards Test Device", "WAD-TEST-STANDARDS", phone="+966500931700")
		ensure_settings()

	def setUp(self):
		self.set = shipped()
		self._clean()
		patcher = patch.object(standards, "records", side_effect=lambda doctype: self.set.get(doctype, {}))
		patcher.start()
		self.addCleanup(patcher.stop)
		self.addCleanup(self._clean)

	@staticmethod
	def _clean():
		for doctype, name in ((N, NOTIF), (A, ALERT), (T, TPL)):
			delete_all(doctype, {"name": name})
			standards._store_fingerprint(doctype, name, None)
		frappe.flags.wa_standards_pending = None

	def sync(self):
		"""What `sync_fixtures` does with each file (`data_import.import_doc`), without its commit."""
		for doctype in (T, N, A):
			with tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False) as f:
				json.dump(list(copy.deepcopy(self.set[doctype]).values()), f, ensure_ascii=False)
			try:
				import_file_by_path(f.name, data_import=True, force=True, reset_permissions=True)
			finally:
				os.unlink(f.name)
				frappe.flags.in_import = False

	def test_a_new_record_is_created_switched_off(self):
		self.sync()
		notif = frappe.get_doc(N, NOTIF)
		self.assertEqual((notif.enabled, notif.device, notif.send_count, notif.last_sent_at), (0, None, 0, None))
		alert = frappe.get_doc(A, ALERT)
		self.assertEqual((alert.enabled, alert.device, alert.send_count), (0, None, 0))
		self.assertEqual(frappe.db.get_value(T, TPL, "use_count"), 0)
		for doctype, name in ((T, TPL), (N, NOTIF), (A, ALERT)):
			self.assertEqual(standards.status(doctype, name), {"standard": True, "customised": False})
		# and a second sync creates nothing twice
		self.sync()
		self.assertEqual(frappe.db.count(N, {"name": NOTIF}), 1)
		self.assertEqual(frappe.db.count("WhatsApp Notification Recipient", {"parent": NOTIF}), 1)

	def _owner_switches_on(self):
		notif = frappe.get_doc(N, NOTIF)
		notif.enabled, notif.device = 1, self.device
		notif.set("recipients", [{"recipient_type": "Fixed Number", "phone": PHONE}])
		notif.save()
		frappe.db.set_value(N, NOTIF, {"send_count": 7, "last_sent_at": "2026-02-02 10:00:00", "last_error": "x", "last_error_at": "2026-02-02 10:00:01"}, update_modified=False)
		alert = frappe.get_doc(A, ALERT)
		alert.enabled, alert.device = 1, self.device
		alert.set("recipients", [{"recipient_type": "Phone", "phone": PHONE}])
		alert.save()
		frappe.db.set_value(A, ALERT, {"send_count": 3, "last_sent_at": "2026-02-02 08:00:00", "next_run_at": "2026-02-03 08:00:00"}, update_modified=False)
		frappe.db.set_value(T, TPL, {"disabled": 1, "use_count": 5, "last_used_at": "2026-02-02 09:00:00"}, update_modified=False)

	def _state(self):
		out = {}
		for doctype, name in ((T, TPL), (N, NOTIF), (A, ALERT)):
			doc = frappe.get_doc(doctype, name).as_dict()
			doc["recipients"] = [(r.recipient_type, r.get("phone_e164"), r.get("role")) for r in doc.get("recipients") or []]
			out[name] = {k: str(v) for k, v in doc.items()}
		return out

	def test_a_sync_keeps_what_the_site_owns(self):
		self.sync()
		self._owner_switches_on()
		before = self._state()
		self.assertEqual(before[NOTIF]["enabled"], "1")
		self.sync()
		self.sync()
		after = self._state()
		for name in before:
			# every field: enabled, device, recipients, counters, timestamps, creation, modified …
			self.assertEqual(after[name], before[name], name)
		self.assertEqual(standards.status(N, NOTIF)["customised"], False)

	def test_shipped_content_reaches_a_record_the_owner_did_not_edit(self):
		self.sync()
		self._owner_switches_on()
		modified = frappe.db.get_value(T, TPL, "modified")
		self.set[T][TPL]["body"] = "shipped v2 {{ doc.name }}"
		self.set[N][NOTIF]["condition"] = "doc.status != 'Closed'"
		self.set[A][ALERT]["message"] = "shipped alert v2"
		self.sync()
		self.assertEqual(frappe.db.get_value(T, TPL, "body"), "shipped v2 {{ doc.name }}")
		self.assertNotEqual(frappe.db.get_value(T, TPL, "modified"), modified)
		notif = frappe.get_doc(N, NOTIF)
		self.assertEqual(notif.condition, "doc.status != 'Closed'")
		# … and the owner's state is still his
		self.assertEqual((notif.enabled, notif.device, notif.send_count), (1, self.device, 7))
		self.assertEqual([r.phone_e164 for r in notif.recipients], [PHONE])
		alert = frappe.get_doc(A, ALERT)
		self.assertEqual((alert.message, alert.enabled, alert.send_count), ("shipped alert v2", 1, 3))
		# the schedule did not change: the run the alert was waiting for is kept
		self.assertEqual(str(alert.next_run_at), "2026-02-03 08:00:00")
		self.assertEqual((frappe.db.get_value(T, TPL, "disabled"), frappe.db.get_value(T, TPL, "use_count")), (1, 5))
		self.assertFalse(standards.status(T, TPL)["customised"])

	def test_a_record_the_owner_edited_is_never_overwritten(self):
		self.sync()
		doc = frappe.get_doc(T, TPL)
		doc.body = "the owner's own words {{ doc.name }}"
		doc.save()
		notif = frappe.get_doc(N, NOTIF)
		notif.condition = "doc.priority == 'High'"
		notif.save()
		self.assertTrue(standards.status(T, TPL)["customised"])
		before = self._state()
		self.set[T][TPL]["body"] = "shipped v2"
		self.set[N][NOTIF]["condition"] = "doc.status != 'Closed'"
		self.set[N][NOTIF]["event"] = "Save"
		self.sync()
		self.sync()
		self.assertEqual(self._state(), before)
		self.assertTrue(standards.status(N, NOTIF)["customised"])
		# asked for, the shipped content comes back — and his state stays
		frappe.db.set_value(N, NOTIF, "send_count", 11, update_modified=False)
		standards.restore(N, NOTIF)
		notif = frappe.get_doc(N, NOTIF)
		self.assertEqual((notif.condition, notif.event, notif.send_count), ("doc.status != 'Closed'", "Save", 11))
		self.assertFalse(standards.status(N, NOTIF)["customised"])

	def test_a_record_that_only_shares_a_standard_name_is_the_owners(self):
		"""No fingerprint: the site had this record before the app shipped one by that name."""
		frappe.get_doc({"doctype": T, "template_name": TPL, "message_type": "Text", "body": "mine", "category": "Mine"}).insert()
		self.sync()
		self.assertEqual(frappe.db.get_value(T, TPL, ["body", "category"]), ("mine", "Mine"))
		self.assertTrue(standards.status(T, TPL)["customised"])

	def test_a_deleted_record_comes_back_switched_off(self):
		self.sync()
		self._owner_switches_on()
		frappe.delete_doc(N, NOTIF, force=1)
		self.sync()
		self.assertEqual(frappe.db.get_value(N, NOTIF, ["enabled", "device", "send_count"]), (0, None, 0))

	def test_other_records_are_imported_as_frappe_does(self):
		self.assertFalse(standards.is_standard(T, "WA-TEST Not Standard"))
		row = {"doctype": T, "name": "WA-TEST Not Standard", "template_name": "WA-TEST Not Standard", "message_type": "Text", "body": "x"}
		before = copy.deepcopy(row)
		standards.prepare_for_import(row)
		self.assertEqual(row, before)
