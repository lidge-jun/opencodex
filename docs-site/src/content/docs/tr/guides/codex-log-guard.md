---
title: Codex Log Guard
description: Günlük gövdelerini açığa çıkarmadan Codex tanılama günlüklerinin kalıcı kaydını inceleyin ve açıkça azaltın.
---

OpenCodex, Codex'in kalıcı tanılama günlüğü veritabanını inceleyebilir ve siz etkinleştirirseniz Codex'in hangi tanılama satırlarını sakladığını azaltabilir. İnceleme salt okunurdur; koruma ise bilinen Codex günlük şeması bulunmadıkça ve Codex durdurulmadıkça reddedilen açık bir değişikliktir.

## İnceleme ne bildirir

OpenCodex, Codex'in mevcut öncelik sırasına göre etkin `sqlite_home` konumunu çözümler ve oradaki kanonik `logs_2.sqlite` veritabanını inceler. Daha yüksek numaralı veya eski bir `logs_N.sqlite` dosyası hiçbir zaman değişiklik yapılabilen hedef olarak onun yerine kullanılmaz.

Depolama görünümü şunları bildirir:

- ana veritabanı, WAL ve SHM dosyalarının boyutları;
- toplam günlük satırı ve `TRACE` düzeyinde saklananların oranı;
- hedef adları yerine sıra etiketleri kullanarak satır sayısına göre en büyük günlük hedefi grupları;
- daha sonra geri kazanılabilecek SQLite boş sayfa listesi alanı; ve
- gözlenen şemanın şu anda bilinen Codex günlük şemasıyla uyumlu olup olmadığı.

`sqlite_home`, `CODEX_HOME` dışında ise tanılama veritabanı ayrı gösterilir. Baytları, mevcut `CODEX_HOME` depolama toplamına sessizce eklenmez.

OpenCodex, bu tanılamaları üretirken `feedback_log_body` alanını seçmez veya açığa çıkarmaz. Günlük düzeyleri bilinen sabit düzey kümesine ve `OTHER` değerine indirgenir; hedef adları serileştirilmez.

## Koruma modları

Koruma **varsayılan olarak kapalıdır**. Etkinleştirmek, Codex'in kanonik `logs_2.sqlite` veritabanına OpenCodex'e ait bir `BEFORE INSERT` tetikleyicisi kurar. OpenCodex, kendisi için ayrılmış adları kullanan bilinmeyen bir tetikleyiciyi asla değiştirmez ve yalnızca SQL'i OpenCodex'e ait sürümle eşleşen tetikleyicileri kaldırır.

İki mod kullanılabilir:

- **Compatibility** (`compat`) önerilen moddur. Geçerli Log Guard v1 kural kümesini, mevcut Codex'in kalıcı SQLite günlük alıcısında zaten filtrelediği veya düzeyini düşürdüğü yüksek hacimli hedeflerle sınırlar. İlgisiz `TRACE` satırları korunur.
- **Quiet** (`quiet`), `DEBUG`, `INFO`, `WARN` ve `ERROR` satırlarını korurken yeni `TRACE` satırlarının tümünü bastırır.

Koruma, kalıcı SQLite depolamasına ulaşan satırları azaltır. Codex'in daha önce yaptığı izleme işini **ortadan kaldırmaz**: tetikleyici bir satırı yok saymadan önce olaylar biçimlendirilebilir, kuyruğa alınabilir, işlemlerde gruplanabilir ve Codex'in kendi budama mantığında değerlendirilebilir. Protect özelliğini Codex içindeki tanılama üretimini kapatan bir anahtar olarak değil, kalıcı yazma yoğunluğuna karşı kalkan olarak düşünün.

Log Guard yalnızca kalıcı yerel SQLite günlük satırlarını filtreler. Codex tanılama işlemesini, [adaptör aktarımını](/tr/reference/adapters/), sağlayıcı yüklerini, akış semantiğini, kimlik doğrulamayı, yönlendirmeyi, kotaları veya hesap durumunu değiştirmez.

### Güvenlik denetimleri

Protect, Disable veya Repair yabancı veritabanını değiştirmeden önce OpenCodex:

1. yalnızca kanonik `logs_2.sqlite` yolunu çözümler;
2. yolun sembolik bağlantı olmayan normal bir dosya olduğunu ve bilinen şemayla tam eşleştiğini doğrular;
3. süreç listelemenin başarılı olduğunu ve desteklenen hiçbir Codex yazıcı sürecinin çalışmadığını doğrular;
4. süreçler arası özel Log Guard kilidini alır;
5. kilidi aldıktan sonra Codex süreç denetimini tekrarlar;
6. veritabanını oluşturma semantiği **olmadan** okuma/yazma modunda açar ve beklemeden SQLite `BEGIN IMMEDIATE` kilidini alır;
7. yalnızca OpenCodex'e ait Log Guard tetikleyicilerini değiştirir ve kaydetmeden önce sonucu yeniden okur; ve
8. Log Guard kilidi hâlâ tutulurken istenen modu OpenCodex yapılandırmasına kaydeder.

Süreç listeleme sonucu belirsizse, veritabanı meşgulse, şema bilinmiyorsa veya ayrılmış bir tetikleyici adı farklı bir SQL'e aitse değişiklik güvenli biçimde reddedilir. OpenCodex, Codex'i otomatik olarak sonlandırmaz.

## Sapma ve Onarım

İstenen koruma modu, OpenCodex yapılandırmasında Codex'in günlük veritabanından ayrı saklanır. Bu önemlidir; çünkü Codex geçişi `logs` tablosunu yeniden oluşturabilir ve SQLite, değiştirilen tabloya bağlı tetikleyicileri kaldırır.

Kaydedilen mod `compat` veya `quiet` olduğu hâlde ilgili sahipli tetikleyici artık görülmüyorsa Log Guard durumu **drifted** olarak bildirir. `ocx doctor` sapmayı bildirir ancak asla otomatik onarmaz.

Onarım açıkça başlatılır:

```bash
ocx storage codex-logs repair
```

OpenCodex korumayı her başlangıçta yeniden oluşturmamayı bilinçli olarak seçer. Gelecekteki bir sürüm, bunun Codex geçişleri boyunca güvenli olduğuna dair yeterli saha kanıtı toplandıktan sonra otomatik onarımı yeniden değerlendirebilir.

## CLI

Durumu okuyun:

```bash
ocx storage codex-logs status
ocx storage codex-logs status --json
ocx doctor
```

Önerilen uyumluluk politikasını etkinleştirin:

```bash
ocx storage codex-logs protect
```

Sessiz modu açıkça seçin:

```bash
ocx storage codex-logs protect --mode quiet
```

OpenCodex korumasını devre dışı bırakın veya sapmayı onarın:

```bash
ocx storage codex-logs unprotect
ocx storage codex-logs repair
```

Makine tarafından okunabilir çıktı için Log Guard komutlarına `--json` ekleyin. Geçerli komut söz dizimi ve JSON davranışı için [CLI başvurusuna](/tr/reference/cli/) bakın.

Mevcut komut değişmeden kalır:

```bash
ocx storage --json
```

Yanıtı, Depolama sayfasının kullandığı aynı Codex günlük durumunu taşır.

## Yönetim API'si

Durum şu adreste kullanılabilir:

```text
GET /api/storage/codex-logs
```

Açık değişiklikler şu uç noktaları kullanır:

```text
POST /api/storage/codex-logs/protect
POST /api/storage/codex-logs/unprotect
POST /api/storage/codex-logs/repair
```

Protect gövdesi `{"mode":"compat"}` veya `{"mode":"quiet"}` olur. `GET /api/storage`, raporu `codexLogs` adıyla da içerir; böylece kontrol paneli normal depolama dökümünü ve Codex günlük tanılamalarını tek bir anlık görüntü isteğiyle yenileyebilir.

## Salt okunur anlık görüntü semantiği

Durum incelemesi veritabanını SQLite `immutable=1` ile salt okunur açar. Bu, tanılama amaçlı okumanın `-wal` veya `-shm` yan dosyalarını oluşturmasını ya da güncellemesini önler.

Bunun bir sonucu vardır: SQL toplamları ve gözlenen tetikleyici meta verileri, veritabanının son denetim noktası anlık görüntüsünü açıklar. Codex etkin olarak yazıyorsa canlı WAL, değişmez anlık görüntüden daha yeni satırlar veya şema sayfaları içerebilir. Başarılı bir değişiklik yanıtı, OpenCodex'in yazma işlemi içinde doğruladığı tetikleyici durumunu kullanır; daha sonraki salt okunur durum isteği, SQLite bu şema sayfaları için denetim noktası oluşturana kadar geçici olarak geriden gelebilir.

OpenCodex, WAL dosya boyutunu ayrı bildirir ve sonucu SSD yazma hızı, NAND yazmaları veya sürücü aşınması/TBW tüketimi olarak **etiketlemez**.

## Uyumluluk durumları

Bilinen bir şema, inceleme ve korumayı destekleniyor olarak bildirir. Eksik, okunamayan veya gelecekteki bilinmeyen bir şema meta veri olarak incelenebilir kalır, ancak değişiklik yapılabilen işlemler için desteklenmiyor olarak bildirilir.

Bilinmeyen bir şema tahmin yoluyla uyumlu sayılmaz. Böylece yeni bir Codex sürümü gözlemlenebilir kalırken Log Guard'ın incelenmemiş bir veritabanı düzenini değiştirmeyi güvenli sayması önlenir.

## Geri kazanma ayrı bir aşama olarak kalır

Protect, SQLite üzerinde vakumlama veya sıkıştırma yapmaz. [**Reclaim**](/tr/guides/codex-log-guard-reclaim/) denetim noktaları ve bütünlük kontrolleri içeren açık, çevrimdışı ve sınırlı bir artımlı vakum akışı sunar.

Protect asla `VACUUM` çalıştırmaz, Codex'in WAL dosyasını doğrudan kesmez veya silmez ve zamanlanmış alan geri kazanma işlemi yapmaz.
