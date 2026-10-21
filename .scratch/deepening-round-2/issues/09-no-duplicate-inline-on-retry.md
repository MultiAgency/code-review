# 09 Don't repost inline comments when a publish is retried

Status: resolved
Type: task
Blocked by: none

Found during 03 (pre-existing). The GitHub publisher posts the inline review, then the summary comment.
If the summary write fails, the job retries (now with the saved review) and posts the same inline
comments again, because the summary state that records `commented` was never written. Options: save
the posted fingerprints with the job (`JobRun.save`) and pass them to the next publish, or write the
summary first and patch it after the inline review.

## Answer

Done. The publisher reports each batch of commented findings (`onPosted`); the job keeps their fingerprints with the saved review, and a retry passes them to `buildReport` as `alreadyPosted`, so they are neither posted again nor listed as uncommented.
