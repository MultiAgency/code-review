# Technical reference

The detailed version of the [README](../README.md): how the service works inside, its security
model, every setting, deployment details and the evaluation tooling. Terms are defined in
[GLOSSARY.md](../GLOSSARY.md).

```
GitHub ─webhook─▶ HTTP adapter ─▶ review queue ─▶ PR workspace ─▶ review pass ─▶ verify pass ─▶ review report ─▶ publisher
                  (HMAC, triggers) (SQLite, retries)  (shallow fetch)  (Read/Grep/Glob)  (refutes)     (pure)          (GitHub / log)
```

## How it works

1. **Triggers.**
   - **Automatic review, once:** when a PR first becomes reviewable (opened as a non-draft, or
     marked ready for review), and only if its author is a repo owner, org member or
     collaborator. Never for bots.
   - **No review on push.** Pushes never trigger a review.
   - **On request:** owners, members and collaborators can ask for a review of any PR,
     including an outside contributor's, with a PR comment line starting with
     **`@multi-review`**. A re-review covers only the commits since the last review.
     **`@multi-review full`** reviews the whole PR, and so does any re-review after a
     rebase or force-push.
   - **Everyone else's comments are ignored,** so outsiders can't spend the review budget.
2. **Review queue.**
   - Jobs are persisted in SQLite (`QUEUE_DB`), so a deploy or crash doesn't lose them.
   - Interrupted jobs resume when the service starts again.
   - A redelivered webhook is ignored.
   - A newer request for a PR replaces the old one. The older review stops before the newer
     one starts.
   - Transient failures (git, GitHub, an overloaded Claude API) retry with backoff.
   - If the review finished but posting it failed, the retry posts the saved review instead of
     paying for it again (as long as the PR head hasn't moved).
   - A review waiting for Claude's usage limit is queued again for the reset time.
3. **PR workspace.**
   - The service fetches only what it needs, at depth 1: the PR head by SHA (full tree, checked
     out), the base branch tip, and the diff base (blobs fetched lazily).
   - The diff base is the merge base for a full review, or the last reviewed commit for a
     re-review.
   - Lockfiles, build output, minified and vendored files are left out.
   - Git runs without the host's config, so local settings can't change the diff.
4. **Review passes.**
   - The model is Claude Code with read-only tools, confined to the checkout.
   - It's given the diff, the PR title and description (marked as untrusted), and any findings
     still open from earlier reviews.
   - It's also given `CLAUDE.md` and `REVIEW.md` from the **base branch**, with the files they
     `@import` (repo files only; no symlinks; depth and size limits).
   - When `REVIEW.md` has a `## Passes` section, one review covers every pass it lists. With
     `REVIEW_SINGLE_PASS=false`, each pass runs as its own focused review instead; findings are
     merged before verification.
   - When `REVIEW.md` has a `## Severity` section, its labels (e.g. Important / Nit) are used.
     They map onto high / low for inline-comment decisions.
   - Every pass is told to trace the callers of each changed function, and how often each one
     runs. It reports what it traced, and the summary shows that as a "Checked:" line.
   - Each finding quotes the exact code it's about (`existing_code`) and can propose a
     one-click fix.
5. **Verify pass** (`REVIEW_VERIFY=true`).
   - A second pass tries to refute each finding and removes it only with proof from the code.
   - Concurrency, memory-safety and compatibility findings are never removed.
   - If this pass fails, the findings are posted marked as unverified.
6. **Publishing.**
   - **One summary comment per PR**, edited in place each time. It carries hidden state (the
     reviewed commit, and fingerprints of posted findings), so a finding is never posted twice.
   - **Inline comments** are posted as one Comment review pinned to the reviewed commit. Only
     high- and medium-severity findings get them, up to `REVIEW_MAX_INLINE_COMMENTS`. They're
     placed by matching the quoted code. Findings that can't go inline go on the file or in
     the summary.
   - **Never approves or requests changes.**
   - **Reactions show progress:** 👀 started, 🎉 done, 😕 failed. A failure also puts a short
     reason in the summary; raw error text is never posted.
   - **Posting is off until `POST_REVIEWS=true`.** Until then, reviews are only logged.

## Security model

PR content is untrusted: a PR can try to steer the reviewer through prompt injection. These
measures limit what such a PR can do. Live probes in `npm run test:live` check the
filesystem ones against the real SDK.

| Risk                                                                       | Mitigation                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Outsiders spend the review budget                                          | Automatic reviews only for trusted authors; trigger comments only from trusted members; bots excluded.                                                                         |
| PR text pulls in files via `@path` mentions                                | `verbatimPrompts: true`: the prompt is delivered as written, with no file-mention expansion.                                                                                   |
| PR adds `.claude/settings.json` hooks, skills, `.mcp.json`                 | `settingSources: []`, `strictMcpConfig: true`: nothing is loaded from disk.                                                                                                    |
| PR rewrites its own review rules                                           | `CLAUDE.md` / `REVIEW.md` are read from the base branch.                                                                                                                       |
| Model runs commands or edits files                                         | Tools are `Read`, `Grep` and `Glob` only, with `permissionMode: "dontAsk"`.                                                                                                    |
| Reading outside the repo (`/proc/self/environ`, `~/…`, symlinks in the PR) | A `PreToolUse` hook resolves real paths and denies anything outside the checkout, `~` paths, and `..` in glob patterns.                                                        |
| Leaking credentials                                                        | Claude's process gets only its own auth (no GitHub credentials or webhook secret). Git gets neither. Secret values are redacted from everything posted.                        |
| Forged state or one-click suggestions                                      | Only the service's own summary comment is trusted as state. Model text can't open `suggestion` blocks or write hidden markers.                                                 |
| Runaway cost or hangs                                                      | A budget per review shared by its passes, per-pass caps, a daily spend cap, turn and time limits, a job timeout, per-call timeouts on git and GitHub, and bounded concurrency. |

The model credential is necessarily visible to the Claude process.

## Setup

### 1. Create a GitHub App

In GitHub, go to Settings → Developer settings → GitHub Apps → New GitHub App.

- **Webhook URL:** `https://<your-host>/webhook`
- **Webhook secret:** a long random string (`GITHUB_WEBHOOK_SECRET`)
- **Repository permissions:**
  - Contents: _Read_
  - Pull requests: _Read & write_ (for reviews and comments)
  - Issues: _Read & write_ (for the summary comment and reactions)
  - Metadata: _Read_
- **Subscribe to events:** Pull request, Issue comment

Generate a private key, then install the app on the repos you want reviewed.

For a single repo you can instead use a fine-grained PAT (`GITHUB_TOKEN`) and a repository
webhook.

### 2. Model access

The service uses a Claude subscription OAuth token, so reviews count against one seat's usage.

1. In your own terminal, on a machine where you're logged in to Claude Code, run
   `claude setup-token`.
2. Put the token straight into the deployment's `CLAUDE_CODE_OAUTH_TOKEN` variable. Don't paste
   it into chats or commit it.
3. Leave `ANTHROPIC_API_KEY` unset; if both are set, the API key wins.

Things to know:

- **Token owner:** the token belongs to the person who generated it and lasts one year. Set a
  renewal reminder.
- **Shared usage limits:** reviews share that seat's limits. When a limit is hit, the review
  waits for the reset time Claude reports (the summary comment says when) and runs again then,
  without using up a retry. If the reset is more than 24 h after the review was requested, or
  Claude gives no reset time, it fails with a "usage limit" note on the PR instead. A rejected
  (expired or revoked) token fails with its own note. You can reduce usage with `REVIEW_EFFORT`,
  `REVIEW_VERIFY=false` or `ALLOWED_REPOS`.
- **Cost figures:** costs in the logs are estimates at API prices; nothing is billed per token
  on a subscription.
- **Bedrock or Vertex instead:** to keep model traffic in your cloud, set
  `CLAUDE_CODE_USE_BEDROCK=1` (plus AWS credentials) or `CLAUDE_CODE_USE_VERTEX=1` (plus
  `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID`). Those cloud credentials reach the Claude
  process only when that provider is on. If you set `REVIEW_MODEL`, use an ID your provider
  serves.

### 3. Configure

Every setting is validated at startup. A bad value stops the service with a list of what's
wrong.

| Variable                                   | Default                  |                                                                                                                                                       |
| ------------------------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_WEBHOOK_SECRET`                    | (required)               | Must match the app's webhook secret                                                                                                                   |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` |                          | App auth. The PEM may use literal `\n`                                                                                                                |
| `GITHUB_TOKEN`                             |                          | PAT, when not using an app                                                                                                                            |
| `GITHUB_API_URL`                           | `https://api.github.com` | Set for GitHub Enterprise Server                                                                                                                      |
| `CLAUDE_CODE_OAUTH_TOKENS`                 |                          | Several tokens, comma- or newline-separated. Reviews rotate across them; a token at its usage limit rests until the reset time Claude reports (or `CLAUDE_TOKEN_COOLDOWN_MIN` without one), a rejected one for 24 h, and the request retries on the next. Each Claude process sees only its own token; tokens are logged as `#1`, `#2`… |
| `CLAUDE_TOKEN_COOLDOWN_MIN`                | `60`                     | How long a token at its usage limit rests when Claude reports no reset time |
| `CLAUDE_CODE_OAUTH_TOKEN`                  |                          | Model access (see above)                                                                                                                              |
| `POST_REVIEWS`                             | `false`                  | `true` posts to GitHub; otherwise reviews are only logged                                                                                             |
| `ALLOWED_REPOS`                            | (all)                    | Comma-separated `owner/repo` allowlist                                                                                                                |
| `REVIEW_TRIGGER`                           | `@multi-review`        | PR comment phrase that requests a review                                                                                                              |
| `REVIEW_MODEL`                             | (Claude Code default)    | Pin a model ID, e.g. `claude-opus-5-5`                                                                                                                |
| `REVIEW_EFFORT`                            | `high`                   | `low` … `max`                                                                                                                                         |
| `REVIEW_VERIFY`                            | `true`                   | Run the verify pass                                                                                                                                   |
| `REVIEW_BUDGET_USD`                        | `12`                     | Per review, across all passes (80% review passes, 20% verify)                                                                                         |
| `REVIEW_MAX_BUDGET_USD`                    | `10`                     | Ceiling for any single pass                                                                                                                           |
| `REVIEW_SINGLE_PASS`                       | `true`                   | One review pass covering every `REVIEW.md` pass. `false` runs one focused pass each (≈2× cost; on our eval it added a few real findings, mostly nits) |
| `REVIEW_MAX_PARALLEL_PASSES`               | `2`                      | Review passes running at once within one review (multi-pass mode)                                                                                     |
| `DAILY_BUDGET_USD`                         | `50`                     | Reviews stop starting once a UTC day's spend reaches this; they wait for the next day. Every Claude run counts when it finishes, including reviews that were superseded or failed. `0` = no cap                                                   |
| `REVIEW_MAX_TURNS`                         | `80`                     | Per pass                                                                                                                                              |
| `REVIEW_PASS_TIMEOUT_MIN`                  | `20`                     | Per pass                                                                                                                                              |
| `REVIEW_JOB_TIMEOUT_MIN`                   | `50`                     | Whole review, including fetch and publish                                                                                                             |
| `REVIEW_MAX_INLINE_COMMENTS`               | `10`                     | Per review; the rest go in the summary                                                                                                                |
| `REVIEW_MAX_ATTEMPTS`                      | `3`                      | Attempts for transient failures                                                                                                                       |
| `MAX_CONCURRENT_REVIEWS`                   | `2`                      | Each review is one Claude Code process                                                                                                                |
| `QUEUE_DB`                                 | `/data/jobs.db`          | Put it on a persistent volume                                                                                                                         |
| `SHUTDOWN_GRACE_SECONDS`                   | `25`                     | Time running reviews get to finish on SIGTERM                                                                                                         |
| `PORT`                                     | `8080`                   |                                                                                                                                                       |

### 4. Deploy

**Railway:**

1. Create a service from this repo. Railway builds the `Dockerfile`.
2. Add a **volume** mounted at `/data`, and set `RAILWAY_RUN_UID=0`. Railway mounts volumes as
   root, and the image otherwise runs as the non-root `node` user, which couldn't write there.
3. In the service settings:
   - set the health check path to `/healthz`;
   - set the **draining time** (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`) to `30`, a little above
     `SHUTDOWN_GRACE_SECONDS`. Railway's default is 0 seconds, which would cut running reviews
     off. Cut-off reviews are re-queued and run again after the deploy, but a longer draining
     time lets most finish first.
4. Set the variables above.
5. Generate a domain, and point the GitHub App's webhook URL at `https://<domain>/webhook`.

(Railway's config-as-code `railway.toml` is deprecated, so these settings live in the
service.)

**Any other container platform:**

```sh
docker build -t multi-review .
docker run -p 8080:8080 -v pr-review-data:/data --env-file .env multi-review
```

- **Shutdown:** give the platform a stop timeout above `SHUTDOWN_GRACE_SECONDS`.
- **Resources:** each pass is its own Claude Code process. Up to
  `MAX_CONCURRENT_REVIEWS × REVIEW_MAX_PARALLEL_PASSES` run at once (4 by default). Plan on
  roughly 1–2 GB RAM per process (an estimate, not measured), plus disk for checkouts, which
  are deleted after each review.

### 5. Turn it on

1. Open a test PR as a trusted author.
2. Check the logged review (`would post`).
3. Set `POST_REVIEWS=true`.

## Local / CI usage

```sh
npm ci && npm run build
CLAUDE_CODE_OAUTH_TOKEN=... node dist/cli.js --repo ../my-repo --base origin/main [--head HEAD] [--json] [--verbose]
```

- **What it reviews:** the committed `--head`, checked out into its own worktree. Uncommitted
  edits are ignored.
- **Output:** the same summary the service would post, printed instead of posted.
- **Exit code:** 2 when a high-severity finding is reported, so the CLI can gate a CI job.
- **In GitHub Actions:** check out with `fetch-depth: 0`, so the merge base exists.

## Customising reviews

Add a `REVIEW.md` at the repo root on the branch PRs merge into. Use it for house rules,
severity calibration, or paths to ignore. `CLAUDE.md` there is read too, and `@path` imports in
either file are followed.

To give the review structure, add these sections to `REVIEW.md`:

```markdown
## Passes

- **Bugs:** logic errors, races, regressions.
- **Security:** who may claim, approve or be paid.
- **Compliance:**
  - a bug fix comes with a test that fails without the fix;

## Severity

- **Important:** would break behavior or a contract.
- **Nit:** naming, style and wording.
```

Each pass costs one more review run.

## Development

```sh
npm test            # unit tests: real git on temp repos, scripted agent, fake GitHub
npm run typecheck   # source and tests
npm run test:live   # real-SDK probes against canary files (costs a few cents)
npm run dev         # run the service locally
npm run backtest -- --repo owner/name --pr 212   # replay labelled PRs and score recall
```

`backtest` reads the hidden `ai-review-ledger` that a reviewer leaves on each round's PR comment,
and treats each round's still-open findings as labels. It replays that commit through this
reviewer, then reports recall and precision against the labels. It only replays each PR's last
round unless you pass `--all-rounds`.

Matching is judged by a cheap agent call ("does any of our findings report the same defect?").
Line numbers drift between rounds, and one bug can be reported at its cause or its symptom.
Pass `--line-window N` to match by file and line instead, which is free but unreliable. Use
`--rescore results.json` to score saved results again without re-running reviews.

"Extras" in the output aren't necessarily false positives: the labels miss real bugs too, so
read them.

Design notes and the work log are in `.scratch/review-hardening/`.
