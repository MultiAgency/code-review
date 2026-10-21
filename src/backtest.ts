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
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { loadConfigOrExit, reviewOptions } from "./config.js";
import { gitAuthEnv } from "./env.js";
import { agentJudge, judgedScore, score, type EvalCase } from "./eval.js";
import { evalTotals, runEval, type CaseScore, type EvalResult, type LedgerSource } from "./eval-run.js";
import type { Finding } from "./review.js";
import { agentRunnerFor } from "./token-pool.js";

const exec = promisify(execFile);
const gh = async <T>(...args: string[]): Promise<T> =>
  JSON.parse((await exec("gh", args, { maxBuffer: 64 * 1024 * 1024 })).stdout) as T;

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
  console.error("usage: backtest --repo owner/name --pr N [--pr N ...] [--all-rounds] [--line-window N] [--out file]");
  console.error("       backtest --rescore results.json [--line-window N]");
  process.exit(1);
}
const config = loadConfigOrExit();
const log = (f: Record<string, unknown>) => console.error(JSON.stringify(f));
// The judge runs on the same tokens as the reviews, with their rotation; a failed judge call leaves
// the case unjudged (out of recall) rather than counting it as a miss.
const judge = agentJudge(
  agentRunnerFor(config, log, { model: undefined, effort: "low", maxBudgetUsd: 0.5, maxTurns: 3, timeoutMs: 5 * 60_000 }),
  await mkdtemp(join(tmpdir(), "judge-")),
);
const scoreCase = (c: EvalCase, findings: Finding[]): Promise<CaseScore> =>
  values["line-window"]
    ? Promise.resolve(score(c.expected, findings, { window: Number(values["line-window"]) }))
    : judgedScore(c.expected, findings, judge);

function report(r: EvalResult) {
  const s = r.score;
  console.log(
    `#${r.pr}@${r.sha.slice(0, 7)}: recall ${s.hits.length}/${r.expected.length}, precision vs labels ${s.hits.length}/${r.findings.length}, $${r.costUsd.toFixed(2)}`,
  );
  for (const h of s.hits)
    console.log(`  hit    ${h.expected.id} ${h.expected.gist ?? ""}\n         ~ ${h.found.file}:${h.found.line} ${h.found.title}`);
  for (const m of s.misses) console.log(`  missed ${m.id} ${m.path}:${m.line} ${m.gist ?? ""}`);
  for (const u of s.unjudged ?? [])
    console.log(`  unjudged ${u.id} ${u.path}:${u.line} (the judge failed; --resume asks again)`);
  for (const e of s.extras) console.log(`  extra  ${e.file}:${e.line} ${e.title}`);
}

function totals(results: EvalResult[]) {
  const t = evalTotals(results);
  console.log(
    `\nTotal over ${t.cases} case(s): recall ${t.hits}/${t.expected}${t.expected ? ` (${Math.round(100 * t.recall)}%)` : ""}, ` +
      `${t.unjudged ? `${t.unjudged} unjudged (left out; rerun with --resume), ` : ""}` +
      `${t.findings} findings, $${t.costUsd.toFixed(2)}. "Extras" can be real bugs the labels missed: read them.`,
  );
}

if (values.rescore) {
  const saved = JSON.parse(await readFile(values.rescore, "utf8")) as EvalResult[];
  const rescored: EvalResult[] = [];
  for (const r of saved) {
    const result = { ...r, score: await scoreCase({ sha: r.sha, expected: r.expected }, r.findings) };
    report(result);
    rescored.push(result);
  }
  totals(rescored);
  process.exit(0);
}

const repo = values.repo!;
const ledger: LedgerSource = {
  async pullRequest(pr) {
    const comments = await gh<Array<Array<{ body: string }>>>(
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/issues/${pr}/comments`,
    ).then((pages) => pages.flat());
    const { title, body } = await gh<{ title: string; body: string }>("pr", "view", pr, "-R", repo, "--json", "title,body");
    return { title, body, comments };
  },
};
const previous: EvalResult[] =
  values.resume && values.out ? JSON.parse(await readFile(values.out, "utf8").catch(() => "[]")) : [];

const results = await runEval({
  cloneUrl: `https://github.com/${repo}`,
  // The checkout ignores host git config, so private repos need the gh login's token passed in.
  gitEnv: gitAuthEnv((await exec("gh", ["auth", "token"])).stdout.trim()),
  prs: values.pr!,
  ledger,
  agent: agentRunnerFor(config, log),
  options: {
    ...reviewOptions(config),
    ...(values["multi-pass"] ? { singlePass: false } : {}),
    ...(values.samples ? { samples: Number(values.samples) } : {}),
    ...(values["extra-passes"] ? { extraPasses: values["extra-passes"].split(",") } : {}),
  },
  score: scoreCase,
  rounds: values["earlier-rounds"] ? "earlier" : values["all-rounds"] ? "all" : "last",
  parallel: Number(values.parallel),
  previous,
  async onResult(result, all) {
    report(result);
    if (values.out) await writeFile(values.out, JSON.stringify(all, null, 2));
  },
  log: (line) => console.error(line),
});
totals(results);
