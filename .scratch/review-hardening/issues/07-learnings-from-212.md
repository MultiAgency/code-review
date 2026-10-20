# 07 Improvements from the near-agencies#212 comparison

Status: claimed
Type: task

Compared against the repo's `ai-review` and Private Investigator on #212, ours found the one bug both
missed (house agent reassigned every sweep) but missed F11, F9, F5 and the unguarded cross-repo writes.
Root causes: CLAUDE.md's `@AGENTS.md` import never followed; REVIEW.md's passes/severities didn't fit our
schema and "defects only" rule; one pass with a strong certainty bias.

Built test-first (tdd skill), seams agreed with the user:
1. `Workspace.instructions()` follows `@imports` from the base (no symlinks, no escapes, depth 4, size caps).
2. `reviewChanges()` runs one focused pass per REVIEW.md pass in parallel, merges across passes, verifies once; repo severity labels; repo rules replace the built-in "defects only" rule.
3. `reviewChanges()` tells every pass to trace callers and run frequency; returns `checked`.
4. `buildReport()` shows pass and label, and a "Checked:" line.
5. `src/eval.ts` (`ledgerCases`, `score`) + `src/backtest.ts` runner.
