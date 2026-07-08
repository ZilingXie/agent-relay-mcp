#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export const DEFAULT_REPO_URL = "https://github.com/ZilingXie/agent-relay-mcp.git";
export const DEFAULT_INSTALL_DIR = "~/agentRelay";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");

export function parseInstallArgs(argv) {
  const options = {
    installDir: process.env.AGENTRELAY_INSTALL_DIR || DEFAULT_INSTALL_DIR,
    repoUrl: process.env.AGENTRELAY_REPO_URL || DEFAULT_REPO_URL,
    update: true,
    npmInstall: true,
    forwardedArgs: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (entry === "--") continue;
    if (!entry.startsWith("--")) {
      throw new Error(`Unexpected positional argument for install: ${entry}`);
    }

    const [rawKey, inlineValue] = entry.slice(2).split("=", 2);
    if (rawKey === "install-dir") {
      const value = inlineValue ?? argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("Missing value for --install-dir");
      options.installDir = value;
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (rawKey === "repo-url") {
      const value = inlineValue ?? argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("Missing value for --repo-url");
      options.repoUrl = value;
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (rawKey === "no-update") {
      options.update = false;
      continue;
    }
    if (rawKey === "skip-npm-install") {
      options.npmInstall = false;
      continue;
    }

    options.forwardedArgs.push(entry);
    if (inlineValue === undefined && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      options.forwardedArgs.push(argv[index + 1]);
      index += 1;
    }
  }

  return {
    ...options,
    installDir: resolveHome(options.installDir)
  };
}

export function buildLocalInstallArgs(forwardedArgs) {
  const args = ["scripts/install-local-inbox.mjs"];
  if (!forwardedArgs.includes("--write")) args.push("--write");
  args.push(...forwardedArgs);
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "serve";
  const rest = command === "serve" ? argv : argv.slice(1);

  if (["help", "--help", "-h"].includes(command)) {
    printHelp();
    return;
  }
  if (command === "install") {
    await install(rest);
    return;
  }
  if (["serve", "server", "mcp"].includes(command)) {
    runOrExit(process.execPath, [resolve(packageRoot, "mcp/server.mjs"), ...rest], { cwd: packageRoot });
    return;
  }

  throw new Error(`Unknown command: ${command}. Run: agent-relay-mcp help`);
}

async function install(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printInstallHelp();
    return;
  }

  const options = parseInstallArgs(argv);
  const targetRoot = options.installDir;

  if (samePath(targetRoot, packageRoot)) {
    console.log(`Using current AgentRelay MCP checkout: ${targetRoot}`);
  } else {
    await ensureInstallDir(targetRoot, options);
  }

  if (options.npmInstall) {
    console.log(`Installing npm dependencies in ${targetRoot}`);
    runOrExit("npm", ["install"], { cwd: targetRoot });
  }

  const localInstallArgs = buildLocalInstallArgs(options.forwardedArgs);
  console.log(`Installing AgentRelay MCP and Local Inbox from ${targetRoot}`);
  runOrExit(process.execPath, localInstallArgs, { cwd: targetRoot });
}

async function ensureInstallDir(targetRoot, options) {
  if (!existsSync(targetRoot)) {
    await mkdir(dirname(targetRoot), { recursive: true });
    console.log(`Cloning AgentRelay MCP into ${targetRoot}`);
    runOrExit("git", ["clone", "--depth", "1", options.repoUrl, targetRoot], { cwd: dirname(targetRoot) });
    return;
  }

  const packagePath = resolve(targetRoot, "package.json");
  if (!existsSync(packagePath)) {
    throw new Error(`Install directory exists but is not an AgentRelay MCP checkout: ${targetRoot}`);
  }

  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  if (packageJson.name !== "agent-relay-mcp") {
    throw new Error(`Install directory package is '${packageJson.name}', expected 'agent-relay-mcp': ${targetRoot}`);
  }

  if (options.update && existsSync(resolve(targetRoot, ".git"))) {
    console.log(`Updating existing AgentRelay MCP checkout in ${targetRoot}`);
    runOrExit("git", ["pull", "--ff-only"], { cwd: targetRoot });
  } else {
    console.log(`Using existing AgentRelay MCP install directory: ${targetRoot}`);
  }
}

function runOrExit(command, args, options) {
  const child = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: "inherit",
    env: process.env
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    process.exit(child.status ?? 1);
  }
}

function printHelp() {
  console.log(`Usage:
  agent-relay-mcp install [options] [installer options]
  agent-relay-mcp serve

Commands:
  install   Clone/update a stable local checkout, then install AgentRelay MCP and Local Inbox.
  serve     Start the MCP stdio server. This is also the default for compatibility.

Examples:
  npx github:ZilingXie/agent-relay-mcp install
  npx github:ZilingXie/agent-relay-mcp install -- --agent-id zac-agent --username zac
  npx github:ZilingXie/agent-relay-mcp install -- --install-dir ~/agentRelay

Run 'agent-relay-mcp install --help' for install options.`);
}

function printInstallHelp() {
  console.log(`Usage:
  agent-relay-mcp install [agent-relay-mcp install options] [local installer options]

AgentRelay MCP install options:
  --install-dir PATH      Stable local checkout path. Default: ${DEFAULT_INSTALL_DIR}
  --repo-url URL          Git repo to clone/update. Default: ${DEFAULT_REPO_URL}
  --no-update             Do not git pull an existing checkout.
  --skip-npm-install      Do not run npm install before local install.

Common local installer options forwarded to scripts/install-local-inbox.mjs:
  --base-url URL
  --ws-url URL
  --agent-id ID
  --username NAME
  --token TOKEN
  --env PATH
  --config PATH
  --skip-ui-service
  --skip-listener-service

The local installer preserves an existing .env and does not print tokens.`);
}

function resolveHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function samePath(left, right) {
  return resolve(left) === resolve(right);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}
