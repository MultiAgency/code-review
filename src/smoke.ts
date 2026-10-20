// Runs one review job against a real PR end to end, read-only, without the webhook server:
//   GITHUB_TOKEN=$(gh auth token) node dist/smoke.js --repo owner/name --pr N
// Exercises the GitHub API, the shallow fetch with token auth, the commits API, the review and the
// report, then prints what would be posted (log publisher). Never posts.
import { parseArgs } from "node:util";
import { sdkAgentRunner } from "./agent.js";
import { agentOptions, loadConfig, reviewOptions } from "./config.js";
import { gitAuthEnv } from "./env.js";
import { githubClient, installationToken } from "./github.js";
import { runReviewJob } from "./job.js";
import { logPublisher } from "./publisher.js";
import { openPullRequestWorkspace } from "./workspace.js";

const { values } = parseArgs({ options: { repo: { type: "string" }, pr: { type: "string" } } });
if (!values.repo || !values.pr) {
  console.error("usage: smoke --repo owner/name --pr N   (needs GITHUB_TOKEN)");
  process.exit(1);
}
const config = loadConfig();
const token = installationToken(
  { apiUrl: config.GITHUB_API_URL, ...(config.GITHUB_TOKEN ? { token: config.GITHUB_TOKEN } : {}) },
  undefined,
);
const gh = githubClient({ apiUrl: config.GITHUB_API_URL, token });
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields, null, 2));
const started = Date.now();
const outcome = await runReviewJob(
  { repo: values.repo, prNumber: Number(values.pr), reason: "comment", full: true },
  {
    agent: sdkAgentRunner(agentOptions(config)),
    reviewOptions: reviewOptions(config),
    maxInline: config.REVIEW_MAX_INLINE_COMMENTS,
    gh,
    gitEnv: async () => gitAuthEnv(await token()),
    publisher: logPublisher(log),
    openWorkspace: openPullRequestWorkspace,
    log: (f) => console.error(JSON.stringify(f)),
  },
  new AbortController().signal,
);
console.log(JSON.stringify({ outcome, seconds: Math.round((Date.now() - started) / 1000) }));
