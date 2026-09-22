#!/usr/bin/env python3
"""PreToolUse hook for analyst/planner subagents: allow Write only under plan/.

This turns "read-only except your one output file" from an instruction into a guarantee.
The binding spec stays protected by protect_readonly.py, which also runs for subagents.
"""
import json
import os
import sys


def main():
    data = json.load(sys.stdin)
    path = (data.get("tool_input") or {}).get("file_path") or ""
    root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    target = os.path.realpath(path if os.path.isabs(path) else os.path.join(root, path))
    plan_dir = os.path.realpath(os.path.join(root, "plan")) + os.sep
    if not target.startswith(plan_dir):
        print(f"Blocked: this agent may write only under plan/. Refused: '{path}'.",
              file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
