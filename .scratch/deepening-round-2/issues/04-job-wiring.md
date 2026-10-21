# 04 One job-wiring module for main and smoke

Status: resolved
Type: task
Blocked by: 03

Decisions 4, 5.

## Answer

Done. `review-work.ts`: `reviewWork(config, { log, publish?, agent?, github? })` returns the queue's Work. main and smoke use it; `loadConfigOrExit` gives every entry point the same config-error handling. `openWorkspace` left JobDeps; `timeoutMs` is required (no second default). Tests: publisher choice, App vs PAT own-comment trust.
