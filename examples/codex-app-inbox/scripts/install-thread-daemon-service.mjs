#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const envPath = resolveHome(getArg("--env") || process.env.AGENTRELAY_ENV_PATH || resolve(projectRoot, ".env"));
const nodePath = process.execPath;
const daemonPath = resolve(projectRoot, "scripts/agentrelay-thread-daemon.mjs");

if (!existsSync(envPath)) fail(`Missing .env at ${envPath}`);
if (!existsSync(daemonPath)) fail(`Missing daemon at ${daemonPath}`);

if (platform() !== "darwin") {
  fail("Only launchd install is implemented for this local Mac. Run the daemon manually with npm run daemon.");
}

const plistDir = resolveHome("~/Library/LaunchAgents");
const logDir = resolve(projectRoot, "state/logs");
const plistPath = resolve(plistDir, "space.stellarix.agentrelay.thread-daemon.plist");

await mkdir(plistDir, { recursive: true });
await mkdir(logDir, { recursive: true });

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>space.stellarix.agentrelay.thread-daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(daemonPath)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(projectRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(resolve(logDir, "thread-daemon.out.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(resolve(logDir, "thread-daemon.err.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTRELAY_ENV_PATH</key><string>${escapeXml(envPath)}</string>
  </dict>
</dict>
</plist>
`;

await writeFile(plistPath, plist, { mode: 0o644 });
spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], { stdio: "ignore" });
const boot = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath], { stdio: "inherit" });
if (boot.status !== 0) fail("launchctl bootstrap failed");
spawnSync("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/space.stellarix.agentrelay.thread-daemon`], { stdio: "inherit" });

console.log(`Installed launchd thread daemon: ${plistPath}`);
console.log(`Logs: ${resolve(logDir, "thread-daemon.out.log")} and thread-daemon.err.log`);

function getArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function resolveHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
