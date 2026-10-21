# Deepening round 2

Architecture review of af1e098 (2026-10-21). Six candidates; all recommended answers accepted.

## Decisions

1. Every Claude run's cost counts toward `DAILY_BUDGET_USD` the moment it finishes, however the job ends.
2. When a review finished but publishing failed, the retry reuses the stored result if the PR head
   hasn't moved; otherwise it reviews again.
3. When every Claude token is resting, the review job waits (re-queued until the earliest token is
   free) for up to 24h instead of failing; then it fails with the usage-limit message.
4. One wiring module turns Config into what a review job needs (GitHub access, own-comment check,
   publisher choice, review options, timeout) for `main` and `smoke`. `cli` and `backtest` share
   only the agent runner and review options.
5. `openWorkspace` leaves `JobDeps`: one adapter, a hypothetical seam.
6. The review report takes the trigger phrase, and renders plain text for the CLI and the log
   publisher (no hidden markers).
7. Prompt formatting moves into `prompts.ts`, which takes domain values; prompts stay byte-for-byte
   identical, checked against snapshots taken before the move.
8. A failed judge call makes an eval case "unjudged": excluded from recall, counted, re-judged on
   `--resume`.
9. Only the two eval bugs now (8, and the judge using the token pool); the eval runner refactor is a
   ticket.
10. Same-fingerprint findings from one run merge into one, using the report's fingerprint function.
