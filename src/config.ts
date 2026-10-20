import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

function env(name: string, fallback?: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const value = env(name);
  return value === undefined ? fallback : value === "true" || value === "1";
}

export const config = {
  // Unset = Claude Code's default model for the account.
  model: env("REVIEW_MODEL"),
  effort: env("REVIEW_EFFORT", "high") as EffortLevel,
  // Hard cap per agent run (review and verify each get this much).
  maxBudgetUsd: Number(env("REVIEW_MAX_BUDGET_USD", "10")),
  maxTurns: Number(env("REVIEW_MAX_TURNS", "80")),
  // A second pass that tries to refute each finding and drops the ones it can.
  verify: bool("REVIEW_VERIFY", true),
  // Off by default: reviews are only logged until you opt in.
  postReviews: bool("POST_REVIEWS", false),
  // Diffs larger than this go to a file Claude reads instead of the prompt.
  inlineDiffChars: Number(env("REVIEW_INLINE_DIFF_CHARS", "120000")),

  // A PR comment line starting with this requests a (re-)review.
  reviewTrigger: env("REVIEW_TRIGGER", "@private-review")!,

  port: Number(env("PORT", "8080")),
  maxConcurrent: Number(env("MAX_CONCURRENT_REVIEWS", "2")),
  webhookSecret: env("GITHUB_WEBHOOK_SECRET"),
  // Comma-separated owner/repo list; empty means every repo the app is installed on.
  allowedRepos: (env("ALLOWED_REPOS") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  githubApiUrl: env("GITHUB_API_URL", "https://api.github.com")!,
  githubAppId: env("GITHUB_APP_ID"),
  // PEM, either raw or with literal "\n" sequences (common in PaaS env editors).
  githubAppPrivateKey: env("GITHUB_APP_PRIVATE_KEY")?.replace(/\\n/g, "\n"),
  // Fallback when not running as a GitHub App (fine-grained PAT).
  githubToken: env("GITHUB_TOKEN"),
};

// Variables the Claude subprocess may see. Everything else (GitHub credentials,
// the webhook secret) is withheld so a prompt-injected PR cannot read it back.
const CLAUDE_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_", "AWS_", "CLOUD_ML_", "GOOGLE_", "VERTEX_"];
const CLAUDE_ENV_NAMES = ["PATH", "HOME", "LANG", "TMPDIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"];

export function claudeEnv(): Record<string, string> {
  const out: Record<string, string> = { CLAUDE_AGENT_SDK_CLIENT_APP: "claude-pr-review/0.1.0" };
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (CLAUDE_ENV_NAMES.includes(key) || CLAUDE_ENV_PREFIXES.some((p) => key.startsWith(p))) {
      out[key] = value;
    }
  }
  return out;
}

const SECRET_NAMES = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/** Masks any secret env value that ends up in text we are about to publish. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [key, value] of Object.entries(process.env)) {
    if (value && value.length >= 12 && SECRET_NAMES.test(key)) {
      out = out.split(value).join("[redacted]");
    }
  }
  return out;
}
