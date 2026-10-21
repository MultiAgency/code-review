// Turns the configuration into the queue's work: one review job, wired with GitHub access for its
// installation, the publisher POST_REVIEWS chooses, and the review options.
import type { AgentRunner } from "./agent.js";
import { reviewOptions, type Config } from "./config.js";
import { gitAuthEnv } from "./env.js";
import { githubClient, installationToken, type GitHubClient } from "./github.js";
import { runReviewJob } from "./job.js";
import { githubPublisher, logPublisher, type IssueComment } from "./publisher.js";
import type { Work } from "./queue.js";
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
}

export function reviewWork(config: Config, options: ReviewWorkOptions): Work {
  const { log } = options;
  const agent = options.agent ?? agentRunnerFor(config, log);
  const github = options.github ?? githubAccess(config);
  const publish = options.publish ?? config.POST_REVIEWS;
  const isOwnComment = ownCommentCheck(config);

  return async (job, run) => {
    const { gh, gitEnv } = github(job.installationId);
    const jobLog = (fields: Record<string, unknown>) =>
      log({ pr: `${job.repo}#${job.prNumber}`, ...fields });
    const publisher = publish
      ? githubPublisher({
          gh,
          repo: job.repo,
          prNumber: job.prNumber,
          ...(job.commentId !== undefined ? { triggerCommentId: job.commentId } : {}),
          isOwnComment: await isOwnComment(gh),
          trigger: config.REVIEW_TRIGGER,
          log: jobLog,
        })
      : logPublisher(jobLog);
    return runReviewJob(
      job,
      {
        agent,
        reviewOptions: reviewOptions(config),
        maxInline: config.REVIEW_MAX_INLINE_COMMENTS,
        gh,
        gitEnv,
        publisher,
        trigger: config.REVIEW_TRIGGER,
        log,
        timeoutMs: config.REVIEW_JOB_TIMEOUT_MIN * 60_000,
      },
      run,
    );
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
