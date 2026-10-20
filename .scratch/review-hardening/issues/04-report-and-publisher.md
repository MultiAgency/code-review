# 04 Review report + publisher

Status: resolved
Type: task
Blocked by: 03

Pure review report: fingerprints, placement by existing_code, inline cap 10, suggestion blocks, fence neutralising, redaction, size limits. Publisher: GitHub adapter (summary comment edited in place with markers, inline comments for new fingerprints only, file-level fallback, reactions, failure reasons, fresh token, retries, head pinning) and log adapter. Prior open findings fed back to the review pass.

## Answer

Done 2026-10-20. `src/report.ts` (pure): fingerprints, hidden state in the summary (capped at 20k chars), inline cap, multi-line placement, one-click suggestions only for exact matches, neutralised suggestion fences and HTML-comment markers in model text, redaction, 60k size fit, failure summaries. `src/publisher.ts`: GitHub adapter (summary edited in place; only our own comments trusted as state — a forged marker comment is ignored; inline review pinned to the reviewed head only while the PR still contains it; 422 folds into the summary; file-level comments; 👀/🎉/😕) and a log adapter. `src/github.ts`: client with per-call token, timeout, retries (network, 5xx, rate limit + Retry-After), pagination. `src/job.ts`: one review end to end, incremental vs full, typed failure reasons with transient flag. Review findings now carry `existing_code` / `fix_code` and a `placement`. 51 unit tests; live CLI run placed both findings exactly.
