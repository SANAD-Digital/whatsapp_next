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

Binds 127.0.0.1 only and refuses anything else. Standard library only.
"""

import http.client
import sys
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
			self.send_response(resp.status, resp.reason)
			for k, v in resp.getheaders():
				if k.lower() not in HOP_BY_HOP and k.lower() != "content-length":
					self.send_header(k, v)
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
