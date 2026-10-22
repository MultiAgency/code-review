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
