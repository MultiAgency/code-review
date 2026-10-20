import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import {
  checkoutPullRequest,
  getPullRequest,
  gitAuthEnv,
  mergeBase,
  postReview,
  reactToComment,
  reviewBody,
  tokenFor,
} from "./github.js";
import { reviewChanges } from "./review.js";
import { jobFromWebhook, type ReviewJob } from "./triggers.js";

function log(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
}

// --- job queue: bounded concurrency, newest request wins per PR --------------

const active = new Map<string, AbortController>();
const waiting: Array<() => void> = [];
let running = 0;

async function slot(signal: AbortSignal): Promise<boolean> {
  if (running < config.maxConcurrent) {
    running++;
    return true;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  if (signal.aborted) {
    release();
    return false;
  }
  return true;
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

function enqueue(job: ReviewJob) {
  const key = `${job.repo}#${job.prNumber}`;
  active.get(key)?.abort();
  const controller = new AbortController();
  active.set(key, controller);

  void (async () => {
    if (!(await slot(controller.signal))) return;
    const started = Date.now();
    try {
      await runReview(job, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) log({ pr: key, msg: "superseded by a newer request" });
      else log({ pr: key, level: "error", msg: error instanceof Error ? error.message : String(error) });
    } finally {
      if (active.get(key) === controller) active.delete(key);
      release();
      log({ pr: key, msg: "done", seconds: Math.round((Date.now() - started) / 1000) });
    }
  })();
}

async function runReview(job: ReviewJob, signal: AbortSignal) {
  const repo = job.repo;
  const key = `${repo}#${job.prNumber}`;
  const token = await tokenFor(job.installationId);
  if (job.commentId !== undefined) await reactToComment(token, repo, job.commentId);
  // Fetched fresh rather than taken from the webhook: comment events don't carry
  // the PR, and the head may have moved since the event was sent.
  const pr = await getPullRequest(token, repo, job.prNumber);
  if (pr.state !== "open") {
    log({ pr: key, msg: "PR is no longer open, skipping" });
    return;
  }
  const gitEnv = gitAuthEnv(token);
  const workDir = await mkdtemp(join(tmpdir(), "pr-review-"));
  try {
    const repoDir = join(workDir, "repo");
    const mergeBaseSha = await mergeBase(token, repo, pr.base.sha, pr.head.sha);
    log({ pr: key, msg: "checking out", head: pr.head.sha, mergeBase: mergeBaseSha });
    await checkoutPullRequest({
      dir: repoDir,
      cloneUrl: pr.base.repo.clone_url,
      prNumber: pr.number,
      baseRef: pr.base.ref,
      headSha: pr.head.sha,
      mergeBaseSha,
      env: gitEnv,
    });
    signal.throwIfAborted();
    const result = await reviewChanges({
      workDir,
      repoDir,
      base: "refs/pr/base",
      head: pr.head.sha,
      diffRange: `${mergeBaseSha}..${pr.head.sha}`,
      title: pr.title,
      description: pr.body ?? "",
      gitEnv,
      signal,
      log: (msg) => log({ pr: key, msg }),
    });
    signal.throwIfAborted();
    log({ pr: key, msg: "review complete", findings: result.findings, costUsd: result.costUsd });
    if (config.postReviews) {
      await postReview({ token, repo, prNumber: pr.number, headSha: pr.head.sha, result });
      log({ pr: key, msg: "posted review" });
    } else {
      log({ pr: key, msg: "POST_REVIEWS=false, not posting", body: reviewBody(result, true) });
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// --- HTTP ---------------------------------------------------------------------

function readBody(req: IncomingMessage, limit = 25 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function validSignature(body: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", config.webhookSecret!).update(body).digest("hex")}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

if (!config.webhookSecret) {
  console.error("GITHUB_WEBHOOK_SECRET is required.");
  process.exit(1);
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200).end(JSON.stringify({ ok: true, running, queued: waiting.length }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404).end();
    return;
  }
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(413).end();
    return;
  }
  if (!validSignature(body, req.headers["x-hub-signature-256"] as string | undefined)) {
    res.writeHead(401).end("bad signature");
    return;
  }
  const eventName = String(req.headers["x-github-event"] ?? "");
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    res.writeHead(400).end();
    return;
  }
  const decision = jobFromWebhook(eventName, payload, {
    trigger: config.reviewTrigger,
    allowedRepos: config.allowedRepos,
  });
  if ("skip" in decision) {
    res.writeHead(204).end();
    return;
  }
  const { job } = decision;
  log({ pr: `${job.repo}#${job.prNumber}`, msg: "queued", reason: job.reason, requestedBy: job.requestedBy });
  enqueue(job);
  res.writeHead(202).end("queued");
});

server.listen(config.port, () => {
  log({
    msg: "listening",
    port: config.port,
    model: config.model ?? "(Claude Code default)",
    postReviews: config.postReviews,
    maxConcurrent: config.maxConcurrent,
  });
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log({ msg: `${signal}, shutting down` });
    for (const controller of active.values()) controller.abort();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
