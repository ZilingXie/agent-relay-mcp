import { buildCreatePayloadV05 } from "./agentrelay-v05.mjs";

export const PROTOCOL_V06 = "agent-collab-v0.6";

export function buildCreatePayloadV06(args, idempotencyKey) {
  return {
    ...buildCreatePayloadV05(args, idempotencyKey),
    protocol_version: PROTOCOL_V06
  };
}
