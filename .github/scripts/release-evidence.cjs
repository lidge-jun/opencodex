'use strict';

// Policy is loaded from the trusted release workflow revision, not the candidate.
// It pins the workflow, local setup action and enumerated CI job/test-selection
// helpers; it does not pin the candidate's whole source tree or every transitive
// test/build dependency. Those inputs, package scripts and repository writers are
// trusted through normal dev review. This is not a defence against a writer who
// can change trusted policy. Security review must assess that boundary separately.
// After reviewing an intentional policy-path change, update its Git blob ID in
// release-evidence-policy.json with `git hash-object --no-filters <path>`, then
// run `node .github/scripts/release-evidence.cjs policy-check` and the evidence
// tests. Retain old approved entries if historical revisions must remain usable.
const APPROVED_POLICIES = require('./release-evidence-policy.json');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { resolve } = require('node:path');
const REPOSITORY_ID = 1273824907;
const FULL_SHA = /^[0-9a-f]{40}$/;
const CI_JOBS = Object.freeze([
  'changes', 'select windows runner', 'storage policy', 'api usage', 'gates',
  ...Array.from({length: 5}, (_, i) => `test ${i + 1}/5`),
  ...Array.from({length: 4}, (_, i) => `macos ${i + 1}/4`),
  'macos control', ...Array.from({length: 11}, (_, i) => `windows ${i + 1}/11`),
  'keyring ubuntu', 'keyring windows', 'keyring macos', 'docker smoke',
  'docs site build', 'structure gate', 'macos widget + bundle', 'desktop shell',
  ...['ubuntu-latest', 'windows-latest', 'macos-latest'].flatMap(os => [
    `setup action ${os}`, `remote helper ${os}`, `npm-global ${os}`,
  ]), 'ci',
]);

function sha(value) {
  if (typeof value !== 'string' || !FULL_SHA.test(value)) throw new Error('expected full lowercase commit SHA');
  return value;
}
function serviceJobs(sourceSha) {
  sha(sourceSha);
  return ['validate source', ...['linux-systemd', 'macos-launchd', 'windows-schtasks'].map(n => `${n} ${sourceSha}`)];
}
function validateJobs(jobs, required) {
  if (!Array.isArray(jobs)) throw new Error('invalid jobs response');
  const seen = new Set();
  for (const job of jobs) {
    if (!job || typeof job.name !== 'string' || seen.has(job.name)) throw new Error('duplicate or malformed job');
    seen.add(job.name);
  }
  for (const name of required) {
    const job = jobs.find(j => j.name === name);
    if (!job || job.status !== 'completed' || job.conclusion !== 'success') throw new Error(`missing or unsuccessful job: ${name}`);
  }
  return true;
}
function apiClient(repository, token) {
  if (repository !== 'lidge-jun/opencodex' || typeof token !== 'string' || !token) throw new Error('expected GH_TOKEN and GITHUB_REPOSITORY=lidge-jun/opencodex');
  const prefix = `https://api.github.com/repos/${repository}`;
  return async path => {
    if (path !== '' && (!path.startsWith('/') || path.startsWith('//'))) throw new Error('invalid API path');
    const response = await fetch(prefix + path, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`GitHub API request failed (${response.status})`);
    return response.json();
  };
}
async function pages(api, path, key) {
  const collected = [];
  let total;
  for (let page = 1; ; page++) {
    const data = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!data || !Number.isSafeInteger(data.total_count) || data.total_count < 0 || !Array.isArray(data[key]) || data[key].length > 100) throw new Error('invalid paginated response');
    if (total === undefined) total = data.total_count;
    if (total !== data.total_count) throw new Error('pagination changed during lookup');
    collected.push(...data[key]);
    if (collected.length === total) return collected;
    if (!data[key].length || collected.length > total) throw new Error('incomplete pagination');
  }
}
async function treeEntry(api, commitSha, pathname) {
  const commit = await api(`/git/commits/${sha(commitSha)}`);
  let tree = commit?.tree?.sha;
  if (!FULL_SHA.test(tree || '')) throw new Error('invalid commit tree');
  const parts = pathname.split('/');
  for (let i = 0; i < parts.length; i++) {
    const data = await api(`/git/trees/${tree}`);
    if (data.truncated || !Array.isArray(data.tree)) throw new Error('incomplete tree');
    const matches = data.tree.filter(entry => entry.path === parts[i]);
    if (matches.length !== 1 || !FULL_SHA.test(matches[0].sha || '')) throw new Error('missing policy path');
    if (i === parts.length - 1) return matches[0];
    if (matches[0].type !== 'tree') throw new Error('invalid policy path');
    tree = matches[0].sha;
  }
  throw new Error('invalid policy path');
}
async function assertPolicy(api, run, kind, policies) {
  const candidates = policies.filter(p => p.kind === kind && p.version === 1 && p.files && typeof p.files === 'object');
  const workflowPath = `.github/workflows/${kind === 'ci' ? 'ci.yml' : 'service-lifecycle.yml'}`;
  for (const policy of candidates) {
    if (!Object.hasOwn(policy.files, workflowPath)) continue;
    let matches = true;
    for (const [path, expected] of Object.entries(policy.files)) {
      let entry;
      try { entry = await treeEntry(api, run.head_sha, path); }
      catch (error) {
        if (error.message === 'missing policy path') { matches = false; break; }
        throw error;
      }
      if (!FULL_SHA.test(expected) || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || entry.sha !== expected) { matches = false; break; }
    }
    if (matches) return;
  }
  throw new Error(`unapproved ${kind} workflow or helper policy`);
}
const SERVICE_PATH = /^(?:src\/service\.ts|src\/service\/.+|desktop\/.+|src\/cli\.ts|src\/cli\/index\.ts|src\/lib\/bun-runtime\.ts|package\.json|bun\.lock|\.github\/workflows\/service-lifecycle\.yml|\.github\/workflows\/release\.yml)$/;
function serviceChangeRequired(paths) {
  if (!Array.isArray(paths)) throw new Error('expected a list of changed paths');
  for (const path of paths) {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid changed path');
  }
  return paths.some(path => SERVICE_PATH.test(path));
}
function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'buffer', maxBuffer: 100 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error('git could not verify the requested service range');
  }
}
function serviceRange(candidate, baseline) {
  sha(candidate);
  if (baseline !== '--initial') sha(baseline);
  for (const commit of baseline === '--initial' ? [candidate] : [candidate, baseline]) {
    if (git(['cat-file', '-t', commit]).toString('utf8').trim() !== 'commit') throw new Error('service range requires commit objects');
  }
  const output = baseline === '--initial'
    ? git(['ls-tree', '-r', '-z', '--name-only', '--full-tree', candidate])
    : (git(['merge-base', '--is-ancestor', baseline, candidate]), git(['diff', '--name-only', '-z', '--no-ext-diff', '--no-renames', baseline, candidate, '--']));
  let decoded;
  try { decoded = new TextDecoder('utf-8', {fatal:true}).decode(output); }
  catch { throw new Error('service range contains a non-UTF-8 path'); }
  if (decoded && !decoded.endsWith('\0')) throw new Error('incomplete service range');
  return {required: serviceChangeRequired(decoded ? decoded.slice(0, -1).split('\0') : [])};
}
function checkPolicyFiles(policies, root) {
  const current = new Map(policies.map(policy => [policy.kind, policy]));
  for (const kind of ['ci', 'service']) if (!current.has(kind)) throw new Error(`missing ${kind} evidence policy`);
  for (const policy of current.values()) {
    for (const [name, expected] of Object.entries(policy.files)) {
      const bytes = readFileSync(resolve(root, name));
      const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (actual !== expected) throw new Error(`policy fingerprint mismatch: ${name}`);
    }
  }
  return true;
}
function validateRun(run, workflow, kind, sourceSha) {
  if (!run || !Number.isSafeInteger(run.id) || run.id <= 0 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 ||
      run.workflow_id !== workflow.id || run.repository?.id !== REPOSITORY_ID || run.head_repository?.id !== REPOSITORY_ID ||
      run.event !== 'workflow_dispatch' || run.head_branch !== 'dev' || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('unqualified run metadata');
  }
  sha(run.head_sha);
  if (kind === 'ci' && (run.head_sha !== sourceSha || run.display_title !== `ocx-ci-v1 lane=all sha=${sourceSha}`)) throw new Error('CI lane or source mismatch');
}
async function ancestor(api, base, head) {
  sha(base); sha(head);
  const data = await api(`/compare/${base}...${head}`);
  if (!['ahead', 'behind', 'identical', 'diverged'].includes(data?.status)) throw new Error('invalid comparison');
  return data.status === 'ahead' || data.status === 'identical';
}
function createEvidence(api, policies = APPROVED_POLICIES) {
  // Git objects are immutable. Reuse them across files and candidate runs so
  // checking a long dev history does not repeatedly fetch the same subtrees.
  const objects = new Map();
  async function policyApi(path) {
    if (!/^\/git\/(?:commits|trees)\/[0-9a-f]{40}$/.test(path)) return api(path);
    if (!objects.has(path)) objects.set(path, api(path).catch(error => { objects.delete(path); throw error; }));
    return objects.get(path);
  }
  async function workflow(kind) {
    const filename = kind === 'ci' ? 'ci.yml' : 'service-lifecycle.yml';
    const [repo, wf] = await Promise.all([api(''), api(`/actions/workflows/${filename}`)]);
    if (repo?.id !== REPOSITORY_ID || repo.full_name !== 'lidge-jun/opencodex' || wf?.path !== `.github/workflows/${filename}` || !Number.isSafeInteger(wf.id)) throw new Error('repository or workflow identity mismatch');
    return wf;
  }
  async function eligible(run, wf, kind, sourceSha) {
    validateRun(run, wf, kind, sourceSha);
    await assertPolicy(policyApi, run, kind, policies);
    const jobs = await pages(api, `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
    validateJobs(jobs, kind === 'ci' ? CI_JOBS : serviceJobs(sourceSha));
  }
  async function select(kind, sourceSha) {
    if (sourceSha !== undefined) sha(sourceSha);
    if (kind === 'service' && !sourceSha) throw new Error('service requires source SHA');
    if (!policies.some(policy => policy.kind === kind && policy.version === 1)) throw new Error(`no approved ${kind} evidence policy`);
    const wf = await workflow(kind);
    const dev = (await api('/commits/dev'))?.sha;
    sha(dev);
    if (sourceSha && !await ancestor(api, sourceSha, dev)) throw new Error('source is not a dev ancestor');
    const runs = await pages(api, `/actions/workflows/${wf.id}/runs`, 'workflow_runs');
    const ids = new Set();
    const candidates = new Map();
    for (const run of runs) {
      if (!run || !Number.isSafeInteger(run.id) || ids.has(run.id)) throw new Error('duplicate or malformed run');
      ids.add(run.id);
      const candidate = kind === 'ci' ? run.head_sha : sourceSha;
      if (!FULL_SHA.test(candidate || '') || (sourceSha && candidate !== sourceSha)) continue;
      try {
        await eligible(run, wf, kind, candidate);
      } catch (error) {
        if (/GitHub API request failed|pagination|invalid paginated|incomplete tree/.test(error.message)) throw error;
        continue;
      }
      if (!await ancestor(api, candidate, dev) || !await ancestor(api, run.head_sha, dev)) continue;
      if (!candidates.has(candidate)) candidates.set(candidate, run.id);
    }
    if (!candidates.size) throw new Error(`no qualifying ${kind} evidence`);
    let newest;
    for (const candidate of candidates.keys()) {
      let containsAll = true;
      for (const other of candidates.keys()) if (!await ancestor(api, other, candidate)) { containsAll = false; break; }
      if (containsAll) {
        if (newest && newest !== candidate) throw new Error('ambiguous qualifying sources');
        newest = candidate;
      }
    }
    if (!newest) throw new Error('ambiguous qualifying sources');
    return { sourceSha: newest, ciRunId: candidates.get(newest) };
  }
  return { select };
}
async function main(args) {
  if (args[0] === 'service-range' && args.length === 3) {
    process.stdout.write(`${JSON.stringify(serviceRange(args[1], args[2]))}\n`);
    return;
  }
  if (args[0] === 'policy-check' && args.length === 1) {
    checkPolicyFiles(APPROVED_POLICIES, resolve(__dirname, '../..'));
    process.stdout.write('Evidence policy fingerprints match the working tree.\n');
    return;
  }
  if (!['resolve', 'check', 'service'].includes(args[0]) || args.length > 2 || (args[0] !== 'resolve' && args.length !== 2)) throw new Error('usage: release-evidence.cjs resolve [fullSha] | check <fullSha> | service <fullSha> | service-range <fullSha> <baselineSha|--initial> | policy-check');
  if (args[1] !== undefined) sha(args[1]);
  const evidence = createEvidence(apiClient(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN));
  const result = await evidence.select(args[0] === 'service' ? 'service' : 'ci', args[1]);
  if (args[0] === 'resolve') process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { process.stderr.write(`release evidence: ${error.message}\n`); process.exitCode = 1; });
module.exports = { CI_JOBS, serviceJobs, validateJobs, createEvidence, pages, validateRun, apiClient, serviceChangeRequired, serviceRange, checkPolicyFiles };
