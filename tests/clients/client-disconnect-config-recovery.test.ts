import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function scenario(mode: string, windows = false) {
  const root = mkdtempSync(join(tmpdir(), "ocx-disconnect-recover-"));
  const ocx = join(root, "ocx"), codex = join(root, "codex");
  mkdirSync(ocx); mkdirSync(codex);
  const eol = windows ? "\r\n" : "\n";
  const edits = ['model = "user/model"', '[hooks]', 'notify = ["user-hook"]',
    windows ? "[projects.'C:\\work\\project']" : "[projects.'/work/project']", 'trust_level = "trusted"',
    '[mcp_servers.computer_use]', windows ? "command = 'C:\\tools\\computer-use.exe'" : 'command = "/opt/computer-use"'].join(eol) + eol;
  const marker = ["legacy-unmarked", "legacy-recorded", "edited-unmarked"].includes(mode) ? "" : "# Auto-injected by opencodex" + eol;
  const current = marker + 'openai_base_url = "https://edited.example/v1"' + eol + edits;
  writeFileSync(join(codex, "config.toml"), current);
  const script = `
    const {readFileSync,writeFileSync,existsSync,readdirSync,statSync} = require("node:fs");
    const {createHash} = require("node:crypto");
    const {handleDisconnectCommand} = require("./src/cli/connect");
    const {readClientConnectionState} = require("./src/client/state");
    const {readDesktopDisconnectReceipt} = require("./src/claude/desktop-remote-store");
    const {tryAcquire,release} = require("./src/codex/prompt-lock");
    const c=process.env.CODEX_HOME,h=process.env.OPENCODEX_HOME;
    const mode=${JSON.stringify(mode)}, current=${JSON.stringify(current)};
    const hash=v=>createHash("sha256").update(v).digest("hex");
    const token="fixture-recovery-key",catalog='{"models":[]}';
    const connection={serverUrl:"https://home.example.test",managementUrl:"https://home.example.test",managementTransport:"direct",
      selectedClients:["codex"],tokenEnv:"OPENCODEX_API_AUTH_TOKEN",apiKeyId:"client-1",tokenFingerprint:hash(token),
      protocolVersion:1,connectedAt:"2026-11-07T00:00:00.000Z",catalogFingerprint:createHash("sha256").update(catalog).digest("base64url"),catalogSyncedAt:"2026-11-07T00:00:00.000Z"};
    writeFileSync(h+"/config.json",JSON.stringify({port:10100,providers:{},defaultProvider:"openai",runtimeRole:"client",client:connection}));
    writeFileSync(h+"/service-api-token",token,{mode:0o600});
    writeFileSync(c+"/opencodex-catalog.json",catalog);
    const legacy=mode.startsWith("legacy");
    const journal={version:1,originalConfig:Buffer.from('model = "before"\\n').toString("base64"),originalProfile:null,
      ...(legacy?{}:{injectedConfigHash:hash('openai_base_url = "http://127.0.0.1:10100/v1"\\nmodel = "before"\\n'),
        injectedProfileHash:mode==="profile-known"?hash('model_provider = "opencodex"\\n'):null,injectedOpenaiBaseUrl:"http://127.0.0.1:10100/v1"}),
      ...(mode==="legacy-recorded"?{injectedOpenaiBaseUrl:"http://127.0.0.1:10100/v1"}:{}),
      owner:mode==="wrong-process"?{kind:"process",pid:process.pid}:{kind:"client",apiKeyId:mode==="wrong-owner"?"other-client":"client-1"},pid:process.pid,timestamp:"2026-11-07T00:00:00.000Z"};
    writeFileSync(c+"/opencodex-journal.json",JSON.stringify(journal));
    if(mode==="profile-unknown") writeFileSync(c+"/opencodex.config.toml",'model = "private-profile-edit"\\n');
    if(mode==="profile-known") writeFileSync(c+"/opencodex.config.toml",'model_provider = "opencodex"\\n');
    const deps={lifecycleLockDeps:{lockPath:h+"/lifecycle.sqlite"},linkTeardownDeps:{reapOrphanTunnel:()=>{throw new Error("teardown ran before confirmation")}}};
    const first=await handleDisconnectCommand(mode==="confirmation"?["--recover-config"]:[],deps);
    const receiptAfterFirst=readDesktopDisconnectReceipt().kind;
    const beforeRecovery=readFileSync(c+"/config.toml","utf8");
    if(mode==="journal-race" || mode==="connection-race") {
      const section=require("./src/codex/inject/config-write-section");
      const begin=section.beginCodexWriteSection;
      require("bun:test").spyOn(section,"beginCodexWriteSection").mockImplementation(held=>{
        begin(held);
        if(mode==="journal-race") {
          const changed=JSON.parse(readFileSync(c+"/opencodex-journal.json","utf8"));
          changed.owner={kind:"client",apiKeyId:"changed-under-lock"};
          writeFileSync(c+"/opencodex-journal.json",JSON.stringify(changed));
        } else {
          const changed=JSON.parse(readFileSync(h+"/config.json","utf8"));
          changed.client.apiKeyId="changed-under-lock";
          writeFileSync(h+"/config.json",JSON.stringify(changed));
        }
      });
    }
    const recover=()=>handleDisconnectCommand(["--recover-config","--yes","--json"],{lifecycleLockDeps:deps.lifecycleLockDeps});
    let second=null;
    if(mode==="locked") {
      const held=tryAcquire(c+"/config.toml.ocx-write.lock");
      if(!held.ok) throw new Error("fixture lock failed");
      try {second=await recover();} finally {release(held.handle);}
    } else if(mode!=="confirmation") second=await recover();
    const after=readFileSync(c+"/config.toml","utf8");
    const backups=readdirSync(c).filter(n=>n.startsWith(".ocx-disconnect-recovery-"));
    const backup=backups.length?JSON.parse(readFileSync(c+"/"+backups[0]+"/snapshot.json","utf8")):null;
    const backupModes=backups.length?[statSync(c+"/"+backups[0]).mode&0o777,statSync(c+"/"+backups[0]+"/snapshot.json").mode&0o777]:null;
    const repeat=second===0?await handleDisconnectCommand(["--recover-config","--yes","--json"],{lifecycleLockDeps:deps.lifecycleLockDeps}):null;
    console.log("RESULT:"+JSON.stringify({first,second,repeat,receiptAfterFirst,beforeRecovery,after,backups,backup,backupModes,
      token:existsSync(h+"/service-api-token"),journal:existsSync(c+"/opencodex-journal.json"),state:readClientConnectionState().kind,
      profile:existsSync(c+"/opencodex.config.toml")?readFileSync(c+"/opencodex.config.toml","utf8"):null}));
  `;
  try {
    const result = spawnSync(process.execPath, ["--eval", script], {cwd: repoRoot(), encoding: "utf8", timeout: 30_000,
      env: {...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: ocx, CODEX_HOME: codex, CODEX_SQLITE_HOME: codex}});
    expect(result.status, result.stderr).toBe(0);
    const line = result.stdout.split("\n").find(line => line.startsWith("RESULT:"));
    expect(line, result.stdout + result.stderr).toBeDefined();
    return {...JSON.parse(line!.slice(7)), stderr: result.stderr, current, edits};
  } finally { removeTreeWithRetry(root); }
}

test("recovery requires --yes before any teardown or receipt", () => {
  const r = scenario("confirmation");
  expect(r.first).toBe(2);
  expect(r.stderr).toContain("--recover-config requires --yes");
  expect(r.stderr).not.toContain("teardown ran");
  expect(r.after).toBe(r.current);
  expect(r.backups).toHaveLength(0);
  expect(r.token).toBe(true);
  expect(r.receiptAfterFirst).toBe("absent");
});

test.each([false, true])("explicit recovery resolves edited owned URL and preserves edits (CRLF: %s)", windows => {
  const r = scenario("edited", windows);
  expect(r.first).not.toBe(0);
  expect(r.beforeRecovery).toBe(r.current);
  expect(r.second, r.stderr).toBe(0);
  expect(r.repeat, r.stderr).toBe(0);
  expect(r.after).toBe(r.edits);
  expect(r.backups).toHaveLength(1);
  expect(r.backup.config).toBe(r.current);
  expect(r.backup.profile).toBeNull();
  expect(r.backup.journal.owner).toEqual({kind: "client", apiKeyId: "client-1"});
  if (process.platform !== "win32") expect(r.backupModes).toEqual([0o700, 0o600]);
  expect(r.state).toBe("disconnected");
  expect(r.token).toBe(false);
  expect(r.journal).toBe(false);
});

test("hashless legacy journal uses exact structural marker plus matching client owner", () => {
  const r = scenario("legacy-marked");
  expect(r.first).not.toBe(0);
  expect(r.second, r.stderr).toBe(0);
  expect(r.after).toBe(r.edits);
  expect(r.backup.config).toBe(r.current);
  expect(r.backup.journal.injectedConfigHash).toBeUndefined();
});

test.each(["edited-unmarked", "legacy-recorded"])("recorded field evidence survives marker removal: %s", mode => {
  const r = scenario(mode);
  expect(r.first).not.toBe(0);
  expect(r.second, r.stderr).toBe(0);
  expect(r.after).toBe(r.edits);
  expect(r.backup.config).toBe(r.current);
});

test("known unchanged generated profile is backed up before its removal", () => {
  const r = scenario("profile-known");
  expect(r.second, r.stderr).toBe(0);
  expect(r.backup.profile).toBe('model_provider = "opencodex"\n');
  expect(r.profile).toBeNull();
  expect(r.after).toBe(r.edits);
});

test.each(["legacy-unmarked", "wrong-owner", "wrong-process", "profile-unknown", "locked", "journal-race", "connection-race"])("recovery refuses insufficient ownership or unavailable lock: %s", mode => {
  const r = scenario(mode);
  expect(r.second).not.toBe(0);
  expect(r.after).toBe(r.current);
  expect(r.state).toBe("connected");
  expect(r.token).toBe(true);
  expect(r.journal).toBe(true);
  expect(r.backups).toHaveLength(0);
  if (mode === "profile-unknown") expect(r.profile).toBe('model = "private-profile-edit"\n');
});
