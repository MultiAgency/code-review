import type { AgentFailureKind, AgentRunner } from "./agent.js";
import {
  compareCommits,
  getPullRequest,
  GitHubError,
  type GitHubClient,
} from "./github.js";
import type { Publisher } from "./publisher.js";
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
} from "./review.js";
import type { ReviewJob } from "./triggers.js";
import type { openPullRequestWorkspace } from "./workspace.js";

export interface JobDeps {
  agent: AgentRunner;
  reviewOptions: ReviewOptions;
  maxInline: number;
  gh: GitHubClient;
  /** Git auth for fetching, from a current token. */
  gitEnv: () => Promise<NodeJS.ProcessEnv>;
  publisher: Publisher;
  openWorkspace: typeof openPullRequestWorkspace;
  log: (fields: Record<string, unknown>) => void;
  /** Wall-clock cap for the whole job; reported on the PR as a timeout. */
  timeoutMs?: number;
}

export type JobOutcome =
  | { kind: "done"; costUsd: number }
  | { kind: "skipped"; why: string }
  | {
      kind: "failed";
      reason: FailureReason;
      transient: boolean;
      error: string;
      costUsd?: number;
    };

const AGENT_REASON: Record<AgentFailureKind, FailureReason> = {
  auth_or_limit: "usage_limit",
  budget_exceeded: "budget",
  turn_limit: "budget",
  timeout: "timeout",
  bad_output: "bad_output",
  aborted: "interrupted",
  crashed: "unknown",
};

/**
 * One review of one PR, start to finish: fetch, review (full or incremental),
 * publish. Failures are reported on the PR and returned, never thrown, except
 * when `outer` aborts (a newer request or shutdown takes over).
 */
export async function runReviewJob(
  job: ReviewJob,
  deps: JobDeps,
  outer: AbortSignal,
): Promise<JobOutcome> {
  const { gh, publisher } = deps;
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? 50 * 60_000);
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

    stage = "git";
    log({ msg: "checking out", head: pr.head.sha, mode, diffBase });
    await using workspace = await deps.openWorkspace({
      cloneUrl: pr.base.repo.clone_url,
      baseRef: pr.base.ref,
      headSha: pr.head.sha,
      diffBase,
      gitEnv: await deps.gitEnv(),
      signal,
    });
    stage = "review";
    const result = await reviewChanges(
      {
        workspace,
        title: pr.title,
        description: pr.body ?? "",
        priorFindings: priorFindings(prior),
        signal,
        log: (msg) => log({ msg }),
      },
      { agent: deps.agent, options: deps.reviewOptions },
    );
    signal.throwIfAborted();
    log({
      msg: "review complete",
      findings: result.findings.length,
      verification: result.verification,
      costUsd: result.costUsd,
    });

    stage = "publish";
    const report = buildReport(result, {
      headSha: workspace.headSha,
      mode,
      ...(prior ? { prior } : {}),
      maxInline: deps.maxInline,
    });
    await publisher.publish(report);
    return { kind: "done", costUsd: result.costUsd };
  } catch (error) {
    if (outer.aborted) throw error;
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
      reason === "git" || reason === "github" || reason === "unknown";
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
    const costUsd = error instanceof ReviewFailedError ? error.costUsd : 0;
    return { kind: "failed", reason, transient, error: message, costUsd };
  }
}
