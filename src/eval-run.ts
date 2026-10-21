// Runs eval cases: for each labelled round of each PR, review the commit against its merge base and
// score the findings against the labels. Never posts anything.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner } from "./agent.js";
import { ledgerCases, type EvalCase, type LedgerFinding, type Score } from "./eval.js";
import { git } from "./git.js";
import { mapLimited } from "./map-limited.js";
import { reviewChanges, type Finding, type ReviewOptions } from "./review.js";
import { openLocalWorkspace } from "./workspace.js";

/** Where the labels come from: a PR's title, body and comments (which carry the ledgers). */
export interface LedgerSource {
  pullRequest(pr: string): Promise<{
    title: string;
    body: string;
    comments: Array<{ body?: string | null }>;
  }>;
}

export type CaseScore = Score<LedgerFinding, Finding>;

export interface EvalResult {
  pr: string;
  sha: string;
  expected: LedgerFinding[];
  findings: Finding[];
  checked: string[];
  score: CaseScore;
  costUsd: number;
}

export interface EvalRunOptions {
  /** The repository to clone (a GitHub URL, or file:// in tests). */
  cloneUrl: string;
  /** Git auth for the clone and fetches, e.g. from `gitAuthEnv`. */
  gitEnv?: NodeJS.ProcessEnv;
  prs: string[];
  ledger: LedgerSource;
  agent: AgentRunner;
  options: ReviewOptions;
  score: (c: EvalCase, findings: Finding[]) => Promise<CaseScore>;
  /** last: each PR's last labelled round; all: every round; earlier: every round but the last. */
  rounds: "last" | "all" | "earlier";
  parallel: number;
  /** Results of an earlier run: those cases are skipped, and any unjudged ones are scored again. */
  previous?: EvalResult[];
  /** Hears every result as it lands (all results so far), e.g. to save them. */
  onResult?: (result: EvalResult, all: EvalResult[]) => Promise<void> | void;
  log?: (line: string) => void;
}

export async function runEval(o: EvalRunOptions): Promise<EvalResult[]> {
  const log = o.log ?? (() => {});
  const results = [...(o.previous ?? [])];
  for (const [i, r] of results.entries()) {
    if (r.score.unjudged?.length) {
      results[i] = { ...r, score: await o.score({ sha: r.sha, expected: r.expected }, r.findings) };
      await o.onResult?.(results[i]!, results);
    }
  }
  const done = new Set(results.map((r) => `${r.pr}@${r.sha}`));

  const tmp = await mkdtemp(join(tmpdir(), "eval-"));
  const repoDir = join(tmp, "repo");
  try {
    const env = o.gitEnv ? { env: o.gitEnv } : {};
    await git(tmp, ["clone", "--quiet", o.cloneUrl, repoDir], { timeoutMs: 30 * 60_000, ...env });
    const defaultBranch = (await git(repoDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();

    // Gather every case first; fetches and worktree changes share one repo, so they run one at a time.
    const todo: Array<{ pr: string; c: EvalCase; title: string; body: string }> = [];
    for (const pr of o.prs) {
      const { title, body, comments } = await o.ledger.pullRequest(pr);
      let cases = ledgerCases(comments);
      if (o.rounds === "earlier") cases = cases.slice(0, -1).filter((c) => c.sha && c.expected.length);
      else if (o.rounds === "last") cases = cases.slice(-1);
      if (cases.length === 0) log(`#${pr}: no ai-review ledger found`);
      for (const c of cases) {
        if (done.has(`${pr}@${c.sha}`)) continue;
        try {
          await git(repoDir, ["fetch", "--quiet", "origin", c.sha], { timeoutMs: 10 * 60_000, ...env });
          todo.push({ pr, c, title, body });
        } catch {
          log(`#${pr}@${c.sha.slice(0, 7)}: commit no longer fetchable (force-pushed?), skipped`);
        }
      }
    }

    let gitLock: Promise<unknown> = Promise.resolve();
    const serially = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = gitLock.then(fn, fn);
      gitLock = next.catch(() => {});
      return next;
    };

    await mapLimited(todo, o.parallel, async ({ pr, c, title, body }) => {
      const label = `#${pr}@${c.sha.slice(0, 7)}`;
      // Instructions come from the merge base, so an old PR is judged by the rules it was written under.
      const workspace = await serially(async () => {
        const mergeBase = (await git(repoDir, ["merge-base", defaultBranch, c.sha])).trim();
        return openLocalWorkspace({ repoDir, base: mergeBase, head: c.sha });
      });
      try {
        const review = await reviewChanges(
          { workspace, title, description: body, log: (msg) => log(`[${label}] ${msg}`) },
          { agent: o.agent, options: o.options },
        );
        const result: EvalResult = {
          pr,
          sha: c.sha,
          expected: c.expected,
          findings: review.findings,
          checked: review.checked,
          score: await o.score(c, review.findings),
          costUsd: review.costUsd,
        };
        results.push(result);
        await o.onResult?.(result, results);
      } catch (error) {
        log(`${label}: failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await serially(() => workspace.dispose());
      }
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return results;
}

/** Totals over results; unjudged expected findings are left out of recall. */
export function evalTotals(results: EvalResult[]) {
  const unjudged = results.reduce((n, r) => n + (r.score.unjudged?.length ?? 0), 0);
  const expected = results.reduce((n, r) => n + r.expected.length, 0) - unjudged;
  const hits = results.reduce((n, r) => n + r.score.hits.length, 0);
  return {
    cases: results.length,
    expected,
    hits,
    unjudged,
    recall: expected ? hits / expected : 1,
    findings: results.reduce((n, r) => n + r.findings.length, 0),
    costUsd: results.reduce((n, r) => n + r.costUsd, 0),
  };
}
