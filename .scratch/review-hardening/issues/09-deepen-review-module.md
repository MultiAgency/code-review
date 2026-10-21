# 09 Deepen the review module

Status: resolved
Type: task
Blocked by: eval decision on one pass vs three

`src/review.ts` (~400 lines) parses REVIEW.md, builds prompts, runs passes, merges, verifies and places
findings. Run the improve-codebase-architecture skill on it once the eval settles the default pass
strategy, so the shape follows what the eval showed (e.g. pass strategy behind one seam, REVIEW.md
plan parsing as its own module, placement next to the diff).

## Answer

Done 2026-10-21. `reviewChanges` keeps its interface; its concerns moved to internal modules:
`review-plan.ts` (REVIEW.md passes/severities, which runs to make), `placement.ts` (where a finding
is shown), `prompts.ts` builders (`reviewPrompt`, `verifyPrompt`), and named helpers in review.ts
(`mergeRuns`, `applyVerdicts`). Instructions are read from git once per review instead of twice.
Tests untouched (90 pass); prompts compared byte-for-byte before/after on 5 prompts: identical.
