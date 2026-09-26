"""Snapshot layout, checksums, packaging.

<ID>/
    manifest.json                    no secrets: architecture, sites, apps, versions, repos, warnings
    dev-state-summary.md             no secrets: human handoff
    checksums.sha256                 sha256 of every other file (sha256sum -c compatible)
    databases/<site>.postgres.dump   pg_dump custom format   (PostgreSQL sites)
    databases/<site>.mariadb.sql.gz  mariadb-dump, gzipped   (MariaDB sites)
    sites/<site>/site_config.json    SENSITIVE (db password, encryption_key, app secrets)
    sites/<site>/public-files.tar.gz
    sites/<site>/private-files.tar.gz
    sites/<site>/row_counts.json     per-table row counts, used to verify a restore
    bench/common_site_config.json    SENSITIVE
    bench/apps.txt, bench/apps.json
    bench/versions.json              runtimes and tools
    git/repositories.json            url / branch / commit / dirty files per app (no code)
    git/patches/<app>.diff           only with --include-dirty-patches
"""

from __future__ import annotations

import json
import os
import tarfile
from pathlib import Path

from .common import MANIFEST_FORMAT, Config, DevStateError, secure_file, sha256_file

CHECKSUMS = "checksums.sha256"
SENSITIVE_PATTERNS = ("site_config.json", "common_site_config.json", "databases/", "files.tar.gz", "patches/")


def write_checksums(root: Path, cfg: Config):
	lines = []
	for path in sorted(p for p in root.rglob("*") if p.is_file() and p.name != CHECKSUMS):
		lines.append(f"{sha256_file(path)}  {path.relative_to(root).as_posix()}")
	(root / CHECKSUMS).write_text("\n".join(lines) + "\n")
	secure_file(root / CHECKSUMS, cfg)


def verify_checksums(root: Path) -> list[str]:
	"""Return a list of problems (empty = intact). Extra, missing and altered files all count."""
	listing = root / CHECKSUMS
	if not listing.exists():
		return [f"{CHECKSUMS} missing"]
	expected = {}
	for line in listing.read_text().splitlines():
		if line.strip():
			digest, _, rel = line.partition("  ")
			expected[rel] = digest
	problems = []
	actual = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file() and p.name != CHECKSUMS}
	for rel in sorted(set(expected) - actual):
		problems.append(f"missing file: {rel}")
	for rel in sorted(actual - set(expected)):
		problems.append(f"unexpected file (not in checksums): {rel}")
	for rel in sorted(set(expected) & actual):
		if sha256_file(root / rel) != expected[rel]:
			problems.append(f"checksum mismatch: {rel}")
	return problems


def load_manifest(root: Path) -> dict:
	path = root / "manifest.json"
	if not path.exists():
		raise DevStateError(f"{root} has no manifest.json")
	manifest = json.loads(path.read_text())
	if manifest.get("format") != MANIFEST_FORMAT:
		raise DevStateError(
			f"unsupported manifest format {manifest.get('format')} (this tool reads {MANIFEST_FORMAT})"
		)
	return manifest


def package(snapshot_dir: Path, out: Path, cfg: Config) -> Path:
	with tarfile.open(out, "w") as tar:
		tar.add(snapshot_dir, arcname=snapshot_dir.name)
	secure_file(out, cfg)
	return out


def unpack(package_path: Path, dst_parent: Path) -> Path:
	with tarfile.open(package_path, "r") as tar:
		names = tar.getnames()
		tops = {n.split("/", 1)[0] for n in names}
		if len(tops) != 1:
			raise DevStateError(f"{package_path.name} does not contain exactly one snapshot directory")
		tar.extractall(dst_parent, filter="data")
	return dst_parent / tops.pop()


def backend_meta(manifest: dict, package_path: Path, encrypted: bool) -> dict:
	"""Non-secret metadata stored next to the package, so snapshots can be listed without decrypting."""
	return {
		"format": MANIFEST_FORMAT,
		"snapshot_id": manifest["snapshot_id"],
		"created_at": manifest["created_at"],
		"object": package_path.name,
		"object_sha256": sha256_file(package_path),
		"size": package_path.stat().st_size,
		"encrypted": encrypted,
		"label": manifest.get("label"),
		"sites": [
			{"name": s["name"], "db_type": s["db"]["db_type"], "apps": s["installed_apps"]}
			for s in manifest["sites"]
		],
		"repositories": [
			{k: r.get(k) for k in ("app", "url", "branch", "commit", "dirty")}
			for r in manifest["repositories"]
		],
		"warnings": len(manifest.get("warnings", [])),
	}


def is_sensitive(rel: str) -> bool:
	return any(p in rel for p in SENSITIVE_PATTERNS)


def tighten(root: Path, cfg: Config):
	for dirpath, _dirs, files in os.walk(root):
		os.chmod(dirpath, 0o700)
		for name in files:
			secure_file(Path(dirpath) / name, cfg)
