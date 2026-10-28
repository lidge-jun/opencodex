import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { trustWindowsTempFixtureAncestry } from "./windows-temp-ancestry";
import { prepareRetentionFixture } from "./windows-cli-apply-retention-fixture";
import { createCodexCliUpdatePlan } from "../../src/codex/cli-update-plan";
import { applyCodexCliUpdate } from "../../src/codex/cli-update-apply";
import { createCodexCliWorkerCommitWindow } from "../../src/codex/cli-update-worker";
import { beginCodexCliSelectionParentWrite, codexCliUpdateSelectionGate, createCodexCliUpdateFence,
  allocateCodexCliUpdateGateOwner } from "../../src/codex/cli-update-selection-gate";
import { startWindowsCliChild } from "../../src/codex/windows-cli-child";
import { observeWindowsRecoveryFixture, windowsRecoveryFixtureIdentity } from "./windows-cli-recovery-state";

const [role, root] = process.argv.slice(2) as [string, string];
if (role && root) {
  trustWindowsTempFixtureAncestry(root);
  if (role === "probe") {
    const writer = beginCodexCliSelectionParentWrite();
    console.log(JSON.stringify({ entered: writer.entered, recovery: observeWindowsRecoveryFixture(root) })); writer.exit();
  } else if (role === "owner" || role === "owner-descendant") {
    const f = await prepareRetentionFixture(root);
    mkdirSync(f.configDir);
    const gate = codexCliUpdateSelectionGate(), fence = createCodexCliUpdateFence();
    const commitWindow = createCodexCliWorkerCommitWindow({ gate, fence,
      owner: allocateCodexCliUpdateGateOwner(gate), requestId: crypto.randomUUID() });
    const script = join(root, "native-child.js");
    writeFileSync(script, `const fs=require('node:fs'),p=require('node:path'),r=${JSON.stringify(root)};
      if(${role === "owner-descendant"} && process.argv[2]!=='descendant') {
        const {dlopen,ptr}=require('bun:ffi');
        const k=dlopen('kernel32.dll',{
          CreateProcessW:{args:['ptr','ptr','ptr','ptr','i32','u32','ptr','ptr','ptr','ptr'],returns:'i32'},
          CloseHandle:{args:['u64'],returns:'i32'},ExitProcess:{args:['u32'],returns:'void'}
        }).symbols;
        const wide=s=>Buffer.from(s+'\\0','utf16le');
        const exe=wide(process.execPath),command=wide(${JSON.stringify('"' + process.execPath + '" "' + script + '" descendant')});
        const startup=Buffer.alloc(104),info=Buffer.alloc(24);startup.writeUInt32LE(104);
        if(!k.CreateProcessW(ptr(exe),ptr(command),null,null,0,0x08000000,null,null,ptr(startup),ptr(info)))throw Error('fixture_descendant_spawn');
        k.CloseHandle(info.readBigUInt64LE());k.CloseHandle(info.readBigUInt64LE(8));k.ExitProcess(0);
      }
      fs.writeFileSync(p.join(r,'ready'),'ready');
      const timer=setInterval(()=>{if(fs.existsSync(p.join(r,'ping')))fs.writeFileSync(p.join(r,'pong'),'alive');
        if(fs.existsSync(p.join(r,'stop'))){clearInterval(timer);process.exit(0)}},5);`);
    const plan = await createCodexCliUpdatePlan(f.deps);
    if (!plan.applicable || !plan.planId) throw new Error("fixture_plan_refused");
    const result = await applyCodexCliUpdate(plan.planId, { ...f.deps, commitWindow,
      startWindowsChild(invocation) {
        if (invocation.policy !== "installer") throw new Error("unexpected_fixture_child");
        writeFileSync(join(root, "native-starting"), "starting");
        const child = startWindowsCliChild({ ...invocation, executable: process.execPath,
          args: [script], cwd: root, env: { SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root } });
        writeFileSync(join(root, "identity.json"), JSON.stringify(windowsRecoveryFixtureIdentity(child)));
        child.wait = async () => {
          const deadline = Date.now() + 15000;
          while (!existsSync(join(root, "ready"))) {
            if (Date.now() > deadline) throw new Error("native_child_not_ready");
            await Bun.sleep(5);
          }
          if (role === "owner-descendant") while (child.native.k.WaitForSingleObject(child.process, 0) !== 0) {
            if (Date.now() > deadline) throw new Error("primary_child_not_terminal");
            await Bun.sleep(5);
          }
          process.exit(0); // Deliberate owner death while its native installer Job lives.
        };
        return child;
      },
    });
    throw new Error("owner_did_not_exit_in_native_wait: " + JSON.stringify(result));
  }
}
