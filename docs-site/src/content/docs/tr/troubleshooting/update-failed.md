---
title: Windows'ta güncelleme başarısız
description: npm kurulum adımında başarısız olan ocx update sonrasında kurulumun durumu, güncellemeyi güvenle tamamlama ve kalan klasörleri temizleme.
---

Bu sayfa, çoğunlukla Windows'ta `ocx update` veya pano güncellemesinin
[#5624](https://github.com/lidge-jun/opencodex/issues/5624) örneğindeki gibi yarıda
kalması içindir:

```text
update command failed (1)
exit 1 · code: ENOTDIR · syscall: mkdir
```

Ardından paketin yanında, `bunx.exe` kullanımda olduğu için silinemeyen (`EPERM`)
bir klasör kalabilir.

## Kurulumun durumu

Güncelleyici proxy'yi durdurur, yeni sürümü ayrı bir hazırlık klasörüne kurar,
kontrol eder ve ancak sonra eski sürümün yerine geçirir. Kurulum adımı başarısızsa
değiştirme yapılmaz: önceki sürüm kurulu ve çalıştırılabilir kalır. Güncelleyici
çıkmadan önce eski arka plan servisini veya proxy'yi yeniden başlatır. Çalışan
proxy'ye dönmek için yeniden kurmanız gerekmez.

Kontrol edin:

```bash
ocx --version
ocx status
```

Kurulum çıktısı yerel yollar içerebildiği için pano işi yalnızca çıkış durumunu
kaydeder. Terminalde `ocx update` çalıştırmak başarısız adımı ve sonraki işlemi gösterir.

## Güncellemeyi tamamlama

1. OpenCodex dosyalarını çalıştırabilecek uygulamaları kapatın: Codex uygulaması,
   `ocx` veya `bunx` başlatan terminaller ve OpenCodex sistem tepsisi uygulaması.
   Çalışan `bun.exe` veya `bunx.exe`, Windows'ta dosyalarını kilitli tutar.
2. Terminalden yeniden `ocx update` çalıştırın.
3. Aynı hata sürerse `ocx status` çalıştırıp devam eden kurtarmanın bitmesini bekleyin.
   Güncelleyici proxy'yi yeniden başlattıysa onu yöneten uygulama veya servis üzerinden
   (`ocx stop`, servisi veya masaüstü uygulaması) durdurup durduğunu doğrulayın.
   Kurulumu yöneten aynı paket yöneticisiyle yeniden kurun. OpenCodex servisinin
   yönettiği npm kurulumu için:

   ```bash
   ocx stop
   npm install -g --allow-scripts=bun @bitkyc08/opencodex@latest
   ocx service restart
   ```

   Kurulumdan sonra yöneten servis veya masaüstü uygulamasıyla başlatın; bağımsız
   çalıştırıyorsanız `ocx start` kullanın. Önizleme kanalındaysanız `latest` yerine `preview` yazın.

## Kalan klasörler

Bunlar npm'in genel klasöründe paketin yanında bulunur; Windows'ta genellikle
`%APPDATA%\npm\node_modules\@bitkyc08\` konumundadır.

| Klasör | Oluşturan | Yapılacak işlem |
| --- | --- | --- |
| `.opencodex-<random>` | Doğrudan `npm install -g` sırasında paketi değiştiren npm | İçinden OpenCodex işlemi çalışmadığında silin. |
| `.ocx-staging-<timestamp>` | OpenCodex güncelleyicisinin hazırlık kurulumu | İşaretli ve yarım saatten eski klasör bildirilir ama silinmez. İçinden OpenCodex işlemi çalışmadığında elle silin. `.ocx-update-owner.json` işareti yoksa kökeni doğrulanmamıştır: yarım kalan güncelleme de aynı öneki kullanan başka bir şey de oluşturmuş olabilir. Silmeden önce OpenCodex'e ait olduğunu doğrulayın. |
| `.ocx-backup-<timestamp>` | Güncelleyicinin önceki sürüm kopyası | Bırakın; yeni sürüm sağlıklı başlayınca otomatik silinir, başlamazsa geri yüklenir. |

Her deneme yeni klasör kullandığı için bu adlar sonraki güncellemeyi doğrudan
engellemez. Ancak artıklar disk tüketir ve birikirse sonraki hazırlık `ENOSPC`
ile başarısız olabilir. Güncelleyici sonraki güncellemelerde de bunları yerinde
bırakır; sahiplik işaretini kontrol edip yarım saatten eski işaretli klasörleri
bildirir. Yalnızca içinden OpenCodex işlemi çalışmadığını doğruladıktan sonra silin.

Bir klasör silinemiyorsa içinden çalışan işlem kalmış olabilir. Windows oturumunu
kapatmak veya yeniden başlatmak kilidi serbest bırakır.

## Güncelleme UNSUPERVISED proxy bildiriyorsa

Güncellemeden sonra arka plan servisi yenilenemediğinde güncelleyici önce mevcut
servisi launchd (macOS) veya systemd kullanıcı yöneticisi (Linux) üzerinden yeniden
başlatmayı ister. Servisin yönettiği proxy dönmezse hizmet kesilmesin diye proxy'yi
doğrudan başlatır, `UNSUPERVISED` uyarısı verir ve sıfır dışında kodla çıkar.
Proxy çalışır; ancak çökerse yeniden başlatılmaz ve sonraki servis başlangıcıyla
aynı bağlantı noktası için yarışabilir. `ocx service repair` ile yönetimi servise
devredin, ardından `ocx status` kontrolü yapın.

Panodan başlayan güncelleme de aynı sırayı izler. Yalnızca doğrudan başlatma
başarılıysa yeni sürüm yanıtlıyor olsa bile pano aynı uyarıyla başarısızlık
gösterir. Aynı onarım komutu bunu giderir.

## Elle kurulumdan sonra proxy 503 döndürüyorsa

Çalışan proxy'nin üzerine kurulum yapmak, yeniden başlayana kadar
`package_tree_changed` koduyla `503` döndürmesine yol açar. 2.64.0 sonrasındaki
sürümler, paket ağacı ve Bun çalışma zamanı tamamlanınca birkaç saniye içinde
kendini yeniden başlatabilir. Eksik veya başarısız Bun postinstall adımı bu
kurtarmayı engeller. `ocx restart` veya `ocx service restart` bu durumdaki proxy'yi
bulabilir; yine de eksiksiz çalışma zamanı ve paket ağacı gerekir. 2.64.0 ve
öncesinde proxy bu durumda kalır; eski işlem bağlantı noktasını tutarken
`ocx restart` çalışan proxy yok diyebilir. `ocx service restart` kullanın veya
`/healthz` yanıtındaki `pid` işlemine son verip `ocx start` çalıştırın.

Yükleyici çıktıysa veya başarısız olduysa hatasını inceleyin ve `ocx status`
çalıştırın. Kurtarmanın bitmesini bekleyin; çalışan proxy'yi yöneticisi üzerinden
durdurun ve durduğunu doğrulayın. Aynı paket yöneticisiyle yeniden kurup Bun
postinstall adımının tamamlanmasını sağlayın. Sonra yöneten servis/uygulama
üzerinden; bağımsızsa `ocx start` ile başlatın.

## Güncelleme npm önbellek kontrolünde duruyorsa

`mkdir` işleminde `ENOTDIR`, npm'in bir bileşeni dosya olan veya hedefi kayıp bir
bağlantı olan yolda klasör oluşturmaya çalıştığını gösterir.
[#6288](https://github.com/lidge-jun/opencodex/issues/6288) örneğinde,
`%LOCALAPPDATA%\npm-cache` başka sürücüye işaret eden bir junction idi; hedef
klasör silinmiş veya sürücü kaldırılmıştı.

Güncelleyici proxy'yi durdurmadan önce önbellek klasörünü kontrol eder. npm hazırlık
kurulumu da `npm config get cache` tarafından bildirilen aynı klasörü kullanır.
Klasör kullanılamıyorsa güncelleme `cache_root_dangling_link` veya
`cache_root_not_directory` ile durur ve proxy çalışmaya devam eder:

- `cache_root_dangling_link`: Önbellek bağlantısının/junction'ının hedefi kayıp.
  Hedefi yeniden oluşturun veya npm normal klasör oluşturabilsin diye bağlantıyı kaldırın.
- `cache_root_not_directory`: Önbellek ya da üst klasörlerinden biri dosya veya
  kullanılamayan sürücüde. Dosyayı başka yere alın ya da
  `npm config set cache <folder>` ile başka önbellek seçin.

Sonra `ocx update` komutunu yeniden çalıştırın. Kontrol geçmesine rağmen `ENOTDIR`
sürerse tam `ocx update` terminal çıktısı, `npm config get prefix` ve
`npm config get cache` çıktılarıyla sorun kaydı açın.

## Masaüstü güncellemesi “Installing update…” aşamasında takılıyorsa

OpenCodex masaüstü uygulamasında **Install update**, uygulamayı değiştirmeden ve
yeniden başlatmadan önce yükleyiciyi GitHub Releases'ten indirir. Bilinen sürümde
indirme/kurulum başarısızsa elle indirme ipucu ve o sürümün yayın bağlantısı gösterilir.

“Installing update…” takılır veya zaman aşımına uğrarsa ağınız GitHub yayın
indirmelerini yavaşlatıyor veya engelliyor olabilir. Hatadaki bağlantıyı kullanın
ya da [yayınlar sayfasında](https://github.com/lidge-jun/opencodex/releases) aynı
sürümü bulup işletim sisteminize ve mimarinize uygun yükleyiciyi indirin.
Önizleme sürümlerinin ayrı sayfaları vardır; uygulamanın önerdiği sürümü seçin.

Yükleyiciyi çalıştırmadan önce proxy'yi onu yöneten uygulama veya servis üzerinden
durdurun ve durduğunu doğrulayın:

1. Uygulamanın yönettiği proxy için OpenCodex masaüstü uygulamasından tepsi menüsüyle çıkın.
2. Servisin yönettiği proxy'yi servis denetimleriyle durdurun (OpenCodex servisi için
   `ocx stop`). Bağımsız terminal proxy'sini o terminalden durdurun.
3. Windows'ta kalan çalışma zamanlarını belirlemeye yardımcı olması için:

   ```powershell
   Get-Process -Name ocx, opencodex-desktop, bun, bunx -ErrorAction SilentlyContinue
   ```

   Bu liste işlemi hangi uygulamanın yönettiğini kanıtlamaz. OpenCodex çalışma
   zamanını belirleyip yöneten uygulama/servisle durdurun; `bun` başka uygulamaya
   ait olabilir. Kurulumdan önce uygulamanın ve proxy'nin çıkmasını bekleyin.

İndirdiğiniz yükleyiciyi çalıştırın, ardından masaüstü uygulamasını açın veya
yöneten servisi yeniden başlatın.
