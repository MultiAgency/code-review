# 12 Replay fixtures of real Claude runs

Status: ready-for-human
Type: task
Blocked by: first deploy

test/agent.test.ts covers the SDK result mapping with hand-written message streams. Record a few
real streams once the service runs on a real token (a usage limit, a budget overrun, an error
result followed by a non-zero exit, a prompt_too_long) and replay them through `SdkAgentOptions.query`,
so the mapping is checked against what the CLI really sends (t3code does this with ~40 fixtures).
Redact tokens and session ids before committing them.
