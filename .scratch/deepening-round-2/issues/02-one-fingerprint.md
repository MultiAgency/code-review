# 02 One fingerprint definition; merge same-fingerprint findings

Status: resolved
Type: task
Blocked by: none

Decision 10.

## Answer

Done. `fingerprint` lives in review.ts; mergeRuns dedupes on it within and across runs, keeping the most severe report.
