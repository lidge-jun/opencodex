import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/shared';
import { formatTokens } from '../format-tokens';
import { formatProviderDisplayName } from '../provider-icons';
import { UsageCompanionChart } from './usage-companion-chart';
import { type CompanionSettings, type CompanionSettingsResponse, type UsageTimeline } from './usage-companion-utils';
import { fetchTrayJson, parseTrayUsage, filterUsage, measuredTotals, finite, parseAccounts, providerSources, quotaWindows, relativeReset, type TrayProvider, type TrayTotals, type TrayUsage } from './tray-data';

declare global { interface Window { __OPENCODEX_TRAY_VISIBLE__?: boolean } }

const incomplete = (data: TrayUsage | null | undefined) => data?.usageIncomplete || data?.historyTruncated || data?.entriesTruncated;

export default function Tray() {
  const { t, locale } = useI18n();
  const [settings, setSettings] = useState<CompanionSettings | null>(null);
  const [settingsError, setSettingsError] = useState(false);
  const [usage, setUsage] = useState<(TrayUsage | null)[]>([null, null]);
  const [usageError, setUsageError] = useState(false);
  const [providers, setProviders] = useState<TrayProvider[]>([]);
  const [quotaError, setQuotaError] = useState(false);
  const [timeline, setTimeline] = useState<UsageTimeline | null>(null);
  const [chartError, setChartError] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const retry = () => setRevision(value => value + 1);

  // Every post-await state write checks both effect disposal and the request's AbortSignal.
  // react-doctor-disable-next-line react-doctor/no-set-state-after-await-in-effect
  useEffect(() => {
    document.documentElement.classList.add('tray-document');
    let controller: AbortController | null = null;
    let busy = false;
    let focused = true;
    let disposed = false;
    const visible = () => !document.hidden && (window.__OPENCODEX_TRAY_VISIBLE__ ?? focused);
    const load = async () => {
      if (!visible() || busy) return;
      busy = true;
      setRefreshing(true);
      let hadSuccess = false;
      const current = new AbortController();
      controller = current;
      const json = <T,>(path: string) => fetchTrayJson<T>(path, current.signal);
      const active = () => !disposed && !current.signal.aborted;
      try {
        // Quotas load independently: usage/settings failures must not hide account limits.
        const quotas = (async () => {
          try {
            const sources = providerSources(await json<unknown>('/api/config'));
            const rows = await Promise.all(sources.map(async source => {
              if (!source.path) return { name: source.name, accounts: [] };
              try {
                const payload = await json<Record<string, unknown>>(source.path);
                if (source.name === 'openai') {
                  try {
                    const selection = await json<{ activeCodexAccountId?: string | null }>('/api/codex-auth/active');
                    payload.activeCodexAccountId = selection.activeCodexAccountId ?? '__main__';
                  } catch { /* Missing selection is unknown, never inferred from quota. */ }
                }
                return { name: source.name, accounts: parseAccounts(payload) };
              }
              catch { return { name: source.name, accounts: [], unavailable: true }; }
            }));
            if (active()) { setProviders(rows); setQuotaError(false); hadSuccess = true; }
          } catch { if (active()) { setProviders([]); setQuotaError(true); } }
        })();
        const metrics = (async () => {
          let config: CompanionSettings;
          try {
            config = (await json<CompanionSettingsResponse>('/api/companion/settings')).settings;
            if (!config || !Array.isArray(config.hiddenProviders) || !(config.models === null || Array.isArray(config.models))) throw new Error('Invalid settings');
            if (active()) { setSettings(config); setSettingsError(false); }
          } catch { if (active()) setSettingsError(true); return; }
          const totals = Promise.allSettled(['/api/usage?range=today', '/api/usage?range=30d'].map(async path => {
            const data = parseTrayUsage(await json<unknown>(path));
            return filterUsage(data, config);
          })).then(results => {
            if (active()) {
              hadSuccess ||= results.some(result => result.status === 'fulfilled');
              setUsage(results.map(result => result.status === 'fulfilled' ? result.value : null));
              setUsageError(results.some(result => result.status === 'rejected'));
            }
          });
          const chart = (async () => {
            if (!config.showChart) return;
            const query = new URLSearchParams({ hours: String(config.chartHours), bucketMinutes: String(config.bucketMinutes), metric: config.tokenMetric, aggregation: config.aggregation, grouping: config.chartGrouping });
            if (config.models?.length) query.set('models', config.models.join(','));
            try {
              const data = await json<UsageTimeline>(`/api/usage/timeline?${query}`);
              const hiddenProviders = new Set(config.hiddenProviders);
              const configuredModels = config.models === null ? null : new Set(config.models);
              const series = data.series.filter(row => !hiddenProviders.has(row.provider) && (configuredModels === null || configuredModels.has(`${row.provider}/${row.model}`) || configuredModels.has(row.model)));
              if (active()) { setTimeline({ ...data, series }); setChartError(false); }
            } catch { if (active()) { setTimeline(null); setChartError(true); } }
          })();
          await Promise.allSettled([totals, chart]);
        })();
        await Promise.allSettled([quotas, metrics]);
      } finally {
        busy = false;
        if (active()) { setRefreshing(false); if (hadSuccess) setUpdatedAt(Date.now()); }
        if (!disposed && current.signal.aborted && visible()) void load();
      }
    };
    const changed = () => { if (!visible()) { controller?.abort(); } else void load(); };
    const blur = () => { focused = false; changed(); };
    const focus = () => { focused = true; changed(); };
    const nativeVisibility = (event: Event) => {
      const value = (event as CustomEvent<unknown>).detail;
      if (typeof value === 'boolean') window.__OPENCODEX_TRAY_VISIBLE__ = value;
      changed();
    };
    void load();
    const timer = setInterval(() => void load(), 60_000);
    document.addEventListener('visibilitychange', changed);
    window.addEventListener('blur', blur);
    window.addEventListener('focus', focus);
    window.addEventListener('opencodex:tray-visibility', nativeVisibility);
    return () => {
      disposed = true; controller?.abort(); clearInterval(timer);
      document.documentElement.classList.remove('tray-document');
      document.removeEventListener('visibilitychange', changed);
      window.removeEventListener('blur', blur); window.removeEventListener('focus', focus);
      window.removeEventListener('opencodex:tray-visibility', nativeVisibility);
    };
  }, [revision]);

  const number = (value: unknown) => finite(value) ? formatTokens(value, locale) : '—';
  const totals = (raw: TrayTotals | undefined) => {
    const data = raw ? measuredTotals(raw) : undefined;
    const cached = data?.cacheReadInputTokens ?? data?.cachedInputTokens;
    const percent = finite(cached) && finite(data?.inputTokens) && data.inputTokens > 0 ? `${Math.round(cached / data.inputTokens * 100)}%` : '—';
    return <dl>
      <div><dt>{t('usage.card.totalTokens')}</dt><dd>{number(data?.totalTokens)}</dd></div>
      <div><dt>{t('tray.input')}</dt><dd>{number(data?.inputTokens)} <small title={t('usage.card.cachedTokens')}>{t('tray.cached', { percent })}</small></dd></div>
      <div><dt>{t('tray.output')}</dt><dd>{number(data?.outputTokens)}</dd></div>
      {settings?.showCost && <div><dt title={t('logs.metric.estimatedCostTitle')}>{t('tray.cost')}</dt><dd title={finite(data?.requests) && finite(data?.pricedRequests) && data.pricedRequests < data.requests ? t('usage.cost.unpricedNote', { count: data.requests - data.pricedRequests }) : t('logs.metric.estimatedCostTitle')}>{finite(data?.estimatedCostUsd) ? new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(data.estimatedCostUsd) + (finite(data.pricedRequests) && finite(data.requests) && data.pricedRequests < data.requests ? '*' : '') : '—'}</dd></div>}
      <div><dt>{t('usage.card.requests')}</dt><dd>{number(data?.requests)}</dd></div>
      {finite(data?.requests) && data.requests > 0 && finite(data.measuredRequests) && data.measuredRequests < data.requests && <div className="tray-coverage" title={t('usage.coverage.note')}><dt>{t('usage.card.coverage')}</dt><dd>{Math.round(data.measuredRequests / data.requests * 100)}%</dd></div>}
    </dl>;
  };
  const hiddenProviders = new Set(settings?.hiddenProviders ?? []);
  return <main className="tray-page">
    <header><strong>OpenCodex</strong><a href="/?desktop=open#/usage" aria-label={t('sub.settings')} title={t('sub.settings')}>⚙</a></header>
    {settingsError && <p role="alert" className="tray-error">{t('usage.companion.settingsUnavailable')} <button onClick={retry}>{t('common.retry')}</button></p>}
    {!settings && !settingsError && <p role="status">{t('common.loading')}</p>}
    {settings && <section className="tray-totals">
      {settings.showToday && <div><h2>{t('tray.today')}{incomplete(usage[0]) && <span title={t('usage.incomplete')} aria-label={t('usage.incomplete')}> *</span>}</h2>{totals(usage[0]?.summary)}</div>}
      <div><h2>{t('usage.range.30d')}{incomplete(usage[1]) && <span title={t('usage.incomplete')} aria-label={t('usage.incomplete')}> *</span>}</h2>{totals(usage[1]?.summary)}</div>
    </section>}
    {usageError && <p role="alert" className="tray-error">{t('usage.loadError')} <button onClick={retry}>{t('common.retry')}</button></p>}
    {settings?.showChart && <section className="tray-chart"><UsageCompanionChart timeline={timeline} chartStyle={settings.chartStyle} hours={settings.chartHours} loading={!timeline && !chartError} error={chartError ? t('usage.companion.timelineUnavailable') : null} onRetry={retry} locale={locale} t={t} /></section>}
    {settings?.showModels && !!usage[0]?.models.length && <section className="tray-models" aria-label={t('usage.section.models')}>
      {usage[0].models.map(row => <div key={`${row.provider}/${row.model}`}><span title={`${row.provider}/${row.model}`}>{row.model}</span><span className="tray-model-metrics"><span title={t('usage.card.requests')}>{t('pws.dashboard.requests', { count: number(row.requests) })}</span><span title={t('usage.card.totalTokens')}>{number(measuredTotals(row).totalTokens)}</span></span></div>)}
    </section>}
    {(settings?.showAccounts ?? true) && <section className="tray-providers" aria-label={t('usage.section.providers')}>
      {quotaError && <p role="alert" className="tray-error">{t('startup.tray.unavailable')} <button onClick={retry}>{t('common.retry')}</button></p>}
      {providers.filter(provider => !hiddenProviders.has(provider.name)).map(provider => <div className="tray-provider" key={provider.name}>
        <h2>{formatProviderDisplayName(provider.name, t)}</h2>
        {!provider.accounts.length && <div className="tray-missing">{t(provider.unavailable ? 'startup.tray.unavailable' : 'pws.dashboard.noQuota')}</div>}
        {provider.accounts.map(account => <div className="tray-account" key={account.id}>
          <div className="tray-account-name" title={account.label}>{account.label}<span className="tray-account-meta">{account.plan}{account.active && <span title={t('prov.activeBadge')} aria-label={t('prov.activeBadge')}> ●</span>}</span></div>
          {account.email && account.email !== account.label && <div className="tray-account-email">{account.email}</div>}
          {!quotaWindows(account.quota).length && <div className="tray-missing">{t(account.unavailable ? 'startup.tray.unavailable' : 'pws.dashboard.noQuota')}</div>}
          {quotaWindows(account.quota).map(window => {
            const label = 'key' in window ? t(window.key!) : window.label;
            const reset = relativeReset(window.reset, locale);
            const percent = finite(window.percent) ? Math.min(100, window.percent) : null;
            return <div className="tray-quota" key={window.id}>
              <span title={label}>{label}</span><span>{percent === null ? '—' : `${Math.round(percent)}%`}</span>
              <span className="tray-bar" role={percent === null ? 'img' : 'meter'} aria-label={percent === null ? `${label}: ${t('pws.dashboard.noQuota')}` : label} aria-valuemin={percent === null ? undefined : 0} aria-valuemax={percent === null ? undefined : 100} aria-valuenow={percent ?? undefined} aria-valuetext={percent === null ? undefined : `${Math.round(percent)}%`}><i style={{ width: percent === null ? '0%' : `${percent}%` }} /></span>
              <time title={reset.exact}>{reset.text}</time>
            </div>;
          })}
        </div>)}
      </div>)}
    </section>}
    <div className="tray-refresh"><button type="button" onClick={retry} disabled={refreshing}>{t('startup.refresh')}</button><span role="status">{t('tray.updated', { time: updatedAt === null ? '—' : new Date(updatedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) })}</span></div>
    <footer><a href="/?desktop=open#/usage">{t('nav.dashboard')} <span aria-hidden="true">↗</span></a></footer>
  </main>;
}
