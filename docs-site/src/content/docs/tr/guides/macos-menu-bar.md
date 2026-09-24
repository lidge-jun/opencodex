---
title: macOS Menü Çubuğu Uygulaması
description: OpenCodex masaüstü uygulamasının macOS tepsisini, yerel kullanım panelini ve widget'ını kullanın.
---

macOS menü çubuğu öğesi, OpenCodex masaüstü uygulamasının parçasıdır. Yerel proxy'den alınan kullanımı gösterir ve yerel kullanım panelini açar. Aynı uygulama kontrol panelini ve WidgetKit uzantısını da içerir. Diğer platformlarda kurulum için [masaüstü uygulaması rehberine](/tr/guides/desktop-app/) bakın.

## Kurulum

[Son sürümden](https://github.com/lidge-jun/opencodex/releases) `OpenCodex-<version>-macos.dmg` dosyasını indirin. DMG'yi açıp `OpenCodex.app` uygulamasını Applications klasörüne sürükleyin. Masaüstü uygulaması macOS 13 veya yenisini, widget ise macOS 14 veya yenisini gerektirir.

## İlk açılış

`OpenCodex.app` sürüm derlemeleri Developer ID ile imzalanır, güçlendirilmiş çalışma zamanını kullanır ve Apple tarafından, bileti uygulamaya eklenerek noterleştirilir. İlk açılışta macOS normalde yalnızca internetten indirilen uygulamalar için standart onayı ister. Yine de engellerse **System Settings → Privacy & Security** bölümünü açıp OpenCodex için **Open Anyway** seçeneğini seçin. Kendiniz derlediğiniz uygulamalar ad hoc olarak imzalanır; [Kaynaktan derleme](#kaynaktan-derleme) bölümüne bakın.

Uygulama açıldığında başlangıç ilerlemesini bir pencerede gösterir. İlk açılışta **Start at Login** seçeneğini bir kez etkinleştirir; tepsi menüsünden kapatabilirsiniz. Oturum açma öğesi üzerinden sonraki açılışlarda pencere gizli başlar, tepsi ise kullanılabilir kalır.

## Menü çubuğu ve kullanım paneli

Menü çubuğu başlığı varsayılan olarak bugünkü toplam token miktarını gösterir. Kontrol panelinin **Menu bar & widget** ayarlarında istekleri, token miktarını, tahmini maliyeti, kotayı veya yalnızca simgeyi seçebilirsiniz.

Yerel paneli açmak için tepsi menüsündeki **Show Usage** seçeneğini kullanın. Panel, görüntüleme ayarlarınıza göre bugünkü ve 30 günlük toplamları, kullanım grafiğini, model listesini ve sağlayıcı ile hesap sınırlarını gösterir. Toplamlar token ve istekleri, etkinse tahmini maliyeti içerir. Kota satırları zaman aralığını, yüzdeyi ve sıfırlama zamanını gösterir. Eksik ölçümler `—` olarak görünür; kısmi kullanım eksik olarak işaretlenir.

Panelde **Refresh**, **Dashboard** ve **Settings** denetimleri bulunur. **Dashboard** masaüstü penceresinde kullanım görünümünü, **Settings** ise oradaki yardımcı ayarları açar. Tepsi menüsünde ayrıca **Open Dashboard**, **Open in Browser**, **Start at Login**, **Stop proxy**, **Check for Updates…**, güncelleme varsa **Install update** ve **Quit** öğeleri bulunur. **Stop proxy** her zaman listelenir, ancak yalnızca uygulama proxy'yi kendisi başlattığında etkin olur; ayrı başlattığınız proxy çalışmaya devam eder. Tepsi kullanılabilirken pencereyi kapatmak veya Command-Q kullanmak uygulamayı gizler; çıkmak için tepsideki **Quit** seçeneğini kullanın.

Kontrol panelindeki güncelleme düğmesi uygulamanın kendi güncelleme sayfasını açar; bu sayfa tepsi menüsüyle aynı imzalı güncellemeyi denetler ve kurar.

Tepsi başlığı her 60 saniyede yenilenir. Yerel panel açıkken verileri de her 60 saniyede yenilenir; **Refresh** anında güncelleme ister.

## Widget

macOS 14 veya sonrasında OpenCodex.app uygulamasını bir kez açın, masaüstündeki boş bir yere Control-tıklayın, **Edit Widgets** seçeneğini seçin, **OpenCodex** arayın ve istediğiniz boyutu ekleyin. Widget boyutları proxy durumu, bugünkü token ve istekler, tahmini maliyet, kotalar ve kullanım grafiğinin farklı birleşimlerini gösterir. Uzantı, masaüstü uygulamasının yazdığı yerel bir anlık görüntüyü okur; bu görüntü API anahtarları veya ham hesap verileri değil, görüntüleme verileri içerir. Uygulama, proxy bağlıyken widget anlık görüntüsünü her beşinci 60 saniyelik tepsi döngüsünde, yaklaşık beş dakikada bir yeniler. WidgetKit de beş dakika sonra yeni bir zaman çizelgesi ister.

## Proxy'ye bağlanma

Masaüstü uygulaması, paketindeki CLI'dan `ocx resolve --json` çalıştırmasını ister. Erişilebilir mevcut bir yerel proxy'ye bağlanır veya ancak CLI hiçbir çalışma zamanının dinlemediğini kanıtlarsa paketindeki çalışma zamanını başlatır. Keşif sonucu belirsizse ikinci bir proxy başlatmak yerine başlangıç sorunu bildirilir. Uygulama çözümlenen porta `127.0.0.1` üzerinden konuşur.

Yönetim isteklerinde uygulama önce belirteçsiz dener. Proxy HTTP 401 döndürürse uygulamanın ortamındaki `OPENCODEX_ADMIN_AUTH_TOKEN` veya çözümlenen yapılandırma evindeki `admin-api-token` dosyasıyla yeniden dener. Bu belirteç için macOS Keychain kullanmaz. Yalnızca uygulamanın geri döngü üzerinden erişemediği bir adrese bağlanan proxy'ye masaüstü kabuğu bağlanamaz.

## Kaynaktan derleme

macOS 13 veya sonrasında, Bun, Rust ve macOS Swift/Xcode araçları kullanılabilirken kontrol panelini depo kökünden derleyin, ardından masaüstü komutlarını `desktop/` içinden çalıştırın:

```bash
bun install
bun run build:gui
cd desktop
bun install
bun run prepare-sidecar
bun run prepare-widget
bun run build:local
```

`build:local`, Tauri güncelleyici imzalama anahtarı gerektirmeden yerel uygulamayı ve DMG'yi üretir. Doğrudan `bunx tauri build` ayrıca güncelleyici yapıtı ürettiği için `TAURI_SIGNING_PRIVATE_KEY` gerektirir. `MACOS_SIGN_IDENTITY` ayarlı değilse widget derlemesi ad hoc imza kullanır; yerel masaüstü paketleri de ad hoc olarak imzalanır. Uygulama çalışır ancak macOS ad hoc imzalı widget uzantısını kaydetmez; bu yüzden yerel derlemede genellikle OpenCodex widget'ı görünmez. `build:local` uygulamayı her zaman ad hoc olarak imzalar; yalnızca `MACOS_SIGN_IDENTITY` ayarlamak işe yaramaz: widget ancak uygulama ve uzantı, sürüm derlemesindeki gibi aynı Developer ID ekibiyle imzalanırsa kaydolur. Widget gerektiğinde sürüm derlemesini kullanın.

## Kaldırma

Etkinleştirdiyseniz tepsi menüsünde **Start at Login** seçeneğini kapatın, ardından `OpenCodex.app` uygulamasını Applications klasöründen Çöp Sepeti'ne taşıyın. Bu, paketindeki CLI'ı ve widget uzantısını kaldırır; proxy'nin `$OPENCODEX_HOME` durumunu veya ayrı kurulmuş `ocx` servisini kaldırmaz. Masaüstü uygulaması ayrıca kendi yapılandırma dizinine kurulum kimliği ve oturum açma öğesi işaretçileri ile `~/Library/Containers/com.opencodex.desktop.widget/Data/Library/Application Support/OpenCodex/snapshot.json` yoluna widget anlık görüntüsü yazar. Uygulamayı Çöp Sepeti'ne taşımak bu dosyaları silmez.
