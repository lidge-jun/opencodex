import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function scenario(dropSnapshot = false) {
  const root = mkdtempSync(join(tmpdir(), "ocx-disconnect-field-snapshot-"));
  const ocx = join(root, "ocx"), codex = join(root, "codex");
  mkdirSync(ocx); mkdirSync(codex);
  writeFileSync(join(codex, "config.toml"), 'model = "native-model"\n');
  writeFileSync(join(ocx, "config.json"), JSON.stringify({ port: 10100, providers: {}, defaultProvider: "openai" }));
  const script = `
    const { readFileSync, writeFileSync, existsSync } = require("node:fs");
    const { createHash } = require("node:crypto");
    const { connectClient, disconnectClient } = require("./src/client/connect");
    const c = process.env.CODEX_HOME, h = process.env.OPENCODEX_HOME;
    const catalog = '{"models":[]}';
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith("/readyz")) return Response.json({service:"opencodex",version:"0.0.0",uptime:1,pid:1,
        port:443,status:"ready",protocol:1,minimumClientProtocol:1,managementUrl:"https://manage.example.test"});
      if (url.endsWith("/api/keys") && init.method === "POST") return Response.json({id:"snapshot-client",name:"fixture",
        key:"ocx_data_"+"d".repeat(40),createdAt:"2026-11-07T00:00:00.000Z"},{status:201});
      if (url.endsWith("/v1/catalog")) return new Response(catalog,{headers:{"Content-Type":"application/json",
        ETag:'"sha256-'+createHash("sha256").update(catalog).digest("base64url")+'"'}});
      throw new Error("unexpected fixture request "+url);
    };
    await connectClient({serverUrl:"https://hub.example.test",managementTransport:"direct",selectedClients:["codex"],
      credential:{kind:"admin",value:new TextEncoder().encode("ocx_admin_fixture-authority")}},
      {fetchImpl,catalogCompatibility:{supportedEfforts:()=>new Set()},lifecycleLockDeps:{lockPath:h+"/lifecycle.sqlite"}});
    const journalPath=c+"/opencodex-journal.json";
    const journal=JSON.parse(readFileSync(journalPath,"utf8"));
    const fields=journal.injectedConfigFields;
    const injected=readFileSync(c+"/config.toml","utf8");
    const user='[hooks]\\nnotify = ["fixture-user-hook"]\\n';
    const edited=injected.replace(/^model\\s*=.*$/m,'model = "user-edited-model"')+user;
    writeFileSync(c+"/config.toml",edited);
    if (${dropSnapshot}) { delete journal.injectedConfigFields; writeFileSync(journalPath,JSON.stringify(journal)); }
    let result,error;
    try { result=await disconnectClient({}, {lifecycleLockDeps:{lockPath:h+"/lifecycle.sqlite"}}); }
    catch(e) {error=e.message;}
    const after=readFileSync(c+"/config.toml","utf8");
    console.log(JSON.stringify({fields,injected,edited,after,parsed:Bun.TOML.parse(after),result,error,
      retained:existsSync(journalPath),token:existsSync(h+"/service-api-token")}));
  `;
  try {
    const child = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot(), encoding: "utf8", timeout: 30_000,
      env: { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: ocx, CODEX_HOME: codex, CODEX_SQLITE_HOME: codex },
    });
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout.trim());
  } finally { removeTreeWithRetry(root); }
}

test("real Codex connect persists field snapshots used to disconnect after user edits", () => {
  const result = scenario();
  expect(result.fields.model_provider).toContain('"opencodex"');
  expect(result.fields["model_providers.opencodex"]).toContain("base_url");
  expect(result.error).toBeUndefined();
  expect(result.result.restored).toBe(true);
  expect(result.parsed.model).toBe("user-edited-model");
  expect(result.parsed.hooks.notify).toEqual(["fixture-user-hook"]);
  expect(result.parsed.model_provider).toBeUndefined();
  expect(result.parsed.model_providers?.opencodex).toBeUndefined();
  expect(result.retained).toBe(false);
  expect(result.token).toBe(false);
});

test("the same edited provider-table disconnect requires the persisted field snapshot", () => {
  const result = scenario(true);
  expect(result.error).toBeDefined();
  expect(result.after).toBe(result.edited);
  expect(result.retained).toBe(true);
  expect(result.token).toBe(true);
});
