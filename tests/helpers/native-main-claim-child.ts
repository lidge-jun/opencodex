import { withNativeMainExclusiveClaim } from "../../src/codex/native-main-claim";
import type { NativeProfileContext } from "../../src/codex/native-profile-store";

const codexHome = process.argv[2];
if (!codexHome) throw new Error("missing CODEX_HOME argument");
const context = { codexHome } as NativeProfileContext;

try {
  await withNativeMainExclusiveClaim(context, async () => undefined, {
    waitMs: 0,
    hardenPath: async () => {},
  });
  console.log(JSON.stringify({ status: "acquired" }));
} catch (error) {
  console.log(JSON.stringify({
    status: "rejected",
    code: error instanceof Error && "code" in error ? String(error.code) : undefined,
  }));
}
