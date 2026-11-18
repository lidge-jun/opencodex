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
// The Windows leg count a ci policy's pinned workflow produces. Entries written before the
// field existed pinned the eleven-shard ci.yml, so an absent value means eleven; a run is
// held to the count of the entry its revision matched, never to the newest one, so a
// historical revision stays verifiable and a new revision cannot pass with fewer legs.
const LEGACY_WINDOWS_SHARDS = 11;
function windowsShardsOf(policy) {
  if (policy.windowsShards === undefined) return LEGACY_WINDOWS_SHARDS;
  if (!Number.isSafeInteger(policy.windowsShards) || policy.windowsShards < 1 || policy.windowsShards > 64) {
    throw new Error('invalid ci policy windowsShards');
  }
  return policy.windowsShards;
}
function ciJobs(windowsShards) {
  return Object.freeze([
    'changes', 'select windows runner', 'storage policy', 'api usage', 'gates',
    ...Array.from({length: 5}, (_, i) => `test ${i + 1}/5`),
    ...Array.from({length: 4}, (_, i) => `macos ${i + 1}/4`),
    ...Array.from({length: windowsShards}, (_, i) => `windows ${i + 1}/${windowsShards}`),
    'keyring ubuntu', 'keyring windows', 'keyring macos', 'docker smoke',
    'docs site build', 'structure gate', 'macos widget + bundle', 'desktop shell',
    ...['ubuntu-latest', 'windows-latest', 'macos-latest'].flatMap(os => [
      `setup action ${os}`, `remote helper ${os}`, `npm-global ${os}`,
    ]), 'ci',
  ]);
}
// The job set the current workflow produces: the newest approved ci entry's.
const CI_JOBS = ciJobs(windowsShardsOf(APPROVED_POLICIES.filter(policy => policy.kind === 'ci').at(-1)));

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
async function pages(api, path, key, maxTotal = 1000) {
  const collected = [];
  let total;
  for (let page = 1; ; page++) {
    const data = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!data || !Number.isSafeInteger(data.total_count) || data.total_count < 0 || !Array.isArray(data[key]) || data[key].length > 100) throw new Error('invalid paginated response');
    if (total === undefined) total = data.total_count;
    if (total !== data.total_count) throw new Error('pagination changed during lookup');
    if (total > maxTotal) throw new Error('pagination coverage exceeds the safe limit');
    if (data[key].length !== Math.min(100, total - collected.length)) throw new Error('incomplete pagination');
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
    if (matches) return policy;
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
  windowsShardsOf(current.get('ci'));
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
// GitHub limits filtered workflow searches to 1,000 results. Discovery may
// inspect at most those 1,000; exact-SHA lists must fit completely in that cap.
// The compare bound and global request budget make failure explicit when a
// candidate is too old to prove newest within the available API budget.
const MAX_COMPARE_COMMITS = 200;
const MAX_API_REQUESTS = 800;
function createEvidence(rawApi, policies = APPROVED_POLICIES) {
  let requestCount = 0;
  const api = async path => {
    if (++requestCount > MAX_API_REQUESTS) throw new Error('GitHub API request budget exceeded');
    return rawApi(path);
  };
  const objects = new Map();
  const comparisons = new Map();
  async function policyApi(path) {
    if (!/^\/git\/(?:commits|trees)\/[0-9a-f]{40}$/.test(path)) return api(path);
    if (!objects.has(path)) objects.set(path, api(path).catch(error => { objects.delete(path); throw error; }));
    return objects.get(path);
  }
  async function isAncestor(base, head) {
    sha(base); sha(head);
    if (base === head) return true;
    const key = `${base}...${head}`;
    if (!comparisons.has(key)) comparisons.set(key, ancestor(api, base, head));
    return comparisons.get(key);
  }
  async function workflow(kind) {
    const filename = kind === 'ci' ? 'ci.yml' : 'service-lifecycle.yml';
    const [repo, wf] = await Promise.all([api(''), api(`/actions/workflows/${filename}`)]);
    if (repo?.id !== REPOSITORY_ID || repo.full_name !== 'lidge-jun/opencodex' || wf?.path !== `.github/workflows/${filename}` || !Number.isSafeInteger(wf.id)) throw new Error('repository or workflow identity mismatch');
    return wf;
  }
  async function eligible(run, wf, kind, sourceSha) {
    validateRun(run, wf, kind, sourceSha);
    const policy = await assertPolicy(policyApi, run, kind, policies);
    const jobs = await pages(api, `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
    validateJobs(jobs, kind === 'ci' ? ciJobs(windowsShardsOf(policy)) : serviceJobs(sourceSha));
  }
  async function qualifies(run, wf, kind, candidate, dev) {
    try {
      await eligible(run, wf, kind, candidate);
    } catch (error) {
      // API, pagination, resource limits and unknown errors are never evidence
      // that a run is ineligible; stop instead of skipping them.
      if (/^(unqualified run metadata|CI lane or source mismatch|unapproved .* workflow or helper policy|missing or unsuccessful job:|duplicate or malformed job|expected full lowercase commit SHA)/.test(error.message)) return false;
      throw error;
    }
    return isAncestor(run.head_sha, dev);
  }
  function listPath(wf, head) {
    const query = new URLSearchParams({event:'workflow_dispatch', branch:'dev', status:'success'});
    if (head) query.set('head_sha', sha(head));
    return `/actions/workflows/${wf.id}/runs?${query}`;
  }
  function signature(runs) {
    const ids = new Set();
    return JSON.stringify(runs.map(run => {
      if (!run || !Number.isSafeInteger(run.id) || run.id <= 0 || ids.has(run.id)) throw new Error('duplicate or malformed run');
      ids.add(run.id);
      return [run.id,run.run_attempt,run.status,run.conclusion,run.head_sha,run.head_branch,run.event,run.workflow_id,run.repository?.id,run.head_repository?.id,run.display_title];
    }));
  }
  const snapshots = [];
  async function exactRuns(wf, head) {
    const path = listPath(wf, head);
    const runs = await pages(api, path, 'workflow_runs');
    const stamp = signature(runs);
    snapshots.push(async () => {
      if (signature(await pages(api, path, 'workflow_runs')) !== stamp) throw new Error('run pagination changed during lookup');
    });
    return runs;
  }
  async function findEligible(runs, wf, kind, source, dev) {
    for (const run of runs) {
      const candidate = kind === 'ci' ? run.head_sha : source;
      if (!FULL_SHA.test(candidate || '') || (kind === 'ci' && source && candidate !== source)) continue;
      if (await qualifies(run, wf, kind, candidate, dev) && await isAncestor(candidate, dev)) return {sourceSha:candidate,ciRunId:run.id};
    }
    return undefined;
  }
  async function discover(wf, dev) {
    const path = listPath(wf);
    const observed = [];
    let total;
    for (let page = 1; page <= 10; page++) {
      const data = await api(`${path}&per_page=100&page=${page}`);
      if (!data || !Number.isSafeInteger(data.total_count) || data.total_count < 0 || !Array.isArray(data.workflow_runs)) throw new Error('invalid paginated response');
      if (total === undefined) total = data.total_count;
      if (total !== data.total_count) throw new Error('run pagination changed during lookup');
      const expected = Math.min(100, Math.max(0, total - observed.length));
      if (data.workflow_runs.length !== expected) throw new Error('incomplete run pagination');
      observed.push(...data.workflow_runs);
      signature(observed);
      const found = await findEligible(data.workflow_runs, wf, 'ci', undefined, dev);
      if (found) {
        const count = page, stamp = signature(observed), initialTotal = total;
        snapshots.push(async () => {
          const again = [];
          for (let n = 1; n <= count; n++) {
            const result = await api(`${path}&per_page=100&page=${n}`);
            if (result?.total_count !== initialTotal || !Array.isArray(result.workflow_runs)) throw new Error('run pagination changed during lookup');
            again.push(...result.workflow_runs);
          }
          if (signature(again) !== stamp) throw new Error('run pagination changed during lookup');
        });
        return found;
      }
      if (observed.length === total) throw new Error('no qualifying ci evidence');
    }
    throw new Error('run pagination coverage exceeds the safe limit');
  }
  async function commitsSince(base, head) {
    if (base === head) return [];
    const collected = [], seen = new Set();
    let total;
    for (let page = 1; ; page++) {
      const data = await api(`/compare/${base}...${head}?per_page=100&page=${page}`);
      if (data?.status !== 'ahead' || !Number.isSafeInteger(data.total_commits) || data.total_commits < 1 || !Array.isArray(data.commits)) throw new Error('invalid commit comparison');
      if (total === undefined) total = data.total_commits;
      if (total !== data.total_commits) throw new Error('commit pagination changed during lookup');
      if (total > MAX_COMPARE_COMMITS) throw new Error('commit comparison coverage exceeds the safe limit');
      if (data.commits.length !== Math.min(100, total-collected.length)) throw new Error('incomplete commit pagination');
      for (const commit of data.commits) {
        const value = sha(commit?.sha);
        if (value === base || seen.has(value)) throw new Error('duplicate or malformed comparison commit');
        seen.add(value); collected.push(value);
      }
      if (collected.length === total) {
        if (!seen.has(head)) throw new Error('incomplete commit comparison');
        return collected;
      }
    }
  }
  async function select(kind, sourceSha) {
    if (!['ci','service'].includes(kind)) throw new Error('unknown evidence kind');
    if (sourceSha !== undefined) sha(sourceSha);
    if (kind === 'service' && !sourceSha) throw new Error('service requires source SHA');
    if (!policies.some(policy => policy.kind === kind && policy.version === 1)) throw new Error(`no approved ${kind} evidence policy`);
    const wf = await workflow(kind);
    const dev = sha((await api('/commits/dev'))?.sha);
    if (sourceSha && !await isAncestor(sourceSha, dev)) throw new Error('source is not a dev ancestor');
    let found;
    if (sourceSha) {
      // A service dispatch runs the workflow from dev and may test an older
      // source; its head_sha is the workflow revision, not the tested source.
      const runs = await exactRuns(wf, kind === 'ci' ? sourceSha : undefined);
      found = await findEligible(runs, wf, kind, sourceSha, dev);
    } else {
      found = await discover(wf, dev);
      const candidates = [found];
      for (const commit of await commitsSince(found.sourceSha, dev)) {
        const runs = await exactRuns(wf, commit);
        const candidate = await findEligible(runs, wf, 'ci', commit, dev);
        if (candidate) candidates.push(candidate);
      }
      let newest;
      for (const candidate of candidates) {
        let includesAll = true;
        for (const other of candidates) if (!await isAncestor(other.sourceSha, candidate.sourceSha)) { includesAll = false; break; }
        if (includesAll) {
          if (newest && newest.sourceSha !== candidate.sourceSha) throw new Error('ambiguous qualifying sources');
          newest = candidate;
        }
      }
      if (!newest) throw new Error('ambiguous qualifying sources');
      found = newest;
    }
    if (!found) throw new Error(`no qualifying ${kind} evidence`);
    for (const confirm of snapshots) await confirm();
    if (sha((await api('/commits/dev'))?.sha) !== dev) throw new Error('dev changed during evidence lookup');
    return found;
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
module.exports = { CI_JOBS, ciJobs, windowsShardsOf, serviceJobs, validateJobs, createEvidence, pages, validateRun, apiClient, serviceChangeRequired, serviceRange, checkPolicyFiles };
