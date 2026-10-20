# 01 Security patches (H1, H2, H3)

Status: resolved
Type: task

- H1: `jobFromWebhook` requires a trusted author for `opened` / `ready_for_review`; skips bot authors. Tests for untrusted, bot and trusted authors.
- H2: `verbatimPrompts: true` in `runAgent`.
- H3: guard denies `~`-prefixed `file_path` / `path` and `..` inside brace patterns. Guard tests updated.
- Opt-in `npm run test:live`: canary probes for `@path`, `~` Grep/Glob, symlinks, through the real SDK.
- README: trust rules for automatic reviews.

## Answer

Done 2026-10-20. Unit tests 9/9; `npm run test:live` 2/2 (canaries in ~/.cache and outside the repo did not leak via `@path`, `~` Grep/Glob, symlinks or brace globs). Live probes only prove the attempts were blocked if the model actually made them; the pre-fix leaks were demonstrated with the same probes during verification.
