import type {
  DraftPullRequestClient,
  FetchImplementation,
  GitHubPullRequest,
  PrepareResult,
  SyncEvent,
} from "./types";

export interface DraftPullRequestOptions {
  repository: string;
  token: string;
  fetchImpl: FetchImplementation;
}

function publicValue(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function bodyFor(event: SyncEvent, result: PrepareResult): string {
  const rows = result.resolutions.length === 0
    ? ["| (none) | (none) | merge completed without conflicts |"]
    : result.resolutions.map(resolution =>
      `| ${publicValue(resolution.path)} | ${resolution.classification} | ${publicValue(resolution.action)} |`);
  return [
    "<!-- opencodex-fork-sync -->",
    "## Summary",
    `Merge upstream ${publicValue(event.latestTag)} into the fork default branch.`,
    `Tag SHA: ${publicValue(event.latestTagSha) || "unavailable"}`,
    `Vendor main SHA: ${publicValue(event.vendorMainSha) || "unavailable"}`,
    "",
    "## Verification",
    `Prepare status: ${result.status}`,
    `Branch: ${publicValue(result.branch ?? "unavailable")}`,
    "",
    "## Resolution table",
    "| Path | Classification | Action |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "## Checklist",
    "- [ ] Review the resolution table.",
    "- [ ] Confirm the PR is mergeable.",
    "- [ ] Human performs the merge commit.",
  ].join("\n");
}

export function createDraftPullRequestClient(
  options: DraftPullRequestOptions,
): DraftPullRequestClient {
  const base = `https://api.github.com/repos/${options.repository}`;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${options.token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const response = await options.fetchImpl(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      throw new Error(`GitHub pull request request returned HTTP ${response.status}`);
    }
    return response;
  }

  return {
    async upsert({ event, result }) {
      if (result.status !== "merged") {
        throw new Error("merged prepare result is required for a draft PR");
      }
      const branch = result.branch;
      if (!branch) throw new Error("merged prepare result is missing a branch");
      const title = `sync: upstream ${publicValue(event.latestTag) || "unknown-release"}`;
      const body = bodyFor(event, result);
      const response = await request("/pulls?state=open&base=main");
      const openPullRequests = await response.json() as GitHubPullRequest[];
      const matching = openPullRequests.find(pullRequest =>
        pullRequest.state === "open"
        && pullRequest.base.ref === "main"
        && pullRequest.head.ref === branch
        && (pullRequest.title.includes(event.latestTag)
          || (pullRequest.body ?? "").includes(event.latestTagSha)));
      const payload = {
        title,
        head: branch,
        base: "main",
        body,
        draft: true,
      };
      if (matching) {
        await request(`/pulls/${matching.number}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        return matching.number;
      }
      const created = await request("/pulls", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const createdPullRequest = await created.json() as { number: number };
      return createdPullRequest.number;
    },
  };
}
