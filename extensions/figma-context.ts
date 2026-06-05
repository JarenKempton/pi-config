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

function rgba(fill: any): string | undefined {
  const color = fill?.color;
  if (!color) return undefined;
  const to255 = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255);
  const alpha = fill.opacity ?? color.a ?? 1;
  return alpha < 1
    ? `rgba(${to255(color.r)}, ${to255(color.g)}, ${to255(color.b)}, ${Number(alpha.toFixed(3))})`
    : `#${[color.r, color.g, color.b].map((n: number) => to255(n).toString(16).padStart(2, "0")).join("")}`;
}

function summarizePaints(paints: any[] | undefined): string[] | undefined {
  if (!Array.isArray(paints)) return undefined;
  const visible = paints.filter((paint) => paint.visible !== false).slice(0, 3);
  const values = visible.map((paint) => paint.type === "SOLID" ? rgba(paint) : paint.type).filter(Boolean) as string[];
  return values.length ? values : undefined;
}

function pickCssLike(node: any): Record<string, unknown> | undefined {
  const css: Record<string, unknown> = {};
  const box = node.absoluteBoundingBox;
  if (box?.width !== undefined) css.width = Math.round(box.width);
  if (box?.height !== undefined) css.height = Math.round(box.height);
  if (node.layoutMode) css.display = "flex";
  if (node.layoutMode === "HORIZONTAL") css.flexDirection = "row";
  if (node.layoutMode === "VERTICAL") css.flexDirection = "column";
  if (node.primaryAxisAlignItems) css.justifyContent = node.primaryAxisAlignItems;
  if (node.counterAxisAlignItems) css.alignItems = node.counterAxisAlignItems;
  if (node.itemSpacing !== undefined) css.gap = node.itemSpacing;
  if (["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].some((key) => node[key] !== undefined)) {
    css.padding = [node.paddingTop ?? 0, node.paddingRight ?? 0, node.paddingBottom ?? 0, node.paddingLeft ?? 0].join("px ") + "px";
  }
  const fills = summarizePaints(node.fills);
  if (fills) css.background = fills;
  const strokes = summarizePaints(node.strokes);
  if (strokes) css.borderColor = strokes;
  if (node.strokeWeight !== undefined) css.borderWidth = node.strokeWeight;
  if (node.cornerRadius !== undefined) css.borderRadius = node.cornerRadius;
  if (node.rectangleCornerRadii !== undefined) css.borderRadius = node.rectangleCornerRadii;
  if (node.opacity !== undefined && node.opacity !== 1) css.opacity = node.opacity;
  if (node.style) {
    const s = node.style;
    if (s.fontFamily) css.fontFamily = s.fontFamily;
    if (s.fontSize) css.fontSize = s.fontSize;
    if (s.fontWeight) css.fontWeight = s.fontWeight;
    if (s.lineHeightPx) css.lineHeight = Math.round(s.lineHeightPx);
    if (s.letterSpacing) css.letterSpacing = s.letterSpacing;
    if (s.textAlignHorizontal) css.textAlign = s.textAlignHorizontal;
  }
  return Object.keys(css).length ? css : undefined;
}

function pickUsefulNodeContext(document: any, state: { count: number; truncated: number }, depth = 0, maxDepth = 4, maxNodes = 120): unknown {
  if (!document || typeof document !== "object") return document;
  if (state.count >= maxNodes) {
    state.truncated += 1;
    return { truncated: true, reason: `maxNodes ${maxNodes} reached` };
  }
  state.count += 1;

  const useful: Record<string, unknown> = {
    id: document.id,
    name: document.name,
    type: document.type,
  };

  const css = pickCssLike(document);
  if (css) useful.css = css;
  if (document.characters !== undefined) useful.text = String(document.characters).slice(0, 240);
  if (document.componentProperties !== undefined) useful.componentProperties = document.componentProperties;
  if (document.variantProperties !== undefined) useful.variantProperties = document.variantProperties;

  if (depth >= maxDepth) {
    if (Array.isArray(document.children) && document.children.length) useful.childrenTruncated = document.children.length;
    return useful;
  }

  if (Array.isArray(document.children)) {
    useful.children = document.children
      .filter((child: any) => child?.visible !== false)
      .map((child: any) => pickUsefulNodeContext(child, state, depth + 1, maxDepth, maxNodes));
  }

  return useful;
}

function countKeys(value: unknown): number {
  return value && typeof value === "object" ? Object.keys(value as Record<string, unknown>).length : 0;
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
      compact: Type.Optional(Type.Boolean({ description: "Return a compact, bounded CSS/style tree instead of the full raw node", default: true })),
      maxDepth: Type.Optional(Type.Number({ description: "Maximum child depth to include in compact mode", default: 4 })),
      maxNodes: Type.Optional(Type.Number({ description: "Maximum nodes to include in compact mode", default: 120 })),
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

      const state = { count: 0, truncated: 0 };
      const maxDepth = Math.max(1, Math.min(params.maxDepth ?? 4, 8));
      const maxNodes = Math.max(20, Math.min(params.maxNodes ?? 120, 500));
      const document = params.compact === false
        ? nodeEntry.document
        : pickUsefulNodeContext(nodeEntry.document, state, 0, maxDepth, maxNodes);

      const result = {
        source: { url: params.url, fileKey, nodeId, fileName: nodeResponse.name },
        imageUrl,
        meta: {
          mode: params.compact === false ? "raw" : "compact-css-bounded",
          includedNodes: state.count || undefined,
          truncatedNodes: state.truncated || undefined,
          componentCount: countKeys(nodeEntry.components),
          styleCount: countKeys(nodeEntry.styles),
        },
        document,
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
