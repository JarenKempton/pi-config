---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
---

# Grill Me

Interview the user relentlessly about every aspect of their plan or design until you reach shared understanding.

## When to use

Use this skill when the user wants to:

- Stress-test a plan or design
- Be grilled on assumptions, scope, sequencing, risks, or tradeoffs
- Resolve a decision tree one branch at a time
- Mentions “grill me”

## How to run the interview

1. First identify the plan/design under review and the desired outcome.
2. If a question can be answered by exploring the codebase, inspect the codebase instead of asking the user.
3. Walk the decision tree one dependency at a time.
4. Ask exactly one question per turn.
5. For each question, include your recommended answer and why.
6. After the user answers, restate the resolved decision briefly, then move to the next unresolved branch.
7. Keep going until the plan is coherent, risks are explicit, and remaining unknowns are either resolved or intentionally deferred.

## Question format

Use this format:

```md
Question: <one focused question>

My recommended answer: <clear recommendation>

Why: <brief rationale>
```

## Rules

- Do not ask bundles of questions.
- Do not ask the user for facts that are available in the repository; inspect files instead.
- Do not move to implementation during the interview unless the user explicitly asks.
- Prefer dependency-order questions: decisions that unblock later branches come first.
- Be direct and persistent, but keep the interaction constructive.
