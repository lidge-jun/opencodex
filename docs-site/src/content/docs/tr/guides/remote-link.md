---
title: Uzak Bağlantı
description: OpenCodex Home bilgisayarını bir Child bilgisayarına SSH üzerinden bağlayın.
---

Makine bağlantısı, bir OpenCodex **Home** bilgisayarını bir **Child** bilgisayarına SSH üzerinden bağlar. Home, Child'a SSH tüneli üzerinden hizmet verir; iki bilgisayar da yerel OpenCodex hizmetini `10100` portunda tutar. Kontrol paneli Child'a özel bağlantı anahtarını SSH üzerinden aktarır, bu nedenle bir belirteç yazmanız gerekmez.

## Gereksinimler

- Home bilgisayarı, Child bilgisayarına OpenSSH anahtarıyla giriş yapabilir.
- Child tarafından başlatılan bağlantı için Child, Home bilgisayarına OpenSSH anahtarıyla giriş yapabilmelidir (parola girişi desteklenmez).
- Child bilgisayarında OpenCodex 2.66.0 veya sonrası kuruludur (Child tarafından başlatılan bağlantıda Home üzerinde de).
- Her iki bilgisayar da macOS veya Linux çalıştırır.
- Bağlantı Home tarafından başlatılır: kontrol paneli Home bilgisayarının kendisinde (bağımsız kurulumda tarayıcı veya masaüstü uygulaması) ya da eşleştirilmiş bir Hub oturumu üzerinden açılır.

Parolalı SSH ve Windows mevcut akışın dışındadır. Bu sürümde bir bilgisayarı kontrol panelinden Child olarak bağlamak (Child tarafından başlatılan bağlantı) kullanılamaz: katılmak o bilgisayardaki OpenCodex'i yeniden başlatır ve çalışan Codex bağlantılarını keser; bu yüzden kontrol panelinde **Çocuk** rolü kullanılamaz. Desteklenen yol, Home tarafından başlatılan bağlantıdır: Home olacak bilgisayarda **Home** seçeneğini seçin ve diğer bilgisayarı aşağıda anlatıldığı gibi Child olarak ekleyin.

## `#remote` üzerinden Child ekleme

1. Kontrol panelinde `#remote` sayfasını açın ve Remote Link'i açın.
2. **Home** seçeneğini seçin, ardından **Continue** düğmesine basın. SSH ana bilgisayar listesi açılır.
3. SSH adaylarından bir ana bilgisayar seçin veya SSH yapılandırmasındaki diğer adı girin.
4. Bağlantı testini çalıştırın ve gösterilen ana bilgisayar parmak izini bağlanmak istediğiniz bilgisayarın parmak iziyle karşılaştırın. Karşılaştırma, SSH ana bilgisayara güvenmeden önce yanlış bilgisayarı veya değişmiş anahtarını fark etmenize yardımcı olur.
5. Parmak izini onaylayın, ardından Child'ı bağlayın.

Kontrol paneli belirteç girmenizi istemez. Önce ana bilgisayarı yoklar ve parmak izini açıkça onaylamadan bağlantıyı uygulamaz.

## Bağlantı durumu

- **Connected**, SSH tünelinin hazır ve Child'ın Home bağlantısını kullanabilir olduğu anlamına gelir.
- **Reconnecting**, tünelin yeniden denendiği anlamına gelir. Yeniden deneme sırasında istekler geçici olarak `Retry-After` ile birlikte `503` döndürebilir.
- **Failed**, bağlantının ilgilenilmesi gerektiği anlamına gelir. SSH kimlik doğrulamasını, onaylanan ana bilgisayar anahtarını, yönlendirmeyi veya zaman aşımı nedenini kontrol edin.

Bağlantı başarısız olduğunda sistem sessizce yerel bir sağlayıcıya geçmez.

## Child'ı kaldırma

Child için **Disconnect** seçeneğini seçin ve diğer adı onaylayın. Home tüneli durdurur, Child'ın bağlantı anahtarını iptal eder ve kayıtlı bağlantı kaydını kaldırır.

Home, bağlantıyı kesme komutunu çalıştırmak için Child'a ulaşamıyorsa **Remove here only** seçeneğini seçin. Bu işlem yalnızca bu bilgisayardaki tüneli, anahtarı ve kaydı kaldırır. Ardından Child'a giriş yapıp şunu çalıştırın:

```bash
ocx disconnect
```

Child tarafından başlatılan bağlantıyı kesmek için Child üzerinde `ocx disconnect` komutunu çalıştırın. Komut istemci tünelinin bağlantısını keser ve SSH üzerinden Home üzerindeki bağlantıyı iptal eder. Home üzerindeki iptal başarısız olursa şu mesajı yazdırır: `Home revoke failed; run ocx link revoke --link-id <linkId> on the home.`

## Güvenlik

Child, bağlantı üzerinden Home bilgisayarının sağlayıcılarını ve sağlayıcı kimlik bilgilerini kullanır. Home her Child için ayrı bir bağlantı anahtarı oluşturur; bağlantıyı kaldırmak bu anahtarı iptal eder. Onaylamadan önce ana bilgisayar parmak izini karşılaştırarak yanlış bilgisayarı veya değiştirilmiş anahtarı kabul etmediğinizden emin olun. Tailscale kimliğiyle verilen kontrol paneli oturumları makine bağlantılarını yönetemez.

## CLI başvurusu

```text
ocx link port [--json]
ocx link issue --alias <alias> --tunnel-port <port> [--json]
ocx link status [--json]
ocx link revoke --link-id <id> [--json]
```

## İlgili kılavuzlar

- [Remote Hub Dağıtımı](/tr/guides/remote-hub/)
- [Uzak Çalışma Alanı](/tr/guides/remote-workspace/)
