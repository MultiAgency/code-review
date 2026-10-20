# 09 Deepen the review module

Status: needs-triage
Type: task
Blocked by: eval decision on one pass vs three

`src/review.ts` (~400 lines) parses REVIEW.md, builds prompts, runs passes, merges, verifies and places
findings. Run the improve-codebase-architecture skill on it once the eval settles the default pass
strategy, so the shape follows what the eval showed (e.g. pass strategy behind one seam, REVIEW.md
plan parsing as its own module, placement next to the diff).
