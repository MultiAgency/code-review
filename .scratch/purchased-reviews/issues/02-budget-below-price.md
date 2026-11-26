# 02 Keep a purchased review's budget below its price

Status: ready-for-agent
Type: decision
Blocked by: none

`PURCHASE_BUDGET_USD` defaults to `1.5`. The gateway sells Multi Review at `$1.00` (`slop/gateway/wrangler.jsonc`,
`MULTI_REVIEW_PRICE`), the most an x402 buyer client pays without its owner raising a limit. A review that spends its
budget loses up to $0.50 before the market's and NEAR AI Cloud's costs.

Decide one:
- set `PURCHASE_BUDGET_USD` below the price, with a margin for costs (and lower the default, so an unset value is
  safe), or
- raise the price, accepting that buyers' clients refuse it until their owners allow more.

## Comments

2026-11-26, measured: one purchased review of `MultiAgency/dashboard#125` (+226 / −22 lines, 12 files) through NEAR AI
Cloud cost **$0.69** (`costUsd` 0.6945) and found 1 verified finding. That is 69% of the price before fees, at a
twentieth of the 4,000-line limit; cost grows with the change, so larger pull requests lose money.

A review that reaches its budget fails: the cost up to the cap is spent and nothing is collected. So the cap bounds the
loss, it doesn't prevent it. The lever is admission: refuse pull requests too large to review within the price, and
keep the budget just under it. Next measurement: a pull request near the line limit (`dashboard#101`, +3,080 / −635),
to see where cost crosses $1.00.

2026-11-26, second measurement: `dashboard#101` (3,715 changed lines, 25 files, none skipped, 9 areas checked) cost
**$0.71** in 2 min 16 s, 1 verified finding. Cost barely moved with a 15-fold larger change: the review spends about
the same effort either way. So the line limit is not what puts a sale at risk; an outlier review is. Recommended:
`PURCHASE_BUDGET_USD=0.95` (and that default), keeping 4,000 lines, and the cost of every sale watched in the logs
(`costUsd`) until there are enough to see the spread. Two samples are not a distribution.

2026-11-26, decided: `PURCHASE_BUDGET_USD` default 0.95; 4,000-line limit kept.
