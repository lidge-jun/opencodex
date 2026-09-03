/**
 * Sidebar footer: two circular satellite buttons, GitHub and Update.
 *
 * GitHub: a plain link orb. The star action that used to sit beside it moved into the
 * update dialog (`GithubStarButton`) — a promotion ask does not belong at the same
 * weight as the proxy kill switch on every page.
 *
 * Update: always present, so "am I current?" is answerable at any time. It reads the
 * cached badge endpoint (no npm spawn per poll) purely to decide emphasis — an
 * available update renders the accent state plus a dot, otherwise it is a plain orb.
 * Either way a click runs a fresh check and opens the dashboard update dialog, which
 * already owns the install/cancel decision.
 */
import { useKeyedClientResource } from "../client-resource";
import { IconDownload, IconGithub } from "../icons";
import { useT } from "../i18n/shared";
import { REPO_URL } from "./github-star-button";

interface UpdateBadge {
  updateAvailable?: boolean;
  latestVersion?: string | null;
  /** True when no cached registry answer exists, so "no update" is unproven. */
  unknown?: boolean;
}

const BADGE_POLL_MS = 10 * 60_000;

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
  const badgePoll = useKeyedClientResource(
    `sidebar-update-badge:${apiBase}`,
    [apiBase],
    (signal) => readJson<UpdateBadge>(`${apiBase}/api/update/badge`, signal),
    { pollMs: BADGE_POLL_MS },
  );

  const badge = badgePoll.data;
  const updateAvailable = badge?.updateAvailable === true;
  const latestVersion = badge?.latestVersion ?? null;

  // With an update pending the label names the version; otherwise it describes the
  // action, so the button never reads as "update available" when nothing is waiting.
  const updateLabel = updateAvailable && latestVersion
    ? t("sidebar.updateAvailable", { version: latestVersion })
    : t("sidebar.checkUpdate");

  return (
    <>
      <a
        className="sidebar-orb"
        href={REPO_URL}
        target="_blank"
        rel="noreferrer"
        aria-label={t("common.github")}
        title={t("common.github")}
      >
        <IconGithub aria-hidden="true" />
      </a>
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
    </>
  );
}
