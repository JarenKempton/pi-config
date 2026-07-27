#!/usr/bin/env node

import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, relative } from "node:path";
import net from "node:net";

const ACTIVE_PORT_FILE = "DevToolsActivePort";
const SAFE_WEBSOCKET_PATH = /^\/devtools\/browser\/[A-Za-z0-9._-]+$/;
const MCP_PORT = Number(process.env.BROWSER_MCP_PORT ?? "8931");
const PROBE_TIMEOUT_MS = 1_500;

function defaultUserDataDirs() {
  const appSupport = join(homedir(), "Library", "Application Support");
  return [
    join(appSupport, "net.imput.helium"),
    join(appSupport, "Google", "Chrome"),
    join(appSupport, "Chromium"),
    join(appSupport, "BraveSoftware", "Brave-Browser"),
    join(appSupport, "Microsoft Edge"),
  ];
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function tcpAlive(port, timeoutMs = 750) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function activePortFiles() {
  if (process.env.BROWSER_CDP_ACTIVE_PORT_FILE) {
    return [process.env.BROWSER_CDP_ACTIVE_PORT_FILE];
  }
  const configured = (
    process.env.BROWSER_USER_DATA_DIRS ??
    process.env.BROWSER_USER_DATA_DIR ??
    ""
  )
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  const files = [];
  for (const root of [...new Set([...configured, ...defaultUserDataDirs()])]) {
    if (!(await exists(root))) continue;
    const rootFile = join(root, ACTIVE_PORT_FILE);
    if (await exists(rootFile)) files.push(rootFile);
    let entries = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nested = join(root, entry.name, ACTIVE_PORT_FILE);
      if (await exists(nested)) files.push(nested);
    }
  }
  return [...new Set(files)];
}

async function liveCandidates() {
  const candidates = [];
  for (const path of await activePortFiles()) {
    try {
      const [portText, websocketPath] = (await readFile(path, "utf8"))
        .trim()
        .split(/\r?\n/);
      const port = Number(portText);
      if (
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65_535 ||
        !SAFE_WEBSOCKET_PATH.test(websocketPath ?? "") ||
        !(await tcpAlive(port))
      ) {
        continue;
      }
      candidates.push({
        path,
        websocketUrl: `ws://127.0.0.1:${port}${websocketPath}`,
        modifiedMs: (await stat(path)).mtimeMs,
      });
    } catch {}
  }
  return candidates.sort((left, right) => right.modifiedMs - left.modifiedMs);
}

function safeSource(path) {
  const value = relative(homedir(), path);
  return value.startsWith("..") ? path : `~/${value}`;
}

async function probePages(websocketUrl) {
  const socket = new WebSocket(websocketUrl);
  let nextId = 0;
  const pending = new Map();
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, PROBE_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      socket.send(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      );
    });

  await opened;
  try {
    const { targetInfos = [] } = await send("Target.getTargets");
    const pages = targetInfos.filter((target) => target.type === "page");
    let unresponsive = 0;
    for (const target of pages) {
      let sessionId;
      try {
        ({ sessionId } = await send("Target.attachToTarget", {
          targetId: target.targetId,
          flatten: true,
        }));
        await send("Page.getFrameTree", {}, sessionId);
      } catch {
        unresponsive++;
      } finally {
        if (sessionId) {
          await send("Target.detachFromTarget", { sessionId }).catch(() => {});
        }
      }
    }
    return { pageCount: pages.length, unresponsivePageCount: unresponsive };
  } finally {
    socket.close();
  }
}

async function status() {
  const brokerAvailable = await tcpAlive(MCP_PORT);
  const candidate = (await liveCandidates())[0];
  if (!candidate) {
    return {
      available: false,
      brokerAvailable,
      playwrightReady: false,
      preferredMode: "browser_qa",
      error: "No live debug-enabled Chromium endpoint was found.",
    };
  }
  try {
    const probe = await probePages(candidate.websocketUrl);
    return {
      available: true,
      brokerAvailable,
      endpointDetected: true,
      source: safeSource(candidate.path),
      ...probe,
      playwrightReady: brokerAvailable && probe.unresponsivePageCount === 0,
      preferredMode:
        brokerAvailable && probe.unresponsivePageCount === 0
          ? "authenticated-browser"
          : "browser_qa",
      ...(probe.unresponsivePageCount > 0
        ? {
            error:
              "At least one open tab is CDP-unresponsive; Playwright attaches every tab and may hang. Use browser_qa instead of retrying.",
          }
        : {}),
    };
  } catch (error) {
    return {
      available: true,
      brokerAvailable,
      endpointDetected: true,
      source: safeSource(candidate.path),
      playwrightReady: false,
      preferredMode: "browser_qa",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

if (process.argv[2] && process.argv[2] !== "status") {
  process.stderr.write("Usage: browser-cdp.mjs status\n");
  process.exit(2);
}
process.stdout.write(`${JSON.stringify(await status(), null, 2)}\n`);
