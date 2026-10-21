// What a repository's REVIEW.md asks for, and which review runs that turns into.

export type Severity = "high" | "medium" | "low";

export interface Pass {
  name: string;
  focus: string;
}

/** The passes and severities REVIEW.md defines (both empty when it defines none). */
export interface ReviewPlan {
  passes: Pass[];
  severities: string[];
}

export const DEFAULT_SEVERITIES: [string, ...string[]] = ["high", "medium", "low"];

/**
 * Reads `## Passes` and `## Severity` sections: each top-level `- **Name:** …`
 * bullet (with its indented lines) is one pass or severity, in order.
 */
export function parsePlan(reviewMd: string | undefined): ReviewPlan {
  const section = (title: RegExp) => {
    const lines = (reviewMd ?? "").split("\n");
    const start = lines.findIndex((l) => /^#{2,3}\s/.test(l) && title.test(l));
    if (start < 0) return [];
    const end = lines.findIndex((l, i) => i > start && /^#{1,3}\s/.test(l));
    const items: Pass[] = [];
    for (const line of lines.slice(start + 1, end < 0 ? undefined : end)) {
      const top = /^[-*]\s+\*\*(.+?):?\*\*:?\s*(.*)$/.exec(line);
      if (top) items.push({ name: top[1]!.replace(/:$/, "").trim(), focus: top[2]!.trim() });
      else if (items.length && /^\s+\S/.test(line)) items.at(-1)!.focus += `\n${line}`;
    }
    return items;
  };
  return { passes: section(/passes/i), severities: section(/severit/i).map((s) => s.name) };
}

/** The severity names findings must use: the repository's, or ours. */
export function severityLabels(plan: ReviewPlan): [string, ...string[]] {
  return plan.severities.length > 0 ? (plan.severities as [string, ...string[]]) : DEFAULT_SEVERITIES;
}

/** Repository severities map onto ours by position: first is high, last is low. */
export function toSeverity(label: string, labels: string[]): Severity {
  if (labels === DEFAULT_SEVERITIES) return label as Severity;
  const i = labels.indexOf(label);
  if (i === 0) return "high";
  if (i === labels.length - 1 && labels.length > 1) return "low";
  return "medium";
}

/**
 * The passes to run: one focused pass per REVIEW.md pass, or (in one-pass mode,
 * or with no passes defined) one combined pass (`undefined`) plus any named
 * extra passes. Each is then run `samples` times.
 */
export function passesToRun(
  plan: ReviewPlan,
  options: { singlePass?: boolean; extraPasses?: string[]; samples?: number },
): { passes: Array<Pass | undefined>; runs: Array<Pass | undefined> } {
  const extra = new Set((options.extraPasses ?? []).map((n) => n.toLowerCase()));
  const passes: Array<Pass | undefined> =
    plan.passes.length > 0 && !options.singlePass
      ? plan.passes
      : [undefined, ...plan.passes.filter((p) => extra.has(p.name.toLowerCase()))];
  const samples = Math.max(1, options.samples ?? 1);
  return { passes, runs: passes.flatMap((pass) => Array.from({ length: samples }, () => pass)) };
}
