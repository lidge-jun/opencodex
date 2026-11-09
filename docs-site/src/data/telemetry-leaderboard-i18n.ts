/**
 * Copy for the opencodex.me leaderboard section (TelemetryLeaderboard.astro): connected public
 * profiles only. Same 8 locales as the anonymous dashboard copy, kept in a separate table because
 * profiles are something a person connects, while the anonymous telemetry is on by default.
 */
export const TELEMETRY_LEADERBOARD_LOCALES = ["en", "fr", "ko", "zh-cn", "zh-tw", "ru", "ja", "tr"] as const;
export type TelemetryLeaderboardLocale = (typeof TELEMETRY_LEADERBOARD_LOCALES)[number];

export interface TelemetryLeaderboardCopy {
  title: string;
  subtitle: string;
  periodAria: string;
  periodDay: string;
  periodWeek: string;
  periodMonth: string;
  metricAria: string;
  metricTokens: string;
  metricRequests: string;
  colRank: string;
  colProfile: string;
  colTokens: string;
  colRequests: string;
  loading: string;
  empty: string;
  error: string;
  retry: string;
  findLabel: string;
  findButton: string;
  findInvalid: string;
  profileNotFound: string;
  profileRankOf: string;
  profileNotRanked: string;
  profileFamilies: string;
  profileClose: string;
  howToJoin: string;
}

export const TELEMETRY_LEADERBOARD_STRINGS: Record<TelemetryLeaderboardLocale, TelemetryLeaderboardCopy> = {
  "en": {
    title: "Leaderboard",
    subtitle: "Profiles that people connected from their own opencodex dashboard. Daily totals are self-reported.",
    periodAria: "Leaderboard period",
    periodDay: "Day",
    periodWeek: "Week",
    periodMonth: "Month",
    metricAria: "Rank by",
    metricTokens: "Tokens",
    metricRequests: "Requests",
    colRank: "Rank",
    colProfile: "Profile",
    colTokens: "Tokens",
    colRequests: "Requests",
    loading: "Loading the leaderboard…",
    empty: "No public profiles yet.",
    error: "The leaderboard could not be loaded.",
    retry: "Try again",
    findLabel: "Find a profile by handle",
    findButton: "Find",
    findInvalid: "Handles are 3–24 lowercase letters, digits or hyphens.",
    profileNotFound: "No public profile has that handle.",
    profileRankOf: "#{rank} of {of}",
    profileNotRanked: "Not ranked",
    profileFamilies: "Top model families this month",
    profileClose: "Close",
    howToJoin: "Connect a profile from the Home screen of your opencodex dashboard, or run ocx telemetry profile connect. Disconnecting deletes it.",
  },
  "fr": {
    title: "Classement",
    subtitle: "Profils connectés par leurs propriétaires depuis leur tableau de bord opencodex. Les totaux quotidiens sont autodéclarés.",
    periodAria: "Période du classement",
    periodDay: "Jour",
    periodWeek: "Semaine",
    periodMonth: "Mois",
    metricAria: "Classer par",
    metricTokens: "Jetons",
    metricRequests: "Requêtes",
    colRank: "Rang",
    colProfile: "Profil",
    colTokens: "Jetons",
    colRequests: "Requêtes",
    loading: "Chargement du classement…",
    empty: "Aucun profil public pour l'instant.",
    error: "Le classement n'a pas pu être chargé.",
    retry: "Réessayer",
    findLabel: "Trouver un profil par identifiant",
    findButton: "Trouver",
    findInvalid: "Les identifiants comptent 3 à 24 minuscules, chiffres ou tirets.",
    profileNotFound: "Aucun profil public ne porte cet identifiant.",
    profileRankOf: "{rank}e sur {of}",
    profileNotRanked: "Non classé",
    profileFamilies: "Principales familles de modèles ce mois-ci",
    profileClose: "Fermer",
    howToJoin: "Connectez un profil depuis l'accueil de votre tableau de bord opencodex, ou lancez ocx telemetry profile connect. La déconnexion le supprime.",
  },
  "ko": {
    title: "리더보드",
    subtitle: "사용자가 자신의 opencodex 대시보드에서 직접 연결한 프로필이에요. 일일 합계는 자체 보고 값이에요.",
    periodAria: "리더보드 기간",
    periodDay: "일간",
    periodWeek: "주간",
    periodMonth: "월간",
    metricAria: "순위 기준",
    metricTokens: "토큰",
    metricRequests: "요청",
    colRank: "순위",
    colProfile: "프로필",
    colTokens: "토큰",
    colRequests: "요청",
    loading: "리더보드를 불러오는 중…",
    empty: "아직 공개 프로필이 없어요.",
    error: "리더보드를 불러오지 못했어요.",
    retry: "다시 시도",
    findLabel: "핸들로 프로필 찾기",
    findButton: "찾기",
    findInvalid: "핸들은 소문자·숫자·하이픈 3–24자예요.",
    profileNotFound: "그 핸들의 공개 프로필이 없어요.",
    profileRankOf: "{of}명 중 {rank}위",
    profileNotRanked: "순위 없음",
    profileFamilies: "이번 달 주요 모델 계열",
    profileClose: "닫기",
    howToJoin: "opencodex 대시보드 홈 화면에서 프로필을 연결하거나 ocx telemetry profile connect를 실행하세요. 연결을 해제하면 삭제돼요.",
  },
  "zh-cn": {
    title: "排行榜",
    subtitle: "由用户在自己的 opencodex 仪表板中连接的资料。每日合计为自行上报。",
    periodAria: "排行榜周期",
    periodDay: "日",
    periodWeek: "周",
    periodMonth: "月",
    metricAria: "排名依据",
    metricTokens: "令牌",
    metricRequests: "请求",
    colRank: "排名",
    colProfile: "资料",
    colTokens: "令牌",
    colRequests: "请求",
    loading: "正在加载排行榜…",
    empty: "还没有公开资料。",
    error: "无法加载排行榜。",
    retry: "重试",
    findLabel: "按用户名查找资料",
    findButton: "查找",
    findInvalid: "用户名为 3–24 个小写字母、数字或连字符。",
    profileNotFound: "没有使用该用户名的公开资料。",
    profileRankOf: "第 {rank} 名 / 共 {of}",
    profileNotRanked: "未排名",
    profileFamilies: "本月主要模型系列",
    profileClose: "关闭",
    howToJoin: "在 opencodex 仪表板的主页连接资料，或运行 ocx telemetry profile connect。断开连接会删除资料。",
  },
  "zh-tw": {
    title: "排行榜",
    subtitle: "由使用者在自己的 opencodex 儀表板中連接的資料。每日合計為自行回報。",
    periodAria: "排行榜期間",
    periodDay: "日",
    periodWeek: "週",
    periodMonth: "月",
    metricAria: "排名依據",
    metricTokens: "Token",
    metricRequests: "請求",
    colRank: "排名",
    colProfile: "資料",
    colTokens: "Token",
    colRequests: "請求",
    loading: "正在載入排行榜…",
    empty: "尚無公開資料。",
    error: "無法載入排行榜。",
    retry: "重試",
    findLabel: "依帳號名稱尋找資料",
    findButton: "尋找",
    findInvalid: "帳號名稱為 3–24 個小寫字母、數字或連字號。",
    profileNotFound: "沒有使用該帳號名稱的公開資料。",
    profileRankOf: "第 {rank} 名 / 共 {of}",
    profileNotRanked: "未排名",
    profileFamilies: "本月主要模型系列",
    profileClose: "關閉",
    howToJoin: "在 opencodex 儀表板的首頁連接資料，或執行 ocx telemetry profile connect。中斷連接會刪除資料。",
  },
  "ru": {
    title: "Рейтинг",
    subtitle: "Профили, которые люди подключили в своей панели opencodex. Дневные суммы сообщают сами пользователи.",
    periodAria: "Период рейтинга",
    periodDay: "День",
    periodWeek: "Неделя",
    periodMonth: "Месяц",
    metricAria: "Сортировать по",
    metricTokens: "Токены",
    metricRequests: "Запросы",
    colRank: "Место",
    colProfile: "Профиль",
    colTokens: "Токены",
    colRequests: "Запросы",
    loading: "Загрузка рейтинга…",
    empty: "Публичных профилей пока нет.",
    error: "Не удалось загрузить рейтинг.",
    retry: "Повторить",
    findLabel: "Найти профиль по нику",
    findButton: "Найти",
    findInvalid: "Ник: 3–24 строчные латинские буквы, цифры или дефисы.",
    profileNotFound: "Публичного профиля с таким ником нет.",
    profileRankOf: "№{rank} из {of}",
    profileNotRanked: "Без места",
    profileFamilies: "Основные семейства моделей за месяц",
    profileClose: "Закрыть",
    howToJoin: "Подключите профиль на главном экране панели opencodex или выполните ocx telemetry profile connect. Отключение удаляет его.",
  },
  "ja": {
    title: "リーダーボード",
    subtitle: "利用者が自分の opencodex ダッシュボードから接続したプロフィールです。日ごとの合計は自己申告です。",
    periodAria: "リーダーボードの期間",
    periodDay: "日",
    periodWeek: "週",
    periodMonth: "月",
    metricAria: "並べ替え",
    metricTokens: "トークン",
    metricRequests: "リクエスト",
    colRank: "順位",
    colProfile: "プロフィール",
    colTokens: "トークン",
    colRequests: "リクエスト",
    loading: "リーダーボードを読み込み中…",
    empty: "公開プロフィールはまだありません。",
    error: "リーダーボードを読み込めませんでした。",
    retry: "再試行",
    findLabel: "ハンドルでプロフィールを探す",
    findButton: "検索",
    findInvalid: "ハンドルは小文字・数字・ハイフンで 3〜24 文字です。",
    profileNotFound: "そのハンドルの公開プロフィールはありません。",
    profileRankOf: "{of} 人中 {rank} 位",
    profileNotRanked: "順位なし",
    profileFamilies: "今月の主なモデル系統",
    profileClose: "閉じる",
    howToJoin: "opencodex ダッシュボードのホーム画面でプロフィールを接続するか、ocx telemetry profile connect を実行してください。接続を解除すると削除されます。",
  },
  "tr": {
    title: "Sıralama",
    subtitle: "Kişilerin kendi opencodex panolarından bağladığı profiller. Günlük toplamlar kişilerin kendi bildirimidir.",
    periodAria: "Sıralama dönemi",
    periodDay: "Gün",
    periodWeek: "Hafta",
    periodMonth: "Ay",
    metricAria: "Sıralama ölçütü",
    metricTokens: "Jeton",
    metricRequests: "İstek",
    colRank: "Sıra",
    colProfile: "Profil",
    colTokens: "Jeton",
    colRequests: "İstek",
    loading: "Sıralama yükleniyor…",
    empty: "Henüz herkese açık profil yok.",
    error: "Sıralama yüklenemedi.",
    retry: "Tekrar dene",
    findLabel: "Kullanıcı adıyla profil bul",
    findButton: "Bul",
    findInvalid: "Kullanıcı adları 3–24 küçük harf, rakam veya tiredir.",
    profileNotFound: "Bu kullanıcı adına sahip herkese açık profil yok.",
    profileRankOf: "{of} kişi içinde {rank}.",
    profileNotRanked: "Sıralamada değil",
    profileFamilies: "Bu ayın başlıca model aileleri",
    profileClose: "Kapat",
    howToJoin: "opencodex panonun Ana ekranından bir profil bağla ya da ocx telemetry profile connect komutunu çalıştır. Bağlantıyı kesmek profili siler.",
  },
};

export function resolveTelemetryLeaderboardLocale(locale: string | null | undefined): TelemetryLeaderboardLocale {
  const normalized = (locale ?? "en").toLowerCase();
  return (TELEMETRY_LEADERBOARD_LOCALES as readonly string[]).includes(normalized)
    ? (normalized as TelemetryLeaderboardLocale)
    : "en";
}

export function getTelemetryLeaderboardCopy(locale: string | null | undefined): TelemetryLeaderboardCopy {
  return TELEMETRY_LEADERBOARD_STRINGS[resolveTelemetryLeaderboardLocale(locale)];
}

