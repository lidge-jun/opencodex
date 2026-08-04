/**
 * Sidebar footer row: the GitHub link plus two circular satellite buttons.
 *
 * Star: reflects the real state from `gh` rather than always inviting a click.
 * Already starred renders a filled, non-interactive marker; an unauthenticated
 * `gh` falls back to opening the repository page, because a POST could not
 * succeed there. A `gh` failure mid-click does the same fallback instead of
 * leaving a dead button.
 *
 * Update: always present, so "am I current?" is answerable at any time. It reads the
 * cached badge endpoint (no npm spawn per poll) purely to decide emphasis — an
 * available update renders the accent state plus a dot, otherwise it is a plain orb.
 * Either way a click runs a fresh check and opens the dashboard update dialog, which
 * already owns the install/cancel decision.
 */
import { useState } from "react";
import { useKeyedClientResource } from "../client-resource";
import { IconDownload, IconGithub, IconStar } from "../icons";
import { useT } from "../i18n/shared";

type StarState = "starred" | "not-starred" | "unauthenticated";

interface StarStatus {
  state?: StarState;
  url?: string;
}

interface UpdateBadge {
  updateAvailable?: boolean;
  latestVersion?: string | null;
  /** True when no cached registry answer exists, so "no update" is unproven. */
  unknown?: boolean;
}

const STAR_POLL_MS = 5 * 60_000;
const BADGE_POLL_MS = 10 * 60_000;
const REPO_URL = "https://github.com/lidge-jun/opencodex";

async function readJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  return await res.json() as T;
}

export function SidebarGithubRow({
  apiBase,
  onOpenUpdate,
}: {
  apiBase: string;
  /** Navigates to the dashboard maintenance surface where the update dialog lives. */
  onOpenUpdate: () => void;
}) {
  const t = useT();
  const [starring, setStarring] = useState(false);
  /*
   * Optimistic result of this session's own click, tagged with the polled state it was
   * taken against. Once the poll reports something different from that baseline the
   * server has caught up (or the repo was unstarred elsewhere), so the override is
   * ignored — derived during render rather than cleared in an effect.
   */
  const [starOverride, setStarOverride] = useState<{ state: StarState; basedOn: StarState | null } | null>(null);

  const starPoll = useKeyedClientResource(
    `sidebar-star:${apiBase}`,
    [apiBase],
    (signal) => readJson<StarStatus>(`${apiBase}/api/github/star`, signal),
    { pollMs: STAR_POLL_MS },
  );
  const badgePoll = useKeyedClientResource(
    `sidebar-update-badge:${apiBase}`,
    [apiBase],
    (signal) => readJson<UpdateBadge>(`${apiBase}/api/update/badge`, signal),
    { pollMs: BADGE_POLL_MS },
  );

  const polledState = starPoll.data?.state ?? null;
  const overrideStillApplies = starOverride !== null && starOverride.basedOn === polledState;
  const starState: StarState = overrideStillApplies
    ? starOverride.state
    : polledState ?? "not-starred";
  const repoUrl = starPoll.data?.url ?? REPO_URL;
  const starred = starState === "starred";
  const badge = badgePoll.data;
  const updateAvailable = badge?.updateAvailable === true;
  const latestVersion = badge?.latestVersion ?? null;

  const openRepo = () => window.open(repoUrl, "_blank", "noopener,noreferrer");

  const handleStar = async () => {
    if (starred || starring) return;
    if (starState === "unauthenticated") { openRepo(); return; }
    setStarring(true);
    try {
      const res = await fetch(`${apiBase}/api/github/star`, { method: "POST" });
      // A proxy running older code has no such route. Falling through to the repo page
      // keeps the button useful instead of failing silently.
      const data = res.ok ? await res.json() as StarStatus & { ok?: boolean } : null;
      if (data?.ok === true) {
        setStarOverride({ state: "starred", basedOn: polledState });
        return;
      }
      // Also covers the 403 the proxy returns when it is running under an agent
      // session and this click carried no dashboard session (`agent_consent_required`):
      // the repo page is exactly where the user can star it themselves.
      //
      // gh refused (logged out, revoked scope, network). The server reports a fixed code
      // rather than gh's output, so there is nothing to show — hand over the page instead.
      if (data?.state) setStarOverride({ state: data.state, basedOn: polledState });
      openRepo();
    } catch {
      openRepo();
    } finally {
      setStarring(false);
      starPoll.refresh();
    }
  };

  const starLabel = starred
    ? t("sidebar.starred")
    : starState === "unauthenticated"
      ? t("sidebar.starUnauthenticated")
      : t("sidebar.star");

  // With an update pending the label names the version; otherwise it describes the
  // action, so the button never reads as "update available" when nothing is waiting.
  const updateLabel = updateAvailable && latestVersion
    ? t("sidebar.updateAvailable", { version: latestVersion })
    : t("sidebar.checkUpdate");

  return (
    <div className="sidebar-github-row">
      <a className="sidebar-link sidebar-github-link" href={repoUrl} target="_blank" rel="noreferrer">
        <IconGithub /> {t("common.github")}
      </a>
      <div className="sidebar-github-actions">
        <button
          type="button"
          className={`sidebar-orb${starred ? " sidebar-orb--starred" : ""}`}
          onClick={() => { void handleStar(); }}
          disabled={starring || starred}
          aria-label={starLabel}
          aria-pressed={starred}
          title={starLabel}
        >
          <IconStar aria-hidden="true" {...(starred ? { fill: "currentColor" } : {})} />
        </button>
        <button
          type="button"
          className={`sidebar-orb${updateAvailable ? " sidebar-orb--update" : ""}`}
          onClick={onOpenUpdate}
          aria-label={updateLabel}
          title={updateLabel}
        >
          <IconDownload aria-hidden="true" />
          {updateAvailable && <span className="sidebar-orb-dot" aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
