import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveGuiFile } from "../src/server/gui-static";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("#2792 snapshots a static asset before server framing can outlive the file", async () => {
  const guiDist = mkdtempSync(join(tmpdir(), "ocx-gui-static-"));
  temporaryDirectories.push(guiDist);
  writeFileSync(join(guiDist, "index.html"), "<!doctype html>");
  const assetPath = join(guiDist, "index.js");
  const originalAsset = "console.log('complete dashboard asset');";
  writeFileSync(assetPath, originalAsset);

  const response = serveGuiFile("/index.js", guiDist);
  expect(response).not.toBeNull();

  // A package update may replace gui/dist after the response is constructed. The response
  // body must retain the same byte snapshot the HTTP server uses for Content-Length.
  writeFileSync(assetPath, "truncated");
  expect(await response!.text()).toBe(originalAsset);
});
