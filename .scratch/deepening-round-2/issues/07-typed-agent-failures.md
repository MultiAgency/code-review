# 07 Typed agent runner failures; wait for a resting token

Status: resolved
Type: task
Blocked by: t3code / SDK comparison

Decision 3.

## Answer

Done. agent.ts reads the SDK's typed signals (rate_limit_event resetsAt, assistant `error`, api_error_status) into `usage_limit` (+ retryAt) / `auth_rejected` / `overloaded`; tested with a scripted `query`. The pool rests a token until its reset and returns `retryAt` when all rest (or `auth_rejected` when all were rejected). A job whose limit resets within 24h of being queued returns `waiting`; the queue reruns it then without using an attempt, and the summary comment says when. `overloaded` is transient.
