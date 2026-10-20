// Review a local checkout: `node dist/cli.js [--repo .] [--base origin/main] [--head HEAD] [--json]`
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { reviewBody } from "./github.js";
import { reviewChanges } from "./review.js";

const { values } = parseArgs({
  options: {
    repo: { type: "string", default: "." },
    base: { type: "string", default: "origin/main" },
    head: { type: "string", default: "HEAD" },
    json: { type: "boolean", default: false },
  },
});

const workDir = await mkdtemp(join(tmpdir(), "pr-review-"));
try {
  const result = await reviewChanges({
    workDir,
    repoDir: resolve(values.repo),
    base: values.base,
    head: values.head,
    log: (msg) => console.error(`[claude-pr-review] ${msg}`),
  });
  console.log(values.json ? JSON.stringify(result, null, 2) : reviewBody(result, true));
  process.exitCode = result.findings.some((f) => f.severity === "high") ? 2 : 0;
} finally {
  await rm(workDir, { recursive: true, force: true });
}
