/**
 * Inbound / upstream protocol filters for the compatibility matrix, and the line that says
 * what the Lab knows about the filtered pair. Pair resolution is compatibility-protocol-pairs.ts.
 *
 * The filter reads Lab verdicts only. Delivery mode (native, translated) is how a request
 * travels and belongs to the path preview; the two are never folded into one badge here.
 */
import { PROTOCOLS, type Protocol } from "../../../src/protocols/contract";
import { protocolHopLabel } from "../components/protocols/protocol-labels";
import { useT } from "../i18n/shared";
import { Select } from "../ui";
import type { ProtocolPairFilter } from "../protocol-deep-links";
import { protocolFilterActive, type ProtocolPairEvidence } from "./compatibility-matrix-shared";
import type { SubjectProtocolPairs } from "./compatibility-protocol-pairs";

function useProtocolName() {
  const t = useT();
  return (protocol: Protocol | "") => protocol ? protocolHopLabel(protocol, t) : t("compatProtocol.anyProtocol");
}

export function ProtocolPairFilters({ value, onChange }: {
  value: ProtocolPairFilter;
  onChange: (next: ProtocolPairFilter) => void;
}) {
  const t = useT();
  const protocolName = useProtocolName();
  const options = [
    { value: "", label: t("lab.filter.all") },
    ...PROTOCOLS.map(protocol => ({ value: protocol, label: protocolName(protocol) })),
  ];
  return (
    <>
      <div className="lab-filter-field">
        <label htmlFor="lab-filter-inbound">{t("compatProtocol.filter.inbound")}</label>
        <Select
          id="lab-filter-inbound"
          value={value.inbound}
          options={options}
          onChange={next => onChange({ ...value, inbound: next as Protocol | "" })}
          label={t("compatProtocol.filter.inbound")}
          portal={false}
        />
      </div>
      <div className="lab-filter-field">
        <label htmlFor="lab-filter-upstream">{t("compatProtocol.filter.upstream")}</label>
        <Select
          id="lab-filter-upstream"
          value={value.upstream}
          options={options}
          onChange={next => onChange({ ...value, upstream: next as Protocol | "" })}
          label={t("compatProtocol.filter.upstream")}
          portal={false}
        />
      </div>
    </>
  );
}

/**
 * The one line that states what the Lab knows about the filtered pair. With no matching row
 * the pair is unverified; nothing here ever calls it failed or unsupported.
 */
export function ProtocolPairStatus({ filter, evidence, resolution }: {
  filter: ProtocolPairFilter;
  evidence: ProtocolPairEvidence;
  resolution: Pick<SubjectProtocolPairs, "loading" | "unresolved">;
}) {
  const t = useT();
  const protocolName = useProtocolName();
  if (!protocolFilterActive(filter)) return null;
  const pair = t("compatProtocol.pair", { inbound: protocolName(filter.inbound), upstream: protocolName(filter.upstream) });
  return (
    <div className="lab-protocol-status" data-pair-evidence={resolution.loading ? "loading" : evidence}>
      {resolution.loading ? (
        <p className="muted small" role="status">{t("compatProtocol.loading")}</p>
      ) : evidence === "unverified" ? (
        // Plain text, not a Notice: every Notice tone reads as success, degradation or failure.
        <p className="lab-protocol-unverified" role="status">{t("compatProtocol.unverified", { pair })}</p>
      ) : null}
      {resolution.unresolved > 0 && !resolution.loading && (
        <p className="muted small">{t("compatProtocol.unresolved", { count: resolution.unresolved })}</p>
      )}
      <p className="muted small">{t("compatProtocol.axisNote")}</p>
    </div>
  );
}
