import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JobOutcome } from "../src/job.ts";
import { openReviewQueue, type Work } from "../src/queue.ts";
import type { ReviewJob } from "../src/triggers.ts";

const job = (pr: number, over: Partial<ReviewJob> = {}): ReviewJob => ({
  repo: "o/r",
  prNumber: pr,
  reason: "opened",
  ...over,
});
const done: JobOutcome = { kind: "done", costUsd: 0 };
const fast = { concurrency: 2, maxAttempts: 3, backoffMs: () => 5, pollMs: 5 };

/** Work that records calls and finishes when told to. */
function controlled() {
  const calls: Array<{
    job: ReviewJob;
    signal: AbortSignal;
    finish: (o?: JobOutcome) => void;
  }> = [];
  let active = 0;
  let peak = 0;
  const work: Work = (j, { signal }) =>
    new Promise((resolve, reject) => {
      active++;
      peak = Math.max(peak, active);
      const finish = (o: JobOutcome = done) => {
        active--;
        resolve(o);
      };
      signal.addEventListener("abort", () => {
        active--;
        reject(signal.reason);
      });
      calls.push({ job: j, signal, finish });
    });
  return { work, calls, peak: () => peak };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("runs jobs with bounded concurrency", async () => {
  const w = controlled();
  const q = openReviewQueue(w.work, { ...fast, dbPath: ":memory:" });
  for (let pr = 1; pr <= 5; pr++) q.submit(job(pr), `d${pr}`);
  await settle();
  assert.equal(w.calls.length, 2);
  for (let round = 0; round < 3; round++) {
    w.calls.splice(0).forEach((c) => c.finish());
    await settle();
  }
  await q.whenIdle();
  assert.equal(w.peak(), 2);
  await q.close(0);
});

test("a redelivered webhook is ignored", async () => {
  const w = controlled();
  const q = openReviewQueue(w.work, { ...fast, dbPath: ":memory:" });
  assert.equal(q.submit(job(1), "same"), "queued");
  assert.equal(q.submit(job(1), "same"), "duplicate");
  await settle();
  assert.equal(w.calls.length, 1);
  w.calls[0]!.finish();
  await q.whenIdle();
  await q.close(0);
});

test("a newer request for the same PR supersedes the running one, which can't overlap it", async () => {
  const w = controlled();
  const q = openReviewQueue(w.work, { ...fast, dbPath: ":memory:" });
  q.submit(job(1), "a");
  await settle();
  q.submit(job(1, { reason: "comment", commentId: 9 }), "b");
  await settle();
  assert.equal(w.calls[0]!.signal.aborted, true);
  assert.equal(w.calls.length, 2);
  assert.equal(w.calls[1]!.job.commentId, 9);
  w.calls[1]!.finish();
  await q.whenIdle();
  await q.close(0);
});

test("transient failures retry with backoff; others don't", async () => {
  const outcomes: JobOutcome[] = [
    { kind: "failed", reason: "github", transient: true, error: "502" },
    { kind: "failed", reason: "github", transient: true, error: "502" },
    done,
    { kind: "failed", reason: "usage_limit", transient: false, error: "429" },
  ];
  const seen: number[] = [];
  const q = openReviewQueue(
    async (j) => (seen.push(j.prNumber), outcomes.shift()!),
    { ...fast, dbPath: ":memory:" },
  );
  q.submit(job(1), "a");
  await q.whenIdle();
  assert.deepEqual(seen, [1, 1, 1]);
  q.submit(job(2), "b");
  await q.whenIdle();
  assert.deepEqual(seen, [1, 1, 1, 2]);
  await q.close(0);
});

test("gives up after maxAttempts", async () => {
  let n = 0;
  const q = openReviewQueue(
    async () => (
      n++,
      { kind: "failed", reason: "git", transient: true, error: "x" }
    ),
    {
      ...fast,
      dbPath: ":memory:",
    },
  );
  q.submit(job(1), "a");
  await q.whenIdle();
  assert.equal(n, 3);
  await q.close(0);
});

test("jobs interrupted by shutdown resume on the next start", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "queue-")), "jobs.db");
  const w1 = controlled();
  const q1 = openReviewQueue(w1.work, { ...fast, dbPath });
  q1.submit(job(1), "a");
  q1.submit(job(2), "b");
  q1.submit(job(3), "c");
  await settle();
  w1.calls[0]!.finish();
  await settle();
  await q1.close(10);

  const w2 = controlled();
  const q2 = openReviewQueue(w2.work, { ...fast, dbPath });
  await settle();
  assert.deepEqual(w2.calls.map((c) => c.job.prNumber).sort(), [2, 3]);
  w2.calls.forEach((c) => c.finish());
  await q2.whenIdle();
  await q2.close(0);
});

test("close waits for running jobs within the grace period", async () => {
  const w = controlled();
  const q = openReviewQueue(w.work, { ...fast, dbPath: ":memory:" });
  q.submit(job(1), "a");
  await settle();
  setTimeout(() => w.calls[0]!.finish(), 20);
  await q.close(1000);
  assert.equal(w.calls[0]!.signal.aborted, false);
});

test("a daily spend cap holds further jobs until the next UTC day", async () => {
  let clock = Date.parse("2026-10-21T10:00:00Z");
  const seen: number[] = [];
  const q = openReviewQueue(
    async (j, run) => {
      seen.push(j.prNumber);
      run.recordSpend(5);
      return done;
    },
    {
      ...fast,
      concurrency: 1,
      dbPath: ":memory:",
      dailyBudgetUsd: 8,
      now: () => clock,
    },
  );
  q.submit(job(1), "a");
  q.submit(job(2), "b");
  q.submit(job(3), "c");
  await settle();
  await settle();
  // $5 then $10 spent: the cap stops the third job, which stays queued.
  assert.deepEqual(seen, [1, 2]);
  assert.equal(q.stats().queued, 1);
  clock = Date.parse("2026-10-22T00:00:01Z");
  await q.whenIdle();
  assert.deepEqual(seen, [1, 2, 3]);
  await q.close(0);
});

test("failed jobs count toward the daily cap too", async () => {
  const seen: number[] = [];
  const q = openReviewQueue(
    async (j, run) => {
      seen.push(j.prNumber);
      run.recordSpend(9);
      return { kind: "failed", reason: "budget", transient: false, error: "x" };
    },
    { ...fast, dbPath: ":memory:", dailyBudgetUsd: 8, concurrency: 1 },
  );
  q.submit(job(1), "a");
  q.submit(job(2), "b");
  await settle();
  await settle();
  assert.deepEqual(seen, [1]);
  await q.close(0);
});

test("spend recorded by a job that is then superseded still counts", async () => {
  const seen: number[] = [];
  const q = openReviewQueue(
    (j, run) =>
      new Promise((_, reject) => {
        seen.push(j.prNumber);
        run.recordSpend(9);
        run.signal.addEventListener("abort", () => reject(run.signal.reason));
      }),
    { ...fast, dbPath: ":memory:", dailyBudgetUsd: 8 },
  );
  q.submit(job(1), "a");
  await settle();
  q.submit(job(1, { reason: "comment" }), "b");
  await settle();
  await settle();
  // The newer request waits: the superseded review already spent today's budget.
  assert.deepEqual(seen, [1]);
  assert.equal(q.stats().queued, 1);
  await q.close(0);
});

test("what a job saves is handed to its retry", async () => {
  const saw: unknown[] = [];
  const q = openReviewQueue(
    async (_j, run) => {
      saw.push(run.saved);
      if (run.saved === undefined) {
        run.save({ review: "finished" });
        return { kind: "failed", reason: "github", transient: true, error: "502" };
      }
      return done;
    },
    { ...fast, dbPath: ":memory:" },
  );
  q.submit(job(1), "a");
  await q.whenIdle();
  assert.deepEqual(saw, [undefined, { review: "finished" }]);
  await q.close(0);
});

test("a job waiting for Claude's usage limit runs again at the reset time, without using up an attempt", async () => {
  let clock = 1_000;
  const attempts: number[] = [];
  const q = openReviewQueue(
    async () => {
      attempts.push(clock);
      return attempts.length < 3 ? { kind: "waiting", until: clock + 10_000, costUsd: 0 } : done;
    },
    { ...fast, maxAttempts: 1, dbPath: ":memory:", now: () => clock },
  );
  q.submit(job(1), "a");
  await settle();
  assert.equal(attempts.length, 1);
  clock += 5_000;
  await settle();
  assert.equal(attempts.length, 1);
  clock += 5_000;
  await settle();
  clock += 10_000;
  await q.whenIdle();
  assert.equal(attempts.length, 3);
  await q.close(0);
});

test("a job superseded while it reports waiting is not queued again", async () => {
  const runs: string[] = [];
  let q!: ReturnType<typeof openReviewQueue>;
  q = openReviewQueue(
    async (j) => {
      runs.push(j.reason);
      // Only the first run asks to wait; a buggy re-run of the old job finishes, so the test ends.
      if (j.reason === "opened" && runs.length === 1) {
        q.submit(job(1, { reason: "comment" }), "newer");
        return { kind: "waiting", until: 0, costUsd: 0 };
      }
      return done;
    },
    { ...fast, concurrency: 2, dbPath: ":memory:" },
  );
  q.submit(job(1), "older");
  await settle();
  await q.whenIdle();
  await settle();
  assert.deepEqual(runs, ["opened", "comment"]);
  await q.close(0);
});
