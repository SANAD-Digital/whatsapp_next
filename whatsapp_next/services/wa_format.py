# Module role: WhatsApp text formatting repair. WhatsApp only draws *bold*, _italic_ and ~strike~
# when the marker touches the text; `* Grant Plastics*` or `*total *` arrive as literal asterisks.
# Templates written by hand (and values rendered into `* {{ doc.name }}*`) get this wrong easily,
# so every rendered or outbound text passes through `tidy_markers`, which moves a marker onto its
# text when one side of the pair already touches it. A pair spaced on both sides is left alone —
# that is arithmetic (`2 * 3 * 4`), not formatting.

from __future__ import annotations

import re

_PAIR = re.compile(
	r"(?P<pre>^|[\s(\[{«\"'])"  # a marker opens at a line start or after a space / bracket
	r"(?P<m>[*_~])"
	r"(?P<lead>[ \t]*)"
	r"(?P<body>[^\s*_~](?:[^\n]*?[^\s])?)"  # one line of text, not starting with a marker
	r"(?P<trail>[ \t]*)"
	r"(?P=m)"
	r"(?=$|[\s.,:;!?)\]}»\"'،؛؟])",  # and closes before a space, punctuation or the line end
	re.MULTILINE,
)


def _tidy(match: re.Match) -> str:
	lead, trail = match["lead"], match["trail"]
	if bool(lead) == bool(trail):
		return match.group(0)  # already touching, or spaced on both sides (not formatting)
	return f"{match['pre']}{match['m']}{match['body']}{match['m']}"


def tidy_markers(text: str | None) -> str | None:
	"""`* text*` / `*text *` → `*text*` (and the same for `_` and `~`); everything else unchanged.
	Code spans (```…```) are left as written."""
	if not text or not any(m in text for m in "*_~"):
		return text
	parts = re.split(r"(```.*?```)", text, flags=re.DOTALL)
	return "".join(p if p.startswith("```") else _PAIR.sub(_tidy, p) for p in parts)
