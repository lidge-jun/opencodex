---
title: Gelen gövde kabulü
description: Artırılmış istek gövdesi sınırlarının eşzamanlı HTTP isteklerini, yeniden denemeleri ve bellek muhasebesini nasıl etkilediği.
---

[Sağlayıcı yapılandırması referansı](/tr/reference/configuration/providers/),
tek bir gelen JSON gövdesinin çözümlenmiş azami boyutu olan `maxInboundBodyBytes`
ayarını açıklar. Varsayılan 256 MiB olarak kalır; yapılandırılan değerler 1 MiB
ile 512 MiB arasında sınırlandırılır. Sınırı değiştirdikten sonra dinleyici ve
okuyucuların aynı sınırı kullanması için proxy'yi yeniden başlatın.

Önceki 512 MiB paylaşılan bütçe varsayılanını korumak, aşağıda açıklanan kuyruk ve
yanıtın yaşam döngüsü boyunca rezervasyonun tutulmasına ilişkin ödünleşimleri ortadan kaldırmaz.

## Paylaşılan bütçeyi açıkça seçin

`maxConcurrentInboundBodyBytes`, `config.json` içinde bayt cinsinden isteğe bağlı bir
**üst düzey** ayardır. Varsayılanı önceki gibi **512 MiB (`536870912`)**
olarak kalır. Ayar atlanırsa, `0` veya geçersiz bir değer verilirse bu varsayılan kullanılır.
Geçerli bir pozitif tam sayı, kullanıldığı anda **512 MiB–2 GiB (`536870912`–`2147483648`)**
aralığına sınırlandırılır. Değişiklikten sonra proxy'yi yeniden başlatın. Aynı süreçteki tüm
dinleyiciler tek bütçeyi paylaşır; bu bütçe `appOwnedMemoryBudgetMb` ayarından ayrıdır.

İstek başına 512 MiB sınırı seçip paylaşılan bütçeyi açıkça 2 GiB yapmak için bu alanları
mevcut `config.json` dosyanızın üst düzeyine ekleyin, ardından yeniden başlatın:

```json
{
  "maxInboundBodyBytes": 536870912,
  "maxConcurrentInboundBodyBytes": 2147483648
}
```

Bu, olası en yüksek bellek kullanımını artıran bir operatör seçimidir. Proxy kullanılabilir
RAM'i otomatik algılamaz veya bütçeyi buna göre seçmez.

## Sınırı artırmak eşzamanlılığı değiştirir

Etkin sınır 256 MiB'ı aştığında kapsanan her HTTP isteği, **gövdeden herhangi
bir veri okunmadan önce** istek başına etkin payın tamamını ayırmalıdır. Bu rezervasyonlar
süreç genelindeki `maxConcurrentInboundBodyBytes` bütçesini paylaşır; varsayılan
**512 MiB** olarak kalır.

Boyut denetimli JSON ayrıştırması tamamlanmadan önce küçük bir `Content-Length`
veya küçük bir sıkıştırılmış aktarım gövdesi rezervasyonu azaltmaz. Kabul
denetimi bu değerleri çözülmüş ya da normalleştirilmiş JSON boyutunun güvenilir
kanıtı olarak kullanmaz.

Boyut sınırları içinde başarılı JSON ayrıştırmasından sonra okuyucu,
rezervasyonu aktarımda gözlenen bayt sayısı, çözülmüş bayt sayısı ve çevirici
ölçüm için bir bütçe sağladığında mevcut normalleştirilmiş JSON ölçümünün en
büyüğüne indirir. Mevcut UTF-8 ve yeniden serileştirilmiş JSON denetimleri
korunur; girdi bayt uzunluğu daha büyük olabilen normalleştirilmiş JSON
boyutunun yerine geçmez. Rezervasyon yalnızca azalır ve başlangıçta ayrılan
istek başına payı aşmaz; daha büyük bir normalleştirilmiş JSON ölçümü bile
rezervasyonu artırmaz.

**Varsayılan 512 MiB paylaşılan bütçe** ve **istek başına 512 MiB sınırı** ile,
henüz ayrıştırılmamış **yalnızca bir yükleme** tam payını ayırabilir. Ayrıştırma rezervasyonu
**bir bayta** indirse bile kalan kapasite 512 MiB'dan azdır. Sonraki tam pay, yeterli kapasite
serbest bırakılana kadar bekler. Dolayısıyla varsayılan, istek başına 512 MiB sınırındaki
ilk eşzamanlılık sorununu **çözmez**.

`maxConcurrentInboundBodyBytes` değerini açıkça `2147483648` yapmak **2 GiB** seçer ve
ayrıştırma ile ölçüme dayalı azaltmalardan önce **her biri tam 512 MiB ayıran en fazla
4 yüklemeye** izin verir. Bu 2 GiB bütçesi ayrıştırma sonrasında sabit 4 istek sınırı değildir:
örneğin azalan rezervasyonlar sonraki kabullere yer açtığında, paylaşılan bütçe ve diğer
sınırlar izin verdiği sürece **8 çok küçük istek aynı anda yanıt akışı iletebilir**.

Azaltılan rezervasyon, asenkron çalışma ve sağlayıcı beklemeleri boyunca,
yanıt akışının sonuna (EOF), hataya veya iptal işleminin tamamlanmasına kadar
tutulur. Yalnızca ayrıştırmanın bitmesi onu serbest bırakmaz. İstemci
bağlantısı kesilirse üretici tarafındaki iptal tamamlanana kadar tutulur.
Hata, durdurma ve iptal aynı anda gerçekleşse bile tam olarak bir kez serbest
bırakılır.

Kapsanan POST uç noktaları `/v1/responses`, `/v1/responses/compact`,
`/v1/chat/completions`, `/v1/messages`, `/v1/messages/count_tokens`,
`/v1/images/generations`, `/v1/images/edits` ve `/v1/alpha/search` yollarıdır.
Görseller, arama ve belirteç sayımı mevcut yapılandırılabilir gövde başı
sınırlarını korur. İç doğrudan çeviri ve kombo çağrıları ikinci bir HTTP alanı
ayırmaz. Yönetim, ses, bağlam geçmişi ve WebSocket sınırları değişmez.

Bu ek eşzamanlılık kapısı yalnızca etkin `maxInboundBodyBytes` 256 MiB'ı aştığında uygulanır.
İstek başına ayarı atlamak veya `0` yapmak, 256 MiB varsayılanını korur ve kapıyı kapalı tutar.
`maxConcurrentInboundBodyBytes` ayarını atlamak veya sıfırlamak ise 512 MiB paylaşılan
varsayılanını seçer; zaten etkin olan kapıyı devre dışı bırakmaz. Mevcut istek sayısı ve
diğer kaynak sınırları yine uygulanır.

## Geçici ret ile büyük gövde arasındaki fark

Payın tamamı geçici olarak ayrılamıyorsa istek, **en fazla 32 bekleyen istek
tutan FIFO kuyruğuna** girebilir; **bekleme sınırı 120 saniyedir**. Bekleme
sırasında uygulama istek gövdelerini okumaz. Ölçümle rezervasyon azalması veya son serbest
bırakma yer açtığında istekler kuyruk sırasıyla kabul edilir. Beklerken
durdurulan istek kuyruktan çıkarılır ve okunmamış gövdesi tüketilmeden iptal
edilir.

Kuyruk doluysa veya bekleme süresi dolarsa gövde ayrıştırılmadan ya da
sağlayıcıya gönderilmeden önce HTTP **503**, `Retry-After: 1` ve `server_busy`
hata kodu döner. Ret sırasında okunmamış gövdeler iptal edilir. Messages ve
belirteç sayan istemciler `overloaded_error` türünde Anthropic biçimli hata;
OpenAI uyumlu istemciler `server_error` alır. Kimlik doğrulaması ve kaynak
denetimleri kabulden ve kuyruğa girişten önce çalışır.

Yeniden deneme başlığına ve istemci geri çekilmesine uyun. Sınırlı bekleme ve
ölçülen rezervasyonlar önlenebilir kapasite retlerini azaltır, ancak tüm 503
yanıtlarını ortadan kaldırmaz. İstek başına sınırı daha da yükseltmek sürekli
kapasite tükenmesini çözmez.

İstek başına sınırından büyük gövde mevcut HTTP **413** işlemesini izler.
Bildirilen büyük boyut, meşgul ret yerine bu yolu korur.

## Bütçe neyi ölçer?

Yapılandırılan bütçe kabul birimlerini sayar: ayrıştırma öncesinde tam payları,
sonrasında ölçülen rezervasyonları. **2 GiB veya ayarlanan miktar önceden ayrılmaz**;
bu bütçe **süreç RSS'sinin veya ayrıştırılmış nesne yığınının sınırı değildir**.
Çözümleme, dizeler, nesne grafikleri, istek kopyaları ve diğer uygulama durumu ek bellek
kullandığından gerçek bellek kullanımı bütçeyi aşabilir.

512 MiB paylaşılan varsayılanı yerine 2 GiB seçmek toplam rezervasyon payını dört katına
çıkarır. İstek başına 512 MiB sınırında bu açık tercih, ayrıştırma öncesinde bir yerine
en fazla dört tam yüklemeyi kabul eder ve olası en yüksek bellek kullanımını artırır.
Bütçeyi kurulumunuzun bellek payına göre seçin. İstek başına sınır 256 MiB veya altındaysa
paylaşılan bütçe ayarı ne olursa olsun bu ek kapı kapalı kalır.

Mümkünse istek başına varsayılan sınırı koruyun. Büyük geçmiş gerektiren bir
iş akışı için artırırken olası bellek tepe değerinin büyümesini ve sınırlı
beklemeyi hesaba katın.
