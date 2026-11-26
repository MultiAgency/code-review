// Runs one review job against a real PR end to end, read-only, without the webhook server:
//   GITHUB_TOKEN=$(gh auth token) node dist/smoke.js --repo owner/name --pr N
// Exercises the GitHub API, the shallow fetch with token auth, the commits API, the review and the
// report, then prints what would be posted (log publisher). Never posts.
import { parseArgs } from "node:util";
import { loadConfigOrExit } from "./config.js";
import { reviewWork } from "./review-work.js";

const { values } = parseArgs({
  options: { repo: { type: "string" }, pr: { type: "string" } },
});
if (!values.repo || !values.pr) {
  console.error("usage: smoke --repo owner/name --pr N   (needs GITHUB_TOKEN)");
  process.exit(1);
}
const config = loadConfigOrExit();
const work = reviewWork(config, {
  log: (fields) =>
    fields.msg === "would post"
      ? console.log(String(fields.review))
      : console.error(JSON.stringify(fields)),
  publish: false,
});
const started = Date.now();
const outcome = await work(
  { repo: values.repo, prNumber: Number(values.pr), reason: "comment", full: true },
  { signal: new AbortController().signal, recordSpend: () => {}, queuedAt: Date.now(), saved: undefined, save: () => {}, finalAttempt: true },
);
console.log(
  JSON.stringify({
    outcome,
    seconds: Math.round((Date.now() - started) / 1000),
  }),
);
