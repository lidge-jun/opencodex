import { expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  inspectServiceManagerInstallation,
  type ProbeRunner,
} from "../src/service-manager-probe";
import { removeTreeWithRetry } from "./helpers/remove-tree";

test("Linux reports systemd absent when systemctl cannot be spawned", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-probe-docker-"));
  const run: ProbeRunner = () => ({
    status: null,
    stdout: "",
    stderr: "spawn systemctl ENOENT",
    timedOut: false,
    spawnFailed: true,
  });

  try {
    expect(inspectServiceManagerInstallation({ run, platform: "linux", home })).toEqual({
      kind: "absent",
    });
  } finally {
    removeTreeWithRetry(home);
  }
});
