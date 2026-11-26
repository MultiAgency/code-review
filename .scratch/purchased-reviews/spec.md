# Purchased reviews

Review of the uncommitted `x402-purchased-reviews` work against `~/agencies/multi/market-access-points.md` and the
gateway at `~/agencies/multi/slop/gateway` (`0fe4c3b`), 2026-11-26. Read only; no code changed.

## What exists

**This repository** (uncommitted on `x402-purchased-reviews`, synced with `main` at `61246ec`; typecheck clean, 164
tests pass):

- `POST /jobs` with the gateway's bearer token (`server.ts`). It validates `{ id, input: { repo, pr }, callback }`,
  refuses a callback outside `PURCHASE_GATEWAY`, admits or refuses (`422 { error, message }`), and answers `202` once
  queued. The same purchase id again is a duplicate, still `202`.
- Admission (`purchase.ts`): the PR must exist, be public, be open, change at most `PURCHASE_MAX_CHANGED_LINES`, and
  change a file a review reads. It uses `GITHUB_TOKEN`.
- The review (`review-work.ts`): always full, billed to `PURCHASE_ANTHROPIC_API_KEY` (optionally through
  `PURCHASE_ANTHROPIC_BASE_URL`, e.g. NEAR AI Cloud), capped at `PURCHASE_BUDGET_USD`. Nothing is written to GitHub.
- The outcome goes to the callback: `{ status: "done", result }` from `renderData`, or one
  `{ status: "failed", reason, message }` once no attempt is left. A failed callback fails the publish, and the retry
  re-sends the saved result without running the review again.
- A purchased job is its buyer's own in the queue: keyed by purchase id, never replacing or replaced by another review.
- The Worker forwards `POST /jobs`; `cloudflare.config.ts` declares the purchase bindings.
- Documented in `docs/technical.md` (settings table and "Purchased reviews") and `GLOSSARY.md`.

**The gateway** (`slop/gateway`, committed): Multi Review is a job service at `/multi-review`, price
`MULTI_REVIEW_PRICE = $1.00`, payment window 60 minutes, collected only when the outcome is `done` inside the window.
It hands off with an 8-second timeout; `422` reaches the buyer uncharged, anything else is `service_unavailable`
(`503`). `MULTI_REVIEW_URL` is empty, so Multi Review is not listed or served.

**The contract matches.** The gateway's `Outcome` schema (`jobs.ts`) accepts exactly what `purchase.ts` sends, the
callback's bearer token is the job's, and the backend only delivers under the gateway's own origin.

## Findings

1. **The budget is above the price.** `PURCHASE_BUDGET_USD` defaults to `1.5`; the gateway sells at `$1.00`, capped
   there because x402 buyer clients refuse more by default (`wrangler.jsonc`). A review that uses its budget loses
   money. The design doc's "$2.00 against $1.50" is out of date. → 02
2. **Retries can't finish inside the payment window.** A purchase may take `REVIEW_MAX_ATTEMPTS` (3) attempts of
   `REVIEW_JOB_TIMEOUT_MIN` (50 minutes). The gateway collects only within 60 minutes of the order, so any second
   attempt that runs long is delivered `LATE`: uncharged, and its model cost spent. → 03
3. **A cold container can't answer within the gateway's 8 seconds.** Waking from idle took 22 seconds once today, and
   admission then makes two GitHub calls. The gateway then tells the buyer `service_unavailable`, but the backend may
   still queue the job when the request lands: a review is run that the gateway has already refused and will never
   collect. → 04
4. **A restart or redeploy loses running purchases.** The queue is on the container's ephemeral disk. The gateway
   records them as `timeout`, uncharged; the model cost is spent and the buyer gets nothing. → 05
5. **Not yet run end to end:** the reviewer on NEAR AI Cloud through `PURCHASE_ANTHROPIC_BASE_URL` (the Claude Code
   SDK against that endpoint), a real paid order through the gateway, and the matching secrets
   (`MULTI_REVIEW_TOKEN` on the gateway equal to `PURCHASE_TOKEN` here). → 06
6. **Purchases share the reviewer's daily budget and concurrency** with the organization's own reviews: a busy day of
   purchases can stop the team's reviews, and the reverse. Not decided whether that is wanted. → 07

## Status, 2026-11-26

01 to 04 done and merged (`code-review#11`, `x402-gateway#1`); 05 and 07 accepted as they are; 06 live on both sides
and proven on mainnet, the first order settled on Base. Nothing left open.

## Order

01, then 02 to 05 (02 and 03 need a decision first), then 06. 07 can be decided any time.
