import * as z from "zod/v4";

import { agentToolDefinitions } from "./protocol-runtime.mjs";

export function compileAgentToolDefinitions(bundle) {
  return agentToolDefinitions(bundle).map((definition) => ({
    ...definition,
    paramsSchema: compileObjectShape(definition.input_schema)
  }));
}

function compileObjectShape(schema) {
  const required = new Set(schema.required || []);
  return Object.fromEntries(Object.entries(schema.properties || {}).map(([name, child]) => {
    const compiled = compileNode(child);
    return [name, required.has(name) ? compiled : compiled.optional()];
  }));
}

function compileNode(schema) {
  let value;
  if (schema.enum !== undefined) {
    const literals = schema.enum.map((item) => z.literal(item));
    value = literals.length === 1 ? literals[0] : z.union(literals);
  } else if (schema.type === "string") {
    value = z.string();
    if (schema.minLength !== undefined) value = value.min(schema.minLength);
    if (schema.maxLength !== undefined) value = value.max(schema.maxLength);
  } else if (schema.type === "integer") {
    value = z.number().int();
    if (schema.minimum !== undefined) value = value.min(schema.minimum);
    if (schema.maximum !== undefined) value = value.max(schema.maximum);
  } else if (schema.type === "number") {
    value = z.number();
    if (schema.minimum !== undefined) value = value.min(schema.minimum);
    if (schema.maximum !== undefined) value = value.max(schema.maximum);
  } else if (schema.type === "boolean") {
    value = z.boolean();
  } else if (schema.type === "null") {
    value = z.null();
  } else if (schema.type === "array") {
    value = z.array(compileNode(schema.items));
    if (schema.minItems !== undefined) value = value.min(schema.minItems);
    if (schema.maxItems !== undefined) value = value.max(schema.maxItems);
  } else if (schema.type === "object" && schema.minProperties !== undefined) {
    value = z.record(z.string(), z.unknown()).refine(
      (item) => Object.keys(item).length >= schema.minProperties,
      `Object must contain at least ${schema.minProperties} properties`
    );
  } else if (schema.type === "object") {
    value = z.object(compileObjectShape(schema)).strict();
  } else {
    throw new Error(`Unsupported dynamic Agent tool schema type: ${schema.type}`);
  }
  return schema.description ? value.describe(schema.description) : value;
}
