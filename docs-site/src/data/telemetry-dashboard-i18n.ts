export const TELEMETRY_DASHBOARD_LOCALES = [
  "en",
  "es",
  "fr",
  "ko",
  "zh-cn",
  "zh-tw",
  "ru",
  "ja",
  "tr",
] as const;

export type TelemetryDashboardLocale = (typeof TELEMETRY_DASHBOARD_LOCALES)[number];

export interface TelemetryDashboardCopy {
  title: string;
  subtitle: string;
  rangeAria: string;
  range7d: string;
  range30d: string;
  range90d: string;
  range365d: string;
  updatedPrefix: string;
  updatedPending: string;
  privacyBadge: string;
  selfReportedLabel: string;
  privacyBody: string;
  privacyOptOutHint: string;
  privacyGuideLink: string;
  stateLoadingTitle: string;
  stateLoadingBody: string;
  stateEmptyTitle: string;
  stateEmptyBody: string;
  stateErrorTitle: string;
  stateErrorBody: string;
  retryButton: string;
  kpiSectionAria: string;
  kpiActiveInstalls: string;
  kpiNewInstalls: string;
  kpiRequests: string;
  kpiTokens: string;
  kpiActiveHours: string;
  tokenMixTitle: string;
  tokenMixSubtitle: string;
  tokenInput: string;
  tokenCacheRead: string;
  tokenCacheWrite: string;
  tokenOutput: string;
  tokenReasoning: string;
  heatmapTitle: string;
  heatmapSubtitle: string;
  heatmapActiveDays: string;
  heatmapPeakDay: string;
  heatmapLess: string;
  heatmapMore: string;
  heatmapTooltipUnit: string;
  heatmapKeyboardHint: string;
  dailyChartTitle: string;
  dailyChartSubtitle: string;
  metricTokens: string;
  metricRequests: string;
  providersTitle: string;
  providersSubtitle: string;
  modelsTitle: string;
  modelsSubtitle: string;
  colProvider: string;
  colModel: string;
  colRequests: string;
  colTokens: string;
  colShare: string;
  versionsTitle: string;
  versionsSubtitle: string;
  platformsTitle: string;
  platformsSubtitle: string;
  channelsTitle: string;
  channelsSubtitle: string;
  colVersion: string;
  colPlatform: string;
  colChannel: string;
  colInstalls: string;
  colNewInstalls: string;
  colInstallShare: string;
  reliabilityTitle: string;
  reliabilitySubtitle: string;
  completionRateLabel: string;
  outcomeCompleted: string;
  outcomeIncomplete: string;
  outcomeAborted: string;
  outcomeFailed: string;
  topErrorsTitle: string;
  colErrorCause: string;
  colErrorCount: string;
  noErrorsRecorded: string;
  downloadsTitle: string;
  downloadsSubtitle: string;
  npmWeeklyLabel: string;
  npmMonthlyLabel: string;
  npmYearlyLabel: string;
  githubTotalLabel: string;
  githubLatestLabel: string;
  downloadsPartial: string;
  downloadsUnavailable: string;
  noDataInTable: string;
  creditPrefix: string;
  creditSuffix: string;
}

export const TELEMETRY_DASHBOARD_STRINGS: Readonly<
  Record<TelemetryDashboardLocale, TelemetryDashboardCopy>
> = {
  en: {
    title: "Usage Dashboard",
    subtitle:
      "Project-wide anonymous daily aggregates, with all figures self-reported by opencodex installs (on by default after a person has seen the privacy notice, unless declined or turned off).",
    rangeAria: "Reporting window",
    range7d: "7d",
    range30d: "30d",
    range90d: "90d",
    range365d: "365d",
    updatedPrefix: "Updated",
    updatedPending: "Awaiting snapshot",
    privacyBadge: "Anonymous aggregates only",
    selfReportedLabel: "Self-reported by opencodex installs",
    privacyBody:
      "Telemetry is on by default and sends nothing until a person has seen the notice. Reports carry closed-vocabulary daily counts with a rotating daily install hash — never prompts, model outputs, API keys, account identifiers, file paths, or IP addresses.",
    privacyOptOutHint:
      "Disable anytime with ocx telemetry disable, OCX_TELEMETRY=0, or DO_NOT_TRACK=1.",
    privacyGuideLink: "Telemetry & privacy guide",
    stateLoadingTitle: "Loading project telemetry…",
    stateLoadingBody:
      "Fetching aggregate usage snapshot from telemetry.opencodex.me.",
    stateEmptyTitle: "Collector not deployed yet",
    stateEmptyBody:
      "The public collector at telemetry.opencodex.me is not deployed yet or has not recorded daily aggregates for this window.",
    stateErrorTitle: "Could not load live telemetry",
    stateErrorBody:
      "The request to telemetry.opencodex.me did not complete (the collector may not be deployed yet or is temporarily unreachable).",
    retryButton: "Retry",
    kpiSectionAria: "Key usage metrics",
    kpiActiveInstalls: "Avg daily active installs",
    kpiNewInstalls: "New installs",
    kpiRequests: "Requests",
    kpiTokens: "Total tokens",
    kpiActiveHours: "Active hours",
    tokenMixTitle: "Token mix",
    tokenMixSubtitle:
      "Disjoint token buckets across all reported model families — segments sum to 100% of total tokens.",
    tokenInput: "Input",
    tokenCacheRead: "Cache read",
    tokenCacheWrite: "Cache write",
    tokenOutput: "Output",
    tokenReasoning: "Reasoning",
    heatmapTitle: "365-day activity heatmap",
    heatmapSubtitle:
      "Daily reporting installs over the trailing 52 weeks (UTC).",
    heatmapActiveDays: "{count} active days",
    heatmapPeakDay: "Peak: {date} ({count})",
    heatmapLess: "Low",
    heatmapMore: "High",
    heatmapTooltipUnit: "active installs",
    heatmapKeyboardHint:
      "Use arrow keys to inspect adjacent days, Home and End to jump to range boundaries, and Escape to dismiss the tooltip.",
    dailyChartTitle: "Daily usage by provider kind",
    dailyChartSubtitle:
      "Stacked daily volume across the selected reporting window.",
    metricTokens: "Tokens",
    metricRequests: "Requests",
    providersTitle: "Provider kinds",
    providersSubtitle:
      "Closed vendor roster share by tokens and requests.",
    modelsTitle: "Model families",
    modelsSubtitle:
      "Coarse model family share by tokens and requests.",
    colProvider: "Provider kind",
    colModel: "Model family",
    colRequests: "Requests",
    colTokens: "Tokens",
    colShare: "Token share",
    versionsTitle: "Versions",
    versionsSubtitle:
      "Active and newly reporting installs by release version.",
    platformsTitle: "Platforms",
    platformsSubtitle: "OS and CPU architecture distribution.",
    channelsTitle: "Install channels",
    channelsSubtitle: "How reporting proxies were installed.",
    colVersion: "Version",
    colPlatform: "Platform",
    colChannel: "Channel",
    colInstalls: "Installs",
    colNewInstalls: "New",
    colInstallShare: "Share",
    reliabilityTitle: "Reliability & outcomes",
    reliabilitySubtitle:
      "Request outcome ratio and top closed-vocabulary failure causes.",
    completionRateLabel: "Completion rate",
    outcomeCompleted: "Completed",
    outcomeIncomplete: "Incomplete",
    outcomeAborted: "Aborted",
    outcomeFailed: "Failed",
    topErrorsTitle: "Top failure causes",
    colErrorCause: "Failure cause",
    colErrorCount: "Count",
    noErrorsRecorded: "No failure causes recorded in this window.",
    downloadsTitle: "Package & release downloads",
    downloadsSubtitle:
      "Live download counts from npm (@bitkyc08/opencodex) and GitHub release assets (lidge-jun/opencodex).",
    npmWeeklyLabel: "npm (last 7 days)",
    npmMonthlyLabel: "npm (last 30 days)",
    npmYearlyLabel: "npm (last 365 days)",
    githubTotalLabel: "GitHub release assets (total)",
    githubLatestLabel: "Latest release assets",
    downloadsPartial: "partial",
    downloadsUnavailable: "Unavailable",
    noDataInTable: "No data reported for this window.",
    creditPrefix:
      "Visual design and contribution heatmap patterns adapted from",
    creditSuffix: "(MIT License).",
  },
  es: {
    "title": "Panel de uso",
    "subtitle": "Estadísticas diarias anónimas de todo el proyecto, comunicadas por las instalaciones de opencodex. Se activan de forma predeterminada después de que una persona vea el aviso de privacidad, salvo rechazo o desactivación.",
    "rangeAria": "Periodo del informe",
    "range7d": "7 d",
    "range30d": "30 d",
    "range90d": "90 d",
    "range365d": "365 d",
    "updatedPrefix": "Actualizado",
    "updatedPending": "Esperando una instantánea",
    "privacyBadge": "Solo estadísticas anónimas",
    "selfReportedLabel": "Datos comunicados por instalaciones de opencodex",
    "privacyBody": "La telemetría está activada de forma predeterminada y no envía nada hasta que una persona vea el aviso. Los informes incluyen recuentos diarios de categorías predefinidas y un hash de instalación que cambia a diario; nunca prompts, respuestas de modelos, claves API, identificadores de cuenta, rutas de archivos ni direcciones IP.",
    "privacyOptOutHint": "Desactívala cuando quieras con ocx telemetry disable, OCX_TELEMETRY=0 o DO_NOT_TRACK=1.",
    "privacyGuideLink": "Guía de telemetría y privacidad",
    "stateLoadingTitle": "Cargando la telemetría del proyecto…",
    "stateLoadingBody": "Obteniendo las estadísticas de uso de telemetry.opencodex.me.",
    "stateEmptyTitle": "El recolector aún no está desplegado",
    "stateEmptyBody": "El recolector público de telemetry.opencodex.me aún no está desplegado o no ha registrado estadísticas diarias para este periodo.",
    "stateErrorTitle": "No se pudo cargar la telemetría en vivo",
    "stateErrorBody": "La solicitud a telemetry.opencodex.me no terminó; puede que el recolector aún no esté desplegado o no esté disponible temporalmente.",
    "retryButton": "Reintentar",
    "kpiSectionAria": "Métricas principales de uso",
    "kpiActiveInstalls": "Promedio de instalaciones activas al día",
    "kpiNewInstalls": "Instalaciones nuevas",
    "kpiRequests": "Solicitudes",
    "kpiTokens": "Tokens totales",
    "kpiActiveHours": "Horas activas",
    "tokenMixTitle": "Distribución de tokens",
    "tokenMixSubtitle": "Categorías de tokens sin solapamiento para todas las familias de modelos comunicadas; los segmentos suman el 100% de los tokens.",
    "tokenInput": "Entrada",
    "tokenCacheRead": "Lectura de caché",
    "tokenCacheWrite": "Escritura de caché",
    "tokenOutput": "Salida",
    "tokenReasoning": "Razonamiento",
    "heatmapTitle": "Mapa de actividad de 365 días",
    "heatmapSubtitle": "Instalaciones que envían informes cada día durante las últimas 52 semanas (UTC).",
    "heatmapActiveDays": "{count} días activos",
    "heatmapPeakDay": "Máximo: {date} ({count})",
    "heatmapLess": "Bajo",
    "heatmapMore": "Alto",
    "heatmapTooltipUnit": "instalaciones activas",
    "heatmapKeyboardHint": "Usa las flechas para consultar los días contiguos, Inicio y Fin para ir a los extremos del periodo, y Escape para cerrar la información.",
    "dailyChartTitle": "Uso diario por tipo de proveedor",
    "dailyChartSubtitle": "Volumen diario acumulado durante el periodo seleccionado.",
    "metricTokens": "Tokens",
    "metricRequests": "Solicitudes",
    "providersTitle": "Tipos de proveedor",
    "providersSubtitle": "Participación de cada proveedor de la lista predefinida en tokens y solicitudes.",
    "modelsTitle": "Familias de modelos",
    "modelsSubtitle": "Participación de las familias generales de modelos en tokens y solicitudes.",
    "colProvider": "Tipo de proveedor",
    "colModel": "Familia de modelos",
    "colRequests": "Solicitudes",
    "colTokens": "Tokens",
    "colShare": "Porcentaje de tokens",
    "versionsTitle": "Versiones",
    "versionsSubtitle": "Instalaciones activas y que informan por primera vez, por versión.",
    "platformsTitle": "Plataformas",
    "platformsSubtitle": "Distribución por sistema operativo y arquitectura de CPU.",
    "channelsTitle": "Canales de instalación",
    "channelsSubtitle": "Cómo se instalaron los proxies que envían informes.",
    "colVersion": "Versión",
    "colPlatform": "Plataforma",
    "colChannel": "Canal",
    "colInstalls": "Instalaciones",
    "colNewInstalls": "Nuevas",
    "colInstallShare": "Porcentaje",
    "reliabilityTitle": "Fiabilidad y resultados",
    "reliabilitySubtitle": "Proporción de resultados y principales causas de fallo de la lista predefinida.",
    "completionRateLabel": "Tasa de finalización",
    "outcomeCompleted": "Finalizadas",
    "outcomeIncomplete": "Incompletas",
    "outcomeAborted": "Canceladas",
    "outcomeFailed": "Fallidas",
    "topErrorsTitle": "Principales causas de fallo",
    "colErrorCause": "Causa del fallo",
    "colErrorCount": "Cantidad",
    "noErrorsRecorded": "No se registraron causas de fallo en este periodo.",
    "downloadsTitle": "Descargas de paquetes y versiones",
    "downloadsSubtitle": "Recuentos de descargas en vivo de npm (@bitkyc08/opencodex) y de archivos de versiones de GitHub (lidge-jun/opencodex).",
    "npmWeeklyLabel": "npm (últimos 7 días)",
    "npmMonthlyLabel": "npm (últimos 30 días)",
    "npmYearlyLabel": "npm (últimos 365 días)",
    "githubTotalLabel": "Archivos de versiones de GitHub (total)",
    "githubLatestLabel": "Archivos de la última versión",
    "downloadsPartial": "parcial",
    "downloadsUnavailable": "No disponible",
    "noDataInTable": "No se comunicaron datos para este periodo.",
    "creditPrefix": "Diseño visual y patrones del mapa de contribuciones adaptados de",
    "creditSuffix": "(licencia MIT)."
},
  fr: {
    title: "Tableau de bord d’utilisation",
    subtitle:
      "Agrégats quotidiens anonymes à l’échelle du projet, tous les chiffres étant auto-déclarés par les installations opencodex (activé par défaut après affichage de l’avis de confidentialité à une personne, sauf refus ou désactivation).",
    rangeAria: "Période d’analyse",
    range7d: "7j",
    range30d: "30j",
    range90d: "90j",
    range365d: "365j",
    updatedPrefix: "Mis à jour",
    updatedPending: "En attente d’instantané",
    privacyBadge: "Agrégats anonymes uniquement",
    selfReportedLabel: "Auto-déclaré par les installations opencodex",
    privacyBody:
      "La télémétrie est activée par défaut et n’envoie rien tant qu’une personne n’a pas vu l’avis. Les rapports ne contiennent que des compteurs quotidiens à vocabulaire fermé avec un hachage journalier rotatif — jamais de prompts, de réponses, de clés API, d’identifiants de compte, de chemins ou d’adresses IP.",
    privacyOptOutHint:
      "Désactivez à tout moment avec ocx telemetry disable, OCX_TELEMETRY=0 ou DO_NOT_TRACK=1.",
    privacyGuideLink: "Guide de télémétrie et confidentialité",
    stateLoadingTitle: "Chargement de la télémétrie du projet…",
    stateLoadingBody:
      "Récupération des statistiques agrégées depuis telemetry.opencodex.me.",
    stateEmptyTitle: "Collecteur non encore déployé",
    stateEmptyBody:
      "Le collecteur public sur telemetry.opencodex.me n’est pas encore déployé ou n’a pas encore enregistré d’agrégats pour cette période.",
    stateErrorTitle: "Impossible de charger la télémétrie en direct",
    stateErrorBody:
      "La requête vers telemetry.opencodex.me a échoué (le collecteur n’est peut-être pas encore déployé ou est temporairement injoignable).",
    retryButton: "Réessayer",
    kpiSectionAria: "Indicateurs clés d’utilisation",
    kpiActiveInstalls: "Installations actives moy./jour",
    kpiNewInstalls: "Nouvelles installations",
    kpiRequests: "Requêtes",
    kpiTokens: "Jetons totaux",
    kpiActiveHours: "Heures actives",
    tokenMixTitle: "Répartition des jetons",
    tokenMixSubtitle:
      "Catégories de jetons disjointes sur toutes les familles de modèles — la somme correspond à 100 % des jetons.",
    tokenInput: "Entrée",
    tokenCacheRead: "Lecture cache",
    tokenCacheWrite: "Écriture cache",
    tokenOutput: "Sortie",
    tokenReasoning: "Raisonnement",
    heatmapTitle: "Carte d’activité sur 365 jours",
    heatmapSubtitle:
      "Installations actives quotidiennes sur les 52 dernières semaines (UTC).",
    heatmapActiveDays: "{count} jours actifs",
    heatmapPeakDay: "Pic : {date} ({count})",
    heatmapLess: "Faible",
    heatmapMore: "Élevé",
    heatmapTooltipUnit: "installations actives",
    heatmapKeyboardHint:
      "Utilisez les flèches pour parcourir les jours, Début/Fin pour aller aux extrémités et Échap pour fermer l’infobulle.",
    dailyChartTitle: "Utilisation quotidienne par type de fournisseur",
    dailyChartSubtitle:
      "Volume quotidien empilé sur la période sélectionnée.",
    metricTokens: "Jetons",
    metricRequests: "Requêtes",
    providersTitle: "Types de fournisseurs",
    providersSubtitle: "Part des fournisseurs par jetons et requêtes.",
    modelsTitle: "Familles de modèles",
    modelsSubtitle: "Part des familles de modèles par jetons et requêtes.",
    colProvider: "Fournisseur",
    colModel: "Famille de modèles",
    colRequests: "Requêtes",
    colTokens: "Jetons",
    colShare: "Part (jetons)",
    versionsTitle: "Versions",
    versionsSubtitle:
      "Installations actives et nouvelles par version publiée.",
    platformsTitle: "Plateformes",
    platformsSubtitle: "Répartition par système et architecture CPU.",
    channelsTitle: "Canaux d’installation",
    channelsSubtitle: "Mode d’installation des proxys déclarants.",
    colVersion: "Version",
    colPlatform: "Plateforme",
    colChannel: "Canal",
    colInstalls: "Installations",
    colNewInstalls: "Nouvelles",
    colInstallShare: "Part",
    reliabilityTitle: "Fiabilité et résultats",
    reliabilitySubtitle:
      "Taux d’aboutissement des requêtes et principales causes d’échec.",
    completionRateLabel: "Taux de réussite",
    outcomeCompleted: "Terminées",
    outcomeIncomplete: "Incomplètes",
    outcomeAborted: "Interrompues",
    outcomeFailed: "Échouées",
    topErrorsTitle: "Principales causes d’échec",
    colErrorCause: "Cause d’échec",
    colErrorCount: "Nombre",
    noErrorsRecorded: "Aucune cause d’échec enregistrée sur cette période.",
    downloadsTitle: "Téléchargements de paquets et versions",
    downloadsSubtitle:
      "Compteurs en direct depuis npm (@bitkyc08/opencodex) et les binaires GitHub Releases (lidge-jun/opencodex).",
    npmWeeklyLabel: "npm (7 derniers jours)",
    npmMonthlyLabel: "npm (30 derniers jours)",
    npmYearlyLabel: "npm (365 derniers jours)",
    githubTotalLabel: "GitHub Releases (total)",
    githubLatestLabel: "Dernière version GitHub",
    downloadsPartial: "partiel",
    downloadsUnavailable: "Indisponible",
    noDataInTable: "Aucune donnée déclarée pour cette période.",
    creditPrefix:
      "Design visuel et carte d’activité adaptés de",
    creditSuffix: "(licence MIT).",
  },
  ko: {
    title: "사용량 대시보드",
    subtitle:
      "개인정보 안내를 확인한 뒤 기본으로 활성화되는 opencodex 설치(거부하거나 끈 경우 제외)에서 자체 보고된 프로젝트 전체 익명 일일 통계입니다.",
    rangeAria: "집계 기간",
    range7d: "7일",
    range30d: "30일",
    range90d: "90일",
    range365d: "365일",
    updatedPrefix: "업데이트",
    updatedPending: "스냅샷 대기 중",
    privacyBadge: "익명 집계 전용",
    selfReportedLabel: "opencodex 설치에서 자체 보고된 수치",
    privacyBody:
      "텔레메트리는 기본으로 켜져 있으며 사람이 안내를 확인하기 전에는 아무것도 전송하지 않습니다. 보고서에는 매일 회전하는 설치 해시와 고정 어휘 일일 카운터만 포함되며 프롬프트, 모델 출력, API 키, 계정 식별자, 파일 경로, IP 주소는 절대 전송되지 않습니다.",
    privacyOptOutHint:
      "언제든 ocx telemetry disable, OCX_TELEMETRY=0 또는 DO_NOT_TRACK=1로 끌 수 있습니다.",
    privacyGuideLink: "텔레메트리 및 개인정보 가이드",
    stateLoadingTitle: "프로젝트 텔레메트리 불러오는 중…",
    stateLoadingBody:
      "telemetry.opencodex.me에서 집계 스냅샷을 가져오고 있습니다.",
    stateEmptyTitle: "수집기가 아직 배포되지 않았습니다",
    stateEmptyBody:
      "telemetry.opencodex.me 공개 수집기가 아직 배포되지 않았거나 선택한 기간에 기록된 일일 집계가 없습니다.",
    stateErrorTitle: "실시간 텔레메트리를 불러오지 못했습니다",
    stateErrorBody:
      "telemetry.opencodex.me 요청을 완료하지 못했습니다(수집기가 아직 배포 전이거나 일시적으로 연결할 수 없습니다).",
    retryButton: "다시 시도",
    kpiSectionAria: "주요 사용 지표",
    kpiActiveInstalls: "일평균 활성 설치",
    kpiNewInstalls: "신규 설치",
    kpiRequests: "요청 수",
    kpiTokens: "총 토큰",
    kpiActiveHours: "활성 시간",
    tokenMixTitle: "토큰 구성비",
    tokenMixSubtitle:
      "입력·캐시 읽기·캐시 쓰기·출력·추론의 서로소(disjoint) 토큰 버킷 분포로 합계는 100%입니다.",
    tokenInput: "입력",
    tokenCacheRead: "캐시 읽기",
    tokenCacheWrite: "캐시 쓰기",
    tokenOutput: "출력",
    tokenReasoning: "추론",
    heatmapTitle: "365일 활동 히트맵",
    heatmapSubtitle:
      "최근 52주간 일별 활성 설치 추이(UTC 기준).",
    heatmapActiveDays: "활성 일수 {count}일",
    heatmapPeakDay: "최고치: {date} ({count})",
    heatmapLess: "낮음",
    heatmapMore: "높음",
    heatmapTooltipUnit: "활성 설치",
    heatmapKeyboardHint:
      "방향키로 인접 날짜를 이동하고 Home/End로 시작·끝 날짜로 이동하며 Escape로 툴팁을 닫습니다.",
    dailyChartTitle: "프로바이더 종류별 일일 사용량",
    dailyChartSubtitle:
      "선택한 기간의 프로바이더별 일일 누적 추이입니다.",
    metricTokens: "토큰",
    metricRequests: "요청 수",
    providersTitle: "프로바이더 종류",
    providersSubtitle: "토큰 및 요청 기준 프로바이더 점유율.",
    modelsTitle: "모델 계열",
    modelsSubtitle: "토큰 및 요청 기준 모델 계열 점유율.",
    colProvider: "프로바이더",
    colModel: "모델 계열",
    colRequests: "요청 수",
    colTokens: "토큰",
    colShare: "토큰 점유율",
    versionsTitle: "버전 분포",
    versionsSubtitle: "릴리스 버전별 활성 설치 및 신규 설치 수.",
    platformsTitle: "플랫폼 분포",
    platformsSubtitle: "OS 및 CPU 아키텍처 비율.",
    channelsTitle: "설치 채널",
    channelsSubtitle: "프록시가 설치된 경로별 비율.",
    colVersion: "버전",
    colPlatform: "플랫폼",
    colChannel: "설치 채널",
    colInstalls: "설치 수",
    colNewInstalls: "신규",
    colInstallShare: "비율",
    reliabilityTitle: "신뢰성 및 요청 결과",
    reliabilitySubtitle:
      "요청 완료 비율과 주요 실패 원인(고정 어휘 코드).",
    completionRateLabel: "완료율",
    outcomeCompleted: "완료",
    outcomeIncomplete: "미완료",
    outcomeAborted: "중단됨",
    outcomeFailed: "실패",
    topErrorsTitle: "주요 실패 원인",
    colErrorCause: "실패 원인",
    colErrorCount: "건수",
    noErrorsRecorded: "이 기간에 기록된 실패 원인이 없습니다.",
    downloadsTitle: "패키지 및 릴리스 다운로드",
    downloadsSubtitle:
      "npm(@bitkyc08/opencodex)과 GitHub 릴리스 에셋(lidge-jun/opencodex) 실시간 다운로드 집계.",
    npmWeeklyLabel: "npm (최근 7일)",
    npmMonthlyLabel: "npm (최근 30일)",
    npmYearlyLabel: "npm (최근 365일)",
    githubTotalLabel: "GitHub 릴리스 에셋 (누적)",
    githubLatestLabel: "최신 릴리스 에셋",
    downloadsPartial: "일부 집계",
    downloadsUnavailable: "확인 불가",
    noDataInTable: "이 기간에 보고된 데이터가 없습니다.",
    creditPrefix:
      "시각 디자인 및 기여도 히트맵 패턴 참고:",
    creditSuffix: "(MIT 라이선스).",
  },
  "zh-cn": {
    title: "使用量仪表盘",
    subtitle:
      "由 opencodex 安装实例自行上报的全项目匿名每日汇总（在用户查看隐私提示后默认开启，除非拒绝或关闭）。",
    rangeAria: "统计时间范围",
    range7d: "7天",
    range30d: "30天",
    range90d: "90天",
    range365d: "365天",
    updatedPrefix: "更新于",
    updatedPending: "等待快照",
    privacyBadge: "仅匿名汇总数据",
    selfReportedLabel: "由 opencodex 安装实例自行上报",
    privacyBody:
      "遥测默认开启，但在人工查看隐私提示前不会发送任何数据。上报数据仅包含固定词汇的每日计数与每日轮换的安装哈希——绝不包含提示词、模型输出、API 密钥、账户标识、文件路径或 IP 地址。",
    privacyOptOutHint:
      "可随时通过 ocx telemetry disable、OCX_TELEMETRY=0 或 DO_NOT_TRACK=1 关闭。",
    privacyGuideLink: "遥测与隐私指南",
    stateLoadingTitle: "正在加载项目遥测数据…",
    stateLoadingBody: "正在从 telemetry.opencodex.me 获取汇总快照。",
    stateEmptyTitle: "收集器尚未部署",
    stateEmptyBody:
      "位于 telemetry.opencodex.me 的公共收集器尚未部署，或该时间范围内尚无每日汇总记录。",
    stateErrorTitle: "无法加载实时遥测数据",
    stateErrorBody:
      "对 telemetry.opencodex.me 的请求未能完成（收集器可能尚未部署或暂时无法访问）。",
    retryButton: "重试",
    kpiSectionAria: "核心使用指标",
    kpiActiveInstalls: "日均活跃安装",
    kpiNewInstalls: "新增安装",
    kpiRequests: "请求数",
    kpiTokens: "总 Token 数",
    kpiActiveHours: "活跃小时数",
    tokenMixTitle: "Token 构成",
    tokenMixSubtitle:
      "输入、缓存读取、缓存写入、输出与推理五个互不重叠的 Token 桶，总和为 100%。",
    tokenInput: "输入",
    tokenCacheRead: "缓存读取",
    tokenCacheWrite: "缓存写入",
    tokenOutput: "输出",
    tokenReasoning: "推理",
    heatmapTitle: "365 天活跃热力图",
    heatmapSubtitle: "过去 52 周每日活跃安装量（UTC）。",
    heatmapActiveDays: "{count} 个活跃日",
    heatmapPeakDay: "峰值：{date}（{count}）",
    heatmapLess: "低",
    heatmapMore: "高",
    heatmapTooltipUnit: "活跃安装",
    heatmapKeyboardHint:
      "使用方向键浏览相邻日期，Home/End 跳至起止日期，Escape 关闭提示框。",
    dailyChartTitle: "按提供商类型的每日使用量",
    dailyChartSubtitle: "所选时间窗口内的每日堆叠趋势。",
    metricTokens: "Token",
    metricRequests: "请求数",
    providersTitle: "提供商类型",
    providersSubtitle: "按 Token 与请求数统计的提供商占比。",
    modelsTitle: "模型系列",
    modelsSubtitle: "按 Token 与请求数统计的模型系列占比。",
    colProvider: "提供商类型",
    colModel: "模型系列",
    colRequests: "请求数",
    colTokens: "Token",
    colShare: "Token 占比",
    versionsTitle: "版本分布",
    versionsSubtitle: "各发布版本的活跃安装与新增安装。",
    platformsTitle: "平台分布",
    platformsSubtitle: "操作系统与 CPU 架构分布。",
    channelsTitle: "安装渠道",
    channelsSubtitle: "上报代理的安装方式分布。",
    colVersion: "版本",
    colPlatform: "平台",
    colChannel: "渠道",
    colInstalls: "安装量",
    colNewInstalls: "新增",
    colInstallShare: "占比",
    reliabilityTitle: "可靠性与请求结果",
    reliabilitySubtitle: "请求完成率与主要失败原因（固定错误码）。",
    completionRateLabel: "完成率",
    outcomeCompleted: "已完成",
    outcomeIncomplete: "未完成",
    outcomeAborted: "已中止",
    outcomeFailed: "失败",
    topErrorsTitle: "主要失败原因",
    colErrorCause: "失败原因",
    colErrorCount: "次数",
    noErrorsRecorded: "该时间窗口内无失败记录。",
    downloadsTitle: "软件包与发行版下载量",
    downloadsSubtitle:
      "来自 npm (@bitkyc08/opencodex) 与 GitHub Release 资产 (lidge-jun/opencodex) 的实时下载统计。",
    npmWeeklyLabel: "npm（最近 7 天）",
    npmMonthlyLabel: "npm（最近 30 天）",
    npmYearlyLabel: "npm（最近 365 天）",
    githubTotalLabel: "GitHub 发行版资产（累计）",
    githubLatestLabel: "最新发行版资产",
    downloadsPartial: "部分统计",
    downloadsUnavailable: "暂不可用",
    noDataInTable: "该时间窗口内暂无上报数据。",
    creditPrefix: "视觉设计与贡献热力图模式改编自",
    creditSuffix: "（MIT 许可证）。",
  },
  "zh-tw": {
    title: "使用量儀表板",
    subtitle:
      "由 opencodex 安裝實例自行回報之全專案匿名每日彙總（於使用者查看隱私提示後預設開啟，除非拒絕或關閉）。",
    rangeAria: "統計時間範圍",
    range7d: "7天",
    range30d: "30天",
    range90d: "90天",
    range365d: "365天",
    updatedPrefix: "更新於",
    updatedPending: "等待快照",
    privacyBadge: "僅限匿名彙總資料",
    selfReportedLabel: "由 opencodex 安裝實例自行回報",
    privacyBody:
      "遙測預設開啟，但在人工查看隱私提示前不會傳送任何資料。回報資料僅包含固定詞彙的每日計數與每日輪替的安裝雜湊——絕不包含提示詞、模型輸出、API 金鑰、帳號識別碼、檔案路徑或 IP 位址。",
    privacyOptOutHint:
      "可隨時透過 ocx telemetry disable、OCX_TELEMETRY=0 或 DO_NOT_TRACK=1 關閉。",
    privacyGuideLink: "遙測與隱私指南",
    stateLoadingTitle: "正在載入專案遙測資料…",
    stateLoadingBody: "正在從 telemetry.opencodex.me 取得彙總快照。",
    stateEmptyTitle: "收集器尚未部署",
    stateEmptyBody:
      "位於 telemetry.opencodex.me 的公開收集器尚未部署，或此時間範圍內尚無每日彙總紀錄。",
    stateErrorTitle: "無法載入即時遙測資料",
    stateErrorBody:
      "對 telemetry.opencodex.me 的請求未能完成（收集器可能尚未部署或暫時無法連線）。",
    retryButton: "重試",
    kpiSectionAria: "核心使用指標",
    kpiActiveInstalls: "日均活躍安裝",
    kpiNewInstalls: "新增安裝",
    kpiRequests: "請求數",
    kpiTokens: "總 Token 數",
    kpiActiveHours: "活躍小時數",
    tokenMixTitle: "Token 構成",
    tokenMixSubtitle:
      "輸入、快取讀取、快取寫入、輸出與推理五個互不重疊的 Token 桶，總和為 100%。",
    tokenInput: "輸入",
    tokenCacheRead: "快取讀取",
    tokenCacheWrite: "快取寫入",
    tokenOutput: "輸出",
    tokenReasoning: "推理",
    heatmapTitle: "365 天活躍熱力圖",
    heatmapSubtitle: "過去 52 週每日活躍安裝量（UTC）。",
    heatmapActiveDays: "{count} 個活躍日",
    heatmapPeakDay: "峰值：{date}（{count}）",
    heatmapLess: "低",
    heatmapMore: "高",
    heatmapTooltipUnit: "活躍安裝",
    heatmapKeyboardHint:
      "使用方向鍵瀏覽相鄰日期，Home/End 跳至起訖日期，Escape 關閉提示框。",
    dailyChartTitle: "依供應商類型的每日使用量",
    dailyChartSubtitle: "所選時間視窗內的每日堆疊趨勢。",
    metricTokens: "Token",
    metricRequests: "請求數",
    providersTitle: "供應商類型",
    providersSubtitle: "依 Token 與請求數統計的供應商佔比。",
    modelsTitle: "模型系列",
    modelsSubtitle: "依 Token 與請求數統計的模型系列佔比。",
    colProvider: "供應商類型",
    colModel: "模型系列",
    colRequests: "請求數",
    colTokens: "Token",
    colShare: "Token 佔比",
    versionsTitle: "版本分佈",
    versionsSubtitle: "各發佈版本的活躍安裝與新增安裝。",
    platformsTitle: "平台分佈",
    platformsSubtitle: "作業系統與 CPU 架構分佈。",
    channelsTitle: "安裝管道",
    channelsSubtitle: "回報代理的安裝方式分佈。",
    colVersion: "版本",
    colPlatform: "平台",
    colChannel: "管道",
    colInstalls: "安裝量",
    colNewInstalls: "新增",
    colInstallShare: "佔比",
    reliabilityTitle: "可靠性與請求結果",
    reliabilitySubtitle: "請求完成率與主要失敗原因（固定錯誤碼）。",
    completionRateLabel: "完成率",
    outcomeCompleted: "已完成",
    outcomeIncomplete: "未完成",
    outcomeAborted: "已中止",
    outcomeFailed: "失敗",
    topErrorsTitle: "主要失敗原因",
    colErrorCause: "失敗原因",
    colErrorCount: "次數",
    noErrorsRecorded: "此時間視窗內無失敗紀錄。",
    downloadsTitle: "套件與發行版下載量",
    downloadsSubtitle:
      "來自 npm (@bitkyc08/opencodex) 與 GitHub Release 資產 (lidge-jun/opencodex) 的即時下載統計。",
    npmWeeklyLabel: "npm（最近 7 天）",
    npmMonthlyLabel: "npm（最近 30 天）",
    npmYearlyLabel: "npm（最近 365 天）",
    githubTotalLabel: "GitHub 發行版資產（累計）",
    githubLatestLabel: "最新發行版資產",
    downloadsPartial: "部分統計",
    downloadsUnavailable: "暫不可用",
    noDataInTable: "此時間視窗內暫無回報資料。",
    creditPrefix: "視覺設計與貢獻熱力圖模式改編自",
    creditSuffix: "（MIT 授權條款）。",
  },
  ru: {
    title: "Дашборд использования",
    subtitle:
      "Анонимные ежедневные сводки по всему проекту по данным самоотчётов установок opencodex (включено по умолчанию после показа уведомления человеку, если не отклонено и не отключено).",
    rangeAria: "Период отчёта",
    range7d: "7д",
    range30d: "30д",
    range90d: "90д",
    range365d: "365д",
    updatedPrefix: "Обновлено",
    updatedPending: "Ожидание снимка",
    privacyBadge: "Только анонимные сводки",
    selfReportedLabel: "По данным самоотчётов установок opencodex",
    privacyBody:
      "Телеметрия включена по умолчанию и ничего не отправляет, пока человек не увидит уведомление. Отчёты содержат только суточные счётчики фиксированного словаря и ежедневно меняющийся хеш установки — без промптов, ответов моделей, API-ключей, аккаунтов, путей или IP-адресов.",
    privacyOptOutHint:
      "Отключить можно в любой момент через ocx telemetry disable, OCX_TELEMETRY=0 или DO_NOT_TRACK=1.",
    privacyGuideLink: "Руководство по телеметрии и приватности",
    stateLoadingTitle: "Загрузка телеметрии проекта…",
    stateLoadingBody:
      "Получение сводного снимка использования с telemetry.opencodex.me.",
    stateEmptyTitle: "Коллектор ещё не развёрнут",
    stateEmptyBody:
      "Публичный коллектор telemetry.opencodex.me ещё не развёрнут или не содержит записей за выбранный период.",
    stateErrorTitle: "Не удалось загрузить телеметрию",
    stateErrorBody:
      "Запрос к telemetry.opencodex.me не завершился (коллектор ещё не развёрнут или временно недоступен).",
    retryButton: "Повторить",
    kpiSectionAria: "Ключевые метрики использования",
    kpiActiveInstalls: "Среднесуточные активные установки",
    kpiNewInstalls: "Новые установки",
    kpiRequests: "Запросы",
    kpiTokens: "Всего токенов",
    kpiActiveHours: "Активные часы",
    tokenMixTitle: "Структура токенов",
    tokenMixSubtitle:
      "Непересекающиеся категории токенов по всем семействам моделей — в сумме дают 100%.",
    tokenInput: "Ввод",
    tokenCacheRead: "Чтение кэша",
    tokenCacheWrite: "Запись кэша",
    tokenOutput: "Вывод",
    tokenReasoning: "Рассуждения",
    heatmapTitle: "Карта активности за 365 дней",
    heatmapSubtitle:
      "Ежедневные активные установки за последние 52 недели (UTC).",
    heatmapActiveDays: "Активных дней: {count}",
    heatmapPeakDay: "Пик: {date} ({count})",
    heatmapLess: "Меньше",
    heatmapMore: "Больше",
    heatmapTooltipUnit: "активных установок",
    heatmapKeyboardHint:
      "Используйте стрелки для перехода по дням, Home/End для перехода к краям периода и Escape для закрытия подсказки.",
    dailyChartTitle: "Ежедневное использование по типам провайдеров",
    dailyChartSubtitle:
      "Сложенная динамика по дням за выбранный период.",
    metricTokens: "Токены",
    metricRequests: "Запросы",
    providersTitle: "Типы провайдеров",
    providersSubtitle: "Доля провайдеров по токенам и запросам.",
    modelsTitle: "Семейства моделей",
    modelsSubtitle: "Доля семейств моделей по токенам и запросам.",
    colProvider: "Провайдер",
    colModel: "Семейство моделей",
    colRequests: "Запросы",
    colTokens: "Токены",
    colShare: "Доля токенов",
    versionsTitle: "Версии",
    versionsSubtitle:
      "Активные и новые установки по версиям релиза.",
    platformsTitle: "Платформы",
    platformsSubtitle: "Распределение по ОС и архитектуре CPU.",
    channelsTitle: "Каналы установки",
    channelsSubtitle: "Способы установки прокси.",
    colVersion: "Версия",
    colPlatform: "Платформа",
    colChannel: "Канал",
    colInstalls: "Установки",
    colNewInstalls: "Новые",
    colInstallShare: "Доля",
    reliabilityTitle: "Надёжность и исходы",
    reliabilitySubtitle:
      "Доля успешных запросов и основные причины сбоев.",
    completionRateLabel: "Доля завершения",
    outcomeCompleted: "Завершено",
    outcomeIncomplete: "Неполные",
    outcomeAborted: "Прервано",
    outcomeFailed: "Ошибка",
    topErrorsTitle: "Основные причины сбоев",
    colErrorCause: "Причина сбоя",
    colErrorCount: "Количество",
    noErrorsRecorded: "За этот период ошибок не зафиксировано.",
    downloadsTitle: "Загрузки пакетов и релизов",
    downloadsSubtitle:
      "Статистика скачиваний из npm (@bitkyc08/opencodex) и GitHub Releases (lidge-jun/opencodex).",
    npmWeeklyLabel: "npm (за 7 дней)",
    npmMonthlyLabel: "npm (за 30 дней)",
    npmYearlyLabel: "npm (за 365 дней)",
    githubTotalLabel: "GitHub Releases (всего)",
    githubLatestLabel: "Последний релиз GitHub",
    downloadsPartial: "частично",
    downloadsUnavailable: "Недоступно",
    noDataInTable: "Нет данных за выбранный период.",
    creditPrefix:
      "Визуальный дизайн и тепловая карта активности адаптированы из",
    creditSuffix: "(лицензия MIT).",
  },
  ja: {
    title: "利用統計ダッシュボード",
    subtitle:
      "opencodex インストールによる自己申告データから集計されたプロジェクト全体の匿名日次統計です（プライバシー通知の表示後にデフォルトで有効になり、拒否または無効化されている場合を除きます）。",
    rangeAria: "集計期間",
    range7d: "7日",
    range30d: "30日",
    range90d: "90日",
    range365d: "365日",
    updatedPrefix: "更新",
    updatedPending: "スナップショット待機中",
    privacyBadge: "匿名集計のみ",
    selfReportedLabel: "opencodex インストールによる自己申告データ",
    privacyBody:
      "テレメトリはデフォルトでオンですが、人が通知を確認するまでは何も送信されません。レポートには日替わりインストールハッシュと固定語彙の日次カウンタのみが含まれ、プロンプト、モデル出力、APIキー、アカウント識別子、ファイルパス、IPアドレスは一切含まれません。",
    privacyOptOutHint:
      "ocx telemetry disable、OCX_TELEMETRY=0、または DO_NOT_TRACK=1 でいつでも無効化できます。",
    privacyGuideLink: "テレメトリとプライバシーガイド",
    stateLoadingTitle: "プロジェクトテレメトリを読み込み中…",
    stateLoadingBody:
      "telemetry.opencodex.me から集計スナップショットを取得しています。",
    stateEmptyTitle: "コレクターはまだデプロイされていません",
    stateEmptyBody:
      "telemetry.opencodex.me の公開コレクターがまだデプロイされていないか、この期間の日次集計がまだ記録されていません。",
    stateErrorTitle: "ライブテレメトリを読み込めませんでした",
    stateErrorBody:
      "telemetry.opencodex.me へのリクエストが完了しませんでした（コレクターが未デプロイか一時的に到達不能です）。",
    retryButton: "再試行",
    kpiSectionAria: "主要利用指標",
    kpiActiveInstalls: "1日平均アクティブインストール",
    kpiNewInstalls: "新規インストール",
    kpiRequests: "リクエスト数",
    kpiTokens: "総トークン数",
    kpiActiveHours: "アクティブ時間",
    tokenMixTitle: "トークン内訳",
    tokenMixSubtitle:
      "入力・キャッシュ読取・キャッシュ書込・出力・推論の互いに素な5区分の比率（合計100%）。",
    tokenInput: "入力",
    tokenCacheRead: "キャッシュ読取",
    tokenCacheWrite: "キャッシュ書込",
    tokenOutput: "出力",
    tokenReasoning: "推論",
    heatmapTitle: "365日アクティビティヒートマップ",
    heatmapSubtitle:
      "過去52週間の日次アクティブインストール数（UTC）。",
    heatmapActiveDays: "アクティブ {count} 日",
    heatmapPeakDay: "ピーク: {date} ({count})",
    heatmapLess: "少",
    heatmapMore: "多",
    heatmapTooltipUnit: "アクティブインストール",
    heatmapKeyboardHint:
      "矢印キーで前後の日に移動し、Home/Endで期間の端へジャンプ、Escapeでツールチップを閉じます。",
    dailyChartTitle: "プロバイダー種別ごとの日次利用量",
    dailyChartSubtitle: "選択した期間における日次積み上げ推移。",
    metricTokens: "トークン",
    metricRequests: "リクエスト",
    providersTitle: "プロバイダー種別",
    providersSubtitle: "トークン数・リクエスト数別のプロバイダーシェア。",
    modelsTitle: "モデル系統",
    modelsSubtitle: "トークン数・リクエスト数別のモデル系統シェア。",
    colProvider: "プロバイダー種別",
    colModel: "モデル系統",
    colRequests: "リクエスト",
    colTokens: "トークン",
    colShare: "トークン比率",
    versionsTitle: "バージョン",
    versionsSubtitle: "リリースバージョン別のアクティブ・新規インストール数。",
    platformsTitle: "プラットフォーム",
    platformsSubtitle: "OS および CPU アーキテクチャの分布。",
    channelsTitle: "インストール経路",
    channelsSubtitle: "プロキシのインストール方法別の分布。",
    colVersion: "バージョン",
    colPlatform: "プラットフォーム",
    colChannel: "経路",
    colInstalls: "インストール数",
    colNewInstalls: "新規",
    colInstallShare: "比率",
    reliabilityTitle: "信頼性とリクエスト結果",
    reliabilitySubtitle:
      "リクエスト完了率と主な失敗原因（固定エラーコード）。",
    completionRateLabel: "完了率",
    outcomeCompleted: "完了",
    outcomeIncomplete: "未完了",
    outcomeAborted: "中断",
    outcomeFailed: "失敗",
    topErrorsTitle: "主な失敗原因",
    colErrorCause: "失敗原因",
    colErrorCount: "件数",
    noErrorsRecorded: "この期間に記録された失敗原因はありません。",
    downloadsTitle: "パッケージ & リリースダウンロード",
    downloadsSubtitle:
      "npm (@bitkyc08/opencodex) と GitHub Releases (lidge-jun/opencodex) のライブダウンロード集計。",
    npmWeeklyLabel: "npm（過去7日間）",
    npmMonthlyLabel: "npm（過去30日間）",
    npmYearlyLabel: "npm（過去365日間）",
    githubTotalLabel: "GitHub リリースアセット（累計）",
    githubLatestLabel: "最新リリースアセット",
    downloadsPartial: "一部集計",
    downloadsUnavailable: "取得不可",
    noDataInTable: "この期間のレポートデータはありません。",
    creditPrefix:
      "ビジュアルデザインとコントリビューションヒートマップは",
    creditSuffix: "（MITライセンス）を参考に構成されています。",
  },
  tr: {
    title: "Kullanım Paneli",
    subtitle:
      "opencodex kurulumları tarafından kendi kendine bildirilen proje genelinde anonim günlük istatistikler (bir kişi gizlilik bildirimini gördükten sonra, reddedilmediği veya kapatılmadığı sürece varsayılan olarak açıktır).",
    rangeAria: "Raporlama aralığı",
    range7d: "7g",
    range30d: "30g",
    range90d: "90g",
    range365d: "365g",
    updatedPrefix: "Güncellendi",
    updatedPending: "Anlık görüntü bekleniyor",
    privacyBadge: "Yalnızca anonim toplamlar",
    selfReportedLabel: "opencodex kurulumları tarafından kendi kendine bildirilen veriler",
    privacyBody:
      "Telemetri varsayılan olarak açıktır ve bir kişi bildirimi görene kadar hiçbir şey göndermez. Raporlar yalnızca günlük dönen kurulum karması ve kapalı sözlük sayaçları içerir; istemler, model çıktıları, API anahtarları, hesap kimlikleri, dosya yolları veya IP adresleri asla gönderilmez.",
    privacyOptOutHint:
      "İstediğiniz zaman ocx telemetry disable, OCX_TELEMETRY=0 veya DO_NOT_TRACK=1 ile kapatabilirsiniz.",
    privacyGuideLink: "Telemetri ve gizlilik kılavuzu",
    stateLoadingTitle: "Proje telemetrisi yükleniyor…",
    stateLoadingBody:
      "telemetry.opencodex.me adresinden toplu kullanım verileri alınıyor.",
    stateEmptyTitle: "Toplayıcı henüz devreye alınmadı",
    stateEmptyBody:
      "telemetry.opencodex.me üzerindeki genel toplayıcı henüz dağıtılmadı veya bu aralık için günlük veri kaydedilmedi.",
    stateErrorTitle: "Canlı telemetri yüklenemedi",
    stateErrorBody:
      "telemetry.opencodex.me isteği tamamlanamadı (toplayıcı henüz dağıtılmamış veya geçici olarak erişilemiyor olabilir).",
    retryButton: "Yeniden dene",
    kpiSectionAria: "Temel kullanım ölçütleri",
    kpiActiveInstalls: "Günlük ort. etkin kurulum",
    kpiNewInstalls: "Yeni kurulumlar",
    kpiRequests: "İstekler",
    kpiTokens: "Toplam jeton",
    kpiActiveHours: "Etkin saat",
    tokenMixTitle: "Jeton dağılımı",
    tokenMixSubtitle:
      "Giriş, önbellek okuma, önbellek yazma, çıkış ve akıl yürütme ayrık jeton dilimleri — toplamı %100'dür.",
    tokenInput: "Giriş",
    tokenCacheRead: "Önbellek okuma",
    tokenCacheWrite: "Önbellek yazma",
    tokenOutput: "Çıkış",
    tokenReasoning: "Akıl yürütme",
    heatmapTitle: "365 günlük etkinlik ısı haritası",
    heatmapSubtitle:
      "Son 52 hafta boyunca günlük rapor veren etkin kurulumlar (UTC).",
    heatmapActiveDays: "{count} etkin gün",
    heatmapPeakDay: "Zirve: {date} ({count})",
    heatmapLess: "Düşük",
    heatmapMore: "Yüksek",
    heatmapTooltipUnit: "etkin kurulum",
    heatmapKeyboardHint:
      "Günler arasında gezinmek için ok tuşlarını, dönem uçlarına gitmek için Home/End tuşlarını, ipucunu kapatmak için Escape tuşunu kullanın.",
    dailyChartTitle: "Sağlayıcı türüne göre günlük kullanım",
    dailyChartSubtitle: "Seçilen aralıktaki günlük yığılmış kullanım hacmi.",
    metricTokens: "Jeton",
    metricRequests: "İstek",
    providersTitle: "Sağlayıcı türleri",
    providersSubtitle: "Jeton ve isteklere göre sağlayıcı payları.",
    modelsTitle: "Model aileleri",
    modelsSubtitle: "Jeton ve isteklere göre model ailesi payları.",
    colProvider: "Sağlayıcı türü",
    colModel: "Model ailesi",
    colRequests: "İstek",
    colTokens: "Jeton",
    colShare: "Jeton payı",
    versionsTitle: "Sürümler",
    versionsSubtitle: "Sürüme göre etkin ve yeni kurulumlar.",
    platformsTitle: "Platformlar",
    platformsSubtitle: "İşletim sistemi ve CPU mimarisi dağılımı.",
    channelsTitle: "Kurulum kanalları",
    channelsSubtitle: "Proxy'lerin nasıl kurulduğu.",
    colVersion: "Sürüm",
    colPlatform: "Platform",
    colChannel: "Kanal",
    colInstalls: "Kurulum",
    colNewInstalls: "Yeni",
    colInstallShare: "Pay",
    reliabilityTitle: "Güvenilirlik ve sonuçlar",
    reliabilitySubtitle:
      "İstek tamamlanma oranı ve başlıca kapalı sözlük hata nedenleri.",
    completionRateLabel: "Tamamlanma oranı",
    outcomeCompleted: "Tamamlandı",
    outcomeIncomplete: "Eksik",
    outcomeAborted: "İptal edildi",
    outcomeFailed: "Başarısız",
    topErrorsTitle: "Başlıca hata nedenleri",
    colErrorCause: "Hata nedeni",
    colErrorCount: "Sayı",
    noErrorsRecorded: "Bu aralıkta hata nedeni kaydedilmedi.",
    downloadsTitle: "Paket ve sürüm indirmeleri",
    downloadsSubtitle:
      "npm (@bitkyc08/opencodex) ve GitHub sürüm varlıklarından (lidge-jun/opencodex) canlı indirme sayıları.",
    npmWeeklyLabel: "npm (son 7 gün)",
    npmMonthlyLabel: "npm (son 30 gün)",
    npmYearlyLabel: "npm (son 365 gün)",
    githubTotalLabel: "GitHub sürüm varlıkları (toplam)",
    githubLatestLabel: "Son sürüm varlıkları",
    downloadsPartial: "kısmi",
    downloadsUnavailable: "Kullanılamıyor",
    noDataInTable: "Bu aralık için veri bildirilmedi.",
    creditPrefix:
      "Görsel tasarım ve katkı ısı haritası desenleri şuradan uyarlanmıştır:",
    creditSuffix: "(MIT Lisansı).",
  },
};

export function resolveTelemetryDashboardLocale(
  raw: string | null | undefined,
): TelemetryDashboardLocale {
  if (!raw) return "en";
  const normalized = raw.trim().toLowerCase();
  if ((TELEMETRY_DASHBOARD_LOCALES as readonly string[]).includes(normalized)) {
    return normalized as TelemetryDashboardLocale;
  }
  return "en";
}

export function getTelemetryDashboardCopy(
  locale: string | null | undefined,
): TelemetryDashboardCopy {
  return TELEMETRY_DASHBOARD_STRINGS[resolveTelemetryDashboardLocale(locale)];
}
