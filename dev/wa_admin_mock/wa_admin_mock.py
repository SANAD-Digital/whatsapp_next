"""Development-only mock of the wa-admin gateway used by snd_whatsapp_platform.

Implements only the endpoints the platform actually calls (see gaide_whatsapp_api.py and
providers/wa_admin_provider.py), with the envelopes that client parses:

    success   -> HTTP 2xx, {"ok": true, "data": ...}
    failure   -> HTTP 4xx, {"ok": false, "error": "<text the platform matches on>"}

Safety:
    * binds to loopback only and rejects requests from any other address;
    * never opens an outbound connection (no HTTP client, no callbacks to the platform);
    * all state is in memory and every id is derived from a counter, so runs are deterministic.

Run:
    WA_MOCK_ADMIN_SECRET=<dev secret> python3 wa_admin_mock.py --port 18080
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
from dataclasses import dataclass, field
from email.parser import BytesParser
from email.policy import HTTP
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}
API_PREFIX = "/api"
MAX_LOGGED_REQUESTS = 500

#: Device states the platform maps through services/devices.py (CONNECTED_WORDS / LOGGED_OUT_WORDS).
CONNECTED = "connected"
DISCONNECTED = "disconnected"
LOGGED_OUT = "logged_out"


class MockError(Exception):
	def __init__(self, status: int, message: str):
		super().__init__(message)
		self.status = status
		self.message = message


@dataclass
class State:
	"""Everything the mock remembers. Counters make every id reproducible for a given call order."""

	admin_secret: str
	api_keys: dict[int, dict] = field(default_factory=dict)
	devices: dict[str, dict] = field(default_factory=dict)
	webhooks: dict[int, dict] = field(default_factory=dict)
	polls: dict[str, dict] = field(default_factory=dict)
	requests: list[dict] = field(default_factory=list)
	lock: threading.RLock = field(default_factory=threading.RLock)
	# Optional JSON file the state survives restarts in (dev VMs restart often; the platform
	# keeps the api-key ids and device ids it was given, so a forgetful mock breaks it).
	state_file: str | None = None

	def __post_init__(self):
		self.reset()
		self.load()

	def reset(self):
		with self.lock:
			self.api_keys.clear()
			self.devices.clear()
			self.webhooks.clear()
			self.polls.clear()
			self.requests.clear()
			self.seq = {"key": 0, "device": 0, "webhook": 0, "message": 0, "poll": 0}

	# -- ids -------------------------------------------------------------------------------------
	def _next(self, kind: str) -> int:
		self.seq[kind] += 1
		return self.seq[kind]

	def next_key_id(self) -> int:
		return self._next("key")

	def next_device_id(self) -> int:
		return self._next("device")

	def next_webhook_id(self) -> int:
		return self._next("webhook")

	def next_message_id(self) -> str:
		return f"MOCKMSG{self._next('message'):08d}"

	def next_poll_id(self) -> str:
		return f"MOCKPOLL{self._next('poll'):06d}"

	# -- persistence (only with --state-file) ------------------------------------------------------
	def save(self) -> None:
		if not self.state_file:
			return
		with self.lock:
			data = {
				"seq": self.seq,
				"api_keys": self.api_keys,
				"devices": self.devices,
				"webhooks": self.webhooks,
				"polls": self.polls,
			}
			tmp = f"{self.state_file}.tmp"
			with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as fh:
				json.dump(data, fh)
			os.replace(tmp, self.state_file)

	def load(self) -> None:
		if not self.state_file or not os.path.exists(self.state_file):
			return
		with open(self.state_file) as fh:
			data = json.load(fh)
		with self.lock:
			self.seq.update(data.get("seq") or {})
			self.api_keys.update({int(k): v for k, v in (data.get("api_keys") or {}).items()})
			self.devices.update(data.get("devices") or {})
			self.webhooks.update({int(k): v for k, v in (data.get("webhooks") or {}).items()})
			self.polls.update(data.get("polls") or {})

	# -- lookups ---------------------------------------------------------------------------------
	def key_by_value(self, api_key: str) -> dict | None:
		return next((k for k in self.api_keys.values() if k["api_key"] == api_key), None)

	def device_by_token(self, token: str) -> dict | None:
		return next((d for d in self.devices.values() if d["token"] == token), None)

	def snapshot(self) -> dict:
		"""State for the /__mock/state endpoint. Tokens and keys are dev fakes, but still not echoed."""
		with self.lock:
			return {
				"api_keys": [
					{
						"id": k["id"],
						"max_devices": k.get("max_devices"),
						"customer_email": k.get("customer_email"),
					}
					for k in self.api_keys.values()
				],
				"devices": [
					{key: d[key] for key in ("id", "api_key_id", "name", "phone", "status")}
					for d in self.devices.values()
				],
				"webhooks": [
					{key: w[key] for key in ("id", "device_id", "url", "events")}
					for w in self.webhooks.values()
				],
				"messages_sent": sum(d["sent"] for d in self.devices.values()),
			}


# ------------------------------------------------------------------------------------------------
# Routing
# ------------------------------------------------------------------------------------------------
ROUTES: list[tuple[str, re.Pattern, str]] = []


def route(method: str, pattern: str):
	def register(fn):
		ROUTES.append((method, re.compile(f"^{pattern}$"), fn.__name__))
		return fn

	return register


def digits(value) -> str:
	return "".join(ch for ch in str(value or "") if ch.isdigit())


class Handler(BaseHTTPRequestHandler):
	server_version = "wa-admin-mock/1.0"
	protocol_version = "HTTP/1.1"
	state: State  # set on the server subclass

	# -- plumbing --------------------------------------------------------------------------------
	def log_message(self, fmt, *args):  # quiet by default; requests are kept in state.requests
		if os.environ.get("WA_MOCK_VERBOSE"):
			sys.stderr.write("wa-admin-mock: " + (fmt % args) + "\n")

	def _dispatch(self, method: str):
		status, payload = HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "unhandled"}
		path = urlsplit(self.path).path
		try:
			if self.client_address[0] not in {"127.0.0.1", "::1"}:
				raise MockError(403, "wa-admin mock only accepts loopback clients")
			self.body = self._read_body()
			status, payload = self._route(method, path)
		except MockError as exc:
			status, payload = exc.status, {"ok": False, "error": exc.message}
		finally:
			self._log(method, path, int(status))
		raw = json.dumps(payload).encode()
		self.send_response(int(status))
		self.send_header("Content-Type", "application/json")
		self.send_header("Content-Length", str(len(raw)))
		self.end_headers()
		self.wfile.write(raw)

	def _route(self, method: str, path: str):
		if path.startswith("/__mock/"):
			self._require_admin()
			sub = path[len("/__mock") :]
		elif path.startswith(API_PREFIX + "/"):
			sub = path[len(API_PREFIX) :]
		else:
			raise MockError(404, f"cannot {method.lower()} {path}")
		for route_method, pattern, name in ROUTES:
			if route_method != method:
				continue
			match = pattern.match(sub if not path.startswith("/__mock/") else "/__mock" + sub)
			if match:
				with self.state.lock:
					data = getattr(self, name)(*[unquote(g) for g in match.groups()])
					if method != "GET":
						self.state.save()
				return HTTPStatus.OK, {"ok": True, "data": data}
		raise MockError(404, f"cannot {method.lower()} {path}")

	def _read_body(self) -> dict:
		length = int(self.headers.get("Content-Length") or 0)
		raw = self.rfile.read(length) if length else b""
		ctype = self.headers.get("Content-Type", "")
		if not raw:
			return {}
		if ctype.startswith("application/json"):
			try:
				return json.loads(raw or b"{}")
			except ValueError as exc:
				raise MockError(400, "invalid json body") from exc
		if ctype.startswith("application/x-www-form-urlencoded"):
			return {k: v[-1] for k, v in parse_qs(raw.decode()).items()}
		if ctype.startswith("multipart/form-data"):
			message = BytesParser(policy=HTTP).parsebytes(f"Content-Type: {ctype}\r\n\r\n".encode() + raw)
			body = {}
			for part in message.iter_parts():
				name = part.get_param("name", header="content-disposition")
				if part.get_filename() is not None:
					body[name] = {
						"filename": part.get_filename(),
						"size": len(part.get_payload(decode=True) or b""),
					}
				else:
					body[name] = part.get_content()
			return body
		return {}

	def _log(self, method, path, status):
		auth = (
			"admin"
			if self.headers.get("X-Admin-Secret")
			else "api-key"
			if self.headers.get("X-API-Key")
			else "bearer"
			if self.headers.get("Authorization")
			else "none"
		)
		with self.state.lock:
			self.state.requests.append({"method": method, "path": path, "auth": auth, "status": status})
			del self.state.requests[:-MAX_LOGGED_REQUESTS]

	# -- auth ------------------------------------------------------------------------------------
	def _require_admin(self):
		if self.headers.get("X-Admin-Secret", "") != self.state.admin_secret:
			raise MockError(401, "invalid admin secret")

	def _require_api_key(self) -> dict:
		key = self.state.key_by_value(self.headers.get("X-API-Key", ""))
		if not key:
			raise MockError(401, "invalid api key")
		return key

	def _require_device(self) -> dict:
		auth = self.headers.get("Authorization", "")
		token = auth[len("Bearer ") :] if auth.startswith("Bearer ") else ""
		device = self.state.device_by_token(token) if token else None
		if not device:
			raise MockError(401, "invalid or expired token")
		return device

	def _require_connected(self) -> dict:
		device = self._require_device()
		if device["status"] != CONNECTED:
			raise MockError(400, "whatsapp client is not connected")
		return device

	# -- admin -----------------------------------------------------------------------------------
	@route("POST", r"/admin/api-keys")
	def admin_create_api_key(self):
		self._require_admin()
		if not self.body.get("customer_email"):
			raise MockError(400, "customer_email is required")
		key_id = self.state.next_key_id()
		record = {**self.body, "id": key_id, "api_key": f"mock-apikey-{key_id:04d}"}
		self.state.api_keys[key_id] = record
		return {"id": key_id, "api_key": record["api_key"]}

	@route("PATCH", r"/admin/api-keys/(\d+)")
	def admin_update_api_key(self, key_id):
		self._require_admin()
		record = self.state.api_keys.get(int(key_id))
		if not record:
			raise MockError(404, "api key not found")
		record.update({k: v for k, v in self.body.items() if k not in ("id", "api_key")})
		return {"id": record["id"], "api_key": record["api_key"]}

	@route("GET", r"/admin/api-keys/(\d+)/devices")
	def admin_list_devices_by_api_key(self, key_id):
		self._require_admin()
		if int(key_id) not in self.state.api_keys:
			raise MockError(404, "api key not found")
		return [
			{"id": d["id"], "name": d["name"], "status": d["status"]}
			for d in self.state.devices.values()
			if d["api_key_id"] == int(key_id)
		]

	@route("DELETE", r"/admin/devices/([^/]+)")
	def admin_delete_device(self, device_id):
		self._require_admin()
		if not self.state.devices.pop(device_id, None):
			raise MockError(404, "device not found")
		for wid in [w for w, hook in self.state.webhooks.items() if hook["device_id"] == device_id]:
			del self.state.webhooks[wid]
		return {"deleted": device_id}

	# -- devices ---------------------------------------------------------------------------------
	@route("POST", r"/devices")
	def create_device(self):
		key = self._require_api_key()
		limit = int(key.get("max_devices") or 0)
		owned = [d for d in self.state.devices.values() if d["api_key_id"] == key["id"]]
		if limit and len(owned) >= limit:
			raise MockError(409, "device limit reached")
		n = self.state.next_device_id()
		device = {
			"id": f"mock-dev-{n:04d}",
			"token": f"mock-devtok-{n:04d}",
			"api_key_id": key["id"],
			"name": self.body.get("name") or f"device-{n}",
			"phone": digits(self.body.get("phone")),
			"status": DISCONNECTED,
			"paired": False,
			"sent": 0,
			"contacts": {},
		}
		self.state.devices[device["id"]] = device
		return {"id": device["id"], "token": device["token"], "status": device["status"]}

	@route("GET", r"/devices/me")
	def device_me(self):
		device = self._require_device()
		return {
			"id": device["id"],
			"name": device["name"],
			"phone_number": device["phone"],
			"status": device["status"],
		}

	@route("GET", r"/devices/me/status")
	def device_status(self):
		device = self._require_device()
		return {"status": device["status"], "connected": device["status"] == CONNECTED}

	@route("POST", r"/devices/me/login")
	def device_login_qr(self):
		device = self._require_device()
		if device["status"] == CONNECTED:
			raise MockError(400, "already logged in")
		# A fixed 1x1 PNG: enough for the platform's "starts with iVBOR" detection, never a real QR.
		png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
		return {"qr_code": f"data:image/png;base64,{png}", "device_id": device["id"]}

	@route("POST", r"/devices/me/login-code")
	def device_login_pair_code(self):
		device = self._require_device()
		phone = digits(self.body.get("phone"))
		if not phone:
			raise MockError(400, "phone is required")
		device["phone"] = phone
		number = int(device["id"].rsplit("-", 1)[-1])
		return {"PairCode": f"MOCK-{number:04d}"}

	@route("POST", r"/devices/me/reconnect")
	def device_reconnect(self):
		device = self._require_device()
		if device["paired"] and device["status"] != LOGGED_OUT:
			device["status"] = CONNECTED
		return {"status": device["status"]}

	@route("DELETE", r"/devices/me/session")
	def device_logout(self):
		device = self._require_device()
		device["status"] = LOGGED_OUT
		device["paired"] = False
		return {"status": device["status"]}

	# -- messaging -------------------------------------------------------------------------------
	def _sent(self, device: dict) -> dict:
		device["sent"] += 1
		return {"provider_message_id": self.state.next_message_id(), "status": "sent"}

	@route("POST", r"/chats/([^/]+)/messages")
	def send_text_message(self, jid):
		device = self._require_connected()
		if self.body.get("type") != "location" and not self.body.get("text"):
			raise MockError(400, "text is required")
		return self._sent(device)

	@route("POST", r"/chats/([^/]+)/messages/location")
	def send_location_message(self, jid):
		device = self._require_connected()
		if self.body.get("latitude") is None or self.body.get("longitude") is None:
			raise MockError(400, "latitude and longitude are required")
		return self._sent(device)

	@route("POST", r"/chats/([^/]+)/(images|documents|videos|audio|stickers)")
	def send_media_message(self, jid, kind):
		device = self._require_connected()
		if not isinstance(self.body.get("file"), dict):
			raise MockError(400, "file is required")
		return self._sent(device)

	@route("POST", r"/chats/([^/]+)/polls")
	def create_poll(self, jid):
		device = self._require_connected()
		options = self.body.get("options") or []
		if not self.body.get("question") or len(options) < 2:
			raise MockError(400, "question and at least two options are required")
		poll_id = self.state.next_poll_id()
		self.state.polls[poll_id] = {
			"device_id": device["id"],
			"question": self.body["question"],
			"options": options,
		}
		device["sent"] += 1
		return {"poll_id": poll_id, "provider_message_id": poll_id}

	@route("GET", r"/polls/([^/]+)/results")
	def poll_results(self, poll_id):
		device = self._require_device()
		poll = self.state.polls.get(poll_id)
		if not poll or poll["device_id"] != device["id"]:
			raise MockError(404, "poll not found")
		return {
			"poll_id": poll_id,
			"question": poll["question"],
			"results": [{"option": o, "votes": 0} for o in poll["options"]],
		}

	# -- contacts / groups -----------------------------------------------------------------------
	@route("POST", r"/users/me/contacts/sync")
	def sync_contacts(self):
		device = self._require_connected()
		phones = [digits(p) for p in self.body.get("phones") or [] if digits(p)]
		if not phones:
			raise MockError(400, "phones list is empty")
		rows = [{"phone": p, "jid": f"{p}@s.whatsapp.net", "is_on_whatsapp": True} for p in phones]
		for row in rows:
			device["contacts"][row["phone"]] = row
		return rows

	@route("GET", r"/users/me/contacts")
	def list_contacts(self):
		device = self._require_device()
		return [
			{"id": c["jid"], "jid": c["jid"], "phone": c["phone"], "push_name": ""}
			for c in device["contacts"].values()
		]

	@route("GET", r"/groups")
	def list_groups(self):
		self._require_device()
		return []

	# -- webhooks --------------------------------------------------------------------------------
	@route("GET", r"/webhooks")
	def list_webhooks(self):
		device = self._require_device()
		return [
			{"id": w["id"], "url": w["url"], "events": w["events"], "active": True}
			for w in self.state.webhooks.values()
			if w["device_id"] == device["id"]
		]

	@route("POST", r"/webhooks")
	def create_webhook(self):
		device = self._require_device()
		if not self.body.get("url"):
			raise MockError(400, "url is required")
		webhook_id = self.state.next_webhook_id()
		self.state.webhooks[webhook_id] = {
			"id": webhook_id,
			"device_id": device["id"],
			"url": self.body["url"],
			"events": list(self.body.get("events") or []),
			"has_secret": bool(self.body.get("secret")),
		}
		return {"id": webhook_id}

	@route("DELETE", r"/webhooks/(\d+)")
	def delete_webhook(self, webhook_id):
		device = self._require_device()
		hook = self.state.webhooks.get(int(webhook_id))
		if not hook or hook["device_id"] != device["id"]:
			raise MockError(404, "webhook not found")
		del self.state.webhooks[int(webhook_id)]
		return {"deleted": int(webhook_id)}

	# -- development controls (admin secret required) --------------------------------------------
	@route("GET", r"/__mock/state")
	def mock_state(self):
		return self.state.snapshot()

	@route("GET", r"/__mock/requests")
	def mock_requests(self):
		return list(self.state.requests)

	@route("POST", r"/__mock/reset")
	def mock_reset(self):
		self.state.reset()
		return {"reset": True}

	@route("POST", r"/__mock/devices/([^/]+)/state")
	def mock_set_device_state(self, device_id):
		"""Simulate the phone side: {"status": "connected"} pairs the device, anything else unpairs it."""
		device = self.state.devices.get(device_id)
		if not device:
			raise MockError(404, "device not found")
		status = str(self.body.get("status") or "")
		if status not in (CONNECTED, DISCONNECTED, LOGGED_OUT):
			raise MockError(400, f"status must be one of {CONNECTED}, {DISCONNECTED}, {LOGGED_OUT}")
		device["status"] = status
		device["paired"] = status == CONNECTED
		return {"id": device_id, "status": status}

	def do_GET(self):
		self._dispatch("GET")

	def do_POST(self):
		self._dispatch("POST")

	def do_PATCH(self):
		self._dispatch("PATCH")

	def do_DELETE(self):
		self._dispatch("DELETE")


def make_server(host: str, port: int, admin_secret: str, state_file: str | None = None) -> ThreadingHTTPServer:
	if host not in LOOPBACK_HOSTS:
		raise SystemExit(f"refusing to bind wa-admin mock to non-loopback host {host!r}")
	if not admin_secret:
		raise SystemExit("WA_MOCK_ADMIN_SECRET is required")
	state = State(admin_secret=admin_secret, state_file=state_file)
	handler = type("BoundHandler", (Handler,), {"state": state})
	server = ThreadingHTTPServer(("127.0.0.1" if host == "localhost" else host, port), handler)
	server.daemon_threads = True
	server.state = state
	return server


def main(argv=None):
	parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
	parser.add_argument("--host", default="127.0.0.1")
	parser.add_argument("--port", type=int, default=18080)
	parser.add_argument("--state-file", default=None, help="keep the state in this JSON file across restarts")
	args = parser.parse_args(argv)
	server = make_server(args.host, args.port, os.environ.get("WA_MOCK_ADMIN_SECRET", ""), args.state_file)
	host, port = server.server_address[:2]
	print(f"wa-admin mock listening on http://{host}:{port}{API_PREFIX}", flush=True)
	try:
		server.serve_forever()
	except KeyboardInterrupt:
		pass
	finally:
		server.server_close()


if __name__ == "__main__":
	main()
