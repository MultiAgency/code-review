// Replays message streams recorded from the real Claude Code CLI (2.1.304) through the agent runner,
// so its mapping is checked against what the CLI really sends. Recorded 2026-10-21 and redacted
// (ids, paths, signatures); a `{"__throws": …}` line is where the stream threw after its messages.
// A real usage limit (429) can't be recorded on demand; test/agent.test.ts covers it by hand.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { sdkAgentRunner, type SdkAgentOptions } from "../src/agent.ts";

const root = mkdtempSync(join(tmpdir(), "replay-"));
const req = { prompt: "p", schema: z.object({ answer: z.string() }), roots: [root] };

function recorded(name: string): Array<Record<string, unknown>> {
  return readFileSync(join(import.meta.dirname, "fixtures", "sdk", `${name}.ndjson`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Plays a recording back; with `afterInterrupt`, only once the runner interrupts the pass. */
function replay(name: string, afterInterrupt = false): SdkAgentOptions["query"] {
  return (() => {
    let interrupted!: () => void;
    const wait = afterInterrupt ? new Promise<void>((r) => (interrupted = r)) : Promise.resolve();
    const gen = (async function* () {
      await wait;
      for (const m of recorded(name)) {
        if ("__throws" in m) throw new Error(String(m.__throws));
        yield m;
      }
    })();
    return Object.assign(gen, { interrupt: async () => interrupted?.() });
  }) as unknown as SdkAgentOptions["query"];
}

const runner = (name: string, over: Partial<SdkAgentOptions> = {}) =>
  sdkAgentRunner({ effort: "low", maxBudgetUsd: 1, maxTurns: 4, timeoutMs: 60_000, query: replay(name), ...over });

test("replay: a structured answer", async () => {
  const result = await runner("success").run(req);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(typeof result.data.answer, "string");
  assert.ok(result.costUsd > 0);
});

test("replay: a budget overrun, after which the CLI exits non-zero", async () => {
  const result = await runner("budget").run(req);
  assert.deepEqual(!result.ok && result.failure, "budget_exceeded");
  assert.ok(result.costUsd > 0);
});

test("replay: a rejected token, after the CLI's own retries", async () => {
  const result = await runner("rejected").run(req);
  assert.deepEqual(!result.ok && [result.failure, result.costUsd], ["auth_rejected", 0]);
});

test("replay: a prompt too long for the context window", async () => {
  const result = await runner("too-long").run(req);
  assert.deepEqual(!result.ok && result.failure, "too_large");
});

test("replay: a pass interrupted at its timeout keeps the cost Claude reports", async () => {
  const result = await runner("interrupted", { timeoutMs: 30, query: replay("interrupted", true) }).run(req);
  assert.deepEqual(!result.ok && result.failure, "timeout");
  assert.ok(!result.ok && result.costUsd > 0);
});
