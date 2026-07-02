import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandUserPath, getConfigDir } from "../src/config";

const previousOpenCodexHome = process.env.OPENCODEX_HOME;

afterEach(() => {
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
});

describe("expandUserPath", () => {
  test("expands ~ and leading ~/ or ~\\ to the home directory", () => {
    expect(expandUserPath("~")).toBe(homedir());
    expect(expandUserPath("~/custom/dir")).toBe(join(homedir(), "custom/dir"));
    expect(expandUserPath("~\\custom\\dir")).toBe(join(homedir(), "custom\\dir"));
  });

  test("leaves ~user, absolute, relative, and %VAR%/$VAR paths untouched", () => {
    expect(expandUserPath("~other/dir")).toBe("~other/dir");
    expect(expandUserPath("/absolute/dir")).toBe("/absolute/dir");
    expect(expandUserPath("relative/dir")).toBe("relative/dir");
    expect(expandUserPath("%USERPROFILE%\\dir")).toBe("%USERPROFILE%\\dir");
    expect(expandUserPath("$HOME/dir")).toBe("$HOME/dir");
  });
});

describe("OPENCODEX_HOME tilde expansion", () => {
  test("getConfigDir honors OPENCODEX_HOME=~/...", () => {
    process.env.OPENCODEX_HOME = "~/.ocx-tilde-test";
    expect(getConfigDir()).toBe(join(homedir(), ".ocx-tilde-test"));
  });
});
