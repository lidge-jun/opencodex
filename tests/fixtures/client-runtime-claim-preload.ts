// Preloaded into the `ocx start` child by tests/cli/cli-client-start-owner-e2e.test.ts.
//
// handleStart loads src/client/runtime.ts with a dynamic import on the connected-client branch,
// after the early owner check and the lease-held recovery fence and immediately before the
// client-runtime fence. Publishing an owner while that module loads is therefore the
// exact interleaving the fence exists for, without timing: nothing else imports that module.
import { plugin } from "bun";
import { swapServiceInstallState } from "../../src/service/state";

const CLIENT_RUNTIME = /[\\/]src[\\/]client[\\/]runtime\.ts$/;

plugin({
  name: "commit-desktop-claim-at-client-runtime-load",
  setup(build) {
    build.onLoad({ filter: CLIENT_RUNTIME }, async args => {
      const publishOwnerUrl = process.env.OCX_TEST_LATE_OWNER_URL;
      if (publishOwnerUrl) {
        const response = await fetch(publishOwnerUrl, { method: "POST" });
        if (!response.ok) throw new Error("fixture failed to publish the late owner");
        return { contents: await Bun.file(args.path).text(), loader: "ts" };
      }
      const codexHome = process.env.CODEX_HOME ?? "";
      const opencodexHome = process.env.OPENCODEX_HOME ?? "";
      const state = swapServiceInstallState(current => ({
        ...(current ?? { version: 2, codexHome, opencodexHome, backend: "scheduler" }),
        ownership: { owner: "desktop", installId: "app-install-a", consentGeneration: 1 },
        consentGenerationCeiling: 1,
        ownershipProtocolVersion: 1,
      }));
      if (state?.ownership?.owner === "desktop") console.error("[claim-preload] desktop claim committed at client runtime load");
      return { contents: await Bun.file(args.path).text(), loader: "ts" };
    });
  },
});
