---
title: Hızlı Başlangıç
description: İlk sağlayıcınızı yapılandırın ve OpenAI Codex'i üç komutta opencodex üzerinden yönlendirin.
---

Bu kılavuz, yeni bir kurulumdan başlayarak Codex'i OpenAI harici bir model
üzerinde çalıştırmanızı sağlar.

## 1. Kurulum sihirbazını çalıştırın

```bash
ocx init
```

`ocx init` adım adım size rehberlik eder:

1. **Bir sağlayıcı seçin** — yerleşik kayıt defterindeki 79 önayardan birini
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

İstenen port meşgulse `ocx start` boş bir port seçer, bunu `runtime-port.json`
dosyasına kaydeder ve canlı dinleyiciyi kullanmak için Codex'i günceller.

Kontrol edin:

```bash
ocx status
ocx gui       # kontrol panelini canlı port üzerinde açın
```

## 3. Codex'i kullanın

Codex artık opencodex ile şeffaf bir şekilde konuşur:

```bash
codex "Okunabilirlik için bu fonksiyonu yeniden düzenle"
```

Yönlendirilen belirli bir modeli hedeflemek için Codex'in model seçicisinin
gösterdiği `saglayici/model` biçimini kullanın:

```bash
codex -m "anthropic/claude-opus-5" "Bu yığın izini (stack trace) açıkla"
codex -m "ollama-cloud/glm-5.2"      "Bir SQL geçişi yaz"
```

## Alt ajan modellerini seçin (isteğe bağlı)

Yeni bir yapılandırma, Codex'in alt ajan seçicisinde beş yerel model sunar:
`gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` ve `gpt-5.4-mini`. En
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


