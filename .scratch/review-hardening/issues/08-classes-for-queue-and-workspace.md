# 08 Queue and workspace as classes (ADR 0001)

Status: resolved
Type: task
Blocked by: none (09 done)

- Split the review queue into a `JobStore` (SQLite: jobs, spend) and a `ReviewQueue` class (scheduler: concurrency, newest-wins, retries, daily cap, close). Same `ReviewQueue` interface.
- `Workspace` as a class implementing `Symbol.asyncDispose`; `openPullRequestWorkspace` / `openLocalWorkspace` stay as the constructors' front doors; callers move to `await using`.
- Existing queue and workspace tests must pass unchanged (they test the interfaces); a test that has to change means the refactor changed behaviour.

## Answer

Done 2026-10-21. `queue.ts`: a `JobStore` class (all SQLite: jobs, statuses, retries, spend) and a
`ReviewQueue` class (scheduler state and lifecycle); `openReviewQueue` unchanged for callers.
`workspace.ts`: `GitWorkspace` class implementing `Symbol.asyncDispose` (idempotent dispose); the
job and CLI use `await using`; backtest keeps an explicit, serialised dispose for parallel
worktrees. tsconfig adds `esnext.disposable`. Existing tests unchanged (90) plus one new interface
test that `await using` cleans up when the body throws.
