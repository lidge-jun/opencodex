import type { Locale } from "./catalogs";

export type LogGuardSchemaState = "compatible" | "missing" | "unreadable" | "unsupported";
export type LogGuardProtectionState = "off" | "active" | "drifted" | "unsupported" | "unknown";
export type LogGuardProtectionMode = "off" | "compat" | "quiet" | "collision";

type StateLabels = {
  schema: Record<LogGuardSchemaState, string>;
  protection: Record<LogGuardProtectionState, string>;
  mode: Record<LogGuardProtectionMode, string>;
};

const LABELS: Record<Locale, StateLabels> = {
  en: {
    schema: { compatible: "Compatible", missing: "Database not found", unreadable: "Database unavailable", unsupported: "Unsupported" },
    protection: { off: "Off", active: "Active", drifted: "Needs repair", unsupported: "Unsupported", unknown: "Unknown" },
    mode: { off: "Off", compat: "Compatibility", quiet: "Quiet", collision: "Unknown" },
  },
  de: {
    schema: { compatible: "Kompatibel", missing: "Datenbank nicht gefunden", unreadable: "Datenbank nicht lesbar", unsupported: "Nicht unterstützt" },
    protection: { off: "Aus", active: "Aktiv", drifted: "Reparatur erforderlich", unsupported: "Nicht unterstützt", unknown: "Unbekannt" },
    mode: { off: "Aus", compat: "Kompatibilität", quiet: "Leise", collision: "Unbekannt" },
  },
  fr: {
    schema: { compatible: "Compatible", missing: "Base de données introuvable", unreadable: "Base de données indisponible", unsupported: "Non pris en charge" },
    protection: { off: "Désactivée", active: "Active", drifted: "Réparation requise", unsupported: "Non prise en charge", unknown: "Inconnue" },
    mode: { off: "Désactivé", compat: "Compatibilité", quiet: "Silencieux", collision: "Inconnu" },
  },
  ko: {
    schema: { compatible: "호환됨", missing: "데이터베이스 없음", unreadable: "데이터베이스를 읽을 수 없음", unsupported: "지원되지 않음" },
    protection: { off: "꺼짐", active: "활성", drifted: "복구 필요", unsupported: "지원되지 않음", unknown: "알 수 없음" },
    mode: { off: "꺼짐", compat: "호환 모드", quiet: "조용한 모드", collision: "알 수 없음" },
  },
  zh: {
    schema: { compatible: "兼容", missing: "未找到数据库", unreadable: "无法读取数据库", unsupported: "不受支持" },
    protection: { off: "关闭", active: "已启用", drifted: "需要修复", unsupported: "不受支持", unknown: "未知" },
    mode: { off: "关闭", compat: "兼容模式", quiet: "静默模式", collision: "未知" },
  },
  "zh-TW": {
    schema: { compatible: "相容", missing: "找不到資料庫", unreadable: "無法讀取資料庫", unsupported: "不支援" },
    protection: { off: "關閉", active: "已啟用", drifted: "需要修復", unsupported: "不支援", unknown: "未知" },
    mode: { off: "關閉", compat: "相容模式", quiet: "靜默模式", collision: "未知" },
  },
  ru: {
    schema: { compatible: "Совместимо", missing: "База не найдена", unreadable: "База недоступна", unsupported: "Не поддерживается" },
    protection: { off: "Выключено", active: "Активно", drifted: "Требуется восстановление", unsupported: "Не поддерживается", unknown: "Неизвестно" },
    mode: { off: "Выключено", compat: "Совместимость", quiet: "Тихий режим", collision: "Неизвестно" },
  },
  ja: {
    schema: { compatible: "互換", missing: "データベースが見つかりません", unreadable: "データベースを読み取れません", unsupported: "未対応" },
    protection: { off: "オフ", active: "有効", drifted: "修復が必要", unsupported: "未対応", unknown: "不明" },
    mode: { off: "オフ", compat: "互換モード", quiet: "静音モード", collision: "不明" },
  },
  tr: {
    schema: { compatible: "Uyumlu", missing: "Veritabanı bulunamadı", unreadable: "Veritabanı okunamıyor", unsupported: "Desteklenmiyor" },
    protection: { off: "Kapalı", active: "Etkin", drifted: "Onarım gerekli", unsupported: "Desteklenmiyor", unknown: "Bilinmiyor" },
    mode: { off: "Kapalı", compat: "Uyumluluk", quiet: "Sessiz", collision: "Bilinmiyor" },
  },
};

export function logGuardSchemaStateLabel(locale: Locale, state: LogGuardSchemaState): string {
  return LABELS[locale].schema[state];
}

export function logGuardProtectionStateLabel(locale: Locale, state: LogGuardProtectionState): string {
  return LABELS[locale].protection[state];
}

export function logGuardProtectionModeLabel(locale: Locale, mode: LogGuardProtectionMode): string {
  return LABELS[locale].mode[mode];
}
