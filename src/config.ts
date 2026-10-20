import { z } from "zod";
import type { SdkAgentOptions } from "./agent.js";
import type { ReviewOptions } from "./review.js";

const num = (fallback: number, check: (s: z.ZodNumber) => z.ZodNumber = (s) => s) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : Number(v)))
    .pipe(check(z.number({ error: (issue) => (issue.code === "invalid_type" ? "must be a number" : undefined) })));

const bool = (fallback: boolean) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return fallback;
      if (["true", "1"].includes(v)) return true;
      if (["false", "0"].includes(v)) return false;
      ctx.addIssue({ code: "custom", message: "must be true or false" });
      return z.NEVER;
    });

const optionalText = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));

const Env = z.object({
  // Unset = Claude Code's default model for the account.
  REVIEW_MODEL: optionalText,
  REVIEW_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  // Hard cap per agent pass (review and verify each get this much).
  REVIEW_MAX_BUDGET_USD: num(10, (s) => s.positive()),
  REVIEW_MAX_TURNS: num(80, (s) => s.int().positive()),
  REVIEW_PASS_TIMEOUT_MIN: num(20, (s) => s.positive()),
  REVIEW_JOB_TIMEOUT_MIN: num(50, (s) => s.positive()),
  // A second pass that tries to refute each finding.
  REVIEW_VERIFY: bool(true),
  // Off by default: reviews are only logged until you opt in.
  POST_REVIEWS: bool(false),
  // High/medium findings posted inline per review; the rest go in the summary.
  REVIEW_MAX_INLINE_COMMENTS: num(10, (s) => s.int().min(0)),
  // Diffs larger than this go to a file Claude reads instead of the prompt.
  REVIEW_INLINE_DIFF_CHARS: num(120_000, (s) => s.int().positive()),
  // A PR comment line starting with this requests a review.
  REVIEW_TRIGGER: z.string().trim().min(1).default("@private-review"),
  REVIEW_MAX_ATTEMPTS: num(3, (s) => s.int().min(1)),

  PORT: num(8080, (s) => s.int().min(1).max(65535)),
  MAX_CONCURRENT_REVIEWS: num(2, (s) => s.int().min(1)),
  // Persisted review jobs; put it on a volume so deploys don't lose them.
  QUEUE_DB: z.string().trim().min(1).default("/data/jobs.db"),
  // On SIGTERM, how long running reviews get to finish before they're re-queued.
  SHUTDOWN_GRACE_SECONDS: num(25, (s) => s.min(0)),

  GITHUB_WEBHOOK_SECRET: optionalText,
  // Comma-separated owner/repo list; empty means every repo the app is installed on.
  ALLOWED_REPOS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  GITHUB_API_URL: z.url().default("https://api.github.com"),
  GITHUB_APP_ID: optionalText,
  // PEM, raw or with literal "\n" sequences (common in PaaS env editors).
  GITHUB_APP_PRIVATE_KEY: optionalText.transform((v) => v?.replace(/\\n/g, "\n")),
  // Fallback when not running as a GitHub App (fine-grained PAT).
  GITHUB_TOKEN: optionalText,
});

export type Config = z.output<typeof Env>;

export class ConfigError extends Error {}

/** Reads and validates settings from the environment; throws one error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${problems.join("\n")}`);
  }
  return parsed.data;
}

/** The webhook service also needs a secret and a way to authenticate to GitHub. */
export function checkServiceConfig(config: Config): void {
  const problems: string[] = [];
  if (!config.GITHUB_WEBHOOK_SECRET) problems.push("  GITHUB_WEBHOOK_SECRET: required");
  const app = Boolean(config.GITHUB_APP_ID) || Boolean(config.GITHUB_APP_PRIVATE_KEY);
  if (app && !(config.GITHUB_APP_ID && config.GITHUB_APP_PRIVATE_KEY)) {
    problems.push("  GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY: set both, or neither");
  }
  if (!app && !config.GITHUB_TOKEN) problems.push("  GitHub auth: set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY, or GITHUB_TOKEN");
  if (problems.length) throw new ConfigError(`Invalid configuration:\n${problems.join("\n")}`);
}

export function agentOptions(config: Config): SdkAgentOptions {
  return {
    ...(config.REVIEW_MODEL ? { model: config.REVIEW_MODEL } : {}),
    effort: config.REVIEW_EFFORT,
    maxBudgetUsd: config.REVIEW_MAX_BUDGET_USD,
    maxTurns: config.REVIEW_MAX_TURNS,
    timeoutMs: config.REVIEW_PASS_TIMEOUT_MIN * 60_000,
  };
}

export function reviewOptions(config: Config): ReviewOptions {
  return { verify: config.REVIEW_VERIFY, inlineDiffChars: config.REVIEW_INLINE_DIFF_CHARS };
}
