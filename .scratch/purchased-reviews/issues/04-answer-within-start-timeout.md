# 04 Answer the gateway within its start timeout

Status: ready-for-agent
Type: bug
Blocked by: none

The gateway waits 8 seconds for `POST /jobs` (`slop/gateway/src/service.ts`, `START_TIMEOUT_MS`), then tells the buyer
`service_unavailable` and records the order refused. On Cloudflare the reviewer's container sleeps after 10 idle
minutes; waking it took 22 seconds once on 2026-11-26 (`/healthz` answered "no container instance" until then), and
admission then makes two GitHub calls.

Two failures follow:
- the first purchase after a quiet spell is refused, and
- if the request still reaches the service, the job is queued and reviewed after the gateway has refused it: model
  cost for a review nobody collects.

Not measured: how often a wake takes longer than 8 seconds. Three probes after 12 idle minutes on 2026-11-26 were
answered in a second, so the slow wake is intermittent.

To decide: raise the gateway's start timeout (it has to stay under the buyer's request timeout), have the gateway wake
the service with `GET /healthz` before taking payment, or have the backend drop a purchase it starts after the
gateway's timeout (it would need the order time from the gateway).

## Comments

2026-11-26, decided, fixed at both causes:
- **Gateway** (done, branch `deadline-and-wake`, staged): before handing off, it asks the backend's `/healthz` every
  250 ms for up to `BACKEND_WAKE_SECONDS` (30), so a wake no longer eats the 8 s for taking the job. Two tests: a
  backend waking after two failed checks gets the job; one that never wakes is refused as unavailable, handed nothing.
- **Here, left:** before running a purchase, `GET` its job at the gateway (the callback URL without `/outcome`); a 404
  means the gateway refused or dropped it, so drop it without spending. And in `deploy/cloudflare/worker.ts`, retry the
  container start in the Durable Object for up to ~30 s instead of answering 503 at the first "no container instance";
  that also serves GitHub's webhooks.
