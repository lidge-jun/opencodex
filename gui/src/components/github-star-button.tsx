/**
 * "Star on GitHub" as an explicit, human-clicked button.
 *
 * It used to be a sidebar orb on every page: a promotion ask polling `gh` every five
 * minutes at the same visual weight as the proxy kill switch. It now lives inside the
 * update dialog, which is the one place the dashboard already talks about the project
 * itself. The behaviour is unchanged: an already-starred repo renders a settled marker,
 * an unauthenticated `gh` falls back to opening the repository page (a POST could not
 * succeed there), and a `gh` failure mid-click does the same fallback instead of
 * leaving a dead button. The consent rule in AGENTS_INSTALL.md is untouched — nothing
 * here stars on the user's behalf.
 *
 * Mount it only while the dialog is open: the poll starts on mount and stops on unmount.
 */
import { useState } from "react";
import { useKeyedClientResource } from "../client-resource";
import { IconStar } from "../icons";
import { useT } from "../i18n/shared";

type StarState = "starred" | "not-starred" | "unauthenticated";

interface StarStatus {
  state?: StarState;
  url?: string;
}

const STAR_POLL_MS = 5 * 60_000;
export const REPO_URL = "https://github.com/lidge-jun/opencodex";

async function readJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  return await res.json() as T;
}

export function GithubStarButton({ apiBase }: { apiBase: string }) {
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
    `github-star:${apiBase}`,
    [apiBase],
    (signal) => readJson<StarStatus>(`${apiBase}/api/github/star`, signal),
    { pollMs: STAR_POLL_MS },
  );

  const polledState = starPoll.data?.state ?? null;
  const overrideStillApplies = starOverride !== null && starOverride.basedOn === polledState;
  const starState: StarState = overrideStillApplies
    ? starOverride.state
    : polledState ?? "not-starred";
  const repoUrl = starPoll.data?.url ?? REPO_URL;
  const starred = starState === "starred";

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

  return (
    <button
      type="button"
      className={`btn btn-ghost btn-sm github-star-button${starred ? " github-star-button--starred" : ""}`}
      onClick={() => { void handleStar(); }}
      disabled={starring || starred}
      aria-pressed={starred}
      title={starLabel}
    >
      <IconStar aria-hidden="true" {...(starred ? { fill: "currentColor" } : {})} /> {starLabel}
    </button>
  );
}
