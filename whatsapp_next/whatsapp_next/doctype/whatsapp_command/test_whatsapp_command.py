# Module role: tests for WhatsApp Command — permission matrix (02 §6), word normalization and cross-command
# uniqueness, settings-override keys, output copy from the Function and the edit lock while Active.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAStateConflictError, WAValidationError
from whatsapp_next.install import ensure_roles
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_test_user

DT = "WhatsApp Command"
# Link targets are real site data (or sibling DocTypes); no fixture generation needed.
IGNORE_TEST_RECORD_DEPENDENCIES = [
	"WhatsApp Function",
	"DocType",
	"WhatsApp Contact Group",
	"WhatsApp Device",
	"Print Format",
]
FUNCTION_KEY = "_wa_test_cmd_fn"


class TestWhatsAppCommand(IntegrationTestCase):
	"""Command words are unique across commands and frozen while Active."""

	def setUp(self) -> None:
		super().setUp()
		ensure_roles()
		frappe.set_user("Administrator")
		if not frappe.db.exists("WhatsApp Function", FUNCTION_KEY):
			frappe.get_doc(
				{
					"doctype": "WhatsApp Function",
					"function_key": FUNCTION_KEY,
					"function_name": "Command Test Function",
					"installed_version": "1.0.0",
					"settings": [{"key": "limit", "label": "Limit", "fieldtype": "Int", "value": "5"}],
					"outputs": [
						{"output_key": "reply", "label": "Reply", "default_template": "Hi {{ data.name }}"},
						{
							"output_key": "pdf",
							"label": "PDF",
							"output_type": "Document",
							"template": "Statement",
						},
					],
				}
			).insert(ignore_permissions=True)

	def tearDown(self) -> None:
		frappe.set_user("Administrator")
		delete_all(DT, {"code": ["like", "_wa_test%"]})
		delete_all("WhatsApp Function", {"function_key": FUNCTION_KEY})
		super().tearDown()

	def _insert(self, code: str = "_wa_test balance", **values):
		payload = {"doctype": DT, "code": code, "function": FUNCTION_KEY}
		payload.update(values)
		return frappe.get_doc(payload).insert(ignore_permissions=True)

	def test_permission_matrix(self) -> None:
		expected = {
			"System Manager": {"read": True, "write": True, "create": True, "delete": True, "export": True},
			"WhatsApp Manager": {"read": True, "write": True, "create": True, "delete": True, "export": True},
			"WhatsApp Agent": {"read": True, "write": False, "create": False, "delete": False},
			"WhatsApp Viewer": {"read": True, "write": False, "create": False, "delete": False},
			"WhatsApp Contact User": {"read": False, "write": False, "create": False},
		}
		for role, ptypes in expected.items():
			user = ensure_test_user(role)
			for ptype, allowed in ptypes.items():
				with self.subTest(role=role, ptype=ptype):
					self.assertEqual(bool(frappe.has_permission(DT, ptype, user=user)), allowed)

	def test_words_normalized_and_outputs_copied(self) -> None:
		doc = self._insert(code="  _wa_test Balance ", synonyms=" Bal \nBAL\n\nrasid ")
		self.assertEqual(doc.name, "_wa_test balance")
		self.assertEqual(doc.code, "_wa_test balance")
		self.assertEqual(doc.title, "_wa_test balance")
		self.assertEqual(doc.synonyms, "bal\nrasid")
		self.assertEqual(doc.status, "Inactive")
		self.assertEqual([o.output_key for o in doc.outputs], ["reply", "pdf"])
		self.assertEqual(doc.outputs[0].template, "Hi {{ data.name }}")
		self.assertEqual(doc.outputs[1].template, "Statement")

	def test_synonym_equal_to_code_rejected(self) -> None:
		with self.assertRaises(WAValidationError):
			self._insert(code="_wa_test x", synonyms="_WA_TEST X")

	def test_words_unique_across_commands(self) -> None:
		self._insert(code="_wa_test one", synonyms="_wa_test uno")
		with self.assertRaises(WAValidationError):
			self._insert(code="_wa_test uno")
		with self.assertRaises(WAValidationError):
			self._insert(code="_wa_test two", synonyms="_WA_TEST ONE")
		other = self._insert(code="_wa_test two", synonyms="_wa_test dos")
		self.assertEqual(other.synonyms, "_wa_test dos")

	def test_settings_overrides_keys_validated(self) -> None:
		with self.assertRaises(WAValidationError):
			self._insert(settings_overrides={"unknown": 1})
		with self.assertRaises(WAValidationError):
			self._insert(settings_overrides="{not json")
		doc = self._insert(settings_overrides={"limit": 9})
		self.assertEqual(doc.overrides_dict(), {"limit": 9})

	def test_party_types_validated(self) -> None:
		with self.assertRaises(WAValidationError):
			self._insert(allowed_party_types=[{"party_type": "ToDo"}])
		doc = self._insert(allowed_party_types=[{"party_type": "Customer"}, {"party_type": "Sales Person"}])
		self.assertEqual(len(doc.allowed_party_types), 2)

	def test_edit_lock_while_active(self) -> None:
		doc = self._insert(synonyms="_wa_test bal")
		doc.status = "Active"
		doc.save()  # only status changed: allowed
		doc.reload()
		doc.synonyms = "_wa_test bal\n_wa_test rasid"
		with self.assertRaises(WAStateConflictError):
			doc.save()
		doc.reload()
		doc.description = "note"
		with self.assertRaises(WAStateConflictError):
			doc.save()
		doc.reload()
		doc.outputs[0].template = "changed"
		with self.assertRaises(WAStateConflictError):
			doc.save()
		doc.reload()
		doc.run_count = 3
		doc.save()  # counters are unlocked
		doc.reload()
		doc.status = "Inactive"
		doc.save()
		doc.reload()
		doc.synonyms = "_wa_test bal\n_wa_test rasid"
		doc.save()
		self.assertEqual(doc.synonyms, "_wa_test bal\n_wa_test rasid")

	def test_restore_defaults_recopies_outputs(self) -> None:
		doc = self._insert()
		doc.outputs[0].template = "custom"
		doc.save()
		doc.copy_outputs_from_function()
		doc.save()
		self.assertEqual(doc.outputs[0].template, "Hi {{ data.name }}")
