import type { ReactNode } from 'react';
import { IconSettings } from '@tabler/icons-react';
import { BrandMark } from '../../components/ui-v2/brand-mark';
import { IconExternal, IconRefresh } from '../../icons';
import type { TFn } from '../../i18n/shared';

/** Where the dashboard opens from the popover; the native panel links the same page. */
export const TRAY_DASHBOARD_HREF = '/?desktop=open#/usage';

/**
 * Connection state as the popover itself observed it: the runtime answered (`up`), could not be
 * reached (`down`), or nothing has come back yet (`loading`). It adds no request of its own.
 */
export type TrayConnection = 'up' | 'down' | 'loading';

export function TrayHeader({ connection, refreshing, onRefresh, t }: {
  connection: TrayConnection;
  refreshing: boolean;
  onRefresh: () => void;
  t: TFn;
}) {
  const status = connection === 'up' ? t('dash.online') : connection === 'down' ? t('startup.tray.unavailable') : t('common.loading');
  return <header className="tray-head">
    <span className="tray-brand"><BrandMark className="tray-brand-mark" />OpenCodex</span>
    <span className="tray-status" data-state={connection}><span className="tray-status-dot" aria-hidden="true" />{status}</span>
    <span className="tray-head-actions">
      <button type="button" className="tray-icon-btn" onClick={onRefresh} disabled={refreshing} aria-label={t('startup.refresh')} title={t('startup.refresh')}>
        <IconRefresh className={refreshing ? 'tray-spin' : undefined} aria-hidden="true" />
      </button>
      <a className="tray-icon-btn" href={TRAY_DASHBOARD_HREF} aria-label={t('sub.settings')} title={t('sub.settings')}>
        <IconSettings aria-hidden="true" stroke={1.75} />
      </a>
    </span>
  </header>;
}

/** A failure line with the retry it offers; tests find the retry as `[role="alert"] button`. */
export function TrayAlert({ children, onRetry, t }: { children: ReactNode; onRetry?: () => void; t: TFn }) {
  return <p role="alert" className="tray-error">
    <span>{children}</span>
    {onRetry && <button type="button" onClick={onRetry}>{t('common.retry')}</button>}
  </p>;
}

/**
 * Outer tinted frame with an optional title line around an inset body (Application UI card).
 * A group rather than a section: the dashboard's bridge spaces nested sections apart, and a
 * popover has no use for one landmark per card.
 */
export function TrayCard({ title, label, className, children }: { title?: ReactNode; label?: string; className?: string; children: ReactNode }) {
  return <div className={`tray-card${className ? ` ${className}` : ''}`} role={label ? 'group' : undefined} aria-label={label}>
    {title && <h2 className="tray-card-head">{title}</h2>}
    <div className="tray-card-body">{children}</div>
  </div>;
}

export function TrayFooter({ updated, t }: { updated: string; t: TFn }) {
  return <footer className="tray-foot">
    <span role="status">{updated}</span>
    <a className="tray-link" href={TRAY_DASHBOARD_HREF}>{t('nav.dashboard')}<IconExternal aria-hidden="true" /></a>
  </footer>;
}
