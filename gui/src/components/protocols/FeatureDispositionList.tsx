/**
 * What one path does to each request feature, as declared by the server's plan.
 *
 * The disposition is always spelled out as text; colour only repeats it. These are declared
 * claims about the translators, not Lab evidence, so nothing here reads as "verified".
 */
import type { FeatureDisposition, ProtocolFeature } from "../../../../src/protocols/features";
import type { ProtocolFeatureEffectV1 } from "../../../../src/protocols/dto";
import { useT, type TKey } from "../../i18n/shared";

const DISPOSITION_KEYS: Record<FeatureDisposition, TKey> = {
  passthrough: "api.plan.disposition.passthrough",
  translated: "api.plan.disposition.translated",
  degraded: "api.plan.disposition.degraded",
  unsupported: "api.plan.disposition.unsupported",
};

const DISPOSITION_TONES: Record<FeatureDisposition, string> = {
  passthrough: "badge-green",
  translated: "badge-accent",
  degraded: "badge-amber",
  unsupported: "badge-muted",
};

export function FeatureDispositionList({
  effects,
  unknownFeatures,
}: {
  effects: readonly ProtocolFeatureEffectV1[];
  unknownFeatures: readonly ProtocolFeature[];
}) {
  const t = useT();
  if (effects.length === 0 && unknownFeatures.length === 0) {
    return <p className="muted small">{t("api.plan.noFeatures")}</p>;
  }
  return (
    <ul className="protocol-feature-list">
      {effects.map(effect => (
        <li key={effect.feature}>
          <code>{effect.feature}</code>
          <span className={`badge ${DISPOSITION_TONES[effect.disposition]}`}>{t(DISPOSITION_KEYS[effect.disposition])}</span>
        </li>
      ))}
      {unknownFeatures.map(feature => (
        <li key={feature}>
          <code>{feature}</code>
          <span className="badge badge-muted">{t("api.plan.disposition.unknown")}</span>
        </li>
      ))}
    </ul>
  );
}
