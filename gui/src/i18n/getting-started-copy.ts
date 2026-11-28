/*
 * Copy for hiding and restoring Home's Getting started card. One row per key, columns in the
 * order of `locales`; spread into the catalogs through shellV2Copy() so this surface lands as one
 * reviewable table without touching the eleven locale files.
 */
type Locale = "en" | "ko" | "de" | "fr" | "zh" | "zh-TW" | "ru" | "ja" | "tr" | "vi" | "pt" | "es";
const locales: readonly Locale[] = ["en", "ko", "de", "fr", "zh", "zh-TW", "ru", "ja", "tr", "vi", "pt", "es"];
type Row = readonly [string, string, string, string, string, string, string, string, string, string, string, string];

const rows = {
  "gettingStarted.hide": ["Hide", "숨기기", "Ausblenden", "Masquer", "隐藏", "隱藏", "Скрыть", "非表示", "Gizle", "Ẩn", "Ocultar", "Ocultar"],
  "gettingStarted.hideLabel": ["Hide Getting started", "시작하기 숨기기", "Erste Schritte ausblenden", "Masquer Premiers pas", "隐藏开始使用", "隱藏開始使用", "Скрыть «Начало работы»", "「はじめに」を非表示", "Başlarken’i gizle", "Ẩn Bắt đầu", "Ocultar Primeiros passos", "Ocultar Primeros pasos"],
  "gettingStarted.hideHint": ["You can show it again from {place}.", "{place}에서 다시 보이게 할 수 있어요.", "Unter {place} kannst du es wieder einblenden.", "Vous pouvez le réafficher depuis {place}.", "可在{place}中重新显示。", "可在{place}中重新顯示。", "Вернуть можно в разделе {place}.", "{place} から再表示できます。", "{place} bölümünden yeniden gösterebilirsin.", "Bạn có thể hiện lại trong {place}.", "Você pode mostrar de novo em {place}.", "Puedes volver a mostrarlo desde {place}."],
  "gettingStarted.hiddenNote": ["Getting started is hidden. You can show it again from {place}.", "시작하기를 숨겼어요. {place}에서 다시 보이게 할 수 있어요.", "Erste Schritte ist ausgeblendet. Unter {place} kannst du es wieder einblenden.", "Premiers pas est masqué. Vous pouvez le réafficher depuis {place}.", "已隐藏“开始使用”。可在{place}中重新显示。", "已隱藏「開始使用」。可在{place}中重新顯示。", "Блок «Начало работы» скрыт. Вернуть его можно в разделе {place}.", "「はじめに」を非表示にしました。{place} からいつでも再表示できます。", "Başlarken gizlendi. {place} bölümünden yeniden gösterebilirsin.", "Đã ẩn Bắt đầu. Bạn có thể hiện lại trong {place}.", "Primeiros passos está oculto. Você pode mostrá-lo de novo em {place}.", "Primeros pasos está oculto. Puedes volver a mostrarlo desde {place}."],
  "gettingStarted.undo": ["Undo", "되돌리기", "Rückgängig", "Annuler", "撤销", "復原", "Отменить", "元に戻す", "Geri al", "Hoàn tác", "Desfazer", "Deshacer"],
  "gettingStarted.hiddenOnHome": ["Getting started is hidden on Home.", "홈에서 시작하기를 숨겨 두었어요.", "Erste Schritte ist auf der Startseite ausgeblendet.", "Premiers pas est masqué sur l’accueil.", "“开始使用”已在首页隐藏。", "「開始使用」已在首頁隱藏。", "Блок «Начало работы» скрыт на главной.", "「はじめに」はホームで非表示になっています。", "Başlarken ana sayfada gizli.", "Bắt đầu đang bị ẩn trên Trang chủ.", "Primeiros passos está oculto no Início.", "Primeros pasos está oculto en Inicio."],
  "gettingStarted.showOnHome": ["Show on Home", "홈에 다시 표시", "Auf der Startseite anzeigen", "Afficher sur l’accueil", "在首页显示", "在首頁顯示", "Показать на главной", "ホームに表示", "Ana sayfada göster", "Hiện trên Trang chủ", "Mostrar no Início", "Mostrar en Inicio"],
  "gettingStarted.backOnHome": ["Getting started is back on Home.", "시작하기가 홈에 다시 나와요.", "Erste Schritte ist wieder auf der Startseite.", "Premiers pas est de retour sur l’accueil.", "“开始使用”已回到首页。", "「開始使用」已回到首頁。", "Блок «Начало работы» снова на главной.", "「はじめに」をホームに戻しました。", "Başlarken yeniden ana sayfada.", "Bắt đầu đã trở lại Trang chủ.", "Primeiros passos voltou ao Início.", "Primeros pasos volvió a Inicio."],
} satisfies Record<string, Row>;

export type GettingStartedKey = keyof typeof rows;

export function gettingStartedCopy(locale: Locale): Record<GettingStartedKey, string> {
  const index = locales.indexOf(locale);
  return Object.fromEntries(
    Object.entries(rows).map(([key, row]) => [key, row[index]!]),
  ) as Record<GettingStartedKey, string>;
}
