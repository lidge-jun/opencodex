---
title: Codex oturum açamıyor veya yüklenmiyor
description: opencodex uygulandıktan sonra Codex girişte takılırsa veya her istek hata verirse ne yapmalı; proxy'yi başlatmadan Codex'i kendi hesabına nasıl döndürmeli.
---

Codex giriş ekranında takılırsa, giriş gereksinimlerini yükleyemediğini
bildirirse veya opencodex kurulumundan sonra tüm model istekleri başarısız
olursa en olası neden şudur: proxy çalışmamasına rağmen Codex hâlâ opencodex
proxy'sine yöneliktir. Bu durum [#5261](https://github.com/lidge-jun/opencodex/issues/5261)
olarak bildirildi.

## Bu neden olur?

Varsayılan geri döngü kurulumunda opencodex, Codex'e ayrı bir sağlayıcı vermez.
`$CODEX_HOME/config.toml` dosyasına (Windows'ta `%USERPROFILE%\.codex`) kök
düzeyinde geçersiz kılma yazarak Codex'in yerleşik `openai` sağlayıcısını
proxy'ye yönlendirir:

```toml
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex (undo: ocx restore)
openai_base_url = "http://127.0.0.1:10100/v1"
# Auto-injected by opencodex (undo: ocx restore)
experimental_realtime_ws_base_url = "http://127.0.0.1:10100/v1"
```

Bu satırlar diskte olduğundan yeniden başlatmadan sonra da kalır. Codex
başladığında proxy çalışmıyorsa adresten yanıt gelmez ve Codex'in dönebileceği
ikinci bir uç nokta yoktur. Ekran opencodex'ten söz etmez; bu yüzden durumun
Codex sorunu sanılması kolaydır.

Proxy olağan nedenlerle çalışmıyor olabilir. Codex bütünleştirmesini uygulamak
arka plan servisi kurmaz; bunun için ayrıca `ocx service install` gerekir.
Dolayısıyla yeniden başlatma sonrasında proxy'yi başlatacak bir şey olmayabilir.
Kayıtlı bir Windows zamanlanmış görevi açılışta değil, oturum açıldığında
başlar; devre dışı bırakılmış olabilir, başlatılamayabilir veya portu başka
bir sürece kaptırabilir.

## Codex'i yeniden çalıştırma

İstediğiniz sonucu seçin. Proxy kapalıyken her iki yol da güvenle çalışır.

**Codex'i kendi hesabına ve uç noktalarına döndürün:**

```bash
ocx restore
```

Bu işlem eklenmiş yönlendirmeyi, gerçek zamanlı geçersiz kılmayı ve opencodex
katalog işaretçisini kaldırır. Çalışan proxy, kontrol paneli oturumu veya ağ
gerekmez. Sonrasında Codex normal şekilde giriş yapıp çalışır. opencodex'i
yeniden kullanmak istediğinizde `ocx restore back`, Codex'i proxy'ye tekrar
yönlendirir.

**Ya da proxy'yi yeniden başlatın:**

```bash
ocx start
ocx service install   # keep it running across restarts
```

`ocx status`, proxy'nin yanıt verip vermediğini ve Codex'in şu anda onun
üzerinden yönlendirilip yönlendirilmediğini bildirir. `ocx doctor` aynı durumu
daha ayrıntılı açıklar ve önerilen onarımı belirtir.

## ocx kullanılamıyorsa

Yönlendirmeyi elle geri alabilirsiniz. `$CODEX_HOME/config.toml` dosyasını
açıp üç şeyi silin: `openai_base_url` satırı,
`experimental_realtime_ws_base_url` satırı ve adı `opencodex-catalog.json` ile
biten herhangi bir `model_catalog_json` satırı. İlk iki satırın hemen üzerindeki
`# Auto-injected by opencodex` yorumlarını da kaldırın.

Yoruma değil, anahtar adına bakın. opencodex aynı sahiplik yorumunu yönettiği
başka anahtarların, örneğin eklenen `developer_instructions` alanının da
üzerine yazar. Bunları silmek giriş sorununu çözmez ve geri isteyebileceğiniz
yapılandırmayı kaybettirir.

`model_catalog_json` satırını tek başına değil, yönlendirmeyle **birlikte**
silin. Artık bulunmayan dosyaya işaret eden `model_catalog_json`, Codex'in
yapılandırmasını hiç yükleyememesine neden olur; bu, farklı bir nedenle aynı
kilitlenme gibi görünür.

## Eklenemeyen veya görüntülenemeyen hesaplar

Havuz hesabı ekleme hataları veya eklenmiş hesapların görünmemesi, aynı oturumda
yaşansa bile yukarıdaki kilitlenmeden ayrıdır. Hesap havuzuna proxy'nin yönetim
API'si hizmet verir; bu nedenle hem `ocx account login openai` akışı hem de
kontrol paneli listesi için önce çalışan proxy gerekir. Tarayıcı girişi ayrıca
başka porta taşınamayan sabit `http://localhost:1455/auth/callback` adresine
döner. Port 1455 başka bir süreç tarafından kullanılıyorsa veya tarayıcı
açılamıyorsa cihaz akışını kullanın:

```bash
ocx account login openai --device
```

Eklemenin ne yazdığını ve yönlendirmenin nasıl seçildiğini öğrenmek için
[Codex Bütünleştirmesi](/tr/guides/codex-integration/) sayfasına bakın.
