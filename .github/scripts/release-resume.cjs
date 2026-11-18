#!/usr/bin/env node
'use strict';

// The operator attests that this version was published from this source.
// Registry metadata and GitHub state are consistency checks, not provenance.
// Call from trusted workflow code with the release lock held; repeat immediately
// before release creation and asset attachment. This helper never publishes npm.
// Asset receipts must come from the trusted verify-release job in this workflow;
// this helper does not authenticate an arbitrary receipt file.
const { lstatSync, readFileSync } = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const { compareVersions } = require('./release-history.cjs');
const REPO = 'lidge-jun/opencodex';
const PACKAGE = '@bitkyc08/opencodex';
const API = `https://api.github.com/repos/${REPO}`;
const REGISTRY = 'https://registry.npmjs.org/%40bitkyc08%2Fopencodex';
const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview\.\d{8}\.\d+)?$/;
function must(condition, message) { if (!condition) throw new Error(message); }
function timestamp(value) {
  const time = Date.parse(value);
  must(typeof value === 'string' && Number.isFinite(time) && new Date(time).toISOString() === value, 'invalid npm publication time');
  return time;
}
async function requestJson(fetchImpl,url,token,allow404 = false) {
  const github = url.startsWith(API + '/');
  must(github || url === REGISTRY, 'unexpected evidence endpoint');
  let response;
  try {
    response = await fetchImpl(url,{headers:github ? {Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'} : {Accept:'application/json'},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)});
  } catch { throw new Error('evidence request failed'); }
  if (allow404 && response.status === 404) return null;
  must(response.ok, `evidence request failed (${response.status})`);
  const length = response.headers.get('content-length');
  must(!length || (/^\d+$/.test(length) && Number(length) <= 20*1024*1024), 'evidence too large');
  let size = 0; const chunks = [];
  must(response.body, 'empty evidence response');
  for await (const chunk of response.body) { size += chunk.length; must(size <= 20*1024*1024, 'evidence too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks,size).toString('utf8')); }
  catch { throw new Error('invalid JSON evidence'); }
}
async function pages(fetchImpl,token,path) {
  const result=[];
  for (let page=1;page<=100;page++) {
    const list=await requestJson(fetchImpl,`${API}/${path}?per_page=100&page=${page}`,token);
    must(Array.isArray(list) && list.length<=100, 'invalid GitHub pagination');
    result.push(...list);
    if (list.length<100) return result;
  }
  throw new Error('GitHub pagination limit exceeded');
}
function registryCheck(data,version,sourceSha,now) {
  must(data?.name===PACKAGE && data.versions && typeof data.versions==='object' && !Array.isArray(data.versions) && data.time && typeof data.time==='object' && data['dist-tags'] && typeof data['dist-tags']==='object' && !Array.isArray(data['dist-tags']), 'invalid npm history');
  const entries=Object.entries(data.versions);
  must(entries.length>0 && entries.length<=10000 && Object.hasOwn(data.versions,version), 'npm version is missing');
  const published=timestamp(data.time[version]); must(published<=now,'future npm publication');
  for (const [v,metadata] of entries) {
    must(metadata?.name===PACKAGE && metadata.version===v, 'invalid npm version identity');
    const time=timestamp(data.time[v]);
    must(time<=now && (v===version || time<published), 'newer or ambiguous npm publication floor');
    must(compareVersions(v,version)<=0, 'newer npm version floor');
  }
  for (const value of Object.values(data['dist-tags'])) must(typeof value==='string' && Object.hasOwn(data.versions,value), 'unknown npm dist-tag');
  must(data.versions[version].gitHead===sourceSha, 'npm gitHead mismatch');
}
function tagCheck(tags,version,sourceSha) {
  let found=false; const seen=new Set();
  for (const tag of tags) {
    must(typeof tag?.name==='string' && !seen.has(tag.name) && SHA.test(tag.commit?.sha || ''), 'unknown or duplicate git tag');
    seen.add(tag.name);
    if (!/^v\d/.test(tag.name)) continue;
    const v=tag.name.slice(1);
    must(compareVersions(v,version)<=0, 'newer git tag floor');
    if (v===version) { must(tag.commit.sha===sourceSha, 'git tag source mismatch'); found=true; }
  }
  return found;
}
function checkAssets(receipt,release,assets,version,sourceSha) {
  must(receipt && receipt.version===version && receipt.sha===sourceSha && receipt.repo===REPO && receipt.assets && typeof receipt.assets==='object' && !Array.isArray(receipt.assets), 'verified asset receipt mismatch');
  const expected=receipt.assets, names=Object.keys(expected), seen=new Set();
  must(names.length>0, 'empty verified asset receipt');
  for (const name of names) must(name && name!=='.' && name!=='..' && !/[\x00-\x1f\x7f/\\]/.test(name) && DIGEST.test(expected[name]), 'invalid verified asset receipt');
  for (const asset of assets) {
    must(asset && typeof asset.name==='string' && !seen.has(asset.name) && Object.hasOwn(expected,asset.name) && asset.state==='uploaded' && asset.digest===`sha256:${expected[asset.name]}`, 'existing release asset mismatch');
    seen.add(asset.name);
  }
  const missing=names.filter(name=>!seen.has(name)).sort();
  must(!release || release.draft || missing.length===0, 'published release missing verified assets');
  return {reuseAssets:[...seen].sort(),missingAssets:missing};
}
async function collectResumeDecision({version,sourceSha,channel,token,fetchImpl=fetch,now=Date.now,assetReceipt}) {
  must(typeof version==='string' && VERSION.test(version) && SHA.test(sourceSha || '') && channel===(version.includes('-')?'preview':'stable'), 'explicit version, source and matching channel are required');
  must(typeof token==='string' && token.length>0 && typeof fetchImpl==='function', 'GH_TOKEN is required');
  const clock=now(); must(Number.isFinite(clock), 'invalid clock');
  const read=async()=> {
    const [registry,tags,release]=await Promise.all([
      requestJson(fetchImpl,REGISTRY,token),pages(fetchImpl,token,'tags'),
      requestJson(fetchImpl,`${API}/releases/tags/v${version}`,token,true),
    ]);
    registryCheck(registry,version,sourceSha,clock);
    const tagExists=tagCheck(tags,version,sourceSha);
    if (release!==null) must(Number.isSafeInteger(release.id) && release.id>0 && release.tag_name===`v${version}` && typeof release.draft==='boolean' && release.prerelease===(channel==='preview'), 'invalid GitHub release evidence');
    const assets=assetReceipt!==undefined && release ? await pages(fetchImpl,token,`releases/${release.id}/assets`) : [];
    return {registry,tags,release,assets,tagExists};
  };
  const first=await read(), second=await read();
  must(isDeepStrictEqual(first,second), 'publication evidence changed while checking');
  const result={version,sourceSha,channel,publishNpm:false,tagExists:first.tagExists,releaseExists:first.release!==null,assetsChecked:assetReceipt!==undefined};
  if (assetReceipt!==undefined) Object.assign(result,checkAssets(assetReceipt,first.release,first.assets,version,sourceSha));
  return result;
}
async function main() {
  const [command,version,sourceSha,channel,receiptPath,...extra]=process.argv.slice(2);
  must((command==='check' && !receiptPath && !extra.length) || (command==='check-assets' && receiptPath && !extra.length), 'usage: release-resume.cjs check <version> <source-sha> <stable|preview> | check-assets <version> <source-sha> <stable|preview> <verified-receipt.json>');
  let assetReceipt;
  if (command==='check-assets') {
    const stat=lstatSync(receiptPath); must(stat.isFile() && !stat.isSymbolicLink() && stat.size<=1024*1024, 'invalid verified receipt file');
    assetReceipt=JSON.parse(readFileSync(receiptPath,'utf8'));
  }
  const result=await collectResumeDecision({version,sourceSha,channel,token:process.env.GH_TOKEN,assetReceipt});
  process.stdout.write(JSON.stringify(result)+'\n');
}
if (require.main===module) main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={collectResumeDecision};
