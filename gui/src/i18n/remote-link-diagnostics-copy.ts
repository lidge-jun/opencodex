/*
 * Copy for the read-only Remote Link diagnostics section (#7297). One row per key, columns in the
 * order of `locales`, kept apart from the per-locale files like codex-cli-update-copy.ts. Event,
 * outcome and state words are machine codes and are shown raw, in <code>.
 */
type Locale = "en" | "ko" | "de" | "fr" | "zh" | "zh-TW" | "ru" | "ja" | "tr" | "vi" | "pt";
const locales: readonly Locale[] = ["en", "ko", "de", "fr", "zh", "zh-TW", "ru", "ja", "tr", "vi", "pt"];
type Row = readonly [string, string, string, string, string, string, string, string, string, string, string];

const rows = {
  title: ["Diagnostics","진단","Diagnose","Diagnostic","诊断","診斷","Диагностика","診断","Tanılama","Chẩn đoán","Diagnóstico"],
  hint: ["Recent tunnel and relay events recorded on this computer. Only fixed categories, generated IDs, numbers and times are kept.","이 컴퓨터에 기록된 최근 터널·릴레이 이벤트예요. 정해진 분류, 생성된 ID, 숫자와 시간만 남겨요.","Letzte Tunnel- und Relay-Ereignisse, die auf diesem Computer aufgezeichnet wurden. Gespeichert werden nur feste Kategorien, erzeugte IDs, Zahlen und Zeiten.","Événements récents de tunnel et de relais enregistrés sur cet ordinateur. Seuls des catégories fixes, des identifiants générés, des nombres et des horodatages sont conservés.","此电脑上记录的最近隧道和中继事件。只保留固定类别、生成的 ID、数字和时间。","此電腦上記錄的最近通道和中繼事件。只保留固定類別、產生的 ID、數字和時間。","Недавние события туннеля и ретрансляции, записанные на этом компьютере. Хранятся только фиксированные категории, сгенерированные ID, числа и время.","このコンピューターで記録された最近のトンネルとリレーのイベントです。固定の分類、生成された ID、数値と時刻だけを残します。","Bu bilgisayarda kaydedilen son tünel ve aktarma olayları. Yalnızca sabit kategoriler, üretilmiş kimlikler, sayılar ve zamanlar tutulur.","Các sự kiện đường hầm và chuyển tiếp gần đây được ghi trên máy này. Chỉ giữ các loại cố định, ID được tạo, số và thời gian.","Eventos recentes de túnel e retransmissão registrados neste computador. Só são mantidos categorias fixas, IDs gerados, números e horários."],
  show: ["Show diagnostics","진단 보기","Diagnose anzeigen","Afficher le diagnostic","显示诊断","顯示診斷","Показать диагностику","診断を表示","Tanılamayı göster","Hiện chẩn đoán","Mostrar diagnóstico"],
  hide: ["Hide diagnostics","진단 숨기기","Diagnose ausblenden","Masquer le diagnostic","隐藏诊断","隱藏診斷","Скрыть диагностику","診断を隠す","Tanılamayı gizle","Ẩn chẩn đoán","Ocultar diagnóstico"],
  loading: ["Loading diagnostics…","진단을 불러오는 중…","Diagnose wird geladen…","Chargement du diagnostic…","正在加载诊断…","正在載入診斷…","Загрузка диагностики…","診断を読み込み中…","Tanılama yükleniyor…","Đang tải chẩn đoán…","Carregando diagnóstico…"],
  error: ["Diagnostics could not be read. Try again.","진단을 읽지 못했어요. 다시 시도하세요.","Die Diagnose konnte nicht gelesen werden. Versuche es erneut.","Le diagnostic n’a pas pu être lu. Réessayez.","无法读取诊断。请重试。","無法讀取診斷。請重試。","Не удалось прочитать диагностику. Повторите попытку.","診断を読み取れませんでした。もう一度お試しください。","Tanılama okunamadı. Yeniden deneyin.","Không đọc được chẩn đoán. Hãy thử lại.","Não foi possível ler o diagnóstico. Tente novamente."],
  empty: ["No diagnostics recorded yet.","아직 기록된 진단이 없어요.","Noch keine Diagnose aufgezeichnet.","Aucun diagnostic enregistré pour l’instant.","尚未记录任何诊断。","尚未記錄任何診斷。","Диагностика ещё не записывалась.","まだ診断は記録されていません。","Henüz tanılama kaydedilmedi.","Chưa có chẩn đoán nào được ghi.","Nenhum diagnóstico registrado ainda."],
  colTime: ["Time","시간","Zeit","Heure","时间","時間","Время","時刻","Zaman","Thời gian","Horário"],
  colEvent: ["Event","이벤트","Ereignis","Événement","事件","事件","Событие","イベント","Olay","Sự kiện","Evento"],
  colOutcome: ["Outcome","결과","Ergebnis","Résultat","结果","結果","Результат","結果","Sonuç","Kết quả","Resultado"],
  colState: ["State","상태","Zustand","État","状态","狀態","Состояние","状態","Durum","Trạng thái","Estado"],
  colAttempt: ["Attempt","시도","Versuch","Tentative","尝试","嘗試","Попытка","試行","Deneme","Lần thử","Tentativa"],
  colPort: ["Port","포트","Port","Port","端口","連接埠","Порт","ポート","Bağlantı noktası","Cổng","Porta"],
  suppressed: ["+{count} suppressed","+{count}건 생략","+{count} unterdrückt","+{count} supprimés","+{count} 条已合并","+{count} 筆已合併","+{count} подавлено","+{count} 件省略","+{count} bastırıldı","+{count} bị lược","+{count} suprimidos"],
  showing: ["Showing the newest {shown} of {total} records.","전체 {total}건 중 최신 {shown}건을 보여줘요.","Die neuesten {shown} von {total} Einträgen werden angezeigt.","Affichage des {shown} enregistrements les plus récents sur {total}.","显示 {total} 条记录中最新的 {shown} 条。","顯示 {total} 筆記錄中最新的 {shown} 筆。","Показаны последние {shown} из {total} записей.","{total} 件中、最新の {shown} 件を表示しています。","{total} kaydın en yeni {shown} tanesi gösteriliyor.","Đang hiện {shown} bản ghi mới nhất trong {total}.","Mostrando os {shown} registros mais recentes de {total}."],
  skipped: ["Skipped unreadable or unrecognized lines: {count}.","읽을 수 없거나 알 수 없는 줄 {count}개를 건너뛰었어요.","Übersprungene unlesbare oder unbekannte Zeilen: {count}.","Lignes illisibles ou non reconnues ignorées : {count}.","已跳过 {count} 行无法读取或无法识别的内容。","已略過 {count} 行無法讀取或無法辨識的內容。","Пропущено нечитаемых или нераспознанных строк: {count}.","読み取れない、または認識できない行を {count} 行スキップしました。","Okunamayan veya tanınmayan {count} satır atlandı.","Đã bỏ qua {count} dòng không đọc được hoặc không nhận ra.","Linhas ilegíveis ou não reconhecidas ignoradas: {count}."],
  truncated: ["A diagnostics file is larger than 256 KiB; only its newest 256 KiB were read.","진단 파일이 256 KiB보다 커서 최신 256 KiB만 읽었어요.","Eine Diagnosedatei ist größer als 256 KiB; nur die neuesten 256 KiB wurden gelesen.","Un fichier de diagnostic dépasse 256 Kio ; seuls ses 256 Kio les plus récents ont été lus.","有诊断文件超过 256 KiB，只读取了最新的 256 KiB。","有診斷檔案超過 256 KiB，只讀取了最新的 256 KiB。","Файл диагностики больше 256 КиБ; прочитаны только последние 256 КиБ.","診断ファイルが 256 KiB を超えているため、最新の 256 KiB だけを読み取りました。","Bir tanılama dosyası 256 KiB'tan büyük; yalnızca en yeni 256 KiB okundu.","Một tệp chẩn đoán lớn hơn 256 KiB; chỉ 256 KiB mới nhất được đọc.","Um arquivo de diagnóstico tem mais de 256 KiB; só os 256 KiB mais recentes foram lidos."],
  refused: ["A diagnostics file was not read because it is not a regular file.","일반 파일이 아니어서 읽지 않은 진단 파일이 있어요.","Eine Diagnosedatei wurde nicht gelesen, weil sie keine reguläre Datei ist.","Un fichier de diagnostic n’a pas été lu, car ce n’est pas un fichier ordinaire.","有诊断文件不是普通文件，因此未读取。","有診斷檔案不是一般檔案，因此未讀取。","Файл диагностики не прочитан: это не обычный файл.","通常のファイルではないため、読み取らなかった診断ファイルがあります。","Bir tanılama dosyası normal bir dosya olmadığı için okunmadı.","Một tệp chẩn đoán không được đọc vì nó không phải tệp thông thường.","Um arquivo de diagnóstico não foi lido porque não é um arquivo comum."],
  unreadable: ["A diagnostics file exists but could not be read.","진단 파일이 있지만 읽지 못했어요.","Eine Diagnosedatei existiert, konnte aber nicht gelesen werden.","Un fichier de diagnostic existe mais n’a pas pu être lu.","诊断文件存在，但无法读取。","診斷檔案存在，但無法讀取。","Файл диагностики существует, но его не удалось прочитать.","診断ファイルはありますが、読み取れませんでした。","Bir tanılama dosyası var ama okunamadı.","Có tệp chẩn đoán nhưng không đọc được.","Existe um arquivo de diagnóstico, mas não foi possível lê-lo."],
} satisfies Record<string, Row>;

export type RemoteLinkDiagnosticsCopyKey = `remoteLinkDiagnostics.${keyof typeof rows}`;

export function remoteLinkDiagnosticsCopy(locale: Locale): Record<RemoteLinkDiagnosticsCopyKey, string> {
  const column = locales.indexOf(locale);
  return Object.fromEntries(
    Object.entries(rows).map(([key, row]) => [`remoteLinkDiagnostics.${key}`, row[column]!]),
  ) as Record<RemoteLinkDiagnosticsCopyKey, string>;
}
