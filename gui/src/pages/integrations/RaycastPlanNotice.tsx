import { useT } from "../../i18n/shared";
import { Notice } from "../../ui";
import type { RaycastInstall } from "./integration-api";

/*
 * Raycast is the one file client whose `current` state can still mean
 * "ignored": Custom Providers is a Pro feature, and the file is read from a
 * folder Raycast only creates after a click in its own settings. Neither fact
 * is a reason to refuse the write -- the user may be about to subscribe, or
 * has already clicked and the folder is seconds old -- so the page writes and
 * says so here instead of showing a green badge that overstates the result.
 *
 * `free` is a warning because it is a known blocker; `unknown` stays muted
 * because on Linux and Windows there is no subscription signal to read, and a
 * Pro user there must not be told they are not one.
 */
export default function RaycastPlanNotice({ install }: { install: RaycastInstall }) {
  const t = useT();
  return (
    <>
      {install.plan === "free" && (
        <Notice tone="warn">{t("integrations.raycast.proRequired")}</Notice>
      )}
      {install.plan === "unknown" && (
        <p className="page-sub" data-raycast-plan="unknown">{t("integrations.raycast.planUnknown")}</p>
      )}
      {!install.aiDirPresent && (
        <p className="page-sub" data-raycast-ai-dir="absent">{t("integrations.raycast.revealConfig")}</p>
      )}
    </>
  );
}
