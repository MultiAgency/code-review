// Replays PRs whose comments carry `ai-review-ledger` labels and scores our review against them:
//   node dist/backtest.js --repo owner/name --pr 212 [--pr 94] [--all-rounds] [--out results.json]
//                         [--parallel 3] [--resume] [--multi-pass]
//   node dist/backtest.js --rescore results.json       (score saved results again, no review runs)
// Matching is judged by an agent (same defect?) unless --line-window N is given.
// By default only each PR's last labelled commit is replayed (one paid review per PR); --all-rounds
// replays every round. Each case's instructions (REVIEW.md, imports) come from its merge base, so an
// old PR is judged by the rules it was written under. --resume skips cases already in --out, which is
// rewritten after every case. Uses `gh` for GitHub and the same config as the CLI. Never posts.
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { loadConfigOrExit, reviewOptions } from "./config.js";
import { agentRunnerFor } from "./token-pool.js";
import {
  agentJudge,
  judgedScore,
  ledgerCases,
  score,
  type EvalCase,
} from "./eval.js";
import { readFile } from "node:fs/promises";
import type { Finding } from "./review.js";
import { git } from "./git.js";
import { reviewChanges } from "./review.js";
import { openLocalWorkspace } from "./workspace.js";

const run = promisify(execFile);
const gh = async <T>(...args: string[]): Promise<T> =>
  JSON.parse(
    (await run("gh", args, { maxBuffer: 64 * 1024 * 1024 })).stdout,
  ) as T;

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    pr: { type: "string", multiple: true },
    "all-rounds": { type: "boolean", default: false },
    "line-window": { type: "string" },
    out: { type: "string" },
    rescore: { type: "string" },
    parallel: { type: "string", default: "3" },
    resume: { type: "boolean", default: false },
    "multi-pass": { type: "boolean", default: false },
    samples: { type: "string" },
    "extra-passes": { type: "string" },
    "earlier-rounds": { type: "boolean", default: false },
  },
});
if (!values.rescore && (!values.repo || !values.pr?.length)) {
  console.error(
    "usage: backtest --repo owner/name --pr N [--pr N ...] [--all-rounds] [--line-window N] [--out file]",
  );
  console.error("       backtest --rescore results.json [--line-window N]");
  process.exit(1);
}
const config = loadConfigOrExit();
const agent = agentRunnerFor(config, (f) => console.error(JSON.stringify(f)));
// The judge runs on the same tokens as the reviews, with their rotation; a failed judge call leaves
// the case unjudged (out of recall) rather than counting it as a miss.
const judge = agentJudge(
  agentRunnerFor(config, (f) => console.error(JSON.stringify(f)), {
    model: undefined,
    effort: "low",
    maxBudgetUsd: 0.5,
    maxTurns: 3,
    timeoutMs: 5 * 60_000,
  }),
  await mkdtemp(join(tmpdir(), "judge-")),
);
const scoreCase = (c: EvalCase, findings: Finding[]) =>
  values["line-window"]
    ? Promise.resolve(
        score(c.expected, findings, { window: Number(values["line-window"]) }),
      )
    : judgedScore(c.expected, findings, judge);

function report(
  label: string,
  c: EvalCase,
  findings: Finding[],
  s: Awaited<ReturnType<typeof scoreCase>>,
  costUsd: number,
) {
  console.log(
    `${label}: recall ${s.hits.length}/${c.expected.length}, precision vs labels ${s.hits.length}/${findings.length}, $${costUsd.toFixed(2)}`,
  );
  for (const h of s.hits)
    console.log(
      `  hit    ${h.expected.id} ${h.expected.gist ?? ""}\n         ~ ${h.found.file}:${h.found.line} ${h.found.title}`,
    );
  for (const m of s.misses)
    console.log(`  missed ${m.id} ${m.path}:${m.line} ${m.gist ?? ""}`);
  for (const u of s.unjudged)
    console.log(`  unjudged ${u.id} ${u.path}:${u.line} (the judge failed; --resume asks again)`);
  for (const e of s.extras)
    console.log(`  extra  ${e.file}:${e.line} ${e.title}`);
}

if (values.rescore) {
  const saved = JSON.parse(await readFile(values.rescore, "utf8")) as Array<{
    pr: string;
    sha: string;
    expected: EvalCase["expected"];
    findings: Finding[];
    costUsd: number;
  }>;
  let expected = 0;
  let hits = 0;
  let unjudged = 0;
  for (const r of saved) {
    const s = await scoreCase({ sha: r.sha, expected: r.expected }, r.findings);
    report(
      `#${r.pr}@${r.sha.slice(0, 7)}`,
      { sha: r.sha, expected: r.expected },
      r.findings,
      s,
      r.costUsd,
    );
    expected += r.expected.length - s.unjudged.length;
    hits += s.hits.length;
    unjudged += s.unjudged.length;
  }
  console.log(`\nTotal: recall ${hits}/${expected}${unjudged ? `; ${unjudged} unjudged, left out` : ""}.`);
  process.exit(0);
}
const repo = values.repo!;

const cloneDir = join(await mkdtemp(join(tmpdir(), "backtest-")), "repo");
await run("git", ["clone", "--quiet", `https://github.com/${repo}`, cloneDir]);

type Result = {
  pr: string;
  sha: string;
  expected: EvalCase["expected"];
  findings: Finding[];
  checked: string[];
  score: unknown;
  costUsd: number;
};
const results: Result[] =
  values.resume && values.out
    ? JSON.parse(await readFile(values.out, "utf8").catch(() => "[]"))
    : [];
// Cases the judge couldn't answer last time are judged again.
for (const r of results) {
  if ((r.score as { unjudged?: unknown[] }).unjudged?.length)
    r.score = await scoreCase({ sha: r.sha, expected: r.expected }, r.findings);
}
if (values.out && results.length) await writeFile(values.out, JSON.stringify(results, null, 2));
const done = new Set(results.map((r) => `${r.pr}@${r.sha}`));
const options = {
  ...reviewOptions(config),
  ...(values["multi-pass"] ? { singlePass: false } : {}),
  ...(values.samples ? { samples: Number(values.samples) } : {}),
  ...(values["extra-passes"]
    ? { extraPasses: values["extra-passes"].split(",") }
    : {}),
};

// Gather every case first; git fetches and worktree changes share one repo, so they run one at a time.
const todo: Array<{ pr: string; c: EvalCase; title: string; body: string }> =
  [];
for (const pr of values.pr!) {
  const comments = await gh<Array<Array<{ body: string }>>>(
    "api",
    "--paginate",
    "--slurp",
    `repos/${repo}/issues/${pr}/comments`,
  ).then((pages) => pages.flat());
  const { title, body } = await gh<{ title: string; body: string }>(
    "pr",
    "view",
    pr,
    "-R",
    repo,
    "--json",
    "title,body",
  );
  let cases = ledgerCases(comments);
  // --earlier-rounds: every round but the last, as a second tuning set that leaves final rounds held out.
  if (values["earlier-rounds"])
    cases = cases.slice(0, -1).filter((c) => c.sha && c.expected.length);
  else if (!values["all-rounds"]) cases = cases.slice(-1);
  if (cases.length === 0) console.error(`#${pr}: no ai-review ledger found`);
  for (const c of cases) {
    if (done.has(`${pr}@${c.sha}`)) continue;
    try {
      await git(cloneDir, ["fetch", "--quiet", "origin", c.sha], {
        timeoutMs: 10 * 60_000,
      });
      todo.push({ pr, c, title, body });
    } catch {
      console.error(
        `#${pr}@${c.sha.slice(0, 7)}: commit no longer fetchable (force-pushed?), skipped`,
      );
    }
  }
}
const { stdout: defaultBranch } = await run("git", [
  "-C",
  cloneDir,
  "symbolic-ref",
  "--short",
  "refs/remotes/origin/HEAD",
]);

let gitLock: Promise<unknown> = Promise.resolve();
const serially = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = gitLock.then(fn, fn);
  gitLock = next.catch(() => {});
  return next;
};

async function runCase({ pr, c, title, body }: (typeof todo)[number]) {
  const label = `#${pr}@${c.sha.slice(0, 7)}`;
  const workspace = await serially(async () => {
    const mergeBase = (
      await git(cloneDir, ["merge-base", defaultBranch.trim(), c.sha])
    ).trim();
    return openLocalWorkspace({
      repoDir: cloneDir,
      base: mergeBase,
      head: c.sha,
    });
  });
  try {
    const result = await reviewChanges(
      {
        workspace,
        title,
        description: body,
        log: (msg) => console.error(`[${label}] ${msg}`),
      },
      { agent, options },
    );
    const s = await scoreCase(c, result.findings);
    report(label, c, result.findings, s, result.costUsd);
    results.push({
      pr,
      sha: c.sha,
      expected: c.expected,
      findings: result.findings,
      checked: result.checked,
      score: s,
      costUsd: result.costUsd,
    });
    if (values.out)
      await writeFile(values.out, JSON.stringify(results, null, 2));
  } catch (error) {
    console.error(
      `${label}: failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await serially(() => workspace.dispose());
  }
}

let next = 0;
await Promise.all(
  Array.from(
    { length: Math.max(1, Math.min(Number(values.parallel), todo.length)) },
    async () => {
      while (next < todo.length) await runCase(todo[next++]!);
    },
  ),
);

const scored = results as Array<Result & { score: { hits: unknown[]; unjudged?: unknown[] } }>;
const unjudgedTotal = scored.reduce((n, r) => n + (r.score.unjudged?.length ?? 0), 0);
const expectedTotal = scored.reduce((n, r) => n + r.expected.length, 0) - unjudgedTotal;
const hitTotal = scored.reduce((n, r) => n + r.score.hits.length, 0);
const foundTotal = scored.reduce((n, r) => n + r.findings.length, 0);
const costTotal = scored.reduce((n, r) => n + r.costUsd, 0);
console.log(
  `\nTotal over ${scored.length} case(s): recall ${hitTotal}/${expectedTotal}${expectedTotal ? ` (${Math.round((100 * hitTotal) / expectedTotal)}%)` : ""}, ` +
    `${unjudgedTotal ? `${unjudgedTotal} unjudged (left out; rerun with --resume), ` : ""}` +
    `${foundTotal} findings, $${costTotal.toFixed(2)}. "Extras" can be real bugs the labels missed: read them.`,
);
