// Replays PRs whose comments carry `ai-review-ledger` labels and scores our review against them:
//   node dist/backtest.js --repo owner/name --pr 212 [--pr 94] [--all-rounds] [--out results.json]
//   node dist/backtest.js --rescore results.json       (score saved results again, no review runs)
// Matching is judged by an agent (same defect?) unless --line-window N is given.
// By default only each PR's last labelled commit is replayed (one paid review per PR); --all-rounds
// replays every round. Uses `gh` for GitHub and the same config as the CLI. Never posts.
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { sdkAgentRunner } from "./agent.js";
import { agentOptions, loadConfig, reviewOptions } from "./config.js";
import { agentJudge, judgedScore, ledgerCases, score, type EvalCase } from "./eval.js";
import { readFile } from "node:fs/promises";
import type { Finding } from "./review.js";
import { git } from "./git.js";
import { reviewChanges } from "./review.js";
import { openLocalWorkspace } from "./workspace.js";

const run = promisify(execFile);
const gh = async <T>(...args: string[]): Promise<T> =>
  JSON.parse((await run("gh", args, { maxBuffer: 64 * 1024 * 1024 })).stdout) as T;

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    pr: { type: "string", multiple: true },
    "all-rounds": { type: "boolean", default: false },
    "line-window": { type: "string" },
    out: { type: "string" },
    rescore: { type: "string" },
  },
});
if (!values.rescore && (!values.repo || !values.pr?.length)) {
  console.error("usage: backtest --repo owner/name --pr N [--pr N ...] [--all-rounds] [--line-window N] [--out file]");
  console.error("       backtest --rescore results.json [--line-window N]");
  process.exit(1);
}
const config = loadConfig();
const agent = sdkAgentRunner(agentOptions(config));
const judge = agentJudge(
  sdkAgentRunner({ effort: "low", maxBudgetUsd: 0.5, maxTurns: 3, timeoutMs: 5 * 60_000 }),
  await mkdtemp(join(tmpdir(), "judge-")),
);
const scoreCase = (c: EvalCase, findings: Finding[]) =>
  values["line-window"] ? Promise.resolve(score(c.expected, findings, { window: Number(values["line-window"]) })) : judgedScore(c.expected, findings, judge);

function report(label: string, c: EvalCase, findings: Finding[], s: Awaited<ReturnType<typeof scoreCase>>, costUsd: number) {
  console.log(`${label}: recall ${s.hits.length}/${c.expected.length}, precision vs labels ${s.hits.length}/${findings.length}, $${costUsd.toFixed(2)}`);
  for (const h of s.hits) console.log(`  hit    ${h.expected.id} ${h.expected.gist ?? ""}\n         ~ ${h.found.file}:${h.found.line} ${h.found.title}`);
  for (const m of s.misses) console.log(`  missed ${m.id} ${m.path}:${m.line} ${m.gist ?? ""}`);
  for (const e of s.extras) console.log(`  extra  ${e.file}:${e.line} ${e.title}`);
}

if (values.rescore) {
  const saved = JSON.parse(await readFile(values.rescore, "utf8")) as Array<{ pr: string; sha: string; expected: EvalCase["expected"]; findings: Finding[]; costUsd: number }>;
  let expected = 0;
  let hits = 0;
  for (const r of saved) {
    const s = await scoreCase({ sha: r.sha, expected: r.expected }, r.findings);
    report(`#${r.pr}@${r.sha.slice(0, 7)}`, { sha: r.sha, expected: r.expected }, r.findings, s, r.costUsd);
    expected += r.expected.length;
    hits += s.hits.length;
  }
  console.log(`\nTotal: recall ${hits}/${expected}.`);
  process.exit(0);
}
const repo = values.repo!;

const cloneDir = join(await mkdtemp(join(tmpdir(), "backtest-")), "repo");
await run("git", ["clone", "--quiet", `https://github.com/${repo}`, cloneDir]);

const results: unknown[] = [];
let expectedTotal = 0;
let hitTotal = 0;
let foundTotal = 0;
let costTotal = 0;

for (const pr of values.pr!) {
  const comments = await gh<Array<{ body: string }>>("api", "--paginate", "--slurp", `repos/${repo}/issues/${pr}/comments`).then(
    (pages) => (pages as unknown as Array<Array<{ body: string }>>).flat(),
  );
  const { baseRefName, title, body } = await gh<{ baseRefName: string; title: string; body: string }>(
    "pr", "view", pr, "-R", repo, "--json", "baseRefName,title,body",
  );
  let cases = ledgerCases(comments);
  if (!values["all-rounds"]) cases = cases.slice(-1);
  if (cases.length === 0) console.error(`#${pr}: no ai-review ledger found`);

  for (const c of cases) {
    const label = `#${pr}@${c.sha.slice(0, 7)}`;
    try {
      await git(cloneDir, ["fetch", "--quiet", "origin", c.sha], { timeoutMs: 10 * 60_000 });
    } catch {
      console.error(`${label}: commit no longer fetchable (force-pushed?), skipped`);
      continue;
    }
    const workspace = await openLocalWorkspace({ repoDir: cloneDir, base: `origin/${baseRefName}`, head: c.sha });
    try {
      const result = await reviewChanges(
        { workspace, title, description: body, log: (msg) => console.error(`[${label}] ${msg}`) },
        { agent, options: reviewOptions(config) },
      );
      const s = await scoreCase(c, result.findings);
      expectedTotal += c.expected.length;
      hitTotal += s.hits.length;
      foundTotal += result.findings.length;
      costTotal += result.costUsd;
      report(label, c, result.findings, s, result.costUsd);
      results.push({ pr, sha: c.sha, expected: c.expected, findings: result.findings, checked: result.checked, score: s, costUsd: result.costUsd });
    } finally {
      await workspace.dispose();
    }
  }
}

console.log(
  `\nTotal: recall ${hitTotal}/${expectedTotal}${expectedTotal ? ` (${Math.round((100 * hitTotal) / expectedTotal)}%)` : ""}, ` +
    `${foundTotal} findings, $${costTotal.toFixed(2)}. "Extras" can be real bugs the labels missed: read them.`,
);
if (values.out) await writeFile(values.out, JSON.stringify(results, null, 2));
