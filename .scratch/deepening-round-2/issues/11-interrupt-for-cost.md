# 11 Interrupt instead of abort on timeout, to record the pass's cost

Status: ready-for-human
Type: research
Blocked by: none

A pass that times out or is aborted records ~$0: no result message arrives, so `total_cost_usd` is
never seen. `Query.interrupt()` should make the CLI emit a final result with its cost, but it only
works with streaming input. Before switching: check live that `verbatimPrompts` still stops `@path`
expansion for streamed user messages (the canary from ticket 01), and that the interrupted result
carries `total_cost_usd`. Needs a real token, so a human runs the probe.
