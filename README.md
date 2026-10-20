# claude-pr-review

A self-hosted GitHub pull request reviewer built on the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). It runs as one container
in your own cloud (Railway, Kubernetes, ECS, a VM), receives GitHub webhooks, checks out
each PR, and has Claude Code review it with read-only access. Results are posted back as
a single PR review made of inline comments.

```
GitHub ──webhook──▶ /webhook ─▶ queue ─▶ shallow checkout ─▶ review pass ─▶ verify pass ─▶ PR review
                    (HMAC check)  (newest request wins)        (Read/Grep/Glob only)          (COMMENT only)
```

## How it works

1. **Triggers.** Webhooks are verified with HMAC. A PR is reviewed **once automatically**, when
   it first becomes reviewable: opened as a non-draft, or marked ready for review. Pushes do
   not trigger reviews. After that, anyone with access to the repo can ask for another
   review with a PR comment whose line starts with **`@private-review`** (the service reacts
   with 👀). Only comments from owners, org members and collaborators count, so outside
   contributors on public repos can't trigger reviews. A new request for the same PR cancels
   any review of it that is still running.
2. **Checkout.** The service fetches only the commits it needs, with depth 1: the PR head (full
   tree), the base branch tip, and the merge base (blobs fetched lazily). The GitHub token is
   passed in an env-provided git config header. It never appears in argv or `.git/config`.
3. **Review pass.** It calls `query()` from the Agent SDK with the Claude Code system prompt and
   the review rules in `src/review.ts`. The model gets the diff, the PR title and description
   (framed as untrusted), and `CLAUDE.md` / `REVIEW.md` read from the **base** branch. Findings
   come back as structured JSON (`outputFormat: json_schema`).
4. **Verify pass** (`REVIEW_VERIFY=true`). A second `query()` tries to refute each finding
   against the code and drops the ones that don't hold up.
5. **Post.** Findings on lines that are in the diff become inline comments. The rest go in
   the review body. Reviews are always `COMMENT`; the service never approves or requests
   changes. Posting is **off until you set `POST_REVIEWS=true`**. Until then, results are only
   logged.

## Security model

PR content is untrusted, and a PR can try to steer the reviewer through prompt injection. The
service limits what such a PR can do:

| Risk | Mitigation |
|---|---|
| PR adds `.claude/settings.json` hooks, skills, `.mcp.json` | `settingSources: []`, `strictMcpConfig: true`. No filesystem settings are loaded at all. |
| PR rewrites its own review rules | `CLAUDE.md` / `REVIEW.md` are read from the base branch, not the PR. |
| Model runs commands or edits files | Tool surface is `Read`, `Grep`, `Glob` only, `permissionMode: "dontAsk"`. |
| Reading secrets outside the repo (`/proc/self/environ`, symlinks committed in the PR) | `PreToolUse` hook resolves real paths and denies anything outside the checkout (`test/guard.test.ts`). |
| Leaking credentials into the posted review | Claude's subprocess gets an env allowlist (no GitHub token or webhook secret), and any secret env value found in the output is redacted before posting. |
| Runaway cost | `REVIEW_MAX_BUDGET_USD` and `REVIEW_MAX_TURNS` per pass; bounded concurrency. |

The model credential (`ANTHROPIC_API_KEY`, or the cloud credentials for Bedrock / Vertex) is
necessarily visible to the Claude process.

## Setup

### 1. Create a GitHub App

In GitHub, go to Settings → Developer settings → GitHub Apps → New GitHub App.

- **Webhook URL:** `https://<your-host>/webhook`
- **Webhook secret:** a long random string (this becomes `GITHUB_WEBHOOK_SECRET`)
- **Repository permissions:** Contents: *Read*, Pull requests: *Read & write*, Metadata: *Read*
- **Subscribe to events:** Pull request, Issue comment

Generate a private key, then install the app on the repos you want reviewed.

On a single repo, you can use a fine-grained PAT (`GITHUB_TOKEN`) and a repository webhook
instead of an app.

### 2. Configure

| Variable | Default | |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | (required) | Must match the app's webhook secret |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | | App auth. The PEM may use literal `\n` |
| `GITHUB_TOKEN` | | PAT fallback when not using an app |
| `GITHUB_API_URL` | `https://api.github.com` | Set for GitHub Enterprise Server |
| `CLAUDE_CODE_OAUTH_TOKEN` | | Model access on your Claude subscription (see "Model access" below) |
| `ANTHROPIC_API_KEY` | | Alternative: Console API billing. Takes precedence if both are set |
| `POST_REVIEWS` | `false` | Set `true` to post reviews to GitHub |
| `ALLOWED_REPOS` | (all) | Comma-separated `owner/repo` allowlist |
| `REVIEW_TRIGGER` | `@private-review` | PR comment phrase that requests a review |
| `REVIEW_MODEL` | (Claude Code default) | Pin a model ID, e.g. `claude-opus-5-5` |
| `REVIEW_EFFORT` | `high` | `low` … `max` |
| `REVIEW_VERIFY` | `true` | Second, refuting pass |
| `REVIEW_MAX_BUDGET_USD` | `10` | Per pass |
| `REVIEW_MAX_TURNS` | `80` | Per pass |
| `MAX_CONCURRENT_REVIEWS` | `2` | Each review is one Claude Code process |
| `PORT` | `8080` | |

### 3. Deploy

**Railway:** connect the repo or run `railway up`. `railway.toml` builds the Dockerfile and
health-checks `/healthz`. Set the variables above, generate a domain, and point the GitHub
App's webhook URL at `https://<domain>/webhook`.

**Any other container platform:**

```sh
docker build -t claude-pr-review .
docker run -p 8080:8080 --env-file .env claude-pr-review
```

Give the container about 2 GB RAM per concurrent review, plus disk for the checkouts (they are
deleted after each review).

### Model access

The service uses a subscription OAuth token, so reviews count against a Team seat's usage.

1. On a machine where you are logged in to Claude Code, run `claude setup-token` in your own
   terminal.
2. Copy the token straight into the deployment's `CLAUDE_CODE_OAUTH_TOKEN` variable (for
   example, Railway → Variables). Don't paste it into chats or commit it.
3. Leave `ANTHROPIC_API_KEY` unset; if it is present it wins over the token.

Notes:

- The token belongs to the person who generated it and is valid for one year. Put a renewal
  reminder in your calendar. If that person leaves the org, generate a new token.
- Reviews share that seat's usage limits. When the limit is hit, runs fail with an error in the
  logs until the limit resets. Lower `REVIEW_EFFORT`, turn off `REVIEW_VERIFY`, or use
  `ALLOWED_REPOS` to reduce volume.
- The `costUsd` in the logs is an estimate at API prices. Nothing is billed per token on a
  subscription.

### Keeping traffic in your cloud

Alternatively, Claude Code (and therefore this service) can use your cloud provider's Claude endpoint
instead of the Anthropic API. Set the provider's standard variables instead of a token or key:

- Amazon Bedrock: `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, plus AWS credentials or an
  instance role
- Google Vertex AI: `CLAUDE_CODE_USE_VERTEX=1`, `CLOUD_ML_REGION`,
  `ANTHROPIC_VERTEX_PROJECT_ID`, plus workload identity / ADC

These variables pass through to the Claude subprocess (see `claudeEnv()` in `src/config.ts`).
If you set `REVIEW_MODEL`, check that it is an ID your provider serves.

## Local / CI usage

```sh
npm ci && npm run build
CLAUDE_CODE_OAUTH_TOKEN=... node dist/cli.js --repo ../my-repo --base origin/main [--json]
```

The command exits with code 2 when a high-severity finding is reported, so it can gate a CI
job.

## Development

```sh
npm test            # diff parser + path guard
npm run dev         # tsx watch-free server on :8080
```

Customize review behavior per repo with a `REVIEW.md` at the repo root (on the default
branch), for example severity calibration, paths to ignore, or house rules.
