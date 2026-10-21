import assert from "node:assert/strict";
import { test } from "node:test";
import { runReviewJob, type JobDeps } from "../src/job.ts";
import { githubPublisher } from "../src/publisher.ts";
import { parseState } from "../src/report.ts";
import type { ReviewJob } from "../src/triggers.ts";
import { openPullRequestWorkspace } from "../src/workspace.ts";
import { fakeGitHub } from "./support/fake-github.ts";
import { gitRepo } from "./support/git-repo.ts";
import { ok, scriptedAgent } from "./support/scripted-agent.ts";

/** A PR on a file:// "GitHub": main + feature with one commit. */
function pr() {
  const repo = gitRepo();
  const base = repo.commit({ "src/a.ts": "a\n" }, "base");
  repo.git("checkout", "-q", "-b", "feature");
  const head = repo.commit({ "src/a.ts": "a\nbug()\n" }, "pr");
  return {
    ...repo,
    base,
    head,
    cloneUrl: `file://${repo.dir}`,
    push(files: Record<string, string>) {
      return repo.commit(files, "push");
    },
  };
}

const bug = {
  file: "src/a.ts",
  line: 2,
  severity: "high",
  category: "correctness",
  title: "bug() throws",
  body: "Always throws.",
  existing_code: "bug()",
};

const job = (over: Partial<ReviewJob> = {}): ReviewJob => ({
  repo: "o/r",
  prNumber: 1,
  reason: "opened",
  ...over,
});

function deps(
  gh: ReturnType<typeof fakeGitHub>,
  agent: JobDeps["agent"],
): JobDeps {
  return {
    agent,
    reviewOptions: { verify: false, inlineDiffChars: 100_000 },
    maxInline: 10,
    gh: gh.gh,
    gitEnv: async () => ({}),
    publisher: githubPublisher({
      gh: gh.gh,
      repo: "o/r",
      prNumber: 1,
      isOwnComment: (c) => c.performed_via_github_app?.id === 42,
    }),
    openWorkspace: openPullRequestWorkspace,
    log: () => {},
  };
}

const signal = () => new AbortController().signal;

test("an opened PR gets a full review, posted inline with a summary", async () => {
  const p = pr();
  const gh = fakeGitHub({ head: p.head, base: p.base, cloneUrl: p.cloneUrl });
  const { runner, requests } = scriptedAgent(() =>
    ok({ summary: "One bug.", findings: [bug] }),
  );
  const outcome = await runReviewJob(job(), deps(gh, runner), signal());
  assert.equal(outcome.kind, "done");
  assert.match(requests[0]!.prompt, /\+bug\(\)/);
  assert.equal(gh.state.reviews.length, 1);
  assert.equal(parseState(gh.state.comments[0]!.body!)!.head, p.head);
});

test("a re-review comment after new commits reviews only those commits and passes earlier findings", async () => {
  const p = pr();
  const gh = fakeGitHub({ head: p.head, base: p.base, cloneUrl: p.cloneUrl });
  await runReviewJob(
    job(),
    deps(gh, scriptedAgent(() => ok({ summary: "s", findings: [bug] })).runner),
    signal(),
  );

  gh.state.head = p.push({ "src/b.ts": "new()\n" });
  const second = scriptedAgent(() => ok({ summary: "s", findings: [] }));
  const outcome = await runReviewJob(
    job({ reason: "comment", commentId: 5 }),
    deps(gh, second.runner),
    signal(),
  );
  assert.equal(outcome.kind, "done");
  const prompt = second.requests[0]!.prompt;
  assert.match(prompt, /\+new\(\)/);
  assert.doesNotMatch(prompt, /\+bug\(\)/);
  assert.match(prompt, /Findings from earlier reviews[\s\S]*bug\(\) throws/);
  assert.match(gh.state.comments[0]!.body!, /changes since/);
  assert.match(gh.state.comments[0]!.body!, /Still open from earlier reviews/);
});

/** Reviews a PR once, then pushes a commit; returns what a second review needs. */
async function reviewedThenPushed(
  compare?: (first: string, next: string) => Record<string, string>,
) {
  const p = pr();
  const first = fakeGitHub({
    head: p.head,
    base: p.base,
    cloneUrl: p.cloneUrl,
  });
  await runReviewJob(
    job(),
    deps(
      first,
      scriptedAgent(() => ok({ summary: "s", findings: [bug] })).runner,
    ),
    signal(),
  );
  const next = p.push({ "src/b.ts": "new()\n" });
  const gh = fakeGitHub({
    head: next,
    base: p.base,
    cloneUrl: p.cloneUrl,
    ...(compare ? { compare: compare(p.head, next) } : {}),
  });
  gh.state.comments.push(...first.state.comments);
  return gh;
}

test("`@private-review full` reviews the whole PR and resolves fixed findings", async () => {
  const gh = await reviewedThenPushed();
  const second = scriptedAgent(() => ok({ summary: "s", findings: [] }));
  await runReviewJob(
    job({ reason: "comment", full: true }),
    deps(gh, second.runner),
    signal(),
  );
  assert.match(second.requests[0]!.prompt, /\+bug\(\)/);
  assert.match(gh.state.comments[0]!.body!, /Resolved since the last review/);
});

test("after a force-push, a re-review is full", async () => {
  const gh = await reviewedThenPushed((first, next) => ({
    [`${first}...${next}`]: "diverged",
  }));
  const second = scriptedAgent(() => ok({ summary: "s", findings: [] }));
  await runReviewJob(
    job({ reason: "comment" }),
    deps(gh, second.runner),
    signal(),
  );
  assert.match(second.requests[0]!.prompt, /\+bug\(\)/);
  assert.doesNotMatch(gh.state.comments[0]!.body!, /changes since/);
});

test("a usage-limit failure is reported on the PR and not retried", async () => {
  const p = pr();
  const gh = fakeGitHub({ head: p.head, base: p.base, cloneUrl: p.cloneUrl });
  const { runner } = scriptedAgent(() => ({
    ok: false,
    failure: "auth_or_limit",
    detail: "429",
    costUsd: 0,
  }));
  const outcome = await runReviewJob(job(), deps(gh, runner), signal());
  assert.deepEqual(
    [
      outcome.kind,
      outcome.kind === "failed" && outcome.reason,
      outcome.kind === "failed" && outcome.transient,
    ],
    ["failed", "usage_limit", false],
  );
  assert.match(gh.state.comments[0]!.body!, /usage limit/);
  assert.equal(gh.state.reactions.at(-1)!.content, "confused");
});

test("a fetch failure is reported as a transient git failure", async () => {
  const p = pr();
  const gh = fakeGitHub({
    head: p.head,
    base: p.base,
    cloneUrl: "file:///does/not/exist",
  });
  const outcome = await runReviewJob(
    job(),
    deps(gh, scriptedAgent().runner),
    signal(),
  );
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.kind === "failed" && outcome.reason, "git");
  assert.equal(outcome.kind === "failed" && outcome.transient, true);
});

test("a closed PR is skipped without a review", async () => {
  const p = pr();
  const gh = fakeGitHub({
    head: p.head,
    base: p.base,
    cloneUrl: p.cloneUrl,
    prState: "closed",
  });
  const outcome = await runReviewJob(
    job(),
    deps(gh, scriptedAgent().runner),
    signal(),
  );
  assert.equal(outcome.kind, "skipped");
});
