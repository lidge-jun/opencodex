---
title: Yönetim API'si
description: opencodex kontrol düzlemi için kimlik doğrulama, hatalar ve uç nokta referansı.
---

Yönetim API'si, opencodex'in kontrol düzlemidir. `http://localhost:10100`
adresindeki kontrol paneli onun bir istemcisidir; başsız `ocx` sağlayıcı, model,
kombo, hesap, ayarlar, tanılama ve yaşam döngüsü komutları da istemcilerdir. API
yalnızca proxy çalışırken kullanılabilir.

Etkileşimli bir istemci için [Web Kontrol Panelini](/tr/guides/web-dashboard/)
veya otomasyon oluştururken bu referansı kullanın. Kalıcı değerler nihai olarak
[Yapılandırma](/tr/reference/configuration/) bölümünü takip eder.

## Kimlik doğrulama modeli

Yönetim API'sinin, veri düzlemi API anahtarlarından bağımsız kendi yönetici
kimlik bilgisi vardır. Başlangıçta opencodex bunu şu sırayla çözer:

1. Ayarlandığında `OPENCODEX_ADMIN_AUTH_TOKEN`.
2. Güçlendirilmiş bir gizli dosyada oluşturulan bir `ocx_admin_*` belirteci.

Dosya destekli belirteç, yalnızca dizini ve dosya izinleri veya ACL'leri
güçlendirildikten sonra kabul edilir. Bu garanti edilemezse, yönetim kimlik
doğrulaması kapalı olarak başarısız olur ve bir ortam belirteci sağlanana veya
dosya durumu onarılana kadar API 503 döndürür.

Yönetici belirtecini şu iki biçimden biriyle gönderin:

```http
X-OpenCodex-API-Key: <yonetici-belirteci>
```

```http
Authorization: Bearer <yonetici-belirteci>
```

:::caution
Yönetici belirteci her veri düzlemi kimlik bilgisinden farklı olmalıdır.
Başlangıç, bir proxy kabul anahtarıyla çakışan bir yönetim kimlik bilgisini
reddeder. Yönetici belirtecini Codex, Claude Code veya başka bir model
istemcisine koymayın; kontrol düzlemi değişikliklerini yetkilendirir.
:::

### Geri döngü kontrol paneli oturumları

Bir geri döngü bağlantısında, kontrol paneli önyüklemesi kısa ömürlü bir
`ocx_session_*` kimlik bilgisi alabilir. Her oturum beş dakika sürer ve tam
kontrol paneli kaynağına bağlanır. Güvenli istekler bu kaynakla eşleşmelidir.
Güvenli olmayan yöntemler ayrıca tarayıcı `Origin`'ini ve oturumun CSRF
belirtecini gerektirir.

Uzak bağlantıları da içeren veri düzlemi kimlik doğrulaması gerektiğinde oturum
verilmesi devre dışı bırakılır. Uzak bir operatör ham yönetici belirteci ile
kimlik doğrulaması yapmalıdır; geri döngü tarzı bir GUI oturumu basılmaz.

## Yaygın hatalar

Aşağıdaki tüm uç nokta satırları bu sınır hatalarını devralır. "Dikkate değer
hatalar" sütunu bu tabloyu tekrarlamak yerine rotaya özgü ek sonuçları listeler.

| Durum | Tip veya kod | Anlamı |
| --- | --- | --- |
| 401 | `opencodex admin token required` | Yönetici belirteci veya GUI oturumu eksik, geçersiz, süresi dolmuş, kaynak uyumsuz veya CSRF kanıtı eksik |
| 403 | `cross-origin request blocked` | İstek kaynağı yönetim izin listesinin dışında |
| 404 | `not_found` | Hiçbir yönetim rotası yöntem ve yol ile eşleşmedi |
| 413 | `request body too large` | Bir POST, PUT veya PATCH gövdesi 2 MiB yönetim sınırını aşıyor |
| 503 | `management API unavailable` | Yönetici kimlik bilgisi başlatma veya güçlendirme kullanılamıyor |
| 503 | `oauth_mutation_busy` | Başka bir OAuth kimlik bilgisi mutasyonu yazıcıyı tutuyor; yanıt `Retry-After: 1` içerir |
| 503 | `catalog_busy` | Katalog toplama işlemi zaten kapasitede; yanıt `Retry-After: 1` içerir |

## Uç nokta matrisi

### Ajan ve istemci ayarları

| Yöntem ve yol | Amaç | Dikkate değer hatalar |
| --- | --- | --- |
| `GET, PUT /api/v2` | Yerel çoklu ajan v2 modunu ve iş parçacığı ayarlarını okuyun veya değiştirin | 400 geçersiz ayarlar; 502 geçiş veya kalıcılık arızası |
| `GET, PUT /api/injection-model` | Enjekte edilen alt ajan modelini, çabayı, istemi ve rehberlik ayarlarını okuyun veya ayarlayın | 400 geçersiz model, çaba veya gövde |
| `GET, PUT /api/effort-caps` | Küresel ve alt ajan akıl yürütme çabası tavanlarını okuyun veya ayarlayın | 400 geçersiz merdiven değeri |
| `GET, PUT /api/subagent-models` | Alt ajanlara sunulan modelleri okuyun veya sıralayın | 400 geçersiz liste veya beşten fazla model |
| `GET, PUT /api/subagent-model-fallback` | Sıralı geri dönüş zincirini ve yoklama aralığını okuyun veya ayarlayın | 400 geçersiz liste veya yoklama aralığı |
| `GET /api/grok` | Grok yönetilen yapılandırma durumunu ve aday modelleri okuyun | 400 durum okuma hatası |
| `PUT /api/grok/selection` | Hariç tutulan Grok modellerini kalıcı hale getirin | 400 geçersiz veya aşırı büyük seçim |
| `POST /api/grok/apply` | Kalıcı hale getirilen Grok yapılandırmasını yönetilen senkronizasyon aracılığıyla uygulayın | 409 `grok_apply_busy`; 400/500 uygulama hatası |
| `GET, PUT /api/claude-desktop` | Claude Desktop yönlendirilen/yerel profilini okuyun veya kalıcı hale getirin | 400 geçersiz veya kullanılamaz atama |
| `POST /api/claude-desktop/apply` | Kaydedilen profili Claude Desktop'ın yönetilen yapılandırmasına yazın | 400/500 yazma hatası |
| `GET /api/claude-desktop/status` | Kaydedilen ve uygulanan profili ve Desktop sağlığını inceleyin | 400 durum okuma hatası |
| `GET, PUT /api/claude-code` | Claude Code ağ geçidi, kimlik doğrulama modu, model haritası, bağlam, ajan ve sidecar ayarlarını okuyun veya güncelleyin | 400 geçersiz alan veya şekil |

Model kadrosunun ve şifrelenmiş çalışan görevi davranışının arkasındaki
kavramlar için [Alt Ajan Arayüzü](/tr/guides/sub-agent-surface/) sayfasına
bakın.

### Kombolar

| Yöntem ve yol | Amaç | Dikkate değer hatalar |
| --- | --- | --- |
| `GET /api/combos` | Normalleştirilmiş komboları ve genel model kimliklerini listeleyin | Katalog çalışması `catalog_busy` döndürebilir |
| `PUT /api/combos` | Bir komboyu oluşturun, değiştirin veya yeniden adlandırın | 400 geçersiz kimlik, hedef, yapılandırma, yeniden adlandırma veya sıradan çakışma; 409 Codex hesabı ad alanı çakışması |
| `DELETE /api/combos?id=...` | Bir komboyu silin ve seçim/soğuma durumunu temizleyin | 400 eksik kimlik; 404 bilinmeyen kombo |

Hedef stratejileri, soğuma süreleri, takma adlar ve yönlendirme hataları için
[Kombolar](/tr/guides/combos/) sayfasına bakın.

### Yapılandırma, başlangıç, senkronizasyon ve güncellemeler

| Yöntem ve yol | Amaç | Dikkate değer hatalar |
| --- | --- | --- |
| `GET /api/config` | Maskelenmiş, yönetim açısından güvenli yapılandırma DTO'sunu döndürün | — |
| `PUT /api/config` | Devre dışı bırakılmış tam yapılandırma değiştirme koruması | 405; bunun yerine odaklanmış uç noktaları kullanın |
| `GET, PUT /api/settings` | Çalışma zamanı/başlangıç ayarlarını okuyun veya otomatik başlatmayı, akış modunu, uygulamaya ait bellek bütçesini ve `codexAccountPickerEnabled`'ı güncelleyin | 400 geçersiz, nesne olmayan veya boş güncelleme |
| `GET /api/startup-health` | Önbelleğe alınmış servis/dolgu başlangıç sağlığını okuyun | — |
| `POST /api/startup-action` | Servisi veya Codex dolgusunu kurun veya onarın | 400 geçersiz eylem; 500 eylem hatası |
| `GET, POST /api/windows-tray` | Windows tepsisi durumunu okuyun veya kurun/başlatın/durdurun/kaldırın | 400 desteklenmeyen platform/eylem; 500 işlem hatası |
| `GET /api/diagnostics/project-config` | Önbelleğe alınmış proje yapılandırma uyarılarını okuyun | — |
| `POST /api/sync` | Geçerli model kataloğunu Codex ile senkronize edin | 500 başarısız senkronizasyon |
| `GET /api/update/check` | `latest` veya `preview` güncelleme kanalını kontrol edin | 400 geçersiz etiket |
| `POST /api/update/run` | İsteğe bağlı olarak yeniden başlatmanın takip ettiği bir güncelleme işini başlatın | 400 geçersiz gövde; işe özgü çakışma/hata durumu |
| `GET /api/update/status` | Bir güncelleme işini kimliğe göre yoklayın | 404 bilinmeyen iş |
| `GET, PUT /api/sidecar-settings` | Web arama ve vizyon sidecar model/arka uç ayarlarını okuyun veya güncelleyin | 400 geçersiz şekil, arka uç veya sınır |
| `GET, PUT /api/shadow-call-settings` | Gölge çağrı müdahale ayarlarını okuyun veya güncelleyin | 400 geçersiz şekil veya değer |

### Günlükler, kullanım ve depolama

| Yöntem ve yol | Amaç | Dikkate değer hatalar |
| --- | --- | --- |
| `GET /api/logs` | Filtrelenmiş bellek içi istek günlüklerini sorgulayın | — |
| `GET, PUT /api/debug` | Hata ayıklama bayraklarını okuyun; yakalama kategorilerini ayarlayın, temizleyin veya sıfırlayın | 400 geçersiz veya boş güncelleme |
| `GET /api/debug/logs` | Sınırlı sağlayıcı/hata ayıklama günlüğü girdilerini okuyun | — |
| `GET /api/debug/usage-logs` | Sınırlı kullanım hata ayıklama girdilerini okuyun | — |
| `GET /api/debug/injection-logs` | Sınırlı rehberlik enjeksiyonu hata ayıklama girdilerini okuyun | — |
| `GET /api/claude/inbound-debug` | Claude gelen hata ayıklama durumunu ve girdilerini okuyun | — |
| `GET /api/usage` | Kullanımı aralığa ve istemci yüzeyine göre özetleyin; Codex yanıtları ayrıca kararlı PII olmayan günlük etiketlerine göre anahtarlanan bir `accounts` dökümü içerir | Depolama okunamıyorsa bir `error: "read_failed"` özeti döndürür |
| `GET /api/storage` | Sepete göre Codex depolama kullanımını tarayın | Tarama hatasında bir `error: "scan_failed"` yükü döndürür |
| `POST /api/storage/cleanup/preview` | Arşivlenmiş oturum temizliğini önizleyin ve bağlayıcı bir özet döndürün | 400 `invalid_json` veya `invalid_percent` |
| `POST /api/storage/cleanup` | Önizlenen arşivlenmiş kümeyi karantinaya alın veya kalıcı olarak kaldırın | 400 geçersiz girdi; 409 eski/meşgul/başvurulan durum; 500 dosya sistemi/veritabanı hatası |
| `GET /api/storage/trash` | Karantinaya alınan temizleme girdilerini listeleyin | 500 `trash_list_failed` |
| `POST /api/storage/trash/restore` | Karantinaya alınan bir girdiyi geri yükleyin | 400 geçersiz kimlik; 404 eksik çöp; 409 meşgul/hedef çakışması; 500 geri yükleme hatası |
| `GET /api/storage/trash/restore/test-stream` | Yalnızca test amaçlı geri yükleme akış kancası | Test kancaları kapalıyken 404 `not_available` |
| `GET, PUT /api/storage/cleanup-policy` | Zamanlanmış temizleme politikasını ve iş durumunu okuyun veya güncelleyin | 400 geçersiz politika |
| `POST /api/storage/cleanup-policy/run` | Manuel bir temizleme politikası çalıştırması başlatın | 409 `already_running`; 500 `cleanup_failed` |
| `GET /api/storage/cleanup-policy/test-stream` | Yalnızca test amaçlı politika akış kancası | Kullanılamadığında 404 `not_found` |

`GET /api/usage?range=30d&surface=codex` için `accounts`, gözlemlenen her Codex
havuz etiketi için bir satır içerir. Her satır `accountLogLabel`, belirteç
toplamları, `usageCoverageRatio` ve geçerli olarak yapılandırılmış görüntüleme
fiyatlandırmasına dayalı isteğe bağlı bir `estimatedCostUsd` bildirir. Aktif
kullanıcı `modelCosts` katmanları paketlenmiş doğrulanmış katalog ve fiyat geri
dönüşlerine göre önceliklidir ve geçmiş kullanım özet okunduğunda aktif olan
fiyatlandırmadan yeniden tahmin edilir. Bu bir API eşdeğeri tahmindir, bir
abonelik ücreti değildir. Yeni ana havuz istekleri ayrılmış `main` etiketini
kullanır; eski yalın `openai` satırları geçerli yapılandırmadan yeniden atanmak
yerine belirsiz bir sepette kalır.

:::caution
Depolama temizleme uç noktaları arşivlenmiş oturum verilerini taşıyabilir veya
kalıcı olarak kaldırabilir. Her zaman önce önizleyin ve döndürülen özeti
gönderin. Kurtarma gerekebileceğinde karantinayı tercih edin.
:::

### Modeller ve katalog

| Yöntem ve yol | Amaç | Dikkate değer hatalar |
| --- | --- | --- |
| `GET /api/catalog` | Kurulu Codex katalog belgesini döndürün | 404 katalog bulunamadı |
| `GET /api/models` | Kontrol paneli/CLI model satırlarını döndürün | Toplama doyduğunda `catalog_busy` |
| `GET /api/client-config?client=...` | Desteklenen herhangi bir dosya entegrasyonu için salt okunur bir istemci yapılandırması oluşturun | 400 desteklenmeyen istemci; 503 katalog kullanılamıyor |
| `PUT /api/disabled-models` | Paylaşılan devre dışı model listesini değiştirin | 400 geçersiz JSON |
| `PUT /api/model-visibility` | Sağlayıcı veya model düzeyindeki görünürlüğü atomik olarak değiştirin | 400 geçersiz sağlayıcı, kapsam, hedef veya gövde |
| `GET, POST /api/custom-models` | Özel modelleri listeleyin veya bir tane ekleyin | 400 geçersiz alanlar; 404 sağlayıcı eksik; 409 yinelenen model |
| `PUT, DELETE /api/custom-models/{id}` | Bir özel modeli düzenleyin veya silin | 400 geçersiz kimlik/alanlar; 404 bulunamadı; 409 yinelenen model |
| `GET, PUT /api/selected-models` | Sağlayıcı izin listelerini ve kullanılabilirliğini okuyun veya bir izin listesini değiştirin | 400 eksik sağlayıcı/gövde; 404 bilinmeyen sağlayıcı |

### OAuth hesapları, sağlayıcı anahtarları ve veri düzlemi anahtarları

| Yöntem ve yol | Amaç | Dikkate değer hatalar |
| --- | --- | --- |
| `GET /api/oauth/providers` | Genel OAuth giriş akışlarına sahip sağlayıcıları listeleyin | — |
| `GET /api/key-providers` | API anahtarı girişi aracılığıyla yapılandırılan sağlayıcıları listeleyin | — |
| `POST /api/oauth/login` | Bir OAuth girişi veya hesap ekleme akışı başlatın | 400 bilinmeyen/geçersiz sağlayıcı; `oauth_mutation_busy` |
| `POST /api/oauth/login/code` | Manuel bir geri arama URL'si veya yetkilendirme kodu gönderin | 400 geçersiz sağlayıcı/kod; `oauth_mutation_busy` |
| `POST /api/oauth/login/cancel` | Devam eden bir genel OAuth akışını iptal edin | 400 bilinmeyen sağlayıcı |
| `GET /api/oauth/status` | Bir sağlayıcının OAuth akışını yoklayın | 400 bilinmeyen sağlayıcı |
| `POST /api/oauth/logout` | Seçilen sağlayıcı kimlik bilgisini kaldırın | 400 bilinmeyen sağlayıcı; `oauth_mutation_busy` |
| `GET, DELETE /api/oauth/accounts` | Maskelenmiş hesapları listeleyin veya bir hesabı kaldırın | 400 geçersiz sağlayıcı/kimlik; 404 hesap eksik; `oauth_mutation_busy` |
| `PUT /api/oauth/accounts/active` | Aktif OAuth hesabını seçin | 400 geçersiz sağlayıcı/hesap; `oauth_mutation_busy` |
| `GET, PUT, PATCH /api/oauth/accounts/pool` | Anthropic OAuth havuz politikasını okuyun veya güncelleyin | 400 Anthropic olmayan sağlayıcı veya geçersiz politika |
| `POST /api/oauth/accounts/clear-cooldown` | Bir OAuth hesabının çalışma zamanı soğuma süresini temizleyin | 400 geçersiz sağlayıcı/hesap |
| `PUT /api/oauth/accounts/alias` | Bir OAuth hesap takma adını ayarlayın veya temizleyin | 400 geçersiz sağlayıcı/hesap/takma ad |
| `GET, POST, DELETE /api/providers/keys` | Maskelenmiş sağlayıcı anahtarlarını listeleyin, bir tane ekleyin/etkinleştirin veya kaldırın | 400 geçersiz girdi; 404 sağlayıcı/anahtar eksik |
| `PUT /api/providers/keys/active` | Bir sağlayıcının etkin anahtarını seçin | 400 geçersiz girdi; 404 sağlayıcı/anahtar eksik |
| `PUT /api/providers/keys/alias` | Bir sağlayıcı anahtarı takma adını ayarlayın veya temizleyin | 400 geçersiz girdi; 404 sağlayıcı/anahtar eksik |
| `GET, POST, PATCH, DELETE /api/keys` | Veri düzlemi kabul anahtarlarını listeleyin, oluşturun, düzenleyin veya silin | 400 geçersiz gövde/kimlik; 404 anahtar eksik |

Kimlik bilgisi listesi yanıtları kasıtlı olarak maskelenir. OAuth erişim
belirteçleri ve eksiksiz sağlayıcı API anahtarları kontrol paneli istemcilerine
döndürülmez.

### Sağlayıcılar

| Yöntem ve yol | Amaç | Dikkate değer hatalar |
| --- | --- | --- |
| `GET /api/providers` | Maskelenmiş sağlayıcı yapılandırmasını ve keşif durumunu listeleyin | — |
| `POST /api/providers` | Doğrulanmış bir sağlayıcı ekleyin veya değiştirin ve isteğe bağlı olarak onu varsayılan yapın | 400 geçersiz/tehlikeli hedef veya yapılandırma; 409 ad alanı çakışması |
| `PATCH /api/providers?name=...` | İzin verilen sağlayıcı alanlarını (birleştirilmiş bir `headers` bloğu dahil), etkin/varsayılan durumunu veya OpenAI hesap modunu güncelleyin | 400 geçersiz alan veya geçiş; 404 bilinmeyen sağlayıcı |
| `DELETE /api/providers?name=...` | Mümkün olduğunda varsayılanı yeniden atayarak bir sağlayıcıyı silin | 404 bilinmeyen sağlayıcı; 409 `last_provider`; 409 `provider_has_dependent_combos` |
| `POST /api/providers/test?name=...` | Sınırlı bir canlı sağlayıcı bağlantı/model keşif probu gerçekleştirin | 404 bilinmeyen sağlayıcı; arızalar normalde `ok: false` kanıtı olarak döndürülür |
| `GET /api/provider-quotas` | Sağlayıcı kota raporlarını okuyun; `refresh=1` yenilemeye zorlar | — |
| `GET, PUT /api/provider-context-caps` | Küresel, tüm sağlayıcılar veya tek sağlayıcı bağlam sınırlarını okuyun veya güncelleyin | 400 geçersiz istek; 404 bilinmeyen sağlayıcı |
| `GET /api/provider-presets` | Çalışma zamanı kayıt defterinden türetilen GUI sağlayıcı önayarlarını döndürün | — |

`provider_has_dependent_combos` bir güvenlik engelidir: sağlayıcılarını silmeden
önce bağımlı komboları kaldırın veya düzenleyin.

### Kenar çubuğu ve rızaya bağlı eylemler

| Yöntem ve yol | Amaç | Dikkate değer hatalar |
| --- | --- | --- |
| `GET /api/github/star` | Kullanıcının `gh` oturumu aracılığıyla depo yıldız durumunu okuyun | Duruma özgü sabit sonuç kodları |
| `POST /api/github/star` | Depoyu yalnızca kimliği doğrulanmış bir insan eyleminden yıldızlayın | Kontrol paneli oturumu kanıtı olmayan ajan odaklı arayanlar için 403 `agent_consent_required` |
| `GET /api/update/badge` | Ucuz kenar çubuğu güncelleme rozeti durumunu okuyun | — |

:::caution
Yönetim kimlik doğrulaması proxy'ye erişimi kanıtlar; kullanıcının kimliğini
harcama rızasını kanıtlamaz. Bir ajan `agent_consent_required` etrafından
dolaşmamalıdır. Depoya yıldız verip vermeyeceğini kullanıcı seçmelidir.
:::

### Sistem yaşam döngüsü

| Yöntem ve yol | Amaç | Dikkate değer hatalar |
| --- | --- | --- |
| `GET /api/system/memory` | Skaler süreç, yığın (heap), akış, yanıt durumu, denetleyici ve aktif tur metriklerini döndürün | — |
| `POST /api/system/restart` | İstemci enjeksiyonunu kaldırmadan boşaltma duyarlı bir süreç yeniden başlatması başlatın | 202 döndürür; tekrarlanan çağrılar mevcut boşaltmayı bildirir |
| `POST /api/stop` | Servisi durdurun, yerel Codex'i geri yükleyin, yönetilen Grok enjeksiyonunu kaldırın ve proxy'yi boşaltın | 409 servis sahipliği çakışması |

### Codex kimlik doğrulama yetkilendirmesi

`GET /api/settings`, geçerli `codexAccountPickerEnabled` boolean değerini
bildirir. Bu katı boolean'ı içeren bir `PUT`, boş bir haritayı etkinleştirirken
gizlilik açısından güvenli hesap seçicilerini başlatır, devre dışı bırakırken
veya yeniden etkinleştirirken mevcut seçici etiketlerini korur, önce kalıcı hale
getirir ve ardından yalnızca geçerli seçici görünürlüğü değiştiğinde sınırlı bir
katalog yakınsaması talep eder. Başarılı yanıt `catalogRefreshPending` içerir:
`false`, katalog işleminin tamamlandığı (veya yenilemeye gerek olmadığı)
anlamına gelir; `true`, ayarın kaydedildiği ancak katalog yenilemesini yeniden
denemek için `POST /api/sync` kullanılması gerektiği anlamına gelir. Kalıcılık
veya seçici tahsis arızası bellek içi ayarları geri alır ve yakınsamayı
çalıştırmaz.

Kök yönetim dağıtıcısı her `/api/codex-auth/*` isteğini Codex hesap yöneticisine
devreder. Rotaları şunlardır:

| Yöntem ve yol | Amaç | Dikkate değer hatalar |
| --- | --- | --- |
| `GET, POST, DELETE /api/codex-auth/accounts` | Codex hesaplarını listeleyin/yenileyin veya silin. POST devre dışı bırakılmış bir uyumluluk uç noktası olarak tutulur; başarılı DELETE yanıtları `catalogRefreshPending` içerir. | POST her zaman 403 `manual_import_disabled` döndürür; 400 geçersiz DELETE girdisi |
| `PUT /api/codex-auth/accounts/alias` | Bir hesap takma adını ayarlayın veya temizleyin | 400 geçersiz hesap/takma ad |
| `PUT /api/codex-auth/accounts/pause` | Bir hesabı duraklatın veya devam ettirin | 400 geçersiz hesap/durum; 404 eksik hesap |
| `PUT /api/codex-auth/accounts/pause-exhausted` | Kotası tükenen hesapları duraklatın | Mutasyon kilidi arızaları 503 olur |
| `POST /api/codex-auth/accounts/clear-cooldown` | Bir hesap veya tüm hesaplar için çalışma zamanı soğuma süresini temizleyin | 400 geçersiz kimlik |
| `GET, PUT /api/codex-auth/active` | Aktif hesabı okuyun veya seçin | 400 geçersiz veya eksik hesap; 409 duraklatılmış/eski satır çakışması |
| `PUT /api/codex-auth/auto-switch` | Otomatik hesap geçişi için kota eşiğini ayarlayın | 400 geçersiz eşik |
| `PUT, PATCH /api/codex-auth/pool-strategy` | Codex hesap havuzu seçim stratejisini güncelleyin | 400 geçersiz strateji/yapılandırma |
| `PUT /api/codex-auth/failover` | Hesap yük devretme eşiğini ayarlayın | 400 geçersiz eşik |
| `GET /api/codex-auth/quota` | Hesaba göre önbelleğe alınmış kota durumunu okuyun | — |
| `GET /api/codex-auth/reset-credits` | Bir hesap için sıfırlama kredisi uygunluğunu inceleyin | 400 eksik hesap kimliği; yukarı akış durum doğrudan geçişi; 500 arama hatası |
| `POST /api/codex-auth/reset-credits/consume` | Uygun bir sıfırlama kredisini tüketin | 400 eksik hesap kimliği; yukarı akış durum doğrudan geçişi; 503 `server_busy`; 500 tüketme hatası |
| `POST /api/codex-auth/login` | Codex girişini veya yeniden kimlik doğrulamasını başlatın | 400 geçersiz istek; çakışma/meşgul giriş durumları |
| `POST /api/codex-auth/login/code` | Bir Codex giriş akışı için manuel bir kod gönderin | 400 geçersiz akış/kod |
| `POST /api/codex-auth/login/cancel` | Bir Codex giriş akışını iptal edin | — |
| `GET /api/codex-auth/login-status` | Bir akışı veya hesap giriş durumunu yoklayın. Tamamlanan yeni hesap akışı yalnızca kurtarma gerektiğinde `catalogRefreshPending: true` içerir. | Bilinmeyen akışlar `expired` bildirir; aktif olmayan akış `idle` bildirir |

Yeni bir hesap yapılandırma satırı kaydedilirse ancak kimlik bilgisi kurulumu
tamamlanamazsa, OAuth `login-status`, `code:
"codex_credential_persistence_failed"`, `accountId`, `needsReauth: true` ve
isteğe bağlı `catalogRefreshPending: true` ile `status: "error"` bildirir;
depolama hatası ayrıntıları açığa çıkarılmaz. Hesap satırı kaydedilmiş olarak
kalır: hesap oluşturmayı yeniden denemeden önce yeniden kimlik doğrulaması yapın
veya silin.

Bu yetkilendirilmiş aile altındaki yapılandırma yazıcısı veya kimlik bilgisi
yenileme kilidi zaman aşımları `CONFIG_MUTATION_LOCK_UNAVAILABLE` koduyla HTTP
503 döndürür. İstemciler bu yanıtı kalıcı bir hesap hatası olarak değerlendirmek
yerine kısa süre sonra yeniden denemelidir.

Hesap oluşturma ve silme, katalog yakınsamasından önce kimlik
bilgilerini/yapılandırmayı işler. Başarısız veya ertelenmiş bir katalog denemesi
kalıcı hesap mutasyonunu asla geri almaz ve dahili sağlayıcı, hesap, yol veya
kimlik bilgisi ayrıntılarını asla yansıtmaz; istemciler yalnızca tamamlama
boolean'ını alır. Bir hesabı silmek seçici bağlamasını korur, böylece hesap
yokken tam rotalar kapalı olarak başarısız olur ve bu hesap kimliği tekrar
eklenirse aynı seçici geri yüklenir.

## Bir istemci seçme

Sıradan yönetim için [Web Kontrol Paneli](/tr/guides/web-dashboard/) en güvenli
rehberli iş akışını sağlar. Başsız ana bilgisayarlar ve otomasyon için ilgili
`ocx` komutlarını kullanın: aynı canlı API'yi çağırırlar ve proxy erişilemez
olduğunda veya işlem başarısız olduğunda sıfır olmayan bir sonuç döndürürler.
Doğrudan HTTP, yukarıdaki tam uç nokta sözleşmelerine ihtiyaç duyan
entegrasyonlar için en yararlıdır.


