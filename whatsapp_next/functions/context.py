# Module role: the contract between the command router and a function handler (D-012,
# backend-plan §7.3 step 8). A handler is `Callable[[FunctionContext], FunctionResult]`, runs as
# the command service user, and returns plain data plus optional files; it never sends.

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Sender:
	"""Who sent the command. `party_type` / `party_name` come from the linked Contact's
	Dynamic Link rows (first party of an allowed type)."""

	phone_e164: str | None
	jid: str | None
	display_name: str | None
	contact: str | None
	party_type: str | None = None
	party_name: str | None = None
	is_group: bool = False


@dataclass(frozen=True)
class FunctionContext:
	function_key: str
	command: str | None
	args: dict[str, Any]
	settings: dict[str, Any]
	sender: Sender
	device: str | None
	inbound: str | None
	dry_run: bool = False


@dataclass
class FunctionResult:
	"""`data` feeds output templates (`{{ data.x }}`); `files` are `(file_name, bytes, mime)`
	the router attaches as Document outputs; `error` marks a handled failure to report."""

	data: dict[str, Any] = field(default_factory=dict)
	files: list[tuple[str, bytes, str]] = field(default_factory=list)
	error: str | None = None

	@property
	def ok(self) -> bool:
		return self.error is None
