import { resolveWindowsNativePrincipal } from "./windows-native-principal";

declare const self: Worker;
self.addEventListener("message", () => {
  try {
    const identity = resolveWindowsNativePrincipal();
    self.postMessage(identity ? { kind: "identity", ...identity } : { kind: "unavailable" });
  } catch {
    self.postMessage({ kind: "failure" });
  } finally {
    // Native token/string/DLL finally blocks completed before the result was posted.
    process.exit(0);
  }
}, { once: true });
