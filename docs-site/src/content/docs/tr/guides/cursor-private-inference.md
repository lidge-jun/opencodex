---
title: Cursor Private Inference
description: macOS, Windows veya Linux üzerinde, genel bir tünel olmadan Cursor'ın yerel ajan derlemesinde opencodex üzerinden yönlendirilen modelleri kullanın.
---

Normal Cursor, kendi makinenizdeki bir proxy ile konuşamaz. "Override OpenAI Base URL" ayarını yaptığınızda Cursor'ın arka ucu istemi oluşturur ve URL'yi Cursor sunucularından çağırır; geri döngü, LAN ve özel adresler reddedilir. Bu yüzden Cursor ve yerel modelleri birleştiren topluluk tariflerinin hepsi ngrok, Cloudflare Tunnel veya bir VPS ile biter.

Cursor, ajan döngüsü yerel çalışan ve yapılandırdığınız OpenAI uyumlu ağ geçidini çağıran ikinci bir masaüstü derlemesi de sunar: **Cursor Private Inference**. opencodex'e yönlendirildiğinde, modellerinizi tünel, uygulama yaması veya TLS olmadan kullanır. Bu sayfa o derlemeyi anlatır.

## Başlamadan önce

Bu bölümü önce okuyun; çoğu kişinin gözden kaçırdığı kısım budur.

- **opencodex bu derlemeyi dağıtmaz.** Cursor da belgelemiyor. cursor.com üzerinden bağlantısı yoktur, haber verilmeden değişebilir veya artık kullanılamayabilir. Elinizde zaten yoksa bu rehber geçerli değildir; bunun yerine genel bir HTTPS uç noktasıyla topluluğun [`ocx-cursor`](https://www.npmjs.com/package/ocx-cursor) köprüsünü kullanın.
- **Cursor oturumu yine gereklidir.** Giriş ekranı ağ geçidi iletişim kutusundan önce gelir.
- **Cursor'ın kendi modelleri kullanılamaz.** Yerel modda seçici yalnızca ağ geçidinizin döndürdüklerini listeler. Tab tamamlama, Cursor kataloğu (Composer, Auto) ve Cloud Agents kapalıdır. Sağlayıcıyı yapılandırdıysanız Cursor sağlayıcı modellerine opencodex'in kendi `cursor/*` rotaları üzerinden yine ulaşabilirsiniz.
- **Her tur Cursor'ın yerel sistem istemini taşır**; ikinci ve sonraki turlarda yaklaşık 23 bin token. Model seçerken bunu bütçeye katın.
- **Normal Cursor ile aynı kimliği paylaşır.** Aynı paket kimliği, aynı `~/.cursor`, aynı `Application Support/Cursor` (macOS), `%APPDATA%\Cursor` (Windows) veya `~/.config/Cursor` (Linux) kullanılır. İkisini ayrı tutmak için `--user-data-dir <dir>` ile başlatın; ayarlarınızın kopyalanmasını istemiyorsanız ilk çalıştırmada "Import data from existing Cursor installation" kutusunu işaretlemeyin.

## Kurulu derlemeyi tanımlama

Her iki derleme Dock'ta "Cursor" adını ve aynı paket kimliğini kullanır; bu nedenle `product.json` dosyasını kontrol edin:

| Platform | product.json |
|---|---|
| macOS | `/Applications/Cursor Private Inference.app/Contents/Resources/app/product.json` |
| Windows | `%LOCALAPPDATA%\\Programs\\cursor-private-inference\\resources\\app\\product.json` |
| Linux | `<install root>/resources/app/product.json` (AppImage önce çıkarılmalıdır) |

Yerel ajan derlemesinde `nameLong` değeri `"Cursor Private Inference"`, normal derlemede `"Cursor"` olur; `version` derleme sürümüdür (bu metin yazıldığında 3.18.25). Kontrol panelindeki Integrations > Cursor kartı aynı denetimi yapar ve bulduklarını listeler. Yerel mod `product.json` içinde değil, çalışma alanı paketinde açılır; değiştirilecek bir bayrak yoktur: `nameLong` normal Cursor gösteriyorsa kurulum geri döngü ağ geçidine erişemez.

Ağ geçidiyle konuşan ajan döngüsü, aynı kurulum kökündeki `extensions/cursor-agent-exec/dist/main.js` dosyasında bulunur. opencodex, Cursor'ın akıl yürütme çabası tablosunu öğrenmek için onu salt okunur ve sınırlı biçimde okur; aşağıdaki "Modeller ve akıl yürütme çabası" bölümüne bakın.

## Ağ geçidini yapılandırma

opencodex çalışıyor olmalıdır (`ocx service status`). Aşağıdaki iki yoldan biri kullanılabilir; ikisi de aynı sonuca ulaşır.

**Uygulamada.** Settings → Models → Gateway → Configure gateway:

| Alan | Değer |
|---|---|
| Base URL | `http://127.0.0.1:10100/v1` (`/v1` ekleyin; düz `http://` geri döngü adresi kabul edilir) |
| API Key | servisiniz API kimlik doğrulaması kullanıyorsa `OPENCODEX_API_AUTH_TOKEN` değeri, aksi hâlde `opencodex-loopback` gibi herhangi bir yer tutucu |

**Refresh model list** düğmesine tıklayın. Seçici opencodex'in `/v1/models` listesiyle dolar; istediğiniz satırları açın.

**Ortam değişkenleriyle.** Uygulama başlangıçta bunları okur:

```text
CURSOR_LOCAL_AGENT_BASE_URL=http://127.0.0.1:10100/v1
CURSOR_LOCAL_AGENT_API_KEY=opencodex-loopback
CURSOR_LOCAL_AGENT_HEADERS=            # optional, newline-separated "Header-Name: value" lines
```

`CURSOR_LOCAL_AGENT_HEADERS`, `User-Agent` ve çözümlenmemiş `{...}` yer tutucularını reddeder; `{gitOrgRepo}` ve `{gitBranch}` genişletilir.

Öncelik yüksekten düşüğe şöyledir: model başına kimlik bilgileri → Settings içinde kaydedilmiş ağ geçidi → `CURSOR_LOCAL_AGENT_*` → `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` (uyumluluk geri dönüşü). Ortam değişkenleri kaydedilmiş ağ geçidini geçersiz kılmaz; ortamdan geçiş yapmak istiyorsanız önce Settings içindeki kaydı temizleyin.

Cursor Private Inference bir GUI uygulamasıdır; dolayısıyla etkileşimli kabuk profili tek başına yeterli değildir. Değişken, uygulamayı başlatan sürecin ortamında bulunmalıdır.

| İşletim sistemi | Nereye koymalı |
|---|---|
| macOS | Geçerli oturum için `launchctl setenv CURSOR_LOCAL_AGENT_BASE_URL http://127.0.0.1:10100/v1` veya kalıcı olması için `EnvironmentVariables` içeren bir LaunchAgent. Uygulamayı terminalden başlatmak da işe yarar. |
| Windows | `setx CURSOR_LOCAL_AGENT_BASE_URL http://127.0.0.1:10100/v1` (kullanıcı kapsamında; yeni süreçleri etkiler) veya System Properties → Environment Variables. Ardından uygulamayı yeniden başlatın. |
| Linux | Ekran yöneticisi oturumu için `~/.profile` ya da `~/.pam_environment`; masaüstü kullanıcı systemd oturumunda çalışıyorsa `systemctl --user set-environment CURSOR_LOCAL_AGENT_BASE_URL=http://127.0.0.1:10100/v1`. Terminalden başlatılan AppImage o kabuğun ortamını devralır. |

Derleme macOS (arm64, x64, universal), Windows (x64, arm64) ve Linux (x64, arm64) için vardır. Yapılandırma hepsinde aynıdır.

## Kontrol panelinden

opencodex kontrol panelinde Integrations altında bir **Cursor** sekmesi (`/#integrations/cursor`) bulunur. Cursor açısından salt okunurdur: Cursor'ın ayar veritabanına, anahtarlık girdisine veya uygulama paketine yazmaz; bu nedenle açılacak bir anahtar yoktur. Size değerleri verir ve uygulanıp uygulanmadıklarını gösterir.

- **Kurulu derlemeler.** Cursor Private Inference'ın (yol ve sürümle) ve normal Cursor'ın (yalnızca yolla) bulunup bulunmadığını gösterir. Yalnızca normal Cursor bulunursa sekme bunu belirtip buraya bağlantı verir: normal Cursor özel uç noktaları Cursor sunucuları üzerinden yönlendirir; bu nedenle genel tünel olmadan geri döngü proxy'sine erişemez.
- **Ağ geçidi değerleri.** Proxy'nin kendi dinleme portundaki Base URL'yi (çalışma zamanı kaydından; ters proxy arkasındaki kontrol paneli bile bu makinede Cursor'ın erişebileceği portu gösterir) ve Copy düğmesini sunar. API Key satırı bağlama türüne bağlıdır: kimlik bilgisi gerekmiyorsa `opencodex-loopback` ve Copy gösterilir; API kimlik doğrulaması açıksa veya herhangi bir opencodex API anahtarı yapılandırılmışsa kendi anahtarlarınızdan birini kullanmanızı söyler ve API Keys sekmesine bağlantı verir. Yalnızca `OPENCODEX_API_AUTH_TOKEN` değil, yapılandırılmış herhangi bir anahtar çalışır.
- **Bağlantı.** User-Agent başlığı tam olarak `Cursor/<version>` olan son `/v1/models` isteğini (Cursor'ın yerel ajan çalışma zamanının gönderdiği başlık), zamanı ve sürümüyle gösterir. Cursor proxy'yi çağırana kadar "never seen" yazar; Cursor'da **Refresh model list** düğmesine basmak durumu değiştirir. Sekme açıkken kart her 15 saniyede bir yenilenir.
- **Cursor'ın gösterecekleri.** opencodex'in bildirdiği modellerin Model / Reasoning / Context tablosudur (devre dışı modeller ve sağlayıcı izin listeleri ham listede olduğu gibi uygulanır). Sonraki bölümün kurallarını izler. Bu bir öngörüdür: Reasoning basamaklarını Cursor kendi tablosundan seçer.

## Modeller ve akıl yürütme çabası

Seçici, opencodex'in ham `/v1/models` listesidir. Model satırının **Reasoning** denetimi alıp almayacağını iki şey belirler:

1. opencodex satırda yetenekleri bildirmelidir (`api_types` ve bir `capabilities` nesnesi). v2.41'den itibaren bunu yapar. Daha eski proxy'ler modelleri gösterir ama çaba denetimi göstermez.
2. Model kimliği, son `/` öncesindeki her şey ve `@…` son eki çıkarıldıktan sonra Cursor'ın kendi çaba tablosuyla eşleşmelidir. Bu tablo uygulamanın içine derlenmiştir (`extensions/cursor-agent-exec/dist/main.js`); opencodex onu algılanan kurulumdan okur, böylece kontrol paneli öngörüsü Cursor güncellemelerini izler. Kart, hangi derlemeyi okuduğunu veya bulunamadığında "static mirror" bilgisini söyler. Basamakları opencodex değil Cursor belirler; hiçbir `/v1/models` alanı tabloya model ekleyemez. Aşağıdaki matris, statik yansının taşıdığı 3.18.25 anlık görüntüsüdür:

| Model kimliği (son `/` sonrasında) | Cursor'ın gösterdiği basamaklar | Aktarım alanı |
|---|---|---|
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | Low, Medium, High, Extra High (düşükten çok yükseğe) | `reasoning.effort` |
| `gpt-5`, `gpt-5.x` | Low, Medium, High, Extra High (düşükten çok yükseğe) | `reasoning.effort` |
| `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4.7`, `claude-opus-4.8` | Low, Medium, High, Extra High, Max (düşükten en yükseğe) | `output_config.effort` |
| `claude-opus-4.6`, `claude-opus-4.5`, `claude-sonnet-4.6` | Low, Medium, High, Max (düşükten en yükseğe) | `output_config.effort` |
| `grok-4.3`, `grok-4.5`, `grok-4.6`, `grok-build-latest` | Minimal, Low, Medium, High, Extra High (en düşükten çok yükseğe) | `reasoning_effort` |
| `gemini-*` (`supports_reasoning` gerektirir) | Minimal, Low, Medium, High | `reasoning_effort` |
| `claude-fable-5-1`, `kimi-k3` dâhil diğerleri | denetim yok | — |

Dolayısıyla `anthropic/claude-opus-5` çalışır; opencodex'in GPT-5.6 için `max`/`ultra` düzeylerine bu seçiciden erişilemez.

### Denetimi olmayan modeller

`anthropic/claude-fable-5-1`, `cursor/kimi-k3` ve tablo dışındaki diğer modeller Reasoning denetimi almaz. Ağ geçidi `supports_reasoning` bildirirse Cursor böyle her kimlik için şu günlük satırını yazar: "Local provider advertises reasoning support for a model with no hardcoded Bottlerocket effort family". Yine de çaba seçmenin iki yolu vardır:

- **Çaba satırları** (opencodex yapılandırmasında `cursorEffortRows: true`; varsayılan kapalı): ağ geçidi, tabloda olmayan modeller için çaba başına bir seçici girdisi yayımlar; örneğin `anthropic/claude-fable-5-1--high` veya `cursor/kimi-k3--max`. Her girdi, uygulanan çabayla temel modele yönlendirilir. Cursor'ın zaten işlediği modeller ek satır almaz; tam eşleşen bilinen model kimliği her zaman `--<effort>` sonekinin önüne geçer. Açtıktan sonra Refresh model list düğmesine basın. Kontrol paneli kartı model başına yayımlanan satırları sayar. Satır seçmek açık bir tercihtir; bu nedenle çabası istekteki `ocx-effort` yönergesinin de önüne geçer.
- **Sabit varsayılan** (sağlayıcıdaki `modelDefaultReasoningEfforts`): Cursor çaba göndermediğinde uygulanır.

### "Max" iki farklı anlama gelir

Normal Cursor bazı modellerin yanında **Max** anahtarı gösterir. Bu, akıl yürütme düzeyi değil, daha büyük bağlam penceresi olan Max Mode'dur. Yerel ajan derlemesinde aynı fikir model menüsünde **Context** girdisi olarak görünür; opencodex bunu yerel GPT-5.6 ailesi için açar: **272K** (varsayılan) veya **922K** (daha pahalı olduğu belirtilen 1M etkinleştirmesi). Seçtiğiniz değer o turun bağlamını sınırlar. Yönlendirilen modeller tek pencere gösterir ve Context girdisi göstermez; sağlayıcının 922K altındaki bağlam sınırı yerel satırlardaki girdiyi de kaldırır.

Akıl yürütme çabası **Max** (opencodex'in `max`/`ultra` değeri) diğer anlamdır ve buna erişilemez: Cursor çaba basamaklarını ağ geçidinden değil kendi tablosundan alır; GPT-5.6 girdisi Extra High düzeyinde biter.

opencodex `api_types` içinde `responses` bildirdiği için bu derleme ajan turlarını `/v1/chat/completions` yerine `reasoning.effort` ile `/v1/responses` adresine gönderir.

Bu aktarım seçiminin Claude satırları için yan etkisi vardır: Cursor Claude çabasını yalnızca Anthropic Messages aktarımındaki `output_config.effort` olarak gönderir. Bu yüzden `/v1` Base URL ile, denetim gösteren Claude satırı bile sağlayıcı varsayılanında çalışır. `/messages` ile biten Base URL sonucu tersine çevirir: Claude çabası gönderilir, OpenAI ailesinin çabası düşer. Tek ağ geçidi girdisi iki aileye birden hizmet edemez; yukarıdaki çaba satırları, çabayı opencodex'in uygulaması sayesinde bunu aşar.

## Doğrulama

`ocx observe logs`, turları `inboundProtocol: responses` ve `admissionKind: loopback` ile gösterir.

| Belirti | Denetim |
|---|---|
| Ağ geçidinden 401 | API Key, `OPENCODEX_API_AUTH_TOKEN` ile eşleşmiyor; API kimlik doğrulaması olmayan geri döngü bağlamında her değer çalışır |
| seçici boş | opencodex çalışmıyor veya Base URL'de `/v1` eksik; düzelttikten sonra Refresh model list düğmesine basın |
| modeller listeleniyor ama Reasoning denetimi yok | opencodex v2.41'den eski veya kimlik Cursor tablosunda yok (kontrol paneli bunu — ile işaretler); `cursorEffortRows` açın ya da sağlayıcı varsayılanı belirleyin |
| şema değişikliği görünmüyor | Cursor `/models` listesini Base URL dizesi başına süresiz önbelleğe alır; Refresh model list yeniden okur. Aksi hâlde uygulamayı yeniden başlatın veya URL'nin farklı yazımını (`localhost` yerine `127.0.0.1`) geçici olarak kaydedin |
| ilk turda 23 bin token | beklenen durum; bu Cursor'ın yerel sistem istemidir |
