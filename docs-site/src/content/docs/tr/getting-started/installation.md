---
title: Kurulum
description: opencodex (ocx) proxy'sini ve ön koşullarını kurun, çalıştığını doğrulayın.
---

opencodex, `ocx` ve `opencodex` olmak üzere iki eşdeğer komut adı kurar. Her
ikisi de aynı küçük yerel HTTP sunucusunu (Bun üzerinde oluşturulmuştur)
başlatır. Model istekleri yönlendirme tarafından seçilen sağlayıcıya gider;
isteğe bağlı vizyon ve web araması sidecar'ları, yönlendirilen bir model ihtiyaç
duyduğunda ChatGPT oturumunuzu da kullanabilir.

## Ön Koşullar

| Gereksinim | Neden |
| --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | `ocx` Bun çalışma zamanı üzerinde çalışır, ancak çalışma zamanı `npm install` sırasında otomatik olarak paketlenir — Bun'ı kendiniz kurmanız **gerekmez**. |
| **[OpenAI Codex](https://openai.com/codex)** (CLI, App veya SDK) | opencodex'in önünde durduğu istemci. opencodex `$CODEX_HOME/config.toml` (varsayılan `~/.codex/config.toml`) dosyasına yazar. |
| Bir sağlayıcı hesabı veya API anahtarı | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, OpenAI uyumlu bir uç nokta veya ChatGPT oturumunuz. |

## Kurulum

```bash
npm install -g @bitkyc08/opencodex
```

:::note[npm bun postinstall betiğini engelledi mi?]
Son npm sürümleri, bun'ın postinstall betiğini engelleyebilir (`npm warn
install-scripts ... blocked because they are not covered by allowScripts`), bu
da paketlenmiş Bun çalışma zamanını hazırlanmamış bırakır. Bun'ın betiğine izin
vererek yeniden kurun — ve her zaman paket adını ekleyin (npm'nin kısaltılmış
önerisi paket adını atlar ve bu da geçerli dizini yeniden kurmaya çalışır):

```bash
npm install -g --allow-scripts=bun @bitkyc08/opencodex

# orijinal kurulum sudo kullandıysa, sudo kullanmaya devam edin:
sudo npm install -g --allow-scripts=bun @bitkyc08/opencodex
```
:::

Her iki komut takma adının da `PATH` üzerinde olduğunu doğrulayın:

```bash
ocx --version
opencodex --version
```

### Sürüm kanalları

Kararlı `latest` kanalı; ChatGPT, OpenAI API anahtarı, OpenRouter ve deneysel
Cursor rotaları için GPT-5.6 Sol/Terra/Luna katalog desteğini zaten içerir.
Yukarı akış erişimi hala hesap geçişlidir; katalog girdileri tek başlarına
erişim sağlamaz. Önizleme kanalını yalnızca yayınlanmamış opencodex
derlemelerini test etmek için kullanın:

```bash
npm install -g @bitkyc08/opencodex@preview
ocx update --tag preview
```

## Kaynaktan çalıştırma

opencodex'in kendisi üzerinde geliştirmeler yapmak için:

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy   # geliştirme modunda proxy API'sini başlatır (src/cli/index.ts start)
bun run dev:gui     # kontrol paneli geliştirme sunucusunu başlatır (başka bir terminal)
```

`bun run dev`, `bun run dev:proxy` komutunun bir takma adıdır. Proxy API'si
`/healthz`, `/v1/responses` ve `/api/*` uç noktalarını sunar; `GET /`, yalnızca
`bun run build:gui` komutu `gui/dist` çıktısını ürettikten sonra paketlenmiş
kontrol panelini sunar. Kontrol paneli üzerinde geliştirme yaparken ön ucu ayrı
olarak `bun run dev:gui` ile çalıştırın.

## Neler oluşturulur?

opencodex durumu `$OPENCODEX_HOME` (varsayılan `~/.opencodex`) altında tutulur.
Codex entegrasyon dosyaları `$CODEX_HOME` (varsayılan `~/.codex`) altında yer
alır.

| Yol | Amaç |
| --- | --- |
| `$OPENCODEX_HOME/config.json` | Sağlayıcılarınız, varsayılan sağlayıcı, port ve seçenekler. |
| `$OPENCODEX_HOME/ocx.pid` | Çalışan proxy'nin PID'si (tek örnek koruması). |
| `$OPENCODEX_HOME/runtime-port.json` | Otomatik olarak seçilen bir yedek port dahil olmak üzere canlı PID, ana bilgisayar adı ve port. |
| `$OPENCODEX_HOME/auth.json` | Saklanan OAuth kimlik bilgileri (`ocx login` yaptığınızda). |
| `$OPENCODEX_HOME/catalog-backup*.json` | opencodex düzenlemeden önce alınan Codex model kataloğu yedekleri. |
| `$CODEX_HOME/config.toml` | Geri döngüde opencodex işaretçi sahipliğindeki kök `openai_base_url` ekler; geri döngü olmayan bağlantılar `model_provider = "opencodex"` artı `[model_providers.opencodex]` kullanır, böylece Codex API kimlik doğrulama başlığını gönderebilir. |
| `$CODEX_HOME/opencodex.config.toml` | Ana Codex yapılandırmasının yanında yazılan yedek/referans profili. |
| `$CODEX_HOME/opencodex-catalog.json` | Codex tarafından kullanılan senkronize edilmiş yerel ve yönlendirilen model kataloğu. |

:::note
opencodex asla Codex yapılandırmanızı silmez. Her enjeksiyon tersine
çevrilebilir — `ocx stop`, `ocx restore` veya `ocx eject`, tam olarak
opencodex'in eklediği satırları kaldırır ve yerel Codex'i geri yükler.
:::

## Sonraki Adımlar

İlk sağlayıcınızı yapılandırmak için [Hızlı
Başlangıç](/tr/getting-started/quickstart/) ile devam edin veya mimari için
[Nasıl Çalışır](/tr/getting-started/how-it-works/) bölümünü okuyun.


