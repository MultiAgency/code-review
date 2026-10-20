// The service entry point: wires config, the review queue and the webhook handler.
import { createServer } from "node:http";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { sdkAgentRunner } from "./agent.js";
import { agentOptions, checkServiceConfig, ConfigError, loadConfig, reviewOptions, type Config } from "./config.js";
import { gitAuthEnv } from "./env.js";
import { githubClient, installationToken, type GitHubClient } from "./github.js";
import { runReviewJob } from "./job.js";
import { githubPublisher, logPublisher, type IssueComment } from "./publisher.js";
import { openReviewQueue } from "./queue.js";
import { webhookHandler } from "./server.js";
import type { ReviewJob } from "./triggers.js";
import { openPullRequestWorkspace } from "./workspace.js";

function log(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
}

let config: Config;
try {
  config = loadConfig();
  checkServiceConfig(config);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

const agent = sdkAgentRunner(agentOptions(config));
const auth = {
  apiUrl: config.GITHUB_API_URL,
  ...(config.GITHUB_APP_ID ? { appId: config.GITHUB_APP_ID } : {}),
  ...(config.GITHUB_APP_PRIVATE_KEY ? { appPrivateKey: config.GITHUB_APP_PRIVATE_KEY } : {}),
  ...(config.GITHUB_TOKEN ? { token: config.GITHUB_TOKEN } : {}),
};

/** Our own comments: by this GitHub App, or by the PAT's user. */
async function ownCommentCheck(gh: GitHubClient): Promise<(c: IssueComment) => boolean> {
  if (config.GITHUB_APP_ID) {
    const appId = Number(config.GITHUB_APP_ID);
    return (c) => c.performed_via_github_app?.id === appId;
  }
  const { login } = await gh.request<{ login: string }>("GET", "/user");
  return (c) => c.user?.login === login;
}

async function review(job: ReviewJob, signal: AbortSignal) {
  const token = installationToken(auth, job.installationId);
  const gh = githubClient({ apiUrl: config.GITHUB_API_URL, token });
  const jobLog = (fields: Record<string, unknown>) => log({ pr: `${job.repo}#${job.prNumber}`, ...fields });
  const publisher = config.POST_REVIEWS
    ? githubPublisher({
        gh,
        repo: job.repo,
        prNumber: job.prNumber,
        ...(job.commentId !== undefined ? { triggerCommentId: job.commentId } : {}),
        isOwnComment: await ownCommentCheck(gh),
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
      gitEnv: async () => gitAuthEnv(await token()),
      publisher,
      openWorkspace: openPullRequestWorkspace,
      log,
      timeoutMs: config.REVIEW_JOB_TIMEOUT_MIN * 60_000,
    },
    signal,
  );
}

if (config.QUEUE_DB !== ":memory:") mkdirSync(dirname(config.QUEUE_DB), { recursive: true });
const queue = openReviewQueue(review, {
  dbPath: config.QUEUE_DB,
  concurrency: config.MAX_CONCURRENT_REVIEWS,
  maxAttempts: config.REVIEW_MAX_ATTEMPTS,
  log,
});

const server = createServer(
  webhookHandler({
    secret: config.GITHUB_WEBHOOK_SECRET!,
    trigger: config.REVIEW_TRIGGER,
    allowedRepos: config.ALLOWED_REPOS,
    queue,
    log,
  }),
);

server.listen(config.PORT, () => {
  log({
    msg: "listening",
    port: config.PORT,
    model: config.REVIEW_MODEL ?? "(Claude Code default)",
    postReviews: config.POST_REVIEWS,
    maxConcurrent: config.MAX_CONCURRENT_REVIEWS,
    queueDb: config.QUEUE_DB,
    ...queue.stats(),
  });
});

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log({ msg: `${signal}: finishing running reviews for up to ${config.SHUTDOWN_GRACE_SECONDS}s` });
    server.close();
    // Unfinished jobs stay queued and resume after the next start.
    void queue.close(config.SHUTDOWN_GRACE_SECONDS * 1000).finally(() => process.exit(0));
  });
}
