// The service entry point: wires config, the review queue and the webhook handler.
import { createServer } from "node:http";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { checkServiceConfig, loadConfigOrExit } from "./config.js";
import { openReviewQueue } from "./queue.js";
import { reviewWork } from "./review-work.js";
import { webhookHandler } from "./server.js";

function log(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
}

const config = loadConfigOrExit(checkServiceConfig);

if (config.QUEUE_DB !== ":memory:")
  mkdirSync(dirname(config.QUEUE_DB), { recursive: true });
const queue = openReviewQueue(reviewWork(config, { log }), {
  dbPath: config.QUEUE_DB,
  concurrency: config.MAX_CONCURRENT_REVIEWS,
  maxAttempts: config.REVIEW_MAX_ATTEMPTS,
  ...(config.DAILY_BUDGET_USD > 0
    ? { dailyBudgetUsd: config.DAILY_BUDGET_USD }
    : {}),
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
    log({
      msg: `${signal}: finishing running reviews for up to ${config.SHUTDOWN_GRACE_SECONDS}s`,
    });
    server.close();
    // Unfinished jobs stay queued and resume after the next start.
    void queue
      .close(config.SHUTDOWN_GRACE_SECONDS * 1000)
      .finally(() => process.exit(0));
  });
}
