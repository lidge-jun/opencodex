---
title: Uzak Bağlantı
description: OpenCodex Home bilgisayarını bir Child bilgisayarına SSH üzerinden bağlayın.
---

Makine bağlantısı, bir OpenCodex **Home** bilgisayarını bir **Child** bilgisayarına SSH üzerinden bağlar. Home, Child'a SSH tüneli üzerinden hizmet verir; iki bilgisayar da yerel OpenCodex hizmetini `10100` portunda tutar. Kontrol paneli Child'a özel bağlantı anahtarını SSH üzerinden aktarır, bu nedenle bir belirteç yazmanız gerekmez.

## Gereksinimler

- Home bilgisayarı, Child bilgisayarına OpenSSH anahtarıyla giriş yapabilir.
- Child tarafından başlatılan bağlantı için Child, Home bilgisayarına OpenSSH anahtarıyla giriş yapabilmelidir (parola girişi desteklenmez).
- Child bilgisayarında OpenCodex 2.66.0 veya sonrası kuruludur (Child tarafından başlatılan bağlantıda Home üzerinde de).
- Bilgisayarlar macOS, Linux veya Windows x64 kullanabilir. Windows için OpenSSH Server ve Windows PowerShell gerekir; Git Bash ve curl gerekmez.
- Home üzerinden Child ekleyen kontrol paneli Home üzerinde ya da eşleştirilmiş bir Hub oturumunda açılır. Geçerli bilgisayarı Child'a dönüştürmek için operatörün eşleştirdiği bir kontrol paneli oturumu gerekir; kimlik bilgisi olmadan oluşturulan yerel oturum bu yönlendirme değişikliğini onaylayamaz.

Parolalı SSH desteklenmez. Bağlantı Home veya Child üzerinden başlatılabilir. Windows aynı doğrulanmış OpenSSH bağlantısı üzerinden PowerShell çalıştırır.

## `#remote` üzerinden Child ekleme

1. Kontrol panelinde `#remote` sayfasını açın ve Remote Link'i açın.
2. **Home** seçeneğini seçin, ardından **Continue** düğmesine basın. SSH ana bilgisayar listesi açılır.
3. SSH adaylarından bir ana bilgisayar seçin veya SSH yapılandırmasındaki diğer adı girin.
4. Bağlantı testini çalıştırın ve gösterilen ana bilgisayar parmak izini bağlanmak istediğiniz bilgisayarın parmak iziyle karşılaştırın. Karşılaştırma, SSH ana bilgisayara güvenmeden önce yanlış bilgisayarı veya değişmiş anahtarını fark etmenize yardımcı olur.
5. Parmak izini onaylayın, ardından Child'ı bağlayın.

Kontrol paneli belirteç girmenizi istemez. Önce ana bilgisayarı yoklar ve parmak izini açıkça onaylamadan bağlantıyı uygulamaz.

Child ekleme penceresi, Child’ın bu Home’un sağlayıcılarını SSH üzerinden kullandığını ve yukarıdaki gereksinimleri açıklar. Takma adlar, tarayıcıyı gösteren bilgisayardan değil, OpenCodex’i çalıştıran Home üzerindeki `~/.ssh/config` dosyasından gelir. Tarama başarılı olup hiç ana bilgisayar bulunamazsa aşağıdaki gibi bir `Host` girdisi ekleyip yeniden tarayın. Mevcut bir takma adı elle de girebilirsiniz; seçim veya giriş bağlantı testini etkinleştirir. Pencerede bu kılavuza bağlantı bulunur.

```sshconfig
Host devbox
  HostName devbox.example.com
  User you
  IdentityFile ~/.ssh/id_ed25519
```

Tarama başarısız olursa boş liste yerine yükleme hatası, mevcut neden ve yeniden deneme eylemi gösterilir. Bağlantı testinin nedeni ve temizlenmiş SSH ipucu yalnızca etkin pencerede görünür, arkasında yinelenmez. Nedeni ve gerektiğinde aşağıdaki SSH tanılamasını kontrol edip yeniden deneyin. Yeniden tarama girilen takma adı korur ancak bağlantıdan önce parmak izinin yeniden incelenmesini gerektirir.

## Bu bilgisayarı Child olarak bağlama

Home'un sağlayıcılarını kullanacak bilgisayarda:

1. Kontrol panelinde `#remote` sayfasını açın ve Remote Link'i açın.
2. **Child** seçeneğini seçin. SSH ana bilgisayar listesi açılır.
3. Home'un SSH ana bilgisayarını seçin, bağlantı testini çalıştırın, ardından ana bilgisayar parmak izini karşılaştırıp onaylayın.
4. Uyarıyı okuyun ve **Connect as Child** seçeneğini seçin.

Bağlanmak bu bilgisayardaki OpenCodex'i yeniden başlatır. Zaten çalışan Codex istekleri önce tamamlanır ve yeniden başlatma sırasında yeni istekler bir dakikaya kadar başarısız olabilir. Ardından kontrol paneli kendiliğinden yeniden yüklenir ve Child bağlantısını gösterir. Codex bu bilgisayarda `http://127.0.0.1:<port>/v1` adresini kullanmaya devam eder ve belirteç veya ortam değişkeni ayarlamanız gerekmez: yerel OpenCodex her isteği Home'a aktarır, Home da kendi sağlayıcıları ve hesaplarıyla yanıt verir.

**Child** önce bu bilgisayarı eşleştirmenizi istiyorsa bu bilgisayarın yapılandırılmış HTTP geri döngü IP adresindeki kontrol panelini açın; örneğin `http://127.0.0.1:<configured-port>`. Yerel eşleştirme formu yalnızca eşleştirme eksik olduğunda ve kontrol paneli ile API aynı geri döngü kaynağını kullandığında görünür. Formdaki `ocx gui pair --origin "http://127.0.0.1:<configured-port>"` komutunu kopyalayıp bu bilgisayarın terminalinde çalıştırın, ardından tek kullanımlık kodu forma yapıştırın. Formda gösterilen kaynak adresini aynen kullanın; sağlayıcı API anahtarı veya yönetici belirteci eşleştirme kodu değildir. Eksik eşleştirme ile yapılandırılmış bağlantı noktası uyuşmazlığı farklı nedenlerdir.

**Child** rolü ayrıca OpenCodex'in bağımsız çalışma modunda, yapılandırılmış bağlantı noktasında çalışmasını gerektirir, çünkü Child tam olarak o bağlantı noktasında yeniden başlar. Kontrol paneli OpenCodex'in yapılandırılmış bağlantı noktasında çalışmadığını söylerse önce onu o bağlantı noktasında yeniden başlatın.

## Bağlantı durumu

- **Connected**, SSH tünelinin hazır ve Child'ın Home bağlantısını kullanabilir olduğu anlamına gelir.
- **Reconnecting**, tünelin yeniden denendiği anlamına gelir. Yeniden deneme sırasında istekler geçici olarak `Retry-After` ile birlikte `503` döndürebilir. Kendi panosundan bağlanan bir Child üzerinde istek önce tünelin geri gelmesi için en fazla 15 saniye bekler.
- **Failed**, bağlantının ilgilenilmesi gerektiği anlamına gelir. SSH kimlik doğrulamasını, onaylanan ana bilgisayar anahtarını, yönlendirmeyi veya zaman aşımı nedenini kontrol edin. SSH tünelini açan taraf (eklediği Child için Home, kendi panosundan katıldığı bağlantı için Child); uyku, kesinti veya yeniden başlatmadan sonra kendiliğinden yeniden dener: zaman aşımı veya yönlendirme hatasından sonra bir dakika sonra, ardından her yeni başarısızlıkta bekleme ikiye katlanarak en fazla beş dakikada bir; kimlik doğrulama hatasından sonra beş dakikada bir. Değişmiş bir ana bilgisayar anahtarı asla yeniden denenmez. Hemen yeniden denemek için Home panosunda **Retry** düğmesini seçin veya Home üzerinde `ocx link reconnect --link-id <id>` komutunu çalıştırın. Bu, OpenCodex'i yeniden başlatmadan yalnızca o bağlantının tünelini yeniden başlatır.

Bağlantı başarısız olduğunda sistem sessizce yerel bir sağlayıcıya geçmez.

## Child'ı kaldırma

Child için **Disconnect** seçeneğini seçin ve diğer adı onaylayın. Home tüneli durdurur, Child'ın bağlantı anahtarını iptal eder ve kayıtlı bağlantı kaydını kaldırır.

Home, bağlantıyı kesme komutunu çalıştırmak için Child'a ulaşamıyorsa **Remove here only** seçeneğini seçin. Bu işlem yalnızca bu bilgisayardaki tüneli, anahtarı ve kaydı kaldırır. Ardından Child'a giriş yapıp şunu çalıştırın:

```bash
ocx disconnect
```

Child tarafından başlatılan bağlantıyı kesmek için Child üzerinde `ocx disconnect` komutunu çalıştırın. Komut istemci tünelinin bağlantısını keser ve SSH üzerinden Home üzerindeki bağlantıyı iptal eder. Home üzerindeki iptal başarısız olursa şu mesajı yazdırır: `Home revoke failed; run ocx link revoke --link-id <linkId> on the home.`

## Güvenlik

Child, bağlantı üzerinden Home bilgisayarının sağlayıcılarını ve sağlayıcı kimlik bilgilerini kullanır. Home her Child için ayrı bir bağlantı anahtarı oluşturur; bağlantıyı kaldırmak bu anahtarı iptal eder. Onaylamadan önce ana bilgisayar parmak izini karşılaştırarak yanlış bilgisayarı veya değiştirilmiş anahtarı kabul etmediğinizden emin olun. Tailscale kimliğiyle verilen kontrol paneli oturumları makine bağlantılarını yönetemez. Child üzerinde anahtar OpenCodex içinde kalır: Codex veya Claude Code'un Child üzerinde gönderdiği kimlik bilgileri Home'a iletilmez ve Child üzerinde `127.0.0.1:<port>` adresine ulaşan her program Home'u anahtarsız kullanır; bu, bağımsız bir kurulumun yerel programlara verdiği güvenle aynıdır. Başka sitelerden gelen web sayfaları reddedilir.

## CLI başvurusu

```text
ocx link probe <alias> [--json]
ocx link add <alias> [--expect-fingerprint SHA256:…] [--json]
ocx link port [--json]
ocx link issue --alias <alias> --tunnel-port <port> [--json]
ocx link status [--json]
ocx link revoke --link-id <id> [--json]
ocx link reconnect --link-id <id> [--json]
ocx link check (--link-id <id> | --all) [--no-wait] [--json]
ocx link update (--link-id <id> | --all) --yes [--no-wait] [--json]
ocx link sync (--link-id <id> | --all) [--no-wait] [--json]
ocx link sync --link-id <id> (--restart-app-server-only | --restart-codex --yes) [--no-wait] [--json]
ocx link restart-codex --link-id <id> [--scope app-server|codex] --yes [--no-wait] [--json]
```

TTY olmayan kullanımda `--expect-fingerprint` zorunludur. Etkileşimli bir terminalde sunulan parmak izini açıkça onaylayarak bu seçeneği atlayabilirsiniz.

Home üzerinde `ocx link check (--link-id <id> | --all)`, Home'un eklediği her Child için kurulu sürümü, kurulum türünü ve güncelleme yolunu okur: bağlantının SSH oturumu üzerinden Child'ın `ocx update --plan` komutunu çalıştırır (Child başına 60 saniye, aynı anda üç tane); bu komut yalnızca bir plan hesaplar, hiçbir şeyi değiştirmez. 2.97.0'dan eski bir Child `owner-action` (`legacy-ocx`) olarak görünür; sürümü macOS ve Linux'ta salt okunur bir SSH çağrısıyla daha, Windows'ta ise bağlantı üzerinden bildirdiği sürümden alınır. Child tarafından başlatılan bağlantılar ve `ocx-child` Child'ları SSH olmadan raporlanır. `ocx link status --json` her satıra bir `child` bloğu (sürümler, sürüm farkı, katalog güncelliği, etkinlik, son işlem) ekler. Ayrıntılar ve çıkış kodları: [Child install, catalog and activity](/guides/remote-link/#child-install-catalog-and-activity) (İngilizce).

### Child'ları Home'dan yönetmek

`ocx link sync`, `ocx link restart-codex` ve `ocx link update`, Home'un eklediği Child'larda bağlantının SSH bağlantısı üzerinden çalışır ve işi JSON olarak yazdırır. `sync`, sabitlenmiş `ocx sync --expect-link` komutunu çalıştırır (Child 2.93.0 veya üstü). `restart-codex` önce eşitler, ardından çalışan Codex'in güncel kataloğu yüklemesi için Child'daki Codex app-server süreçlerini yeniden başlatır; `--scope codex` masaüstü uygulamasını da yeniden açar. Yeniden başlatma tek bir bağlantıyı hedefler; `restart-codex` ve `--restart-codex` için `--yes` gerekir, `ocx link sync --link-id <id> --restart-app-server-only` ise app-server süreçlerini onay istemeden yeniden başlatır. Home o Child için bir model isteği aktarırken yeniden başlatma atlanır (`restart-skipped:link-active`). 2.69'dan eski bir Child'da akış olmayan bir istek ancak yanıtı başladığında görülür. `update --yes`, Child'ın kendi güncelleyicisiyle Child'ın OpenCodex sürümünü bu Home'un sürümüne getirir, asla başka bir sürüme değil (Child 2.97.0 veya üstü; npm ve pnpm kurulumları Node başlatıcısı üzerinden güncellenir, bu yüzden `ocx link check` orada salt okunur `node --version` da çalıştırır). Her seferinde bir Child güncellenir; başarılı, başarısız veya geri alınmış bir uygulamadan sonra yeniden eşitlenir. Sonucu bilinmeyen bir uygulama tekrarlanmaz ve eşitlenmez; `ocx link check` ile denetleyin. O Child için aktarılan istekler sona erer. Windows Child'ları yalnızca `sync` destekler; `ocx-child` Child'ları yeniden başlatmayı ve güncellemeyi desteklenmiyor olarak bildirir. CLI, loopback'e bağlı bir Home gerektirir; başka bir Home'da bu işlemler kullanılamaz ve panoda da bu işlemler yoktur. Ayrıntılar ve çıkış kodları: [Operating Children from the Home](/guides/remote-link/#operating-children-from-the-home) (İngilizce). Bu koruma en iyi çaba esaslıdır: kontrol ile yeniden başlatma arasında başlayan bir istek yine de sonlandırılabilir; turların korunması gerekiyorsa o Child'da yeni istekleri duraklatın. `ocx sync --restart-children` (veya `--restart-children=codex --yes`), bir Home eşitlemesi dağıtılırken aynı kuralı tüm Child'lara ya da `--child <linkId>` ile belirtilenlere uygular: her Child eşitlenir ve aktarılan bir istek sürerken yalnızca yeniden başlatması atlanır (`restart-skipped:link-active`).

Size ait olmayan bir makineyi bağlamayın: Home orada sizin SSH anahtarınızla komut çalıştırır.

## İlgili kılavuzlar

- [Remote Hub Dağıtımı](/tr/guides/remote-hub/)
- [Uzak Çalışma Alanı](/tr/guides/remote-workspace/)


`ocx link probe <alias> --json` · `ocx link add <alias> --expect-fingerprint SHA256:… --json` — [CLI, restart, relay verification and recovery](/guides/remote-link/#add-a-child-from-the-terminal).
