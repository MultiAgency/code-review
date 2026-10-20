# Glossary

**Finding**: one defect the review reports: file, line, severity, title, body, the `existing_code` it
refers to, and an optional suggested fix. _Avoid_: issue, comment (a comment is how a finding is posted).

**Review pass**: the agent run that reads a PR and produces candidate findings.

**Verify pass**: the second agent run that tries to refute each candidate finding. It removes a
finding only with proof from the code; findings it can't check are kept and labelled unverified.

**Fingerprint**: a stable hash of a finding's path and normalised title, used to recognise the same
finding across reviews so it is never posted twice. The review pass is told to repeat earlier
findings word-for-word, which keeps titles stable.

**PR workspace**: the shallow checkout of a PR plus everything a review needs from git: the repo
directory, the instructions ref, the diff, the changed files and the reviewed head commit.

**Instructions ref**: the commit `CLAUDE.md` / `REVIEW.md` are read from: the base branch, never the PR.

**Agent runner**: runs one agent pass (prompt, output schema, readable roots) and returns parsed data
or a typed failure, plus cost.

**Review report**: the rendered result of a review: the summary comment body and the inline comments,
redacted and size-limited. Pure; knows nothing about GitHub transport.

**Summary comment**: the single PR comment the service edits in place on every review. It carries
hidden markers for the reviewed head and the fingerprints of posted findings.

**Publisher**: delivers a review report somewhere: GitHub (summary comment, inline comments,
reactions) or a log (dry run).

**Review job**: one queued request to review a PR, from an automatic trigger or a trigger phrase.
Persisted until it finishes.

**Trigger phrase**: the PR comment line (`@private-review`, or `@private-review full`) that requests
a review. Only owners, members and collaborators can use it.

**Trusted author**: a PR author or commenter whose `author_association` is OWNER, MEMBER or
COLLABORATOR.

**Pass**: one focused review run, named by the repository's `REVIEW.md` (e.g. Bugs, Security,
Compliance). Passes run in parallel; their findings are merged before the verify pass.

**Label (severity)**: the repository's own name for a severity (e.g. Important, Nit), mapped onto
high / medium / low by position.

**Eval case**: a commit plus the findings an existing reviewer's ledger says were still open there;
used by `backtest` to measure recall.
