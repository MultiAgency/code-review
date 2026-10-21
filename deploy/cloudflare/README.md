# Deploy on Cloudflare

A Worker forwards GitHub's webhook to the reviewer service, which runs as a Cloudflare Container
built from the repo's `Dockerfile` (one `standard-1` instance, on the MultiAgency account). An alarm
keeps the container up while reviews are running or queued; once idle it sleeps after 10 minutes.

- Webhook URL: `https://claude-pr-review.multidaomensional.workers.dev/webhook`
- Settings: `cloudflare.config.ts` (`POST_REVIEWS=true`, `REVIEW_MODEL`, …). Repositories: wherever the GitHub App is installed
- Secrets: a local file, never committed, with `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`,
  `GITHUB_APP_PRIVATE_KEY` (newlines written as `\n`) and `CLAUDE_CODE_OAUTH_TOKEN`.

```sh
npm ci
cf deploy --secrets-file ~/.config/claude-pr-review/cloudflare.secrets.env
```

Needs Docker (with working DNS for builds) and the Workers Paid plan. Local test: put dummy values
for the four secrets in `.dev.vars` and run `cf dev`.

**The container's disk is ephemeral.** The job queue survives while the container is up, which is
whenever reviews are running or queued; the daily spend total and webhook de-duplication reset
when it sleeps or is redeployed. A redeploy during a review stops it; ask again with the trigger
phrase.
