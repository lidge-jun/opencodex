---
title: Adaptörler
description: Yedi sağlayıcı adaptörü — her birinin neyi hedeflediği, istekleri nasıl oluşturduğu ve kendine özgü yanları.
---

Bir **adaptör**, opencodex'in dahili istek/yanıt modeli ile bir sağlayıcının hat
formatı arasında çeviri yapar. Her adaptör `ProviderAdapter` arayüzünü
(`src/adapters/base.ts`) uygular:

```ts
interface ProviderAdapter {
  name: string;
  buildRequest(parsed, incoming?): AdapterRequest | Promise<AdapterRequest>;
  fetchResponse?(request, context): Promise<Response>;   // özel yeniden deneme/aktarım
  parseStream(response): AsyncGenerator<AdapterEvent>;
  parseResponse?(response): Promise<AdapterEvent[]>;   // akışsız
  runTurn?(parsed, incoming, emit): Promise<void>;      // çift yönlü aktarım
}
```

`buildRequest`, bir `OcxParsedRequest`'i bir yukarı akış HTTP isteğine indirir;
`parseStream` / `parseResponse`, sağlayıcının yanıtını tekrar dahili
`AdapterEvent`'lere yükseltir. `fetchResponse`, bir adaptörün yeniden
denemelere/zaman aşımlarına sahip olmasına izin verirken `runTurn`, tek bir HTTP
getirmesini takip eden tek bir yanıt akışı olarak temsil edilemeyen aktarımları
destekler. [`bridge.ts`](/tr/reference/architecture/#kopru-bridge) daha sonra
olayları Responses SSE'ye dönüştürür.

## `openai-chat`

**Hedefler:** OpenAI **Chat Completions** (`POST {baseUrl}/chat/completions`;
`baseUrl` üzerindeki sondaki `/chat/completions` veya `/` önce kaldırılır) ve
her uyumlu sağlayıcı — xAI, Kimi, DeepSeek, GLM, Groq, OpenRouter, Ollama (yerel
ve bulut) ve daha fazlası.
**Kimlik Doğrulama:** `key` (Bearer).

- Dahili mesajları OpenAI rollerine dönüştürür; araçları `{type:"function",
  function:{…}}` ve `tool_choice` (`auto`/`none`/`required` veya adlandırılmış
  bir fonksiyon) ile eşler.
- **Araç sonucu görselleri**, `role:"tool"` içeriği salt metin olduğundan, araç
  turu kapandıktan sonra yayınlanan bir takip kullanıcı vizyon mesajında
  (`image_url` parçaları) gider; `[image]` işaretçisi çapa olarak araç mesajında
  kalır.
- Yönlendirilen modellerin OpenAI olduğunu iddia etmemesi için **Codex'in GPT-5
  kimlik istemini** modelden bağımsız bir girişe **yeniden yazar**.
- Tam bir katman kullanılamadığında **`reasoning_effort`'ı modelin bildirilen
  alt kümesine sabitler**; bir sağlayıcı açıkça bir takma ad yapılandırmadıkça
  `xhigh` ve `max` ayrı etiketler olarak kalır. Adaptör,
  `provider.noReasoningModels` içindeki kimlikler için bunu **tamamen atlar**.
- `delta.content` (metin), `delta.reasoning_content` (düşünme) ve
  `delta.tool_calls[]` akışını sağlar; `usage` toplar.
- ClinePass, canlı olarak doğrulanmış `reasoning: { enabled: true, effort: "low"
  }` (veya akıl yürütme devre dışı bırakıldığında `{ enabled: false }`) ağ
  geçidi formatını kullanır; genel API belgeleri şu anda bu istek şeklini
  belirtmemektedir. Adaptör diğer çaba isteklerini doğrulanmış `low` katmanına
  sabitler, `delta.reasoning_content` veya `delta.reasoning`'den gelen akıl
  yürütme farklarını kabul eder, `stream_options.include_usage` ile akışlı
  kullanım ister ve akışsız yanıt zarflarından kullanımı okur.

## `openai-responses`

**Hedefler:** OpenAI **Responses API**. **`passthrough: true`** — ham istek
gövdesini iletir ve yanıtı **çevrilmemiş** olarak geri akışlar.
**Kimlik Doğrulama:** `forward` (arayanın başlıklarını iletme) veya `key`.

`key` kimlik doğrulaması için [`retryOn429`](/tr/reference/configuration/)
burada da geçerlidir: akış öncesi bir 429, çevrilen `openai-chat` / Anthropic
istek yolunda olduğu gibi herhangi bir işlemden önce aynı anahtar üzerinde aynı
isteği bekler ve yeniden oynatır. Özel `runTurn` aktarımları HTTP yeniden deneme
döngüsünün bir parçası değildir.

- DeepSeek'in durum bilgisi olmayan Responses ayrıştırıcısı sağlayıcı kapsamlı
  geçmiş normalleştirmesi alır: kanca ile enjekte edilen bağlam belirsiz olmayan
  bir araç çağrısı/sonuç grubundan sonra taşınır. Paralel çağrılar eşleşen
  çıktılarından önce gruplandırılmış olarak kalır, böylece her çağrı akıl
  yürütme taşıyan asistan turunda kalır. Toleranslı sağlayıcılar ve belirsiz
  yinelenen, eksik veya sıra dışı çağrı kimlikleri orijinal girdi sıralarını
  korur.

- `forward` URL'si → `{baseUrl}/responses`. Bir `key` sağlayıcısı varsayılan
  olarak eski `{baseUrl}/v1/responses` yapısını kullanır.
- Bir `key` sağlayıcısı doğrulanmış bir göreli `responsesPath` ayarlayabilir;
  adaptör `baseUrl`'den sondaki bir eğik çizgiyi kaldırır ve
  `{trimmedBaseUrl}{responsesPath}` gönderir. Ark Agent Plan için
  `responsesPath: "/responses"` ile `baseUrl:
  "https://ark.cn-beijing.volces.com/api/plan/v3"` kullanın.
- `forward` modunda yalnızca güvenli bir başlık izin listesi iletilir
  (`FORWARD_HEADERS`): yetkilendirme, ChatGPT hesap kimliği ve OpenAI
  beta/originator/oturum başlıkları. Bu, [sidecar'ları](/tr/guides/sidecars/) da
  çalıştıran ChatGPT girişi yoludur.

## `anthropic`

**Hedefler:** Anthropic **Messages** (`/v1/messages`).
**Kimlik Doğrulama:** `key` (varsayılan olarak `x-api-key` veya
`apiKeyTransport: "bearer"` ile `Authorization: Bearer`) veya `oauth` (Claude
Pro/Max için Bearer + `anthropic-beta`).

- Mesajları Anthropic içerik bloklarına (metin, base64 görsel, `tool_use`,
  `thinking`) dönüştürür.
- **Genişletilmiş düşünme matematiği:** Anthropic `max_tokens >
  thinking.budget_tokens` gerektirir. Adaptör akıl yürütme çabasını bir bütçeye
  (en az 1024 … en çok 32000) eşler, ardından çıktı payı ile güvenli bir
  `max_tokens` hesaplar ve düşünme etkinleştirildiğinde
  **`temperature`/`top_p`'yi bırakır** (Anthropic orada bunları yasaklar).
- **Yapılandırılmış çıktı:** `type: "json_schema"` içeren Responses
  `text.format` ve Chat Completions `response_format` istekleri Anthropic
  `output_config.format` haline gelir. Format, uyumlu bir
  `output_config.effort`'ı koruyarak mevcut bir uyarlanabilir düşünme çıktı
  yapılandırmasıyla birleşir. Yönlendirilen Anthropic Messages istekleri
  saklanan OAuth çevirisi aracılığıyla aynı formatı korur. Adaptör, Anthropic
  TypeScript SDK'sının desteklenen JSON Şeması alt kümesini yansıtır:
  desteklenmeyen kısıtlamalar model rehberliği olarak `description` içine
  taşınır, `oneOf` `anyOf` haline gelir ve nesne şemaları `additionalProperties:
  false` alır. Bir kök `$ref`, yerel referansın çözümlenebilir kalması için
  bitişik `$defs`'ini korur. Şema `name`, zarf `description` ve `strict` gibi
  OpenAI zarf alanları Anthropic hat formatının bir parçası değildir. Şemasız
  JSON nesne modunun Anthropic eşdeğeri yoktur ve çevrilmez.
- Her zaman `anthropic-version: 2023-06-01` gönderir. `content_block_delta`
  (`text_delta`, `thinking_delta`, uyumlu `reasoning_delta`, `input_json_delta`)
  akışını sağlar. SSE kod çözücü getirme parçaları boyunca olay durumunu korur
  ve sonunda yeni satır olmayan bir terminal `message_stop`'u kabul eder.
- İstemci araçlarına sahip yönlendirilmiş Anthropic Responses turları için
  sınırlı bir terminal koruyucusu, kullanıcının bir eylem talep ettiği ancak
  Claude'un bir yürütme iddiasıyla ve hiçbir araç çağrısı olmadan bittiği yüksek
  güvenilirlikli durumu algılar. En fazla bir dahili devam gerçekleştirir;
  normal yanıtlar, açıklama soruları, araç kullanan turlar ve aktarımı
  tamamlanmamış yanıtlar otomatik olarak yeniden denenmez.

## `google`

**Hedefler:** Google **Gemini**, **Vertex AI** ve Antigravity **Cloud Code
Assist**. AI Studio `/v1beta/models/{model}:streamGenerateContent` kullanır;
diğer modlar yerel Google uç noktalarını kullanır.
**Kimlik Doğrulama:** `googleMode` tarafından seçilen API anahtarı, Vertex ADC
veya Google Antigravity OAuth.

- Sistem istemi → `systemInstruction`; mesajlar → `contents[]` (asistan →
  `model`); araçlar → `functionDeclarations`. Veri-URL görselleri →
  `inline_data`.
- Gemini araç çağrısı kimliklerini atladığında bunlar sentezlenir. Vertex ve
  Antigravity, araç sonucu devamlarının Gemini akıl yürütme sürekliliğini
  koruması için donuk `thoughtSignature` değerlerini korur ve yeniden oynatır.
  İmza önbelleğinin anlık görüntüsü yapılandırma dizinine alınır, böylece
  devamlar proxy yeniden başlatmalarında da hayatta kalır.
- **Satır içi görsel çıktısı:** model açık görsel yetenekli sohbet
  kimliklerinden biri olduğunda (`gemini-3.1-flash-image`,
  `gemini-2.0-flash-preview-image-generation` veya
  `gemini-3-pro-image-preview`), adaptör `responseModalities: ["TEXT", "IMAGE"]`
  gönderir. `gemini-3-pro-image` gibi bağımsız medya oluşturma kimlikleri dahil
  edilmez. Döndürülen `inlineData` parçaları yapılandırılmış OpenCodex
  `artifacts/` dizini altında somutlaştırılır ve kimliği doğrulanmış donuk
  `/v1/opencodex/artifacts/<id>` rotasına markdown görsel bağlantıları olarak
  açığa çıkarılır (`file:` URI'leri veya ana bilgisayar dosya sistemi yolları
  değil). Her görsel 50 MB ve her yanıt 100 MB çözülmüş veri ile
  sınırlandırılmıştır; hatalı biçimlendirilmiş base64 yükleri reddedilir. Sayı
  200 dosyayı aştığında yapılar otomatik olarak budanır.

## `kiro`

**Hedefler:** Kiro tarafından kullanılan Amazon CodeWhisperer Streaming
`GenerateAssistantResponse` hizmeti (`https://runtime.{region}.kiro.dev/`).
**Kimlik Doğrulama:** Kiro kimlik bilgisinden bölge/profil meta verileriyle
birlikte Bearer olarak Kiro OAuth erişim belirteci.

- Kiro `conversationState` oluşturur, Codex araçlarını ve araç sonuçlarını eşler
  ve Kiro hattı tarafından desteklenen görsel bloklarını gönderir.
- `application/vnd.amazon.eventstream` kodunu çözer, metin/düşünme/araç
  olaylarını yeniden oluşturur, kesilmiş araç JSON'ını algılar ve yukarı akış
  belirteç sayılarını döndürmediği için kullanımı tahmin eder.
- Özel olduğunda yapılandırılmış `baseUrl`'i birebir kullanır. Kurallı bir
  `runtime.{region}.kiro.dev` URL'si içe aktarılan kimlik bilgisinin API
  bölgesini takip eder; bir uç nokta, imza, DNS veya bağlantı hatasından sonra
  `q.{region}.amazonaws.com`'a tek bir sınırlı geri dönüş için yalnızca bu
  kurallı şekil uygundur.
- Yeniden oynatma güvenli bağlantı sıfırlama kurtarmasına, bu tek uygun uç nokta
  geri dönüşüne, HTTP 401'den sonra bir OAuth yenileme/yeniden oynatmaya ve
  geçici Kiro 429'ları için sınırlı kurtarmaya sahiptir. Paylaşılan bir soğuma
  süresi ve soğuma sonrası tek bir araştırma, eşzamanlı isteklerin bağımsız
  yeniden deneme bütçelerini tüketmesini önler; sabit kota hataları ve sıradan
  hizmet hataları yeniden oynatılmaz.
- Akışsız ayrıştırıcısı web arama döngüsü için aynı olay akışını boşaltır.

### Tamamlama anlambilimi

Kiro asistan metni kendine ait güvenilir bir tur sonu aşaması taşımaz. Terminal
`metadataEvent` yerel bir `stopReason` taşıyabilir, ancak Kiro ilerleme
düzyazısını `END_TURN` olarak etiketleyebilir. Araç etkin turlarda `END_TURN` ve
`STOP_SEQUENCE` bu nedenle yalnızca çıkarımın durduğunu kanıtlar; sıradan metin
yorum olarak kalır ve tek sınırlı tamamlama doğrulamasına girer.

`END_TURN`, `STOP_SEQUENCE` veya eksik bir durma nedeni uyumluluk yolunu
kullanabilir. Diğer açık nedenler yukarı akışta çıkarımı zaten sonlandırmıştır,
bu nedenle adaptör başka bir model isteği harcamak yerine bunları bildirir: bir
çıktı belirteci sınırı istemcinin devam edebileceği tamamlanmamış çıktı olarak
görünürken, bağlam penceresi tükenmesi kesilmiş çıktı olarak değil, yeniden
denenemez bir bağlam uzunluğu hatası olarak görünür. Filtreleme ve korkuluk
durmaları filtrelenmiş tamamlanmamış çıktı olarak görünür ve gerçek bir araç
çağrısı olmadan gelen bir `TOOL_USE` durması ilerleme olarak değerlendirilmek
yerine bir çelişki olarak bildirilir.

Sıradan bir istemci aracı mevcut olduğunda opencodex yukarı akış isteğine özel
bir `codex_kiro_final_answer` aracı ekler; ilerleme metni yorum olarak akar ve
turu sonlandıramaz. Adaptör özel çağrıyı tüketir, yanıtını son metin olarak
yayar ve özel aracı asla Codex veya Claude Code'a açığa çıkarmaz. Durma nedeni
yalnızca akışın sonunda geldiğinden, araç etkin bir turdaki asistan metni ya
gerçek bir araç çağrısı başlayana ya da akış bitene kadar tutulur, ardından özel
araç nihai yanıtı sağlamadığı sürece onu yorum olarak serbest bırakır. Web arama
sidecar'ı etkinken serbest bırakılan yorum terminal olayından önce yine de akar;
yalnızca modelin sentetik bir arama talep edip etmediğine karar vermek için
gereken olaylar arabelleğe alınmış olarak kalır.

Kiro tamamlama aracını çağırmadan durursa adaptör bir devam işlemi yapar.
Yalnızca akıl yürütme yeniden denemeleri boş bir asistan mesajı üretmek yerine
orijinal geçerli kullanıcı/araç sonucu turunu korur; görünür ilerleme boş
olmayan adaptöre ait bir talimatla yeniden oynatılır. Aktarımdan önce
oluşturulan görüşme değişen roller, boş olmayan yapısal turlar ve eşleşen araç
kullanımı/sonuç kimlikleri açısından kontrol edilir. Boş araç çıktısı nötr, boş
olmayan bir yer tutucu alır. Yeniden deneme özyineleme yapamaz: boş veya
yalnızca akıl yürütmeli bir yeniden deneme yeniden denenebilir tamamlanmamış
olarak döndürülürken, gerçek bir istemci araç çağrısı turu açık tutar. Bir
tamamlama aracı yanıtı her zaman `final_answer` olarak yayınlanır, önceki yorumu
tam olarak tekrarlasa bile, çünkü aşama doğruluğu kozmetik tekilleştirmeden daha
önemlidir. Araçsız istekler normal metin tamamlama davranışını korur.

### Akıl yürütme çabası

`gpt-5.6-sol` ve `claude-opus-5` doğrulanmış yerel çaba desteğine sahiptir ve
her model ailesi istek alanını farklı şekilde adlandırır. Seçilen `low`,
`medium`, `high`, `xhigh` veya `max` değeri `gpt-5.6-sol` için
`additionalModelRequestFields.reasoning.effort` olarak ve `claude-opus-5` için
`additionalModelRequestFields.output_config.effort` olarak gönderilir. Diğer
Kiro modelleri şu anda öykünülmüş akıl yürütme kullanır: opencodex yerel çaba
alanları doğrulanmadığı için seçilen seviyeyi kullanıcı içeriğinde sınırlı
düşünme talimatlarına dönüştürür. Bu modellerde bildirilen bir çaba denetimini
yukarı akış yerel akıl yürütme desteğinin kanıtı olarak yorumlamayın.

## `cursor`

**Hedefler:** `api2.cursor.sh` adresinde HTTP/2 Connect akışı üzerinden
Cursor'ın `agent.v1.AgentService/Run` servisi.
**Kimlik Doğrulama:** `provider.apiKey`'den veya iletilen yetkilendirme
başlığından Cursor OAuth/erişim belirteci.

- Sıradan getirme/ayrıştırma yolu yerine `runTurn` kullanır. İstekler, sunucu
  olayları, araç argümanları, kullanım denetim noktaları ve istemci yanıtları
  `cursor/gen/agent_pb.ts` içindeki `@bufbuild/protobuf` şemalarıyla kodlanır ve
  Connect mesajları olarak çerçevelenir.
- Görüşme durumunu içerik adresli bloblar aracılığıyla yeniden oynatır, sunucu
  araç çağrılarını Codex'e geri eşler, protobuf `GetUsableModels` RPC'si
  aracılığıyla canlı Cursor modellerini keşfeder ve yalnızca bir çalıştırma
  isteği hatta işlenmeden önce yeniden dener.
- Cursor Router'ı `cursor/auto` artı açık `cursor/auto-cost`,
  `cursor/auto-balance` ve `cursor/auto-intelligence` girdileri olarak sunar.
  Açık seviyeler `requested_model.parameters` içinde kodlanırken eski
  `cursor/auto` girdisi hesap/takım varsayılanını korur.
- Normal `cursor/grok-4.5` katmanlarını Cursor'ın tam canlı keşif hat
  kimlikleriyle (`cursor-grok-4.5-low`, `-medium` veya `-high`) gönderir.
  Kurallı `grok-4.5` modelini ayrı `effort` ve `fast=true` parametreleriyle
  gönderirken `cursor/grok-4.5-fast`'ı seçilebilir tutar.
- Cursor yerel dosya sistemi/kabuk/ağ yürütmesi varsayılan olarak reddedilir.
  Açık `mcpServers` ve `desktopExecutor` entegrasyonlarının ayrı katılımları
  vardır; `nativeLocalExec: "on"` daha geniş yerleşik yürütücüyü etkinleştirir
  ve Codex onay/sanal alan anlambilimini atlar ve eski
  `unsafeAllowNativeLocalExec: true` yalnızca `nativeLocalExec` ayarlanmadığında
  eşdeğer kalır.

## `azure-openai` (takma ad: `azure`)

**Hedefler:** **Azure OpenAI**. `openai-responses`'ı sarar (bu nedenle
`passthrough: true`).
**Kimlik Doğrulama:** `api-key` başlığı aracılığıyla `key` (Bearer değil).

- İstek oluşturmayı Responses doğrudan geçişine devreder, `baseUrl`'in
  çözümlenmemiş şablon yer tutucusu içermediğini doğrular ve `Authorization`'ı
  `api-key` ile değiştirir. Yapılandırılan URL doğrudan Azure'un v1 Responses
  API'sini hedefler, bu nedenle adaptör `api-version` eklemez.

## Görsel yardımcıları (`image.ts`)

Vizyon duyarlı adaptörler tarafından kullanılan paylaşılan yardımcılar:

- `parseDataUrl(url)` — Anthropic/Google görsel blokları için bir
  `data:<tip>;base64,<veri>` URL'sini `{ mediaType, base64 }` olarak böler.
- `contentPartsToText(content)` — salt metin araç mesajları için içerik
  parçalarını metne düzleştirir (açıklanmayan bir görsel kısa bir `[image]`
  işaretçisi haline gelir, asla belirteç patlatan bir base64 bloğu olmaz).


