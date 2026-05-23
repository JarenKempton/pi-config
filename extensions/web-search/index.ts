import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface StructuredSearchArgs {
  query?: string;
  exactPhrases?: string[];
  excludeTerms?: string[];
  site?: string;
  count?: number;
}

interface BuiltSearchQuery {
  query: string;
  baseQuery?: string;
  exactPhrases: string[];
  excludeTerms: string[];
  site?: string;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, num) => String.fromCharCode(parseInt(num, 10)));
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function normalizeDuckDuckGoUrl(href: string): string {
  const decoded = decodeHtml(href);
  try {
    const url = decoded.startsWith("//") ? new URL(`https:${decoded}`) : new URL(decoded);
    const uddg = url.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return url.toString();
  } catch {
    return decoded;
  }
}

async function duckDuckGoSearch(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);

  const resp = await fetch(url.toString(), {
    method: "GET",
    signal,
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`DuckDuckGo HTML search failed (${resp.status}): ${body.slice(0, 300)}`);
  }

  const html = await resp.text();
  const results: SearchResult[] = [];
  const blocks = html.split(/<div class="result results_links[^>]*>/g).slice(1);

  for (const block of blocks) {
    const linkMatch = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;

    const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/);
    const title = stripTags(linkMatch[2] || "");
    const resultUrl = normalizeDuckDuckGoUrl(linkMatch[1] || "");
    const snippet = stripTags(snippetMatch?.[1] || snippetMatch?.[2] || "");

    if (title && resultUrl) {
      results.push({ title, url: resultUrl, snippet });
    }
    if (results.length >= count) break;
  }

  return results;
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join("\n\n");
}

function stripWrappingQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).trim()
    : value;
}

function cleanItems(values?: string[]): string[] {
  if (!values) return [];
  return values
    .map((value) => stripWrappingQuotes(value.trim().replace(/\s+/g, " ")))
    .filter(Boolean);
}

function cleanQuery(value?: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned || undefined;
}

function normalizeSite(site?: string): string | undefined {
  if (typeof site !== "string") return undefined;

  let value = site.trim().replace(/^site:/i, "").trim();
  if (!value) return undefined;

  try {
    const candidate = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;
    const url = new URL(candidate);
    if (url.hostname) value = url.hostname;
  } catch {}

  return value.replace(/\/+$/, "") || undefined;
}

function quoteForSearch(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function buildSearchQuery(args: StructuredSearchArgs): BuiltSearchQuery {
  const baseQuery = cleanQuery(args.query);
  const exactPhrases = cleanItems(args.exactPhrases);
  const excludeTerms = cleanItems(args.excludeTerms);
  const site = normalizeSite(args.site);

  if (!baseQuery && exactPhrases.length === 0) {
    throw new Error("At least one of 'query' or 'exactPhrases' is required.");
  }

  const parts: string[] = [];
  if (baseQuery) parts.push(baseQuery);
  for (const phrase of exactPhrases) parts.push(quoteForSearch(phrase));
  for (const term of excludeTerms) parts.push(`-${term.includes(" ") ? quoteForSearch(term) : term}`);
  if (site) parts.push(`site:${site}`);

  return { query: parts.join(" "), baseQuery, exactPhrases, excludeTerms, site };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using DuckDuckGo's no-key HTML endpoint. Build one search per call from a base query string, exact phrases, exclusions, and an optional site. Returns title, URL, and snippet.",
    promptSnippet:
      "Search the web via DuckDuckGo using query plus optional exactPhrases, excludeTerms, and site. Use one tool call per search angle.",
    promptGuidelines: [
      "Use exactPhrases for exact phrase matching instead of embedding quote marks inside the main query string.",
      "Use one web_search tool call per search angle instead of batching multiple searches into one call.",
      "web_search uses a no-key DuckDuckGo HTML endpoint; if results are sparse, try a simpler query or a site-restricted query.",
    ],

    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Base search query as a normal string." })),
      exactPhrases: Type.Optional(Type.Array(Type.String({ description: "Exact phrases to match." }))),
      excludeTerms: Type.Optional(Type.Array(Type.String({ description: "Terms or phrases to exclude." }))),
      site: Type.Optional(Type.String({ description: "Optional site/domain restriction, such as example.com." })),
      count: Type.Optional(Type.Number({ description: "Number of results to return (default: 5, max: 10)", minimum: 1, maximum: 10 })),
    }),

    async execute(_toolCallId, params: StructuredSearchArgs, signal) {
      const count = Math.max(1, Math.min(params.count ?? 5, 10));
      const built = buildSearchQuery(params);
      const results = await duckDuckGoSearch(built.query, count, signal);

      return {
        content: [{ type: "text" as const, text: formatResults(results) }],
        details: {
          provider: "duckduckgo-html",
          composedQuery: built.query,
          query: built.baseQuery,
          exactPhrases: built.exactPhrases,
          excludeTerms: built.excludeTerms,
          site: built.site,
          resultCount: results.length,
        },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const { count, ...searchArgs } = args as StructuredSearchArgs;

      try {
        const built = buildSearchQuery(searchArgs);
        const display = built.query.length > 70 ? `${built.query.slice(0, 67)}...` : built.query;
        const lines = [theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${display}"`)];
        if (count && count !== 5) lines.push(theme.fg("dim", `  count: ${count}`));
        text.setText(lines.join("\n"));
        return text;
      } catch {
        text.setText(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("error", "(invalid query)"));
        return text;
      }
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

      if (isPartial) {
        text.setText(theme.fg("warning", "Searching…"));
        return text;
      }

      if (context.isError) {
        const msg = result.content.find((c) => c.type === "text")?.text || "Error";
        text.setText(theme.fg("error", msg));
        return text;
      }

      const details = result.details as { composedQuery?: string; resultCount?: number };
      const status = theme.fg("success", `${details?.resultCount ?? 0} results`);
      if (!expanded) {
        text.setText(status);
        return text;
      }

      const content = result.content.find((c) => c.type === "text")?.text || "";
      const preview = content.length > 500 ? `${content.slice(0, 500)}...` : content;
      const queryLine = details?.composedQuery ? theme.fg("dim", `query: ${details.composedQuery}`) : "";
      text.setText([status, queryLine, theme.fg("dim", preview)].filter(Boolean).join("\n"));
      return text;
    },
  });
}
