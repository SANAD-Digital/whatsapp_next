"""Development-only loopback reverse proxy that pins one Frappe site (mobile preview).

    site_proxy.py <listen_port> <upstream_port> <site>

One instance per site sits between the Microsoft Dev Tunnel and that site's loopback gunicorn:

    phone --HTTPS--> devtunnels.ms --> devtunnel host --> 127.0.0.1:<listen_port> (this proxy)
          --> 127.0.0.1:<upstream_port> (gunicorn, frappe.app:application_with_statics())

Routing rules (the behaviour tested for the mobile preview):
- ``X-Frappe-Site-Name: <site>`` is set on every request (any client value is dropped), so Frappe
  serves <site> whatever public hostname the request arrived with (frappe/app.py resolves the site
  from this header before Host). No site configuration is changed for the public hostname.
- The Host header is passed through, except for ``/files/``: Frappe's static-file middleware
  (frappe/middlewares.py) picks the site's public/files directory from Host only, so for those
  paths Host is rewritten to <site>.
- ``X-Forwarded-Proto: https`` is added when the client did not send one: the tunnel terminates
  TLS, so the application must know the browser is on HTTPS.
- Text responses (JS, CSS, HTML, JSON, SVG, ...) are gzip-compressed when the client accepts it,
  as nginx does in production. This matters on a phone: Dev Tunnels adds
  ``Cache-Control: no-cache,no-store`` to every response, so the browser downloads the bundles
  again on every page, and ~2.4 MB of uncompressed assets made the login page slow enough that
  Login was pressed before Frappe's JavaScript ran (the form then just reloads the page).
  Compressed /assets/ responses are kept in a small in-memory cache (keyed by path + ETag).

Binds 127.0.0.1 only and refuses anything else. Standard library only.
"""

import gzip
import http.client
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BIND = "127.0.0.1"
HOP_BY_HOP = {
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade",
}


COMPRESSIBLE = ("text/", "application/javascript", "application/json", "application/xml", "image/svg+xml")
MIN_COMPRESS = 1024
ASSET_CACHE_LIMIT = 64 * 1024 * 1024
_asset_cache = {}
_asset_cache_size = 0
_asset_cache_lock = threading.Lock()


def accepts_gzip(accept_encoding):
	"""True when an Accept-Encoding header value allows gzip (and does not give it q=0)."""
	for part in (accept_encoding or "").lower().split(","):
		name, _, params = part.strip().partition(";")
		if name.strip() in ("gzip", "*"):
			q = params.replace(" ", "")
			try:
				return not q.startswith("q=") or float(q[2:]) > 0
			except ValueError:
				return False
	return False


def should_compress(status, headers, body):
	"""Compress only complete, not yet encoded, reasonably large text responses."""
	lower = {k.lower(): v for k, v in headers}
	ctype = lower.get("content-type", "").lower()
	return (
		status == 200
		and "content-encoding" not in lower
		and len(body) >= MIN_COMPRESS
		and any(ctype.startswith(t) for t in COMPRESSIBLE)
	)


def compress(path, etag, body):
	"""gzip ``body``; /assets/ results are reused per ETag (the file is unchanged while the ETag is)."""
	global _asset_cache_size
	key = (path, etag) if path.startswith("/assets/") and etag else None
	if key:
		with _asset_cache_lock:
			hit = _asset_cache.get(key)
		if hit is not None:
			return hit
	data = gzip.compress(body, compresslevel=6)
	if key:
		with _asset_cache_lock:
			if _asset_cache_size + len(data) > ASSET_CACHE_LIMIT:
				_asset_cache.clear()
				_asset_cache_size = 0
			_asset_cache[key] = data
			_asset_cache_size += len(data)
	return data


def build_upstream_headers(items, path, site):
	"""Headers to send to gunicorn for a request with header ``items`` (name, value) and ``path``."""
	headers = {k: v for k, v in items if k.lower() not in HOP_BY_HOP and k.lower() != "x-frappe-site-name"}
	headers["X-Frappe-Site-Name"] = site
	if not any(k.lower() == "x-forwarded-proto" for k in headers):
		headers["X-Forwarded-Proto"] = "https"
	if path.startswith("/files/"):
		for k in [k for k in headers if k.lower() == "host"]:
			del headers[k]
		headers["Host"] = site
	return headers


def make_handler(upstream_port, site):
	class Proxy(BaseHTTPRequestHandler):
		protocol_version = "HTTP/1.1"

		def log_message(self, fmt, *args):
			sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

		def _read_body(self):
			if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
				chunks = []
				while True:
					size = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
					if size == 0:
						while self.rfile.readline() not in (b"\r\n", b"\n", b""):
							pass
						break
					chunks.append(self.rfile.read(size))
					self.rfile.readline()
				return b"".join(chunks)
			length = int(self.headers.get("Content-Length") or 0)
			return self.rfile.read(length) if length else None

		def _forward(self):
			body = self._read_body()
			headers = build_upstream_headers(self.headers.items(), self.path, site)
			if body is not None:
				headers["Content-Length"] = str(len(body))
			conn = http.client.HTTPConnection(BIND, upstream_port, timeout=120)
			try:
				conn.request(self.command, self.path, body=body, headers=headers)
				resp = conn.getresponse()
				data = resp.read()
			except OSError as exc:
				self.send_error(502, f"upstream error: {exc}")
				return
			finally:
				conn.close()
			resp_headers = resp.getheaders()
			gzipped = accepts_gzip(self.headers.get("Accept-Encoding")) and should_compress(
				resp.status, resp_headers, data
			)
			if gzipped:
				etag = next((v for k, v in resp_headers if k.lower() == "etag"), "")
				data = compress(self.path.split("?", 1)[0], etag, data)
			self.send_response(resp.status, resp.reason)
			vary = []
			for k, v in resp_headers:
				kl = k.lower()
				if kl in HOP_BY_HOP or kl == "content-length":
					continue
				if gzipped and kl == "vary":
					vary.append(v)
					continue
				if gzipped and kl == "etag" and not v.startswith("W/"):
					v = "W/" + v  # the encoded body differs byte-wise (as nginx does)
				self.send_header(k, v)
			if gzipped:
				self.send_header("Content-Encoding", "gzip")
				self.send_header("Vary", ", ".join([*vary, "Accept-Encoding"]))
			self.send_header("Content-Length", str(len(data)))
			self.end_headers()
			if self.command != "HEAD":
				self.wfile.write(data)

		do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = _forward

	return Proxy


def main(argv):
	if len(argv) != 4:
		sys.exit("usage: site_proxy.py <listen_port> <upstream_port> <site>")
	listen, upstream, site = int(argv[1]), int(argv[2]), argv[3]
	server = ThreadingHTTPServer((BIND, listen), make_handler(upstream, site))
	server.daemon_threads = True
	sys.stderr.write(f"site_proxy {BIND}:{listen} -> {BIND}:{upstream} site={site}\n")
	server.serve_forever()


if __name__ == "__main__":
	main(sys.argv)
