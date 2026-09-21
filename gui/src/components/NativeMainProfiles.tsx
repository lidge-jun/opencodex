import { useId, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/shared";
import { nativeMainTranslator } from "../i18n/native-main-copy";
import { NativeMainProfileSession } from "../native-main-profile-session";
import { NativeMainProfilesView } from "./native-main-profiles-view";

interface Props {
  apiBase: string;
  disabled?: boolean;
  onChanged: () => unknown | Promise<unknown>;
}

/** The proxy identity owns confirmation, requests and the in-memory return hint. */
export default function NativeMainProfiles(props: Props) {
  return <NativeMainProfilesForProxy key={props.apiBase} {...props} />;
}

function NativeMainProfilesForProxy({ apiBase, disabled = false, onChanged }: Props) {
  const { locale } = useI18n();
  const t = nativeMainTranslator(locale);
  const id = useId();
  const [session] = useState(() => new NativeMainProfileSession(apiBase));
  const [state, setState] = useState(session.state);
  const summaryRef = useRef<HTMLButtonElement>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => session.attach(setState), [session]);
  useLayoutEffect(() => { session.updateOptions(disabled, onChanged); }, [session, disabled, onChanged]);
  useLayoutEffect(() => {
    if (state.action) {
      restoreFocus.current = true;
      confirmationRef.current?.focus();
    } else if (!state.busy && restoreFocus.current) {
      restoreFocus.current = false;
      summaryRef.current?.focus();
    }
  }, [state.action, state.busy]);

  return <NativeMainProfilesView t={t} id={id} {...state}
    previousId={state.previous?.id ?? null} summaryRef={summaryRef} confirmationRef={confirmationRef}
    onToggle={() => { void session.toggle(); }} onRefresh={() => { void session.refresh(); }}
    onLabel={label => session.setLabel(label)} onRegister={() => { void session.register(); }}
    onSelect={action => session.select(action)} onStopped={checked => session.setStopped(checked)}
    onConfirm={() => { void session.confirm(); }} />;
}
