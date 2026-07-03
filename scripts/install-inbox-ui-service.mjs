#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const nodePath = process.execPath;
const uiPath = resolve(projectRoot, "scripts/agentrelay-inbox-ui.mjs");
const label = "space.stellarix.agentrelay.inbox-ui";

export function buildInboxUiLaunchdPlist({
  label,
  nodePath,
  uiPath,
  projectRoot,
  stateRoot,
  envPath,
  processorMode,
  host,
  port,
  outLogPath,
  errLogPath
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(uiPath)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(projectRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(outLogPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(errLogPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTRELAY_STATE_DIR</key><string>${escapeXml(stateRoot)}</string>
    <key>AGENTRELAY_ENV_PATH</key><string>${escapeXml(envPath)}</string>
    <key>AGENTRELAY_PROCESSOR_MODE</key><string>${escapeXml(processorMode)}</string>
    <key>HOST</key><string>${escapeXml(host)}</string>
    <key>PORT</key><string>${escapeXml(port)}</string>
  </dict>
</dict>
</plist>
`;
}

async function installInboxUiService({
  plistDir = resolveHome("~/Library/LaunchAgents"),
  logDir = resolve(projectRoot, "state/logs"),
  stateRoot = process.env.AGENTRELAY_STATE_DIR || resolve(projectRoot, "state"),
  envPath = process.env.AGENTRELAY_ENV_PATH || resolve(projectRoot, ".env"),
  processorMode = process.env.AGENTRELAY_PROCESSOR_MODE || "codex",
  host = process.env.AGENTRELAY_INBOX_UI_HOST || "127.0.0.1",
  port = Number.parseInt(process.env.AGENTRELAY_INBOX_UI_PORT || "8787", 10)
} = {}) {
  if (!existsSync(uiPath)) fail(`Missing inbox UI at ${uiPath}`);
  if (platform() !== "darwin") {
    fail("Only launchd install is implemented for this local Mac. Run the UI manually with npm run inbox-ui.");
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`Invalid inbox UI port: ${port}`);

  const plistPath = resolve(plistDir, `${label}.plist`);
  await mkdir(plistDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const plist = buildInboxUiLaunchdPlist({
    label,
    nodePath,
    uiPath,
    projectRoot,
    stateRoot,
    envPath,
    processorMode,
    host,
    port,
    outLogPath: resolve(logDir, "inbox-ui.out.log"),
    errLogPath: resolve(logDir, "inbox-ui.err.log")
  });

  await writeFile(plistPath, plist, { mode: 0o644 });
  spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], { stdio: "ignore" });
  const boot = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath], { stdio: "inherit" });
  if (boot.status !== 0) fail("launchctl bootstrap failed");
  spawnSync("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${label}`], { stdio: "inherit" });

  console.log(`Installed launchd inbox UI: ${plistPath}`);
  console.log(`URL: http://${host}:${port}/`);
  console.log(`Logs: ${resolve(logDir, "inbox-ui.out.log")} and inbox-ui.err.log`);
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

function isMainModulePath(moduleUrl, argvPath = process.argv[1], cwd = process.cwd()) {
  if (!argvPath) return false;
  return resolve(cwd, argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModulePath(import.meta.url)) {
  installInboxUiService().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
