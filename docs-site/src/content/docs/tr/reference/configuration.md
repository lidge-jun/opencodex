---
title: Yapılandırma Referansı
description: opencodex'in yapılandırmayı nerede sakladığı, düzenlemelerin nasıl uygulandığı ve her yapılandırma alanına bağlantılar.
---

opencodex kalıcı yapılandırmasını `$OPENCODEX_HOME/config.json` içinde saklar,
normalde `~/.opencodex/config.json` konumundadır. Windows'ta varsayılan
`%USERPROFILE%\.opencodex\config.json`'dır.

## Yapılandırmayı düzenleme yolları

Göreve uygun düzenleme kanalını seçin:

- **Kontrol Paneli:** rehberli sağlayıcı, model, ajan, erişim ve depolama
  ayarları için web kullanıcı arayüzünü kullanın.
- **CLI:** `ocx init` başlangıç dosyasını oluştururken `ocx provider`, `ocx
  models`, `ocx combo`, `ocx agent` ve `ocx config` gibi komutlar sahip
  oldukları ayarları günceller veya inceler.
- **Dosya:** özel bir kullanıcı arayüzü veya CLI komutu olmayan alanlar için
  `config.json` dosyasını doğrudan düzenleyin. Dosya geçerli JSON olarak
  kalmalıdır.

Kontrol paneli, yönetim API'si ve değiştiren CLI komutlarının tümü aynı dosyaya
kalıcı hale gelir. Bu kanalları tercih edin veya elle düzenlemeden önce proxy'yi
durdurun. Çalışan bir süreç yapılandırmayı bellekte tutar, bu nedenle daha
sonraki canlı bir kaydetme, ilişkisiz el düzenlemelerini anlık görüntüsünden
yeniden yazabilir. Canlı kaydetmeler, bu yolların açık çakışma korumasına sahip
olduğu harici olarak düzenlenmiş `claudeCode` ve dinleyici bağlama alanlarını
birleştirir, ancak bu koruma her alt ağacı kapsamaz.

Dosya ayrıştırılamazsa opencodex dosyayı `config.json.invalid-<zaman-damgasi>`
olarak yedekler, konsolda uyarır ve varsayılanlarla başlar. Eksik bir dosya da
yeni yükleme varsayılanını kullanır: bir `openai` iletme sağlayıcısı.

## Öncelik ve varsayılanlar

`config.json` içindeki geçerli değerler yerleşik varsayılanları geçersiz kılar.
Eksik isteğe bağlı alanlar, alan sayfalarında belgelenen varsayılanları
kullanır. `OPENCODEX_HOME` varsayılan yapılandırma dizinine göre önceliklidir.
`apiKey: "${PROVIDER_API_KEY}"` gibi bir ortam referansını kabul eden alanlar bu
değişkeni istek zamanında çözer. Giden proxy oluşturma için önceden ayarlanmış
bir `HTTP_PROXY` veya `HTTPS_PROXY`, üst düzey `proxy` alanına göre
önceliklidir.

Yönlendirmenin kendi sıralı çözümleme kuralları vardır; bkz.
[Yönlendirme](/tr/reference/configuration/routing/).

## Yapılandırma alanları

- [Sağlayıcılar](/tr/reference/configuration/providers/) — sağlayıcı girdileri,
  kimlik doğrulama, uç noktalar, kataloglar, izin listeleri, bağlam sınırları,
  kotalar ve sağlayıcıya özgü seçenekler.
- [Yönlendirme](/tr/reference/configuration/routing/) — `defaultProvider`, model
  çözümleme sırası, kombolar, takma adlar ve kombo çaba varsayılanları.
- [Ajanlar](/tr/reference/configuration/agents/) — çoklu ajan modu,
  yetkilendirme rehberliği, geri dönüş modelleri, yerel varsayılan
  senkronizasyonu ve çaba sınırları.
- [Sunucu ve çalışma zamanı](/tr/reference/configuration/server/) — dinleyici ve
  uzaktan erişim, kabul anahtarları, zaman aşımları, depolama, sidecar'lar,
  başlangıç davranışı ve gölge çağrılar.

## Sırları dosyanın dışında tutun

API anahtarları için `${ENV_VAR}` referanslarını tercih edin. Değişmez `apiKey`,
`apiKeyPool[].key` ve `apiKeys[].key` değerleri sırdır; bunları kaydetmeyin,
günlüklere yapıştırmayın veya paylaşmayın. OAuth ve iletme sağlayıcı
belirteçleri `config.json` yerine ayrı kimlik bilgisi depolarında saklanır.
Hesap kimlikleri ve e-postaları da gizli kalmalıdır; desteklendiğinde genel
seçici takma adlarını kullanın.

:::note[Atomik yazmalar]
opencodex, yönetilen `config.toml` ve `opencodex-catalog.json` dosyalarını
geçici bir dosya ve ardından yeniden adlandırma (`atomicWriteFile`) yoluyla
yazar. Bu, `ocx stop` ve proxy kapatma işleyicisi gibi eşzamanlı yazıcılar
Codex'i aynı anda geri yüklediğinde kısmi dosyaları önler.
:::


