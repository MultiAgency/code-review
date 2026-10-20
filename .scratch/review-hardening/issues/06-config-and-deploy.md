# 06 Config, env policy and deploy docs

Status: resolved
Type: task
Blocked by: 05

Validated config built at entry points and passed down. One env policy module (Claude env, git env, redaction). Drop railway.toml; README documents Railway service settings, volume at /data, draining ~30 s, Issues: write permission. Fix README "default branch" wording; type-check tests.

## Answer

Done 2026-10-20 (container image built and checked: health, /data owned by node, config errors stop startup). `src/config.ts`: zod-validated env, `loadConfig` / `checkServiceConfig` at the entry points, options passed down; bad values (e.g. `MAX_CONCURRENT_REVIEWS=0`) stop startup with a list. `src/env.ts`: one env policy: Claude gets only its own auth (cloud creds only for its provider, lowercase proxies kept), git gets no model or GitHub credentials and no host config, redaction. GitHub auth decoupled from config (`installationToken`). `railway.toml` removed; README rewritten (Railway volume + draining, Issues: write, Issue comment event, `fetch-depth: 0`, base-branch wording). `npm run typecheck` covers tests. Tests: 67 unit, 3 live.
