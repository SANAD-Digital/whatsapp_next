# Tests for providers/snd_platform.py with mocked HTTP: headers (D-020), error mapping (200
# ok:false, 417, 401, 402, 409, 429, 5xx), batch payload keys (D-024), status parsing.

from __future__ import annotations

import json
from unittest.mock import patch

import requests
from frappe.tests import IntegrationTestCase

from whatsapp_next.providers import exceptions as pex
from whatsapp_next.providers.schemas import AttachmentRef, NormalizedMessage, Poll, ProviderSettings, Source
from whatsapp_next.providers.snd_platform import SndPlatformProvider


class _Resp:
	def __init__(self, status: int, body=None, headers=None):
		self.status_code = status
		self._body = body
		self.content = json.dumps(body).encode() if body is not None else b""
		self.headers = headers or {}

	def json(self):
		if self._body is None:
			raise ValueError("no body")
		return self._body


def _provider(**creds) -> SndPlatformProvider:
	base = {"customer_api_key": "ck", "api_key": "k", "api_secret": "s"}
	base.update(creds)
	return SndPlatformProvider(
		ProviderSettings(
			provider_key="snd_platform", base_url="https://platform.invalid/", timeout=5, credentials=base
		)
	)


class TestSndPlatform(IntegrationTestCase):
	def _call(self, provider, method, *args, response=None, exc=None, **kwargs):
		with patch.object(provider._session, "request") as req:
			if exc:
				req.side_effect = exc
			else:
				req.return_value = response
			result = getattr(provider, method)(*args, **kwargs)
			return result, req

	def test_headers_d020(self):
		provider = _provider()
		_, req = self._call(
			provider,
			"get_queue_status",
			response=_Resp(200, {"message": {"ok": True, "counts": {"Queued": 2}}}),
		)
		headers = req.call_args.kwargs["headers"]
		self.assertEqual(headers["X-SND-API-Key"], "ck")
		self.assertEqual(headers["Authorization"], "token k:s")
		self.assertEqual(headers["X-SND-API-Secret"], "s")
		self.assertTrue(
			req.call_args.args[1].startswith(
				"https://platform.invalid/api/method/snd_whatsapp_platform.snd_whatsapp_platform.api.get_queue_status_api"
			)
		)

	def test_missing_customer_key_is_auth_error_without_io(self):
		provider = _provider(customer_api_key="")
		with patch.object(provider._session, "request") as req, self.assertRaises(pex.AuthError):
			provider.get_queue_status()
		req.assert_not_called()

	def test_error_mapping(self):
		provider = _provider()
		cases = [
			(
				_Resp(
					200,
					{
						"message": {
							"ok": False,
							"error": "Monthly quota exceeded",
							"rejected": True,
							"message_log": "ML1",
						}
					},
				),
				pex.QuotaExceededError,
			),
			(
				_Resp(200, {"message": {"ok": False, "error": "nope", "code": "FEATURE_NOT_IN_PLAN"}}),
				pex.FeatureNotInPlanError,
			),
			(
				_Resp(
					200, {"message": {"ok": False, "error": "Recipient is not registered", "rejected": True}}
				),
				pex.BusinessRejectedError,
			),
			(
				_Resp(
					401, {"message": {"ok": False, "error": "Invalid API key", "code": "AUTH_INVALID_KEY"}}
				),
				pex.AuthError,
			),
			(
				_Resp(
					417,
					{
						"exc_type": "ValidationError",
						"exception": "frappe.exceptions.ValidationError: Invalid API key",
						"_server_messages": json.dumps([json.dumps({"message": "Invalid API key"})]),
					},
				),
				pex.AuthError,
			),
			(
				_Resp(
					417,
					{
						"exc_type": "ValidationError",
						"_server_messages": json.dumps([json.dumps({"message": "recipient_no is required"})]),
					},
				),
				pex.ValidationError,
			),
			(
				_Resp(402, {"message": {"ok": False, "error": "expired", "code": "SUBSCRIPTION_EXPIRED"}}),
				pex.QuotaExceededError,
			),
			(
				_Resp(
					403,
					{
						"message": {
							"ok": False,
							"error": "Device does not belong to this API key",
							"code": "NOT_OWNER",
						}
					},
				),
				pex.PermissionDeniedError,
			),
			(_Resp(404, {"message": {"ok": False, "error": "not found"}}), pex.NotFoundError),
			(
				_Resp(
					409,
					{
						"message": {
							"ok": False,
							"error": "Selected device is not connected. Complete QR authentication first.",
							"device_status": "Pending QR",
						}
					},
				),
				pex.DeviceOfflineError,
			),
			(
				_Resp(413, {"message": {"ok": False, "error": "too big", "code": "BATCH_TOO_LARGE"}}),
				pex.ValidationError,
			),
			(
				_Resp(
					429,
					{"message": {"ok": False, "error": "slow down", "code": "RATE_LIMITED"}},
					headers={"Retry-After": "7"},
				),
				pex.RateLimitError,
			),
			(
				_Resp(500, {"message": {"ok": False, "error": "boom", "code": "INTERNAL_ERROR"}}),
				pex.TransientError,
			),
			(_Resp(502, None), pex.TransientError),
			(_Resp(503, {"message": {"ok": False, "error": "maintenance"}}), pex.TransientError),
		]
		for response, expected in cases:
			with self.subTest(status=response.status_code, body=response._body), self.assertRaises(expected):
				self._call(provider, "get_queue_status", response=response)
		with self.assertRaises(pex.TransientError):
			self._call(provider, "get_queue_status", exc=requests.Timeout())
		with self.assertRaises(pex.TransientError):
			self._call(provider, "get_queue_status", exc=requests.ConnectionError())
		try:
			self._call(
				provider,
				"get_queue_status",
				response=_Resp(429, {"message": {"ok": False, "error": "x"}}, headers={"Retry-After": "7"}),
			)
		except pex.RateLimitError as exc:
			self.assertEqual(exc.retry_after, 7)

	def test_send_batch_payload_keys(self):
		provider = _provider()
		messages = [
			NormalizedMessage(
				client_ref="ref1",
				platform_device="WAD-1",
				phone_e164="+966500000002",
				body="hi",
				source=Source(type="Campaign", doctype="WhatsApp Log", docname="ref1", site="s"),
			),
			NormalizedMessage(
				client_ref="ref2",
				platform_device="WAD-1",
				recipient_type="Group",
				jid="1@g.us",
				message_type="Document",
				caption="c",
				attachment=AttachmentRef(file_name="a.pdf", mime_type="application/pdf", content_b64="QUJD"),
			),
			NormalizedMessage(
				client_ref="ref3",
				platform_device="WAD-1",
				phone_e164="+966500000002",
				message_type="Poll",
				poll=Poll(question="q", options=("a", "b"), allow_multiple=True),
			),
		]
		body = {
			"message": {
				"ok": True,
				"batch_id": "b1",
				"queued": 2,
				"rejected": 1,
				"accepted": [
					{"client_ref": "ref1", "queue_id": "MQ1", "status": "Queued"},
					{"client_ref": "ref3", "queue_id": "MQ3", "status": "Held"},
				],
				"errors": [
					{"client_ref": "ref2", "error": "Device does not exist", "code": "DEVICE_NOT_FOUND"}
				],
			}
		}
		result, req = self._call(provider, "send_batch", messages, "b1", response=_Resp(200, body))
		sent = req.call_args.kwargs["json"]
		self.assertEqual(sent["batch_id"], "b1")
		m1, m2, m3 = sent["messages"]
		self.assertEqual(m1["recipient_no"], "966500000002")  # digits without + (PB-05)
		self.assertEqual(m1["client_ref"], "ref1")
		self.assertEqual(m1["message_body"], "hi")
		self.assertEqual(m1["source_type"], "Campaign")
		self.assertNotIn("scheduled_at", m1)
		self.assertEqual(m2["group_id"], "1@g.us")
		self.assertEqual(m2["recipient_type"], "Group")
		self.assertEqual(m2["media_base64"], "QUJD")
		self.assertEqual(m2["media_filename"], "a.pdf")
		self.assertEqual(m3["poll_options"], ["a", "b"])
		self.assertEqual(m3["poll_allow_multiple_answers"], 1)
		self.assertEqual(len(result.accepted), 2)
		self.assertEqual(result.accepted[1].status, "Held")
		self.assertEqual(result.errors[0].code, "DEVICE_NOT_FOUND")

	def test_send_message_and_status(self):
		provider = _provider()
		msg = NormalizedMessage(
			client_ref="ref1", platform_device="WAD-1", phone_e164="+966500000002", body="hi"
		)
		result, req = self._call(
			provider,
			"send_message",
			msg,
			response=_Resp(
				200,
				{
					"message": {
						"ok": True,
						"message_log": "ML1",
						"provider_message_id": "pm1",
						"device": "WAD-2",
						"requested_device": "WAD-1",
						"device_fallback": True,
					}
				},
			),
		)
		self.assertTrue(result.ok)
		self.assertTrue(result.device_fallback)
		self.assertEqual(req.call_args.kwargs["json"]["allow_fallback"], 0)
		statuses, unknown = self._call(
			provider,
			"get_message_status",
			["ref1", "ref9"],
			response=_Resp(
				200,
				{
					"message": {
						"ok": True,
						"statuses": [
							{
								"client_ref": "ref1",
								"queue_id": "MQ1",
								"status": "Sent",
								"attempt_count": 1,
								"provider_message_id": "pm1",
							}
						],
						"unknown": ["ref9"],
					}
				},
			),
		)[0]
		self.assertEqual(statuses[0].status, "Sent")
		self.assertEqual(unknown, ["ref9"])
		self.assertEqual(self._call(provider, "get_message_status", [], response=None)[0], ([], []))

	def test_devices_and_pairing(self):
		provider = _provider()
		state, req = self._call(
			provider,
			"create_device",
			"Main",
			"+966500000001",
			"Code",
			response=_Resp(
				200,
				{"message": {"ok": True, "device": "WAD-9", "wa_device_id": "wa9", "status": "Pending QR"}},
			),
		)
		self.assertEqual(req.call_args.kwargs["json"]["phone_number"], "966500000001")
		self.assertEqual(state.platform_device, "WAD-9")
		self.assertEqual(state.status, "Pending QR")
		with self.assertRaises(pex.ValidationError):
			provider.create_device("Main", None, "Code")
		devices, _ = self._call(
			provider,
			"list_devices",
			response=_Resp(
				200,
				{
					"message": {
						"ok": True,
						"devices": [
							{
								"name": "WAD-9",
								"device_name": "Main",
								"status": "connected",
								"phone_number": "966500000001",
								"wa_webhook_id": "wh1",
							}
						],
					}
				},
			),
		)
		self.assertEqual(devices[0].status, "Connected")
		self.assertEqual(devices[0].phone_e164, "+966500000001")
		self.assertTrue(devices[0].webhook_registered)
		qr, _ = self._call(
			provider,
			"get_qr",
			"WAD-9",
			response=_Resp(200, {"message": {"ok": True, "qr_code": "data:...", "qr_expires_in": 60}}),
		)
		self.assertEqual(qr.mode, "QR")
		self.assertEqual(qr.expires_in, 60)
		with self.assertRaises(pex.DeviceOfflineError):
			self._call(
				provider, "get_qr", "WAD-9", response=_Resp(200, {"message": {"ok": True, "qr_code": None}})
			)
		code, _ = self._call(
			provider,
			"get_pair_code",
			"WAD-9",
			response=_Resp(
				200, {"message": {"ok": True, "pair_code": "ABCD1234", "phone_number": "966500000001"}}
			),
		)
		self.assertEqual(code.pair_code, "ABCD1234")
		self.assertEqual(code.phone_e164, "+966500000001")

	def test_webhook_secret_and_endpoints(self):
		provider = _provider()
		secret, _ = self._call(
			provider,
			"get_webhook_secret",
			response=_Resp(200, {"message": {"ok": True, "webhook_secret": "abc"}}),
		)
		self.assertEqual(secret, "abc")
		endpoints, _ = self._call(
			provider,
			"list_webhook_endpoints",
			response=_Resp(
				200,
				{
					"message": {
						"ok": True,
						"webhooks": [
							{
								"name": "WAWE-1",
								"endpoint_url": "https://x/y",
								"status": "Locked",
								"consecutive_failures": 5,
								"lock_reason": "5 consecutive failures",
								"events": [{"event_name": "message.sent", "enabled": 1}],
							}
						],
					}
				},
			),
		)
		self.assertEqual(endpoints[0].status, "Locked")
		self.assertEqual(endpoints[0].events, ("message.sent",))
		with patch.object(provider._session, "request") as req:
			req.return_value = _Resp(404, {"exc_type": "DoesNotExistError", "exception": "not found"})
			with self.assertRaises(pex.NotSupportedError):
				provider.update_webhook_endpoint("WAWE-1", "Active", None, None)

	def test_account_fallback_to_legacy_calls(self):
		provider = _provider()
		responses = iter(
			[
				_Resp(404, {"exc_type": "AttributeError", "exception": "no such method"}),
				_Resp(
					200,
					{
						"message": {
							"status": "Active",
							"plan": "Business",
							"plan_code": "biz",
							"messages_used": 5,
							"message_limit": 100,
							"messages_remaining": 95,
							"features": {"allow_webhooks": True},
						}
					},
				),
				_Resp(200, {"message": {"ok": True, "balance": 12.5, "currency": "SAR"}}),
			]
		)
		with patch.object(provider._session, "request", side_effect=lambda *a, **k: next(responses)):
			account = provider.get_account()
		self.assertEqual(account.plan_code, "biz")
		self.assertEqual(account.messages_remaining, 95)
		self.assertEqual(account.wallet_currency, "SAR")

	def test_health_check_reports_error(self):
		provider = _provider()
		with patch.object(provider._session, "request", side_effect=requests.ConnectionError()):
			health = provider.health_check()
		self.assertFalse(health.ok)
		self.assertIn("connection", (health.error or "").lower())
