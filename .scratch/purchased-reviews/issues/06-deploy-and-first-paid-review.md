# 06 Deploy, then one paid review end to end

Status: ready-for-human
Type: task
Blocked by: none

1. Secrets: `PURCHASE_TOKEN` here equal to `MULTI_REVIEW_TOKEN` on the gateway; `PURCHASE_ANTHROPIC_API_KEY` (a NEAR
   AI Cloud key) and `GITHUB_TOKEN` (public read only). The three are already in the deploy's secrets file and were
   uploaded on 2026-11-26; they do nothing until 01 is deployed.
2. One review through `PURCHASE_ANTHROPIC_BASE_URL=https://cloud-api.near.ai`: the Claude Code SDK against NEAR AI
   Cloud has not been run, and it gives the cost per review that 02 needs.
3. Set `MULTI_REVIEW_URL` on the gateway to `https://claude-pr-review.multidaomensional.workers.dev`.
4. One order on Base Sepolia (`X402_ENVIRONMENT=development`), then one on mainnet: refused (a private PR), delivered,
   and the sale recorded in `GET /sales`.

## Comments

2026-11-26, done except the last step:
- Base Sepolia, end to end (`slop/gateway/scripts/testnet-run.mjs`, local gateway and reviewer): a closed pull request
  refused with 422 and nothing charged; a paid order on `dashboard#103` started one job, the same payment sent again
  answered with that job, it ended `done` and was charged 1,000,000 units once
  (`0x06a3e60754d74cfc1fb4b42ecde349d3280d631a3e64b831b5e33b212d19e602`); the sales record showed 1 delivered and
  2 refused. Review cost on NEAR AI Cloud: $0.23 (three local reviews so far: $0.23, $0.69, $0.71).
- Live: the reviewer deployed with purchases on (version `c75998e6`; `POST /jobs` answers 401 without the token and
  400 to the gateway's token with an empty body). The gateway has `MULTI_REVIEW_TOKEN` and lists Multi Review at
  $1.00 on Base mainnet (version `efc4b425`, `MULTI_REVIEW_URL` set in `94b65eb`); `/healthz` reports all three
  backends healthy.
- Left: one real order on mainnet, through Coinbase's facilitator. It needs a buyer wallet with USDC on Base;
  `testnet-run.mjs` refuses mainnet by design. That first settled call is also what lists the route on agentic.market.

