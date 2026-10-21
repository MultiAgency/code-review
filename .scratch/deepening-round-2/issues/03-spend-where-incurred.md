# 03 Record spend where it is incurred; reuse a finished review on publish retry

Status: resolved
Type: task
Blocked by: none

Decisions 1, 2.

## Answer

Done. The queue hands each job a `JobRun` (signal, recordSpend, saved, save). `runReviewJob` meters its agent runner, so every pass is recorded as it finishes; outcome `costUsd` is for logs. A finished review is saved with the job and reused on retry while head, diff base and mode match.
