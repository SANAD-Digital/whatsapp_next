"""Snapshot encryption with age (https://age-encryption.org), a standard, audited tool.

Encryption needs only PUBLIC recipient keys, so an unattended save never holds a secret:
    DEV_STATE_AGE_RECIPIENTS        "age1... age1..."  (space/comma separated), or
    DEV_STATE_AGE_RECIPIENTS_FILE   file with one recipient per line
Decryption needs the matching PRIVATE identity, only at restore time:
    DEV_STATE_AGE_IDENTITY          contents of an age identity ("AGE-SECRET-KEY-1..."), or
    DEV_STATE_AGE_IDENTITY_FILE     path to an identity file
Neither is ever read from the repository.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from .common import Config, DevStateError, private_tempfile, run, which

RECIPIENT_RE = re.compile(r"^age1[0-9a-z]{58}$")


def recipients() -> list[str]:
	raw = os.environ.get("DEV_STATE_AGE_RECIPIENTS", "")
	path = os.environ.get("DEV_STATE_AGE_RECIPIENTS_FILE")
	if path:
		raw += "\n" + Path(path).read_text()
	values = [v.strip() for v in re.split(r"[\s,]+", raw) if v.strip() and not v.strip().startswith("#")]
	bad = [v for v in values if not RECIPIENT_RE.match(v)]
	if bad:
		raise DevStateError(
			f"{len(bad)} DEV_STATE_AGE_RECIPIENTS value(s) are not age X25519 recipients (age1...)"
		)
	return values


def encryption_configured() -> bool:
	return bool(recipients())


def decryption_configured() -> bool:
	return bool(os.environ.get("DEV_STATE_AGE_IDENTITY") or os.environ.get("DEV_STATE_AGE_IDENTITY_FILE"))


def _require_age():
	if not which("age"):
		raise DevStateError("the 'age' tool is not installed (bootstrap-cloud.sh installs it)")


def encrypt(cfg: Config, src: Path, dst: Path):
	_require_age()
	recips = recipients()
	if not recips:
		raise DevStateError("encryption requested but DEV_STATE_AGE_RECIPIENTS is not configured")
	args = ["age", "--encrypt"]
	for r in recips:
		args += ["-r", r]
	run([*args, "-o", str(dst), str(src)])
	os.chmod(dst, 0o600)


def decrypt(cfg: Config, src: Path, dst: Path):
	_require_age()
	identity_file = os.environ.get("DEV_STATE_AGE_IDENTITY_FILE")
	if identity_file:
		run(["age", "--decrypt", "-i", identity_file, "-o", str(dst), str(src)])
	else:
		identity = os.environ.get("DEV_STATE_AGE_IDENTITY", "")
		if not identity:
			raise DevStateError(
				"snapshot is encrypted; set DEV_STATE_AGE_IDENTITY or DEV_STATE_AGE_IDENTITY_FILE"
			)
		with private_tempfile(identity.strip() + "\n", cfg, suffix=".age-identity") as tmp:
			run(["age", "--decrypt", "-i", str(tmp), "-o", str(dst), str(src)])
	os.chmod(dst, 0o600)
