'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');
const { reconcileHistory, verifyExactResume, createReceiptVerifier, collectPublicationHistory, verifyLegacyTreeEvidence } = require('./release-history.cjs');

const old = 'a'.repeat(40), newer = 'b'.repeat(40), other = 'c'.repeat(40), workflow = 'd'.repeat(40);
const digest = '1'.repeat(64), assetDigest = '2'.repeat(64);
const ancestry = (base, head) => base === head || (base === old && head === newer);
const record = (version, sourceSha, publishedAt) => ({version, gitHead: sourceSha, publishedAt});
const receipt = (version, sourceSha, channel = 'stable') => ({version, sourceSha, workflowSha: workflow, channel, sha256: digest, runId: 123, attempt: 1, assets: {'app.zip': assetDigest}});
const authenticated = x => x?.authenticated === true;
const attested = x => x?.verified === true;
const signed = payload => ({payload, authenticated: true});
const snapshot = overrides => ({
  candidateSha: newer, candidateVersion: '1.0.2', channel: 'stable',
  versions: [record('1.0.0', old, '2026-01-01T00:00:00.000Z')],
  distTags: {latest: '1.0.0'}, tags: [{version: '1.0.0', sha: old}],
  releases: [{version: '1.0.0', tag: 'v1.0.0'}], receipts: [], mappings: [],
  isAncestor: ancestry, verifyReceipt: authenticated, ...overrides,
});

test('newer npm-only partial publication prevents source rollback', () => {
  const r = receipt('1.0.1', newer);
  const input = snapshot({candidateSha: old, versions: [record('1.0.0', old, '2026-01-01T00:00:00.000Z'), record('1.0.1', newer, '2026-01-02T00:00:00.000Z')], receipts: [signed(r)]});
  assert.throws(() => reconcileHistory(input), /lineage|rollback/);
  assert.throws(() => reconcileHistory({...input, receipts: []}), /receipt/);
  assert.throws(() => reconcileHistory({...input, receipts: [{payload:r, authenticated:false}]}), /receipt/);
});

test('pure history rejects divergent sources and arbitrary mappings cannot bypass ancestry', () => {
  const input = snapshot({versions:[record('1.0.0', other, '2026-01-01T00:00:00.000Z')], tags:[{version:'1.0.0', sha:other}]});
  assert.throws(() => reconcileHistory(input), /lineage/);
  assert.throws(() => reconcileHistory({...input, mappings:[{version:'1.0.0', legacySha:other, devSha:old}]}), /lineage/);
});

test('pure history rejects divergent channels', () => {
  const input = snapshot({versions:[record('1.0.0',other,'2026-01-01T00:00:00.000Z'),record('1.0.1-preview.20260102.1',old,'2026-01-02T00:00:00.000Z')],
    tags:[{version:'1.0.0',sha:other},{version:'1.0.1-preview.20260102.1',sha:old}], releases:[{version:'1.0.0',tag:'v1.0.0'},{version:'1.0.1-preview.20260102.1',tag:'v1.0.1-preview.20260102.1'}]});
  assert.throws(() => reconcileHistory(input), /lineage/);
});

test('stable may follow preview at the same source but rollback and ambiguity fail', () => {
  const input = snapshot({candidateSha:old, candidateVersion:'1.0.1', versions:[record('1.0.1-preview.20260101.1',old,'2026-01-01T00:00:00.000Z')], tags:[{version:'1.0.1-preview.20260101.1',sha:old}], releases:[{version:'1.0.1-preview.20260101.1',tag:'v1.0.1-preview.20260101.1'}], distTags:{preview:'1.0.1-preview.20260101.1'}});
  assert.equal(reconcileHistory(input).floor.sourceSha, old);
  assert.throws(() => reconcileHistory({...input, candidateVersion:'1.0.0'}), /version/);
  assert.throws(() => reconcileHistory({...input, versions:[...input.versions, record('1.0.0',old,input.versions[0].publishedAt)]}), /order/);
});

function resumeInput() {
  const tuple = receipt('1.0.1', newer);
  return {tuple, receipt:signed(tuple), registry:{version:tuple.version, gitHead:newer, sha256:digest}, provenance:{verified:true}, tag:{name:'v1.0.1',sha:newer}, release:{tag:'v1.0.1',assets:[{name:'app.zip',sha256:assetDigest}]}, historyFloor:{version:tuple.version,sourceSha:newer}, verifyHistory:() => true, verifyReceipt:authenticated, verifyProvenance:attested};
}
test('verified exact resume never requests republish or overwrites assets', () => {
  assert.deepEqual(verifyExactResume(resumeInput()), {publishNpm:false, reuseAssets:['app.zip']});
});
test('resume rejects corrupt or forged receipts, registry and provenance mismatches, and asset replacement', () => {
  const input = resumeInput();
  assert.throws(() => verifyExactResume({...input, receipt:{...input.receipt,authenticated:false}}), /receipt/);
  assert.throws(() => verifyExactResume({...input, receipt:signed({...input.tuple, sha256:'3'.repeat(64)})}), /receipt/);
  assert.throws(() => verifyExactResume({...input, registry:{...input.registry,gitHead:old}}), /registry/);
  assert.throws(() => verifyExactResume({...input, provenance:{verified:false}}), /provenance/);
  assert.throws(() => verifyExactResume({...input, historyFloor:{version:'1.0.2',sourceSha:other}}), /roll back/);
  assert.throws(() => verifyExactResume({...input, verifyHistory:() => false}), /history/);
  assert.throws(() => verifyExactResume({...input, tag:{name:'v1.0.1',sha:old}}), /tag/);
  assert.throws(() => verifyExactResume({...input, release:{tag:'v1.0.1',assets:[{name:'app.zip',sha256:digest}]}}), /asset/);
  assert.throws(() => verifyExactResume({...input, release:{tag:'v1.0.1',assets:[{name:'extra.zip',sha256:digest}]}}), /asset/);
});

test('real signed receipt binds bytes, tuple, expiry, and authenticated run attempt', () => {
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({type:'spki',format:'pem'});
  const input = resumeInput();
  const bytes = Buffer.from(JSON.stringify({payload:input.tuple,expiresAt:'2026-01-02T00:00:00.000Z'}));
  const envelope = {payload:input.tuple, signedBytes:bytes.toString('base64'), signature:sign(null,bytes,privateKey).toString('base64')};
  const makeVerifier = (now, verifyRun = t => t.runId === 123 && t.attempt === 1) => createReceiptVerifier({publicKey:publicPem, now:() => Date.parse(now), verifyRun});
  const verifyReceipt = makeVerifier('2026-01-01T00:00:00.000Z');
  assert.deepEqual(verifyExactResume({...input,receipt:envelope,verifyReceipt}), {publishNpm:false,reuseAssets:['app.zip']});
  assert.throws(() => verifyExactResume({...input,receipt:{...envelope,payload:{...input.tuple,attempt:2}},verifyReceipt}), /receipt/);
  const forged = Buffer.from(bytes); forged[10] ^= 1;
  assert.throws(() => verifyExactResume({...input,receipt:{...envelope,signedBytes:forged.toString('base64')},verifyReceipt}), /receipt/);
  assert.throws(() => verifyExactResume({...input,receipt:envelope,verifyReceipt:makeVerifier('2026-01-02T00:00:00.000Z')}), /receipt/);
  assert.throws(() => verifyExactResume({...input,receipt:envelope,verifyReceipt:makeVerifier('2026-01-01T00:00:00.000Z', () => false)}), /receipt/);
  const history = snapshot({versions:[record('1.0.1',newer,'2026-01-01T00:00:00.000Z')], distTags:{latest:'1.0.1'}, tags:[], releases:[], receipts:[envelope], candidateSha:old, candidateVersion:'1.0.2', verifyReceipt});
  assert.throws(() => reconcileHistory(history), /lineage|rollback/);
  assert.throws(() => reconcileHistory({...history,receipts:[{...envelope, signature:Buffer.alloc(64).toString('base64')}]}), /receipt/);
  const resumed = reconcileHistory({...history,candidateSha:newer,candidateVersion:'1.0.1',distTags:{latest:'1.0.1'},resume:true});
  assert.equal(resumed.floor.sourceSha, newer);
  assert.throws(() => reconcileHistory({...history,candidateSha:old,candidateVersion:'1.0.0',distTags:{latest:'1.0.1'},resume:true}), /roll back/);
});

test('history rejects missing sources, unknown tags, and missing registry evidence', () => {
  const input = snapshot();
  assert.throws(() => reconcileHistory({...input, versions:[record('1.0.0','', '2026-01-01T00:00:00.000Z')]}), /source/);
  assert.throws(() => reconcileHistory({...input, distTags:{latest:'1.0.5'}}), /dist-tag/);
  assert.throws(() => reconcileHistory({...input, tags:[{version:'1.0.1',sha:old}]}), /tag/);
  assert.throws(() => reconcileHistory({...input, releases:[{version:'1.0.0',tag:'v1.0.1'}]}), /release/);
});

function collectorFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ocx-release-history-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const git = (...args) => execFileSync('git', ['-C',dir,...args], {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q');
  const commit = name => { git('-c','user.name=Test','-c','user.email=test@localhost','commit','--allow-empty','-qm',name); return git('rev-parse','HEAD'); };
  const first = commit('preview'), second = commit('stable'), candidate = commit('candidate');
  const control = {devSha:candidate};
  const data = {name:'@bitkyc08/opencodex',versions:{},time:{},'dist-tags':{preview:'1.0.1-preview.20260101.1',latest:'1.0.1'}};
  const refs = new Map();
  function publish(v, sha, time, hasTag = true) {
    data.versions[v] = {name:data.name,version:v,gitHead:sha}; data.time[v] = time;
    if (hasTag) refs.set(v,sha);
  }
  publish('1.0.1-preview.20260101.1',first,'2026-01-01T00:00:00.000Z');
  publish('1.0.1',second,'2026-01-02T00:00:00.000Z');
  const fetchImpl = async (url, options) => {
    const u = new URL(url);
    assert.ok(options.signal); assert.equal(options.redirect,'error');
    if (u.hostname === 'registry.npmjs.org') return Response.json(data);
    assert.equal(u.hostname,'api.github.com'); assert.equal(options.headers.Authorization,'Bearer test-token');
    const path = u.pathname.replace('/repos/lidge-jun/opencodex','');
    if (path === '') return Response.json({id:1273824907,full_name:'lidge-jun/opencodex'});
    if (path === '/commits/dev') return Response.json({sha:control.devSha});
    if (path === '/tags') return Response.json([...refs].map(([v,sha]) => ({name:`v${v}`,commit:{sha}})));
    if (path === '/releases') return Response.json([...refs].map(([v]) => ({tag_name:`v${v}`,draft:false,prerelease:v.includes('-preview.'),published_at:data.time[v]})));
    const m = /^\/git\/ref\/tags\/v(.+)$/.exec(path);
    if (m) return refs.has(m[1]) ? Response.json({ref:`refs/tags/v${m[1]}`,object:{type:'commit',sha:refs.get(m[1])}}) : new Response('',{status:404});
    const r = /^\/releases\/tags\/v(.+)$/.exec(path);
    if (r) return refs.has(r[1]) ? Response.json({tag_name:`v${r[1]}`,draft:false,prerelease:r[1].includes('-preview.'),published_at:'2026-01-01T00:00:00Z'}) : new Response('',{status:404});
    throw Error(`unexpected mock URL ${url}`);
  };
  return {dir, git, commit, control, first, second, candidate, data, refs, publish, fetchImpl, args:{candidateSha:candidate,candidateVersion:'1.0.2',channel:'stable',repoPath:dir,token:'test-token',fetchImpl,mappings:[]}};
}

test('collector uses live-shaped npm and authenticated GitHub responses with real Git ancestry', async t => {
  const f = collectorFixture(t);
  const result = await collectPublicationHistory(f.args);
  assert.deepEqual(result.floor,{version:'1.0.1',sourceSha:f.second,publishedAt:'2026-01-02T00:00:00.000Z'});
  assert.deepEqual(result.channels.map(x => x.version),['1.0.1-preview.20260101.1','1.0.1']);
});

test('collector refuses a newer npm-only source and missing source metadata', async t => {
  const f = collectorFixture(t);
  f.publish('1.0.2-preview.20260103.1',f.candidate,'2026-01-03T00:00:00.000Z',false);
  await assert.rejects(collectPublicationHistory({...f.args,candidateSha:f.second,candidateVersion:'1.0.3'}), /npm-only|rollback|lineage/i);
  await assert.rejects(collectPublicationHistory({...f.args,candidateVersion:'1.0.3'}), /npm-only.*receipt/i);
  f.data.versions['1.0.2-preview.20260103.1'].gitHead = '';
  await assert.rejects(collectPublicationHistory({...f.args,candidateVersion:'1.0.3'}), /gitHead/);
});

test('collector refuses registry races and mismatched GitHub tag source', async t => {
  const f = collectorFixture(t);
  f.refs.set('1.0.1',f.first);
  await assert.rejects(collectPublicationHistory(f.args), /tag.*gitHead/i);
  f.refs.set('1.0.1',f.second);
  let reads = 0;
  const racingFetch = async (url, options) => {
    if (new URL(url).hostname === 'registry.npmjs.org' && ++reads === 2) f.data['dist-tags'].next = '1.0.1';
    return f.fetchImpl(url,options);
  };
  await assert.rejects(collectPublicationHistory({...f.args,fetchImpl:racingFetch}), /changed|race/i);
});

test('collector rejects arbitrary mappings for divergent nonlegacy channel histories', async t => {
  const f = collectorFixture(t);
  f.git('checkout','-q','--detach',f.first);
  const divergent = f.commit('divergent preview');
  f.git('checkout','-q','--detach',f.candidate);
  const preview = '1.0.1-preview.20260101.1';
  f.data.versions[preview].gitHead = divergent; f.refs.set(preview,divergent);
  await assert.rejects(collectPublicationHistory({...f.args,mappings:[{version:preview,legacySha:divergent,devSha:f.candidate}]}), /lineage/);
});

test('collector rejects missing releases, ambiguous timestamps, and missing commit objects', async t => {
  const f = collectorFixture(t);
  const missingRelease = async (url, options) => {
    const res = await f.fetchImpl(url,options);
    if (new URL(url).pathname.endsWith('/releases')) {
      const values = await res.json(); return Response.json(values.filter(v => v.tag_name !== 'v1.0.1'));
    }
    return res;
  };
  await assert.rejects(collectPublicationHistory({...f.args,fetchImpl:missingRelease}), /matching GitHub release/);
  f.data.time['1.0.1'] = f.data.time['1.0.1-preview.20260101.1'];
  await assert.rejects(collectPublicationHistory(f.args), /ambiguous.*order/);
  f.data.time['1.0.1'] = '2026-01-02T00:00:00.000Z';
  f.data.versions['1.0.1'].gitHead = 'f'.repeat(40); f.refs.set('1.0.1','f'.repeat(40));
  await assert.rejects(collectPublicationHistory(f.args), /Git source.*unavailable/);
});

test('collector accepts a strictly superseded historical tag mismatch', async t => {
  const f = collectorFixture(t);
  f.publish('1.0.0',f.first,'2025-12-30T00:00:00.000Z');
  f.refs.set('1.0.0',f.second);
  assert.equal((await collectPublicationHistory(f.args)).floor.sourceSha,f.second);
  f.refs.delete('1.0.0'); delete f.data.versions['1.0.0'].gitHead;
  assert.equal((await collectPublicationHistory(f.args)).floor.sourceSha,f.second);
});

test('collector still enforces the version floor for superseded publications', async t => {
  const f = collectorFixture(t);
  f.publish('1.9.0',f.first,'2025-12-30T00:00:00.000Z');
  await assert.rejects(collectPublicationHistory(f.args), /candidate version.*1\.9\.0/);
});

test('collector rejects a mismatch at the older channel floor', async t => {
  const f = collectorFixture(t);
  f.refs.set('1.0.1-preview.20260101.1',f.second);
  await assert.rejects(collectPublicationHistory(f.args), /tag.*gitHead/i);
});

test('collector rejects an npm-only publication newer than the older channel floor', async t => {
  const f = collectorFixture(t);
  f.publish('1.0.0',f.first,'2026-01-01T12:00:00.000Z',false);
  await assert.rejects(collectPublicationHistory(f.args), /npm-only.*receipt/i);
});

test('collector refuses an arbitrary legacy mapping even with a future baseline', async t => {
  const f = collectorFixture(t);
  f.git('checkout','-q','--detach',f.first);
  const divergent = f.commit('divergent preview');
  f.git('checkout','-q','--detach',f.candidate);
  const future = f.commit('future baseline');
  const preview = '1.0.1-preview.20260101.1';
  f.data.versions[preview].gitHead = divergent; f.refs.set(preview,divergent);
  const mappings = [{version:preview,legacySha:divergent,devSha:future},{version:'1.0.1',legacySha:f.second,devSha:future}];
  await assert.rejects(collectPublicationHistory({...f.args,mappings}), /lineage|baseline|ancestor/i);
});

test('collector accepts a candidate that merges both independently verified channel sources', async t => {
  const f = collectorFixture(t);
  f.git('checkout','-q','--detach',f.first);
  const divergent = f.commit('divergent preview');
  f.git('checkout','-q','--detach',f.candidate);
  f.git('-c','user.name=Test','-c','user.email=test@localhost','merge','--no-ff','-qm','merge preview',divergent);
  const merged = f.git('rev-parse','HEAD');
  f.control.devSha = merged;
  const preview = '1.0.1-preview.20260101.1';
  f.data.versions[preview].gitHead = divergent; f.refs.set(preview,divergent);
  const result = await collectPublicationHistory({...f.args,candidateSha:merged});
  assert.equal(result.floor.sourceSha,f.second);
});

test('collector refuses unknown publication order even for old versions', async t => {
  const f = collectorFixture(t);
  f.publish('1.0.0',f.first,'2025-12-30T00:00:00.000Z');
  delete f.data.time['1.0.0'];
  await assert.rejects(collectPublicationHistory(f.args), /publication time/);
});

test('collector reads all GitHub tag pages on both snapshots', async t => {
  const f = collectorFixture(t);
  let pageTwo = 0;
  const paginatedFetch = async (url, options) => {
    const u = new URL(url);
    if (u.hostname === 'api.github.com' && u.pathname.endsWith('/tags')) {
      const real = [...f.refs].map(([v,sha]) => ({name:`v${v}`,commit:{sha}}));
      const filler = Array.from({length:99},(_,i) => ({name:`archive-${i}`,commit:{sha:f.first}}));
      const combined = [...real,...filler];
      const page = Number(u.searchParams.get('page'));
      if (page === 2) pageTwo++;
      return Response.json(combined.slice((page-1)*100,page*100));
    }
    return f.fetchImpl(url,options);
  };
  await collectPublicationHistory({...f.args,fetchImpl:paginatedFetch});
  assert.equal(pageTwo,2);
});

test('collector permits preview to stable on the identical source', async t => {
  const f = collectorFixture(t);
  delete f.data.versions['1.0.1']; delete f.data.time['1.0.1']; delete f.data['dist-tags'].latest; f.refs.delete('1.0.1');
  const result = await collectPublicationHistory({...f.args,candidateSha:f.first,candidateVersion:'1.0.1'});
  assert.equal(result.floor.sourceSha,f.first);
});

test('collector rejects GitHub API failures and requires authentication', async t => {
  const f = collectorFixture(t);
  await assert.rejects(collectPublicationHistory({...f.args,token:''}), /GH_TOKEN/);
  const fetchImpl = async (url, options) => new URL(url).pathname.endsWith('/tags') ? new Response('',{status:403}) : f.fetchImpl(url,options);
  await assert.rejects(collectPublicationHistory({...f.args,fetchImpl}), /GitHub evidence request failed \(403\)/);
});

test('fixed stable and preview legacy trees differ from dev baseline only by verified version values', () => {
  const baseline = '0627a2c255bc239d5748119f1d0bc4457a1c03e3';
  for (const [sourceSha,sourceVersion] of [['667662903a6c139524506667d12656d9ad50fad0','2.99.0'],['68eee1eb804445ad86fe942b734060f323eb1517','2.99.0-preview.20261108']]) {
    assert.equal(verifyLegacyTreeEvidence({repoPath:resolve(__dirname,'../..'),sourceSha,baselineSha:baseline,sourceVersion,baselineVersion:'2.100.0',candidateSha:baseline,devSha:baseline}),true);
  }
});

test('collector verifies both fixed legacy sources and refuses a forged legacy SHA', async t => {
  const f = collectorFixture(t);
  const baseline = '0627a2c255bc239d5748119f1d0bc4457a1c03e3';
  const stable = '667662903a6c139524506667d12656d9ad50fad0', preview = '68eee1eb804445ad86fe942b734060f323eb1517';
  f.data.versions = {}; f.data.time = {}; f.refs.clear(); f.control.devSha = baseline;
  f.publish('2.99.0-preview.20261108',preview,'2026-01-01T00:00:00.000Z');
  f.publish('2.99.0',stable,'2026-01-02T00:00:00.000Z');
  f.data['dist-tags'] = {preview:'2.99.0-preview.20261108',latest:'2.99.0'};
  const args = {...f.args,repoPath:resolve(__dirname,'../..'),candidateSha:baseline,candidateVersion:'2.100.0'};
  assert.equal((await collectPublicationHistory(args)).floor.sourceSha,stable);
  f.data.versions['2.99.0'].gitHead = baseline; f.refs.set('2.99.0',baseline);
  await assert.rejects(collectPublicationHistory(args), /fixed expected SHA/);
});

test('legacy tree evidence rejects other changes, wrong version values, and an uncontained baseline', t => {
  const dir = mkdtempSync(join(tmpdir(),'ocx-legacy-evidence-'));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const git = (...args) => execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q'); mkdirSync(join(dir,'desktop/src-tauri'),{recursive:true});
  const write = (version,extra = '') => {
    writeFileSync(join(dir,'package.json'),JSON.stringify({name:'fixture',version})+'\n');
    writeFileSync(join(dir,'desktop/src-tauri/tauri.conf.json'),JSON.stringify({version})+'\n');
    writeFileSync(join(dir,'desktop/src-tauri/Cargo.toml'),`[package]\nname = "opencodex-desktop"\nversion = "${version}"\n${extra}`);
    writeFileSync(join(dir,'desktop/src-tauri/Cargo.lock'),`[[package]]\nname = "opencodex-desktop"\nversion = "${version}"\n`);
  };
  const commit = msg => {git('add','.');git('-c','user.name=Test','-c','user.email=test@localhost','commit','-qm',msg);return git('rev-parse','HEAD');};
  write('1.0.0'); const sourceSha = commit('source');
  write('1.1.0'); const baselineSha = commit('baseline');
  const args = {repoPath:dir,sourceSha,baselineSha,sourceVersion:'1.0.0',baselineVersion:'1.1.0',candidateSha:baselineSha,devSha:baselineSha};
  assert.equal(verifyLegacyTreeEvidence(args),true);
  assert.throws(() => verifyLegacyTreeEvidence({...args,sourceVersion:'1.0.1'}), /version/);
  assert.throws(() => verifyLegacyTreeEvidence({...args,candidateSha:sourceSha}), /baseline.*candidate/i);
  assert.throws(() => verifyLegacyTreeEvidence({...args,devSha:sourceSha}), /baseline.*dev/i);
  write('1.1.0','description = "unexpected"\n'); const changedFile = commit('other content');
  assert.throws(() => verifyLegacyTreeEvidence({...args,baselineSha:changedFile,candidateSha:changedFile,devSha:changedFile}), /version|content/i);
  writeFileSync(join(dir,'extra.txt'),'unexpected\n'); const extraPath = commit('extra path');
  assert.throws(() => verifyLegacyTreeEvidence({...args,baselineSha:extraPath,candidateSha:extraPath,devSha:extraPath}), /paths|diff/i);
});
