# 08 Move eval-case running into the eval module

Status: resolved
Type: task
Blocked by: none

Deferred (decision 9): backtest.ts keeps only flag parsing; ledger source and clone as adapters;
tests for resume and totals; drop the second worker pool.

## Answer

Done. `eval-run.ts`: `runEval` (clone, gather cases by round, merge-base workspaces, review, score, resume with re-judging) behind a `LedgerSource` port, and `evalTotals`. backtest.ts keeps flags, the gh adapter and printing. `mapLimited` is shared (map-limited.ts). Tested with real git repos, a scripted agent and a fake ledger. The clone now goes through the env-policy git helper, so backtest passes the gh login's token (checked against the private near-agencies repo).
