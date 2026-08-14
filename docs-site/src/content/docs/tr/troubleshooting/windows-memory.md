---
title: Windows Bellek Büyümesi
description: Windows'ta bun sürecinin neden çok sayıda gigabayt RAM'e kadar büyüyebildiği, opencodex'in bugün bu konuda ne yaptığı ve yukarı akış Bun düzeltmeleri gelene kadar seçenekleriniz.
---

Bazı Windows kullanıcıları, uzun akış oturumları sırasında opencodex'in
arkasındaki `bun` sürecinin çok sayıda gigabayt RSS'ye kadar büyüdüğünü
görmektedir ([#314](https://github.com/lidge-jun/opencodex/issues/314) numaralı
sorun olarak bildirilmiştir). Bu sayfa gerçekte ne olduğunu ve bu konuda
dürüstçe neler yapabileceğinizi açıklamaktadır.

## Temel neden: yukarı akış Bun çalışma zamanı sorunları

opencodex, Bun çalışma zamanını (şu anda **1.3.14**) paketler. Bellek büyümesi,
proxy'deki JavaScript düzeyindeki sızıntılardan değil, bilinen yukarı akış Bun
sorunlarından kaynaklanmaktadır:

| Bun sorunu | Durum (2026-07-23 tarihinde kontrol edildi) |
|---|---|
| [#28035](https://github.com/oven-sh/bun/issues/28035) — JS tüketimine bağlı olmayan `fetch()` alma geri basıncı | [PR #29831](https://github.com/oven-sh/bun/pull/29831) ile düzeltildi; **hangi sürümün taşıdığı doğrulanmadı** — paketlenmiş 1.3.14'ün taşımadığını varsayıyoruz |
| [#32111](https://github.com/oven-sh/bun/issues/32111) — bir istemci zaman uyumsuz çekme (async-pull) akışını iptal ettiğinde çökme | Düzeltme [PR #32120](https://github.com/oven-sh/bun/pull/32120) 2026-06-21 tarihinde birleştirildi; 1.3.14'te mevcut olduğu varsayılmıyor. Not: Bu çökme **Windows'a özgü değildir** (macOS/Linux'ta da yeniden üretildi) |
| [PR #31654](https://github.com/oven-sh/bun/pull/31654) — `node:net` soket tanıtıcısı sızıntısı | Yukarı akışta hala **açık** |

Windows'ta opencodex, #32111 çökmesini önlemek için akış yanıtlarını muhafazakar
bir kod yolunda tutmalıdır ve bu yol, geri basınç sorununa en çok maruz kalan
yoldur: yavaş veya durmuş bir istemci, çalışma zamanının yukarı akış verilerini
JavaScript'in sınırlayamayacağı yerel bellekte arabelleğe almasına neden
olabilir.

## opencodex bugün ne yapıyor

Sınırlı azaltma ve görünürlük — **bir düzeltme değil**. Paketlenmiş 1.3.14
çalışma zamanında sızıntının kendisi bir yukarı akış sorunu olarak kalır:

- **Bellek denetleyicisi (Memory watchdog)** — proxy kendi belleğini her dakika
  örnekler ve gözlemlenen bellek 4 GiB'yi aştığında hız sınırlı bir uyarı
  kaydeder. Gözlemlenen bellek, RSS, `external` ve `arrayBuffers`'ın en
  büyüğüdür (toplamları değil), çünkü Windows çalışma kümesi/RSS sayaçları
  taahhüt edilen harici tutmayı eksik bildirebilir.
- **`ocx doctor`** — bir "Bellek / çalışma zamanı" bölümü *servis* sürecinin Bun
  sürümünü, RSS'yi, external/ArrayBuffers sayaçlarını, JS yığın bağlamını ve
  akış modu kararını gösterir. Paketlenmiş Bun 1.3.14 çalışma zamanında tek
  başına `heapUsed` / `jscHeap` bir sızıntı ayrımcısı değildir; uygulama
  düzeyinde bir sızıntı atamadan önce gözlemlenen belleği `responseState` ve
  tekrarlanan örneklerle karşılaştırın.
- **`GET /api/system/memory`** — kontrol panelleri veya betikler için kimliği
  doğrulanmış yönetim API'si üzerinden aynı veriler. RSS/heap/external
  sayaçlarının yanı sıra, proxy'nin bellek içi `previous_response_id` devam
  deposu için skaler bir `responseState` bloğu (girdi sayısı, toplam/en büyük
  serileştirilmiş baytlar, en eski girdi yaşı) bildirir. Bu, büyümeyi daha da
  ilişkilendirir: artan gözlemlenen bellek altında yükselen bir
  `responseState.totalBytes` görüşmenin tutulduğunu (her turda yeniden
  genişleyen uzun `store:false` zincirleri) gösterirken, artan gözlemlenen
  bellek altında düz bir `responseState` bu depodan uzağa işaret eder. Değerler
  yalnızca skalerdir — istek gövdeleri, belirteçler, yollar veya hesap
  tanımlayıcıları yoktur — ve okuma yan etkisizdir (asla budamaz veya çıkarmaz).
  Kontrol panelinin **Bellek gözlemlenebilirliği** kartı aynı alanları işler ve
  onay korumalı bir **Boşalt ve yeniden başlat (Drain & restart)** eylemi sunar:
  geçerli aktif tur sayısını gösterir, aktif turlar için 60 saniyeye kadar
  bekler (mevcut 503 + `Retry-After` boşaltmasını yeniden kullanarak), ardından
  kalan turları iptal eder. Çalışan proxy yeniden başlatma yetkilendirmesine ve
  boşaltma koordinasyonuna sahiptir, ardından çıkar; kurulu bir servis
  yöneticisi geçerli olduğunda yenisini başlatır. Eylem, yalnızca aynı portta
  kimliği doğrulanmış farklı bir süreç sağlıklı olduğunda, Codex enjeksiyonunu
  kaldırmadan başarı bildirir. Bu, `POST /api/stop` üzerindeki kısa boşaltmadan
  daha uzun, bilgilendirilmiş bir geri dönüşümdür.
- **Geçitli bir alternatif akış yolu** — sınırsız arabellek şeklini tamamen
  ortadan kaldıran sınırlı bir tek okuyucu aktarımı. Windows'ta, paketlenmiş bir
  Bun sürümü #32111 düzeltmesini doğrulanabilir şekilde taşıdığında otomatik
  olarak varsayılan hale gelir; bugün yalnızca isteğe bağlıdır (aşağıya bakın).
  macOS'ta böyle bir sürümden sonra bile isteğe bağlı kalır — macOS `auto`'yu
  çevirmek ayrı bir karardır.

Bu değişikliklerden kaynaklanan gerçek dünya RSS iyileştirmesi **Windows
kullanıcıları tarafından doğrulanmayı beklemektedir** — sızıntının
düzeltildiğini iddia etmiyoruz.

Eşik tabanlı otomatik yeniden başlatma kasıtlı olarak **gönderilmemiştir**.
Süreç çökerse servis yöneticileri (Görev Zamanlayıcı/WinSW, launchd, systemd)
onu zaten yeniden başlatır.

## Seçenekleriniz

1. **Paketlenmiş bir çalışma zamanı güncellemesini bekleyin.** Bir Bun sürümü
   düzeltmeleri doğrulanabilir şekilde taşıdığında opencodex paketlenmiş çalışma
   zamanını yükseltecektir ve daha güvenli akış yolu Windows'ta otomatik olarak
   açılacaktır (macOS aşağıdaki açık katılımı gerektirmeye devam eder).

2. **`OPENCODEX_BUN_PATH` ile güvendiğiniz bir Bun çalışma zamanını
   çalıştırın.** Bu doğrulanmamış bir alandır — opencodex'i test etmediğimiz bir
   çalışma zamanında kendi sorumluluğunuzda çalıştırıyorsunuz. Servis
   yüklemeleri için önemli: geçersiz kılma servis başlangıcında değil, **servis
   varlığı oluşturulduğunda** okunur. Ortam değişkenini ayarlayın, ardından
   yolun dayanıklı servis tanımına yerleştirilmesi için aynı kabuktan `ocx
   service repair`'ı yeniden çalıştırın. Ortamı tek başına ayarlamak zaten
   kurulu bir servis için hiçbir şey yapmaz.

3. **`streamMode: "eager-relay"` ile sınırlı aktarıma katılın.** İki yol vardır:
   `config.json` dosyasını düzenleyin (`"streamMode": "eager-relay"` ekleyin)
   veya yönetim API'sini çağırın — `{"streamMode":"eager-relay"}` içeren bir
   `PUT /api/settings`, yeniden başlatma olmadan yeni turlara uygulanır. **Çökme
   riski uyarısı:** Bun 1.3.14'te bu, #32111'den etkilenen ve süreci akış
   ortasında çökertebilecek akış şeklini kullanır (yalnızca Windows'ta değil,
   herhangi bir işletim sisteminde). Servis yöneticisi onu yeniden başlatır,
   ancak devam eden istekler başarısız olur. `"legacy-tee"` geçerli varsayılanı
   sabitler. Windows'ta `"auto"` (varsayılan), çalışma zamanı geçidinin karar
   vermesini sağlar. macOS'ta `"auto"` her zaman tee üzerinde kalır; açık
   `"eager-relay"` katılımdır.

Bunlardan herhangi birini gerçek bir Windows iş yükünde denerseniz lütfen
[#314](https://github.com/lidge-jun/opencodex/issues/314) üzerinde önceki ve
sonraki `ocx doctor` bellek bölümlerini bildirin — bu azaltmanın beklediği
doğrulama tam olarak budur.


