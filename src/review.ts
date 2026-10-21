import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AgentFailureKind, AgentRunner } from "./agent.js";
import { place, type Placement } from "./placement.js";
import { reviewPrompt, verifyPrompt } from "./prompts.js";
import {
  DEFAULT_SEVERITIES,
  parsePlan,
  passesToRun,
  severityLabels,
  toSeverity,
  type Pass,
  type Severity,
} from "./review-plan.js";
import type { ChangedFile, Workspace } from "./workspace.js";

export type { Placement } from "./placement.js";

const Category = z.enum([
  "correctness",
  "security",
  "concurrency",
  "memory_safety",
  "compatibility",
  "resource_leak",
  "error_handling",
  "performance",
  "other",
]);

// The verify pass may not remove these: they are the findings most likely to be
// real yet hard to prove from reading code, and the costliest to miss.
const PROTECTED_CATEGORIES = new Set<string>([
  "concurrency",
  "memory_safety",
  "compatibility",
]);

/** The review pass's output; `severity` takes the repository's own labels when it defines them. */
function reviewOutput(severities: [string, ...string[]]) {
  return z.object({
    summary: z
      .string()
      .describe("2-5 sentence overview of the change and its overall risk."),
    checked: z
      .array(z.string())
      .describe(
        "The functions and paths you actually traced, each in a few words (e.g. 'settleSourceClaim and its 2 callers').",
      ),
    findings: z.array(
      z.object({
        file: z
          .string()
          .describe(
            "Path relative to the repo root, as it appears in the diff.",
          ),
        line: z
          .number()
          .int()
          .describe("Line number in the NEW version of the file."),
        severity: z.enum(severities),
        category: Category.describe(
          "compatibility = a change in behaviour or contract that existing callers or users depend on.",
        ),
        title: z.string().describe("One-line statement of the defect."),
        body: z
          .string()
          .describe("What goes wrong, under which inputs or state, and why."),
        existing_code: z
          .string()
          .describe(
            "The exact lines the finding is about, copied verbatim from the new version of the file.",
          ),
        suggestion: z
          .string()
          .optional()
          .describe("Concrete fix in prose, if obvious."),
        fix_code: z
          .string()
          .optional()
          .describe(
            "Replacement for existing_code, line for line, when the fix is confined to those lines.",
          ),
      }),
    ),
  });
}

type RawFinding = z.infer<ReturnType<typeof reviewOutput>>["findings"][number];

const VerifyOutput = z.object({
  verdicts: z.array(
    z.object({
      index: z.number().int(),
      keep: z
        .boolean()
        .describe(
          "false only with proof the finding is wrong; true otherwise.",
        ),
      reason: z
        .string()
        .describe(
          "For keep=false: the proof, quoting the code that disproves it.",
        ),
    }),
  ),
});

export type Finding = Omit<RawFinding, "severity"> & {
  severity: Severity;
  /** The repository's name for the severity (e.g. "Important"), when it defines its own. */
  label?: string;
  /** The REVIEW.md pass that reported it (e.g. "Security"), when the repository defines passes. */
  pass?: string;
  placement: Placement;
};

/** A finding from an earlier review that is still open. */
export interface PriorFinding {
  file: string;
  line: number;
  title: string;
  body: string;
}

/**
 * verified: the verify pass checked every finding. unverified: it failed, so
 * findings are reported unchecked. skipped: verification is off or nothing to verify.
 */
export type Verification = "verified" | "unverified" | "skipped";

export interface ReviewResult {
  summary: string;
  findings: Finding[];
  /** Findings the verify pass disproved. */
  dropped: number;
  /** Changed files left out of the review (lockfiles, build output...). */
  skipped: number;
  /** What the review passes say they traced. */
  checked: string[];
  verification: Verification;
  costUsd: number;
}

export interface ReviewOptions {
  verify: boolean;
  /** Diffs longer than this go to a file the agent reads instead of the prompt. */
  inlineDiffChars: number;
  /** Spend cap for the whole review: 80% shared by the review passes, 20% for verify. */
  reviewBudgetUsd?: number;
  /** Review passes running at once (each is a Claude Code process). */
  maxParallelPasses?: number;
  /** One review pass covering every REVIEW.md pass, instead of one focused pass each. */
  singlePass?: boolean;
  /** Independent runs of each pass, merged; the verify pass removes duplicates between them. */
  samples?: number;
  /** With one combined pass: REVIEW.md passes (by name) that also get a focused pass of their own. */
  extraPasses?: string[];
}

export interface ReviewInput {
  workspace: Workspace;
  /** Still-open findings from earlier reviews, to be repeated verbatim if they still apply. */
  priorFindings?: PriorFinding[];
  title?: string;
  description?: string;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

/** The review pass failed, so there is nothing to report. */
export class ReviewFailedError extends Error {
  constructor(
    readonly failure: AgentFailureKind,
    readonly costUsd: number,
    detail: string,
  ) {
    super(`review pass failed (${failure}): ${detail}`);
  }
}

export async function reviewChanges(
  input: ReviewInput,
  deps: { agent: AgentRunner; options: ReviewOptions },
): Promise<ReviewResult> {
  const log = input.log ?? (() => {});
  const { agent, options } = deps;
  const ws = input.workspace;
  const diff = await ws.diff();
  if (diff.files.length === 0) {
    const summary = diff.skipped.length
      ? `Only files that aren't reviewed changed (${diff.skipped.length}: lockfiles, build output or vendored code).`
      : "No changes to review.";
    return { summary, findings: [], dropped: 0, skipped: diff.skipped.length, checked: [], verification: "skipped", costUsd: 0 };
  }

  const diffPath = join(ws.workDir, "pr.diff");
  await writeFile(diffPath, diff.text);
  const roots = [ws.repoDir, ws.workDir];
  // Instructions come from the base branch so a PR cannot rewrite its own review rules.
  const instructionFiles = await ws.instructions();
  const plan = parsePlan(instructionFiles.find((i) => i.name === "REVIEW.md")?.text);
  const labels = severityLabels(plan);
  const { passes, runs: runPasses } = passesToRun(plan, options);

  const promptFor = (pass: Pass | undefined) =>
    reviewPrompt({
      repoDir: ws.repoDir,
      repoDefinesWhatToReport: plan.passes.length > 0 || plan.severities.length > 0,
      severityLabels: plan.severities,
      instructions: instructionFiles.map((i) => `## ${i.name} (from the base branch)\n\n${i.text}`),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      changedFiles: diff.files.map(describeFile),
      ...(input.priorFindings?.length ? { priorFindingsJson: JSON.stringify(input.priorFindings, null, 2) } : {}),
      range: ws.range,
      diffSection:
        diff.text.length <= options.inlineDiffChars
          ? `\`\`\`diff\n${diff.text}\n\`\`\``
          : `The diff is large (${diff.text.length} characters). Read it from ${diffPath} in chunks.`,
      allPasses: plan.passes.map((p) => p.name),
      ...(pass ? { pass } : {}),
    });

  log(
    `review: ${diff.files.length} files (${diff.skipped.length} skipped), ${diff.text.length} diff chars, ` +
      `${passes.length} pass(es) × ${runPasses.length / passes.length} sample(s)`,
  );
  const schema = reviewOutput(labels);
  const passBudget =
    options.reviewBudgetUsd === undefined ? {} : { maxBudgetUsd: (options.reviewBudgetUsd * 0.8) / runPasses.length };
  const runs = await mapLimited(runPasses, options.maxParallelPasses ?? runPasses.length, (pass) =>
    agent.run({ prompt: promptFor(pass), schema, roots, signal: input.signal, ...passBudget }),
  );
  let costUsd = runs.reduce((sum, r) => sum + r.costUsd, 0);
  const failed = runs.find((r) => !r.ok);
  if (failed && !failed.ok) throw new ReviewFailedError(failed.failure, costUsd, failed.detail);

  const merged = mergeRuns(
    runs.map((r) => (r.ok ? r.data : undefined)),
    runPasses,
    passes,
    labels,
    ws.repoDir,
  );
  let findings = merged.findings;
  log(`review: ${findings.length} candidate findings, $${costUsd.toFixed(2)}`);

  let dropped = 0;
  let verification: Verification = "skipped";
  if (options.verify && findings.length > 0) {
    const verify = await agent.run({
      prompt: verifyPrompt({
        repoDir: ws.repoDir,
        diffPath,
        findingsJson: JSON.stringify(findings.map((f, index) => ({ index, ...f })), null, 2),
      }),
      schema: VerifyOutput,
      roots,
      signal: input.signal,
      ...(options.reviewBudgetUsd === undefined ? {} : { maxBudgetUsd: options.reviewBudgetUsd * 0.2 }),
    });
    costUsd += verify.costUsd;
    if (verify.ok) {
      const before = findings.length;
      findings = applyVerdicts(findings, verify.data.verdicts);
      dropped = before - findings.length;
      verification = "verified";
      log(`verify: kept ${findings.length}, dropped ${dropped}, total $${costUsd.toFixed(2)}`);
    } else {
      // The review already cost money; report its findings, labelled as unchecked.
      verification = "unverified";
      log(`verify: failed (${verify.failure}), keeping ${findings.length} unverified findings`);
    }
  }

  const changed = new Set(diff.files.map((f) => f.path));
  const placed: Finding[] = [];
  for (const f of findings) {
    // Only files in the diff are read, so a model-supplied path can't point elsewhere.
    const text = changed.has(f.file)
      ? await readFile(join(ws.repoDir, f.file), "utf8").catch(() => undefined)
      : undefined;
    placed.push({ ...f, placement: place(f, text, diff.commentable.get(f.file), changed.has(f.file)) });
  }
  const order = { high: 0, medium: 1, low: 2 };
  return {
    summary: merged.summaries.join("\n\n"),
    findings: placed.sort((a, b) => order[a.severity] - order[b.severity]),
    dropped,
    skipped: diff.skipped.length,
    checked: merged.checked,
    verification,
    costUsd,
  };
}

type RunOutput = z.infer<ReturnType<typeof reviewOutput>>;

/**
 * Merges the runs' findings, keeping the first report of a finding that
 * several passes or samples found (exact duplicates; the verify pass removes
 * reworded ones). With a combined pass, its summary speaks for the review.
 */
function mergeRuns(
  outputs: Array<RunOutput | undefined>,
  runPasses: Array<Pass | undefined>,
  passes: Array<Pass | undefined>,
  labels: [string, ...string[]],
  repoDir: string,
): { findings: Array<Omit<Finding, "placement">>; summaries: string[]; checked: string[] } {
  const seenIn = new Map<string, number>();
  const findings: Array<Omit<Finding, "placement">> = [];
  const summaries: string[] = [];
  const checked: string[] = [];
  const summarised = new Set<string | undefined>();
  outputs.forEach((data, n) => {
    if (!data) return;
    const pass = runPasses[n];
    if (!summarised.has(pass?.name) && !(pass && passes.includes(undefined))) {
      summarised.add(pass?.name);
      summaries.push(pass && passes.length > 1 ? `**${pass.name}:** ${data.summary}` : data.summary);
    }
    for (const item of data.checked ?? []) if (!checked.includes(item)) checked.push(item);
    for (const raw of data.findings) {
      const file = repoRelative(raw.file, repoDir);
      const key = `${file}\0${raw.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
      const firstRun = seenIn.get(key);
      if (firstRun !== undefined && firstRun !== n) continue;
      seenIn.set(key, n);
      findings.push({
        ...raw,
        file,
        severity: toSeverity(raw.severity, labels),
        ...(labels !== DEFAULT_SEVERITIES ? { label: raw.severity } : {}),
        ...(pass ? { pass: pass.name } : {}),
      });
    }
  });
  return { findings, summaries, checked };
}

/**
 * Applies the verify pass's verdicts. A finding the verifier skipped is kept, so
 * a truncated answer never hides a real bug; protected categories are removed
 * only as duplicates, and a duplicate only while the finding it points to stays.
 */
function applyVerdicts<F extends { category: string }>(
  findings: F[],
  verdicts: Array<{ index: number; keep: boolean; reason: string }>,
): F[] {
  const rejected = new Set<number>();
  for (const v of verdicts) {
    if (v.keep || rejected.has(v.index) || !findings[v.index]) continue;
    const duplicateOf = /^duplicate of (\d+)/i.exec(v.reason)?.[1];
    if (duplicateOf !== undefined) {
      const target = Number(duplicateOf);
      if (target !== v.index && findings[target] && !rejected.has(target)) rejected.add(v.index);
    } else if (!PROTECTED_CATEGORIES.has(findings[v.index]!.category)) {
      rejected.add(v.index);
    }
  }
  return findings.filter((_, index) => !rejected.has(index));
}

function describeFile(f: ChangedFile): string {
  return f.previousPath ? `- ${f.path} (${f.status} from ${f.previousPath})` : `- ${f.path} (${f.status})`;
}

/** Like Promise.all over `items`, with at most `limit` running at once; results keep their order. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Findings sometimes name files by absolute path or with a leading `./`. */
function repoRelative(file: string, repoDir: string): string {
  const prefix = repoDir.endsWith("/") ? repoDir : `${repoDir}/`;
  const stripped = file.startsWith(prefix) ? file.slice(prefix.length) : file;
  return stripped.replace(/^(\.\/)+/, "");
}
