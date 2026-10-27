---
title: Yerel eklentiler
description: Sağlayıcı gönderimlerini değiştirmek ve örneğin sağlayıcıların önüne yerel sıkıştırma proxy'si koymak için başlangıçta kendi kodunuzu yükleyin.
---

Yerel eklenti, `ocx start` komutunun proxy hizmet vermeye başlamadan yüklediği
TypeScript/JavaScript dosyasıdır. Her sağlayıcı gönderimini işlemden çıkmadan
hemen önce görebilir, yönlendirebilir veya başlık ekleyebilir. Böylece opencodex'i
değiştirmeden sağlayıcıların önüne yerel yardımcı servis (sıkıştırma proxy'si veya
kayıt aracı gibi) yerleştirebilirsiniz.

Eklentiler tek kuruluma özeldir. opencodex bunları indirmez, güncellemez veya imzalamaz.

## Eklentilerin konumu

Dosyaları opencodex ana dizinindeki `plugins/` içine koyun: `~/.opencodex/plugins/`
veya değişken ayarlıysa `$OPENCODEX_HOME/plugins/`.

```text
~/.opencodex/plugins/
  my-sidecar.ts
```

- `.ts`, `.js`, `.mjs` dosyaları ad sırasıyla yüklenir.
- `.` veya `_` ile başlayan adlar ve `*.d.ts` yok sayılır. Kapatmak için dosyayı
  `_my-sidecar.ts` olarak yeniden adlandırın.
- Dizin isteğe bağlıdır; yoksa hiçbir şey yüklenmez.
- Eklenti proxy içinde sizin kimlik bilgilerinizle çalışır. Bu yüzden dosya veya
  `plugins/` dizini başka kullanıcıya aitse, grup/diğer kullanıcılarca yazılabiliyorsa
  ya da sembolik bağlantıysa reddedilir. `/` köküne kadar tüm üst dizinler size
  veya root'a ait olmalı ve `/tmp` gibi sticky değillerse grup/diğer kullanıcılarca
  yazılamamalıdır. İzinler için `chmod go-w ~/.opencodex/plugins ~/.opencodex/plugins/*`
  kullanın; varsayılan umask `002` olan sistemlerde üst dizinleri de kontrol edin.
  macOS'ta başka kullanıcıya/gruba yazma, silme, izin değiştirme veya yol girdisi
  ekleme/silme yetkisi veren ACL, mod `0600` olsa bile yüklemeyi engeller.
  Yolun kendisini `/bin/ls -lebd -- <path>` ile inceleyin. Salt okunur, ret,
  yalnızca devralma ve yalnızca yol sahibine/çalışan kullanıcıya verilen izinler
  engellemez. `root` veya `0` gibi ACL görünen adları sayısal UID kanıtı sayılmaz.
  Linux'ta `getfacl` kuruluysa genişletilmiş ACL denetlenir; yoksa yalnızca sahiplik
  ve mod bitleri doğrulanır.
- Windows'ta ACL güven kontrolü sağlanana kadar otomatik eklenti yükleme kapalıdır.

Ekleme, değiştirme veya kaldırma sonrasında proxy'yi yeniden başlatın
(`ocx service restart` veya `ocx start` işlemini durdurup başlatın). Yüklenen her
eklenti başlangıçta `Plugin loaded: <name>` yazar; atlanan eklenti sınırlı bir
neden kategorisi bildirir. Ham eklenti istisna metni otomatik yazdırılmaz.

Bir kez eklentisiz başlatmak için `OCX_PLUGINS=0` ayarlayın.

## Eklenti yazma

Eklenti, isteğe bağlı `name` ve bir `setup` işlevi içeren nesneyi varsayılan dışa
aktarım olarak sunar. `setup` bir bağlam alır. Asenkron `setup` beş saniyede
tamamlanmalıdır. Eklentiler proxy'nin kendi iş parçacığında çalıştığından senkron
bloklayan `setup` kesilemez; dönene kadar başlangıcı geciktirir. Zaman aşımındaki
`setup` da durdurulmaz: başlattığı sunucu/zamanlayıcılar çalışmaya devam eder.
Uzun ömürlü kaynakları yalnızca başarısız olabilecek işlerden sonra başlatın.

```ts
interface UpstreamTarget {
  url: string;            // mutlak üst sunucu URL'si; yönlendirmek için değiştirin
  headers: Headers;       // kimlik bilgileri dahil giden başlıklar; asla kaydetmeyin
  readonly transport: "http" | "websocket";
}

export default {
  name: "my-sidecar",
  setup(ctx: {
    log(message: string): void;
    registerUpstreamRewriter(rewrite: (target: UpstreamTarget) => void): void;
    onShutdown(teardown: () => void): void;
  }) {
    ctx.registerUpstreamRewriter(target => {
      const upstream = new URL(target.url);
      if (!upstream.pathname.endsWith("/chat/completions")) return;
      target.url = `http://127.0.0.1:9000${upstream.pathname}${upstream.search}`;
      target.headers.set("x-original-origin", upstream.origin);
    });
  },
};
```

Bağlam ayrıca `name`, `configDir` (opencodex ana dizini) ve `pluginDir` taşır.

Eklentiler opencodex modüllerini içe aktaramaz; paketlenmiş çalıştırılabilir
dosyada bunlar diskte bulunmaz. Gerekli küçük arayüzleri örnekteki gibi yerel tanımlayın.

## Yeniden yazmanın davranışı

- Yeniden yazıcı, opencodex aktarımı seçtikten sonra her HTTP sağlayıcı gönderiminde
  ve Codex WebSocket bağlantısında senkron çalışır. Hızlı tutun; sağlık sorguları
  gibi ağ kontrollerini arka planda yapıp önbellekteki sonucu okuyun.
- Geri döngü adresine (`127.0.0.1`, `::1`, `localhost`) yönlendirilen gönderim HTTP
  ve Codex WebSocket üzerinde doğrudan bağlanır; sağlayıcı proxy'lerini ve
  `HTTP_PROXY` değerini yok sayar. Başka yerdeki proxy bu makinenin geri döngüsüne
  ulaşamaz. Diğer hedefler iki aktarımda da yeniden yazılan URL'ye göre normal
  çıkış ayarlarını (`NO_PROXY` dahil) kullanır.
- Codex WebSocket yeniden yazıcısı, boş havuz soketi yeniden kullanılmadan önce
  her turda çalışır. Soket yalnızca hedef ve yeniden yazılan başlıklar aynıysa
  kullanılır; tur başına `x-codex-turn-state` ve `x-codex-turn-metadata` istisnadır.
  Bunlar istek çerçevesinde taşınır, aynı sokette değişebilir ve yeniden yazıcının
  bunlara yaptığı değişiklikler atılır. Eklentinin yönlendirmeyi başlatması veya
  bırakması sonraki turda etkili olur.
- Sağlayıcı, hesap ve rota seçildikten sonra çalışır; yönlendirmeyi, hesap seçimini,
  yeniden denemeleri veya istek günlüklerini değiştirmez.
- Gönderim seçtiğiniz sunucuya gider. O sunucu, kimlik bilgileri dahil sağlayıcının
  göreceği isteği görür.
- Yeniden yazıcı hata fırlatırsa opencodex o yazıcının değişikliklerini geri alıp
  işlem sonuna kadar onu kapatır. Önceki yeniden yazıcıların değişiklikleri korunur;
  tek eklentiyse gönderim değişmeden çıkar. `setup` hata verir veya zaman aşımına
  uğrarsa eklenti atlanır, kaydettikleri kaldırılır, sonraki kayıt girişimleri yok
  sayılır. Diğer eklentiler ve proxy normal başlar.
- Mevcut ama okunamayan eklenti dizini (örneğin yanlış izinler) boş sayılmaz;
  başlangıçta bildirilir.
