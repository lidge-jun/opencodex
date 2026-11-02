import { copyTable, type Row } from "./copy-table";

/*
 * Copy for the v2 Connect (integrations, Claude, API keys) and the Set up hub pages. Columns: en, ko, de, fr, zh, zh-TW, ru, ja, tr, vi, pt.
 * Keys render as `connectV2.<key>`.
 */
const rows = {
  moreAbout: ["More about {label}", "{label} 자세히", "Mehr zu {label}", "En savoir plus sur {label}", "关于{label}的更多信息", "關於{label}的更多資訊", "Подробнее: {label}", "{label}の詳細", "{label} hakkında daha fazla", "Tìm hiểu thêm về {label}", "Mais sobre {label}"],
  subtitle: [
    "Turn an app on and its requests go through opencodex. Every change keeps a backup you can restore.",
    "앱을 켜면 그 앱의 요청이 opencodex를 거쳐 가요. 바꾸기 전에 항상 백업을 남겨서 언제든 되돌릴 수 있어요.",
    "Schalte eine App ein, dann laufen ihre Anfragen über opencodex. Jede Änderung legt vorher eine Sicherung an, die du wiederherstellen kannst.",
    "Activez une application et ses requêtes passent par opencodex. Chaque modification conserve une sauvegarde que vous pouvez restaurer.",
    "打开一个应用后，它的请求会经过 opencodex。每次更改前都会保留备份，随时可以恢复。",
    "開啟一個應用程式後，它的請求會經過 opencodex。每次變更前都會保留備份，隨時可以還原。",
    "Включите приложение, и его запросы пойдут через opencodex. Перед каждым изменением сохраняется резервная копия, которую можно восстановить.",
    "アプリをオンにすると、そのリクエストは opencodex を経由します。変更のたびにバックアップを残すので、いつでも元に戻せます。",
    "Bir uygulamayı açtığınızda istekleri opencodex üzerinden geçer. Her değişiklikten önce geri yükleyebileceğiniz bir yedek alınır.",
    "Bật một ứng dụng và các yêu cầu của nó sẽ đi qua opencodex. Mỗi thay đổi đều giữ lại bản sao lưu để bạn khôi phục.",
    "Ative um app e as solicitações dele passam pelo opencodex. Cada mudança guarda um backup que você pode restaurar.",
  ],
  elsewhereTitle: ["Not on this computer ({count})", "이 컴퓨터에 없는 앱 ({count})", "Nicht auf diesem Computer ({count})", "Absentes de cet ordinateur ({count})", "此电脑上未安装（{count}）", "此電腦上未安裝（{count}）", "Не установлены на этом компьютере ({count})", "このパソコンにないアプリ（{count}）", "Bu bilgisayarda yok ({count})", "Chưa có trên máy này ({count})", "Não estão neste computador ({count})"],
  elsewhereHint: ["Install one and it moves up to your apps.", "설치하면 위의 내 앱 목록으로 올라가요.", "Installiere eine, dann erscheint sie oben bei deinen Apps.", "Installez-en une et elle remonte parmi vos applications.", "安装后会移到上方的应用列表中。", "安裝後會移到上方的應用程式清單中。", "Установите приложение, и оно появится выше в списке.", "インストールすると上のアプリ一覧に移ります。", "Birini kurduğunuzda yukarıdaki uygulamalarınıza taşınır.", "Cài đặt một ứng dụng và nó sẽ chuyển lên danh sách phía trên.", "Instale um e ele sobe para os seus apps."],
  setupEssentials: ["The essentials", "꼭 할 일", "Das Wichtigste", "L’essentiel", "必做事项", "必做事項", "Самое важное", "まずやること", "Temel adımlar", "Việc cần làm", "O essencial"],
  setupOptional: ["When you need them", "필요할 때", "Bei Bedarf", "Selon vos besoins", "需要时再设置", "需要時再設定", "По необходимости", "必要なときに", "İhtiyaç duyduğunuzda", "Khi bạn cần", "Quando precisar"],
} satisfies Record<string, Row>;

export const connectV2Copy = copyTable("connectV2", rows);
