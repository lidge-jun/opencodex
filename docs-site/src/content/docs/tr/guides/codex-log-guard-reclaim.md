---
title: Codex Log Guard ile Alan Geri Kazanma
description: Sınırlı artımlı vakumlama ile Codex tanılama günlüklerinin SQLite depolamasındaki boş sayfaları elle geri kazanın.
---

Geri kazanma, Codex Log Guard'ın elle başlatılan alan kurtarma aşamasıdır. Kanonik Codex `logs_2.sqlite` veritabanını yalnızca veritabanı ve çalışma zamanı, Log Guard korumasının kullandığı güvenlik denetimlerinden geçtiğinde sıkıştırır.

Geri kazanma **asla otomatik olarak zamanlanmaz** ve yalnızca Depolama sayfası açıldı diye çalışmaz. Kontrol paneli, değişiklik isteğini göndermeden önce açık bir Compact eylemi ve ikinci bir onay ister.

## Geri kazanma ne yapar

OpenCodex, sınırlı bir çevrimdışı bakım dizisi uygular:

1. Codex'in etkin `sqlite_home` konumu üzerinden kanonik `logs_2.sqlite` dosyasını bulur;
2. dosya kimliğini ve bilinen Codex günlük şemasını doğrular;
3. süreç listelemenin başarılı olduğunu ve desteklenen hiçbir Codex yazıcı sürecinin çalışmadığını doğrular;
4. süreçler arası özel Log Guard kilidini alır;
5. kilit tutulurken Codex süreç denetimini tekrarlar;
6. mevcut veritabanını oluşturma semantiği olmadan okuma/yazma modunda açar ve hemen bir SQLite yazıcı kilidi alınabildiğini kanıtlar;
7. `PRAGMA auto_vacuum` değerinin zaten `INCREMENTAL` olmasını şart koşar;
8. bakımdan önce `PRAGMA quick_check` çalıştırır;
9. tam bir WAL denetim noktası yürütür ve meşgul veya tamamlanmamış denetim noktasını reddeder;
10. her partiden sonra denetim noktası oluşturarak sınırlı `PRAGMA incremental_vacuum(N)` partileri çalıştırır;
11. bakımdan sonra `PRAGMA quick_check` işlemini yineler; ve
12. veritabanı, WAL, sayfa sayısı, boş sayfa listesi ve geri kazanılabilir bayt ölçümlerinin öncesini ve sonrasını bildirir.

Varsayılan parti hedefi yaklaşık **8 MiB SQLite sayfasıdır**. Tek bir çağrı, ek bir sonlu yineleme sınırıyla birlikte en fazla yaklaşık **256 MiB sayfayı** geri kazanır. Daha fazla boş sayfa kalırsa sonuç kısmi olarak bildirilir; Compact eylemini daha sonra yeniden başlatabilirsiniz.

Bayt sınırları, veritabanının gerçek SQLite sayfa boyutu kullanılarak sayfa sayılarına dönüştürülür. Bunlar işlenen mantıksal SQLite sayfalarının sınırıdır; SSD/NAND yazma hacmine ilişkin iddia değildir.

## Güvenlik garantileri

Geri kazanma özellikle şunları **yapmaz**:

- tam `VACUUM` çalıştırmak;
- mevcut bir Codex veritabanında `auto_vacuum` modunu değiştirmek;
- Codex `-wal` / `-shm` dosyalarını doğrudan silmek, kesmek, yeniden adlandırmak veya başka şekilde değiştirmek;
- tanılama satırlarını silmek;
- Log Guard koruma tetikleyicilerini veya kullanıcıya ait ilgisiz tetikleyicileri değiştirmek;
- Codex etkin olarak algılandığında çalışmak;
- süreç listeleme sonucu belirsizken devam etmek;
- gelecekteki bilinmeyen bir günlük şemasında devam etmek; ya da
- başarısız bir SQLite bütünlük denetiminden sonra devam etmek.

Meşgul Log Guard kilidi, meşgul SQLite yazıcısı veya meşgul ilk denetim noktası arka planda yeniden denenmek yerine açık bir ret olarak döner. Denetim noktası çekişmesi ancak bir artımlı vakum partisi kaydedildikten sonra ortaya çıkarsa OpenCodex, hiçbir şeyin değişmediğini iddia etmek yerine tamamlanmış işi `stopReason: "busy"` ile başarılı bir kısmi sonuç olarak bildirir.

## CLI

Önce geri kazanılabilir alanı inceleyin:

```bash
ocx storage codex-logs status
```

Tek bir sınırlı bakım geçişi çalıştırın:

```bash
ocx storage codex-logs compact
```

Makine tarafından okunabilir önce/sonra ölçümleri için:

```bash
ocx storage codex-logs compact --json
```

Sonuç daha fazla geri kazanılabilir alan kaldığını bildirirse, açıkça başka bir sınırlı geçiş istemediğiniz sürece burada durun. OpenCodex sonsuza kadar döngüye girmez veya sizin için takip geçişi zamanlamaz.

## Yönetim API'si

Sıkıştırma yalnızca değişiklik yapan bir uç nokta üzerinden sunulur:

```text
POST /api/storage/codex-logs/compact
```

Sıkıştırma için GET takma adı yoktur. Başarılı yanıt, önce/sonra ölçümleri, geri kazanılan sayfa sayılarını, ana veritabanının fiziksel boyut değişimini, yineleme sayısını, tamamlanma durumunu, durma nedenini ve bütünlük durumunu içeren bir `report` nesnesi taşır.

Tipik ret durumları şunlardır:

- `codex_running` — Codex çalışıyor
- `process_enumeration_failed` — süreçler listelenemedi
- `busy` — kilit veya veritabanı meşgul
- `unsupported_schema` — şema desteklenmiyor
- `auto_vacuum_not_incremental` — artımlı vakumlama etkin değil
- `unsafe_path` — dosya yolu güvenli değil
- `integrity_check_failed` — bütünlük denetimi başarısız
- `database_error` — veritabanı hatası

Bütünlük hataları, bakım geçişinden önce mi sonra mı oluştuklarını belirtir. `busy` reddi, herhangi bir vakum partisi kaydedilmeden önce çekişme algılandığı anlamına gelir; başarılı bir rapor içindeki `stopReason: "busy"` ise sonraki denetim noktası çekişmesi geçişi durdurmadan önce en az bir partinin kaydedildiği anlamına gelir.

## Sonucu anlama

`pagesReclaimed` ve `logicalBytesReclaimed`, geçiş sırasında kaldırılan SQLite boş sayfa listesi sayfalarını açıklar. `physicalDatabaseBytesReclaimed`, bakım denetim noktalarından sonra ana veritabanı dosyasında gözlenen küçülmeyi bildirir.

Bu sayılar farklı olabilir. SQLite/WAL/dosya sistemi davranışı nedeniyle mantıksal sayfaların geri kazanılması, fiziksel dosyanın hemen aynı miktarda küçüleceğini garanti etmez. Bu ölçümlerin hiçbiri NAND yazmaları, SSD aşınması veya tüketilen/tasarruf edilen TBW olarak yorumlanmamalıdır.

`complete: true`, gözlenen boş sayfa listesinin sıfıra indiği anlamına gelir. Kısmi sonuçta, geçiş başına sayfa bütçesi veya sonlu yineleme sınırı sona ererse `stopReason: "page_budget"`, SQLite boş sayfa listesini küçültmeyi bırakırsa `stopReason: "no_progress"`, kaydedilmiş geri kazanımdan sonra denetim noktası çekişmesi oluşursa `stopReason: "busy"` kullanılır. Üçü de sınırlı sonuçlardır; hiçbiri otomatik yeniden denemeye yol açmaz.
