import { copyTable, type Row } from "./copy-table";

/*
 * Copy for the v2 Connect (integrations, Claude, API keys) and the Set up hub pages. Columns: en, ko, de, fr, zh, zh-TW, ru, ja, tr, vi, pt.
 * Keys render as `connectV2.<key>`.
 */
const rows = {
  moreAbout: ["More about {label}", "{label} 자세히", "Mehr zu {label}", "En savoir plus sur {label}", "关于{label}的更多信息", "關於{label}的更多資訊", "Подробнее: {label}", "{label}の詳細", "{label} hakkında daha fazla", "Tìm hiểu thêm về {label}", "Mais sobre {label}"],
  subtitle: [
    "Turn an app on and its requests go through opencodex. Before changing an app's settings, opencodex keeps a backup of them.",
    "앱을 켜면 그 앱의 요청이 opencodex를 거쳐 가요. 앱 설정을 바꾸기 전에는 백업을 남겨 둬요.",
    "Schalte eine App ein, dann laufen ihre Anfragen über opencodex. Bevor opencodex die Einstellungen einer App ändert, legt es eine Sicherung an.",
    "Activez une app et ses requêtes passent par opencodex. Avant de modifier les réglages d'une app, opencodex en garde une sauvegarde.",
    "开启某个应用后，它的请求会经过 opencodex。修改应用设置前，opencodex 会先保留一份备份。",
    "開啟某個應用程式後，它的請求會經過 opencodex。修改應用程式設定前，opencodex 會先保留一份備份。",
    "Включите приложение — и его запросы пойдут через opencodex. Перед изменением настроек приложения opencodex сохраняет их резервную копию.",
    "アプリをオンにすると、その要求は opencodex を経由します。アプリの設定を変更する前に、opencodex はバックアップを残します。",
    "Bir uygulamayı açtığınızda istekleri opencodex üzerinden geçer. opencodex, bir uygulamanın ayarlarını değiştirmeden önce yedeğini alır.",
    "Bật một ứng dụng và các yêu cầu của nó sẽ đi qua opencodex. Trước khi thay đổi cài đặt của ứng dụng, opencodex giữ lại một bản sao lưu.",
    "Ative um app e as solicitações dele passam pelo opencodex. Antes de alterar as configurações de um app, o opencodex guarda um backup delas.",
  ],
  elsewhereTitle: ["Not on this computer ({count})", "이 컴퓨터에 없는 앱 ({count})", "Nicht auf diesem Computer ({count})", "Absentes de cet ordinateur ({count})", "此电脑上未安装（{count}）", "此電腦上未安裝（{count}）", "Не установлены на этом компьютере ({count})", "このパソコンにないアプリ（{count}）", "Bu bilgisayarda yok ({count})", "Chưa có trên máy này ({count})", "Não estão neste computador ({count})"],
  elsewhereHint: ["Install one and it moves up to your apps.", "설치하면 위의 내 앱 목록으로 올라가요.", "Installiere eine, dann erscheint sie oben bei deinen Apps.", "Installez-en une et elle remonte parmi vos applications.", "安装后会移到上方的应用列表中。", "安裝後會移到上方的應用程式清單中。", "Установите приложение, и оно появится выше в списке.", "インストールすると上のアプリ一覧に移ります。", "Birini kurduğunuzda yukarıdaki uygulamalarınıza taşınır.", "Cài đặt một ứng dụng và nó sẽ chuyển lên danh sách phía trên.", "Instale um e ele sobe para os seus apps."],
  setupEssentials: ["The essentials", "꼭 할 일", "Das Wichtigste", "L’essentiel", "必做事项", "必做事項", "Самое важное", "まずやること", "Temel adımlar", "Việc cần làm", "O essencial"],
  setupOptional: ["When you need them", "필요할 때", "Bei Bedarf", "Selon vos besoins", "需要时再设置", "需要時再設定", "По необходимости", "必要なときに", "İhtiyaç duyduğunuzda", "Khi bạn cần", "Quando precisar"],
} satisfies Record<string, Row>;

export const connectV2Copy = copyTable("connectV2", rows);
