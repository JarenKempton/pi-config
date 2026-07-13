#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import net from "node:net";

const PLAYWRIGHT_MCP_VERSION = "0.0.78";
const ACTIVE_PORT_FILE = "DevToolsActivePort";
const SAFE_WEBSOCKET_PATH = /^\/devtools\/browser\/[A-Za-z0-9._-]+$/;
const MCP_HOST = "127.0.0.1";
const MCP_PORT = Number(process.env.BROWSER_MCP_PORT ?? "8931");
const NPX_PATH = process.env.BROWSER_NPX_PATH ?? join(dirname(process.execPath), process.platform === "win32" ? "npx.cmd" : "npx");
const command = process.argv[2] ?? "status";

function defaultUserDataDirs() {
  const home = homedir();
  if (process.platform === "darwin") {
    const appSupport = join(home, "Library", "Application Support");
    return [
      join(appSupport, "net.imput.helium"),
      join(appSupport, "Google", "Chrome"),
      join(appSupport, "Chromium"),
      join(appSupport, "BraveSoftware", "Brave-Browser"),
      join(appSupport, "Microsoft Edge"),
    ];
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (!local) return [];
    return [
      join(local, "imput", "Helium", "User Data"),
      join(local, "Google", "Chrome", "User Data"),
      join(local, "Chromium", "User Data"),
      join(local, "BraveSoftware", "Brave-Browser", "User Data"),
      join(local, "Microsoft", "Edge", "User Data"),
    ];
  }
  const config = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return [
    join(config, "net.imput.helium"),
    join(config, "helium"),
    join(config, "google-chrome"),
    join(config, "chromium"),
    join(config, "BraveSoftware", "Brave-Browser"),
    join(config, "microsoft-edge"),
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

async function activePortFiles() {
  if (process.env.BROWSER_CDP_ACTIVE_PORT_FILE) {
    return [process.env.BROWSER_CDP_ACTIVE_PORT_FILE];
  }

  const configured = (process.env.BROWSER_USER_DATA_DIRS ?? process.env.BROWSER_USER_DATA_DIR ?? "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  const roots = [...new Set([...configured, ...defaultUserDataDirs()])];
  const files = [];

  for (const root of roots) {
    if (!(await exists(root))) continue;
    const rootFile = join(root, ACTIVE_PORT_FILE);
    if (await exists(rootFile)) files.push(rootFile);

    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nested = join(root, entry.name, ACTIVE_PORT_FILE);
      if (await exists(nested)) files.push(nested);
    }
  }
  return [...new Set(files)];
}

async function candidateFromFile(path) {
  const lines = (await readFile(path, "utf8")).trim().split(/\r?\n/);
  const port = Number(lines[0]);
  const websocketPath = lines[1];
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !SAFE_WEBSOCKET_PATH.test(websocketPath ?? "")) {
    throw new Error(`Invalid ${ACTIVE_PORT_FILE}: ${path}`);
  }
  const fileStat = await stat(path);
  return {
    path,
    port,
    websocketUrl: `ws://127.0.0.1:${port}${websocketPath}`,
    modifiedMs: fileStat.mtimeMs,
  };
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

async function liveCandidates() {
  const candidates = [];
  for (const path of await activePortFiles()) {
    try {
      const candidate = await candidateFromFile(path);
      if (await tcpAlive(candidate.port)) candidates.push(candidate);
    } catch {}
  }
  return candidates.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

async function resolveBrowser() {
  if (process.env.BROWSER_CDP_ENDPOINT) {
    return {
      candidate: {
        path: "BROWSER_CDP_ENDPOINT",
        websocketUrl: process.env.BROWSER_CDP_ENDPOINT,
        modifiedMs: Date.now(),
      },
      profileMatched: false,
    };
  }

  const profileHint = process.env.BROWSER_PROFILE_HINT?.toLowerCase();
  const candidates = await liveCandidates();

  if (candidates.length === 0) {
    throw new Error("No live debug-enabled Chromium browser was found. Open the intended browser profile and enable chrome://inspect/#remote-debugging.");
  }

  const candidate = candidates.find((item) => profileHint && item.path.toLowerCase().includes(profileHint))
    ?? candidates[0];
  return {
    candidate,
    profileMatched: Boolean(profileHint && candidate.path.toLowerCase().includes(profileHint)),
  };
}

function safeSource(path) {
  if (path === "BROWSER_CDP_ENDPOINT") return path;
  const value = relative(homedir(), path);
  return value.startsWith("..") ? path : `~/${value}`;
}

async function status() {
  if (await tcpAlive(MCP_PORT)) {
    process.stdout.write(`${JSON.stringify({
      available: true,
      brokerAvailable: true,
      mcpUrl: `http://localhost:${MCP_PORT}/mcp`,
      authorizationState: "verified-by-first-tool-call",
    }, null, 2)}\n`);
    return;
  }

  const result = await resolveBrowser();
  const output = {
    available: true,
    brokerAvailable: false,
    endpointDetected: true,
    source: safeSource(result.candidate.path),
    profileHintMatched: Boolean(result.profileMatched),
    authorizationRequired: true,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

async function startMcp({ http = false } = {}) {
  const result = await resolveBrowser();
  const args = [
    "-y",
    `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`,
    "--cdp-endpoint",
    result.candidate.websocketUrl,
    "--caps",
    "vision,devtools",
  ];
  if (http) {
    args.push(
      "--host",
      MCP_HOST,
      "--port",
      String(MCP_PORT),
      "--shared-browser-context",
    );
  }
  const childPath = [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter);
  const child = spawn(NPX_PATH, args, {
    stdio: "inherit",
    env: { ...process.env, PATH: childPath },
  });
  let endpointWatcher;
  if (http && result.candidate.path !== "BROWSER_CDP_ENDPOINT") {
    endpointWatcher = setInterval(async () => {
      try {
        const current = await resolveBrowser();
        if (current.candidate.websocketUrl !== result.candidate.websocketUrl) child.kill("SIGTERM");
      } catch {
        // Keep serving while the browser is briefly closed; restart when a new endpoint appears.
      }
    }, 5000);
  }
  child.once("error", (error) => {
    if (endpointWatcher) clearInterval(endpointWatcher);
    process.stderr.write(`Unable to start Playwright MCP: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (endpointWatcher) clearInterval(endpointWatcher);
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

try {
  if (command === "status") await status();
  else if (command === "mcp") await startMcp();
  else if (command === "serve") await startMcp({ http: true });
  else {
    process.stderr.write("Usage: browser-cdp.mjs <status|mcp|serve>\n");
    process.exitCode = 2;
  }
} catch (error) {
  if (command === "status") {
    process.stdout.write(`${JSON.stringify({ available: false, error: error.message }, null, 2)}\n`);
  } else {
    process.stderr.write(`${error.message}\n`);
  }
  process.exitCode = 1;
}
