---
title: Mimari
description: opencodex iç yapısı — modül haritası, AdapterEvent köprüsü, istek ayrıştırıcısı ve önbellekleme.
---

opencodex tek bir Bun sürecidir. Bir istek OpenAI Responses olarak girer, dahili
bir modele normalleştirilir, yönlendirilir, bir adaptör aracılığıyla bir
sağlayıcıya gönderilir ve Responses SSE'ye geri köprülenir. Uçtan uca akış için
[Nasıl Çalışır](/tr/getting-started/how-it-works/) sayfasına bakın.

## Modül haritası

```
src/
├── cli/                # ocx komut dağıtımı, başlatma, durum, sağlayıcı komutları
├── server/             # Bun.serve, /v1/* proxy, /api/* yönetim API'si, WS köprüsü
├── codex/              # Codex yapılandırma enjeksiyonu, katalog senkronizasyonu, kimlik doğrulama/hesap entegrasyonu
├── providers/          # sağlayıcı meta verileri, API anahtarı havuzu, kota ve etiketler
├── adapters/           # yedi hat adaptörü, paylaşılan koruyucular/yardımcılar, Cursor protobuf aktarımı
├── oauth/              # OAuth sağlayıcıları, API anahtarı kataloğu, belirteç deposu/yenileme
├── usage/              # istek kullanımı çıkarma, JSONL günlükleri, özetler, toplamlar
├── lib/                # çalışma zamanı, süreç, yeniden deneme, gizlilik, belirteç tahmin yardımcıları
├── web-search/         # web arama sidecar'ı (sentetik araç, döngü, yürütücü, ayrıştırıcı)
├── vision/             # vizyon sidecar'ı (açıklama + plan)
├── config.ts           # ~/.opencodex/config.json, varsayılanlar, PID, ortam çözümleme
├── router.ts           # model kimliği → sağlayıcı + adaptör
├── bridge.ts           # AdapterEvent akışı → Responses SSE / JSON
├── reasoning-effort.ts # akıl yürütme çabası çevirisi, sabitleme ve katalog seviyeleri
├── responses/
│   ├── parser.ts       # Responses isteği → OcxParsedRequest
│   ├── schema.ts       # Zod doğrulaması
│   └── compaction.ts   # uzak sıkıştırma istemleri, zarflar, kompakt geçmiş
├── service.ts          # launchd / systemd / Görev Zamanlayıcı arka plan servisi
├── types.ts            # temel arayüzler + yardımcılar (modelInList, namespacedToolName)
└── index.ts            # genel giriş noktası
```

Eskiden büyük olan üç giriş dosyası artık cepheler (facades) olarak uyumluluğu
korur: `codex/catalog.ts` odaklanmış yedi `codex/catalog/*.ts` modülünü dışa
aktarır, `server/management-api.ts` dokuz `server/management/*.ts` modülüne
dağıtır ve `server/responses.ts` beş `server/responses/*.ts` modülünü dışa
aktarır.

## İstek akışı

`server/index.ts` HTTP sınırına sahiptir ve Responses veri düzlemini
`server/responses.ts` cephesine ve onun `server/responses/*.ts` modüllerine
devreder:

1. `server/index.ts` CORS ve API kimlik doğrulamasını uygular, boşaltma
   sırasında yeni işleri reddeder ve istek yaşam döngüsü meta verilerini
   kaydeder. `GET /v1/models`, `POST /v1/responses`, `POST
   /v1/responses/compact`, `POST /v1/images/generations` / `POST
   /v1/images/edits` (codex'in yerleşik `image_gen` aracı için
   `server/images.ts` tarafından bir OpenAI ailesi yukarı akışına iletilir),
   `POST /v1/live` / `POST /v1/realtime/calls` (ChatGPT / Codex App sesi ve
   OpenAI Realtime çağrı oluşturma, `server/live.ts` tarafından iletilir),
   `/v1/live/{callId}` (ve `/v1/realtime?call_id=`) üzerindeki yan bant
   WebSocket katılımlarını ve `/v1/responses` üzerindeki isteğe bağlı WebSocket
   yükseltmesini sunar.
2. `server/responses/core.ts` JSON'ı açar ve ayrıştırır, kullanılabilir
   olduğunda yerel olarak hatırlanan `previous_response_id` girdisini
   genişletir, ardından `responses/parser.ts`'yi çağırır.
3. `router.ts` yalın veya `sağlayıcı/model` kimliğini çözer. Sunucu daha sonra
   Codex hesap bağlılığını çözer, gerektiğinde sağlayıcı OAuth'unu yeniler ve
   seçilen kimlik bilgisini rotaya uygular.
4. Ana çağrıdan önce `vision/`, `noVisionModels` içindeki modeller için
   görselleri açıklar; güvenli bir sidecar yolu yoksa görseller salt metin bir
   yukarı akışa gönderilmek yerine kaldırılır.
5. `server/adapter-resolve.ts` modele özgü herhangi bir hat geçersiz kılmasını
   uygular ve yedi adaptörden birini oluşturur. Responses doğrudan geçişi yerel
   gövdeyi iletir, Cursor çift yönlü `runTurn` aktarımını çalıştırır ve çevrilen
   adaptörler bir yukarı akış isteği oluşturur/getirir/ayrıştırır.
6. Barındırılan bir `web_search` aracına sahip yönlendirilen modeller için
   `web-search/` sentetik bir fonksiyon sunar, gerçek aramayı ChatGPT sidecar'ı
   aracılığıyla yürütür, sonuçları yönlendirilen modele geri besler ve
   yapılandırılmış döngü sınırı içinde tekrarlar.
7. `bridge.ts` Responses SSE veya JSON üretir. `server/request-log.ts` ve
   `usage/` yanıtı değiştirmeden uç durumu, gecikmeyi, sağlayıcı/model
   etiketlerini ve en iyi çaba belirteç kullanımını toplar.

## Ayrıştırıcı (Parser)

`responses/parser.ts`, gelen isteği `responses/schema.ts` (Zod) ile doğrular,
ardından bir `OcxParsedRequest` oluşturur:

- **Mesajlar** — `input` öğeleri normalleştirilmiş bir `OcxMessage[]` haline
  gelir: user / developer / assistant / toolResult. `reasoning` öğeleri düşünme
  blokları haline gelir; `function_call`, `custom_tool_call` ve
  `tool_search_call` öğeleri araç çağrıları haline gelir; `*_output`
  karşılıkları araç sonuçları haline gelir.
- **Araçlar** — fonksiyon araçları doğrudan geçer; **ad alanlı (MCP) araçları**
  `ad_alani__ad` olarak **düzleştirilir** (ve dönüş yolunda geri yüklenir);
  **serbest biçimli** araçlar (örneğin `apply_patch`) ve **tool_search** keşif
  araçları bayraklanır; **barındırılan araçlar** (`web_search`, görsel üretimi,
  …) bırakılır ve yalnızca sidecar bunları işleyecekse yeniden enjekte edilir.
- **Görseller** — asla metin olarak satır içine alınmaz, gerçek içerik parçaları
  olarak korunur (veri URL'si veya uzak https).
- **Özellik bayrakları** — `_webSearch` (barındırılan web araması talep edildi),
  `_structuredOutput` (`text.format` json_schema / json_object'tir) ve
  `_compactionRequest` (uzak sıkıştırma v2).

## Köprü (Bridge)

`bridge.ts`, adaptörün dahili `AdapterEvent` akışını Codex'in anladığı Responses
SSE'ye dönüştürür:

| AdapterEvent | Yayınlanan Responses SSE |
| --- | --- |
| `text_delta` | `response.output_text.delta` → `…done`, `response.content_part.done`, `response.output_item.done` |
| `thinking_delta` | `response.reasoning_summary_text.delta` → `…done`, öğe kapanışı |
| `reasoning_raw_delta` | Ham bir `reasoning_text` öğesi (veya gizli bir gidiş-dönüş zarfı) |
| `thinking_signature` / `redacted_thinking` | Bir `encrypted_content` akıl yürütme zarfında korunur |
| `tool_call_start` | `response.output_item.added` (tip: `function_call` / `custom_tool_call` / `tool_search_call`) |
| `tool_call_delta` | `response.function_call_arguments.delta` (serbest biçimli / tool_search için atlanır) |
| `tool_call_end` | `response.function_call_arguments.done` → `response.output_item.done` |
| `web_search_call_begin` / `web_search_call_end` | Canlı bir `web_search_call` öğesi artı URL alıntıları |
| `heartbeat` | Yukarı akış etkinliğini işaretler; kullanıcı tarafından görülebilen çıktı öğesi yoktur |
| `done` | `response.completed` (kullanım ile birlikte) |
| `error` | `response.failed` (`last_error` ile birlikte) |

Köprü ayrıca bir **kalp atışı canlı tutması (heartbeat keep-alive)** çalıştırır
(RC3): yukarı akış sessizliği sırasında Codex'in boşta kalma zamanlayıcısını
yeniden kurmak için her 2 saniyede bir ayrıştırıcı tarafından yok sayılan
`: opencodex heartbeat` SSE yorum satırı yayar. Yorum satırı, olay üretmeden her
eventsource ayrıştırıcısı tarafından atılır, böylece katı Responses kod çözücüleri
asla bilinmeyen bir varyant görmez. Varsayılan **durma süresi sınırı** 300
saniyedir (`stallTimeoutSec`); bu sınıra ulaşılması yukarı akışı iptal eder ve
`upstream_stall_timeout` nedeni ile `response.incomplete` yayar, böylece askıda
kalan bir bağlantının Codex'i süresiz olarak engellemesi önlenir.

Araç çağrıları ad alanı haritası, serbest biçimli küme ve ayrıştırıcı tarafından
yakalanan araç arama kümesi kullanılarak üç Responses öğe türüne ayrılır —
böylece MCP ad alanları, `apply_patch` tarzı serbest biçimli araçlar ve istemci
tarafından yürütülen `tool_search` gidiş-dönüş yapar. Bir `buildResponseJSON()`
varyantı aynı olaylardan tek bir akışsız yanıt nesnesi üretir.

## Yönetim API'si, OAuth ve kullanım

`server/management-api.ts` kontrol panelini destekler ve odaklanmış rota
gruplarını `server/management/*.ts` modüllerine dağıtır. `/api/*` rotaları
güvenli yapılandırma/ayarları, sağlayıcı CRUD ve anahtar havuzlarını, model
seçimi/bağlam sınırları/v2 denetimlerini, katalog senkronizasyonunu, tanılama ve
hata ayıklama günlüklerini, kullanım ve kotaları, sidecar ayarlarını,
güncellemeleri, oluşturulan istemci API anahtarlarını, OAuth giriş/durum/çıkış
ve hesap seçimini, Codex hesap yönetimini ve zarif durdurmayı kapsar.
`server/auth-cors.ts`, proxy geri döngünün ötesine bağlandığında hem `/api/*`
hem de `/v1/*` için `OPENCODEX_API_AUTH_TOKEN` gerektirir; yapılandırılmış
`corsAllowOrigins` girdileri yerel kaynak izin listesini genişletir.

OAuth uygulamaları `oauth/` içinde yer alır; erişim belirteçleri yönlendirilen
bir aramadan hemen önce yüklenir veya yenilenir, `oauth/token-guardian.ts` ise
yalnızca politikası izin veren sağlayıcıları proaktif olarak yenileyebilir.
Yenileme süreç içi tek uçuş, hesap başına dosya kilidi ve nesil CAS ile koordine
edilir, böylece eşzamanlı yazıcılar daha yeni bir kimlik bilgisini ezemez.
Paylaşılan bir sağlık projeksiyonu (`oauth/health.ts`) `ocx status`, `ocx
doctor`, yönetim API'si ve kontrol panelini besler. Codex/ChatGPT havuz kimlik
bilgileri ve işleme özel iş parçacığı bağlılığı `codex/` altında yaşar ve
yönetim yanıtlarının dışında tutulur; bağlılık `401` / `403` / `429`'da
temizlenir (hız sınırları boyunca sabitlenmez) ve yeniden başlatmalar arasında
kalıcı değildir. İstek kullanımı `OcxUsage` olarak normalleştirilir, Responses
uç olaylarında ortaya çıkarılır ve kontrol paneli ile isteğe bağlı JSONL
tanılamaları için `usage/` tarafından toplanır.

## Aktarım ve sıkıştırma

`server/index.ts` varsayılan olarak `/v1/responses` üzerinde HTTP/SSE sunar.
Codex `websockets` `false` iken bir Responses WebSocket yükseltmesi denerse
opencodex `426 upgrade_required` döndürür; Codex daha sonra bu oturum için
HTTP'ye geri döner. `"websockets": true` ayarlandığında aynı uç nokta
yükseltmeyi kabul eder ve WebSocket köprüsünü kullanır.

Codex bağlam sıkıştırması yönlendirilen modeller için çalışır.
`server/responses/compact.ts`, dahili bir yönlendirilen özetleme turu
çalıştırarak ve sıkıştırılmış geçmişi döndürerek `POST /v1/responses/compact`'ı
işlerken, `responses/parser.ts` ve `bridge.ts` tam olarak bir sentetik
`compaction` çıktı öğesi yayarak uzak sıkıştırma v2 `compaction_trigger`
turlarını işler.

## Önbellekleme ve katalog

- `codex/model-cache.ts`, getirme başarısız olduğunda eski bir geri dönüşle
  birlikte canlı `/models` sonuçlarının sağlayıcı başına bellek içi bir TTL
  önbelleğini (Codex'in kendi önbelleğiyle eşleşen varsayılan 5 dakika) tutar.
- `codex/catalog.ts` cephesi aracılığıyla dışa aktarılan
  `codex/catalog/sync.ts`, yönlendirilen modelleri ad alanlı girdiler olarak
  Codex'in kataloğuyla birleştirir, öne çıkan [alt ajan
  modellerini](/tr/guides/codex-integration/#the-subagent-picker) ilk sıraya
  koyar, `disabledModels`'ı filtreler ve bozulmamış kataloğu tek seferlik bir
  yedekten tamamen geri yükleyebilir.

## Akıl yürütme çabası

`reasoning-effort.ts`, Codex'in akıl yürütme etiketlerini her sağlayıcının hat
değerlerine çevirir. Codex kataloğu Codex'in kabul ettiği etiketleri bildirir
(`low` / `medium` / `high` / `xhigh` / `max`), ancak yukarı akış sağlayıcıları
yalnızca daha küçük bir alt kümeyi destekleyebilir veya gerçek bir takma ad
gerektirebilir. Modül:

- Kurallı `CODEX_REASONING_LEVELS` ve sıralama düzenlerini tanımlar.
- Tam seviye kullanılamadığında talep edilen çabayı en yakın desteklenen katmana
  sabitler.
- Özel hat eşlemeleri için model başına ve sağlayıcı başına `reasoningEffortMap`
  geçersiz kılmalarını çözer.
- `noReasoningModels` içinde listelenen modeller için çabayı tamamen bırakır.

Qwen3.8-Max, eski Qwen3.x bütçe sözleşmesine açık bir doğrudan çaba
istisnasıdır. Alibaba Token Plan yukarı akışta desteklenen merdivenini `low`,
`medium` ve `xhigh` (varsayılan) olarak kaydeder ve etkin değeri
`reasoning_effort` olarak gönderir; yalnızca Codex uyumluluk üstleri hatta
`xhigh`'a sabitlenir. Çalışma zamanı kayıt defteri zenginleştirmesi, bu modeli
hala bir `thinking_budget` modeli olarak sınıflandıran daha eski kalıcı önayar
meta verilerini onarır.

## Temel tipler

Dahili model `types.ts` içinde yer alır: `OcxParsedRequest`, `OcxContext`,
`OcxMessage` birleşimi, `OcxContentPart` (metin / görsel), `OcxToolCall`,
`OcxTool`, `AdapterEvent` ve yapılandırma tipleri (`OcxConfig`,
`OcxProviderConfig`). İki yardımcı yaygın olarak kullanılır:
`namespacedToolName()` ve `modelInList()` (`noVisionModels` /
`noReasoningModels` için toleranslı `:size` etiketi eşleştirmesi).

