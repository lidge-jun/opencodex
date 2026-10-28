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

`check` kayıt defterini sorgulamaz ve Codex’i çalıştırmaz. POSIX üzerinde çözümleyicinin seçtiği kanonik yol, yayımlanmış başlatıcının yakaladığı ortam adayıyla aynıysa `selectionAttested: true` olabilir. Bağlantılı npm-global paket bildirimi sahipliği doğrularsa ve aday sürüm bildirildiyse bu sürüm bildirimdeki sürümle eşleşirse `managed: true` olabilir; kalıcı adaylar doğrulanmaz. Windows x64 ayrıca kanıta bağlı mutlak standart npm `codex.cmd` ile tutulan tanıtıcılara bağlı bir Node/npm araç zincirini (varsa önek-yerel, yokluğu doğrulanırsa başlatıcı mimarisine bağlanmış yakalanan PATH çifti) ve önek içinde doğrulanmış platform desteğini destekler; yeniden ayrıştırmayı reddeden tutulan tanıtıcılar kullanır. Diğer Windows düzenleri ertelenmiş veya yönetimsiz kalır. Windows'taki bir `managed` sonucu yalnızca gözlemlenen kurulum düzenini sınıflandırır: bağlı Node/npm, güncelleyicinin salt okunur meta veri araç zinciridir ve sonraki bir `codex.cmd` çağrısının hangi yorumlayıcıyı çözeceğine dair bir güvence değildir. Doğrudan Bun/kaynak çalıştırması başlatıcı kanıtı sağlamaz. `plan`, yalıtılmış geçici npm yapılandırması, önbelleği ve günlükleriyle resmî kayıt defterini sorgular; etkin oturumları veya eksik süreç gözlemini reddeder. Yazılım kurmaz ve süreçlere sinyal göndermez. Windows x64 apply, doğrulanmış özel yazma yetkisine sahip sınırlı bir npm öneki gerektirir ve ilgisiz paketleri ve shim'leri korur; desteklenmeyen gözlemlenen düzenler `applicable: false` ve `refusal: windows_apply_disabled` döndürür; yalnızca PATH seçimi, OpenCodex otomatik başlatma sarmalayıcıları ve global/vendor geri dönüşü ertelenmiş kalır. [Komutların ve ret nedenlerinin tam açıklamasına (İngilizce)](/reference/cli/agents/#read-only-codex-cli-update-plan) bakın.

Windows x64 kurulum gözlemi için [`attest`](/tr/reference/cli/agents/) komutuna bakın. Açık yollar verilmezse komut, kanıta bağlı başlatıcı anlık görüntüsünün belirlediği seçili adayı gözlemler; güncelleme yetkisi veya çalışma zamanı seçimi doğrulanmaz.

Belirsiz olmayan yerlerde liste veya durum varsayılandır. Yapılandırılmış anlık
görüntüler için `--json` ve akışlı bir istek günlüğü akışı için `ocx observe
logs --follow --jsonl` kullanın. Tema, dil, gezinme ve diğer tamamen görsel
tarayıcı durumlarının CLI eşdeğeri yoktur; Cloudflare Tünel kurulumu bu komut
kümesinin dışındadır.

## Canlılık yoklaması üst sınırının geçersiz kılınması

`ocx health`, `ocx status`, `ocx account *`, `ocx login codex` ve `ocx ready`, çalışan proxy'yi kısa bir canlılık yoklamasıyla bulur: varsayılan olarak deneme başına 750 ms, durdurma ve başlatma kararlarında yeniden denemelerle 1500 ms. Bir güvenlik katmanının (içerik filtresi veya EDR tarzı ağ uzantısı) her loopback bağlantısına sabit bir gecikme eklediği ana makinelerde bu sınırlar, sağlıklı bir proxy yanıt vermeden dolabilir.

Bu durumda sınırları `OCX_PROBE_TIMEOUT_MS` ile yükseltin, örneğin `OCX_PROBE_TIMEOUT_MS=5000 ocx status`. Değer 1 ile 30000 arasında tam sayı milisaniyedir. Geçersiz kılma yalnızca yükseltir: 750 ms varsayılan ve 1500 ms durdurma/başlatma bütçeleri alt sınırlarını korur, bu yüzden `1000` yalnızca varsayılan yoklamayı uzatır. Boş, kesirli, negatif, sıfır veya daha büyük değerler yok sayılır.

## Çıkış kodları ve onaylama

Başarılı komutlar 0 ile çıkar. Geçersiz kullanım, bilinmeyen komutlar veya
kaynaklar, başarısız API işlemleri ve kullanılamayan gerekli servisler sıfır
olmayan bir çıkış yapar. `ocx health` özellikle yalnızca proxy sağlıklı
olduğunda 0, sağlıklı proxy bulunamadığında 1 ve geçersiz argümanlarda 2 ile çıkar, bu nedenle bir servis probu olarak
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
