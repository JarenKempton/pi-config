# ADR format

Use ADRs only for decisions that are hard to reverse, surprising without context, and the result of a real trade-off.

Create ADRs in the relevant `docs/adr/` directory. Use the next sequential number if the repo already uses numbered ADRs.

Filename format:

```text
NNNN-short-kebab-title.md
```

Document format:

```md
# NNNN. <Decision title>

Date: YYYY-MM-DD
Status: Accepted

## Context

<What situation forced the decision? Include only enough background to understand the trade-off.>

## Decision

<The decision in one or two direct paragraphs.>

## Alternatives considered

- <Alternative>: <why it was not chosen>
- <Alternative>: <why it was not chosen>

## Consequences

- <Positive consequence>
- <Negative or trade-off consequence>
- <Operational follow-up, if any>
```

## ADR writing rules

- Be concise.
- Capture why, not just what.
- Do not include implementation tasks unless they are essential consequences.
- Do not create ADRs for ordinary product copy, reversible UI choices, or low-cost implementation details.
