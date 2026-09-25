import { expect, spyOn, test } from "bun:test";
import { clientConnectionSchema } from "../../src/config/schema/leaf-validators";
import { connectClient } from "../../src/client/connect";
import { linkRelayDestination } from "../../src/client/link-relay";
import { isLinkPort } from "../../src/link/ports";
import { parseLinkStore } from "../../src/link/store";
import { runLinkCommand } from "../../src/cli/link";

const linkId = "lnk_0123456789abcdef";
const linkKey = `ocx_data_${"a".repeat(40)}`;

function linkConfig(tunnelPort: number) {
  return {
    serverUrl: `http://127.0.0.1:${tunnelPort}`,
    managementUrl: `http://127.0.0.1:${tunnelPort}`,
    managementTransport: "direct",
    transport: "link",
    link: { tunnelPort, linkId },
    selectedClients: ["codex"],
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    apiKeyId: "key-1",
    tokenFingerprint: "a".repeat(64),
    protocolVersion: 1,
    connectedAt: "2026-09-25T00:00:00.000Z",
  };
}

async function cliExit(args: string[], deps: Parameters<typeof runLinkCommand>[1]): Promise<number> {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try { return await runLinkCommand(args, deps); }
  finally { error.mockRestore(); }
}

test("isLinkPort accepts 1024 and rejects privileged and oversized values", () => {
  expect(isLinkPort(1023)).toBe(false);
  expect(isLinkPort(1024)).toBe(true);
  expect(isLinkPort(65535)).toBe(true);
  expect(isLinkPort(65536)).toBe(false);
});

test("CLI link port allocation and issue parsing use the client port contract", async () => {
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await runLinkCommand(["port"], { choosePort: async () => 1024 })).toBe(0);
    expect(output.mock.calls.flat().join(" ")).toContain('"port":1024');
  } finally {
    output.mockRestore();
  }
  expect(await cliExit(["port"], { choosePort: async () => 1023 })).toBe(1);
  expect(await cliExit(["issue", "--alias", "home.example.test", "--tunnel-port", "1023"], {
    baseUrl: "http://127.0.0.1:10100",
    fetchImpl: async () => Response.json({}),
  })).toBe(2);
  expect(await cliExit(["issue", "--alias", "home.example.test", "--tunnel-port", "65536"], {
    baseUrl: "http://127.0.0.1:10100",
    fetchImpl: async () => Response.json({}),
  })).toBe(2);
  const calls: Request[] = [];
  const issueOutput = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await runLinkCommand(["issue", "--alias", "home.example.test", "--tunnel-port", "1024"], {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl: async (input, init) => {
        calls.push(new Request(input, init));
        return Response.json({ linkId, apiKeyId: "key-1", key: linkKey, listenerPort: 1 });
      },
    })).toBe(0);
  } finally {
    issueOutput.mockRestore();
  }
  expect(JSON.parse(await calls[0]!.text())).toEqual({ alias: "home.example.test", tunnelPort: 1024 });
});

test("store and relay keep listener ports broad while enforcing tunnel ports", () => {
  const record = {
    id: linkId,
    alias: "home.example.test",
    direction: "hub-initiated",
    hostKeyFingerprint: "SHA256:ABCDEFGHIJKLMNOP",
    tunnelPort: 1024,
    apiKeyId: "key-1",
    createdAt: "2026-09-25T00:00:00.000Z",
  };
  expect(parseLinkStore(JSON.stringify({ version: 1, listenerPort: 1, links: [record] })).links[0]?.tunnelPort).toBe(1024);
  expect(() => parseLinkStore(JSON.stringify({ version: 1, listenerPort: 1, links: [{ ...record, tunnelPort: 1023 }] }))).toThrow();
  expect(linkRelayDestination(new URL("http://127.0.0.1/v1/models"), { tunnelPort: 1024 }))
    .toBe("http://127.0.0.1:1024/v1/models");
  expect(() => linkRelayDestination(new URL("http://127.0.0.1/v1/models"), { tunnelPort: 1023 })).toThrow();
  expect(() => linkRelayDestination(new URL("http://127.0.0.1/v1/models"), { tunnelPort: 65536 })).toThrow();
});

test("config and connect validation use isLinkPort", async () => {
  expect(clientConnectionSchema.safeParse(linkConfig(1024)).success).toBe(true);
  expect(clientConnectionSchema.safeParse(linkConfig(1023)).success).toBe(false);
  expect(clientConnectionSchema.safeParse(linkConfig(65536)).success).toBe(false);
  await expect(connectClient({
    serverUrl: "http://127.0.0.1:1023",
    managementUrl: "http://127.0.0.1:1023",
    managementTransport: "direct",
    transport: "link",
    link: { tunnelPort: 1023, linkId },
    credential: { kind: "link", apiKeyId: "key-1", key: linkKey },
    selectedClients: ["codex"],
  })).rejects.toThrow("invalid link credential");
});
