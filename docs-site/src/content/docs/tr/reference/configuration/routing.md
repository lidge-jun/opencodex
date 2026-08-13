---
title: Yönlendirme Yapılandırması
description: Varsayılan sağlayıcı seçimi, model çözümleme sırası, kombo takma adları, hedef sıralaması ve çaba varsayılanları.
---

Yönlendirme, bir istemci tarafından gönderilen model kimliğini somut bir
sağlayıcıya ve yukarı akış modeline dönüştürür.

## Üst düzey yönlendirme alanları

| Alan | Tip | Varsayılan | Anlamı |
| --- | --- | --- | --- |
| `defaultProvider` | `string` | `"openai"` | Daha önceki hiçbir model kuralı eşleşmediğinde kullanılan nihai sağlayıcı. Etkinleştirilmiş yapılandırılmış bir sağlayıcıyı adlandırmalıdır. |
| `combos?` | `Record<string, OcxComboConfig>` | `{}` | Sıralı sağlayıcı/model hedeflerinden oluşturulmuş sanal `combo/<id>` modelleri. |
| `routingProfiles?` | `Record<string, OcxRoutingProfileConfig>` | `{}` | Kesin yetenek gereksinimlerini ve belirleyici puanlamayı kullanarak açık bir aday izin listesi arasından seçim yapan sanal `policy/<id>` modelleri. |

## Model çözümleme sırası

opencodex istenen modeli şu sırayla çözer:

1. İlke değerlendiricisini yürüten ve seçilen adayı yönlendiren yapılandırılmış
   bir `policy/<id>` veya yönlendirme profili takma adı. Çözümlenmemiş bir
   `policy/<id>` sonraki kurallara düşer.
2. Tam olarak eşlenen saklanan Codex hesabı aracılığıyla yönlendirilen
   yapılandırılmış bir `<hesap-secici>/<yerel-openai-modeli>` ad alanı. Geçersiz
   veya kullanılamaz tam bir hedef kapalı olarak başarısız olur.
3. Kurallı bir `combo/<id>` veya yapılandırılmış kombo takma adı. Kurallı
   kimlikler takma ad eşleştirmesinden önce kazanır.
4. Öneki yapılandırılmış bir sağlayıcıyı adlandıran açık bir
   `<saglayici>/<model>` ad alanı.
5. Kurallı etkin `openai` sağlayıcısı aracılığıyla yönlendirilen `gpt-*`,
   `o1-*`, `o3-*` veya `o4-*` gibi yalın bir yerel OpenAI ailesi kimliği.
6. Bir sağlayıcının `defaultModel`'ı için tam bir eşleşme.
7. Bilinen bir sağlayıcı ailesi model öneki.
8. Bir sağlayıcının yapılandırılmış `models` listesindeki tam bir model.
9. İstenen model kimliğini koruyarak `defaultProvider`.

Devre dışı bırakılmış sağlayıcılar hariç tutulur. Devre dışı bırakılmış bir
sağlayıcı için açık bir ad alanı sonraki kurallara düşmek yerine başarısız olur.
Birden fazla sağlayıcıyla eşleşebilecek kurallar için sağlayıcı girdileri JSON
ekleme sıralarına göre kontrol edilir, bu nedenle yalın bir model belirsiz
olabileceğinde açık ad alanları kullanın.

## Tam Codex hesap seçicileri

`codexAccountNamespaces`, `side` gibi genel bir seçiciyi saklanan bir Codex
hesabına eşler. `side/gpt-5.6-sol` için bir istek, kurallı `openai` sağlayıcısı
Doğrudan (Direct) modda olsa bile yalnızca bu hesabı kullanır ve yukarı akışa
yalın `gpt-5.6-sol` model kimliğini gönderir. Seçiciden sonra yalnızca yalın
yerel OpenAI ailesi kimlikleri geçerlidir. Codex'in geçerli model kataloğunda
gözlemlenen hesap kapsamlı kimlikler, henüz opencodex'in statik kümesinin bir
parçası olmadıklarında da tam olarak korunabilir; gözlem gerçek bir katalog
satırının alan şeklini taşımalıdır, eşleşen hesap seçicisine nitelikli kalır ve
asla küresel yalın model listesine yükseltilmez. Bu şekil kontrolü hatalı
biçimlendirilmiş ve minimum satırları filtreler — bu bir güven kontrolü
değildir, çünkü model önbelleği kullanıcıya ait bir dosyadır ve elle yazılmış
tam bir satır yukarı akış gözleminden ayırt edilemez. Yeni hiçbir şey
yönlendirilebilir hale gelmez: bir hesap seçicisi altındaki yalın bir `gpt-*`
kimliği, katalogdan bağımsız olarak yönlendirici tarafından kabul edilir.

Tam seçim, Havuz atama stratejisini ve sıradan iş parçacığı bağlılığını atlar.
Eşlenen hesap eksikse, duraklatılmışsa, soğuyorsa, kullanılamaz durumdaysa veya
yeniden kimlik doğrulama gerektiriyorsa istek hesap değiştirmek yerine kapalı
olarak başarısız olur ve aktif Havuz hesabını değiştirmez. En az bir uygun
seçici yapılandırıldığında Codex katalogları yalın yerel seçici satırlarını
gizler ve her seçici için ayrı bir `<secici>/<yerel-openai-modeli>` satırı
listeler. Yalın yerel kimlikler normal Havuz/Direct yönlendirmesini korur ve
açıkça devre dışı bırakılmadıkça ham `/v1/models` keşfinde kalır. Eşlenen
saklanan hesabı eksik olan seçiciler sunulmaz. Seçici doğrulaması, çakışma
kuralları ve gizlilik rehberliği [Sağlayıcı
Yapılandırması](/tr/reference/configuration/providers/) bölümünde
belgelenmiştir.

Codex Auth sayfası bu seçici davranışını isteğe bağlı bir özellik olarak sunar.
Devre dışı bırakılması, oluşturulan seçici nitelikli seçici satırlarını gizler
ve sıradan GPT satırlarını geri yükler, ancak eşlemeleri kaldırmaz veya tam
`<secici>/<model>` yönlendirmesini değiştirmez. Yeniden etkinleştirmek bu
nedenle aynı genel etiketleri geri yükler. Hesap ve ayar mutasyonları sınırlı
bir katalog yenilemesinden önce kalıcı hale getirilir; bir `ocx sync` uyarısı
yalnızca seçici kataloğunun hala yakınsamaya ihtiyacı olduğu anlamına gelir,
yönlendirme değişikliğinin kaybolduğu anlamına gelmez.

## Kombolar (`config.combos`)

Her kombo anahtarı `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` ile eşleşen bir kimliktir.
Her zaman `combo/<id>` olarak doğrudan adreslenebilirdir ve ayrıca bir `alias`
sunabilir. Takma adlar benzersiz olmalıdır, `combo/` ad alanını işgal edemez ve
`nativeAlias: true` Masaüstü uyumluluk sözleşmesini açıkça etkinleştirmedikçe
`gpt-*`, `o1-*`, `o3-*`, `o4-*` veya `codex-*` gibi ayrılmış yalın yerel
aileleri kullanamaz.

| Anahtar | Tip | Varsayılan | Anlamı |
| --- | --- | --- | --- |
| `targets` | `{ provider: string; model: string; weight?: number }[]` | gerekli | Sıralı somut rotalar. `weight` 1–10000 arasındadır ve varsayılan olarak `1`'dir. |
| `strategy?` | `"failover" \| "round-robin"` | `"failover"` | Seçim stratejisi. Hedef sırası yük devretme önceliğidir; ağırlıklar pürüzsüz ağırlıklı round-robin'i şekillendirir. |
| `stickyLimit?` | `number` | `1` | Tek bir round-robin grubunda tutulan başarılı istekler. Aralık 1–100. |
| `defaultEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra" \| null` | ayarlanmamış | Yalnızca arayan çabayı atladığında ve seçilen hedef istenen basamağı bildirdiğinde uygulanır. |
| `alias?` | `string` | — | Kurallı seçici slug'ı yerine isteğe bağlı genel model kimliği. |
| `nativeAlias?` | `boolean` | `false` | Şu anda desteklenen bir yalın yerel kimliğin yalnızca o niteliksiz kimlik için öncelikli olmasına izin verin. Yalın `gpt-5.6-*` kimlikleri Codex Havuz/Direct kimlik bilgilerini kullanır. Hesap nitelikli rotalar ayrı kalır. `openai-apikey/gpt-5.6-*` gibi sağlayıcı nitelikli rotalar yapılandırılmış API anahtarı rotalarını kullanır ve asla yerel takma ada düşmez. |
| `displayName?` | `string` | — | Yalnızca görüntüleme amaçlı katalog etiketi, yerel bir takma ad için gerekli ve boş olmamalıdır. |

```json
{
  "defaultProvider": "openai",
  "combos": {
    "coding": {
      "targets": [
        { "provider": "anthropic", "model": "claude-sonnet-5" },
        { "provider": "openrouter", "model": "qwen/qwen3-coder-plus" }
      ],
      "strategy": "failover",
      "defaultEffort": "high",
      "alias": "coding-primary"
    }
  }
}
```

Strateji davranışı, yeniden denenebilir arızalar, soğuma süreleri, şifrelenmiş
v2 görev sınırları ve yönetim komutları için [Kombolar](/tr/guides/combos/)
sayfasına bakın.

## Yönlendirme politikası profilleri (`config.routingProfiles`)

Yönlendirme politikası profilleri, Yönlendirici Zekası (Router Intelligence)
seçim katmanıdır: açıkça talep edilen bir `policy/<id>` (veya yapılandırılmış
takma ad), kesin yetenek gereksinimlerini ve belirleyici, açıklanabilir
puanlamayı kullanarak sabit bir aday izin listesi arasından seçim yapar. Açık
bir `policy/<id>` isteği (veya yapılandırılmış bir takma ad) değerlendiriciyi
yürütür ve seçilen adayı yönlendirir. Mevcut model kimlikleri **asla** örtük
olarak bir profil üzerinden yönlendirilmez: `policy/` ad alanı ve profil takma
adları tek giriş noktalarıdır ve her ikisi de yukarıdaki model çözümleme
sırasına göre doğrulanır.

Her anahtar `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` ile eşleşen bir kimliktir, her
zaman `policy/<id>` olarak adreslenebilir ve isteğe bağlı bir `alias` içerir.
Takma adlar benzersiz olmalıdır ve yapılandırılmış sağlayıcılar,
`<saglayici>/<model>` yönlendirme ad alanı, kombolar, codex hesap ad alanları,
`policy/` ad alanı veya ayrılmış yalın yerel ailelerle (`gpt-*`, `o1-*`, `o3-*`,
`o4-*`, `codex-*`) çakışamaz.

| Anahtar | Tip | Varsayılan | Anlamı |
| --- | --- | --- | --- |
| `candidates` | `{ provider: string; model: string }[]` | gerekli | `provider/model` referanslarının açık izin listesi. Örtük genişleme yok. |
| `alias?` | `string` | — | `policy/<id>` yerine isteğe bağlı genel model kimliği. |
| `require?` | object | `{}` | Puanlamadan önce değerlendirilen kesin yetenek gereksinimleri (aşağıya bakın). |
| `optimize?` | object | latency 0.55, health 0.25, cost 0.10, quota 0.10 | Belirleyici olarak normalleştirilmiş puanlama ağırlıkları. `health`, `quota` ve `cost` puan boyutlarına sahiptir; yapılandırılmış öncelik payı `1 - health - quota - cost`'tur (varsayılan 0.55) ve `latency` bağımsız puanlama yapmak yerine bu öncelik payına katlanır. |
| `limits?` | object | — | Kesin sınırlar. `maxEstimatedCostUsd`, tahmini maliyeti bilindiğinde ve sınırın üzerinde olduğunda bir adayı hariç tutar. Bu sınır ayarlandığında `onUnknownCost` (varsayılan `"allow"` veya `"exclude"`), bilinmeyen tahminleri kontrol eder: allow sınıra özgü bir hariç tutmayı önler ve `cost.capOutcome: "unknown-allowed"` kaydeder; exclude `cost-limit-unknown` ve `capOutcome: "unknown-excluded"` yayar. Tek başına `onUnknownCost` (sınır yok) etkisizdir. Bilinmeyen fiyatları `unknown-price` / puanlama yoluyla yine de hariç tutabilen veya cezalandırabilen `unknownEvidence.cost`'tan ayrıdır. |
| `unknownEvidence?` | object | capability `exclude`, health/quota/cost `penalize` | Boyut başına bilinmeyen kanıta nasıl davranılacağı: `allow`, `penalize` veya `exclude`. Bilinmeyen asla sıfır olmaz. |

`require` şunları destekler: `minContextWindow` (pozitif tamsayı),
`minQuotaHeadroom` (0..1 kesri) ve `tools`, `imageInput`, `structuredOutput`,
`localOnly`, `remoteAllowed`, `encryptedCodexTasks` boolean değerleri; artı
`reasoningEffort` ve `serviceTier` dizeleri.

`unknownEvidence.capability` için `penalize` şu anda `allow` gibi davranır: bir
yetenek puanı boyutu gelene kadar (RI-06+ ile planlanmıştır) puanlamanın
yalnızca yapılandırılmış öncelikli bir bileşeni vardır, bu nedenle `penalize`
henüz seçilen adayı değiştiremez.

İstek kanıtı, profil `require` bloğu ile birlikte aday yeteneklerine göre
değerlendirilir; bir adayın uygun olması için her ikisini de karşılaması
gerekir. Canlı istek yolunda proxy, istek gövdesinden araçlar ve görsel girişi
kanıtı türetir; bağlam penceresi boyutu ve kalan kanıt boyutları yönlendirme
zamanında bilinmeyen olarak kalır. Bağlama duyarlı profiller için tam kanıt
yüzeyini incelemek üzere deneme çalıştırması API'sini/CLI'sını kullanın.

CLI deneme çalıştırması istek kanıtı bayraklarını kabul eder ancak henüz aday
yetenek kanıtı sağlayamaz; aday kanıtı API (`POST
/api/routing-profiles/dry-run`) aracılığıyla sağlanır.

```json
{
  "routingProfiles": {
    "fast": {
      "alias": "ocx/fast",
      "candidates": [
        { "provider": "anthropic", "model": "claude-sonnet-5" },
        { "provider": "openai", "model": "gpt-5.6-sol" }
      ],
      "require": { "tools": true, "minContextWindow": 128000 },
      "optimize": { "latency": 0.55, "health": 0.25, "cost": 0.10, "quota": 0.10 },
      "limits": { "maxEstimatedCostUsd": 0.50, "onUnknownCost": "allow" },
      "unknownEvidence": {
        "capability": "exclude",
        "health": "penalize",
        "quota": "penalize",
        "cost": "penalize"
      }
    }
  }
}
```

CLI: `ocx route policy list [--json]`, `ocx route policy show <id> [--json]` ve
`ocx route policy dry-run <id> [--model-context <tokens>] [--tools] [--image]
[--structured-output] [--json]`. Deneme çalıştırması, herhangi bir yukarı akış
isteği göndermeden adayları değerlendirir.

Kota kanıtı (`optimize.quota`, `require.minQuotaHeadroom`,
`unknownEvidence.quota`), hesap anahtarlı Codex ve Anthropic kota
önbelleklerinden gelir. Bir çalışma zamanı adayı, yalnızca kanıt hesabı zaten
tanımladığında önbelleğe alınmış kota alır. Bağımsız kurallı `openai` ve
Anthropic adayları politika değerlendirmesi sırasında bilinmeyen kalır çünkü
Havuz seçimi, Direct arayan kimliği, sağlayıcı rotasyonu ve iş parçacığı
bağlılığı politika bir sağlayıcı/model seçtikten sonra çözülür; süreçte aktif
bir hesap bir ikame olarak kullanılmaz.
Kota kanıtı asla hesap seçimini, oturum bağlılığını, soğuma sürelerini veya
geçiş davranışını değiştirmez — yalnızca politika puanlamasını besler. Bir API
deneme çalıştırmasında kota duyarlı davranışı görmek için `POST
/api/routing-profiles/dry-run`'a gönderilen aday kanıtında hesap referansları
sağlayın: `candidates[].codexAccountId` (Codex havuzu, sağlayıcı `openai`) veya
`candidates[].accountRef` (Anthropic) eşleşen önbelleğe alınmış hesap kotasını
türetir; açık bir `candidates[].quota` nesnesi verildiği gibi yankılanır. CLI
deneme çalıştırması bu aday başına hesap alanlarını sağlayamaz.

### Kombolar ve politika profilleri

- Bir **kombo**, açık sıralı/ağırlıklı hedef yönlendirmesi ve yük devretmesidir:
  yapılandırılmış sıra (veya pürüzsüz ağırlıklı round-robin) karar verir ve
  arızalar liste boyunca ilerler.
- Bir **politika profili**, yapılandırılmış adaylar arasında kanıta dayalı
  seçimdir: kesin yetenek gereksinimleri önce filtreler, ardından belirleyici
  puanlama kalanları sıralar.

Her ikisi de takma adlar ve çakışma doğrulaması içeren sanal ad alanlarıdır; bir
adayın *nasıl* seçildiği konusunda farklılık gösterirler. Profil puanlaması,
kanıtın mevcut olduğu yerlerde yapılandırılmış öncelik bileşenini sağlık
(RI-06), kota (RI-07) ve maliyet (RI-08) puan boyutlarıyla birleştirir;
`latency` ağırlığı bağımsız olarak puanlama yapmak yerine öncelik payına
katlanır. Maliyet ayrıca `limits.maxEstimatedCostUsd` sınırı aracılığıyla da
uygulanır: tahmini maliyeti bilinen ve sınırı aşan bir aday hariç tutulur
(`cost-limit`). Bir sınır yapılandırıldığında ve tahmin bilinmediğinde
varsayılan `limits.onUnknownCost: "allow"`, rota kararı izinde bir sınır hariç
tutması olmadan `cost.capOutcome: "unknown-allowed"` kaydeder; kapalı olarak
başarısız olan bir tavan için `onUnknownCost: "exclude"` ayarlayın
(`cost-limit-unknown`). Sınır sonucu genel uygunluk değildir —
`unknownEvidence.cost: "exclude"` yine de `unknown-price` ekleyebilir ve adayı
uygunsuz olarak işaretleyebilir. Bir politika profili yürütüldüğünde istek
başına rota kararı izleri kaydedilir.

### Katalog uygunluğu

Bir kombo listelenemediğinde bile doğrudan yönlendirilebilir kalır. `ocx sync`,
`/v1/models` ve Codex seçicisi, bunu yalnızca her hedef kesiştirilebilecek
yetenekleri açığa çıkardığında listeler:

- canlı meta verilerden, kayıt defteri ipuçlarından, sağlayıcı
  `modelContextWindows` / `contextWindow`'undan, üye satırında bilinen pozitif
  bir `maxInputTokens`'tan veya — sağlayıcı bilindiğinde ve etkinleştirildiğinde
  ancak her kaynak yine de bir pencereyi atladığında — muhafazakar bir 128.000
  belirteç geri dönüşünden (ayarlandığında `providerContextCaps` tarafından
  sabitlenir) gelen pozitif bir `contextWindow`; ve
- atlanan bir üye değerini `["text"]` olarak değerlendiren boş olmayan bir
  `inputModalities` kesişimi.

Devre dışı bırakılmış bir sağlayıcıdaki bir hedef (tam bir keşif satırıyla
bile), keşif satırı olmayan bilinmeyen bir sağlayıcıdaki bir hedef veya ayrık
modalitelere sahip hedefler komboyu katalogdan kaldırır. Senkronizasyon bir özet
uyarısı yayar ve kontrol paneli bunu **Dikkat gerekiyor** olarak işaretler.
Bağlam meta verileri ekleyin, modaliteleri hizalayın veya keşfedilebilir uyumlu
yeteneklere sahip modelleri hedefleyin.

## İstek geçmişi ve yönlendirme analitiği

- `GET /api/request-history` - filtreler (`provider`, `model`, `requestedModel`,
  `status`, `conversationId`, `surface`, `inboundProtocol`, `apiKeyId`,
  `profileId`, `fallback`, `from`, `to`) ve donuk `cursor` sayfalaması ile
  türetilen dizinden (`routing-history.sqlite`) imleç sayfalamalı tam geçmiş.
  `GET /api/request-history/:requestId` tek bir kurallı satır döndürür.
- `GET /api/request-history/:requestId/route-decision` - rota açıklaması: iz
  (adaylar, hariç tutmalar, puan bileşenleri, profil + revizyon), yürütme
  denemesi dizisi ve nihai sonuç.
- `GET /api/routing-analytics` - başarı/başarısızlık/iptal/geri dönüş oranları,
  p50/p95/p99 süresi ve TTFT, eksik akış oranı, soğuma tetikleyen arızalar,
  başarılı istek başına maliyet, kapsam, güven ve açık bir kesme bayrağı.
- `GET /api/routing-profiles`, `POST /api/routing-profiles/dry-run` - profil
  incelemesi ve deneme çalıştırması değerlendirmesi (yukarı akış dağıtımı yok).

Döndürülen geçmiş ve rota kararı yükleri yalnızca maskelenmiş istek meta
verilerini açığa çıkarır (örneğin donuk `apiKeyId` etiketleri). Kimlik
bilgilerini, ham istem gövdelerini veya sağlayıcı sırlarını içermezler.

CLI: `ocx logs explain <request-id>`, `ocx logs rebuild-index`, `ocx logs
index-status`, `ocx route policy list | show | dry-run | evaluate`.

## Geçiş

`routingProfiles` isteğe bağlı ve eklemelidir: mevcut yapılandırma dosyaları
değişmeden yüklenir. `routeDecision` içermeyen eski `usage.jsonl` satırları
değişmeden ayrıştırılır. Geçmiş dizini tek kullanımlıktır -
`routing-history.sqlite` dosyasını silmek, bir sonraki sorguda `usage.jsonl`'den
otomatik bir yeniden oluşturmayı tetikler; `ocx logs rebuild-index` bunu zorlar.
Bu sistemdeki hiçbir şey ağırlıkları, bütçeleri veya aday kümelerini otomatik
olarak ayarlamaz.


