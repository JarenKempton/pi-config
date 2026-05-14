import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a URL and return its text content.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
    }),
    async execute(_toolCallId, params, signal) {
      const res = await fetch(params.url, {
        signal,
        headers: {
          "User-Agent": "pi-web-fetch/1.0",
          Accept: "text/html,text/plain,application/json,*/*",
        },
      });

      const contentType = res.headers.get("content-type") ?? "";
      const text = await res.text();

      return {
        content: [
          {
            type: "text",
            text:
              `Status: ${res.status} ${res.statusText}\n` +
              `Content-Type: ${contentType}\n` +
              `URL: ${res.url}\n\n` +
              text.slice(0, 100_000),
          },
        ],
        details: {
          status: res.status,
          url: res.url,
          contentType,
        },
      };
    },
  });
}
