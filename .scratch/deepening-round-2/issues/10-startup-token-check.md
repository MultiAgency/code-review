# 10 Check Claude tokens at startup

Status: wontfix
Type: research
Blocked by: none

## Answer

Tried 2026-10-21. The SDK's free probe (streaming input that never yields, then `accountInfo()`)
never calls the API: a made-up `CLAUDE_CODE_OAUTH_TOKEN` comes back as
`{"tokenSource":"CLAUDE_CODE_OAUTH_TOKEN","apiProvider":"firstParty"}`, the same as a real one, so it
can't tell a revoked token from a good one. A real call would spend usage on every deploy. The pool
already benches a rejected token on its first use, and a 401 costs $0, so there's nothing to gain.
