# 06 Deploy, then one paid review end to end

Status: ready-for-human
Type: task
Blocked by: 01, 02, 03

1. Secrets: `PURCHASE_TOKEN` here equal to `MULTI_REVIEW_TOKEN` on the gateway; `PURCHASE_ANTHROPIC_API_KEY` (a NEAR
   AI Cloud key) and `GITHUB_TOKEN` (public read only). The three are already in the deploy's secrets file and were
   uploaded on 2026-11-26; they do nothing until 01 is deployed.
2. One review through `PURCHASE_ANTHROPIC_BASE_URL=https://cloud-api.near.ai`: the Claude Code SDK against NEAR AI
   Cloud has not been run, and it gives the cost per review that 02 needs.
3. Set `MULTI_REVIEW_URL` on the gateway to `https://claude-pr-review.multidaomensional.workers.dev`.
4. One order on Base Sepolia (`X402_ENVIRONMENT=development`), then one on mainnet: refused (a private PR), delivered,
   and the sale recorded in `GET /sales`.
