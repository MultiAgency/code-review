# 06 Eval: unjudged cases, judge on the token pool

Status: resolved
Type: task
Blocked by: none

Decisions 8, 9.

## Answer

Done. `SameDefectJudge.match` may answer "unjudged"; `Score.unjudged` is left out of recall and printed; `--resume` re-judges them. The judge runs through `agentRunnerFor` (token rotation) with low-effort overrides.
