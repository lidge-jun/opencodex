export interface StatusCodeInfo { label: string; description: string }

type Locale = "en" | "de" | "ko" | "zh";
type LocalizedInfo = Record<Locale, StatusCodeInfo>;

const STATUS_CODES: Record<number, LocalizedInfo> = {
  400: {
    en: { label: "Bad request", description: "The proxy could not understand the request. Check the model, message shape, headers, and JSON body before retrying." },
    ko: { label: "잘못된 요청", description: "프록시가 요청을 이해할 수 없습니다. 재시도 전에 모델, 메시지 형식, 헤더, JSON 본문을 확인해야 합니다." },
    zh: { label: "错误请求", description: "代理无法理解该请求。重试前请检查模型、消息结构、标头和 JSON 正文。" },
    de: { label: "Ungültige Anfrage", description: "Der Proxy konnte die Anfrage nicht verstehen. Prüfe Modell, Nachrichtenformat, Header und JSON-Body vor einem erneuten Versuch." },
  },
  401: {
    en: { label: "Unauthorized", description: "Credentials are missing, expired, or invalid. Re-login or refresh the account/provider credentials used by opencodex." },
    ko: { label: "인증 필요", description: "자격 증명이 없거나 만료되었거나 유효하지 않습니다. opencodex에서 사용하는 계정 또는 제공자 자격 증명을 다시 로그인하거나 갱신해야 합니다." },
    zh: { label: "未授权", description: "凭据缺失、已过期或无效。请重新登录，或刷新 opencodex 使用的账号/提供商凭据。" },
    de: { label: "Nicht autorisiert", description: "Anmeldedaten fehlen, sind abgelaufen oder ungültig. Melde dich erneut an oder aktualisiere die von opencodex genutzten Konto-/Anbieter-Zugangsdaten." },
  },
  402: {
    en: { label: "Payment required", description: "The upstream provider rejected the request because billing, credits, or plan access is not available. Add credits, update billing, or switch provider." },
    ko: { label: "결제 필요", description: "청구, 크레딧, 플랜 접근 권한 문제로 업스트림 제공자가 요청을 거부했습니다. 크레딧 추가, 결제 정보 갱신, 제공자 전환이 필요합니다." },
    zh: { label: "需要付款", description: "上游提供商因账单、额度或套餐权限不可用而拒绝了请求。请充值、更新账单信息或切换提供商。" },
    de: { label: "Zahlung erforderlich", description: "Der Upstream-Anbieter hat die Anfrage abgelehnt, weil Abrechnung, Guthaben oder Planzugriff nicht verfügbar ist. Guthaben aufladen, Abrechnung aktualisieren oder Anbieter wechseln." },
  },
  403: {
    en: { label: "Forbidden", description: "The account is authenticated but not allowed to use this model or operation. Check provider permissions, org access, and policy restrictions." },
    ko: { label: "권한 없음", description: "계정 인증은 되었지만 이 모델 또는 작업을 사용할 권한이 없습니다. 제공자 권한, 조직 접근, 정책 제한을 확인해야 합니다." },
    zh: { label: "禁止访问", description: "账号已认证，但无权使用此模型或操作。请检查提供商权限、组织访问权限和策略限制。" },
    de: { label: "Verboten", description: "Das Konto ist authentifiziert, darf dieses Modell oder diese Operation aber nicht nutzen. Prüfe Anbieterberechtigungen, Organisationszugriff und Richtlinien." },
  },
  404: {
    en: { label: "Not found", description: "The requested route, model, account, or upstream resource was not found. Verify the model name and opencodex provider configuration." },
    ko: { label: "찾을 수 없음", description: "요청한 경로, 모델, 계정 또는 업스트림 리소스를 찾을 수 없습니다. 모델 이름과 opencodex 제공자 설정을 확인해야 합니다." },
    zh: { label: "未找到", description: "找不到请求的路由、模型、账号或上游资源。请确认模型名称和 opencodex 提供商配置。" },
    de: { label: "Nicht gefunden", description: "Die angeforderte Route, das Modell, das Konto oder die Upstream-Ressource wurde nicht gefunden. Prüfe Modellname und opencodex-Anbieterkonfiguration." },
  },
  408: {
    en: { label: "Request timeout", description: "The request took too long before the proxy or upstream provider could complete it. Retry with a smaller request or a different provider." },
    ko: { label: "요청 시간 초과", description: "프록시 또는 업스트림 제공자가 요청을 완료하기 전에 시간이 초과되었습니다. 더 작은 요청으로 재시도하거나 다른 제공자로 전환해야 합니다." },
    zh: { label: "请求超时", description: "代理或上游提供商未能在限定时间内完成请求。请缩小请求后重试，或切换提供商。" },
    de: { label: "Anfrage-Timeout", description: "Die Anfrage dauerte zu lange, bevor Proxy oder Upstream-Anbieter sie abschließen konnten. Mit kleinerer Anfrage oder anderem Anbieter erneut versuchen." },
  },
  409: {
    en: { label: "Conflict", description: "The request conflicts with the current account, session, or provider state. Refresh the session or retry after the active operation finishes." },
    ko: { label: "상태 충돌", description: "요청이 현재 계정, 세션 또는 제공자 상태와 충돌합니다. 세션을 갱신하거나 진행 중인 작업이 끝난 뒤 재시도해야 합니다." },
    zh: { label: "状态冲突", description: "请求与当前账号、会话或提供商状态冲突。请刷新会话，或等待当前操作完成后重试。" },
    de: { label: "Konflikt", description: "Die Anfrage kollidiert mit dem aktuellen Konto-, Sitzungs- oder Anbieterstatus. Sitzung aktualisieren oder nach Abschluss der laufenden Operation erneut versuchen." },
  },
  413: {
    en: { label: "Request too large", description: "The prompt, attachments, or generated payload exceeds a proxy or upstream limit. Reduce tokens, file size, or conversation history." },
    ko: { label: "요청 과대", description: "프롬프트, 첨부 파일 또는 생성 페이로드가 프록시나 업스트림 한도를 초과했습니다. 토큰, 파일 크기, 대화 기록을 줄여야 합니다." },
    zh: { label: "请求过大", description: "提示、附件或生成的负载超过了代理或上游限制。请减少 token、文件大小或对话历史。" },
    de: { label: "Anfrage zu groß", description: "Prompt, Anhänge oder generierte Nutzlast überschreiten ein Proxy- oder Upstream-Limit. Tokens, Dateigröße oder Verlauf reduzieren." },
  },
  422: {
    en: { label: "Invalid content", description: "The provider accepted the request format but rejected its contents. Check model options, tool definitions, message roles, and unsupported fields." },
    ko: { label: "내용 검증 실패", description: "제공자가 요청 형식은 받았지만 내용을 거부했습니다. 모델 옵션, 도구 정의, 메시지 역할, 지원되지 않는 필드를 확인해야 합니다." },
    zh: { label: "内容无效", description: "提供商接受了请求格式，但拒绝了其中的内容。请检查模型选项、工具定义、消息角色和不支持的字段。" },
    de: { label: "Ungültiger Inhalt", description: "Der Anbieter akzeptierte das Anfrageformat, lehnte den Inhalt aber ab. Prüfe Modelloptionen, Tool-Definitionen, Nachrichtenrollen und nicht unterstützte Felder." },
  },
  424: {
    en: { label: "Provider dependency failed", description: "A required upstream dependency failed while opencodex was routing the request. Retry later or switch to another configured provider." },
    ko: { label: "제공자 의존성 실패", description: "opencodex가 요청을 라우팅하는 동안 필요한 업스트림 의존성이 실패했습니다. 나중에 재시도하거나 다른 설정된 제공자로 전환해야 합니다." },
    zh: { label: "提供商依赖失败", description: "opencodex 路由请求时，必需的上游依赖失败。请稍后重试，或切换到另一个已配置的提供商。" },
    de: { label: "Anbieter-Abhängigkeit fehlgeschlagen", description: "Eine erforderliche Upstream-Abhängigkeit ist fehlgeschlagen, während opencodex die Anfrage geroutet hat. Später erneut versuchen oder zu einem anderen Anbieter wechseln." },
  },
  429: {
    en: { label: "Rate limited", description: "The upstream provider rate or quota limit has been reached. Wait for the quota window to reset or switch account/provider." },
    ko: { label: "한도 초과", description: "업스트림 제공자의 속도 또는 할당량 한도에 도달했습니다. 한도 창이 초기화될 때까지 기다리거나 계정/제공자를 전환해야 합니다." },
    zh: { label: "限流", description: "已达到上游提供商的速率或额度限制。请等待额度窗口重置，或切换账号/提供商。" },
    de: { label: "Ratenlimit erreicht", description: "Das Raten- oder Kontingentlimit des Upstream-Anbieters ist erreicht. Auf Reset des Kontingentfensters warten oder Konto/Anbieter wechseln." },
  },
  499: {
    en: { label: "Client closed request", description: "The client disconnected or canceled the request before opencodex finished routing it. Retry if the cancellation was accidental." },
    ko: { label: "클라이언트 취소", description: "opencodex가 라우팅을 끝내기 전에 클라이언트 연결이 끊기거나 요청이 취소되었습니다. 의도한 취소가 아니면 다시 시도해야 합니다." },
    zh: { label: "客户端已取消", description: "opencodex 完成路由前，客户端已断开连接或取消请求。如果不是有意取消，请重试。" },
    de: { label: "Client hat Anfrage geschlossen", description: "Der Client hat die Verbindung getrennt oder die Anfrage abgebrochen, bevor opencodex das Routing abgeschlossen hat. Bei versehentlichem Abbruch erneut versuchen." },
  },
  500: {
    en: { label: "Proxy error", description: "opencodex hit an internal error while handling the request. Retry once, then check proxy logs if it repeats." },
    ko: { label: "프록시 오류", description: "opencodex가 요청을 처리하는 동안 내부 오류가 발생했습니다. 한 번 재시도하고 반복되면 프록시 로그를 확인해야 합니다." },
    zh: { label: "代理错误", description: "opencodex 处理请求时发生内部错误。请先重试一次；如果重复出现，请检查代理日志。" },
    de: { label: "Proxy-Fehler", description: "opencodex ist bei der Anfragebearbeitung auf einen internen Fehler gestoßen. Einmal erneut versuchen, bei Wiederholung Proxy-Logs prüfen." },
  },
  502: {
    en: { label: "Bad upstream response", description: "The upstream provider returned an invalid or failed response through the proxy. Retry or route the request to another provider." },
    ko: { label: "업스트림 응답 오류", description: "업스트림 제공자가 프록시를 통해 유효하지 않거나 실패한 응답을 반환했습니다. 재시도하거나 다른 제공자로 라우팅해야 합니다." },
    zh: { label: "上游响应错误", description: "上游提供商通过代理返回了无效或失败的响应。请重试，或将请求路由到其他提供商。" },
    de: { label: "Ungültige Upstream-Antwort", description: "Der Upstream-Anbieter lieferte über den Proxy eine ungültige oder fehlgeschlagene Antwort. Erneut versuchen oder zu einem anderen Anbieter routen." },
  },
  503: {
    en: { label: "Provider unavailable", description: "The proxy or upstream provider is temporarily unavailable or overloaded. Wait briefly, then retry or switch provider." },
    ko: { label: "제공자 사용 불가", description: "프록시 또는 업스트림 제공자가 일시적으로 사용할 수 없거나 과부하 상태입니다. 잠시 기다린 뒤 재시도하거나 제공자를 전환해야 합니다." },
    zh: { label: "提供商不可用", description: "代理或上游提供商暂时不可用或过载。请稍后重试，或切换提供商。" },
    de: { label: "Anbieter nicht verfügbar", description: "Proxy oder Upstream-Anbieter ist vorübergehend nicht verfügbar oder überlastet. Kurz warten, dann erneut versuchen oder Anbieter wechseln." },
  },
  504: {
    en: { label: "Upstream timeout", description: "The upstream provider did not respond before the proxy timeout. Retry with a smaller request or choose a faster provider." },
    ko: { label: "업스트림 시간 초과", description: "프록시 시간 제한 전에 업스트림 제공자가 응답하지 않았습니다. 더 작은 요청으로 재시도하거나 더 빠른 제공자를 선택해야 합니다." },
    zh: { label: "上游超时", description: "上游提供商未在代理超时前响应。请缩小请求后重试，或选择响应更快的提供商。" },
    de: { label: "Upstream-Timeout", description: "Der Upstream-Anbieter antwortete nicht vor dem Proxy-Timeout. Mit kleinerer Anfrage erneut versuchen oder schnelleren Anbieter wählen." },
  },
  529: {
    en: { label: "Provider overloaded", description: "The upstream provider is overloaded or capacity-limited. Wait and retry, or switch to another account/provider." },
    ko: { label: "제공자 과부하", description: "업스트림 제공자가 과부하 상태이거나 처리 용량이 제한되었습니다. 기다렸다가 재시도하거나 다른 계정/제공자로 전환해야 합니다." },
    zh: { label: "提供商过载", description: "上游提供商过载或容量受限。请等待后重试，或切换到其他账号/提供商。" },
    de: { label: "Anbieter überlastet", description: "Der Upstream-Anbieter ist überlastet oder kapazitätsbegrenzt. Warten und erneut versuchen oder anderes Konto/Anbieter nutzen." },
  },
};

const GENERIC_STATUS: { client: LocalizedInfo; server: LocalizedInfo } = {
  client: {
    en: { label: "Request error", description: "The proxy or upstream provider rejected the request. Check the request shape, credentials, model name, and provider configuration." },
    ko: { label: "요청 오류", description: "프록시 또는 업스트림 제공자가 요청을 거부했습니다. 요청 형식, 자격 증명, 모델 이름, 제공자 설정을 확인해야 합니다." },
    zh: { label: "请求错误", description: "代理或上游提供商拒绝了该请求。请检查请求结构、凭据、模型名称和提供商配置。" },
    de: { label: "Anfragefehler", description: "Der Proxy oder Upstream-Anbieter hat die Anfrage abgelehnt. Prüfe Anfrageformat, Anmeldedaten, Modellname und Anbieterkonfiguration." },
  },
  server: {
    en: { label: "Server or upstream error", description: "opencodex or an upstream provider failed while processing the request. Retry later or route the request to another provider." },
    ko: { label: "서버 또는 업스트림 오류", description: "opencodex 또는 업스트림 제공자가 요청 처리 중 실패했습니다. 나중에 재시도하거나 다른 제공자로 라우팅해야 합니다." },
    zh: { label: "服务器或上游错误", description: "opencodex 或上游提供商处理请求时失败。请稍后重试，或将请求路由到其他提供商。" },
    de: { label: "Server- oder Upstream-Fehler", description: "opencodex oder ein Upstream-Anbieter ist bei der Anfragebearbeitung fehlgeschlagen. Später erneut versuchen oder zu einem anderen Anbieter routen." },
  },
};

function normalizeLocale(locale: string): Locale {
  return locale === "de" || locale === "ko" || locale === "zh" ? locale : "en";
}

export function statusCodeInfo(code: number, locale: string): StatusCodeInfo | null {
  if (code < 400) return null;
  const normalizedLocale = normalizeLocale(locale);
  const info = STATUS_CODES[Math.trunc(code)] ?? (code < 500 ? GENERIC_STATUS.client : GENERIC_STATUS.server);
  return info[normalizedLocale];
}
