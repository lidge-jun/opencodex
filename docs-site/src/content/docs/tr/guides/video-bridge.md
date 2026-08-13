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

## Ön Koşullar

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
>     "xai": { "adapter": "openai-chat", "apiKey": "xai-…", "authMode": "key" }
>   }
> }
> ```
>
> `ocx login xai` (OAuth) ile katıldıysanız sağlayıcı `authMode: "oauth"` modunda kalır ve köprü sessizce devreye girmez. Ortamda `XAI_API_KEY` ayarlayın **veya** anahtarı yukarıda gösterildiği gibi sabit kodlayın.

## Yapılandırma

`images` yapılandırmanıza `videoBridgeEnabled: true` ekleyin:

```json
{
  "images": {
    "bridgeEnabled": true,
    "videoBridgeEnabled": true,
    "videoBridgeModel": "grok-imagine-video",
    "videoMaxRounds": 2,
    "videoTimeoutMs": 300000
  }
}
```

| Seçenek | Varsayılan | Açıklama |
|--------|---------|-------------|
| `videoBridgeEnabled` | `false` | Ana anahtar. Açıkça etkinleştirilmelidir. |
| `videoBridgeModel` | `"grok-imagine-video"` | xAI video model kimliği. |
| `videoMaxRounds` | `2` | Zorunlu nihai yanıttan önceki maksimum video üretim turu. |
| `videoTimeoutMs` | `300000` (5 dk) | Yoklama dahil video başına zaman aşımı süresi. |

## Nasıl Çalışır?

1. opencodex, `videoBridgeEnabled: true` etkinken OpenAI harici yönlendirilen
   bir modeli algılar
2. Sohbete sentetik bir `video_gen` fonksiyon aracı enjekte edilir
3. Model `video_gen`'i çağırdığında opencodex xAI'ın `/videos/generations` uç
   noktasına bir görev gönderir
4. Köprü akışı canlı tutmak için kalp atışı mesajları göndererek her 5-15
   saniyede bir görev durumunu yoklar
5. Video hazır olduğunda yapılar (artifacts) dizinine indirilir
6. Yerel dosya yolu modele bir araç sonucu olarak döndürülür

## Desteklenen Parametreler

`video_gen` aracı şunları kabul eder:

| Parametre | Tip | Aralık | Açıklama |
|-----------|------|-------|-------------|
| `prompt` | string | gerekli | Ayrıntılı video üretim istemi |
| `duration` | integer | 1-15 | Saniye cinsinden video uzunluğu |
| `resolution` | string | `"480p"`, `"720p"` | Video çözünürlüğü |
| `aspect_ratio` | string | 7 oran | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3` |

## Sınırlamalar

- **Yalnızca xAI**: Video üretimi yalnızca xAI'ın Grok Imagine Video API'si
  aracılığıyla kullanılabilir
- **Zaman uyumsuz (Asynchronous)**: Video üretimi 30-120 saniye sürer
- **Maliyet**: Video üretimi ücretli bir xAI özelliğidir (~$0.05/sn @480p,
  ~$0.07/sn @720p)
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


