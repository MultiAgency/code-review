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

/** A `query` that runs until interrupted, then reports what the pass cost so far, like the CLI does. */
function interruptible(opts: { honoursInterrupt: boolean; seen: { prompt?: unknown; interrupted: boolean } }) {
  return ((params: { prompt: unknown; options: { abortController: AbortController } }) => {
    opts.seen.prompt = params.prompt;
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    params.options.abortController.signal.addEventListener("abort", () => stop());
    const gen = (async function* () {
      await stopped;
      if (params.options.abortController.signal.aborted) throw new Error("Claude Code process aborted by user");
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_streaming",
        errors: ["interrupted"],
        total_cost_usd: 0.37,
      };
      throw new Error("Claude Code returned an error result");
    })();
    return Object.assign(gen, {
      async interrupt() {
        opts.seen.interrupted = true;
        if (opts.honoursInterrupt) stop();
      },
    });
  }) as unknown as SdkAgentOptions["query"];
}

test("on timeout Claude is interrupted, not killed, so the pass's cost so far is recorded", async () => {
  const seen = { interrupted: false } as { prompt?: unknown; interrupted: boolean };
  const result = await sdkAgentRunner({
    effort: "high",
    maxBudgetUsd: 5,
    maxTurns: 10,
    timeoutMs: 50,
    query: interruptible({ honoursInterrupt: true, seen }),
  }).run(req);
  assert.ok(seen.interrupted);
  assert.deepEqual(!result.ok && [result.failure, result.costUsd], ["timeout", 0.37]);
  // The prompt is streamed in (interrupt needs it), as one user message.
  assert.equal(typeof (seen.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator], "function");
});

test("if Claude ignores the interrupt, the process is stopped after a grace period", async () => {
  const seen = { interrupted: false } as { prompt?: unknown; interrupted: boolean };
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  const result = await sdkAgentRunner({
    effort: "high",
    maxBudgetUsd: 5,
    maxTurns: 10,
    timeoutMs: 60_000,
    interruptGraceMs: 50,
    query: interruptible({ honoursInterrupt: false, seen }),
  }).run({ ...req, signal: ac.signal });
  assert.ok(seen.interrupted);
  assert.deepEqual(!result.ok && [result.failure, result.costUsd], ["aborted", 0]);
});
