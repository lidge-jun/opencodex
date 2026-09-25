---
title: Uzak Çalışma Alanı
description: Codex, Claude Code, Pi ve bunların girişlerini tek OCX Hub üzerinde tutarken yalnızca OCX kurulu bilgisayarlar çalışma alanını ve derleme ortamını sağlar.
---

SSH makine bağlantıları için [Uzak Bağlantı](/tr/guides/remote-link/) kılavuzuna bakın.

Remote Workspace, bir OpenCodex Hub üzerinde kodlama ajanlarını çalıştırırken
başka bir bilgisayarın proje dosyalarını, komutları, testleri ve derleme
kaynaklarını sağlamasına olanak verir. Telefon veya üçüncü bir bilgisayar,
oturumu Hub kontrol panelinden yönetebilir.

```text
Phone browser -> Computer 1 OCX Hub -> encrypted channel -> Computer 2 OCX Executor
                 Codex / Claude / Pi                       project and commands
                 logins and sessions                      no coding CLI login
```

Executor için yalnızca OpenCodex gerekir. Codex, Claude Code, Pi, ChatGPT girişi
veya sağlayıcı API anahtarı gerekmez. Hub'a dışarı yönlü WebSocket açtığından
Executor için genel port veya yönlendiricide port yönlendirmesi gerekmez.

:::caution[Deneysel temel]
Remote Workspace isteğe bağlıdır ve üretim dağıtımı değildir. Linux dosya
araçları ve koşullu bubblewrap komut yürütmesi sunar. Windows ve macOS yalnızca
dosya araçları sunar: resmî yerel yardımcıları prob ve komut isteklerini
reddeder. Windows komutları, doğrulanmış bir yaşam döngüsü sahibi iptal sırasında
temizlik yetkisini koruyana kadar desteklenmez. Komut desteği yoksa yürütme
hiçbir zaman Hub'a aktarılmaz.
:::

## Hub kurulumu

Bilgisayar 1 tüm kodlama ajanı girişlerini ve model oturumlarını tutar.
Kullanmak istediğiniz ajanları oraya kurup giriş yapın, ardından OpenCodex'i
Hub olarak çalıştırın:

```bash
ocx config set runtimeRole hub
OCX_REMOTE_WORKSPACE_ENABLED=1 ocx start
ocx gui
```

`OCX_REMOTE_WORKSPACE_ENABLED=1` değerini Hub sürecinin kendisinde ayarlayın;
yalnızca kontrol paneli komutuna vermek çalışan servisi etkinleştirmez. Açıkça
etkinleştirilmemiş bir Hub, çalışma alanı anahtarları oluşturmadan veya kodlama
ajanı çalışma zamanlarını yoklamadan devre dışı durum döndürür.

Kontrol panelini telefon veya başka bilgisayardan açarken kimliği doğrulanmış
HTTPS dağıtımı kullanın. Desteklenen yönetim girişi ve Tailscale düzeni için
[Remote Hub Dağıtımı](/tr/guides/remote-hub/) sayfasına bakın. Kimlik doğrulaması
olmayan yerel kontrol paneli portunu yayımlamayın.

Codex Remote Workspace güncel App Server izin profillerini kullanır. Hub'ın
seçili Codex yapılandırmasında eski `sandbox_mode` veya
`sandbox_workspace_write` hâlâ ayarlıysa kontrol paneli, daha zayıf sınırla
başlatmak yerine Codex'i kullanılamaz gösterir. Özelliği kullanmadan önce
Codex profilini taşıyın; eski sandbox ile izin profilini birlikte
ayarlamayın.

## Executor eşleştirme

1. Hub kontrol panelinde **Remote Workspace** açın.
2. **Create pairing code** seçin.
3. Bilgisayar 2'de açığa çıkarmak istediğiniz proje dizinine geçin.
4. O bilgisayar için oluşturulan **Linux / macOS terminal** veya **Windows PowerShell** komutunu kopyalayın. Komut geçerli dizini eşleştirir ve `ocx remote-workspace agent` bağlantısını o terminalde açık tutar.

Eşdeğer el ile akış:

```bash
cd /path/to/project
printf '%s\n' 'ONE-TIME-CODE' | ocx remote-workspace pair 'https://your-hub.example' \
  --pairing-code-stdin --root "$PWD"
ocx remote-workspace agent
```

Windows PowerShell'de kontrol panelinin gösterdiği komutu kullanın. Eşdeğer
el ile biçim:

```powershell
$pairingCode = 'ONE-TIME-CODE'
$pairingCode | ocx remote-workspace pair 'https://your-hub.example' `
  --pairing-code-stdin --root (Get-Location).Path
if ($LASTEXITCODE -eq 0) { ocx remote-workspace agent }
```

Geçerli OCX Bun yürütülebiliri Linux sandbox'ına otomatik olarak tek salt okunur
dosya olarak eklenir. Proje sistem yolları dışında kullanıcı tarafından
kurulmuş bir araç zinciri gerektiriyorsa ev dizininin geri kalanını açmadan
onu açıkça eşleştirin:

```bash
printf '%s\n' 'ONE-TIME-CODE' | ocx remote-workspace pair 'https://your-hub.example' \
  --pairing-code-stdin --root "$PWD" \
  --toolchain-root "$HOME/.nvm/versions/node/v24/bin"
```

Yerel yardımcı kaynak kodu inceleme için paketlenmiştir. Derlemek, bu taşıma
kapsamında Windows veya macOS komutlarını etkinleştirmez. `--executor-helper`
incelenmiş yardımcı seçicisi olarak kalır; ikilinin bulunması veya yolun
ayarlanması komut desteğini kanıtlamaz.

Tek kullanımlık kod komut satırı argümanlarından değil standart girdiden okunur.
Eşleştirme yerel cihaz imzalama anahtarı ve cihaza özgü bearer oluşturur. Hub
yalnızca bunun özetini saklar ve gerçek Executor yolunu hiç almaz. Ön plandaki
ajanı Ctrl+C ile durdurun; yeniden çalıştırmak aynı cihazı bağlar.

Sırları yazdırmadan yerel kaydı denetleyin:

```bash
ocx remote-workspace status
```

## Uzak kodlama oturumu başlatma

Kontrol panelinde şunları seçin:

1. çevrimiçi bilgisayar;
2. yerel olarak onaylanan bir çalışma alanı klasörü;
3. Hub üzerindeki Codex, Claude Code veya Pi; ve
4. erişim modu.

**Read only** varsayılandır ve dizin listeleme ile dosya okuma sunar. Yazma
seçeneği yalnızca Executor komut sandbox probunu geçtiyse **Edit files and run commands**
olarak görünür; aksi halde **Edit files only** görünür. Kontrol paneli iki ayrı
konum gösterir: model ile giriş Hub'da kalır, çalışma alanı işlemleri ise
seçilen bilgisayarda çalışır.

İstemleri Bilgisayar 1, Bilgisayar 3 veya telefondaki Hub kontrol panelinden
gönderin. Oturum kendiliğinden başka bilgisayar veya klasöre geçemez.
Executor bağlantısı koparsa oturum **Executor offline** durumuna geçer ve
Hub'ın dosya sistemine dönmez.

İstem gönderimi kabulü hemen bildirir; kontrol paneli ilerleme ve tamamlanma
için oturumu yoklar. Kabul bildirimi kaybolursa taslak, gönderimin bilinmediğini
belirten bildirimle görünür kalır. Yeniden göndermeden önce oturum ilerlemesini
kontrol edin; kontrol paneli istemi hiçbir zaman otomatik yeniden denemez.

İstem sürerken **Stop** kullanılabilir. Hub kodlama ajanı turunu keser,
etkin Executor komutunu iptal eder ve geç gelen yanıtın durdurulmuş oturumu
yeniden açmasını engeller.

## Yeniden başlatma ve yeniden bağlanma davranışı

Hub sınırlı oturum meta verisini ve yakın tarihli küçük bir olay anlık
görüntüsünü saklar. Hub yeniden başladığında tamamlanmamış oturum özgün
Executor'ını bekler. Cihaz yeniden bağlanınca sonraki istem özgün Codex
görevini, Claude Code oturumunu veya Pi oturum kimliğini sürdürür.

Claude Code kalıcı geçmişini ilk tamamlanan istemde oluşturur. Hub, yeni bir
Claude oturumunda herhangi bir istem tamamlanmadan durursa sürdürülecek
konuşma yoktur; yeni oturum başlatın.

Değişmiş yetenek bildirimi mevcut oturumu sessizce zayıflatmaz. Executor komut
yalıtımını kaybederse veya kullanılabilir araçları değişirse yeni oturum
başlatın. Bilgisayarın yetkisini kaldırmak soketini kapatır ve ona bağlı
oturumları durdurur.

## Güvenlik sınırları

- Sağlayıcı kimlik bilgileri ve kodlama ajanı geçmişi Hub'da kalır.
- Executor özel anahtarları, cihaz bearer'ı ve gerçek kök yolları yalnızca sahibine açık OCX durumunda kalır.
- Eşleştirme kodu hataları her dinleyicide çekirdeğin gözlemlediği eş başına sınırlanır. On dakikadaki on başarısız kod, genel bir `429` ve `Retry-After` döndürür; Hub kaynak kimliklerin yalnızca sınırlı ve süresi dolan özetlerini tutar. Doğrudan yerel arayan kimlik başlığını taklit edebildiğinden Tailscale Serve kullanıcıları yönetim dinleyicisinin geri döngü kovasını paylaşır.
- Her çalışma oturumu Ed25519 imzalı geçici P-256 ECDH el sıkışması ve sıralı AES-256-GCM iletileri kullanır.
- İki taraf geçerli yetenek bildiriminde anlaşmadan soket çevrimiçi gösterilmez.
- Yeniden bağlanma, yerel sandbox kullanılamıyorsa yeteneği kaldırabilir; eşleştirmede kaydedilen iznin dışına yetenek ekleyemez.
- Her istek tek model görevine, cihaza, köke, erişim moduna ve yetenek kümesine bağlıdır.
- Yollar görelidir, kanonikleştirilir ve sınırlandırılır; sembolik bağlantı, junction veya üst dizine kaçışta reddedilir. Windows aygıt adları, alternatif veri akışları ve sondaki nokta/boşluk takma adları reddedilir.
- Executor işlemleri sırayla yürür, açılmış dosya kimlikleri yeniden denetlenir ve yazma özetleri atomik değiştirmeden hemen önce tekrar denetlenir. Onaylı kökü değiştirmek yeniden eşleştirme gerektirir; araç zinciri kökleri her komuttan önce yeniden doğrulanır.
- Dosya okuma/yazma sabit bağlantılı dosyaları reddeder. OCX komut yürütmeden önce en fazla 250.000 çalışma alanı girdisini tarar; dizin dışı bir girdinin birden fazla bağlantısı varsa komut yolunu kapatır. Yol sandbox'ları aynı inode'un diğer adının onaylı kök dışında olmadığını kanıtlayamaz.
- Linux komutları, tek yazılabilir çalışma alanı, temizlenmiş ortam, özel süreç ad alanları, salt okunur tek dosya olarak geçerli OCX Bun yürütülebiliri, sınırlı çıktı ve zaman aşımı ile varsayılan olarak kapalı ağ kullanan bubblewrap üzerinden çalışır. Özel yalıtım testleri açıkça yapılandırılmış barındırılan ortam gerektirir; genel paketin yeşil olması bu testlerin çalıştığını kanıtlamaz.
- macOS yalnızca dosya araçlarını sunar. Bir süreç grubu, `setsid()` çağıran alt süreci kapsayamaz; yalnızca komut başlatmak için geniş Apple Seatbelt sistem profili kullanmak ilgisiz ana bilgisayar servislerine yetki açardı. Bu nedenle yerel yardımcı, OCX'in dar ve geri alınabilir alt süreç sınırlandırma sahibi olana kadar hem probu hem doğrudan komut isteklerini reddeder.
- Windows ve macOS yerel komut istekleri güvenli biçimde reddedilir. Doğrudan yardımcı ret testleri çalışan komut yalıtımı kanıtından ayrı tutulmalıdır; Windows komut kabulü hâlâ açıktır.
- Sabitlenmiş yerel yardımcı, onaylı her yazılabilir çalışma alanının dışında olmalıdır. OCX bunu komut desteğini duyurmadan ve her komuttan hemen önce kontrol eder; böylece çalışma alanı kodu sonraki sandbox'ı uygulayan ikiliyi değiştiremez.
- Oturumu durdurmak etkin Executor komutunu iptal eder ve Hub model sürecini ve geri döngü araç köprüsünü temizler. Windows sahiplenilmiş npm sarmalayıcı süreç ağacını durdurup Node çocuğunu bırakmaz; Linux ve macOS CLI yalnızca düzgün durdurma penceresini yok sayarsa zorla durdurulur.

Kodlama ajanını çalıştırdığı için Hub istemleri ve model çıktısını bilerek görür.
Uçtan uca şifreleme Executor RPC yüklerini korur. Eşleştirilmiş Hub'ın, kimliği
doğrulanmış WSS üzerinden onaylı kökleri seçmesine güvenilir; kendi model
konuşmasına kör değildir.

## Geçerli kapsam

Remote Workspace kimlik bilgilerini başka bilgisayarlara kopyalamaz veya
eşitlemez. Remote Hub sağlayıcı yönlendirmesinden ve gelecekteki barındırılan
işlem veya Super Sync ürünlerinden ayrıdır. Üretim sürümü için yine imzalı
Windows yardımcı paketlemesi, tam ikililerde yerel CI kanıtı, bağımsız bakım
sorumlusu incelemesi ve gerçek üç bilgisayarlı kabul çalışması gerekir.

## İstem kabul API'si

`POST /api/remote-workspace/sessions/:id/prompt`, kabul edilmiş oturum anlık
görüntüsüyle HTTP 202 döndürür. Oturum kimliği ve monoton olay sırası kabul
anlık görüntüsünü tanımlar; 202 model turunun tamamlandığı anlamına gelmez.
Sonraki olaylar ve son durum için `GET /api/remote-workspace/sessions` yoklayın.
Yeniden bağlanma ve çalışma zamanı sürdürme, o tur etkin olduğu sürece meşgul
kalır. Kayıp bir kabul bildirimi kabulü belirsiz bırakır; istemciler yeniden
gönderme kararı vermeden önce yoklamalıdır.
