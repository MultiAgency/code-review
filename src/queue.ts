import { DatabaseSync } from "node:sqlite";
import type { JobOutcome } from "./job.js";
import type { ReviewJob } from "./triggers.js";

/** What the queue hands a running job. */
export interface JobRun {
  /** Aborts when a newer request for the PR supersedes this job, or on shutdown. */
  signal: AbortSignal;
  /** Adds to today's spend at once, so it counts however the job ends. */
  recordSpend(usd: number): void;
  /** When the job was first queued (epoch ms). */
  queuedAt: number;
  /** What an earlier attempt of this job saved, if anything. */
  saved: unknown;
  /** Keeps JSON data with the job for its retries, e.g. a finished review whose publishing failed. */
  save(data: unknown): void;
  /** True when a transient failure of this run will not be retried. */
  finalAttempt: boolean;
}

export type Work = (job: ReviewJob, run: JobRun) => Promise<JobOutcome>;

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

type Status = "queued" | "running" | "done" | "failed" | "superseded";

interface ReadyRow {
  id: number;
  pr: string;
  payload: string;
  attempts: number;
  saved: string | null;
  created: number;
}

/** Review jobs and daily spend, persisted in SQLite. Knows nothing about running them. */
class JobStore {
  private readonly db: DatabaseSync;

  constructor(
    dbPath: string,
    private readonly now: () => number,
  ) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
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
    const columns = this.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "saved")) this.db.exec("ALTER TABLE jobs ADD COLUMN saved TEXT");
    if (!columns.some((c) => c.name === "created")) this.db.exec("ALTER TABLE jobs ADD COLUMN created INTEGER");
  }

  /** A crash or an expired grace period left these mid-run: run them again. */
  resumeInterrupted(): void {
    this.db.prepare("UPDATE jobs SET status = 'queued' WHERE status = 'running'").run();
  }

  purgeFinishedBefore(time: number): void {
    this.db.prepare("DELETE FROM jobs WHERE status IN ('done', 'failed', 'superseded') AND updated < ?").run(time);
  }

  /** The new job's id, or undefined when this delivery was already stored. */
  insert(pr: string, deliveryId: string, job: ReviewJob): number | undefined {
    const inserted = this.db
      .prepare(
        `INSERT INTO jobs (pr, delivery, payload, status, run_after, updated, created)
         VALUES (?, ?, ?, 'queued', ?, ?, ?) ON CONFLICT (delivery) DO NOTHING`,
      )
      .run(pr, deliveryId, JSON.stringify(job), this.now(), this.now(), this.now());
    return inserted.changes === 0 ? undefined : Number(inserted.lastInsertRowid);
  }

  /** Marks older waiting or running jobs for the same PR as superseded. */
  supersedeOlder(pr: string, id: number): void {
    this.db
      .prepare("UPDATE jobs SET status = 'superseded', updated = ? WHERE pr = ? AND id < ? AND status IN ('queued', 'running')")
      .run(this.now(), pr, id);
  }

  /** Queued jobs whose retry time has come, oldest first. */
  ready(): ReadyRow[] {
    return this.db
      .prepare("SELECT id, pr, payload, attempts, saved, COALESCE(created, updated) AS created FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY id")
      .all(this.now()) as unknown as ReadyRow[];
  }

  markRunning(id: number): void {
    this.db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated = ? WHERE id = ?").run(this.now(), id);
  }

  status(id: number): Status | undefined {
    return (this.db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: Status } | undefined)?.status;
  }

  save(id: number, data: unknown): void {
    this.db.prepare("UPDATE jobs SET saved = ? WHERE id = ?").run(JSON.stringify(data), id);
  }

  setStatus(id: number, status: Status): void {
    this.db.prepare("UPDATE jobs SET status = ?, updated = ? WHERE id = ?").run(status, this.now(), id);
  }

  retryAt(id: number, runAfter: number): void {
    this.db.prepare("UPDATE jobs SET status = 'queued', run_after = ?, updated = ? WHERE id = ?").run(runAfter, this.now(), id);
  }

  /** Back to the queue without using up an attempt (the job was interrupted or is waiting, not failed). */
  requeueInterrupted(id: number, runAfter = this.now()): void {
    this.db
      .prepare("UPDATE jobs SET status = 'queued', attempts = attempts - 1, run_after = ?, updated = ? WHERE id = ?")
      .run(runAfter, this.now(), id);
  }

  queuedCount(): number {
    return Number((this.db.prepare("SELECT count(*) AS n FROM jobs WHERE status = 'queued'").get() as { n: number }).n);
  }

  today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  spentToday(): number {
    return (this.db.prepare("SELECT usd FROM spend WHERE day = ?").get(this.today()) as { usd: number } | undefined)?.usd ?? 0;
  }

  addSpend(usd: number): void {
    if (usd <= 0) return;
    this.db
      .prepare("INSERT INTO spend (day, usd) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET usd = usd + excluded.usd")
      .run(this.today(), usd);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Review jobs, persisted so a deploy or crash doesn't lose them. Runs up to
 * `concurrency` at once; a newer job for the same PR supersedes an older one.
 * Resumes queued and interrupted jobs on start.
 */
export class ReviewQueue {
  private readonly store: JobStore;
  private readonly now: () => number;
  private readonly log: (fields: Record<string, unknown>) => void;
  private readonly backoff: (attempt: number) => number;
  private readonly running = new Map<number, { pr: string; controller: AbortController; done: Promise<void> }>();
  private readonly idleWaiters: Array<() => void> = [];
  private readonly timer: NodeJS.Timeout;
  private closing = false;
  private capLoggedOn = "";

  constructor(
    private readonly work: Work,
    private readonly options: QueueOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
    this.backoff = options.backoffMs ?? ((attempt) => 30_000 * 4 ** (attempt - 1));
    this.store = new JobStore(options.dbPath, this.now);
    this.store.resumeInterrupted();
    this.store.purgeFinishedBefore(this.now() - 7 * 864e5);
    this.timer = setInterval(this.pump, options.pollMs ?? 1000);
    this.timer.unref();
    setImmediate(this.pump);
  }

  /** Persists a job. A redelivered webhook (same delivery id) is ignored. */
  submit(job: ReviewJob, deliveryId: string): "queued" | "duplicate" {
    // A purchased review is its buyer's own: it neither replaces nor is replaced by another review of the PR.
    const pr = job.purchase ? `purchase ${job.purchase.id}` : `${job.repo}#${job.prNumber}`;
    const id = this.store.insert(pr, deliveryId, job);
    if (id === undefined) return "duplicate";
    // Newest request wins: drop older waiting jobs for this PR and stop a running one.
    this.store.supersedeOlder(pr, id);
    for (const [rid, r] of this.running) {
      if (r.pr === pr && rid !== id) r.controller.abort(new Error("superseded"));
    }
    setImmediate(this.pump);
    return "queued";
  }

  stats(): { running: number; queued: number } {
    return { running: this.running.size, queued: this.store.queuedCount() };
  }

  /** Resolves when nothing is running or waiting to run. */
  whenIdle(): Promise<void> {
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
      this.checkIdle();
    });
  }

  /**
   * Stops taking work, gives running jobs `graceMs` to finish, then aborts the
   * rest. Aborted jobs stay queued and run again after the next start.
   */
  async close(graceMs: number): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    const all = Promise.all([...this.running.values()].map((r) => r.done));
    const grace = new Promise((resolve) => setTimeout(resolve, graceMs).unref());
    await Promise.race([all, grace]);
    for (const r of this.running.values()) r.controller.abort(new Error("shutdown"));
    await all;
    this.store.close();
  }

  // An arrow property, so it can be handed to timers without binding.
  private readonly pump = (): void => {
    if (this.closing) return;
    if (this.options.dailyBudgetUsd !== undefined && this.store.spentToday() >= this.options.dailyBudgetUsd) {
      if (this.capLoggedOn !== this.store.today()) {
        this.capLoggedOn = this.store.today();
        this.log({
          level: "warn",
          msg: "daily review budget reached; queued reviews wait until tomorrow (UTC)",
          spentUsd: this.store.spentToday(),
        });
      }
      return;
    }
    for (const row of this.store.ready()) {
      if (this.running.size >= this.options.concurrency) break;
      // One job per PR at a time, including one still unwinding after being superseded,
      // so a stale review can never post after a newer one starts.
      if ([...this.running.values()].some((r) => r.pr === row.pr)) continue;
      this.store.markRunning(row.id);
      this.start(row, JSON.parse(row.payload) as ReviewJob, row.attempts + 1);
    }
    this.checkIdle();
  };

  private start(row: ReadyRow, job: ReviewJob, attempt: number): void {
    const { id, pr } = row;
    const controller = new AbortController();
    const run: JobRun = {
      signal: controller.signal,
      recordSpend: (usd) => this.store.addSpend(usd),
      queuedAt: Number(row.created),
      saved: row.saved === null ? undefined : JSON.parse(row.saved),
      save: (data) => this.store.save(id, data),
      finalAttempt: attempt >= this.options.maxAttempts,
    };
    const done = (async () => {
      let next: Status = "done";
      try {
        const outcome = await this.work(job, run);
        this.log({ pr, msg: "job finished", attempt, ...outcome });
        if (outcome.kind === "waiting") {
          // Unless a newer request superseded it meanwhile.
          if (this.store.status(id) === "running") this.store.requeueInterrupted(id, outcome.until);
          return;
        }
        if (outcome.kind === "failed") {
          if (outcome.transient && attempt < this.options.maxAttempts) {
            this.store.retryAt(id, this.now() + this.backoff(attempt));
            return;
          }
          next = "failed";
        }
      } catch (error) {
        if (controller.signal.aborted) {
          // Superseded jobs were already marked; shutdown leaves the job queued to resume.
          if (this.closing && this.store.status(id) === "running") this.store.requeueInterrupted(id);
          return;
        }
        this.log({ pr, level: "error", msg: "job crashed", error: error instanceof Error ? error.message : String(error) });
        next = "failed";
      } finally {
        this.running.delete(id);
        setImmediate(this.pump);
      }
      if (this.store.status(id) === "running") this.store.setStatus(id, next);
    })();
    this.running.set(id, { pr, controller, done });
  }

  private checkIdle(): void {
    if (this.running.size === 0 && this.store.queuedCount() === 0) {
      this.idleWaiters.splice(0).forEach((resolve) => resolve());
    }
  }
}

export function openReviewQueue(work: Work, options: QueueOptions): ReviewQueue {
  return new ReviewQueue(work, options);
}
