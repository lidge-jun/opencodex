import { desktopOutboundFetch } from "../../src/lib/desktop-proxy-route";
const response = await desktopOutboundFetch("https://chatgpt.com/fixture", {
  method: "POST", body: new Uint8Array([0, 255, 42]), signal: AbortSignal.timeout(5000), headers: { cookie: "fixture=session" },
});
console.log(JSON.stringify({ status: response.status, body: await response.text() }));
