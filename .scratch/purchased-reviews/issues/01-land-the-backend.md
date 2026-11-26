# 01 Land the purchase backend

Status: resolved
Type: task
Blocked by: none

The work is uncommitted on `x402-purchased-reviews`: 23 changed files and `src/purchase.ts`, `test/purchase.test.ts`.
It typechecks and its 164 tests pass on `main` at `61246ec`. Purchased reviews stay off until the three `PURCHASE_*`
settings are set, so merging changes nothing live.

Done when it is on `main` through a reviewed pull request, and the deploy that follows still reviews the organization's
pull requests as before.

## Comments

2026-11-26: landed in `code-review#11` (merge on `main`), with the fixes for 02 to 04, and deployed (`c75998e6`). The
organization's own reviews were last checked live on the version before it (`dashboard#126`); not yet on this one.
