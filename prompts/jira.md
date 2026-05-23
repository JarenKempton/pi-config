---
description: Pull Jira ticket context with local CLI tools
argument-hint: "<JIRA-KEY-or-URL>"
---
Use the jira-context skill for: $1

Extract the Jira key from `$1`, fetch the ticket with available local CLI tools, then summarize the task context and suggest the first repo files/commands to inspect. If no Jira CLI is authenticated, tell me the exact auth/setup command to run and ask me to paste the ticket text as a fallback.
