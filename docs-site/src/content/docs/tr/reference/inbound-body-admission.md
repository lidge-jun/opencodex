---
title: Gelen gövde kabulü
description: Artırılmış istek gövdesi sınırlarının eşzamanlı HTTP isteklerini, yeniden denemeleri ve bellek muhasebesini nasıl etkilediği.
---

[Sağlayıcı yapılandırması referansı](/tr/reference/configuration/providers/),
tek bir gelen JSON gövdesinin çözümlenmiş azami boyutu olan `maxInboundBodyBytes`
ayarını açıklar. Varsayılan 256 MiB olarak kalır; yapılandırılan değerler 1 MiB
ile 512 MiB arasında sınırlandırılır. Sınırı değiştirdikten sonra dinleyici ve
okuyucuların aynı sınırı kullanması için proxy'yi yeniden başlatın.

## Sınırı artırmak eşzamanlılığı değiştirir

Etkin sınır 256 MiB'ı aştığında kapsanan her HTTP isteği, **gövdeden herhangi
bir veri okunmadan önce** istek başına etkin payın tamamını ayırmalıdır. Süreç
genelinde paylaşılan kabul bütçesi 512 MiB'dan **2 GiB**'a çıkarılmıştır; aynı
süreçteki birden çok dinleyici de bu bütçeyi paylaşır. Bu bütçe
`appOwnedMemoryBudgetMb` ayarından ayrıdır.

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

İstek başına sınır 512 MiB olduğunda bütçe, rezervasyonlar ölçülüp azaltılmadan
önce **her biri tam 512 MiB ayıran en fazla 4 yüklemeyi** kabul edebilir.
Ayrıştırma sonrasında eşzamanlılık 4 istekle sabitlenmez: örneğin azalan
rezervasyonlar sonraki kabullere yer açtığında, paylaşılan bütçe ve diğer
sınırlar izin verdiği sürece **8 çok küçük istek aynı anda yanıt akışı
iletebilir**.

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

Atlanan/sıfır ayarı veya 256 MiB ya da altındaki etkin sınır, bu ek
eşzamanlılık kapısını etkinleştirmez. Mevcut istek sayısı ve diğer kaynak
sınırları yine uygulanır.

## Geçici ret ile büyük gövde arasındaki fark

Payın tamamı geçici olarak ayrılamıyorsa istek, **en fazla 32 bekleyen istek
tutan FIFO kuyruğuna** girebilir; **bekleme sınırı 120 saniyedir**. Bekleme
sırasında gövdeler okunmaz. Ölçümle rezervasyon azalması veya son serbest
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

**2 GiB** bütçesi kabul birimlerini sayar: ayrıştırma öncesinde tam payları,
sonrasında ölçülen rezervasyonları. **Süreç RSS'sinin veya ayrıştırılmış nesne
yığınının sınırı değildir** ve bellek kullanımının 2 GiB altında kalacağını
garanti etmez. Çözümleme, dizeler, nesne grafikleri, istek kopyaları ve diğer
uygulama durumu ek bellek kullanır.

Paylaşılan bütçenin 512 MiB'dan 2 GiB'a çıkarılması toplam rezervasyon payını
dört katına çıkarır. Sınırı 256 MiB'ın üzerine çıkarmayı seçen kurulumlar,
her biri tam 512 MiB ayıran bir yükleme yerine artık en fazla 4 yüklemeyi kabul
edebilir; dolayısıyla olası en yüksek bellek kullanımı artar. Ayrıştırılmış
nesneler ve kopyalar gerçek bellek kullanımını kabul bütçesinin üzerine
çıkarabilir. Varsayılan ve daha küçük sınırlar bu kapıyı etkinleştirmez ve
mevcut davranışlarını korur.

Mümkünse istek başına varsayılan sınırı koruyun. Büyük geçmiş gerektiren bir
iş akışı için artırırken olası bellek tepe değerinin büyümesini ve sınırlı
beklemeyi hesaba katın.
