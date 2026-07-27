import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const COMPUTER_USE_SCRIPT = fileURLToPath(
  new URL(
    "../skills/codex-computer-use/scripts/codex_computer_use.py",
    import.meta.url,
  ),
);
const BROWSER_APPS = [
  "Helium",
  "Google Chrome",
  "Chromium",
  "Brave Browser",
  "Microsoft Edge",
] as const;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

interface ComputerUseResult {
  ok: boolean;
  final_message?: string;
  images?: string[];
  approved_apps?: string[];
  denied_elicitations?: string[];
  confirmations_required?: string[];
  error?: string | null;
}

export function parseComputerUseResult(stdout: string): ComputerUseResult {
  const parsed = JSON.parse(stdout) as ComputerUseResult;
  if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean") {
    throw new Error("Codex Computer Use returned an invalid result.");
  }
  return parsed;
}

function mimeType(path: string) {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

export default function browserQa(pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser_qa",
    label: "Browser QA",
    description:
      "Operate the user's existing visible browser through Codex Computer Use for visual QA, authenticated web checks, screenshots, and routine browser interaction. This is the reliable default browser path and does not depend on Playwright/CDP authorization. Read-only inspection is assumed unless the user explicitly requested a consequential action.",
    promptSnippet:
      "Visually inspect or operate the user's existing authenticated browser through Codex Computer Use",
    promptGuidelines: [
      "Use browser_qa by default for browser QA, visual verification, authenticated pages, and routine web interaction instead of attempting authenticated-browser MCP first.",
      "Give browser_qa a precise standalone task, name the target page or tab, request screenshot evidence, and prohibit unrelated or consequential actions.",
      "Use authenticated-browser MCP only when DOM, console, network, or trace inspection is specifically required and its preflight reports healthy; if it fails, fall back to browser_qa rather than asking the user to repeatedly authorize browser control.",
    ],
    parameters: Type.Object({
      task: Type.String({
        minLength: 1,
        maxLength: 12_000,
        description:
          "Standalone browser task for Codex Computer Use. Include the target, allowed interactions, prohibited side effects, and expected evidence.",
      }),
      app: Type.Optional(
        StringEnum(BROWSER_APPS, {
          description: "Visible browser application to control (defaults to Helium).",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const app = params.app ?? "Helium";
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Delegating visible browser QA to Codex Computer Use in ${app}…`,
          },
        ],
        details: { app, phase: "running" },
      });
      const result = await pi.exec(
        "python3",
        [
          COMPUTER_USE_SCRIPT,
          "--cwd",
          ctx.cwd,
          "--allow-app",
          app,
          "--",
          params.task,
        ],
        { signal, timeout: 10 * 60 * 1000 },
      );
      if (result.code !== 0) {
        throw new Error(
          result.stderr.trim() ||
            result.stdout.trim() ||
            `Codex Computer Use exited with code ${result.code}.`,
        );
      }

      const report = parseComputerUseResult(result.stdout);
      if (!report.ok) {
        throw new Error(report.error || report.final_message || "Browser QA failed.");
      }
      if (report.denied_elicitations?.length) {
        throw new Error(
          `Browser QA required unapproved app access: ${report.denied_elicitations.join(", ")}`,
        );
      }
      if (report.confirmations_required?.length) {
        throw new Error(
          `Browser QA stopped for confirmation: ${report.confirmations_required.join(", ")}`,
        );
      }

      const content: Array<
        { type: "text"; text: string } |
        { type: "image"; data: string; mimeType: string }
      > = [
        {
          type: "text",
          text: report.final_message?.trim() || "Browser QA completed.",
        },
      ];
      for (const imagePath of (report.images ?? []).slice(0, MAX_IMAGES)) {
        try {
          const image = await readFile(imagePath);
          if (image.byteLength <= MAX_IMAGE_BYTES) {
            content.push({
              type: "image",
              data: image.toString("base64"),
              mimeType: mimeType(imagePath),
            });
          }
        } catch {
          // The textual report remains useful if a temporary image disappeared.
        }
      }

      return {
        content,
        details: {
          app,
          approvedApps: report.approved_apps ?? [],
          screenshotCount: content.filter((item) => item.type === "image").length,
        },
      };
    },
  });
}
