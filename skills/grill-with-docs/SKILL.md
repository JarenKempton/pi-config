---
name: grill-with-docs
description: Grilling session that challenges your plan against the existing domain model, sharpens terminology, and updates documentation (CONTEXT.md, ADRs) inline as decisions crystallise. Use when user wants to stress-test a plan against their project's language and documented decisions.
---

# Grill With Docs

Interview the user relentlessly about a plan until it is precise, consistent with the codebase, and captured in the project’s domain docs as decisions crystallize.

## Core behavior

1. Identify the plan under review and the desired outcome.
2. Inspect existing docs and code before asking questions that the repo can answer.
3. Walk the design tree one dependency at a time.
4. Ask exactly one question per turn.
5. For each question, provide your recommended answer.
6. Wait for the user’s answer before continuing.
7. When a term or domain boundary is resolved, update the relevant `CONTEXT.md` immediately.
8. Offer ADRs sparingly, only when the decision meets the ADR criteria below.

## Repository context discovery

Before the first substantive question, look for domain documentation:

- If `CONTEXT-MAP.md` exists at the repo root, read it and use it to locate the relevant bounded context.
- Otherwise, look for a root `CONTEXT.md`.
- Look for ADRs in `docs/adr/` for system-wide decisions.
- In multi-context repos, also look for context-specific `docs/adr/` directories beside the relevant `CONTEXT.md`.

Create files lazily:

- If no relevant `CONTEXT.md` exists, create it when the first canonical term is resolved.
- If no relevant `docs/adr/` exists, create it when the first ADR is needed.

## Domain awareness during the interview

### Challenge against the glossary

When the user uses a term that conflicts with existing language in `CONTEXT.md`, call it out immediately.

Example:

```md
Your glossary defines “cancellation” as X, but you seem to mean Y. Which is it?
```

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term.

Example:

```md
You’re saying “account”. Do you mean the Customer or the User? Those are different things.
```

### Discuss concrete scenarios

Stress-test domain relationships with specific scenarios. Invent scenarios that probe edge cases and force precise boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If the code contradicts the statement, surface it immediately.

Example:

```md
The code cancels entire Orders, but you just said partial cancellation is possible. Which is right?
```

## Documentation rules

### `CONTEXT.md`

Use `CONTEXT.md` only as a glossary. It must be devoid of implementation details. Do not use it as a spec, scratch pad, plan, or implementation decision log.

When a term is resolved, update `CONTEXT.md` immediately using [CONTEXT-FORMAT.md](references/CONTEXT-FORMAT.md).

### ADRs

Offer to create an ADR only when all three are true:

1. The decision is hard to reverse.
2. The decision would be surprising without context.
3. The decision involved a real trade-off between credible alternatives.

If any condition is missing, skip the ADR.

When an ADR is needed, use [ADR-FORMAT.md](references/ADR-FORMAT.md).

## Question format

Use this format:

```md
Question: <one focused question>

My recommended answer: <clear recommendation>

Why: <brief rationale>
```

After the user answers:

1. Restate the resolved decision briefly.
2. Update `CONTEXT.md` if a term or boundary was resolved.
3. Offer an ADR only if the ADR criteria are met.
4. Move to the next unresolved dependency.

## Rules

- Do not ask bundles of questions.
- Do not ask the user for facts available in the repository; inspect files instead.
- Do not move to implementation unless the user explicitly asks.
- Prefer dependency-order questions.
- Be direct and persistent, but constructive.
