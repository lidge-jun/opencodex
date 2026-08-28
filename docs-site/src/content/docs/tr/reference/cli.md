---
title: CLI Referansı
description: Komut dağıtımı, çıkış kodları ve her ocx komut ailesine bağlantılar.
---

opencodex CLI'sı `ocx`'tir. `setup`/`init`, `restore`/`eject` ve
`models`/`model` gibi belgelenmiş takma adların aynı işleme ulaşmasıyla ilk
komut adında dağıtım yapar. Bilinmeyen komutlar ve geçersiz komut şekilleri
hatadır.

Üst düzey kullanım için `ocx help` (veya `ocx --help` / `ocx -h`) çalıştırın.
Yardım tablosunda kayıtlı bir komut için `ocx help <komut>`, `ocx <komut>
--help` veya `ocx <komut> -h` çalıştırın. Yardım ve sürüm komutları salt
okunurdur: Codex veya opencodex durumunu başlatmaz, durdurmaz, kurmaz, kaldırmaz
veya yeniden yazmazlar.

## Komut aileleri

- [Yaşam Döngüsü](/tr/reference/cli/lifecycle/) — kurulum, proxy ve servis yaşam
  döngüsü, sağlık, tanılama, katalog senkronizasyonu, kontrol paneli ve
  güncellemeler.
- [Sağlayıcılar, hesaplar ve modeller](/tr/reference/cli/providers-accounts/) —
  sağlayıcı yapılandırması, kimlik doğrulama, kimlik bilgisi havuzları, kota,
  özel modeller, görünürlük, seçilen modeller ve bağlam sınırları.
- [Ajanlar, yönlendirme ve entegrasyonlar](/tr/reference/cli/agents/) — çoklu
  ajan kontrolleri, kombolar, gözlemlenebilirlik, kabul anahtarları, istemci
  entegrasyonları, çalışma zamanı ayarları, doğrulanmış yapılandırma ve salt
  okunur Codex CLI güncelleme denetimi.

## Başsız (Headless) davranış

Yönetim komutları, ikinci bir yapılandırma yolunu sürdürmek yerine kaydedilen
çalışma zamanı portunu ve kimlik denetimlerini kullanarak canlı proxy'nin
yönetim API'sine gidiş-dönüş yapar. Durdurulmuş veya erişilemeyen bir proxy HTTP
503 olarak temsil edilir ve sıfır olmayan bir CLI çıkışı üretir. Çevrimdışı
yapılandırma işlemleri olarak açıkça belgelenen komutlar, bunun yerine canlı bir
proxy olmadan yapılandırma dosyasını doğrulayabilir ve düzenleyebilir.

`ocx system codex-cli-update check` canlı proxy gerektirmez ve paket kayıt defterine istek göndermez. Yapılandırmada belirtilen kurulum adayına ilişkin provenance meta verilerini, maskelenmiş yürütülebilir dosya konumu ve sahiplik kanıtı dâhil, sınırlı biçimde inceler. Yayımlanmış başlatıcıdan gelen güvenilir bağlam aday anlık görüntüsünü doğrular; Codex'in başarıyla çalıştırıldığını doğrulamaz. Bu tek seferlik denetim Codex'i hiçbir zaman çalıştırmadığından, ortamdan ve kalıcı kayıtlardan gelen adaylar yalnızca raporlanır (`managed: false`, genellikle `selection_unattested`). JSON çıktısında `candidateAvailable`, `candidateVersion` ve `candidateSource` alanları bulunur; `selectionAttested` değeri ise `false` kalır. Yapılandırmada belirtilen kurulum adayını incelemek için yayımlanmış başlatıcıdan gelen güvenilir bağlam gerekir; Bun ile veya kaynak koddan doğrudan başlatıldığında bu kanıt bulunmadığından ortamdaki ve kalıcı kayıtlardaki aday durumu yok sayılır ve `candidate_unavailable` bildirilebilir. Windows'ta bu ilk parça, aday veya yapılandırma yollarında hiçbir dosya sistemi G/Ç işlemi yapmaz. Yalnızca güvenilir başlatıcının yakaladığı mutlak bir ortam adayı sözcüksel olarak uygulama paketi ya da sürüm yöneticisi etiketi alabilir; diğer tüm Windows adayları kapalı başarısızlıkla reddedilir. Komut yazılım kurmaz veya onarmaz, Codex ya da npm çalıştırmaz, çalışan bir sürece müdahale etmez ve yapılandırmaya ya da önbellek durumuna yazmaz.

Belirsiz olmayan yerlerde liste veya durum varsayılandır. Yapılandırılmış anlık
görüntüler için `--json` ve akışlı bir istek günlüğü akışı için `ocx observe
logs --follow --jsonl` kullanın. Tema, dil, gezinme ve diğer tamamen görsel
tarayıcı durumlarının CLI eşdeğeri yoktur; Cloudflare Tünel kurulumu bu komut
kümesinin dışındadır.

## Çıkış kodları ve onaylama

Başarılı komutlar 0 ile çıkar. Geçersiz kullanım, bilinmeyen komutlar veya
kaynaklar, başarısız API işlemleri ve kullanılamayan gerekli servisler sıfır
olmayan bir çıkış yapar. `ocx health` özellikle yalnızca proxy sağlıklı
olduğunda 0 ve aksi takdirde 1 ile çıkar, bu nedenle bir servis probu olarak
kullanılabilir. Betikler insan tarafından okunabilir çıktıyı kazımak yerine
çıkış kodunu test etmelidir.

Onay bildiren yıkıcı kaldırma, içe aktarma, kredi tüketimi ve güncelleme
işlemleri etkileşimsiz kullanımda `--yes` gerektirir. Bayrak açık bir
katılımdır; atlanması eylemi sessizce onaylamamalıdır.

## Sürüm ve dahili dağıtım hedefleri

`ocx --version`, `ocx -v` ve `ocx version` betik dostu tek bir sürüm satırı
yazdırır ve çıkar.

İki dağıtım hedefi normal yardımdan kasıtlı olarak çıkarılmıştır:
`__refresh-version [preview]`, ayrılmış bir süreçte güncelleme bildirimi
önbelleğini yeniler ve `__gui-update-worker <is-kimligi> [latest|preview]
[restart]`, bir kontrol paneli güncelleme işini çalıştırır. Bunlar kararlı
kullanıcıya yönelik komutlar değil, uygulama ayrıntılarıdır. Kontrol paneli
çalışan PID'sini kaydeder, çalışanı ölen aktif bir işi kurtarır, daha eski
PID'siz aktif kayıtları on dakika sonra eski olarak değerlendirir ve canlı bir
çalışanı eşzamanlı güncellemelerden korur.
