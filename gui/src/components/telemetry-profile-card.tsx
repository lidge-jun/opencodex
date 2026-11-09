import { useEffect, useState } from "react";
import { isConnectedRuntime } from "../api-targets";
import { useKeyedClientResource } from "../client-resource";
import { getActiveLocale, useT } from "../i18n/shared";
import { Button } from "@/components/ui-v2/button";
import { cn } from "@/lib/utils";
import { TELEMETRY_STATUS_CHANGED_EVENT } from "../telemetry-api";
import {
  PROFILE_AVATARS,
  PROFILE_GUIDE_URL,
  ProfileRequestError,
  connectProfile,
  disconnectProfile,
  fetchProfileRank,
  fetchProfileStatus,
  isValidProfileHandle,
  profileLeaderboardUrl,
  type ProfileAvatar,
  type ProfileRank,
} from "../telemetry-profile-api";

/*
 * Home card for the opt-in public leaderboard profile. Shown while anonymous telemetry is on, and
 * whenever a profile exists so it can always be disconnected. Connecting is the user's own choice:
 * nothing is pre-filled or pre-checked, and the server accepts it only from a human session.
 */

const AVATAR_HEX: Readonly<Record<ProfileAvatar, string>> = {
  slate: "#64748b", red: "#ef4444", orange: "#f97316", amber: "#f59e0b", lime: "#84cc16", green: "#22c55e",
  teal: "#14b8a6", cyan: "#06b6d4", blue: "#3b82f6", indigo: "#6366f1", violet: "#8b5cf6", pink: "#ec4899",
};

const PERIODS = ["day", "week", "month"] as const;

function initial(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? "?";
}

function errorKey(error: unknown) {
  const code = error instanceof ProfileRequestError ? error.code : null;
  if (code === "handle_taken") return "telemetryProfile.errTaken" as const;
  if (code === "invalid") return "telemetryProfile.errInvalid" as const;
  if (code === "rate_limited") return "telemetryProfile.errRateLimited" as const;
  if (code === "telemetry_off") return "telemetryProfile.errTelemetryOff" as const;
  if (code === "agent_consent_required") return "telemetryProfile.errSession" as const;
  return "telemetryProfile.errUnavailable" as const;
}

export function TelemetryProfileCard({ apiBase }: { apiBase: string }) {
  const t = useT();
  const compact = new Intl.NumberFormat(getActiveLocale(), { notation: "compact", maximumFractionDigits: 1 });
  const number = new Intl.NumberFormat(getActiveLocale());
  const status = useKeyedClientResource(`telemetry-profile:${apiBase}`, [apiBase],
    signal => fetchProfileStatus(apiBase, signal), { pollMs: 60_000 });
  const profile = status.data?.profile ?? null;
  const rankHandle = profile && !profile.pendingDelete && !profile.revoked ? profile.handle : "";
  const rank = useKeyedClientResource<ProfileRank | null>(`telemetry-profile-rank:${apiBase}:${rankHandle}`, [apiBase, rankHandle],
    signal => rankHandle ? fetchProfileRank(apiBase, signal) : Promise.resolve(null), { pollMs: 300_000 });
  const refreshStatus = status.refresh;

  // Turning anonymous telemetry on or off elsewhere changes whether this card shows or pauses.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onChange = () => refreshStatus();
    window.addEventListener(TELEMETRY_STATUS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(TELEMETRY_STATUS_CHANGED_EVENT, onChange);
  }, [refreshStatus]);

  const [formOpen, setFormOpen] = useState(false);
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [avatar, setAvatar] = useState<ProfileAvatar | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof errorKey> | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [deletionPending, setDeletionPending] = useState(false);

  if (isConnectedRuntime() || !status.data) return null;
  const s = status.data;
  if (!profile && !s.unreadable && !s.telemetryEffective) return null;

  const normalizedHandle = handle.trim().toLowerCase();
  const canConnect = isValidProfileHandle(normalizedHandle) && displayName.trim().length > 0
    && [...displayName.trim()].length <= 32 && avatar !== null && acknowledged && !busy;

  const submit = async () => {
    if (!canConnect || !avatar) return;
    setBusy(true);
    setFailure(null);
    try {
      await connectProfile(apiBase, { handle: normalizedHandle, displayName: displayName.trim(), avatar });
      setFormOpen(false);
      status.refresh();
    } catch (error) {
      setFailure(errorKey(error));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const outcome = await disconnectProfile(apiBase);
      // Show what the server answered, even if the refresh below cannot reach it.
      setDeletionPending(outcome === "deletion_pending");
      setConfirmingDisconnect(false);
    } catch (error) {
      setFailure(errorKey(error));
    } finally {
      setBusy(false);
      status.refresh();
    }
  };

  const leaderboardUrl = profile ? profileLeaderboardUrl(profile.handle) : null;

  return (
    <section className="flex flex-col gap-4 rounded-card bg-surface p-5" aria-labelledby="telemetry-profile-title" data-testid="telemetry-profile-card">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="telemetry-profile-title" className="m-0 text-[15px] font-semibold">{t("telemetryProfile.title")}</h2>
        <a href={PROFILE_GUIDE_URL} target="_blank" rel="noreferrer" className="text-[13px] font-medium text-highlight hover:underline">
          {t("telemetryProfile.learnMore")}
        </a>
      </div>

      {s.unreadable && !profile && (
        <>
          <p className="m-0 text-[14px] text-fg-muted">{t("telemetryProfile.unreadable")}</p>
          <div><Button variant="outline" disabled={busy} onClick={() => { void disconnect(); }}>{t("telemetryProfile.disconnect")}</Button></div>
        </>
      )}

      {!profile && !s.unreadable && (
        <>
          <p className="m-0 text-[14px] text-fg-muted">{t("telemetryProfile.lede")}</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px] text-fg-muted">
            <li>{t("telemetryProfile.publicWhat")}</li>
            <li>{t("telemetryProfile.neverWhat")}</li>
          </ul>
          {!formOpen ? (
            <div><Button variant="primary" onClick={() => setFormOpen(true)}>{t("telemetryProfile.connect")}</Button></div>
          ) : (
            <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
              <label className="flex flex-col gap-1 text-[13px]">
                <span className="font-medium">{t("telemetryProfile.handleLabel")}</span>
                <input name="handle" value={handle} onChange={event => setHandle(event.target.value)} autoComplete="off" spellCheck={false}
                  maxLength={24} className="rounded-control border border-line bg-raised px-2.5 py-1.5 font-mono text-[14px]" />
                <span className="text-xs text-fg-subtle">{t("telemetryProfile.handleHint")}</span>
              </label>
              <label className="flex flex-col gap-1 text-[13px]">
                <span className="font-medium">{t("telemetryProfile.nameLabel")}</span>
                <input name="displayName" value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="off"
                  maxLength={32} className="rounded-control border border-line bg-raised px-2.5 py-1.5 text-[14px]" />
              </label>
              <fieldset className="m-0 flex flex-col gap-1 border-0 p-0 text-[13px]">
                <legend className="mb-1 font-medium">{t("telemetryProfile.colourLabel")}</legend>
                <div className="flex flex-wrap gap-1.5">
                  {PROFILE_AVATARS.map(colour => (
                    <button key={colour} type="button" aria-label={colour} aria-pressed={avatar === colour} onClick={() => setAvatar(colour)}
                      className={cn("size-6 cursor-pointer rounded-full border-2", avatar === colour ? "border-fg" : "border-transparent")}
                      style={{ backgroundColor: AVATAR_HEX[colour] }} />
                  ))}
                </div>
              </fieldset>
              <label className="flex items-start gap-2 text-[13px]">
                <input type="checkbox" name="acknowledgePublic" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />
                <span>{t("telemetryProfile.acknowledge")}</span>
              </label>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" type="submit" disabled={!canConnect}>
                  {t(busy ? "telemetryProfile.connecting" : "telemetryProfile.connect")}
                </Button>
                <Button variant="outline" onClick={() => { setFormOpen(false); setFailure(null); }}>{t("telemetryProfile.cancel")}</Button>
              </div>
            </form>
          )}
        </>
      )}

      {profile && (
        <>
          <div className="flex items-center gap-3">
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full text-[15px] font-semibold text-white"
              style={{ backgroundColor: AVATAR_HEX[profile.avatar] }}>{initial(profile.displayName)}</span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[14px] font-semibold">{profile.displayName}</span>
              <span className="truncate font-mono text-xs text-fg-subtle">@{profile.handle}</span>
            </span>
          </div>
          {profile.pendingDelete || deletionPending ? (
            <p className="m-0 text-[14px] text-warning">{t("telemetryProfile.deletionPending")}</p>
          ) : profile.revoked ? (
            <p className="m-0 text-[14px] text-warning">{t("telemetryProfile.revoked")}</p>
          ) : (
            <>
              {!s.telemetryEffective && <p className="m-0 text-[13px] text-fg-muted">{t("telemetryProfile.paused")}</p>}
              {rank.error ? (
                <p className="m-0 text-[13px] text-fg-muted">{t("telemetryProfile.rankUnavailable")}</p>
              ) : rank.data ? (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    {PERIODS.map(period => {
                      const entry = rank.data!.periods[period];
                      return (
                        <div key={period} className="flex min-w-0 flex-col gap-0.5 rounded-control bg-surface-2 px-3 py-2">
                          <span className="text-xs font-medium text-fg-subtle">{t(`telemetryProfile.${period}`)}</span>
                          <span className="truncate text-[15px] font-semibold tabular-nums">
                            {entry.rank === null ? t("telemetryProfile.notRanked")
                              : t("telemetryProfile.rankOf", { rank: number.format(entry.rank), of: number.format(entry.of) })}
                          </span>
                          <span className="truncate text-xs text-fg-muted tabular-nums">
                            {t("telemetryProfile.totals", { tokens: compact.format(entry.tokens), requests: number.format(entry.requests) })}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {PERIODS.every(period => rank.data!.periods[period].rank === null) && (
                    <p className="m-0 text-[13px] text-fg-muted">{t("telemetryProfile.firstRank")}</p>
                  )}
                  {rank.data.families.length > 0 && (
                    <p className="m-0 text-[13px] text-fg-muted">
                      {t("telemetryProfile.topModels")}: {rank.data.families.slice(0, 3).map(row => row.family).join(", ")}
                    </p>
                  )}
                </>
              ) : null}
            </>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {leaderboardUrl && !profile.pendingDelete && (
              <a href={leaderboardUrl} target="_blank" rel="noreferrer" className="text-[13px] font-medium text-highlight hover:underline">
                {t("telemetryProfile.viewLeaderboard")}
              </a>
            )}
            {profile.pendingDelete || deletionPending ? (
              <Button variant="outline" disabled={busy} onClick={() => { void disconnect(); }}>{t("telemetryProfile.retry")}</Button>
            ) : confirmingDisconnect ? (
              <>
                <span className="text-[13px]">{t("telemetryProfile.disconnectConfirm")}</span>
                <Button variant="outline" disabled={busy} onClick={() => { void disconnect(); }}>{t("telemetryProfile.disconnectYes")}</Button>
                <Button variant="outline" onClick={() => setConfirmingDisconnect(false)}>{t("telemetryProfile.cancel")}</Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setConfirmingDisconnect(true)}>{t("telemetryProfile.disconnect")}</Button>
            )}
          </div>
        </>
      )}

      {failure && <p role="alert" className="m-0 text-[13px] text-danger">{t(failure)}</p>}
    </section>
  );
}

export default TelemetryProfileCard;

