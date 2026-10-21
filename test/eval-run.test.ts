import assert from "node:assert/strict";
import { test } from "node:test";
import { score } from "../src/eval.ts";
import { evalTotals, runEval, type EvalRunOptions } from "../src/eval-run.ts";
import { gitRepo } from "./support/git-repo.ts";
import { ok, scriptedAgent } from "./support/scripted-agent.ts";

/**
 * A PR with two labelled rounds. REVIEW.md changes on main after the PR branched, so a case must be
 * reviewed under the rules at its merge base.
 */
function labelledPr() {
  const repo = gitRepo();
  repo.commit({ "src/a.ts": "a\n", "REVIEW.md": "Old rules.\n" }, "base");
  repo.git("checkout", "-q", "-b", "feature");
  const round1 = repo.commit({ "src/a.ts": "a\nbug()\n" }, "round 1");
  const round2 = repo.commit({ "src/a.ts": "a\nbug()\nmore()\n" }, "round 2");
  repo.git("checkout", "-q", "main");
  repo.commit({ "REVIEW.md": "New rules.\n" }, "later rules");
  const ledger = (sha: string, ids: string[]) =>
    `<!-- ai-review-ledger ${JSON.stringify({
      sha,
      findings: ids.map((id) => ({ id, path: "src/a.ts", line: 2, status: "open", gist: `${id} bug` })),
    })} -->`;
  return {
    cloneUrl: `file://${repo.dir}`,
    round1,
    round2,
    ledger: {
      async pullRequest() {
        return {
          title: "Add bug",
          body: "",
          comments: [{ body: ledger(round1, ["F1"]) }, { body: ledger(round2, ["F1", "F2"]) }],
        };
      },
    },
  };
}

const finding = { file: "src/a.ts", line: 2, severity: "high", category: "correctness", title: "bug() throws", body: "b", existing_code: "bug()" };

function options(p: ReturnType<typeof labelledPr>, over: Partial<EvalRunOptions> = {}) {
  const agent = scriptedAgent(...Array.from({ length: 4 }, () => () => ok({ summary: "s", findings: [finding] }, 0.5)));
  const opts: EvalRunOptions = {
    cloneUrl: p.cloneUrl,
    prs: ["7"],
    ledger: p.ledger,
    agent: agent.runner,
    options: { verify: false, inlineDiffChars: 100_000 },
    score: async (c, found) => score(c.expected, found, { window: 3 }),
    rounds: "last",
    parallel: 2,
    ...over,
  };
  return { opts, requests: agent.requests };
}

test("reviews each PR's last labelled round under its merge base's rules, and scores it", async () => {
  const p = labelledPr();
  const { opts, requests } = options(p);
  const results = await runEval(opts);
  assert.deepEqual(results.map((r) => r.sha), [p.round2]);
  assert.match(requests[0]!.prompt, /Old rules\./);
  assert.doesNotMatch(requests[0]!.prompt, /New rules/);
  assert.deepEqual(evalTotals(results), { cases: 1, expected: 2, hits: 1, unjudged: 0, recall: 0.5, findings: 1, costUsd: 0.5 });
});

test("all rounds, saving each result as it lands", async () => {
  const p = labelledPr();
  const saved: number[] = [];
  const { opts } = options(p, { rounds: "all", onResult: (_r, all) => void saved.push(all.length) });
  const results = await runEval(opts);
  assert.deepEqual(results.map((r) => r.sha).sort(), [p.round1, p.round2].sort());
  assert.deepEqual(saved, [1, 2]);
});

test("resuming skips finished cases and judges unjudged ones again", async () => {
  const p = labelledPr();
  const first = await runEval(
    options(p, {
      score: async (c) => ({ hits: [], misses: [], unjudged: c.expected, extras: [], recall: 1, precision: 1 }),
    }).opts,
  );
  assert.equal(evalTotals(first).unjudged, 2);
  const { opts, requests } = options(p, { previous: first });
  const again = await runEval(opts);
  assert.equal(requests.length, 0);
  assert.deepEqual(evalTotals(again), { cases: 1, expected: 2, hits: 1, unjudged: 0, recall: 0.5, findings: 1, costUsd: 0.5 });
});

test("a round whose commit is gone is skipped with a note", async () => {
  const p = labelledPr();
  const lines: string[] = [];
  const gone = "f".repeat(40);
  const { opts } = options(p, {
    ledger: {
      async pullRequest() {
        return { title: "", body: "", comments: [{ body: `<!-- ai-review-ledger {"sha":"${gone}","findings":[]} -->` }] };
      },
    },
    log: (l) => lines.push(l),
  });
  assert.deepEqual(await runEval(opts), []);
  assert.ok(lines.some((l) => /no longer fetchable/.test(l)));
});
