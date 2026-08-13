---
title: Proxy API Formatları
description: Responses, Chat Completions, Anthropic Messages, model kataloğu, WebSocket, gerçek zamanlı ve sıkıştırma yüzeyleri için hat düzeyinde referans.
---

opencodex, tek bir yerel proxy'yi çeşitli istemci lehçelerinde sunar. Bir Codex
istemcisi Responses API'sini, OpenAI uyumlu bir uygulama Chat Completions'ı ve
Claude Code, her yukarı akış sağlayıcısının her formatı uygulamasını
gerektirmeden Anthropic Messages'ı konuşabilir.

Normal çeviri yolu şöyledir:

```text
istemci lehçesi → dahili Responses modeli → sağlayıcı adaptörü → sağlayıcı hat formatı
sağlayıcı olayları → dahili adaptör olayları → istemci lehçesi
```

Responses temsili köprünün merkezindedir. Yerel uyumlu rotalar çevirinin bazı
kısımlarını atlayabilir ve bir isteği doğrudan iletebilir, ancak kimlik
doğrulama, yönlendirme, kabul kontrolü ve yanıt güvenliği yine de proxy
sınırında gerçekleşir. Dinleyiciyi ve kabul anahtarlarını
[Yapılandırma](/tr/reference/configuration/) bölümünde yapılandırın; tek bir
genel model kimliği birkaç hedef arasından seçim yapması gerektiğinde
[Kombolar](/tr/guides/combos/) kullanın.

## Uç nokta genel bakışı

| İstemci yüzeyi | Uç nokta | Başarılı akışsız sonuç | Başarılı akış veya soket sonucu |
| --- | --- | --- | --- |
| OpenAI Responses | `POST /v1/responses` | Responses JSON | Responses SSE veya WebSocket üzerinden Responses JSON metin çerçeveleri |
| OpenAI Chat Completions | `POST /v1/chat/completions` | `chat.completion` JSON | `[DONE]` ile biten `chat.completion.chunk` SSE |
| Anthropic Messages | `POST /v1/messages` | Anthropic `message` JSON | Anthropic Messages SSE |
| Anthropic belirteç sayısı | `POST /v1/messages/count_tokens` | `{ "input_tokens": sayi }` | Geçerli değil |
| Model keşfi | `GET /v1/models` | Üç katalog sözleşmesinden biri | Geçerli değil |
| Ses ve Realtime | `POST /v1/live`, `POST /v1/realtime/calls` | İletilen çağrı oluşturma yanıtı | Ayrı bir yan bant WebSocket her iki yönde de çerçeveleri iletir |
| Responses sıkıştırması | `POST /v1/responses/compact` | Değiştirme geçmişi JSON'ı | Geçerli değil |

## `POST /v1/responses`

Bu, yerel opencodex veri düzlemi şeklidir. İstek gövdesi boş olmayan bir `model`
içeren bir JSON nesnesi olmalıdır. `input` bir dize veya Responses öğeleri
dizisi olabilir.

### Kabul edilen istek alanları

| Alan | Kabul edilen şekil |
| --- | --- |
| Model ve girdi | Gerekli boş olmayan `model`; isteğe bağlı dize `input` veya bir öğe dizisi |
| Mesaj öğeleri | `user`, `developer`, `system` ve `assistant` mesajları; role uygun dize içeriği veya tipli içerik blokları |
| İçerik blokları | Üst öğelerinin izin verdiği yerlerde metin, girdi görselleri, girdi dosyaları, çıktı metni, retler ve akıl yürütme özeti/metin blokları |
| Araç geçmişi | `function_call`, `function_call_output`, `custom_tool_call` ve `custom_tool_call_output` öğeleri |
| Araçlar | Fonksiyon araçları artı serbest yerleşik veya barındırılan araç girdileri; `tool_choice`, `auto`, `none`, `required`, adlandırılmış fonksiyon/özel seçimler, barındırılan seçimler veya `allowed_tools` kabul eder |
| Akıl yürütme | `reasoning.effort` ve `reasoning.summary` (`auto`, `concise`, `detailed` veya `none`) |
| Devam ve önbellekleme | `previous_response_id`, `store` ve `prompt_cache_key` |
| Üretim kontrolleri | `max_output_tokens`, `temperature`, `top_p`, `stop`, `presence_penalty` ve `frequency_penalty` |
| Servis ve yürütme | `stream`, `service_tier`, `parallel_tool_calls`, `instructions`, `metadata` ve `user` |
| Genişletilmiş Responses alanları | Uyumlu rotalar için `background`, `include`, `prompt`, `text` ve `truncation` kabul edilir |

Bilinmeyen öğe türleri ileriye dönük uyumluluk için serbest tipli öğeler olarak
kabul edilir. Çevrilen adaptörler yalnızca tanıdıkları öğe türlerini işler ve
sağlayıcılarının temsil edemediği bir özelliği reddedebilir.

### JSON ve SSE çıktısı

`stream: true` olduğunda yanıt `text/event-stream` olur. Köprü
`response.created`, çıktı öğesi ve metin/araç farkları ve tam olarak bir
terminal `response.completed`, `response.failed` veya `response.incomplete`
olayı gibi Responses olaylarını yayar. Normal bir akış `data: [DONE]` ile biter.

`stream: false` veya `stream` olmadığında aynı adaptör olayları tek bir
Responses JSON nesnesinde toplanır. Her iki form da seçilen modeli, çıktı
öğelerini, terminal durumunu ve kullanımı korur.

İstemciye yönelik Responses SSE çerçeveleri, SSE blok sınırlayıcısından önceki
ham bayt cinsinden ölçülen çerçeve başına 4 MiB ile sınırlandırılmıştır. HTTP
üzerinde sınırı aşan sonlandırılmamış bir yukarı akış çerçevesi, ardından `data:
[DONE]` gelen sentetik bir `response.failed` olayıyla kapalı olarak başarısız
olur. Responses WebSocket köprüsünde aynı durum 502 `websocket_protocol_error`
yayar ve yukarı akış okuyucusunu iptal eder. Tam bir Responses terminal
çerçevesi yetkilidir: bu terminalden sonraki aşırı büyük veya hatalı
biçimlendirilmiş sondaki baytlar tamamlanan turu bir aktarım hatasıyla
değiştirmek yerine bırakılır.

Sağlayıcı bu ayrıntıları bildirmese bile her terminal Responses kullanım nesnesi
her iki ayrıntı nesnesini de içerir:

```json
{
  "input_tokens": 0,
  "output_tokens": 0,
  "total_tokens": 0,
  "input_tokens_details": { "cached_tokens": 0 },
  "output_tokens_details": { "reasoning_tokens": 0 }
}
```

Kullanılabilir olduğunda `input_tokens_details` `cache_write_tokens` da
içerebilir. Her zaman mevcut olan ayrıntı nesneleri katı Responses istemcileri
için bir uyumluluk garantisidir; sıfır olması "sağlayıcı böyle bir çalışma
yapmadı" anlamına gelmek zorunda değildir, "bildirilmedi" anlamına gelebilir.

### Aynı yol üzerinde WebSocket yükseltmesi

`websockets` etkinleştirildiğinde bir istemci bir HTTP POST açmak yerine
`/v1/responses`'ı yükseltebilir. Kimlik doğrulama ve kaynak kabulü WebSocket el
sıkışması sırasında gerçekleşir. Her çerçevenin içinde tekrarlanmazlar.

İstemci JSON metin çerçeveleri gönderir:

```json
{
  "type": "response.create",
  "model": "saglayici/model",
  "input": "Hello",
  "tools": [],
  "generate": true
}
```

`type` dışındaki her şey Responses istek gövdesi haline gelir ve proxy tur için
akışı zorlar. Yeni bir `response.create`, bu soketteki önceki turu geçersiz
kılar ve iptal eder. `response.processed` işlem yapılmayan bir onay (no-op)
olarak kabul edilir. Ayrıştırılamayan veya ilgisiz çerçeve türleri yok sayılır.

Sunucu çerçeveleri JSON metin çerçeveleridir. Başarılı akışlı çıktı SSE zarfı
veya `[DONE]` olmadan SSE `data:` satırlarında görünecek aynı JSON yüklerini
kullanır. Akışsız dahili bir sonuç `response.created`, sıfır veya daha fazla
`response.output_item.done` çerçevesi ve ardından bir terminal çerçevesi olarak
yeniden çerçevelenir. Hatalar şu zarfı kullanır:

```json
{
  "type": "error",
  "status": 502,
  "error": {
    "type": "upstream_error",
    "message": "..."
  },
  "headers": {}
}
```

`generate: false` içeren bir ısınma çerçevesi bir yukarı akışı çağırmaz. Boş bir
yanıt kimliği ve çıktı içermeyen sentetik bir `response.created` ve ardından
`response.completed` döndürür.

:::note
WebSockets devre dışı bırakıldığında bir yükseltme denemesi `upgrade_required`
koduyla HTTP 426 alır. Codex bu el sıkışma sonucunu oturum için HTTP'ye geri
dönme sinyali olarak değerlendirir. Başarısız bir model turu değildir.
:::

## `POST /v1/chat/completions`

Bu uç nokta, gerekli bir `model` ve boş olmayan bir `messages` dizisi içeren
OpenAI uyumlu Chat Completions isteklerini kabul eder. Sistem, kullanıcı,
asistan ve araç mesajlarını dahili Responses öğelerine çevirir; fonksiyon
araçlarını, araç seçimini, görselleri, akıl yürütme çabasını ve desteklenen
yanıt formatlarını çevirir; normal Responses yönlendirme işlem hattını
çalıştırır; ardından sonucu geri çevirir.

Yapılandırılmış çıktı bu çevirinin bir parçasıdır: `json_object` veya
`json_schema` içeren `response_format`, yönlendirilen `openai-chat` modellerine
iletilir. `POST /v1/responses` üzerinde eşdeğer istek alanı `text.format`'tır:
yerel Responses rotaları onu ham Responses gövdesinde korur ve model bir
`openai-chat` sağlayıcısına yönlendiğinde `response_format`'a çevrilir.
Sağlayıcının `noStructuredOutputModels` listesinde yer alan bir model bu sohbet
hattında `response_format`'ı atlar; kardeş modeller çeviriyi korur.
Sınıflandırılmamış arka uçlar alanı alır ve proxy'nin yeteneklerini tahmin
etmesi yerine kendi hatalarını döndürür.

Akışsız çıktı `object: "chat.completion"` içerir. Akışlı çıktı `object:
"chat.completion.chunk"` içeren SSE nesnelerini, seçenek farklarını,
`finish_reason` içeren bir terminal seçeneğini ve `data: [DONE]` kullanır. Araç
çağrısı ve kullanım bilgileri kaynak olayların bunları taşıdığı yerlere geri
çevrilir.

Dahili yürütme yolu Responses tabanlı olduğundan bir sağlayıcı adaptörü daha dar
bir özellik kümesi uygulayabilir. Örneğin seçilen adaptör tarafından temsil
edilemeyen bir istek özelliği anlamı sessizce değiştirilmek yerine bir hata
olarak döndürülür.

## `POST /v1/messages` ve `count_tokens`

Bu uç noktalar Claude Code ve uyumlu istemciler tarafından kullanılan Anthropic
Messages lehçesini konuşur. Çoğu istek Responses'a çevrilir, normal şekilde
yönlendirilir, ardından Anthropic JSON veya Anthropic SSE'ye geri çevrilir.

Yerel Anthropic doğrudan geçişi yalnızca bunların tümü doğru olduğunda uygundur:

- Claude Code yapılandırmasında yerel doğrudan geçiş devre dışı bırakılmamışsa;
- istenen model `claude` veya `anthropic` ile başlıyorsa;
- istek yerel bir Anthropic taşıyıcısı veya `x-api-key` kimlik bilgisi
  taşıyorsa;
- geri döngü olmayan bir dinleyicide istek yalnızca `x-opencodex-api-key` içinde
  geçerli proxy kabulü de taşıyorsa; ve
- yapılandırılmış hiçbir takma ad veya model haritası bu model kimliğini
  yönlendirilen bir hedef için talep etmiyorsa.

Uygun bir istek Anthropic lehçesinde iletilir, böylece yerel beta başlıkları,
düşünme imzaları ve abonelik kimliği uçtan uca kalır. Aksi takdirde Responses
gidiş-dönüşünü alır.

Özel kabul başlığı asla iletilmez. `Authorization` veya `x-api-key` içinde
bulunan proxy kabul sırları da kaldırılır; ayrı bir gerçek Anthropic kimlik
bilgisi korunur. Belirsiz virgülle birleştirilmiş kimlik bilgisi başlıkları
iletilmek yerine kapalı olarak başarısız olur.

`POST /v1/messages/count_tokens` aynı model çözümlemesini ve doğrudan geçiş
kararını takip eder. Yerel olarak uygun bir istek Anthropic'in sayım uç
noktasına iletilir. Diğer istekler sistem içeriği, mesajlar ve araçlar üzerinden
yerel belgelenmiş tahmini kullanır ve şunu döndürür:

```json
{ "input_tokens": 123 }
```

## `GET /v1/models`

Aynı rota uyumsuz katalog zarfları bekleyen üç istemciye hizmet verir.
`client_version` da mevcut olmadıkça Anthropic türü kazanır.

| Sözleşme | Tetikleyici | Üst düzey şekil | Model kimliği davranışı |
| --- | --- | --- | --- |
| Anthropic model listesi | `client_version` olmadan `anthropic-version` başlığı veya `?flavor=anthropic` | Anthropic model bilgisi girdileriyle `{ "data": [...] }` | Claude Code okunabilir kimlikleri alır; Desktop profile özgü takma ad ailesini alabilir |
| Codex kataloğu | `client_version` sorgu parametresi | `{ "models": [...] }` | Yerel ve yönlendirilen girdiler daha zengin Codex katalog alanlarını, görünürlüğü, çabayı, WebSocket ve çoklu ajan meta verilerini taşır |
| Düz OpenAI listesi | Hiçbir tetikleyici yok | `{ "object": "list", "data": [...] }` | Görünür yerel kimlikler yalındır; yönlendirilen kimlikler takma adlar veya `sağlayıcı/model`'dir |

## `POST /v1/live` ve Realtime yan bandı

`POST /v1/live`, ChatGPT/Codex App Frameless çağrı oluşturma yüzeyini kabul
eder. `POST /v1/realtime/calls`, OpenAI Realtime çağrı oluşturma yüzeyini kabul
eder. opencodex uygun bir OpenAI ailesi rotası seçer, yukarı akış kimlik
doğrulama modu için çağrı oluşturma isteğini normalleştirir ve sınırlı yanıtı
iletir.

Çağrı oluşturulduktan sonra istemciler desteklenen herhangi bir gelen formu
kullanarak bir yan bant WebSocket'e katılabilir:

- `/v1/live/{callId}`
- `/v1/realtime/calls/{callId}`
- `/v1/realtime?call_id={callId}`

Proxy yukarı akış katılım URL'sini normalleştirir ve ardından her iki yönde
metin ve ikili çerçeveleri şeffaf bir şekilde iletir. İstemci protokol
başlıkları korunurken yukarı akış kimlik doğrulaması proxy mülkiyetinde kalır.

## `POST /v1/responses/compact`

Sıkıştırma, uzun bir Responses görüşmesini kısaltması gereken istemciler için
değiştirme geçmişini döndürür.

| Rota türü | Davranış |
| --- | --- |
| Kurallı ChatGPT veya resmi OpenAI rotası | İsteği çözümlenen hesap ve model kimlik doğrulamasıyla yerel `/responses/compact` uç noktasına iletir |
| Diğer yönlendirilen model | Bir `compaction_trigger` ile dahili, akışsız, araçsız bir sıkıştırma turu çalıştırır; `encrypted_content`'i bir `ocx1:` zarfı olan tam olarak bir sentetik `compaction` öğesi gerektirir; bu özeti v1 değiştirme geçmişine çözer |

Yerel sıkıştırma yanıtları, bildirilen `Content-Length` değeri sınırı zaten aşan
yanıtlar da dahil olmak üzere maksimum 32 MiB ile arabelleğe alınır.
Sıkıştırmaya özgü hatalar şunları içerir:

| Durum | Tip veya kod | Anlamı |
| --- | --- | --- |
| 400 | `invalid_request_error` | Geçersiz JSON/gövde şekli veya eksik model |
| 404 | `invalid_request_error` | İstenen model yönlendirilemez |
| 499 | `client_cancelled` | İstemci iletme veya arabelleğe alma sırasında iptal etti |
| 502 | `compact_response_too_large` | Yerel sıkıştırma çıktısı 32 MiB'yi aştı |
| 502 | `upstream_error` | Bağlantı, okuma veya sentetik sıkıştırma turu arızası |
| 502 | `invalid_response_error` | Sentetik tur tam olarak bir geçerli, boş olmayan `ocx1:` sıkıştırma öğesi üretmedi |

## Kimlik doğrulama matrisi

Yalnızca geri döngü bağlantısında veri düzlemi kabulü yapılandırılmış bir
anahtar gerektirmez. Uzak bir bağlantıda aşağıdaki matrisi kullanın. "Özel",
`X-OpenCodex-API-Key` anlamına gelir; diğer sütunlar `Authorization: Bearer ...`
ve `x-api-key` anlamına gelir.

| Yüzey | Özel | Bearer | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` HTTP ve WebSocket | Gerekli | Proxy kabulü için reddedilir | Reddedilir |
| `/v1/responses/compact` | Gerekli | Proxy kabulü için reddedilir | Reddedilir |
| `/v1/chat/completions` | Gerekli | Proxy kabulü için reddedilir | Reddedilir |
| `/v1/messages` ve `/v1/messages/count_tokens` | Kabul Edilir | Kabul Edilir | Kabul Edilir |
| `/v1/models` | Kabul Edilir | Kabul Edilir | Kabul Edilir |
| `/v1/live`, `/v1/realtime/calls` ve yan bant katılımları | Kabul Edilir | Kabul Edilir | Kabul Edilir |

Responses ailesi ve Sohbet istekleri `Authorization`'ı sağlayıcı veya Codex
Direct doğrudan geçişi için ayırır, bu nedenle uzak bir proxy anahtarı özel
başlığı kullanmalıdır. Messages ve Realtime yüzeyleri daha geniş istemci
uyumluluğuna ihtiyaç duyar ve bu nedenle üç formu da kabul eder.

:::caution
Veri düzlemi anahtarları yönetim kimlik bilgileri değildir. Yönetim API'si ayrı
bir yönetici sırrı kullanır; bkz. [Yönetim
API'si](/tr/reference/management-api/). Her iki düzlem için asla tek bir sırrı
yeniden kullanmayın.
:::

## Yaygın hata sözlüğü

Hatalar gerektiğinde istemci lehçesinin zarfını kullanır, ancak bu durum/kod
anlamları kararlıdır:

| Durum | Tip veya kod | Anlamı |
| --- | --- | --- |
| 401 | `authentication_error` | Gerekli bir proxy kabul kimlik bilgisi eksik veya geçersiz |
| 403 | `origin_rejected` | Bir Responses/OpenAI veri düzlemi isteği veya WebSocket yükseltmesi izin verilmeyen bir kaynaktan geldi |
| 503 | `combo_unavailable` | Seçilen komdodaki her hedef kullanılamaz, soğumada, devre dışı veya başka şekilde uygun değil |
| 400 | `unreadable_encrypted_agent_task` | Şifrelenmiş bir v2 çalışan görevinin onu tüketebilecek uygun yerel bir ChatGPT hedefi yok |
| 426 | `upgrade_required` | Responses WebSocket aktarımı devre dışı bırakıldı veya yükseltme başarısız oldu; HTTP kullanın |

Anthropic kaynaklı arızalar Anthropic'in hata zarfında işlenir, bu nedenle
kaynak reddi OpenAI tarzı `origin_rejected` gövdesi yerine bu lehçede 403
`permission_error` olur.

## Şifrelenmiş içerik hijyeni

Proxy gerçek arka uç şifreli metnine donuk muamelesi yapar. Yapısal olarak
geçerli şifreli metin bayt bayt korunur: opencodex şifresini çözmez, içeriğini
çevirmez veya başka bir sağlayıcı için yeniden şifrelemez.

Bazı ajan kancaları geçmişte `encrypted_content` yuvasına düz metin denetim
metni yerleştirmiştir. Uyumluluk için proxy yapısal olarak geçerli Fernet
çalışmalarını değiştirmeden tutarken bu düz metni metin parçalarına ayırır. Bir
`agent_message` bu onarım sırasında tüm şifrelenmiş parçaları kaybederse normal
bir kullanıcı mesajı haline gelir. Geçerli bir v2 görevi gerçekten şifrelenmiş
kalırsa ancak seçilen yönlendirilen hedef yerel ChatGPT şifreli metnini
okuyamazsa opencodex bu sağlayıcıya okunamayan baytlar göndermek yerine
`unreadable_encrypted_agent_task` ile başarısız olur. Çalışan görevleri
etrafındaki istemci davranışı için [Alt Ajan
Arayüzü](/tr/guides/sub-agent-surface/) sayfasına bakın.


