# CONTEXT.md format

`CONTEXT.md` is a domain glossary. It captures the language of the business/domain and nothing else.

Do not include:

- Implementation details
- Database schema details
- API contracts
- UI behavior
- Open questions
- Plans or tasks
- ADR-style decision rationale

Use this structure:

```md
# Context

## Glossary

### <Canonical Term>

<Plain-language domain definition.>

Aliases: <optional comma-separated alternate names, only when useful>

Not: <optional list of nearby terms this must not be confused with>

Example: <optional concrete domain scenario>
```

## Entry guidelines

- One canonical concept per heading.
- Define what the term means in the domain, not how it is implemented.
- Prefer short definitions.
- Add aliases only when they prevent confusion.
- Add “Not” only when there is a real ambiguity.
- Add an example when the boundary is hard to understand without one.

## Update workflow

When a term is resolved during a grilling session:

1. Add it if missing.
2. Refine the existing definition if the user clarified it.
3. Remove contradictory or stale wording.
4. Keep the file alphabetized only if it already is. Otherwise preserve local organization.
