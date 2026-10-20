# 05 Review queue

Status: resolved
Type: task
Blocked by: 04

Persisted review jobs in node:sqlite: delivery-id dedupe, newest-wins per PR, bounded concurrency, retries with backoff for transient failures, resume after restart, 50-min job timeout, 2-min call timeouts, drain on SIGTERM. Server becomes the HTTP adapter with no import-time side effects. Re-review scope (incremental / full) resolved here.

## Answer

Done 2026-10-20. `src/queue.ts`: review jobs in `node:sqlite` (delivery-id dedupe, newest-wins per PR with no overlap while a superseded job unwinds, bounded concurrency, retries with backoff for transient failures, resume of interrupted jobs, 7-day retention, close with grace). `src/job.ts` gained a whole-job timeout reported as `timeout`. `src/server.ts` is now only the HTTP adapter (`webhookHandler`); `src/main.ts` wires everything; Dockerfile runs `dist/main.js` with `/data` owned by `node`. Re-review scope was done in 04. Tests: queue (7), server (3); 61 total. Smoke test: dedupe, health stats, SIGTERM re-queues the running job.
