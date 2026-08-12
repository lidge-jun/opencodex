import { catalogValue, type Locale } from "./i18n/catalogs";

export function formatUptime(seconds: number, locale: Locale): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const day = catalogValue(locale, "uptime.day");
  const hour = catalogValue(locale, "uptime.hour");
  const minute = catalogValue(locale, "uptime.minute");
  const second = catalogValue(locale, "uptime.second");

  if (totalSeconds < 5 * 60) return `${totalSeconds}${second}`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}${minute}`;

  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${totalHours}${hour} ${minutes}${minute}` : `${totalHours}${hour}`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${days}${day} ${hours}${hour}` : `${days}${day}`;
}
