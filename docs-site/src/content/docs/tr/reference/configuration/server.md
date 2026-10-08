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
| `proxy?` | `string` | — | Giden HTTP(S) veya SOCKS5 proxy URL'si (`socks5://host:port`) ya da `${ENV_VAR}`. HTTP URL'leri değişkenler boşsa `HTTP_PROXY` / `HTTPS_PROXY`'ye yazılır. SOCKS5 URL'leri yerleşik gerçek SOCKS5 tünelini kullanır ve `ALL_PROXY`'ye de yazılır (`ocx start --socks5`); bu süreçte miras `HTTP(S)_PROXY` temizlenir. Geri döngü `NO_PROXY` içinde kalır. |
| `emptyCompletionRetry?` | `boolean` | `false` | Metin veya araç çağrısı içermeyen bir Responses tamamlamasını aynı istekle bir kez yeniden denemeyi açıkça etkinleştirir. Yeniden deneme ücretlendirilebilir. `OCX_EMPTY_COMPLETION_RETRY=0`, yapılandırmayı değiştirmeden devre dışı bırakır; combo ve routed-compaction turları hariçtir. |
| `stallTimeoutSec?` | `number` | `300` (public) / kapalı (local) | Akış kesilmeden önce anlamlı üst sunucu ilerlemesi olmadan geçen saniye (Responses ve yerel Chat). Ayarlanmamışsa **yerel** üst sunucu (loopback, private, `.local`/`.lan` adı) için varsayılan kapalı, genel üst sunucu için 300 sn; pozitif değer ikisine de uygulanır (en az 1 sn); `0` sessizlik watchdog'unu her yerde kapatır. Canonical ChatGPT SSE'yi akışsız JSON'a katlayan Responses isteklerinde watchdog kapalı olsa bile bağımsız 15 dakikalık toplam tur sınırı kalır. `/v1/responses/compact` için bekleyen gövde okumaları bu bütçeyi paylaşır ama yerel üst sunucuda bile varsayılan 300 sn'dir; açık değer (`0` dahil) önceliklidir. |
| `connectTimeoutMs?` | `number` | `200000` | Deneme başına DNS/TCP/TLS/nihai başlık son tarihi; gövde üretiminden önce biter. |
| `shutdownTimeoutMs?` | `number` | `5000` | Aktif turlar iptal edilmeden önce zarif boşaltma süresi sınırı. |
| `websockets?` | `boolean` | `false` | Responses WebSocket yolu için `supports_websockets` bildirin. False, HTTP/SSE'yi tutar. |
| `corsAllowOrigins?` | `string[]` | `[]` | CORS tarafından izin verilen ek tam kaynaklar. Geri döngü kaynaklarına her zaman izin verilir. `chrome-extension://<extension-id>` gibi yetki tabanlı tarayıcı uzantısı kaynakları desteklenir; `*` bir joker karakter değildir. Firefox ve Safari uzantı UUID'sini yeniden oluşturur (yükleme başına / tarayıcı başlatma başına), bu nedenle kaynak değiştiğinde girdiyi güncelleyin. |
| `apiKeys?` | `OcxApiKey[]` | `[]` | Geri döngü olmayan bağlamalarda veri düzlemi kabulü için oluşturulmuş `ocx_…` kimlik bilgileri. Yönetim API'lerini yetkilendirmezler; yönetim erişimi [yönetim API referansında](/tr/reference/management-api/) açıklanan ayrı kimlik bilgisini kullanır. Kontrol paneli tarafından yönetilir. |
| `storageCleanupPolicy?` | `StorageCleanupPolicy` | devre dışı | İsteğe bağlı arşivlenmiş oturum temizleme politikası. Asla örtük olarak etkinleştirilmez. |
| `appOwnedMemoryBudgetMb?` | `number` | `256` | Çıkarılabilir uygulamaya ait günlükler, önbellekler, bloblar ve devam yükleri için MiB cinsinden sınır. Aralık 64–4096; bir RSS sınırı değildir. |
| `metricsExport.enabled?` | `boolean` | `false` | Kimliği doğrulanmış `GET /api/metrics` üzerinde süreç yerel toplu istek metriklerini etkinleştirir. Yeniden başlatma gerekir; devre dışıyken yol 404 döndürür ve dışa aktarıcı etkinliği başlamaz. |
| `codexAutoStart?` | `boolean` | `true` | Codex dolgusunun Codex'i başlatmadan önce `ocx ensure` çalıştırmasına izin verin. False, ensure'ı bir işlem yapmayan (no-op) hale getirir. |
| `codexShimAutoRestore?` | `boolean` | `true` | Tamamlanan harici bir Codex güncellemesi değiştirdikten sonra kurulu bir dolguyu geri yükleyin. Ortam vazgeçmesi: `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0`. |
| `syncResumeHistory?` | `boolean` | `true` | Tersine çevrilebilir Codex App geçmişi uyumluluğu. Orijinal meta veriler yedeklenir ve `ocx stop` / `ocx restore` tarafından geri yüklenir. |
| `shadowCallIntercept?` | `{ enabled?: boolean; model?: string; sourceModels?: string[] }` | kapalı | Tanınan Codex yardımcı/gölge çağrılarını, istek için yapılandırılan akıl yürütme çabasını koruyarak seçilen bir modele yeniden yönlendirin. Varsayılan kaynak öneki `gpt-6-luna`, `gpt-5.6-luna`'dır; 0.144.x'e kadar olan eski istemciler `sourceModels`'ın geri yükleyebileceği `gpt-5.4-mini` kullanmıştır. |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | kullanılabilir olduğunda açık | Web arama sidecar seçenekleri. |
| `visionSidecar?` | `OcxVisionSidecarConfig` | kullanılabilir olduğunda açık | Görsel açıklama sidecar seçenekleri. |
| `images?` | `OcxImagesConfig` | otomatik OpenAI seçimi | Codex `image_gen` için bağımsız Görseller aktarma seçenekleri. |

Daha eski bir geliştirme derlemesi yedekleme desteği var olmadan önce devam
geçmişi meta verilerini değiştirdiyse yerel sağlayıcı kurtarmasını zorlamak için
`ocx recover-history --legacy-openai --yes` çalıştırın.
Komut, geçerli dedicated-provider geçmişi de dahil olmak üzere kullanıcı iletisi bulunan tüm `opencodex` satırlarını yeniden etiketler; çalıştırmadan önce lifecycle başvurusundaki tam kapsam uyarısını okuyun.

### Yerel Chat zaman aşımı ve tamamlanma

Yerel Chat de üst sunucu çıktısını beklerken `stallTimeoutSec` kullanır. Boş olmayan metin, akıl yürütme, ret içeriği, araç güncellemeleri ve bitiş olayları süreyi yeniler; bağlantıyı canlı tutan yorumlar, yalnızca rol ve yalnızca kullanım bilgileri yenilemez. Yavaş istemcinin okumasını beklemek süreyi duraklatır. Zaman aşımı `upstream_stall_timeout` üretir: akış istemcileri hata olayı, akışsız istemciler HTTP 502 alır. Sonuç tamamlanmadan iptal edilen istek, başarılı bir kısmi yanıt yerine iptal hatası döndürür. Akışsız Chat, LF ve CRLF ayraçlarını ve çok satırlı data alanlarını destekler.

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
/v1/responses/compact`, `POST /v1/alpha/search` (yerel Codex web arama aktarımı),
`GET /v1/models` ve bağımsız sesli WebSocket yükseltmelerini sunar. `/api/*` ve
kontrol paneli dahil diğer her şey `404` döndürür.

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
modu](/tr/guides/claude-code/#kimlik-doğrulama-modu-auth-mode).

## Gölge çağrılar

Codex, başlıklar ve commit mesajları gibi görevler için küçük yardımcı modeller
kullanır. Tanınan kaynak model öneklerini yapılandırılmış başka bir modele yeniden
yönlendirmek için `shadowCallIntercept`'i etkinleştirin. Değiştirilen istek, yapılandırılmış
akıl yürütme çabasını korur.
`sourceModels`'ı yalnızca bir istemci farklı yardımcı kimlikleri kullandığında
ayarlayın. Yakalama model tabanlıdır: çıplak model kimliği `sourceModels` ile
eşleşen her istek, normal `request_kind: "turn"` istekleri dahil, yeniden
yönlendirilebilir. `x-openai-subagent: collab_spawn` veya `x-codex-turn-metadata` JSON üst bilgisindeki
`subagent_kind: "thread_spawn"` ile oluşturulmuş çocuk olarak işaretlenen istekler muaftır; açıkça oluşturulan
bir alt aracının modeli korunur.

```json
{
  "shadowCallIntercept": {
    "enabled": true,
    "model": "gpt-5.5",
    "sourceModels": ["gpt-6-luna", "gpt-5.6-luna"]
  }
}
```

### Hedef kullanılamadığında

Yerine geçen model, operatörün seçtiği tek hedeftir; bu yüzden artık çözümlenemeyen bir hedef, çağrıyı başka yere göndermek yerine yardımcı çağrıyı başarısız kılar. Hedefin sağlayıcısı devre dışı bırakılmış ya da silinmişse veya kombosu artık yoksa, yakalanan istek üst kaynağa bir şey gönderilmeden önce `409` ve `intercept_target_unavailable` hata koduyla döner. İstek günlüğü de aynı kodu kaydeder. İstek yerel yardımcı modele aktarılmaz ve varsayılan sağlayıcıya geri düşmez; ikisi de sizin seçiminiz olmadan hedefi, kimlik bilgilerini ve maliyeti değiştirirdi. Bir kombo veya yönlendirme profili hedefi kendi üyeleri arasında yük devretmeye devam eder. Sağlayıcı kısmı yapılandırılmış hiçbir şeyi göstermeyen `provider/model` gibi nitelikli bir hedef de aynı şekilde ele alınır ve ayarlar API'si bunu kaydetmeyi reddeder. Varsayılan sağlayıcı üzerinden çözümlenen yalın bir model kimliği geçerli kalır.

Hedefin çözümlendiği sağlayıcıyı devre dışı bırakmak (`disabled: true` ile `PATCH /api/providers?name=<provider>`) veya silmek yine başarılı olur; yanıta `dependentShadowIntercept: { model, enabled }` eklenir ve pano bir uyarı gösterir. Sağlayıcıyı yeniden etkinleştirmek veya başka bir hedef seçmek yakalamayı geri getirir.

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
| `enabled?` | `boolean` | kullanılabilir olduğunda açık | Ana anahtar. `false` olduğunda OpenCodex `web_search` yakalamayı bırakır ve Codex entegrasyonu `~/.codex/config.toml` dosyasına `web_search = "disabled"` yazar. |
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
| `model?` | `string` | arka uca bağlı | OpenAI için `gpt-5.6-luna` veya Anthropic için `claude-sonnet-5`. |
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

## Remote Hub anahtarları ve varsayılanlar

`runtimeRole` varsayılan olarak `standalone` değerindedir. Hub; `hub.managementPublicOrigin`, yalnız loopback `hub.managementIngress` (yokken `enabled:false`) ve tam `remoteGui.allowedTailscaleUsers` (yokken boş) kullanır. İstemci anahtarı `config.json` yerine `service-api-token` içinde kalır; döndürme sırasında `service-api-token.prev` geçici olarak bulunabilir. Kullanım kayıtları yansıtılmaz.

`remoteGui.allowInsecureHttp`, yalnızca eski strict-schema yapılandırmalarının yüklenebilmesi için tutulan, kullanımdan kaldırılmış bir no-op'tur. Yapılandırmadan silin: pairing grant'leri yalnız loopback veya kimliği doğrulanmış HTTPS üzerinden kabul edilir ve `true` değeri düz HTTP pairing'i yeniden açmaz.

## Codex kota ağı tanılaması

Ana Codex hesabının satırındaki `quotaRefresh`, kalan kotayı veya model erişim yetkisini değil, kota sorgusunun sonucunu açıklar. Önbellek kullanıldığında ya da sorgu yapılmadığında alan bulunmayabilir. Sorgu, etkileşimli terminalin değil çalışan proxy servisinin ortamını kullanır. `proxy` ayarlanmazsa mevcut ortam korunur; `"auto"` başlangıçta Windows veya macOS statik HTTP/HTTPS ayarlarını okur. macOS üzerinde devralınmış proxy varsa bu ayarlar okunmaz. macOS üzerinde geçerli `*.<domain>` kalıbı `.<domain>` olur: `*.local` için `foo.local` ve yalın `local` doğrudan gider, `xlocal` gitmez. Tam `169.254/16`, `169.254.0.0/16` ve `fe80::/10` aralıkları bir tanıyla atlanır; link-local IP adresleri proxy kullanır. IP adresleri ve `*` kabul edilir; diğer CIDR, glob ve yalın ana makine istisnaları ortam değiştirilmeden keşfi reddeder. PAC/WPAD, yalnızca SOCKS ayarları ve çalışma sırasındaki değişiklikler otomatik uygulanmaz. TUN ile başarı, HTTP proxy yolunun da çalıştığını tek başına göstermez. [Komutlar ve durumlar için İngilizce bölüme](/reference/configuration/server/#codex-quota-network-diagnostics) bakın.

### Forced Claude Code subagent model

The Subagents page offers **Force all subagents onto one model**, off by default. Select an exposed roster-style id, such as `combo/tev-auto`, then enable the switch. The roster is offered first; unavailable saved roster entries cannot be force targets.

`ocx agent subagents force combo/tev-auto` sets `claudeCode.subagentModelForce`; `ocx agent subagents force -` clears it. `ocx agent status` reports the setting. `GET /api/subagent-models` returns `force`, `forceAvailable`, and `forceStatus`; `PUT` accepts `{ "force": "combo/tev-auto" }` or `{ "force": null }` without changing the roster. Omitting `force` leaves it unchanged. Invalid or unexposed targets are rejected on write; stale targets are reported and skipped at launch.

This takes effect on the **next routed `ocx claude` launch**, injecting `CLAUDE_CODE_SUBAGENT_MODEL` as an explicit proxy alias (with `[1m]` only for an authoritative million-token window; native Claude targets use a reversible native alias) and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. Each nonempty shell-exported variable independently wins. Native launches inject neither variable; plain `claude` is not affected. No plugin files or `settings.json` are modified by this setting.

Claude Code **2.1.257 or newer** is required for FORCE. Plugin and built-in agents (including Explore/Plan) and per-call model arguments are overridden. Forks and subagent skills with `model: inherit` keep the main conversation model. The main loop and Haiku/small-fast sidecars are unaffected. Existing roster files remain available.

The dashboard warns about old or unknown CLI versions, unavailable targets, and either variable already present in `settings.json` → `env` (which overrides launch env). Detection is read-only and server-local: it cannot inspect another launch shell, another machine, or project-local settings. An unknown result is not proof of force support.

## Havuz harcama geçmişinin sürekliliği

Havuz sınırı, istek günlüğündeki hesap etiketinden bağımsız olarak yönlendirmenin seçtiği kanonik sağlayıcıya uygulanır. Şu anda yapılandırılmış her `P` sağlayıcısı için bu kuruluma ait tuzlanmış havuz takma adı `h(pool, P)`, bakiyeler okunurken otomatik olarak `P` ile eşleştirilir. Aynı takma ad altında tutulan eski bakiyeler de buna dahildir. Bağımsız sağlayıcı sınırları için elle öz eşleme eklemek veya tuzu kullanarak karma hesaplamak gerekmez.

Hesap sıra numarası içeren etiketler dahil diğer geçmiş etiketlerin sahibi otomatik olarak belirlenmez. Her özgün bakiye, eşleştiği sağlayıcı grubunda bir kez sayılır. Hâlâ eşleşmemiş pozitif bakiyeler, ihtiyatlı olmak için her aday havuza birer kez eklenir. Kesinleşmiş, rezerve edilmiş ve çözümlenmemiş kullanımın tümü hesaba katılır. Bu yüzden belirsiz geçmiş, kullanılmamış bir havuzu da sınırlayabilir. Güncel adlar ve hesap sırası geçmişin sahibini kanıtlamaz. Kök ve kimlik sınırları bağımsız kalır.

Sahibini doğruladığınız geçmiş için `config.json` dosyasının en üst düzeyindeki `spendPoolAliases` alanına eşleme ekleyin; bu alan `spend` içinde olmamalıdır. Anahtar, bu kurulumun günlüğündeki tam 32 küçük harfli onaltılık karakterden oluşan tuzlanmış havuz takma adıdır. Değer, doğrulanmış ve şu anda yapılandırılmış sağlayıcının tam kimliğidir; başında veya sonunda boşluk bulunamaz. Günlüğü, tuzu ve eşleme kanıtını gizli tutun. Yapılandırılmış bir sağlayıcının kendi takma adı başka bir sağlayıcıya atanamaz. Sağlayıcı kümesi değiştiğinde doğrulama tekrarlanır; doğrulama mevcut tuzu okur, yenisini oluşturmaz.

Otomatik ve açık eşlemeler yalnızca okuma sırasında uygulanır; özgün bakiyeleri taşımaz veya günlüğe kimlik bağlantısı yazmaz. Açık bir eşleme kaldırılınca geçmiş yeniden belirsiz olur; ancak takma ad halen yapılandırılmış bir sağlayıcının kendi takma adıysa otomatik eşleme sürer. Geçersiz eşlemeler yazılırken reddedilir. Elle yapılmış geçersiz bir değişiklik mevcut sınırları korur ve havuza yeni istek kabulünü engeller.

Etkin olmayan belirsiz geçmiş, yalnızca son etkinliği `spend.retentionDays` eşiğinden kesin olarak daha eski olduğunda sona erer. Kapasite baskısı pozitif bakiyeler için bu süreyi kısaltmaz. Etkin rezervasyonlar ve hedefleri sıfır belirteçte bile korunur. Kabul kararında daha düşük toplam kullanılmadan önce silme kaydı kalıcı olarak yazılır.

### Rezervasyonlar ve gönderim sınırı

Kök, kimlik veya havuz sınırı geçerliyse her hedef ya da anahtarın ilk gönderimi normal izleme kapasitesinden bir rezervasyon gerektirir. Rezervasyon alınamazsa sağlayıcıya gönderim yapılmaz. Aynı hedefteki yeniden denemeler aynı kapsamları kullanır; farklı hedef veya anahtar yeni rezervasyon gerektirir. `L`, istek başladığında sabitlenen, isteğin tamamı için fiziksel gönderim sınırıdır. Varsayılan değer dörttür; mevcut OAuth istek profili en fazla on sekiz gönderime izin verir.

Sınırların uygulanıp uygulanmayacağı, geçerli kök, kimlik ve havuz belirteç sınırları ile `L`, her isteğin başlangıcında belirlenir. Yapılandırma değişiklikleri yalnızca değişiklikten sonra başlayan istekleri etkiler. Devam eden istekler, tüm yeniden denemeler ve devam çağrıları için başlangıç politikalarını korur: bir sınırı etkinleştirmek veya düşürmek onları daha fazla kısıtlamaz; yükseltmek veya kaldırmak da daha fazla izin vermez. Yalnızca gözlem modunda başlayan bir istek, tamamlanana kadar bu modda kalır.

Son hesaplaşma, başlamış gönderimlerin raporlarını bekler. Bir gönderim kimliği ancak muhasebesi kalıcılaştıktan sonra unutulur; bakiyesi silinmez. Sınır faturayı değil gönderim sayısını sınırlar: ilk tahmini aşan gerçek kullanımın tamamı kaydedilir. Geçerli bir harcama sınırı yoksa yalnızca gözlem davranışı sürer; izleme kapasitesi dolduğunda kayıtların atlanması da değişmez. Kimlik bağlantısı içeren yeni kontrol noktaları eklenmez.

Claude CLI, CodeBuddy ve Qoder için her CLI çağrısı bir gönderim sayılır. Başlatmadan önce normal rezervasyon gerekir; alınamazsa çağrı reddedilir. CLI içindeki yeniden denemeler ve araç turları istek genelindeki gönderim sınırını ayrıca tüketmez. Maliyetleri, ilk tahmini aşan bölüm dahil, raporlanan gerçek kullanıma göre hesaplanır.

### 2.80.0 sürümüne dönüş: C sözleşmesi

Yeni kayıtlar olağan v1 biçimini ve `pool` takma ad alanını kullanır. Değiştirilmemiş 2.80.0 bunları kendi etiket bazlı kurallarıyla okur, günlüğü sıkıştırır ve saklama süresini uygular. Güncel günlüğü ve tuzu koruyun; eski bir kopyayı geri yüklemek, o kopyadan sonra kaydedilen harcamayı kaybettirir. Geriye dönük yama, başlatıcı engeli veya mutabakat komutu gerekmez.

Sürüm düşürme, kanonik toplamların korunacağını veya aynı trafik baştan beri 2.80.0 üzerinde işlenseydi kalacak kotayla eşitliği garanti etmez. Yeniden yükseltmede, yapılandırılmış sağlayıcıların otomatik öz eşlemeleri ve güncel açık eşlemeler, 2.80.0 tarafından hâlâ tutulan özgün bakiyelere uygulanır. Yeni kontrol noktaları eski okuyucunun koruması gereken kimlik bağlantısı metaverisi içermez.

Yayımlanmamış deneysel sürümlerin `pool-current` veya `poolContinuity` içeren günlükleri, daha sonra sıkıştırılsalar bile C sözleşmesinin dışındadır. Özgün bakiyeleri normal saklama süresi dolana kadar belirsiz geçmiş olarak tutulur; hemen dönüştürülmez veya silinmez.

Tam ama geçersiz bir kayıt, son satırdaki `null` dahil, sınır uygulanan isteklerin kabulünü engeller. Sıkıştırma geçerli muhasebeyi temiz bir kontrol noktasında koruyabilir; çalışan süreç temiz günlükle yeniden başlatılana kadar ret durumu sürer. Yarım kalmış son JSON satırı mevcut kurtarma kurallarına tabidir. Ayrıntılar ve hata kodları için [İngilizce kaynağa](/reference/configuration/server/#historical-pool-continuity) bakın.
