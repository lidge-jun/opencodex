---
title: Codex yeniden deneme tanılaması
description: Hız sınırı önerisini, otomatik yeniden gönderimi, sağlayıcının düzelmesini ve Desktop bildirimlerini birbirinden ayırın.
---

OpenCodex'in [Devin bağdaştırıcısı](/tr/reference/adapters/#devin), Codex'in anladığı
hata sözleşmesinde kullanılabilir yeniden deneme ipucunu korur. Bu, Desktop'ın
yeniden bağlanma satırı göstereceğini veya sağlayıcının sonraki isteği kabul
edeceğini garanti etmez.

## Beklemeyi kim yönetir?

`OPENCODEX_DEVIN_STATED_RESET_WAIT_MS` ayarlanmamışsa veya `0` ise Devin
bağdaştırıcısı reddedilen isteği belirtilen bekleme süresi boyunca tutmaz. Son
hata Codex'e iletilir; sınırlı yeniden deneme ilkesini Codex yönetir. Pozitif değer,
proxy'nin mevcut bekleme davranışını açar; son hatanın teslimini geciktirir ve
istemci yeniden denemeleriyle birleşebilir. Bu uyumluluk eşlemesi ne ayarı ne de
Codex'in yeniden deneme sayısını değiştirir. Yalnızca işleme özel değişken yeniden
başlatmada korunmayabilir.

`rate_limit_exceeded` ve `Please try again in Ns.` bir yeniden deneme önerisidir;
geri sayım olayı değildir. Codex'in yeniden deneme, iptal ve yaşam döngüsü
kuralları geçerlidir. Beklemeyi göstermek için yapay akıl yürütme, araç, asistan
veya başarı öğeleri eklemeyin: geçmişi bozabilir veya iş yapılmış izlenimi
verebilirler. Sağlayıcı gecikmesini kısaltmayın; istemci sayacını ilerletmek için
fazladan istek üretmeyin.

## Tanılama: `exceeded retry limit, last status: 429 Too Many Requests`

Bu ileti istemcinin yeniden deneme bütçesinin özetidir; tanı değildir. İstemcinin
yeniden göndermediği tek ret de tamamen tükenmiş bütçeyle aynı sözlerle turu
bitirebilir. Bu katmanda aynı görünen üç durum ayrı kontrol edilir:

| Kontrol | Ayırt edici kanıt | Sonuç doğrulanırsa |
| --- | --- | --- |
| Ana hesap kesin kilidi (yerel kabul ilkesi) | Pano Ayarlar veya `GET /api/settings`, `mainAccountHardLock.state` için `blocked`, `ready` ya da `off`; ayrıca `thresholds` ve isteğe bağlı `resetAt` bildirir. Akışsız istek, yalın üst sunucu 429'u yerine açık ana ilke gövdesi de taşıyabilir. | `ocx account refresh openai` ile kullanımı yenileyin. Tüm engelleme eşiklerinin altında güncel kullanım veya pencerenin bulunmadığının doğrulanması kilidi kaldırır. Engel sürerse daha düşük güncel kullanımı bekleyin veya Ayarlar'da `codexMainAccountHardLock` değerini açıkça kapatın. [#6287](https://github.com/lidge-jun/opencodex/pull/6287) öncesi derlemeler, yeni gözlem eskisinin yerini almadığında eski kısa pencere engelini yeniden başlatmalar arasında koruyabiliyordu. Ayrıntılar [#6244 kapanış notunda](https://github.com/lidge-jun/opencodex/issues/6244). |
| Üst sunucudaki ChatGPT plan penceresi | Kilit `ready` veya `off` iken hesap kota bölümü 5 saatlik/haftalık pencereyi sınıra yakın veya dolu gösterir. | Sıfırlanmayı bekleyin, ChatGPT'nin sunduğu sıfırlama seçeneklerini inceleyin ([biriktirilmiş sıfırlama kuralları](https://help.openai.com/en/articles/20001498-how-banked-codex-resets-work), [plan pencereleri](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)) veya `ocx account use openai <id>` ile başka hesaba geçin. Sınır sonrası açıkça izin verilmiş ücretli kredi kullanımı için [hesap kredi ilkesine](/tr/reference/cli/providers-accounts/) bakın. [#6845](https://github.com/lidge-jun/opencodex/issues/6845) kredi bakiyesi yeniden keşif hatası [#6886](https://github.com/lidge-jun/opencodex/pull/6886) ile düzeltildi. |
| Sağlayıcı olayı veya aktarım hatası | Kota düşük ve kilit açık kalırken `ocx doctor` aktarım/ChatGPT erişim sorunu bildirir. | Olay düzeldikten sonra yeniden deneyin veya mevcut combo üzerinden yönlendirin. Kilit/eşik ilkesini değiştirmek aktarım hatasını çözmez. |

Kilitli ana kimlik bilgisi istek kabulünü kapatır; kalan kotayı ayırmaz. Tahmini
sıfırlanma zamanı tek başına kilidi kaldırmaz. Eşikler (varsayılan `short` 90,
`long` 98) durum yükünde görünür ve `codexMainAccountHardLockThresholds` ile ayarlanır.

Kesin kilit reddi `usage_limit_reached` olarak bildirilir. Böylece Codex günlerce
yeniden denemede beklemek yerine turu bitirir ve etkin Goal'ı kullanım sınırlı
işaretler. Önerilen zaman, ana hesap sıfırlanmasıdır; havuzun ana hesaba
yönlendirdiği isteklerde başka havuz hesabının bilinen en erken düzelme zamanı
daha erkense o kullanılır. Süre hiçbir zaman bir dakikadan kısa değildir.
Goal'ı o zamandan sonra sürdürün; yönlendirme güncel durumdan hesap seçer.

## İlk yeniden bağlanma satırı neden görünmeyebilir?

Herkese açık Codex `rust-v0.158.0-alpha.2.1` kaynaklarında normal akış yeniden
deneme bildirimi
[`handle_response_stream_error`](https://github.com/openai/codex/blob/rust-v0.158.0-alpha.2.1/codex-rs/core/src/responses_retry.rs)
içinde şu koşula bağlıdır:

```rust
let report_error = retry_count > 1
    || cfg!(debug_assertions)
    || !sess.services.model_client.responses_websocket_enabled();
```

Yayın derlemesinde iç WebSocket koşulu doğruysa bu döngünün ilk yeniden denemesi
`Reconnecting...` üretmeden bekleyebilir. Seçilen gecikme bildirim koşulunun parçası
değildir; uyku `if report_error` dışındadır. Sunucunun önerdiği uzun bekleme de
sessiz olabilir. Bu, belirli sürümün kaynak gözlemidir; bir Desktop isteğinin o
dalı kullandığını kanıtlamaz. İç koşulu model adından, HTTP durumundan veya tek
proxy adımında görülen aktarımdan çıkarmayın.

Etkin bildirim aboneliği ve satırı çizebilen arayüz yalnızca alıcı yolunun
varlığını gösterir; motorun ilgili turda olay ürettiğini kanıtlamaz. Daraltılmış
sağlayıcı ayrıntıları eksik ayrıntı metnini açıklayabilir; tek başına eksik yeniden
bağlanma satırını açıklamaz.

Karşılık gelen app-server
[`ErrorNotification`](https://github.com/openai/codex/blob/rust-v0.158.0-alpha.2.1/codex-rs/app-server-protocol/schema/typescript/v2/ErrorNotification.ts)
olayı `willRetry`, `threadId`, `turnId` içerir. Üretimi, doğru tura teslimi ve
gösterimi ayrı gözlemleyin. Proxy'nin `response.failed` çerçevesi bu bildirim
değildir. İlk bildirim ilkesinin değişmesi Codex değişikliği gerektirir; OpenCodex
hata metnini değiştirerek olay üretmeyen daldan olay geçiremez.

## Salt okunur doğrulama

Kanıt toplarken uygulamayı, proxy'yi, ayarları ve test turunu değiştirmeyin.
Yeniden başlatmak, yeni tur göndermek veya aktarımı değiştirmek deneyi değiştirir.
Ayrı bir takip testinde aynı kontrollü hatayı iki iç WebSocket durumunda karşılaştırın;
ilk ve sonraki yeniden denemeleri inceleyin. Arayüz gözlenmediyse bunu gerçek
Desktop gösterim testi olarak adlandırmayın.

İlgili konuşma ve etkin tur için şu sonuçları ayırın:

| Soru | Gerekli kanıt |
| --- | --- |
| Kullanılabilir öneri ulaştı mı? | Son hatanın kodu, normalleştirilmiş gecikme ve yanıt bitiş zamanı. |
| Otomatik yeniden gönderim oldu mu? | Elle gönderim olmadan, hatadan sonra onunla ilişkili yeni istek. Süreyi ilk istek başlangıcından değil, hata yanıtının bitişinden sonraki isteğin başlangıcına ölçün. |
| Sağlayıcı düzeldi mi? | Başarılı yanıt ve ilgili işin devamı; yalnızca yeni istek veya ilgisiz başarılı tur yeterli değildir. |
| Yeniden deneme bildirimi üretildi ve ulaştı mı? | Yalnızca abonelik değil, eşleşen app-server hata olayı ve yeniden deneme bayrağı. |
| Bildirim göründü mü? | İlgili Desktop turunun gözlemi; protokol/kaynak kontrolü tek başına yetmez. |

Yaklaşık sağlayıcı önerisi ve zamanlama yükü küçük farklar yaratabilir. Yeniden
gönderim soket kapanma hatasına ulaşıyor, daha sonraki deneme yeni hız sınırı
alıyorsa yeniden gönderimi çalışıyor, sağlayıcı düzelmesini eksik kaydedin. Yeni
ret gecikmesi yeni gözlemdir; önceki retten devralınmış zamanlayıcı değildir.
`inProgress` turu tek başına düzelmeyi veya doğru gösterimi kanıtlamaz. Deneme
tükenmesi, iptal ve uygulama yeniden başlatma kurtarmasını ayrı değerlendirin.

Yalnızca doğrulama kapsamını, toplu süreleri ve sonuçları yayımlayın. Ham günlükleri,
istek gövdelerini, kimlik bilgilerini, hesap verilerini, özel yolları ve
tur/konuşma/istek/iz kimliklerini herkese açık PR ve raporlara koymayın.

## Regresyon testinin kapsamı

`tests/server/retry-delay-hardening.test.ts`; 120, 900, 1.800, 2.460 ve 3.600
saniyelik önerilerin biçimlendirmede korunduğunu, kısa öneri de varken uzunun önde
kaldığını ve aradaki süresiz bağlantı kesilmesinin sonraki rete eski gecikmeyi
taşımadığını kontrol eder. Bunlar saf ayrıştırıcı/biçimlendirici testleridir.
Bir saat beklemez, Codex bildirim koşulunu çalıştırmaz, uygulama yeniden
başlatmasını doğrulamaz ve canlı sağlayıcı hatasından düzelmeyi kanıtlamaz.
