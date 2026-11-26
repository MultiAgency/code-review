import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { webhookHandler } from "../src/server.ts";
import type { ReviewJob } from "../src/triggers.ts";

const submitted: Array<{ job: ReviewJob; delivery: string }> = [];
let server: Server;
let url: string;

before(async () => {
  server = createServer(
    webhookHandler({
      secret: "s3cret",
      trigger: "@multi-review",
      allowedRepos: [],
      queue: {
        submit: (job, delivery) => (
          submitted.push({ job, delivery }),
          submitted.length > 1 && delivery === submitted[0]!.delivery
            ? "duplicate"
            : "queued"
        ),
        stats: () => ({ running: 1, queued: 2 }),
      },
      purchases: {
        token: "gateway-t0ken",
        gateway: "https://gateway.test",
        admit: async (_repo, prNumber) =>
          prNumber === 13 ? { error: "too_large", message: "Too large." } : undefined,
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const sign = (body: string) =>
  `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
const post = (
  event: string,
  payload: unknown,
  headers: Record<string, string> = {},
) => {
  const body = JSON.stringify(payload);
  return fetch(`${url}/webhook`, {
    method: "POST",
    headers: {
      "x-github-event": event,
      "x-hub-signature-256": sign(body),
      "x-github-delivery": "d1",
      ...headers,
    },
    body,
  });
};

const opened = {
  action: "opened",
  repository: { full_name: "o/r" },
  installation: { id: 3 },
  pull_request: {
    number: 5,
    draft: false,
    author_association: "MEMBER",
    user: { login: "dev", type: "User" },
  },
};

test("health check reports queue stats", async () => {
  const res = await fetch(`${url}/healthz`);
  assert.deepEqual(await res.json(), { ok: true, running: 1, queued: 2 });
});

test("rejects bad signatures and malformed bodies", async () => {
  assert.equal(
    (await post("pull_request", opened, { "x-hub-signature-256": "sha256=00" }))
      .status,
    401,
  );
  const res = await fetch(`${url}/webhook`, {
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign("{nope"),
    },
    body: "{nope",
  });
  assert.equal(res.status, 400);
});

test("queues review-worthy events with their delivery id; ignores the rest", async () => {
  const res = await post("pull_request", opened);
  assert.equal(res.status, 202);
  assert.deepEqual(submitted.at(-1), {
    job: { repo: "o/r", prNumber: 5, installationId: 3, reason: "opened" },
    delivery: "d1",
  });
  assert.equal(
    (await post("pull_request", { ...opened, action: "closed" })).status,
    204,
  );
  assert.equal((await post("ping", { zen: "hi" })).status, 204);
  // A signed payload missing fields is skipped, not a crash.
  assert.equal(
    (
      await post("pull_request", {
        action: "opened",
        repository: { full_name: "o/r" },
      })
    ).status,
    204,
  );
  assert.equal((await fetch(`${url}/nope`)).status, 404);
});

const purchaseId = "3f2b6c1e-8a4d-4e0b-9c57-1d2a7f6b9e10";
const purchase = (
  over: { pr?: number; callbackUrl?: string; token?: string } = {},
) =>
  fetch(`${url}/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${over.token ?? "gateway-t0ken"}` },
    body: JSON.stringify({
      id: purchaseId,
      input: { repo: "o/r", pr: over.pr ?? 5 },
      callback: {
        url: over.callbackUrl ?? `https://gateway.test/jobs/${purchaseId}/outcome`,
        token: "cb",
      },
    }),
  });

test("a purchase from the gateway is queued as its own job", async () => {
  const res = await purchase();
  assert.equal(res.status, 202);
  assert.deepEqual(submitted.at(-1), {
    job: {
      repo: "o/r",
      prNumber: 5,
      reason: "purchase",
      purchase: {
        id: purchaseId,
        callback: { url: `https://gateway.test/jobs/${purchaseId}/outcome`, token: "cb" },
      },
    },
    delivery: `purchase ${purchaseId}`,
  });
});

test("a purchase needs the gateway's token and a callback under the gateway", async () => {
  const before = submitted.length;
  assert.equal((await purchase({ token: "wrong" })).status, 401);
  assert.equal((await purchase({ callbackUrl: "https://elsewhere.test/outcome" })).status, 400);
  assert.equal((await purchase({ callbackUrl: "https://gateway.test.evil.test/outcome" })).status, 400);
  assert.equal(submitted.length, before);
});

test("a pull request that can't be reviewed is refused before anything is queued", async () => {
  const before = submitted.length;
  const res = await purchase({ pr: 13 });
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: "too_large", message: "Too large." });
  assert.equal(submitted.length, before);
});

test("without purchase settings there is no purchase route", async () => {
  const plain = createServer(
    webhookHandler({
      secret: "s3cret",
      trigger: "@multi-review",
      allowedRepos: [],
      queue: { submit: () => "queued", stats: () => ({ running: 0, queued: 0 }) },
    }),
  );
  await new Promise<void>((resolve) => plain.listen(0, resolve));
  const res = await fetch(`http://127.0.0.1:${(plain.address() as AddressInfo).port}/jobs`, {
    method: "POST",
    headers: { authorization: "Bearer gateway-t0ken" },
    body: "{}",
  });
  plain.close();
  assert.equal(res.status, 404);
});
