import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserSecurityHeaders, corsHeaders } from "../src/server/auth-cors";
import { serveGuiFile } from "../src/server/gui-static";

const EXPECTED = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

describe("clickjacking response headers", () => {
  test("the shared browser header set denies all framing", () => {
    expect(browserSecurityHeaders()).toEqual(EXPECTED);
  });

  test("API and preflight headers include the framing policy", () => {
    expect(corsHeaders()).toMatchObject(EXPECTED);
  });

  test("static dashboard responses include the framing policy", () => {
    const guiDist = mkdtempSync(join(tmpdir(), "ocx-gui-headers-"));
    writeFileSync(join(guiDist, "index.html"), "<!doctype html><title>test</title>");
    try {
      const response = serveGuiFile("/", guiDist);
      expect(response).not.toBeNull();
      expect(response?.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response?.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    } finally {
      rmSync(guiDist, { recursive: true, force: true });
    }
  });
});
