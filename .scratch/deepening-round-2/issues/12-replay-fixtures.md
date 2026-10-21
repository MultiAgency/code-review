# 12 Replay fixtures of real Claude runs

Status: resolved
Type: task
Blocked by: none

test/agent.test.ts covers the SDK result mapping with hand-written message streams. Record a few
real streams once the service runs on a real token (a usage limit, a budget overrun, an error
result followed by a non-zero exit, a prompt_too_long) and replay them through `SdkAgentOptions.query`,
so the mapping is checked against what the CLI really sends (t3code does this with ~40 fixtures).
Redact tokens and session ids before committing them.

## Answer

Done 2026-10-21 with the local Claude login instead of waiting for the deploy. Recorded with CLI 2.1.304 (recorder/record.mts, redacted by recorder/redact.py): success, budget overrun, rejected token, interrupted pass, prompt too long. test/agent-replay.test.ts replays them. The recordings caught a bug: the CLI reports a too-long prompt as `terminal_reason: "blocking_limit"`, not `prompt_too_long`, so it was mapped to `crashed`; both now map to `too_large`. A real 429 can't be recorded on demand, so usage limits stay covered by hand-written streams in test/agent.test.ts.
