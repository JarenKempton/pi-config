---
name: bug-fix
description: Fix bugs with a regression-first TDD loop: confirm repro, write failing tests before production changes, report failures, then implement only after approval. Use when working on bug tickets, debugging broken behavior, fixing regressions, or when the user asks for a bug fix.
---

# Bug Fix

Use this skill for bug tickets and reported broken behavior. The core rule is: **capture the bug with a failing regression test or reproducible harness before changing production code.**

## Non-negotiable gate

Before production-code changes:

1. Confirm the actual bug and reproduction path with the user when ambiguous.
2. Sketch the regression tests/harnesses that will fail for the bug.
3. Add only those failing tests/harnesses. Do not fix production code yet.
4. Run the focused test command.
5. Report back with:
   - test/harness names and file paths
   - what each test asserts
   - the failing output
   - why the failures match the reported bug
   - the implementation plan to make them pass
6. Wait for explicit user approval before implementing the fix.

If no correct test seam exists, stop and explain why. Propose the closest runnable repro harness or manual HITL loop, then ask for approval before fixing.

## Workflow

### 1. Reproduce and minimize

- Restate the repro steps in the user's terms.
- Identify the smallest code path that exercises the behavior.
- Prefer existing tests near the affected code before creating new test files.
- Do not assume nearby behavior is the bug; verify the user's exact symptom.

### 2. Define failing tests before coding

For each test, specify:

- Given: starting state and fixtures
- When: user action or function call
- Then: expected behavior after the fix
- Why it fails today

Keep tests focused on behavior, not implementation details.

### 3. Add and run failing tests only

Allowed changes before approval:

- Test files
- Test fixtures/mocks needed to express the failing behavior
- Temporary repro harnesses under an obvious debug/test path

Not allowed before approval:

- Production source changes
- Refactors
- Cleanup unrelated to making the failing test compile/run

If the first test fails because the test is wrong, fix the test until it fails for the product bug.

### 4. Report and ask for approval

Do not proceed to implementation until the user approves the failing-test report.

Use this report shape:

```text
Failing regression tests added:
- path/to/test: "test name"
  - Asserts: ...
  - Fails with: ...
  - Matches bug because: ...

Fix plan:
1. ...
2. ...

Approve implementation?
```

### 5. Implement the smallest fix

- Change production code only after approval.
- Make the failing tests pass without weakening their assertions.
- Preserve existing behavior covered by nearby tests.
- Add targeted additional tests only if implementation reveals another relevant edge case.

### 6. Validate and clean up

Before declaring done:

- Re-run the focused regression tests.
- Run relevant lint/type/test quality gates when feasible.
- Remove temporary debug logs/harnesses unless intentionally committed as tests.
- Summarize root cause and why the regression tests prevent recurrence.

## Interaction with start-ticket

When `start-ticket` identifies a ticket as a bug, it should stop after planning and explicitly name this skill as the next execution workflow. The bug-fix workflow then owns the failing-test gate and implementation.
