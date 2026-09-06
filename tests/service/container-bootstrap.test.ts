import { afterEach, describe, expect, test } from "bun:test";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readBoundedToken } from "../../docker/bootstrap-token";
import { verifyCompatibilitySnapshot } from "../../docker/verify-compatibility";
import type { CompatibilityVersionManifest } from "../../scripts/generate-compatibility-version";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

function input(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("container token bootstrap", () => {
  test("accepts one trimmed token split across input chunks", async () => {
    await expect(readBoundedToken(input("  compose-", "token\n"))).resolves.toBe("compose-token");
  });

  test("accepts a maximum-size token followed by a shell newline", async () => {
    const token = "x".repeat(4096);
    await expect(readBoundedToken(input(token, "\n"))).resolves.toBe(token);
  });

  test("rejects empty, multiline, and oversized input", async () => {
    await expect(readBoundedToken(input(" \n"))).rejects.toThrow("token input is empty");
    await expect(readBoundedToken(input("first\nsecond\n"))).rejects.toThrow("exactly one line");
    await expect(readBoundedToken(input("first\n\n"))).rejects.toThrow("exactly one line");
    await expect(readBoundedToken(input("\nfirst\n"))).rejects.toThrow("exactly one line");
    await expect(readBoundedToken(input("x".repeat(4097), "\n"))).rejects.toThrow("exceeds 4096 bytes");
  });
});

describe("container deployment contract", () => {
  test("persists separate OCX and Codex homes under the read-only root", () => {
    const compose = Bun.YAML.parse(readFileSync(repoPath("compose.yaml"), "utf8")) as {
      services: { hub: { environment: Record<string, string>; volumes: string[]; read_only: boolean } };
      volumes: Record<string, unknown>;
    };
    const hub = compose.services.hub;
    expect(hub.environment?.CODEX_HOME).toBe("/home/bun/.codex");
    expect(hub.read_only).toBe(true);
    expect(hub.volumes).toContain("ocx-state:/home/bun/.opencodex");
    expect(hub.volumes).toContain("codex-state:/home/bun/.codex");
    expect(Object.hasOwn(compose.volumes, "codex-state")).toBe(true);

    const runtime = readFileSync(repoPath("Dockerfile"), "utf8").split(" AS runtime")[1]!;
    expect(runtime).toContain("CODEX_HOME=/home/bun/.codex");
    expect(runtime).toContain("install -d -m 0700 -o bun -g bun /home/bun/.opencodex /home/bun/.codex");
    expect(runtime).toContain('VOLUME ["/home/bun/.opencodex", "/home/bun/.codex"]');
    expect(runtime).toContain("USER bun");
  });

  test("catalog serialization uses the persistent Codex home without combining auth stores", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-container-catalog-"));
    snapshotDirs.push(root);
    const ocxHome = join(root, "ocx-state");
    const codexHome = join(root, "codex-state");
    mkdirSync(ocxHome, { mode: 0o700 });
    mkdirSync(codexHome, { mode: 0o700 });
    const previousOcx = process.env.OPENCODEX_HOME;
    const previousCodex = process.env.CODEX_HOME;
    process.env.OPENCODEX_HOME = ocxHome;
    process.env.CODEX_HOME = codexHome;
    const ocxAuth = '{"fixture":"ocx-oauth-store"}';
    const codexAuth = '{"fixture":"native-codex-store"}';
    writeFileSync(join(ocxHome, "auth.json"), ocxAuth, { mode: 0o600 });
    writeFileSync(join(codexHome, "auth.json"), codexAuth, { mode: 0o600 });
    const catalog = { models: [{ slug: "fixture/model", display_name: "Fixture", description: "fixture",
      priority: 1, visibility: "list", base_instructions: "Fixture", input_modalities: ["text"] }] };
    try {
      const { serializePersistedCatalog } = await import("../../src/server/catalog-download");
      expect((await serializePersistedCatalog()).body).toBeNull();
      writeFileSync(join(ocxHome, "opencodex-catalog.json"), JSON.stringify(catalog), { mode: 0o600 });
      expect((await serializePersistedCatalog()).body).toBeNull();
      writeFileSync(join(codexHome, "opencodex-catalog.json"), JSON.stringify(catalog), { mode: 0o600 });
      expect(JSON.parse((await serializePersistedCatalog()).body!)).toEqual(catalog);
      expect(readFileSync(join(ocxHome, "auth.json"), "utf8")).toBe(ocxAuth);
      expect(readFileSync(join(codexHome, "auth.json"), "utf8")).toBe(codexAuth);
    } finally {
      if (previousOcx === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousOcx;
      if (previousCodex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodex;
    }
  });

  test("publishes only the data port with loopback and explicit bind overrides", () => {
    const compose = Bun.YAML.parse(readFileSync(repoPath("compose.yaml"), "utf8")) as {
      services: { hub: { ports: string[] } };
    };
    expect(compose.services.hub.ports).toEqual([
      "${OPENCODEX_BIND_ADDRESS:-127.0.0.1}:${OPENCODEX_PORT:-10100}:10100",
    ]);
  });

  test("requires the host-generated manifest in the runtime image", () => {
    const ignored = readFileSync(repoPath(".dockerignore"), "utf8").split(/\r?\n/);
    expect(ignored[0]).toBe("**");
    expect(ignored).toContain("!src/generated/compatibility-version.json");
    expect(ignored).not.toContain("src/generated/compatibility-version.json");
    expect(ignored.some(line => /^!\/?\.git(?:\/|$)/.test(line))).toBe(false);
    expect(ignored.slice(ignored.indexOf("!scripts/"), ignored.indexOf("!scripts/") + 3)).toEqual([
      "!scripts/", "scripts/**", "!scripts/model-metadata.source.json",
    ]);
    expect(ignored).not.toContain("!scripts/**");

    const dockerfile = readFileSync(repoPath("Dockerfile"), "utf8");
    const runtime = dockerfile.split(" AS runtime")[1];
    expect(dockerfile).toContain("RUN --mount=type=bind,target=/build-context bun /tmp/verify-compatibility.ts /build-context");
    expect(dockerfile.indexOf("RUN --mount=type=bind")).toBeLessThan(dockerfile.indexOf("COPY --chown=bun:bun src ./src"));
    expect(dockerfile).toContain("COPY --chown=bun:bun scripts/model-metadata.source.json ./scripts/model-metadata.source.json");
    expect(runtime).toContain("COPY --from=build --chown=bun:bun /home/bun/app/scripts/model-metadata.source.json ./scripts/model-metadata.source.json");
    expect(runtime).toContain("COPY --chown=bun:bun src/generated/compatibility-version.json ./src/generated/compatibility-version.json");
    expect(runtime).toContain('RUN ["bun", "docker/verify-compatibility.ts"]');
    expect(runtime).toContain("readOpenCodexCompatibilityVersion() ?? ''");
    expect(runtime).toContain("throw new Error('Missing or invalid generated compatibility manifest')");
  });
});

const snapshotDirs: string[] = [];
const manifestPath = "src/generated/compatibility-version.json";
const snapshotPaths = ["package.json", "bun.lock", "scripts/model-metadata.source.json", "src/main.ts"];
// Independent SHA-256 test vector for the bytes "abc", not computed by the verifier.
const abcDigest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

afterEach(() => {
  for (const dir of snapshotDirs.splice(0)) removeTreeWithRetry(dir);
});

function compatibilitySnapshot() {
  const root = mkdtempSync(join(tmpdir(), "ocx-container-identity-"));
  snapshotDirs.push(root);
  for (const path of snapshotPaths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "abc");
  }
  mkdirSync(join(root, "src/generated"));
  const manifest: CompatibilityVersionManifest = {
    schemaVersion: 1,
    assertionDslVersion: "1.0.0",
    evidenceSchemaVersion: "1.0.0",
    bunRuntimeVersion: "1.4.0",
    files: snapshotPaths.map(path => ({ path, sha256: abcDigest })),
  };
  const save = () => writeFileSync(join(root, manifestPath), JSON.stringify(manifest));
  save();
  return { root, manifest, save };
}

describe("container compatibility snapshot validation", () => {
  test("accepts matching bytes and the complete source set without Git metadata", () => {
    const { root } = compatibilitySnapshot();
    expect(existsSync(join(root, ".git"))).toBe(false);
    expect(() => verifyCompatibilitySnapshot(root)).not.toThrow();
  });

  for (const path of snapshotPaths) {
    test(`rejects stale bytes in ${path}`, () => {
      const { root } = compatibilitySnapshot();
      writeFileSync(join(root, path), "abd"); // Same length; metadata checks are insufficient.
      expect(() => verifyCompatibilitySnapshot(root)).toThrow("hash mismatch");
    });

    test(`rejects a missing copied file: ${path}`, () => {
      const { root } = compatibilitySnapshot();
      unlinkSync(join(root, path));
      expect(() => verifyCompatibilitySnapshot(root)).toThrow();
    });
  }

  for (const path of snapshotPaths.slice(0, 3)) {
    test(`requires the root manifest entry: ${path}`, () => {
      const { root, manifest, save } = compatibilitySnapshot();
      manifest.files = manifest.files.filter(row => row.path !== path);
      save();
      expect(() => verifyCompatibilitySnapshot(root)).toThrow("Missing required manifest entry");
    });
  }

  for (const path of ["src/untracked.ts", "src/generated/untracked.json"]) {
    test(`rejects an extra source file: ${path}`, () => {
      const { root } = compatibilitySnapshot();
      writeFileSync(join(root, path), "abc");
      expect(() => verifyCompatibilitySnapshot(root)).toThrow("Source file absent from compatibility manifest");
    });
  }

  test("rejects a source entry missing from the manifest while other sources remain", () => {
    const { root, manifest, save } = compatibilitySnapshot();
    writeFileSync(join(root, "src/second.ts"), "abc");
    manifest.files = manifest.files.filter(row => row.path !== "src/main.ts");
    manifest.files.push({ path: "src/second.ts", sha256: abcDigest });
    save();
    expect(() => verifyCompatibilitySnapshot(root)).toThrow("Source file absent from compatibility manifest");
  });

  test("rejects an empty source inventory", () => {
    const { root, manifest, save } = compatibilitySnapshot();
    manifest.files = manifest.files.filter(row => !row.path.startsWith("src/"));
    save();
    expect(() => verifyCompatibilitySnapshot(root)).toThrow("contains no source files");
  });

  test("rejects duplicate manifest entries", () => {
    const { root, manifest, save } = compatibilitySnapshot();
    manifest.files.push({ path: "src/main.ts", sha256: abcDigest });
    save();
    expect(() => verifyCompatibilitySnapshot(root)).toThrow("Duplicate compatibility manifest entry");
  });

  for (const path of ["../outside", "/src/main.ts", "src/../package.json", "src//main.ts", "src/./main.ts", "src\\main.ts", "src/", "src/zero\0.ts", "docker/bootstrap-token.ts", manifestPath]) {
    test(`rejects an unsafe or out-of-authority path: ${JSON.stringify(path)}`, () => {
      const { root, manifest, save } = compatibilitySnapshot();
      manifest.files.push({ path, sha256: abcDigest });
      save();
      expect(() => verifyCompatibilitySnapshot(root)).toThrow("Invalid compatibility manifest path");
    });
  }

  for (const raw of ["not json", "null", "{}", JSON.stringify({ schemaVersion: 1, files: [] })]) {
    test(`rejects a malformed manifest: ${raw}`, () => {
      const { root } = compatibilitySnapshot();
      writeFileSync(join(root, manifestPath), raw);
      expect(() => verifyCompatibilitySnapshot(root)).toThrow();
    });
  }

  test("rejects an invalid hash", () => {
    const { root, manifest, save } = compatibilitySnapshot();
    manifest.files[0]!.sha256 = "not-a-sha256";
    save();
    expect(() => verifyCompatibilitySnapshot(root)).toThrow("Invalid compatibility manifest entry");
  });

  test("rejects a missing manifest", () => {
    const { root } = compatibilitySnapshot();
    unlinkSync(join(root, manifestPath));
    expect(() => verifyCompatibilitySnapshot(root)).toThrow();
  });

  for (const path of ["package.json", manifestPath]) {
    test(`rejects a directory in place of a required file: ${path}`, () => {
      const { root } = compatibilitySnapshot();
      unlinkSync(join(root, path));
      mkdirSync(join(root, path));
      expect(() => verifyCompatibilitySnapshot(root)).toThrow("Non-regular compatibility input");
    });
  }

  for (const path of ["src", "src/generated", "scripts"]) {
    test(`rejects a linked input directory: ${path}`, () => {
      const { root } = compatibilitySnapshot();
      const target = join(root, "linked-target");
      renameSync(join(root, path), target);
      symlinkSync(target, join(root, path), process.platform === "win32" ? "junction" : "dir");
      expect(() => verifyCompatibilitySnapshot(root)).toThrow("Symlink");
    });
  }

  test("rejects an unlisted linked source directory before following it", () => {
    const { root } = compatibilitySnapshot();
    symlinkSync(join(root, "scripts"), join(root, "src/extra"), process.platform === "win32" ? "junction" : "dir");
    expect(() => verifyCompatibilitySnapshot(root)).toThrow("Symlink");
  });

  // File symlinks require Developer Mode/admin on Windows; junction cases above run everywhere.
  for (const path of [...snapshotPaths, manifestPath]) {
    test.skipIf(process.platform === "win32")(`rejects a linked file: ${path}`, () => {
      const { root } = compatibilitySnapshot();
      const target = join(root, "linked-target");
      renameSync(join(root, path), target);
      symlinkSync(target, join(root, path), "file");
      expect(() => verifyCompatibilitySnapshot(root)).toThrow("Symlink");
    });
  }
});
