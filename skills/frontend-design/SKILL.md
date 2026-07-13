---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, or applications. Generates creative, polished code that avoids generic AI aesthetics.
license: Complete terms in LICENSE.txt
---

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Project Constraints and Creative Tension

Respect project constraints: existing design systems, component libraries, accessibility requirements, product principles, brand guidelines, repo conventions, and explicit user instructions override this global frontend-design guidance.

However, do not treat constraints as a reason to become generic. If a bold design idea may conflict with the project's current design level, design-system norms, or established UI patterns, ask the user for feedback before discarding it. Present the creative tradeoff clearly: what the project convention suggests, what the global frontend-design direction suggests, and why the deviation might be worth trying.

Use this skill to expand the design possibility space inside tight systems. Prefer experiments that can be implemented reversibly, behind isolated components, feature branches, or clearly scoped visual variations.

## Figma-to-Code Source of Truth

When a user provides a Figma link/node, treat Figma variables and measured browser output as the source of truth for visual parity.

Required workflow:
1. Use the Figma MCP design context, screenshot, and variable definitions for the target node.
2. Build a token map before coding. Do not assume project CSS variables with similar names have the same values as Figma variables.
3. Compare the Figma variable value to the project variable's computed value. If they differ, call out the mismatch explicitly and choose one:
   - exact Figma parity for this component via local CSS/custom properties, or
   - existing app-system consistency using project tokens.
4. For visual QA, use the authenticated browser to inspect computed styles for the implemented component and compare against Figma values: dimensions, padding, gap, border, radius, background, typography, and control states.
5. If an existing component has the right semantics but wrong visual metrics, add narrow local overrides or propose a design-token cleanup. Do not silently accept the mismatch.

Current SalesAi Figma token mapping notes / proof-of-concept glossary:

| Figma token | Figma value observed | Project token caveat |
| --- | ---: | --- |
| `surfaces/raised` | `#141416` | Project `--surfaces-raised` is currently `#18181a`; do not treat as equivalent. |
| `surfaces/high` | `#1c1c1e` | Project `--surfaces-high` is currently `#141416`; this matches Figma `surfaces/raised`, not Figma `surfaces/high`. |
| `surfaces/higher` | `#202022` | Project `--surfaces-higher` is currently `#1e2021`; close but not exact. |
| `borders/brand` | `#3ede6f` | Project `--borders-brand` matches. |
| `borders/subtle` | `#272729` | Verify project token before use. |
| `borders/strong` | `#353637` | Verify project token before use. |
| `borders/stronger` | `#4e4f50` | Verify project token before use. |
| spacing `xxxs` | `2px` | Prefer exact spacing value if project spacing aliases differ. |
| spacing `xxs` | `4px` | Figma button/control radius may be `4px`; existing components can default to `8px`. |
| spacing `xs` | `8px` | Verify against `--xs` / `--default-spacing` in project. |
| spacing `sm` | `12px` | Verify against project token. |
| spacing `md` | `16px` | Verify against project token. |

For SalesAi work, phrase design-token findings in Figma terms first (`surfaces/high`, `borders/brand`, etc.), then note the current CSS variable implementation. This keeps design/product/code conversations aligned even while globals are inconsistent.

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for plain HTML/CSS. In component frameworks, use the project's established animation library when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Remember: modern coding agents are capable of extraordinary creative work. Don't hold back; show what can truly be created when thinking outside the box and committing fully to a distinctive vision.
