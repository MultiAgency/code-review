// Records real SDK streams (ticket 12). Run from the repo root with a Claude login (costs ~$0.10):
//   npx tsx .scratch/deepening-round-2/recorder/record.mts <out dir>, then redact.py into test/fixtures/sdk.
// Records real SDK message streams through sdkAgentRunner, for replay fixtures (ticket 12).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "/home/zeeshan/claude-pr-review/node_modules/zod/index.js";
import { query } from "/home/zeeshan/claude-pr-review/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import { sdkAgentRunner, type SdkAgentOptions } from "/home/zeeshan/claude-pr-review/src/agent.ts";

const out = process.argv[2]!;
const root = mkdtempSync(join(tmpdir(), "record-"));
writeFileSync(join(root, "a.ts"), "export const a = 1 / 0;\n");

function recording(name: string): SdkAgentOptions["query"] {
  return ((params: any) => {
    const q = query(params);
    const lines: unknown[] = [];
    const save = () => writeFileSync(join(out, `${name}.ndjson`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const gen = (async function* () {
      try {
        for await (const m of q) { lines.push(m); yield m; }
        save();
      } catch (e) {
        lines.push({ __throws: (e as Error).message.split("\n")[0] });
        save();
        throw e;
      }
    })();
    return Object.assign(gen, { interrupt: () => q.interrupt() });
  }) as SdkAgentOptions["query"];
}

const schema = z.object({ answer: z.string() });
const base = { effort: "low" as const, maxBudgetUsd: 0.3, maxTurns: 4, timeoutMs: 5 * 60_000 };
const req = (prompt: string) => ({ prompt, schema, roots: [root] });
const show = (name: string, r: any) => console.log(name, JSON.stringify(r.ok ? { ok: true, costUsd: r.costUsd } : { failure: r.failure, costUsd: r.costUsd, retryAt: r.retryAt, detail: String(r.detail).slice(0, 100) }));

show("success", await sdkAgentRunner({ ...base, query: recording("success") }).run(req("Read a.ts and say in a few words what it computes.")));
show("budget", await sdkAgentRunner({ ...base, maxBudgetUsd: 0.0001, query: recording("budget") }).run(req("Read a.ts and explain it in detail.")));
show("rejected", await sdkAgentRunner({ ...base, oauthToken: "sk-ant-oat01-" + "x".repeat(95), query: recording("rejected") }).run(req("Say hi.")));
show("interrupted", await sdkAgentRunner({ ...base, timeoutMs: 8000, query: recording("interrupted") }).run(req("Write a detailed 3000-word essay on the history of version control, as the answer.")));
show("too-long", await sdkAgentRunner({ ...base, query: recording("too-long") }).run(req("Summarise this:\n" + "lorem ipsum dolor sit amet ".repeat(260_000))));
process.exit(0);
