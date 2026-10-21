# 05 Prompts take domain values

Status: resolved
Type: task
Blocked by: 02

Decision 7.

## Answer

Done. `reviewPrompt` takes the plan, instruction files, ChangedFile[], PriorFinding[] and the diff with its inline threshold; `verifyPrompt` takes the findings and numbers them. test/prompts.test.ts pins the exact prompt text (snapshots taken before the move, unchanged after); update with UPDATE_SNAPSHOTS=1 only alongside an eval run.
