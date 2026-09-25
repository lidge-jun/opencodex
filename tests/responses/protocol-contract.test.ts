/**
 * The shared protocol vocabulary (src/protocols/contract.ts) and its leaf-module boundary.
 *
 * The dashboard imports these files directly, so an import of server, router, provider or Lab
 * code would drag the runtime into the GUI bundle and its typecheck. The boundary case reads
 * the import specifiers as text rather than trusting a reviewer to notice.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  deliveryModeForPath,
  inboundWireForProtocol,
  isDeliveryMode,
  isProtocolReasonCode,
  labProtocolForProtocol,
  protocolFromInboundWire,
  protocolFromLabProtocol,
  protocolNodes,
  PROTOCOLS,
  upstreamWireForAdapter,
} from "../../src/protocols/contract";
import { repoPath } from "../helpers/repo-root";

describe("protocol vocabulary mapping", () => {
  test("inbound wire spelling round-trips through the public name", () => {
    expect(protocolFromInboundWire("anthropic")).toBe("messages");
    expect(protocolFromInboundWire("chat")).toBe("chat");
    expect(protocolFromInboundWire("responses")).toBe("responses");
    for (const protocol of PROTOCOLS) {
      expect(protocolFromInboundWire(inboundWireForProtocol(protocol))).toBe(protocol);
    }
  });

  test("Lab protocol identities map both ways and reject unknown identities", () => {
    for (const protocol of PROTOCOLS) {
      expect(protocolFromLabProtocol(labProtocolForProtocol(protocol))).toBe(protocol);
    }
    expect(protocolFromLabProtocol("anthropic")).toBeUndefined();
    expect(protocolFromLabProtocol("gemini")).toBeUndefined();
  });

  test("only the three public-wire adapters map to a protocol", () => {
    expect(upstreamWireForAdapter("openai-responses")).toBe("responses");
    expect(upstreamWireForAdapter("openai-chat")).toBe("chat");
    expect(upstreamWireForAdapter("anthropic")).toBe("messages");
    expect(upstreamWireForAdapter("google")).toBe("other");
    expect(upstreamWireForAdapter("kiro")).toBe("other");
    expect(upstreamWireForAdapter("")).toBe("other");
  });

  test("guards accept exactly the declared vocabulary", () => {
    expect(isDeliveryMode("native")).toBe(true);
    expect(isDeliveryMode("passthrough")).toBe(false);
    expect(isProtocolReasonCode("not-migrated")).toBe(true);
    expect(isProtocolReasonCode("because I said so")).toBe(false);
  });
});

describe("path semantics", () => {
  test("protocolNodes drops ir and folds the internal Responses bridge into Responses", () => {
    expect(protocolNodes(["chat", "responses-internal", "ir", "chat"])).toEqual(["chat", "responses", "chat"]);
    expect(protocolNodes(["responses", "ir", "chat"])).toEqual(["responses", "chat"]);
    expect(protocolNodes(["chat", "chat"])).toEqual(["chat"]);
  });

  test("mode follows the path: internal Responses means legacy-bridge", () => {
    expect(deliveryModeForPath(["chat", "chat"])).toBe("native");
    expect(deliveryModeForPath(["chat", "responses"])).toBe("translated");
    expect(deliveryModeForPath(["responses", "ir", "messages"])).toBe("translated");
    expect(deliveryModeForPath(["messages", "responses-internal", "ir", "messages"])).toBe("legacy-bridge");
    expect(deliveryModeForPath(["chat", "ir", "other"])).toBe("translated");
  });
});

describe("leaf-module boundary", () => {
  const LEAVES = ["contract.ts", "features.ts", "baseline.ts", "dto.ts", "path.ts", "plan.ts", "guard.ts", "shadow.ts"];
  const ALLOWED = new Set(["./contract", "./features", "./dto", "./path", "../compatibility/manifest"]);

  for (const file of LEAVES) {
    test(`src/protocols/${file} imports only protocol leaves`, () => {
      const source = readFileSync(repoPath("src", "protocols", file), "utf8");
      const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(match => match[1]);
      for (const specifier of specifiers) expect(ALLOWED.has(specifier!)).toBe(true);
    });
  }
});
