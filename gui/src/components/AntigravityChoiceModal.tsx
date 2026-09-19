import { useT } from "../i18n/shared";
import AccountAuthChoiceModal, { type AccountAuthChoiceModalProps } from "./AccountAuthChoiceModal";

export type AntigravityChoiceModalProps = Omit<AccountAuthChoiceModalProps, "provider" | "providerLabel"> & {
  provider?: string;
  providerLabel?: string;
};

export default function AntigravityChoiceModal(props: AntigravityChoiceModalProps) {
  const t = useT();
  return (
    <AccountAuthChoiceModal
      provider={props.provider ?? "google-antigravity"}
      providerLabel={props.providerLabel ?? t("pws.providerLabelAntigravity")}
      {...props}
    />
  );
}
