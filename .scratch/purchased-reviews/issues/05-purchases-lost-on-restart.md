# 05 Purchases lost on a restart or redeploy

Status: wontfix
Type: decision
Blocked by: none

On Cloudflare the queue (`QUEUE_DB`) is on the container's ephemeral disk (`deploy/cloudflare/README.md`). A redeploy,
or the container stopping, loses queued and running purchases. The gateway then records each as `timeout` at its
deadline and charges nothing, so the buyer is never charged wrongly; but they get nothing, and any model cost already
spent is lost.

For the organization's own reviews this is accepted: someone asks again with the trigger phrase. A buyer can't.

Decide whether that is acceptable for purchases, given that deploys are rare and checked for an idle queue first
(`/healthz` shows `running` and `queued`), or whether the Durable Object should keep purchases and re-submit them after
a restart.

## Comments

2026-11-26, decided: accepted for now. Deploy only when `/healthz` shows nothing running or queued.
