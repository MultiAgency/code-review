import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { sdkAgentRunner, type SdkAgentOptions } from "../src/agent.ts";

const root = mkdtempSync(join(tmpdir(), "agent-"));
const req = { prompt: "p", schema: z.object({ v: z.number() }), roots: [root] };

/**
 * An SDK `query` that writes `stderr` to the process's stderr callback, plays back these messages,
 * then optionally throws like the CLI exiting non-zero.
 */
function scripted(messages: unknown[], thenThrow?: Error, stderr: string[] = []): SdkAgentOptions["query"] {
  return ((params: { options: { stderr?: (data: string) => void } }) =>
    (async function* () {
      for (const line of stderr) params.options.stderr?.(line);
      for (const m of messages) yield m;
      if (thenThrow) throw thenThrow;
    })()) as unknown as SdkAgentOptions["query"];
}

const runner = (messages: unknown[], thenThrow?: Error, stderr?: string[]) =>
  sdkAgentRunner({
    effort: "high",
    maxBudgetUsd: 5,
    maxTurns: 10,
    timeoutMs: 60_000,
    query: scripted(messages, thenThrow, stderr),
  });

const errorResult = (status: number | null, cost = 0.02) => ({
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: status,
  result: "API Error",
  total_cost_usd: cost,
});

test("structured output is validated and returned with its cost", async () => {
  const result = await runner([
    { type: "result", subtype: "success", is_error: false, structured_output: { v: 1 }, total_cost_usd: 0.3 },
  ]).run(req);
  assert.deepEqual(result, { ok: true, data: { v: 1 }, costUsd: 0.3 });
});

test("a usage limit is typed, with the reset time Claude announced", async () => {
  const result = await runner(
    [
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_800_000_000, rateLimitType: "five_hour" } },
      { type: "assistant", message: {}, error: "rate_limit" },
      errorResult(429),
    ],
    new Error("Claude Code process exited with code 1"),
  ).run(req);
  assert.deepEqual(
    !result.ok && [result.failure, result.retryAt, result.costUsd],
    ["usage_limit", 1_800_000_000_000, 0.02],
  );
});

test("a 429 without a reset time is still a usage limit", async () => {
  const result = await runner([errorResult(429)]).run(req);
  assert.ok(!result.ok && result.failure === "usage_limit" && result.retryAt === undefined);
});

test("a rejected token is told apart from a usage limit", async () => {
  for (const messages of [
    [{ type: "assistant", message: {}, error: "authentication_failed" }, errorResult(null)],
    [errorResult(401)],
    [{ type: "assistant", message: {}, error: "billing_error" }, errorResult(400)],
  ]) {
    const result = await runner(messages).run(req);
    assert.equal(!result.ok && result.failure, "auth_rejected");
  }
});

test("an overloaded API is its own, retryable failure", async () => {
  for (const messages of [[errorResult(529)], [{ type: "assistant", message: {}, error: "overloaded" }, errorResult(null)]]) {
    const result = await runner(messages).run(req);
    assert.equal(!result.ok && result.failure, "overloaded");
  }
});

test("a result that arrived before the stream threw decides the outcome", async () => {
  const result = await runner(
    [{ type: "result", subtype: "error_max_budget_usd", errors: ["over budget"], total_cost_usd: 5.1 }],
    new Error("exited with code 1"),
  ).run(req);
  assert.deepEqual(!result.ok && [result.failure, result.costUsd], ["budget_exceeded", 5.1]);
});

test("a stream that dies without a result is a crash", async () => {
  const result = await runner([], new Error("spawn failed")).run(req);
  assert.deepEqual(!result.ok && [result.failure, result.detail], ["crashed", "spawn failed"]);
});

test("a crash carries the end of Claude's stderr, with secrets redacted", async () => {
  process.env.TEST_AGENT_SECRET_KEY = "sekrit-value-0123456789";
  try {
    const noise = "x".repeat(5000);
    const result = await runner([], new Error("exited with code 1"), [
      noise,
      "Error: ENOSPC writing sekrit-value-0123456789\n",
    ]).run(req);
    assert.ok(!result.ok && result.failure === "crashed");
    assert.match(result.detail, /exited with code 1[\s\S]*stderr:[\s\S]*ENOSPC/);
    assert.doesNotMatch(result.detail, /sekrit-value/);
    assert.ok(result.detail.length < 2_500, String(result.detail.length));
  } finally {
    delete process.env.TEST_AGENT_SECRET_KEY;
  }
});

test("a prompt too long for Claude's context is its own failure", async () => {
  const result = await runner([
    { ...errorResult(400), terminal_reason: "prompt_too_long" },
  ]).run(req);
  assert.equal(!result.ok && result.failure, "too_large");
});
