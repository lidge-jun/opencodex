import { copyTable, type Row } from "./copy-table";

/*
 * Copy for the v2 Startup protection, Remote Link and Remote Workspace pages. Columns: en, ko, de, fr, zh, zh-TW, ru, ja, tr, vi, pt.
 * Keys render as `startupV2.<key>`.
 */
const rows = {
  // ---- Startup protection
  about: ["About: {name}", "{name} 설명", "Info: {name}", "À propos : {name}", "说明：{name}", "說明：{name}", "Подробнее: {name}", "説明: {name}", "Hakkında: {name}", "Giới thiệu: {name}", "Sobre: {name}"],
  optionsTitle: [
    "Keep Codex working after a restart",
    "재부팅 후에도 Codex가 동작하게 하기",
    "Codex nach einem Neustart weiter nutzen",
    "Garder Codex opérationnel après un redémarrage",
    "重启后让 Codex 继续可用",
    "重新開機後讓 Codex 繼續可用",
    "Codex продолжит работать после перезагрузки",
    "再起動後も Codex を使えるようにする",
    "Yeniden başlatmadan sonra Codex çalışmaya devam etsin",
    "Giữ Codex hoạt động sau khi khởi động lại",
    "Manter o Codex funcionando após reiniciar",
  ],
  optionsHint: [
    "One healthy option is enough. The background service covers the most ways Codex starts.",
    "정상 작동하는 방법 하나면 충분합니다. 백그라운드 서비스가 Codex의 실행 경로를 가장 넓게 지켜 줍니다.",
    "Eine funktionierende Option reicht. Der Hintergrunddienst deckt die meisten Startwege von Codex ab.",
    "Une seule option en bon état suffit. Le service d’arrière-plan couvre le plus de façons de lancer Codex.",
    "只需一个正常工作的方式。后台服务覆盖的 Codex 启动方式最多。",
    "只需一個正常運作的方式。背景服務涵蓋的 Codex 啟動方式最多。",
    "Достаточно одного исправного способа. Фоновая служба покрывает больше всего способов запуска Codex.",
    "正常に動く方法が一つあれば十分です。バックグラウンドサービスが Codex の起動方法を最も広くカバーします。",
    "Sağlıklı tek bir seçenek yeterli. Arka plan hizmeti, Codex'in en çok başlatılma yolunu kapsar.",
    "Chỉ cần một cách hoạt động tốt. Dịch vụ nền bao quát nhiều cách khởi động Codex nhất.",
    "Uma opção funcionando já basta. O serviço em segundo plano cobre a maioria das formas de iniciar o Codex.",
  ],
  recommended: ["Recommended", "권장", "Empfohlen", "Recommandé", "推荐", "推薦", "Рекомендуется", "推奨", "Önerilen", "Khuyên dùng", "Recomendado"],
  optional: ["Optional", "선택", "Optional", "Facultatif", "可选", "選用", "Необязательно", "任意", "İsteğe bağlı", "Tùy chọn", "Opcional"],
  shimPlain: ["Start with Codex", "Codex와 함께 시작", "Mit Codex starten", "Démarrer avec Codex", "随 Codex 启动", "隨 Codex 啟動", "Запуск вместе с Codex", "Codex と一緒に起動", "Codex ile başlat", "Khởi động cùng Codex", "Iniciar com o Codex"],
  recoveryMeta: [
    "Commands to run yourself",
    "직접 실행하는 명령",
    "Befehle zum selbst Ausführen",
    "Commandes à lancer vous-même",
    "可自行运行的命令",
    "可自行執行的指令",
    "Команды для ручного запуска",
    "自分で実行するコマンド",
    "Kendiniz çalıştıracağınız komutlar",
    "Lệnh để tự chạy",
    "Comandos para você executar",
  ],
  // ---- Remote Link
  off: ["Off", "꺼짐", "Aus", "Désactivé", "关闭", "關閉", "Выкл.", "オフ", "Kapalı", "Tắt", "Desligado"],
  on: ["On", "켜짐", "An", "Activé", "开启", "開啟", "Вкл.", "オン", "Açık", "Bật", "Ligado"],
  linkIntroTitle: [
    "Use one computer's setup on your other computers",
    "한 컴퓨터의 설정을 다른 컴퓨터에서도 쓰기",
    "Die Einrichtung eines Computers auf weiteren Computern nutzen",
    "Utiliser la configuration d’un ordinateur sur vos autres ordinateurs",
    "在其他电脑上使用同一台电脑的设置",
    "在其他電腦上使用同一台電腦的設定",
    "Настройки одного компьютера на других ваших компьютерах",
    "1 台のコンピューターの設定を他のコンピューターでも使う",
    "Bir bilgisayarın kurulumunu diğer bilgisayarlarınızda kullanın",
    "Dùng thiết lập của một máy cho các máy khác",
    "Use a configuração de um computador nos outros",
  ],
  linkIntroBody: [
    "Remote Link connects OpenCodex computers over SSH. The Home shares its providers, and a Child uses them without any setup of its own.",
    "원격 연결은 SSH로 OpenCodex 컴퓨터끼리 연결합니다. 홈이 프로바이더를 나눠 주고, 자식은 따로 설정하지 않고 그대로 씁니다.",
    "Remote Link verbindet OpenCodex-Computer über SSH. Der Home teilt seine Anbieter, ein Child nutzt sie ohne eigene Einrichtung.",
    "Remote Link relie les ordinateurs OpenCodex par SSH. Le Home partage ses fournisseurs, et un Child les utilise sans configuration propre.",
    "远程连接通过 SSH 连接 OpenCodex 电脑。主机共享其提供方，子机无需自行设置即可直接使用。",
    "遠端連線透過 SSH 連接 OpenCodex 電腦。主機分享其提供者，子機無需自行設定即可直接使用。",
    "Remote Link соединяет компьютеры с OpenCodex по SSH. Home делится своими провайдерами, а Child пользуется ими без собственной настройки.",
    "リモート接続は SSH で OpenCodex のコンピューター同士をつなぎます。ホームがプロバイダーを共有し、子はそのまま使えます。",
    "Remote Link, OpenCodex bilgisayarlarını SSH üzerinden bağlar. Home sağlayıcılarını paylaşır, Child bunları kendi kurulumu olmadan kullanır.",
    "Remote Link kết nối các máy OpenCodex qua SSH. Máy Home chia sẻ nhà cung cấp, máy Child dùng lại mà không cần tự thiết lập.",
    "O Remote Link conecta computadores OpenCodex por SSH. O Home compartilha seus provedores e um Child os usa sem configuração própria.",
  ],
  sshTunnel: ["SSH tunnel", "SSH 터널", "SSH-Tunnel", "Tunnel SSH", "SSH 隧道", "SSH 通道", "SSH-туннель", "SSH トンネル", "SSH tüneli", "Đường hầm SSH", "Túnel SSH"],
  stepHost: ["Choose a host", "호스트 선택", "Host wählen", "Choisir un hôte", "选择主机", "選擇主機", "Выбор хоста", "ホストを選ぶ", "Ana bilgisayar seçin", "Chọn máy chủ", "Escolher o host"],
  stepVerify: ["Check the host key", "호스트 키 확인", "Hostschlüssel prüfen", "Vérifier la clé d’hôte", "核对主机密钥", "核對主機金鑰", "Проверка ключа хоста", "ホストキーを確認", "Ana bilgisayar anahtarını doğrulayın", "Kiểm tra khóa máy chủ", "Conferir a chave do host"],
  stepConnect: ["Connect", "연결", "Verbinden", "Connecter", "连接", "連線", "Подключение", "接続", "Bağlan", "Kết nối", "Conectar"],
  steps: ["Steps", "단계", "Schritte", "Étapes", "步骤", "步驟", "Шаги", "手順", "Adımlar", "Các bước", "Etapas"],
} satisfies Record<string, Row>;

export const startupV2Copy = copyTable("startupV2", rows);
