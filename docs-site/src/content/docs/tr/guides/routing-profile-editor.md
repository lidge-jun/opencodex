---
title: Yönlendirme Profili Düzenleyicisi
description: OpenCodex kontrol panelinden yönlendirme politikası profilleri oluşturun, düzenleyin, doğrulayın, deneme çalıştırması (dry-run) yapın ve kaldırın.
---

OpenCodex kontrol panelindeki **Modeller → Yönlendirme** sekmesi, `config.json`
dosyasını elle düzenlemeden `config.routingProfiles` alanını yönetebilir.

## Bir profil oluşturma

1. Kontrol panelinde **Yönlendirme (Routing)** sayfasını açın.
2. **Profil oluştur (Create profile)** seçeneğini belirleyin.
3. Bir `id` girin. Kurallı model kimliği `policy/<id>` olur.
4. Bir veya daha fazla açık sağlayıcı/model adayı ekleyin.
5. İsteğe bağlı gereksinimleri, puanlama ağırlıklarını, maliyet sınırlarını
   (`maxEstimatedCostUsd`, isteğe bağlı `onUnknownCost`) ve bilinmeyen kanıt
   davranışını yapılandırın.
6. Profili kaydedin.

Profil kimlikleri oluşturulduktan sonra sabittir (immutable). Farklı bir kimlik
kullanmak için yeni bir profil oluşturun ve arayanları güncelledikten sonra
eskisini kaldırın.

## Doğrulama ve kalıcılık

Kontrol paneli, `config.routingProfiles` tarafından kullanılan aynı profil
nesnesini yönetim API'sine gönderir. Sunucu yazmadan önce adayın tamamını
doğrular:

- kimlikler ve takma adlar yönlendirme profili adlandırma ve çakışma kurallarına
  uymalıdır;
- her aday sağlayıcı mevcut olmalı ve etkinleştirilmelidir;
- yinelenen adaylar reddedilir;
- sayısal sınırlar ve gereksinimler desteklenen aralıkları içinde kalmalıdır; ve
- en az bir optimizasyon ağırlığı pozitif olmalıdır.

Başarılı bir kaydetme, profili normal yapılandırma yazıcısı aracılığıyla kalıcı
hale getirir, canlı durumu uzlaştırır ve model kataloğunu yeniler. Doğrulama
hataları önceki yapılandırmayı değiştirmeden bırakır ve düzenleyicide
gösterilir.

`limits.maxEstimatedCostUsd` yapılandırıldığında, `limits.onUnknownCost`
varsayılan olarak `"allow"` değerini alır: bilinmeyen bir maliyet tahmini sınıra
özgü bir hariç tutma almaz ve deneme çalıştırması / canlı rota kararı izleri
`cost.capOutcome: "unknown-allowed"` damgasını vurur, böylece operatörler
sınırın kanıtlanmadığını anlayabilir. Tavanın kapalı olarak başarısız olması
gerektiğinde `"exclude"` olarak ayarlayın (`cost.capOutcome: "unknown-excluded"`
ile `cost-limit-unknown`). Yalnızca `onUnknownCost`'u yapılandırmak etkisizdir
ve bir sınır sonucu yayınlamaz. Bu, sınır sonucundan bağımsız olarak bilinmeyen
fiyatları hariç tutabilen veya cezalandırabilen `unknownEvidence.cost`'tan
ayrıdır.

## Kaydedilmiş bir profilde deneme çalıştırması (dry-run) yapma

Kaydedilmiş bir profili seçin ve bağlam penceresi boyutu, araç kullanımı, görsel
girişi veya yapılandırılmış çıktı gibi istek kanıtları eklemek için **Deneme
çalıştırması değerlendirmesi (Dry-run evaluation)**'ı kullanın. Deneme
çalıştırması uygunluğu ve puanlamayı değerlendirir ancak asla bir yukarı akış
model isteği göndermez.

Kaydedilmemiş düzenlemeler deneme çalıştırması tarafından kullanılmaz.
Görüntülenen revizyon ve değerlendirmenin aynı yapılandırmaya atıfta bulunması
için önce profili kaydedin.

## Yönetim API'si

Düzenleyici şu uç noktaları kullanır:

- `GET /api/routing-profiles`, normalleştirilmiş profilleri ve revizyonları
  listeler.
- `PUT /api/routing-profiles`, tek bir profili oluşturur veya günceller. `mode:
  "create"` veya `mode: "update"` gönderin; oluşturma modu mevcut bir kimliğin
  üzerine yazmayı reddeder.
- `DELETE /api/routing-profiles?id=<id>`, tek bir profili kaldırır.
- `POST /api/routing-profiles/dry-run`, yukarı akışa göndermeden kaydedilmiş bir
  profili değerlendirir.

Örnek kaydetme yükü:

```json
{
  "id": "fast",
  "mode": "create",
  "profile": {
    "alias": "ocx/fast",
    "candidates": [
      { "provider": "anthropic", "model": "claude-sonnet-5" },
      { "provider": "openai", "model": "gpt-5.6" }
    ],
    "require": { "tools": true, "minContextWindow": 128000 },
    "optimize": { "latency": 0.55, "health": 0.25, "cost": 0.1, "quota": 0.1 },
    "limits": { "maxEstimatedCostUsd": 0.5, "onUnknownCost": "allow" },
    "unknownEvidence": {
      "capability": "exclude",
      "health": "penalize",
      "quota": "penalize",
      "cost": "penalize"
    }
  }
}
```


