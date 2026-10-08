use serde_json::Value;
use std::{env, fs, path::PathBuf, process::Command};

#[test]
fn aborted_unread_responses_release_owned_budgets_before_cancel_settles() {
    let result = contract(
        "aborted-unread-budget",
        r#"
const budgets=await import(pathToFileURL(join(process.env.CONTRACT_REPO,'src/lib/translator-budget.ts')).href);
const lifetime=await import(pathToFileURL(join(process.env.CONTRACT_REPO,'src/server/responses/core-lifetime.ts')).href);
const answers=[];
for (const kind of ['responses','shared']) for (const mode of ['before','after','cancel']) {
 const controller=new AbortController(); if(mode==='before')controller.abort('synthetic-client-gone');
 const baseline=budgets.translatorLiveBudgetCountForTests();
 const aggregateBaseline=budgets.translatorObservedBufferSnapshot();
 const budget=budgets.createTranslatorBudget();
 budget.openCall('reserved-before-abort');
 const reservedBeforeAbort=budget.reserveTransient(512,{kind:'retained_collectors',callId:'reserved-before-abort'});
 let release, calls=0;
 const hold=new Promise(resolve=>{release=resolve});
 const original=new Response(new ReadableStream({cancel(){calls++; return hold}}));
 const wrap=kind==='responses'?lifetime.finalizeOwnedTranslatorBudget:budgets.finalizeTranslatorBudgetResponse;
 const wrapped=wrap(original,budget,controller.signal);
 if(mode!=='before' && budgets.translatorLiveBudgetCountForTests()!==baseline+1)throw Error('live response released before stream death');
 let cancel;
 if(mode==='after')controller.abort('synthetic-client-gone');
 if(mode==='cancel')cancel=wrapped.body.cancel('synthetic-client-gone');
 await Bun.sleep(20);
 const whileHeld=budgets.translatorLiveBudgetCountForTests()-baseline;
 const beforeReleaseCalls=calls;
 budget.openCall('late-after-abort');
 budget.chargeRetained(1024,{kind:'retained_collectors'});
 const late=budget.reserveTransient(2048,{kind:'retained_collectors'}); late.commitRetained(); late.release();
 reservedBeforeAbort.commitRetained(); reservedBeforeAbort.release();
 const observed=budget.observeAcceptedRequestCopy(4096); observed();
 const afterLate=budget.snapshot();
 const aggregate=budgets.translatorObservedBufferSnapshot();
 const aggregateDelta={bytes:budgets.translatorAggregateCurrentBytesForTests()-aggregateBaseline.currentBytes,active:aggregate.active-aggregateBaseline.active};
 cancel??=wrapped.body.cancel('fixture-cleanup');
 release(); await cancel;
 answers.push({kind,mode,whileHeld,beforeReleaseCalls,afterReleaseCalls:calls,afterLate,aggregateDelta,remaining:budgets.translatorLiveBudgetCountForTests()-baseline});
}
const baseline=budgets.translatorLiveBudgetCountForTests();
const budget=budgets.createTranslatorBudget();
const source=new Response('synthetic-eof',{status:201,headers:{'x-fixture':'kept'}});
const eof=lifetime.finalizeOwnedTranslatorBudget(source,budget,new AbortController().signal);
const eofResult={text:await eof.text(),status:eof.status,header:eof.headers.get('x-fixture'),remaining:budgets.translatorLiveBudgetCountForTests()-baseline};
const preparedResponses=[];
for(const wrap of [lifetime.finalizeOwnedTranslatorBudget,budgets.finalizeTranslatorBudgetResponse])for(const status of [200,499,504]){
 const controller=new AbortController(); controller.abort(new Error('synthetic-client-gone'));
 const budget=budgets.createTranslatorBudget(); budget.observeAcceptedRequestCopy(1024);
 const source=new Response('synthetic-final-'+status,{status,headers:{'x-fixture':'kept','content-type':status===504?'text/event-stream':'application/json'}});
 const response=wrap(source,budget,controller.signal);
 preparedResponses.push({status:response.status,header:response.headers.get('x-fixture'),remaining:budgets.translatorLiveBudgetCountForTests()-baseline,bytes:budget.snapshot().currentBytes,text:await response.text()});
}
return {answers,eof:eofResult,preparedResponses};
"#,
    );
    for answer in result["answers"].as_array().unwrap() {
        assert_eq!(
            answer["whileHeld"], 0,
            "aborted unread body retained its budget"
        );
        assert_eq!(
            answer["beforeReleaseCalls"],
            u64::from(answer["mode"] == "cancel")
        );
        assert_eq!(answer["afterReleaseCalls"], 1);
        assert_eq!(answer["remaining"], 0);
        assert_eq!(answer["afterLate"]["currentBytes"], 0);
        assert_eq!(answer["afterLate"]["activeCalls"], 0);
        assert_eq!(answer["aggregateDelta"]["bytes"], 0);
        assert_eq!(answer["aggregateDelta"]["active"], 0);
    }
    assert_eq!(result["eof"]["text"], "synthetic-eof");
    assert_eq!(result["eof"]["status"], 201);
    assert_eq!(result["eof"]["header"], "kept");
    assert_eq!(result["eof"]["remaining"], 0);
    for response in result["preparedResponses"].as_array().unwrap() {
        assert_eq!(response["header"], "kept");
        assert_eq!(response["remaining"], 0);
        assert_eq!(response["bytes"], 0);
        assert_eq!(
            response["text"],
            format!("synthetic-final-{}", response["status"])
        );
    }
}

#[test]
fn removal_barrier_matches_canonical_directory_aliases() {
    let result = contract(
        "acl-path-alias",
        r#"
const acl=await import(pathToFileURL(join(process.env.CONTRACT_REPO,'src/lib/windows-secret-acl.ts')).href);
const principal=await import(pathToFileURL(join(process.env.CONTRACT_REPO,'src/lib/windows-user-principal.ts')).href);
const target=join(root,'..physical'); const alias=join(root,'alias'); fs.mkdirSync(target);
fs.symlinkSync(target,alias,process.platform==='win32'?'junction':'dir');
const heldFile=join(target,'held.tmp'); fs.writeFileSync(heldFile,'owned-fixture');
const unrelated=join(root,'unrelated'); fs.mkdirSync(unrelated);
let release, announce;const held=new Promise(resolve=>{release=resolve});const started=new Promise(resolve=>{announce=resolve});
acl.setPlatformForTests('win32');
principal.setAsyncWindowsPrincipalRunnerForTests(async()=>({success:true,exitCode:0,timedOut:false,stdout:'S-1-5-21-1-2-3-1001\nTEST\\user\n'}));
acl.setAsyncIcaclsBeltSchedulerForTests(()=>()=>{});
acl.setAsyncIcaclsRunnerForTests(async()=>{announce();await held;return {success:true,exitCode:0,timedOut:false,stdout:''}});
try {
 const harden=acl.hardenSecretPathAsync(heldFile,{required:true,deadlineMs:5000}).then(()=>true,()=>false);await started;
 const guarded=acl.windowsSecretAclReapPendingAtOrBelow(alias);
 const rootGuard=acl.windowsSecretAclReapPendingAtOrBelow(root);
 const unrelatedGuard=acl.windowsSecretAclReapPendingAtOrBelow(unrelated);
 const nativeRealpath=fs.realpathSync.native;let unreadableGuard;
 try{fs.realpathSync.native=()=>{throw Object.assign(new Error('injected identity read'),{code:'EACCES'})};unreadableGuard=acl.windowsSecretAclReapPendingAtOrBelow(unrelated)}
 finally{fs.realpathSync.native=nativeRealpath}
 fs.unlinkSync(heldFile);const deletedGuard=acl.windowsSecretAclReapPendingAtOrBelow(alias);
 let settled=false;const barrier=acl.flushWindowsSecretAclReapsBeforeRemoval(alias).then(()=>{settled=true});
 await Bun.sleep(20);const early=settled;release();await Promise.all([harden,barrier]);
 return {guarded,rootGuard,unrelatedGuard,unreadableGuard,deletedGuard,early,remaining:acl.windowsSecretAclReapPendingAtOrBelow(alias)};
}finally{release();await acl.flushWindowsSecretAclReapsBeforeRemoval(target);fs.unlinkSync(alias)}
"#,
    );
    assert_eq!(result["guarded"], true);
    assert_eq!(result["rootGuard"], true);
    assert_eq!(result["unrelatedGuard"], false);
    assert_eq!(result["unreadableGuard"], true);
    assert_eq!(result["deletedGuard"], true);
    assert_eq!(result["early"], false);
    assert_eq!(result["remaining"], false);
}

#[test]
fn removal_barrier_waits_for_a_normal_acl_runner_before_its_belt_fires() {
    let result = contract(
        "normal-acl-runner",
        r#"
const acl=await import(pathToFileURL(join(process.env.CONTRACT_REPO,'src/lib/windows-secret-acl.ts')).href);
const principal=await import(pathToFileURL(join(process.env.CONTRACT_REPO,'src/lib/windows-user-principal.ts')).href);
const target=join(root,'normal-acl-child'); fs.mkdirSync(target);
let release, releaseSecond, announce, announceSecond, calls=0;
const held=new Promise(resolve=>{release=resolve});
const started=new Promise(resolve=>{announce=resolve});
const secondHeld=new Promise(resolve=>{releaseSecond=resolve});
const secondStarted=new Promise(resolve=>{announceSecond=resolve});
acl.setPlatformForTests('win32');
principal.setAsyncWindowsPrincipalRunnerForTests(async()=>({success:true,exitCode:0,timedOut:false,stdout:'S-1-5-21-1-2-3-1001\nTEST\\user\n'}));
acl.setAsyncIcaclsBeltSchedulerForTests(()=>()=>{});
acl.setAsyncIcaclsRunnerForTests(async()=>{
 calls++;
 if(calls===1){announce(); await held}
 if(calls===2){announceSecond(); await secondHeld}
 return {success:true,exitCode:0,timedOut:false,stdout:''};
});
try {
 const harden=acl.hardenSecretDirAsync(target,{required:true,deadlineMs:5000});
 await started;
 const timedOutOnly=acl.windowsSecretAclReapPendingForPath(target);
 const activeGuard=acl.windowsSecretAclReapPendingAtOrBelow(root);
 let settled=false;
 const barrier=acl.flushWindowsSecretAclReapsBeforeRemoval(root).then(()=>{settled=true});
 await Bun.sleep(20);
 const early=settled;
 release(); await secondStarted; await Bun.sleep(20);
 const middle=settled;
 releaseSecond(); const [outcome]=await Promise.all([harden,barrier]);
 const beforeMemo=calls;
 const memo=acl.hardenSecretDirAsync(target,{required:true,deadlineMs:5000});
 const memoBusy=acl.windowsSecretAclReapPendingAtOrBelow(root);
 await memo;
 return {early,middle,timedOutOnly,activeGuard,calls,ok:outcome.ok,memoBusy,memoProbes:calls-beforeMemo,remaining:acl.windowsSecretAclReapPendingAtOrBelow(root)};
} finally { release(); releaseSecond(); await acl.flushWindowsSecretAclReapsBeforeRemoval(root); }
"#,
    );
    assert!(result["calls"].as_u64().unwrap() >= 3);
    assert_eq!(
        result["early"], false,
        "removal overtook a live normal runner"
    );
    assert_eq!(
        result["middle"], false,
        "removal overtook the next ACL command"
    );
    assert_eq!(result["timedOutOnly"], false);
    assert_eq!(result["activeGuard"], true);
    assert_eq!(result["ok"], true);
    assert_eq!(result["memoBusy"], false);
    assert_eq!(result["memoProbes"], 0);
    assert_eq!(result["remaining"], false);
}

struct OwnedRoot(PathBuf);
impl Drop for OwnedRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn hidden(command: Command) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = command;
        command.creation_flags(0x08000000);
        command
    }
    #[cfg(not(windows))]
    command
}

fn bun_binary() -> PathBuf {
    let candidate = env::var_os("OCX_CATALOG_TEST_BUN").unwrap_or_else(|| "bun".into());
    let output = hidden(Command::new(candidate))
        .args(["--no-env-file", "--print", "process.execPath"])
        .output()
        .expect("Bun must be installed for the catalog contracts");
    assert!(output.status.success(), "Bun path discovery failed");
    let path = PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
    assert!(
        path.is_absolute(),
        "Bun must resolve to an absolute executable"
    );
    path
}

// Rust owns the fixture/environment and assertions. These expressions invoke the existing
// Bun modules and their owner test seams; they are not an alternative catalog implementation.
fn contract(name: &str, expression: &str) -> Value {
    let bun = bun_binary();
    let repo = env::var_os("OCX_CATALOG_TEST_REPO")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(3)
                .unwrap()
                .to_path_buf()
        });
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = (0..32)
        .find_map(|attempt| {
            let path = env::temp_dir().join(format!(
                "ocx-catalog-contract-{}-{name}-{stamp}-{attempt}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => Some(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => panic!("cannot create owned fixture: {error}"),
            }
        })
        .expect("unique fixture root");
    let _owned = OwnedRoot(root.clone());
    let result = {
        let exe = root.join(if cfg!(windows) {
            "probe-env.exe"
        } else {
            "probe-env"
        });
        fs::copy(env!("CARGO_BIN_EXE_ocx-catalog-fixture"), &exe).unwrap();
        let mut search = vec![root.clone()];
        if let Some(system) = env::var_os("SystemRoot") {
            search.push(PathBuf::from(system).join("System32"));
        }
        let path = env::join_paths(search).unwrap();
        let script = format!(
            r#"
const fs = await import('node:fs');
const {{ pathToFileURL }} = await import('node:url');
const {{ join }} = await import('node:path');
const bundled = await import(pathToFileURL(join(process.env.CONTRACT_REPO, 'src/codex/catalog/bundled.ts')).href);
const runtime = await import(pathToFileURL(join(process.env.CONTRACT_REPO, 'src/codex/runtime.ts')).href);
const paths = await import(pathToFileURL(join(process.env.CONTRACT_REPO, 'src/codex/paths.ts')).href);
const effort = await import(pathToFileURL(join(process.env.CONTRACT_REPO, 'src/codex/catalog/effort.ts')).href);
const root = process.env.OPENCODEX_HOME;
const row = slug => ({{ slug, display_name:slug, base_instructions:'synthetic', context_window:128000,
  supported_reasoning_levels:[{{effort:'medium',description:'synthetic'}}], default_reasoning_level:'medium' }});
const catalog = {{ models:[row('gpt-5.5'),row('gpt-5.6-sol')] }};
const selected = {{command:process.env.CODEX_CLI_PATH,version:'0.160.0',source:'environment'}};
const answer = await (async () => {{ {expression} }})();
console.log('@@catalog-contract@@'+JSON.stringify(answer));
"#
        );
        let mut command = hidden(Command::new(bun));
        command.env_clear();
        if let Some(system) = env::var_os("SystemRoot") {
            command.env("SystemRoot", &system).env("WINDIR", &system);
        }
        let output = command
            .env("PATH", path)
            .env("TEMP", &root)
            .env("TMP", &root)
            .env("HOME", &root)
            .env("USERPROFILE", &root)
            .env("APPDATA", root.join("appdata"))
            .env("LOCALAPPDATA", root.join("localappdata"))
            .env("OPENCODEX_HOME", &root)
            .env("CODEX_HOME", &root)
            .env("CODEX_CLI_PATH", &exe)
            .env("CONTRACT_REPO", &repo)
            .env("CODEX_CI", "1")
            .args(["--no-env-file", "--no-orphans", "--eval", &script])
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "Bun contract process failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let text = String::from_utf8(output.stdout).unwrap();
        let json = text
            .lines()
            .find_map(|line| line.strip_prefix("@@catalog-contract@@"))
            .expect("contract answer");
        serde_json::from_str(json).unwrap()
    };
    let cleanup_deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match fs::remove_dir_all(&root) {
            Ok(()) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                assert!(
                    std::time::Instant::now() < cleanup_deadline,
                    "owned fixture cleanup failed: {error}"
                );
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
        }
    }
    result
}

#[test]
fn bundled_snapshot_keeps_native_source_priority_and_rejects_changed_inputs() {
    let result = contract(
        "source-priority",
        r#"
fs.writeFileSync(paths.DEFAULT_CATALOG_PATH, JSON.stringify({models:[row('gpt-5.5')]}));
bundled.setBundledCatalogCacheForTests(selected, catalog, {expiresAt:Date.now()+60000});
const first = bundled.readCurrentCatalogOrCache();
Reflect.set(first.models[0], 'slug', 'changed');
const stable = bundled.readCurrentCatalogOrCache();
bundled.setBundledCatalogCacheForTests(selected, catalog, {expiresAt:0});
const stale = bundled.readCurrentCatalogOrCache();
await bundled.loadBundledCodexCatalogAsync();
process.env.CODEX_CLI_PATH = join(root,'missing.exe');
const switched = bundled.bundledCodexCatalogSnapshot();
return {stable:stable.models.map(row=>row.slug), stale:stale.models.map(row=>row.slug), switched:switched===null};
"#,
    );
    assert_eq!(
        result["stable"],
        serde_json::json!(["gpt-5.5", "gpt-5.6-sol"])
    );
    assert_eq!(result["stale"], result["stable"]);
    assert_eq!(result["switched"], true);
}

#[test]
fn concurrent_default_catalog_refreshes_share_one_flight() {
    let result = contract(
        "single-flight",
        r#"
fs.writeFileSync(join(root,'arm'),'catalog-delay');
const results = await Promise.all(Array.from({length:12},()=>bundled.loadBundledCodexCatalogAsync()));
const starts = fs.readFileSync(join(root,'fake-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
  .filter(event=>event.event==='start');
return {all:results.every(value=>value?.models[0]?.slug==='gpt-5.5'),
  versions:starts.filter(event=>event.version).length, catalogs:starts.filter(event=>!event.version).length,
  published:bundled.bundledCatalogCacheState().valueIdentity!==null};
"#,
    );
    assert_eq!(result["all"], true);
    assert_eq!(result["versions"], 1);
    assert_eq!(result["catalogs"], 1);
    assert_eq!(result["published"], true);
}

#[test]
fn invalidation_and_stopped_source_discard_late_catalogs() {
    let result = contract(
        "invalidation",
        r#"
let release;
let current = true;
const deps = {commandCandidates:()=>['C:\\fixture\\codex.exe'],
  execFile:()=>new Promise(resolve=>{release=resolve})};
const pending = bundled.loadBundledCodexCatalogAsync(deps);
bundled.invalidateBundledCatalogCache();
release(JSON.stringify(catalog));
const invalidated = await pending;
const stoppedPending = bundled.loadBundledCodexCatalogAsync(deps,()=>current);
current = false;
release(JSON.stringify(catalog));
return {invalidated:invalidated===null, stopped:(await stoppedPending)===null,
  empty:bundled.bundledCatalogCacheState().valueIdentity===null};
"#,
    );
    assert_eq!(
        result,
        serde_json::json!({"invalidated":true,"stopped":true,"empty":true})
    );
}

#[test]
fn async_runtime_persistence_rejects_pin_changes_cache_clear_and_stopped_sources() {
    let result = contract(
        "persist-guards",
        r#"
const initial = {version:1,command:'C:\\fixture\\codex.exe',source:'environment',selectedVersion:'0.159.0',
  origin:'discovered',updatedAt:'2026-10-08T00:00:00Z'};
async function resolveCase(change) {
  let release;
  let bytes = JSON.stringify(initial);
  let current = true;
  const dir = join(root,change); fs.mkdirSync(dir);
  const deps = {configDir:dir,env:{CODEX_CLI_PATH:initial.command,PATH:''},platform:'win32',
    discoverAlternatives:false,existsSync:()=>true,readdirSync:()=>[],
    readFileSync:path=>{if(path.endsWith('codex-runtime.json')) return bytes; throw Error('absent')},
    execFile:()=>new Promise(resolve=>{release=resolve})};
  const pending = runtime.resolveAndPersistCodexRuntimeAsync(deps,()=>current);
  if(change==='pin') bytes = JSON.stringify({...initial,origin:'pinned'}); // same timestamp and command
  if(change==='clear') runtime.clearCodexRuntimeResolveCache();
  if(change==='stop') current = false;
  release('codex-cli 0.160.0');
  const resolved = await pending;
  const file = join(dir,'codex-runtime.json');
  return {accepted:resolved!==null,written:fs.existsSync(file),
    version:fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).selectedVersion:null};
}
return {pin:await resolveCase('pin'),clear:await resolveCase('clear'),stop:await resolveCase('stop'),valid:await resolveCase('valid')};
"#,
    );
    for name in ["pin", "clear", "stop"] {
        assert_eq!(result[name]["accepted"], false);
        assert_eq!(result[name]["written"], false);
    }
    assert_eq!(result["valid"]["accepted"], true);
    assert_eq!(result["valid"]["version"], "0.160.0");
}
#[test]
fn failed_refresh_keeps_confirmed_rows_without_a_request_retry_storm() {
    let result = contract(
        "retry-backoff",
        r#"
await bundled.loadBundledCodexCatalogAsync();
bundled.setBundledCatalogCacheForTests(selected,catalog,{expiresAt:0});
fs.writeFileSync(join(root,'arm'),'catalog-invalid');
const stale = bundled.bundledCodexCatalogSnapshot();
await bundled.loadBundledCodexCatalogAsync();
const starts = ()=>fs.readFileSync(join(root,'fake-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
  .filter(event=>event.event==='start').length;
const before = starts();
const snapshots = Array.from({length:20},()=>bundled.bundledCodexCatalogSnapshot());
await new Promise(resolve=>setTimeout(resolve,500));
return {stale:stale.models.map(row=>row.slug), unchanged:snapshots.every(value=>value?.models.length===2),
  before,after:starts()};
"#,
    );
    assert_eq!(
        result["stale"],
        serde_json::json!(["gpt-5.5", "gpt-5.6-sol"])
    );
    assert_eq!(result["unchanged"], true);
    assert_eq!(result["before"], result["after"]);
}

#[test]
fn refresh_deadline_settles_an_uncooperative_executor_and_allows_the_next_load() {
    let result = contract(
        "deadline",
        r#"
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback,delay,...args)=>realTimeout(callback,delay===45000?20:delay,...args);
const keepAlive = setInterval(()=>{},100);
const expired = await bundled.loadBundledCodexCatalogAsync({commandCandidates:()=>['C:\\fixture\\codex.exe'],
  execFile:()=>new Promise(()=>{})});
clearInterval(keepAlive);
globalThis.setTimeout = realTimeout;
const fresh = await bundled.loadBundledCodexCatalogAsync({commandCandidates:()=>['C:\\fixture\\codex.exe'],
  execFile:async()=>JSON.stringify(catalog)});
return {expired:expired===null,fresh:fresh?.models.map(row=>row.slug)};
"#,
    );
    assert_eq!(result["expired"], true);
    assert_eq!(
        result["fresh"],
        serde_json::json!(["gpt-5.5", "gpt-5.6-sol"])
    );
}

#[test]
fn asynchronous_loader_preserves_large_valid_bundled_instructions() {
    let result = contract(
        "large-catalog",
        r#"
fs.writeFileSync(join(root,'arm'),'catalog-large');
const loaded = await bundled.loadBundledCodexCatalogAsync();
return {models:loaded?.models.length ?? 0,instructions:loaded?.models[0]?.base_instructions?.length ?? 0};
"#,
    );
    assert_eq!(result["models"], 1);
    assert_eq!(result["instructions"], 9 * 262144);
}

#[test]
fn warm_runtime_observation_does_not_repeat_version_processes() {
    let result = contract(
        "warm-runtime",
        r#"
await bundled.loadBundledCodexCatalogAsync();
await bundled.loadBundledCodexCatalogAsync(); // stabilize the memo after initial persistence
const starts = ()=>fs.readFileSync(join(root,'fake-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
  .filter(event=>event.event==='start').length;
const before = starts();
await bundled.loadBundledCodexCatalogAsync();
return {before,after:starts()};
"#,
    );
    assert_eq!(result["before"], result["after"]);
}

#[test]
fn failed_catalog_cannot_retain_a_different_runtime_version() {
    let result = contract(
        "failed-version",
        r#"
await bundled.loadBundledCodexCatalogAsync();
await bundled.loadBundledCodexCatalogAsync();
bundled.setBundledCatalogCacheForTests({...selected,version:'0.159.0'},catalog);
fs.writeFileSync(join(root,'arm'),'catalog-invalid');
await bundled.loadBundledCodexCatalogAsync();
return {dropped:bundled.bundledCodexCatalogSnapshot()===null};
"#,
    );
    assert_eq!(result["dropped"], true);
}

#[test]
fn source_abort_does_not_cancel_an_independent_shared_catalog_refresh() {
    let result = contract(
        "source-abort",
        r#"
await bundled.loadBundledCodexCatalogAsync();
await bundled.loadBundledCodexCatalogAsync();
bundled.setBundledCatalogCacheForTests(selected,catalog,{expiresAt:0});
fs.writeFileSync(join(root,'arm'),'catalog-delay');
const controller = new AbortController();
const scoped = bundled.loadBundledCodexCatalogAsync({},()=>true,controller.signal);
const independent = bundled.loadBundledCodexCatalogAsync();
setTimeout(()=>controller.abort(),50);
const [stopped,shared] = await Promise.all([scoped,independent]);
return {stopped:stopped===null,shared:shared?.models[0]?.slug,
  visible:bundled.bundledCodexCatalogSnapshot()?.models[0]?.slug};
"#,
    );
    assert_eq!(result["stopped"], true);
    assert_eq!(result["shared"], "gpt-5.5");
    assert_eq!(result["visible"], "gpt-5.5");
}

#[test]
fn observed_effort_clamp_never_calls_a_synchronous_version_executor() {
    let result = contract(
        "observed-effort",
        r#"
await bundled.loadBundledCodexCatalogAsync();
await bundled.loadBundledCodexCatalogAsync(); // settle the input signature after initial persistence
const observed = bundled.bundledCodexCatalogSnapshot();
if (!observed) throw new Error('confirmed bundled catalog missing');
const settledCommand = runtime.getCodexRuntimeSnapshot().runtime.command;
let syncCalls = 0;
const entry = {...row('gpt-5.5'), supported_reasoning_levels:[
  {effort:'medium',description:'synthetic'},{effort:'high',description:'synthetic'}],
  default_reasoning_level:'high'};
effort.clampCatalogModelsToCodexSupport([entry], {
  observedCatalog:observed,
  execFileSync:()=>{syncCalls++;return 'codex-cli 0.160.0';}
});
fs.writeFileSync(join(root,'arm'),'version-gated');
runtime.resetCodexRuntimeResolveCacheForTests();
const ends = () => fs.readFileSync(join(root,'fake-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
  .filter(event=>event.event==='end'&&event.version).length;
const before = ends();
effort.clampCatalogModelsToCodexSupport([entry], {observedCatalog:observed});
const after = ends();
fs.writeFileSync(join(root,'version-release'),'release');
await runtime.resolveCodexRuntimeAsync();
return {syncCalls,before,after,sameSelection:runtime.getCodexRuntimeSnapshot().runtime.command===settledCommand,
  levels:entry.supported_reasoning_levels.map(level=>level.effort),
  defaultLevel:entry.default_reasoning_level,
  runtime:runtime.getCodexRuntimeSnapshot().runtime.command};
"#,
    );
    assert_eq!(result["syncCalls"], 0);
    assert_eq!(result["before"], result["after"]);
    assert_eq!(result["sameSelection"], true);
    assert_eq!(result["levels"], serde_json::json!(["medium"]));
    assert_eq!(result["defaultLevel"], "medium");
}
