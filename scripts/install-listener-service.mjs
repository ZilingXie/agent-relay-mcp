#!/usr/bin/env node

import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const envPath = resolveHome(getArg("--env") || process.env.AGENTRELAY_ENV_PATH || resolve(repoRoot, ".env"));
const nodePath = process.execPath;
const listenerPath = resolve(repoRoot, "scripts/listener.mjs");

if (!existsSync(envPath)) fail(`Missing .env at ${envPath}. Run install-codex-mcp first and fill credentials.`);
if (!existsSync(listenerPath)) fail(`Missing listener at ${listenerPath}`);

if (platform() === "darwin") {
  await installLaunchAgent();
} else if (platform() === "linux") {
  await installSystemdUser();
} else {
  fail(`Unsupported platform ${platform()}. Run manually with: npm run listener`);
}

async function installLaunchAgent() {
  const plistDir = resolveHome("~/Library/LaunchAgents");
  const plistPath = resolve(plistDir, "space.stellarix.agentrelay.listener.plist");
  await mkdir(plistDir, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>space.stellarix.agentrelay.listener</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(listenerPath)}</string>
    <string>--env</string>
    <string>${escapeXml(envPath)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(repoRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(resolve(repoRoot, ".agentrelay/listener.out.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(resolve(repoRoot, ".agentrelay/listener.err.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTRELAY_ENV_PATH</key><string>${escapeXml(envPath)}</string>
  </dict>
</dict>
</plist>
`;
  await mkdir(resolve(repoRoot, ".agentrelay"), { recursive: true });
  await writeFile(plistPath, plist, { mode: 0o644 });
  spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], { stdio: "ignore" });
  const boot = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath], { stdio: "inherit" });
  if (boot.status !== 0) fail("launchctl bootstrap failed");
  spawnSync("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/space.stellarix.agentrelay.listener`], { stdio: "inherit" });
  console.log(`Installed launchd listener: ${plistPath}`);
  console.log(`Logs: ${resolve(repoRoot, ".agentrelay/listener.out.log")} and listener.err.log`);
}

async function installSystemdUser() {
  const unitDir = resolveHome("~/.config/systemd/user");
  const unitPath = resolve(unitDir, "agentrelay-listener.service");
  await mkdir(unitDir, { recursive: true });
  await mkdir(resolve(repoRoot, ".agentrelay"), { recursive: true });
  const unit = `[Unit]
Description=AgentRelay local WebSocket listener
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${repoRoot}
Environment=AGENTRELAY_ENV_PATH=${envPath}
ExecStart=${nodePath} ${listenerPath} --env ${envPath}
Restart=always
RestartSec=5
StandardOutput=append:${resolve(repoRoot, ".agentrelay/listener.out.log")}
StandardError=append:${resolve(repoRoot, ".agentrelay/listener.err.log")}

[Install]
WantedBy=default.target
`;
  await writeFile(unitPath, unit, { mode: 0o644 });
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  const enable = spawnSync("systemctl", ["--user", "enable", "--now", "agentrelay-listener.service"], { stdio: "inherit" });
  if (enable.status !== 0) fail("systemctl --user enable --now failed");
  console.log(`Installed systemd user listener: ${unitPath}`);
  console.log("Status: systemctl --user status agentrelay-listener.service");
}

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
