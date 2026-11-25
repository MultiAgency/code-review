import assert from "node:assert/strict";
import { test } from "node:test";
import { runReviewJob, type JobDeps } from "../src/job.ts";
import { githubPublisher } from "../src/publisher.ts";
import { parseState } from "../src/report.ts";
import type { ReviewJob } from "../src/triggers.ts";
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
      trigger: "@multi-review",
    }),
    trigger: "@multi-review",
    log: () => {},
    timeoutMs: 60_000,
  };
}

/** What the queue hands a job: an abort signal, a spend meter and a save slot. */
function run(saved?: unknown) {
  const r = {
    signal: new AbortController().signal,
    spent: 0,
    queuedAt: Date.now(),
    saved,
    recordSpend(usd: number) {
      r.spent += usd;
    },
    save(data: unknown) {
      r.saved = data;
    },
  };
  return r;
}

test("an opened PR gets a full review, posted inline with a summary", async () => {
  const p = pr();
  const gh = fakeGitHub({ head: p.head, base: p.base, cloneUrl: p.cloneUrl });
  const { runner, requests } = scriptedAgent(() =>
    ok({ summary: "One bug.", findings: [bug] }),
  );
  const outcome = await runReviewJob(job(), deps(gh, runner), run());
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
    run(),
  );

  gh.state.head = p.push({ "src/b.ts": "new()\n" });
  const second = scriptedAgent(() => ok({ summary: "s", findings: [] }));
  const outcome = await runReviewJob(
    job({ reason: "comment", commentId: 5 }),
    deps(gh, second.runner),
    run(),
  );
  assert.equal(outcome.kind, "done");
  const prompt = second.requests[0]!.prompt;
  assert.match(prompt, /\+new\(\)/);
  assert.doesNotMatch(prompt, /\+bug\(\)/);
  assert.match(prompt, /Findings from earlier reviews[\s\S]*bug\(\) throws/);
  assert.match(gh.state.comments[0]!.body!, /changes since/);
  assert.match(gh.state.comments[0]!.body!, /Still open from earlier reviews/);
});

test("a re-review of new commits that fix an earlier finding marks it resolved in the summary", async () => {
  const p = pr();
  const gh = fakeGitHub({ head: p.head, base: p.base, cloneUrl: p.cloneUrl });
  await runReviewJob(
    job(),
    deps(gh, scriptedAgent(() => ok({ summary: "s", findings: [bug] })).runner),
    run(),
  );

  gh.state.head = p.push({ "src/a.ts": "a\n" });
  const second = scriptedAgent(() =>
    ok({
      summary: "s",
      findings: [],
      resolved: [{ index: 0, reason: "bug() was removed" }],
    }),
  );
  await runReviewJob(
    job({ reason: "comment", commentId: 5 }),
    deps(gh, second.runner),
    run(),
  );
  const body = gh.state.comments[0]!.body!;
  assert.match(body, /changes since/);
  assert.match(body, /Resolved since the last review[\s\S]*bug\(\) throws/);
  assert.doesNotMatch(body, /Still open from earlier reviews/);
  assert.equal(parseState(body)!.findings[0]!.status, "resolved");
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
    run(),
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

test("`@multi-review full` reviews the whole PR and resolves fixed findings", async () => {
  const gh = await reviewedThenPushed();
  const second = scriptedAgent(() => ok({ summary: "s", findings: [] }));
  await runReviewJob(
    job({ reason: "comment", full: true }),
    deps(gh, second.runner),
    run(),
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
    run(),
  );
  assert.match(second.requests[0]!.prompt, /\+bug\(\)/);
  assert.doesNotMatch(gh.state.comments[0]!.body!, /changes since/);
});

test("a usage limit with a known reset waits for it, saying so on the PR", async () => {
  const p = pr();
  const gh = fakeGitHub({ head: p.head, base: p.base, cloneUrl: p.cloneUrl });
  const until = Date.parse("2099-01-01T14:30:00Z");
  const r = { ...run(), queuedAt: until - 60 * 60_000 };
  const { runner } = scriptedAgent(() => ({ ok: false, failure: "usage_limit", detail: "429", costUsd: 0, retryAt: until }));
  const outcome = await runReviewJob(job(), deps(gh, runner), r);
  assert.deepEqual(outcome, { kind: "waiting", until, costUsd: 0 });
  assert.match(gh.state.comments[0]!.body!, /run again after it resets, at about 14:30 UTC/);
  assert.ok(!gh.state.reactions.some((x) => x.content === "confused"));
});

test("a usage limit that resets too late fails instead of waiting", async () => {
  const p = pr();
  const gh = fakeGitHub({ head: p.head, base: p.base, cloneUrl: p.cloneUrl });
  const r = run();
  const { runner } = scriptedAgent(() => ({
    ok: false,
    failure: "usage_limit",
    detail: "429",
    costUsd: 0,
    retryAt: r.queuedAt + 25 * 60 * 60_000,
  }));
  const outcome = await runReviewJob(job(), deps(gh, runner), r);
  assert.equal(outcome.kind === "failed" && outcome.reason, "usage_limit");
});

test("a rejected token or a too-large PR fails for good; an overloaded API is retried", async () => {
  const p = pr();
  for (const [failure, reason, transient] of [
    ["auth_rejected", "auth", false],
    ["too_large", "too_large", false],
    ["overloaded", "overloaded", true],
  ] as const) {
    const gh = fakeGitHub({ head: p.head, base: p.base, cloneUrl: p.cloneUrl });
    const { runner } = scriptedAgent(() => ({ ok: false, failure, detail: "x", costUsd: 0 }));
    const outcome = await runReviewJob(job(), deps(gh, runner), run());
    assert.deepEqual(
      outcome.kind === "failed" && [outcome.reason, outcome.transient],
      [reason, transient],
    );
  }
});

test("a usage-limit failure without a reset time is reported on the PR and not retried", async () => {
  const p = pr();
  const gh = fakeGitHub({ head: p.head, base: p.base, cloneUrl: p.cloneUrl });
  const { runner } = scriptedAgent(() => ({
    ok: false,
    failure: "usage_limit",
    detail: "429",
    costUsd: 0,
  }));
  const outcome = await runReviewJob(job(), deps(gh, runner), run());
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
    run(),
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
    run(),
  );
  assert.equal(outcome.kind, "skipped");
});

test("every Claude pass counts toward spend as it finishes, even when publishing then fails", async () => {
  const p = pr();
  const gh = fakeGitHub({ head: p.head, base: p.base, cloneUrl: p.cloneUrl, failCommentWrites: 2 });
  const r = run();
  const outcome = await runReviewJob(
    job(),
    deps(gh, scriptedAgent(() => ok({ summary: "s", findings: [bug] }, 0.4)).runner),
    r,
  );
  assert.equal(outcome.kind === "failed" && outcome.reason, "github");
  assert.equal(outcome.kind === "failed" && outcome.transient, true);
  assert.equal(r.spent, 0.4);
  assert.equal(outcome.kind === "failed" && outcome.costUsd, 0.4);
});

test("a finished review whose publishing failed is published on retry without running Claude again", async () => {
  const p = pr();
  const gh = fakeGitHub({ head: p.head, base: p.base, cloneUrl: p.cloneUrl, failCommentWrites: 2 });
  const first = run();
  await runReviewJob(job(), deps(gh, scriptedAgent(() => ok({ summary: "s", findings: [bug] })).runner), first);

  const retry = run(first.saved);
  const outcome = await runReviewJob(job(), deps(gh, scriptedAgent().runner), retry);
  assert.equal(outcome.kind, "done");
  assert.equal(retry.spent, 0);
  assert.equal(parseState(gh.state.comments[0]!.body!)!.findings[0]!.title, "bug() throws");
});

test("a saved review is not reused once the PR head has moved", async () => {
  const p = pr();
  const gh = fakeGitHub({ head: p.head, base: p.base, cloneUrl: p.cloneUrl, failCommentWrites: 2 });
  const first = run();
  await runReviewJob(job(), deps(gh, scriptedAgent(() => ok({ summary: "s", findings: [bug] })).runner), first);

  gh.state.head = p.push({ "src/b.ts": "new()\n" });
  const again = scriptedAgent(() => ok({ summary: "s", findings: [] }));
  const outcome = await runReviewJob(job(), deps(gh, again.runner), run(first.saved));
  assert.equal(outcome.kind, "done");
  assert.equal(again.requests.length, 1);
});

test("a retry after the summary failed doesn't post the inline comments again", async () => {
  const p = pr();
  const gh = fakeGitHub({ head: p.head, base: p.base, cloneUrl: p.cloneUrl, failCommentWrites: 2 });
  const first = run();
  await runReviewJob(job(), deps(gh, scriptedAgent(() => ok({ summary: "s", findings: [bug] })).runner), first);
  assert.equal(gh.state.reviews.length, 1);

  const outcome = await runReviewJob(job(), deps(gh, scriptedAgent().runner), run(first.saved));
  assert.equal(outcome.kind, "done");
  assert.equal(gh.state.reviews.length, 1);
  assert.equal(parseState(gh.state.comments[0]!.body!)!.findings[0]!.commented, true);
});

test("a review cut short during verify by a shutdown is not saved for the restarted job", async () => {
  const p = pr();
  const gh = fakeGitHub({ head: p.head, base: p.base, cloneUrl: p.cloneUrl });
  const shutdown = new AbortController();
  const r = run();
  r.signal = shutdown.signal;
  const agent = scriptedAgent(
    () => ok({ summary: "s", findings: [bug] }),
    () => {
      shutdown.abort(new Error("shutdown"));
      return { ok: false, failure: "aborted", detail: "", costUsd: 0.1 };
    },
  );
  const withVerify = { ...deps(gh, agent.runner), reviewOptions: { verify: true, inlineDiffChars: 100_000 } };
  await assert.rejects(runReviewJob(job(), withVerify, r));
  assert.equal(r.saved, undefined);
  assert.equal(r.spent, 0.2);
});
