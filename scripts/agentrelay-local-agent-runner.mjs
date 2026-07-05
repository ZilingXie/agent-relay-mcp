import { existsSync } from "node:fs";

const VALID_RUNNERS = new Set(["codex", "responses", "auto"]);

export function normalizeLocalAgentRunner(value, fallback = "codex") {
  const normalized = String(value || fallback || "codex").trim().toLowerCase();
  if (!VALID_RUNNERS.has(normalized)) {
    throw new Error(`Unsupported AgentRelay local agent runner: ${value}`);
  }
  return normalized;
}

export function resolveLocalAgentRunner({
  componentRunner,
  localAgentRunner = process.env.AGENTRELAY_LOCAL_AGENT_RUNNER,
  defaultRunner = "codex",
  codexCli,
  codexCliExists = existsSync,
  responsesApiAvailable = Boolean(process.env.OPENAI_API_KEY)
} = {}) {
  const requested = normalizeLocalAgentRunner(componentRunner || localAgentRunner || defaultRunner, defaultRunner);
  if (requested === "codex" || requested === "responses") return requested;
  if (responsesApiAvailable) return "responses";
  if (codexCli && codexCliExists(codexCli)) return "codex";
  throw new Error("No AgentRelay local agent runner is available. Set AGENTRELAY_LOCAL_AGENT_RUNNER=codex or configure Responses API credentials.");
}
