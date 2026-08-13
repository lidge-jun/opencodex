---
title: Entegrasyonlar
description: Kontrol panelinden OpenCode, Pi, OMP, Hermes, OpenClaw, Kimi Code ve Gajae Code'u opencodex'e bağlayın — istemci başına tek bir anahtar ve her yazmadan önce alınan bir yedek.
---

**Entegrasyonlar** sekmesi, opencodex'in sağlayıcı bloğunu istemcinin kendi
yapılandırma dosyasına yazar ve tekrar kaldırır. Yedi istemci bu şekilde
çalışır, her biri bir anahtarla:

| İstemci | Yapılandırma dosyası | Format | Değişiklik ne zaman geçerli olur? | Kimlik bilgisi |
|---|---|---|---|---|
| OpenCode | `~/.config/opencode/opencode.json` | JSON | sonraki doğrudan başlatmada | `OPENCODEX_OPENCODE_API_KEY` |
| Pi | `~/.pi/agent/models.json` | JSON | yeni oturumlarda | geri döngü (loopback) yer tutucusu |
| OMP | `~/.omp/agent/models.yml` | YAML | OMP yeniden başlatıldıktan sonra | `opencodex-loopback` yer tutucusu |
| Hermes | `~/.hermes/config.yaml` | YAML | yeni oturumlarda | `OPENCODEX_HERMES_API_KEY` |
| OpenClaw | `~/.openclaw/openclaw.json` | JSON5 | hemen, çalışan bir ağ geçidinde | `OPENCODEX_OPENCLAW_API_KEY` |
| Kimi Code | `~/.kimi-code/config.toml` | TOML | yeniden başlatmada veya `/reload` ile | geri döngü (loopback) yer tutucusu |
| Gajae Code | `~/.gjc/agent/models.yml` | YAML | yeni oturumlarda veya `/model` açtığınızda | `OPENCODEX_GAJAE_API_KEY` |

Yollar, varsa her istemcinin kendi ortam geçersiz kılmalarını dikkate alır. OMP
için `OMP_PROFILE`, açıkça boş olduğunda bile varlığıyla `PI_PROFILE`'a üstün
gelir. Adlandırılmış bir profil, `PI_CONFIG_DIR`'i kullanıcının ev dizinine göre
bir dizin adı olarak kullanır ve `PI_CODING_AGENT_DIR`'i yok sayar;
adlandırılmış bir profil olmadığında `PI_CODING_AGENT_DIR` kazanır. OMP
sağlayıcı düzeyinde başlıkları destekler, ancak bu ilk entegrasyon kasıtlı
olarak yalnızca geri döngü (loopback) içindir; uzaktan `x-opencodex-api-key`
bağlantısı ertelenmiştir. Taşınmış `HERMES_HOME`, `KIMI_CODE_HOME` ve
`XDG_CONFIG_HOME` yolları tahmin edilmek yerine benzer şekilde takip edilir.
Tablo her istemcinin varsayılanını listeler.

Yerel OpenAI modelleri için üretilen OMP bloğu, görsel girişini ve akıl yürütme
çabası denetimlerini koruyarak model düzeyindeki Responses API'sini seçer.
Yönlendirilen modeller, sağlayıcının Chat Completions lehçesini korur, böylece
mevcut adaptörleri uyumlu kalır.

OpenClaw'un birkaç yolu vardır ve bunlar farklı işler yapar.
`OPENCLAW_CONFIG_PATH` dosyayı seçer; `OPENCLAW_STATE_DIR`, `OPENCLAW_PROFILE`
ve `OPENCLAW_HOME` algılamanın da baktığı durum dizinini seçer — bu nedenle bir
profil veya taşınmış bir ev dizini hala kurulu olarak okunurken, bir
yapılandırma yolu geçersiz kılması yalnızca dosyayı taşır. Hala eski `.clawdbot`
düzenindeyseniz bu da bulunur: modern dizin mevcut olduğunda kazanır ve eski
dizin yalnızca orada tek olduğunda kullanılır.

Bunlar **mutlak yollar** olmalı veya `~` ile başlamalıdır. Göreli bir yol
çözümlenmek yerine reddedilir, çünkü her sürecin tesadüfen başladığı dizin
anlamına gelirdi — ve bu yol yedekle birlikte saklanır, bu yüzden yarın da bugün
olduğu gibi aynı dosyayı adlandırmalıdır.

opencodex bunları kendi ortamından okur. Ağ geçidiniz bir profil veya taşınmış
bir ev dizini ile çalışıyorsa, opencodex'i aynı değişkenler ayarlanmış olarak
başlatın; aksi takdirde doğru şekilde farklı bir kurulumu takip eder.

## Diğer dört yüzey anahtar değildir

**API Anahtarları (API Keys)** opencodex'in kendi kimlik bilgilerini yönetir ve
hiçbir şekilde bir istemci değildir. **Codex CLI**, proxy servisinin kendisi
tarafından bağlanır — opencodex'i başlatmak uygular, durdurmak yerel
yönlendirmeyi geri yükler — bu nedenle dosya başına değiştirilecek bir şey
yoktur. **Claude** kendi etkinleştirme bayrağını ve Desktop'ın Kaydet/Uygula
akışını korur; **Grok Build** ise seç ve uygula model çitini korur. Bu
anlambilimler bu özellikten öncedir ve değişmemiştir.

## Geri Alma (Rollback)

Her başarılı yazma işlemi *önce* dosyanızın bir anlık görüntüsünü alır, böylece
sahip olduğunuz durum her zaman kurtarılabilir:

- **Geri Al (Undo)**, dosyanız yazdığımızla hala eşleştiğinde en yeni işlemde
  görünür.
- **Bu noktayı geri yükle… (Restore this point…)**, daha eski işlemlerde veya
  dosya bu işlemden sonra değiştiğinde görünür. Böyle bir değişiklik üzerinden
  geri yükleme yapmak, daha yeni düzenlemelerinizin üzerine yazmadan önce ikinci
  kez sorar — ve bunları da yedekler, böylece bu geri yüklemenin kendisi de geri
  alınabilir olur.
- İstemci başına on yedek saklanır. Bunun ötesinde, en eski anlık görüntü
  dosyaları kaldırılır ve geçmiş satırlarında **Yedek süresi doldu (Backup
  expired)** yazar.

Devre dışı bırakma, yalnızca opencodex'in kendisine ait olarak kaydettiği
girdileri kaldırır. Dosyanız biz yazdıktan sonra değiştiyse, anahtar kilitlenir
ve hangi düzenlemelerin size ait olduğunu tahmin etmek yerine devre dışı
bırakmayı reddeder.

## Dürüstçe ne beklenmeli?

**Biçimlendirme genellikle korunmaz.** Uygulama işlemi bir yapılandırmayı
ayrıştırır ve geri yazar, bu nedenle JSON, JSON5 ve TOML yeniden
biçimlendirilebilir ve JSON5 veya TOML içindeki yorumlar kaybolur. OMP
istisnadır: YAML yazıcısı yalnızca `providers.opencodex` kısmını yamalar,
ilgisiz sağlayıcı yorumlarını ve biçimlendirmesini bayt bayt korur. Bu tam
kaynak aralığı güvenli bir şekilde tanımlanamazsa işlem bunun yerine reddeder.
Diğer istemciler için önceki dosya baytlarına ihtiyacınız olduğunda Geri
Yükle'yi kullanın: anlık görüntü birebir bir kopyadır.

**Bir değer aslına sadık kalınarak yeniden yazılamıyorsa anahtar bunun yerine
reddeder.** Gidiş-dönüş, bu formatların pratikte kullandığı değer türlerini
kapsar ve kapsamadığı yerlerde — örneğin elimizdeki ayrıştırıcının doğru şekilde
geri okuyamadığı `inf` veya `nan` kullanan bir TOML dosyası — uygulama işlemi
değişen bir değer yazıp buna başarı demek yerine durur ve bunu söyler. Dosyanın
adlandırıldığını ve diskte hiçbir şeyin taşınmadığını görürsünüz. Bu dosyayı
elle düzenlemek hala çalışır; yalnızca otomatik yeniden yazmamız reddeder.

**Pi, Kimi Code ve Gajae Code yalnızca geri döngü (loopback) bağlantısına karşı
çalışır.** Yapılandırma şemalarında geri döngü olmayan bir bağlantının
gerektirdiği `x-opencodex-api-key` başlığı için yer yoktur, bu nedenle
oluşturulan bir yapılandırma basitçe reddedilir. Bunun yerine onlara bir SSH
tüneli veya başlığı ekleyen yerel bir iletici aracılığıyla geri döngü erişimi
verin.

**Oluşturulan OMP entegrasyonu da kasıtlı olarak yalnızca geri döngü içindir.**
OMP sağlayıcı düzeyinde başlıkları destekler, ancak bu ilk entegrasyon uzak
`x-opencodex-api-key` kimlik bilgisi bağlantısını yayınlamaz. Manuel uzak OMP
yapılandırması şimdilik yönetilen entegrasyonun dışındadır.

**Kimi Code bir ortam referansı tutamaz,** bu nedenle yapılandırması bir anahtar
yerine `opencodex-loopback` yer tutucusu taşır. Hiçbir istemci yapılandırmasına
asla gerçek bir kimlik bilgisi yazılmaz.

**`ocx opencode` için başlatıcının sağlayıcı bloğu kazanır.** Bu başlatıcı,
`provider.opencodex`'i diskteki aynı girdiden üstün olan
`OPENCODE_CONFIG_CONTENT` aracılığıyla enjekte eder — opencode yapılandırmanızın
geri kalanı her zamanki gibi geçerli olmaya devam eder. Buradaki anahtar,
`opencode`'u doğrudan başlattığınızda önemlidir.

## Terminalden

Aynı işlemler başsız (headless) olarak da mevcuttur:

```bash
ocx integration client status
ocx integration client enable --client hermes
ocx integration client disable --client hermes
ocx integration client history --client hermes
ocx integration client restore --op <opId> [--confirm-drift]
```

`--confirm-drift` asla varsayılmaz. Geri yüklediğiniz işlemden sonra dosya
değiştiyse, komut reddeder ve size bildirir; çünkü daha yeni düzenlemelerinizin
üzerine yazmak sizin vereceğiniz bir karardır.

İstemci ayrıntıları her projenin kendi yapılandırma formatına göre
doğrulanmıştır; neyin ne zaman denetlendiğine ilişkin
`devlog/_fin/260802_client_toggle_api/002_client_toggle_matrix.md` içindeki
araştırma notlarına bakın.


