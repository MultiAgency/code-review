# 1. Classes only for long-lived state with a lifecycle

Status: accepted, 2026-10-21

## Context

The codebase is a functional core with an imperative shell: pure functions for transformations
(triggers, report, eval scoring, config, diff parsing, placement), and factory functions that
return interface-typed objects at the seams (agent runner, GitHub client, publisher, queue,
workspace), with dependencies passed in. Classes are used only for error types.

Two modules hold real mutable state and have a lifecycle: the review queue (running jobs, a
closing flag, a SQLite handle; `close`) and the workspace (temporary directories; `dispose`). As
closures their state is implicit, and every workspace caller hand-writes `try/finally` around
`dispose`.

## Decision

Use a class when a module is long-lived, holds mutable state and has a lifecycle (start, close,
dispose). Everything that transforms data stays a plain function. No inheritance: variation comes
from swapping adapters behind an interface, never from subclassing.

Classes that own resources implement `Symbol.asyncDispose`, so callers write `await using`.

## Consequences

- The review queue and the workspace become classes when they are next refactored (ticket 08).
  Their interfaces, and the tests written against them, don't change.
- New modules follow the rule; reviews can point at this ADR instead of re-arguing style.
- Methods passed as callbacks must be bound (or be arrow-function properties).
