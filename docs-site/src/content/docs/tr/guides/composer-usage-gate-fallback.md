---
title: Mesaj alanı kullanım engeli için kuyruk seçeneği
description: OpenCodex yönlendirmesini ve masaüstü kimlik doğrulamasını değiştirmeden, sunucu kotalarını koruyarak mevcut Codex konuşmasına isteğe bağlı metin ekleme.
---

Masaüstünde **yalnızca mesaj yazma alanındaki** kullanım engeli, konuşmanın
OpenCodex rotasında kapasite olsa bile yeni girişi önleyebilir. Uyumlu kurulumda
`codex queue`, bu alanı kullanmadan Codex'in yerel app-server kuyruğuna gönderir.
Uygulamayı yamaz, TLS trafiğini yakalamaz, sertifika kurmaz, kimlik doğrulamayı değiştirmez.

Bu, **her kullanım sınırı durumunun çözümü değildir**. Tükenmiş kotayı geri
getirmez, model seçiciyi açmaz. `gpt-reserve` kullanan konuşma o modeli kullanmayı
sürdürür; metni kuyruğa almak başka sağlayıcıya geçirmez. Sunucu yetkilendirmesi,
sağlayıcı kotaları, onaylar ve konuşmanın çalıştırma ayarları geçerlidir.

## Engellenen katmanı belirleyin

Gönderimden önce mesaj alanının kapalı olması, gönderim sonrası gerçek sağlayıcı
reddinden farklıdır. Özel model etiketi bağımsız sağlayıcıyı veya kapasiteyi
kanıtlamaz. Bu seçeneği, rotası kullanılabilir olan ve bilerek seçtiğiniz konuşmada
kullanın; bekleyen onayları, etkin turları ve app-server bağlantısını ayrı kontrol edin.

Ana hesap kesin kilidi yetkili kalır. Bu, tükenme öncesi kabul korumasıdır;
tükenmiş hesabı kurtarmaz. Yardımcı korumayı kapatmaz veya konuşmanın sağlayıcısını
değiştirmez. Kuyruktaki yerel hesap isteği çalışsın diye kota yanıtlarını
değiştirmeyin veya korumayı kapatmayın.

## OpenCodex entegrasyonu ve sorumluluk

Mevcut [Codex entegrasyonu](/tr/guides/codex-integration) ve
[model yönlendirme](/tr/guides/model-routing) ayarlarını koruyun. Yol:

```text
yardımcı -> yerel Codex kuyruğu -> seçilen konuşmanın app-server'ı
         -> konuşmanın yapılandırılmış sağlayıcısı -> zaten oraya yönlendirilmişse OpenCodex
```

Yardımcılar yeni sağlayıcı yönlendiricisi uygulamaz. Yalnızca hedef ve metni
gönderir; model, hesap, hizmet katmanı, onay, sandbox veya temel URL geçersiz
kılması göndermez. OpenCodex'e yönlendirilmiş yerleşik `openai` ve özel `opencodex`
sağlayıcısı mevcut yapılandırmayı korur. Pool/Direct seçimi, hesap bağları,
sağlayıcı kimlik bilgileri ve kabul kontrolleri OpenCodex ile hizmet veren daemon'a
aittir. Kuyruk kabulü tek başına sağlayıcı çağrısını kanıtlamaz.

Masaüstü kurulumuyla **aynı `CODEX_HOME` ve uyumlu CLI/app-server** kullanın.
`CODEX_HOME` varsayılanı `~/.codex`'tir; başka ana dizin başka daemon/konuşma
deposu bulabilir. `OPENCODEX_HOME` proxy'nin dizinidir, `CODEX_HOME` yerine geçmez.
Yardımcılar iki değişkeni ve iki uygulamanın yapılandırmasını değiştirmez.
PowerShell'de yerel alt işlemler, `CODEX_HOME` göreli olsa da kabuğun dosya sistemi
konumunu devralır.

Proxy zaten çalışmalı ve konuşma amaçlanan rotayı zaten kullanmalıdır. Yardımcı
OpenCodex'i başlatmaz/eşitlemez/yeniden yapılandırmaz, kapalı entegrasyonu açmaz,
doğrudan OpenAI rotasını sessizce değiştirmez. `codexDesktopAuthless` değişimi
gerekmez. Uzak OpenCodex sağlayıcı URL'si uzak Codex app-server değildir;
yardımcılar başka bilgisayara otomatik konuşma yönlendirmesi değil, yerel daemon keşfi kullanır.

Bunlar kurulu `ocx queue` komutu veya pano denetimi değil, **isteğe bağlı depo
yardımcılarıdır**. npm paketinin dosya izin listesi `scripts/` içermez; eşleşen
depo kopyasını veya yerel `codex queue` komutunu kullanın. Bu dar kapsam, ikinci
aktarım, kalıcı dinleyici, hesap önbelleği veya kullanım sınırı izleyicisi eklemez.

## Açma/kapatma ve normal kullanım

**Kalıcı açma/kapatma anahtarı yoktur**; yardımcıyı çalıştırmak tek gönderime
katılmaktır. OpenCodex'i kurmak/güncellemek veya betikleri diskte tutmak onları çalıştırmaz.

| Durum | Davranış |
| --- | --- |
| Çağrılmadı; kota var veya tükenmiş | İşlem, zamanlayıcı, sorgulama, dinleyici veya yardımcı kaynaklı istek yoktur. |
| Kota varken normal çağrıldı | Sıradan tek mesajı kuyruğa alır. Masaüstü alanı çalışıyor diye atlamaz; gönderilince normal kullanım/ücret uygulanabilir. |
| Yalnızca mesaj alanı engelliyken çağrıldı | Aynı yerel kuyruk gönderimini dener; rota yetkili ve kullanılabilir olmalıdır. |
| Gerçek sağlayıcıda kapasite/yetki yok | Kısıtı aşmaz, sağlayıcı/hesap değiştirmez; kuyruk kabulünden sonra çalıştırma başarısız olabilir. |
| `-DryRun` / `--dry-run` | Hedef seçip CLI yardımını sorgular; metin göndermez, kota/daemon sağlığı/sağlayıcı erişimini kontrol etmez. |
| Kullanım engeli kalktı | Normal mesaj alanına dönün; geri alınacak yardımcı ayarı yoktur. |

Kullanmayı bırakmak için çağırmayı bırakın. Sırf yardımcıyı kapatmak için
`ocx restore` çalıştırmayın veya Codex entegrasyonunu kapatmayın; normal
yönlendirmeyi de değiştirir. Haricen zamanladıysanız o zamanlamayı kapatın.
Kabul edilmiş kuyruk öğeleri Codex'e aittir ve yine çalışabilir: betiği silmek,
işlemini kapatmak veya kotanın düzelmesi bunları iptal etmez. Aynı konuşmadaki
normal kuyruk denetimleriyle inceleyip kaldırın. Aynı istemi hem yardımcıdan hem
mesaj alanından göndermeyin.

## Göndermeden önce uyumluluk

Uygulamayla paketlenen CLI'yı tercih edin; PATH'teki ayrı `codex` eski olabilir.
`codex queue --help` içinde `--thread`, `--message` seçeneklerini kontrol edin.
Yardımcılar CLI yeteneğini sorgular; daemon'ın `thread/queue/add` desteğini ancak
gerçek istek doğrular. Yöntem desteklenmiyorsa eşleşen kurulumu güncellemeden veya
yeniden başlatmadan önce işi kaydedin. Yardımcılar daemon'ı yeniden başlatmaz veya
başka sunucuyla denemez. Kuyruk komutuna `--no-daemon` eklemeyin. Güncellemeler
uyumluluğu değiştirebilir.

Önce hedef konuşmayı açıp proje, model ve sağlayıcıyı doğrulayın. **Açık UUID**
tercih edin; yerel CLI tam oturum adını da kabul eder:

```powershell
codex queue --thread 'my-project-review' --message 'continue with the next step'
```

Windows yardımcısı depo kopyasından paketlenmiş yerel `codex.exe` dosyasını bulabilir:

```powershell
.\scripts\codex-queue.ps1 -Thread 'my-project-review' -Message 'continue with the next step'
```

macOS/Linux'ta Bash kullanın (macOS Bash 3.2 dahil):

```bash
bash scripts/codex-queue.sh --thread 'my-project-review' --message 'continue with the next step'
```

Eşleşen güvenilir dosyayı `-CodexExe 'C:\path\to\codex.exe'`,
`--codex '/path/to/codex'` veya `CODEX_EXE` ile sabitleyin. Açık seçim geçersizse
başka dosya sessizce seçilmez, hata verilir. Windows'ta mesaj tırnaklamasını
`cmd.exe` dışında tutmak için npm `.cmd`/PowerShell shim yerine yerel `.exe`
kullanın. Kuyruk destekli uygulama paketleri ve bağımsız yerleşimler PATH'ten önce
denenir. Otomatik PATH keşfi, mevcut projeden farkında olmadan CLI çalıştırmamak
için boş/göreli girdileri yok sayar. Güvenilir yerel dosya yine
`--codex './codex'` veya `-CodexExe '.\codex.exe'` ile açıkça seçilebilir.
Kurulum kökleri ve mutlak PATH girdileri işletmeci tarafından güvenilir olmalıdır;
yardımcı imza doğrulamaz. Keşif, uygulama sürümünün eşleştiğini kanıtlamaz.

### Özel tanılama ve isteğe bağlı son konuşma keşfi

Deneme çalıştırması varsayılan olarak dosya yollarını, konuşma UUID/adını ve mesaj
gövdesini gizler:

```powershell
.\scripts\codex-queue.ps1 -Thread 'my-project-review' -DryRun
```

Yalnızca CLI yeteneğini/hedef seçimini bildirir; sunucu doğrulamasını değil.
Eski rollout depolarında `-Latest` / `--latest`, **en son dosya sezgisine** açıkça
katılır. Seçimi görmek için yönlendirilmemiş özel terminal kullanın:

```powershell
.\scripts\codex-queue.ps1 -Latest -DryRun -ShowTarget
```

```bash
bash scripts/codex-queue.sh --latest --dry-run --show-target
```

`-ShowTarget` / `--show-target`, deneme çalıştırması ve yerel terminal çıktısı
gerektirir. Yalnızca bu açık istekle seçilen yol ve UUID/adı gösterir, kontrol
karakterlerini kaçırır, CI yakalaması gibi yönlendirilmiş çıktıyı reddeder.
Kayıtlı/paylaşılan terminalde kullanmayın veya çıktıyı yayımlamayın. Mesajı asla
yazdırmaz. Gerçek gönderimde normal Codex çıktısı geçirilir ve kimlik içerebilir;
günlük paylaşmadan önce inceleyin.

Latest keşfi `CODEX_HOME/sessions` altında değiştirilme zamanını kullanır;
eşitlikte dosya adı sırası belirler. Bu **mevcut masaüstü konuşması değildir**;
başka proje veya alt ajan seçilebilir. Yerel önizlemeyi doğrulayıp açık UUID ile
gönderin. Mesaj verilirse Latest de gönderebilir; yine bu sezgiye bilinçli katılımdır.

Tanınan `rollout-*.jsonl` adları konuşma UUID'si, bazen ardından `_<rollout-uuid>`
içerir; yardımcı ilk UUID'yi alır. Bozuk adlar atlanır. Eksik/okunamayan depo başka
ana dizin seçilmeden hata verir. Taşınmış, yalnızca sayfalı veya yalnızca uzak
konuşmaların yerel rollout'u olmayabilir; açık UUID/ad kullanın.

Mesajın tamamını tek argümanda tutun. Bash `--message '- start with this'` veya
`-- '- start with this'`; PowerShell `-Message '- start with this'` kabul eder.
Kabuk geçmişi ve yerel işlem listeleri komut metnini açığa çıkarabilir; istemlere
kimlik bilgisi koymayın.

## Kuyruğa alınmak, çalıştırılmak değildir

`Queued message ... for thread ...` yalnızca **kuyruk kabulünü** doğrular; model
çalışmasını veya tamamlanmasını değil. Meşgul konuşma mevcut turu/onayı bekleyebilir.
İncelenen üst kaynak uygulamasında yüklü olmayan kayıtlı konuşma, başka istemci
sürdürünceye kadar mesajı tutabilir.

Kuyruğu ve etkinliği **aynı konuşmada** kontrol edin. Yüklü değilse uygulamada
açın veya istemi tekrar eklemeden `codex resume <thread-id>` kullanın. Bekleyen
onayları ve kuyruğu inceleyin. Her çağrı yeni öğe yaratabilir; belirsiz hatadan
sonra yeniden denemeden önce inceleyin. Yardımcılar CLI çıkış durumunu korur,
otomatik yeniden göndermez.

Yerel CLI'nın açık `--remote` seçenekleri vardır (`codex queue --help`); bu,
masaüstü uzaktan denetim bağlantısının kullanıldığını varsaymaktan farklıdır.
Kimlik doğrulama ayarını korumak ilgisiz ağ/kimlik hatalarını onarmaz veya uzaktan
denetim sürekliliğini garanti etmez.

## Mesaj alanı olmadan iş başlatma veya sürdürme

`codex exec '<prompt>'`, açık masaüstü konuşmasına mesaj değil, etkileşimsiz yeni
iş başlatır. Çalışma dizinini, sağlayıcıyı, izinleri ve ayarları kontrol edin.
`codex resume <thread-id>` açık oturumu sürdürür. `codex resume --last` normalde
mevcut çalışma dizinine göre süzer; `--all` bunu kaldırır, diğer uygunluk
filtreleri kalabilir. Genel seçim görünür veya en yeni dosya sistemi oturumu
olmayabilir. Süren masaüstü işi için açık kimlik tercih edin.

## Kapsam ve doğrulama

Bu seçenek hesap haklarını ve uygulama dosyalarını değiştirmez. Sağlayıcıyı
tanıyan mesaj alanı/model seçici onarımı, otomatik kota kurtarma veya eski
deneylerin ilgisiz proxy/sertifika değişikliklerini temizleme özelliği değildir.

Özgün Windows denemesi (Desktop `26.917.9434.0`), canlı konuşma için kuyruk kabulü
ve var olmayan konuşma için beklenen hata bildirdi. Bu; uçtan uca model çalışması,
yüklü olmayan konuşma, uzaktan denetim veya platformlar arası garanti değildir.
Üst kaynak `7dae8c53d97e61cd774e4d6bcca5243c29ca615c` sürümünde incelendi:

- [CLI kuyruk seçenekleri](https://github.com/openai/codex/blob/7dae8c53d97e61cd774e4d6bcca5243c29ca615c/codex-rs/cli/src/queue_cmd.rs)
  ve [app-server gönderimi](https://github.com/openai/codex/blob/7dae8c53d97e61cd774e4d6bcca5243c29ca615c/codex-rs/tui/src/session_queue_commands.rs).
- [Yüklü konuşmaya kuyruk teslimi](https://github.com/openai/codex/blob/7dae8c53d97e61cd774e4d6bcca5243c29ca615c/codex-rs/ext/queue/src/service.rs)
  ve [sürdürme seçim seçenekleri](https://github.com/openai/codex/blob/7dae8c53d97e61cd774e4d6bcca5243c29ca615c/codex-rs/cli/src/main.rs).

Çevrimdışı regresyonları `node --test scripts/codex-queue.test.mjs` ile çalıştırın
(Node 20+). Sahte yerel CLI ve geçici dizinler kullanılır; gerçek hesap/model
isteği yoktur. **Codex queue helpers** iş akışı Windows PowerShell 5.1/7, macOS
sistem Bash ve Linux Bash üzerinde çalışır; gerekli kabuk eksikse sessiz atlamak
yerine hata verir. Yapılandırma koruma örnekleri yerleşik/özel sağlayıcı ayarlarını
ve iki kullanım durumunu kapsar, canlı OpenCodex yönlendirmesini değil. Gerçek
Desktop gönderimini, sağlayıcı başarısını ve uzaktan denetim sürekliliğini
desteklenen kurulumda ayrı doğrulayın.
