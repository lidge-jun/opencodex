'use strict';

/*
 * The collector reads npm, authenticated GitHub and local Git under the release
 * lock. Callers MUST execute this file from the trusted workflow revision, with
 * a complete git checkout and repeat the check immediately before publication.
 * The API's fetchImpl injection is for trusted callers and tests only;
 * the CLI pins both endpoints, package/repository identity and mapping policy.
 * Decision primitives require complete, fresh evidence under the release
 * lock. isAncestor must
 * query complete Git history and throw on an unknown object. verifyReceipt and
 * verifyProvenance must cryptographically authenticate their inputs, bind the
 * supplied tuple, and return the literal boolean true. Neither JSON flags nor a
 * candidate-created Actions artifact are authentication. Never invoke these
 * functions with callbacks or evidence controlled by a dispatch input.
 *
 * reconcileHistory accepts registry versions {version,gitHead,publishedAt},
 * distTags, Git tag commits {version,sha}, GitHub releases {version,tag}, signed
 * receipt envelopes {payload}, candidateSha/candidateVersion/channel,
 * isAncestor and verifyReceipt. This primitive requires direct ancestry.
 * resume:true requires the candidate to be the already-published floor and an
 * authenticated receipt; it does not derive or approve a new version.
 * Input arrays must cover the entire reconciled ledger, including partial npm
 * publishes. A collector must separately detect pagination and snapshot races.
 *
 * verifyExactResume accepts tuple/receipt/registry/provenance/tag/release/historyFloor
 * plus verifyReceipt, verifyProvenance and verifyHistory. verifyHistory must
 * authenticate a fresh, complete, lock-protected reconciliation including all
 * npm-only publications. Receipt payload binds the complete tuple and
 * asset name-to-SHA256 map; registry.sha256 must be independently calculated
 * from downloaded registry tarball bytes. Existing assets are hashed from bytes.
 * A null tag/release means the authenticated GitHub lookup confirmed absence.
 * Publication orchestration must not call npm publish after a successful resume.
 */
const { verify, createPublicKey } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?)?$/;
const PACKAGE = '@bitkyc08/opencodex';
const REPO = 'lidge-jun/opencodex';
const REPO_ID = 1273824907;
// One-time legacy transition. The collector verifies the tag and registry SHA,
// both ancestry relationships and actual version-only tree differences at run
// time. This code-backed policy still needs independent review before cutover.
const LEGACY_MAPPINGS = Object.freeze([
  {version:'2.99.0',legacySha:'667662903a6c139524506667d12656d9ad50fad0'},
  {version:'2.99.0-preview.20261108',legacySha:'68eee1eb804445ad86fe942b734060f323eb1517'},
]);
const LEGACY_BASELINE = '0627a2c255bc239d5748119f1d0bc4457a1c03e3';
const LEGACY_BASELINE_VERSION = '2.100.0';
const VERSION_PATHS = Object.freeze(['package.json','desktop/src-tauri/tauri.conf.json','desktop/src-tauri/Cargo.toml','desktop/src-tauri/Cargo.lock']);

function must(condition, message) { if (!condition) throw new Error(message); }
function version(v) {
  const m = typeof v === 'string' && VERSION.exec(v);
  must(m, 'invalid release version');
  const numbers = m.slice(1).map(x => x === undefined ? null : Number(x));
  must(numbers.every(x => x === null || Number.isSafeInteger(x)), 'invalid release version');
  return numbers;
}
function compareVersions(a, b) {
  const x = version(a), y = version(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  if (x[3] === null || y[3] === null) return x[3] === y[3] ? 0 : x[3] === null ? 1 : -1;
  for (let i = 3; i < 5; i++) {
    if (x[i] !== y[i]) return x[i] === null ? -1 : y[i] === null ? 1 : x[i] < y[i] ? -1 : 1;
  }
  return 0;
}
function channelFor(v) { return version(v)[3] === null ? 'stable' : 'preview'; }
function validTuple(t) {
  must(t && SHA.test(t.sourceSha || '') && SHA.test(t.workflowSha || '') && DIGEST.test(t.sha256 || '') &&
    Number.isSafeInteger(t.runId) && t.runId > 0 && Number.isSafeInteger(t.attempt) && t.attempt > 0 &&
    t.channel === channelFor(t.version), 'invalid receipt tuple');
  must(t.assets && typeof t.assets === 'object' && !Array.isArray(t.assets), 'invalid receipt assets');
  for (const [name, digest] of Object.entries(t.assets)) must(name && !/[\x00-\x1f/\\]/.test(name) && DIGEST.test(digest), 'invalid receipt asset');
}
function sameTuple(a, b) {
  validTuple(a); validTuple(b);
  return ['sourceSha','workflowSha','version','channel','sha256','runId','attempt'].every(k => a[k] === b[k]) &&
    Object.keys(a.assets).length === Object.keys(b.assets).length && Object.entries(a.assets).every(([k,v]) => Object.hasOwn(b.assets,k) && b.assets[k] === v);
}
function assertReceipt(envelope, expected, verifyReceipt) {
  must(envelope && typeof verifyReceipt === 'function' && verifyReceipt(envelope, expected) === true, 'receipt authentication failed');
  must(sameTuple(envelope.payload, expected), 'receipt tuple mismatch');
}
function reconcileHistory(input) {
  const {candidateSha, candidateVersion, channel, versions, distTags, tags, releases, receipts, isAncestor, verifyReceipt, resume = false} = input;
  must(typeof resume === 'boolean', 'invalid resume mode');
  must(SHA.test(candidateSha || '') && channel === channelFor(candidateVersion), 'invalid candidate');
  must([versions,tags,releases,receipts].every(Array.isArray) && distTags && typeof distTags === 'object' && !Array.isArray(distTags) && typeof isAncestor === 'function', 'incomplete history');
  const byVersion = new Map(), byTag = new Map(), byRelease = new Map(), byReceipt = new Map();
  for (const r of versions) {
    version(r?.version); must(!byVersion.has(r.version) && SHA.test(r.gitHead || ''), 'missing or duplicate registry source');
    const time = Date.parse(r.publishedAt);
    must(typeof r.publishedAt === 'string' && Number.isFinite(time) && new Date(time).toISOString() === r.publishedAt, 'missing publication order');
    byVersion.set(r.version, {...r,time});
  }
  for (const [name, v] of Object.entries(distTags)) { must(name && byVersion.has(v), 'unknown dist-tag version'); }
  for (const t of tags) { version(t?.version); must(!byTag.has(t.version) && SHA.test(t.sha || '') && byVersion.has(t.version), 'unknown or duplicate tag'); byTag.set(t.version,t); }
  for (const r of releases) { version(r?.version); must(!byRelease.has(r.version) && r.tag === `v${r.version}` && byTag.has(r.version), 'unknown or duplicate release'); byRelease.set(r.version,r); }
  for (const envelope of receipts) {
    const r = envelope?.payload; validTuple(r);
    must(!byReceipt.has(r.version) && byVersion.has(r.version), 'unknown or duplicate receipt');
    assertReceipt(envelope, r, verifyReceipt); byReceipt.set(r.version, r);
  }
  const ordered = [...byVersion.values()].sort((a,b) => a.time-b.time);
  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i], tag = byTag.get(r.version), receipt = byReceipt.get(r.version);
    if (i) must(ordered[i-1].time < r.time, 'ambiguous publication order');
    if (tag) must(tag.sha === r.gitHead, 'tag and registry source mismatch');
    if (receipt) must(receipt.sourceSha === r.gitHead && receipt.channel === channelFor(r.version), 'receipt and registry source mismatch');
    if (!tag || !byRelease.has(r.version)) must(receipt, 'npm-only publication requires authenticated receipt');
  }
  for (let i = 1; i < ordered.length; i++) must(isAncestor(ordered[i-1].gitHead,ordered[i].gitHead) === true, 'publication lineage diverges');
  if (ordered.length) {
    const floor = ordered.at(-1);
    if (resume) {
      must(candidateVersion === floor.version && candidateSha === floor.gitHead && byReceipt.has(floor.version), 'resume would roll back or lacks a receipt');
    } else {
      must(ordered.every(r => compareVersions(candidateVersion, r.version) > 0), 'candidate version would regress or already exists');
      must(isAncestor(floor.gitHead,candidateSha) === true, 'candidate lineage would roll back or diverge');
      if (candidateSha === floor.gitHead) must(channel === 'stable' && channelFor(floor.version) === 'preview', 'same source only allowed for preview to stable');
    }
    return {floor:{version:floor.version,sourceSha:floor.gitHead,publishedAt:floor.publishedAt}};
  }
  must(!resume, 'resume requires published history');
  return {floor:null};
}
function verifyExactResume({tuple, receipt, registry, provenance, tag, release, historyFloor, verifyReceipt, verifyProvenance, verifyHistory}) {
  validTuple(tuple); assertReceipt(receipt, tuple, verifyReceipt);
  must(registry && registry.version === tuple.version && registry.gitHead === tuple.sourceSha && registry.sha256 === tuple.sha256, 'registry identity or digest mismatch');
  must(typeof verifyProvenance === 'function' && verifyProvenance(provenance, tuple, registry) === true, 'provenance authentication failed');
  must(typeof verifyHistory === 'function' && verifyHistory(historyFloor) === true && historyFloor?.version === tuple.version && historyFloor.sourceSha === tuple.sourceSha, 'resume would roll back publication history');
  must(tag === null || (tag && tag.name === `v${tuple.version}` && tag.sha === tuple.sourceSha), 'existing tag mismatch');
  must(release === null || (release && tag && release.tag === tag.name && Array.isArray(release.assets)), 'existing release mismatch');
  const reuseAssets = [], seen = new Set();
  for (const asset of release?.assets || []) {
    must(asset && typeof asset.name === 'string' && !seen.has(asset.name) && Object.hasOwn(tuple.assets,asset.name) && DIGEST.test(asset.sha256 || '') && tuple.assets[asset.name] === asset.sha256, 'unsafe existing asset');
    seen.add(asset.name); reuseAssets.push(asset.name);
  }
  return {publishNpm:false, reuseAssets:reuseAssets.sort()};
}

function createGit(repoPath) {
  function run(args, allowNotAncestor = false, trim = true) {
    const r = spawnSync('git', ['-C',repoPath,...args], {encoding:'utf8',maxBuffer:1024*1024,env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1'},stdio:['ignore','pipe','pipe']});
    if (allowNotAncestor && r.status === 1) return false;
    must(r.status === 0, `Git could not verify ${args[0]}; fetch complete dev and tag history`);
    return trim ? r.stdout.trim() : r.stdout;
  }
  must(run(['rev-parse','--is-shallow-repository']) === 'false', 'Git history is shallow; fetch complete history');
  const known = new Set(), comparisons = new Map();
  function commit(sha) {
    must(SHA.test(sha || ''), 'invalid Git source SHA');
    if (!known.has(sha)) {
      try { run(['cat-file','-e',`${sha}^{commit}`]); }
      catch { throw new Error(`Git source ${sha} is unavailable; fetch complete release and dev history and reconcile unknown sources`); }
      known.add(sha);
    }
  }
  function isAncestor(a,b) {
    commit(a); commit(b);
    const key = `${a}:${b}`;
    if (!comparisons.has(key)) comparisons.set(key, run(['merge-base','--is-ancestor',a,b],true) !== false);
    return comparisons.get(key);
  }
  function treeFile(sha,path) {
    commit(sha);
    const entry = run(['ls-tree',sha,'--',path]);
    must(/^100644 blob [a-f0-9]{40}\t/.test(entry) && entry.endsWith(`\t${path}`), `legacy version file ${path} is missing or has an unsafe mode`);
    const text = run(['show',`${sha}:${path}`],false,false);
    must(!text.includes('\ufffd'), `legacy version file ${path} is not valid UTF-8`);
    return text;
  }
  function changedPaths(a,b) {
    commit(a); commit(b);
    const output = run(['diff','--no-ext-diff','--no-renames','--name-status','-z',a,b,'--'],false,false);
    const fields = output.split('\0');
    must(fields.pop() === '' && fields.length % 2 === 0, 'invalid legacy tree diff');
    const paths = [];
    for (let i=0;i<fields.length;i+=2) { must(fields[i] === 'M', 'legacy tree diff contains a non-modified path'); paths.push(fields[i+1]); }
    return paths;
  }
  return {commit,isAncestor,treeFile,changedPaths};
}

function normalizeVersionFile(path,text,expected) {
  if (path.endsWith('.json')) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error(`invalid legacy version JSON in ${path}`); }
    must(parsed && parsed.version === expected, `legacy version mismatch in ${path}`);
    const matches = [...text.matchAll(/("version"\s*:\s*")([^"\\]*)(")/g)];
    must(matches.length === 1 && matches[0][2] === expected, `ambiguous legacy version in ${path}`);
    const index = matches[0].index + matches[0][1].length;
    return text.slice(0,index) + '__OCX_VERSION__' + text.slice(index+expected.length);
  }
  const lines = text.split('\n');
  let indexes;
  if (path.endsWith('Cargo.toml')) {
    const starts = lines.map((line,i) => line.trim() === '[package]' ? i : -1).filter(i => i >= 0);
    must(starts.length === 1, `ambiguous package version in ${path}`);
    let end = starts[0] + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    must(lines.slice(starts[0]+1,end).filter(line => /^\s*name\s*=\s*"opencodex-desktop"\s*$/.test(line)).length === 1, `invalid desktop package in ${path}`);
    indexes = lines.map((line,i) => i > starts[0] && i < end && /^\s*version\s*=/.test(line) ? i : -1).filter(i => i >= 0);
  } else {
    indexes = [];
    for (let i=0;i+2<lines.length;i++) if (lines[i].trim() === '[[package]]' && lines[i+1].trim() === 'name = "opencodex-desktop"') indexes.push(i+2);
  }
  must(indexes.length === 1, `ambiguous legacy version in ${path}`);
  const match = /^(\s*version\s*=\s*")([^"\\]*)("\s*\r?)$/.exec(lines[indexes[0]]);
  must(match && match[2] === expected, `legacy version mismatch in ${path}`);
  lines[indexes[0]] = `${match[1]}__OCX_VERSION__${match[3]}`;
  return lines.join('\n');
}

// Generic verifier for testing; only the fixed policy below can invoke it from
// the collector. No candidate-controlled policy or attestation is accepted.
function verifyLegacyTreeEvidence({repoPath,sourceSha,baselineSha,sourceVersion,baselineVersion,candidateSha,devSha}) {
  const git = createGit(repoPath);
  must(git.isAncestor(baselineSha,candidateSha), 'legacy baseline is not contained in candidate');
  must(git.isAncestor(baselineSha,devSha), 'legacy baseline is not contained in dev');
  const actual = git.changedPaths(sourceSha,baselineSha).sort();
  must(isDeepStrictEqual(actual,[...VERSION_PATHS].sort()), 'legacy tree diff does not contain exactly the four version paths');
  for (const path of VERSION_PATHS) {
    const before = normalizeVersionFile(path,git.treeFile(sourceSha,path),sourceVersion);
    const after = normalizeVersionFile(path,git.treeFile(baselineSha,path),baselineVersion);
    must(before === after, `legacy version file ${path} contains other content changes`);
  }
  return true;
}

async function requestJson(fetchImpl, url, token, allow404 = false) {
  const github = url.startsWith(`https://api.github.com/repos/${REPO}`);
  must(github || url === 'https://registry.npmjs.org/%40bitkyc08%2Fopencodex', 'unexpected evidence endpoint');
  const headers = {Accept:'application/json','Cache-Control':'no-cache'};
  if (github) { headers.Authorization = `Bearer ${token}`; headers.Accept = 'application/vnd.github+json'; headers['X-GitHub-Api-Version'] = '2022-11-28'; }
  let response;
  try { response = await fetchImpl(url,{headers,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)}); }
  catch { throw new Error(`cannot read ${github ? 'GitHub' : 'npm registry'} evidence`); }
  if (allow404 && response.status === 404) return null;
  must(response.ok, `${github ? 'GitHub' : 'npm registry'} evidence request failed (${response.status})`);
  const length = response.headers.get('content-length');
  must(!length || Number(length) <= 20 * 1024 * 1024, 'evidence response exceeds size limit');
  const body = await response.text();
  must(Buffer.byteLength(body) <= 20 * 1024 * 1024, 'evidence response exceeds size limit');
  try { return JSON.parse(body); } catch { throw new Error('invalid evidence JSON'); }
}
async function githubPages(fetchImpl, token, path) {
  const result = [];
  for (let page = 1; page <= 100; page++) {
    const list = await requestJson(fetchImpl, `https://api.github.com/repos/${REPO}/${path}?per_page=100&page=${page}`,token);
    must(Array.isArray(list) && list.length <= 100, `invalid GitHub ${path} pagination`);
    result.push(...list);
    if (list.length < 100) return result;
  }
  throw new Error(`GitHub ${path} pagination exceeds limit`);
}
function registrySnapshot(data) {
  must(data?.name === PACKAGE && data.versions && typeof data.versions === 'object' && !Array.isArray(data.versions) && data.time && typeof data.time === 'object' && data['dist-tags'] && typeof data['dist-tags'] === 'object', 'invalid npm package history');
  const entries = Object.entries(data.versions);
  must(entries.length > 0 && entries.length <= 10000, 'empty or oversized npm history requires reconciliation');
  const versions = entries.map(([v,metadata]) => {
    version(v);
    must(metadata?.name === PACKAGE && metadata.version === v, `npm ${v} has invalid package identity`);
    const publishedAt = data.time[v], time = Date.parse(publishedAt);
    must(typeof publishedAt === 'string' && Number.isFinite(time) && new Date(time).toISOString() === publishedAt, `npm ${v} has missing publication time`);
    return {version:v,gitHead:metadata.gitHead ?? null,publishedAt,time};
  }).sort((a,b) => a.time-b.time);
  for (let i=1;i<versions.length;i++) must(versions[i-1].time !== versions[i].time, `ambiguous npm publication order: ${versions[i-1].version}, ${versions[i].version}`);
  const tags = data['dist-tags'];
  for (const [key,value] of Object.entries(tags)) must(key && versions.some(r => r.version === value), `npm dist-tag ${key} names unknown version`);
  if (tags.latest) must(channelFor(tags.latest) === 'stable', 'npm latest dist-tag is not stable');
  if (tags.preview) must(channelFor(tags.preview) === 'preview', 'npm preview dist-tag is not preview');
  return {versions,distTags:Object.fromEntries(Object.entries(tags).sort(([a],[b]) => a.localeCompare(b)))};
}
function githubSnapshot(tags, releases) {
  const tagMap = new Map(), releaseMap = new Map();
  for (const tag of tags) {
    must(typeof tag?.name === 'string' && SHA.test(tag.commit?.sha || '') && !tagMap.has(tag.name), 'duplicate or malformed GitHub tag');
    tagMap.set(tag.name,tag.commit.sha);
  }
  for (const release of releases) {
    must(typeof release?.tag_name === 'string' && typeof release.draft === 'boolean' && typeof release.prerelease === 'boolean' && !releaseMap.has(release.tag_name), 'duplicate or malformed GitHub release');
    releaseMap.set(release.tag_name,{draft:release.draft,prerelease:release.prerelease,published_at:release.published_at});
  }
  return {tagMap,releaseMap};
}
/**
 * Read-only history gate. GH_TOKEN needs repository contents:read. Invoke from
 * trusted workflow checkout with full Git history after acquiring the shared
 * release lock: `node .github/scripts/release-history.cjs check <sourceSha>
 * <version> <stable|preview>`. Exit 0 returns JSON {floor,channels,devSha,
 * versionsChecked}; any unverifiable evidence exits nonzero. Publications at
 * or after the older channel head without a matching tag and published release
 * stop for manual reconciliation; no receipt/provenance verifier is assumed.
 * Older versions still participate in the global version and ordering checks.
 * Re-run immediately before publication. This gate does not authorize
 * npm publication or prove build, CI, package digest, provenance, or resume.
 */
async function collectPublicationHistory({candidateSha,candidateVersion,channel,repoPath = process.cwd(),token,fetchImpl = fetch}) {
  must(typeof token === 'string' && token.length > 0 && typeof fetchImpl === 'function', 'GH_TOKEN is required for authenticated GitHub evidence');
  must(SHA.test(candidateSha || '') && channel === channelFor(candidateVersion), 'invalid candidate source, version or channel');
  const git = createGit(repoPath), base = `https://api.github.com/repos/${REPO}`;
  const get = (path,allow404) => requestJson(fetchImpl,base+path,token,allow404);
  const readNpm = async () => registrySnapshot(await requestJson(fetchImpl,'https://registry.npmjs.org/%40bitkyc08%2Fopencodex',token));
  const [repo,dev,npm,tags,releases] = await Promise.all([get(''),get('/commits/dev'),readNpm(),githubPages(fetchImpl,token,'tags'),githubPages(fetchImpl,token,'releases')]);
  must(repo?.id === REPO_ID && repo.full_name === REPO, 'GitHub repository identity mismatch');
  must(SHA.test(dev?.sha || '') && git.isAncestor(candidateSha,dev.sha), 'candidate is not reachable from GitHub dev');
  const gh = githubSnapshot(tags,releases);
  const channels = ['preview','stable'].map(c => npm.versions.filter(r => channelFor(r.version) === c).at(-1)).filter(Boolean).sort((a,b) => a.time-b.time);
  const cutoff = channels[0].time;
  for (const r of npm.versions.filter(r => r.time >= cutoff)) {
    const tag = gh.tagMap.get(`v${r.version}`), release = gh.releaseMap.get(`v${r.version}`);
    must(SHA.test(r.gitHead || ''), `npm ${r.version} has missing or invalid gitHead; reconcile publication source`);
    must(tag, `npm-only publication ${r.version} (${r.gitHead}) has no GitHub tag; authenticated prior receipt and provenance required for reconciliation`);
    must(tag === r.gitHead, `GitHub tag v${r.version} does not match npm gitHead`);
    must(release && !release.draft && release.prerelease === (channelFor(r.version) === 'preview') && Number.isFinite(Date.parse(release.published_at)), `npm publication ${r.version} lacks a published matching GitHub release; authenticated receipt and provenance required`);
  }
  for (const r of npm.versions) {
    must(compareVersions(candidateVersion,r.version) > 0, `candidate version ${candidateVersion} does not exceed published npm version ${r.version}`);
  }
  const selectedVersions = new Set(npm.versions.map(r => r.version));
  for (const [tag,release] of gh.releaseMap) {
    if (release.draft) continue;
    const published = Date.parse(release.published_at);
    must(Number.isFinite(published), `GitHub release ${tag} has no publication time`);
    if (published >= cutoff && tag.startsWith('v')) must(selectedVersions.has(tag.slice(1)), `GitHub release ${tag} has no matching npm version; reconcile partial publication`);
  }
  for (const r of channels) {
    const legacy = LEGACY_MAPPINGS.find(m => m.version === r.version);
    if (legacy) {
      must(r.gitHead === legacy.legacySha && gh.tagMap.get(`v${r.version}`) === legacy.legacySha, `legacy ${r.version} registry or tag source does not match the fixed expected SHA`);
      verifyLegacyTreeEvidence({repoPath,sourceSha:legacy.legacySha,baselineSha:LEGACY_BASELINE,sourceVersion:legacy.version,baselineVersion:LEGACY_BASELINE_VERSION,candidateSha,devSha:dev.sha});
    } else {
      must(git.isAncestor(r.gitHead,candidateSha), `candidate lineage does not include ${r.version} source ${r.gitHead}`);
    }
  }
  const newest = channels.at(-1);
  if (candidateSha === newest.gitHead) must(channel === 'stable' && channelFor(newest.version) === 'preview', 'same source only allowed for preview to stable');
  const result = {floor:{version:newest.version,sourceSha:newest.gitHead,publishedAt:newest.publishedAt}};
  const [npmAgain,devAgain,tagsAgain,releasesAgain] = await Promise.all([readNpm(),get('/commits/dev'),githubPages(fetchImpl,token,'tags'),githubPages(fetchImpl,token,'releases')]);
  const comparable = snapshot => JSON.stringify({tags:[...snapshot.tagMap].sort(),releases:[...snapshot.releaseMap].sort(([a],[b]) => a.localeCompare(b))});
  must(isDeepStrictEqual(npm,npmAgain) && devAgain?.sha === dev.sha && comparable(gh) === comparable(githubSnapshot(tagsAgain,releasesAgain)), 'publication evidence changed during collection; retry under the shared release lock');
  return {...result,channels:channels.map(({version,gitHead,publishedAt}) => ({version,sourceSha:gitHead,publishedAt})),devSha:dev.sha,versionsChecked:npm.versions.length};
}

// Ed25519 signatures authenticate raw bytes. The public key must come from a
// reviewed trusted policy, not an artifact, candidate checkout, or CLI input.
function verifyEd25519Receipt(bytes, signature, trustedPublicKey) {
  try {
    const key = createPublicKey(trustedPublicKey);
    return key.asymmetricKeyType === 'ed25519' && Buffer.isBuffer(bytes) && Buffer.isBuffer(signature) && verify(null, bytes, key, signature);
  }
  catch { return false; }
}
// Signed JSON has shape {payload,expiresAt}; the verifier rejects a changed
// parsed payload and requires a separate authenticated run/attempt lookup.
function createReceiptVerifier({publicKey, now, verifyRun}) {
  must(typeof now === 'function' && typeof verifyRun === 'function', 'receipt verification dependencies required');
  return (envelope, expected) => {
    try {
      if (!envelope || typeof envelope.signedBytes !== 'string' || typeof envelope.signature !== 'string') return false;
      const bytes = Buffer.from(envelope.signedBytes, 'base64');
      const signature = Buffer.from(envelope.signature, 'base64');
      if (!bytes.length || bytes.length > 1024 * 1024 || bytes.toString('base64') !== envelope.signedBytes || signature.toString('base64') !== envelope.signature ||
          !verifyEd25519Receipt(bytes, signature, publicKey)) return false;
      const signed = JSON.parse(bytes.toString('utf8'));
      const expires = Date.parse(signed.expiresAt), current = now();
      if (!Number.isFinite(expires) || !Number.isFinite(current) || expires <= current || !isDeepStrictEqual(signed.payload, envelope.payload) ||
          !sameTuple(signed.payload, expected)) return false;
      return verifyRun(signed.payload) === true;
    } catch { return false; }
  };
}
// check must run from the trusted workflow revision under the release lock.
// GH_TOKEN is read from the environment; output contains no credentials.
async function main(args) {
  const [command, first, second, third, ...extra] = args;
  if (command === 'check') {
    must(first && second && third && !extra.length, 'usage: release-history.cjs check <source-sha> <version> <stable|preview>');
    const result = await collectPublicationHistory({candidateSha:first,candidateVersion:second,channel:third,token:process.env.GH_TOKEN});
    process.stdout.write(`${JSON.stringify(result)}\n`); return;
  }
  must(command === 'verify-signature' && first && second && third && !extra.length, 'usage: release-history.cjs check <source-sha> <version> <stable|preview> | verify-signature <payload> <binary-signature> <trusted-public-key>');
  must(verifyEd25519Receipt(readFileSync(first), readFileSync(second), readFileSync(third)), 'receipt signature invalid');
  process.stdout.write('signature valid; publication evidence has not been checked\n');
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { process.stderr.write(`release history: ${error.message}\n`); process.exitCode = 1; });
module.exports = {compareVersions, reconcileHistory, verifyExactResume, verifyEd25519Receipt, createReceiptVerifier, collectPublicationHistory, verifyLegacyTreeEvidence, LEGACY_MAPPINGS, LEGACY_BASELINE};
