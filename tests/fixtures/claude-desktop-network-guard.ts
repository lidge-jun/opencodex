/** Process-fixture guard: unexpected traffic must never reach a real provider. */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const allowed = new Set<string>(JSON.parse(process.env.OCX_TEST_ALLOWED_ORIGINS ?? "[]"));
const deniedFile = process.env.OCX_TEST_DENIED_REQUESTS;
const nativeFetch = globalThis.fetch;

function permit(input: Parameters<typeof fetch>[0]): void {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (allowed.has(url.origin)) return;
  // The real CLI can consult its own management endpoint during startup.
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    try {
      const record = JSON.parse(readFileSync(join(process.env.OPENCODEX_HOME!, "runtime-port.json"), "utf8"));
      if (record.pid === process.pid && record.port === Number(url.port)) return;
    } catch { /* no owned listener yet */ }
  }
  if (deniedFile) appendFileSync(deniedFile, url.origin + "\n");
  throw new Error("OCX_TEST_EXTERNAL_REQUEST_BLOCKED");
}

globalThis.fetch = Object.assign(
  (...args: Parameters<typeof fetch>) => {
    permit(args[0]);
    return nativeFetch(...args);
  },
  {
    preconnect: (...args: Parameters<typeof fetch.preconnect>) => {
      permit(args[0]);
      return nativeFetch.preconnect(...args);
    },
  },
);
