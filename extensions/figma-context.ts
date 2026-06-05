import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const FIGMA_NODE_URL_RE = /figma\.com\/(?:file|design)\/([^/?#]+).*?[?&]node-id=([^&#]+)/;

type FigmaApiNodeResponse = {
  name?: string;
  nodes?: Record<string, { document?: unknown; components?: unknown; styles?: unknown; schemaVersion?: number }>;
};

function parseFigmaNodeUrl(url: string): { fileKey: string; nodeId: string } {
  const match = url.match(FIGMA_NODE_URL_RE);
  if (!match) {
    throw new Error("Expected a Figma file/design URL containing ?node-id=..., e.g. https://www.figma.com/design/<fileKey>/...?node-id=1-2");
  }

  return {
    fileKey: match[1],
    nodeId: decodeURIComponent(match[2]).replace("-", ":"),
  };
}

function pickUsefulNodeContext(document: any): unknown {
  if (!document || typeof document !== "object") return document;

  const useful: Record<string, unknown> = {};
  for (const key of [
    "id",
    "name",
    "type",
    "visible",
    "locked",
    "absoluteBoundingBox",
    "absoluteRenderBounds",
    "constraints",
    "layoutMode",
    "layoutWrap",
    "layoutSizingHorizontal",
    "layoutSizingVertical",
    "primaryAxisSizingMode",
    "counterAxisSizingMode",
    "primaryAxisAlignItems",
    "counterAxisAlignItems",
    "paddingLeft",
    "paddingRight",
    "paddingTop",
    "paddingBottom",
    "itemSpacing",
    "fills",
    "strokes",
    "strokeWeight",
    "strokeAlign",
    "cornerRadius",
    "rectangleCornerRadii",
    "effects",
    "opacity",
    "blendMode",
    "characters",
    "style",
    "characterStyleOverrides",
    "styleOverrideTable",
    "componentId",
    "componentPropertyReferences",
    "componentProperties",
    "variantProperties",
  ]) {
    if (document[key] !== undefined) useful[key] = document[key];
  }

  if (Array.isArray(document.children)) {
    useful.children = document.children.map(pickUsefulNodeContext);
  }

  return useful;
}

async function figmaGet(path: string, token: string): Promise<any> {
  const res = await fetch(`https://api.figma.com/v1${path}`, {
    headers: { "X-Figma-Token": token },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Figma API ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }

  return res.json();
}

export default function figmaContextExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "figma_context",
    label: "Figma Context",
    description: "Fetch useful design context for a Figma node URL using the Figma REST API. Requires FIGMA_TOKEN.",
    promptSnippet: "Use figma_context when the user provides a Figma node URL and asks to inspect design styles, layout, typography, colors, or component context.",
    promptGuidelines: [
      "Ask the user to set FIGMA_TOKEN if authentication fails or the token is missing.",
      "Treat returned CSS as an approximation; prefer the raw node data for exact decisions.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Figma file/design URL containing a node-id query parameter" }),
      includeImage: Type.Optional(Type.Boolean({ description: "Include a rendered PNG export URL", default: true })),
      compact: Type.Optional(Type.Boolean({ description: "Return a compact style/layout-focused tree instead of the full raw node", default: true })),
    }),
    async execute(_toolCallId, params) {
      const token = process.env.FIGMA_TOKEN;
      if (!token) {
        throw new Error("FIGMA_TOKEN is not set. Create a Figma personal access token and export FIGMA_TOKEN=figd_...");
      }

      const { fileKey, nodeId } = parseFigmaNodeUrl(params.url);
      const encodedNodeId = encodeURIComponent(nodeId);
      const nodeResponse: FigmaApiNodeResponse = await figmaGet(`/files/${fileKey}/nodes?ids=${encodedNodeId}`, token);
      const nodeEntry = nodeResponse.nodes?.[nodeId];
      if (!nodeEntry?.document) throw new Error(`No Figma node returned for ${nodeId}`);

      let imageUrl: string | undefined;
      if (params.includeImage !== false) {
        const imageResponse = await figmaGet(`/images/${fileKey}?ids=${encodedNodeId}&format=png&scale=2`, token);
        imageUrl = imageResponse.images?.[nodeId];
      }

      const result = {
        source: { url: params.url, fileKey, nodeId, fileName: nodeResponse.name },
        imageUrl,
        components: nodeEntry.components,
        styles: nodeEntry.styles,
        document: params.compact === false ? nodeEntry.document : pickUsefulNodeContext(nodeEntry.document),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerCommand("figma-context", {
    description: "Fetch Figma node context: /figma-context <figma node url>",
    handler: async (args, ctx) => {
      const url = args.trim();
      if (!url) {
        ctx.ui.notify("Usage: /figma-context <figma node url>. Requires FIGMA_TOKEN.", "warning");
        return;
      }
      ctx.ui.notify("Ask Pi to use the figma_context tool with that URL; the tool is registered for this session.", "info");
    },
  });
}
