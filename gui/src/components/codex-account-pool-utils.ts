import {
  formatCreditDate as formatCreditDateIntl,
  formatCreditDateTime as formatCreditDateTimeIntl,
} from "../intl-formatters";

export function formatCreditDate(iso: string, locale?: string): string {
  return formatCreditDateIntl(iso, locale);
}

export function formatCreditDateTime(iso: string, locale?: string): string {
  return formatCreditDateTimeIntl(iso, locale);
}

export function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}
