import { createSign } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { config, redactSecrets } from "./config.js";
import { git } from "./git.js";
import type { Finding, ReviewResult } from "./review.js";

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function appJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.githubAppId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(config.githubAppPrivateKey!);
  return `${header}.${payload}.${base64url(signature)}`;
}

async function api<T>(token: string, method: string, path: string, body?: unknown, auth = "token"): Promise<T> {
  const response = await fetch(`${config.githubApiUrl}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `${auth} ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "claude-pr-review",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new GitHubError(response.status, `${method} ${path}: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Installation token when running as a GitHub App, else the configured PAT. */
export async function tokenFor(installationId: number | undefined): Promise<string> {
  if (config.githubAppId && config.githubAppPrivateKey && installationId !== undefined) {
    const { token } = await api<{ token: string }>(
      appJwt(),
      "POST",
      `/app/installations/${installationId}/access_tokens`,
      undefined,
      "Bearer",
    );
    return token;
  }
  if (config.githubToken) return config.githubToken;
  throw new Error("Set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY, or GITHUB_TOKEN.");
}

/**
 * Git auth via an extra header in env-provided config, so the token never
 * appears in argv, the remote URL, or .git/config.
 */
export function gitAuthEnv(token: string): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}

export interface PullRequest {
  number: number;
  state: string;
  title: string;
  body: string | null;
  head: { sha: string };
  base: { ref: string; sha: string; repo: { clone_url: string } };
}

export function getPullRequest(token: string, repo: string, prNumber: number): Promise<PullRequest> {
  return api<PullRequest>(token, "GET", `/repos/${repo}/pulls/${prNumber}`);
}

/** Acknowledges a review request with 👀. Best effort. */
export async function reactToComment(token: string, repo: string, commentId: number): Promise<void> {
  await api(token, "POST", `/repos/${repo}/issues/comments/${commentId}/reactions`, { content: "eyes" }).catch(
    () => {},
  );
}

/** The commit GitHub diffs a PR against. */
export async function mergeBase(token: string, repo: string, base: string, head: string): Promise<string> {
  const compare = await api<{ merge_base_commit: { sha: string } }>(
    token,
    "GET",
    `/repos/${repo}/compare/${base}...${head}`,
  );
  return compare.merge_base_commit.sha;
}

/**
 * Shallow fetch of just the commits a review needs, no history: the PR head
 * (full tree, checked out; refs/pull/N/head also covers fork PRs), plus the
 * base branch tip (refs/pr/base, for review instructions) and the merge base
 * without blobs, which git fetches lazily for the files the diff touches.
 */
export async function checkoutPullRequest(opts: {
  dir: string;
  cloneUrl: string;
  prNumber: number;
  baseRef: string;
  headSha: string;
  mergeBaseSha: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  await mkdir(opts.dir, { recursive: true });
  await git(opts.dir, ["init", "--quiet"]);
  await git(opts.dir, ["remote", "add", "origin", opts.cloneUrl]);
  await git(
    opts.dir,
    ["fetch", "--quiet", "--depth=1", "origin", `+refs/pull/${opts.prNumber}/head:refs/pr/head`],
    opts.env,
  );
  await git(
    opts.dir,
    [
      "fetch",
      "--quiet",
      "--depth=1",
      "--filter=blob:none",
      "origin",
      `+refs/heads/${opts.baseRef}:refs/pr/base`,
      opts.mergeBaseSha,
    ],
    opts.env,
  );
  await git(opts.dir, ["checkout", "--quiet", "--detach", opts.headSha], opts.env);
}

const SEVERITY_LABEL = { high: "🔴 High", medium: "🟠 Medium", low: "🟡 Low" };

function commentBody(f: Finding): string {
  const parts = [`**${SEVERITY_LABEL[f.severity]}: ${f.title}**`, f.body];
  if (f.suggestion) parts.push(`**Suggested fix:** ${f.suggestion}`);
  return parts.join("\n\n");
}

export function reviewBody(result: ReviewResult, includeAll: boolean): string {
  const outside = result.findings.filter((f) => includeAll || !f.inDiff);
  const lines = [`### Claude review`, "", result.summary, ""];
  lines.push(
    result.findings.length === 0
      ? "No issues found."
      : `Found ${result.findings.length} issue(s)${result.dropped ? ` (${result.dropped} more discarded by verification)` : ""}.`,
  );
  if (outside.length) {
    lines.push("", includeAll ? "#### Findings" : "#### Findings outside the diff", "");
    for (const f of outside) lines.push(`- \`${f.file}:${f.line}\` ${commentBody(f).replace(/\n\n/g, " — ")}`);
  }
  return lines.join("\n");
}

/**
 * Posts one COMMENT review (never approves or requests changes). Falls back to
 * a summary-only review if GitHub rejects an inline position.
 */
export async function postReview(opts: {
  token: string;
  repo: string;
  prNumber: number;
  headSha: string;
  result: ReviewResult;
}): Promise<void> {
  const path = `/repos/${opts.repo}/pulls/${opts.prNumber}/reviews`;
  const comments = opts.result.findings
    .filter((f) => f.inDiff)
    .map((f) => ({ path: f.file, line: f.line, side: "RIGHT", body: redactSecrets(commentBody(f)) }));
  try {
    await api(opts.token, "POST", path, {
      commit_id: opts.headSha,
      event: "COMMENT",
      body: redactSecrets(reviewBody(opts.result, false)),
      comments,
    });
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 422 && comments.length > 0)) throw error;
    await api(opts.token, "POST", path, {
      commit_id: opts.headSha,
      event: "COMMENT",
      body: redactSecrets(reviewBody(opts.result, true)),
    });
  }
}
