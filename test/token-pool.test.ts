import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { AgentResult, AgentRunner } from "../src/agent.ts";
import { tokenPoolRunner } from "../src/token-pool.ts";

const schema = z.object({ v: z.number() });
const req = { prompt: "p", schema, roots: ["/tmp"] };
const ok: AgentResult<{ v: number }> = { ok: true, data: { v: 1 }, costUsd: 0.1 };
const limited: AgentResult<{ v: number }> = { ok: false, failure: "auth_or_limit", detail: "API error 429: session limit", costUsd: 0 };
const rejected: AgentResult<{ v: number }> = { ok: false, failure: "auth_or_limit", detail: "API error 401: invalid token", costUsd: 0 };

/** One scripted runner per token; records which token ran each request. */
function fakeRunners(answers: Record<string, Array<AgentResult<{ v: number }>>>) {
  const used: string[] = [];
  const make = (token: string): AgentRunner => ({
    async run<T>() {
      used.push(token);
      return (answers[token]!.shift() ?? ok) as AgentResult<T>;
    },
  });
  return { make, used };
}

test("spreads reviews across tokens in turn", async () => {
  const { make, used } = fakeRunners({ a: [], b: [], c: [] });
  const pool = tokenPoolRunner(["a", "b", "c"], make);
  for (let i = 0; i < 4; i++) assert.ok((await pool.run(req)).ok);
  assert.deepEqual(used, ["a", "b", "c", "a"]);
});

test("a token at its usage limit rests, and the same request retries on the next one", async () => {
  let clock = 0;
  const logs: Array<Record<string, unknown>> = [];
  const { make, used } = fakeRunners({ a: [limited], b: [], c: [] });
  const pool = tokenPoolRunner(["a", "b", "c"], make, { limitCooldownMs: 60_000, now: () => clock, log: (f) => logs.push(f) });
  assert.ok((await pool.run(req)).ok);
  assert.deepEqual(used, ["a", "b"]);
  // a is skipped while it rests…
  await pool.run(req);
  await pool.run(req);
  assert.deepEqual(used.slice(2), ["c", "b"]);
  // …and comes back after the cooldown.
  clock = 61_000;
  await pool.run(req);
  await pool.run(req);
  assert.ok(used.slice(4).includes("a"));
  // Tokens are identified by position, never by value.
  assert.ok(logs.some((l) => l.token === "#1"));
  assert.ok(!JSON.stringify(logs).includes('"a"'));
});

test("a rejected token is benched longer than a rate-limited one", async () => {
  let clock = 0;
  const { make, used } = fakeRunners({ a: [rejected], b: [] });
  const pool = tokenPoolRunner(["a", "b"], make, { limitCooldownMs: 60_000, rejectedCooldownMs: 3_600_000, now: () => clock });
  await pool.run(req);
  clock = 120_000;
  await pool.run(req);
  await pool.run(req);
  assert.deepEqual(used, ["a", "b", "b", "b"]);
});

test("when every token is resting, the limit failure is returned instead of looping", async () => {
  const { make, used } = fakeRunners({ a: [limited], b: [limited] });
  const pool = tokenPoolRunner(["a", "b"], make, { limitCooldownMs: 60_000, now: () => 0 });
  const result = await pool.run(req);
  assert.ok(!result.ok && result.failure === "auth_or_limit");
  assert.deepEqual(used, ["a", "b"]);
  const again = await pool.run(req);
  assert.ok(!again.ok && /all .*tokens/i.test(again.detail));
  assert.equal(used.length, 2);
});

test("other failures are not retried on another token", async () => {
  const budget: AgentResult<{ v: number }> = { ok: false, failure: "budget_exceeded", detail: "", costUsd: 1 };
  const { make, used } = fakeRunners({ a: [budget], b: [] });
  const result = await tokenPoolRunner(["a", "b"], make).run(req);
  assert.ok(!result.ok && result.failure === "budget_exceeded");
  assert.deepEqual(used, ["a"]);
});
