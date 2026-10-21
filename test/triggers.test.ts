import assert from "node:assert/strict";
import { test } from "node:test";
import { jobFromWebhook, mentionsTrigger } from "../src/triggers.ts";

const opts = { trigger: "@private-review", allowedRepos: [] as string[] };
const repository = { full_name: "acme/app" };

const pr = (
  action: string,
  draft = false,
  author: { association?: string; type?: string } = {},
) =>
  jobFromWebhook(
    "pull_request",
    {
      action,
      repository,
      installation: { id: 7 },
      pull_request: {
        number: 3,
        draft,
        author_association: author.association ?? "MEMBER",
        user: { login: "author", type: author.type ?? "User" },
      },
    },
    opts,
  );

const comment = (
  body: string,
  extra: {
    association?: string;
    senderType?: string;
    onIssue?: boolean;
    state?: string;
  } = {},
) =>
  jobFromWebhook(
    "issue_comment",
    {
      action: "created",
      repository,
      issue: {
        number: 3,
        state: extra.state ?? "open",
        ...(extra.onIssue ? {} : { pull_request: { url: "x" } }),
      },
      comment: {
        id: 99,
        body,
        author_association: extra.association ?? "MEMBER",
      },
      sender: { login: "dev", type: extra.senderType ?? "User" },
    },
    opts,
  );

test("reviews once when a PR becomes reviewable, never on push", () => {
  assert.deepEqual(pr("opened"), {
    job: { repo: "acme/app", prNumber: 3, installationId: 7, reason: "opened" },
  });
  assert.ok("job" in pr("ready_for_review"));
  assert.ok("skip" in pr("opened", true));
  assert.ok("skip" in pr("synchronize"));
  assert.ok("skip" in pr("reopened"));
});

test("automatic reviews only for trusted, human authors", () => {
  assert.ok("job" in pr("opened", false, { association: "OWNER" }));
  assert.ok("job" in pr("opened", false, { association: "COLLABORATOR" }));
  assert.ok("skip" in pr("opened", false, { association: "CONTRIBUTOR" }));
  assert.ok(
    "skip" in pr("opened", false, { association: "FIRST_TIME_CONTRIBUTOR" }),
  );
  assert.ok("skip" in pr("ready_for_review", false, { association: "NONE" }));
  assert.ok(
    "skip" in pr("opened", false, { association: "MEMBER", type: "Bot" }),
  );
});

test("on-demand review from a trusted comment", () => {
  const decision = comment("Thanks!\n@Private-Review please");
  assert.ok("job" in decision);
  assert.equal(decision.job.reason, "comment");
  assert.equal(decision.job.commentId, 99);
  assert.ok("job" in comment("@private-review", { association: "OWNER" }));
  const full = comment("@private-review full");
  assert.ok("job" in full && full.job.full === true);
  const plain = comment("@private-review please");
  assert.ok("job" in plain && plain.job.full === undefined);
});

test("ignores untrusted, bot, issue, closed and unrelated comments", () => {
  assert.ok(
    "skip" in comment("@private-review", { association: "CONTRIBUTOR" }),
  );
  assert.ok("skip" in comment("@private-review", { association: "NONE" }));
  assert.ok("skip" in comment("@private-review", { senderType: "Bot" }));
  assert.ok("skip" in comment("@private-review", { onIssue: true }));
  assert.ok("skip" in comment("@private-review", { state: "closed" }));
  assert.ok("skip" in comment("looks good"));
  assert.ok("skip" in comment("ping @private-reviewer"));
});

test("respects the repo allowlist", () => {
  const d = jobFromWebhook(
    "pull_request",
    {
      action: "opened",
      repository,
      pull_request: { number: 1, author_association: "OWNER" },
    },
    {
      ...opts,
      allowedRepos: ["acme/other"],
    },
  );
  assert.deepEqual(d, { skip: "repo not allowed" });
});

test("mentionsTrigger matches whole phrase at line start", () => {
  assert.ok(mentionsTrigger("  @private-review  ", "@private-review"));
  assert.ok(!mentionsTrigger("please @private-review", "@private-review"));
});
