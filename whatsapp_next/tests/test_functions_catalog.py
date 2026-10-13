# Tests for services/functions_catalog.py (WHATSAPP_NEXT_INTEGRATION §2–§4): discovery of function
# scripts and its cache, `script_spec`, diff-before-install, install / update / remove rules with their
# audit rows, status, the site's values, the daily update check and the storefront states. Uses the
# fixture scripts of function_fixtures.py only.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WANotFoundError, WAStateConflictError, WAValidationError
from whatsapp_next.services import functions_catalog as fc
from whatsapp_next.tests import function_fixtures as ff


class TestFunctionsCatalog(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ff.drop_all()

	def setUp(self):
		ff.drop_all()
		self._lang = frappe.local.lang
		frappe.local.lang = "en"

	def tearDown(self):
		frappe.local.lang = self._lang

	def _audit(self, action: str, key: str) -> int:
		return frappe.db.count(
			"WhatsApp Audit Log",
			{"action": action, "reference_doctype": "WhatsApp Function", "reference_name": key},
		)

	def test_discover_reads_function_scripts_and_caches_them(self):
		name, script = ff.FUNCTIONS["_test_echo"]
		ff.ensure_script(name, script)
		entry = {e["server_script"]: e for e in fc.discover()}[name]
		self.assertEqual(
			(entry["spec"]["function"], entry["error"], entry["guarded"]), ("_test_echo", None, True)
		)
		self.assertEqual(len(entry["checksum"]), 64)
		cached = frappe.cache.get_value(fc._CACHE_KEY)
		self.assertTrue(any(k.startswith(name + "|") for k in cached))
		# saving the script drops the cache (doc_event), and the new header is read
		ff.ensure_script(name, script.replace("@title        Test Echo", "@title        Test Echo 2"))
		self.assertIsNone(frappe.cache.get_value(fc._CACHE_KEY))
		self.assertEqual({e["server_script"]: e for e in fc.discover()}[name]["spec"]["title"], "Test Echo 2")

	def test_script_spec(self):
		name, script = ff.FUNCTIONS["_test_echo"]
		ff.ensure_script(name, script)
		spec, checksum = fc.script_spec(name)
		self.assertEqual([p["name"] for p in spec["params"]], ["text", "party_type", "party", "msg_result"])
		# the checksum is the header's: code below it does not change it
		ff.ensure_script(name, script + "\n# a code comment\n")
		self.assertEqual(fc.script_spec(name)[1], checksum)
		with self.assertRaises(WANotFoundError):
			fc.script_spec("wa_fn__test_nope")
		ff.ensure_script("wa_fn__test_other", script, api_method="not_a_function")
		with self.assertRaises(WAValidationError):
			fc.script_spec("wa_fn__test_other")
		ff.ensure_script("wa_fn__test_broken", "# no header at all\nx = 1\n")
		with self.assertRaises(WAValidationError):
			fc.script_spec("wa_fn__test_broken")

	def test_install_diff_update_remove(self):
		name, script = ff.FUNCTIONS["_test_typed"]
		ff.ensure_script(name, script)
		d = fc.diff(name)
		self.assertEqual(
			(d["function_key"], d["installed_version"], d["target_version"], d["changed"], d["available"]),
			("_test_typed", None, "1.0.0", True, True),
		)
		self.assertEqual(d["params"]["added"], sorted(["party_type", "party", "doc_name", "days", "since"]))
		self.assertEqual(d["replies"]["added"], ["result_text"])
		self.assertEqual(d["commands_impacted"], [])

		key = fc.install(name)
		doc = frappe.get_doc("WhatsApp Function", key)
		self.assertEqual(
			(doc.name, doc.server_script, doc.status, doc.installed_version, doc.function_name),
			("_test_typed", name, "Active", "1.0.0", "Test Typed"),
		)
		self.assertEqual(doc.manifest_checksum, fc.script_spec(name)[1])
		self.assertEqual(
			fc.manifest_of(doc)["party_types"], {"mode": "only", "types": ["Customer", "Supplier"]}
		)
		self.assertEqual(doc.installed_by, frappe.session.user)
		self.assertEqual(self._audit("Function Installed", key), 1)
		with self.assertRaises(WAStateConflictError):
			fc.install(name)

		# same header: nothing changes, the update is still allowed and audited
		self.assertFalse(fc.diff(name)["changed"])
		fc.update(key)
		self.assertEqual(self._audit("Function Updated", key), 1)

		# a script that now declares another function cannot update this one
		ff.ensure_script(name, script.replace("@function     _test_typed", "@function     _test_renamed"))
		with self.assertRaises(WAValidationError):
			fc.update(key)
		ff.ensure_script(name, script)

		# an Active command blocks removal
		cmd = ff.make_command("tfcdoc", key)
		self.assertEqual(fc.diff(name)["commands_impacted"], [cmd])
		with self.assertRaises(WAStateConflictError):
			fc.remove(key)
		frappe.delete_doc("WhatsApp Command", cmd, ignore_permissions=True)
		fc.remove(key)
		self.assertFalse(frappe.db.exists("WhatsApp Function", key))
		self.assertEqual(self._audit("Function Removed", key), 1)
		with self.assertRaises(WANotFoundError):
			fc.remove(key)
		with self.assertRaises(WANotFoundError):
			fc.update(key)

	def test_disabled_script_is_neither_listed_nor_installable(self):
		name, script = ff.FUNCTIONS["_test_echo"]
		ff.ensure_script(name, script, disabled=1)
		self.assertNotIn(name, [e["server_script"] for e in fc.discover(use_cache=False)])
		with self.assertRaises(WAValidationError):
			fc.install(name)

	def test_status_and_values(self):
		key = ff.ensure_function("_test_typed")
		self.assertEqual(fc.set_status(key, "Inactive"), "Inactive")
		self.assertEqual(fc.set_status(key, "Inactive"), "Inactive")
		self.assertEqual(fc.set_status(key, "Active"), "Active")
		with self.assertRaises(WANotFoundError):
			fc.set_status("_test_nope", "Active")

		self.assertEqual(
			fc.save_values(key, {"days": "7", "since": "month_start"}), {"days": 7, "since": "month_start"}
		)
		self.assertEqual(fc.values_of(key), {"days": 7, "since": "month_start"})
		with self.assertRaises(WAValidationError):
			fc.save_values(key, {"party": "Someone"})  # the sender's, never the site's
		with self.assertRaises(WAValidationError):
			fc.save_values(key, {"nope": 1})
		with self.assertRaises(WAValidationError):
			fc.save_values(key, {"days": "seven"})
		with self.assertRaises(WAValidationError):
			fc.save_values(key, ["days"])
		# empty clears to the header's default
		self.assertEqual(fc.save_values(key, {"days": ""}), {"since": "month_start"})

		echo = ff.ensure_function("_test_echo")
		out = fc.save_values(echo, {"msg_result": {"en": "hi {{ echo }}", "ar": "", "": "all"}})
		self.assertEqual(out, {"msg_result": {"en": "hi {{ echo }}", "": "all"}})
		self.assertEqual(fc.save_values(echo, {"msg_result": "one text"}), {"msg_result": "one text"})
		self.assertEqual(fc.save_values(echo, {"msg_result": {}}), {})
		# the controller refuses values that are not the header's parameters
		doc = frappe.get_doc("WhatsApp Function", echo)
		doc.values = '{"nope": 1}'
		with self.assertRaises(WAValidationError):
			doc.save(ignore_permissions=True)

	def test_check_updates_and_storefront_states(self):
		key = ff.ensure_function("_test_echo")
		name, script = ff.FUNCTIONS["_test_echo"]
		mine = lambda: {e["server_script"]: e for e in fc.storefront() if e["server_script"]}  # noqa: E731
		self.assertEqual(mine()[name]["state"], "available")
		self.assertTrue(mine()[name]["installed"])
		counts = fc.check_updates()
		self.assertGreaterEqual(counts["checked"], 1)
		self.assertEqual(frappe.db.get_value("WhatsApp Function", key, "update_available"), 0)

		ff.ensure_script(name, script.replace("@version      1.0.0", "@version      1.1.0"))
		counts = fc.check_updates()
		self.assertGreaterEqual(counts["updates"], 1)
		self.assertEqual(frappe.db.get_value("WhatsApp Function", key, "update_available"), 1)
		entry = mine()[name]
		self.assertEqual(
			(entry["state"], entry["update_available"], entry["version"]), ("update", True, "1.1.0")
		)
		self.assertEqual(entry["installed_version"], "1.0.0")
		fc.update(key)
		self.assertEqual(mine()[name]["state"], "available")

		# the script goes away: the installed function is listed as missing
		frappe.delete_doc("Server Script", name, ignore_permissions=True, force=True)
		fc.clear_cache()
		missing = {e["function_key"]: e for e in fc.storefront()}[key]
		self.assertEqual(
			(missing["state"], missing["installed"], missing["available"]), ("missing", True, False)
		)
		self.assertGreaterEqual(fc.check_updates()["missing"], 1)
