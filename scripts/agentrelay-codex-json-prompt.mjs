import { readFile } from "node:fs/promises";

export async function buildCodexCliJsonPrompt({ prompt, schemaPath, schemaName }) {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  return [
    prompt,
    "",
    "Codex CLI JSON output instructions:",
    "- Return exactly one JSON object and nothing else.",
    "- Do not wrap the JSON in Markdown fences.",
    "- The JSON object must validate against this JSON Schema.",
    "- Use only enum values shown in the schema.",
    "- Include optional string fields with an empty string when they are not used.",
    `Schema name: ${schemaName || "agentrelay_output"}`,
    "```json",
    JSON.stringify(schema, null, 2),
    "```"
  ].join("\n");
}
