---
title: Uzak Bağlantı
description: OpenCodex Home bilgisayarını bir Child bilgisayarına SSH üzerinden bağlayın.
---

Makine bağlantısı, bir OpenCodex **Home** bilgisayarını bir **Child** bilgisayarına SSH üzerinden bağlar. Home, Child'a SSH tüneli üzerinden hizmet verir; iki bilgisayar da yerel OpenCodex hizmetini `10100` portunda tutar. Kontrol paneli Child'a özel bağlantı anahtarını SSH üzerinden aktarır, bu nedenle bir belirteç yazmanız gerekmez.

## Gereksinimler

- Home bilgisayarı, Child bilgisayarına OpenSSH anahtarıyla giriş yapabilir.
- Child tarafından başlatılan bağlantı için Child, Home bilgisayarına OpenSSH anahtarıyla giriş yapabilmelidir (parola girişi desteklenmez).
- Child bilgisayarında OpenCodex kuruludur.
- Her iki bilgisayar da macOS veya Linux çalıştırır.
- Home kontrol panelinde tam bir eşleştirilmiş oturum vardır.

Parolalı SSH ve Windows mevcut akışın dışındadır. Child üzerinden bağlantı başlatmak için bağımsız çalışan Child kontrol panelinde **Çocuk** → **Home'u bul** seçeneklerini izleyin, Home için SSH ana bilgisayarını seçin, ana bilgisayar anahtarı parmak izini kontrol edip onaylayın ve ardından **Çocuk olarak bağlan** seçeneğini seçin. Child, Home bilgisayarına SSH anahtarıyla giriş yapabilmelidir (parola girişi desteklenmez) ve Home üzerinde `ocx` çalışıyor olmalıdır. İstemci tüneli portu `1024` veya daha yüksek olmalıdır. Katılma işleminden sonra Child yeniden başlar ve Home bilgisayarına bağlanır. Bu seçenek yalnızca standalone çalışma zamanında kullanılabilir.

## `#remote` üzerinden Child ekleme

1. Kontrol panelinde `#remote` sayfasını açın ve Remote Link'i açın.
2. **Home** seçeneğini seçin.
3. **Add child** seçeneğini seçin.
4. SSH adaylarından bir ana bilgisayar seçin veya SSH yapılandırmasındaki diğer adı girin.
5. Bağlantı testini çalıştırın ve gösterilen ana bilgisayar parmak izini bağlanmak istediğiniz bilgisayarın parmak iziyle karşılaştırın. Karşılaştırma, SSH ana bilgisayara güvenmeden önce yanlış bilgisayarı veya değişmiş anahtarını fark etmenize yardımcı olur.
6. Parmak izini onaylayın, ardından Child'ı bağlayın.

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
