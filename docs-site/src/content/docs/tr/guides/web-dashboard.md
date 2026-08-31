---
title: Web Kontrol Paneli
description: Proxy sağlığı, sağlayıcılar, modeller, yetkilendirme rehberliği, kimlik doğrulama havuzları, kullanım ve günlükler için opencodex GUI'si.
---

opencodex, proxy'den sunulan yerel bir web kontrol paneli (`gui/` altında bir
Vite/React uygulaması) ile birlikte gelir. Sağlayıcıları, Codex/ChatGPT
hesaplarını, katalog modellerini, sidecar'ları, alt ajan ayarlarını ve istek
trafiğini yönetmenin en kısa yoludur.

## Açma

```bash
ocx gui
```

Bu, gerekirse önce proxy'yi otomatik olarak başlatarak tarayıcınızda
`http://localhost:<port>` adresini açar. Geliştirme sırasında GUI geliştirme
sunucusunu çalışan bir proxy'ye karşı ayrı olarak çalıştırabilirsiniz:

```bash
ocx start
bun run dev:gui
```

## Oturum Açma

Varsayılan geri döngü bağlantısında (`localhost` / `127.0.0.1`) kontrol paneli
asla bir belirteç istemez: proxy sunulan sayfaya kısa ömürlü GUI oturumları
basar ve süreleri dolduğunda veya proxy yeniden başladığında bunları sessizce
yeniler. Yalnızca geri döngü olmayan bir ana bilgisayar adına bağlı bir kontrol
paneli yönetici belirtecini (`OPENCODEX_ADMIN_AUTH_TOKEN` veya otomatik olarak
oluşturulan `~/.opencodex/admin-api-token` dosyası) gerektirir.

Uzak bir kontrol panelinin bu kimlik bilgisine ihtiyacı olduğunda, bir tarayıcı
şifre yöneticisinin onu kaydetmeyi ve otomatik doldurmayı teklif edebilmesi için
standart bir şifre formu sunar. Kontrol panelinin kendisi belirteci yine de
yalnızca bellekte tutar ve `localStorage` veya `sessionStorage`'a yazmaz;
kaydedilip kaydedilmeyeceği tamamen tarayıcının veya şifre yöneticisinin
kararıdır.

## Neler yapabilirsiniz

| Alan | Ne yapar |
| --- | --- |
| **Kontrol paneli özeti** | Çoklu ajan modu, çevrimiçi durum, sürüm, çalışma süresi, sağlayıcı sayısı, 30 günlük token toplamı, aktif sağlayıcılar ve kullanılabilir yerel/yönlendirilen modeller. |
| **Alt ajan yetkilendirmesi** | OpenCodex yetkilendirme rehberliği ve ayrı yerel varsayılan katılımı tarafından paylaşılan yerel veya yönlendirilen bir model ve isteğe bağlı akıl yürütme çabası seçin. Bu, proxy tarafında spawn başına bir yönlendirici değildir; aşağıya bakın. |
| **Sidecar'lar** | Web arama modelini ve çabasını artı vizyon açıklama modelini seçin. Değişiklikler bir sonraki istekte geçerli olur. |
| **Bakım** | Codex model kataloğunu yeniden senkronize edin, projeye özel yapılandırma atlama uyarılarını inceleyin, en son veya önizleme sürümünü kontrol edin ve isteğe bağlı proxy yeniden başlatmasıyla bir güncelleme çalıştırın. |
| **Başlangıç güvenliği** | Ayrı servis ve başlatıcı dolgu sağlığı artı tam onarım komutlarıyla enjekte edilen Codex yönlendirmesinin yeniden başlatmada hayatta kalıp kalmadığını gösterin. |
| **Windows sistem tepsisi** | Tek tıklamayla proxy başlatma, durdurma, yeniden başlatma, kontrol paneli erişimi ve durum için kullanıcı başına bir oturum açma tepsisi yükleyin. Tepsi bir kontrolördür, bir proxy yeniden başlatma servisi değildir. |
| **Codex otomatik başlatma** | Zaten kurulu bir Codex başlatıcı dolgusunun `ocx ensure` çalıştırmasına izin verin. Bu anahtar bir dolgu veya arka plan servisi kurmaz. |
| **Sağlayıcılar** | Sağlayıcıları ekleyin, düzenleyin, varsayılanı ayarlayın (yalnızca etkin sağlayıcılar), etkinleştirin/devre dışı bırakın ve kaldırın; desteklendiğinde OAuth hesap havuzlarını ve API anahtarı havuzlarını yönetin. Geçerli varsayılanı kaldırmak, bir tane varsa kalan ilk etkin sağlayıcıya geçer; aksi takdirde silme reddedilir ve geçerli varsayılan tutulur. Sağlayıcı Ayarları, eksik, yavaş veya aşırı büyük `/models` kataloglarına sahip uç noktalar için canlı model keşfini devre dışı bırakabilir. Claude (Anthropic) OAuth havuzları için oturum açmış her hesap kendi 5 saatlik ve haftalık hız sınırı çubuklarını gösterir (kullanım kimlik bilgisi başınadır); başarısız bir araştırma bilinen son çubukları tutar ve bir sonraki başarılı yenilemeye kadar bunları kullanılamaz olarak işaretler. |
| **Sağlayıcı ekle** | Hesap girişi, API anahtarı hizmetleri, yerel sunucular veya özel bir uç nokta için kayıt defteri destekli önayarları arayın. |
| **Codex Auth** | ChatGPT/Codex havuz hesapları ekleyin, sonraki oturum hesabını seçin, 5 saatlik / haftalık / 30 günlük kotaları yenileyin, kota otomatik geçişini etkinleştirin veya devre dışı bırakın, %1–100 eşiğini ayarlayın ve geçici arıza yük devretmesini yapılandırın. |
| **Alt Ajanlar** | `spawn_agent` geçersiz kılma listesinde en fazla beş yalın yerel veya ad alanlı yönlendirilen modeli öne çıkarın. |
| **Modeller** | Yerel GPT ve yönlendirilen modelleri açıp kapatın, sağlayıcı izin listelerini ve bağlam sınırlarını ayarlayın, v1/base/v2'yi seçin ve v2 iş parçacığı sınırını yapılandırın. Yapılandırılmış sağlayıcılar, keşif kapalı olduğunda veya hiçbir satır döndürmediğinde sıfır modelli gruplar olarak görünür kalır. |
| **Günlükler** | Belirteçler, talep edilen çaba ve (varsa) etkili giden çaba, çözümlenen model, sağlayıcı, durum, istek kimliği, süre ve hata ayrıntılarıyla son istekleri otomatik yenileyin. Ayrıntı görünümü, adaptör bir tane yaydığında tam akıl yürütme hat alanını içerir. Yüklenen Günlükler halkası için toplam belirteçleri ve tahmini liste fiyatı maliyetini görmek üzere donuk görüşme/oturum kimliğine göre (istemci bir tane gönderdiğinde) filtreleyin. |
| **Kullanım / Hata Ayıklama** | Belirteç kullanımı kapsamını ve eğilimlerini inceleyin veya isteğe bağlı sağlayıcı aktarımı ve kullanım çıkarma tanılamalarını etkinleştirin. |
| **Depolama** | Salt okunur CODEX_HOME disk dökümü (oturumlar, arşivler, DB'ler, ekler). İsteğe bağlı arşivlenmiş temizleme: en eski %N'yi önizleyin, ardından `CODEX_HOME/.trash` konumuna karantinaya alın (varsayılan) veya açık bir onay kutusu arkasında kalıcı olarak silin. **Otomatik temizleme politikası** isteğe bağlıdır ve **varsayılan olarak KAPALIDIR** (`storageCleanupPolicy.enabled`); Depolama sayfasında eşik/hedef/zamanlama/mod yapılandırın veya **Şimdi çalıştır (Run now)**'ı tetikleyin. Karantinaya alınan girdiler Depolama sayfasından geri yüklenebilir (JSONL + iş parçacıkları). Aktif oturumlar salt okunur kalır. Codex en yeni/aktif `state_*.sqlite` dosyasını kilitli tuttuğu sürece temizleme ve geri yükleme reddedilir. |
| **Durdur** | Proxy'yi ve kurulu arka plan servisini zarif bir şekilde durdurun, yerel Codex'i geri yükleyin ve çıkın (`POST /api/stop`). Windows'ta Görev Zamanlayıcı arka ucunda panel reddeder ve `ocx stop` çalıştırmanızı ister: görev bittikten sonra sarmalayıcı proxy'yi yeniden başlatabilir ve bu yeniden başlatma penceresini istemci yapılandırmanız geri yüklenmeden önce yalnızca proxy dışında çalışan bir stop doğrulayabilir. Reddedildiğinde hiçbir şey değiştirilmez. |

### Bir bölüme bağlantı verme

Tek bir düzen vardır, bu nedenle yapılandırılacak bir düzen anahtarı yoktur.
Bunun yerine kontrol paneli bölümleri adreslenebilirdir: `#dashboard` Genel
Bakış'ı açar, `#dashboard/providers` ve `#dashboard/models` diğer ikisini açar.
Yeniden Yükle, yer imi ve Geri işlemlerinin tümü bulunduğunuz bölümü korur.
**Günlükler** `#logs` ve `#logs/debug` ile aynı şekilde çalışır. Daha eski bir
`#providers/workspace` yer imi artık `#providers` üzerine iner.

**Günlükler** ve **Kullanım**'daki maliyet değerleri bildirilen belirteçlerden
hesaplanan API liste fiyatı eşdeğerleridir. Bunlar fatura makbuzları veya gerçek
bir ücret kanıtı değildir; bunun yerine abonelik kullanımı veya sağlayıcı
kredileri geçerli olabilir.

## Model görünürlüğü

**Modeller** anahtarları nihai Codex görünürlüğünü gösterir: yönlendirilen bir
model yalnızca sağlayıcı izin listesi onu içerdiğinde (veya hiçbir izin listesi
ayarlanmadığında) ve devre dışı bırakılmadığında açıktır. Bir modeli açmak her
iki filtreyi de atomik olarak uzlaştırır; **Tümünü aç (All on)** sağlayıcı izin
listesini temizler, böylece yeni keşfedilen modeller de açık olur.

## Yetkilendirme seçicisi ve spawn yönlendirmesi

Kontrol Panelinin **Alt ajan yetkilendirmesi** seçicisi `injectionModel`'i ve
isteğe bağlı olarak `injectionEffort`'ı saklar. **OpenCodex çoklu ajan
rehberliği**, bu değerleri kullanan yetkilendirme talimatlarını bağımsız olarak
denetler. Uygun v2 turlarında bu rehberlik ana ajana `spawn_agent`'a hangi tam
modeli ve akıl yürütme çabasını ileteceğini söyler; modeli temizlemek saklanan
çabayı da temizler.

Varsayılan olarak kapalı olan **Yerel Codex alt ajan varsayılanları olarak
kullan (Use as native Codex subagent defaults)** anahtarı, OpenCodex aktif Codex
yönlendirmesini yönettiğinde bir sonraki senkronizasyonda/yeniden başlatmada
aynı seçimi Codex'in yerel `[agents]` varsayılanlarına uygular. Harici kullanıcı
tarafından yönetilen sağlayıcı yapılandırmaları dokunulmadan kalır. Bu
varsayılanlar yeni oluşturulan Codex görevlerini etkiler ve kendileri
yetkilendirmeye neden olmaz. Kullanıcıya ait mevcut `[agents]` varsayılanları
üzerine yazılmak yerine korunur, bu nedenle talep edilen varsayılanları geçersiz
kılmaya devam edebilirler.

:::caution
Hiçbir kontrol proxy tarafında modeller arası bir spawn yönlendiricisi değildir.
OpenCodex rehberliği Codex'ten `spawn_agent`'a geçersiz kılmalar iletmesini
ister; yerel `[agents]` varsayılanları yalnızca Codex senkronize edildikten
sonra yeni bir görev oluşturduğunda geçerlidir. Kurallı v1/base/v2 davranışı
için [Alt Ajan Arayüzü](/tr/guides/sub-agent-surface/) sayfasına bakın.
:::

Spawn geçersiz kılma garantisi **yerleşik** v2 rehberlik metni için geçerlidir.
Özel bir `injectionPrompt` bu metnin yerini tamamen alır ve `{{model}}` ve
`{{effort}}` yer tutucularını (ve isteğe bağlı olarak `{{roster}}`) içermelidir,
aksi takdirde bu değerler enjekte edilen rehberlikte görünmez.

Seçici, etkinleştirilmiş yerel ve yönlendirilen modellerin yanı sıra küresel
Codex çaba merdivenini sunar. API seçilen çabayı küresel olarak doğrular; Codex
yine de hedef katalog girdisine karşı bir spawn çabasını doğrular.

## Codex Auth ve hesap havuzları

**Codex Auth** sayfası yerel ChatGPT/Codex rotasını yönetir:

Pool modu ana ve eklenen Codex hesapları arasında seçim yapar; Direct yalnızca
arayan/ana girişi kullanır. Devam eden istekler yakalanan kimlik bilgilerini
korur ve bir 401/403 yeniden kimlik doğrulaması veya 429 soğuma süresi bağlılığı
temizleyebilir ve başka bir uygun Pool hesabına dönebilir. Bu, `openai-apikey`
ve diğer sağlayıcılardan ayrıdır.

- Manuel olarak bir hesap seçmek hemen uygulanır: zaten bağlı olan bir iş
  parçacığı bir sonraki isteğinde ona geçer ve yalnızca devam eden istekler
  yakaladıkları hesabı tutar. Manuel bir seçim de sabitlenir: kart bir
  **PINNED** rozeti gösterir ve boşaltılana, başka bir hesap seçene kadar veya
  herhangi bir hesabın seçim sırasını değiştirene kadar daha yüksek bir seçim
  sırası bu hesabı öncelikleyemez.
- Her hesap kartı bir **Seçim sırası (Selection order)** kontrolü taşır (İlk,
  Daha Önce, Normal, Daha Sonra, Son). Daha yüksek sıra önce kullanılır ve havuz
  ancak üzerindeki her hesap boşaldığında veya kullanılamaz olduğunda daha düşük
  bir sıraya düşer. Değişen bir sıra bir sonraki bağımsız istekten itibaren
  geçerlidir ve zaten bağlı olan bir iş parçacığını asla taşımaz. Codex Desktop
  (ana) hesabı diğerleri gibi sıralanır, böylece **Son** olarak ayarlanabilir ve
  yedek olarak tutulabilir. Bu beş önayarın dışındaki `ocx account priority`'den
  ayarlanan bir sıra kartta görünür ve seçilebilir kalır.
- İş parçacığı bağlılığı istek başına dalgalanmayı önler. Kota otomatik geçişi
  etkinken uzun süredir çalışan bir iş parçacığı düzenli olarak yeniden
  değerlendirilir ve ilgili kullanımı eşiğe ulaştıktan ve kesinlikle daha düşük
  kullanımlı uygun bir hesap mevcut olduğunda yeniden bağlanabilir.
- Yeni oturumlar en düşük kullanımlı uygun hesabı seçebilir. Ücretli planlar
  bilinen en sıcak 5 saatlik, haftalık veya 30 günlük pencereyi puanlar;
  Go/Ücretsiz planlar yalnızca 30 günlük pencereyi kullanır.
- WHAM `limit_window_seconds` sağladığında Codex Auth, her birincil pencerenin
  haftalık olduğunu varsaymak yerine en az 28 günlük birincil pencereyi 30 gün
  olarak sınıflandırır. Süresi olmayan yanıtlar eski haftalık yorumu korur.
- **Kotaları yenile (Refresh quotas)**, yönlendirmenin ve hesap kartlarının aynı
  değerleri kullanması için hesap kullanımını hemen yeniden okur.
- Havuz isteği günlükleri `p3fa91c` gibi donuk etiketler kullanır, asla hesap
  e-postalarını kullanmaz.
- Her hesap kartı ayrıca bu kararlı günlük etiketini, gözlemlenen 30 günlük
  belirteç toplamını, geçerli olarak yapılandırılmış görüntüleme
  fiyatlandırmasını kullanan yaklaşık bir API eşdeğeri maliyeti ve ölçülen
  kullanıma sahip denemelerin oranını gösterir. Aktif kullanıcı `modelCosts`
  katmanları paketlenmiş doğrulanmış katalog ve fiyat geri dönüşlerine göre
  önceliklidir ve geçmiş kullanım özet okunduğunda aktif olan fiyatlandırmadan
  yeniden tahmin edilir. Maliyet mutabakat için bir tahmindir, bir ChatGPT
  Plus/Pro abonelik faturası değildir. Açık atıftan önceki geçmiş yalın `openai`
  satırları geçerli ana hesaba atanmak yerine belirsiz kalır.
- **Model seçicisinden belirli bir Codex hesabını hedefleme** açık bir
  katılımdır. Etkinleştirildiğinde sıradan desteklenen GPT seçici satırları
  genel hesap seçicisi başına bir girdiyle değiştirilir. Birini seçmek o
  görüşmeyi eşlenen hesaba kilitler: dönmez, geri dönmez veya aktif Havuz
  hesabını değiştirmez. Yerleşik Codex App girişinin kendi seçicisi vardır;
  oluşturulan haritalar normalde `main` kullanır, gerektiğinde `main-2` gibi
  çakışma güvenli bir sonek kullanır. Eklenen hesaplar kararlı, gizlilik
  açısından güvenli etiketler alır ve mevcut özel seçici etiketleri korunur.
  Mevcut görüşmeler ve kaydedilen model seçimleri yönlendirmeye devam eder.
  Ayarı kapatmak hesapları, seçicileri veya tam rotaları silmeden oluşturulan
  seçici girdilerini gizler. Düz GPT model kimlikleri yapılandırılmış Havuz veya
  Direct davranışını kullanmaya devam eder.
- Hesap ekleme, kaldırma ve seçici ayarı değişiklikleri model kataloğu
  yenilenmeden önce kaydedilir. Bu sınırlı yenileme tamamlanamazsa kontrol
  paneli sarı renkli bir kurtarma ile başarı bildirimi gösterir; yeniden denemek
  için `ocx sync` çalıştırın. Hesabın veya ayarın kendisi kaydedilmiş olarak
  kalır.

Sağlayıcılar genel bakışı, etkin hesabın ham kotası ve bir sonraki kapasite
kurtarmasının yanı sıra Havuz modu kullanımını salt görüntüleme amaçlı ağırlıklı
bir kapasite tahmini olarak ayrı ayrı özetler. Görünür alanlar, eksik kapsam
anlamı ve yönlendirme sınırı için [Sağlayıcılar genel bakış havuz
kapasitesi](/tr/guides/providers/#saglayicilar-genel-bakis-havuz-kapasitesi)
bölümüne bakın.

## Yıldız vermek ajanın değil sizin kararınızdır

Kenar çubuğunun yıldız düğmesi — ve etkileşimli bir terminalde `ocx start`'ın
sorduğu tek seferlik soru — **kendi `gh` girişinizden** geçer. opencodex hiçbir
GitHub belirteci tutmaz ve öğrendiği tek şey evet veya hayır cevabınızdır.

Bu GitHub hesabınıza yazdığından, ajan odaklı arayanların sizin adınıza yanıt
vermesine izin verilmek yerine reddedilir:

- `ocx start` ve `ocx service install`, bir ajan veya CI donanımı onları
  çalıştırdığında (`CLAUDECODE`, `CODEX_THREAD_ID`, `CURSOR_TRACE_ID`, `CI` ve
  benzeri) **istemi tamamen atlar**. Tek seferlik işaretçi yazılmadan kalır, bu
  nedenle gerçek istem bir sonraki elle yazılan çalıştırmanızda yine de görünür.
  Ajanın bunun yerine size sorması söylenir — ve geçiştirebileceği yumuşak bir
  kenar notu olarak değil, yanıtlamanız gereken düz bir Evet/Hayır seçeneği
  olarak sorması söylenir. Yanıtlamaya hiç fırsat bulamazsanız ajana
  sessizliğinizi hayır olarak değerlendirmek yerine tekrar sorması söylenir.
- Proxy bir ajan oturumu altında çalıştığında ve isteğin kontrol paneli tarayıcı
  oturumu olmadığında `POST /api/github/star` `code: "agent_consent_required"`
  ile `403` yanıtı verir. Yönetici belirtecine sahip olmak rıza değildir:
  makinenizdeki bir ajan bu dosyayı okuyabilir.
- Kontrol paneli düğmesi normal şekilde çalışmaya devam eder. Gerçek bir tıklama
  aynı kaynaktan oturum kanıtı taşır, bu nedenle proxy'yi bir ajan başlatmış
  olsa bile siz olarak tanınır.
- Hayır demek onu sonlandırır. Hiçbir şey kalıcı hale getirilmez ve daha sonra
  sizi dürtmek için hiçbir model istemine hiçbir şey eklenmez.

## Kontrol paneli proxy ile nasıl konuşur

GUI, proxy'nin JSON yönetim API'si üzerinde ince bir istemcidir. Yararlı uç
noktalar şunları içerir:

| Uç nokta | Amaç |
| --- | --- |
| `GET` / `PUT /api/settings` | Ayarları okuyun veya Codex otomatik başlatmayı, akış/bellek ayarlarını ve hesap hedefli seçici görünürlüğünü güncelleyin. |
| `GET` / `POST /api/github/star` | `gh` kaynaklı yıldız durumunu okuyun veya depoya yıldız verin. POST, bir kontrol paneli oturumu olmayan ajan odaklı arayanlar için `403` `agent_consent_required` ile reddedilir. |
| `GET /api/startup-health` | Sırsız yönlendirme, servis, dolgu ve yeniden başlatma güvenliği tanılamalarını okuyun. |
| `POST /api/startup-action` | Sabit, izin listesine alınmış eylemler aracılığıyla arka plan servisini veya Codex başlatıcı dolgusunu kurun. |
| `GET` / `POST /api/windows-tray` | Windows tepsisi kurulumunu ve görünür süreç durumunu okuyun veya değiştirin. POST `install`, `start`, `stop` veya `uninstall` kabul eder. |
| `POST /api/sync` | Paylaşılan model kataloğunu yeniden oluşturun ve Codex model önbelleğini eski haline getirin. |
| `GET /api/update/check` · `POST /api/update/run` · `GET /api/update/status` | Kendi kendini güncelleme işlerini kontrol edin, çalıştırın ve izleyin. Çöken bir işin otomatik olarak kurtarılması için çalışan PID'leri kalıcı hale getirilir; eski PID'siz işler on dakika sonra kurtarılır. |
| `GET` / `PUT /api/sidecar-settings` | Arama/vizyon sidecar model ayarlarını okuyun veya ayarlayın. |
| `GET` / `PUT /api/injection-model` | Paylaşılan alt ajan model/çaba seçimini ve bağımsız rehberlik/yerel varsayılan anahtarlarını okuyun veya ayarlayın. |
| `GET` / `PUT /api/v2` | Arayüz modunu, Codex özellik bayrağını ve v2 iş parçacığı sınırını okuyun veya ayarlayın. |
| `GET /api/providers` · `POST /api/providers` · `PATCH /api/providers?name=...` · `DELETE /api/providers?name=...` | Sağlayıcıları listeleyin, ekleyin/değiştirin, etkinleştirin/devre dışı bırakın, varsayılanı ayarlayın veya kaldırın. `PATCH`, etkin bir sağlayıcıda bağımsız `{ "setDefault": true }` kullanır; `POST`, oluştururken/değiştirirken `setDefault` içerebilir (ayrıca yalnızca etkin olanlar). Geçerli varsayılanı silmek, bir tane varsa kalan ilk etkin sağlayıcıya yeniden atar; aksi takdirde API `code: "last_provider"` ile `409` döndürür ve geçerli varsayılanı tutar. |
| `GET /api/models` · `PUT /api/disabled-models` | Yerel/yönlendirilen model satırlarını listeleyin ve paylaşılan devre dışı model kümesini güncelleyin. |
| `GET /api/selected-models` · `PUT /api/model-visibility` | Sağlayıcı izin listelerini okuyun ve bir modelin veya sağlayıcı grubunun nihai görünürlüğünü atomik olarak değiştirin. |
| `GET /api/key-providers` · `GET /api/oauth/providers` | API anahtarı ve OAuth sağlayıcı kataloglarını okuyun. |
| `POST /api/oauth/login` · `GET /api/oauth/status` | Bir sağlayıcı OAuth akışını başlatın ve tamamlanmasını yoklayın. |
| `GET /api/codex-auth/accounts?refresh=1` | Ana ve havuz hesaplarını listeleyin, kota yenilemeye zorlayın ve ana hesap `hasCredential` / terminal `needsReauth` durumunu bildirin. |
| `PUT /api/codex-auth/active` · `PUT /api/codex-auth/auto-switch` · `PUT /api/codex-auth/failover` | Bir sonraki istek için hesabı seçin ve havuz yönlendirmesini yapılandırın. |
| `GET /api/codex-auth/active` · `PUT /api/codex-auth/accounts/priority` | Geçerli hesabı okuyun (`pinned` ve hangi hesabın `pinnedAccountId` olduğu dahil) ve bir hesabın seçim sırasını ayarlayın. |
| `POST /api/codex-auth/login` · `GET /api/codex-auth/login-status` | Tarayıcı girişi aracılığıyla bir havuz hesabı ekleyin. |
| `GET /api/logs?tail=50&limit=20&offset=0&provider=...&status=5xx` | İsteğe bağlı kuyruk, sağlayıcı ve tam/sınıf durum filtreleriyle son istek meta verilerini okuyun. `limit`/`offset` ile sayfalama en yeni satırdan geriye doğru ilerler (`offset=0` en son sayfayı döndürür). Yanıt şekli: `{ timeZone, total, logs }` burada `total`, sayfalamadan önceki filtrelenmiş satır sayısıdır. |
| `GET` / `PUT /api/subagent-models` | Öne çıkan beş `spawn_agent` geçersiz kılma modelini okuyun veya ayarlayın. |
| `POST /api/stop` | Proxy'yi/servisi durdurun, yerel Codex'i geri yükleyin ve çıkın. Windows Görev Zamanlayıcı arka ucunda `respawnable_service`, bu durum okunamadığında `service_state_unknown` ile reddedilir; her iki durumda da hiçbir şey değiştirilmez. |

:::tip
Kontrol panelinden **Ollama Cloud** veya başka bir katalog sağlayıcısı eklemek,
metin ve vizyon sınıflandırmasını kaydedilen sağlayıcı yapılandırmasına
kopyalar, böylece [vizyon sidecar'ı](/tr/guides/sidecars/) manuel sınıflandırma
olmadan doğru şekilde geçişlenir.
:::


