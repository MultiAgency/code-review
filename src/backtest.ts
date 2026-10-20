// Replays PRs whose comments carry `ai-review-ledger` labels and scores our review against them:
//   node dist/backtest.js --repo owner/name --pr 212 [--pr 94] [--all-rounds] [--window 15] [--out results.json]
// By default only each PR's last labelled commit is replayed (one paid review per PR); --all-rounds
// replays every round. Uses `gh` for GitHub and the same config as the CLI. Never posts.
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { sdkAgentRunner } from "./agent.js";
import { agentOptions, loadConfig, reviewOptions } from "./config.js";
import { ledgerCases, score } from "./eval.js";
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
    window: { type: "string", default: "15" },
    out: { type: "string" },
  },
});
if (!values.repo || !values.pr?.length) {
  console.error("usage: backtest --repo owner/name --pr N [--pr N ...] [--all-rounds] [--window 15] [--out file]");
  process.exit(1);
}
const repo = values.repo;
const window = Number(values.window);
const config = loadConfig();
const agent = sdkAgentRunner(agentOptions(config));

const cloneDir = join(await mkdtemp(join(tmpdir(), "backtest-")), "repo");
await run("git", ["clone", "--quiet", `https://github.com/${repo}`, cloneDir]);

const results: unknown[] = [];
let expectedTotal = 0;
let hitTotal = 0;
let foundTotal = 0;
let costTotal = 0;

for (const pr of values.pr) {
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
      const s = score(c.expected, result.findings, { window });
      expectedTotal += c.expected.length;
      hitTotal += s.hits.length;
      foundTotal += result.findings.length;
      costTotal += result.costUsd;
      console.log(
        `${label}: recall ${s.hits.length}/${c.expected.length}, precision vs labels ${s.hits.length}/${result.findings.length}, $${result.costUsd.toFixed(2)}`,
      );
      // Matching is by file and line window only: check each hit really is the same bug.
      for (const h of s.hits) console.log(`  hit    ${h.expected.id} ${h.expected.gist ?? ""}\n         ~ ${h.found.file}:${h.found.line} ${h.found.title}`);
      for (const m of s.misses) console.log(`  missed ${m.id} ${m.path}:${m.line} ${m.gist ?? ""}`);
      for (const e of s.extras) console.log(`  extra  ${e.file}:${e.line} ${e.title}`);
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
