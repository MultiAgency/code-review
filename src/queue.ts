import { DatabaseSync } from "node:sqlite";
import type { JobOutcome } from "./job.js";
import type { ReviewJob } from "./triggers.js";

export type Work = (job: ReviewJob, signal: AbortSignal) => Promise<JobOutcome>;

export interface QueueOptions {
  /** SQLite file, or ":memory:". Put it on a volume so jobs survive deploys. */
  dbPath: string;
  concurrency: number;
  /** Attempts per job, counting the first. Only transient failures retry. */
  maxAttempts: number;
  backoffMs?: (attempt: number) => number;
  pollMs?: number;
  /** Stop starting reviews once this much has been spent today (UTC); they wait for tomorrow. */
  dailyBudgetUsd?: number;
  now?: () => number;
  log?: (fields: Record<string, unknown>) => void;
}

export interface ReviewQueue {
  /** Persists a job. A redelivered webhook (same delivery id) is ignored. */
  submit(job: ReviewJob, deliveryId: string): "queued" | "duplicate";
  stats(): { running: number; queued: number };
  /** Resolves when nothing is running or waiting to run. */
  whenIdle(): Promise<void>;
  /**
   * Stops taking work, gives running jobs `graceMs` to finish, then aborts the
   * rest. Aborted jobs stay queued and run again after the next start.
   */
  close(graceMs: number): Promise<void>;
}

type Status = "queued" | "running" | "done" | "failed" | "superseded";

/**
 * Review jobs, persisted so a deploy or crash doesn't lose them. Runs up to
 * `concurrency` at once; a newer job for the same PR supersedes an older one.
 * Resumes queued and interrupted jobs on start.
 */
export function openReviewQueue(
  work: Work,
  options: QueueOptions,
): ReviewQueue {
  const db = new DatabaseSync(options.dbPath);
  const log = options.log ?? (() => {});
  const backoff =
    options.backoffMs ?? ((attempt) => 30_000 * 4 ** (attempt - 1));
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr TEXT NOT NULL,
      delivery TEXT UNIQUE,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      run_after INTEGER NOT NULL,
      updated INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, run_after);
    CREATE TABLE IF NOT EXISTS spend (day TEXT PRIMARY KEY, usd REAL NOT NULL);
  `);
  const now = options.now ?? (() => Date.now());
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const spentToday = () =>
    (
      db.prepare("SELECT usd FROM spend WHERE day = ?").get(today()) as
        { usd: number } | undefined
    )?.usd ?? 0;
  const addSpend = (usd: number) => {
    if (usd > 0) {
      db.prepare(
        "INSERT INTO spend (day, usd) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET usd = usd + excluded.usd",
      ).run(today(), usd);
    }
  };
  let capLogged = "";
  // A crash or an expired grace period left these mid-run: run them again.
  db.prepare(
    "UPDATE jobs SET status = 'queued' WHERE status = 'running'",
  ).run();
  db.prepare(
    "DELETE FROM jobs WHERE status IN ('done', 'failed', 'superseded') AND updated < ?",
  ).run(now() - 7 * 864e5);

  const setStatus = db.prepare(
    "UPDATE jobs SET status = ?, updated = ? WHERE id = ?",
  );
  const running = new Map<
    number,
    { pr: string; controller: AbortController; done: Promise<void> }
  >();
  const idleWaiters: Array<() => void> = [];
  let closing = false;

  const keyOf = (job: ReviewJob) => `${job.repo}#${job.prNumber}`;

  function queuedCount(): number {
    return Number(
      (
        db
          .prepare("SELECT count(*) AS n FROM jobs WHERE status = 'queued'")
          .get() as { n: number }
      ).n,
    );
  }

  function checkIdle() {
    if (running.size === 0 && queuedCount() === 0)
      idleWaiters.splice(0).forEach((resolve) => resolve());
  }

  function pump() {
    if (closing) return;
    if (
      options.dailyBudgetUsd !== undefined &&
      spentToday() >= options.dailyBudgetUsd
    ) {
      if (capLogged !== today()) {
        capLogged = today();
        log({
          level: "warn",
          msg: "daily review budget reached; queued reviews wait until tomorrow (UTC)",
          spentUsd: spentToday(),
        });
      }
      return;
    }
    const ready = db
      .prepare(
        "SELECT id, pr, payload, attempts FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY id",
      )
      .all(now()) as Array<{
      id: number;
      pr: string;
      payload: string;
      attempts: number;
    }>;
    for (const row of ready) {
      if (running.size >= options.concurrency) break;
      // One job per PR at a time, including one still unwinding after being superseded,
      // so a stale review can never post after a newer one starts.
      if ([...running.values()].some((r) => r.pr === row.pr)) continue;
      db.prepare(
        "UPDATE jobs SET status = 'running', attempts = attempts + 1, updated = ? WHERE id = ?",
      ).run(now(), row.id);
      start(
        row.id,
        row.pr,
        JSON.parse(row.payload) as ReviewJob,
        row.attempts + 1,
      );
    }
    checkIdle();
  }

  function start(id: number, pr: string, job: ReviewJob, attempt: number) {
    const controller = new AbortController();
    const done = (async () => {
      let next: Status = "done";
      try {
        const outcome = await work(job, controller.signal);
        addSpend(outcome.kind === "skipped" ? 0 : (outcome.costUsd ?? 0));
        log({ pr, msg: "job finished", attempt, ...outcome });
        if (outcome.kind === "failed") {
          if (outcome.transient && attempt < options.maxAttempts) {
            db.prepare(
              "UPDATE jobs SET status = 'queued', run_after = ?, updated = ? WHERE id = ?",
            ).run(now() + backoff(attempt), now(), id);
            return;
          }
          next = "failed";
        }
      } catch (error) {
        if (controller.signal.aborted) {
          // Superseded jobs were already marked; shutdown leaves the job queued to resume.
          if (closing && current(id) === "running") {
            db.prepare(
              "UPDATE jobs SET status = 'queued', attempts = attempts - 1, updated = ? WHERE id = ?",
            ).run(now(), id);
          }
          return;
        }
        log({
          pr,
          level: "error",
          msg: "job crashed",
          error: error instanceof Error ? error.message : String(error),
        });
        next = "failed";
      } finally {
        running.delete(id);
        setImmediate(pump);
      }
      if (current(id) === "running") setStatus.run(next, now(), id);
    })();
    running.set(id, { pr, controller, done });
  }

  function current(id: number): Status | undefined {
    return (
      db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as
        { status: Status } | undefined
    )?.status;
  }

  const timer = setInterval(pump, options.pollMs ?? 1000);
  timer.unref();
  setImmediate(pump);

  return {
    submit(job, deliveryId) {
      const pr = keyOf(job);
      const inserted = db
        .prepare(
          `INSERT INTO jobs (pr, delivery, payload, status, run_after, updated)
           VALUES (?, ?, ?, 'queued', ?, ?) ON CONFLICT (delivery) DO NOTHING`,
        )
        .run(pr, deliveryId, JSON.stringify(job), now(), now());
      if (inserted.changes === 0) return "duplicate";
      const id = Number(inserted.lastInsertRowid);
      // Newest request wins: drop older waiting jobs for this PR and stop a running one.
      db.prepare(
        "UPDATE jobs SET status = 'superseded', updated = ? WHERE pr = ? AND id < ? AND status IN ('queued', 'running')",
      ).run(now(), pr, id);
      for (const [rid, r] of running) {
        if (r.pr === pr && rid !== id)
          r.controller.abort(new Error("superseded"));
      }
      setImmediate(pump);
      return "queued";
    },
    stats() {
      return { running: running.size, queued: queuedCount() };
    },
    whenIdle() {
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
        checkIdle();
      });
    },
    async close(graceMs) {
      closing = true;
      clearInterval(timer);
      const all = Promise.all([...running.values()].map((r) => r.done));
      const grace = new Promise((resolve) =>
        setTimeout(resolve, graceMs).unref(),
      );
      await Promise.race([all, grace]);
      for (const r of running.values())
        r.controller.abort(new Error("shutdown"));
      await all;
      db.close();
    },
  };
}
