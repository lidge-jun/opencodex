import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { standaloneRecycleEnv } from "../../src/client/runtime";

describe("standalone recycle environment", () => {
  test("removes a disconnected hub token and its token-file source", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-recycle-env-"));
    const file = join(dir, "hub-service-token");
    const hubToken = "hub-issued-token";
    writeFileSync(file, `${hubToken}\n`, "utf8");
    const source = {
      OPENCODEX_API_AUTH_TOKEN: hubToken,
      OCX_API_TOKEN_FILE: file,
      PATH: "/usr/bin",
    };

    const result = standaloneRecycleEnv(source, serviceApiTokenFingerprint(hubToken));
    expect(result).toEqual({
      PATH: "/usr/bin",
    });
    expect(result.OCX_API_TOKEN_FILE).toBeUndefined();
    expect(source.OPENCODEX_API_AUTH_TOKEN).toBe(hubToken);
    expect(source.OCX_API_TOKEN_FILE).toBe(file);
  });

  test("preserves an independently configured operator credential", () => {
    const operatorToken = "operator-token";
    const source = {
      OPENCODEX_API_AUTH_TOKEN: operatorToken,
      OCX_API_TOKEN_FILE: "/tmp/operator-token",
    };

    expect(standaloneRecycleEnv(source, serviceApiTokenFingerprint("disconnected-hub-token"))).toEqual(source);
  });

  test("removes a token-file source carrying the disconnected token when the env var is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-recycle-env-"));
    const file = join(dir, "named-token");
    const hubToken = "hub-issued-token";
    writeFileSync(file, `${hubToken}\n`, "utf8");
    const source = {
      OCX_API_TOKEN_FILE: file,
      PATH: "/usr/bin",
    };

    expect(standaloneRecycleEnv(source, serviceApiTokenFingerprint(hubToken))).toEqual({
      PATH: "/usr/bin",
    });
    expect(source.OCX_API_TOKEN_FILE).toBe(file);
  });

  test("keeps a token file holding a different operator credential", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-recycle-env-"));
    const file = join(dir, "operator-token");
    writeFileSync(file, "operator-token\n", "utf8");
    const hubToken = "hub-issued-token";
    const source = {
      OPENCODEX_API_AUTH_TOKEN: hubToken,
      OCX_API_TOKEN_FILE: file,
    };

    expect(standaloneRecycleEnv(source, serviceApiTokenFingerprint(hubToken))).toEqual({
      OCX_API_TOKEN_FILE: file,
    });
  });

  test("removes a missing token-file source when the env token matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-recycle-env-"));
    const hubToken = "hub-issued-token";
    const source = {
      OPENCODEX_API_AUTH_TOKEN: hubToken,
      OCX_API_TOKEN_FILE: join(dir, "does-not-exist"),
    };

    expect(standaloneRecycleEnv(source, serviceApiTokenFingerprint(hubToken))).toEqual({});
  });
});
