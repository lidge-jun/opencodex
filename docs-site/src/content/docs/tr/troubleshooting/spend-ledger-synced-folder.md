---
title: Eşitlenen klasörde harcama kaydı reddi
description: Durum dizini iCloud Drive veya başka bir eşitlenen klasördeyken görülen harcama kaydı hatasının nedeni ve çözümü.
---

Harcama kaydı depolama reddi, `server_error` türü ve `spend_ledger_storage_unavailable`
kodu ile HTTP 503 döndürür. Bu yerel bir depolama sorunudur; sağlayıcı veya hesap
sağlığını olumsuz etkilemez. İstek günlüklerinde `local-refusal` olarak kaydedilir.
Akışı başlamış yanıtlarda aynı kod son hata olayında yer alır. Dosyanın durumu
geçiciyse aynı oturumdaki diğer istekler başarılı olabilir.

Eski sürümler yanıltıcı bir “Provider unreachable” önekiyle HTTP 502 döndürüyordu.
Güncel sürümler hangi dosya rolünün hangi kontrolden geçemediğini belirtir:

```text
Spend-ledger storage could not be opened safely (journal: extra-hard-link).
```

## Kontrolün amacı

opencodex, durum dizininde (varsayılan `~/.opencodex` veya `OPENCODEX_HOME`)
`spend-ledger.jsonl` günlük dosyasını ve `spend-ledger.salt` tuz dosyasını tutar.
Her yazmadan önce dosyaların size ait normal dosyalar olduğunu, sembolik bağlantı
olmadığını ve tam olarak bir dizin girdisine sahip olduğunu doğrular. İkinci bir
sabit bağlantı, aynı diskte başka bir adın aynı baytları okuyabilmesi veya
değiştirebilmesi demektir. Bu yüzden opencodex yazmayı reddeder. Bu kontrol
bilerek katı tutulur.

| İletideki koşul | Anlamı |
| --- | --- |
| `extra-hard-link` | Aynı dosyaya başka bir dizin girdisi işaret ediyor. |
| `symbolic-link` | Kayıt dosyası sembolik bağlantı. |
| `not-regular-file` | Kayıt yolunda normal dosya dışında bir nesne var. |
| `foreign-owner` | Dosya başka bir kullanıcıya ait. |
| `invalid-salt` | Tuz dosyası mevcut ancak içeriği geçerli değil. |

İletideki rol `journal`, `journal-compaction` (günlük sıkıştırılırken yazılan geçici
dosya) veya `salt` olabilir.

## Eşitlenen klasörler neden bu hatayı tetikler?

“Masaüstü ve Belgeler Klasörleri” açık olan iCloud Drive ve OneDrive, Dropbox,
Google Drive gibi File Provider istemcileri, bir değişikliği hazırlarken veya
yüklerken dosyaya geçici olarak ikinci bağlantı tutabilir. Durum dizini böyle bir
klasördeyse sıradan bir yazmadan sonra günlüğün kısa süreliğine iki bağlantısı
olabilir. O anda gelen istek reddedilirken bir sonraki başarılı olabilir.
Eşitleme tamamlanınca dosya yeniden tek bağlantılı olur; sonradan incelemek
sorunu göstermeyebilir.

Başlangıçta opencodex; durum dizini iCloud Drive (`~/Library/Mobile Documents`),
bir File Provider klasörü (`~/Library/CloudStorage`), iCloud Masaüstü ve Belgeler
eşitlemesi açık görünürken Masaüstü/Belgeler veya Google Drive for desktop
kullanılıyor görünürken Masaüstü/Belgeler içindeyse uyarır. Google Drive ipucu,
`~/Library/CloudStorage/GoogleDrive-*` ya da
`~/Library/Application Support/Google/DriveFS` varlığıdır. Hangi klasörlerin
eşitleneceğini uygulamadan okumaz; Belgeler seçili olmasa bile Drive kurulumu
uyarıya yol açabilir. Bu yalnızca bilgilendirmedir. Klasör düzenine dayalı
algılama hem gereksiz uyarı verebilir hem de bir durumu kaçırabilir.

## Çözüm

Durum dizinini eşitlenen klasörlerin dışında tutun. Varsayılan `~/.opencodex`
eşitlenmez.

1. opencodex'i durdurun.
2. Durum dizinini `~/.opencodex-trial` gibi eşitlenmeyen bir konuma taşıyın veya kopyalayın.
3. `OPENCODEX_HOME` değişkenini o konuma ayarlayın ya da varsayılanı kullanmak için kaldırın; opencodex'i yeniden başlatın.

Hatayı gidermek için günlüğü silmeyin, izinlerini gevşetmeyin veya kontrolü
kaldırmayın. Günlük harcama geçmişinizi tutar; kontrol de beklenmedik bir bağlantı
üzerinden yazılmasını önler.

İleti `extra-hard-link` dışında bir koşul belirtiyorsa veya durum dizini
eşitlenen bir klasörde değilse tam ret iletisiyle bir sorun kaydı açın. Bu ileti
dosya yolu, hesap bilgisi veya istek içeriği içermez.
