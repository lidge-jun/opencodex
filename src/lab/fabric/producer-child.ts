import {
  FABRIC_LIMITS,
  SYNTHETIC_AFTER_UTF8,
  SYNTHETIC_BEFORE_UTF8,
  SYNTHETIC_VALUE_PATH,
} from "./constants";
import {
  encodeProducerProtocolLine,
  FABRIC_PRODUCER_PROTOCOL_MAX_BYTES,
  FABRIC_PRODUCER_REQUEST_MAX_BYTES,
  type ProducerParentRequest,
} from "./producer-protocol";
import type { FabricHarnessProducerKind, SyntheticPatchV1 } from "./types";

function writeLine(message: Parameters<typeof encodeProducerProtocolLine>[0]): void {
  process.stdout.write(encodeProducerProtocolLine(message));
}

function correctPatch(): SyntheticPatchV1 {
  return {
    schemaVersion: 1,
    operations: [{ op: "replace", path: SYNTHETIC_VALUE_PATH, contentUtf8: SYNTHETIC_AFTER_UTF8 }],
  };
}

function wrongPatch(): SyntheticPatchV1 {
  return {
    schemaVersion: 1,
    operations: [{ op: "replace", path: SYNTHETIC_VALUE_PATH, contentUtf8: "wrong\n" }],
  };
}

async function runHarness(
  kind: FabricHarnessProducerKind,
  scratchRoot: string,
  totalTimeoutMs: number,
  inactivityTimeoutMs: number,
): Promise<SyntheticPatchV1> {
  switch (kind) {
    case "deterministic_correct":
      return correctPatch();
    case "deterministic_wrong":
      return wrongPatch();
    case "infinite_sync":
      while (true) {
        /* terminated by parent */
      }
    case "never_resolve":
      while (true) {
        await Bun.sleep(Math.max(25, Math.min(1_000, Math.floor(inactivityTimeoutMs * 0.75))));
      }
    case "mutate_after_delay": {
      await Bun.sleep(totalTimeoutMs + Math.max(250, inactivityTimeoutMs));
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { join, dirname } = await import("node:path");
      mkdirSync(join(scratchRoot, dirname(SYNTHETIC_VALUE_PATH)), { recursive: true });
      writeFileSync(join(scratchRoot, SYNTHETIC_VALUE_PATH), "late\n");
      return correctPatch();
    }
    case "periodic_activity": {
      const intervalMs = Math.max(10, Math.min(200, Math.floor(inactivityTimeoutMs * 0.4)));
      const iterations = Math.max(3, Math.min(20, Math.floor((totalTimeoutMs * 0.7) / intervalMs)));
      for (let i = 0; i < iterations; i++) {
        writeLine({ type: "activity" });
        await Bun.sleep(intervalMs);
      }
      return correctPatch();
    }
    case "activity_until_total": {
      const intervalMs = Math.max(10, Math.min(50, Math.floor(inactivityTimeoutMs * 0.25)));
      while (true) {
        writeLine({ type: "activity" });
        await Bun.sleep(intervalMs);
      }
    }
    case "flood_stdout":
      while (true) {
        process.stdout.write("x".repeat(4096));
      }
    default:
      throw new Error(`unsupported harness kind: ${kind as string}`);
  }
}

async function runExecutorModule(
  modulePath: string,
  executorInput: unknown,
  reportActivity: () => void,
): Promise<SyntheticPatchV1> {
  const mod = await import(modulePath) as { execute: (input: unknown) => Promise<SyntheticPatchV1> | SyntheticPatchV1 };
  if (typeof mod.execute !== "function") throw new Error("executor module missing execute export");
  const input = {
    ...(executorInput as Record<string, unknown>),
    reportActivity,
  };
  return await Promise.resolve(mod.execute(input));
}

async function main(): Promise<void> {
  const raw = await Bun.stdin.text();
  if (Buffer.byteLength(raw, "utf8") > FABRIC_PRODUCER_REQUEST_MAX_BYTES) {
    writeLine({
      type: "error",
      code: "budget_exhausted",
      message: "request payload exceeds protocol limit",
      attribution: "environment",
    });
    process.exit(1);
    return;
  }
  const req = JSON.parse(raw) as ProducerParentRequest;
  const totalTimeoutMs = req.totalTimeoutMs ?? FABRIC_LIMITS.totalTimeoutMs;
  const inactivityTimeoutMs = req.inactivityTimeoutMs ?? FABRIC_LIMITS.inactivityTimeoutMs;
  let patch: SyntheticPatchV1;
  const reportActivity = () => writeLine({ type: "activity" });
  if (req.harnessKind) {
    patch = await runHarness(
      req.harnessKind as FabricHarnessProducerKind,
      req.scratchRoot,
      totalTimeoutMs,
      inactivityTimeoutMs,
    );
  } else if (req.executorModulePath) {
    patch = await runExecutorModule(req.executorModulePath, req.executorInput, reportActivity);
  } else {
    throw new Error("child request missing harnessKind or executorModulePath");
  }
  writeLine({ type: "result", patch });
}

await main().catch((error: unknown) => {
  writeLine({
    type: "error",
    code: "harness_failure",
    message: error instanceof Error ? error.message : String(error),
    attribution: "harness",
  });
  process.exit(1);
});
