# 03 Fit a purchase's attempts inside the payment window

Status: ready-for-agent
Type: decision
Blocked by: none

The gateway collects only if `done` arrives within 60 minutes of the order (`multi-review.ts`, `60 * 60`). A purchase
runs like any review: up to `REVIEW_MAX_ATTEMPTS` (3) attempts of `REVIEW_JOB_TIMEOUT_MIN` (50 minutes). A second
attempt after a long first one finishes too late: the gateway marks it `LATE`, charges nothing and withholds the
result, and the model cost is spent.

Options:
- **A deadline per purchase.** The job keeps its order time; an attempt gets only the time left before the window
  closes, less a margin, and none starts when too little is left. A `PURCHASE_WINDOW_MIN` setting, kept equal to the
  gateway's window.
- **The gateway sends the deadline** with the job (`{ id, input, callback, deadline }`), so the two can't drift. A
  change to both sides.
- **One attempt only** for purchases, with a timeout below the window. Simplest; loses retries of transient failures.

## Comments

2026-11-26, measured: the purchased review of `dashboard#125` took 1 min 46 s from queued to delivered. Normal reviews
fit the window many times over; only an attempt that runs to the 50-minute limit misses it. Recommended now: the
simplest option, a purchase timeout per attempt (e.g. 15 minutes, so 3 attempts fit in 45), rather than a change to the
gateway's contract.

2026-11-26, decided: the gateway sends `deadline` (ISO 8601, its `collectBy`) with each job, since the window is the
gateway's to choose. Gateway side done on branch `deadline-and-wake` in `slop/gateway` (staged, not committed): test
"a backend is handed the moment its job's payment stops being collectable". Left here: read the optional `deadline`
in `PurchaseRequest`; in the queue, start no attempt too close to it, cut each attempt's timeout to the time left, and
end a purchase past it as `failed: timeout` without running it. Supersedes the 15-minute setting above.
