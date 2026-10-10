# Tests for api/v1/testlab.py and services/testlab.py (the Test Lab page): the manager-only gate,
# the page's opening read, the health checks (scheduler, queue), the run's server-side guards
# (recipients limited to the run's numbers, the hard cap, the pacing, the owner of the run), each
# check going through the product's own path and coming out marked `is_test`, a refused check
# recorded as a failed step instead of raised, and the status read that follows a run to its
# receipts. Nothing leaves the site: a test run never kicks the dispatcher, and the one check
# that would ask the platform is mocked.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import testlab as api
from whatsapp_next.exceptions import (
	WAInvalidPhoneError,
	WANotFoundError,
	WAPermissionError,
	WAValidationError,
)
from whatsapp_next.services import testlab
from whatsapp_next.services.guards import status_writer
from whatsapp_next.tests.conftest_frappe import (
	as_user,
	delete_all,
	ensure_device,
	ensure_settings,
)

P1, P2, P3 = "+966500930101", "+966500930102", "+966500930103"
TAG = "ApiTest lab"
TEMPLATE = "ApiTest lab tpl"
NOTIFICATION = "ApiTest lab notification"
ALERT = "ApiTest lab alert"


class TestApiTestLab(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("ApiTest Device LAB", "WAD-TEST-LAB1", phone="+966500930001")
		ensure_settings(default_device=cls.device, queue_paused=0, send_only_to_known_numbers=0)
		# the runs of a test never show in the site's own history
		cls.patches = [
			patch.object(testlab, "RUN_KEY", "wa:testlab:apitest:run:{0}"),
			patch.object(testlab, "AUDIT_START", "ApiTest lab run started"),
			patch.object(testlab, "AUDIT_CHECK", "ApiTest lab check"),
		]
		for p in cls.patches:
			p.start()
		cls._clean_config()
		frappe.get_doc(
			{
				"doctype": "WhatsApp Template",
				"template_name": TEMPLATE,
				"message_type": "Text",
				"reference_doctype": "ToDo",
				"body": f"{TAG} tpl {{{{ doc.description }}}}",
			}
		).insert(ignore_permissions=True)
		frappe.get_doc(
			{
				"doctype": "WhatsApp Notification",
				"notification_name": NOTIFICATION,
				"enabled": 1,
				"document_type": "ToDo",
				"event": "Save",
				"message": f"{TAG} notif {{{{ doc.description }}}}",
				"recipients": [{"recipient_type": "Fixed Number", "phone": P3}],
			}
		).insert(ignore_permissions=True)
		cls.todo = frappe.get_doc({"doctype": "ToDo", "description": "ApiTest lab todo"}).insert(ignore_permissions=True).name

	@classmethod
	def tearDownClass(cls):
		cls._clean_rows()
		cls._clean_config()
		for run in testlab.runs():
			frappe.cache.delete_value(testlab.RUN_KEY.format(run["id"]))
		for p in cls.patches:
			p.stop()
		super().tearDownClass()

	def setUp(self):
		self._clean_rows()
		ensure_settings(queue_paused=0, send_only_to_known_numbers=0)

	@classmethod
	def _clean_config(cls):
		delete_all("WhatsApp Notification", {"name": NOTIFICATION})
		delete_all("WhatsApp Notification Alert", {"name": ALERT})
		delete_all("WhatsApp Template", {"name": TEMPLATE})
		delete_all("ToDo", {"description": "ApiTest lab todo"})

	@classmethod
	def _clean_rows(cls):
		names = frappe.get_all("WhatsApp Log", filters={"device": cls.device}, pluck="name")
		if names:
			delete_all("WhatsApp Queue Item", {"outbound_message": ("in", names)})
			delete_all("WhatsApp Log", {"name": ("in", names)})
		delete_all("WhatsApp Campaign", {"device": cls.device})

	# ---- helpers ----------------------------------------------------------------------------

	def _run(self, targets=(P1,), **kwargs) -> dict:
		return api.start_run(device=self.device, targets=list(targets), **kwargs)

	@staticmethod
	def _rewind(run: str) -> None:
		"""Let the next message leave now: the run's pacing is treated as already spent."""
		data = frappe.cache.get_value(testlab.RUN_KEY.format(run))
		data["last_send"] = 0.0
		frappe.cache.set_value(testlab.RUN_KEY.format(run), data, expires_in_sec=testlab.RUN_TTL)

	def _log(self, name: str):
		return frappe.db.get_value(
			"WhatsApp Log",
			name,
			["phone_e164", "status", "is_test", "source_type", "message_type", "body", "queue_item", "attachment", "notification", "template", "reference_name"],
			as_dict=True,
		)

	# ---- gate and reads ---------------------------------------------------------------------

	def test_only_managers(self):
		"""The page sends real messages: an Agent, a Viewer and a user with no role are refused."""
		for role in ("WhatsApp Agent", "WhatsApp Viewer", "_none"):
			with as_user(role):
				for fn, kwargs in (
					(api.get_context, {}),
					(api.get_health, {}),
					(api.start_run, {"device": self.device, "targets": [P1]}),
					(api.run_check, {"run": "x", "kind": "quick_text", "target": P1}),
					(api.get_status, {"run": "x"}),
					(api.list_runs, {}),
					(api.identify, {"phones": [P1]}),
					(api.search_documents, {"doctype": "ToDo"}),
					(api.preview, {"kind": "template", "params": {"template": TEMPLATE}}),
				):
					with self.assertRaises(WAPermissionError, msg=f"{role} {fn.__name__}"):
						fn(**kwargs)

	def test_get_context(self):
		with as_user("WhatsApp Manager"):
			ctx = api.get_context()
		self.assertIn(self.device, [d["name"] for d in ctx["devices"]])
		self.assertEqual(ctx["default_device"], self.device)
		self.assertEqual((ctx["limits"]["cap"], ctx["limits"]["cap_max"]), (20, 50))
		self.assertGreaterEqual(ctx["limits"]["pacing_min"], 3)
		self.assertIn(TEMPLATE, [t["name"] for t in ctx["templates"]])
		self.assertIn(NOTIFICATION, [n["name"] for n in ctx["notifications"]])
		self.assertEqual(set(ctx["samples"]), {"image", "document"})
		for key in ("alerts", "commands", "commands_enabled", "history", "me"):
			self.assertIn(key, ctx)

	def test_identify_and_documents(self):
		with as_user("WhatsApp Manager"):
			rows = api.identify(phones=["0500930101", "nope"])
			self.assertEqual((rows[0]["valid"], rows[0]["phone_e164"], rows[0]["blacklisted"]), (True, P1, False))
			self.assertFalse(rows[1]["valid"])
			with self.assertRaises(WAValidationError):
				api.search_documents(doctype="No Such ApiTest DocType")
		with as_user("System Manager"):
			found = api.search_documents(doctype="ToDo", txt="ApiTest lab todo")
		self.assertFalse(found["no_access"])
		self.assertIn(self.todo, [r["name"] for r in found["rows"]])

	# ---- health -----------------------------------------------------------------------------

	def test_health_names_every_part(self):
		# `live` asks the platform through the product's own connection test, which writes what it
		# learns on Settings: it is only checked to be called, so the site's real plan stays as it is
		with patch("whatsapp_next.services.onboarding.test_connection") as test_connection, as_user("System Manager"):
			out = api.get_health(device=self.device, live=True)
		test_connection.assert_called_once()
		by_key = {c["key"]: c for c in out["checks"]}
		self.assertEqual(
			set(by_key),
			{"credentials", "subscription", "webhook", "webhook_traffic", "device", "scheduler", "workers", "queue", "commands"},
		)
		self.assertTrue(out["live"])
		# connected; a fixture device has no webhook registration, which is a warning, not a failure
		self.assertIn(by_key["device"]["status"], ("ok", "warn"))
		for c in out["checks"]:
			self.assertIn(c["status"], ("ok", "warn", "fail"))
			self.assertTrue(c["title"] and c["detail"])
			if c["status"] != "ok":
				self.assertTrue(c["fix"], c["key"])

	def test_health_reports_a_disabled_scheduler(self):
		"""A disabled scheduler stops alerts and scheduled campaigns without an error anywhere
		(2026-10-02: fifteen hours): the check fails and says how to switch it back on."""
		with patch("frappe.utils.scheduler.is_scheduler_inactive", return_value=True), as_user("WhatsApp Manager"):
			out = api.get_health(device=self.device)
		check = next(c for c in out["checks"] if c["key"] == "scheduler")
		self.assertEqual(check["status"], "fail")
		self.assertIn("enable-scheduler", check["fix"])
		self.assertFalse(out["ok"])

	def test_health_reports_a_paused_queue_and_an_offline_device(self):
		ensure_settings(queue_paused=1)
		with status_writer():
			frappe.db.set_value("WhatsApp Device", self.device, "status", "Disconnected")
		try:
			with as_user("WhatsApp Manager"):
				by_key = {c["key"]: c for c in api.get_health(device=self.device)["checks"]}
		finally:
			with status_writer():
				frappe.db.set_value("WhatsApp Device", self.device, "status", "Connected")
			ensure_settings(queue_paused=0)
		self.assertEqual(by_key["queue"]["status"], "fail")
		self.assertEqual(by_key["device"]["status"], "fail")
		self.assertEqual(by_key["device"]["route"], "wa-devices")

	# ---- the run's guards -------------------------------------------------------------------

	def test_start_run_validates_targets_and_limits(self):
		with as_user("WhatsApp Manager"):
			run = self._run(targets=["0500930101", P1, P2], cap=5, pacing=4)
			self.assertEqual(run["targets"], [P1, P2])  # normalised, duplicates dropped
			self.assertEqual((run["cap"], run["pacing"], run["used"]), (5, 4, 0))
			with self.assertRaises(WAInvalidPhoneError):
				self._run(targets=["abc"])
			with self.assertRaises(WAInvalidPhoneError):
				self._run(targets=["120363000000930101@g.us"])  # a group is not a test target
			with self.assertRaises(WAValidationError):
				self._run(targets=[])
			with self.assertRaises(WAValidationError):
				self._run(targets=[f"+96650093{n:04d}" for n in range(200, 200 + testlab.MAX_TARGETS + 1)])
			with self.assertRaises(WAValidationError):
				self._run(cap=testlab.CAP_MAX + 1)
			with self.assertRaises(WAValidationError):
				self._run(pacing=testlab.PACING_MIN - 1)
			with self.assertRaises(WAValidationError):
				api.start_run(device="No Such ApiTest Device", targets=[P1])
		# the service clamps as well, whatever the caller passes
		clamped = testlab.start_run(self.device, [P1], cap=9999, pacing=0)
		self.assertEqual((clamped["cap"], clamped["pacing"]), (testlab.CAP_MAX, testlab.PACING_DEFAULT))

	def test_quick_text_is_a_marked_test_through_the_queue(self):
		with as_user("WhatsApp Manager"):
			run = self._run()
			step = api.run_check(run=run["id"], kind="quick_text", target=P1, params={"body": f"{TAG} hello"})
		self.assertTrue(step["ok"], step)
		self.assertEqual((step["count"], step["dry"]), (1, False))
		log = self._log(step["outbounds"][0])
		self.assertEqual((log.phone_e164, log.is_test, log.source_type, log.status), (P1, 1, "Quick Send", "Queued"))
		self.assertEqual(log.body, f"{TAG} hello")
		self.assertTrue(frappe.db.exists("WhatsApp Queue Item", log.queue_item))
		self.assertTrue(
			frappe.db.exists("WhatsApp Audit Log", {"action": "Test Send", "reference_doctype": "WhatsApp Log", "reference_name": step["outbounds"][0]})
		)

	def test_only_the_runs_own_numbers(self):
		with as_user("WhatsApp Manager"):
			run = self._run()
			with self.assertRaises(WAPermissionError):
				api.run_check(run=run["id"], kind="quick_text", target=P2, params={"body": f"{TAG} x"})
			with self.assertRaises(WAPermissionError):
				api.run_check(run=run["id"], kind="quick_text", params={"body": f"{TAG} x"})
			with self.assertRaises(WAValidationError):
				api.run_check(run=run["id"], kind="no_such_check", target=P1)
			with self.assertRaises(WANotFoundError):
				api.run_check(run="no-such-run", kind="quick_text", target=P1)
		self.assertFalse(frappe.db.exists("WhatsApp Log", {"device": self.device}))

	def test_only_the_user_who_started_the_run_adds_to_it(self):
		with as_user("WhatsApp Manager"):
			run = self._run()
		with as_user("System Manager"):
			with self.assertRaises(WAPermissionError):
				api.run_check(run=run["id"], kind="quick_text", target=P1, params={"body": f"{TAG} x"})
			# reading where it stands is open to every manager
			self.assertEqual(api.get_status(run=run["id"])["run"]["id"], run["id"])

	def test_pacing_is_enforced_on_the_server(self):
		with as_user("WhatsApp Manager"):
			run = self._run(pacing=30)
			first = api.run_check(run=run["id"], kind="quick_text", target=P1, params={"body": f"{TAG} one"})
			self.assertTrue(first["ok"])
			held = api.run_check(run=run["id"], kind="quick_text", target=P1, params={"body": f"{TAG} two"})
			self.assertEqual(list(held), ["wait"])
			self.assertTrue(0 < held["wait"] <= 30)
			self.assertEqual(frappe.db.count("WhatsApp Log", {"device": self.device}), 1)
			self._rewind(run["id"])
			second = api.run_check(run=run["id"], kind="quick_text", target=P1, params={"body": f"{TAG} two"})
			self.assertTrue(second["ok"])
			self.assertEqual(api.get_status(run=run["id"])["run"]["used"], 2)

	def test_cap_is_enforced_on_the_server(self):
		with as_user("WhatsApp Manager"):
			run = self._run(cap=1)
			api.run_check(run=run["id"], kind="quick_text", target=P1, params={"body": f"{TAG} one"})
			self._rewind(run["id"])
			with self.assertRaises(WAValidationError):
				api.run_check(run=run["id"], kind="quick_text", target=P1, params={"body": f"{TAG} two"})
			# a dry run sends nothing, so the cap does not stop it
			dry = api.run_check(run=run["id"], kind="command", target=P1, params={"text": "apitest-lab-no-such-word"})
			self.assertTrue(dry["dry"])
		self.assertEqual(frappe.db.count("WhatsApp Log", {"device": self.device}), 1)

	def test_a_refused_check_is_a_failed_step_not_an_error(self):
		before = len(frappe.local.message_log or [])
		with as_user("WhatsApp Manager"):
			run = self._run()
			step = api.run_check(run=run["id"], kind="template", target=P1, params={"template": "No Such ApiTest Template"})
			self.assertFalse(step["ok"])
			self.assertTrue(step["error"])
			self.assertEqual((step["outbounds"], step["count"]), ([], 0))
			# nothing was sent, so neither the cap nor the pacing moved
			again = api.run_check(run=run["id"], kind="quick_text", target=P1, params={"body": f"{TAG} after"})
			self.assertTrue(again["ok"])
			status = api.get_status(run=run["id"])
		self.assertEqual(len(frappe.local.message_log or []), before)  # no Desk pop-up for a recorded failure
		self.assertEqual([s["state"] for s in status["steps"]], ["failed", "running"])
		self.assertEqual(status["run"]["used"], 1)

	# ---- each check is the product's own path -----------------------------------------------

	def test_template_over_a_real_record(self):
		with as_user("System Manager"):
			run = self._run()
			shown = api.preview(kind="template", params={"template": TEMPLATE, "reference_name": self.todo}, target=P1)
			self.assertEqual(shown["message"], f"{TAG} tpl ApiTest lab todo")
			self.assertEqual((shown["reference_doctype"], shown["reference_name"]), ("ToDo", self.todo))
			step = api.run_check(run=run["id"], kind="template", target=P1, params={"template": TEMPLATE, "reference_name": self.todo})
		self.assertTrue(step["ok"], step)
		log = self._log(step["outbounds"][0])
		self.assertEqual((log.body, log.is_test, log.template, log.reference_name), (f"{TAG} tpl ApiTest lab todo", 1, TEMPLATE, self.todo))

	def test_template_needs_read_on_the_record(self):
		"""A manager who cannot read the record gets a failed step, not the record's fields."""
		name = f"{TEMPLATE} user"
		delete_all("WhatsApp Template", {"name": name})
		frappe.get_doc(
			{"doctype": "WhatsApp Template", "template_name": name, "message_type": "Text", "reference_doctype": "User", "body": f"{TAG} {{{{ doc.email }}}}"}
		).insert(ignore_permissions=True)
		try:
			with as_user("WhatsApp Manager"):
				self.assertFalse(frappe.has_permission("User", "read", "Administrator"))
				run = self._run()
				step = api.run_check(run=run["id"], kind="template", target=P1, params={"template": name, "reference_name": "Administrator"})
				with self.assertRaises(frappe.PermissionError):
					api.preview(kind="template", params={"template": name, "reference_name": "Administrator"})
		finally:
			delete_all("WhatsApp Template", {"name": name})
		self.assertFalse(step["ok"])
		self.assertEqual(step["outbounds"], [])
		self.assertEqual(frappe.db.count("WhatsApp Log", {"device": self.device}), 0)

	def test_notification_goes_to_the_target_not_to_its_recipients(self):
		with as_user("System Manager"):
			run = self._run()
			shown = api.preview(kind="notification", params={"notification": NOTIFICATION, "reference_name": self.todo})
			self.assertEqual(shown["message"], f"{TAG} notif ApiTest lab todo")
			self.assertEqual(shown["recipients_count"], 1)
			step = api.run_check(run=run["id"], kind="notification", target=P1, params={"notification": NOTIFICATION, "reference_name": self.todo})
		self.assertTrue(step["ok"], step)
		log = self._log(step["outbounds"][0])
		self.assertEqual((log.phone_e164, log.is_test, log.source_type), (P1, 1, "Notification"))
		self.assertFalse(frappe.db.exists("WhatsApp Log", {"device": self.device, "phone_e164": P3}))

	def test_real_recipients_must_be_confirmed(self):
		with as_user("System Manager"):
			run = self._run()
			step = api.run_check(run=run["id"], kind="notification", target=P1, params={"notification": NOTIFICATION, "reference_name": self.todo, "real_recipients": 1})
			self.assertFalse(step["ok"])
			self.assertEqual(frappe.db.count("WhatsApp Log", {"device": self.device}), 0)
			step = api.run_check(
				run=run["id"],
				kind="notification",
				target=P1,
				params={"notification": NOTIFICATION, "reference_name": self.todo, "real_recipients": 1, "confirm_real": 1},
			)
		self.assertTrue(step["ok"], step)
		self.assertEqual(step["count"], 1)
		# the record's own recipient, and real traffic: not marked as a test
		log = self._log(step["real"][0])
		self.assertEqual((log.phone_e164, log.is_test), (P3, 0))

	def test_image_uses_the_apps_sample_file(self):
		with as_user("WhatsApp Manager"):
			run = self._run()
			step = api.run_check(run=run["id"], kind="quick_image", target=P1, params={"body": f"{TAG} image"})
		self.assertTrue(step["ok"], step)
		log = self._log(step["outbounds"][0])
		self.assertEqual((log.message_type, log.is_test), ("Image", 1))
		self.assertEqual(log.attachment, testlab.sample_file("image"))  # one File, reused
		self.assertTrue(testlab.sample_file("document").endswith(".pdf"))

	def test_command_dry_run_stores_and_sends_nothing(self):
		inbound = frappe.db.count("WhatsApp Inbound Message", {"device": self.device})
		with as_user("WhatsApp Manager"):
			run = self._run()
			step = api.run_check(run=run["id"], kind="command", target=P1, params={"text": "apitest-lab-no-such-word"})
			status = api.get_status(run=run["id"])
		self.assertTrue(step["dry"])
		self.assertEqual(step["result"]["status"], "Not Matched")
		self.assertEqual((step["outbounds"], step["count"]), ([], 0))
		self.assertEqual(frappe.db.count("WhatsApp Log", {"device": self.device}), 0)
		self.assertEqual(frappe.db.count("WhatsApp Inbound Message", {"device": self.device}), inbound)
		self.assertEqual(status["run"]["used"], 0)
		self.assertEqual(status["steps"][0]["state"], "failed")

	def test_campaign_goes_through_bulk_send(self):
		with as_user("WhatsApp Manager"), patch.object(frappe, "enqueue") as enqueue:
			run = self._run(targets=[P1, P2], pacing=10)
			step = api.run_check(run=run["id"], kind="campaign", params={"body": f"{TAG} campaign"})
			self.assertTrue(step["ok"], step)
			self.assertEqual(step["count"], 2)
			doc = frappe.get_doc("WhatsApp Campaign", step["campaign"])
			self.assertEqual(doc.device, self.device)
			self.assertEqual(sorted(r.phone_e164 for r in doc.recipients), [P1, P2])
			self.assertEqual(doc.messages_per_minute, 6)  # one message per 10 s of pacing
			self.assertEqual(doc.status, "Queued")
			self.assertTrue(step["result"]["readiness"]["ok"])
			self.assertTrue(enqueue.called)  # materialisation is the campaign runner's job
			# the campaign's messages hold the next check back for their own pacing
			self.assertEqual(list(api.run_check(run=run["id"], kind="quick_text", target=P1, params={"body": f"{TAG} x"})), ["wait"])
			status = api.get_status(run=run["id"])
		self.assertEqual(status["run"]["used"], 2)
		self.assertEqual(status["steps"][0]["campaign_row"]["name"], step["campaign"])

	def test_scheduled_campaign(self):
		with as_user("WhatsApp Manager"), patch.object(frappe, "enqueue"):
			run = self._run()
			step = api.run_check(run=run["id"], kind="campaign", params={"body": f"{TAG} later", "scheduled": 1, "schedule_minutes": 3})
			status = api.get_status(run=run["id"])
		self.assertTrue(step["ok"], step)
		self.assertEqual(frappe.db.get_value("WhatsApp Campaign", step["campaign"], "status"), "Scheduled")
		self.assertEqual(step["result"]["schedule_minutes"], 3)
		self.assertEqual(status["steps"][0]["state"], "scheduled")
		self.assertFalse(status["finished"])

	# ---- following a run --------------------------------------------------------------------

	def test_status_follows_a_message_to_its_receipt(self):
		with as_user("WhatsApp Manager"):
			run = self._run()
			step = api.run_check(run=run["id"], kind="quick_text", target=P1, params={"body": f"{TAG} follow", "label": "Quick text"})
			status = api.get_status(run=run["id"])
			self.assertEqual(status["steps"][0]["state"], "running")
			self.assertEqual(status["steps"][0]["label"], "Quick text")
			self.assertFalse(status["finished"])
			self.assertEqual(status["summary"]["pending"], 1)
			now = frappe.utils.now_datetime()
			with status_writer():
				frappe.db.set_value(
					"WhatsApp Log",
					step["outbounds"][0],
					{"status": "Delivered", "sent_at": frappe.utils.add_to_date(now, seconds=2), "delivered_at": frappe.utils.add_to_date(now, seconds=5)},
				)
			status = api.get_status(run=run["id"])
		self.assertEqual(status["steps"][0]["state"], "delivered")
		message = status["steps"][0]["messages"][0]
		self.assertEqual((message["status"], message["send_seconds"], message["deliver_seconds"]), ("Delivered", 2.0, 5.0))
		self.assertEqual((status["summary"]["passed"], status["summary"]["failed"], status["summary"]["messages"]), (1, 0, 1))
		self.assertEqual((status["receipts"]["sent"], status["receipts"]["delivered"]), (1, 1))
		self.assertTrue(status["finished"])
		self.assertEqual(status["inbound"], [])

	def test_a_failed_message_fails_its_step_and_history_lists_the_run(self):
		with as_user("WhatsApp Manager"):
			run = self._run()
			step = api.run_check(run=run["id"], kind="quick_text", target=P1, params={"body": f"{TAG} broken"})
			with status_writer():
				frappe.db.set_value("WhatsApp Log", step["outbounds"][0], {"status": "Failed", "error_code": "device_offline"})
			status = api.get_status(run=run["id"])
			runs = api.list_runs()
		self.assertEqual(status["steps"][0]["state"], "failed")
		self.assertEqual(status["steps"][0]["messages"][0]["error_code"], "device_offline")
		self.assertEqual(status["summary"]["failed"], 1)
		listed = next(r for r in runs if r["id"] == run["id"])
		self.assertEqual((listed["checks"], listed["messages"], listed["failed"], listed["targets"]), (1, 1, 1, 1))

	def test_a_run_outlives_the_cache_as_an_archive(self):
		"""`clear-cache` and migrate empty the cache: the run is read back from its audit rows —
		numbers masked, nothing can be added — and its messages are still followed."""
		with as_user("WhatsApp Manager"):
			run = self._run(cap=7, pacing=5)
			step = api.run_check(run=run["id"], kind="quick_text", target=P1, params={"body": f"{TAG} archive", "label": "Quick text"})
			self._rewind(run["id"])
			api.run_check(run=run["id"], kind="command", target=P1, params={"text": "apitest-lab-no-such-word"})
			frappe.cache.delete_value(testlab.RUN_KEY.format(run["id"]))
			status = api.get_status(run=run["id"])
			self.assertTrue(status["run"]["archived"])
			self.assertEqual((status["run"]["cap"], status["run"]["pacing"], status["run"]["used"], status["run"]["device"]), (7, 5, 1, self.device))
			self.assertNotIn(P1, status["run"]["targets"])  # masked, as the audit log keeps them
			self.assertEqual([(s["kind"], s["dry"], s["label"]) for s in status["steps"]], [("quick_text", False, "Quick text"), ("command", True, None)])
			self.assertEqual(status["steps"][0]["messages"][0]["name"], step["outbounds"][0])
			self.assertEqual(status["steps"][1]["result"]["status"], "Not Matched")
			self.assertEqual(status["inbound"], [])
			self.assertIn(run["id"], [r["id"] for r in api.list_runs()])
			with self.assertRaises(WANotFoundError):
				api.run_check(run=run["id"], kind="quick_text", target=P1, params={"body": f"{TAG} late"})
			with self.assertRaises(WANotFoundError):
				api.get_status(run="nosuchrun")
