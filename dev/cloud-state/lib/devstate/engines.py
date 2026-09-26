"""Database engines. Each engine uses its own native tools; a dump is only ever restored into
the engine that produced it. Passwords travel through 0600 temp files or stdin, never argv."""

from __future__ import annotations

from pathlib import Path

from .common import Config, DevStateError, private_tempfile, read_secret_file, run, shlex_quote


def _pg_escape_passfile(value: str) -> str:
	return value.replace("\\", "\\\\").replace(":", "\\:")


def _pg_literal(value: str) -> str:
	return "'" + value.replace("'", "''") + "'"


def _pg_ident(value: str) -> str:
	return '"' + value.replace('"', '""') + '"'


def _my_literal(value: str) -> str:
	return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _my_ident(value: str) -> str:
	return "`" + value.replace("`", "``") + "`"


class Engine:
	name = ""
	dump_suffix = ""

	def __init__(self, cfg: Config):
		self.cfg = cfg

	# Implemented per engine ------------------------------------------------------------------------
	def root_check(self) -> str: ...
	def dump(self, db: dict, password: str, out: Path): ...
	def recreate(self, db: dict, password: str): ...
	def restore(self, db: dict, password: str, dump: Path): ...
	def database_exists(self, db_name: str) -> bool: ...
	def site_check(self, db: dict, password: str) -> str: ...


class Postgres(Engine):
	name = "postgres"
	dump_suffix = "postgres.dump"

	def _passfile(self, host, port, user, password):
		line = ":".join(_pg_escape_passfile(str(v)) for v in (host, port, "*", user, password))
		return private_tempfile(line + "\n", self.cfg, suffix=".pgpass")

	def _root(self):
		return (
			self.cfg.PG_HOST,
			int(self.cfg.PG_PORT),
			self.cfg.PG_ROOT_USER,
			read_secret_file(self.cfg, "postgres-root.pw"),
		)

	def _psql_root(self, sql: str, database="postgres", capture=True):
		host, port, user, password = self._root()
		with self._passfile(host, port, user, password) as pf:
			return run(
				[
					"psql",
					"-X",
					"-v",
					"ON_ERROR_STOP=1",
					"-h",
					host,
					"-p",
					port,
					"-U",
					user,
					"-d",
					database,
					"-At",
				],
				user=self.cfg.FRAPPE_USER,
				env={"PGPASSFILE": str(pf)},
				input=sql,
				capture=capture,
			)

	def root_check(self) -> str:
		return self._psql_root("SHOW server_version;").stdout.strip()

	def site_check(self, db, password) -> str:
		with self._passfile(db["db_host"], db["db_port"], db["db_user"], password) as pf:
			res = run(
				[
					"psql",
					"-X",
					"-h",
					db["db_host"],
					"-p",
					db["db_port"],
					"-U",
					db["db_user"],
					"-d",
					db["db_name"],
					"-Atc",
					"select 1",
				],
				user=self.cfg.FRAPPE_USER,
				env={"PGPASSFILE": str(pf)},
			)
		return res.stdout.strip()

	def database_exists(self, db_name) -> bool:
		return (
			self._psql_root(
				f"SELECT 1 FROM pg_database WHERE datname = {_pg_literal(db_name)};"
			).stdout.strip()
			== "1"
		)

	def dump(self, db, password, out: Path):
		with self._passfile(db["db_host"], db["db_port"], db["db_user"], password) as pf:
			run(
				[
					"pg_dump",
					"-Fc",
					"-Z",
					"6",
					"--no-owner",
					"--no-privileges",
					"-h",
					db["db_host"],
					"-p",
					db["db_port"],
					"-U",
					db["db_user"],
					"-d",
					db["db_name"],
					"-f",
					str(out),
				],
				user=self.cfg.FRAPPE_USER,
				env={"PGPASSFILE": str(pf)},
			)

	def recreate(self, db, password):
		name, user = db["db_name"], db["db_user"]
		sql = f"""
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = {_pg_literal(name)} AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS {_pg_ident(name)};
DO $$BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {_pg_literal(user)}) THEN
    EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', {_pg_literal(user)}, {_pg_literal(password)});
  ELSE
    EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L', {_pg_literal(user)}, {_pg_literal(password)});
  END IF;
END$$;
CREATE DATABASE {_pg_ident(name)} OWNER {_pg_ident(user)};
GRANT ALL PRIVILEGES ON DATABASE {_pg_ident(name)} TO {_pg_ident(user)};
"""
		self._psql_root(sql)

	def restore(self, db, password, dump: Path):
		with self._passfile(db["db_host"], db["db_port"], db["db_user"], password) as pf:
			run(
				[
					"pg_restore",
					"--no-owner",
					"--no-privileges",
					"--exit-on-error",
					"-j",
					"2",
					"-h",
					db["db_host"],
					"-p",
					db["db_port"],
					"-U",
					db["db_user"],
					"-d",
					db["db_name"],
					str(dump),
				],
				user=self.cfg.FRAPPE_USER,
				env={"PGPASSFILE": str(pf)},
			)

	def drop(self, db):
		self._psql_root(
			f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = {_pg_literal(db['db_name'])};\n"
			f"DROP DATABASE IF EXISTS {_pg_ident(db['db_name'])};\nDROP ROLE IF EXISTS {_pg_ident(db['db_user'])};"
		)


class MariaDB(Engine):
	name = "mariadb"
	dump_suffix = "mariadb.sql.gz"

	def _cnf(self, host, port, user, password):
		content = f"[client]\nuser={user}\npassword={password}\nhost={host}\nport={port}\nprotocol=TCP\n"
		return private_tempfile(content, self.cfg, suffix=".cnf")

	def _root_cnf(self):
		return self._cnf(
			self.cfg.MARIADB_HOST,
			self.cfg.MARIADB_PORT,
			self.cfg.MARIADB_ROOT_USER,
			read_secret_file(self.cfg, "mariadb-root.pw"),
		)

	def _sql_root(self, sql: str):
		with self._root_cnf() as cnf:
			return run(
				["mariadb", f"--defaults-extra-file={cnf}", "-N", "-B"], user=self.cfg.FRAPPE_USER, input=sql
			)

	def root_check(self) -> str:
		return self._sql_root("SELECT VERSION();").stdout.strip()

	def site_check(self, db, password) -> str:
		with self._cnf(db["db_host"], db["db_port"], db["db_user"], password) as cnf:
			return run(
				["mariadb", f"--defaults-extra-file={cnf}", "-N", "-B", db["db_name"], "-e", "select 1"],
				user=self.cfg.FRAPPE_USER,
			).stdout.strip()

	def database_exists(self, db_name) -> bool:
		return bool(self._sql_root(f"SHOW DATABASES LIKE {_my_literal(db_name)};").stdout.strip())

	def dump(self, db, password, out: Path):
		with self._cnf(db["db_host"], db["db_port"], db["db_user"], password) as cnf:
			pipeline = (
				f"set -o pipefail; mariadb-dump --defaults-extra-file={shlex_quote(str(cnf))} --single-transaction --quick "
				f"--skip-lock-tables --no-tablespaces --hex-blob --default-character-set=utf8mb4 "
				f"{shlex_quote(db['db_name'])} | gzip -6 > {shlex_quote(str(out))}"
			)
			run(["bash", "-c", pipeline], user=self.cfg.FRAPPE_USER)

	def recreate(self, db, password):
		name, user, scope = db["db_name"], db["db_user"], self.cfg.MARIADB_USER_HOST_SCOPE
		account = f"{_my_literal(user)}@{_my_literal(scope)}"
		self._sql_root(
			f"DROP DATABASE IF EXISTS {_my_ident(name)};\n"
			f"CREATE DATABASE {_my_ident(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n"
			f"CREATE USER IF NOT EXISTS {account} IDENTIFIED BY {_my_literal(password)};\n"
			f"ALTER USER {account} IDENTIFIED BY {_my_literal(password)};\n"
			f"GRANT ALL PRIVILEGES ON {_my_ident(name)}.* TO {account};\nFLUSH PRIVILEGES;"
		)

	def restore(self, db, password, dump: Path):
		with self._cnf(db["db_host"], db["db_port"], db["db_user"], password) as cnf:
			pipeline = (
				f"set -o pipefail; gunzip -c {shlex_quote(str(dump))} | "
				f"mariadb --defaults-extra-file={shlex_quote(str(cnf))} {shlex_quote(db['db_name'])}"
			)
			run(["bash", "-c", pipeline], user=self.cfg.FRAPPE_USER)

	def drop(self, db):
		scope = self.cfg.MARIADB_USER_HOST_SCOPE
		self._sql_root(
			f"DROP DATABASE IF EXISTS {_my_ident(db['db_name'])};\nDROP USER IF EXISTS {_my_literal(db['db_user'])}@{_my_literal(scope)};"
		)


ENGINES = {"postgres": Postgres, "mariadb": MariaDB}


def engine_for(cfg: Config, db_type: str) -> Engine:
	try:
		return ENGINES[db_type](cfg)
	except KeyError as exc:
		raise DevStateError(
			f"unsupported database type {db_type!r} (supported: {', '.join(ENGINES)})"
		) from exc


def infra_address(cfg: Config, db_type: str) -> tuple[str, int]:
	"""Where this session's server for an engine listens (current-session infrastructure, not snapshot state)."""
	if db_type == "postgres":
		return cfg.PG_HOST, int(cfg.PG_PORT)
	return cfg.MARIADB_HOST, int(cfg.MARIADB_PORT)
