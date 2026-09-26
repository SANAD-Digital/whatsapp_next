"""Command-line entry point used by the *.sh wrappers."""

from __future__ import annotations

import argparse
import json
import os
import sys

from . import snapshot
from .backends import get_backend
from .common import DevStateError, load_config, log


def _list(cfg, args) -> int:
	backend = get_backend(cfg, args.backend)
	latest = (backend.latest() or {}).get("snapshot_id")
	metas = backend.list()
	if not metas:
		print(f"no snapshots in the {backend.name} backend")
	for m in metas:
		flag = "*" if m["snapshot_id"] == latest else " "
		sites = ", ".join(f"{s['name']}({s['db_type']})" for s in m["sites"])
		enc = "encrypted" if m["encrypted"] else "PLAIN"
		print(
			f"{flag} {m['snapshot_id']}  {m['size'] / 1e6:7.1f} MB  {enc:<9}  {sites}"
			+ (f"  [{m['label']}]" if m.get("label") else "")
		)
	return 0


def _check(cfg, args) -> int:
	from pathlib import Path

	problems = snapshot.verify_checksums(Path(args.path))
	for p in problems:
		print(p)
	print("OK" if not problems else f"{len(problems)} problem(s)")
	return 0 if not problems else 1


def main(argv=None) -> int:
	parser = argparse.ArgumentParser(prog="devstate")
	sub = parser.add_subparsers(dest="cmd", required=True)

	p = sub.add_parser("save", help="snapshot every site")
	p.add_argument("--id", help="snapshot id (default: UTC timestamp)")
	p.add_argument("--label", help="free-text label stored in the manifest")
	p.add_argument("--backend", help="local | r2 (default DEV_STATE_BACKEND)")
	p.add_argument("--no-publish", action="store_true", help="keep the snapshot directory only")
	p.add_argument(
		"--include-dirty-patches", action="store_true", help="also store diffs of uncommitted code"
	)
	p.add_argument("--summary-out", help="where to write dev-state-summary.md")

	p = sub.add_parser("restore", help="restore a snapshot (defensive)")
	p.add_argument("snapshot", help="'latest', a snapshot id, a snapshot directory, or a package file")
	p.add_argument("--backend")
	p.add_argument("--site", action="append", help="restore only this site (repeatable)")
	p.add_argument(
		"--as", dest="as_", action="append", metavar="OLD=NEW", help="restore a site under another name"
	)
	p.add_argument("--dry-run", action="store_true", help="verify and print the plan only")
	p.add_argument("--force", action="store_true", help="allow replacing sites/databases that already exist")
	p.add_argument("--yes", action="store_true", help="do not ask for confirmation")
	p.add_argument("--migrate", action="store_true", help="always migrate after restoring")
	p.add_argument(
		"--no-migrate",
		action="store_true",
		help="never migrate, even when app commits differ from the snapshot",
	)
	p.add_argument("--keep-scheduler", action="store_true", help="keep the scheduler state from the snapshot")
	p.add_argument(
		"--no-pre-backup", action="store_true", help="skip the backup taken before replacing a site"
	)

	sub.add_parser("verify", help="status report")
	p = sub.add_parser("list", help="list snapshots in a backend")
	p.add_argument("--backend")
	p = sub.add_parser("check", help="verify checksums of a snapshot directory")
	p.add_argument("path")

	args = parser.parse_args(argv)
	cfg = load_config()
	# Everything this tool creates is private by default: files 0600, directories 0700.
	os.umask(0o077)
	try:
		if args.cmd == "save":
			from .save import save

			return save(cfg, args)
		if args.cmd == "restore":
			from .restore import restore

			return restore(cfg, args)
		if args.cmd == "verify":
			from .verify import verify

			return verify(cfg, args)
		if args.cmd == "list":
			return _list(cfg, args)
		if args.cmd == "check":
			return _check(cfg, args)
	except DevStateError as exc:
		log(str(exc), level="error")
		return 1
	return 0


if __name__ == "__main__":
	sys.exit(main())
