import assert from "node:assert/strict";
import test from "node:test";

import { compileAgentToolDefinitions } from "../scripts/agentrelay-agent-tools.mjs";
import { protocolV2Bundle, resignProtocolV2Bundle } from "./protocol-v2-fixture.mjs";

test("dynamic Agent tool compiler enforces the signed subject and parts schema", () => {
  const tools = compileAgentToolDefinitions(protocolV2Bundle());
  const create = tools.find((item) => item.name === "agentrelay_create_task");
  const createSchema = create.paramsSchema;

  assert.equal(createSchema.message.safeParse({ subject: "Task title", parts: [{ kind: "text", text: "Do it" }] }).success, true);
  assert.equal(createSchema.message.safeParse({ parts: [{ kind: "text", text: "Do it" }] }).success, false);
  assert.equal(createSchema.message.safeParse({ subject: "x".repeat(121), parts: [{ kind: "text", text: "Do it" }] }).success, false);

  const reply = tools.find((item) => item.name === "agentrelay_reply");
  assert.equal(reply.paramsSchema.parts.safeParse([{ kind: "text", text: "Done" }]).success, true);
  assert.equal(Object.hasOwn(reply.paramsSchema, "subject"), false);
});

test("dynamic Agent tool compiler applies a signed optional metadata extension", () => {
  const bundle = protocolV2Bundle();
  bundle.agent_tools.tools.agentrelay_create_task.input_schema.properties.message.properties.metadata = {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      category: { type: "string", enum: ["test-b", "followup"] },
      requiresReview: { type: "boolean" }
    }
  };
  resignProtocolV2Bundle(bundle);
  const create = compileAgentToolDefinitions(bundle)
    .find((item) => item.name === "agentrelay_create_task");

  assert.equal(create.paramsSchema.message.safeParse({
    subject: "Task title",
    parts: [{ kind: "text", text: "Do it" }],
    metadata: { category: "test-b", requiresReview: false }
  }).success, true);
  assert.equal(create.paramsSchema.message.safeParse({
    subject: "Task title",
    parts: [{ kind: "text", text: "Do it" }],
    metadata: { category: "unknown", requiresReview: false }
  }).success, false);
});
