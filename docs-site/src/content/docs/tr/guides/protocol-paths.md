---
title: Protokol yolları
description: Responses, Chat Completions veya Messages isteğinin sağlayıcıya ulaşma yolu, önizleme ve izleme araçları ile bu yolu değiştiren aşamalı anahtarlar.
---

opencodex üç istemci API'si sunar: **Responses** (`/v1/responses`), **Chat Completions**
(`/v1/chat/completions`) ve **Messages** (`/v1/messages`). Her sağlayıcı,
bağdaştırıcısının belirlediği tek üst sunucu protokolünü alır. İstemci API'si ile
üst sunucu protokolü farklıysa istek gidişte, yanıt dönüşte dönüştürülür. Bu sayfa
yolun adlandırılmasını, istek öncesi/sonrası görülmesini ve onu değiştiren ayarları açıklar.

Bu sayfadaki ayarlar varsayılan olarak kapalıdır; aşağıda açıklanan
`antigravityDirect` varsayılanı istisnadır. Kapalı anahtarlar mevcut yolu değiştirmez.

## Teslim modları

Yol, istemci API'sinden üst sunucu protokolüne uzanan adımlar listesidir. Adımlar
üç API adı, `ir` (opencodex'in bağdaştırıcıdan bağımsız istek/olay biçimi) ve
`responses-internal` (yalnızca iç köprüde üretilen, istemciye gösterilmeyen Responses JSON/SSE) olabilir.

| Mod | Anlamı | Örnek istek yolu |
| --- | --- | --- |
| `native` | İki uçta aynı API; sağlayıcı istemcinin gövdesini alır | `chat > chat` |
| `translated` | Hedef protokolün kodlayıcısı veya IR üzerinden tek dönüşüm | `chat > responses`, `responses > ir > messages` |
| `legacy-bridge` | Önce iç Responses biçimi üzerinden dönüşüm | `chat > responses-internal > ir > messages` |
| `blocked` | Gönderimden önce ret | Yok |

`native`, isteğin taşınma biçimidir; uyumluluk kararı değildir. Yerel yol üzerinde
de sağlayıcı bir alanı reddedebilir. Compatibility Lab doğrulama sonuçları ayrıdır.

Tüm anahtarlar kapalıyken uygun tek sağlayıcı rotası şu yolları izler:

| İstemci API'si → üst sunucu | Yol |
| --- | --- |
| Responses → Responses | Yerel |
| Responses → Chat veya Messages | IR üzerinden dönüştürülür |
| Chat → Chat | Yerel; istemci `stream: false` gönderirse JSON |
| Chat → Responses, Messages → Responses | Responses kodlayıcısı üzerinden dönüştürülür |
| Chat → Messages, Messages → Chat | Eski köprü |
| Messages → Messages | Yalnızca çağıran kendi Anthropic kimlik bilgisini iletiyorsa yerel; opencodex'in yönettiği anahtarda eski köprü |

Aşağıdaki anahtarlardan biri farklı davranış belirtmedikçe combo'lar, yönlendirme
ilkeleri, sentetik çaba veya hızlı model satırları Chat/Messages girişinde eski köprüyü kullanır.

## Özellik etkileri

Bazı istek özellikleri her dönüşümde korunamaz. Örneğin Chat alanları `n`,
`logprobs`, `logit_bias`, `seed`, `audio`, `prediction` Responses gövdesinde yer
bulamaz; Messages `top_k` alanı da Responses'a giderken düşürülür. opencodex her
etkiyi `passthrough`, `translated`, `degraded`, `unsupported` olarak kaydeder
(sonuncusu panoda *Dropped* gösterilir). Bunlar dönüştürücü kodundan çıkarılan
beyanlardır; ölçülmüş sonuçlar değildir.

## Yolu önizleme

Önizleme yalnızca yapılandırmanızdan hesaplanır. Sağlayıcıya istek göndermez,
combo dönüş sırasını ilerletmez ve günlüğe yazılmaz.

- Pano: **API** sayfasındaki **Request path preview**.
- CLI:

  ```bash
  ocx api explain --model combo/main --inbound chat --feature request.seed
  ocx api explain --model claude-sonnet-4-5 --inbound messages --json
  ```

Her rota adayı için istek yolu, teslim modu, özellik etkileri ve aşağıdaki
`reject` ilkesinin reddedip reddetmeyeceği listelenir. `ocx api protocols --json`
kabul edilen özellik adlarını gösterir. Çağıranın kendi Anthropic kimlik bilgisini
ilettiği Messages isteği varsayılmaz; önizlemede çağıran bulunmadığından
`caller-credential-required` gösterilir.

## İsteği izleme

Sağlayıcıya ulaşan veya gönderilmeden reddedilen her isteğin günlük satırına gerçek
yolu kaydedilir: son mod ve yollar, nedenler, özellik etkileri ve her fiziksel
deneme için bir yol. Panodaki **Logs**, yol rozeti, **Protocol path** filtresi ve
istek ayrıntısında aynı adlı bölüm sunar. Eski satırlarda yol verisinin olmadığı
belirtilir; tahmin yapılmaz.

## Temsil edilemeyen özellikler

`protocols.unrepresentable`, yolun düşüreceği bir özellik taşındığında davranışı belirler:

- `legacy` (varsayılan): İstek eskisi gibi gönderilir; kayıp yalnızca izin özellik etkilerinde görünür.
- `reject`: Hiç gönderilmeden HTTP 400 ile reddedilir; yalnızca özellik anahtarları
  adlandırılır. Chat, `unsupported_feature` kodlu `invalid_request_error`;
  Messages, `invalid_request_error` döndürür. İz `blocked` olur.

`reject` altında doğrudan rota, sağlayıcı ve protokol belirlendiğinde girişte
değerlendirilir. Combo/ilkeler girişte değerlendirilmez. `nativeChatCombos`
açıksa Chat combo her adayı ayrı değerlendirip isteği taşıyamayanı atlar.

## Aşamalı geçiş anahtarları

Yeni yollar bu anahtarlarla aşamalı açılır. `antigravityDirect` dışında tümü
varsayılan olarak kapalıdır; kapalı anahtar değişiklik yapmaz.

| Anahtar | Açıkken |
| --- | --- |
| `nativeChatCombos` | Combo içindeki uygun Chat adayı, istemci gövdesinin kendine ait kopyasından yerel gönderilir; diğer adaylar köprüde kalır. |
| `managedMessagesNative` | Doğrudan, anahtarla doğrulanan Anthropic sağlayıcısına giden Messages isteği köprü yerine Messages olarak gönderilir. Sabitlenmiş çaba, engelli beceri çıkarma, web arama yardımcısı, görsel ön işleme veya sentetik satır gibi yalnızca köprüde çalışan davranışlar köprüde kalır. |
| `managedMessagesNativeOAuth` | `api.anthropic.com` üzerindeki havuzsuz `anthropic` OAuth sağlayıcısı için yerel Messages. Yalnızca `managedMessagesNative` ile birlikte etkilidir; Anthropic OAuth hesap havuzu köprüde kalır. |
| `directEncoders` | Responses dışı üst sunucuda Chat/Messages yanıtı, iç Responses akışı yerine doğrudan bağdaştırıcı olaylarından kodlanır. İstek tarafı değişmez. |
| `antigravityDirect` | **Varsayılan olarak açık**; kapatmak için `false` yapın. Tek Google Antigravity sağlayıcısına giden Chat/Messages, iç Responses gövdesini iki yönde de atlar: konuşma doğrudan Google bağdaştırıcısının derlediği biçime çözülür, yanıt `directEncoders` gibi kodlanır. Yol `chat -> ir -> other` veya `messages -> ir -> other` olur. Model, çaba, sınırlar ve araç seçimi normal ilkelerden geçtiği için hesap dönüşümü, çaba kuralları ve kullanım değişmez. Combo'lar, ilkeler, barındırılan web araması aracı, yalnızca metin modeline gelen görseller, gölge çağrı yakalamasının değiştirebileceği modeller ve proxy'nin yeniden yazdığı metinler (beceri kataloğu, üretilmiş görsel bağlantısı) köprüde kalır; neden günlükte belirtilir. |
| `shadowPlan` | Her Chat/Messages isteğinin sonunda önizlemenin öngöreceği plan gerçek yolla karşılaştırılır. Uyuşmazsa yol kaydına `planMismatch: true` eklenir. İkinci istek gönderilmez. |

CLI ile veya `config.json` içindeki `protocols` bölümünü düzenleyerek değiştirin
([başvuru](/tr/reference/configuration/server/)):

```bash
ocx api policy                                   # geçerli ilkeyi göster; değişiklik yapmaz
ocx api policy --rollout shadowPlan=on           # tek anahtarı değiştir
ocx api policy --unrepresentable reject
```

`ocx api policy` yalnızca ayar bayrağı verdiğinizde ve komutu çalıştırdığınızda yazar.

### Gölge plan

`shadowPlan` güvenli ilk adımdır: hiçbir isteği değiştirmez. Gönderdiğiniz gerçek
trafikte önizlemenin gerçekle uyuşmasını kontrol eder. Sonuçlanan rotayı (combo'da
yanıt veren hedefi) kullanarak teslim modunu, üst sunucu protokolünü ve istek
yolunu karşılaştırır. `directEncoders` yanıt yolunu değiştirdiği ve önizleme bu
anahtarı modellemediği için yanıt yolu karşılaştırılmaz. Çağıran kimlik bilgili
Messages, Claude uyumluluk retleri ve Responses istekleri karşılaştırılmaz.

`planMismatch`, `GET /api/logs` satırının `protocolTrace` alanında görünür.
Panoda henüz gösterilmez.

## Henüz taşınmayan yollar

Aşağıdakiler iç Responses köprüsünü kullanmaya devam eder veya kapsam dışıdır:

- Dönüştürülen yollar dahil Chat/Messages, IR öncesinde hâlâ Responses biçimli
  gövdeye çözülür. Tek Google Antigravity rotası istisnadır; ancak
  `antigravityDirect: false` ise o da köprü kullanır.
- Yönlendirme ilkesi adayları, çaba satırından ulaşılan combo'lar,
  `nativeChatCombos` kapalıyken combo adayları ve Messages combo'ları.
- `directEncoders`, yalnızca somut Responses dışı rotalarda akışlı teslimi kapsar.
  Combo/ilke alt istekleri, yönlendirilmiş sıkıştırma, tur çalıştıran bağdaştırıcılar
  (Cursor, Devin, kod ajanı CLI'ları, CodeBuddy) ve yardımcı servis turları köprüde kalır.
- Çıktı üretmeden akış içinde başarısız olan yerel Chat combo adayı sonraki adaya
  geçmez; köprülenen aday geçerdi.
- Web arama, görsel işleme ve görsel üretme yardımcıları yalnızca Responses hattında çalışır.
- `previous_response_id`, `store`, `background`, sıkıştırma Responses özellikleri olarak kalır.
- Protokolü üç API'den biri olmayan bağdaştırıcılar (Gemini, Kiro, Cursor ve diğerleri)
  özellik iddiası olmadan IR üzerinden dönüştürülür.
- Birinci taraf Anthropic'e yönetilen yerel Messages yolu; token yenileme ve hesap
  seçimi boyunca gözlenen tutarlı Claude Code CLI user-agent, oturum UUID'si ve
  izin listeli SDK başlıklarını korur. Kimlik bilgisi yerleşimini proxy yönetir;
  beta izin listesi geçerlidir. Kimlik eksik/geçersizse mevcut uyumluluk başlıkları
  kullanılır; uyumlu sunucular ve üretilen Responses mevcut davranışı korur.
  Başlıklar tek başına istek yetkisi veya resmi destek sağlamaz. TypeScript Agent
  SDK'nın `sdk-ts` user-agent giriş noktası da aynı zorunlu kimlik başlıklarıyla
  tanınır; birinci taraf Anthropic isteklerinde izin listeli yerel betalarını korur.
- OAuth üzerinden yerel Chat planlanmıyor. Anthropic OAuth ile yerel Messages
  yalnızca havuzsuz hesabı kapsar; hesap havuzu köprüde kalır.
- Yönetilen yerel Messages, çağıranın `anthropic-beta` değerlerinden yalnızca kısa
  izin listesindekileri ve yalnızca `api.anthropic.com` hedefine iletir. İzin
  listesi dışı üst düzey alanları özellik etkisi kaydetmeden düşürür ve
  `claudeCode.stabilizePromptCache` uygulamaz. Tanınan Claude Code istemcisi,
  `context-management-2025-06-27` ile `context_management` gövde alanını birlikte
  korur. Birinci taraf Anthropic anahtar/OAuth isteklerinde herhangi bir yerel
  Messages istemcisi, adaptive veya enabled thinking üzerinde
  `thinking-binding-controls-2026-08-01` ile `thinking.block_binding` gönderebilir.
  Beta yoksa veya hedef desteklemiyorsa proxy iç alanı çıkarır, diğer düşünme
  ayarlarını korur. Bulut sağlayıcı uç noktaları ve üçüncü taraf uyumlu sağlayıcılar
  birinci taraf beta desteğini devralmaz. Eşleştirme, işletmecinin ayarladığı
  betalar dahil son başlığı kullanır. Beta tek başına
  [düşünme dönüşümü tanılaması](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)
  için geçerlidir. Düşürülen beta adları proxy günlüğünde bir kez
  `anthropic-beta-dropped=<names>` olarak görünür.
