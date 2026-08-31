---
title: Codex Entegrasyonu
description: opencodex'in kendisini Codex'e nasıl enjekte ettiği, model kataloğunu nasıl senkronize ettiği, dolguları (shims) nasıl kurduğu ve nasıl temiz bir şekilde geri yüklediği.
---

opencodex, Codex'in okuduğu iki şeyi düzenleyerek Codex'in proxy üzerinden
yönlendirilmesini sağlar: yapılandırması (`$CODEX_HOME/config.toml`, varsayılan
`~/.codex/config.toml`) ve model kataloğu. Her düzenleme eşkuvvetli (idempotent)
ve geri alınabilirdir.

Proxy, Havuz (varsayılan) ve Doğrudan (Direct) hesap modlarına sahip tek bir
yalın `openai` Codex girişi rotasının yanı sıra, yapılandırılmış API anahtarı
için `openai-apikey/<model>` sunar. Havuz, ana hesap artı eklenen hesapları
içerir; Direct yalnızca arayan/ana taşıyıcıyı kullanır. Rotalar birbirine geri
dönmez (fall back yapmaz). Sevk edilen v1 yapılandırmaları işaretçi 2'ye geçer
ve manuel geri yükleme için `config.json.pre-openai-tiers-v2.bak` dosyasını
korur.

## Yapılandırma enjeksiyonu

`ocx init`, `ocx start` ve `ocx sync` enjektörü çağırır. Varsayılan geri döngü
(loopback) bağlantısında, Codex'in yerleşik `openai` sağlayıcı kimliğini korur
ve bu sağlayıcıyı opencodex'e yönlendirir:

```toml
# kök anahtarlar, ilk tablodan önce
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex
openai_base_url = "http://127.0.0.1:10100/v1"

# yalnızca fastMode ayarlandığında; ayarlanmadığında [features] tablosu eklenmez
[features]
fast_mode = true
```

Enjekte edilen `fast_mode`, üç durumlu `fastMode` ayarını takip eder: `true`,
`fast_mode = true` yazar, `false`, `fast_mode = false` yazar ve ayarlanmamış
durum, bir `[features]` tablosu eklemeden mevcut bir `fast_mode`'a dokunulmadan
bırakır.

Proxy varsayılan olarak `10100` portunu dinler ve `POST /v1/responses`, `POST
/v1/responses/compact`, `POST /v1/images/generations`, `POST /v1/images/edits`,
`GET /v1/models`, `GET /healthz` ve `/api/*` yönetim yüzeyini sunar.

### Yerleşik görsel oluşturma (`image_gen`)

Codex'in yerleşik `image_gen` aracı `/v1/responses` üzerinden geçmez — codex-rs
uzantısı, sohbet için kullandığı aynı ChatGPT taşıyıcı kimlik doğrulamasıyla
doğrudan `{base_url}/images/generations` (veya referans görseller eklendiğinde
`/images/edits`) uç noktasına POST gönderir. Enjekte edilen `base_url`
opencodex'i işaret ettiğinden proxy bu çağrıları OpenAI yukarı akışına iletir.

Bu, yalnızca OpenAI harici bir model seçiliyken bir **Responses** turu
barındırılan `image_generation` aracını listelediğinde etkinleşen [Görsel
Köprüsü (Image Bridge)](/tr/guides/image-bridge/) özelliğinden ayrıdır. Bağımsız
`/images/generations` çağrıları bu köprüye asla girmez.

- **Tek bir mod duyarlı iletme adayı:** Pool uygun bir ana/eklenen hesabı seçer;
  Direct arayanın OAuth taşıyıcısını kullanır. Yapılandırılan mod görsel
  isteğine tutarlı bir şekilde uygulanır.
- **OpenAI API anahtarı sağlayıcısı:** yalnızca hiçbir iletme adayı bir kimlik
  doğrulama hatasına sahip olmadığında kullanılır. Bozuk/süresi dolmuş bir Havuz
  kimlik bilgisi hiçbir zaman ayrı olarak faturalandırılan API kullanımının
  arkasına gizlenmez.
- **Açık özel sağlayıcı:** `images.provider`'ı, uç noktası OpenAI Images
  API'sini uygulayan özel bir API anahtarlı `openai-responses` sağlayıcısının
  kimliğine ayarlayın. Açık seçim kapalı olarak başarısız olur ve asla farklı
  bir ücretli yukarı akışa geri dönmez. Kayıt defteri tarafından yönetilen
  sağlayıcı kimlikleri burada kabul edilmez; yerleşik OpenAI katmanlarını
  kullanmak için `images.provider`'ı atlayın.
- **Google Antigravity (CCA) geri dönüşü:** ne bir OpenAI iletme adayı ne de
  anahtarlı bir sağlayıcı yapılandırılmadığında, `/v1/images/generations`
  (`/images/edits` değil), `gemini-3.1-flash-image` modelini kullanarak
  Antigravity **Cloud Code Assist** uç noktasına geri döner. Geri dönüş,
  yalnızca hiçbir OpenAI adayı yapılandırılmadığında değil, OpenAI kimlik
  doğrulama çözümlemesi başarısız olduktan sonra da (örneğin süresi dolmuş veya
  eksik bir ChatGPT kimlik bilgisi) tetiklenir. Bu, `ocx login
  google-antigravity` gerektirir; OAuth belirteci asla yapılandırma düzeyindeki
  bir `baseUrl` geçersiz kılmaya değil, yalnızca sabitlenmiş CCA kayıt defteri
  ana bilgisayarına gönderilir. Yanıt, Codex'in beklediği aynı `{created,
  data:[{b64_json}]}` biçiminde döndürülür.
- **Hiçbiri:** proxy genel bir 404 yerine net bir hata döndürür. Yönlendirilen
  sağlayıcılar (Cursor, Gemini, Kiro, …) `image_generation` araç aktarımını
  sunamaz; aracın hiç sunulmasını istemiyorsanız Codex'te `codex features
  disable image_generation` (`config.toml` içinde `[features] image_generation =
  false`) ile devre dışı bırakın.

Araç bildirimi modelin Responses isteğiyle birlikte gitmeye devam eder. API
anahtarlı Responses sağlayıcıları için opencodex, Codex'in özel `image_gen` ad
alanını yukarı akış açısından güvenli bir `image_gen__<dahili-ad>` takma adına
(örneğin `image_gen__imagegen`) indirir. Bu kullanılabilir takma ad istemci
bildiriminin yerini aldığında opencodex yinelenen bir barındırılan
`image_generation` bildirimini kaldırır. Fonksiyon çağrısını Codex görmeden önce
açık `image_gen` ad alanıyla eşler ve daha sonraki geçmiş yukarı akışta yeniden
oynatıldığında yerel çağrıyı tekrar kodlar. Bu, istemci tarafı görsel
oluşturmanın ad alanını ayıran veya noktalı fonksiyon adlarını reddeden genel
uyumlu yukarı akışlarda çağrılabilir kalmasını sağlar. ChatGPT iletme modu
dokunulmadan kalır ve yerel Responses Lite şeklini korur.

OpenAI uyumlu özel bir ağ geçidi için ayrılmış bir sağlayıcı yapılandırın ve
bunu yalnızca bağımsız Görseller istekleri için seçin:

```json
{
  "providers": {
    "custom-images": {
      "adapter": "openai-responses",
      "baseUrl": "https://gateway.example.com/v1",
      "authMode": "key",
      "apiKey": "${IMAGE_GATEWAY_API_KEY}"
    }
  },
  "images": {
    "provider": "custom-images",
    "timeoutMs": 300000
  }
}
```

Özel uç nokta `POST /v1/images/generations` ve `/v1/images/edits` kabul etmeli
ve Codex tarafından beklenen OpenAI Görselleri yanıt şeklini döndürmelidir.
Sağlayıcının yapılandırılmış anahtarı, yukarı akış isteğinden önce arayanın
taşıyıcısının yerini alır.

> **Not:** Bu yalnızca Codex `image_generation` aracına (`/images/generations` aktarımı) atıfta bulunur. Görsel yetenekli Gemini modelleri bu aktarımdan bağımsız olarak `google` adaptörü aracılığıyla (`responseModalities: ["TEXT", "IMAGE"]` üzerinden) satır içi görselleri yerel olarak üretir — bkz. [Adaptörler](/tr/reference/adapters/#google).

Geri döngü olmayan bir `hostname` için Codex oluşturulan API kimlik doğrulama
başlığını göndermelidir. Bu nedenle enjektör bunun yerine özel bir sağlayıcı
kullanır:

```toml
# kök anahtarlar
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

# dosyanın sonuna eklenir
# Auto-injected by opencodex
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://your-host:10100/v1"
wire_api = "responses"
requires_openai_auth = true
env_key = "OPENCODEX_API_AUTH_TOKEN"
# supports_websockets = true   # yalnızca config.websockets true olduğunda
```

OpenCodex yönlendirmeye sahip olduğunda, her iki mod da bir referans/geri dönüş
yapılandırması olarak `$CODEX_HOME/opencodex.config.toml` dosyasını yazar. Geri
döngüde otomatik enjeksiyon kaldırılmışsa manuel olarak birleştirebileceğiniz
kök anahtarları içerir; geri döngü olmayanda ise özel sağlayıcı formunu içerir.
Harici sağlayıcı modu bu profile dokunmaz.

:::caution
`openai_base_url`, `model_provider` ve `model_catalog_json` gibi kök anahtarlar
ilk `[tablo]` başlığından önce **bulunmalıdır**. Enjektör bu yerleşimi garanti
eder, kendi eski/yinelenen kopyalarını kaldırır ve kullanıcıya ait bir kök
`openai_base_url`'in üzerine asla yazmaz; bir tane varsa senkronizasyon kataloğu
günceller ancak yönlendirmenin enjekte edilmediğini bildirir.
:::

## Paylaşılan model kataloğu

Codex CLI, TUI, App ve SDK'nın tümü aynı Codex evini okur. opencodex bu dizini
`CODEX_HOME`'dan çözer, `~/.codex`'e geri döner ve şunları yönetir:

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

WSL üzerinde, `CODEX_HOME` ayarlanmamışsa ve Linux `~/.codex/config.toml` mevcut
değilse, opencodex `/mnt/c/Users/*/.codex/config.toml` konumunda tek bir Windows
Codex Desktop evini de kontrol eder. Tam olarak bir aday mevcut olduğunda bu
dizini kullanır, böylece WSL app-server modu ve Windows Codex Desktop aynı
yapılandırma ve kimlik doğrulama dosyalarını paylaşır. Bu algılamayı geçersiz
kılmak için `CODEX_HOME`'u açıkça ayarlayın.

Codex, SQLite destekli iş parçacığı durumunu ayrı bir dizinde tutabilir.
OpenCodex geçmiş işlemleri Codex ile aynı önceliği kullanır: `config.toml`
içindeki kök `sqlite_home`, ardından `CODEX_SQLITE_HOME`, ardından geçerli
`CODEX_HOME`. Göreli SQLite evleri geçerli çalışma dizininden çözümlenir. Servis
kurulumu veya onarımı sırasında açık bir `CODEX_SQLITE_HOME` mevcut olduğunda,
kalıcı başlatıcı kurulum zamanındaki mutlak yolunu saklar, böylece arka plan
proxy'si aynı veritabanını adreslemeye devam eder. `config.toml` veya kök
`sqlite_home` anahtarı yoksa OpenCodex ortam/ev geri dönüşüne devam eder. Dosya
okunamıyor veya ayrıştırılamıyorsa ya da anahtar mevcut ancak boş veya dize
değilse, SQLite-ev çözümlemesi farklı bir veritabanına karşı geçmiş işlemlerini
riske atmak yerine durur.

Windows'ta bir Orca kabuğu, ChatGPT/Codex uygulaması hala `%USERPROFILE%\.codex`
okurken hem `CODEX_HOME` hem de `ORCA_CODEX_HOME`'u Orca'nın paketlenmiş çalışma
zamanı evine ayarlayabilir. `ocx status` ve `ocx doctor` bu tam uyumsuzluk
hakkında uyarır ve maskelenmiş hedef yollarını yazdırır. Bu Orca kabuğundan bir
arka plan servisi kurulmuşsa, önce orijinal kabuktan kaldırın, ardından
`CODEX_HOME`'u uygulama evine ayarlayın, `ORCA_CODEX_HOME`'u kaldırın,
senkronizasyon/geri yüklemeyi yeniden çalıştırın ve servisi tekrar kurun.

Özel sağlayıcı modunda `requires_openai_auth = true`, Codex App/TUI hesap
geçişli yüzeylerini yerel Codex ile hizalı tutar. opencodex ayrıca WebSocket
üzerinden `/v1/responses` sunar. Özel sağlayıcı yalnızca `"websockets": true`
olduğunda `supports_websockets = true` bildirir; geri döngüde Codex'in yerleşik
sağlayıcısı önce WebSocket'i deneyebilir ve devre dışı bırakılmış bir proxy
`426` döndürür, böylece Codex HTTP/SSE'ye geri döner.

## İş parçacığı kimliği ve geçmişi

Varsayılan geri döngü formu yeni iş parçacıklarının Codex'in yerel `openai`
sağlayıcısıyla etiketlenmesini sağlar, böylece normal devam etme geçmişinin
yeniden eşlenmesi gerekmez. Sync ve restore yalnızca eşleşen bir yedek manifestini
uygular ve her iş parçacığının özgün provider, source ve event marker değerlerini
tam olarak geri yükler. Manifesti olmayan bir `opencodex` satırı değişmeden kalır;
legacy yeniden etiketlemeyi açıkça zorlamak istediğinizde yalnızca
`ocx recover-history --legacy-openai --yes` kullanın. Bu komut bilinçli olarak geniş kapsamlıdır:
kullanıcı iletisi bulunan ve şu anda `opencodex` olarak etiketlenmiş her thread'i `openai`
olarak yeniden etiketler, `exec` değerini `cli` olarak normalleştirir ve event marker'ı ayarlar;
geçerli dedicated-provider geçmişi de buna dahildir. Durumu yedekleyin ve yalnızca bu kapsamın
tamamını istiyorsanız kullanın. Geri döngü olmayan özel sağlayıcı
modu etkinken geçmişi yine de `opencodex` sağlayıcısı altında yansıtır ve çıkışta
yedeklenen meta verileri geri yükler. Geçmişe dokunulmadan bırakmak için
`syncResumeHistory: false` ayarlayın.

## Model kataloğu senkronizasyonu

Codex modelleri diskteki bir katalogdan gösterir (varsayılan olarak
`$CODEX_HOME/opencodex-catalog.json`). Başlangıçta ve `ocx sync` sırasında
opencodex:

1. Öne çıkarmanın geri alınabilir olması için bozulmamış kataloğu
   `~/.opencodex/catalog-backup.json` konumuna bir kez **yedekler**.
2. Uygun sağlayıcıların canlı model kataloglarını **getirir** (~5 dakika
   önbelleğe alınır; son iyi listeye, ardından yapılandırılmış `models[]`'a geri
   döner). İletme kimlik doğrulamasının bir model uç noktası yoktur ve Cursor
   `/models` yerine `GetUsableModels` RPC'sini kullanır.
3. Yönlendirilen modelleri, Codex'in katı ayrıştırıcısının kabul etmesi için
   yerel bir Codex katalog şablonundan klonlanan ad alanlı girdiler
   (`provider/model`) olarak **birleştirir**.
4. `config.disabledModels` ve her sağlayıcının boş olmayan `selectedModels` izin
   listesini **filtreler**.
5. Öne çıkan modellerin ilk önce sıralanması için **yeniden derecelendirir**
   (aşağıya bakın), ardından birleştirilmiş kataloğu geri yazar.

Yönlendirilen katalog girdileri ayrıca GPT-5 kimliklerinin gerçek yukarı akış
model adına yeniden yazılmasını sağlar. Akıl yürütme denetimleri, Codex'in `low
| medium | high | xhigh | max | ultra` merdiveni genelinde sağlayıcı/model meta
verilerinden gelir; desteklenmeyen değerler yukarı akış isteğinden önce eşlenir
veya sabitlenir.

### Yönlendirilen yerel araçlar

Yerel olmayan yönlendirilen katalog satırları `tool_mode: "code_mode_only"`
kullanır. Bu, Codex'in resmi `exec` giriş noktasını ve Tarayıcı ile Bilgisayar
Kullanımı dahil olmak üzere iç içe geçmiş MCP araçlarını açığa çıkarmasını
sağlarken, opencodex yalnızca modelin sıradan fonksiyon çağrısını yönlendirir.
Araç yürütme, izinler ve onaylar Codex'e yerel kalır; opencodex ikinci bir
tarayıcı veya masaüstü denetim yürütücüsü uygulamaz.

Codex'in `exec` özel araç dilbilgisini kabul etmeyen anahtar kimlik doğrulamalı
Responses sağlayıcıları için opencodex bu bildirimi ve geçmişini bir yukarı akış
fonksiyon aracı olarak kodlar, ardından akışlı fonksiyon çağrısı yaşam döngüsünü
Codex görmeden önce `custom_tool_call`'a geri yükler. Yerel OpenAI iletme
yönlendirmesi ve desteklenen `apply_patch` özel aracı değişmeden kalır.

Seçilen sağlayıcı fonksiyon/araç çağrısını desteklemelidir. Araç çağrısı desteği
olmayan salt metin bir sağlayıcı `exec`, Tarayıcı veya Bilgisayar Kullanımını
kullanamaz. Yerel OpenAI satırları yukarı akış araç modunu değiştirmeden tutar.

`ocx sync` bu meta verileri değiştirdikten sonra Codex App'i yeniden başlatın ve
yeni bir görev açın. Mevcut app-server süreçleri ve görevleri başlangıçta
yükledikleri kataloğu ve araç planını koruyabilir.

### Özel model görünen adları

Özel bir model, modelin nasıl yönlendirildiği hakkında hiçbir şeyi değiştirmeden
Codex'in model seçicisinde gösterdiği etiketi geçersiz kılan insan tarafından
okunabilir bir **görünen ad (display name)** taşıyabilir. Görünen ad yalnızca
katalog girdisinin `display_name` alanıyla eşleşir — yönlendirme slug'ı
(`<provider>/<model>`), takma ad çakışma sırası, sağlayıcı ve yerel OpenAI
pazarlama adlarının tümü dokunulmadan bırakılır.

CLI'dan bir görünen ad ekleyin (proxy canlıyken kataloğu hemen senkronize eder):

```bash
ocx models add deepseek deepseek-v4 --display-name "DeepSeek V4" --context-window 128000
```

Uzak Codex istemcileri oluşturulan aynı kataloğu yönetim API'si üzerinden
getirebilir (diğer `/api/*` rotalarıyla aynı kabul belirteci):

```bash
dest="${CODEX_HOME:-$HOME/.codex}/opencodex-catalog.json"
tmp="$(mktemp "${dest}.XXXXXX")"
curl -fsS -H "x-opencodex-api-key: $OPENCODEX_API_AUTH_TOKEN" \
  "https://proxy.example.com/v1/catalog" > "$tmp" \
  && mv "$tmp" "$dest"
ocx sync-cache
```

Yanıt ham `opencodex-catalog.json` belgesidir (sağlayıcı kimlik bilgisi yoktur).
Kullanılabilir olduğunda `x-opencodex-codex-version` başlığı sunucudaki Codex
çalışma zamanı sürümünü bildirir, böylece istemciler sürüm kaymasını tespit
edebilir.

Ayrıca bunu yönetim API'si (`POST /api/custom-models`, bir `displayName`
dizesiyle `PUT /api/custom-models/<id>`) ve web kontrol paneli aracılığıyla
ayarlayabilir veya düzenleyebilirsiniz. Yönlendirilen slug ayırıcısıyla
çakışacağı için `/` işareti reddedilir.

`GET /v1/catalog`, bir model listesini okumanın yönetici belirtecine mal olmaması için vardır. Rota salt okunurdur (`GET` ve `HEAD`), `x-opencodex-api-key`, bearer belirteci veya `x-api-key` kabul eder ve yönetim rotasıyla tamamen aynı baytları sunar. Yanıtlar güçlü bir `ETag` taşır — tam belge yerine `304` almak için `If-None-Match` ile geri gönderin — ve `Cache-Control: private, no-cache` içerir. Burada kabul edilen bir veri düzlemi anahtarı yönetim düzleminde **hiçbir şey** kazanmaz: `/api/catalog` ve tüm `/api/*` rotaları hâlâ yönetici belirteci veya pano oturumu gerektirir.

Görünen ad **yalnızca görüntüleme amaçlıdır ve yeniden oluşturma boyunca
kararlıdır**. Her `ocx sync` ve katalog yenilemesi yönlendirilen girdileri
`config.json`'dan (`customModels` dahil) yeniden türetir, böylece yapılandırılan
ad yönlendirilen slug'a geri dönmek yerine yeniden uygulanır. Yönetilen bir
servis yeniden başlatması da proxy bağlandıktan kısa bir süre sonra bu
senkronizasyonu dener. Bu en iyi çaba açılış senkronizasyonu başarısız olursa,
örneğin çevrimdışı bir oturum açma sırasında, daha önce kalıcı hale getirilen
katalog korunur ve bir sonraki başarılı `ocx sync` yapılandırılan adı yeniden
uygular. Gerçek yukarı akış yerel adları (örneğin `gpt-5.6-sol` → "GPT-5.6-Sol")
sabitlenmiş yukarı akış anlık görüntüsünden gelir ve özel bir görünen ad
tarafından asla geçersiz kılınmaz.

### Harici sağlayıcı yöneticileri

`config.toml` zaten `openai` veya `opencodex` dışında bir sağlayıcı seçiyorsa
OpenCodex dosyayı değiştirmeden bırakır ve profil yazmalarını, katalog/önbellek
yenilemesini ve Codex geçmiş meta verilerinin hem anlık hem de arka planda geri yüklenmesini atlar. Özel bir
sağlayıcıyı yöneten araçlar genellikle mevcut oturumları bu sağlayıcı kimliğiyle
etiketler; etkin kimliği değiştirmek bu bozulmamış oturumların Codex'in geçmiş
görünümünden kaybolmasına neden olabilir. Aynı koruma eski bir kök profil
tarafından seçilen harici bir sağlayıcı için de geçerlidir.

Codex sağlayıcı yapılandırmasının sahibi olarak tek bir araç tutun. OpenCodex'i
mevcut bir sağlayıcı yöneticisinin arkasında kullanmak için, bu sağlayıcıyı Chat
Completions çevirisiyle değil, Responses doğrudan geçişiyle (`Codex TOML'da
wire_api = "responses"`) `http://127.0.0.1:10100/v1` adresine yönlendirin. Proxy
API kimlik doğrulaması etkinleştirildiğinde yukarıdaki geri döngü olmayan
sağlayıcı formuyla eşleşecek şekilde `OPENCODEX_API_AUTH_TOKEN`'dan
`x-opencodex-api-key` değerini de iletin. OpenCodex'in yönlendirmeyi doğrudan
enjekte etmesine izin vermek için önce Codex'i yerleşik `openai` sağlayıcısına
geri döndürün ve kullanıcıya ait herhangi bir kök `openai_base_url`'i kaldırın,
ardından `ocx start`'ı yeniden çalıştırın.

### Katalog sorunlarını giderme

Codex'te bir model eksikse veya katalog sırası/görünürlüğü yanlış görünüyorsa
sırayla kontrol edin:

1. Sağlayıcıdaki **`selectedModels`** — boş olmayan bir izin listesi Codex'e
   yalnızca bu kimlikleri gösterir; boş veya atlanmış olması keşfedilen tüm
   modelleri gösterir. İzin listesinde olmayan bir kimlik kataloğa asla ulaşmaz.
2. **`disabledModels`** (üst düzey) — modelleri hem katalogdan hem de
   `/v1/models` listesinden gizler ve yalın yerel GPT slug'larını `visibility:
   "hide"` olarak değiştirir.
3. **Boş `models` ile `liveModels: false`** — canlı keşif kapalı olduğunda ve
   `models` boş veya atlandığında opencodex bu sağlayıcı için hiçbir
   yönlendirilmiş model göstermez.
4. **Cursor `GetUsableModels`** — Cursor adaptörü modelleri `/models` üzerinden
   değil, protobuf `GetUsableModels` RPC'si üzerinden keşfeder; bu nedenle
   Cursor tarafındaki bir değişiklik diğer sağlayıcılardan bağımsız olarak hangi
   kimliklerin görünür olduğunu değiştirebilir.
5. **Önbellek ve `ocx sync`** — canlı kataloglar yaklaşık beş dakika önbelleğe
   alınır (`modelCacheTtlMs`, varsayılan `300000`). Yeni bir getirmeye zorlamak
   ve kataloğu hemen yeniden yazmak için `ocx sync` çalıştırın.
6. **Çalışan Codex `app-server`** — uzun ömürlü bir Codex `app-server` (Desktop
   / CLI arka plan ana bilgisayarı) önceki listeyi bellekte tuttuğu sürece
   diskteki kataloğu yeniden yazmak yeterli değildir. `ocx sync` ve `ocx
   sync-cache` bu süreçler algılandığında uyarır. Bunları `ocx sync
   --restart-codex` ile yeniden başlatın (veya eşleşen `app-server` süreçlerini
   kendiniz durdurun), ardından yeni listenin görünmesi için Codex'in bunları
   yeniden oluşturmasına izin verin.

:::caution[Diğer yerel yazıcılar]
Katalog yazmaları (`opencodex-catalog.json`, `config.toml`) opencodex **içinde**
atomiktir, bu da yalnızca opencodex'e ait iki yazıcı yarıştığında yarı yazılmış
dosyaları önler. Bu, opencodex yazdıktan sonra başka bir yerel sürecin, dosya
izleyicisinin veya senkronizasyon ajanının katalog görünürlüğünü veya sırasını
yeniden yazmasını **engellemez**. Codex ayrı `models_cache.json` dosyasını tutar
ve bunu bağımsız olarak yenileyebilir, `opencodex-catalog.json` dosyasını
yeniden yazmadan görünür listeyi değiştirebilir. Proxy çalışırken modeller
beklenmedik bir şekilde değişirse yarışan yazıcıları durdurun veya yeniden
yapılandırın, ardından `ocx sync` çalıştırın — bu onaylanmış bir opencodex
hatası değil, harici bir yazıcı tehlikesidir.
:::

## Proxy bağlantı hataları

Codex yeniden dener ve ardından `stream disconnected before completion: error
sending request for url (http://127.0.0.1:10100/v1/responses)` gibi bir hatayla
başarısız olursa — veya Claude Code benzer bir bağlantı hatası bildirirse —
opencodex proxy'si çalışmıyordur: yapılandırılmış portu hiçbir şey
dinlemiyordur, bu nedenle istemci bu ham bağlantı hatasını kendisi işler.
Proxy'yi yeniden başlatın:

```bash
ocx start              # ön plan
ocx service install    # kalıcı: girişte otomatik başlar ve çökmede yeniden doğar
```

`ocx status` proxy'nin çalışıp çalışmadığını gösterir ve çalışmadığında aynı
yeniden başlatma ipucunu yazdırır; `ocx doctor` yeniden başlatma güvenliğini
(servis/dolgu kapsamı) bildirir.

## Alt ajan seçicisi

Katalog senkronizasyonu seçilen alt ajan modellerini Codex için kullanılabilir
hale getirir; seçici sıralaması için [Codex App model
seçicisi](/tr/guides/codex-app-models/#subagent-selection) ve v1/base/v2
delegasyonu ve geri dönüş davranışı için [Alt Ajan
Arayüzü](/tr/guides/sub-agent-surface/) sayfasına bakın.

## Codex hesap ısınması

Codex hesap havuzuna bir ChatGPT hesabı eklendiğinde opencodex, Codex Responses
arka ucuna küçük bir akış isteği ile kalıcılıktan önce hesabı doğrular. İstek
gerçek bir Responses öğe dizisi kullanır (`input: [{ type: "message", ... }]`),
`response.completed` bekler ve varsayılan olarak `gpt-5.4-mini` kullanır. Bu
model HTTP 400 döndürürse `gpt-5.5` ile yeniden dener; ham yanıt gövdelerini
açığa çıkarmadan yapılandırılmış yukarı akış hata ayrıntıları ortaya çıkarılır.
Arka plan yeniden doğrulaması ayrıdır ve varsayılan olarak kapalıdır; yalnızca
Token Guardian etkinleştirildiğinde, `chatgpt` yenileme politikası `proactive`
olduğunda ve `tokenGuardian.codexWarmupEnabled` true olduğunda çalışır.

## Yerel Codex'i geri yükleme

opencodex sizi asla tuzağa düşürmez. **`ocx stop`, yerel Codex'e tamamen geri
dönen tek komuttur** — proxy'yi durdurur, kuruluysa arka plan servisini durdurur
ve enjekte edilen her satırı ve yönlendirilen katalog girdisini kaldırır,
böylece düz `codex` sanki opencodex hiç var olmamış gibi tam olarak çalışır:

```bash
ocx stop       # proxy'yi + servisi durdurun, yerel Codex'i geri yükleyin
ocx restore    # durdurmadan geri yükleyin  (takma ad: ocx eject)
ocx restore back # düz Codex'i çalışan proxy'ye yeniden yönlendirin
```

opencodex yönetilen bir [arka plan servisi](/tr/reference/cli/#ocx-service)
olarak çalıştığında `OCX_SERVICE=1` ayarlar, böylece servis odaklı bir yeniden
başlatma Codex yapılandırmasını **bozmaz** — yalnızca açık bir `ocx stop` / `ocx
service stop` yerel Codex'i geri yükler.
