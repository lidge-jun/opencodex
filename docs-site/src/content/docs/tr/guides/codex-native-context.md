---
title: Yerel bağlam uyumluluğu
description: Codex geçmiş ve not aktarmasının uygunluk koşulları, kimlik doğrulamalı deneme yapılandırması ve sınırları.
---

OpenCodex, yerel Codex geçmişini ve notlarını zaten aktarır. Bu, yönlendirilen sağlayıcılar için genel bir bellek hizmeti değildir; HTTP uç noktalarının sunulması da belirli bir Codex derlemesinin, hesabın veya modelin bunları kullanabildiğini kanıtlamaz. Aktarmanın sahiplik, iptal ve kimlik bilgisi sınırları için [Codex entegrasyonuna](/tr/guides/codex-integration/) bakın.

## Birbirinden bağımsız iki gereksinim

Codex uzantıyı etkinleştirmeli, OpenCodex ise arayanı tanımlamalıdır. Arka uç URL'sini değiştirmek tek başına iki gereksinimi de karşılamaz.

İncelenen yukarı akış Codex sözleşmesi; yerel katalog kaydında `supports_experimental_context` bildiren bir model, uygun bir ChatGPT oturumu ve adı tam olarak `OpenAI` olan, temel URL'si `/backend-api/codex` ile biten bir sağlayıcı gerektirir. Otomatik etkinleştirme, `env_key`, `experimental_bearer_token`, komut destekli `auth` veya AWS kimlik doğrulaması kullanan sağlayıcıları reddeder. İncelenen uygunluk koşulu ChatGPT Plus, Pro ve ProLite planlarını kabul eder; bu, o planlardaki her hesapta arka uç geçmiş uç noktalarının çalıştığı anlamına gelmez.

OpenCodex ayrıca hem başarılı model isteğinde hem de sonraki bağlam isteklerinde etkin bir **veri düzlemi API anahtarı** gerektirir. Varsayılan yerleşik geri döngü enjeksiyonu bu anahtarı göndermez; bu nedenle modeller çalışırken bağlam çağrıları `context_principal_required` (403) ile başarısız olabilir. Kimlik doğrulamalı uzak sağlayıcı tablosu biçimi de tek başına yerel bağlam çözümü değildir: `env_key` ve sağlayıcı adı yukarıdaki Codex etkinleştirme sözleşmesini karşılamaz. İki sorunu gizlemek için asıl taraf veya hesap sahipliği denetimlerini asla kaldırmayın.

## Açık etkinleştirme söz dizimi

OpenCodex, Codex'in `FeatureToml` tarafından kabul edilen iki kalıcı kök özellik biçimini de kabul eder:

```toml
[features]
context_management = true
```

Eşdeğer tablo biçimi de çalışır ve boole biçimini henüz tanımayan eski OpenCodex sürümleriyle uyumludur:

```toml
[features.context_management]
experimental_mode = true
```

İki biçimden yalnızca birini kullanın. Yanlış, eksik ve hatalı biçimlendirilmiş değerler özelliği kapalı tutar. Proxy kendi Codex ev yapılandırmasını okur; yalnızca CLI'da geçerli bir geçersiz kılma veya yalnızca bir Codex profili içindeki etkinleştirme, çalışma zamanı kapısını açmaz. Bu değişiklik model meta verilerinden etkinleştirme çıkarımı yapmaz.

## Kimlik doğrulamalı yerel deneme profili

Bu, **kaynak koduyla denetlenmiş bir deneme yapılandırmasıdır; gerçek hesapla uçtan uca doğrulama değildir**. Denemeden önce Codex yapılandırmasını yedekleyin ve kalıcı bir görev kontrol noktası tutun. Yeni, atılabilir bir iş parçacığı kullanın; çalışan mevcut bir iş parçacığının sağlayıcı kimliğini değiştirmeyin.

Codex sürecinin ortamındaki `OCX_CONTEXT_API_KEY` değişkenine mevcut etkin bir OpenCodex veri düzlemi anahtarı verin. Yönetim/yönetici belirteci kullanmayın veya anahtarı TOML içinde saklamayın. Ayrı başlatılan masaüstü uygulaması, bir servisin ortamını otomatik olarak devralmaz. Normal yerel Codex ChatGPT oturumunu kullanılabilir tutun; ek başlık OAuth'un yerini almaz.

Yukarıdaki kök özellik etkinleştirmesi, OpenCodex'te yapılandırılmış kanonik ChatGPT iletme sağlayıcısı ve güncel yerel model kataloğuyla birlikte bu **ek** sağlayıcıyı ve profili aynı Codex yapılandırmasına ekleyin. Portu gerçek yerel proxy'ye uyarlayın. Kök `model_provider` değerini ve mevcut sağlayıcı tablolarını değiştirmeyin.

```toml
[model_providers.ocx-native-context]
name = "OpenAI"
base_url = "http://127.0.0.1:10100/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
env_http_headers = { "x-opencodex-api-key" = "OCX_CONTEXT_API_KEY" }

[profiles.ocx-native-context]
model_provider = "ocx-native-context"
model = "gpt-6-astra"
```

`codex --profile ocx-native-context` ile yeni bir CLI iş parçacığı başlatın. Örnek, ilk denemeyi modelden aktarmaya sahiplik yolunda tutmak için HTTP/SSE kullanır; diğer profillerin aktarımını değiştirmez veya WebSocket/tur ortasında yönlendirme eşitliğini doğrulamaz. Modeli yalnızca hesabın yerel kataloğu bağlam yeteneğini gerçekten bildiriyorsa kullanın; bu bayrağı Devin, Gemini veya başka bir yönlendirilen satıra zorla eklemeyin.

Özel sağlayıcı kimliği bilinçli bir seçimdir. Yukarı akış Codex, yerleşik sağlayıcıları `model_providers.openai` üzerinden genellikle geçersiz kılmaz; oraya eklenen başlık sessizce etkisiz kalabilir. Özel kimlik normal sağlayıcıyı korurken tam `OpenAI` adı yerel arka uç koşulunu karşılar. Bu profile `env_key` eklemeyin: `env_http_headers` yerel kabul bilgisini ayrı taşırken `Authorization` yerel ChatGPT oturumunu taşımayı sürdürür. OpenCodex yerel anahtarı tüketir; ChatGPT'ye iletmez.

Kök etkinleştirme diğer uygun yerel profilleri de etkiler. **Bu deneme sırasında ek anahtarı taşımayan sıradan yerleşik geri döngü iş parçacıklarını sürdürmeyin.** Bu iş parçacıklarına dönmeden önce kök özelliği kapatıp `ocx sync` çalıştırın. Bu, otomatik veya varsayılan bir entegrasyon değişikliği değildir; CLI profili de masaüstünde profil seçiminin desteklendiğine dair bir iddia değildir.

## Bağlamı sıfırlamadan önce doğrulayın

Önce yeni iş parçacığında başarılı bir yerel model yanıtı alın. Ardından bir not yazıldığını doğrulayın, aynı notu geri okuyun ve o iş parçacığının geçmişini sorgulayın. Ancak bu işlemler başarılı olduktan sonra atılabilir bir testte `new_context` kullanıp kayıtlı durumun kurtarılabildiğini kontrol edin. Deneme başarılı olsa bile harici kontrol noktasını koruyun.

- **403 `context_principal_required`:** geçerli bir yerel veri düzlemi anahtarı proxy'ye ulaşmadı.
- **409 `context_account_unavailable`:** sahiplik yok veya tutarsız; o anda etkin hesabı onun yerine koymayın ya da yazmayı körlemesine yinelemeyin.
- **404:** proxy'nin devre dışı/bilinmeyen uç nokta yanıtını yukarı akış 404 yanıtından ayırın. İkincisi, OpenCodex yönlendirme hatasının veya hesap genelinde kesintinin kanıtı değildir.

Başarılı model çağrısı veya `ocx ready`, notların, geçmişin ya da durum geri yüklemenin çalıştığını kanıtlamaz. Model yönlendirme, hesap değişiklikleri, proxy yeniden başlatmaları ve yukarı akış uç noktası kullanılabilirliği ayrı konulardır. Hiçbir yerel bayrak eksik arka uç uygunluğunu veremez; başarısız bağlam işlemi başarılı bir sıfırlama olarak bildirilmemelidir. İşiniz bittiğinde deneme tablolarını kaldırıp deneme anahtarını ortamdan çıkarın; doğrulanmış kimlik doğrulamalı bir yol kullanmadığınız sürece özelliği kapalı bırakın.

## İncelenen yukarı akış sözleşmeleri

Bu bağlantılar, yukarıdaki yapılandırma için kullanılan kaynak sözleşmesini sabitler; dağıtım vaadi değildir:

- [FeatureToml boole/tablo biçimleri](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/features/src/lib.rs)
- [Yerel bağlam uygunluğu](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/session/token_budget.rs)
- [Sağlayıcı kimliği ve yerleşik birleştirme kuralları](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/model-provider-info/src/lib.rs)
- [Geçmiş/notların sağlayıcı istek başlıklarını ve kimlik doğrulamasını kullanması](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/ext/history-notes/src/backend.rs)
