import { afterEach, describe, expect, test } from "bun:test";

import { assertLiveServiceManagerAllowed } from "../../src/service";

/**
 * The suite must not be able to stop the proxy the developer is running.
 *
 * HOME isolation, which the test preload already does, covers everything addressed by
 * path. It does not cover a service manager addressed by job name: `systemctl --user stop
 * opencodex-proxy.service` talks to the user manager that is already running, and
 * `launchctl bootout gui/<uid>/com.opencodex.proxy` talks to launchd, and neither of them
 * consults HOME. Windows has refused this since a partially-faked test replaced a real
 * scheduled task; macOS and Linux did not, so the person running opencodex on the machine
 * they develop it on was the one exposed.
 */
const GUARD_ENV = "OCX_TEST_HOME_GUARD";
const original = process.env[GUARD_ENV];

afterEach(() => {
  if (original === undefined) delete process.env[GUARD_ENV];
  else process.env[GUARD_ENV] = original;
});

describe("live service-manager guard", () => {
  test("refuses every mutating launchctl and systemctl call while armed", () => {
    process.env[GUARD_ENV] = "1";
    const mutations = [
      "launchctl unload /tmp/LaunchAgents/com.opencodex.proxy.plist",
      "launchctl load -w /tmp/LaunchAgents/com.opencodex.proxy.plist",
      "launchctl bootout gui/501/com.opencodex.proxy",
      "launchctl kickstart -k gui/501/com.opencodex.proxy",
      "systemctl --user stop opencodex-proxy.service",
      "systemctl --user restart opencodex-proxy.service",
      "systemctl --user disable opencodex-proxy.service",
      "systemctl --user enable opencodex-proxy.service",
      "systemctl --user daemon-reload",
    ];
    for (const command of mutations) {
      expect(() => assertLiveServiceManagerAllowed(command)).toThrow(/armed test process/);
    }
  });

  test("still allows observation, which is what the diagnostics need", () => {
    process.env[GUARD_ENV] = "1";
    const observations = [
      "launchctl list",
      "launchctl list | grep com.opencodex.proxy || true",
      "launchctl print gui/501/com.opencodex.proxy",
      "systemctl --version",
      "systemctl --user show -p NeedDaemonReload opencodex-proxy.service",
      "systemctl --user is-active opencodex-proxy.service",
      "systemctl --user is-enabled opencodex-proxy.service",
      "systemctl --user status opencodex-proxy.service",
      "systemctl --user show-environment",
    ];
    for (const command of observations) {
      expect(() => assertLiveServiceManagerAllowed(command)).not.toThrow();
    }
  });

  test("leaves unrelated commands alone", () => {
    process.env[GUARD_ENV] = "1";
    expect(() => assertLiveServiceManagerAllowed("git status")).not.toThrow();
    expect(() => assertLiveServiceManagerAllowed("sw_vers -productVersion")).not.toThrow();
  });

  test("is inert in production, where the guard is not armed", () => {
    delete process.env[GUARD_ENV];
    expect(() =>
      assertLiveServiceManagerAllowed("systemctl --user stop opencodex-proxy.service"),
    ).not.toThrow();
  });
});
