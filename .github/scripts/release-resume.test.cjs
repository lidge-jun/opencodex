'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { collectResumeDecision } = require('./release-resume.cjs');
const packageName = '@bitkyc08/opencodex', sourceSha = 'a'.repeat(40), version = '2.100.1';
const assetDigest = 'b'.repeat(64);
function fixture() {
  const data = {
    registry:{name:packageName,versions:{[version]:{name:packageName,version,gitHead:sourceSha}},time:{[version]:'2026-01-01T00:00:00.000Z'},'dist-tags':{latest:version}},
    tags:[{name:`v${version}`,commit:{sha:sourceSha}}],
    release:null,
    receipt:{version,sha:sourceSha,repo:'lidge-jun/opencodex',assets:{'ocx.zip':assetDigest}},
  };
  const fetchImpl = async (url,options) => {
    assert.equal(options.method,undefined);
    if (url === 'https://registry.npmjs.org/%40bitkyc08%2Fopencodex') { assert.equal(options.headers.Authorization,undefined); return Response.json(data.registry); }
    assert.equal(options.headers.Authorization,'Bearer token');
    if (url.endsWith('/tags?per_page=100&page=1')) return Response.json(data.tags);
    if (url.endsWith(`/releases/tags/v${version}`)) return data.release === null ? new Response('',{status:404}) : Response.json(data.release);
    if (url.endsWith('/releases/99/assets?per_page=100&page=1')) return Response.json(data.release.assets);
    throw Error(`unexpected URL ${url}`);
  };
  return {data,args:{version,sourceSha,channel:'stable',token:'token',fetchImpl,now:()=>Date.parse('2026-01-02T00:00:00Z')}};
}
test('explicit attested version and source produce a resume decision without npm publication', async () => {
  const f=fixture();
  assert.deepEqual(await collectResumeDecision(f.args),{version,sourceSha,channel:'stable',publishNpm:false,tagExists:true,releaseExists:false,assetsChecked:false});
});
test('missing tag is allowed but wrong or unknown metadata is rejected', async () => {
  const f=fixture(); f.data.tags=[];
  assert.equal((await collectResumeDecision(f.args)).tagExists,false);
  for (const change of [
    f=>f.data.registry.versions[version].gitHead='c'.repeat(40),
    f=>delete f.data.registry.versions[version],
    f=>f.data.registry.versions[version].version='2.100.0',
    f=>f.data.tags[0].commit.sha='c'.repeat(40),
    f=>f.data.tags[0].commit.sha=null,
    f=>delete f.data.registry.time[version],
    f=>f.args.channel='preview',
    f=>f.args.sourceSha='',
  ]) { const x=fixture(); change(x); await assert.rejects(collectResumeDecision(x.args)); }
});
test('newer npm publication or git tag blocks rollback', async () => {
  for (const change of [
    f=>{f.data.registry.versions['2.100.2']={name:packageName,version:'2.100.2',gitHead:'c'.repeat(40)}; f.data.registry.time['2.100.2']='2026-01-01T01:00:00.000Z';},
    f=>{f.data.registry.versions['2.100.0']={name:packageName,version:'2.100.0',gitHead:'c'.repeat(40)}; f.data.registry.time['2.100.0']='2026-01-01T01:00:00.000Z';},
    f=>{f.data.tags.push({name:'v2.100.2',commit:{sha:sourceSha}});},
  ]) { const f=fixture(); change(f); await assert.rejects(collectResumeDecision(f.args),/floor|rollback/i); }
});
test('existing release assets can only be reused against a matching verified receipt', async () => {
  const f=fixture();
  f.data.release={id:99,tag_name:`v${version}`,draft:true,prerelease:false,assets:[{name:'ocx.zip',state:'uploaded',digest:`sha256:${assetDigest}`}]};
  const decision=await collectResumeDecision({...f.args,assetReceipt:f.data.receipt});
  assert.equal(decision.publishNpm,false); assert.deepEqual(decision.reuseAssets,['ocx.zip']); assert.deepEqual(decision.missingAssets,[]);
  f.data.release.assets[0].digest='sha256:'+'c'.repeat(64);
  await assert.rejects(collectResumeDecision({...f.args,assetReceipt:f.data.receipt}),/asset/i);
  f.data.release.assets[0].digest=`sha256:${assetDigest}`;
  await assert.rejects(collectResumeDecision({...f.args,assetReceipt:{...f.data.receipt,sha:'c'.repeat(40)}}),/receipt/i);
});
test('draft may upload missing verified assets; published release cannot be missing them', async () => {
  const f=fixture(); f.data.release={id:99,tag_name:`v${version}`,draft:true,prerelease:false,assets:[]};
  const result=await collectResumeDecision({...f.args,assetReceipt:f.data.receipt});
  assert.deepEqual(result.missingAssets,['ocx.zip']);
  f.data.release.draft=false;
  await assert.rejects(collectResumeDecision({...f.args,assetReceipt:f.data.receipt}),/missing/i);
});
test('unknown and duplicate release assets and changing registry evidence are rejected', async () => {
  const f=fixture();
  const asset={name:'ocx.zip',state:'uploaded',digest:`sha256:${assetDigest}`};
  f.data.release={id:99,tag_name:`v${version}`,draft:true,prerelease:false,assets:[asset,asset]};
  await assert.rejects(collectResumeDecision({...f.args,assetReceipt:f.data.receipt}),/asset/i);
  f.data.release.assets=[{...asset,name:'unknown.zip'}];
  await assert.rejects(collectResumeDecision({...f.args,assetReceipt:f.data.receipt}),/asset/i);
  const g=fixture(); let reads=0; const original=g.args.fetchImpl;
  g.args.fetchImpl=async (...args)=>{
    if (args[0].startsWith('https://registry.npmjs.org/') && ++reads===2) g.data.registry['dist-tags'].preview=version;
    return original(...args);
  };
  await assert.rejects(collectResumeDecision(g.args),/changed/i);
});
test('a newer tag on a later GitHub API page blocks resume', async () => {
  const f=fixture(), original=f.args.fetchImpl;
  f.args.fetchImpl=async (url,options)=>{
    if (url.endsWith('/tags?per_page=100&page=1')) return Response.json(Array.from({length:100},(_,i)=>({name:`old-${i}`,commit:{sha:sourceSha}})));
    if (url.endsWith('/tags?per_page=100&page=2')) return Response.json([{name:'v2.100.2',commit:{sha:sourceSha}}]);
    return original(url,options);
  };
  await assert.rejects(collectResumeDecision(f.args),/tag floor/);
});
test('CLI consumes explicit version and source and prints the no-publish decision', () => {
  const f=fixture(), dir=mkdtempSync(join(tmpdir(),'resume-cli-'));
  try {
    const fixturePath=join(dir,'fixture.json'), preload=join(dir,'preload.cjs');
    writeFileSync(fixturePath,JSON.stringify(f.data));
    writeFileSync(preload,`const d=require(${JSON.stringify(fixturePath)}); global.fetch=async (u,o)=>{if(o.method) throw Error('unexpected method'); if(u.startsWith('https://registry.npmjs.org/')) return Response.json(d.registry); if(u.includes('/tags?')) return Response.json(d.tags); if(u.includes('/releases/tags/')) return d.release ? Response.json(d.release) : new Response('',{status:404}); if(u.includes('/releases/99/assets?')) return Response.json(d.release.assets); throw Error('unexpected request');};`);
    const run=spawnSync(process.execPath,['--require',preload,join(__dirname,'release-resume.cjs'),'check',version,sourceSha,'stable'],{encoding:'utf8',env:{...process.env,GH_TOKEN:'token'}});
    assert.equal(run.status,0,run.stderr);
    assert.deepEqual(JSON.parse(run.stdout),{version,sourceSha,channel:'stable',publishNpm:false,tagExists:true,releaseExists:false,assetsChecked:false});
    f.data.release={id:99,tag_name:`v${version}`,draft:true,prerelease:false,assets:[{name:'ocx.zip',state:'uploaded',digest:`sha256:${assetDigest}`}]};
    writeFileSync(fixturePath,JSON.stringify(f.data));
    const receiptPath=join(dir,'receipt.json'); writeFileSync(receiptPath,JSON.stringify(f.data.receipt));
    const assets=spawnSync(process.execPath,['--require',preload,join(__dirname,'release-resume.cjs'),'check-assets',version,sourceSha,'stable',receiptPath],{encoding:'utf8',env:{...process.env,GH_TOKEN:'token'}});
    assert.equal(assets.status,0,assets.stderr);
    assert.deepEqual(JSON.parse(assets.stdout).reuseAssets,['ocx.zip']);
    const invalid=spawnSync(process.execPath,['--require',preload,join(__dirname,'release-resume.cjs'),'check',version,'','stable'],{encoding:'utf8',env:{...process.env,GH_TOKEN:'token'}});
    assert.equal(invalid.status,1); assert.equal(invalid.stdout,'');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
