# claude-pr-review

An AI code reviewer for your GitHub pull requests, built on Claude. It runs on your own server,
reads each pull request, and leaves comments about real problems it finds, such as bugs, security
holes, or breaking a project rule.

It never approves, blocks or changes a pull request. It only comments.

For the full details (how it works inside, its safety measures, every setting), see
[docs/technical.md](docs/technical.md).

## What you'll see on a pull request

- **One summary comment** from the reviewer bot: what the change does, what it found, and what it
  checked. Later reviews update this same comment instead of adding new ones.
- **Comments on specific lines** for the more serious problems, sometimes with a one-click fix you
  can accept.
- **Reactions** on the pull request that show progress: 👀 working on it, 🎉 done, 😕 something
  went wrong. If something went wrong, the summary says why in one line.

It won't repeat a problem it already pointed out.

## When it reviews

- **Automatically, once,** when a pull request opens (or a draft is marked ready). This only
  happens for people in your organisation or with access to the repo, never for bots or
  outside contributors.
- **Whenever you ask.** Comment `@private-review` on any pull request to get another review of
  the new changes, or `@private-review full` to review the whole thing again. Only people with
  access to the repo can ask.

Pushing new commits does not trigger a review on its own. Ask with a comment when you want one.

## Setting it up

You need three things: a GitHub App (so it can read pull requests and comment), a Claude
account to pay for the reviews, and somewhere to run it.

1. **Create a GitHub App** in your organisation's settings (Developer settings → GitHub Apps).
   Give it permission to read code and to write pull requests and issues, and have it send
   *Pull request* and *Issue comment* events to `https://<your-server>/webhook`. Then install it
   on the repositories you want reviewed. [Step-by-step details](docs/technical.md#setup).
2. **Get a Claude token.** On a computer where you're signed in to Claude Code, run
   `claude setup-token`. Reviews then use that person's Claude plan.
3. **Run the service.** It's a single Docker container. It needs a small storage volume at
   `/data` so it remembers queued reviews across restarts. Railway works out of the box;
   [see the deployment notes](docs/technical.md#4-deploy).
4. **Fill in the settings** below, then open a test pull request. At first the reviewer only
   writes its reviews to its own logs. Once you're happy with them, set `POST_REVIEWS=true`.

## The settings that matter

| Setting | What it's for |
|---|---|
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | Your GitHub App's ID and private key |
| `GITHUB_WEBHOOK_SECRET` | The secret you gave the GitHub App, so the service knows messages really come from GitHub |
| `CLAUDE_CODE_OAUTH_TOKEN` | The Claude token from step 2 |
| `POST_REVIEWS` | `false` (the default) only logs reviews; `true` posts them on GitHub |
| `ALLOWED_REPOS` | Which repositories to review, e.g. `my-org/my-repo`. Leave empty for all |
| `DAILY_BUDGET_USD` | Stops starting new reviews once a day's spending reaches this (default $50) |

Everything else has sensible defaults. The [full list](docs/technical.md#3-configure) covers
the model, how thorough it is, time limits and more.

## Teaching it your rules

Put a `REVIEW.md` file at the root of your repository, on the main branch. Write your team's
rules in plain English, for example "every bug fix needs a test", or "don't flag style issues".
The reviewer follows them. It also reads `CLAUDE.md` if you have one.

You can sort its feedback into categories and severities too:

```markdown
## Passes

- **Bugs:** logic errors and things that break.
- **Security:** who may approve, claim or be paid.
- **Compliance:** every bug fix comes with a test.

## Severity

- **Important:** would break something or a rule.
- **Nit:** naming, style and wording.
```

The rules are always read from your main branch, so a pull request can't change the rules it is
reviewed by.

## Good to know

- **Cost:** a typical review costs roughly $0.40–0.70 of Claude usage (more for very large pull
  requests). On a Claude plan this comes out of that seat's usage. If the usage limit is reached,
  the review says so and you can ask again later.
- **How good it is:** on our tests with real pull requests, it caught about 9 in 10 of the serious
  issues a strong existing AI reviewer found, plus many real bugs that reviewer missed. About 1 in
  20 of its comments was wrong. It misses some smaller issues, so treat it as a second pair of
  eyes, not a replacement for human review.
- **Safety:** pull request text can't make it read files outside the code under review, run
  commands, or leak your keys. [How that's enforced](docs/technical.md#security-model).

## Trying it on your laptop

You can review a branch locally without GitHub. It prints the review instead of posting it:

```sh
npm ci && npm run build
CLAUDE_CODE_OAUTH_TOKEN=... node dist/cli.js --repo ../my-repo --base origin/main
```

## Credits

The review instructions are adapted from
[open-code-review](https://github.com/alibaba/open-code-review) (Apache-2.0) and
[PR-Agent](https://github.com/The-PR-Agent/pr-agent) (MIT). See [NOTICE](NOTICE).
