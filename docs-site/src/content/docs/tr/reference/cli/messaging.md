---
title: Codex mesajlaşma
description: Yüklü Codex oturumlarına yerel olarak veya açıkça tanımlanmış SSH eşleri üzerinden ilişkili mesajlar gönderin.
---

`ocx message`, mevcut Codex oturumları için isteğe bağlı arayüzdür. Proxy veya
app-server başlatmaz, konuşma sürdürmez, beceri kurmaz. Linux/macOS Unix soketleri
desteklenir; Windows açık hatayla durur. Mevcut Codex daemon'ı deneysel
`thread/queue/add` desteklemelidir. CLI sürümü sabitlemek veya `CODEX_CLI_PATH`
seçmek gerekmez.

## Keşfetme ve gönderme

```bash
ocx message sessions --json
printf '%s\n' 'Please review the current change and send your findings back.' |
  ocx message send --name 'reviewer' --stdin --json
```

Keşif yalnızca yüklü konuşma kimliklerini, adlarını ve çalışma durumlarını döndürür;
geçmiş, önizleme veya çalışma dizini döndürmez. Tam UUID (`--thread`) veya benzersiz
tam ad (`--name`) kullanın. Eksik, yinelenen, tamamlanmamış veya yüklü olmayan
hedefler reddedilir; yaklaşık eşleştirme ya da kayıtlı oturumlara geri dönüş yoktur.

Mevcut denetim soketi, diğer Codex entegrasyon komutlarıyla aynı ana dizin ilkesi
kullanılarak etkin `CODEX_HOME` altında çözümlenir. Bağlanmadan önce çözümlenen
yolun sizin UID'nize ait soket olması gerekir. Kök dahil tüm gerçek üst dizinler
size veya root'a ait olmalı ve root'a ait `/tmp` gibi sticky dizinler dışında
grup/diğer kullanıcılarca yazılamamalıdır. Çözümlenen yol kontrolü geçiyorsa
sembolik bağlantılı ana dizinler kabul edilir. Güvenilmeyen yollar, çözümlenmiş
yol ayrıntıları verilmeden `untrusted_socket` ile reddedilir.

Keşif, son yüklü hedef kontrolü ve kuyruk gönderimi aynı soket bağlantısını
kullanır. Yerel CLI yardımcısı, kurulum, onarım veya yeniden bağlantı yapılmaz.
Yerel kuyruk desteği olmayan daemon `unsupported_queue` döndürür.

Yalnızca UTF-8 stdin kabul edilir: NUL içermeyen, boş olmayan en fazla 16 KiB metin.
Girdi, keşif, yeniden doğrulama ve gönderimin toplam süresi 30 saniyedir. Her RPC
en fazla 10 saniye sürer. Tam zarf 32 KiB ile sınırlıdır. Mesaj Unix RPC bağlantısı
üzerinden iletilir; başlatılan işlemlerin argümanlarına konmaz.

## Gönderen ve yanıtlar

Sarmalayıcı mesaj UUID'si üretir; yüklü `CODEX_THREAD_ID` ve daemon meta verisinden
gönderen kimliği/adı ekler. Bu bağlam **kimliği doğrulanmış eş yetkisi değildir**;
kullanıcı onayı veya yetki yükseltme sağlamaz. Geçersiz/yüklü olmayan gönderen
iddiası reddedilir; eksik bağlamda gönderen bilinmeyen kalır, yanıt rotası tahmin edilmez.

Eş mesajları izin onayı veya ayar geçersiz kılması olarak değil, metin olarak
kuyruğa alınır. Alıcı ajanın çalıştırma ortamı izinleri uygular; zarf yönergeleri
teknik yetkilendirme sınırı veya model davranışı garantisi değildir.

Varsayılan tür `request`'tir. Zarftaki üretilmiş `replyCommand` ile yanıtlayın veya
yanıtı açıkça ilişkilendirin:

```bash
printf '%s\n' 'Review findings: ...' |
  ocx message send --thread <sender-thread-uuid> --kind response \
    --in-reply-to <request-message-uuid> --stdin --json
```

`response`, `--in-reply-to` gerektirir; diğer türler bunu reddeder. Bilgilendirme
için `--kind notification` kullanın. Yanıt/bildirimler alındı onayı istemez.
Ajandan gelen normal son yanıt eşe gönderilmez; eksik rotalar tahmin edilmemelidir.
Genel istem değişikliği veya onay döngüsü eklenmez.

## Alındılar ve çıkış kodları

`--json`, `ocx-message/1` sürümlü tek alındı üretir: mesaj UUID'si, türü, yanıt
ilişkisi, gönderen/hedef meta verisi ve gönderim durumu. Gövde metni veya ham
daemon çıktısı içermez. Alındı oluşmadan önceki girdi/kurulum hataları,
`not_sent` ile `ocx-message-error/1` kullanır; keşif hataları aynı şemayı gönderim
durumu olmadan kullanır. Geçersiz kullanım, I/O öncesinde stderr ile 64 koduyla çıkar.

| Durum | Çıkış | Anlamı |
| --- | --- | --- |
| `not_sent` | 1 | Doğrulama/keşif/yeniden doğrulama başarısız, kuyruk çerçevesi yazılmadı veya daemon açıkça reddetti. |
| `queued` | 0 | İlişkili daemon yanıtı gönderimi onayladı; alıcının **işlemesini değil**. |
| `unknown` | 3 | Gönderim olmuş olabilir; onay kayıp, bozuk, eşleşmiyor veya iptal edilmiş. **Yeniden göndermeyin.** |

Uygulama mesaj UUID'si kuyruk isteğinin `clientUserMessageId` değeridir. Daemon
gönderim kimliği ayrıdır; hiçbiri alıcı işlemeyi kanıtlamaz. Kuyruğa alma, etkin
turu yönlendirme değildir; meşgul turun bitmesini bekleyebilir. OpenCodex otomatik
yeniden gönderim, takip sorgusu, kalıcı saklama veya teslim izleme yapmaz.
Son yüklü hedef kontrolü ile kuyruk gönderimi atomik değildir. Hedef sonra
kaldırılırsa açık ret `queue_rejected` ile `not_sent`; kayıp/geçersiz yanıt
`unknown` olur. OpenCodex hedefi sürdürmez veya yeniden denemez.

## Açıkça tanımlanmış uzak eşler

Uzak mesajlaşma, Remote Link ve normal proxy başlangıcından bağımsızdır. Sağlayıcı
yönlendirmez, sağlayıcı kimlik bilgisi paylaşmaz, yerel daemon başlatmaz. İki
düğümde de uyumlu OpenCodex CLI ve kuyruk destekli mevcut daemon gerekir. Linux
için yalıtılmış birlikte çalışabilirlik kanıtı vardır; macOS ayrı doğrulama
gerektirir. Windows uzak aktarımı desteklenmez.

Her düğümde mesajlaşmayı açıkça etkinleştirin. Alıcıda ön plan yöneticisini çalışır tutun:

```bash
ocx message enable --port 39176 --json
ocx message serve --json
```

Başlatan düğümde mevcut OpenSSH hedefini/takma adını kullanın. Onaylamadan önce
sunulan parmak izini güvenilir kaynaktan doğrulayın:

```bash
ocx message hosts probe --ssh worker --json
ocx message hosts add worker --ssh worker --fingerprint 'SHA256:<confirmed-key>' --json
ocx message hosts list --json
ocx message serve --host worker --json
```

Normal SSH ayarlarınızda `HashKnownHosts` açık olsa bile özel sorgu kayıtları
takma ad önekli biçimi korur; normal known_hosts dosyanız değişmez. Her kayıt
girişimi kendine ait, işleme özgü sabitlenmiş anahtar geçici dosyası kullanır.
SSH yardımcısı sonuçlanınca başarısızlık dahil temizlenir; başka değişiklik
yöneticisinin kilidine bağlı değildir. Temizlik doğrulanamazsa başarı değil,
bilinmeyen depolama sonucu bildirilir. Kurtarma günlüğü ayrıdır.

`hosts add worker`, `worker` hedefine giden mesajlara izin verir; **başlatan
düğüme gelişigüzel geri mesajlara değil**. SSH denetim alışverişi mevcut SSH
girişinizle alıcıda giden yönü yetkilendirir. Kayıt alındısı ve `hosts list`,
her düğümün yerel gelen mesaj ilkesini gösterir. Başlatan düğümde varsayılan
`responses-only`'dir: eş yalnızca bu düğümün gönderdiği isteğe ilişkili yanıt
bekleyen özgün yerel gönderen oturumlarını görebilir ve yanıtlayabilir. Yanıt;
istek UUID'si, kayıt ve özgün yerel hedefle eşleşmelidir. Başka oturumu
hedefleyemez, istenmeyen istek/bildirime dönüşemez.

Bir düğümde daha geniş erişim vermek için o düğümde açıkça çalıştırın:

```bash
ocx message hosts allow-inbound <peer-alias-or-machine-uuid> --json
# Kaydı kaldırmadan geniş izni geri alın:
ocx message hosts deny-inbound <peer-alias-or-machine-uuid> --json
```

`allow-inbound`, üç mesaj türünü **yüklü tüm yerel Codex oturumlarına** kabul eder
ve dizin meta verilerini eşe açar. Yalnızca yanıt izni değildir. Onay değişiklikleri
mevcut bağlantılarda sonraki okuma/gönderimden önce uygulanır. Yerel gelen ilke
içermeyen eski kayıtlar geniş erişim değil, `responses-only` varsayar.
Yanıt rotaları ön plan yöneticisi başına 256 bekleyen istekle sınırlıdır; 24 saat
sonra veya yönetici sonlandırılınca/yeniden başlayınca sona erer. Gönderen bağlamı
yoksa yanıt rotası yoktur. Kuyruğa alınan veya belirsiz yanıt rotayı tüketir;
kesin yerel ret tüketmez. Kayıp/süresi dolmuş rota otomatik yeniden gönderim
değil, işletmecinin/gönderenin açık uzlaştırmasını gerektirir.

Her `serve` ön planda yönetilir; çalışır bırakıp mesajlar için ayrı terminal
kullanın. En fazla dört farklı `--host` seçimi verilebilir. Servis kurulmaz veya
yönetici otomatik başlatılmaz. SSH doğrulanmış sabit sunucu anahtarlarını ve
yapılandırılmış anahtarlarınızı/ajanınızı kullanır; parola istemleri kapalıdır.
Sarmalayıcı yalnızca geri döngüde ileri/dönüş rotalarını yönetir. Böylece alıcı,
yukarıdaki ilkeye bağlı olarak başlatana SSH girişi yapmadan ilişkili yanıt gönderebilir.

```bash
ocx message status --json
ocx message sessions --host worker --json
printf '%s\n' 'Please review and reply using the supplied route.' |
  ocx message send --host worker --name reviewer --stdin --json
```

`--host` tam kayıtlı takma ad veya makine UUID'si seçer. Yanıt komutları doğrulanmış
kaynak makine ve konuşma UUID'sini içerir; kimlik uzak dizinden tahmin edilmez,
kaynak daemon'da çözülür. Gönderen bağlamı yoksa yanıt komutu uydurulmaz.
`--host` olmayan yerel komutlar durum/SSH/dinleyici kullanmayan yolu korur.
Alıcı; yanıt sunucusu/komutu ve standart eş yönergeleri dahil tüm kanonik zarfı,
kimliği doğrulanmış makine ve yerel mesaj UUID'sine göre doğrular. Eş,
sarmalayıcıyı başka makine olarak etiketleyemez veya kullanıcı mesajı olmadığına
dair uyarıyı çıkaramaz. Oturum adları ve konuşma kimlikleri makinenin açıklayıcı
iddialarıdır; oturum başına kimlik doğrulaması değildir.

Alıcının verdiği yönlü yetkiler `OPENCODEX_HOME` (veya varsayılan yapılandırma
dizini) altındaki özel mesajlaşma durumunda tutulur. Normal komut çıktısında,
yardımcı argümanlarında, URL'lerde veya mesaj zarflarında görünmez. Karşılıklı
kanıtlar gerçek WebSocket bağlantısını yerel/gövde çerçevelerinden önce doğrular;
ayrı sağlık sorgusu kimlik kanıtı için yetmez. Bu bir OpenCodex ağ geçidi
protokolüdür; yalın `codex queue --remote` onun kimlik el sıkışmasını uygulamaz.
Ağ geçidi aynı deneysel `thread/queue/add` sözleşmesini kullanır; Codex'in
`--ws-auth`, yapılandırma veya yerel bearer-token dinleyicilerini değiştirmez.
Genel app-server denetimi değil, yalnızca yüklü meta veri ve metin kuyruğu sunar.

Durum; etkin yapılandırmayı, çalışan yöneticiyi ve başlatılan/kiralanan rotaları
ayırır. Dönüş kiraları yenilenmezse 25 saniyede sona erer; teslim/işleme alındısı
değildir. Rota kaybı veya yönetici yapılandırma değişikliği açık yönetici yeniden
başlatması gerektirir. Aktarım kurtarması belirsiz mesajı yeniden göndermez.

```bash
ocx message hosts remove worker --json
ocx message disable --json
```

Kaldırma önce yerel kabulü iptal eder. Doğrulanmamış uzak temizlik çıkış 3 verir;
eş üzerinde de kaldırma gerekir. Her giden kaldırma bağımsız sabit anahtar geçici
dosyası kullanır; bu dosya hazırlanamazsa da yerel kaldırma ve doğrulanmamış uzak
temizlik bildirilir. Başarı/hata durumunda temizlik denenir. Üretilen rehber
`hosts remove <machine-uuid> --transaction <enrollment-uuid> --json` kullanır;
işlem koruması eski alındıyla yeni kaydın kaldırılmasını reddeder. İsteğe bağlı
koruma olmadan normal kaldırma, seçili mevcut eşi kaldırır.

Kapatma mevcut yönetici neslini sonlandırır; yeni iş hemen reddedilir. Ön plan
yöneticisi değişen ayarı on saniyelik bakım aralığında fark eder. Gönderen
gönderimden hemen önce yerel yetkiyi yeniden kontrol eder; sonradan iptal, yoldaki
mesajı veya kabul edilmiş yerel işi geri çekemez. Kayıp kayıt yanıtı bir özel işlem
tutar: aynı etkin nesil içinde başka adla kayıt yapmak yerine aynı add komutunu
tekrarlayarak uzlaştırın. Kapatıp açmak veya port değişimi kurtarma neslini
geçersiz kılar. Tamamlanan/iptal edilen işlemler kaldırılmış eşi geri getiremez
veya başka kaydın kurtarma kaydını silemez.

Yerel günlük JSON'u, kayıt biçimleri veya alan değerleri bozuksa `hosts add`,
`hosts list`, `status`, `hosts abandon`, `invalid_enrollment_journal` ile reddeder.
Baytlar işletmecinin açık kurtarması için korunur; OpenCodex otomatik onarmaz,
değiştirmez veya silmez. Bu durumda `hosts add` kayıt denetim isteği göndermez;
ancak ön sunucu anahtarı sorgusu çalışabilir. Güvensiz depolama ve meşgul değişiklik
kilidi ayrı hata sınıfını korur. Geçerli günlük artık uzlaştırılamıyorsa
`ocx message hosts list --json` veya `ocx message status --json` içindeki
`pendingEnrollment` alanını (takma ad, işlem UUID'si, neslin eskiliği) inceleyin.
Sonra tam o yerel günlüğü açıkça bırakın:

```bash
ocx message hosts abandon --transaction <pending-transaction-uuid> --json
```

Bırakma kapalıyken de çalışır; mevcut eşleri değiştirmez, kaydı yeniden denemez.
Uzak temizlik doğrulanmadığı için 3 ile çıkar. Yetim kayıt kalırsa uzak düğümde
verilen temizlik yönergesini uygulayın. Eski günlükler sessiz silinmez. Dolu
alıcı kayıt yapmadan `peer_capacity` döndürür; yer açıp aynı işlemi tekrarlayın
veya açıkça bırakın. Bozuk/kayıp denetim yanıtları belirsiz kalır.

Mevcut güvenilir `0755` yapılandırma dizinleri chmod yapılmadan kabul edilir;
mesajlaşmanın alt dizini özel kalır. Yeni uç kimlik doğrular ve eskisi bir
saniyelik kontrolde doğrulayamazsa hemen yeniden başlatılan yönetici eski dönüş
kirasını değiştirebilir. Hâlâ doğrulanan eski uç kirasını süresi dolana kadar
korur. Geçici erişimsizlik devralmaya izin verebilir, yeniden göndermeye değil.
Beklenmeyen tünel kaybı ön plan yöneticisini görünür biçimde sonlandırır;
bilinçli eş kaldırma ilgisiz rotaları durdurmaz. Çökmeden kalan değişiklik
kilitleri kapalı güvenli davranır ve işletmeci kurtarması ister; sarmalayıcı eski
kilidin sahipsiz olduğunu tahmin etmez.

Durum ve kurtarma günlüğü, bağlı uzak işten önce dosyayı ve üst dizini diske
eşitler; günlük kaldırma da dizini eşitler. `remote_storage_unknown` (çıkış 3),
depolama değişikliğinin çökmeye karşı kalıcılığının doğrulanamadığını belirtir.
macOS'ta dosya değişiminden sonra ACL reddi/sorgu hatası da bu kodu üretir:
yeni durum görünür, fakat ACL gizliliği ve kalıcılığı doğrulanmamıştır. Otomatik
tekrar/geri alma yerine durumu ve izinleri inceleyip açık kurtarma yapın.
Güvenle okunabilir ama bozuk JSON/şemalı günlük, eş kaldırmayı engellemez;
kurtarma için korunur. Güvensiz depolama veya eşleşen günlüğü geçersiz kılamama
ise kaldırmayı reddeder.

Ön plan yöneticisi tüm eşler arasında sonlu bağlantı/istek/yardımcı/tampon sınırları
paylaşır; sınırsız kuyruk kurmadan aşırı yükü reddeder. Kayıtlı eşler birlikte
12 doğrulanmış bağlantı tutabilir. Dört bağlantı yöneticinin denetimi, giden
sorguları ve yenilemesi için ayrılır. En fazla sekiz tünel alt işlemi ve iki
geçici denetim/inceleme yardımcısı, toplam on işlem vardır. Seçilen tüm eşlerin
kurulumu 30 saniyeyle sınırlıdır. Başarıdan önce son kira yenilemesi yapılır;
son ve dönemsel yenileme gruplarının süresi beş saniyedir (uygunsa genel kurulum
süresi içinde). Dönemsel bakım her on saniyede çalışır.

İptal yalnızca kendisine ait SSH yardımcılarını/dinleyicileri durdurur;
Codex daemon'larına, konuşmalara ve ilgisiz proxy'lere dokunmaz. Temizlik geri
çekilmiş tünel rotalarını da bekler. Doğrudan alt işlemin çıkışı ile doğal boru
EOF'u üç saniyelik temizlik sınırında sonuçlanmalıdır; aksi halde temizlik eksik
kalır ve yardımcı kapasitesi ayrılmış kalır. Boruları iptal etmek alt nesil
işlemlerin çıktığını kanıtlamaz. Ayrılmış veya devraldığı boruları kapatan alt
nesil işlemler izlenmez. Yardımcı stdout yakalaması 64 KiB ile sınırlıdır;
stderr yazdırılmadan/saklanmadan atılır. Yakalama taşınca yardımcı durdurulur,
atılan çıktı doğal EOF'a kadar boşaltılır. Başarılı temizlik özgün çıktı hatasını
bildirir; gerçekten eksik temizlik `cleanup_incomplete` kalır ve kapasiteyi tutar.

Aynı UID ile çalışan işlemler özel kayıt durumunu okuyabilir; makine kimlik
doğrulaması taklit edilemez ajan kimliği sağlamaz. Bu ağ geçidini atlayan yerel
trafik onun denetiminde değildir.

Mesh, pano/önbellek denetimleri, yalıtım, Claude mesajlaşması, yönetilen beceriler
ve boşta bildirimleri bu katkının kapsamı dışındadır.
