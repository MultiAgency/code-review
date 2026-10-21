// Cloudflare deployment: a Worker that forwards GitHub's webhook to the reviewer service running as
// a Container built from the repo's Dockerfile. Deploy from this directory with `cf deploy`.
// Secrets (GITHUB_WEBHOOK_SECRET, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, CLAUDE_CODE_OAUTH_TOKEN[S])
// are uploaded as Worker secrets and passed to the container; see README.md here.
import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import * as entrypoint from "./worker.ts" with { type: "cf-worker" };

const reviewer = defineContainer({
  name: "claude-pr-review",
  image: { dockerfile: "../../Dockerfile" },
  instanceType: "standard-1",
  maxInstances: 1,
});

export default defineConfig({
  accountId: "1a5fc563e57e4a8ecb7d33a893ae2da9", // MultiAgency
  worker: {
    name: "claude-pr-review",
    entrypoint,
    compatibilityDate: "2026-10-01",
    exports: {
      Reviewer: exports.durableObject({ storage: "sqlite", container: reviewer }),
    },
    env: {
      REVIEWER: bindings.durableObject({ worker: "claude-pr-review", exportName: "Reviewer" }),
      // Secrets, passed through to the service. GitHub auth is the App (ID + key) or, for testing, a token.
      GITHUB_WEBHOOK_SECRET: bindings.secret(),
      GITHUB_APP_ID: bindings.secret(),
      GITHUB_APP_PRIVATE_KEY: bindings.secret(),
      CLAUDE_CODE_OAUTH_TOKEN: bindings.secret(),
      // Post reviews on PRs, with the model pinned. Which repositories are reviewed is decided by
      // where the GitHub App is installed (no ALLOWED_REPOS).
      POST_REVIEWS: bindings.text("true"),
      REVIEW_MODEL: bindings.text("claude-opus-5-5"),
      // Leave the platform's stop signal time to finish or requeue running reviews.
      SHUTDOWN_GRACE_SECONDS: bindings.text("25"),
      SETTINGS_PROBE: bindings.text("1"),
    },
  },
  containers: [reviewer],
});
