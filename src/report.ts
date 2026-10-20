import { createHash } from "node:crypto";
import { redactSecrets } from "./env.js";
import type { Finding, PriorFinding, ReviewResult } from "./review.js";

/** What the summary comment remembers between reviews. */
export interface ReviewState {
  v: 1;
  /** Last commit reviewed. */
  head: string;
  findings: StoredFinding[];
}

export interface StoredFinding {
  fp: string;
  file: string;
  line: number;
  severity: Finding["severity"];
  title: string;
  body: string;
  status: "open" | "resolved";
  /** Already posted as an inline or file comment, so never posted again. */
  commented: boolean;
}

export interface PlannedComment {
  fp: string;
  path: string;
  /** Present for line comments; absent for file-level comments. */
  line?: number;
  startLine?: number;
  body: string;
}

export interface ReviewReport {
  headSha: string;
  /** Inline comments, posted together as one review. */
  inline: PlannedComment[];
  /** File-level comments, for findings on a changed file but not a commentable line. */
  fileComments: PlannedComment[];
  /** Body of the review that carries the inline comments. */
  reviewBody: string;
  /** The summary comment, given which planned comments actually got posted. */
  renderSummary(posted: ReadonlySet<string>): string;
}

export type FailureReason =
  | "usage_limit"
  | "budget"
  | "timeout"
  | "bad_output"
  | "git"
  | "github"
  | "interrupted"
  | "unknown";

const FAILURE_TEXT: Record<FailureReason, string> = {
  usage_limit: "Claude's usage limit was reached, or its token was rejected.",
  budget: "The review hit its spending or turn limit.",
  timeout: "The review took too long and was stopped.",
  bad_output: "Claude didn't return a usable review.",
  git: "The PR's commits couldn't be fetched.",
  github: "A GitHub API call failed.",
  interrupted: "The service restarted during the review.",
  unknown: "Something unexpected went wrong.",
};

export const SUMMARY_MARKER = "<!-- private-review:summary -->";
const STATE_PREFIX = "<!-- private-review:state ";
const MAX_BODY = 60_000;
const MAX_STATE_CHARS = 20_000;
const SEVERITY = { high: "🔴 High", medium: "🟠 Medium", low: "🟡 Low" } as const;
const ICON = { high: "🔴", medium: "🟠", low: "🟡" } as const;

/** "🔴 Bugs · Important" when the repo names its passes and severities, else "🔴 High". */
function badge(f: Pick<Finding, "severity" | "pass" | "label">): string {
  const names = [f.pass, f.label].filter(Boolean).map((n) => clean(n!));
  return names.length ? `${ICON[f.severity]} ${names.join(" · ")}` : SEVERITY[f.severity];
}

export function fingerprint(file: string, title: string): string {
  const norm = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return createHash("sha256").update(`${file}\0${norm}`).digest("hex").slice(0, 16);
}

export function parseState(body: string): ReviewState | undefined {
  const start = body.lastIndexOf(STATE_PREFIX);
  if (start < 0) return undefined;
  const end = body.indexOf(" -->", start);
  try {
    const state = JSON.parse(Buffer.from(body.slice(start + STATE_PREFIX.length, end), "base64").toString("utf8"));
    return state?.v === 1 && Array.isArray(state.findings) ? (state as ReviewState) : undefined;
  } catch {
    return undefined;
  }
}

/** Open findings from earlier reviews, to feed back into the review pass. */
export function priorFindings(state: ReviewState | undefined): PriorFinding[] {
  return (state?.findings ?? [])
    .filter((f) => f.status === "open")
    .map(({ file, line, title, body }) => ({ file, line, title, body }));
}

export function buildReport(
  result: ReviewResult,
  ctx: {
    headSha: string;
    /** full: the whole PR was reviewed; incremental: only commits since `prior.head`. */
    mode: "full" | "incremental";
    prior?: ReviewState;
    maxInline: number;
  },
): ReviewReport {
  const priorByFp = new Map((ctx.prior?.findings ?? []).map((f) => [f.fp, f]));
  const current = result.findings.map((f) => ({ ...f, fp: fingerprint(f.file, f.title) }));
  const currentFps = new Set(current.map((f) => f.fp));

  const inline: PlannedComment[] = [];
  const fileComments: PlannedComment[] = [];
  for (const f of current) {
    if (f.severity === "low" || priorByFp.get(f.fp)?.commented) continue;
    if (f.placement.kind === "lines" && inline.length < ctx.maxInline) {
      inline.push({
        fp: f.fp,
        path: f.file,
        line: f.placement.end,
        ...(f.placement.end > f.placement.start ? { startLine: f.placement.start } : {}),
        body: commentBody(f, f.placement.exact),
      });
    } else if (f.placement.kind === "file" && inline.length + fileComments.length < ctx.maxInline) {
      fileComments.push({ fp: f.fp, path: f.file, body: commentBody(f, false) });
    }
  }

  // An incremental review only saw new commits, so it can't tell whether older
  // findings were fixed. Only a full review of a new head resolves them.
  const canResolve = ctx.mode === "full" && ctx.prior !== undefined && ctx.prior.head !== ctx.headSha;
  const earlierOpen = (ctx.prior?.findings ?? []).filter((f) => f.status === "open" && !currentFps.has(f.fp));
  const resolved = canResolve ? earlierOpen : [];
  const stillOpen = canResolve ? [] : earlierOpen;

  return {
    headSha: ctx.headSha,
    inline,
    fileComments,
    reviewBody: clean(`Inline findings for \`${ctx.headSha.slice(0, 7)}\`; see the summary comment for the rest.`),
    renderSummary(posted) {
      const state: ReviewState = {
        v: 1,
        head: ctx.headSha,
        findings: [
          ...current.map((f) => stored(f, "open", posted.has(f.fp) || priorByFp.get(f.fp)?.commented === true)),
          ...stillOpen,
          ...resolved.map((f) => ({ ...f, status: "resolved" as const })),
        ],
      };
      const notCommented = current.filter((f) => !posted.has(f.fp) && !priorByFp.get(f.fp)?.commented);
      const head = [
        SUMMARY_MARKER,
        `### Claude review · \`${ctx.headSha.slice(0, 7)}\`${ctx.mode === "incremental" ? ` (changes since \`${ctx.prior!.head.slice(0, 7)}\`)` : ""}`,
        "",
      ];
      if (result.verification === "unverified") {
        head.push("> ⚠️ Verification didn't complete, so these findings were not double-checked.", "");
      }
      head.push(clean(result.summary), "", countsLine(current.length, posted.size, stillOpen.length, resolved.length, result.dropped));
      if (result.checked.length) head.push("", `_Checked: ${clean(result.checked.join("; ")).slice(0, 1500)}_`);
      const footer = [
        "",
        `<sub>${result.skipped ? `Skipped ${result.skipped} file(s): lockfiles, build output or vendored code. ` : ""}` +
          "Comment `@private-review` to re-review new commits, or `@private-review full` for a full review.</sub>",
        `${STATE_PREFIX}${encodeState(state)} -->`,
      ];
      const sections: string[][] = [];
      if (notCommented.length) {
        sections.push(["", "#### Findings", "", ...notCommented.map((f) => summaryEntry(f))]);
      }
      if (stillOpen.length) {
        sections.push(["", "#### Still open from earlier reviews", "", ...stillOpen.map((f) => `- ${SEVERITY[f.severity]} \`${f.file}:${f.line}\` ${clean(f.title)}`)]);
      }
      if (resolved.length) {
        sections.push(["", "#### Resolved since the last review", "", ...resolved.map((f) => `- ✅ ~~${clean(f.title)}~~ \`${f.file}\``)]);
      }
      return fit(head, sections, footer);
    },
  };
}

/** Summary comment for a review that failed; keeps the earlier state so nothing is lost. */
export function renderFailure(reason: FailureReason, prior?: ReviewState): string {
  return [
    SUMMARY_MARKER,
    "### Claude review",
    "",
    `😕 The review failed: ${FAILURE_TEXT[reason]} Comment \`@private-review\` to retry.`,
    ...(prior ? ["", `<sub>Earlier results for \`${prior.head.slice(0, 7)}\` are kept.</sub>`, `${STATE_PREFIX}${encodeState(prior)} -->`] : []),
  ].join("\n");
}

function commentBody(f: Finding & { fp: string }, exact: boolean): string {
  const heading = f.pass || f.label ? badge(f) : `${SEVERITY[f.severity]} · ${f.category}`;
  const parts = [`**${heading}: ${clean(f.title)}**`, clean(f.body)];
  if (f.suggestion) parts.push(`**Suggested fix:** ${clean(f.suggestion)}`);
  // A one-click suggestion only when it replaces exactly the quoted lines.
  if (exact && f.fix_code !== undefined) parts.push("```suggestion\n" + redactSecrets(f.fix_code.replace(/```/g, "ˋˋˋ")) + "\n```");
  return parts.join("\n\n");
}

function summaryEntry(f: Finding): string {
  const where = `\`${f.file}${f.placement.kind === "lines" ? `:${f.placement.start}` : `:${f.line}`}\``;
  const text = [`- ${badge(f)} ${where} **${clean(f.title)}**`, `  ${clean(f.body).replace(/\n/g, "\n  ")}`];
  if (f.suggestion) text.push(`  _Suggested fix:_ ${clean(f.suggestion).replace(/\n/g, "\n  ")}`);
  return text.join("\n");
}

function countsLine(found: number, posted: number, open: number, resolved: number, dropped: number): string {
  const parts = [found === 0 ? "No new issues found" : `**${found} issue(s)**${posted ? ` (${posted} commented inline)` : ""}`];
  if (open) parts.push(`${open} still open from earlier`);
  if (resolved) parts.push(`${resolved} resolved`);
  if (dropped) parts.push(`${dropped} discarded by verification`);
  return parts.join(" · ");
}

function stored(f: Finding & { fp: string }, status: StoredFinding["status"], commented: boolean): StoredFinding {
  return { fp: f.fp, file: f.file, line: f.line, severity: f.severity, title: f.title.slice(0, 200), body: f.body.slice(0, 500), status, commented };
}

/**
 * Keeps the hidden state small enough to always fit in the comment: drops
 * resolved findings first, then the least severe open ones.
 */
function encodeState(state: ReviewState): string {
  const rank = (f: StoredFinding) => (f.status === "resolved" ? 3 : { high: 0, medium: 1, low: 2 }[f.severity]);
  const findings = [...state.findings].sort((a, b) => rank(a) - rank(b));
  let encoded = Buffer.from(JSON.stringify({ ...state, findings })).toString("base64");
  while (encoded.length > MAX_STATE_CHARS && findings.length > 0) {
    findings.pop();
    encoded = Buffer.from(JSON.stringify({ ...state, findings })).toString("base64");
  }
  return encoded;
}

/**
 * Model-written text is untrusted: it can't open a one-click suggestion
 * block, forge our hidden markers, or carry a secret out.
 */
function clean(text: string): string {
  return redactSecrets(text)
    .replace(/```\s*suggestion/gi, "```text")
    .replace(/<!--/g, "&lt;!--");
}

/**
 * Keeps the comment under GitHub's size limit by dropping entries from the
 * end of the longest section. The footer (with the state marker) always fits.
 */
function fit(head: string[], sections: string[][], footer: string[]): string {
  const HEADER_LINES = 3; // "", "#### Title", ""
  const omitted = sections.map(() => 0);
  const main = () =>
    [...head, ...sections.flatMap((s, i) => (omitted[i] ? [...s, `- …and ${omitted[i]} more not shown`] : s))].join("\n");
  const tail = footer.join("\n");
  let body = main();
  while (body.length + tail.length + 1 > MAX_BODY) {
    let idx = -1;
    sections.forEach((s, i) => {
      if (s.length > HEADER_LINES && (idx < 0 || s.length > sections[idx]!.length)) idx = i;
    });
    if (idx < 0) break;
    sections[idx]!.pop();
    omitted[idx]!++;
    body = main();
  }
  return `${body.slice(0, MAX_BODY - tail.length - 1)}\n${tail}`;
}
