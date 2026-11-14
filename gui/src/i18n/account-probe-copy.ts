type Locale = "en" | "ko" | "de" | "fr" | "zh" | "zh-TW" | "ru" | "ja" | "tr" | "vi" | "pt";
const locales: readonly Locale[] = ["en", "ko", "de", "fr", "zh", "zh-TW", "ru", "ja", "tr", "vi", "pt"];
type Row = readonly [string, string, string, string, string, string, string, string, string, string, string];

/** Per-account probe and manual model discovery copy, one row per key in `locales` order. */
const rows = {
  "acctProbe.test": ["Test", "테스트", "Testen", "Tester", "测试", "測試", "Проверить", "テスト", "Test et", "Kiểm tra", "Testar"],
  "acctProbe.testing": ["Testing…", "테스트 중…", "Wird getestet…", "Test en cours…", "测试中…", "測試中…", "Проверка…", "テスト中…", "Test ediliyor…", "Đang kiểm tra…", "Testando…"],
  "acctProbe.testAll": ["Test all", "모두 테스트", "Alle testen", "Tout tester", "全部测试", "全部測試", "Проверить все", "すべてテスト", "Tümünü test et", "Kiểm tra tất cả", "Testar todas"],
  "acctProbe.hint": ["Read-only: sends one quota request with this account's stored token. Expired tokens are reported, never refreshed.", "읽기 전용: 이 계정에 저장된 토큰으로 할당량 요청을 한 번 보냅니다. 만료된 토큰은 갱신하지 않고 그대로 보고합니다.", "Nur lesend: sendet eine Kontingentanfrage mit dem gespeicherten Token dieses Kontos. Abgelaufene Tokens werden gemeldet, nie erneuert.", "Lecture seule : envoie une requête de quota avec le jeton enregistré de ce compte. Un jeton expiré est signalé, jamais renouvelé.", "只读：用该账号已存的 token 发一次额度查询。token 已过期时只报告，不刷新。", "唯讀：用該帳號已存的 Token 送出一次額度查詢。Token 已過期時只回報，不刷新。", "Только чтение: один запрос квоты с сохранённым токеном аккаунта. Истёкший токен только отмечается, не обновляется.", "読み取り専用：このアカウントの保存済みトークンでクォータ要求を 1 回送ります。期限切れトークンは報告のみで更新しません。", "Salt okunur: bu hesabın kayıtlı belirteciyle bir kota isteği gönderir. Süresi dolmuş belirteç yenilenmez, yalnızca bildirilir.", "Chỉ đọc: gửi một yêu cầu hạn mức bằng token đã lưu của tài khoản. Token hết hạn chỉ được báo, không làm mới.", "Somente leitura: envia uma consulta de cota com o token salvo desta conta. Tokens expirados são informados, nunca renovados."],
  "acctProbe.failed": ["Test request failed", "테스트 요청 실패", "Testanfrage fehlgeschlagen", "La requête de test a échoué", "测试请求失败", "測試請求失敗", "Запрос проверки не выполнен", "テスト要求に失敗しました", "Test isteği başarısız", "Yêu cầu kiểm tra thất bại", "Falha na solicitação de teste"],
  "acctProbe.status.ok": ["Usable", "사용 가능", "Nutzbar", "Utilisable", "可用", "可用", "Работает", "利用可能", "Kullanılabilir", "Dùng được", "Utilizável"],
  "acctProbe.status.paused": ["Paused (not tested)", "일시 중지됨(테스트 안 함)", "Pausiert (nicht getestet)", "En pause (non testé)", "已暂停（未测试）", "已暫停（未測試）", "Приостановлен (не проверялся)", "一時停止中（未テスト）", "Duraklatıldı (test edilmedi)", "Đã tạm dừng (không kiểm tra)", "Pausada (não testada)"],
  "acctProbe.status.token_expired": ["Token expired (not refreshed)", "토큰 만료(갱신 안 함)", "Token abgelaufen (nicht erneuert)", "Jeton expiré (non renouvelé)", "token 已过期（未刷新）", "Token 已過期（未刷新）", "Токен истёк (не обновлён)", "トークン期限切れ（未更新）", "Belirteç süresi doldu (yenilenmedi)", "Token hết hạn (chưa làm mới)", "Token expirado (não renovado)"],
  "acctProbe.status.suspended": ["Suspended", "정지됨", "Gesperrt", "Suspendu", "已暂停", "已暫停", "Приостановлен", "停止中", "Askıya alındı", "Bị đình chỉ", "Suspensa"],
  "acctProbe.status.verification_required": ["Verification required", "인증 필요", "Verifizierung erforderlich", "Vérification requise", "要求验证", "需要驗證", "Требуется подтверждение", "確認が必要", "Doğrulama gerekli", "Cần xác minh", "Verificação necessária"],
  "acctProbe.status.rate_limited": ["Rate limited", "요청 제한", "Ratenlimit", "Limite de débit", "限流", "限流", "Ограничение частоты", "レート制限", "Hız sınırı", "Bị giới hạn tốc độ", "Limite de taxa"],
  "acctProbe.status.permission_denied": ["Permission denied (403)", "권한 거부(403)", "Zugriff verweigert (403)", "Accès refusé (403)", "权限拒绝（403）", "權限遭拒（403）", "Доступ запрещён (403)", "権限拒否（403）", "İzin reddedildi (403)", "Bị từ chối quyền (403)", "Permissão negada (403)"],
  "acctProbe.status.error": ["Other error", "기타 오류", "Anderer Fehler", "Autre erreur", "其他错误", "其他錯誤", "Другая ошибка", "その他のエラー", "Diğer hata", "Lỗi khác", "Outro erro"],
  "modelDiscover.now": ["Discover now", "지금 검색", "Jetzt abrufen", "Découvrir maintenant", "立即发现", "立即探索", "Найти сейчас", "今すぐ検出", "Şimdi keşfet", "Khám phá ngay", "Descobrir agora"],
  "modelDiscover.running": ["Discovering…", "검색 중…", "Wird abgerufen…", "Découverte…", "发现中…", "探索中…", "Поиск…", "検出中…", "Keşfediliyor…", "Đang khám phá…", "Descobrindo…"],
  "modelDiscover.recent": ["Recently added models", "최근 추가된 모델", "Kürzlich hinzugekommene Modelle", "Modèles ajoutés récemment", "最近新增的模型", "最近新增的模型", "Недавно добавленные модели", "最近追加されたモデル", "Son eklenen modeller", "Mô hình mới thêm gần đây", "Modelos adicionados recentemente"],
  "modelDiscover.none": ["No new models recorded yet.", "아직 기록된 새 모델이 없습니다.", "Noch keine neuen Modelle erfasst.", "Aucun nouveau modèle enregistré pour l’instant.", "还没有记录到新模型。", "尚未記錄到新模型。", "Новые модели пока не обнаружены.", "新しいモデルはまだ記録されていません。", "Henüz yeni model kaydedilmedi.", "Chưa ghi nhận mô hình mới nào.", "Nenhum modelo novo registrado ainda."],
  "modelDiscover.result": ["{count} live models, {added} new", "실시간 모델 {count}개, 새 모델 {added}개", "{count} Live-Modelle, {added} neu", "{count} modèles en direct, {added} nouveaux", "共 {count} 个在线模型，新增 {added} 个", "共 {count} 個線上模型，新增 {added} 個", "Моделей: {count}, новых: {added}", "ライブモデル {count} 件、新規 {added} 件", "{count} canlı model, {added} yeni", "{count} mô hình trực tiếp, {added} mới", "{count} modelos ativos, {added} novos"],
  "modelDiscover.failed": ["Discovery failed", "검색 실패", "Abruf fehlgeschlagen", "Échec de la découverte", "发现失败", "探索失敗", "Поиск не удался", "検出に失敗しました", "Keşif başarısız", "Khám phá thất bại", "Falha na descoberta"],
  "modelDiscover.static": ["Live discovery is off for this provider.", "이 공급자는 실시간 검색이 꺼져 있습니다.", "Live-Abruf ist für diesen Anbieter aus.", "La découverte en direct est désactivée pour ce fournisseur.", "该供应商未开启在线发现。", "此供應商未開啟線上探索。", "Для этого провайдера поиск моделей отключён.", "このプロバイダーはライブ検出がオフです。", "Bu sağlayıcı için canlı keşif kapalı.", "Nhà cung cấp này đang tắt khám phá trực tiếp.", "A descoberta ao vivo está desativada para este provedor."],
  "modelDiscover.autoDisabled": ["hidden by new-model policy", "새 모델 정책으로 숨김", "durch Neu-Modell-Richtlinie ausgeblendet", "masqué par la règle des nouveaux modèles", "按新模型策略已隐藏", "依新模型政策已隱藏", "скрыта политикой новых моделей", "新モデルポリシーで非表示", "yeni model politikasıyla gizlendi", "bị ẩn theo chính sách mô hình mới", "oculto pela política de novos modelos"],
  "modelDiscover.new": ["NEW", "NEW", "NEU", "NOUVEAU", "新", "新", "НОВАЯ", "NEW", "YENİ", "MỚI", "NOVO"],
} as const satisfies Record<string, Row>;

export type AccountProbeCopyKey = keyof typeof rows;

export function accountProbeCopy(locale: Locale): Record<AccountProbeCopyKey, string> {
  const index = locales.indexOf(locale);
  return Object.fromEntries(Object.entries(rows).map(([key, values]) => [key, values[index]!])) as Record<AccountProbeCopyKey, string>;
}
