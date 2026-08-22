---
title: Sunucu ve Çalışma Zamanı Yapılandırması
description: Dinleyici, uzaktan erişim, kabul anahtarları, zaman aşımları, depolama, sidecar'lar, gölge çağrılar ve başlangıç davranışı.
---

Sunucu ayarları yerel proxy'nin nasıl dinleyeceğini, uzak trafiği nasıl
koruyacağını, kaynakları nasıl yöneteceğini ve sağlayıcı istekleri etrafındaki
yardımcı özellikleri nasıl çalıştıracağını kontrol eder.

## Sunucu alanları

| Alan | Tip | Varsayılan | Anlamı |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | Proxy dinleme portu. |
| `hostname?` | `string` | `"127.0.0.1"` | Bağlama adresi. Geri döngü olmayan bağlamalar `OPENCODEX_API_AUTH_TOKEN` gerektirir. |
| `proxy?` | `string` | — | Giden HTTP(S) proxy URL'si veya `${ENV_VAR}`. Yalnızca bu değişkenler ayarlanmadığında `HTTP_PROXY` / `HTTPS_PROXY`'ye uygulanır; geri döngü `NO_PROXY` içinde kalır. |
| `emptyCompletionRetry?` | `boolean` | `false` | Metin veya araç çağrısı içermeyen bir Responses tamamlamasını aynı istekle bir kez yeniden denemeyi açıkça etkinleştirir. Yeniden deneme ücretlendirilebilir. `OCX_EMPTY_COMPLETION_RETRY=0`, yapılandırmayı değiştirmeden devre dışı bırakır; combo ve routed-compaction turları hariçtir. |
| `stallTimeoutSec?` | `number` | `300` | `response.incomplete` öncesinde yukarı akış verisi olmadan geçen saniye. Minimum 1. |
| `connectTimeoutMs?` | `number` | `200000` | Deneme başına DNS/TCP/TLS/nihai başlık son tarihi; gövde üretiminden önce biter. |
| `shutdownTimeoutMs?` | `number` | `5000` | Aktif turlar iptal edilmeden önce zarif boşaltma süresi sınırı. |
| `websockets?` | `boolean` | `false` | Responses WebSocket yolu için `supports_websockets` bildirin. False, HTTP/SSE'yi tutar. |
| `corsAllowOrigins?` | `string[]` | `[]` | CORS tarafından izin verilen ek tam kaynaklar. Geri döngü kaynaklarına her zaman izin verilir. `chrome-extension://<extension-id>` gibi yetki tabanlı tarayıcı uzantısı kaynakları desteklenir; `*` bir joker karakter değildir. Firefox ve Safari uzantı UUID'sini yeniden oluşturur (yükleme başına / tarayıcı başlatma başına), bu nedenle kaynak değiştiğinde girdiyi güncelleyin. |
| `apiKeys?` | `OcxApiKey[]` | `[]` | Geri döngü olmayan bağlamalarda yönetim ve veri düzlemi kimlik doğrulaması tarafından kabul edilen oluşturulmuş `ocx_…` kimlik bilgileri. Kontrol paneli tarafından yönetilir. |
| `storageCleanupPolicy?` | `StorageCleanupPolicy` | devre dışı | İsteğe bağlı arşivlenmiş oturum temizleme politikası. Asla örtük olarak etkinleştirilmez. |
| `appOwnedMemoryBudgetMb?` | `number` | `256` | Çıkarılabilir uygulamaya ait günlükler, önbellekler, bloblar ve devam yükleri için MiB cinsinden sınır. Aralık 64–4096; bir RSS sınırı değildir. |
| `codexAutoStart?` | `boolean` | `true` | Codex dolgusunun Codex'i başlatmadan önce `ocx ensure` çalıştırmasına izin verin. False, ensure'ı bir işlem yapmayan (no-op) hale getirir. |
| `codexShimAutoRestore?` | `boolean` | `true` | Tamamlanan harici bir Codex güncellemesi değiştirdikten sonra kurulu bir dolguyu geri yükleyin. Ortam vazgeçmesi: `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0`. |
| `syncResumeHistory?` | `boolean` | `true` | Tersine çevrilebilir Codex App geçmişi uyumluluğu. Orijinal meta veriler yedeklenir ve `ocx stop` / `ocx restore` tarafından geri yüklenir. |
| `shadowCallIntercept?` | `{ enabled?: boolean; model?: string; sourceModels?: string[] }` | kapalı | Tanınan Codex yardımcı/gölge çağrılarını düşük çabayla seçilen bir modele yeniden yönlendirin. Varsayılan kaynak öneki `gpt-5.6-luna`'dır; 0.144.x'e kadar olan eski istemciler `sourceModels`'ın geri yükleyebileceği `gpt-5.4-mini` kullanmıştır. |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | kullanılabilir olduğunda açık | Web arama sidecar seçenekleri. |
| `visionSidecar?` | `OcxVisionSidecarConfig` | kullanılabilir olduğunda açık | Görsel açıklama sidecar seçenekleri. |
| `images?` | `OcxImagesConfig` | otomatik OpenAI seçimi | Codex `image_gen` için bağımsız Görseller aktarma seçenekleri. |

Daha eski bir geliştirme derlemesi yedekleme desteği var olmadan önce devam
geçmişi meta verilerini değiştirdiyse yerel sağlayıcı kurtarmasını zorlamak için
`ocx recover-history --legacy-openai` çalıştırın.

## Uzaktan erişim

Varsayılan `127.0.0.1` bağlaması yalnızca geri döngüdür. `0.0.0.0` gibi geri
döngü olmayan bir adres hem `/api/*` hem de veri düzleminde belirteç kimlik
doğrulaması gerektirir. Başlamadan önce belirteci dışa aktarın:

```bash
export OPENCODEX_API_AUTH_TOKEN="your-secret-token"
ocx start
```

Proxy bu değişken olmadan uzak bir bağlamayı reddeder. Bir arka plan servisi
için launchd, systemd veya Görev Zamanlayıcı'nın alması amacıyla `ocx service
install`'dan önce dışa aktarın. İstemciler şunu göndermelidir:

```text
x-opencodex-api-key: your-secret-token
```

| Uç nokta | `Authorization: Bearer` | `x-opencodex-api-key` | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` | kabul edilmez | **gerekli** | kabul edilmez |
| `/v1/chat/completions` | kabul edilmez | **gerekli** | kabul edilmez |
| `/v1/messages` | kabul edilir | kabul edilir | kabul edilir |
| `/v1/messages/count_tokens` | kabul edilir | kabul edilir | kabul edilir |
| `/v1/models` | kabul edilir | kabul edilir | kabul edilir |

Responses ve Chat Completions, olası Codex Direct doğrudan geçişi için
`Authorization`'ı ayırır, bu nedenle orada yalnızca özel kabul başlığı kabul
edilir. Kontrol paneli tarafından oluşturulan `apiKeys`, başlangıçtan sonra
ortam belirtecinin yerini alabilir; adaylar sabit zamanda karşılaştırılır.

Messages ve `count_tokens`, yönlendirilen istemci uyumluluğu için üç kabul
formunu da kabul etmeye devam eder. Yerel Anthropic doğrudan geçişi geri döngü
olmayan bir bağlamada daha katıdır: proxy kabulü `x-opencodex-api-key`
kullanmalıdır, `Authorization` ve `x-api-key` ise Anthropic kimlik bilgileri
için ayrılmıştır. Bu sağlayıcı başlıklarına yerleştirilen herhangi bir proxy
kabul sırrı iletilmeden önce kaldırılır.

:::caution[LAN maruziyeti]
`0.0.0.0` bağlaması proxy'yi ve yapılandırılmış sağlayıcı erişimini LAN'a açar.
Yalnızca güçlü bir belirteçle güvenilen ağlarda kullanın.
:::

### Belirteci alamayan yerel istemciler

Uzak bir bağlama, yerel olanlar da dahil olmak üzere her arayandan bir kimlik
bilgisi gerektirir. Bu belirli bir durumu bozar: Codex giriş noktasını doğrudan
çözen bir ana bilgisayar süreci tarafından başlatılan bir `codex app-server`
(`require.resolve('@openai/codex/bin/codex.js')`), oluşturulan `codex`
dolgusundan asla geçmez, bu nedenle asla `OPENCODEX_API_AUTH_TOKEN`'ı devralmaz
ve her model çağrısı bir akış açılmadan önce `401` ile başarısız olur.

`unauthenticatedLoopbackListener`, bir kimlik bilgisi olmadan kabul eden
`127.0.0.1`'e bağlı ikinci bir dinleyici açar. Ana dinleyiciye dokunulmaz — uzak
arayanlar yine de belirtece ihtiyaç duyar.

```json
{
  "hostname": "0.0.0.0",
  "port": 10100,
  "unauthenticatedLoopbackListener": { "enabled": true, "port": 10200 }
}
```

`ocx sync` daha sonra yönetilen Codex sağlayıcı bloğuna `base_url =
"http://127.0.0.1:10200/v1"` yazar ve kimlik doğrulama başlığını atlar, böylece
doğrudan oluşturulan bir app-server herhangi bir kimlik bilgisi aktarımı olmadan
çalışır.

Port gereklidir ve proxy portundan farklı olmalıdır. Asla işletim sistemi
tarafından atanmaz: geçici bir port yeniden başlatmalar arasında değişirken
zaten çalışan app-server'lar önceki `base_url`'i tutardı.

Dinleyici yalnızca `POST /v1/responses`, onun WebSocket yükseltmesi, `POST
/v1/responses/compact` ve `GET /v1/models` sunar. `/api/*` ve kontrol paneli
dahil diğer her şey `404` döndürür.

:::danger[Bu kimliği doğrulanmamış bir yüzeydir]
Makinedeki her süreç bu dinleyiciyi kullanabilir. Hesap kotasını ve ücretli
sağlayıcı kimlik bilgilerini harcar ve kimliği doğrulanmış uzak istemcilerin
bağlı olduğu paylaşılan tur kapasitesini tüketebilir. Paylaşılan veya çok
kiracılı bir ana bilgisayarda etkinleştirmeyin.

`127.0.0.1`'e bağlamak çekirdeğin uzak bağlantıları reddettiği anlamına gelir,
ancak bir tarayıcıyı durdurmaz: ziyaret ettiğiniz bir sayfa tarayıcınızın
`127.0.0.1`'e bağlanmasını sağlayabilir. Dinleyici bu nedenle sıradan bir geri
döngü bağlamasıyla aynı `Host` ve `Origin` kontrollerini uygular. Varsayılan
olarak kapalıdır.
:::

### SSH port yönlendirme

Uzaktan kullanım uzak bir bağlama gerektirmez. Geri döngüyü tutun ve
yönlendirin:

```bash
ssh -L 20100:localhost:10100 you@remote
```

Herhangi bir yerel port çalışır. Host'u `localhost`, `127.0.0.1` veya `::1`
olarak çözümlenen istekler porttan bağımsız olarak geri döngü kalır, bu nedenle
`http://localhost:20100/v1` çalışır. Bu temel URL'yi istemcide ayarlayın; `ocx`
yönetilen istemci yapılandırmasına yalnızca varsayılan yerel `127.0.0.1`
adresini yazar.

Sağlayıcı OAuth geri aramaları sabit bir uzak portta dinler. Uzak makinede
oturum açın veya bu portu da yönlendirin:

```bash
ssh -L 20100:localhost:10100 -L 1455:localhost:1455 you@remote
```

Kayıtlı bir geri arama portu zaten kullanımdaysa ve oturum açma yüzeyi manuel
girdi sunuyorsa OpenCodex kayıtlı yönlendirme URI'sini tutar ve yine de
sağlayıcı yetkilendirme URL'sini döndürür. Sağlayıcı girişini tamamlayın,
ardından tarayıcı adres çubuğundaki son yönlendirme URL'sini veya yetkilendirme
kodunu OpenCodex'e yapıştırın. Bekleyen akış durumu ve PKCE doğrulamasını korur.
Manuel girdisi olmayan arayanlar yine de kapalı olarak başarısız olur.

:::caution[Yönlendirilen geri döngü kimliği doğrulanmamıştır]
Düz `ssh -L` yerel geri döngünüzü dinler ve varsayılan kimliği doğrulanmamış
bağlama için güvenlidir. `ssh -g -L`, geniş kapsayıcı yayınlama veya istemci
tarafını `0.0.0.0` üzerinde açığa çıkaran yönlendirme modlarını kullanmayın.
Emin olmadığınızda `ssh -L 127.0.0.1:20100:localhost:10100` ile açıkça bağlayın.
:::

## Depolama temizliği

`storageCleanupPolicy` varsayılan olarak devre dışıdır. Etkinleştirildiğinde
arşivlenen baytlar `trigger.archivedBytesOver`'ı aştıktan sonra `startup`,
`daily`, `weekly` veya `manual` olarak çalışır. En eski arşivleri
`target.reduceToBytes` veya `target.removeOldestPercent` hedefine doğru seçer.
`mode` varsayılan olarak `quarantine`'dir; `permanent`'ı yalnızca açık bir
yıkıcı seçenek olarak kullanın. Politika `lastRun` ve `nextRun`'ı kalıcı hale
getirir. Depolama sayfasında veya `GET`/`PUT /api/storage/cleanup-policy` ile
yapılandırın; `POST /api/storage/cleanup-policy/run` ile manuel bir çalıştırma
tetikleyin.

## Claude Code (`claudeCode`)

Bu ayarlar `/v1/messages`, `/v1/messages/count_tokens`, `ocx claude` başlatıcısı
ve Claude kontrol paneli sayfasını yönetir.

| Anahtar | Tip | Varsayılan | Açıklama |
| --- | --- | --- | --- |
| `claudeCode.bodyStallSec?` | `number` | `90` | Toplam süre değil, bir okuma beklemedeyken saniye cinsinden yerel doğrudan geçiş gövdesi hareketsizlik bütçesi. Minimum 1; tam olarak `0` devre dışı bırakır. |
| `claudeCode.bodyMaxBytes?` | `number` | `67108864` | Akışlı ve arabelleğe alınmış yanıtlar için kümülatif yerel doğrudan geçiş gövdesi sınırı. Tam olarak `0` devre dışı bırakır. |
| `claudeCode.authMode?` | `"proxy" \| "subscription"` | auto | Başlatmanın `ANTHROPIC_AUTH_TOKEN`'ı nasıl işlediği. Auto her başlatmada kimlik doğrulamasını algılar; açık bir değer asla geçersiz kılınmaz. |
| `claudeCode.authModeMigratedAt?` | `string` | ayarlanmamış | Dahili tek seferlik yükseltme işaretçisi. Manuel olarak ayarlamayın. |
| `claudeCode.subagentEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | inherit | Oluşturulan `~/.claude/agents/ocx-*.md` dosyasına yazılan çaba; Codex rehberliğinden ve proxy sınırlarından ayrıdır. Yeniden oluşturmak için `ocx claude` üzerinden yeniden başlatın. |

Otomatik kimlik doğrulama saklanan Claude kimlik doğrulaması bulunduğunda
subscription'ı, hiçbiri bulunmadığında proxy'yi ve algılama yetersiz olduğunda
bir uyarı ile subscription'ı seçer. Bkz. [Claude Code kimlik doğrulama
modu](/tr/guides/claude-code/#auth-mode).

## Gölge çağrılar

Codex, başlıklar ve commit mesajları gibi görevler için küçük yardımcı modeller
kullanır. Tanınan kaynak model öneklerini düşük çabayla yapılandırılmış başka
bir modele yeniden yönlendirmek için `shadowCallIntercept`'i etkinleştirin.
`sourceModels`'ı yalnızca bir istemci farklı yardımcı kimlikleri kullandığında
ayarlayın. Codex 0.145.0+, istek amacını `x-codex-turn-metadata` içinde
işaretler: normal `request_kind: "turn"` istekleri seçilen modeli tutarken
tanınan bakım istekleri yeniden yönlendirilebilir. Bu meta verileri içermeyen
istemciler eski önek davranışını korur.

```json
{
  "shadowCallIntercept": {
    "enabled": true,
    "model": "gpt-5.5",
    "sourceModels": ["gpt-5.6-luna"]
  }
}
```

## Sidecar'lar

### `images` (`OcxImagesConfig`)

| Alan | Tip | Varsayılan | Anlamı |
| --- | --- | --- | --- |
| `provider?` | `string` | otomatik OpenAI seçimi | `/v1/images/generations` ve `/v1/images/edits` için açık özel API anahtarlı `openai-responses` sağlayıcısı. Kayıt defteri tarafından yönetilen kimlikler reddedilir. |
| `timeoutMs?` | `number` | `300000` | Tek bir bağımsız Görseller isteği için tüm istek zaman aşımı. |

Açık seçim sağlayıcı eksik, devre dışı, uyumsuz olduğunda veya kullanılabilir
bir anahtardan yoksun olduğunda kapalı olarak başarısız olur; asla başka bir
ücretli yukarı akışa geri dönmez. Uç nokta Codex tarafından beklenen OpenAI
Images API yollarını ve yanıt şeklini uygulamalıdır.

### `webSearchSidecar` (`OcxWebSearchSidecarConfig`)

| Alan | Tip | Varsayılan | Anlamı |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | kullanılabilir olduğunda açık | Ana anahtar. |
| `backend?` | `"openai" \| "anthropic" \| "xai" \| "gemini" \| "exa"` | `openai` | Açık değer kazanır; ayarlanmadığında her zaman `openai` seçilir. `anthropic` ve `xai` yalnızca açıkça yapılandırıldığında çalışır; `gemini` ve `exa` executor'ları sunulana kadar ayrılmıştır. |
| `model?` | `string` | arka uca bağlı | OpenAI için `gpt-5.6-luna`, Anthropic için `claude-sonnet-5` veya xAI için `grok-4.6`. Eski açık `gpt-5.4-mini` başlangıçta geçirilir. |
| `exaApiKey?` | `string` | yok | `exa` arka ucu için operatör anahtarı. Yalnızca yazılır; yönetim okumaları saklanan değeri asla döndürmez. |
| `xSearch?` | `object` | atlanmış | Yalnızca xAI için hosted `x_search` opt-in: `enabled`, birbirini dışlayan `allowedXHandles` / `excludedXHandles` dizileri (en fazla 20) ve ISO `fromDate` / `toDate` (`YYYY-MM-DD`). |
| `reasoning?` | `string` | `low` | Sidecar çabası. `minimal` web araması ile reddedilir. |
| `maxSearchesPerTurn?` | `number` | `3` | Ana model turu başına izin verilen gerçek aramalar. |
| `routedModelStallTimeoutMs?` | `number` | `200000` | Yalnızca yapılandırma dosyasındaki yönlendirilen model ham gövde hareketsizlik süresi sınırı. Tamsayı 1–2147483647; boş olmayan her parça onu sıfırlar. |
| `timeoutMs?` | `number` | `60000` | Bir barındırılan arama için son tarih. |

OpenAI arka ucu bir ChatGPT girişi ve etkinleştirilmiş ChatGPT `forward`
sağlayıcısı gerektirir. Claude gelen yönlendirilen yeniden oynatmaları ana
ChatGPT kimlik doğrulamasını dahili isteğe enjekte eder. Anthropic arka ucu
etkinleştirilmiş bir Anthropic OAuth sağlayıcısından gelen aktif saklanan kimlik
bilgisini kullanır. Kullanılabilir hesabı olmayan açıkça seçilmiş bir Anthropic
arka ucu geri dönmek yerine kapalı olarak başarısız olur. Anthropic yürütücüsü
yerel `web_search_20250305` aracını kullanır.
xAI arka ucu kullanılabilir, saklanmış bir Grok OAuth hesabı gerektirir, hosted `web_search` kullanır
ve `xSearch.enabled` true olduğunda hosted `x_search` ekler. Hatalı `xSearch` yönetim girdisi `400`
döndürür; hatalı kalıcı blok planlama sırasında kapalı olarak başarısız olur. `gemini` ve `exa`
hatları kimlik bilgisi keşfi veya fallback ile hiçbir zaman etkinleşmez; operatör bunları açıkça
seçmelidir. `exaApiKey` yazmalarda kabul edilir ancak yönetim yanıtlarından çıkarılır.

Aramayı dört saat yönetir: temel `stallTimeoutSec`, `connectTimeoutMs`,
yönlendirilen model hareketsizliği ve barındırılan arama zaman aşımı. Geçerli
köprü denetleyicisi maksimum artı 30 saniyedir. Yönlendirilen durma bir
hareketsizlik korumasıdır, toplam bir üretim süresi sınırı değildir.

### `visionSidecar` (`OcxVisionSidecarConfig`)

| Alan | Tip | Varsayılan | Anlamı |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | kullanılabilir olduğunda açık | Ana görsel açıklama anahtarı. |
| `backend?` | `"openai" \| "anthropic"` | auto | Açık değer önceliklidir; ayarlanmadığında kullanılabilir kayıtlı bir Anthropic OAuth kimlik bilgisi tercih edilir, aksi halde `openai` kullanılır. |
| `model?` | `string` | arka uca bağlı | OpenAI için `gpt-5.4-mini` veya Anthropic için `claude-sonnet-5`. |
| `maxDescriptionsPerTurn?` | `number` | `8` | Ana tur başına kabul edilen yeni açıklama önbellek ıskalamaları. `0` çağrıları devre dışı bırakır; geçersiz değerler varsayılanı kullanır. |
| `timeoutMs?` | `number` | `45000` | Sidecar getirme zaman aşımı. Tamsayı 1–2147483647. |

Vizyon yalnızca sağlayıcısının `noVisionModels` listesindeki bir modele
gönderilen görseller için etkinleşir. OpenAI arama ile aynı oturum açma/iletme
gereksinimlerine sahiptir; açıkça seçilen Anthropic kullanılabilir bir kimlik
bilgisi olmadan kapalı olarak başarısız olur. Başarılı `data:` açıklamaları arka
uç, model, ayrıntı, görsel baytları ve normalleştirilmiş mesaj bağlamına göre
anahtarlanan sınırlı bir önbellek kullanır. İsabetler ve aynı turdaki kopyalar
sınırı tüketmez. Uzak `https:` görselleri ve başarısız veya boş açıklamalar
önbelleğe alınmaz.

Anthropic OAuth sidecar'ları opencodex'in mevcut Claude Code OAuth parmak izini
yeniden kullanır. Hedeflenen hesap ve iş yükünü kapsamlı bir şekilde test edin.
