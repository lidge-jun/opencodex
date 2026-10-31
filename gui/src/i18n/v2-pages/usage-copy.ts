import { copyTable, type Row } from "./copy-table";

/*
 * Copy for the v2 Usage page. Columns: en, ko, de, fr, zh, zh-TW, ru, ja, tr, vi, pt.
 * Keys render as `usageV2.<key>`.
 */
const rows = {
  rangeLabel: ["Time range", "기간", "Zeitraum", "Période", "时间范围", "時間範圍", "Период", "期間", "Zaman aralığı", "Khoảng thời gian", "Período"],
  activeDaysFoot: ["Active on {days} days", "{days}일 동안 사용", "An {days} Tagen aktiv", "Actif {days} jours", "{days} 天有活动", "{days} 天有活動", "Активно дней: {days}", "{days} 日間アクティブ", "{days} gün etkin", "Hoạt động {days} ngày", "Ativo em {days} dias"],
  tokensSplit: ["In {input} · Out {output}", "입력 {input} · 출력 {output}", "Ein {input} · Aus {output}", "Entrée {input} · Sortie {output}", "输入 {input} · 输出 {output}", "輸入 {input} · 輸出 {output}", "Вход {input} · Выход {output}", "入力 {input} · 出力 {output}", "Giriş {input} · Çıkış {output}", "Vào {input} · Ra {output}", "Entrada {input} · Saída {output}"],
  costLabel: ["Estimated cost", "예상 비용", "Geschätzte Kosten", "Coût estimé", "预估费用", "預估費用", "Оценка стоимости", "推定コスト", "Tahmini maliyet", "Chi phí ước tính", "Custo estimado"],
  costFoot: ["An estimate, not a bill", "청구 금액이 아닌 추정치", "Schätzung, keine Rechnung", "Une estimation, pas une facture", "估算值，并非账单", "估算值，並非帳單", "Оценка, а не счёт", "請求額ではなく推定値", "Fatura değil, tahmin", "Ước tính, không phải hóa đơn", "Uma estimativa, não uma fatura"],
  costMissing: ["This proxy does not report prices", "이 프록시는 가격을 알려 주지 않습니다", "Dieser Proxy meldet keine Preise", "Ce proxy ne fournit pas de prix", "此代理不提供价格", "此代理不提供價格", "Этот прокси не сообщает цены", "このプロキシは価格を返しません", "Bu proxy fiyat bildirmiyor", "Proxy này không báo giá", "Este proxy não informa preços"],
  coverageHint: [
    "Share of requests whose token counts are known, measured by the proxy or reported by the provider. The rest are still counted as requests but never shown as zero tokens.",
    "토큰 수를 알고 있는 요청의 비율입니다. 프록시가 직접 측정했거나 프로바이더가 알려 준 요청이 포함됩니다. 나머지도 요청 수에는 들어가지만 토큰 0으로 표시되지는 않습니다.",
    "Anteil der Anfragen mit bekannter Tokenzahl, vom Proxy gemessen oder vom Anbieter gemeldet. Die übrigen zählen weiter als Anfragen, erscheinen aber nie als null Tokens.",
    "Part des requêtes dont le nombre de jetons est connu, mesuré par le proxy ou communiqué par le fournisseur. Les autres restent comptées comme requêtes, sans jamais afficher zéro jeton.",
    "已知 token 数的请求占比，由代理测量或由提供商报告。其余请求仍计入请求数，但不会显示为 0 token。",
    "已知 token 數的請求比例，由代理測量或由供應商回報。其餘請求仍計入請求數，但不會顯示為 0 token。",
    "Доля запросов с известным числом токенов — измеренным прокси или сообщённым провайдером. Остальные учитываются как запросы, но никогда не показываются как ноль токенов.",
    "トークン数が分かっているリクエストの割合です。プロキシが計測したものと、プロバイダーが報告したものを含みます。残りもリクエスト数には含まれますが、0 トークンとしては表示しません。",
    "Token sayısı bilinen isteklerin oranı; proxy tarafından ölçülen veya sağlayıcının bildirdiği. Kalanlar istek olarak sayılır ama asla sıfır token olarak gösterilmez.",
    "Tỷ lệ yêu cầu đã biết số token, do proxy đo hoặc nhà cung cấp báo. Phần còn lại vẫn được tính là yêu cầu nhưng không bao giờ hiển thị là 0 token.",
    "Parcela de pedidos com contagem de tokens conhecida, medida pelo proxy ou informada pelo provedor. Os demais continuam contados como pedidos, mas nunca aparecem como zero tokens.",
  ],
  coverageFoot: ["{measured} of {requests} requests measured", "요청 {requests}건 중 {measured}건 측정됨", "{measured} von {requests} Anfragen gemessen", "{measured} requêtes mesurées sur {requests}", "{requests} 个请求中已测量 {measured} 个", "{requests} 個請求中已測量 {measured} 個", "Измерено {measured} из {requests} запросов", "{requests} 件中 {measured} 件を計測", "{requests} isteğin {measured} tanesi ölçüldü", "Đã đo {measured} trên {requests} yêu cầu", "{measured} de {requests} pedidos medidos"],
  chartCaption: ["{tokens} tokens in this window", "이 기간 토큰 {tokens}", "{tokens} Tokens in diesem Zeitraum", "{tokens} jetons sur cette période", "此期间共 {tokens} token", "此期間共 {tokens} token", "{tokens} токенов за период", "この期間のトークン {tokens}", "Bu aralıkta {tokens} token", "{tokens} token trong khoảng này", "{tokens} tokens neste período"],
  chartView: ["Chart view", "차트 보기", "Diagrammansicht", "Vue du graphique", "图表视图", "圖表檢視", "Вид графика", "グラフ表示", "Grafik görünümü", "Kiểu biểu đồ", "Visualização do gráfico"],
  viewBars: ["Bars", "막대", "Balken", "Barres", "柱状", "長條", "Столбцы", "棒グラフ", "Çubuklar", "Cột", "Barras"],
  viewCalendar: ["Calendar", "달력", "Kalender", "Calendrier", "日历", "日曆", "Календарь", "カレンダー", "Takvim", "Lịch", "Calendário"],
  emptyFiltered: [
    "Nothing in this window or source. Available history or another source may show older usage.",
    "이 기간이나 출처에는 기록이 없습니다. 사용 가능한 기록이나 다른 출처를 고르면 이전 사용량이 보일 수 있습니다.",
    "Nichts in diesem Zeitraum oder dieser Quelle. Der verfügbare Verlauf oder eine andere Quelle zeigt eventuell ältere Nutzung.",
    "Rien sur cette période ou pour cette source. L’historique disponible ou une autre source peut afficher une utilisation plus ancienne.",
    "此时间范围或来源中没有记录。选择“可用历史”或其他来源可能会看到更早的用量。",
    "此時間範圍或來源中沒有紀錄。選擇「可用歷史」或其他來源可能會看到更早的用量。",
    "В этом периоде или источнике ничего нет. «Доступная история» или другой источник могут показать более раннее использование.",
    "この期間やソースには記録がありません。「利用可能な履歴」や別のソースで以前の使用量が見られる場合があります。",
    "Bu aralıkta veya kaynakta kayıt yok. Kullanılabilir geçmiş veya başka bir kaynak daha eski kullanımı gösterebilir.",
    "Không có gì trong khoảng hoặc nguồn này. Lịch sử hiện có hoặc nguồn khác có thể hiển thị mức dùng cũ hơn.",
    "Nada neste período ou origem. O histórico disponível ou outra origem pode mostrar uso mais antigo.",
  ],
  companionPreview: ["Widget preview", "위젯 미리 보기", "Widget-Vorschau", "Aperçu du widget", "小组件预览", "小工具預覽", "Предпросмотр виджета", "ウィジェットのプレビュー", "Widget önizlemesi", "Xem trước widget", "Prévia do widget"],
  companionSettings: ["Display settings", "표시 설정", "Anzeigeeinstellungen", "Réglages d’affichage", "显示设置", "顯示設定", "Настройки отображения", "表示設定", "Görüntü ayarları", "Cài đặt hiển thị", "Configurações de exibição"],
  companionMenuBar: ["Menu bar", "메뉴 막대", "Menüleiste", "Barre des menus", "菜单栏", "選單列", "Строка меню", "メニューバー", "Menü çubuğu", "Thanh menu", "Barra de menus"],
  companionChart: ["Chart", "차트", "Diagramm", "Graphique", "图表", "圖表", "График", "グラフ", "Grafik", "Biểu đồ", "Gráfico"],
} satisfies Record<string, Row>;

export const usageV2Copy = copyTable("usageV2", rows);
