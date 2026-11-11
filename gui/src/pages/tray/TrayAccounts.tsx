import type { TFn } from '../../i18n/shared';
import { IconAlert } from '../../icons';
import { formatProviderDisplayName } from '../../provider-icons';
import { ProviderIcon } from '../../components/provider-workspace/ProviderRail';
import { quotaSeverity } from '../../quota-summary';
import { finite, quotaWindows, relativeReset, type TrayAccount, type TrayProvider, type TraySwitchKind } from '../tray-data';
import { TrayCard } from './TrayParts';

interface AccountsProps {
  provider: TrayProvider;
  switching: string | null;
  onSwitch: (provider: string, kind: TraySwitchKind, accountId: string) => void;
  locale: string;
  t: TFn;
}

function QuotaRows({ account, locale, t }: { account: TrayAccount; locale: string; t: TFn }) {
  const windows = quotaWindows(account.quota);
  if (!windows.length) return <p className="tray-missing">{t(account.unavailable ? 'startup.tray.unavailable' : 'pws.dashboard.noQuota')}</p>;
  return <>{windows.map(window => {
    const label = 'key' in window ? t(window.key!) : ('displayLabel' in window && window.displayLabel ? window.displayLabel : window.label);
    const reset = relativeReset(window.reset, locale);
    const percent = finite(window.percent) ? Math.min(100, window.percent) : null;
    return <div className="tray-quota" key={window.id}>
      <span className="tray-quota-label" title={label}>{label}</span>
      <span className={`tray-bar tray-bar--${quotaSeverity(percent ?? undefined)}`} role={percent === null ? 'img' : 'meter'} aria-label={percent === null ? `${label}: ${t('pws.dashboard.noQuota')}` : label} aria-valuemin={percent === null ? undefined : 0} aria-valuemax={percent === null ? undefined : 100} aria-valuenow={percent ?? undefined} aria-valuetext={percent === null ? undefined : `${Math.round(percent)}%`}><i style={{ width: percent === null ? '0%' : `${percent}%` }} /></span>
      <span className="tray-quota-value">{percent === null ? '—' : `${Math.round(percent)}%`}</span>
      <time title={reset.exact}>{reset.text}</time>
    </div>;
  })}</>;
}

/** One provider: its accounts, which one is in use, each quota window, and the switch. */
export function TrayProviderCard({ provider, switching, onSwitch, locale, t }: AccountsProps) {
  const kind = provider.switchKind;
  return <TrayCard className="tray-provider" title={<><ProviderIcon name={provider.name} cls="provider-icon tray-provider-icon" />{formatProviderDisplayName(provider.name, t)}</>}>
    {!provider.accounts.length && <p className="tray-missing">{t(provider.unavailable ? 'startup.tray.unavailable' : 'pws.dashboard.noQuota')}</p>}
    {provider.accounts.map(account => {
      const pending = switching === `${provider.name}:${account.id}`;
      return <div className="tray-account" key={account.id} data-active={account.active ? 'true' : undefined}>
        <div className="tray-account-name">
          <span className="tray-account-label" title={account.label}>{account.label}</span>
          {account.exhausted && <span className="tray-exhausted" title={t('quota.limitReached')} aria-label={t('quota.limitReached')}><IconAlert aria-hidden="true" /></span>}
          {account.active && <span className="tray-badge tray-badge--active">{t('prov.activeBadge')}</span>}
          {account.plan && <span className="tray-badge">{account.plan}</span>}
          <span className="tray-account-action">
            {pending && <span role="status">{t('pws.accountSwitching')}</span>}
            {!pending && kind && account.switchState === 'available' && <button type="button" className="tray-use" disabled={switching !== null} onClick={() => onSwitch(provider.name, kind, account.id)} title={t('prov.accountSwitchTitle')} aria-label={`${t('prov.accountSwitchTitle')}: ${account.label}`}>{t('prov.accountSwitchTitle')}</button>}
          </span>
        </div>
        {account.email && account.email !== account.label && <div className="tray-account-email">{account.email}</div>}
        <QuotaRows account={account} locale={locale} t={t} />
      </div>;
    })}
  </TrayCard>;
}
