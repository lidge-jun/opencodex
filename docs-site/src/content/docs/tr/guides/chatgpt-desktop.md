---
title: ChatGPT Desktop app-server shim (deneysel)
description: Paketlenmiş app-server stdout akışındaki normal kota geçidi alanlarını yeniden yazan, isteğe bağlı macOS deneyi.
---

Bu deney **yalnızca macOS içindir ve varsayılan olarak kapalıdır**. Paketlenmiş
ChatGPT app-server'ın JSON-RPC stdout akışını filtreleyerek bilinen normal kota
geçitlerini açar. Hesabın kotasını artırmaz; üst servisin reddettiği isteği kabul
etmesini sağlamaz.

OpenCodex `config.json` dosyanızda etkinleştirin:

```json
{
  "chatgptDesktop": { "appServerShim": true }
}
```

Ardından çalıştırın:

```bash
ocx chatgpt launch
ocx chatgpt status
```

`launch`, OpenCodex yapılandırma dizininde çalıştırılabilir bir başlatıcı oluşturur,
ChatGPT açıksa kapatır ve `open -a <bundle> --env CODEX_CLI_PATH=<launcher>` ile
yeniden açar. Uygulama `com.openai.codex` paket kimliğiyle bulunur; `~/Applications`
veya başka diskteki kurulumlar da çalışır, “ChatGPT” adını paylaşan başka bir
uygulama kapatılmaz veya açılmaz. Önce devam eden işinizi kaydedin: uygulama
yeniden başlatılır. Çalışan OpenCodex proxy'si gerekmez.

Başlatıcıyı kaldırıp geçersiz kılma olmadan yeniden açmak için:

```bash
ocx chatgpt restore
```

Geri yükleme yapılandırma bayrağını değiştirmez. Sonraki açık shim başlatmalarını
kapatmak için `chatgptDesktop.appServerShim` değerini `false` yapın veya kaldırın.
Dock/Spotlight üzerinden normal başlatmalar shim'i otomatik uygulamaz.

ChatGPT kurulu değilse (`com.openai.codex` paketi bulunamazsa) `restore` yalnızca
başlatıcıyı kaldırır; yeniden açabileceği uygulama olmadığından hatayla çıkar.

## Yeniden yazma sınırı

Yalnızca `account/rateLimits/updated` bildirimleri ve üst düzey sonucunda
`rateLimits`, `rateLimitsByLimitId` veya `ordinaryUsageAllowed` bulunan yanıtlar
uygundur. Normal `rate_limit_reached` işaretleri temizlenir. Bilinen kota bayrakları
(`allowed`, `limit_reached` / `limitReached`, `ordinaryUsageAllowed`) yalnızca normal
kota kanıtıyla açılır: temizlenmiş normal sınır türü veya %100 dolmuş pencere.
Yükün açıklamadığı bir nedenle kapalı olan bayrak kapalı kalır. Çalışma alanı,
kredi, bilinmeyen sınır türü ve harcama denetimi kısıtlamaları geçidi kapalı tutar.

Gösterilen kullanım değişmez: yüzdeler, sıfırlanma zamanları, pencere süreleri,
plan bilgileri ve diğer gösterim alanları alındığı gibi kalır. İlgisiz JSON-RPC
iletileri, iç içe araç çıktıları, konuşma gönderim engeli meta verileri ve bozuk
satırlar aynen geçer. Yalnızca değişen satırlar yeniden serileştirilir; diğer
baytların kodlaması ve satır sonları korunur. Stdin, stderr ve gerçek dosyanın
çıkış durumu uygulamaya doğrudan bağlı kalır.

## Çalıştırılabilir dosya ve ortam güvenliği

Oluşturulan başlatıcının izin modu `0755` olur; mevcut OpenCodex çalıştırılabilir
dosyasını ve kaynak kurulumlarında CLI giriş yolunu içerir. `CODEX_CLI_PATH`,
ChatGPT'nin paketlenmiş dosyayı doğrudan çalıştırmak yerine başlatıcıyı kullanmasını
sağlar. Başlatıcıyı, yapılandırma dizinini ve OpenCodex kurulumunu kontrolünüzde
tutun: bu yolları değiştirmek uygulamanın çalıştırdığı kodu değiştirir. Başlatıcı
yine bulunan paketin dosyasını `exec` ile çalıştırır. Pakette app-server dosyası
yoksa `launch` başlatıcı yazmak yerine reddeder.

Yazmadan önce `launch`, paketin ve app-server dosyasının size veya root'a ait
olduğunu, grup/diğer kullanıcılar tarafından yazılamadığını ve OpenAI takım
kimliği (`2DC432GLL2`) altında katı kod imzası doğrulamasından geçtiğini kontrol
eder. Başka hesaba ait paketler dahil kontrollerden geçemeyen paket reddedilir.
Başlatıcı önce geçici dosyaya yazılıp yeniden adlandırılır; hedefteki sembolik
bağlantı izlenmez, değiştirilir.

`restore`, uygulamayı kapatmadan/açmadan önce pakete ve ana uygulama dosyasına
aynı sahiplik, izin ve imza kontrollerini uygular. Deney bayrağı kapalıyken ve
paket içinde app-server yokken de çalışır. Güven doğrulaması veya yeniden açma
başarısızsa mevcut başlatıcı kurtarma için korunur.

İki komut da paketin üst klasörlerini dosya sistemi köküne kadar denetler. Başka
hesaba ait klasörler, sembolik bağlantılar ve sıradan grup/herkes yazılabilir
üst klasörler reddedilir. Root'a ait yönetici grubu kurulum klasörleri ve güvenilir
sticky klasörler normal izin davranışlarını korur. Bunlar sahiplik, POSIX izni ve
imza kontrolleridir; yerel ACL ve disk sahiplik ilkesi davranışı doğrulanmamıştır.

Entegrasyon sertifika, ağ dinleyicisi, PAC veya arka plan izleyicisi kurmaz.
Uygulama iletilerini/ortamını kaydetmez. Durum çıktısı, çalışan ChatGPT paket
işleminin beklenen başlatıcı geçersiz kılmasını taşıyıp taşımadığını bildirir.

Uygulama keşfi veya işlem incelemesi başarısızsa `status`, `not running` yerine
`unknown` bildirir. `launch` ve `restore`, çıktığı doğrulanamayan uygulamayı
yeniden açmayı reddeder; restore başlatıcıyı korur. İnceleme hatasını giderip
yeniden deneyin. Launch yazmadan önce kontrol etse de atomik güncelleme sonrasında
başka bir inceleme başarısız olabilir; komutlar bütünüyle başarılı ya da bütünüyle
etkisiz bir yeniden başlatma işlemi garanti etmez.

## Hata davranışı ve bilinen sınırlar

Başlatıcı, Desktop'ın yeniden başlattığı işlemler dahil her çalıştırmadan önce
yürütülebilir dosyayı doğrular. Stdout filtresi kullanılamıyorsa veya öz sınaması
başarısızsa doğrulanmış dosya stdout değiştirilmeden çalışır. Dosya doğrulaması
başarısızsa ya da OpenCodex doğrulayıcısı kullanılamıyorsa başlatıcı app-server'ı
çalıştırmadan hatayla çıkar. Paketlenmiş app-server dosyasının eksikliği de
başlatmayı engeller.

Öz sınamayı geçen filtre oturum ortasında çökerse boru kapanır. Paketlenmiş
app-server'ın bundan sonra ne yaptığı doğrulanmamıştır; SIGPIPE/yazma hatası
alabilir ve Desktop tarafından aynı başlatıcıyla yeniden başlatılabilir. Filtrenin
doğrudan geçiş modu bunu çıkış/çökme durumuyla sınırlar: yeniden yazma istisnası
satırı aynen geçirir, beklenmedik yeniden yazma mekanizması hatasıysa kalan akışı
ham baytlara geçirir.

Deney; paketlenmiş dosya yoluna, uygulamanın `CODEX_CLI_PATH` değerini kullanmasına
ve güncel RPC alan biçimlerine bağlıdır. Güncellemeler bunları değiştirebilir.
OpenCodex taşınır veya kaldırılırsa başlatıcı dosyayı doğrulayamayabilir ve
başlatmayı reddeder. Kurulumu taşıdıktan sonra `ocx chatgpt launch` komutunu yeniden
çalıştırın veya geçersiz kılmayı kaldırmak için `ocx chatgpt restore` kullanın.

Uygulama güncellemesi paketlenmiş app-server dosyasını taşır veya kaldırırsa
başlatıcı onu çalıştıramaz: stderr üzerinde `ocx chatgpt launch` ve
`ocx chatgpt restore` komutlarını belirten iletiyle çıkar. Bunlardan birini
çalıştırana kadar Desktop app-server'ını başlatamaz. 8 MiB'den uzun tek çıktı
satırı tamponlanmak yerine ayrıştırılmadan geçirilir.

Bu bağımsız shim konuşma meta verilerini yeniden yazmaz veya model çağrılarını
yönlendirmez. Diğer uygulama geçitleri veya üst servis retleri gönderimi hâlâ
engelleyebilir. Başlatıcının bağlı olması veya öz sınamanın geçmesi, uygulamanın
geçit verilerinin bu borudan geçtiğini kanıtlamaz.

[#6196](https://github.com/lidge-jun/opencodex/issues/6196) üzerindeki 2 ve 13 Ekim
2026 tarihli bildirimler, doğal kota tükenmesinde shim bağlıyken Gönder düğmesinin
hâlâ kapalı kaldığını anlatır. Desktop 26.1007.30912 ve OpenCodex 2.84.0 kullanan
bildirici, arayüzün ayrı kullanım aktarımı kullanması nedeniyle uygun hız sınırı
RPC iletisi gözlemlememiştir. Shim stdout filtresine ulaşmayan veriyi yeniden
yazamaz. Bunlar derlemeye özgü saha bildirimleridir; yeni bir canlı doğrulama veya
her Desktop derlemesinin aynı aktarımı kullandığının kanıtı değildir.

Oturum açıkken mesaj düzenleyicinin kalan davranışı #6196 altında izlenir. Birleşik
shim/yakalama yapılandırmasının önceki başarısı, shim'in tek başına yeterli
olduğunu göstermez. Kapatılmış ve birleştirilmemiş #6365 yakalama çalışması
yayımlanmış bir çözüm değildir.
