---
title: Hızlı Başlangıç
description: "opencodex’i kurun, ilk sağlayıcınızı ekleyin ve kullandığınız kodlama aracını bağlayın: Codex, Claude Code, Claude Desktop, Grok Build veya desteklenen başka bir araç."
---

Bu kılavuz, yeni kurulumdan kullandığınız kodlama aracındaki ilk isteğe kadar size yol gösterir. 1. ve 2. adımlar tüm araçlar için aynıdır; 3. adımda her araç için kısa bir bölüm vardır. [İstemci desteği sayfası](/tr/reference/client-support/) araçları ve bağlantı yöntemlerini listeler.

## 1. Kurulum sihirbazını çalıştırın

```bash
ocx init
```

`ocx init` adım adım size rehberlik eder:

1. **Bir sağlayıcı seçin** — yerleşik kayıt defterindeki 106 önayardan birini
   veya bir temel URL ile adaptör yazmak için `custom` seçeneğini belirleyin.
2. **API anahtarı** — bir anahtar yapıştırın veya `${ANTHROPIC_API_KEY}` gibi
   bir ortam değişkenine başvurun.
3. **Varsayılan model** — anahtar, yerel ve özel sağlayıcılar için önayarı kabul
   edin veya bir model kimliği girin.
4. **Proxy portu** — varsayılan olarak `10100`.
5. **Codex'e enjekte edilsin mi?** — normal bir geri döngü kurulumunda
   opencodex, `$CODEX_HOME/config.toml` (varsayılan `~/.codex/config.toml`)
   dosyasına bir kök `openai_base_url` ekler, böylece Codex'in yerleşik `openai`
   sağlayıcısı proxy'yi hedefler. Uzak/LAN bağlantıları bunun yerine bir API
   kimlik doğrulama başlığına sahip özel bir sağlayıcı girdisi kullanır.
6. **Otomatik başlatma dolgusu (shim) kurulsun mu?** — etkinleştirildiğinde,
   `codex` başlatıldığında önce `ocx ensure` çalışır.

Sonuç `$OPENCODEX_HOME/config.json` (varsayılan `~/.opencodex/config.json`)
dosyasına kaydedilir.

:::note[GPT-5.6 dağıtım girdileri]
Mevcut kararlı sürüm; ChatGPT doğrudan geçişi, OpenAI API anahtarı, OpenRouter
ve deneysel Cursor adaptörü için GPT-5.6 Sol/Terra/Luna modellerini tohumlar.
Bunlar yalnızca yukarı akış hesabının erişimi olduğunda çalışır. OpenAI API
anahtarı ve OpenRouter önayarları 922.000 tokenlik kullanılabilir bir bağlam
penceresi bildirir; Cursor kendi adaptör meta verilerini korur.
:::

## 2. Proxy'yi başlatın

```bash
ocx start            # varsayılan port 10100
ocx start --port 8080
```

Başlatıldığında opencodex:

- PID'sini `~/.opencodex/ocx.pid` dosyasına yazar (ve iki kez başlamayı
  reddeder),
- Sağlayıcının desteklediği durumlarda canlı modelleri keşfeder ve **yerel ile
  yönlendirilen girdileri Codex'in model kataloğuna senkronize eder**,
- `http://localhost:<port>/v1` üzerinde dinler.

İstenen port meşgulse `ocx start` durur ve portu neyin tuttuğunu bildirir: orada bir
opencodex yanıt veriyorsa önce `ocx stop` çalıştırın veya `ocx start --port <port>` ile
boş bir portta başlatın. Kendiliğinden başka bir porta geçmez; önceki davranış, iki
proxy'nin yan yana çalışmasına ve Codex'in daha yeni olana yönlendirilmesine neden oluyordu.

Kontrol edin:

```bash
ocx status
ocx gui       # kontrol panelini canlı port üzerinde açın
```

## 3. Aracınızı bağlayın

Kullandığınız araca ait bölümü seçin. Birden fazla araç bağlayabilirsiniz; bunlar aynı sağlayıcıları ve modelleri paylaşır.

### Codex

1. adımda Codex istemini kabul ettiyseniz Codex artık opencodex ile şeffaf biçimde iletişim kurar. İstemi reddettiyseniz veya mevcut yapılandırma nedeniyle kurulum sona erdiyse Codex’i çalıştırmadan önce panelin **Connect** sayfasındaki Codex anahtarını açın; [Codex Entegrasyonu](/tr/guides/codex-integration/) değişiklikleri ve nasıl geri alınacağını açıklar.

```bash
codex "Okunabilirlik için bu fonksiyonu yeniden düzenle"
```

Yönlendirilen belirli bir modeli hedeflemek için Codex'in model seçicisinin
gösterdiği `saglayici/model` biçimini kullanın:

```bash
codex -m "anthropic/claude-opus-5" "Bu yığın izini (stack trace) açıkla"
codex -m "ollama-cloud/glm-5.2"      "Bir SQL geçişi yaz"
```

### Claude Code

`claude` CLI kuruluysa:

```bash
ocx claude
```

`ocx claude`, çalışmıyorsa proxy’yi başlatır ve Claude Code’u ortamı opencodex’e yönlendirilmiş olarak açar. Ek argümanlar aynen iletilir. Katman varsayılanları, diğer başlatıcılar ve devre dışı bırakma için [Claude Code](/tr/guides/claude-code/) sayfasına bakın.

### Claude Desktop

```bash
ocx claude desktop
```

Yeni kurulumda tüm uygulama için ağ geçidi profilini ayarlar. Zaten first-party modunu kullanan bir kurulum bu modu korur; açıkça geçiş yapmak için `ocx claude desktop apply --gateway` çalıştırın. Desktop’ı claude.ai üzerinde tutup yalnızca Code sekmesini yönlendiren first-party modu, [Claude Code](/tr/guides/claude-code/) sayfasındaki Claude Desktop modları bölümünde açıklanır.

Mod değiştirdikten sonra Claude Desktop’tan tamamen çıkıp yeniden açın.

### Grok Build

Yerel dinleyicide `~/.grok` varsa `ocx start` görünür modelleri `~/.grok/config.toml` dosyasına kaydeder. Grok Build içinde bir `ocx-*` modeli seçin. Uzak kurulumlar ve yönetilen blok [Grok Build](/tr/guides/grok-build/) sayfasında anlatılır.

Sağlayıcı veya model ekledikten sonra Grok Build’in görmesi için `ocx ensure` çalıştırın veya proxy’yi yeniden başlatın.

### Diğer araçlar

Yönetilen entegrasyonu olan araçlar (OpenCode, Pi, Qoder, WorkBuddy, Kilo, Cline, T3 Code ve diğerleri) panelin **Connect** sayfasından veya şu komutla bağlanır:

```bash
ocx integration client enable --client <id>
```

Her aracın yapılandırma dosyası ve değişikliğin ne zaman geçerli olacağı [Entegrasyonlar](/tr/guides/integrations/) sayfasında listelenir. Özel uç noktayı kabul eden diğer araçlar OpenAI uyumlu temel URL `http://localhost:10100/v1` veya Anthropic temel URL `http://localhost:10100` kullanabilir.

## Alt ajan modellerini seçin (isteğe bağlı)

Yeni bir yapılandırma, Codex'in alt ajan seçicisinde beş yerel model sunar:
`gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` ve `gpt-6-astra`. En
fazla beş yerel veya yönlendirilmiş modeli değiştirmek veya yeniden sıralamak
için `ocx gui`'yi açın. Kontrol paneli ayrıca tercih edilen bir alt ajan
modelini ve akıl yürütme çabasını ayarlayabilir. v1/base/v2 seçmek ve rehberlik,
yerel varsayılanlar ve geri dönüşün ne zaman geçerli olduğunu anlamak için [Alt
Ajan Arayüzü](/tr/guides/sub-agent-surface/) sayfasına bakın.

## Anahtar yapıştırmak yerine giriş yapma

Bazı sağlayıcılar gerçek hesap girişini (OAuth, otomatik yenilenen) destekler:

```bash
ocx login xai          # veya: anthropic, kimi, kiro, google-antigravity, cursor
ocx logout xai
```

OpenAI'nin kendisi **hiçbir anahtara** ihtiyaç duymaz — varsayılan sağlayıcı
mevcut `codex login` kimlik bilgilerinizi doğrudan iletir (bkz.
[Sağlayıcılar](/tr/guides/providers/)).

## Durdurma ve geri yükleme

```bash
ocx stop          # proxy'yi durdurun ve yerel Codex'i geri yükleyin
ocx restore       # durdurmadan yerel Codex'i geri yükleyin (takma ad: ocx eject)
ocx restore back  # Codex'i hala çalışan proxy üzerinden tekrar yönlendirin
```

## Sonraki Adımlar

- [Nasıl Çalışır](/tr/getting-started/how-it-works/) — her isteğe ne olur?
- [Sağlayıcılar](/tr/guides/providers/) — kimlik doğrulamanın her yolu.
- [Yapılandırma](/tr/reference/configuration/) — tam `config.json` referansı.
