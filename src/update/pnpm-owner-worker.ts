import { resolveCurrentPnpmGlobalOwner } from "./index";

onmessage = event => {
  try {
    const invoked = typeof event.data === "string" ? event.data : "";
    if (!invoked) { postMessage(null); return; }
    const result = resolveCurrentPnpmGlobalOwner(invoked);
    postMessage(result.ok ? result.owner : null);
  } catch {
    postMessage(null);
  }
};
