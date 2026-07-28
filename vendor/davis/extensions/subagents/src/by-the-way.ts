import type { SubagentOrigin } from "./domain.ts";

export const BTW_TITLE_MAX_LENGTH = 60;

/** Build a compact dashboard title from the first non-empty prompt line. */
export function deriveBtwTitle(prompt: string) {
  const firstLine = prompt
    .split("\n")
    .find((line) => line.trim())
    ?.trim();
  const title = firstLine?.replace(/\s+/g, " ") ?? "";
  if (!title) return "by the way";
  const codePoints = Array.from(title);
  if (codePoints.length <= BTW_TITLE_MAX_LENGTH) return title;
  return `${codePoints.slice(0, BTW_TITLE_MAX_LENGTH - 1).join("")}…`;
}

export function buildBtwWorkerContract(prompt: string, answer: string) {
  return [
    "# Work contract",
    "",
    "## Original BTW request",
    prompt.trim(),
    "",
    "## Planner outcome",
    answer.trim(),
    "",
    "## Required execution report",
    "Report changed files, verification performed, remaining risks, and any work deliberately left undone.",
  ].join("\n");
}

export function buildBtwParentHandoff(title: string, answer: string) {
  return [
    `BTW handoff from “${title}” (explicitly queued by the user):`,
    "",
    answer.trim(),
  ].join("\n");
}

/** User asides remain visible in the dashboard but hidden from model tools. */
export function isModelVisible(snap: { readonly origin: SubagentOrigin }) {
  return snap.origin === "model";
}
