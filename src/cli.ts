// Review a local checkout: `node dist/cli.js [--repo .] [--base origin/main] [--head HEAD] [--json] [--verbose]`
// Prints the review; never posts anywhere. Exits 2 when a high-severity finding is reported.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfigOrExit, reviewOptions } from "./config.js";
import { buildReport } from "./report.js";
import { ReviewFailedError, reviewChanges } from "./review.js";
import { agentRunnerFor } from "./token-pool.js";
import { openLocalWorkspace } from "./workspace.js";

const { values } = parseArgs({
  options: {
    repo: { type: "string", default: "." },
    base: { type: "string", default: "origin/main" },
    head: { type: "string", default: "HEAD" },
    json: { type: "boolean", default: false },
    // List what the review checked, not just how much.
    verbose: { type: "boolean", default: false },
  },
});

const config = loadConfigOrExit();

await using workspace = await openLocalWorkspace({
  repoDir: resolve(values.repo),
  base: values.base,
  head: values.head,
});
const result = await reviewChanges(
  { workspace, log: (msg) => console.error(`[claude-pr-review] ${msg}`) },
  {
    agent: agentRunnerFor(config, (f) => console.error(`[claude-pr-review] ${JSON.stringify(f)}`)),
    options: reviewOptions(config),
  },
).catch((error: unknown) => {
  if (!(error instanceof ReviewFailedError)) throw error;
  console.error(`[claude-pr-review] ${error.message}`);
  process.exit(1);
});
const report = buildReport(result, {
  headSha: workspace.headSha,
  mode: "full",
  maxInline: 0,
  trigger: config.REVIEW_TRIGGER,
});
console.log(
  values.json
    ? JSON.stringify(result, null, 2)
    : report.renderText({ verbose: values.verbose }),
);
process.exitCode = result.findings.some((f) => f.severity === "high") ? 2 : 0;

