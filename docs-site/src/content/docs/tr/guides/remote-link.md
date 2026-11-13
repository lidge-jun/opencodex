---
title: Uzak Bağlantı
description: OpenCodex Home bilgisayarını bir Child bilgisayarına SSH üzerinden bağlayın.
---

Makine bağlantısı, bir OpenCodex **Home** bilgisayarını bir **Child** bilgisayarına SSH üzerinden bağlar. Home, Child'a SSH tüneli üzerinden hizmet verir; iki bilgisayar da yerel OpenCodex hizmetini `10100` portunda tutar. Kontrol paneli Child'a özel bağlantı anahtarını SSH üzerinden aktarır, bu nedenle bir belirteç yazmanız gerekmez.

## Gereksinimler

- Home bilgisayarı, Child bilgisayarına OpenSSH anahtarıyla giriş yapabilir.
- Child tarafından başlatılan bağlantı için Child, Home bilgisayarına OpenSSH anahtarıyla giriş yapabilmelidir (parola girişi desteklenmez).
- Child bilgisayarında OpenCodex 2.66.0 veya sonrası kuruludur (Child tarafından başlatılan bağlantıda Home üzerinde de).
- Bilgisayarlar macOS, Linux veya Windows x64 kullanabilir. Windows için OpenSSH Server ve Windows PowerShell gerekir; Git Bash ve curl gerekmez.
- Home üzerinden Child ekleyen kontrol paneli Home üzerinde ya da eşleştirilmiş bir Hub oturumunda açılır. Geçerli bilgisayarı Child'a dönüştürmek için operatörün eşleştirdiği bir kontrol paneli oturumu gerekir; kimlik bilgisi olmadan oluşturulan yerel oturum bu yönlendirme değişikliğini onaylayamaz.

Parolalı SSH desteklenmez. Bağlantı Home veya Child üzerinden başlatılabilir. Windows aynı doğrulanmış OpenSSH bağlantısı üzerinden PowerShell çalıştırır.

## `#remote` üzerinden Child ekleme

1. Kontrol panelinde `#remote` sayfasını açın ve Remote Link'i açın.
2. **Home** seçeneğini seçin, ardından **Continue** düğmesine basın. SSH ana bilgisayar listesi açılır.
3. SSH adaylarından bir ana bilgisayar seçin veya SSH yapılandırmasındaki diğer adı girin.
4. Bağlantı testini çalıştırın ve gösterilen ana bilgisayar parmak izini bağlanmak istediğiniz bilgisayarın parmak iziyle karşılaştırın. Karşılaştırma, SSH ana bilgisayara güvenmeden önce yanlış bilgisayarı veya değişmiş anahtarını fark etmenize yardımcı olur.
5. Parmak izini onaylayın, ardından Child'ı bağlayın.

Kontrol paneli belirteç girmenizi istemez. Önce ana bilgisayarı yoklar ve parmak izini açıkça onaylamadan bağlantıyı uygulamaz.

Child ekleme penceresi, Child’ın bu Home’un sağlayıcılarını SSH üzerinden kullandığını ve yukarıdaki gereksinimleri açıklar. Takma adlar, tarayıcıyı gösteren bilgisayardan değil, OpenCodex’i çalıştıran Home üzerindeki `~/.ssh/config` dosyasından gelir. Tarama başarılı olup hiç ana bilgisayar bulunamazsa aşağıdaki gibi bir `Host` girdisi ekleyip yeniden tarayın. Mevcut bir takma adı elle de girebilirsiniz; seçim veya giriş bağlantı testini etkinleştirir. Pencerede bu kılavuza bağlantı bulunur.

```sshconfig
Host devbox
  HostName devbox.example.com
  User you
  IdentityFile ~/.ssh/id_ed25519
```

Tarama başarısız olursa boş liste yerine yükleme hatası, mevcut neden ve yeniden deneme eylemi gösterilir. Bağlantı testinin nedeni ve temizlenmiş SSH ipucu yalnızca etkin pencerede görünür, arkasında yinelenmez. Nedeni ve gerektiğinde aşağıdaki SSH tanılamasını kontrol edip yeniden deneyin. Yeniden tarama girilen takma adı korur ancak bağlantıdan önce parmak izinin yeniden incelenmesini gerektirir.

## Bu bilgisayarı Child olarak bağlama

Home'un sağlayıcılarını kullanacak bilgisayarda:

1. Kontrol panelinde `#remote` sayfasını açın ve Remote Link'i açın.
2. **Child** seçeneğini seçin. SSH ana bilgisayar listesi açılır.
3. Home'un SSH ana bilgisayarını seçin, bağlantı testini çalıştırın, ardından ana bilgisayar parmak izini karşılaştırıp onaylayın.
4. Uyarıyı okuyun ve **Connect as Child** seçeneğini seçin.

Bağlanmak bu bilgisayardaki OpenCodex'i yeniden başlatır. Zaten çalışan Codex istekleri önce tamamlanır ve yeniden başlatma sırasında yeni istekler bir dakikaya kadar başarısız olabilir. Ardından kontrol paneli kendiliğinden yeniden yüklenir ve Child bağlantısını gösterir. Codex bu bilgisayarda `http://127.0.0.1:<port>/v1` adresini kullanmaya devam eder ve belirteç veya ortam değişkeni ayarlamanız gerekmez: yerel OpenCodex her isteği Home'a aktarır, Home da kendi sağlayıcıları ve hesaplarıyla yanıt verir.

**Child** önce bu bilgisayarı eşleştirmenizi istiyorsa bu bilgisayarın yapılandırılmış HTTP geri döngü IP adresindeki kontrol panelini açın; örneğin `http://127.0.0.1:<configured-port>`. Yerel eşleştirme formu yalnızca eşleştirme eksik olduğunda ve kontrol paneli ile API aynı geri döngü kaynağını kullandığında görünür. Formdaki `ocx gui pair --origin "http://127.0.0.1:<configured-port>"` komutunu kopyalayıp bu bilgisayarın terminalinde çalıştırın, ardından tek kullanımlık kodu forma yapıştırın. Formda gösterilen kaynak adresini aynen kullanın; sağlayıcı API anahtarı veya yönetici belirteci eşleştirme kodu değildir. Eksik eşleştirme ile yapılandırılmış bağlantı noktası uyuşmazlığı farklı nedenlerdir.

**Child** rolü ayrıca OpenCodex'in bağımsız çalışma modunda, yapılandırılmış bağlantı noktasında çalışmasını gerektirir, çünkü Child tam olarak o bağlantı noktasında yeniden başlar. Kontrol paneli OpenCodex'in yapılandırılmış bağlantı noktasında çalışmadığını söylerse önce onu o bağlantı noktasında yeniden başlatın.

## Bağlantı durumu

- **Connected**, SSH tünelinin hazır ve Child'ın Home bağlantısını kullanabilir olduğu anlamına gelir.
- **Reconnecting**, tünelin yeniden denendiği anlamına gelir. Yeniden deneme sırasında istekler geçici olarak `Retry-After` ile birlikte `503` döndürebilir. Kendi panosundan bağlanan bir Child üzerinde istek önce tünelin geri gelmesi için en fazla 15 saniye bekler.
- **Failed**, bağlantının ilgilenilmesi gerektiği anlamına gelir. SSH kimlik doğrulamasını, onaylanan ana bilgisayar anahtarını, yönlendirmeyi veya zaman aşımı nedenini kontrol edin. SSH tünelini açan taraf (eklediği Child için Home, kendi panosundan katıldığı bağlantı için Child); uyku, kesinti veya yeniden başlatmadan sonra kendiliğinden yeniden dener: zaman aşımı veya yönlendirme hatasından sonra bir dakika sonra, ardından her yeni başarısızlıkta bekleme ikiye katlanarak en fazla beş dakikada bir; kimlik doğrulama hatasından sonra beş dakikada bir. Değişmiş bir ana bilgisayar anahtarı asla yeniden denenmez. Hemen yeniden denemek için Home panosunda **Retry** düğmesini seçin veya Home üzerinde `ocx link reconnect --link-id <id>` komutunu çalıştırın. Bu, OpenCodex'i yeniden başlatmadan yalnızca o bağlantının tünelini yeniden başlatır.

Bağlantı başarısız olduğunda sistem sessizce yerel bir sağlayıcıya geçmez.

## Child'ı kaldırma

Child için **Disconnect** seçeneğini seçin ve diğer adı onaylayın. Home tüneli durdurur, Child'ın bağlantı anahtarını iptal eder ve kayıtlı bağlantı kaydını kaldırır.

Home, bağlantıyı kesme komutunu çalıştırmak için Child'a ulaşamıyorsa **Remove here only** seçeneğini seçin. Bu işlem yalnızca bu bilgisayardaki tüneli, anahtarı ve kaydı kaldırır. Ardından Child'a giriş yapıp şunu çalıştırın:

```bash
ocx disconnect
```

Child tarafından başlatılan bağlantıyı kesmek için Child üzerinde `ocx disconnect` komutunu çalıştırın. Komut istemci tünelinin bağlantısını keser ve SSH üzerinden Home üzerindeki bağlantıyı iptal eder. Home üzerindeki iptal başarısız olursa şu mesajı yazdırır: `Home revoke failed; run ocx link revoke --link-id <linkId> on the home.`

## Güvenlik

Child, bağlantı üzerinden Home bilgisayarının sağlayıcılarını ve sağlayıcı kimlik bilgilerini kullanır. Home her Child için ayrı bir bağlantı anahtarı oluşturur; bağlantıyı kaldırmak bu anahtarı iptal eder. Onaylamadan önce ana bilgisayar parmak izini karşılaştırarak yanlış bilgisayarı veya değiştirilmiş anahtarı kabul etmediğinizden emin olun. Tailscale kimliğiyle verilen kontrol paneli oturumları makine bağlantılarını yönetemez. Child üzerinde anahtar OpenCodex içinde kalır: Codex veya Claude Code'un Child üzerinde gönderdiği kimlik bilgileri Home'a iletilmez ve Child üzerinde `127.0.0.1:<port>` adresine ulaşan her program Home'u anahtarsız kullanır; bu, bağımsız bir kurulumun yerel programlara verdiği güvenle aynıdır. Başka sitelerden gelen web sayfaları reddedilir.

## CLI başvurusu

```text
ocx link probe <alias> [--json]
ocx link add <alias> [--expect-fingerprint SHA256:…] [--json]
ocx link port [--json]
ocx link issue --alias <alias> --tunnel-port <port> [--json]
ocx link status [--json]
ocx link revoke --link-id <id> [--json]
ocx link reconnect --link-id <id> [--json]
ocx link check (--link-id <id> | --all) [--no-wait] [--json]
ocx link update (--link-id <id> | --all) --yes [--no-wait] [--json]
ocx link sync (--link-id <id> | --all) [--no-wait] [--json]
ocx link sync --link-id <id> (--restart-app-server-only | --restart-codex --yes) [--no-wait] [--json]
ocx link restart-codex --link-id <id> [--scope app-server|codex] --yes [--no-wait] [--json]
```

TTY olmayan kullanımda `--expect-fingerprint` zorunludur. Etkileşimli bir terminalde sunulan parmak izini açıkça onaylayarak bu seçeneği atlayabilirsiniz.

Home üzerinde `ocx link check (--link-id <id> | --all)`, Home'un eklediği her Child için kurulu sürümü, kurulum türünü ve güncelleme yolunu okur: bağlantının SSH oturumu üzerinden Child'ın `ocx update --plan` komutunu çalıştırır (Child başına 60 saniye, aynı anda üç tane); bu komut yalnızca bir plan hesaplar, hiçbir şeyi değiştirmez. 2.97.0'dan eski bir Child `owner-action` (`legacy-ocx`) olarak görünür; sürümü macOS ve Linux'ta salt okunur bir SSH çağrısıyla daha, Windows'ta ise bağlantı üzerinden bildirdiği sürümden alınır. Child tarafından başlatılan bağlantılar ve `ocx-child` Child'ları SSH olmadan raporlanır. `ocx link status --json` her satıra bir `child` bloğu (sürümler, sürüm farkı, katalog güncelliği, etkinlik, son işlem) ekler. Ayrıntılar ve çıkış kodları: [Child install, catalog and activity](/guides/remote-link/#child-install-catalog-and-activity) (İngilizce).

### Child'ları Home'dan yönetmek

`ocx link sync`, `ocx link restart-codex` ve `ocx link update`, Home'un eklediği Child'larda bağlantının SSH bağlantısı üzerinden çalışır ve işi JSON olarak yazdırır. `sync`, sabitlenmiş `ocx sync --expect-link` komutunu çalıştırır (Child 2.93.0 veya üstü). `restart-codex` önce eşitler, ardından çalışan Codex'in güncel kataloğu yüklemesi için Child'daki Codex app-server süreçlerini yeniden başlatır; `--scope codex` masaüstü uygulamasını da yeniden açar. Yeniden başlatma tek bir bağlantıyı hedefler; `restart-codex` ve `--restart-codex` için `--yes` gerekir, `ocx link sync --link-id <id> --restart-app-server-only` ise app-server süreçlerini onay istemeden yeniden başlatır. Home o Child için bir model isteği aktarırken yeniden başlatma atlanır (`restart-skipped:link-active`). 2.69'dan eski bir Child'da akış olmayan bir istek ancak yanıtı başladığında görülür. `update --yes`, Child'ın kendi güncelleyicisiyle Child'ın OpenCodex sürümünü bu Home'un sürümüne getirir, asla başka bir sürüme değil (Child 2.97.0 veya üstü; npm ve pnpm kurulumları Node başlatıcısı üzerinden güncellenir, bu yüzden `ocx link check` orada salt okunur `node --version` da çalıştırır). Her seferinde bir Child güncellenir; başarılı, başarısız veya geri alınmış bir uygulamadan sonra yeniden eşitlenir. Sonucu bilinmeyen bir uygulama tekrarlanmaz ve eşitlenmez; `ocx link check` ile denetleyin. O Child için aktarılan istekler sona erer. Windows Child'ları yalnızca `sync` destekler; `ocx-child` Child'ları yeniden başlatmayı ve güncellemeyi desteklenmiyor olarak bildirir. CLI, loopback'e bağlı bir Home gerektirir; başka bir Home'da bu işlemler kullanılamaz ve panonun Remote Link sayfası Home'un eklediği Child için aynı işlemleri sunar. Ayrıntılar ve çıkış kodları: [Operating Children from the Home](/guides/remote-link/#operating-children-from-the-home) (İngilizce). Bu koruma en iyi çaba esaslıdır: kontrol ile yeniden başlatma arasında başlayan bir istek yine de sonlandırılabilir; turların korunması gerekiyorsa o Child'da yeni istekleri duraklatın. Home ayrıca Codex'in model isteği yerine bir araç çalıştıran bir turun ortasında olup olmadığını bilemez; bu yüzden o Child'da Codex'i yeniden başlatmadan veya OpenCodex'i güncellemeden önce etkin Codex turlarının bitmesini bekleyin. Elle güncelleme o Child'ın OpenCodex'ini yeniden başlatır ve onun için hâlâ aktarılan her turu sona erdirir; otomatik güncellemeler Child boşta olana kadar bekler. `ocx sync --restart-children` (veya `--restart-children=codex --yes`), bir Home eşitlemesi dağıtılırken aynı kuralı tüm Child'lara ya da `--child <linkId>` ile belirtilenlere uygular: her Child eşitlenir ve aktarılan bir istek sürerken yalnızca yeniden başlatması atlanır (`restart-skipped:link-active`).

### Child sürümleri ve işlemleri

Home üzerinde her Remote Link satırı, Home'un o Child hakkında son öğrendiğini taşır; Home'un başlattığı bir satır ayrıca onun denetimlerini taşır. Rozetler şunları gösterir:

- Child'ın sürümü ve yanında `Behind Home (<home version>)`, `Same version as Home` veya `Newer than Home`, ayrıca güncelleme uygulanabiliyorsa `Update available: <home version>`. Kendi panosundan başlatılan bir Child sürümünü sürüm farkı rozeti olmadan gösterir ve `ocx-child` bir Child her zaman `unknown` okur.
- kurulum türü (`Desktop app`, `GOAT`, `Source checkout`) veya bu sürüm adlandırmıyorsa ham belirteç eş aralıklı yazıyla.
- `Catalog current` veya `Catalog out of date`. `Codex restart needed (<n>)` ve `Codex not running` rozetleri ancak Child kendi Codex durumunu bildirdikten sonra görünür; bu bildirimi daha sonraki bir sürüm ekleyecek. Henüz bunu gönderen bir Child sürümü olmadığı için bu iki rozet bugün görünmez.
- son işlemi `Last <operation>: <state>` olarak, nedeni eş aralıklı yazıyla; bir iş bağlantıyı tutarken de çalışanı.

Home o Child'ı kendisi güncelleyemediğinde satır bunun yerine ne yapılacağını söyler: o Child'daki OpenCodex Desktop'ta Check for Updates kullanın, elle güncelleyin, `mise` üzerinden güncelleyin veya GOAT yapsın. Bilinmeyen bir neden tahmin edilmiş bir cümle yerine belirteç olarak yazılır.

Dört işlem CLI ile aynı işi başlatır, bu yüzden Child'da aynı sürümlere ihtiyaç duyar:

- **Check**, `ocx link check` gibi Child'ın kurulum bilgilerini okur.
- **Sync now**, `ocx link sync` gibi sabitlenmiş `ocx sync --expect-link` komutunu orada çalıştırır.
- **Restart Codex** bir kapsam seçimi açar. `Codex app-servers` Child'ın arka plan app-server süreçlerini yeniden başlatır, böylece güncel kataloğu yükler; Codex masaüstü uygulamasının kendi app-server'ını yenilemez, bunun için masaüstü uygulamasını yeniden başlatın. `Codex desktop app` masaüstü uygulamasını da kapatıp yeniden açar; bu, orada açık konuşmaları sona erdirir.
- **Update**, `ocx link update` gibi Child'ın kendi güncelleyicisiyle Child'ın OpenCodex'ini bu Home'un sürümüne getirir. Onay, Child'ın OpenCodex'inin yeniden başlayacağını ve onun için hâlâ aktarılan her turun sona ereceğini, otomatik güncellemelerin ise Child boşta olana kadar beklediğini söyler.

**Check all** ve **Update all** uygun tüm Home başlatmalı bağlantılara uygulanır; Update all yine de her seferinde bir Child çalıştırır ve asla başka bir sürümü hedeflemez. Çalışan bir iş, Child başına bir satırda durumunu, geçtiği sürümü (öncesi ve sonrası), katalog eşitleme sonucunu ve yeniden başlatma sonucunu gösterir. İş bitince panel kaybolur ve satırlar yenilenir; Home'un artık bilmediği bir iş (Home yeniden başladığı için) bunu söyler ve her satırın kendi durumu yanıt olur. Bir iş bir bağlantıyı tutarken o bağlantının işlemleri ve Disconnect devre dışıdır; sunucu isteği zaten reddeder.

Listenin altındaki **Child automation** paneli, `ocx link policy` ile aynı politika dosyasını gösterir ve düzenler: katalog dağıtımı (varsayılan otomatik), Codex yeniden başlatma (varsayılan asla), güncellemeler (varsayılan boştayken otomatik, bu sürümde henüz etkin değil) ve boşta kalma süresi. Kaydetme yalnızca değiştirdiklerinizi yazar. Politika dosyası bozulmuşsa panel otomatik katalog dağıtımının ve otomatik güncellemelerin kapalı olduğunu söyler ve kaydetme o durumda tüm ayarları yazar, böylece seçtiğiniz modlar kalıcı olur. Bu denetimler sunucuyu asla atlamaz: sunucu her işte politikayı, bağlantı durumunu ve Child'ın etkinliğini yeniden denetler.

Sahibi olmadığınız bir makineyi bağlamayın: Home orada komutları sizin SSH anahtarınızla çalıştırır.

### Otomatik katalog dağıtımı ve Child politikası

Katalog dağıtımı varsayılan olarak açıktır. Home'un kataloğu değiştiğinde (katalog otomatik yenilemesi bir değişiklik bildirdiğinde ya da 5 dakikada bir yapılan kontrol panelde veya yönetim API'sinde yapılan bir düzenlemeyi fark ettiğinde) Home, düzenlemelerin durulması için 60 saniye bekler (ilk değişiklikten en fazla 5 dakika sonra). Ardından sizden hiçbir işlem beklemeden her uygun Child'a arka planda bir SSH oturumu açar ve `ocx link sync` ile aynı sabitlenmiş `ocx sync --expect-link` komutunu çalıştırır; siz etkinleştirmedikçe Codex'i yeniden başlatmaz (aşağıdaki `childCodexRestart`). Uygun Child; bağlantısını Home'un başlattığı, tüneli bağlı olan, üzerinde başka işlem çalışmayan ve bu Home'un orada çalıştırdığı son eşitlemesi değişiklikten önce olan Child'dır. Kataloğu yalnızca indirmiş bir Child hâlâ geride sayılır. Model isteklerini aktaran bir Child, yalnızca Codex ayarları zaten Home ile aynıysa ve OpenCodex istemci çalışma zamanı bu ayarlar uygulandıktan sonra yeniden başlamışsa eşitlenir, çünkü aksi hâlde eşitleme o çalışma zamanını yeniden başlatır; aksi hâlde boşta kaldığında eşitlenir. Başarısız bir eşitleme 5 dakika sonra yeniden denenir, aralık 6 saate kadar ikiye katlanır; 2.93.0'dan eski bir Child başka bir sürüm bildirene kadar yeniden denenmez. Bu işler diğer işler gibi görünür ve `trigger: "auto"` taşır. Bağlantısı olmayan bir Home bunların hiçbirini çalıştırmaz.

Dağıtım, Child'ın katalog dosyasını düzeltir. Child'da zaten çalışan bir Codex app-server, yeniden başlayana kadar yüklediği listeyi kullanır: `ocx link restart-codex --link-id <id> --yes` veya `ocx sync --restart-children` kullanın ya da `ocx link policy --child-codex-restart app-server-when-idle` ile app-server'ları Home'un yeniden başlatmasına izin verin; Home bunu yalnızca eşitleme çalıştığında hâlâ boşta olan bir Child'da yapar. Bu ayar bir sonraki otomatik eşitlemeden itibaren geçerlidir; kataloğu zaten güncel olan bir Child eşitlenmez, dolayısıyla yeniden başlatılmaz; o Child'ı kendiniz yeniden başlatın.

Politika Home'da `<configDir>/link/child-policy.json` içinde tutulur, asla `config.json` içinde değil:

| Ayar | Varsayılan | Değerler |
|---|---|---|
| `catalogFanout` | `auto` | `auto`, `manual` |
| `childCodexRestart` | `never` | `never`, `app-server-when-idle` |
| `updates` | `auto-when-idle` | `off`, `notify`, `auto-when-idle` |
| `idleAfterMs` | `600000` (10 dakika) | 1 ile 60 dakika arası |

`updates` varsayılan olarak boştaki Child'ları otomatik olarak Home'un sürümünde tutar. Otomatik güncellemeler bu sürümde henüz etkin değildir; ayar şimdiden kaydedilir, böylece `ocx link policy --updates notify` veya `--updates off` ile yapılan bir vazgeçme, güncellemeler geldiğinde de geçerli kalır. `idleAfterMs`, bir Child'ın boşta sayılması için aktarılan model isteği olmadan geçmesi gereken süredir; `ocx link status` içindeki `activity.idle` değerini de belirler.

```text
ocx link policy                                    # politikayı oku
ocx link policy --catalog-fanout manual            # otomatik katalog dağıtımını kapat
ocx link policy --child-codex-restart app-server-when-idle
ocx link policy --updates off --idle-after-minutes 20 --json
```

`GET` ve `PUT /api/link/children/policy` aynı ayarları okur ve değiştirir (loopback üzerinde yönetici belirteci veya bir panel oturumu); bir `PUT` yalnızca değiştirdiği ayarları gönderir. Dosya bozuksa veya bilinmeyen bir değer içeriyorsa, otomatik katalog dağıtımı ve güncellemeler kapalı kalır ve `ocx link policy` bunu bildirir. Kaydetmek uyarıyı temizler ama adını vermediğiniz her ayarı kapalı bırakır; bunları açıkça açın, örneğin `ocx link policy --catalog-fanout auto --updates auto-when-idle`. Home dosyayı kendiliğinden asla yeniden yazmaz.

Size ait olmayan bir makineyi bağlamayın: Home orada sizin SSH anahtarınızla komut çalıştırır.

## İlgili kılavuzlar

- [Remote Hub Dağıtımı](/tr/guides/remote-hub/)
- [Uzak Çalışma Alanı](/tr/guides/remote-workspace/)


`ocx link probe <alias> --json` · `ocx link add <alias> --expect-fingerprint SHA256:… --json` — [CLI, restart, relay verification and recovery](/guides/remote-link/#add-a-child-from-the-terminal).
