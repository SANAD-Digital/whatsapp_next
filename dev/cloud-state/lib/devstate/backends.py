"""Where packaged snapshots are kept. Same interface for every backend:

    publish(package, meta)  -> store, verify, then (only then) move the latest pointer
    list()                  -> [meta, ...] newest first
    latest()                -> meta | None
    fetch(snapshot_id, dst_dir) -> local path of the package

Object layout (identical keys locally and in R2, under the prefix):
    <prefix>/snapshots/<ID>.tar.age     encrypted package (plain .tar allowed locally only)
    <prefix>/snapshots/<ID>.meta.json   non-secret metadata: id, time, sha256, size, sites, repos
    <prefix>/latest.json                pointer to the last VERIFIED snapshot
Nothing is ever deleted by these tools.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from .common import Config, DevStateError, log, run, secure_dir, secure_file, sha256_file, utc_now


class LocalBackend:
	name = "local"

	def __init__(self, cfg: Config):
		self.cfg = cfg
		self.root = secure_dir(cfg.state_dir / "store" / cfg.R2_PREFIX, cfg)
		secure_dir(self.root / "snapshots", cfg)

	def publish(self, package: Path, meta: dict) -> dict:
		dst = self.root / "snapshots" / package.name
		shutil.copyfile(package, dst)
		secure_file(dst, self.cfg)
		if sha256_file(dst) != meta["object_sha256"]:
			raise DevStateError(f"stored copy of {package.name} does not match its checksum")
		meta_path = self.root / "snapshots" / f"{meta['snapshot_id']}.meta.json"
		meta_path.write_text(json.dumps(meta, indent=1, sort_keys=True) + "\n")
		secure_file(meta_path, self.cfg)
		self._set_latest(meta)
		return {"backend": self.name, "location": str(dst)}

	def _set_latest(self, meta):
		latest = self.root / "latest.json"
		tmp = latest.with_suffix(".tmp")
		tmp.write_text(
			json.dumps(
				{
					"snapshot_id": meta["snapshot_id"],
					"object": meta["object"],
					"object_sha256": meta["object_sha256"],
					"updated_at": utc_now(),
				},
				indent=1,
			)
			+ "\n"
		)
		secure_file(tmp, self.cfg)
		os.replace(tmp, latest)

	def list(self) -> list[dict]:
		metas = [json.loads(p.read_text()) for p in (self.root / "snapshots").glob("*.meta.json")]
		return sorted(metas, key=lambda m: m["snapshot_id"], reverse=True)

	def latest(self) -> dict | None:
		path = self.root / "latest.json"
		return json.loads(path.read_text()) if path.exists() else None

	def meta(self, snapshot_id: str) -> dict:
		path = self.root / "snapshots" / f"{snapshot_id}.meta.json"
		if not path.exists():
			raise DevStateError(f"snapshot {snapshot_id} is not in the local store")
		return json.loads(path.read_text())

	def fetch(self, snapshot_id: str, dst_dir: Path) -> Path:
		meta = self.meta(snapshot_id)
		src = self.root / "snapshots" / meta["object"]
		dst = dst_dir / meta["object"]
		shutil.copyfile(src, dst)
		secure_file(dst, self.cfg)
		return dst


class R2Backend:
	"""Cloudflare R2 through its S3-compatible API, using boto3 from a dedicated venv.

	Credentials come only from the environment (Claude Cloud environment secrets):
	    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
	"""

	name = "r2"
	REQUIRED = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")

	def __init__(self, cfg: Config):
		missing = [k for k in self.REQUIRED if not os.environ.get(k)]
		if missing:
			raise DevStateError(
				f"R2 backend selected but not configured; missing environment variables: {', '.join(missing)}"
			)
		self.cfg = cfg
		self.python = Path(cfg.DEV_STATE_R2_VENV) / "bin" / "python"
		if not self.python.exists():
			raise DevStateError(
				f"R2 helper venv missing at {cfg.DEV_STATE_R2_VENV} (run bootstrap-cloud.sh --with-r2)"
			)
		self.prefix = cfg.R2_PREFIX.strip("/")

	def _helper(self, *args, stdin: str | None = None) -> dict:
		helper = Path(__file__).with_name("r2_helper.py")
		res = run([str(self.python), str(helper), *args], input=stdin, check=False)
		if res.returncode != 0:
			raise DevStateError(f"R2 {args[0]} failed: {(res.stderr or '').strip()[-500:]}")
		return json.loads(res.stdout or "{}")

	def _key(self, *parts):
		return "/".join([self.prefix, *parts])

	def publish(self, package: Path, meta: dict) -> dict:
		if not package.name.endswith(".age"):
			raise DevStateError("refusing to upload an unencrypted snapshot to R2")
		key = self._key("snapshots", package.name)
		self._helper("put", key, str(package), meta["object_sha256"])
		head = self._helper("head", key)
		if int(head.get("size", -1)) != package.stat().st_size or head.get("sha256") != meta["object_sha256"]:
			raise DevStateError(f"uploaded object {key} failed verification; latest pointer NOT updated")
		self._helper(
			"put-json", self._key("snapshots", f"{meta['snapshot_id']}.meta.json"), stdin=json.dumps(meta)
		)
		pointer = {
			"snapshot_id": meta["snapshot_id"],
			"object": meta["object"],
			"object_sha256": meta["object_sha256"],
			"updated_at": utc_now(),
		}
		self._helper("put-json", self._key("latest.json"), stdin=json.dumps(pointer))
		log(f"uploaded and verified r2://{os.environ['R2_BUCKET']}/{key}", level="ok")
		return {"backend": self.name, "location": f"r2://{os.environ['R2_BUCKET']}/{key}"}

	def list(self) -> list[dict]:
		keys = self._helper("list", self._key("snapshots") + "/").get("keys", [])
		metas = [self._helper("get-json", k) for k in keys if k.endswith(".meta.json")]
		return sorted(metas, key=lambda m: m["snapshot_id"], reverse=True)

	def latest(self) -> dict | None:
		return self._helper("get-json", self._key("latest.json"), "--missing-ok") or None

	def meta(self, snapshot_id: str) -> dict:
		return self._helper("get-json", self._key("snapshots", f"{snapshot_id}.meta.json"))

	def fetch(self, snapshot_id: str, dst_dir: Path) -> Path:
		meta = self.meta(snapshot_id)
		dst = dst_dir / meta["object"]
		self._helper("get", self._key("snapshots", meta["object"]), str(dst))
		secure_file(dst, self.cfg)
		if sha256_file(dst) != meta["object_sha256"]:
			raise DevStateError(f"downloaded {meta['object']} does not match its recorded sha256")
		return dst


def get_backend(cfg: Config, name: str | None = None):
	name = (name or cfg.DEV_STATE_BACKEND or "local").lower()
	if name == "local":
		return LocalBackend(cfg)
	if name == "r2":
		return R2Backend(cfg)
	raise DevStateError(f"unknown DEV_STATE_BACKEND {name!r} (local | r2)")
