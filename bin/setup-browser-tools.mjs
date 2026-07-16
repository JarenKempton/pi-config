#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const apply = process.argv.includes("--apply");
const home = homedir();
const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = resolve(
  home,
  ".pi/agent/git/github.com/JarenKempton/agent-skills/skills/engineering/test-in-browser",
);
const runner = resolve(skillDir, "scripts/browser-cdp.mjs");
const mcpConfig = resolve(repoDir, "mcp.json");
const serverName = "authenticated-browser";
const mcpUrl = "http://localhost:8931/mcp";
const serviceLabel = "com.jaren.authenticated-browser";

const links = [
  [resolve(home, ".pi/agent/mcp.json"), mcpConfig],
  [resolve(home, ".codex/skills/test-in-browser"), skillDir],
  [resolve(home, ".claude/skills/test-in-browser"), skillDir],
];

function report(message) {
  process.stdout.write(`${message}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: options.quiet ? "pipe" : "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return result;
}

function hasCommand(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", stdio: "pipe" });
  return !result.error && result.status === 0;
}

function ensureNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`Node.js 22 or newer is required; found ${process.versions.node}.`);
  }
}

function ensureLink(linkPath, targetPath) {
  mkdirSync(dirname(linkPath), { recursive: true });
  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-symlink path: ${linkPath}`);
    }
    if (resolve(dirname(linkPath), readlinkSync(linkPath)) === targetPath) return;
    rmSync(linkPath, { force: true });
  }
  symlinkSync(targetPath, linkPath);
}

function updatePiSettings() {
  const path = resolve(home, ".pi/agent/settings.json");
  if (!existsSync(path)) throw new Error(`Pi settings not found: ${path}`);
  const settings = JSON.parse(readFileSync(path, "utf8"));
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  settings.packages = [...new Set([
    ...packages.filter((value) => value !== "npm:pi-agent-browser-native" && value !== "npm:pi-mcp-adapter"),
    "npm:pi-mcp-adapter",
  ])];
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

function configureCodex() {
  const existing = run("codex", ["mcp", "get", serverName, "--json"], { quiet: true, allowFailure: true });
  if (existing.status === 0) run("codex", ["mcp", "remove", serverName]);
  run("codex", ["mcp", "add", serverName, "--url", mcpUrl]);
}

function configureClaude() {
  const existing = run("claude", ["mcp", "get", serverName], { quiet: true, allowFailure: true });
  if (existing.status === 0) run("claude", ["mcp", "remove", "--scope", "user", serverName]);
  run("claude", ["mcp", "add", "--scope", "user", "--transport", "http", serverName, mcpUrl]);
}

function installMacService() {
  const agentsDir = resolve(home, "Library/LaunchAgents");
  const logsDir = resolve(home, ".pi/agent/logs");
  const plistPath = resolve(agentsDir, `${serviceLabel}.plist`);
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  const escapeXml = (value) => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${serviceLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(runner)}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escapeXml(resolve(logsDir, "authenticated-browser.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(resolve(logsDir, "authenticated-browser.error.log"))}</string>
</dict>
</plist>
`;
  writeFileSync(plistPath, plist, { mode: 0o600 });
  const domain = `gui/${process.getuid()}`;
  run("launchctl", ["bootout", domain, plistPath], { quiet: true, allowFailure: true });
  run("launchctl", ["bootstrap", domain, plistPath]);
}

function installLinuxService() {
  const serviceDir = resolve(home, ".config/systemd/user");
  const servicePath = resolve(serviceDir, "authenticated-browser.service");
  mkdirSync(serviceDir, { recursive: true });
  const quoteSystemd = (value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const service = `[Unit]
Description=Authenticated browser Playwright MCP broker

[Service]
ExecStart=${quoteSystemd(process.execPath)} ${quoteSystemd(runner)} serve
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
  writeFileSync(servicePath, service, { mode: 0o600 });
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", "authenticated-browser.service"]);
}

function installUserService() {
  if (process.platform === "darwin") installMacService();
  else if (process.platform === "linux") installLinuxService();
  else throw new Error("Automatic broker service installation currently supports macOS and Linux.");
}

function preview() {
  report("Browser tool bootstrap plan:");
  report(`- install/activate npm:pi-mcp-adapter and remove pi-agent-browser-native from ${resolve(home, ".pi/agent/settings.json")}`);
  for (const [linkPath, targetPath] of links) report(`- link ${linkPath} -> ${targetPath}`);
  report(`- install a per-user Playwright MCP broker using ${runner}`);
  report(`- register ${serverName} in Codex and Claude at ${mcpUrl}`);
  report("- leave browser profiles, cookies, tabs, and remote-debugging settings unchanged");
}

try {
  ensureNodeVersion();
  if (!existsSync(runner)) {
    throw new Error(
      "test-in-browser is not installed; run pi install git:git@github.com/JarenKempton/agent-skills",
    );
  }
  preview();
  if (!apply) {
    report("\nPreview only. Re-run with --apply to perform these changes.");
    process.exit(0);
  }

  if (hasCommand("pi")) {
    run("pi", ["install", "npm:pi-mcp-adapter"]);
    updatePiSettings();
  } else {
    report("Skipping Pi registration because the pi executable is not installed.");
  }
  for (const [linkPath, targetPath] of links) ensureLink(linkPath, targetPath);
  installUserService();
  if (hasCommand("codex")) configureCodex();
  else report("Skipping Codex registration because the codex executable is not installed.");
  if (hasCommand("claude")) configureClaude();
  else report("Skipping Claude registration because the claude executable is not installed.");
  report("\nBrowser tools configured. Restart Codex and Claude; run /reload or restart Pi.");
} catch (error) {
  process.stderr.write(`Browser tool bootstrap failed: ${error.message}\n`);
  process.exit(1);
}
