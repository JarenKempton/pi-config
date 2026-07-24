import { existsSync, readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Agent } from "undici";

const MAX_BYTES = 100_000;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;

function mappedIpv4(value: string): string | undefined {
  const suffix = value.toLowerCase().replace(/^::ffff:/, "");
  if (net.isIPv4(suffix)) return suffix;
  const groups = suffix.split(":");
  if (groups.length !== 2) return undefined;
  const high = Number.parseInt(groups[0] ?? "", 16);
  const low = Number.parseInt(groups[1] ?? "", 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return undefined;
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isPrivateIp(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    return (
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && (p[1] === 0 || p[1] === 168)) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19)) ||
      (p[0] === 198 && p[1] === 51 && p[2] === 100) ||
      (p[0] === 203 && p[1] === 0 && p[2] === 113) ||
      p[0] >= 224
    );
  }
  if (!net.isIPv6(ip)) return false;
  if (ip.startsWith("::ffff:")) {
    const mapped = mappedIpv4(ip);
    return mapped ? isPrivateIp(mapped) : true;
  }
  return (
    ip === "::1" ||
    ip === "::" ||
    ip.startsWith("fe") ||
    ip.startsWith("fc") ||
    ip.startsWith("fd") ||
    ip.startsWith("ff") ||
    ip.startsWith("2001:db8:")
  );
}

async function resolvePublicHttpUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs are allowed");
  if (url.username || url.password) throw new Error("URLs with embedded credentials are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("Loopback hosts are not allowed");
  if (net.isIP(host) && isPrivateIp(host)) throw new Error("Loopback/private/link-local IPs are not allowed");
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("DNS lookup returned no addresses");
  for (const answer of addresses) {
    if (isPrivateIp(answer.address)) throw new Error(`DNS resolved to blocked address ${answer.address}`);
  }
  return { url, addresses };
}

export async function validatePublicHttpUrl(raw: string): Promise<URL> {
  return (await resolvePublicHttpUrl(raw)).url;
}

function pinnedDispatcher(addresses: { address: string; family: number }[]) {
  let next = 0;
  return new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        const selected = addresses[next++ % addresses.length]!;
        if (options.all) callback(null, addresses as any);
        else callback(null, selected.address, selected.family);
      },
    },
  });
}

async function readLimited(resp: Response, cap = MAX_BYTES): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) return (await resp.text()).slice(0, cap);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) {
        chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - cap))));
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function directFetch(raw: string, signal?: AbortSignal): Promise<{ text: string; status: number; statusText: string; url: string; contentType: string; truncated: boolean }> {
  let resolved = await resolvePublicHttpUrl(raw);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("web_fetch timed out")), TIMEOUT_MS);
  if (signal) signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const dispatcher = pinnedDispatcher(resolved.addresses);
      try {
        const resp = await fetch(resolved.url.toString(), {
          redirect: "manual",
          signal: controller.signal,
          headers: { "User-Agent": "pi-web-fetch/1.1", Accept: "text/html,text/plain,application/json,*/*" },
          dispatcher,
        } as RequestInit & { dispatcher: Agent });
        if (resp.status >= 300 && resp.status < 400 && resp.headers.get("location")) {
          if (redirects === MAX_REDIRECTS) throw new Error("Too many redirects");
          resolved = await resolvePublicHttpUrl(new URL(resp.headers.get("location")!, resolved.url).toString());
          continue;
        }
        const contentType = resp.headers.get("content-type") ?? "";
        const contentLength = Number(resp.headers.get("content-length") ?? 0);
        const text = await readLimited(resp, MAX_BYTES);
        return { text, status: resp.status, statusText: resp.statusText, url: resp.url || resolved.url.toString(), contentType, truncated: text.length >= MAX_BYTES || contentLength > MAX_BYTES };
      } finally {
        await dispatcher.close();
      }
    }
    throw new Error("Too many redirects");
  } finally {
    clearTimeout(timeout);
  }
}

function loadFirecrawlApiKey(): string | undefined {
  if (process.env.FIRECRAWL_API_KEY?.trim()) return process.env.FIRECRAWL_API_KEY.trim();
  const envPath = join(homedir(), ".pi/agent/.env");
  if (!existsSync(envPath)) return undefined;
  const match = readFileSync(envPath, "utf8").match(/^\s*FIRECRAWL_API_KEY\s*=\s*(.+?)\s*$/m);
  return match?.[1]?.replace(/^['\"]|['\"]$/g, "").trim() || undefined;
}

async function firecrawlScrape(raw: string, signal?: AbortSignal): Promise<{ text: string; status: number; statusText: string; url: string; contentType: string; truncated: boolean }> {
  await validatePublicHttpUrl(raw);
  const apiKey = loadFirecrawlApiKey();
  if (!apiKey) throw new Error("Firecrawl fallback unavailable: FIRECRAWL_API_KEY not configured");
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(35_000)])
    : AbortSignal.timeout(35_000);
  const resp = await fetch("https://api.firecrawl.dev/v1/scrape", { method: "POST", signal: requestSignal, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ url: raw, formats: ["markdown"] }) });
  const body = await readLimited(resp, 500_000);
  let json: any;
  try { json = JSON.parse(body); } catch { json = { error: body.slice(0, 300) }; }
  if (!resp.ok) throw new Error(`Firecrawl scrape failed (${resp.status}): ${String(json?.error ?? json?.message ?? "").slice(0, 300)}`);
  const text = String(json?.data?.markdown ?? json?.markdown ?? json?.data?.html ?? "");
  return { text: text.slice(0, MAX_BYTES), status: resp.status, statusText: resp.statusText, url: raw, contentType: "text/markdown", truncated: text.length > MAX_BYTES };
}

function difficult(result: { status: number; contentType: string; text: string }) {
  return (
    result.status === 401 ||
    result.status === 403 ||
    result.status === 408 ||
    result.status === 429 ||
    result.status >= 500 ||
    (result.contentType.includes("text/html") &&
      result.text.replace(/<[^>]+>/g, "").trim().length < 200 &&
      /captcha|enable javascript|access denied|cloudflare/i.test(result.text))
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a public http(s) URL with SSRF protections; uses direct HTTP first and Firecrawl scrape fallback only for difficult pages.",
    parameters: Type.Object({ url: Type.String({ description: "URL to fetch" }) }),
    async execute(_toolCallId, params, signal) {
      let result: Awaited<ReturnType<typeof directFetch>>;
      let provider = "direct-http";
      let fallbackReason: string | undefined;
      try {
        result = await directFetch(params.url, signal);
      } catch (directError) {
        if (signal?.aborted) throw directError;
        try {
          fallbackReason = `direct HTTP failed: ${directError instanceof Error ? directError.message : String(directError)}`;
          result = await firecrawlScrape(params.url, signal);
          provider = "firecrawl-scrape";
        } catch (firecrawlError) {
          throw new Error(
            `Direct fetch failed (${directError instanceof Error ? directError.message : String(directError)}); Firecrawl fallback failed (${firecrawlError instanceof Error ? firecrawlError.message : String(firecrawlError)})`,
          );
        }
      }
      if (difficult(result)) {
        try {
          fallbackReason = `direct HTTP looked difficult (${result.status})`;
          result = await firecrawlScrape(params.url, signal);
          provider = "firecrawl-scrape";
        } catch (err) {
          fallbackReason = err instanceof Error ? err.message : String(err);
        }
      }
      return { content: [{ type: "text" as const, text: `Status: ${result.status} ${result.statusText}\nContent-Type: ${result.contentType}\nURL: ${result.url}\nProvider: ${provider}${fallbackReason ? `\nFallback: ${fallbackReason}` : ""}${result.truncated ? "\nTruncated: true" : ""}\n\n${result.text}` }], details: { status: result.status, url: result.url, contentType: result.contentType, provider, fallbackReason, truncated: result.truncated } };
    },
  });
}
