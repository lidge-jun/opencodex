import { useRef, useState } from "react";
import { readJsonOrThrow } from "../../fetch-json";
import { useT } from "../../i18n/shared";
import type { RemoteDevice, RemoteSession } from "./types";

export function useSessionActions(apiBase: string, sessions: RemoteSession[], devices: RemoteDevice[], stale: boolean, refresh: () => unknown) {
  const t = useT();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [local, setLocal] = useState<Record<string, RemoteSession>>({});
  const [pending, setPending] = useState<Record<string, { prompt?: boolean; stop?: boolean }>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const stopped = useRef(new Set<string>());
  const inFlightPrompts = useRef(new Set<string>());
  const inFlightStops = useRef(new Set<string>());
  const merged = sessions.map(session => {
    const accepted = local[session.id];
    if (accepted?.status === "stopped") return { ...session, status: "stopped" as const };
    return accepted && (accepted.events.at(-1)?.sequence ?? 0) > (session.events.at(-1)?.sequence ?? 0) ? accepted : session;
  });
  const setDraft = (id: string, value: string) => setDrafts(current => ({ ...current, [id]: value }));
  const setError = (id: string, value: string) => setErrors(current => ({ ...current, [id]: value }));
  const setBusy = (id: string, action: "prompt" | "stop", value: boolean) => setPending(current => ({ ...current, [id]: { ...current[id], [action]: value } }));
  const canSend = (session: RemoteSession) => Boolean((drafts[session.id] ?? "").trim() && !pending[session.id]?.prompt && !pending[session.id]?.stop && !stale
    && session.status !== "running" && session.status !== "starting" && session.status !== "stopped"
    && !(session.status === "failed" && session.resumable === false)
    && !(session.status === "waiting_for_executor" && !devices.find(device => device.id === session.deviceId)?.online));

  const send = async (session: RemoteSession) => {
    const id = session.id;
    if (!canSend(session) || inFlightPrompts.current.has(id) || inFlightStops.current.has(id)) return;
    const submitted = drafts[id] ?? "";
    inFlightPrompts.current.add(id);
    setBusy(id, "prompt", true);
    setError(id, "");
    let status: number | undefined;
    try {
      const response = await fetch(`${apiBase}/api/remote-workspace/sessions/${id}/prompt`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: submitted }),
      });
      status = response.status;
      const accepted = await readJsonOrThrow<RemoteSession>(response, t("remote.requestFailed"));
      if (!accepted) throw new Error(t("remote.requestFailed"));
      setDrafts(current => current[id] === submitted ? { ...current, [id]: "" } : current);
      if (!stopped.current.has(id)) setLocal(current => ({ ...current, [id]: accepted }));
      void refresh();
    } catch (error) {
      if (!stopped.current.has(id)) {
        setError(id, status !== undefined && status >= 400 && status < 500
          ? error instanceof Error ? error.message : t("remote.requestFailed") : t("remote.submissionUnknown"));
        void refresh();
      }
    } finally { inFlightPrompts.current.delete(id); setBusy(id, "prompt", false); }
  };

  const stop = async (session: RemoteSession) => {
    const id = session.id;
    if (inFlightStops.current.has(id) || session.status === "stopped") return;
    inFlightStops.current.add(id);
    setBusy(id, "stop", true);
    try {
      const response = await fetch(`${apiBase}/api/remote-workspace/sessions/${id}`, { method: "DELETE" });
      await readJsonOrThrow(response, t("remote.requestFailed"));
      stopped.current.add(id);
      setLocal(current => ({ ...current, [id]: { ...session, status: "stopped" } }));
      void refresh();
    } catch (error) { setError(id, error instanceof Error ? error.message : t("remote.requestFailed")); }
    finally { inFlightStops.current.delete(id); setBusy(id, "stop", false); }
  };
  return { sessions: merged, drafts, setDraft, pending, errors, canSend, send, stop };
}
