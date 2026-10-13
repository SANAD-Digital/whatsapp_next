# Module role: tests for WhatsApp Command — permission matrix (02 §6), word normalization and cross-command
# uniqueness, settings-override keys, the inputs / message texts / replies named against the function's
# header, party types within its `@party_types`, and the edit lock while Active.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAStateConflictError, WAValidationError
from whatsapp_next.tests import function_fixtures as ff
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_test_user

DT = "WhatsApp Command"
# Link targets are real site data (or sibling DocTypes); no fixture generation needed.
IGNORE_TEST_RECORD_DEPENDENCIES = [
	"WhatsApp Function",
	"DocType",
	"WhatsApp Contact Group",
	"WhatsApp Device",
	"Print Format",
	"Contact",
]
FUNCTION_KEY = "_test_typed"  # params doc_name, days, since; party types Customer, Supplier


class TestWhatsAppCommand(IntegrationTestCase):
	"""Command words are unique across commands and frozen while Active."""

	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ff.drop_all()
		ff.ensure_function(FUNCTION_KEY)
		ff.ensure_function("_test_echo")

	def setUp(self) -> None:
		super().setUp()
		frappe.set_user("Administrator")

	def tearDown(self) -> None:
		frappe.set_user("Administrator")
		delete_all(DT, {"code": ["like", "_wa_test%"]})
		super().tearDown()

	def _insert(self, code: str = "_wa_test balance", function: str = FUNCTION_KEY, **values):
		payload = {"doctype": DT, "code": code, "function": function}
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

	def test_words_normalized(self) -> None:
		doc = self._insert(code="  _wa_test Balance ", synonyms=" Bal \nBAL\n\nrasid ")
		self.assertEqual(doc.name, "_wa_test balance")
		self.assertEqual(doc.code, "_wa_test balance")
		self.assertEqual(doc.title, "_wa_test balance")
		self.assertEqual(doc.synonyms, "bal\nrasid")
		self.assertEqual(doc.status, "Inactive")
		self.assertEqual(doc.templates, [])  # nothing copied: the function's texts apply until changed

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
		for bad in ({"unknown": 1}, {"party": "X"}, {"party_type": "Customer"}, "{not json", "[1]"):
			with self.subTest(overrides=bad), self.assertRaises(WAValidationError):
				self._insert(settings_overrides=bad)
		doc = self._insert(settings_overrides={"days": 9, "language": "en"})
		self.assertEqual(doc.overrides_dict(), {"days": 9, "language": "en"})

	def test_names_checked_against_the_header(self) -> None:
		for bad in (
			{"disabled_inputs": "party"},
			{"disabled_inputs": "nope"},
			{"ask_inputs": "nope: 1, 2"},
			{"disabled_replies": "nope"},
		):
			with self.subTest(values=bad), self.assertRaises(WAValidationError):
				self._insert(**bad)
		doc = self._insert(
			disabled_inputs="since\nsince\n", ask_inputs="days: 1, 3=Three", disabled_replies=" result_text "
		)
		self.assertEqual((doc.disabled_inputs, doc.disabled_replies), ("since", "result_text"))
		# message texts: a Template parameter, once per language
		with self.assertRaises(WAValidationError):
			self._insert(
				code="_wa_test t1", function="_test_echo", templates=[{"param": "text", "text": "x"}]
			)
		with self.assertRaises(WAValidationError):
			self._insert(
				code="_wa_test t2",
				function="_test_echo",
				templates=[
					{"param": "msg_result", "language": "en", "text": "a"},
					{"param": "msg_result", "language": "en", "text": "b"},
				],
			)
		doc = self._insert(
			code="_wa_test t3",
			function="_test_echo",
			templates=[
				{"param": "msg_result", "language": "en", "text": "a"},
				{"param": "msg_result", "language": "ar", "text": "b"},
				{"param": "msg_result", "text": "every language"},
			],
		)
		# a row without a language is for every language: the site's default language never fills it
		doc.reload()
		self.assertEqual([r.language for r in doc.templates], ["en", "ar", None])

	def test_party_types_validated(self) -> None:
		with self.assertRaises(WAValidationError):
			self._insert(allowed_party_types=[{"party_type": "ToDo"}])
		# within the header's `@party_types` (Customer, Supplier)
		with self.assertRaises(WAValidationError):
			self._insert(allowed_party_types=[{"party_type": "Employee"}])
		doc = self._insert(allowed_party_types=[{"party_type": "Customer"}, {"party_type": "Supplier"}])
		self.assertEqual(len(doc.allowed_party_types), 2)
		doc = self._insert(
			code="_wa_test any", function="_test_echo", allowed_party_types=[{"party_type": "Sales Person"}]
		)
		self.assertEqual(len(doc.allowed_party_types), 1)

	def test_edit_lock_while_active(self) -> None:
		doc = self._insert(
			code="_wa_test lock",
			function="_test_echo",
			synonyms="_wa_test bal",
			templates=[{"param": "msg_result", "language": "en", "text": "a"}],
		)
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
		doc.templates[0].text = "changed"
		with self.assertRaises(WAStateConflictError):
			doc.save()
		doc.reload()
		doc.disabled_replies = "result_text"
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

	def test_map_follows_saves(self) -> None:
		from whatsapp_next.services.command_router import command_map

		doc = self._insert(code="_wa_test mapped", status="Active")
		self.assertEqual(command_map().get("_wa_test mapped"), doc.name)
		doc.delete(ignore_permissions=True)
		self.assertIsNone(command_map().get("_wa_test mapped"))
