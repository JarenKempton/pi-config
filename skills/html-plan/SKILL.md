---
name: html-plan
description: Create a strict Markdown plan and compile it into polished, self-contained HTML after a rigorous decision interview. Use when the user asks for an HTML plan, visual plan, interactive roadmap, or to be interviewed or grilled before producing one. Also use when the user wants to teach or update preferences for how compiled plans should work.
---

# HTML Plan

Produce a canonical `.plan.md` planning source and a deterministically compiled HTML artifact only after establishing explicit shared understanding. Keep planning separate from implementing the plan. Models own content and semantic intent; compiler code owns HTML, CSS, SVG, accessibility, responsive behavior, and print.

## Invocation

Support both natural-language requests and:

```text
/skill:html-plan [optional initial topic]
```

Treat command arguments as the initial topic. If no topic is supplied, infer it from the conversation and project; ask for it only when it cannot be discovered.

## Non-negotiable gate

Do not create, regenerate, or modify a canonical plan source or its HTML artifact until the user has both:

1. explicitly confirmed the shared-understanding summary; and
2. explicitly authorized plan generation and rendering.

A request to plan or to start the interview is not generation authorization. Until the gate is passed, inspect, research, interview, and summarize only.

## Interview workflow

### 1. Discover before asking

Inspect the current environment for relevant facts before the first question and as new branches emerge. Read the repository structure, instructions, documentation, existing plans/reports, issue context, code, configuration, and git state as applicable. Use available research tools for external facts when needed.

Never ask the user for a fact that can be discovered safely. Ask about choices, intent, priorities, constraints, and genuinely unavailable context.

### 2. Grill one decision at a time

Run a relentless, one-question-at-a-time interview. Resolve decision dependencies branch-by-branch:

- maintain a private decision tree and a visible decision ledger;
- settle prerequisite decisions before dependent ones;
- follow each answer into its unresolved branch instead of jumping across topics;
- challenge contradictions, vague language, hidden assumptions, and unowned tradeoffs;
- continue until every material branch is decided or explicitly deferred with an owner and consequence.

Every turn must contain exactly one decision question and then stop. Use this compact structure:

```text
What I understand: <relevant current state>
Question: <one decision only>
Options/tradeoff: <concise choices when useful>
Recommendation: <recommended answer and why>
```

Always provide a recommended answer, including for open-ended questions. Wait for the user's response before asking the next question. Do not bundle follow-ups, even if several are obvious.

Cover only branches relevant to the topic, typically: audience and purpose, scope and non-goals, desired outcomes, sequencing, dependencies, constraints, ownership, risk posture, evidence, success criteria, artifact behavior, and unresolved decisions.

### 3. Confirm shared understanding

When the decision tree is exhausted, present a concise synthesis containing:

- objective, audience, scope, and non-goals;
- confirmed decisions and rationale;
- assumptions;
- unresolved or explicitly deferred items;
- proposed phases and dependency order;
- risks and mitigations;
- success criteria;
- intended artifact location and interaction model.

Then ask one final gate question recommending generation, for example:

> Does this accurately capture our shared understanding, and do you authorize me to generate the canonical plan and render its HTML artifact now? Recommended: yes, if the summary is correct; otherwise name the one correction to resolve first.

Wait. Proceed only after an explicit affirmative that confirms the summary and authorizes generation. If the user corrects anything, update the decision ledger, resolve any reopened branch one question at a time, and repeat the gate.

## Preference teaching mode

Enter this mode when the user says they want to teach the skill, update its preferences, or change how canonical plans and compiled artifacts should work.

1. Read this canonical file first: `/Users/jaren/.pi/agent/pi-config/skills/html-plan/SKILL.md`.
2. Inspect existing rules and discoverable examples before asking about preferences.
3. Interview one preference decision at a time using the same question format, recommendation, dependency order, and wait requirement.
4. Distinguish durable preferences from choices specific to one plan. Do not persist project-specific choices as global rules unless explicitly requested.
5. Summarize the resulting preference rules and the exact intended file change.
6. Ask one explicit confirmation question and wait.
7. Only after approval, persist the approved changes to the canonical `SKILL.md`. Do not modify another file unless the user separately approves an adjacent preferences reference.

Never silently rewrite preferences, infer approval from participation, or combine preference persistence with plan generation and rendering authorization. After editing, report exactly what changed.

## Choose and remember local storage

New plans remain local until the user separately authorizes publication. Strict `.plan.md` is canonical regardless of later rendering or hosting state; HTML is a reproducible build artifact.

Before generating a project's first canonical plan:

1. Resolve the project root to its canonical absolute path. Prefer the canonical git root when one exists; otherwise resolve the working directory without symlinks.
2. Read `/Users/jaren/.pi/agent/plans/.project-preferences.json` as strict JSON and validate schema version `1` before trusting it.
3. If exactly one entry matches the canonical project path, reuse its `central` or `project-local` destination without asking again.
4. If no entry matches, ask one `ask_user` question offering:
   - **Central plan library** at `/Users/jaren/.pi/agent/plans/` — recommend this for personal cross-project access unless the repository has a strong artifact convention.
   - **Project-local** — use the repository's existing artifact or report convention, falling back to `artifacts/`.
5. Persist the answer only after the user chooses. Update the preference registry atomically without changing other projects. Keep the directory mode `0700` and metadata mode `0600`.
6. If the registry is missing, initialize `{ "schemaVersion": 1, "projects": [] }`. If it is malformed, duplicated, unsupported, or ambiguous, stop and ask before repairing it; never silently replace valid state.

When the user explicitly requests a destination change, update that one canonical project entry and report the old and new value.

## Author and compile the artifact

After the gate passes and storage is resolved:

1. Choose one canonical lowercase basename. Write `<basename>.plan.md` as source and derive `<basename>.html` beside it. For central storage, use `/Users/jaren/.pi/agent/plans/`; for project-local storage, use the selected project convention.
2. Author only the supported contract: required YAML frontmatter, safe CommonMark/GFM, typed `plan:` fences, and approved `:::` directives. Do not write raw HTML, CSS, SVG, scripts, unknown directives, or remote runtime assets.
3. Express semantic intent rather than presentation instructions. Include the plan's decisions, assumptions, unresolved items, phases, dependencies, risks, success criteria, next actions, and factual citations near materially researched claims.
4. Format and lint the source, resolve all blocking diagnostics, freeze the resolved configuration in a render lock, and invoke the deterministic renderer. Never handcraft or patch the generated HTML to bypass compiler behavior.
5. The renderer must produce one self-contained HTML file with no CDNs, remote fonts, analytics, chart runtimes, or runtime network dependencies. Deterministic code owns hierarchy, components, CSS, inline SVG, syntax highlighting, navigation, accessibility, responsive behavior, and print.
6. If the compiler or an approved component is unavailable, preserve the valid `.plan.md` source and report rendering as blocked. Do not fall back to arbitrary model-authored HTML.
7. Set central source, lock, artifact, registry, and metadata files to mode `0600`. Project-local files follow repository policy unless it is less restrictive for sensitive content.
8. Register every central plan using its stable opaque `pln_` ID and canonical project path. Preserve identity across source edits and artifact rebuilds; update registries atomically and reject malformed, duplicate, unsupported, or ambiguous state rather than guessing.
9. Treat hosting as a separate adapter operation. Local, Tailscale, Cloudflare, or future host selection never changes canonical source or rendered bytes. Every host mutation requires discover → proposal → explicit confirmation → apply → read-back verification.
10. Do not implement the plan's product, code changes, migrations, publication, or operational steps. The canonical source and compiled HTML are planning deliverables only.

## Visual minimap navigation

Use a minimap only when the document is long enough that section position benefits the reader. Keep it a quiet visual rail rather than a second navigation panel:

- render equal, hairline horizontal marks approximately `1px` high in a very narrow fixed rail;
- keep inactive marks short and muted; extend only the current section mark modestly and do not add a scrollbar-like progress track;
- on desktop, allow hover or keyboard focus to reveal the section name and allow click activation to jump to it;
- on mobile, keep the rail visual-only: remove it from the accessibility tree and tab order, disable pointer interaction, labels, click navigation, dragging, and scrubbing;
- never enlarge mobile marks into touch handles or let the rail overlap content;
- hide the minimap in print.

Do not add a minimap to short plans where it would provide no positional value.

## Charts, diagrams, and graphs

Use visualizations evidence-first, never as decoration. Reserve **chart** for quantitative data, **diagram** for architecture, process, or state, and **graph** for node-edge networks or the mathematical concept.

Choose the visual from the reader's task and the structure of the data:

- use a line chart by default for change over ordered time;
- use a zero-baseline bar chart or aligned dot plot for category comparison, ranking, magnitude, or deviation;
- use a scatterplot for relationships between quantitative variables without implying causation;
- use a histogram, box plot, or dot/strip plot for distributions, stating binning or summary definitions;
- use 100% stacked bars for approximate comparison of multiple part-to-whole profiles, but not when exact comparison of middle segments is the task;
- use a pie chart only for an approximate reading of a small number of genuine, mutually exclusive parts of one meaningful whole; prefer aligned bars when differences need precise comparison;
- use a map only when geography is analytically relevant and a Sankey or network-flow diagram only when flow is the actual subject;
- use a table when readers need exact lookup or when a chart would not materially improve understanding.

Treat this mapping as an evidence-backed default, not a universal law. Start with the message the reader should take away, and do not force data into an unsuitable chart form.

Apply these integrity and implementation rules:

1. Plot sourced or reproducibly computed data and link to the specific source. Include units, timeframe, population or geography, transformations, sample size, uncertainty, and retrieval or version details where applicable. Synthetic values may demonstrate mechanics only when prominently labeled as synthetic, fictional, or illustrative; never present them as findings.
2. Start every length-encoded bar at zero. A line chart or dot plot may use a non-zero scale when it reveals relevant variation without exaggeration, but its bounds and any break must be explicit. Use the same scale for directly compared small multiples.
3. Never rely on color alone. Prefer direct labels; otherwise combine color with visible text, shape, line style, pattern, or consistent ordering. Ensure chart text and essential marks meet applicable contrast requirements.
4. Give every meaningful chart equivalent visible HTML. Use a concise narrative when the intended takeaway is a pattern, an accessible table when readers need values or row-and-column structure, and both when the chart serves both purposes. Keep titles, takeaways, caveats, and sources as real HTML text rather than burying them in SVG metadata.
5. Prefer responsive inline SVG for real plots in self-contained plans. Use HTML/CSS for simple progress or single-value indicators. SVG is not automatically accessible: label the figure, provide a concise accessible name or description, and test the rendered result.
6. Keep the essential reading available without hover, animation, network access, or JavaScript and complete in print. Hover, keyboard-focus, and tap interactions may reveal exact point values or add precision, but must remain optional and use consistently compact popups.
7. Avoid 3D effects, ornamental chart backgrounds, heavy gridlines, unnecessary borders, shadows, markers, and legends. Do not use dual axes by default. Keep labels horizontal and use only enough light gridlines to read the scale.
8. Treat density limits as review triggers rather than hard pass/fail thresholds. Around four line series, four stacked or clustered categories, five pie slices, ten gridlines, or a dozen categories should prompt a legibility review, not automatic omission. Use direct labels, small multiples, a disclosed subset, or a table when the target viewport becomes cluttered. Never silently drop data.

## Verify and iterate

After authoring:

1. Validate the `.plan.md` source, formatter idempotency, render lock, diagnostics, and artifact digest. Inspect generated HTML for malformed markup, broken links, accidental external dependencies, and consistency with the confirmed decisions.
2. Automatically call `browser_qa` against the local HTML file in the user's existing visible browser. Give it a standalone task naming the file, allowing only read-only visual inspection and normal viewport/print-preview checks, prohibiting unrelated or consequential actions, and requiring screenshot evidence.
3. Check desktop and narrow responsive layouts, overflow, typography, contrast, navigation/interactions, accessibility, and print presentation.
4. Inspect the report and screenshots. If defects are found, change canonical Markdown when content or semantic intent is wrong; change compiler/theme code when presentation is wrong. Re-render and repeat QA until no material defect remains. Never patch generated HTML directly.
5. Report both source and artifact paths, compiler/theme versions or render lock, what was verified, any remaining limitations, and explicitly note that the plan itself was not implemented.
