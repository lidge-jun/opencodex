---
title: Masaüstü Uygulaması
description: OpenCodex masaüstü uygulamasını macOS, Windows ve Linux üzerinde kurun ve kullanın.
---

OpenCodex masaüstü uygulaması yerel bir sistem tepsisini web kontrol paneliyle birleştirir. Paketindeki CLI mevcut bir yerel proxy'yi bulur; uygulama paketindeki çalışma zamanını yalnızca mevcut bir proxy bulunmadığı kesinleşirse başlatır.

Kontrol paneli çözümlenen yerel proxy uç noktasından sunulur (varsayılan port `10100`). Masaüstü uygulaması, bu kontrol paneli ve paketindeki çalışma zamanı çevresinde yerel bir kabuktur.

## Kurulum

### macOS

[Son sürümden](https://github.com/lidge-jun/opencodex/releases) `OpenCodex-<version>-macos.dmg` dosyasını indirin. DMG'yi açın ve `OpenCodex.app` uygulamasını Applications klasörüne sürükleyin. Uygulama macOS 13 veya daha yenisini gerektirir.

`OpenCodex.app` sürüm derlemeleri Developer ID ile imzalanır ve Apple tarafından noterleştirilir. Dolayısıyla ilk açılışta macOS normalde yalnızca indirilen uygulamalar için standart onayı ister. macOS yine de engellerse **System Settings → Privacy & Security → Open Anyway** yolunu kullanın.

### Windows

`OpenCodex-<version>-windows-x64.msi` dosyasını indirip yükleyiciyi çalıştırın. Yükleyici henüz kod imzalı olmadığından Windows SmartScreen uyarı verebilir; sürüm sayfasından indirdiğinizi doğruladıktan sonra **More info → Run anyway** seçeneğini seçin.

### Linux

Sürüm sayfasından `OpenCodex-<version>-linux-x86_64.AppImage` veya `OpenCodex-<version>-linux-amd64.deb` dosyasını indirin.

AppImage için:

```bash
chmod +x OpenCodex-<version>-linux-x86_64.AppImage
./OpenCodex-<version>-linux-x86_64.AppImage
```

Debian tabanlı dağıtımlar için:

```bash
sudo apt install ./OpenCodex-<version>-linux-amd64.deb
```

Tepsi simgesi, AppIndicator destekleyen bir masaüstü ortamı gerektirir.

## İlk açılış

Uygulama, paketindeki CLI'dan `ocx resolve --json` çalıştırmasını ister ve zaten çalışan erişilebilir bir yerel proxy varsa ona bağlanır. Paketindeki çalışma zamanını yalnızca CLI yokluğunu kanıtlarsa başlatır; belirsiz sonuç başlangıç hatası olarak gösterilir. Ardından kontrol paneli, uygulamanın web görünümünde çözümlenen geri döngü uç noktasında açılır. Oturum açılışında tepside gizli başlayan bir uygulama ise hafif başlangıç sayfasını korur ve kontrol panelini tepsiden ilk açtığınızda ya da uygulamayı yeniden başlattığınızda yükler.

Gömülü kontrol paneli ile normal tarayıcınız arasında geçmek için tepsideki **Open dashboard** veya **Open in browser** eylemini kullanın. Tepsi, güncelleme denetimlerini de sunar.

## Tepside kullanım

macOS ve Windows'ta küçük kullanım penceresini açmak için tepsi simgesine tıklayın. Tepsideki **Show usage** eylemi de pencereyi açar; tıklama olaylarını iletmeyen Linux tepsilerinde de çalışır. Linux'ta masaüstü ortamı tepsi simgesi göstermese bile kontrol paneli başlangıçta açılır.

Kullanım penceresi bugün ve 30 günlük toplamları, yapılandırılmış kullanım grafiğini, kısa model listesini ve sağlayıcı/hesap sınırlarını gösterir. Kota sıfırlama geri sayımları çubuklarının yanındadır; tam sıfırlama zamanını görmek için imleci üzerine getirin. Görünür bölümleri ve grafiği mevcut **Menu bar & widget** ayarları belirler. Gizlenen sağlayıcılar başlık, toplamlar, kotalar ve grafikten çıkarılır. Grafik geçerli zaman aralığındaki etkinliği de içerir. Kısmi veri göstergesi, bazı grafik verilerinin güvenilir biçimde ilişkilendirilemediğini belirtir. Eksik ölçümler sıfır kullanım olarak sunulmaz. Windows ve Linux'ta uzun hesap listesinin sonundaki Refresh ve Dashboard öğelerine ulaşmak için kullanım penceresinde kaydırın.

macOS'ta bu pencere yerel SwiftUI denetimleri ve kaydırılabilir AppKit paneli kullanır. macOS 26 ve sonrasında Apple Liquid Glass, eski sistemlerde yerel açılır panel malzemesi kullanılır. Uzun hesap listelerinde kaydırırken başlık ile Refresh ve Dashboard düğmeleri görünür kalır. **View → Show Usage** (Command-Shift-U) yoluyla da açabilirsiniz. Kapatmak için Escape tuşuna basın veya panel dışına tıklayın.

Tepsi menüsü bugünkü istek sayısını ve token miktarını, etkinse tahmini maliyetle birlikte gösterir. Widget ile aynı yerel gün kullanımını kullanır. Hemen güncellemek için **Refresh now** seçeneğini seçin; uygulama ayrıca her 60 saniyede bir yeniler. Görüntüleme tercihleri kontrol panelindeki **Menu bar & widget** bölümündedir. **Today** kapatılırsa özet gizlenir; **Cost** kapatılırsa maliyet özetten kaldırılır.

Kullanılamayan veya açıkça ölçülmemiş kullanım, ölçülmüş sıfır yerine `—` olarak gösterilir. Yalnızca simge başlığını seçmek önceki sayacı temizler. Kısaltmalar tam sayıdaki sıfırları korur: on milyon token `1M` değil `10M` olur.

## Güncellemeler

Hemen denetlemek için tepsi menüsünden **Check for Updates…** seçeneğini seçin. Sürüm derlemeleri başlangıçtan sonra ve altı saatte bir otomatik denetim de yapar. Güncellemeler kurulmadan önce projenin imzalı güncelleyici açık anahtarıyla doğrulanır. macOS'ta uygulama içi güncellemeler `OpenCodex-<version>-macos.app.tar.gz` dosyasını indirir; DMG ilk kurulum içindir. Sürüm bildirimi yalnızca güncelleyici anahtar sırrı yapılandırıldığında üretilir ve o durumda dört platformun tamamının imzalanmasını gerektirir.

## Widget

macOS uygulaması OpenCodex WidgetKit uzantısını içerir. Widget kurulumu ve yerel anlık görüntü ayrıntıları için [macOS Menü Çubuğu Uygulaması rehberine](/tr/guides/macos-menu-bar/) bakın.

## Kaldırma

macOS'ta `OpenCodex.app` uygulamasını Applications klasöründen Çöp Sepeti'ne sürükleyin. Windows'ta OpenCodex'i **Installed apps** bölümünden kaldırın. Debian tabanlı Linux sistemlerinde şunu çalıştırın:

```bash
sudo apt remove opencodex
```

AppImage için indirilen dosyayı silin.

Kaydedilmiş menü çubuğu ayarları okunamıyorsa dosyayı korumak için kısmi düzenlemeler reddedilir. Tekrar düzenlemeden önce dosyayı geri yükleyin veya yardımcı ayarları açıkça sıfırlayın.
