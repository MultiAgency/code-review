// Measuring the reviewer against labelled PRs. Labels come from the hidden
// `ai-review-ledger` an existing reviewer leaves on each round's comment: the
// commit it reviewed, and every finding with its status at that commit.

export interface LedgerFinding {
  id: string;
  path: string;
  line: number;
  pass?: string;
  severity?: string;
  status: string;
  gist?: string;
}

/** One labelled case: at commit `sha`, these findings were still open. */
export interface EvalCase {
  sha: string;
  expected: LedgerFinding[];
}

const LEDGER = /<!-- ai-review-ledger (\{[\s\S]*?\}) -->/;

/** Cases from a PR's comments, in comment order; a later ledger for the same commit replaces an earlier one. */
export function ledgerCases(comments: Array<{ body?: string | null }>): EvalCase[] {
  const bySha = new Map<string, EvalCase>();
  for (const comment of comments) {
    const match = LEDGER.exec(comment.body ?? "");
    if (!match) continue;
    let ledger: { sha?: unknown; findings?: unknown };
    try {
      ledger = JSON.parse(match[1]!);
    } catch {
      continue;
    }
    if (typeof ledger.sha !== "string" || !Array.isArray(ledger.findings)) continue;
    const expected = (ledger.findings as LedgerFinding[]).filter(
      (f) => f && f.status === "open" && typeof f.path === "string" && typeof f.line === "number",
    );
    bySha.delete(ledger.sha);
    bySha.set(ledger.sha, { sha: ledger.sha, expected });
  }
  return [...bySha.values()];
}

export interface Found {
  file: string;
  line: number;
  title: string;
}

export interface Score<E, F> {
  hits: Array<{ expected: E; found: F }>;
  misses: E[];
  extras: F[];
  /** Share of expected findings matched. */
  recall: number;
  /**
   * Share of our findings that matched one. A lower bound: the labels can miss
   * real bugs too (on near-agencies#212 ours found one the ledger didn't).
   */
  precision: number;
}

/**
 * Matches each expected finding to the nearest unused one of ours in the same
 * file, within `window` lines. Line-based, so it can't tell two different bugs
 * on neighbouring lines apart; read the hits when the numbers matter.
 */
export function score<E extends LedgerFinding, F extends Found>(
  expected: E[],
  found: F[],
  options: { window: number },
): Score<E, F> {
  const used = new Set<number>();
  const hits: Array<{ expected: E; found: F }> = [];
  const misses: E[] = [];
  for (const e of expected) {
    let best = -1;
    for (let i = 0; i < found.length; i++) {
      const f = found[i]!;
      if (used.has(i) || f.file !== e.path) continue;
      const distance = Math.abs(f.line - e.line);
      if (distance > options.window) continue;
      if (best < 0 || distance < Math.abs(found[best]!.line - e.line)) best = i;
    }
    if (best < 0) misses.push(e);
    else {
      used.add(best);
      hits.push({ expected: e, found: found[best]! });
    }
  }
  const extras = found.filter((_, i) => !used.has(i));
  return {
    hits,
    misses,
    extras,
    recall: expected.length ? hits.length / expected.length : 1,
    precision: found.length ? hits.length / found.length : 1,
  };
}
