---
title: Platform desteği
description: OpenCodex'in macOS, Windows ve Linux'ta yapabildikleri ve bazı yeteneklerin neden platforma özgü kaldığı.
---

OpenCodex macOS, Windows ve Linux'ta çalışır. Büyük bölümü üçünde de aynı
şekilde davranır; birkaç yetenek işletim sisteminin sağladığı mekanizmalara
bağlıdır. Bu sayfa hangilerini ve nedenini açıklar.

## Tüm platformlarda

| Yetenek | Notlar |
| --- | --- |
| Proxy, yönlendirme, sağlayıcı bağdaştırıcıları | Çekirdek çalışma zamanı platformdan bağımsızdır. |
| Arka plan servisi | Üç yerel arka uç: macOS'ta launchd, Windows'ta Görev Zamanlayıcı **veya** WinSW, Linux'ta systemd kullanıcı birimi. |
| Tarayıcıyla giriş | Platformun kendi işleyicisiyle açılır. |
| İstemci algılama | Cursor, Claude Desktop, Kiro ve Codex kurulumları platforma göre bulunur. |

### İşletim sistemi kimlik bilgisi deposunda sağlayıcı anahtarları

Üç platformda da **kilidi açık bir işletim sistemi kimlik bilgisi servisi
bulunduğunda** desteklenir: macOS'ta Keychain, Windows'ta Credential Manager,
Linux'ta libsecret. Kilitli bir anahtarlıkta veya başsız oturumda kilidi açık
bir servis yoktur; bu nedenle depo kullanılamaz ve OpenCodex sessizce başka
bir yola geçmek yerine bunu bildirir. Saklama kuralları için
[Sağlayıcılar](/tr/reference/configuration/providers/) bölümüne bakın.

## Yalnızca macOS

### Claude Code otomatik bağlantısı

`ANTHROPIC_BASE_URL` ve Claude Code denetimlerini oturumunuza ekleme işlemi,
başka yerde tek bir karşılığı olmayan launchd kullanıcı alanından geçer.

Linux'taki üç olası mekanizma farklı süreç kümelerine ulaşır:
`systemctl --user set-environment` yalnızca systemd'nin başlattığı birimlere,
`~/.profile` yalnızca giriş kabuklarına, `~/.bashrc` ise yalnızca etkileşimli
giriş dışı kabuklara ulaşır. Kullanıcının tüm oturumunu kapsayan tek bir yer
yoktur.

Windows'taki karşılık `HKCU\Environment` değeridir ve yeniden başlatmalar
arasında gerçekten kalıcıdır. Sorun da budur: bearer belirtecini yeniden
başlatıldığında boşalan bir alandan kalıcı kayıt defteri kovanına taşır; bu,
kimlik bilgisinin diskte kalma süresini ve onu kimlerin okuyabildiğini
değiştirir. Böyle bir karar doğrudan taşıma yerine güvenlik incelemesi
gerektirir.

Claude Code'un ihtiyaç duyduğu diğer her şey tüm platformlarda çalışır. Aynı
değişkenleri kendiniz ayarlayabilir veya onları doğrudan alt sürece ileten
`ocx claude` komutunu çalıştırabilirsiniz.

## İçe aktarma ve yapıştırma

### Meta Muse Code

macOS'ta OpenCodex, `muse login` sonrasında Muse Code CLI'ın zaten sakladığı API
anahtarını içe aktarır; böylece ikinci bir anahtar sağlamanız istenmez.

Diğer platformlarda anahtarı yapıştırmanız istenir. Meta yerel bir Windows CLI
sunmaz. Linux'ta CLI vardır ancak kimlik bilgisini nerede sakladığı
doğrulanmamıştır; OpenCodex bu yüzden kimlik bilgisi deposunu tahmin etmez.
Aynı anahtar [Meta geliştirici konsolunda](https://dev.meta.ai) görünür;
yapıştırılan anahtar da içe aktarılanla aynı biçim denetiminden ve Model API
üzerinden aynı canlı doğrulamadan geçer.

## Windows notları

Windows servisi Görev Zamanlayıcı altında veya yerel WinSW servisi olarak
çalışabilir; bu iki seçenek birbirini dışlar. `ocx service repair`, ikisinin
de durumunu bulursa devam etmeyi reddeder. Hangisinin amaçlandığını tahmin
etmek, aynı port için yarışan iki proxy'ye yol açabilir.

İngilizce olmayan bir Windows kurulumunda konsol çıktısı UTF-8 yerine sistemin
kod sayfasıyla gelir. OpenCodex buna göre çözer; böylece ASCII dışı karakterli
hesap adları doğru bulunur.

## Bir şey kullanılamadığında

OpenCodex bir denetimi sessizce devre dışı bırakmak yerine gerçek nedeni
bildirir. Bir yetenek platformunuzda kullanılamıyorsa hata veya kontrol
paneli, eksik mekanizmayı ve desteklenen alternatifi gösterir. Bunu yapmayan
bir durumla karşılaşırsanız bildirilmesi gereken bir hatadır.
