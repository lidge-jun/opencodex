import type {
  ForkSyncNotifier,
  GitHubIssue,
  GitHubIssuesClient,
  SyncEvent,
} from "../types";

const LABEL = "fork-sync";

export interface GitHubIssueNotifierOptions {
  client: GitHubIssuesClient;
  upstreamRepo: string;
}

function publicValue(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function issueText(event: SyncEvent, upstreamRepo: string): {
  title: string;
  body: string;
} {
  const tag = publicValue(event.latestTag) || "unknown-release";
  const kind = publicValue(event.kind);
  const title = `[fork-sync] ${kind}: ${tag}`;
  const body = [
    "<!-- opencodex-fork-sync -->",
    `Upstream repository: ${publicValue(upstreamRepo)}`,
    `Event: ${kind}`,
    `Latest tag: ${tag}`,
    `Latest tag SHA: ${publicValue(event.latestTagSha) || "unavailable"}`,
    `vendor/main SHA: ${publicValue(event.vendorMainSha) || "unavailable"}`,
    `vendor/dev SHA: ${publicValue(event.vendorDevSha) || "unavailable"}`,
    `Detected at: ${publicValue(event.detectedAt)}`,
    event.error ? `Error: ${publicValue(event.error)}` : "Action: review the release and rebuild run/main.",
  ].join("\n");
  return { title, body };
}

function labelNames(issue: GitHubIssue): string[] {
  return issue.labels
    .map(label => typeof label === "string" ? label : label.name ?? "")
    .filter(Boolean);
}

export function createGitHubIssueNotifier(
  options: GitHubIssueNotifierOptions,
): ForkSyncNotifier {
  return {
    id: "github-issue",
    async notify(event) {
      if (event.kind === "already-current") return;
      const issues = await options.client.listOpen({ label: LABEL });
      const matching = event.latestTag
        ? issues.find(issue =>
          `${issue.title}\n${issue.body}`.includes(event.latestTag)
        )
        : undefined;
      const text = issueText(event, options.upstreamRepo);
      if (matching) {
        const labels = labelNames(matching);
        if (!labels.includes(LABEL)) labels.push(LABEL);
        await options.client.update({
          issueNumber: matching.number,
          title: text.title,
          body: text.body,
          labels,
        });
      } else {
        await options.client.create({
          title: text.title,
          body: text.body,
          labels: [LABEL],
        });
      }
    },
  };
}
