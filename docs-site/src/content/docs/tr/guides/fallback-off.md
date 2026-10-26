---
title: Yedek geçişini kapatma
description: Model ve sağlayıcı yedek geçişini kapsama göre kapatın; Home'a ulaşılamadığında Remote Link Child davranışını öğrenin.
---

Seçtiğiniz hedef başarısız olduğunda OpenCodex isteği başka bir model veya
sağlayıcıyla karşılayabilir: [combo](/tr/guides/combos/) sonraki hedefe,
[yönlendirme profili](/tr/guides/routing-profile-editor/) sonraki adaya geçer;
başlatılan alt ajan model yedek zincirinde ilerler, ana hesap kesin kilidi ise
yapılandırılan yedek modele yönlendirebilir. Bunların tümü varsayılan olarak açıktır.

Seçmediğiniz bir yerden yanıt almak yerine açık bir hata almak istiyorsanız
ilgili yedek geçişini **kapatın**.

## Yedek geçişi sayılan durumlar

Yedek geçişi, **farklı modele** veya **farklı sağlayıcıya** geçiştir:

| Tür | Örnek | Anahtar |
| --- | --- | --- |
| Model yedeği | `anthropic/claude-opus` başarısız; `anthropic/claude-sonnet` yanıtlayacak | `model` |
| Sağlayıcı yedeği | `anthropic/claude-opus` başarısız; `openai/gpt-6-sol` yanıtlayacak | `provider` |

Aynı model için **tek sağlayıcı havuzundaki** hesaplar veya API anahtarları arasında
dönüşüm yedek geçişi değildir. Havuz, hız sınırına takılan hesabı bu şekilde
telafi eder ve buradaki ayarlar bunu durdurmaz. Aynı hedefi yeniden denemek veya
hedefi koruyan aktarım yedekleri de bu kapsama girmez.

## Yedek geçişini kapatma

```bash
ocx fallback off                               # model ve sağlayıcı yedeğini her yerde kapat
ocx fallback off --kind provider               # yalnızca sağlayıcılar arası geçişler
ocx fallback off --route combo/coding          # tek combo, yönlendirme profili veya model seçicisi
ocx fallback off --provider anthropic          # bu sağlayıcıdan ayrılan geçişler
ocx fallback on --route combo/coding           # genel kapatma altında bir istisna
ocx fallback clear --route combo/coding        # geçersiz kılmayı kaldır
ocx fallback status                            # güncel ayarlar ve son yedek geçişi
```

Aynı anahtarlar panoda da bulunur. **Dashboard** sayfasının altındaki **Fallback**
kartı genel anahtarları, geçersiz kılmaları ve yapılan ya da reddedilen son geçişi gösterir.

### Öncelik

1. Kapalı ayarlanmış **cihaz** her zaman reddeder ([cihaz ayarları](#cihaz-ayarları)).
   Cihaz ayarı yalnızca reddedebilir; açılması başka kapsamın reddettiği geçişe izin vermez.
2. Diğer durumlarda en özel ayar kazanır: **rota**, ardından **sağlayıcı**, ardından **genel**.
3. Ayar yoksa izin verilir; mevcut davranış budur.

Ayarlar `config.json` içindeki `fallback` bölümünde saklanır:

```json
{
  "fallback": {
    "provider": false,
    "routes": { "combo/coding": { "provider": true } },
    "providers": { "anthropic": { "model": false } },
    "devices": { "lnk_0123456789abcdef": { "localFallback": false, "model": false } }
  }
}
```

Bozuk bir yaprak değer yok sayılır; ilke çözümlemesi sonraki uygun kapsamı kullanır
ve `ocx config` tanılaması bunu belirtir. Böyle bir değer içeren tüm yapılandırmayı
yazma işlemi ise reddedilir.

## Alınan hata

Reddedilen geçiş, **onu tetikleyen hatanın durum koduyla** yanıtlanır. Örneğin
429, `Retry-After` başlığıyla birlikte 429 olarak kalır:

```json
{
  "error": {
    "type": "fallback_refused",
    "code": "fallback_refused",
    "message": "combo/coding: anthropic/claude-opus failed (rate_limited). Provider fallback to openai/gpt-6-sol is off for route combo/coding, so OpenCodex did not send the request there. To allow it: ocx fallback on --kind provider --route combo/coding",
    "fallback": { "kind": "provider", "scope": "route", "scopeKey": "combo/coding",
                  "from": "anthropic/claude-opus", "to": "openai/gpt-6-sol", "trigger": "rate_limited" }
  }
}
```

Yanıt `x-opencodex-fallback: refused` başlığını da taşır. İlk hedefin kullanılamadığı
önceden biliniyorsa hiçbir şey gönderilmeden ret verilir; yedek hedefle hiç iletişim kurulmaz.
Durum kodu ilk hedefin atlanma nedenine bağlıdır:

- Combo'nun ilk hedefi bekleme süresindeyse veya kotası bittiyse: 429.
- Combo'nun ilk hedefi devre dışıysa veya isteğe uygun değilse: 503.
- Ana hesap engelliyse: 429.
- Alt ajan modeli kullanılamıyorsa: 503.

Gerçek bir üst sağlayıcı hatasından sonra ret, o hatanın durum kodunu korur.

## Remote Link Child ve Hub istemcileri

Remote Link Child ve Hub istemcisi kendi yerel sağlayıcılarından istek karşılamaz.
Home'a ulaşılamadığında Child yeniden denenebilir `503`, Hub istemcisinin pano
aktarıcısı ise `502` döndürür:

```json
{ "error": "link tunnel unavailable", "code": "home_unreachable", "message": "The Home is unreachable, and OpenCodex did not serve this request from this device's local providers. …" }
```

Yerel sağlayıcıya hiçbir şey gönderilmez; bağlantı anahtarı ve istek gövdesi cihazdan çıkmaz.

### Cihaz ayarları

Home üzerinde her bağlı cihazın **Remote Link** sayfasında veya CLI'da iki anahtarı vardır:

```bash
ocx fallback local on --device mac-studio      # Home kapalıyken yerel yedek izni
ocx fallback off --device mac-studio           # bu cihazın isteklerinde model ve sağlayıcı yedeğini reddet
```

`--device`, `ocx link status` çıktısındaki bağlantı takma adını/kimliğini veya
Hub veri anahtarı kimliğini alır.

**Yerel yedek**, GOAT'ın okuduğu bir izindir. Açıksa GOAT, Home'a ulaşılamadığında
cihazın işini cihazın kendi oturumlarına taşıyabilir. OpenCodex'in kendisi yine
`home_unreachable` döndürür ve cihazda yerel hizmet vermez. Siz açmadıkça kapalıdır.

## Durum

`ocx status --json` bir `fallback` nesnesi içerir (Child üzerinde bağlantıdan okunan
Home nesnesidir). `GET /api/fallback` aynı `ocx.fallback/1` belgesini döndürür:
etkin genel anahtarlar, geçersiz kılmalar, her cihazın yerel yedek izni ve yapılan
ya da reddedilen son 20 geçiş. Kayıtlarda zaman, rota, kaynak, hedef, tetikleyici
ve kararı veren kapsam bulunur. Liste bellektedir, proxy yeniden başlayınca
sıfırlanır. İstek gövdesi, anahtar veya hesap kimliği içermez.

Bu özelliği destekleyen Home, `GET /readyz` yanıtının `features` alanında
`fallback-policy/1` bildirir.
