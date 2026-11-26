import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubError, type GitHubClient } from "../src/github.ts";
import { attemptTime, callbackDelivery, failedOutcome, purchaseAdmission, purchaseWanted } from "../src/purchase.ts";

/** GitHub answering one pull request lookup, and the list of the files it changes. */
function github(
  pr: { state?: string; private?: boolean; additions?: number; deletions?: number } | GitHubError,
  files = ["src/index.ts"],
) {
  const gh: GitHubClient = {
    async request<T>(): Promise<T> {
      if (pr instanceof GitHubError) throw pr;
      return {
        number: 1,
        state: pr.state ?? "open",
        title: "t",
        body: null,
        head: { sha: "h" },
        base: { ref: "main", sha: "b", repo: { clone_url: "u", private: pr.private ?? false } },
        additions: pr.additions ?? 10,
        deletions: pr.deletions ?? 5,
      } as T;
    },
    async list<T>(): Promise<T[]> {
      return files.map((filename) => ({ filename })) as T[];
    },
  };
  return gh;
}

const admit = (pr: Parameters<typeof github>[0], files?: string[]) => purchaseAdmission(github(pr, files), 100)("o/r", 1);

test("an open pull request in a public repository is admitted", async () => {
  assert.equal(await admit({}), undefined);
  assert.equal(await admit({ additions: 60, deletions: 40 }), undefined);
});

test("a pull request that can't be reviewed is refused with the reason", async () => {
  assert.equal((await admit({ private: true }))?.error, "private");
  assert.equal((await admit({ state: "closed" }))?.error, "not_open");
  assert.equal((await admit({ additions: 60, deletions: 41 }))?.error, "too_large");
  assert.equal((await admit(new GitHubError(404, "Not Found")))?.error, "not_found");
});

test("a pull request that changes only files a review leaves out is refused, before it is paid for", async () => {
  assert.equal((await admit({}, ["package-lock.json", "web/dist/app.js", "vendor/lib.go"]))?.error, "nothing_to_review");
  assert.equal(await admit({}, ["package-lock.json", "src/index.ts"]), undefined);
});

test("a GitHub failure is not mistaken for a refusal", async () => {
  await assert.rejects(admit(new GitHubError(502, "Bad Gateway")), /Bad Gateway/);
});

test("an outcome is posted to the callback with its token; a rejected delivery throws", async () => {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const answer = (status: number) =>
    (async (url: string, init: RequestInit) => (sent.push({ url, init }), new Response(null, { status }))) as typeof fetch;
  const callback = { url: "https://gateway.test/jobs/1/outcome", token: "t0ken" };

  await callbackDelivery(callback, answer(204))(failedOutcome("timeout"));
  assert.equal(sent[0]!.url, callback.url);
  assert.equal(new Headers(sent[0]!.init.headers).get("authorization"), "Bearer t0ken");
  assert.deepEqual(JSON.parse(String(sent[0]!.init.body)), {
    status: "failed",
    reason: "timeout",
    message: "The review took too long and was stopped.",
  });

  await assert.rejects(callbackDelivery(callback, answer(401))(failedOutcome("timeout")), /answered 401/);
});

test("a purchase is run only while its job is still running at the gateway", async () => {
  const asked: string[] = [];
  const wanted = (answer: () => Response) =>
    purchaseWanted({ url: "https://gateway.test/jobs/p1/outcome", token: "cb" }, async (url) => (asked.push(String(url)), answer()))();
  assert.equal(await wanted(() => Response.json({ id: "p1", status: "running" })), true);
  // Refused or dropped by the gateway: nobody will collect the review.
  assert.equal(await wanted(() => Response.json({ error: "not_found" }, { status: 404 })), false);
  assert.equal(await wanted(() => Response.json({ id: "p1", status: "failed", reason: "timeout" })), false);
  // An unreachable gateway is no proof the job is gone; delivering its outcome will tell.
  assert.equal(await wanted(() => { throw new TypeError("fetch failed"); }), true);
  assert.deepEqual([...new Set(asked)], ["https://gateway.test/jobs/p1"]);
});

test("an attempt gets the time left before the deadline less a minute to deliver, and none when too little is left", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  const minutes = (n: number) => n * 60_000;
  assert.equal(attemptTime(undefined, now, minutes(50)), minutes(50));
  assert.equal(attemptTime(now + minutes(120), now, minutes(50)), minutes(50));
  assert.equal(attemptTime(now + minutes(20), now, minutes(50)), minutes(19));
  assert.equal(attemptTime(now + minutes(5), now, minutes(50)), undefined);
  assert.equal(attemptTime(now - 1, now, minutes(50)), undefined);
});
