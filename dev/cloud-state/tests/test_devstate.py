"""Offline unit tests for the dev-state tool (no databases, no network, no real data).

    sudo env PYTHONPATH=lib python3 -m unittest discover -s tests -v
(root is needed only because the tool chowns what it writes to the frappe user.)
"""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from devstate import crypto, discover, restore, snapshot, summary
from devstate.backends import R2Backend, get_backend
from devstate.common import Config, DevStateError, load_config, redact_mapping


def cfg_with(**overrides) -> Config:
	values = dict(load_config().values)
	values.update(overrides)
	return Config(values)


class TestChecksums(unittest.TestCase):
	def setUp(self):
		self.tmp = tempfile.TemporaryDirectory()
		self.root = Path(self.tmp.name) / "SNAP"
		(self.root / "databases").mkdir(parents=True)
		(self.root / "manifest.json").write_text("{}")
		(self.root / "databases" / "a.dump").write_bytes(b"data")
		self.cfg = load_config()
		snapshot.write_checksums(self.root, self.cfg)

	def tearDown(self):
		self.tmp.cleanup()

	def test_intact_snapshot_verifies(self):
		self.assertEqual(snapshot.verify_checksums(self.root), [])

	def test_altered_missing_and_extra_files_are_reported(self):
		(self.root / "databases" / "a.dump").write_bytes(b"DATA")
		(self.root / "extra.txt").write_text("x")
		(self.root / "manifest.json").unlink()
		problems = "\n".join(snapshot.verify_checksums(self.root))
		self.assertIn("checksum mismatch: databases/a.dump", problems)
		self.assertIn("unexpected file (not in checksums): extra.txt", problems)
		self.assertIn("missing file: manifest.json", problems)


class TestRedaction(unittest.TestCase):
	def test_secret_looking_keys_are_redacted_recursively(self):
		conf = {
			"db_name": "_abc",
			"db_password": "p",
			"encryption_key": "k",
			"wa_admin_secret": "s",
			"nested": {"api_key": "x", "host_name": "h"},
			"developer_mode": 1,
		}
		out = redact_mapping(conf)
		self.assertEqual(out["db_name"], "_abc")
		self.assertEqual(out["developer_mode"], 1)
		for key in ("db_password", "encryption_key", "wa_admin_secret"):
			self.assertEqual(out[key], "<redacted>")
		self.assertEqual(out["nested"], {"api_key": "<redacted>", "host_name": "h"})


class TestSiteDiscovery(unittest.TestCase):
	def test_any_directory_with_site_config_is_a_site(self):
		with tempfile.TemporaryDirectory() as tmp:
			sites = Path(tmp) / "sites"
			for name in ("a.localhost", "c.localhost", "assets", "not-a-site"):
				(sites / name).mkdir(parents=True)
			(sites / "a.localhost" / "site_config.json").write_text("{}")
			(sites / "c.localhost" / "site_config.json").write_text("{}")
			(sites / "assets" / "site_config.json").write_text("{}")  # infrastructure, never a site
			(sites / "apps.txt").write_text("frappe\n")
			cfg = cfg_with(BENCH_DIR=tmp)
			self.assertEqual(discover.discover_sites(cfg), ["a.localhost", "c.localhost"])

	def test_db_info_defaults_per_engine(self):
		self.assertEqual(discover.site_db_info({"db_name": "_x"})["db_type"], "mariadb")
		self.assertEqual(discover.site_db_info({"db_name": "_x"})["db_port"], 3306)
		pg = discover.site_db_info({"db_name": "_y", "db_type": "postgres"})
		self.assertEqual((pg["db_type"], pg["db_port"], pg["db_user"]), ("postgres", 5432, "_y"))


class TestRestoreConfig(unittest.TestCase):
	def test_infra_keys_come_from_this_session_and_state_keys_from_the_snapshot(self):
		plan = {
			"db_type": "postgres",
			"db": {"db_host": "127.0.0.1", "db_port": 6543, "db_name": "_new", "db_user": "_new"},
			"password": "fresh",
			"snapshot_config": {
				"db_type": "postgres",
				"db_host": "10.0.0.9",
				"db_port": 5432,
				"db_name": "_old",
				"db_password": "old",
				"encryption_key": "KEEP",
				"developer_mode": 1,
				"wa_admin_api_url": "http://127.0.0.1:18080/api",
			},
		}
		conf = restore._reconciled_config(plan)
		self.assertEqual((conf["db_host"], conf["db_port"]), ("127.0.0.1", 6543))
		self.assertEqual((conf["db_name"], conf["db_password"]), ("_new", "fresh"))
		self.assertEqual(conf["encryption_key"], "KEEP")  # encrypted Password fields depend on it
		self.assertEqual(conf["wa_admin_api_url"], "http://127.0.0.1:18080/api")

	def test_renamed_targets_get_their_own_database_identity(self):
		a = restore._renamed_identity("x-verify.localhost", "S1")
		b = restore._renamed_identity("y-verify.localhost", "S1")
		self.assertNotEqual(a["db_name"], b["db_name"])
		self.assertTrue(a["db_name"].startswith("_") and len(a["db_name"]) == 17)


class TestEncryptionAndBackends(unittest.TestCase):
	def test_invalid_recipients_are_rejected(self):
		with mock.patch.dict(os.environ, {"DEV_STATE_AGE_RECIPIENTS": "not-a-key"}):
			with self.assertRaises(DevStateError):
				crypto.recipients()

	def test_no_recipients_means_encryption_not_configured(self):
		with mock.patch.dict(os.environ, {}, clear=False):
			os.environ.pop("DEV_STATE_AGE_RECIPIENTS", None)
			os.environ.pop("DEV_STATE_AGE_RECIPIENTS_FILE", None)
			self.assertFalse(crypto.encryption_configured())

	def test_r2_requires_credentials_from_the_environment(self):
		env = {k: v for k, v in os.environ.items() if not k.startswith("R2_")}
		with mock.patch.dict(os.environ, env, clear=True):
			with self.assertRaises(DevStateError) as ctx:
				R2Backend(load_config())
		self.assertIn("R2_ACCOUNT_ID", str(ctx.exception))

	def test_unknown_backend_is_an_error(self):
		with self.assertRaises(DevStateError):
			get_backend(load_config(), "ftp")


class TestSummary(unittest.TestCase):
	def test_summary_is_built_from_public_fields_only(self):
		manifest = {
			"snapshot_id": "S1",
			"created_at": "t",
			"created_on_host": "h",
			"tools": {},
			"sites": [
				{
					"name": "a.localhost",
					"db": {"db_type": "postgres"},
					"installed_apps": ["frappe"],
					"settings": {},
					"config_public": {"db_password": "<redacted>"},
				}
			],
			"repositories": [{"app": "frappe", "branch": "b", "commit": "c" * 40, "dirty": False}],
		}
		text = summary.render(manifest, {"published": True, "backend": "local", "encrypted": False})
		self.assertIn("a.localhost", text)
		self.assertIn("restore-dev-state.sh S1", text)
		self.assertNotIn("<redacted>", text)
		json.dumps(manifest)


if __name__ == "__main__":
	unittest.main()
