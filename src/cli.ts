// Review a local checkout: `node dist/cli.js [--repo .] [--base origin/main] [--head HEAD] [--json]`
// Prints the review; never posts anywhere. Exits 2 when a high-severity finding is reported.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { sdkAgentRunner } from "./agent.js";
import {
  agentOptions,
  ConfigError,
  loadConfig,
  reviewOptions,
  type Config,
} from "./config.js";
import { buildReport } from "./report.js";
import { reviewChanges } from "./review.js";
import { openLocalWorkspace } from "./workspace.js";

const { values } = parseArgs({
  options: {
    repo: { type: "string", default: "." },
    base: { type: "string", default: "origin/main" },
    head: { type: "string", default: "HEAD" },
    json: { type: "boolean", default: false },
  },
});

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

await using workspace = await openLocalWorkspace({
  repoDir: resolve(values.repo),
  base: values.base,
  head: values.head,
});
const result = await reviewChanges(
  { workspace, log: (msg) => console.error(`[claude-pr-review] ${msg}`) },
  {
    agent: sdkAgentRunner(agentOptions(config)),
    options: reviewOptions(config),
  },
);
// Same rendering the service posts, with every finding in the summary.
const report = buildReport(result, {
  headSha: workspace.headSha,
  mode: "full",
  maxInline: 0,
});
console.log(
  values.json
    ? JSON.stringify(result, null, 2)
    : forTerminal(report.renderSummary(new Set())),
);
process.exitCode = result.findings.some((f) => f.severity === "high") ? 2 : 0;


function forTerminal(markdown: string): string {
  return markdown
    .replace(/^<!--.*-->$/gm, "")
    .replace(/^<sub>.*<\/sub>$/gm, "")
    .trim();
}
