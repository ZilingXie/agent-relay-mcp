import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 64 * 1024;

export function investigationDurableSinkFromEnv(command = process.env.AGENTRELAY_INVESTIGATION_DURABLE_SINK || "") {
  const executable = String(command || "").trim();
  return executable ? new InvestigationDurableSink({ executable }) : null;
}

export class InvestigationDurableSink {
  constructor({ executable, spawnImpl = spawn }) {
    this.executable = requiredString(executable, "executable");
    this.spawnImpl = spawnImpl;
  }

  async prepare(input) {
    const receipt = await this.run("prepare", input);
    if (receipt.event_persisted !== true) {
      throw sinkError("INVESTIGATION_SINK_EVENT_NOT_DURABLE", "Investigation sink did not confirm durable Event persistence");
    }
    return receipt;
  }

  async persistSnapshot(input) {
    const receipt = await this.run("persist-snapshot", input);
    if (receipt.event_persisted !== true || receipt.snapshot_persisted !== true) {
      throw sinkError("INVESTIGATION_SINK_SNAPSHOT_NOT_DURABLE", "Investigation sink did not confirm Event and snapshot persistence");
    }
    return receipt;
  }

  run(phase, input) {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.executable, ["--phase", phase], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout = `${stdout}${chunk.toString("utf8")}`;
        if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) child.kill();
      });
      child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
      });
      child.once("error", (error) => reject(sinkError("INVESTIGATION_SINK_START_FAILED", error.message)));
      child.once("close", (code) => {
        if (code !== 0) {
          reject(sinkError("INVESTIGATION_SINK_FAILED", `Investigation sink ${phase} exited with ${code}: ${stderr.trim()}`));
          return;
        }
        try {
          const receipt = parseReceipt(stdout);
          assertReceiptCorrelation(receipt, input);
          resolve(receipt);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(`${JSON.stringify({ version: 1, phase, ...input })}\n`);
    });
  }
}

function parseReceipt(stdout) {
  const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // A sink may emit diagnostics before its final machine-readable receipt.
    }
  }
  throw sinkError("INVESTIGATION_SINK_INVALID_RECEIPT", "Investigation sink did not emit a JSON receipt");
}

function assertReceiptCorrelation(receipt, input) {
  if (receipt.ok !== true) {
    throw sinkError("INVESTIGATION_SINK_REJECTED", "Investigation sink rejected the Event");
  }
  if (receipt.event_id !== input.eventId || receipt.task_id !== input.taskId) {
    throw sinkError("INVESTIGATION_SINK_CORRELATION_MISMATCH", "Investigation sink receipt correlation does not match the Event");
  }
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw sinkError("INVESTIGATION_SINK_INVALID_CONFIG", `${name} must be a non-empty string`);
  }
  return value.trim();
}

function sinkError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
