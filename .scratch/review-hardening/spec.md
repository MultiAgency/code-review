# Spec: harden and deepen the PR reviewer

Status: agreed 2026-10-20 (design review rounds 1–2). Terms as in `GLOSSARY.md`.

## Why

A deep review found three confirmed security holes (H1–H3), several ways a review is silently lost
(M1–M6), and modules that can't be tested without paying Claude. Research into PR-Agent,
alibaba/open-code-review and Kodus found none that fits our constraints (Claude via the Team
subscription token, one container, path-confined agent), so we keep our own tool and borrow their
proven patterns. We write our own prompts and code; nothing is copied from those projects.

## Decisions

Security (ship first, standalone):
- H1: automatic reviews only for trusted authors; bots get none. Trusted members can still use the trigger phrase on any PR.
- H2: `verbatimPrompts: true` on every agent pass.
- H3: the path guard denies `~`-prefixed paths and `..` inside brace patterns.

Review behaviour:
- One summary comment per PR, edited in place, with hidden markers: reviewed head, fingerprints of posted findings, status.
- Re-review via trigger phrase covers commits since the last reviewed head when it is an ancestor; full review after a rebase or with `@private-review full`.
- Open findings from earlier reviews go into the prompt to be repeated word-for-word if still present. A finding is resolved only by a full review at a new head.
- Findings carry `existing_code`; placement: quoted-code match in the diff → in-diff line → file comment → summary.
- High and medium findings inline, max 10; low findings and overflow in the summary only.
- Suggested fixes render as a `suggestion` block only when they replace exactly the finding's lines; model-written suggestion fences elsewhere are neutralised.
- Verify pass: remove only with proof; never remove concurrency, memory-safety or behaviour/compatibility findings; on failure keep findings, labelled unverified.
- Skip lockfiles, build output, minified, vendored and binary files; skip the review if nothing is left.

Operations:
- Status reactions 👀 / 🎉 / 😕 and a one-line failure reason from a fixed list; raw errors never posted. App needs Issues: write.
- Review jobs persisted in `node:sqlite` at `/data/jobs.db` (Railway volume): delivery-id dedupe, 3 retries with backoff for transient failures, no retry for budget / bad output / auth, interrupted jobs resumed on start.
- Timeouts: 20 min per agent pass, 50 min per job, 2 min per git/GitHub call; fresh GitHub token before posting; comments pinned to the reviewed head only while the PR still contains it.
- Drop `railway.toml` (Railway config-as-code is deprecated); document service settings and a ~30 s draining time in the README.

Structure (in order): agent runner → PR workspace (absorbs the diff module) → review report + publisher → review queue → env/config cleanup. The CLI stays as the local adapter and never posts.

Testing: tests at each deepened module's interface replace tests that reach past it. Real-SDK guard probes live in an opt-in `npm run test:live`.

## Tickets

See `issues/` (01 first; the rest in order).
