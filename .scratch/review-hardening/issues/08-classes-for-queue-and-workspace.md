# 08 Queue and workspace as classes (ADR 0001)

Status: needs-triage
Type: task
Blocked by: none (09 done)

- Split the review queue into a `JobStore` (SQLite: jobs, spend) and a `ReviewQueue` class (scheduler: concurrency, newest-wins, retries, daily cap, close). Same `ReviewQueue` interface.
- `Workspace` as a class implementing `Symbol.asyncDispose`; `openPullRequestWorkspace` / `openLocalWorkspace` stay as the constructors' front doors; callers move to `await using`.
- Existing queue and workspace tests must pass unchanged (they test the interfaces); a test that has to change means the refactor changed behaviour.
