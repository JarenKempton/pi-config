# Project-specific guidance

Keep application URLs, authentication indicators, test accounts, environment safety rules, and preferred selectors in the project's own `AGENTS.md` or nearby testing documentation.

A compact project rule can use this shape:

```markdown
For UI changes and web bug reproduction, use the `test-in-browser` skill and the existing authenticated browser session. Verify against the documented development or QA URL. Treat redirects to login or SSO as an authentication handoff. Do not mutate production data without explicit approval. Report the tested URL, steps, expected/actual behavior, console or network failures, and screenshots.
```

Useful project details include:

- development, QA, staging, and production base URLs;
- a stable authenticated shell selector or expected page heading;
- known login, OAuth, and access-denied URL patterns;
- whether save/delete/deploy actions are permitted in each environment;
- test data ownership and cleanup rules;
- selectors such as `data-testid` attributes preferred by the application;
- focused flows that must be checked after particular path changes.

Do not put credentials, cookies, one-time codes, session exports, or private keys in project guidance.
