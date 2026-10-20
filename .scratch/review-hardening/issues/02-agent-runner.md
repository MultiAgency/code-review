# 02 Agent runner seam

Status: resolved
Type: task
Blocked by: 01

Generic runner (prompt, schema, roots, signal → data | typed failure, cost). SDK adapter owns the hook, env allowlist, verbatimPrompts, budgets, 20-min pass timeout. Scripted adapter for tests. Review options as parameters. Verify pass: proof-only removal, protected categories, fail-open with "unverified" label. Tests at the review module's interface.

## Answer

Done 2026-10-20. `src/agent.ts`: `AgentRunner` interface, `sdkAgentRunner` adapter (hook, env, verbatimPrompts, budgets, pass timeout, typed failures), scripted adapter in `test/support/`. Review module takes `{ agent, options }`; verify is proof-only, protects concurrency/memory_safety/compatibility, fails open as `unverified`. Found and fixed: the SDK stream throws after an error result, which the adapter had reported as `crashed`. Tests: 17 unit, 3 live.
