# 11 Interrupt instead of abort on timeout, to record the pass's cost

Status: resolved
Type: research
Blocked by: none

A pass that times out or is aborted records ~$0: no result message arrives, so `total_cost_usd` is
never seen. `Query.interrupt()` should make the CLI emit a final result with its cost, but it only
works with streaming input. Before switching: check live that `verbatimPrompts` still stops `@path`
expansion for streamed user messages (the canary from ticket 01), and that the interrupted result
carries `total_cost_usd`. Needs a real token, so a human runs the probe.

## Answer

Done 2026-10-21, after a live probe (scratchpad interrupt-probe.mts):

- `@path` with a streamed prompt: not expanded with `verbatimPrompts` (no leak); expanded without it (controls with a string prompt and with a streamed one both leaked), so the canary detects expansion.
- `interrupt()` on a streamed pass: the CLI ends with `error_during_execution` / `terminal_reason: aborted_streaming` and a `total_cost_usd` covering completed API calls (the in-flight response is not counted). Killing the process (the old behaviour) gives no result at all.

The runner now streams the prompt as one user message, interrupts on timeout/abort, and kills the process only if Claude has not stopped after `interruptGraceMs` (10s). `npm run test:live` passes and a real CLI review works in this mode.
