import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";

export const FILE_ID_PATTERN = /^file_[a-f0-9]{32}$/;
export const FILE_SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const FILE_NAME_MAX_LENGTH = 255;
export const FILE_MIME_MAX_LENGTH = 255;
const SAFE_FILE_NAME_MAX_LENGTH = 80;

const fileError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

export function isLocalFilePart(part) {
  return Boolean(
    part
    && typeof part === "object"
    && part.kind === "file"
    && typeof part.localPath === "string"
    && part.localPath.trim() !== ""
  );
}

export function isWireFilePart(part) {
  return Boolean(
    part
    && typeof part === "object"
    && part.kind === "file"
    && typeof part.file_id === "string"
    && FILE_ID_PATTERN.test(part.file_id)
  );
}

export function hasAnyFilePart(parts) {
  return Array.isArray(parts)
    && parts.some((part) => part && typeof part === "object" && part.kind === "file");
}

export async function hashLocalFile(localPath) {
  const absolutePath = resolve(localPath);
  const info = await stat(absolutePath).catch((error) => {
    throw fileError("FILE_UNREADABLE", `Cannot read local file ${absolutePath}: ${error.message}`);
  });
  if (!info.isFile()) {
    throw fileError("FILE_UNREADABLE", `Local path is not a file: ${absolutePath}`);
  }
  if (info.size < 1) {
    throw fileError("FILE_EMPTY", `Local file is empty and cannot be attached: ${absolutePath}`);
  }
  const bytes = await readFile(absolutePath).catch((error) => {
    throw fileError("FILE_UNREADABLE", `Cannot read local file ${absolutePath}: ${error.message}`);
  });
  return {
    localPath: absolutePath,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function partMimeTypeInput(part) {
  // Tool input arrives camelCase (mimeType); normalized payloads are snake_case.
  return part.mime_type !== undefined ? part.mime_type : part.mimeType;
}

function validateFilePartDisplayFields(part) {
  const name = typeof part.name === "string" ? part.name.trim() : "";
  if (part.name !== undefined && !name) {
    throw fileError("FILE_PART_INVALID", "file part name must be a non-empty string when provided");
  }
  if (name.length > FILE_NAME_MAX_LENGTH) {
    throw fileError("FILE_PART_INVALID", `file part name must be at most ${FILE_NAME_MAX_LENGTH} characters`);
  }
  const mimeType = typeof partMimeTypeInput(part) === "string" ? partMimeTypeInput(part).trim() : "";
  if (partMimeTypeInput(part) !== undefined && !mimeType) {
    throw fileError("FILE_PART_INVALID", "file part mime_type must be a non-empty string when provided");
  }
  if (mimeType.length > FILE_MIME_MAX_LENGTH) {
    throw fileError("FILE_PART_INVALID", `file part mime_type must be at most ${FILE_MIME_MAX_LENGTH} characters`);
  }
}

/**
 * Normalize the prepared-action payload for a reply: every file part that
 * references a local file is enriched with size and sha256 so the human
 * approval and the payload hash bind the exact file content. The same
 * normalization runs at prepare time and before execution, so a changed file
 * fails the existing ACTION_PAYLOAD_CHANGED guard instead of being uploaded.
 */
export async function normalizeReplyFileParts(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.parts)) {
    return payload;
  }
  const parts = await Promise.all(payload.parts.map(async (part) => {
    if (!part || typeof part !== "object" || part.kind !== "file") return part;
    validateFilePartDisplayFields(part);
    if (isWireFilePart(part)) return part;
    if (!isLocalFilePart(part)) {
      throw fileError(
        "FILE_PART_INVALID",
        "file parts need a localPath (before sending) or a file_id (already uploaded)"
      );
    }
    const hashed = await hashLocalFile(part.localPath);
    const normalized = {
      kind: "file",
      local_path: hashed.localPath,
      name: (typeof part.name === "string" && part.name.trim()) || basename(hashed.localPath),
      size_bytes: hashed.sizeBytes,
      sha256: hashed.sha256
    };
    const mimeType = typeof partMimeTypeInput(part) === "string" ? partMimeTypeInput(part).trim() : "";
    if (mimeType) {
      normalized.mime_type = mimeType;
    }
    return normalized;
  }));
  return { ...payload, parts };
}

/**
 * Initial Task messages (create / follow-up) cannot carry file parts: relay
 * uploads are Task-scoped and the Task does not exist yet. Reject early with
 * an actionable message instead of letting the relay 400 surface later.
 */
export function rejectInitialFileParts(message, { context = "initial message" } = {}) {
  if (!message || typeof message !== "object" || !hasAnyFilePart(message.parts)) return;
  throw fileError(
    "FILE_PART_UNSUPPORTED_HERE",
    `file parts are not supported in a Task's ${context}; create the Task first, then reply with the file part`
  );
}

/**
 * Post-approval wire transformation: upload each local file part through the
 * provided uploader and replace it with the relay file reference. Runs only
 * inside the mutation step, after human approval, so file content never leaves
 * the machine earlier. Content binding is enforced by the ACTION_PAYLOAD_CHANGED
 * guard (prepare-time vs execution-time sha256) and by the relay's own
 * X-AgentRelay-File-Sha256 verification; parts passed in here must already
 * carry the approved sha256/size from normalizeReplyFileParts.
 */
export async function resolveReplyWireParts({ parts, uploadFile }) {
  if (!Array.isArray(parts)) return parts;
  let changed = false;
  const wireParts = await Promise.all(parts.map(async (part) => {
    if (!part || typeof part !== "object" || part.kind !== "file") return part;
    if (isWireFilePart(part)) return part;
    if (typeof part.local_path !== "string" || !part.local_path) {
      throw fileError("FILE_PART_INVALID", "file parts need a localPath or a file_id");
    }
    const uploaded = await uploadFile({
      localPath: part.local_path,
      name: part.name,
      mimeType: part.mime_type,
      sizeBytes: part.size_bytes,
      sha256: part.sha256
    });
    changed = true;
    const wirePart = {
      kind: "file",
      file_id: uploaded.file_id,
      name: part.name,
      size_bytes: part.size_bytes,
      sha256: part.sha256
    };
    if (part.mime_type) wirePart.mime_type = part.mime_type;
    return wirePart;
  }));
  return changed ? wireParts : parts;
}

export function safeFileName(name) {
  const cleaned = String(name || "")
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, SAFE_FILE_NAME_MAX_LENGTH)
    .replace(/\.+$/, "");
  return cleaned || "file";
}

export async function writeDownloadedFile({ targetPath, bytes }) {
  await mkdir(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.download-${randomUUID().hex}.tmp`;
  await writeFile(tempPath, bytes, { mode: 0o600 });
  await rename(tempPath, targetPath);
  return targetPath;
}

export function formatFileSize(sizeBytes) {
  const value = Number(sizeBytes) || 0;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

export function filePartMarker(part) {
  const name = typeof part?.name === "string" && part.name ? part.name : "attachment";
  return `[文件: ${name} (${formatFileSize(part?.size_bytes)})]`;
}

export function isAbsoluteLocalPath(value) {
  return typeof value === "string" && isAbsolute(value);
}
