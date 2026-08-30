import { createInterface } from "node:readline";
import { getValidMainAccountToken } from "../../src/codex/main-account";

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ...event, pid: process.pid })}\n`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

emit({ event: "ready" });

for await (const line of input) {
  if (line !== "run") continue;
  try {
    const result = await getValidMainAccountToken({
      refreshToken: async () => {
        emit({ event: "refresh" });
        return {
          access: "fresh-access",
          refresh: "rotated-grant",
          expires: Date.now() + 3_600_000,
          accountId: "account-main",
        };
      },
    });
    emit({ event: "result", ...result });
  } catch (error) {
    emit({ event: "fatal", message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
  break;
}
