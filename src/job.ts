import type { AgentFailureKind, AgentRunner } from "./agent.js";
import {
  compareCommits,
  getPullRequest,
  GitHubError,
  type GitHubClient,
} from "./github.js";
import type { Publisher } from "./publisher.js";
import type { JobRun } from "./queue.js";
import {
  buildReport,
  priorFindings,
  type FailureReason,
  type ReviewState,
} from "./report.js";
import {
  ReviewFailedError,
  reviewChanges,
  type ReviewOptions,
  type ReviewResult,
} from "./review.js";
import type { ReviewJob } from "./triggers.js";
import { openPullRequestWorkspace } from "./workspace.js";

export interface JobDeps {
  agent: AgentRunner;
  reviewOptions: ReviewOptions;
  maxInline: number;
  gh: GitHubClient;
  /** Git auth for fetching, from a current token. */
  gitEnv: () => Promise<NodeJS.ProcessEnv>;
  publisher: Publisher;
  /** The configured trigger phrase, which the summary invites people to comment. */
  trigger: string;
  log: (fields: Record<string, unknown>) => void;
  /** Wall-clock cap for the whole job; reported on the PR as a timeout. */
  timeoutMs: number;
}

/** How a job ended. `costUsd` is for the logs; spend is recorded as each pass finishes. */
export type JobOutcome =
  | { kind: "done"; costUsd: number }
  | { kind: "skipped"; why: string }
  /** Claude's usage limit: run the job again at `until` (epoch ms). */
  | { kind: "waiting"; until: number; costUsd: number }
  | {
      kind: "failed";
      reason: FailureReason;
      transient: boolean;
      error: string;
      costUsd?: number;
    };

/** How long a review may wait in total for Claude's usage limit to reset before it fails. */
export const MAX_WAIT_MS = 24 * 60 * 60_000;

const AGENT_REASON: Record<AgentFailureKind, FailureReason> = {
  usage_limit: "usage_limit",
  auth_rejected: "auth",
  overloaded: "overloaded",
  too_large: "too_large",
  budget_exceeded: "budget",
  turn_limit: "budget",
  timeout: "timeout",
  bad_output: "bad_output",
  aborted: "interrupted",
  crashed: "unknown",
};

/** A finished review kept with the job, so a publishing retry doesn't pay for it again. */
interface SavedReview {
  headSha: string;
  diffBase: string;
  mode: "full" | "incremental";
  result: ReviewResult;
}

/**
 * One review of one PR, start to finish: fetch, review (full or incremental),
 * publish. Every Claude pass's cost is recorded as it finishes. Failures are
 * reported on the PR and returned, never thrown, except when the run's signal
 * aborts (a newer request or shutdown takes over).
 */
export async function runReviewJob(
  job: ReviewJob,
  deps: JobDeps,
  run: JobRun,
): Promise<JobOutcome> {
  const { gh, publisher } = deps;
  const outer = run.signal;
  let spent = 0;
  const agent: AgentRunner = {
    async run(request) {
      const result = await deps.agent.run(request);
      spent += result.costUsd;
      run.recordSpend(result.costUsd);
      return result;
    },
  };
  const timeout = AbortSignal.timeout(deps.timeoutMs);
  const signal = AbortSignal.any([outer, timeout]);
  const log = (fields: Record<string, unknown>) =>
    deps.log({ pr: `${job.repo}#${job.prNumber}`, ...fields });
  let stage: "github" | "git" | "review" | "publish" = "github";
  let prior: ReviewState | undefined;
  try {
    await publisher.started();
    // Fetched fresh rather than taken from the webhook: comment events don't
    // carry the PR, and the head may have moved since the event was sent.
    const pr = await getPullRequest(gh, job.repo, job.prNumber);
    if (pr.state !== "open")
      return { kind: "skipped", why: "PR is no longer open" };
    prior = await publisher.prior();

    // Re-reviews cover only new commits, unless the branch was rewritten or a
    // full review was asked for.
    let mode: "full" | "incremental" = "full";
    let diffBase = (
      await compareCommits(gh, job.repo, pr.base.sha, pr.head.sha)
    ).mergeBase;
    if (
      job.reason === "comment" &&
      !job.full &&
      prior &&
      prior.head !== pr.head.sha
    ) {
      const since = await compareCommits(
        gh,
        job.repo,
        prior.head,
        pr.head.sha,
      ).catch(() => undefined);
      if (since?.status === "ahead") {
        mode = "incremental";
        diffBase = prior.head;
      }
    }
    if (job.reason === "comment" && !job.full && prior?.head === pr.head.sha) {
      log({ msg: "head already reviewed; reviewing in full" });
    }

    const saved = run.saved as SavedReview | undefined;
    let result: ReviewResult;
    if (
      saved?.headSha === pr.head.sha &&
      saved.diffBase === diffBase &&
      saved.mode === mode
    ) {
      log({ msg: "publishing the review an earlier attempt finished" });
      result = saved.result;
    } else {
      stage = "git";
      log({ msg: "checking out", head: pr.head.sha, mode, diffBase });
      await using workspace = await openPullRequestWorkspace({
        cloneUrl: pr.base.repo.clone_url,
        baseRef: pr.base.ref,
        headSha: pr.head.sha,
        diffBase,
        gitEnv: await deps.gitEnv(),
        signal,
      });
      stage = "review";
      result = await reviewChanges(
        {
          workspace,
          title: pr.title,
          description: pr.body ?? "",
          priorFindings: priorFindings(prior),
          signal,
          log: (msg) => log({ msg }),
        },
        { agent, options: deps.reviewOptions },
      );
      run.save({ headSha: pr.head.sha, diffBase, mode, result } satisfies SavedReview);
      signal.throwIfAborted();
      log({
        msg: "review complete",
        findings: result.findings.length,
        verification: result.verification,
        costUsd: result.costUsd,
      });
    }

    stage = "publish";
    const report = buildReport(result, {
      headSha: pr.head.sha,
      mode,
      ...(prior ? { prior } : {}),
      maxInline: deps.maxInline,
      trigger: deps.trigger,
    });
    await publisher.publish(report);
    return { kind: "done", costUsd: spent };
  } catch (error) {
    if (outer.aborted) throw error;
    if (
      error instanceof ReviewFailedError &&
      error.failure === "usage_limit" &&
      error.retryAt !== undefined &&
      error.retryAt <= run.queuedAt + MAX_WAIT_MS
    ) {
      log({ level: "warn", msg: "waiting for Claude's usage limit to reset", until: new Date(error.retryAt).toISOString() });
      await publisher
        .waiting(error.retryAt, prior)
        .catch((e) => log({ level: "error", msg: "couldn't report waiting", error: String(e) }));
      return { kind: "waiting", until: error.retryAt, costUsd: spent };
    }
    const reason: FailureReason = timeout.aborted
      ? "timeout"
      : error instanceof ReviewFailedError
        ? AGENT_REASON[error.failure]
        : error instanceof GitHubError ||
            stage === "github" ||
            stage === "publish"
          ? "github"
          : stage === "git"
            ? "git"
            : "unknown";
    const transient =
      reason === "git" ||
      reason === "github" ||
      reason === "overloaded" ||
      reason === "unknown";
    const message = error instanceof Error ? error.message : String(error);
    log({
      level: "error",
      msg: "review failed",
      reason,
      stage,
      error: message,
    });
    await publisher
      .failed(reason, prior)
      .catch((e) =>
        log({
          level: "error",
          msg: "couldn't report failure",
          error: String(e),
        }),
      );
    return { kind: "failed", reason, transient, error: message, costUsd: spent };
  }
}
