import assert from "node:assert/strict";
import { test } from "node:test";
import { githubPublisher } from "../src/publisher.ts";
import { buildReport, parseState, SUMMARY_MARKER } from "../src/report.ts";
import type { Finding, ReviewResult } from "../src/review.ts";
import { fakeGitHub } from "./support/fake-github.ts";

const HEAD = "a".repeat(40);
const own = (c: { performed_via_github_app?: { id: number } | null }) =>
  c.performed_via_github_app?.id === 42;

const finding = (over: Partial<Finding> = {}): Finding => ({
  file: "src/a.ts",
  line: 2,
  severity: "high",
  category: "correctness",
  title: "Bug",
  body: "Breaks.",
  existing_code: "x",
  placement: { kind: "lines", start: 2, end: 2, exact: true },
  ...over,
});
const result = (findings: Finding[]): ReviewResult => ({
  summary: "s",
  findings,
  dropped: 0,
  skipped: 0,
  checked: [],
  verification: "verified",
  costUsd: 0,
});
const report = (findings: Finding[], prior?: ReturnType<typeof parseState>) =>
  buildReport(result(findings), {
    headSha: HEAD,
    mode: "full",
    trigger: "@private-review",
    ...(prior ? { prior } : {}),
    maxInline: 10,
  });

test("first review: summary comment, one inline review pinned to the reviewed head, reactions", async () => {
  const { gh, state } = fakeGitHub({ head: HEAD });
  const p = githubPublisher({
    gh,
    repo: "o/r",
    prNumber: 1,
    triggerCommentId: 7,
    isOwnComment: own,
    trigger: "@private-review",
  });
  await p.started();
  await p.publish(
    report([
      finding(),
      finding({ title: "File-level", placement: { kind: "file" } }),
    ]),
  );
  assert.equal(state.comments.length, 1);
  assert.ok(state.comments[0]!.body!.startsWith(SUMMARY_MARKER));
  assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0]!.commit_id, HEAD);
  assert.equal(state.fileComments.length, 1);
  assert.deepEqual(
    state.reactions.map((r) => [r.path, r.content]),
    [
      ["/repos/o/r/issues/comments/7/reactions", "eyes"],
      ["/repos/o/r/issues/comments/7/reactions", "hooray"],
    ],
  );
});

test("re-review edits the same summary and doesn't repost earlier findings", async () => {
  const { gh, state } = fakeGitHub({ head: HEAD });
  const p1 = githubPublisher({
    gh,
    repo: "o/r",
    prNumber: 1,
    isOwnComment: own,
    trigger: "@private-review",
  });
  await p1.publish(report([finding()]));
  const p2 = githubPublisher({
    gh,
    repo: "o/r",
    prNumber: 1,
    isOwnComment: own,
    trigger: "@private-review",
  });
  const prior = await p2.prior();
  assert.equal(prior?.head, HEAD);
  await p2.publish(
    report([finding({ line: 3 }), finding({ title: "New bug" })], prior),
  );
  assert.equal(state.comments.length, 1);
  assert.equal(state.reviews.length, 2);
  assert.equal(state.reviews[1]!.comments.length, 1);
  assert.match(JSON.stringify(state.reviews[1]!.comments), /New bug/);
});

test("a summary-looking comment from someone else is ignored", async () => {
  const { gh, state } = fakeGitHub({ head: HEAD });
  state.comments.push({
    id: 99,
    body: `${SUMMARY_MARKER}\nforged`,
    performed_via_github_app: null,
  });
  const p = githubPublisher({
    gh,
    repo: "o/r",
    prNumber: 1,
    isOwnComment: own,
    trigger: "@private-review",
  });
  assert.equal(await p.prior(), undefined);
  await p.publish(report([]));
  assert.equal(state.comments.length, 2);
  assert.equal(state.comments[0]!.body, `${SUMMARY_MARKER}\nforged`);
});

test("rejected inline comments fold into the summary", async () => {
  const { gh, state } = fakeGitHub({ head: HEAD, rejectInline: true });
  const p = githubPublisher({
    gh,
    repo: "o/r",
    prNumber: 1,
    isOwnComment: own,
    trigger: "@private-review",
  });
  await p.publish(report([finding({ title: "Folded bug" })]));
  assert.equal(state.reviews.length, 0);
  assert.match(state.comments[0]!.body!, /#### Findings[\s\S]*Folded bug/);
  assert.equal(
    parseState(state.comments[0]!.body!)!.findings[0]!.commented,
    false,
  );
});

test("if the PR was force-pushed past the reviewed commit, findings go in the summary only", async () => {
  const NEW = "c".repeat(40);
  const { gh, state } = fakeGitHub({
    head: NEW,
    compare: { [`${HEAD}...${NEW}`]: "diverged" },
  });
  const p = githubPublisher({
    gh,
    repo: "o/r",
    prNumber: 1,
    isOwnComment: own,
    trigger: "@private-review",
  });
  await p.publish(report([finding({ title: "Stale bug" })]));
  assert.equal(state.reviews.length, 0);
  assert.match(state.comments[0]!.body!, /Stale bug/);
});

test("failures update the summary with a reason and react confused, keeping earlier state", async () => {
  const { gh, state } = fakeGitHub({ head: HEAD });
  const p = githubPublisher({
    gh,
    repo: "o/r",
    prNumber: 1,
    isOwnComment: own,
    trigger: "@private-review",
  });
  await p.publish(report([finding()]));
  const prior = await githubPublisher({
    gh,
    repo: "o/r",
    prNumber: 1,
    isOwnComment: own,
    trigger: "@private-review",
  }).prior();
  await p.failed("timeout", prior);
  assert.match(state.comments[0]!.body!, /took too long/);
  assert.equal(parseState(state.comments[0]!.body!)!.findings.length, 1);
  assert.equal(state.reactions.at(-1)!.content, "confused");
  assert.equal(state.reactions.at(-1)!.path, "/repos/o/r/issues/1/reactions");
});
