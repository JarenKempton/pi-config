---
name: to-prd
description: Turn the current conversation context into a PRD and publish it to the project issue tracker. Use when user wants to create a PRD from the current context.
---

# To PRD

Turn the current conversation context and codebase understanding into a PRD, then publish it to the project issue tracker.

Do **not** interview the user to discover requirements. Synthesize from the conversation, existing repo context, domain glossary, ADRs, and codebase state.

If the issue tracker and triage label vocabulary have not been provided, run `/setup-matt-pocock-skills` or ask the user to provide the missing tracker setup before publishing.

## Process

1. Explore the repo to understand the current state of the codebase, unless already done in this conversation.
   - Use the project’s domain glossary vocabulary throughout the PRD.
   - Respect ADRs in the area being touched.
   - If a repo has `CONTEXT-MAP.md`, use it to find the relevant context.
   - Otherwise look for `CONTEXT.md`, `docs/`, and `docs/adr/`.

2. Sketch the major modules that need to be built or modified.
   - Actively look for opportunities to extract deep modules that can be tested in isolation.
   - A deep module encapsulates substantial functionality behind a simple, stable, testable interface.
   - Avoid file-path-level commitments in the PRD unless the tracker workflow explicitly needs them.

3. Check with the user that the module sketch matches their expectations.
   - Ask which modules they want tests written for.
   - This is the only required confirmation step. Do not use it to reopen product discovery.

4. Write the PRD using the template below.

5. Publish the PRD to the project issue tracker.
   - Apply the `ready-for-agent` triage label.
   - No additional triage is needed.

## PRD template

```md
## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format:

1. As an <actor>, I want a <feature>, so that <benefit>

The list should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built or modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do **not** include specific file paths or code snippets. They may become outdated quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can, such as a state machine, reducer, schema, or type shape, inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts only.

## Testing Decisions

A list of testing decisions that were made. Include:

- What makes a good test: test external behavior, not implementation details
- Which modules will be tested
- Prior art for tests, such as similar test styles in the codebase

## Out of Scope

A description of the things that are out of scope for this PRD.

## Further Notes

Any further notes about the feature.
```

## Publishing notes

- Use the project’s existing issue tracker tooling and conventions.
- Preserve project vocabulary from glossary/docs.
- Keep the PRD implementation-aware but not file-path brittle.
- If publishing fails due to missing auth or missing tracker configuration, present the PRD content and the exact command/setup needed to publish.
