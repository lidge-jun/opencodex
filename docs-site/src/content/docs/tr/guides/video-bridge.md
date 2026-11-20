---
title: Video Köprüsü (Video Bridge)
description: OpenAI harici bir model üzerinden Grok Imagine Video ile videolar üretin.
---

## Genel Bakış

Video Köprüsü, opencodex tarafından yönlendirilen herhangi bir OpenAI harici
model aracılığıyla xAI'ın Grok Imagine Video üretimini kullanmanızı sağlar.
Etkinleştirildiğinde sohbete sentetik bir `video_gen` aracı enjekte edilir.
Model bunu herhangi bir fonksiyon aracı gibi çağırır; opencodex çağrıyı yakalar,
xAI'a bir video üretim görevi gönderir, tamamlanana kadar yoklar ve sonucu
indirir.

Varsayılan olarak işler xAI'a gider; `images.videoProvider` bunları uyumlu başka bir arka uca gönderebilir.

## Ön Koşullar

Bu ön koşullar varsayılan xAI hedefi için geçerlidir. `images.videoProvider` ayarlıysa [Video sağlayıcısını seçme](#video-sağlayıcısını-seçme) bölümüne bakın.

- Bir **API anahtarına** sahip bir `xai` sağlayıcı kaydı (`ocx login xai` tek
  başına yeterli değildir — video köprüsü OAuth değil, anahtar kimlik
  doğrulaması gerektirir)
- Yönlendirilen sağlayıcınız olarak OpenAI harici bir model (örn. Anthropic
  Claude, Google Gemini)
- opencodex'in OpenAI harici sağlayıcı üzerinden yönlendirilecek şekilde
  yapılandırılmış olması

> **⚠ Sağlayıcı anahtarı gereklidir:** Video köprüsü yalnızca `xai` sağlayıcısı API anahtarı kimlik doğrulaması kullandığında devreye girer. Yapılandırmanıza şunu ekleyin:
>
> ```json
> {
>   "providers": {
>     "xai": { "adapter": "openai-chat", "apiKey": "${XAI_API_KEY}", "authMode": "key" }
>   }
> }
> ```
>
> `XAI_API_KEY` değerini proxy başlangıç ortamında ayarlayın; `${XAI_API_KEY}` ve `authMode: "key"` korunsun. Başka terminalde export, çalışan proxy’yi değiştirmez; sahibi Desktop, hizmet veya ön plan terminalinden yeniden başlatın. Anahtarları commit ve günlüklere koymayın.

## Yapılandırma

`images` yapılandırmanıza `videoBridgeEnabled: true` ekleyin:

```json
{
  "images": {
    "bridgeEnabled": true,
    "videoBridgeEnabled": true,
    "videoBridgeModel": "grok-imagine-video-1.5-lite",
    "videoMaxRounds": 2,
    "videoTimeoutMs": 300000
  }
}
```

| Seçenek | Varsayılan | Açıklama |
|--------|---------|-------------|
| `videoBridgeEnabled` | `false` | Ana anahtar. Açıkça etkinleştirilmelidir. |
| `videoBridgeModel` | `"grok-imagine-video-1.5-lite"` | xAI video model kimliği. |
| `videoMaxRounds` | `2` | Zorunlu nihai yanıttan önceki maksimum video üretim turu. |
| `videoTimeoutMs` | `300000` (5 dk) | Yoklama dahil video başına zaman aşımı süresi. |
| `videoProvider` | ayarlanmamış (xAI) | `video_gen` çağrılarını kendi `baseUrl` ve anahtarıyla karşılayan isteğe bağlı API anahtarlı sağlayıcı. Bkz. [Video sağlayıcısını seçme](#video-sağlayıcısını-seçme). |

## Video sağlayıcısını seçme

Köprü varsayılan olarak `video_gen` işlerini `xai` sağlayıcısının API anahtarıyla xAI'a gönderir. Bunları aynı eşzamansız API'yi (`POST {baseUrl}/videos/generations`, ardından `GET {baseUrl}/videos/{id}`) uygulayan başka bir arka uca, örneğin kendi barındırdığınız bir medya köprüsüne göndermek için `images.videoProvider` ayarlayın:

```json
{
  "providers": {
    "my-video-bridge": {
      "adapter": "openai-chat",
      "baseUrl": "http://127.0.0.1:8790/v1",
      "apiKey": "${VIDEO_BRIDGE_KEY}",
      "authMode": "key",
      "allowPrivateNetwork": true
    }
  },
  "images": {
    "videoBridgeEnabled": true,
    "videoProvider": "my-video-bridge",
    "videoBridgeModel": "grok-imagine-video-1.5-lite"
  }
}
```

- Hedef ve kimlik bilgisi olarak yalnızca adı verilen sağlayıcının kendi `baseUrl` değeri ve API anahtarı kullanılır. Bağdaştırıcı önemli değildir, ancak API anahtarı kimlik doğrulaması gerekir.
- `"videoProvider": "xai"`, `xai` satırındaki `baseUrl` ne olursa olsun sabit `https://api.x.ai/v1` uç noktasını korur. Diğer yerleşik sağlayıcı kimlikleri reddedilir; özel bir sağlayıcı belirtin.
- Geri döngü veya özel ağ `baseUrl` değeri, diğer sağlayıcı trafiğinde olduğu gibi o sağlayıcıda `allowPrivateNetwork: true` gerektirir.
- OpenCodex'in xAI'a ait olarak tanıyabildiği bir anahtar (`xai-` biçimli anahtar, herhangi bir `xai` satırının anahtarı veya adında xAI ya da Grok geçen ortam değişkeni başvurusu) yalnızca `https://api.x.ai` veya `https://cli-chat-proxy.grok.com` adresine gönderilir; diğer her kaynak reddedilir. Bu işaretleri taşımayan bir anahtar tanınamaz, bu yüzden xAI anahtarınızı başka bir sağlayıcının satırına yapıştırmayın. Başka bir sağlayıcının sırrına işaret eden anahtar zinciri başvurusu her zaman reddedilir, duraklatılmış etkin anahtar da reddedilir ve `baseUrl` kimlik bilgisi, sorgu veya parça içeremez.
- Sağlayıcı yoksa, devre dışıysa, duraklatılmışsa, anahtarı yoksa veya reddedildiyse her `video_gen` çağrısı bu hatayı modele döndürür. Hiçbir şey gönderilmez ve köprü asla xAI'a geri dönmez.
- Tamamlanan video yine yalnızca base64 `data:` URL'sinden veya herkese açık bir `https:` URL'sinden indirilir; bu nedenle yerel bir köprü `video.url` olarak bunlardan birini döndürmelidir.

## Nasıl Çalışır?

1. opencodex, `videoBridgeEnabled: true` etkinken OpenAI harici yönlendirilen
   bir modeli algılar
2. Sohbete sentetik bir `video_gen` fonksiyon aracı enjekte edilir
3. Model `video_gen`'i çağırdığında opencodex xAI'ın `/videos/generations` uç
   noktasına bir görev gönderir (veya yapılandırılan `images.videoProvider` sağlayıcısına)
4. Köprü akışı canlı tutmak için kalp atışı mesajları göndererek her 5-15
   saniyede bir görev durumunu yoklar
5. Video hazır olduğunda yapılar (artifacts) dizinine indirilir
6. Yerel dosya yolu modele bir araç sonucu olarak döndürülür

## Desteklenen Parametreler

`video_gen` aracı şunları kabul eder:

| Parametre | Tip | Aralık | Açıklama |
|-----------|------|-------|-------------|
| `prompt` | string | görüntü veya kare varsa isteğe bağlı | Metin istemi |
| `duration` | integer | 1-15 | Saniye cinsinden video uzunluğu |
| `resolution` | string | `480p`, `720p`, `1080p` | Modele bağlıdır; `last_frame`, `keyframes` veya `reference_images` ile en fazla 720p |
| `aspect_ratio` | string | modele bağlı | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3`, `21:9`, `5:2`; yalnızca `image` canlandırılırken reddedilir; görüntü kendi oranını korur |
| `image` | string | ilk kare | HTTPS URL’si, veri URL’si veya hatırlanan artifact |
| `last_frame` | string | yalnızca 1.5 | Son kare |
| `keyframes` | array | 1.5, en fazla 4 | `{image, timestamp_s}`; zaman damgası kesinlikle klibin içinde olmalıdır (`duration` atlanırsa 8 s) |
| `reference_images` | array | 1.5: 14, klasik: 7 (≤ 10 s) | Referans görüntüler; klasik model bunları `image` ile birleştiremez |

Modelin karşılayamayacağı ayarlar yok sayılmak yerine ücretli çağrıdan önce reddedilir.

### Modeller ve görüntü girdileri

| Model | Çözünürlük | Girdiler | saniye başına (480p / 720p / 1080p) |
|-------|------------|--------|------------------|
| `grok-imagine-video-1.5` | 480p / 720p / 1080p doğal | ilk/son kare, 4 anahtar kare, 14 referans (720p en fazla) | $0.08 / $0.14 / $0.25 |
| `grok-imagine-video-1.5-lite` (varsayılan) | 480p / 720p / 1080p büyütülmüş | ilk kare | $0.02 / $0.03 / $0.14 |
| `grok-imagine-video` | 480p / 720p | ilk kare, 7 referans | $0.05 / $0.07 / — |

Kare sabitleme veya referanslar için `images.videoBridgeModel` değerini `grok-imagine-video-1.5` yapın. Bilinen modeller dokuz en boy oranını destekler; bilinmeyen modeller yedi oran ve 480p/720p ile sınırlıdır ve görüntü girdisi almaz. HTTPS URL’leri ve kodu çözülmüş boyutu 10 MiB’ye kadar PNG/JPEG/WebP veri URL’leri kabul edilir. Köprünün indirdiği görüntüler bir saat boyunca artifact URL’si, mutlak yol veya `file:` URL’siyle anılabilir; yerel dosya okunmadan kayıtlı kaynak URL kullanılır. Bu yalnızca sabit xAI hedefinde çalışır, özel `images.videoProvider` için çalışmaz. Satır içi sonuçların kaynak URL’si yoktur ve geçici URL daha erken sona erebilir.


## Sınırlamalar

- **Varsayılan olarak xAI**: `videoProvider` olmadan video üretimi xAI'ın Grok Imagine Video API'sini kullanır; başka bir arka uç aynı eşzamansız API'yi uygulamalıdır
- **Zaman uyumsuz (Asynchronous)**: Video üretimi 30-120 saniye sürer
- **Çağrı başına bir video**: Her `video_gen` çağrısı bir video üretir
- **Görsel Köprüsü (Image Bridge) ile birlikte var olur**: Her iki köprü aynı
  anda etkinleştirilebilir
- **Web arama önceliği**: Bir tur için bir web arama sidecar'ı etkinken
  (`runTurn` olmayan adaptör), video köprüsü atlanır — ikisi eşzamanlı olarak
  çalışamaz. Bunu günlüklerde algılayabilmeniz için bir `console.warn`
  yayınlanır.
- **Zaman aşımı gönderme + yoklamayı kapsar**: `videoTimeoutMs` bütçesi iş
  gönderilmeden önce başlar, bu nedenle gönderme çağrısı (60 sn) ve sonraki
  yoklama aynı son tarihi paylaşır.


