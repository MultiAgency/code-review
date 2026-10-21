import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubError, githubClient } from "../src/github.ts";

function scriptedFetch(...responses: Array<Response | Error>) {
  const calls: string[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(
      `${init?.method} ${String(url)} ${(init?.headers as Record<string, string>).Authorization}`,
    );
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { f, calls };
}

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

test("retries network errors, 5xx and rate limits, honouring Retry-After", async () => {
  const sleeps: number[] = [];
  const { f, calls } = scriptedFetch(
    new TypeError("fetch failed"),
    json(502, {}),
    json(429, {}, { "retry-after": "7" }),
    json(200, { ok: 1 }),
  );
  let n = 0;
  const gh = githubClient({
    apiUrl: "https://api",
    token: async () => `t${++n}`,
    fetch: f,
    sleep: async (ms) => void sleeps.push(ms),
  });
  assert.deepEqual(await gh.request("GET", "/x"), { ok: 1 });
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [1000, 4000, 7000]);
  assert.match(calls[3]!, /token t4$/);
});

test("validation errors are not retried", async () => {
  const { f, calls } = scriptedFetch(json(422, { message: "bad line" }));
  const gh = githubClient({
    apiUrl: "https://api",
    token: async () => "t",
    fetch: f,
    sleep: async () => {},
  });
  await assert.rejects(
    gh.request("POST", "/x", {}),
    (e) => e instanceof GitHubError && e.status === 422,
  );
  assert.equal(calls.length, 1);
});

test("list follows pagination links", async () => {
  const { f, calls } = scriptedFetch(
    json(200, [1, 2], {
      link: '<https://api/x?page=2>; rel="next", <https://api/x?page=2>; rel="last"',
    }),
    json(200, [3]),
  );
  const gh = githubClient({
    apiUrl: "https://api",
    token: async () => "t",
    fetch: f,
  });
  assert.deepEqual(await gh.list("/x"), [1, 2, 3]);
  assert.match(calls[0]!, /\/x\?per_page=100/);
});
