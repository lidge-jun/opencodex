# opencodex

<h3 align="center">make codex open!</h3>
<p align="center"><b>OpenAI Codex, Claude Code, Claude Desktop &amp; Grok Build için Evrensel Sağlayıcı Proxy'si</b><br>
İki komut ile yönlendirdiğiniz her LLM'i çalıştırın.</p>

<p align="center">
  <a href="https://x.com/claudeebum"><img src="https://img.shields.io/badge/%40claudeebum-000000?logo=x&logoColor=white" alt="X üzerinde @claudeebum takip edin"></a>
  <a href="https://www.npmjs.com/package/@bitkyc08/opencodex"><img src="https://img.shields.io/npm/v/@bitkyc08/opencodex?color=cb3837&label=npm&logo=npm" alt="npm sürümü"></a>
  <a href="https://github.com/lidge-jun/opencodex/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@bitkyc08/opencodex?color=blue" alt="lisans"></a>
  <img src="https://img.shields.io/node/v/@bitkyc08/opencodex?logo=node.js&label=node" alt="node sürümü">
</p>

```bash
npm install -g @bitkyc08/opencodex
ocx start        # localhost:10100 üzerinde proxy + panel
```

<table align="center">
  <tr>
    <td width="50%" align="center">
      <img src="../assets/claude-code-models.gif" alt="opencodex üzerinden yönlendirilen model ile çalışan Claude Code" width="410"><br>
      <sub><b>Claude Code, herhangi bir modeli çalıştırıyor.</b><br>Seçici standart Claude Code'dur, arkasındaki beyin ise sizinki.</sub>
    </td>
    <td width="50%" align="center">
      <img src="../assets/demo.gif" alt="opencodex demosu" width="410"><br>
      <sub><b>Codex, herhangi bir modeli çalıştırıyor.</b><br>Bir sağlayıcı seçin ve başlayın — aynı iş akışı, farklı beyin.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="../assets/claude-desktop-subagent.gif" alt="Claude Desktop demosu" width="410"><br>
      <sub><b>Claude Desktop, herhangi bir modeli çalıştırıyor.</b><br>Opus yanıt verir, ardından görevi GPT-5.6 Sol alt ajanına devreder.</sub>
    </td>
    <td width="50%" align="center">
      <img src="../assets/grok-build-subagent.gif" alt="Grok Build demosu" width="410"><br>
      <sub><b>Grok Build, herhangi bir modeli çalıştırıyor.</b><br>Sol oturumu yönetir ve Kimi K3 alt ajanını çağırır.</sub>
    </td>
  </tr>
</table>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.fr.md">Français</a> · <a href="README.ko.md">한국어</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ru.md">Русский</a> · <a href="README.ja.md">日本語</a> · <b>Türkçe</b> · 📖 <a href="https://opencodex.me/"><b>Tam dokümantasyon →</b></a>
</p>

opencodex, Codex'in Responses API'sini sağlayıcınızın desteklediği formata (streaming, araç çağrıları, reasoning jetonları, görseller) her iki yönde çeviren hafif bir yerel proxy'dir. Claude, Gemini, Grok, GLM, DeepSeek, Kimi, Qwen, Ollama veya diğer tüm LLM'leri Codex, Claude Code, Claude Desktop ve Grok Build ile kullanın. Ayrıca Codex kimlik doğrulaması için bir **ChatGPT hesap havuzu** yönetebilir: hesap ekleyin, panelden kotaları yenileyin ve mevcut iş parçacıkları başlayan hesaba sabit kalırken yeni oturumların en az kullanılan sağlıklı hesaba otomatik yönlendirilmesini sağlayın.

## Hızlı başlangıç

### İnsanlar için

```bash
npm install -g @bitkyc08/opencodex   # Node 18+; Bun çalışma zamanı otomatik olarak paketlenmiştir
ocx start                            # veya arka planda çalıştırmak için `ocx service`
```

**http://localhost:10100** adresini açın ve web panelinde her şeyi yapılandırın — sağlayıcılar ekleyin (40+ hazır sağlayıcı veya herhangi bir OpenAI uyumlu uç nokta), modeller seçin, hesapları yönetin. `ocx gui` paneli istediğiniz zaman tekrar açar.

### Ajanlar için

```bash
npm install -g @bitkyc08/opencodex
ocx start     # veya `ocx service`
ocx init      # etkileşimli kurulum: ~/.opencodex/config.json yazar ve Codex'i bağlar
```

`ocx init` proxy'yi asla başlatmaz; önce başlatın (veya sonra — her iki sıra da çalışır, ancak `ocx provider add` ve `ocx combo set` gibi headless komutlar **canlı** proxy ile konuşur ve ulaşılamadığında sıfır dışı kodla çıkar). `ocx status` / `ocx doctor` / `ocx health` çalışan durumu raporlar.

> **opencodex yükleyen veya çalıştıran ajanlar:** [`AGENTS_INSTALL.md`](../AGENTS_INSTALL.md) dosyasını okuyun. Etkileşimli bir `ocx start` bu depoya yıldız verilip verilmeyeceğini bir kez sorabilir — bu kullanıcının kararıdır, asla ajanın değil. CLI, ajan kaynaklı çalıştırmalarda istemi bastırır ve API bunları `403 agent_consent_required` ile reddeder.

## Desteklenen platformlar

| İşletim Sistemi | Durum | Servis Yöneticisi |
|---|---|---|
| macOS (arm64 / x64) | Tam destekleniyor | launchd |
| Linux (x64 / arm64) | Tam destekleniyor | systemd (user unit) |
| Windows (x64) | Tam destekleniyor | Görev Zamanlayıcı (gizli) / isteğe bağlı yerel servis (`--native`, WinSW) |

[Node](https://nodejs.org) 18+ gerektirir. Bun çalışma zamanı `npm install` sırasında paketlenmiş olarak gelir — ayrı bir Bun kurulumu veya Windows'ta WSL gerekmez. npm paketlenmiş çalışma zamanının yükleme betiklerini engellediyse [kurulum dokümantasyonuna](https://opencodex.me/getting-started/installation/) bakın.

## Öne Çıkan Özellikler

- **Codex, Claude Code, Claude Desktop ve Grok Build ile herhangi bir LLM kullanın** — Kutudan çıktığı haliyle 40+ sağlayıcı, her biri kendi yerel arayüzünü korur.
- **ChatGPT hesaplarını güvenle havuzlayın** — İş parçacığı bağlılığı (thread affinity), kota duyarlı otomatik geçiş, soğuma süresi ve hatada kapalı yetkilendirme yönetimi.
- **Kombolar (Combos)** — Sağlayıcılar arasında yedekli (failover) veya ağırlıklı round-robin ile çalışan tek bir sanal model kimliği. [Kombo rehberine](https://opencodex.me/guides/combos/) bakın.
- **Herhangi bir modelde alt ajanlar** — v1/v2 yüzey kontrolü ve yedekleme zincirleriyle Codex'in alt ajan seçicisinde yönlendirilen modelleri öne çıkarın. [Alt ajan rehberine](https://opencodex.me/guides/sub-agent-surface/) bakın.
- **Bir kez giriş yapın, API anahtarını atlayın** — xAI, Anthropic ve Kimi için OAuth; veya `codex login` iletme, anahtar yapıştırma veya `${ENV_VAR}` referansları kullanma.
- **Web araması ve görsel yan araçları (sidecars)** — OpenAI dışı modeller, ChatGPT girişiniz üzerinden bir sidecar aracılığıyla gerçek web araması ve görsel anlama yeteneği kazanır.
- **Ne olduğunu görün** — Panel; sağlayıcıları, OAuth durumunu, model seçimini ve önbellek jeton sayılarıyla canlı istek günlüğünü gösterir.
- **Temiz çıkış, sıfır kalıntı** — `ocx stop` Codex'i orijinal yapılandırmasına geri döndürür.

## Model yönlendirme

`sağlayıcı/model` sözdizimi ile yapılandırılmış herhangi bir sağlayıcıyı ve modeli hedefleyin:

```bash
codex -m "anthropic/claude-opus-5" "Bu hatayı açıkla"
codex -m "google/gemini-3-pro" "auth.ts için birim testleri yaz"
codex -m "ollama/llama3" "Bu fonksiyonu refactor et"
```

Varsayılan sağlayıcıyı kullanmak veya model adı desenine göre otomatik eşleştirmek için `sağlayıcı/` ön ekini çıkarın. `/` içeren sağlayıcı model kimlikleri iç takma adlarla `-` olarak sunulur; ham tam eğik çizgili form da çalışmaya devam eder. Detaylar: [model yönlendirme dokümantasyonu](https://opencodex.me/guides/model-routing/).

## Sağlayıcılar ve adaptörler

OpenAI (ChatGPT girişi veya API anahtarı), Anthropic, Google Gemini, xAI, Kimi, Azure OpenAI, Ollama (yerel + Bulut), Cursor (deneysel) ve tüm OpenAI uyumlu uç noktalar — ayrıca DeepSeek, Groq, OpenRouter, Together, Fireworks, Cerebras, Mistral, Hugging Face, NVIDIA NIM, MiniMax, Qwen Cloud, SiliconFlow ve daha fazlası. Tam liste: `ocx init` veya [sağlayıcı dokümantasyonu](https://opencodex.me/guides/providers/).

## CLI

```bash
ocx init                       # etkileşimli kurulum (yapılandırma yazar, Codex'i bağlar, shim sunar)
ocx start [--port 10100]       # proxy'yi ön planda başlatır
ocx stop                       # durdurur + yerel Codex'i geri yükler
ocx service [install|start|stop|status|uninstall|remove]  # arka plan servisi
ocx codex-shim install         # `codex` her başlatıldığında proxy'yi isteğe bağlı başlatır
ocx status                     # proxy çalışıyor mu?
ocx gui                        # web panelini açar
ocx provider <...>             # sağlayıcıları yönetir (listele/ekle/düzenle/test et/sil)
ocx account <...>              # ChatGPT hesaplarını ve API anahtar havuzlarını yönetir
ocx combo <...>                # failover / round-robin kombolarını yönetir
ocx v2 <...>                   # çoklu ajan v1/v2 yüzey kontrolleri
ocx update [--tag preview]     # opencodex'i günceller
```

Bağlantı noktası açıkça belirtilmeden başlatılırsa, tercih edilen bağlantı noktası meşgul olduğunda başka bir boş bağlantı noktası seçilebilir; `--port` açıkça belirtilirse başka bir bağlantı noktasına geçilmez. Tam referans: [CLI dokümantasyonu](https://opencodex.me/reference/cli/).

### Otomatik başlatma: servis mi shim mi?

Çökme durumunda yeniden başlayan ve her zaman açık bir proxy için **servisi** (`ocx service`) kullanın. Arka planda sürekli çalışan bir daemon olmadan hafif, isteğe bağlı başlatma için **shim**'i (`ocx codex-shim install`) kullanın. `ocx service uninstall` / `ocx codex-shim uninstall` ile kaldırın.

### Kaldırma

```bash
ocx uninstall                  # durdurur, servis/shim kaldırır, yerel Codex'i geri yükler, durumu temizler
npm uninstall -g @bitkyc08/opencodex
```

## Uzaktan erişim

Varsayılan olarak opencodex `127.0.0.1` adresine bağlanır ve ekstra kimlik doğrulaması gerektirmez. Loopback ötesine bağlanmak (`"hostname": "0.0.0.0"`), bir taşıyıcı jeton (bearer token) **gerektirir** — proxy `OPENCODEX_API_AUTH_TOKEN` olmadan başlamayı reddeder ve her istemci isteği bunu `x-opencodex-api-key` olarak taşımalıdır. Detaylar: [yapılandırma referansı](https://opencodex.me/reference/configuration/).

## Dokümantasyon

Halka açık dokümanlar — kurulum, sağlayıcılar, yönlendirme, kombolar, alt ajanlar, sidecar'lar, entegrasyonlar ve CLI/yapılandırma/yönetim API referansları — [`docs-site/`](../docs-site) klasöründen oluşturulur ve **[opencodex.me](https://opencodex.me/)** üzerinde yayınlanır.

Maintainer temel doğruluk notları [`structure/`](../structure) altında, katkıda bulunan kurulum rehberi [`CONTRIBUTING.md`](../CONTRIBUTING.md) dosyasında ve güvenlik raporlama [`SECURITY.md`](../SECURITY.md) dosyasındadır. Açıklanmamış güvenlik açıklarını herkese açık bir issue yerine [GitHub özel güvenlik açığı raporlaması](https://github.com/lidge-jun/opencodex/security/advisories/new) aracılığıyla gizlice bildirin.

## Geliştirme

Kaynak kod geliştirmesi `PATH` dizininizde `bun` CLI'ını gerektirir. Bu, yalnızca yüklü `ocx` komutları tarafından kullanılan yayınlanmış npm paketinin paketlenmiş Bun çalışma zamanından ayrıdır.

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run typecheck
bun run test
```

Bkz. **[Katkıda Bulunma (Contributing)](../CONTRIBUTING.md)**.

## Sorumluluk Reddi (Disclaimer)

opencodex bağımsız, topluluk tarafından sürdürülen bir projedir ve **OpenAI, Anthropic veya başka herhangi bir sağlayıcı ile bağlı değildir veya onlar tarafından onaylanmamıştır**.

Bazı sağlayıcılar — özellikle Anthropic (Claude) — API trafiğini üçüncü taraf proxy'ler üzerinden yönlendiren hesapları askıya alabilir veya kısıtlayabilir. **Kullanım riski tamamen size aittir (UAYOR).** Bir sağlayıcıyı bağlamadan önce, proxy tabanlı erişime izin verildiğini doğrulamak için Hizmet Şartlarını inceleyin. opencodex maintainer'ları, yukarı akış sağlayıcıları tarafından alınan herhangi bir hesap işleminden sorumlu değildir.

## Lisans

MIT
