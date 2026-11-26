import { redactSecrets } from "./env.js";
import {
  fingerprint,
  type Finding,
  type PriorFinding,
  type ReviewResult,
} from "./review.js";

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

/**
 * One finding in a report: what is stored for it, whether an earlier review
 * had it open, and, when this review reported it, the finding itself.
 */
interface Entry {
  stored: StoredFinding;
  earlier: boolean;
  finding?: Finding & { fp: string };
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
  /**
   * Every finding as plain text, for a terminal or a log: no markdown, markers
   * or state. What was checked is a count unless `verbose`.
   */
  renderText(options?: { verbose?: boolean }): string;
  /** The review as data, for a caller that reads it by program: secrets redacted, no state. */
  renderData(): ReportData;
}

export interface ReportData {
  /** The commit that was reviewed. */
  head: string;
  summary: string;
  verification: ReviewResult["verification"];
  findings: Array<{
    file: string;
    line: number;
    severity: Finding["severity"];
    category: Finding["category"];
    title: string;
    body: string;
    existing_code: string;
    suggestion?: string;
    fix_code?: string;
  }>;
  /** What the review says it traced. */
  checked: string[];
  /** Changed files left out of the review (lockfiles, build output...). */
  skipped: number;
}

export type FailureReason =
  | "usage_limit"
  | "auth"
  | "overloaded"
  | "too_large"
  | "budget"
  | "timeout"
  | "bad_output"
  | "git"
  | "github"
  | "interrupted"
  | "unknown";

const FAILURE_TEXT: Record<FailureReason, string> = {
  usage_limit: "The reviewer's usage limit was reached.",
  auth: "The reviewer's model token was rejected (expired or revoked).",
  overloaded: "The model API was overloaded.",
  too_large: "This PR is too large to review in one pass.",
  budget: "The review hit its spending or turn limit.",
  timeout: "The review took too long and was stopped.",
  bad_output: "The reviewer didn't return a usable review.",
  git: "The PR's commits couldn't be fetched.",
  github: "A GitHub API call failed.",
  interrupted: "The service restarted during the review.",
  unknown: "Something unexpected went wrong.",
};

/** One sentence saying why a review failed. */
export function failureText(reason: FailureReason): string {
  return FAILURE_TEXT[reason];
}

export const SUMMARY_MARKER = "<!-- private-review:summary -->";
const STATE_PREFIX = "<!-- private-review:state ";
const MAX_BODY = 60_000;
const MAX_STATE_CHARS = 20_000;
const SEVERITY = {
  high: "🔴 High",
  medium: "🟠 Medium",
  low: "🟡 Low",
} as const;
const ICON = { high: "🔴", medium: "🟠", low: "🟡" } as const;

/** "🔴 Bugs · Important" when the repo names its passes and severities, else "🔴 High". */
function badge(f: Pick<Finding, "severity" | "pass" | "label">): string {
  const names = [f.pass, f.label].filter(Boolean).map((n) => clean(n!));
  return names.length
    ? `${ICON[f.severity]} ${names.join(" · ")}`
    : SEVERITY[f.severity];
}

export function parseState(body: string): ReviewState | undefined {
  const start = body.lastIndexOf(STATE_PREFIX);
  if (start < 0) return undefined;
  const end = body.indexOf(" -->", start);
  try {
    const state = JSON.parse(
      Buffer.from(
        body.slice(start + STATE_PREFIX.length, end),
        "base64",
      ).toString("utf8"),
    );
    return state?.v === 1 && Array.isArray(state.findings)
      ? (state as ReviewState)
      : undefined;
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
    /** The configured trigger phrase, which the summary invites people to comment. */
    trigger: string;
    /** Fingerprints an earlier attempt already commented, before its summary write failed. */
    alreadyPosted?: readonly string[];
  },
): ReviewReport {
  const trigger = clean(ctx.trigger);
  const priorByFp = new Map((ctx.prior?.findings ?? []).map((f) => [f.fp, f]));
  const alreadyPosted = new Set(ctx.alreadyPosted);
  const commentedBefore = (fp: string) =>
    priorByFp.get(fp)?.commented === true || alreadyPosted.has(fp);
  const current = result.findings.map((f) => ({
    ...f,
    fp: fingerprint(f.file, f.title),
  }));
  const currentFps = new Set(current.map((f) => f.fp));

  const inline: PlannedComment[] = [];
  const fileComments: PlannedComment[] = [];
  for (const f of current) {
    if (f.severity === "low" || commentedBefore(f.fp)) continue;
    if (f.placement.kind === "lines" && inline.length < ctx.maxInline) {
      inline.push({
        fp: f.fp,
        path: f.file,
        line: f.placement.end,
        ...(f.placement.end > f.placement.start
          ? { startLine: f.placement.start }
          : {}),
        body: commentBody(f, f.placement.exact),
      });
    } else if (
      f.placement.kind === "file" &&
      inline.length + fileComments.length < ctx.maxInline
    ) {
      fileComments.push({
        fp: f.fp,
        path: f.file,
        body: commentBody(f, false),
      });
    }
  }

  // A full review of a new head saw everything, so what it no longer reports is
  // resolved. An incremental one only saw the new commits: it resolves the
  // earlier findings the review found fixed, and the rest stay open.
  const sawEverything =
    ctx.mode === "full" &&
    ctx.prior !== undefined &&
    ctx.prior.head !== ctx.headSha;
  const fixed = new Set(ctx.mode === "incremental" ? result.resolved : []);
  const earlierOpen = (ctx.prior?.findings ?? []).filter(
    (f) => f.status === "open",
  );
  const earlierFps = new Set(earlierOpen.map((f) => f.fp));
  const notReported = earlierOpen.filter((f) => !currentFps.has(f.fp));
  const isResolved = (f: StoredFinding) => sawEverything || fixed.has(f.fp);

  /**
   * Every finding on the PR: what this review reported, new or found again,
   * and the earlier ones it didn't report, still open or resolved. The
   * summary, the plain text and the state are all read from it, so a finding
   * can't be counted in one place and missing from another.
   */
  const record = (posted: ReadonlySet<string>): Entry[] => [
    ...current.map((f) => ({
      finding: f,
      earlier: earlierFps.has(f.fp),
      stored: stored(f, "open", posted.has(f.fp) || commentedBefore(f.fp)),
    })),
    ...notReported.map((f) => ({
      earlier: true,
      stored: isResolved(f) ? { ...f, status: "resolved" as const } : f,
    })),
  ];
  const grouped = (entries: Entry[]) => ({
    fresh: entries.filter((e) => !e.earlier),
    stillOpen: entries.filter((e) => e.earlier && e.stored.status === "open"),
    resolved: entries.filter((e) => e.stored.status === "resolved"),
  });

  return {
    headSha: ctx.headSha,
    inline,
    fileComments,
    reviewBody: clean(
      `Inline findings for \`${ctx.headSha.slice(0, 7)}\`; see the summary comment for the rest.`,
    ),
    renderSummary(posted) {
      const entries = record(posted);
      const { fresh, stillOpen, resolved } = grouped(entries);
      const state: ReviewState = {
        v: 1,
        head: ctx.headSha,
        findings: entries.map((e) => e.stored),
      };
      const head = [
        SUMMARY_MARKER,
        `### Multi Review · \`${ctx.headSha.slice(0, 7)}\`${ctx.mode === "incremental" ? ` (changes since \`${ctx.prior!.head.slice(0, 7)}\`)` : ""}`,
        "",
      ];
      if (result.verification === "unverified") {
        head.push(
          "> ⚠️ Verification didn't complete, so these findings were not double-checked.",
          "",
        );
      }
      head.push(
        clean(result.summary),
        "",
        countsLine(
          fresh.length,
          fresh.filter((e) => e.stored.commented).length,
          stillOpen.length,
          resolved.length,
          result.dropped,
          true,
        ),
      );
      // What the review looked at, for telling "found nothing" from "didn't look"; folded away.
      if (result.checked.length) {
        const items = checkedItems(result.checked, clean);
        head.push(
          "",
          `<details><summary>What was checked (${areas(result.checked.length)})</summary>`,
          "",
          ...items.map((item) => `- ${item}`),
          "",
          "</details>",
        );
      }
      const footer = [
        "",
        `<sub>${result.skipped ? `${skippedText(result.skipped)} ` : ""}` +
          `Comment \`${trigger}\` to re-review new commits, or \`${trigger} full\` for a full review.</sub>`,
        `${STATE_PREFIX}${encodeState(state)} -->`,
      ];
      const sections: string[][] = [];
      if (fresh.length) {
        sections.push(["", "#### Findings", "", ...fresh.map(summaryEntry)]);
      }
      if (stillOpen.length) {
        sections.push([
          "",
          "#### Still open from earlier reviews",
          "",
          ...stillOpen.map(summaryEntry),
        ]);
      }
      if (resolved.length) {
        sections.push([
          "",
          "#### Resolved since the last review",
          "",
          ...resolved.map(
            (e) => `- ✅ ~~${clean(e.stored.title)}~~ \`${e.stored.file}\``,
          ),
        ]);
      }
      return fit(head, sections, footer);
    },
    renderText(options = {}) {
      const { fresh, stillOpen, resolved } = grouped(record(new Set()));
      const lines = [
        `Multi Review · ${ctx.headSha.slice(0, 7)}${ctx.mode === "incremental" ? ` (changes since ${ctx.prior!.head.slice(0, 7)})` : ""}`,
      ];
      if (result.verification === "unverified")
        lines.push(
          "Verification didn't complete, so these findings were not double-checked.",
        );
      lines.push(
        "",
        plain(result.summary),
        "",
        countsLine(
          fresh.length,
          0,
          stillOpen.length,
          resolved.length,
          result.dropped,
          false,
        ),
      );
      if (fresh.length) lines.push("", "Findings", ...fresh.map(textEntry));
      if (stillOpen.length)
        lines.push("", "Still open from earlier reviews", ...stillOpen.map(textEntry));
      if (resolved.length) {
        lines.push("", "Resolved since the last review");
        for (const e of resolved)
          lines.push(`  ✅ ${e.stored.file}  ${plain(e.stored.title)}`);
      }
      if (result.checked.length)
        lines.push(
          "",
          options.verbose
            ? ["Checked:", ...checkedItems(result.checked, plain).map((item) => `  - ${item}`)].join("\n")
            : `Checked ${areas(result.checked.length)}.`,
        );
      if (result.skipped) lines.push("", skippedText(result.skipped));
      return lines.join("\n");
    },
    renderData() {
      return {
        head: ctx.headSha,
        summary: plain(result.summary),
        verification: result.verification,
        findings: current.map((f) => ({
          file: f.file,
          line: f.line,
          severity: f.severity,
          category: f.category,
          title: plain(f.title),
          body: plain(f.body),
          existing_code: plain(f.existing_code),
          ...(f.suggestion ? { suggestion: plain(f.suggestion) } : {}),
          ...(f.fix_code ? { fix_code: plain(f.fix_code) } : {}),
        })),
        checked: result.checked.map(plain),
        skipped: result.skipped,
      };
    },
  };
}

function areas(n: number): string {
  return n === 1 ? "1 area" : `${n} areas`;
}

/** The checked list, each item escaped, cut off once it passes 1500 characters in all. */
function checkedItems(checked: string[], escape: (text: string) => string): string[] {
  const items: string[] = [];
  let length = 0;
  for (const raw of checked) {
    const item = escape(raw).replace(/\s+/g, " ").trim();
    if (length + item.length > 1500) {
      items.push(`…and ${checked.length - items.length} more`);
      break;
    }
    items.push(item);
    length += item.length;
  }
  return items;
}

function skippedText(skipped: number): string {
  return `Skipped ${skipped} file(s): lockfiles, build output or vendored code.`;
}

/** Summary comment for a review that failed; keeps the earlier state so nothing is lost. */
export function renderFailure(
  reason: FailureReason,
  ctx: { trigger: string; prior?: ReviewState | undefined },
): string {
  return statusComment(
    `😕 The review failed: ${FAILURE_TEXT[reason]} Comment \`${clean(ctx.trigger)}\` to retry.`,
    ctx.prior,
  );
}

/** Summary comment for a review waiting for the usage limit to reset. */
export function renderWaiting(until: number, prior?: ReviewState): string {
  const at = new Date(until).toISOString().slice(11, 16);
  return statusComment(
    `⏳ ${FAILURE_TEXT.usage_limit} The review will run again after it resets, at about ${at} UTC.`,
    prior,
  );
}

function statusComment(line: string, prior: ReviewState | undefined): string {
  return [
    SUMMARY_MARKER,
    "### Multi Review",
    "",
    line,
    ...(prior
      ? [
          "",
          `<sub>Earlier results for \`${prior.head.slice(0, 7)}\` are kept.</sub>`,
          `${STATE_PREFIX}${encodeState(prior)} -->`,
        ]
      : []),
  ].join("\n");
}

function commentBody(f: Finding & { fp: string }, exact: boolean): string {
  const heading =
    f.pass || f.label ? badge(f) : `${SEVERITY[f.severity]} · ${f.category}`;
  const parts = [`**${heading}: ${clean(f.title)}**`, clean(f.body)];
  if (f.suggestion) parts.push(`**Suggested fix:** ${clean(f.suggestion)}`);
  // A one-click suggestion only when it replaces exactly the quoted lines.
  if (exact && f.fix_code !== undefined)
    parts.push(
      "```suggestion\n" +
        redactSecrets(f.fix_code.replace(/```/g, "ˋˋˋ")) +
        "\n```",
    );
  return parts.join("\n\n");
}

/**
 * A finding in the summary. One with an inline comment is a line pointing to
 * it; any other is shown in full, since the summary is the only place it is.
 */
function summaryEntry({ stored: s, finding: f }: Entry): string {
  const line = f?.placement.kind === "lines" ? f.placement.start : s.line;
  const head = `- ${f ? badge(f) : SEVERITY[s.severity]} \`${s.file}:${line}\``;
  if (s.commented) return `${head} ${clean(f?.title ?? s.title)} (commented inline)`;
  const text = [
    `${head} **${clean(f?.title ?? s.title)}**`,
    `  ${clean(f?.body ?? s.body).replace(/\n/g, "\n  ")}`,
  ];
  if (f?.suggestion)
    text.push(
      `  _Suggested fix:_ ${clean(f.suggestion).replace(/\n/g, "\n  ")}`,
    );
  return text.join("\n");
}

/** A finding as plain text, always in full: a terminal has no inline comments. */
function textEntry({ stored: s, finding: f }: Entry): string {
  const heading = f
    ? f.pass || f.label
      ? badge(f)
      : `${SEVERITY[f.severity]} · ${f.category}`
    : SEVERITY[s.severity];
  const indent = (text: string) => plain(text).replace(/\n/g, "\n    ");
  const lines = [`  ${plain(heading)}  ${s.file}:${s.line}  ${plain(f?.title ?? s.title)}`];
  const body = f?.body ?? s.body;
  if (body) lines.push(`    ${indent(body)}`);
  if (f?.suggestion) lines.push(`    Suggested fix: ${indent(f.suggestion)}`);
  return lines.join("\n");
}

function countsLine(
  found: number,
  posted: number,
  open: number,
  resolved: number,
  dropped: number,
  markdown: boolean,
): string {
  const issues = markdown ? `**${found} issue(s)**` : `${found} issue(s)`;
  const parts = [
    found === 0
      ? "No new issues found"
      : `${issues}${posted ? ` (${posted} commented inline)` : ""}`,
  ];
  if (open) parts.push(`${open} still open from earlier`);
  if (resolved) parts.push(`${resolved} resolved`);
  if (dropped) parts.push(`${dropped} discarded by verification`);
  return parts.join(" · ");
}

function stored(
  f: Finding & { fp: string },
  status: StoredFinding["status"],
  commented: boolean,
): StoredFinding {
  return {
    fp: f.fp,
    file: f.file,
    line: f.line,
    severity: f.severity,
    title: f.title.slice(0, 200),
    body: f.body.slice(0, 500),
    status,
    commented,
  };
}

/**
 * Keeps the hidden state small enough to always fit in the comment: drops
 * resolved findings first, then the least severe open ones.
 */
function encodeState(state: ReviewState): string {
  const rank = (f: StoredFinding) =>
    f.status === "resolved" ? 3 : { high: 0, medium: 1, low: 2 }[f.severity];
  const findings = [...state.findings].sort((a, b) => rank(a) - rank(b));
  let encoded = Buffer.from(JSON.stringify({ ...state, findings })).toString(
    "base64",
  );
  while (encoded.length > MAX_STATE_CHARS && findings.length > 0) {
    findings.pop();
    encoded = Buffer.from(JSON.stringify({ ...state, findings })).toString(
      "base64",
    );
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

/** Model-written text for a terminal or log: secrets redacted, control characters removed. */
function plain(text: string): string {
  return redactSecrets(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/**
 * Keeps the comment under GitHub's size limit by dropping entries from the
 * end of the longest section. The footer (with the state marker) always fits.
 */
function fit(head: string[], sections: string[][], footer: string[]): string {
  const HEADER_LINES = 3; // "", "#### Title", ""
  const omitted = sections.map(() => 0);
  const main = () =>
    [
      ...head,
      ...sections.flatMap((s, i) =>
        omitted[i] ? [...s, `- …and ${omitted[i]} more not shown`] : s,
      ),
    ].join("\n");
  const tail = footer.join("\n");
  let body = main();
  while (body.length + tail.length + 1 > MAX_BODY) {
    let idx = -1;
    sections.forEach((s, i) => {
      if (
        s.length > HEADER_LINES &&
        (idx < 0 || s.length > sections[idx]!.length)
      )
        idx = i;
    });
    if (idx < 0) break;
    sections[idx]!.pop();
    omitted[idx]!++;
    body = main();
  }
  return `${body.slice(0, MAX_BODY - tail.length - 1)}\n${tail}`;
}
