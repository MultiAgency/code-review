import assert from "node:assert/strict";
import { test } from "node:test";
import { ledgerCases, score } from "../src/eval.ts";

const ledger = (sha: string, findings: unknown[]) =>
  `## AI review\n\nprose\n\n<!-- ai-review-ledger ${JSON.stringify({ sha, findings })} -->`;

const F = (id: string, path: string, line: number, status: string, severity = "Important") => ({
  id,
  path,
  line,
  pass: "Bugs",
  severity,
  status,
  gist: `gist ${id}`,
});

test("ledgerCases: one labelled case per reviewed commit, expecting the findings still open there", () => {
  const cases = ledgerCases([
    { body: "unrelated comment" },
    { body: ledger("aaa", [F("F1", "lib/a.mjs", 10, "open"), F("F2", "lib/b.mjs", 5, "open", "Nit")]) },
    { body: ledger("bbb", [F("F1", "lib/a.mjs", 10, "fixed"), F("F2", "lib/b.mjs", 5, "open", "Nit"), F("F3", "lib/c.mjs", 1, "open")]) },
    { body: "<!-- ai-review-ledger {not json -->" },
  ]);
  assert.deepEqual(
    cases.map((c) => [c.sha, c.expected.map((e) => e.id)]),
    [
      ["aaa", ["F1", "F2"]],
      ["bbb", ["F2", "F3"]],
    ],
  );
  assert.equal(cases[1]!.expected[0]!.severity, "Nit");
});

test("score: matches by file and a line window, each finding used once", () => {
  const expected = [F("F1", "lib/a.mjs", 100, "open"), F("F2", "lib/a.mjs", 300, "open"), F("F3", "lib/b.mjs", 5, "open")];
  const found = [
    { file: "lib/a.mjs", line: 108, title: "near F1" },
    { file: "lib/a.mjs", line: 104, title: "also near F1" },
    { file: "lib/b.mjs", line: 60, title: "too far from F3" },
    { file: "lib/z.mjs", line: 1, title: "elsewhere" },
  ];
  const s = score(expected, found, { window: 15 });
  assert.deepEqual(s.hits.map((h) => [h.expected.id, h.found.title]), [["F1", "also near F1"]]);
  assert.deepEqual(s.misses.map((m) => m.id), ["F2", "F3"]);
  assert.deepEqual(s.extras.map((e) => e.title), ["near F1", "too far from F3", "elsewhere"]);
  assert.equal(s.recall, 1 / 3);
  assert.equal(s.precision, 1 / 4);
});

test("score: nothing expected and nothing found is a perfect score, not NaN", () => {
  const s = score([], [], { window: 15 });
  assert.equal(s.recall, 1);
  assert.equal(s.precision, 1);
});
