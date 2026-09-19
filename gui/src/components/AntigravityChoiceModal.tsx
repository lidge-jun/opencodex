import AccountAuthChoiceModal, { type AccountAuthChoiceModalProps } from "./AccountAuthChoiceModal";

export type AntigravityChoiceModalProps = Omit<AccountAuthChoiceModalProps, "provider" | "providerLabel"> & {
  provider?: string;
  providerLabel?: string;
};

export default function AntigravityChoiceModal(props: AntigravityChoiceModalProps) {
  return (
    <AccountAuthChoiceModal
      provider={props.provider ?? "google-antigravity"}
      providerLabel={props.providerLabel ?? "Google Antigravity"}
      {...props}
    />
  );
}
