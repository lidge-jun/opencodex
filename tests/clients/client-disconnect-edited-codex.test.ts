import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function scenario(windows: boolean, conflict = false, hashless = false) {
  const root = mkdtempSync(join(tmpdir(), "ocx-disconnect-edits-"));
  const ocx = join(root, "ocx"), codex = join(root, "codex");
  mkdirSync(ocx); mkdirSync(codex);
  const eol = windows ? "\r\n" : "\n";
  const edits = [
    'model = "user-provider/new-model"',
    '[hooks]', 'notify = ["user-hook"]',
    windows ? '[projects.\'C:\\work\\project\']' : '[projects.\'/work/project\']',
    'trust_level = "trusted"', '[mcp_servers.computer_use]',
    windows ? "command = 'C:\\tools\\computer-use.exe'" : 'command = "/opt/tools/computer-use"',
  ].join(eol) + eol;
  const url = "http://127.0.0.1:10100/v1";
  const injected = `openai_base_url = "${url}"${eol}experimental_realtime_ws_base_url = "${url}"${eol}model_catalog_json = ${JSON.stringify(join(codex, "opencodex-catalog.json"))}${eol}model = "old-model"${eol}`;
  writeFileSync(join(codex, "config.toml"), injected.replace('model = "old-model"' + eol, "") .replace(url, conflict ? "https://user.example/v1" : url) + edits);
  const script = `
    const { readFileSync, writeFileSync, existsSync } = require("node:fs");
    const { createHash } = require("node:crypto");
    const { disconnectClient } = require("./src/client/connect");
    const { readClientConnectionState } = require("./src/client/state");
    const { writeJournal, markJournalInjectedState } = require("./src/codex/journal");
    const c = process.env.CODEX_HOME, h = process.env.OPENCODEX_HOME;
    const hash = value => createHash("sha256").update(value).digest("hex");
    const token = "fixture-disconnect-key", catalog = '{"models":[]}';
    const config = {port:10100,providers:{},defaultProvider:"openai",runtimeRole:"client",client:{
      serverUrl:"https://home.example.test",managementUrl:"https://home.example.test",managementTransport:"direct",
      selectedClients:["codex"],tokenEnv:"OPENCODEX_API_AUTH_TOKEN",apiKeyId:"client-1",tokenFingerprint:hash(token),
      protocolVersion:1,connectedAt:"2026-11-07T00:00:00.000Z",
      catalogFingerprint:createHash("sha256").update(catalog).digest("base64url"),catalogSyncedAt:"2026-11-07T00:00:00.000Z"}};
    writeFileSync(h+"/config.json", JSON.stringify(config));
    writeFileSync(h+"/service-api-token",token,{mode:0o600});
    writeFileSync(c+"/opencodex-catalog.json",catalog);
    const journal = {version:1,originalConfig:Buffer.from('model = "old-model"\\n').toString("base64"),originalProfile:null,
      ${hashless ? "" : "injectedConfigHash:hash(" + JSON.stringify(injected) + "),injectedProfileHash:null,"}
      injectedOpenaiBaseUrl:${JSON.stringify(url)},injectedRealtimeWsBaseUrl:${JSON.stringify(url)},
      injectedCatalogPath:c+"/opencodex-catalog.json",owner:{kind:"client",apiKeyId:"client-1"},pid:999999,timestamp:"2026-11-07T00:00:00.000Z"};
    writeFileSync(c+"/opencodex-journal.json", JSON.stringify(journal));
    let result, error;
    try { result = await disconnectClient({}, {lifecycleLockDeps:{lockPath:h+"/lifecycle.sqlite"}}); }
    catch(e) { error=e.message; }
    const after = readFileSync(c+"/config.toml","utf8");
    const retained = existsSync(c+"/opencodex-journal.json");
    let relinkBaseline;
    if (result) {
      // The next injection must journal the user's edited standalone file, not the old baseline.
      writeJournal({currentStateIsNative:true,owner:{kind:"client",apiKeyId:"client-2"}});
      relinkBaseline = Buffer.from(JSON.parse(readFileSync(c+"/opencodex-journal.json","utf8")).originalConfig,"base64").toString("utf8");
      markJournalInjectedState(after,null,{injectedOpenaiBaseUrl:null,injectedRealtimeWsBaseUrl:null,injectedCatalogPath:null});
    }
    console.log(JSON.stringify({result,error,after,retained,relinkBaseline,state:readClientConnectionState().kind,token:existsSync(h+"/service-api-token")}));
  `;
  try {
    const child = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot(), encoding: "utf8", timeout: 30_000,
      env: { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: ocx, CODEX_HOME: codex, CODEX_SQLITE_HOME: codex },
    });
    expect(child.status, child.stderr).toBe(0);
    return { ...JSON.parse(child.stdout.trim()), edits };
  } finally { removeTreeWithRetry(root); }
}

test.each([false, true])("disconnect preserves post-injection edits and relink baseline (Windows text: %s)", windows => {
  const result = scenario(windows);
  expect(result.error).toBeUndefined();
  expect(result.result.restored).toBe(true);
  expect(result.after).toBe(result.edits);
  expect(result.relinkBaseline).toBe(result.edits);
  expect(result.retained).toBe(false);
  expect(result.state).toBe("disconnected");
  expect(result.token).toBe(false);
});

test("a changed owned URL refuses without clearing the credential or journal", () => {
  const result = scenario(false, true);
  expect(result.error).toContain("ocx disconnect");
  expect(result.after).toContain('openai_base_url = "https://user.example/v1"');
  expect(result.retained).toBe(true);
  expect(result.state).toBe("connected");
  expect(result.token).toBe(true);
});

test("a changed hashless journal remains unverified", () => {
  const result = scenario(false, false, true);
  expect(result.error).toBeDefined();
  expect(result.after).toContain("openai_base_url");
  expect(result.retained).toBe(true);
  expect(result.state).toBe("connected");
  expect(result.token).toBe(true);
});
