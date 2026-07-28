import {
  formatCreditDate as formatCreditDateIntl,
  formatCreditDateTime as formatCreditDateTimeIntl,
} from "../intl-formatters";

export function formatCreditDate(iso: string): string {
  return formatCreditDateIntl(iso);
}

export function formatCreditDateTime(iso: string): string {
  return formatCreditDateTimeIntl(iso);
}

export function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}
