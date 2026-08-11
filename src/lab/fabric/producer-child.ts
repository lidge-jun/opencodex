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

async function runHarness(kind: FabricHarnessProducerKind, scratchRoot: string): Promise<SyntheticPatchV1> {
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
        await Bun.sleep(1_000);
      }
    case "mutate_after_delay": {
      await Bun.sleep(FABRIC_LIMITS.totalTimeoutMs + 5_000);
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { join, dirname } = await import("node:path");
      mkdirSync(join(scratchRoot, dirname(SYNTHETIC_VALUE_PATH)), { recursive: true });
      writeFileSync(join(scratchRoot, SYNTHETIC_VALUE_PATH), "late\n");
      return correctPatch();
    }
    case "periodic_activity":
      for (let i = 0; i < 20; i++) {
        writeLine({ type: "activity" });
        await Bun.sleep(200);
      }
      return correctPatch();
    case "activity_until_total":
      while (true) {
        writeLine({ type: "activity" });
        await Bun.sleep(50);
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
  let patch: SyntheticPatchV1;
  const reportActivity = () => writeLine({ type: "activity" });
  if (req.harnessKind) {
    patch = await runHarness(req.harnessKind as FabricHarnessProducerKind, req.scratchRoot);
  } else if (req.executorModulePath) {
    patch = await runExecutorModule(req.executorModulePath, req.executorInput, reportActivity);
  } else {
    throw new Error("child request missing harnessKind or executorModulePath");
  }
  writeLine({ type: "result", patch });
}

main().catch((error: unknown) => {
  writeLine({
    type: "error",
    code: "harness_failure",
    message: error instanceof Error ? error.message : String(error),
    attribution: "harness",
  });
  process.exit(1);
});
