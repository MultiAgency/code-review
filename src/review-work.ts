// Turns the configuration into the queue's work: one review job, wired with GitHub access for its
// installation, the publisher POST_REVIEWS chooses, and the review options.
import type { AgentRunner } from "./agent.js";
import { sdkAgentRunner } from "./agent.js";
import { agentOptions, purchaseSettings, reviewOptions, type Config } from "./config.js";
import { gitAuthEnv } from "./env.js";
import { githubClient, installationToken, type GitHubClient } from "./github.js";
import { runReviewJob } from "./job.js";
import { githubPublisher, logPublisher, type IssueComment, type Publisher } from "./publisher.js";
import type { JobOutcome } from "./job.js";
import {
  attemptTime,
  callbackDelivery,
  failedOutcome,
  purchasePublisher,
  purchaseWanted,
  type Deliver,
} from "./purchase.js";
import type { Work } from "./queue.js";
import type { ReviewOptions } from "./review.js";
import type { ReviewJob } from "./triggers.js";
import { agentRunnerFor } from "./token-pool.js";

/** GitHub access for one installation (or the PAT, when there is none). */
export interface GitHubAccess {
  gh: GitHubClient;
  /** Git auth for fetching, from a current token. */
  gitEnv: () => Promise<NodeJS.ProcessEnv>;
}

export interface ReviewWorkOptions {
  log: (fields: Record<string, unknown>) => void;
  /** Overrides POST_REVIEWS; the smoke run passes false so it never writes to a PR. */
  publish?: boolean;
  /** Defaults to the configured Claude token(s); one runner is shared by every job. */
  agent?: AgentRunner;
  /** Defaults to the configured GitHub App or PAT. */
  github?: (installationId: number | undefined) => GitHubAccess;
  /** Defaults to posting a purchased review's outcome to its callback. */
  deliver?: (callback: { url: string; token: string }) => Deliver;
  /** Defaults to asking the gateway whether the purchase's job is still running. */
  wanted?: (callback: { url: string; token: string }) => () => Promise<boolean>;
}

export function reviewWork(config: Config, options: ReviewWorkOptions): Work {
  const { log } = options;
  const agent = options.agent ?? agentRunnerFor(config, log);
  const github = options.github ?? githubAccess(config);
  const publish = options.publish ?? config.POST_REVIEWS;
  const isOwnComment = ownCommentCheck(config);
  const purchases = purchaseSettings(config);
  // Purchased reviews are billed to their own API key, within their own budget.
  const purchaseAgent =
    options.agent ??
    (purchases
      ? sdkAgentRunner({
          ...agentOptions(config),
          apiKey: purchases.apiKey,
          ...(purchases.baseUrl ? { baseUrl: purchases.baseUrl } : {}),
          maxBudgetUsd: Math.min(config.REVIEW_MAX_BUDGET_USD, purchases.budgetUsd),
        })
      : agent);
  const deliver = options.deliver ?? callbackDelivery;
  const wanted = options.wanted ?? purchaseWanted;

  const review = (
    job: ReviewJob,
    run: Parameters<Work>[1],
    using: {
      agent: AgentRunner;
      reviewOptions: ReviewOptions;
      publisher: (gh: GitHubClient) => Promise<Publisher>;
      timeoutMs: number;
    },
  ) => {
    const { gh, gitEnv } = github(job.installationId);
    return using.publisher(gh).then((publisher) =>
      runReviewJob(
        job,
        {
          agent: using.agent,
          reviewOptions: using.reviewOptions,
          maxInline: config.REVIEW_MAX_INLINE_COMMENTS,
          gh,
          gitEnv,
          publisher,
          trigger: config.REVIEW_TRIGGER,
          log,
          timeoutMs: using.timeoutMs,
        },
        run,
      ),
    );
  };

  return async (job, run) => {
    const jobLog = (fields: Record<string, unknown>) =>
      log({ pr: `${job.repo}#${job.prNumber}`, ...fields });

    if (job.purchase) {
      // Nothing is spent on a purchase the gateway has refused or dropped: nobody would collect it.
      if (!(await wanted(job.purchase.callback)())) {
        jobLog({ msg: "purchase dropped: the gateway no longer has it", purchase: job.purchase.id });
        return { kind: "skipped", why: "the gateway no longer has this purchase" };
      }
      const report = deliver(job.purchase.callback);
      const timeoutMs = attemptTime(job.purchase.deadline, Date.now(), config.REVIEW_JOB_TIMEOUT_MIN * 60_000);
      const outcome: JobOutcome =
        timeoutMs === undefined
          ? { kind: "failed", reason: "timeout", transient: false, error: "Too little time is left before the purchase's deadline." }
          : await review(job, run, {
              agent: purchaseAgent,
              reviewOptions: {
                ...reviewOptions(config),
                reviewBudgetUsd: purchases?.budgetUsd ?? config.REVIEW_BUDGET_USD,
              },
              publisher: async () => purchasePublisher(report),
              timeoutMs,
            });
      // The buyer hears of a failure once, when no attempt is left that could still succeed.
      const ended =
        outcome.kind === "skipped"
          ? failedOutcome("not_open")
          : outcome.kind === "failed" && (!outcome.transient || run.finalAttempt)
            ? failedOutcome(outcome.reason)
            : undefined;
      if (ended)
        await report(ended).catch((error: unknown) =>
          jobLog({ level: "error", msg: "couldn't deliver the purchase's failure", error: String(error) }),
        );
      return outcome;
    }

    return review(job, run, {
      agent,
      reviewOptions: reviewOptions(config),
      timeoutMs: config.REVIEW_JOB_TIMEOUT_MIN * 60_000,
      publisher: async (gh) =>
        publish
          ? githubPublisher({
              gh,
              repo: job.repo,
              prNumber: job.prNumber,
              ...(job.commentId !== undefined ? { triggerCommentId: job.commentId } : {}),
              isOwnComment: await isOwnComment(gh),
              trigger: config.REVIEW_TRIGGER,
              log: jobLog,
            })
          : logPublisher(jobLog),
    });
  };
}

function githubAccess(config: Config): (installationId: number | undefined) => GitHubAccess {
  const auth = {
    apiUrl: config.GITHUB_API_URL,
    ...(config.GITHUB_APP_ID ? { appId: config.GITHUB_APP_ID } : {}),
    ...(config.GITHUB_APP_PRIVATE_KEY ? { appPrivateKey: config.GITHUB_APP_PRIVATE_KEY } : {}),
    ...(config.GITHUB_TOKEN ? { token: config.GITHUB_TOKEN } : {}),
  };
  return (installationId) => {
    const token = installationToken(auth, installationId);
    return {
      gh: githubClient({ apiUrl: config.GITHUB_API_URL, token }),
      gitEnv: async () => gitAuthEnv(await token()),
    };
  };
}

/**
 * Whose comments are ours: the GitHub App's, or the PAT user's. Only our own
 * summary comment is trusted, since anyone can post one that starts with our marker.
 */
function ownCommentCheck(config: Config): (gh: GitHubClient) => Promise<(c: IssueComment) => boolean> {
  if (config.GITHUB_APP_ID) {
    const appId = Number(config.GITHUB_APP_ID);
    return async () => (c) => c.performed_via_github_app?.id === appId;
  }
  let login: Promise<string> | undefined;
  return async (gh) => {
    login ??= gh
      .request<{ login: string }>("GET", "/user")
      .then((u) => u.login)
      .catch((error: unknown) => {
        login = undefined;
        throw error;
      });
    const user = await login;
    return (c) => c.user?.login === user;
  };
}
