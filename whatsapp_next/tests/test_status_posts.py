# WhatsApp status posts (services/status_posts): posting now or when due, repeating, deleting,
# views, and the plan gate.

from __future__ import annotations

from unittest.mock import MagicMock, patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_to_date, now_datetime

from whatsapp_next.exceptions import WANotSupportedError, WAStateConflictError, WAValidationError
from whatsapp_next.services import status_posts


def plan(on: bool) -> None:
	frappe.db.set_single_value("WhatsApp Settings", "plan_features", frappe.as_json({"allow_status": on}))
	frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")


class TestStatusPosts(IntegrationTestCase):
	def setUp(self):
		self.device = frappe.db.get_value("WhatsApp Device", {"status": "Connected"}, "name")
		if not self.device:
			self.skipTest("needs a connected device")
		plan(True)
		self.provider = MagicMock()
		self.provider.post_status.return_value = "STATUS-1"
		self.provider.get_status_views.return_value = {
			"STATUS-1": {"count": 2, "viewers": [{"jid": "a", "number": "9677", "viewed_at": 1}]}
		}
		self.patch = patch("whatsapp_next.providers.registry.get_provider", return_value=self.provider)
		self.patch.start()
		self.addCleanup(self.patch.stop)
		# posting commits its state so a failure survives the request: kept inside the test here
		self.commit = patch("frappe.db.commit")
		self.commits = self.commit.start()
		self.addCleanup(self.commit.stop)

	def _post(self, **values):
		return frappe.get_doc(
			{
				"doctype": "WhatsApp Status Post",
				"title": "Offer",
				"kind": "Text",
				"text": "Sale today",
				"background_color": "#128C7E",
				"font": "Bold",
				"device": self.device,
				**values,
			}
		).insert(ignore_permissions=True)

	def test_post_now_sends_the_styled_text_and_reads_views(self):
		doc = self._post()
		self.assertEqual(status_posts.post_now(doc.name), "STATUS-1")
		payload = self.provider.post_status.call_args.args[1]
		self.assertEqual(
			(payload["kind"], payload["text"], payload["background_color"], payload["font"]),
			("text", "Sale today", "#128C7E", 6),
		)
		doc.reload()
		self.assertEqual((doc.state, doc.status_id), ("Posted", "STATUS-1"))
		self.assertTrue(doc.expires_at > doc.posted_at)
		self.assertEqual(status_posts.refresh_views([doc.name]), 1)
		self.assertEqual(frappe.db.get_value("WhatsApp Status Post", doc.name, "view_count"), 2)
		status_posts.delete_post(doc.name)
		self.assertEqual(frappe.db.get_value("WhatsApp Status Post", doc.name, "state"), "Deleted")
		self.provider.delete_status.assert_called_once()

	def test_a_failure_is_kept_and_a_post_is_never_posted_twice(self):
		"""A failed post keeps `Failed` and its reason: both are committed before the error goes up,
		since the request's rollback took them away. A post being posted is refused a second time;
		one left in `Posting` by a run that died is taken again after a few minutes."""
		doc = self._post()
		self.provider.post_status.side_effect = RuntimeError("gateway down")
		with self.assertRaises(RuntimeError):
			status_posts.post_now(doc.name)
		doc.reload()
		self.assertEqual((doc.state, doc.error), ("Failed", "gateway down"))
		self.assertEqual(self.commits.call_count, 2, "Posting, then Failed, each committed")

		self.provider.post_status.side_effect = None
		frappe.db.set_value("WhatsApp Status Post", doc.name, "state", "Posting")
		with self.assertRaises(WAStateConflictError):
			status_posts.post_now(doc.name)
		self.provider.post_status.reset_mock()
		frappe.db.set_value(
			"WhatsApp Status Post",
			doc.name,
			"modified",
			add_to_date(now_datetime(), minutes=-(status_posts.STUCK_MINUTES + 1)),
			update_modified=False,
		)
		self.assertEqual(status_posts.post_now(doc.name), "STATUS-1")
		self.provider.post_status.assert_called_once()

	def test_due_posts_go_out_and_a_daily_one_queues_its_next(self):
		doc = self._post(repeat="Daily")
		status_posts.schedule(doc.name, add_to_date(now_datetime(), minutes=5))
		frappe.db.set_value(
			"WhatsApp Status Post", doc.name, "scheduled_at", add_to_date(now_datetime(), minutes=-1)
		)
		with patch("frappe.db.commit"):
			status_posts.post_due()
		self.assertEqual(frappe.db.get_value("WhatsApp Status Post", doc.name, "state"), "Posted")
		nxt = frappe.get_all(
			"WhatsApp Status Post", filters={"repeated_from": doc.name}, fields=["state", "scheduled_at"]
		)
		self.assertEqual(len(nxt), 1)
		self.assertEqual(nxt[0].state, "Scheduled")
		self.assertTrue(nxt[0].scheduled_at > now_datetime())

	def test_rules(self):
		doc = self._post()
		with self.assertRaises(WAValidationError):
			status_posts.schedule(doc.name, add_to_date(now_datetime(), minutes=-5))
		plan(False)
		with self.assertRaises(WANotSupportedError):
			status_posts.post_now(doc.name)
