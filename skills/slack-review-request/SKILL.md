---
name: slack-review-request
description: Generate concise copy-pasteable Slack messages requesting code review. Use when the user asks for a Slack PR ping, reviewer message, or review request.
---

# Slack Review Request

Create a short copy-pasteable message. Prefer a fenced markdown code block so the user can copy it directly.

## Gather

- PR URL
- Ticket URL(s), if any
- Short human summary of each ticket or change
- Optional video/demo URL
- Reviewer groups or people to mention

Use plain URLs inside the Slack block; Slack auto-linkifies them. Avoid markdown links inside the block.

## Style

- Brief and human.
- One light opening sentence.
- No corporate-speak.
- Vary phrasing across invocations.
- Include only useful lines: PR, Ticket(s), Video if present.
