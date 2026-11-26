# 01 Land the purchase backend

Status: ready-for-human
Type: task
Blocked by: none

The work is uncommitted on `x402-purchased-reviews`: 23 changed files and `src/purchase.ts`, `test/purchase.test.ts`.
It typechecks and its 164 tests pass on `main` at `61246ec`. Purchased reviews stay off until the three `PURCHASE_*`
settings are set, so merging changes nothing live.

Done when it is on `main` through a reviewed pull request, and the deploy that follows still reviews the organization's
pull requests as before.
