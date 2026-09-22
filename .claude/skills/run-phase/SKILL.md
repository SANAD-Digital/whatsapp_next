---
name: run-phase
description: Run one phase (0-10) of the whatsapp_next build plan. Usage /run-phase <number>.
disable-model-invocation: true
---

Run phase **$ARGUMENTS** of the whatsapp_next build.

1. Read `.claude/skills/run-phase/phases/phase-$ARGUMENTS.md` and execute it exactly.
   If that file does not exist, list the available phases and stop.
2. Before starting, read `plan/decisions.md` and, if it exists, `plan/10-build-order.md`.
   Do not start a phase whose prerequisites in the build order are unchecked — say so and stop.
3. Every phase ends with the same closing steps:
   - tick completed items in `plan/10-build-order.md` (once it exists);
   - record any decision in `plan/decisions.md` and any new risk in `plan/risks.md`;
   - commit in each app repository you changed, on this phase's branch;
   - report to the human **in Arabic**: what was done, what was decided, what is open;
   - recommend `/clear` before the next phase.
