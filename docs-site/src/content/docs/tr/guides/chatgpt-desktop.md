---
title: ChatGPT Masaüstü Gönderme Kilidini Açma
description: Hesabın kullanım kotası bittiğinde ChatGPT masaüstü uygulamasının yazma alanını kullanılabilir tutar (macOS, isteğe bağlı).
---

Oturum açılmış ChatGPT hesabının kullanım kotası bittiğinde ChatGPT masaüstü uygulaması gönder
düğmesini devre dışı bırakır; opencodex'in model çağrılarını başka sağlayıcılara yönlendirdiği
konuşmalarda bile. Bu isteğe bağlı macOS entegrasyonu yazma alanını kullanılabilir tutar. Varsayılan
olarak kapalıdır.

## Neyi değiştirir

opencodex, `chatgpt.com` için yerel bir TLS dinleyicisi çalıştırır. Uygulama, `chatgpt.com`'u bu
dinleyiciye yönlendiren bir Chromium anahtarıyla başlatılır; alt alan adları dahil diğer tüm ana
bilgisayarlar normal yollarını korur. İstekler uygulamanın kendi kimlik bilgileriyle gerçek
`chatgpt.com`'a aktarılır; WebSocket bağlantıları (sesli dikte gibi) da aktarılır. Hiçbir şey
kaydedilmez veya saklanmaz.

Yanıtlar iki uç nokta dışında değiştirilmeden geçer:

- konuşma meta verileri (`/backend-api/conversation/init` ve konuşma akışı): kullanım kotasından
  kaynaklanan gönderme kilitleri kaldırılır;
- kullanım anlık görüntüsü (`/backend-api/wham/usage`): "sınıra ulaşıldı" geçidi açılır.

Abonelik gerekmesi gibi başka nedenli gönderme kilitleri korunur ve `ocx chatgpt status` tarafından
listelenir. Gösterilen kullanım (yüzdeler, sıfırlanma zamanları, afişler) hiçbir zaman değiştirilmez
ve OpenAI sunucuları kendi isteklerinde tüm sınırları uygulamaya devam eder.

## Kurulum

1. Özelliği `~/.opencodex/config.json` içinde açın ve opencodex'i yeniden başlatın:

   ```json
   { "chatgptDesktop": { "unblockSend": true } }
   ```

   Dinleyici, proxy bağlantı noktasının 200 fazlasını kullanır (varsayılan `10300`). Başka bir bağlantı
   noktası seçmek için `chatgptDesktop.port` ayarını yapın.

2. Yerel sertifika yetkilisine bir kez güvenin. Komut oturum açma parolanızı ister; bu yüzden kendiniz
   çalıştırın:

   ```bash
   security add-trusted-cert -r trustRoot -p ssl \
     -k ~/Library/Keychains/login.keychain-db ~/.opencodex/claude-intercept/ca.pem
   ```

   Bu güven olmadan uygulama hesap, kullanım ve ayarlar sayfalarını yükleyemez. Özel bir opencodex
   dizini kullanıyorsanız `ocx chatgpt status`, kurulumunuza uygun tam komutu yazdırır.

3. Uygulamayı opencodex üzerinden başlatın:

   ```bash
   ocx chatgpt launch
   ```

4. İsteğe bağlı: Dock ve Spotlight'tan yapılan normal başlatmaların da yolu kullanmasını sağlayın:

   ```bash
   ocx chatgpt install-watcher
   ```

   İzleyici, uygulama her başladığında çalışır. opencodex çalışırken uygulama normal şekilde açıldıysa,
   başlatmanın hemen ardından uygulamayı kapatır ve yolla yeniden açar. Kullanımda olan bir uygulamaya
   asla dokunmaz ve opencodex çalışmıyorken hiçbir şey yapmaz. Komut onay ister; `--yes` etkileşimsiz
   onay verir.

## Ağ kurulumları

VPN veya proxy kuralı gerekmez. Varsayılan modda başlatma bağımsız değişkenleri, uygulama her
başladığında sistem proxy'sine göre seçilir:

| Kurulum | Uygulamanın başlatıldığı bağımsız değişkenler |
|---|---|
| Proxy yok | Yalnızca `chatgpt.com` yolu. |
| Sistem proxy modunda VPN | Yol, doğrudan bağlantı yedeği olan sistem proxy'si ve yalnızca `chatgpt.com` için atlama. |
| TUN modunda VPN | Yalnızca yol; geri döngü trafiği tünele hiç girmez. |
| PAC dosyası | Yalnızca yol. PAC dosyası `chatgpt.com`'u proxy'de tutabilir, bu yüzden yazma alanı kilitli kalabilir, ancak başka hiçbir şey bozulmaz. |

opencodex, diğer tüm giden trafiği gibi, gerçek `chatgpt.com`'a kendi `proxy` ayarı üzerinden ulaşır.

## opencodex durduğunda uygulamayı çalışır tutma

Varsayılan modda yönlendirilmiş bir uygulama dinleyiciye bağlıdır: opencodex durduğu sürece
`chatgpt.com` istekleri başarısız olur. PAC yedeği bunun yerine uygulamayı oluşturulan bir PAC
dosyasıyla başlatır; böylece uygulama kendiliğinden yedek yola geçer:

```json
{ "chatgptDesktop": { "unblockSend": true, "pacFallback": true } }
```

`pacFallback` yalnızca `unblockSend` ile birlikte etkilidir. Bu durumda opencodex dinleyici portunun
bir fazlasını da (varsayılan `10301`) dinler ve her başlangıçta ana dizinindeki `chatgpt-unblock.pac`
dosyasını yeniden yazar. PAC, `chatgpt.com`'u önce opencodex'e, diğer tüm sunucuları ise sistemin
yönlendirdiği şekilde gönderir:

| Kurulum | Diğer sunucular ve opencodex durmuşken `chatgpt.com` |
|---|---|
| Proxy yok ya da TUN modunda VPN | Doğrudan. |
| Sistem proxy modunda VPN | Sistem proxy'si, ardından doğrudan. |
| PAC dosyası | Oluşturulan dosyaya gömülü sistem PAC'i. |

opencodex durduğunda uygulama yeniden başlatılmadan bu yoldan çalışmaya devam eder; yalnızca gönderme
kilidinin kaldırılması opencodex geri gelene kadar durur. Yol, opencodex başlarken alınır: VPN modunu
değiştirdikten sonra opencodex'i yeniden başlatın ve `ocx chatgpt launch` çalıştırın. O anda bir
sistem PAC'i ayarlı olduğu hâlde okunamıyorsa diğer sunucular doğrudan gider ve opencodex bir uyarı
yazdırır.

`pacFallback`'i açıp kapattıktan sonra opencodex'i yeniden başlatın, `ocx chatgpt launch` çalıştırın
ve izleyiciyi kullanıyorsanız `ocx chatgpt install-watcher` komutunu yeniden çalıştırın.

## Durumu kontrol etme

```bash
ocx chatgpt status
```

Özelliğin açık olup olmadığını, bağlantı noktasındaki dinleyicinin opencodex'e ait olup olmadığını,
sertifikanın güvenilir olup olmadığını, izleyici durumunu, çalışan uygulamanın yolu taşıyıp taşımadığını
ve bilerek korunan gönderme kilitlerini bildirir.

## Kapatma

```bash
ocx chatgpt uninstall-watcher
ocx chatgpt restore
```

`restore`, yönlendirilmiş bir uygulamayı yerel ağ ile yeniden açar. Ardından
`chatgptDesktop.unblockSend` değerini `false` yapın ve opencodex'i yeniden başlatın. Sertifika
yetkilisi opencodex'in Claude entegrasyonlarıyla paylaşılır; güvenini yalnızca ikisini de
kullanmıyorsanız kaldırın.

## Sorun giderme

- **Hesap, kullanım veya ayarlar sayfaları yüklenmiyor:** sertifika güvenilir değil. 2. adımı tekrar
  çalıştırın; `ocx chatgpt status` güven durumunu gösterir.
- **Gönder düğmesi hâlâ gri:** `ocx chatgpt status` çıktısına bakın. Uygulama yol olmadan çalışıyor
  olabilir (`ocx chatgpt launch` çalıştırın) ya da kilidin nedeni kullanım kotası değildir ve
  "send blocks kept" altında listelenir.
- **opencodex durduktan sonra uygulama hiçbir şey yükleyemiyor:** varsayılan modda yönlendirilmiş bir
  uygulama dinleyiciye bağlıdır. opencodex'i yeniden başlatın ya da `ocx chatgpt restore` çalıştırın;
  PAC yedeğini açarsanız uygulama kendiliğinden yedek yola geçer.
