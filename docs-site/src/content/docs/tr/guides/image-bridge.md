---
title: Görsel Köprüsü (Image Bridge)
description: OpenAI harici bir sağlayıcı kullanırken image_generation araç çağrılarını xAI Grok Imagine'a yönlendirin.
---

## Genel Bakış

Codex'i OpenAI harici bir model (Claude, Gemini, Grok vb.) üzerinden
yönlendirdiğinizde, `image_generation` **barındırılan aracı (hosted tool)**
normal şartlarda çalışmaz — çünkü OpenAI'ın sunucu tarafı yürütme ortamına
ihtiyaç duyar. Görsel Köprüsü (Image Bridge), bu çağrıları tespit eder ve şeffaf
bir şekilde xAI Grok Imagine'a yönlendirir; böylece sohbet ettiğiniz model
sorunsuz bir şekilde görsel üretmeye devam edebilir.

## Ön Koşullar

- Yapılandırmanızda `images.bridgeEnabled: true` olarak ayarlayarak **köprüyü
  etkinleştirin** (beklenmeyen xAI ücretlerini önlemek için varsayılan olarak
  kapalıdır — aşağıdaki [Yapılandırma](#yapılandırma) bölümüne bakın).
- **API anahtarına** sahip bir `xai` sağlayıcı kaydı. Köprü, istekleri doğrudan
  xAI Images uç noktasına (`https://api.x.ai/v1`) gönderir; yapılandırılmış
  herhangi bir `baseUrl` geçersiz kılma ayarı görsel çağrıları için yok sayılır.
  Yalnızca OAuth / `ocx login xai` köprüyü **etkinleştirmez** (Grok CLI OAuth
  aktarımı sohbet odaklıdır ve `/images/*` için kullanılmaz).

  ```json
  {
    "providers": {
      "xai": { "adapter": "openai-chat", "apiKey": "xai-…", "authMode": "key" }
    }
  }
  ```

- Aktif sağlayıcınız olarak OpenAI harici bir model seçilmiş olmalıdır. (Aktif
  sağlayıcı OpenAI olduğunda, yerel barındırılan araç doğrudan kullanılır ve
  köprü devre dışı kalır.)

## Yapılandırma

Görsel Köprüsü seçenekleri `~/.opencodex/config.json` dosyasındaki `images`
altında bulunur. Köprü **isteğe bağlıdır (opt-in)** — ücretli xAI Grok Imagine
görsel üretimini etkinleştirmek için `bridgeEnabled: true` ayarlamalısınız:

```json
{
  "images": {
    "bridgeEnabled": true,
    "bridgeModel": "grok-imagine-image-quality",
    "maxRounds": 3,
    "timeoutMs": 60000
  }
}
```

| Seçenek | Varsayılan | Açıklama |
| --- | --- | --- |
| `bridgeEnabled` | `false` | Ana anahtar. Köprüyü etkinleştirmek için `true` yapın. Beklenmeyen xAI maliyetlerini önlemek için varsayılan olarak kapalıdır. |
| `bridgeModel` | `grok-imagine-image-quality` | İsteklerin gönderileceği xAI görsel model kimliği. |
| `maxRounds` | `3` | Tur başına maksimum görsel üretim döngüsü sayısı. Tam sayıya yuvarlanır ve `[0, 10]` aralığına sınırlandırılır; geçersiz değerler `3`'e döner. |
| `timeoutMs` | `60000` | Milisaniye cinsinden çağrı başına xAI zaman aşımı süresi. |
| `artifactsKeepCount` | `200` | `artifacts/` dizininde saklanacak maksimum dosya sayısı. Aşıldığında, tamamlanan her çağrıdan sonra en eski dosyalar otomatik temizlenir. |

## Çıktıların Saklanması (Artifact Retention)

Üretilen görseller `~/.opencodex/artifacts/` dizinine kaydedilir. Uzun
oturumlarda sınırsız disk büyümesini önlemek için, tamamlanan her görsel
çağrısından sonra dizin otomatik olarak temizlenir — dosya sayısı yapılandırılan
maksimum değeri aştığında en eski dosyalar silinir (varsayılan 200,
`images.artifactsKeepCount` ile ayarlanabilir). Yalnızca temizleme işleminden
sonra kalan yollar modele iletilir.

## Nasıl Çalışır?

Görsel Köprüsü, yalnızca **OpenAI harici** bir model seçiliyken `/v1/responses`
araçlar dizisinde `image_generation` aracını içeren **Responses** turlarında
devreye girer. Codex'in doğrudan `/v1/images/generations` uç noktasına istek
atan yerleşik `image_gen` aracına müdahale **etmez** — bu yol [Codex
Entegrasyonu](/tr/guides/codex-integration/#dahili-görsel-üretimi-image_gen)
kılavuzunda ayrı olarak ele alınmıştır.

1. Bir Responses isteği `tools` içinde `image_generation` içerdiğinde, OpenCodex
   bunu istek ön işleme sırasında tespit eder.
2. Barındırılan araç, yönlendirilen modelin normal şekilde çağırabileceği
   **sentetik bir fonksiyon aracı (synthetic function tool)** ile değiştirilir.
3. Model bu aracı çağırdığında, OpenCodex çağrıyı yakalar ve prompt'u xAI'ın
   görsel üretim API'sine iletir.
4. Üretilen görseller `~/.opencodex/artifacts/` dizinine kaydedilir ve **yerel
   dosya yolu** araç sonucu olarak modele döndürülür.
5. Model, üretilen görsel ve konumu hakkında bilgi sahibi olarak sohbete devam
   eder.

Model açısından hiçbir şey değişmemiştir — bir araç çağırmış ve sonuç almıştır.
Kullanıcı açısından ise görsel üretimi, hata vermek yerine yönlendirilen
herhangi bir sağlayıcıyla sorunsuz çalışır.

## Sınırlamalar

- **Yalnızca xAI Grok Imagine desteklenir.** DALL-E ve diğer görsel
  sağlayıcıları daha sonra eklenebilir.
- Web arama sidecar döngüsünü destekleyen adaptörlerde **web araması
  önceliklidir**. Aynı turda hem web araması hem görsel üretimi istenirse, web
  araması çalıştırılır ve görsel üretimi atlanır.
- **xAI maliyetleri geçerlidir.** xAI üzerinden görsel üretimi aktif bir xAI
  aboneliği veya API kredisi gerektirir.
- **Yalnızca akış (streaming) modu.** Köprü, SSE yanıt akışını yakalayarak
  çalışır; `stream: false` olan istekler 400 hatasıyla reddedilir.


