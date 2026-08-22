import type { Locale } from "./catalogs";

export type LogGuardOperationLabelKey =
  | "applying"
  | "error.generic"
  | "error.codex_running"
  | "error.process_enumeration_failed"
  | "error.busy"
  | "error.unsupported_schema"
  | "error.unsafe_path"
  | "error.database_error"
  | "error.auto_vacuum_not_incremental"
  | "error.integrity_check_failed";

const LABELS: Record<Locale, Record<LogGuardOperationLabelKey, string>> = {
  en: {
    applying: "Applying Log Guard change…",
    "error.generic": "Could not update Codex log storage.",
    "error.codex_running": "Quit Codex before changing Codex log storage.",
    "error.process_enumeration_failed": "Could not verify that Codex is stopped. The Log Guard operation was not started.",
    "error.busy": "The Codex logs database is busy. Quit Codex and try again.",
    "error.unsupported_schema": "This Codex logs schema is not supported for this operation.",
    "error.unsafe_path": "The Codex logs database path failed the safety check.",
    "error.database_error": "Could not update the Codex logs database.",
    "error.auto_vacuum_not_incremental": "This Codex logs database is not configured for incremental vacuum, so space cannot be reclaimed without a full rebuild.",
    "error.integrity_check_failed": "The Codex logs database failed its integrity check. No space was reclaimed.",
  },
  de: {
    applying: "Log-Guard-Änderung wird angewendet…",
    "error.generic": "Der Codex-Protokollspeicher konnte nicht aktualisiert werden.",
    "error.codex_running": "Beende Codex, bevor du den Codex-Protokollspeicher änderst.",
    "error.process_enumeration_failed": "Es konnte nicht sicher festgestellt werden, dass Codex beendet ist. Der Log-Guard-Vorgang wurde nicht gestartet.",
    "error.busy": "Die Codex-Protokolldatenbank ist belegt. Beende Codex und versuche es erneut.",
    "error.unsupported_schema": "Dieses Schema der Codex-Protokolldatenbank wird für diesen Vorgang nicht unterstützt.",
    "error.unsafe_path": "Der Pfad der Codex-Protokolldatenbank hat die Sicherheitsprüfung nicht bestanden.",
    "error.database_error": "Die Codex-Protokolldatenbank konnte nicht aktualisiert werden.",
    "error.auto_vacuum_not_incremental": "Diese Codex-Protokolldatenbank ist nicht fuer inkrementelles Vacuum konfiguriert; ohne vollstaendigen Neuaufbau kann kein Speicher freigegeben werden.",
    "error.integrity_check_failed": "Die Integritaetspruefung der Codex-Protokolldatenbank ist fehlgeschlagen. Es wurde kein Speicher freigegeben.",
  },
  fr: {
    applying: "Application de la modification Log Guard…",
    "error.generic": "Impossible de mettre à jour le stockage des journaux Codex.",
    "error.codex_running": "Quittez Codex avant de modifier le stockage des journaux Codex.",
    "error.process_enumeration_failed": "Impossible de vérifier que Codex est arrêté. L’opération Log Guard n’a pas été lancée.",
    "error.busy": "La base de données des journaux Codex est occupée. Quittez Codex et réessayez.",
    "error.unsupported_schema": "Ce schéma de journaux Codex n’est pas pris en charge pour cette opération.",
    "error.unsafe_path": "Le chemin de la base de données des journaux Codex a échoué au contrôle de sécurité.",
    "error.database_error": "Impossible de mettre à jour la base de données des journaux Codex.",
    "error.auto_vacuum_not_incremental": "Cette base de donnees de journaux Codex n'est pas configuree pour le vacuum incrementiel : l'espace ne peut pas etre recupere sans reconstruction complete.",
    "error.integrity_check_failed": "La verification d'integrite de la base de donnees de journaux Codex a echoue. Aucun espace n'a ete recupere.",
  },
  ko: {
    applying: "Log Guard 변경 적용 중…",
    "error.generic": "Codex 로그 저장소를 업데이트하지 못했습니다.",
    "error.codex_running": "Codex 로그 저장소를 변경하기 전에 Codex를 종료하세요.",
    "error.process_enumeration_failed": "Codex가 종료되었는지 확인할 수 없어 Log Guard 작업을 시작하지 않았습니다.",
    "error.busy": "Codex 로그 데이터베이스가 사용 중입니다. Codex를 종료한 뒤 다시 시도하세요.",
    "error.unsupported_schema": "이 Codex 로그 스키마는 이 작업을 지원하지 않습니다.",
    "error.unsafe_path": "Codex 로그 데이터베이스 경로가 안전성 검사를 통과하지 못했습니다.",
    "error.database_error": "Codex 로그 데이터베이스를 업데이트하지 못했습니다.",
    "error.auto_vacuum_not_incremental": "이 Codex 로그 데이터베이스는 증분 정리로 구성되어 있지 않아, 전체 재구축 없이는 공간을 회수할 수 없습니다.",
    "error.integrity_check_failed": "Codex 로그 데이터베이스 무결성 검사에 실패했습니다. 공간이 회수되지 않았습니다.",
  },
  zh: {
    applying: "正在应用 Log Guard 更改…",
    "error.generic": "无法更新 Codex 日志存储。",
    "error.codex_running": "更改 Codex 日志存储前请先退出 Codex。",
    "error.process_enumeration_failed": "无法确认 Codex 已停止，因此未启动 Log Guard 操作。",
    "error.busy": "Codex 日志数据库正忙。请退出 Codex 后重试。",
    "error.unsupported_schema": "此 Codex 日志数据库结构不支持此操作。",
    "error.unsafe_path": "Codex 日志数据库路径未通过安全检查。",
    "error.database_error": "无法更新 Codex 日志数据库。",
    "error.auto_vacuum_not_incremental": "此 Codex 日志数据库未配置增量清理，因此不完整重建就无法回收空间。",
    "error.integrity_check_failed": "Codex 日志数据库完整性检查失败，未回收任何空间。",
  },
  "zh-TW": {
    applying: "正在套用 Log Guard 變更…",
    "error.generic": "無法更新 Codex 日誌儲存空間。",
    "error.codex_running": "變更 Codex 日誌儲存空間前請先退出 Codex。",
    "error.process_enumeration_failed": "無法確認 Codex 已停止，因此未啟動 Log Guard 操作。",
    "error.busy": "Codex 日誌資料庫忙碌中。請退出 Codex 後重試。",
    "error.unsupported_schema": "此 Codex 日誌資料庫結構不支援此操作。",
    "error.unsafe_path": "Codex 日誌資料庫路徑未通過安全檢查。",
    "error.database_error": "無法更新 Codex 日誌資料庫。",
    "error.auto_vacuum_not_incremental": "此 Codex 日志数据库未配置增量清理，因此不完整重建就无法回收空间。",
    "error.integrity_check_failed": "Codex 日志数据库完整性检查失败，未回收任何空间。",
  },
  ru: {
    applying: "Применение изменения Log Guard…",
    "error.generic": "Не удалось обновить хранилище журналов Codex.",
    "error.codex_running": "Закройте Codex перед изменением хранилища журналов Codex.",
    "error.process_enumeration_failed": "Не удалось убедиться, что Codex остановлен. Операция Log Guard не запущена.",
    "error.busy": "База журналов Codex занята. Закройте Codex и повторите попытку.",
    "error.unsupported_schema": "Эта схема базы журналов Codex не поддерживает эту операцию.",
    "error.unsafe_path": "Путь к базе журналов Codex не прошёл проверку безопасности.",
    "error.database_error": "Не удалось обновить базу журналов Codex.",
    "error.auto_vacuum_not_incremental": "Эта база данных журналов Codex не настроена на инкрементальную очистку, поэтому освободить место без полной перестройки невозможно.",
    "error.integrity_check_failed": "Проверка целостности базы данных журналов Codex не пройдена. Место не освобождено.",
  },
  ja: {
    applying: "Log Guard の変更を適用中…",
    "error.generic": "Codex ログストレージを更新できませんでした。",
    "error.codex_running": "Codex ログストレージを変更する前に Codex を終了してください。",
    "error.process_enumeration_failed": "Codex が停止していることを確認できなかったため、Log Guard 操作を開始しませんでした。",
    "error.busy": "Codex ログデータベースが使用中です。Codex を終了して再試行してください。",
    "error.unsupported_schema": "この Codex ログスキーマではこの操作を使用できません。",
    "error.unsafe_path": "Codex ログデータベースのパスが安全性チェックに失敗しました。",
    "error.database_error": "Codex ログデータベースを更新できませんでした。",
    "error.auto_vacuum_not_incremental": "この Codex ログ データベースは増分バキューム用に構成されていないため、完全な再構築なしに領域を解放できません。",
    "error.integrity_check_failed": "Codex ログ データベースの整合性チェックに失敗しました。領域は解放されていません。",
  },
  tr: {
    applying: "Log Guard değişikliği uygulanıyor…",
    "error.generic": "Codex günlük depolaması güncellenemedi.",
    "error.codex_running": "Codex günlük depolamasını değiştirmeden önce Codex'i kapatın.",
    "error.process_enumeration_failed": "Codex'in kapalı olduğu doğrulanamadı. Log Guard işlemi başlatılmadı.",
    "error.busy": "Codex günlük veritabanı meşgul. Codex'i kapatıp yeniden deneyin.",
    "error.unsupported_schema": "Bu Codex günlük şeması bu işlem için desteklenmiyor.",
    "error.unsafe_path": "Codex günlük veritabanı yolu güvenlik denetimini geçemedi.",
    "error.database_error": "Codex günlük veritabanı güncellenemedi.",
    "error.auto_vacuum_not_incremental": "Bu Codex gunluk veritabani artimli vacuum icin yapilandirilmamis; tam yeniden olusturma olmadan alan geri kazanilamaz.",
    "error.integrity_check_failed": "Codex gunluk veritabani butunluk denetiminden gecemedi. Alan geri kazanilmadi.",
  },
};

export function logGuardOperationLabel(locale: Locale, key: LogGuardOperationLabelKey): string {
  return LABELS[locale][key];
}
