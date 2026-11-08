'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const SHA = 'a'.repeat(40);

test('full dispatch fixes path scopes and identifies its lane and SHA', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /run-name:.*ocx-ci-v1.*github\.sha/);
  for (const scope of ['gui', 'packaging', 'docs', 'structure', 'ci', 'desktop', 'native', 'setup_action', 'remote_helper']) {
    assert.match(ci, new RegExp(`workflow_dispatch[^\\n]*lane[^\\n]*all[^\\n]*steps\\.filter\\.outputs\\.${scope}`));
  }
});

test('CI runs all release and Pages Node contract suites', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const step = ci.split('\n').find(line => line.includes('node --test') && line.includes('release-evidence.test.cjs'));
  assert.ok(step);
  for (const suite of ['release-dispatch-guard.test.cjs','release-evidence.test.cjs','release-history.test.cjs','release-resume.test.cjs','deploy-docs.test.cjs']) assert.ok(step.includes(suite), suite);
});

test('service dispatch validates and binds the same full SHA in each job and checkout', () => {
  const service = fs.readFileSync(path.join(root, '.github/workflows/service-lifecycle.yml'), 'utf8');
  assert.match(service, /source_sha:/);
  assert.match(service, /\[0-9a-f\]\{40\}/);
  for (const name of ['linux-systemd', 'macos-launchd', 'windows-schtasks']) {
    assert.ok(service.includes('name: ' + name + ' ${{ github.event.inputs.source_sha'));
  }
  assert.equal((service.match(/ref: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.source_sha \|\| github\.sha \}\}/g) || []).length, 3);
});

test('run attempt graph fails on missing, skipped and duplicate legs', () => {
  const { validateJobs, CI_JOBS } = require('./release-evidence.cjs');
  const jobs = CI_JOBS.map(name => ({name, status:'completed', conclusion:'success'}));
  assert.equal(validateJobs(jobs, CI_JOBS), true);
  assert.throws(() => validateJobs(jobs.slice(1), CI_JOBS));
  assert.throws(() => validateJobs([...jobs, jobs[0]], CI_JOBS));
  assert.throws(() => validateJobs(jobs.map((j,i) => i ? j : {...j, conclusion:'skipped'}), CI_JOBS));
});

test('service graph binds every leg to the exact tested SHA', () => {
  const { validateJobs, serviceJobs } = require('./release-evidence.cjs');
  const names = serviceJobs(SHA);
  const jobs = names.map(name => ({name, status:'completed', conclusion:'success'}));
  assert.equal(validateJobs(jobs, names), true);
  assert.throws(() => validateJobs(jobs, serviceJobs('b'.repeat(40))));
  assert.throws(() => serviceJobs('abc'));
});

test('authenticated client accepts repository root without allowing alternate hosts', async () => {
  const { apiClient } = require('./release-evidence.cjs');
  const original = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => { requests.push({url, options}); return {ok:true, json:async () => ({id:1273824907})}; };
  try {
    const api = apiClient('lidge-jun/opencodex', 'token');
    assert.deepEqual(await api(''), {id:1273824907});
    assert.equal(requests[0].url, 'https://api.github.com/repos/lidge-jun/opencodex');
    await assert.rejects(api('//example.org'), /invalid API path/);
  } finally { global.fetch = original; }
});

test('run identity rejects forged titles, wrong repository, branch, event and attempt', () => {
  const { validateRun } = require('./release-evidence.cjs');
  const workflow = {id:42};
  const run = {id:7, workflow_id:42, repository:{id:1273824907}, head_repository:{id:1273824907}, event:'workflow_dispatch', head_branch:'dev', status:'completed', conclusion:'success', run_attempt:1, head_sha:SHA, display_title:`ocx-ci-v1 lane=all sha=${SHA}`};
  assert.doesNotThrow(() => validateRun(run, workflow, 'ci', SHA));
  for (const change of [{event:'push'}, {head_branch:'main'}, {conclusion:'failure'}, {run_attempt:0}, {repository:{id:2}}, {head_repository:{id:2}}, {display_title:`ocx-ci-v1 lane=release-gates sha=${SHA}`}, {display_title:`ocx-ci-v1 lane=windows-native-claim sha=${SHA}`}, {head_sha:'b'.repeat(40)}]) {
    assert.throws(() => validateRun({...run, ...change}, workflow, 'ci', SHA));
  }
});

test('pagination reads all pages and refuses truncated or changing totals', async () => {
  const { pages } = require('./release-evidence.cjs');
  const calls = [];
  const api = async url => { calls.push(url); return url.endsWith('page=1') ? {total_count:101, jobs:Array.from({length:100}, (_,i) => i)} : {total_count:101, jobs:[100]}; };
  assert.equal((await pages(api, '/runs/1/jobs', 'jobs')).length, 101);
  assert.equal(calls.length, 2);
  await assert.rejects(pages(async () => ({total_count:2,jobs:[]}), '/runs/1/jobs', 'jobs'), /incomplete pagination/);
  await assert.rejects(pages(async url => url.endsWith('page=1') ? {total_count:101,jobs:Array(100).fill(1)} : {total_count:102,jobs:[1,2]}, '/runs/1/jobs', 'jobs'), /pagination changed/);
});

test('selector authenticates policy and chooses the descendant, independent of run order', async () => {
  const { createEvidence, CI_JOBS } = require('./release-evidence.cjs');
  const older = 'b'.repeat(40), newer = 'c'.repeat(40), tree = 'd'.repeat(40), blob = 'e'.repeat(40);
  const mkRun = (id, head) => ({id, workflow_id:42, repository:{id:1273824907}, head_repository:{id:1273824907}, event:'workflow_dispatch', head_branch:'dev', status:'completed', conclusion:'success', run_attempt:2, head_sha:head, display_title:`ocx-ci-v1 lane=all sha=${head}`});
  const jobs = CI_JOBS.map(name => ({name, status:'completed', conclusion:'success'}));
  const calls = [];
  const api = async url => {
    calls.push(url);
    if (url === '') return {id:1273824907,full_name:'lidge-jun/opencodex'};
    if (url === '/actions/workflows/ci.yml') return {id:42,path:'.github/workflows/ci.yml'};
    if (url === '/commits/dev') return {sha:newer};
    if (url.startsWith('/compare/')) { const [base,head] = url.slice(9).split('...'); return {status:base === head ? 'identical' : base === older && head === newer ? 'ahead' : 'behind'}; }
    if (url.startsWith('/actions/workflows/42/runs?')) return {total_count:2,workflow_runs:[mkRun(1,newer),mkRun(2,older)]};
    if (url.startsWith('/git/commits/')) return {tree:{sha:tree}};
    if (url === `/git/trees/${tree}`) return {truncated:false,tree:[{path:'.github',type:'tree',sha:tree},{path:'workflows',type:'tree',sha:tree},{path:'ci.yml',type:'blob',mode:'100644',sha:blob}]};
    if (/^\/actions\/runs\/[12]\/attempts\/2\/jobs\?/.test(url)) return {total_count:jobs.length,jobs};
    throw new Error(`unexpected API request ${url}`);
  };
  const approved = [{kind:'ci',version:1,files:{'.github/workflows/ci.yml':blob}}];
  assert.deepEqual(await createEvidence(api, approved).select('ci'), {sourceSha:newer,ciRunId:1});
  assert.deepEqual(await createEvidence(api, approved).select('ci', older), {sourceSha:older,ciRunId:2});
  const historical = {kind:'ci',version:1,files:{'.github/workflows/absent.yml':blob,'.github/workflows/ci.yml':blob}};
  assert.deepEqual(await createEvidence(api, [historical, ...approved]).select('ci', older), {sourceSha:older,ciRunId:2});
  assert.ok(calls.some(url => url.includes('/attempts/2/jobs?')));
  await assert.rejects(createEvidence(api, [{kind:'ci',version:1,files:{'.github/workflows/ci.yml':'f'.repeat(40)}}]).select('ci'), /no qualifying/);
  await assert.rejects(createEvidence(api, []).select('ci'), /no approved ci evidence policy/);
});

test('service uses setup action from the workflow revision rather than the historical candidate', () => {
  const service = fs.readFileSync(path.join(root, '.github/workflows/service-lifecycle.yml'), 'utf8');
  assert.equal((service.match(/path: \.evidence-policy/g) || []).length, 3);
  assert.equal((service.match(/ref: \$\{\{ github\.sha \}\}/g) || []).length, 3);
  assert.equal((service.match(/uses: \.\/\.evidence-policy\/\.github\/actions\/setup-project-bun/g) || []).length, 3);
});

test('service evidence uses workflow revision policy and a complete current attempt for the candidate', async () => {
  const { createEvidence, serviceJobs } = require('./release-evidence.cjs');
  const revision = 'b'.repeat(40), tree = 'c'.repeat(40), blob = 'd'.repeat(40);
  const run = {id:9,workflow_id:43,repository:{id:1273824907},head_repository:{id:1273824907},event:'workflow_dispatch',head_branch:'dev',status:'completed',conclusion:'success',run_attempt:3,head_sha:revision};
  let jobs = serviceJobs(SHA).map(name => ({name,status:'completed',conclusion:'success'}));
  const api = async url => {
    if (url === '') return {id:1273824907,full_name:'lidge-jun/opencodex'};
    if (url === '/actions/workflows/service-lifecycle.yml') return {id:43,path:'.github/workflows/service-lifecycle.yml'};
    if (url === '/commits/dev') return {sha:revision};
    if (url.startsWith('/compare/')) return {status:'ahead'};
    if (url.startsWith('/actions/workflows/43/runs?')) return {total_count:1,workflow_runs:[run]};
    if (url === `/git/commits/${revision}`) return {tree:{sha:tree}};
    if (url === `/git/trees/${tree}`) return {truncated:false,tree:[{path:'.github',type:'tree',sha:tree},{path:'workflows',type:'tree',sha:tree},{path:'service-lifecycle.yml',type:'blob',mode:'100644',sha:blob}]};
    if (url.startsWith('/actions/runs/9/attempts/3/jobs?')) return {total_count:jobs.length,jobs};
    throw new Error(`unexpected API request ${url}`);
  };
  const policy = [{kind:'service',version:1,files:{'.github/workflows/service-lifecycle.yml':blob}}];
  assert.deepEqual(await createEvidence(api, policy).select('service', SHA), {sourceSha:SHA,ciRunId:9});
  jobs = jobs.slice(1);
  await assert.rejects(createEvidence(api, policy).select('service', SHA), /no qualifying/);
  jobs = serviceJobs('e'.repeat(40)).map(name => ({name,status:'completed',conclusion:'success'}));
  await assert.rejects(createEvidence(api, policy).select('service', SHA), /no qualifying/);
});

test('production policy pins the current workflows and job-selection helpers', () => {
  const { execFileSync } = require('node:child_process');
  const policies = require('./release-evidence-policy.json');
  for (const kind of ['ci', 'service']) {
    const policy = policies.filter(p => p.kind === kind && p.version === 1).at(-1);
    assert.ok(policy);
    const required = kind === 'ci' ? ['.github/workflows/ci.yml', '.github/actions/setup-project-bun/action.yml', 'scripts/ci/run-bun-test-batches.sh', 'scripts/ci/select-test-lane.sh', 'scripts/ci/windows-sensitive-diff.sh', 'scripts/test.ts', 'scripts/keyring-smoke.ts', 'desktop/scripts/verify-macos-runtime.sh', 'desktop/scripts/verify-linux-sidecar.sh', 'desktop/scripts/linux-packaged-e2e.ts'] : ['.github/workflows/service-lifecycle.yml', '.github/actions/setup-project-bun/action.yml'];
    for (const name of required) assert.ok(policy.files[name], name);
    for (const [name, digest] of Object.entries(policy.files)) {
      assert.equal(execFileSync('git', ['hash-object', '--no-filters', name], {cwd:root,encoding:'utf8'}).trim(), digest, name);
    }
  }
});

test('service change detection handles initial trees, cumulative changes and deletions', () => {
  const { serviceChangeRequired } = require('./release-evidence.cjs');
  assert.equal(serviceChangeRequired(['README.md', 'src/router.ts']), false);
  for (const file of ['src/service.ts','src/service/daemon.ts','desktop/app/main.rs','src/cli.ts','src/cli/index.ts','src/lib/bun-runtime.ts','package.json','bun.lock','.github/workflows/service-lifecycle.yml','.github/workflows/release.yml']) {
    assert.equal(serviceChangeRequired(['README.md',file]), true, file);
  }
  for (const file of ['src/service-other.ts','src/cli/index.ts.bak','nested/package.json']) assert.equal(serviceChangeRequired([file]), false, file);
  assert.throws(() => serviceChangeRequired(null));
  assert.throws(() => serviceChangeRequired(['../src/service.ts']));
});

test('service range accepts a reachable baseline or an explicit initial tree only', () => {
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocx-service-evidence-'));
  const git = (...args) => execFileSync('git', args, {cwd:dir,encoding:'utf8'}).trim();
  const script = path.join(root, '.github/scripts/release-evidence.cjs');
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [script, 'service-range', ...args], {cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  try {
    git('init','-q'); git('config','user.email','fixture@localhost'); git('config','user.name','fixture');
    fs.mkdirSync(path.join(dir,'src/service'), {recursive:true});
    fs.writeFileSync(path.join(dir,'src/service/daemon.ts'),'one');
    git('add','.'); git('commit','-qm','initial'); const initial = git('rev-parse','HEAD');
    fs.writeFileSync(path.join(dir,'src/service/daemon.ts'),'two');
    git('add','.'); git('commit','-qm','service');
    fs.writeFileSync(path.join(dir,'README.md'),'other');
    git('add','.'); git('commit','-qm','later'); const later = git('rev-parse','HEAD');
    assert.deepEqual(run(initial,'--initial'), {required:true});
    assert.deepEqual(run(later,initial), {required:true});
    assert.deepEqual(run(later,later), {required:false});
    fs.unlinkSync(path.join(dir,'src/service/daemon.ts'));
    git('add','-A'); git('commit','-qm','remove service'); const removed = git('rev-parse','HEAD');
    assert.deepEqual(run(removed,later), {required:true});
    assert.throws(() => run(initial,later));
    assert.throws(() => run(later));
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('policy approval check detects drift while retaining historical policies', () => {
  const { checkPolicyFiles } = require('./release-evidence.cjs');
  const { createHash } = require('node:crypto');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocx-policy-check-'));
  try {
    const content = Buffer.from('reviewed');
    fs.writeFileSync(path.join(dir, 'file'),content);
    const digest = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
    const policies = [{kind:'ci',files:{file:'f'.repeat(40)}}, {kind:'ci',files:{file:digest}}, {kind:'service',files:{file:digest}}];
    assert.equal(checkPolicyFiles(policies,dir), true);
    fs.writeFileSync(path.join(dir,'file'),'changed');
    assert.throws(() => checkPolicyFiles(policies,dir), /fingerprint mismatch/);
    assert.throws(() => checkPolicyFiles(policies.slice(0,2),dir), /missing service/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('default production policy accepts its exact blobs and rejects a changed helper', async () => {
  const { createEvidence, CI_JOBS } = require('./release-evidence.cjs');
  const policy = require('./release-evidence-policy.json').filter(p => p.kind === 'ci').at(-1);
  const run = {id:88, workflow_id:42, repository:{id:1273824907},head_repository:{id:1273824907},event:'workflow_dispatch',head_branch:'dev',status:'completed',conclusion:'success',run_attempt:1,head_sha:SHA,display_title:`ocx-ci-v1 lane=all sha=${SHA}`};
  const jobs = CI_JOBS.map(name => ({name,status:'completed',conclusion:'success'}));
  const trees = new Map();
  const directorySha = path => require('node:crypto').createHash('sha1').update(path).digest('hex');
  const treeFor = path => { const id = directorySha(path); if (!trees.has(id)) trees.set(id, []); return trees.get(id); };
  treeFor('');
  for (const [file, id] of Object.entries(policy.files)) {
    const parts = file.split('/'); let current = '';
    for (const part of parts.slice(0,-1)) {
      const next = current ? `${current}/${part}` : part;
      if (!treeFor(current).some(e => e.path === part)) treeFor(current).push({path:part,type:'tree',mode:'040000',sha:directorySha(next)});
      treeFor(next); current = next;
    }
    treeFor(current).push({path:parts.at(-1),type:'blob',mode:'100644',sha:id});
  }
  const api = async url => {
    if (url === '') return {id:1273824907,full_name:'lidge-jun/opencodex'};
    if (url === '/actions/workflows/ci.yml') return {id:42,path:'.github/workflows/ci.yml'};
    if (url === '/commits/dev') return {sha:SHA};
    if (url.startsWith('/compare/')) return {status:'identical'};
    if (url.startsWith('/actions/workflows/42/runs?')) return {total_count:1,workflow_runs:[run]};
    if (url === `/git/commits/${SHA}`) return {tree:{sha:directorySha('')}};
    if (url.startsWith('/git/trees/')) return {truncated:false,tree:trees.get(url.slice('/git/trees/'.length))};
    if (url.startsWith('/actions/runs/88/attempts/1/jobs?')) return {total_count:jobs.length,jobs};
    throw new Error(`unexpected API request ${url}`);
  };
  assert.deepEqual(await createEvidence(api).select('ci', SHA), {sourceSha:SHA,ciRunId:88});
  const script = treeFor('scripts/ci').find(e => e.path === 'run-bun-test-batches.sh');
  script.sha = 'f'.repeat(40);
  await assert.rejects(createEvidence(api).select('ci', SHA), /no qualifying/);
});

function boundedFixture({ runs, order, race = false, raceState = false, devMoves = false, divergent = [], history = ['1','2','3'].map(x => x.repeat(40)) }) {
  const { CI_JOBS } = require('./release-evidence.cjs');
  const tree = 'd'.repeat(40), blob = 'e'.repeat(40), calls = [];
  let exactReads = 0;
  const readsByHead = new Map();
  let devReads = 0;
  const api = async url => {
    calls.push(url);
    if (url === '') return {id:1273824907,full_name:'lidge-jun/opencodex'};
    if (url === '/actions/workflows/ci.yml') return {id:42,path:'.github/workflows/ci.yml'};
    if (url === '/commits/dev') return {sha:devMoves && ++devReads > 1 ? 'f'.repeat(40) : history.at(-1)};
    if (url.startsWith('/compare/')) {
      const parsed = new URL(url, 'https://fixture.invalid');
      const [base, head] = parsed.pathname.slice(9).split('...');
      const a=history.indexOf(base), b=history.indexOf(head);
      const status = a===b ? 'identical' : divergent.includes(base) && divergent.includes(head) ? 'diverged' : a<b ? 'ahead' : 'behind';
      const commits = status === 'ahead' ? history.slice(a+1,b+1).map(sha => ({sha})) : [];
      const page = Number(parsed.searchParams.get('page') || 1), size = Number(parsed.searchParams.get('per_page') || 100);
      return {status,total_commits:commits.length,commits:commits.slice((page-1)*size,page*size)};
    }
    if (url.startsWith('/actions/workflows/42/runs?')) {
      const query = new URL(url, 'https://fixture.invalid').searchParams;
      if (query.get('event') !== 'workflow_dispatch' || query.get('branch') !== 'dev') throw new Error('unfiltered 25000-run history');
      const head = query.get('head_sha');
      if (head) { exactReads++; readsByHead.set(head, (readsByHead.get(head) || 0) + 1); }
      let selected = runs.map(r => raceState && head && readsByHead.get(head) > 1 && r.status === 'in_progress' ? {...r,status:'completed',conclusion:'success'} : r)
        .filter(r => (!head || r.head_sha === head) && (!query.has('status') || r.conclusion === query.get('status')));
      if (order) selected = [...selected].sort((a,b) => order.indexOf(a.id)-order.indexOf(b.id));
      const page=Number(query.get('page') || 1), size=Number(query.get('per_page') || 100);
      const total_count = selected.length + (race && head && exactReads > 1 ? 1 : 0);
      return {total_count,workflow_runs:selected.slice((page-1)*size,page*size)};
    }
    if (url.startsWith('/git/commits/')) return {tree:{sha:tree}};
    if (url === `/git/trees/${tree}`) return {truncated:false,tree:[{path:'.github',type:'tree',sha:tree},{path:'workflows',type:'tree',sha:tree},{path:'ci.yml',type:'blob',mode:'100644',sha:blob}]};
    if (/^\/actions\/runs\/\d+\/attempts\/1\/jobs\?/.test(url)) return {total_count:CI_JOBS.length,jobs:CI_JOBS.map(name => ({name,status:'completed',conclusion:'success'}))};
    throw new Error(`unexpected API request ${url}`);
  };
  const makeRun = (id, source, conclusion='success') => ({id,workflow_id:42,repository:{id:1273824907},head_repository:{id:1273824907},event:'workflow_dispatch',head_branch:'dev',status:'completed',conclusion,run_attempt:1,head_sha:source,display_title:`ocx-ci-v1 lane=all sha=${source}`});
  return {api,calls,history,makeRun,policies:[{kind:'ci',version:1,files:{'.github/workflows/ci.yml':blob}}]};
}

test('exact SHA filters 25000 unrelated runs on the server', async () => {
  const {createEvidence} = require('./release-evidence.cjs');
  const data = boundedFixture({runs:[]});
  const old = data.history[0];
  const run = data.makeRun(7,old);
  const fixture = boundedFixture({runs:[run]});
  assert.deepEqual(await createEvidence(fixture.api,fixture.policies).select('ci',old), {sourceSha:old,ciRunId:7});
  assert.ok(fixture.calls.filter(x=>x.startsWith('/actions/workflows/42/runs?')).every(x=>new URL(x,'https://fixture.invalid').searchParams.get('head_sha')===old));
});

test('newest selection proves ancestry independently of run completion ordering', async () => {
  const {createEvidence} = require('./release-evidence.cjs');
  const seed = boundedFixture({runs:[]}), [older,,newer] = seed.history;
  const fixture = boundedFixture({runs:[seed.makeRun(1,older),seed.makeRun(2,newer)],order:[1,2]});
  assert.deepEqual(await createEvidence(fixture.api,fixture.policies).select('ci'), {sourceSha:newer,ciRunId:2});
  assert.ok(fixture.calls.some(x=>x.startsWith('/compare/') && x.includes('per_page=')));
});

test('newer failed runs do not hide an older qualifying commit', async () => {
  const {createEvidence} = require('./release-evidence.cjs');
  const seed = boundedFixture({runs:[]}), [older,,newer] = seed.history;
  const fixture = boundedFixture({runs:[seed.makeRun(2,newer,'failure'),seed.makeRun(1,older)],order:[2,1]});
  assert.deepEqual(await createEvidence(fixture.api,fixture.policies).select('ci'), {sourceSha:older,ciRunId:1});
});

test('more than 1000 failed newer runs do not exhaust the filtered search', async () => {
  const {createEvidence} = require('./release-evidence.cjs');
  const seed=boundedFixture({runs:[]}), [older,,newer]=seed.history;
  const failures=Array.from({length:1101},(_,i)=>seed.makeRun(i+2,newer,'failure'));
  const fixture=boundedFixture({runs:[...failures,seed.makeRun(1,older)]});
  assert.deepEqual(await createEvidence(fixture.api,fixture.policies).select('ci'), {sourceSha:older,ciRunId:1});
});

test('exact SHA pagination and concurrent list changes fail closed', async () => {
  const {createEvidence} = require('./release-evidence.cjs');
  const seed = boundedFixture({runs:[]}), source=seed.history[0];
  const runs=Array.from({length:101},(_,i)=>seed.makeRun(i+1,source));
  const good=boundedFixture({runs});
  assert.equal((await createEvidence(good.api,good.policies).select('ci',source)).sourceSha,source);
  assert.ok(good.calls.some(x=>x.includes('page=2')));
  const racing=boundedFixture({runs,race:true});
  await assert.rejects(createEvidence(racing.api,racing.policies).select('ci',source), /pagination|changed|incomplete/i);
});

test('newest selection detects dev movement and a newer run completing during lookup', async () => {
  const {createEvidence} = require('./release-evidence.cjs');
  const seed=boundedFixture({runs:[]}), [older,,newer]=seed.history;
  const progress={...seed.makeRun(2,newer),status:'in_progress',conclusion:null};
  const racing=boundedFixture({runs:[seed.makeRun(1,older),progress],raceState:true});
  await assert.rejects(createEvidence(racing.api,racing.policies).select('ci'), /changed/i);
  const moved=boundedFixture({runs:[seed.makeRun(1,older)],devMoves:true});
  await assert.rejects(createEvidence(moved.api,moved.policies).select('ci'), /dev changed/i);
});

test('newest selection paginates the commit comparison and refuses excessive ancestry', async () => {
  const {createEvidence} = require('./release-evidence.cjs');
  const history=Array.from({length:102},(_,i)=>(i+1).toString(16).padStart(40,'0'));
  const seed=boundedFixture({runs:[],history});
  const fixture=boundedFixture({runs:[seed.makeRun(1,history[0])],history});
  assert.equal((await createEvidence(fixture.api,fixture.policies).select('ci')).sourceSha, history[0]);
  assert.ok(fixture.calls.some(x=>x.startsWith('/compare/') && x.includes('page=2')));
  const longHistory=Array.from({length:202},(_,i)=>(i+1).toString(16).padStart(40,'0'));
  const long=boundedFixture({runs:[seed.makeRun(1,longHistory[0])],history:longHistory});
  await assert.rejects(createEvidence(long.api,long.policies).select('ci'), /coverage exceeds/);
});

test('newest selection refuses incomparable green ancestors', async () => {
  const {createEvidence} = require('./release-evidence.cjs');
  const history=['1','2','3','4'].map(x=>x.repeat(40));
  const seed=boundedFixture({runs:[],history});
  const fixture=boundedFixture({history,divergent:[history[1],history[2]],runs:[seed.makeRun(1,history[0]),seed.makeRun(2,history[1]),seed.makeRun(3,history[2])]});
  await assert.rejects(createEvidence(fixture.api,fixture.policies).select('ci'), /ambiguous/);
});

test('filtered searches fail closed beyond GitHub’s 1000-result coverage', async () => {
  const {createEvidence} = require('./release-evidence.cjs');
  const seed=boundedFixture({runs:[]}), source=seed.history[0];
  const runs=Array.from({length:1001},(_,i)=>({...seed.makeRun(i+1,source),display_title:'old policy'}));
  const discovery=boundedFixture({runs});
  await assert.rejects(createEvidence(discovery.api,discovery.policies).select('ci'), /coverage exceeds/);
  assert.equal(discovery.calls.filter(x=>x.startsWith('/actions/workflows/42/runs?')).length,10);
  const exact=boundedFixture({runs});
  await assert.rejects(createEvidence(exact.api,exact.policies).select('ci',source), /coverage exceeds/);
});
