# 03 PR workspace (absorbs the diff module)

Status: resolved
Type: task
Blocked by: 02

One module: fetch head by SHA (fixes M3), merge base, instructions ref, diff with pinned prefixes and --no-textconv, file list from --name-status -z (renames, deletions, binaries), commentable lines, skip-file filters, incremental range from a previous head. Local-checkout adapter for the CLI. Tests on file:// temp repos.

## Answer

Done 2026-10-20. `src/workspace.ts`: `Workspace` (repoDir, workDir, headSha, range, diff(), instructions(), dispose()) with a PR adapter (head fetched by SHA — fixes M3; base tip + diff base blobless; incremental via `diffBase`) and a local adapter (detached worktree at head — fixes L8; clear error without a merge base). Diff: pinned prefixes, --no-textconv, host git config disabled, `--name-status -z` file list (renames, deletions, binaries — fixes L4), C-unquoting and trailing-TAB handling (fixes L3), lockfile/build/vendor skip list. `test/git.test.ts` replaced by `test/workspace.test.ts` (8 tests on file:// repos). Live CLI e2e passed. Git fetch timeout is 10 min (others 2 min): a 111 MB shallow fetch took 5 min on this machine's network.
