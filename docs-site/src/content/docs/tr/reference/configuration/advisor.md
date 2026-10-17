---
title: Danışman
description: manual, preflight ve kanıta dayalı adaptive politikalarıyla bağımsız uzman danışması.
---

Danışman, worker'ın görevini inceleyen ve tavsiye döndüren bağımsız bir uzman modeldir. Danışmayı uçtan uca OpenCodex sahiplenir: proxy, worker'ın turuna sentetik `advisor` aracını enjekte eder, danışmayı normal yönlendirme otoritesi aracılığıyla kendisi yürütür ve tavsiyeyi geri enjekte ederek özgün worker'ın devam etmesini sağlar. Worker'ın bir şey devretmesine, spawn etmesine veya sağlayıcı kimlik bilgisi taşımasına gerek yoktur.

Bu, alt ajan yüzeyinden farklıdır (bkz. [Ajan yapılandırması](/tr/reference/configuration/agents/)): alt ajanlar, Codex'in işbirliği araçları üzerinden worker tarafından başlatılan delegasyondur. Danışman, istemcinin hiç görmediği proxy tarafı bir sidecar'dır — hiçbir şey spawn etmeyen bir worker bile tavsiye alabilir.

## Yapılandırma

Kontrol panelindeki **Advisor** sayfasında katalogdan model seçin. Yerel, sağlayıcı, hesap, özel model ve combo tanımlayıcıları aynen kaydedilir. Devre dışı veya ilk seçimi bekleyen modeller yeni seçenek olarak sunulmaz. Listede bulunmayan kayıtlı tanımlayıcı, değiştirilene veya temizlenene kadar uyarıyla korunur. Yükleme hatası seçimi korur ve yeniden deneme sunar. Metin önerisi verebilen bir model seçin; katalog danışma uyumluluğunu garanti etmez. CLI ve API, yönlendiricinin desteklediği model dizelerini kabul etmeye devam eder.

```json
{
  "advisor": {
    "enabled": true,
    "model": "gpt-6-astra",
    "effort": "max",
    "policy": "preflight",
    "contextSharingConsent": "v1"
  }
}
```

| Alan | Tür | Varsayılan | Anlam |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | Ana anahtar. Kapalıyken istek yolunda hiçbir danışman davranışı olmaz. |
| `model?` | `string` | — | Uzman model. Yönlendiricinin kabul ettiği herhangi bir model dizisi: çıplak yerel model (`gpt-6-astra`), açık `provider/model` (`anthropic/claude-sonnet-4-6`, `xai/grok-...`) veya hesap nitelemeli yerel model. Sağlayıcılar arası tam desteklenir. |
| `effort?` | `string` | `"max"` | Danışman çağrısının muhakeme düzeyi (`low`–`ultra`). |
| `policy?` | `"manual" \| "preflight" \| "adaptive"` | `"manual"` | Ne zaman danışılır. |
| `maxConsultationsPerTask?` | `integer` | `3` | Uyarlanabilir görev bütçesi: manuel çağrılar dahil 1–3 deneme. |
| `timeoutMs?` | `number` | `120000` | Loopback danışma zaman aşımı. |
| `contextSharingConsent?` | `"v1"` | yok | Yapılandırılmış danışman sağlayıcısına görev bağlamını gönderme onayı. Güncel değer yalnızca `"v1"`. Yok, eskimiş veya başka bir değer görev içeriğinin gönderilmemesi demektir. `enabled: true` bu onay değildir. |

Panodaki **Advisor** sayfası veya `ocx advisor status|on|off|set --model <model> --effort <effort> --policy <manual|preflight|adaptive>` ile yönetin.

Güncel onay yokken `ocx advisor on` sağlayıcılar arası gönderimi açmaz: açıklamayı basar ve durur. `ocx advisor on --ack-context-sharing` ile `ocx advisor consent` `v1` kaydeder. `ocx advisor consent --revoke` onayı kaldırır ve gönderimi hemen durdurur. `ocx advisor set` onay vermez. Panodaki onay kutusu önceden işaretli değildir.

## Politikalar

- **`manual`** — yalnızca worker sentetik `advisor` aracını açıkça çağırdığında danışılır. Çağrı proxy tarafından yakalanır, istemciye hiç gösterilmez ve yerel araç olarak yürütülmez.
- **`preflight`** — OpenCodex ayrıca görev başına bir danışmayı otomatik olarak dener. Worker ilk yönelim kanıtını (son kullanıcı mesajından sonra bir asistan araç çağrısı VEYA araç sonucu) ürettikten sonra, worker aracı hiç çağırmasa da proxy uzmana danışır ve worker'ın bir sonraki turundan önce tavsiyeyi enjekte eder. Tetikleyici deterministik, belgelenmiş bir yaklaşımdır; anlamsal bir "takıldı" dedektörü değildir. BAŞARISIZ olan bir danışma denemesi sessizce tavsiye sayılmaz: görev, başarısızlık defteri kaydının süresi dolduğunda yeniden dener, böylece geçici bir danışman kesintisi politikayı kalıcı olarak susturmaz.

## Onay

Operatör bağlam paylaşımı onayı `v1` kaydetmeden görev bağlamı gönderilmez. Onay sürümlüdür: açıklama genişlerse bu izin yeniden kullanılmaz, `v2` gerekir. Çalışma zamanı bunu zorlar. Eksik veya eskimiş değer danışmanı çalışmaz kılar (`advisor_context_sharing_consent_required`) ve kodlama isteğini düşürmez. Worker, danışman modeli ve görev metnindeki bir dize onay veremez.

## Danışmanın gördüğü şey

Bir danışma şunları gönderebilir:

- son kullanıcı isteği
- ayrıştırılmış konuşmada görünen kullanıcı, asistan ve geliştirici metni
- araç çağrıları ve argümanları
- araç sonuçları
- worker araç kataloğu ve açıklamaları
- worker kimliği ve yapılandırılmış danışman modeli
- worker `advisor()` çağırdığında isteğe bağlı odak sorusu

Yapılandırılmış danışman sağlayıcısı, worker sağlayıcısından farklı olabilir.

OpenCodex bu isteme sağlayıcı API anahtarlarını, Authorization başlıklarını, OAuth belirteçlerini, yalnızca arka uca ait yapılandırma sırlarını, süreç ortamını veya gizli düşünce zincirini koymaz. Şifreli sağlayıcıya özel akıl yürütmeyi çözüp iletmez. **Görev içeriği sırlardan arındırılmaz.** Göreve yapıştırılan bir anahtar, araçların okuduğu dosyadaki bir sır veya bir aracın ya da günlüğün yazdırdığı belirteç gönderilebilir. OpenCodex genel bir DLP çalıştırmaz.

## Yetki

Elle danışma, worker'ın kendisinin yaptığı `advisor` çağrısının araç sonucudur. Sonuç bir JSON nesnesidir. `advice` alanı danışman modelinin metnidir. `status` alanını çalışma zamanı yazar.

Otomatik tavsiyenin alıntılanmış JSON içeriği ayrı bir user rolü danışma mesajında taşınır. Developer mesajında yalnızca sabit çalışma zamanı yönergesi kalır; danışmanın ürettiği metin developer/system içeriğine girmez. OpenAI Chat ve Anthropic bunu sahte araç çağrısı olmadan destekler. JSON alıntılama yapısal kaçışı ve alan sahteciliğini önler; doğal dildeki saldırılara karşı kusursuz yalıtım sağlamaz. Özel bir protokol tavsiyeyi kullanıcı isteğinden daha açık ayırabilir. Her istekte en fazla üç danışma ve dört worker sürdürmesi vardır. Danışma sınırında advisor aracı kaldırılır; yinelenen çağrıya sınır sonucu ile yalnızca bir son sürdürme verilir. Sonraki çağrı yeni gönderim yapılmadan 502 advisor_continuation_limit ile biter. Boş tamamlama tekrarları da aynı sınırı paylaşır.

Bastırma, danışmanın dizelerini okumaz. Otomatik yineleme ayıklama sunucunun defterine aittir. Taşıma metnini kopyalayan bir developer iletisi de preflight'ı bastırmaz.

## Maliyet ve hesap

Her danışma gerçek bir ek model çağrısıdır. Worker'ın token sayılarına asla katılmaz; **danışman modeli** altında kullanımda görünür ve her danışma tetikleyici, süre, durum ve kullanımı içeren bir `[advisor]` günlük satırı yazar — böylece bir danışman çağrısı her zaman günlüklerden kanıtlanabilir.

## Hata davranışı

Danışman fail-open davranır: gönderilmiş bir danışma başarısız olursa (model kullanılamıyor, yapılandırma hatası, zaman aşımı) worker kısa ve yanıltıcı olmayan bir "danışman kullanılamıyor" bildirimi alır (preflight için `<opencodex_advisor_unavailable>` mesajı, manual için hata araç sonucu) ve göreve devam eder. Hiçbir şey yalnızca danışma iptal edildiğinde enjekte edilmez; hiç başlatılmayan yapılandırmalarda (kapalı, model yok veya güncel bağlam paylaşımı onayı yok) preflight bildirimi de gönderilmez. Güncel onay olmadan yapılan manuel `advisor()` çağrısı consent-required araç sonucu döner ve dışarı bir şey göndermez. Danışma hatası kodlama isteğini asla başarısız kılmaz ve oturumun ana modelini asla değiştirmez.

## PR1 sınırlamaları

- Yerel OpenAI passthrough turları (ChatGPT havuzu worker'ları) sentetik aracı almaz; danışman desteği yönlendirilen (çevrilen) sağlayıcıları kapsar. Preflight danışması run-turn bağdaştırıcılarına uygulanır; araç uygulanmaz.
- Anlamsal takılma algılama, tamamlanma incelemesi, yükseltme katmanları, çoklu danışman veya oylama yoktur.
- Preflight tekilleştirme defteri süreç içindedir; proxy yeniden başlatıldıktan sonra devam eden bir görev bir preflight danışması daha alabilir.

## Kanıta dayalı uyarlanabilir danışma ve etkinlik

`adaptive`, ilk danışmaya ek olarak aynı çalışma dizinindeki aynı doğrulama başarısız olduğunda, sonraki dosya düzenlemesi tamamlandığında ve yeni doğrulama tekrar başarısız olduğunda danışır. Başarı hata durumunu temizler; düzenleme öncesinde başlayan kontrol onarım sonrası deneme sayılmaz. İlk danışma ve başarısız onarım ayrı ayrı tekilleştirilir. Otomasyon sabit bir konuşma kimliği gerektirir. Eşleşen araç çağrıları/sonuçları ve açık çıkış kodu gerekir. Karmaşık betikler, toplu çağrılar, shell düzenlemeleri ve belirsiz çıktılar tetiklemez.

`ocx advisor set --policy adaptive --max-consultations 2` ile ayarlayın. Manuel ve otomatik denemeler görev başına 1–3 bütçesini paylaşır. Sunucu göndermeden önce `OPENCODEX_HOME/advisor-budget.sqlite` dosyasına rezervasyon yazar; yeniden başlatma veya worker değişimi sayacı sıfırlamaz. Yalnızca görev özetleri, sayaçlar ve süreler tutulur: ilk denemeden itibaren 24 saat, en fazla 512 görev. Bütçe kullanılamıyorsa worker devam eder. Gönderilen başarısız veya iptal edilen çağrılar ücretlenmiş olabileceğinden rezervasyon iade edilmez. Sabit kimlik yoksa yalnızca istek düzeyinde sınırlı manuel çağrılar kullanılabilir.

Advisor sayfası ve `ocx advisor activity --json` (`GET /api/advisor/activity`), bu işlemin son 24 saatinden en fazla 100 meta veri kaydını gösterir. Görünür sayfa beş saniyede bir yenilenir. Neden, durum, modeller, süre, bildirilen girdi/çıktı tokenları, istenen ve adaptörün eşlediği akıl yürütme düzeyi gösterilir. Görev metni, komutlar, tavsiye veya konuşma kimliği tutulmaz; yeniden başlatmada kayıtlar silinir. Eşleme gönderilen parametreyi gösterir, sağlayıcının iç akıl yürütmesini garanti etmez. Eksik veriler bilinmiyor olarak kalır; tavsiye benimsenmesi ve kesin maliyet çıkarılmaz.
