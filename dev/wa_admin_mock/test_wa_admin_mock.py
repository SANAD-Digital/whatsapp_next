"""Tests for the development wa-admin mock, driven through the platform's real client.

Run from this directory with the bench Python (it has `requests`):
    /home/frappe/frappe-bench/env/bin/python -m unittest test_wa_admin_mock -v

The platform's real client is loaded from WA_ADMIN_CLIENT_PATH (default: the snd_whatsapp_platform
working copy). The admin secret below is a fixed test value, not a credential.
"""

import ast
import base64
import importlib.util
import json
import os
import socket
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import wa_admin_mock

CLIENT_PATH = Path(
	os.environ.get("WA_ADMIN_CLIENT_PATH", "/home/user/snd_whatsapp_platform/gaide_whatsapp_api.py")
)
if not CLIENT_PATH.exists():
	raise unittest.SkipTest(f"platform client not found at {CLIENT_PATH} (set WA_ADMIN_CLIENT_PATH)")
ADMIN_SECRET = "dev-mock-admin-secret-CLOUD-TEST"

_spec = importlib.util.spec_from_file_location("gaide_whatsapp_api", CLIENT_PATH)
gaide = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gaide)

_real_connect = socket.socket.connect
outbound_attempts: list = []


def _loopback_only_connect(sock, address):
	"""Fail loudly on any connection that is not to loopback, from the mock or from the client."""
	host = address[0] if isinstance(address, tuple) else address
	if isinstance(host, str) and host not in ("127.0.0.1", "::1", "localhost"):
		outbound_attempts.append(address)
		raise OSError(f"outbound connection blocked in wa-admin mock tests: {address!r}")
	return _real_connect(sock, address)


def setUpModule():
	socket.socket.connect = _loopback_only_connect


def tearDownModule():
	socket.socket.connect = _real_connect


class MockTestCase(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		cls.server = wa_admin_mock.make_server("127.0.0.1", 0, ADMIN_SECRET)
		cls.port = cls.server.server_address[1]
		cls.base = f"http://127.0.0.1:{cls.port}/api"
		cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
		cls.thread.start()

	@classmethod
	def tearDownClass(cls):
		cls.server.shutdown()
		cls.server.server_close()

	def setUp(self):
		self.server.state.reset()
		outbound_attempts.clear()

	def tearDown(self):
		self.assertEqual(outbound_attempts, [], "a non-loopback connection was attempted")

	# -- helpers ---------------------------------------------------------------------------------
	def client(self, **kwargs):
		return gaide.WaAdminSanadClient(base_url=self.base, timeout=5, **kwargs)

	def admin(self):
		return self.client(admin_secret=ADMIN_SECRET)

	def new_key(self, **payload):
		body = {
			"customer_name": "DEV TEST CLOUD Customer",
			"customer_email": "dev-test-cloud@example.test",
			**payload,
		}
		return self.admin().admin_create_api_key(body)

	def new_device(self, api_key, **payload):
		return self.client(api_key=api_key).create_device({"name": "DEV-TEST-CLOUD device", **payload})

	def connect(self, device_id):
		return self.raw("POST", f"/__mock/devices/{device_id}/state", {"status": "connected"}, admin=True)

	def raw(self, method, path, body=None, headers=None, admin=False):
		url = f"http://127.0.0.1:{self.port}{path}"
		data = json.dumps(body).encode() if body is not None else None
		request = urllib.request.Request(url, data=data, method=method)
		request.add_header("Content-Type", "application/json")
		if admin:
			request.add_header("X-Admin-Secret", ADMIN_SECRET)
		for key, value in (headers or {}).items():
			request.add_header(key, value)
		try:
			with urllib.request.urlopen(request, timeout=5) as resp:
				return resp.status, json.loads(resp.read())
		except urllib.error.HTTPError as exc:
			with exc:
				return exc.code, json.loads(exc.read())

	def assertApiError(self, status, fragment, fn, *args, **kwargs):
		with self.assertRaises(gaide.WaAdminApiError) as ctx:
			fn(*args, **kwargs)
		self.assertEqual(ctx.exception.status_code, status)
		self.assertIn(fragment, str(ctx.exception).lower())


class TestAuth(MockTestCase):
	def test_admin_secret_is_validated(self):
		self.assertApiError(
			401,
			"invalid admin secret",
			self.client(admin_secret="wrong").admin_create_api_key,
			{"customer_email": "x@example.test"},
		)
		self.assertEqual(self.raw("GET", "/__mock/state")[0], 401)
		self.assertEqual(self.raw("GET", "/__mock/state", admin=True)[0], 200)

	def test_api_key_is_validated(self):
		self.assertApiError(
			401, "invalid api key", self.client(api_key="mock-apikey-9999").create_device, {"name": "x"}
		)

	def test_bearer_token_is_validated(self):
		self.assertApiError(401, "invalid or expired token", self.client(device_token="nope").device_status)
		status, body = self.raw("GET", "/api/devices/me/status", headers={"Authorization": "Token nope"})
		self.assertEqual((status, body["ok"]), (401, False))

	def test_unknown_route_is_a_404_the_client_can_fall_back_on(self):
		status, body = self.raw("GET", "/api/admin/health", admin=True)
		self.assertEqual(status, 404)
		self.assertIn("cannot get", body["error"])


class TestKeysAndDevices(MockTestCase):
	def test_ids_are_deterministic_integers(self):
		first, second = self.new_key(), self.new_key(customer_email="dev-test-cloud-2@example.test")
		self.assertEqual((first["id"], first["api_key"]), (1, "mock-apikey-0001"))
		self.assertEqual((second["id"], second["api_key"]), (2, "mock-apikey-0002"))
		device = self.new_device(first["api_key"])
		self.assertEqual((device["id"], device["token"]), ("mock-dev-0001", "mock-devtok-0001"))
		self.server.state.reset()
		self.assertEqual(self.new_key()["id"], 1)

	def test_update_and_list_devices_by_key(self):
		key = self.new_key(max_devices=2)
		self.admin().admin_update_api_key(
			key["id"], {"max_devices": 3, "customer_email": "dev-test-cloud@example.test"}
		)
		self.assertEqual(self.server.state.api_keys[1]["max_devices"], 3)
		device = self.new_device(key["api_key"])
		listed = self.admin().admin_list_devices_by_api_key(key["id"])
		self.assertEqual([d["id"] for d in listed], [device["id"]])
		self.admin().admin_delete_device(device["id"])
		self.assertEqual(self.admin().admin_list_devices_by_api_key(key["id"]), [])

	def test_device_limit_uses_the_marker_the_platform_matches(self):
		key = self.new_key(max_devices=1)
		self.new_device(key["api_key"])
		self.assertApiError(409, "device limit reached", self.new_device, key["api_key"])

	def test_qr_pair_code_and_connection_states(self):
		key = self.new_key()
		device = self.new_device(key["api_key"])
		client = self.client(device_token=device["token"])
		self.assertEqual(client.device_status()["status"], "disconnected")
		qr = client.device_login_qr()
		self.assertTrue(qr["qr_code"].startswith("data:image/png;base64,iVBOR"))
		pair = client.device_login_pair_code("966500000001")
		self.assertEqual(pair, {"PairCode": "MOCK-0001"})  # exact key case
		self.connect(device["id"])
		self.assertEqual(client.device_status()["status"], "connected")
		self.assertEqual(client.device_me()["phone_number"], "966500000001")
		self.assertApiError(400, "already logged in", client.device_login_qr)
		client.device_logout()
		self.assertEqual(client.device_status()["status"], "logged_out")
		client.device_reconnect()
		self.assertEqual(client.device_status()["status"], "logged_out")


class TestMessaging(MockTestCase):
	def connected_client(self):
		device = self.new_device(self.new_key()["api_key"])
		self.connect(device["id"])
		return self.client(device_token=device["token"])

	def test_send_requires_a_connected_device_with_the_not_connected_marker(self):
		device = self.new_device(self.new_key()["api_key"])
		client = self.client(device_token=device["token"])
		self.assertApiError(
			400, "not connected", client.send_text_message, "966500000001@s.whatsapp.net", "hi"
		)

	def test_text_returns_provider_message_id_in_a_dict(self):
		client = self.connected_client()
		first = client.send_text_message("966500000001@s.whatsapp.net", "DEV TEST")
		second = client.send_text_message("966500000001@s.whatsapp.net", "DEV TEST")
		self.assertEqual(first["provider_message_id"], "MOCKMSG00000001")
		self.assertEqual(second["provider_message_id"], "MOCKMSG00000002")

	def test_media_location_and_poll(self):
		client = self.connected_client()
		png = base64.b64encode(b"\x89PNG\r\n\x1a\n").decode()
		media = client.send_media_message(
			"966500000001@s.whatsapp.net", "image", png, "a.png", "image/png", caption="DEV"
		)
		self.assertIn("provider_message_id", media)
		location = client.send_location_message("966500000001@s.whatsapp.net", 24.7136, 46.6753, name="DEV")
		self.assertIn("provider_message_id", location)
		poll = client.create_poll(
			"966500000001@s.whatsapp.net", {"question": "DEV?", "options": ["a", "b"], "multi_answer": False}
		)
		self.assertEqual(poll["poll_id"], "MOCKPOLL000001")
		results = client.poll_results(poll["poll_id"])
		self.assertEqual([r["option"] for r in results["results"]], ["a", "b"])

	def test_contacts_and_groups(self):
		client = self.connected_client()
		synced = client.sync_contacts(["+966 50 000 0002"])
		self.assertEqual(synced[0]["jid"], "966500000002@s.whatsapp.net")
		self.assertEqual(client.list_contacts()[0]["phone"], "966500000002")
		self.assertEqual(client.list_groups(), [])


class TestWebhooks(MockTestCase):
	def test_register_list_delete(self):
		device = self.new_device(self.new_key()["api_key"])
		client = self.client(device_token=device["token"])
		created = client.create_webhook(
			{
				"url": "http://platform.localhost:8000/api/method/x",
				"events": ["message.received"],
				"secret": "dev",
			}
		)
		self.assertEqual(created, {"id": 1})
		listed = client.list_webhooks()
		self.assertEqual(
			[(w["id"], w["url"]) for w in listed], [(1, "http://platform.localhost:8000/api/method/x")]
		)
		client.delete_webhook("1")
		self.assertEqual(client.list_webhooks(), [])

	def test_webhooks_are_scoped_to_the_device(self):
		key = self.new_key()
		mine, other = self.new_device(key["api_key"]), self.new_device(key["api_key"])
		self.client(device_token=mine["token"]).create_webhook({"url": "http://x.test/a"})
		self.assertEqual(self.client(device_token=other["token"]).list_webhooks(), [])


class TestSafety(unittest.TestCase):
	def test_refuses_non_loopback_bind(self):
		with self.assertRaises(SystemExit):
			wa_admin_mock.make_server("0.0.0.0", 0, ADMIN_SECRET)

	def test_refuses_to_start_without_admin_secret(self):
		with self.assertRaises(SystemExit):
			wa_admin_mock.make_server("127.0.0.1", 0, "")

	def test_mock_contains_no_network_client(self):
		tree = ast.parse(Path(wa_admin_mock.__file__).read_text())
		imported = {
			alias.name.split(".")[0]
			for node in ast.walk(tree)
			if isinstance(node, ast.Import)
			for alias in node.names
		}
		imported |= {
			node.module.split(".")[0]
			for node in ast.walk(tree)
			if isinstance(node, ast.ImportFrom) and node.module
		}
		self.assertFalse(
			imported & {"requests", "urllib3", "httpx", "aiohttp", "socket", "smtplib"}, imported
		)
		from_urllib = {
			alias.name
			for node in ast.walk(tree)
			if isinstance(node, ast.ImportFrom) and node.module == "urllib.parse"
			for alias in node.names
		}
		self.assertTrue(from_urllib <= {"parse_qs", "unquote", "urlsplit"})
		self.assertNotIn("urllib.request", Path(wa_admin_mock.__file__).read_text())
		self.assertNotIn("http.client", Path(wa_admin_mock.__file__).read_text())


if __name__ == "__main__":
	unittest.main()
