---
title: Entegrasyonlar
description: Kontrol panelinden OpenCode, Pi, OMP, Hermes, OpenClaw, Kimi Code, Gajae Code, DeepSeek Harness ve MiniMax Code'u opencodex'e bağlayın — istemci başına tek bir anahtar ve her yazmadan önce alınan bir yedek.
---

**Entegrasyonlar** sekmesi, opencodex'in sağlayıcı bloğunu istemcinin kendi
yapılandırma dosyasına yazar ve tekrar kaldırır. Dokuz istemci bu şekilde
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
| DeepSeek Harness (DSH) | `$DSH_HOME/settings.yaml` (varsayılan `~/.dsh/settings.yaml`) | YAML | çalışırken yeniden yükleme | gizli olmayan geri döngü bearer yer tutucusu |
| MiniMax Code | `~/.minimax/config.yaml` | YAML | yeni oturumlarda veya model seçici açıldıktan sonra | geri döngü (loopback) yer tutucusu |

Yönetilen DSH desteğinin en düşük uyumlu sürümü **DSH 0.1.0-rc.6**'dır. OpenCodex yalnızca
`llm-pi-ai.providers.opencodex` bölümünü yönetir: Uygula ve Yenile bu bölümü değiştirir, Devre Dışı
Bırak yalnızca bu bölümü kaldırır, Geri Yükle ise kaydedilmiş bir anlık görüntüyü geri koyar. DSH
sağlayıcı değişikliklerini çalışırken yeniden yükler. Bu işlemler kullanıcının varsayılan modelini
veya yerel `deepseek-official` sağlayıcısını değiştirmez. Yönetilen DSH entegrasyonu şu anda yalnızca
geri döngü içindir ve asla gerçek bir kimlik bilgisi yazmaz.

MiniMax Code önce `MINIMAX_DATA_DIR`, ardından `MAVIS_DATA_DIR` yolunu izler ve
son olarak `~/.minimax` dizinine geri döner. Yönetilen blok yalnızca
`custom_provider.opencodex` alanına sahiptir; `defaultModel` değerini, seçilen
MiniMax kimlik bilgisi kaynağını veya kullanıcının MiniMax oturumunu değiştirmez.
Bağladıktan sonra MCode içinde bir `custom_provider:opencodex/<provider/model>` girdisi seçin.
Entegrasyon yenilendiğinde model başına doğrulanmış bağlam pencereleri ve akıl yürütme
çabası seçenekleri de yenilenir; bilinmeyen yetenekler atlanır ve MCode oturumunun
yönettiği geçerli çaba seçimi korunur.

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
girdileri kaldırır. Dosyanız biz yazdıktan sonra değiştiyse, ne olacağı kendi
girdilerimizin hâlâ bozulmamış olup olmadığına ve dosyanın biçimine bağlıdır.
Katı JSON yapılandırmalarında (OpenCode, Pi), bloğumuzun **yanında** yapılan bir
düzenleme — bir MCP sunucusu eklemek, kendinize ait bir sağlayıcı tanımlamak —
**Güncelleme gerekli (Update needed)** olarak görünür: yenileme, girdilerinizin
etrafında birleştirir ve onları korur; yalnızca biçimlendirme
normalleştirilebilir. İstisna, JSON'un birebir yeniden yazamayacağı şeylerdir —
`1e999` gibi sonlu olmayan bir sayı, yeniden yazımın yuvarlayacağı bir sayı (çok
büyük bir tam sayı ya da sıfıra çökecek kadar küçük bir sayı), `-0`, aynı
nesnede iki kez yazılmış bir anahtar veya 1000 seviyeden derin iç içe geçme —
bu durumda anahtar kilitlenir, böylece
hiçbir şey sessizce değiştirilmez veya düşürülmez. **OMP** de yanındaki
düzenlemelerden etkilenmez, ama başka bir nedenle: writer'ı yalnızca kendi
`providers.opencodex` aralığını bayt bayt yamalar, dosyanın geri kalanı hiçbir
zaman yeniden yazılmaz. Yorum taşıyabilen diğer biçimlerde (Hermes, OpenClaw,
Kimi Code, Gajae Code, MiniMax Code — bütün belge olarak yazılan YAML, JSON5 ve TOML) veya
kendi girdilerimiz düzenlenmişse, anahtar kilitlenir ve hangi düzenlemelerin
size ait olduğunu tahmin etmek yerine devre dışı bırakmayı reddeder.

## Dürüstçe ne beklenmeli?

**Biçimlendirme genellikle korunmaz.** Uygulama işlemi bir yapılandırmayı
ayrıştırır ve geri yazar, bu nedenle JSON, JSON5 ve TOML yeniden
biçimlendirilebilir ve JSON5 veya TOML içindeki yorumlar kaybolur. OMP ve DSH
istisnadır: YAML yazıcıları sırasıyla yalnızca `providers.opencodex` ve
`llm-pi-ai.providers.opencodex` kısımlarını yamalar,
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

**Pi, Kimi Code, Gajae Code, MiniMax Code ve yönetilen DSH entegrasyonu yalnızca geri döngü (loopback) bağlantısına karşı
çalışır.** İlk dördünün yapılandırmasında geri döngü olmayan bir bağlantının gerektirdiği
`x-opencodex-api-key` başlığı için alan yoktur. DSH genel bir headers haritası sunar, ancak rc.6
bu özel kabul başlığını desteklenen bir entegrasyon sözleşmesi olarak belgelememektedir; bu nedenle
yönetilen writer tahmin yürütmek yerine kapalı biçimde reddeder. Bunun yerine bir SSH tüneli veya
başlığı ekleyen yerel bir iletici aracılığıyla geri döngü erişimi verin.

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

`--overwrite-conflict`, **Replace** eyleminin terminal karsiligidir:

```bash
ocx integration client enable --client zcode --overwrite-conflict
```

`--confirm-drift` gibi asla varsayilmaz: bayrak yazilmadan catisma yine reddedilir.
Yalnizca `enable` icin gecerlidir; bir catismanin uzerine *disable* zorlamak hic
yazmadigimiz bir blogu silecegi icin bu birlesim reddedilir.

MiniMax Code için sağlayıcıyı bir kez bağlayın ve denetimli başlatıcı üzerinden çalıştırın:

```bash
ocx integration client enable --client mcode
ocx mcode
```

Bağlandıktan sonra `ocx sync`, yönetilen MCode bloğunu güncel bağlam pencereleri ve
akıl yürütme çabası seçenekleriyle de yeniler. Eksik, dışarıdan düzenlenmiş, güvenli
olmayan veya hiç sahiplenilmemiş bloklara dokunmaz; yeniden bağlamak istediğinizde
entegrasyonu açıkça yeniden etkinleştirin.

Ayrı MiniMax platform CLI'si (`mmx`) bir dosya anahtarı entegrasyonu değildir.
Metin komutları MiniMax'ın Anthropic uyumlu uç noktasını kullandığı için OpenCodex,
kimlik bilgilerini yalıtan ve yalnızca geri döngüde çalışan bir başlatıcı sağlar:

```bash
ocx mmx text chat --model anthropic/claude-opus-5 --message "Hello"
ocx mmx text repl --model openai/gpt-5.6-sol
```

Yalnızca `mmx text chat` ve `mmx text repl` proxy üzerinden yönlendirilir. MiniMax'a
özgü diğer komutlar için doğrudan `mmx` çalıştırın. Başlatıcı yalnızca gizli olmayan
geri döngü yer tutucusunu içeren geçici bir yapılandırma kullanır; `~/.mmx` OAuth veya
API anahtarı kimlik bilgilerinizi yüklemez ve `--api-key`, `--base-url` ile `--region`
geçersiz kılmalarını reddeder. Tam iş akışı için
[MiniMax istemcileri](/guides/minimax/) sayfasına bakın.

`--confirm-drift` asla varsayılmaz. Geri yüklediğiniz işlemden sonra dosya
değiştiyse, komut reddeder ve size bildirir; çünkü daha yeni düzenlemelerinizin
üzerine yazmak sizin vereceğiniz bir karardır.

İstemci ayrıntıları her projenin kendi yapılandırma formatına göre
doğrulanmıştır; neyin ne zaman denetlendiğine ilişkin
`devlog/_fin/260802_client_toggle_api/002_client_toggle_matrix.md` içindeki
araştırma notlarına bakın.
