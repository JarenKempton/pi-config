import assert from "node:assert/strict";
import test from "node:test";
import { validatePublicHttpUrl } from "../extensions/web-fetch.ts";
import { hybridSearch } from "../extensions/web-search/index.ts";

test("web_fetch rejects loopback/private SSRF targets", async () => {
  await assert.rejects(() => validatePublicHttpUrl("http://127.0.0.1:8080/"), /Loopback|private|blocked/i);
  await assert.rejects(() => validatePublicHttpUrl("http://[::1]/"), /Loopback|private|blocked/i);
  await assert.rejects(() => validatePublicHttpUrl("http://[::ffff:127.0.0.1]/"), /Loopback|private|blocked/i);
  await assert.rejects(() => validatePublicHttpUrl("file:///etc/passwd"), /http and https/);
});

test("web_search falls back from Firecrawl quota/rate failure to DuckDuckGo", async () => {
  const oldKey = process.env.FIRECRAWL_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.FIRECRAWL_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = (async (url: any) => {
    calls++;
    if (String(url).includes("firecrawl")) return new Response("quota", { status: 429 });
    return new Response('<div class="result results_links"><a class="result__a" href="https://example.com">Example</a><div class="result__snippet">Snippet</div></div>', { status: 200, headers: { "content-type": "text/html" } });
  }) as any;
  try {
    const result = await hybridSearch("example", 1);
    assert.equal(result.provider, "duckduckgo-html");
    assert.equal(result.results[0].title, "Example");
    assert.equal(calls, 2);
    assert.match(result.fallbackReason ?? "", /429/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = oldKey;
  }
});
