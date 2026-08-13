---
title: CLI Yaşam Döngüsü
description: Kurulum, başlatma, durdurma, servis, tanılama, senkronizasyon ve güncelleme komutları.
---

Bu komutlar, yerel opencodex proxy'sini ve Codex entegrasyonunu kurar,
çalıştırır, inceler, onarır ve günceller.

## Kurulum

### `ocx init` · `ocx setup`

Etkileşimli kurulum sihirbazı (`setup`, `init`'in bir takma adıdır). Bir
sağlayıcı (önayar veya özel), API anahtarı (değişmez veya `${ENV}`), varsayılan
model ve proxy portu sorar; `~/.opencodex/config.json` dosyasını kaydeder;
isteğe bağlı olarak proxy'yi `$CODEX_HOME/config.toml` (varsayılan
`~/.codex/config.toml`) içine enjekte eder; ve isteğe bağlı olarak Codex
otomatik başlatma dolgusunu kurar.

## Proxy yaşam döngüsü

### `ocx start [--port <port>]`

Proxy sunucusunu başlatın (tercih edilen port `10100`). Bu port doluysa
opencodex başka bir kullanılabilir port seçer ve kaydeder. PID/çalışma zamanı
portu durumunu yazar ve ikinci bir canlı örneği başlatmayı reddeder. Başlangıçta
her sağlayıcının modellerini Codex'in kataloğuna senkronize eder. Kapatıldığında
— yönetilen bir servis olarak başlatılmadığı sürece (`OCX_SERVICE=1`) — yerel
Codex'i geri yükler.

```bash
ocx start
ocx start --port 8080
```

### `ocx stop`

Çalışan proxy'yi (PID'ye göre) durdurun, PID dosyasını kaldırın ve yerel Codex'i
geri yükleyin. Yönetilen bir arka plan servisi kuruluysa `ocx stop` proxy'yi
yeniden oluşturamaması için önce onu da durdurur. Aynı eylem web kontrol
panelinin **Durdur** düğmesinden de (`POST /api/stop`) kullanılabilir.

### `ocx restart`

Bir proxy çalışırken bu tam onaylanmış PID ve porttan yerinde yeniden
başlatmasını isteyin, normal boşaltmasını bekleyin ve aynı portta farklı bir
çalışma zamanı PID'sini doğrulayın. Yönetilen yönlendirme ve servis denetimi
boyunca kurulu kalır; belirsiz bir istek ayrı bir durdurma/başlatma olarak
yeniden oynatılmak yerine gözlemlenir. Hiçbir proxy çalışmıyorsa komut normal
`ensure` başlangıcına geri döner. Canlı bir dinleyici bir çalışma zamanı
PID'sine (güncelleme öncesi proxy dahil) onaylanamazsa yeniden başlatma bir
`ensure` veya durdurma/başlatma geri dönüşü olmadan kapalı olarak başarısız
olur. Sahipliği onayladıktan sonra bağımsız bir proxy için `ocx stop` ardından
`ocx start` kullanın. Servis tarafından yönetilen bir proxy için denetimin geri
yüklenmesi amacıyla `ocx stop` ardından `ocx service start` kullanın.

### `ocx ensure`

Bir arka plan proxy'sinin çalıştığından eşgüçlü olarak (idempotently) emin olun,
ardından canlı model kataloğunu senkronize edin. `codexAutoStart` `false` ise
otomatik başlatmanın devre dışı bırakıldığını yazdırır ve hiçbir şey yapmaz.

### `ocx restore [back]` · `ocx eject [back]`

Proxy'yi **durdurmadan** yerel Codex'i geri yükleyin — enjekte edilen
yapılandırma satırlarını ve yönlendirilen katalog girdilerini kaldırır, böylece
düz `codex` tekrar yerel olarak çalışır. `eject`, `restore`'un bir takma adıdır.

Proxy yaşam döngüsünü değiştirmeden düz `codex`'i zaten çalışan bir proxy'ye
yeniden yönlendirmek için her iki yazıma da `back` iletin:

```bash
ocx restore back
ocx eject back
```

### `ocx recover-history --legacy-openai`

Tersine çevrilebilir yedekleme desteği var olmadan önce Codex App geçmişini
yeniden eşleyen eski geliştirme derlemeleri için açık kurtarma. Geçmiş
veritabanı kilitliyse önce Codex'i kapatın.

### `ocx uninstall` · `ocx remove`

Servisi ve proxy'yi durdurun, servisi ve Codex dolgusunu kaldırın, yerel Codex'i
geri yükleyin, ardından yalnızca tüm geri yükleme adımları başarılı olduysa
opencodex yerel yapılandırmasını kaldırın. `remove`, `uninstall`'ın bir takma
adıdır. Yapılandırma temizliği yeni bir yükleme tarafından oluşturulan sahiplik
meta verilerini gerektirir; eski veya paylaşılan dizinler yerinde bırakılır.

## Durum ve sağlık

### `ocx status [--json]`

Salt okunur bir tanılama özeti yazdırın: proxy PID, `/healthz` erişilebilirliği,
kontrol paneli URL'si, yapılandırma yolu, varsayılan sağlayıcı, Codex otomatik
başlatma ayarı, servis durumu, dolgu durumu ve maskelenmiş etkin Codex konumu.
Yalnızca açık, yüksek güvenilirlikli Windows Orca çalışma zamanı ana dizini
imzası eyleme geçirilebilir bir Uygulama-ana dizini uyumsuzluğu uyarısı ekler;
asla `CODEX_HOME`'u otomatik olarak değiştirmez.

İnsan çıktısı ayrıca OAuth girişleri özetinden sonra bir **OAuth sağlığı** bloğu
içerir: bilinen her hesap sağlıklı olduğunda `OAuth health: ok` veya sağlıklı
olmayan hesap başına (sağlayıcı, maskelenmiş hesap kimliği, yeniden kimlik
doğrulama gereksinimi, hız veya kota sınırlaması veya yenileme çakışması gibi
durum) artı isteğe bağlı bir `Action:` ipucu ile maskelenmiş bir satır içeren
`OAuth health: warning`. Hesap kimlikleri maskelenir; belirteçler ve e-postalar
asla yazdırılmaz. `--json` sözleşmesi şu anda bu sağlık bloğunu içermez.

```bash
ocx status
ocx status --json
```

Kısaltılmış örnek şekli:

```json
{
  "schemaVersion": 1,
  "proxy": {
    "running": false,
    "pid": null,
    "health": {
      "ok": false,
      "url": "http://127.0.0.1:10100/healthz",
      "message": "unreachable"
    }
  },
  "dashboard": {
    "url": "http://localhost:10100/"
  },
  "paths": {
    "config": "/Users/example/.opencodex/config.json",
    "pid": "/Users/example/.opencodex/ocx.pid",
    "runtime": "/path/to/bun"
  },
  "runtime": {
    "source": "bundled"
  },
  "codexHome": {
    "effectiveCodexHome": "C:\\Users\\[USER]\\.codex",
    "appCodexHome": "C:\\Users\\[USER]\\.codex",
    "mismatch": false,
    "warning": null,
    "action": null
  },
  "codexAutostart": true,
  "defaultProvider": "openai",
  "service": {
    "summary": "not installed (logs: /Users/example/.opencodex/service.log)"
  },
  "codexShim": {
    "summary": "Codex autostart shim: not installed"
  }
}
```

Gerçek nesne ayrıca `listen` (port, ana bilgisayar adı, çalışma
zamanı/yapılandırma kaynağı), yapılandırma yükleme tanılamalarını ve paketlenmiş
Codex eklenti tanılamalarını içerir. JSON şeması yalnızca eklemelidir:
gelecekteki sürümler alanlar ekleyebilir, ancak mevcut alanlar kararlı
kalmalıdır. API anahtarlarını, OAuth belirteçlerini, yetkilendirme başlıklarını,
istek içeriğini, e-postaları ve hesap kimliklerini kasıtlı olarak hariç tutar.

### `ocx health [--json]`

Canlı proxy'yi kimlik kontrolünden geçirin. İnsan çıktısı PID/port bildirir;
`--json`, `{ok, pid, port}` yayar. Komut yalnızca sağlıklı olduğunda 0 ve aksi
takdirde 1 ile çıkar, bu da onu servis probları için uygun hale getirir.

### `ocx ready [--json] [--wait [--timeout <seconds>]]`

Kimliği doğrulanmamış `GET /readyz` uç noktası aracılığıyla senkronizasyon
sonrası hazırlığı kontrol edin. Hazır olduğunda `200` veya `pending` ve terminal
`failed` için `Retry-After: 1` ile `503` döndürür. Temizlenmiş HTTP kimliği
`{service, version, uptime, pid, port, status}` şeklindedir. `/readyz` içermeyen
eski proxy'ler `unreachable` olarak kapalı başarısız olur; `/healthz` hazırlık
değil, ayrı bir canlılıktır. Komut varsayılan olarak bir prob gerçekleştirir;
`--wait`, hazır olana veya zaman aşımına kadar yoklar, ancak terminal `failed`
durumunu gözlemlediğinde hemen çıkar. Varsayılan zaman aşımı 45 saniyedir;
`--timeout <seconds>` `--wait` gerektirir ve 1–300 arası pozitif tamsayı
saniyeleri kabul eder. CLI JSON, `status`'un `ready`, `pending`, `failed` veya
`unreachable` olduğu `{ready, status, pid, port}` yayar. Çıkış kodları hazır
için 0; hazır değil, beklemede, başarısız, zaman aşımı veya erişilemez için 1;
ve geçersiz bağımsız değişkenler için 64'tür.

### `ocx doctor`

Salt okunur ortam ve bağlantı tanılamalarını çalıştırın: durum yolları ve dosya
sistemi türü, WSL ikili yüklemeleri, proxy ortamı/yapılandırması, ChatGPT
erişilebilirliği, Codex eklentisi ve proje yapılandırması uyarıları ve bekleyen
geçmiş geçişi. Codex app-home hedefleme bölümü ayrıca dar Windows Orca çalışma
zamanı ana dizini uyumsuzluğunu algılar ve geçerli olduğunda servis geçişini
açıklar. Bu tanılama tarafından gösterilen yollar işletim sistemi kullanıcı
adını maskeler. Doctor onarım ipuçları yazdırır ancak bunları uygulamaz.

**OAuth güvenilirliği** bölümü kimlik bilgisi depolama alanının yazılabilir olup
olmadığını, `OPENCODEX_HOME` altında yenileme tek uçuş/kilit dosyalarının
oluşturulup oluşturulamayacağını, bir kurtarma `Action:` ile sağlıklı olmayan
OAuth veya Codex havuz hesaplarını (maskelenmiş kimlikler) ve Codex iletme
yolunun resmi istemci meta verileri üretmediğine dair statik bir OK bildirir.
Doctor asla kimlik bilgilerini değiştirmez veya onarımlar uygulamaz.

## Katalog senkronizasyonu

### `ocx sync [--restart-codex]`

Yapılandırılmış her sağlayıcıdan canlı model listesini alın ve birleştirilmiş
kataloğu Codex'e yeniden enjekte edin. Bir sağlayıcı ekledikten sonra veya
kullanılabilir modelleri yenilemek için çalıştırın.

Sağlayıcı keşfinden veya katalog/önbellek değiştirmeden önce `ocx sync`,
yönetilen Codex yapılandırmasının enjekte edilip edilemeyeceğini doğrular. Bu
doğrulama yapılandırmayı reddederse komut sıfır olmayan bir çıkış yapar, somut
nedeni stderr'e yazdırır ve mevcut kataloğu ve önbelleği değiştirmeden bırakır.
`ocx restore back`, yönlendirmeyi yeniden etkinleştirmeden önce aynı yazmasız ön
kontrolü kullanır.

Uzun ömürlü Codex `app-server` süreçleri hala çalışıyorsa `ocx sync`,
`opencodex-catalog.json` / `models_cache.json` güncellenmiş olsa bile önceki
bellek içi model listesini sunmaya devam edebilecekleri konusunda uyarır.
Yalnızca geçerli kullanıcıya ait eşleşen `codex … app-server` ve
`codex-code-mode-host` süreçlerine `SIGTERM` göndermek için `--restart-codex`
iletin (aktif turlar kesintiye uğrayabilir). Geniş `pkill -f codex`
eşleştirmesinden kasıtlı olarak kaçınılır.

### `ocx sync-cache [--restart-codex]`

Codex'in yerel model seçici önbelleğini geçersiz kılın, böylece aktif opencodex
kataloğundan yeniden oluşturulur. `ocx sync` ile aynı eski `app-server` uyarısı
ve isteğe bağlı `--restart-codex` davranışı geçerlidir.

## Arka plan servisi

### `ocx service [install|repair|start|stop|status|uninstall|remove]`

opencodex'i oturum açmada otomatik başlayan ve çökmede otomatik yeniden başlayan
oturumla yönetilen bir arka plan servisi (macOS **launchd**, Linux **systemd
kullanıcı birimi**, Windows **Görev Zamanlayıcı**) olarak çalıştırın. Servis
çalıştırmaları `OCX_SERVICE=1` ayarlar, böylece bir yeniden başlatma Codex
yapılandırmasını dalgalandırmaz.

| Alt komut | Eylem |
| --- | --- |
| none | Servisi oluşturun/güncelleyin ve başlatın. |
| `install` | Servisi oluşturun ve başlatın. Kaydeder, bu da Windows'ta yükseltme gerektirir. |
| `repair` | Kurulu bir servisi yerinde yenileyin ve yeniden kaydetmeden yeniden başlatın. |
| `start` | Kurulu bir servisi başlatın. |
| `stop` | Servisi durdurun ve yerel Codex'i geri yükleyin. |
| `status` | Servis ve proxy tanılamalarını artı günlük yollarını bildirin. |
| `uninstall` | Servisi kaldırın ve yerel Codex'i geri yükleyin. |
| `remove` | `uninstall`'ın takma adıdır. |

```bash
ocx service
ocx service install
ocx service repair
ocx service status
ocx service uninstall
```

`install`, `start` ve `repair`, başarı bildirmeden önce kurulu servise
yerleştirilmiş portta bir proxy'nin gerçekten yanıt verdiğini onaylar — her üç
platformda da. 20 saniyeye kadar beklerler ve ardından sunulan portu
yazdırırlar:

```
✅ opencodex service installed and serving on port 10100.
```

Hiçbir şey yanıt vermezse uyarırlar ve **sıfır olmayan bir çıkış yaparlar**:

```
⚠️  Service installed, but no proxy answered on port 10100 within 20s.
   The manager registered the job; that is not the same as serving.
   Log:       ~/.opencodex/service.log
   Meanwhile: ocx start   (serves in the foreground)
```

Burada sıfır olmayan bir çıkış, *kurulu değil* değil, *kayıtlı ancak hizmet
vermiyor* anlamına gelir. Servis yöneticisi işi kabul etti; arkasındaki proxy
asla portu bağlamadı. Mesajda adı geçen günlüğü okuyun ve bu arada ön planda
hizmet vermek için `ocx start` kullanın.

`ocx service status` ham yönetici çıktısı yerine aynı üç durumu bildirir:

```
✅ installed and loaded (launchd; logs: …)
   Serving on port 10100.
```

```
⚠️  installed and loaded (launchd; logs: …)
   Registered, but no proxy is answering on port 10100.
   launchd is running an OLDER plist than the one on disk.
   Fix:    launchctl bootout gui/$(id -u)/com.opencodex.proxy && ocx service repair
   Log:    ~/.opencodex/service.log
   Repair: ocx service repair
   Meanwhile: ocx start           (serves in the foreground)
```

Artık hizmet veriyor, hiçbir şeye bağlı değil veya önceki bir tanımı
çalıştırıyor olsa da kayıtlı bir işi aynı şekilde bildiren ham `launchctl list`
/ `systemctl status` satırını yazdırmaz. `Diagnostics:` satırı hala günlük
yolunu ve herhangi bir eski yerleşik yol bulgusunu taşır.

Windows'ta zamanlayıcı arka ucu Görev Zamanlayıcı kaydını proxy
erişilebilirliğinden ayrı olarak bildiren kendi daha zengin durum çıktısını
tutar.

macOS'ta bu daha ince bir arızayı da kapsar: `launchctl load` 0 ile çıkarken
stderr'de arıza bildirir, bu nedenle tutmayan bir yükleme komut bir onay işareti
yazdırırken launchd'nin servis tanımının **önceki** bir sürümünü çalıştırmasına
neden olurdu. `install` artık bu durumda yüksek sesle başarısız olur ve eski işi
temizleyen `launchctl bootout` komutunu adlandırır.

Windows'ta `ocx service status`, Görev Zamanlayıcı kaydını kimliği doğrulanmış
OpenCodex proxy erişilebilirliğinden ayrı olarak bildirir. Yerelleştirilmiş
`schtasks` tablosunu yazdırmaz, bu nedenle özet Windows kod sayfaları arasında
okunabilir kalır.

Windows'ta Görev Zamanlayıcı girdisini oluşturmak yükseltme gerektirir. Tanınan
yerelleştirilmiş erişim reddedildi metni mevcut rehberlik yolunu korur. Bu metin
okunamıyorsa geri dönüş `/create /tn opencodex-proxy /xml <bos-olmayan-yol> /f`
sahip olunan komut şeklini, durum 1'i ve onaylanmış yükseltilmemiş bir belirteci
gerektirir; kontrol panelinin Başlangıç Güvenliği eylemi daha sonra UAC'yi
otomatik olarak isteyebilir. Bu geri dönüş belirteç durumunu belirleyemezse
orijinal zamanlayıcı hatasını korur. Yabancı görevler ve işlemler asla otomatik
yükseltme işaretçisini yayamaz. Kontrol paneli UAC istemini onaylayın veya
yükseltilmiş bir PowerShell penceresinde `ocx service install`'ı yeniden
çalıştırın.

OpenCodex zamanlayıcı görevinin kesinlikle bulunmadığı yeni bir kurulum için UAC
onayı artık yükleyici mevcut herhangi bir proxy'yi durdurmadan önce gerçekleşir.
Görev çalıştırılmadan kaydedilir; yalnızca kayıt başarılı olduktan sonra
OpenCodex eski dinleyiciyi durdurur, servis varlıklarını yayınlar ve zamanlanmış
görevi başlatır. Bu nedenle UAC'yi iptal etmek veya reddetmek çalışan proxy'yi
ve Codex yönlendirmesini yerinde bırakır. Mevcut veya çakışan zamanlayıcı
kayıtları güvenli olmayan en iyi çaba geri alması olarak silinmek yerine kapalı
olarak başarısız olmaya devam eder.

### `ocx codex-shim <install|status|uninstall|remove>`

PATH üzerindeki betik tabanlı bir `codex` başlatıcısını hafif bir otomatik
başlatma betiği ile sarın. Tam yürütülebilir çağrıları bozmaktan kaçınmak için
gerçek `codex.exe` hedefleri dokunulmadan bırakılır.

Bir kurulum veya onarım uygulanmadan önce OpenCodex servis başlangıcı atlanırken
kaydedilen başlatıcıyı `--version` ile çalıştırır. Başlatıcı `codex`'i tekrar
dolguya çözdüğünde, sıfır olmayan bir çıkış yaptığında, beş saniyeyi aştığında,
alt süreçleri çalışır durumda bıraktığında veya güvenli bir şekilde doğrulanıp
temizlenemediğinde değişikliği reddeder ve geri alır. Bu nedenle `codex-shim
install` koşulsuz değildir. Reddedilirse PATH girdisinin somut bir yürütülebilir
dosya veya başlatıcı olması için Codex'i yeniden yükleyin ve yeniden deneyin;
dinamik bir komut yöneticisi başlatıcısı bu denetimleri karşılayamadığında bunun
yerine `ocx service install` kullanın. Yükseltmeler sırasında geçerli doğrulama
korumasından yoksun kurulu bir Unix dolgusu yeniden oluşturulur ve araştırılır.
Kaydedilen başlatıcısı güvenli değilse OpenCodex güvensiz sarmalayıcıyı kurulu
bırakmak yerine eski dolguyu kaldırır ve orijinal başlatıcıyı geri yükler.

Yalnızca başlatıcı kurulumu Codex isteklerinin OpenCodex kullanacağını
kanıtlamaz. Sağlıklı bir kurulumdan sonra komut geçerli Codex yönlendirmesini
kontrol eder ve yönlendirme harici, kullanıcıya ait veya doğrulanamaz olduğunda
yeşil bir sonuç yerine bir uyarı bildirir. Ayrıca giden proxy değişkenleri
yalnızca geçerli süreçte mevcutken `config.proxy` ayarlanmadığında veya
çözümlenmediğinde uyarır, çünkü Codex başlatıcıları ve arka plan servisleri bu
ortamı devralmayabilir. Bu denetimler salt okunurdur ve asla proxy değerlerini
yazdırmaz; otomatik başlatmaya güvenmeden önce bildirilen devri çözün ve `ocx
doctor` çalıştırın.

Tamamlanan harici bir Codex güncellemesi kurulu bir dolgunun üzerine yazarsa
sonraki sıradan `ocx` komutu kararlı yeni başlatıcıyı yedekler ve dağıtımdan
önce dolguyu geri yükler. Hala değişmekte olan bir başlatıcı dokunulmadan
bırakılır ve daha sonra yeniden denenir. Onarım arızaları talep edilen komutu
başarısız kılmadan uyarır; manuel geri dönüş: `ocx codex-shim install`. Süreç
düzeyinde bir vazgeçme için `codexShimAutoRestore`'u `false` olarak ayarlayın
veya `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0` ayarlayın.

| Alt komut | Eylem |
| --- | --- |
| `install` | Dolguyu kurun (veya eskiyse onarın). |
| `uninstall` | Dolguyu kaldırın ve orijinal Codex ikili dosyasını geri yükleyin. |
| `remove` | `uninstall`'ın takma adıdır. |
| `status` | Dolgu durumunu bildirin (kurulu, eski veya eksik). |

```bash
ocx codex-shim install
ocx codex-shim status
ocx codex-shim uninstall
```

:::tip[Servis mi Dolgu mu?]
Her zaman açık bir arka plan proxy'si için `ocx service` kullanın (önerilir).
Bir arka plan programı olmadan hafif, isteğe bağlı başlatma için `ocx
codex-shim` kullanın — proxy yalnızca `codex` başlatıldığında başlar.
:::

### `ocx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]`

Windows durum tepsisi simgesini kurun ve kontrol edin. Windows oturum açılışında
başlar ve tek tıklamayla proxy kontrolleri sağlar. `start` ve `stop` yalnızca
simgeyi kontrol eder; proxy'yi kontrol etmek için menüsünü kullanın.
`--no-start`, `install` için geçerlidir ve tepsiyi hemen başlatmadan kurar.

## Kontrol Paneli

### `ocx gui`

Çalışmıyorsa proxy'yi otomatik olarak başlatarak `http://localhost:<port>`
adresindeki [web kontrol panelini](/tr/guides/web-dashboard/) açın.

## Güncelleme

### `ocx update [--tag latest|preview]`

opencodex'i npm'den kendi kendine güncelleyin. Kararlı kurulumlar `@latest`
kullanır; önizleme kurulumları `--tag latest|preview` iletmediğiniz sürece
`@preview` üzerinde kalır. Bir kaynak kod kopyasını algılar ve bunun yerine `git
pull && bun install` yapmanızı söyler ve o etiket için zaten en yeni
sürümdeyseniz işlem yapmaz (no-op). Herhangi bir şeyi durdurmadan önce npm
kurulumları sınırlı bir Unix önbellek sahipliği ve erişim kontrolü çalıştırır.
İç içe sembolik bağlantılar `lstat` ile kontrol edilir ancak takip edilmez;
Windows bu yalnızca Unix denetimini açıkça atlar. Bir arıza tepsi ve proxy hala
çalışırken iptal eder. Çalışan bir proxy daha sonra dosyalar değiştirilmeden
önce durdurulur; kurulu bir servis otomatik olarak yeniden oluşturulur ve
başlatılır, ön plan kurulumu ise sonraki adım olarak `ocx start` yazdırır.
Kontrol paneli güncelleme kayıtları kalıcı hale getirilmeden önce
profil/önbellek yollarını ve UID/GID değerlerini maskeler.

```bash
ocx update
ocx update --tag preview
```

Yeni sürümler, [Sürüm iş
akışı](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml)
bunları npm'de yayınladığında kullanılabilir hale gelir.


