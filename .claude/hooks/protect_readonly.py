#!/usr/bin/env python3
"""PreToolUse hook: block file-tool writes to read-only areas.

Protected:
  ../snd_whatsapp/          legacy app — reference only. Paths are relative to this
                            app (apps/whatsapp_next); sibling apps live one level up.
                            ../snd_whatsapp_platform/ is NOT protected.
  docs/                     the prototype — input only
  plan/00-screens-spec.md   binding spec — the product owner edits it by hand

Exit code 2 blocks the tool call and shows stderr to Claude.
Adjust PROTECTED_DIRS if your bench layout differs.
"""
import json
import os
import sys

PROTECTED_DIRS = ("../snd_whatsapp", "docs")
PROTECTED_FILES = ("plan/00-screens-spec.md",)


def resolve(root, path):
    if not os.path.isabs(path):
        path = os.path.join(root, path)
    return os.path.realpath(path)


def main():
    data = json.load(sys.stdin)
    tool_input = data.get("tool_input") or {}
    path = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
    if not path:
        return 0
    root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    target = resolve(root, path)

    for d in PROTECTED_DIRS:
        if target.startswith(resolve(root, d) + os.sep):
            print(f"Blocked: '{path}' is inside read-only '{d}/'. "
                  "See CLAUDE.md, rules that never bend.", file=sys.stderr)
            return 2
    for f in PROTECTED_FILES:
        if target == resolve(root, f):
            print(f"Blocked: '{path}' is the binding screen spec. Only the product owner "
                  "edits it. Raise a question at the next gate instead.", file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
