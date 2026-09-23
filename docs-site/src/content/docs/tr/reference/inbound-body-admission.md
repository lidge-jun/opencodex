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

Çözümlenen sınır 256 MiB'ı aştığında kapsanan her HTTP isteği, yapılandırılmış
alanının tamamını süreç genelinde paylaşılan 512 MiB kabul bütçesinden ayırır.
Bu, birden çok dinleyici aynı süreci paylaşsa bile aynı anda en fazla bir böyle
isteğin çalışacağı anlamına gelir. Küçük gövdeler de alanın tamamını ayırır;
küçük bir Content-Length veya sıkıştırma kabulü atlatmaz. Rezervasyon, JSON
ayrıştırılır ayrıştırılmaz değil; yanıt akışı bitene, hata verene veya iptal
tamamlanana kadar sürer.

Kapsanan POST uç noktaları `/v1/responses`, `/v1/responses/compact`,
`/v1/chat/completions`, `/v1/messages`, `/v1/messages/count_tokens`,
`/v1/images/generations`, `/v1/images/edits` ve `/v1/alpha/search` yollarıdır.
Görseller, arama ve belirteç sayımı mevcut yapılandırılabilir gövde başı
sınırlarını korur. İç doğrudan çeviri ve kombo çağrıları ikinci bir HTTP alanı
ayırmaz. Yönetim, ses, bağlam geçmişi ve WebSocket sınırları değişmez.

Atlanan/sıfır ayarı veya 256 MiB ya da altında çözümlenen sınır, bu ek
eşzamanlılık kapısını etkinleştirmez. Mevcut istek sayısı ve diğer kaynak
sınırları yine uygulanır.

## Geçici ret ile büyük gövde arasındaki fark

Geçici olarak kullanılamayan alan, protokol ayrıştırması veya sağlayıcıya
göndermeden önce HTTP **503**, `Retry-After: 1` ve `server_busy` hata kodunu
üretir. Messages ve belirteç sayan istemciler `overloaded_error` türünde
Anthropic biçimli hata; OpenAI uyumlu istemciler `server_error` alır. Yeniden
deneme başlığına ve istemci geri çekilmesine uyarak mevcut istek tamamlandıktan
sonra yeniden deneyin. Gövde sınırını daha da yükseltmek dolu alanı çözmez.

İstek başına sınırından büyük gövde mevcut HTTP **413** işlemesini izler.
Bildirilen büyük boyut, meşgul ret yerine bu yolu korur. Bağlantı kopması
mevcut iptal davranışını korur. Kimlik doğrulaması ve kaynak denetimleri bu
eşzamanlılık kapısından önce çalışır.

## Bütçe neyi ölçer?

512 MiB, kabul edilen istek başına alanların toplamıdır; **süreç belleğinin
512 MiB altında kalacağının garantisi değildir**. Çözümleme, dizeler, nesne
grafları, istek kopyaları ve diğer uygulama durumu ek bellek kullanır. Mevcut
UTF-8 ve yeniden serileştirilmiş JSON ölçümleri korunur; girdi bayt uzunluğu,
daha büyük olabilen normalleştirilmiş JSON boyutunun yerine geçmez.

Paralel küçük istekler için mümkünse varsayılan sınırı koruyun. Büyük geçmiş
iş akışı için artırırken ek eşzamanlılık kısıtını kabul edin.
