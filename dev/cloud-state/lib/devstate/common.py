"""Shared helpers: configuration, logging, subprocess execution, permissions, hashing.

Standard library only: this runs with the system python3 before the bench exists.
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import pwd
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parents[2]
DEFAULTS_FILE = TOOL_DIR / "config" / "defaults.env"
REPOS_FILE = TOOL_DIR / "config" / "repos.json"
MANIFEST_FORMAT = 1

#: Keys whose values are never printed or written to non-sensitive files.
SECRET_KEY_MARKERS = ("password", "secret", "token", "encryption_key", "api_key", "passphrase", "identity")


class DevStateError(Exception):
	"""A failure the user must act on; the message says what to do."""


# ------------------------------------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------------------------------------
def _parse_env_file(path: Path) -> dict[str, str]:
	values = {}
	if not path.exists():
		return values
	for line in path.read_text().splitlines():
		line = line.strip()
		if not line or line.startswith("#") or "=" not in line:
			continue
		key, _, value = line.partition("=")
		values[key.strip()] = value.strip().strip('"').strip("'")
	return values


@dataclass(frozen=True)
class Config:
	values: dict

	def __getattr__(self, name):
		try:
			return self.values[name]
		except KeyError as exc:
			raise AttributeError(name) from exc

	def get(self, name, default=None):
		return self.values.get(name, default)

	@property
	def bench(self) -> Path:
		return Path(self.values["BENCH_DIR"])

	@property
	def sites_dir(self) -> Path:
		return self.bench / "sites"

	@property
	def state_dir(self) -> Path:
		return Path(self.values["DEV_STATE_DIR"])

	@property
	def secrets_dir(self) -> Path:
		return Path(self.values["DEV_SECRETS_DIR"])

	@property
	def bench_python(self) -> Path:
		return self.bench / "env" / "bin" / "python"


def load_config() -> Config:
	values = _parse_env_file(DEFAULTS_FILE)
	for key in list(values):
		if key in os.environ:
			values[key] = os.environ[key]
	# Environment-only keys (secrets and backend credentials) are read directly from os.environ
	# where they are used; they are never copied into Config.
	return Config(values)


def read_secret_file(cfg: Config, name: str) -> str:
	path = cfg.secrets_dir / name
	if not path.exists():
		raise DevStateError(f"missing infrastructure secret {path} (run bootstrap-cloud.sh)")
	return path.read_text().strip()


# ------------------------------------------------------------------------------------------------
# Output
# ------------------------------------------------------------------------------------------------
_LOG_FILE = None


def set_log_file(path: Path, cfg: "Config"):
	global _LOG_FILE
	secure_dir(path.parent, cfg)
	path.touch()
	secure_file(path, cfg)
	_LOG_FILE = path


def log(message: str = "", *, level: str = "info"):
	prefix = {"info": "", "warn": "WARN  ", "error": "ERROR ", "ok": "OK    ", "step": "==> "}[level]
	line = f"{prefix}{message}"
	print(line, file=sys.stderr if level == "error" else sys.stdout, flush=True)
	if _LOG_FILE:
		with open(_LOG_FILE, "a") as fh:
			fh.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {line}\n")


def is_secret_key(key: str) -> bool:
	key = key.lower()
	return any(marker in key for marker in SECRET_KEY_MARKERS)


def redact_mapping(mapping: dict) -> dict:
	"""A copy safe to print or put in the manifest: secret-looking values replaced by a marker."""
	out = {}
	for key, value in mapping.items():
		if isinstance(value, dict):
			out[key] = redact_mapping(value)
		elif is_secret_key(key):
			out[key] = "<redacted>" if value else value
		else:
			out[key] = value
	return out


# ------------------------------------------------------------------------------------------------
# Processes
# ------------------------------------------------------------------------------------------------
def require_root():
	if os.geteuid() != 0:
		raise DevStateError("run this as root (it switches to the frappe user where needed)")


def run(
	cmd, *, user: str | None = None, check=True, capture=True, env=None, cwd=None, input=None, stdout=None
):
	"""Run a command, optionally as another user (without a login shell), never through a shell."""
	full_env = dict(os.environ)
	if user:
		pw = pwd.getpwnam(user)
		full_env.update({"HOME": pw.pw_dir, "USER": user, "LOGNAME": user})
		cmd = ["runuser", "-u", user, "--", *cmd]
	if env:
		full_env.update(env)
	result = subprocess.run(
		[str(c) for c in cmd],
		check=False,
		text=stdout is None,
		capture_output=capture and stdout is None,
		stdout=stdout,
		env=full_env,
		cwd=cwd,
		input=input,
	)
	if check and result.returncode != 0:
		err = (result.stderr or "").strip()[-2000:] if isinstance(result.stderr, str) else ""
		raise DevStateError(f"command failed ({result.returncode}): {' '.join(map(str, cmd[:6]))} ...\n{err}")
	return result


def which(tool: str) -> str | None:
	return shutil.which(tool)


def tool_version(cmd: list[str]) -> str | None:
	try:
		out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
	except (OSError, subprocess.TimeoutExpired):
		return None
	text = (out.stdout or out.stderr or "").strip().splitlines()
	return text[0].strip() if text else None


def bench_cmd(cfg: Config, *args, check=True):
	"""Run `bench <args>` as the frappe user from the bench directory, with its login PATH."""
	shell = "cd {} && bench {}".format(
		shlex_quote(str(cfg.bench)), " ".join(shlex_quote(str(a)) for a in args)
	)
	return run(["bash", "-lc", shell], user=cfg.FRAPPE_USER, check=check)


def shlex_quote(value: str) -> str:
	import shlex

	return shlex.quote(value)


# ------------------------------------------------------------------------------------------------
# Files and permissions
# ------------------------------------------------------------------------------------------------
def frappe_ids(cfg: Config) -> tuple[int, int]:
	pw = pwd.getpwnam(cfg.FRAPPE_USER)
	return pw.pw_uid, pw.pw_gid


def secure_dir(path: Path, cfg: Config) -> Path:
	"""mkdir -p where EVERY directory created here (not only the leaf) is 0700 and owned by frappe."""
	uid, gid = frappe_ids(cfg)
	created = []
	probe = path
	while not probe.exists():
		created.append(probe)
		probe = probe.parent
	for d in reversed(created):
		d.mkdir()
		os.chmod(d, 0o700)
		os.chown(d, uid, gid)
	os.chmod(path, 0o700)
	os.chown(path, uid, gid)
	return path


def secure_file(path: Path, cfg: Config, mode=0o600):
	os.chmod(path, mode)
	uid, gid = frappe_ids(cfg)
	os.chown(path, uid, gid)


def sha256_file(path: Path) -> str:
	h = hashlib.sha256()
	with open(path, "rb") as fh:
		for chunk in iter(lambda: fh.read(1 << 20), b""):
			h.update(chunk)
	return h.hexdigest()


def write_json(path: Path, data, *, cfg: Config | None = None):
	"""Every file in a snapshot is 0600, sensitive or not: the directory is private as a whole."""
	path.write_text(json.dumps(data, indent=1, sort_keys=True, default=str) + "\n")
	if cfg:
		secure_file(path, cfg)


@contextlib.contextmanager
def private_tempfile(content: str, cfg: Config, suffix=""):
	"""A 0600 temp file readable by the frappe user (for client credentials), removed afterwards."""
	fd, name = tempfile.mkstemp(suffix=suffix, dir=secure_dir(cfg.state_dir / "tmp", cfg))
	try:
		with os.fdopen(fd, "w") as fh:
			fh.write(content)
		secure_file(Path(name), cfg)
		yield Path(name)
	finally:
		with contextlib.suppress(FileNotFoundError):
			os.unlink(name)


@contextlib.contextmanager
def exclusive_lock(path: Path, what: str):
	path.parent.mkdir(parents=True, exist_ok=True)
	fh = open(path, "w")
	try:
		fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
	except BlockingIOError as exc:
		fh.close()
		raise DevStateError(f"another {what} is already running (lock {path})") from exc
	try:
		fh.write(str(os.getpid()))
		fh.flush()
		yield
	finally:
		fcntl.flock(fh, fcntl.LOCK_UN)
		fh.close()


def utc_id() -> str:
	return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())


def utc_now() -> str:
	return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
