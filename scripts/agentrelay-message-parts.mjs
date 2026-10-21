// Message-part contract for reply text parts (agent-collab v0.5/v0.6).
//
// Incident 14158 (2026-10-21): an executor sent a reply text part as
// {"type":"text","text":...}; the SupportPortal result parser only accepts
// kind:"text", so the relay delivered the message but the business consumer
// rejected it as noise and closed the task. These validators reject that
// shape at the send/prepare boundary so the mistake can never reach Relay.
//
// Errors are structural only: they never embed message text, tokens,
// addresses or App IDs from the payload.

export const ENABLEMENT_RESULT_SCHEMA = "enablement-relay-result-v1";

export const PART_ERRORS = {
  parts_invalid: "parts must be a non-empty array of non-empty objects",
  type_key_rejected: 'message parts use "kind", not "type"; a part carried a "type" field',
  text_without_kind: 'a part carrying "text" must set kind:"text"',
  text_part_invalid: 'a kind:"text" part must carry a non-empty string "text"',
  enablement_result_invalid: `a ${ENABLEMENT_RESULT_SCHEMA} JSON payload must be an object with a non-empty string request_id`,
  enablement_outcome_invalid: `a ${ENABLEMENT_RESULT_SCHEMA} JSON payload must carry a non-empty string outcome`,
  enablement_write_attempted_invalid: `a ${ENABLEMENT_RESULT_SCHEMA} JSON payload must carry a boolean write_attempted`
};

function structuralError(code) {
  const error = new Error(PART_ERRORS[code]);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the reply message-part contract. Throws a structural Error
 * (message never contains payload content) on violation; returns the parts
 * array unchanged on success.
 *
 * Rules (C1):
 *  - parts is a non-empty array of non-empty objects;
 *  - a "type" field on any part is rejected (the protocol key is "kind");
 *  - a part carrying "text" must set kind:"text";
 *  - kind:"text" requires a non-empty string "text";
 *  - file parts and other explicitly-kinded parts pass through unchanged.
 */
export function validateReplyParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) throw structuralError("parts_invalid");
  for (const part of parts) {
    if (!isPlainObject(part) || Object.keys(part).length === 0) throw structuralError("parts_invalid");
    if ("type" in part) throw structuralError("type_key_rejected");
    if ("text" in part && part.kind !== "text") throw structuralError("text_without_kind");
    if (part.kind === "text") {
      if (typeof part.text !== "string" || part.text.trim() === "") {
        throw structuralError("text_part_invalid");
      }
      validateEnablementResultText(part.text);
    }
  }
  return parts;
}

/**
 * When a text part parses as an enablement-relay-result-v1 JSON object,
 * enforce the result binding before it can be sent (C2): object shape,
 * non-empty string request_id/outcome, boolean write_attempted. Any other
 * text (plain prose or an unrelated JSON schema) passes through untouched.
 */
export function validateEnablementResultText(text) {
  const trimmed = String(text).trim();
  if (!trimmed.startsWith("{")) return;
  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return; // ordinary text that merely starts with "{" is not our contract
  }
  if (!isPlainObject(payload)) return;
  if (String(payload.schema_version) !== ENABLEMENT_RESULT_SCHEMA) return;
  if (typeof payload.request_id !== "string" || payload.request_id.trim() === "") {
    throw structuralError("enablement_result_invalid");
  }
  if (typeof payload.outcome !== "string" || payload.outcome.trim() === "") {
    throw structuralError("enablement_outcome_invalid");
  }
  if (typeof payload.write_attempted !== "boolean") {
    throw structuralError("enablement_write_attempted_invalid");
  }
  return payload;
}

/**
 * Canonical builder for the enablement-relay-result-v1 reply (C1/C2).
 * Executors must not hand-assemble the wire parts: pass the already-approved
 * result JSON object (loaded from a file) and get the exact parts payload
 * for the reply tool back. Throws the same structural errors on violation.
 */
export function buildEnablementResultParts(resultObject) {
  if (!isPlainObject(resultObject)) throw structuralError("enablement_result_invalid");
  const text = JSON.stringify(resultObject);
  validateEnablementResultText(text);
  return { parts: [{ kind: "text", text }] };
}
