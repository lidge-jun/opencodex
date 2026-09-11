<h3 align="center">make codex open!</h3>
<p align="center"><b>OpenAI Codex, Claude Code, Claude Desktop ve Grok Build için evrensel sağlayıcı proxy'si</b><br>
İki komut, ve hepsi işaret ettiğiniz LLM ile çalışır.</p>

<p align="center">
  <a href="https://x.com/claudeebum"><img src="https://img.shields.io/badge/%40claudeebum-000000?logo=x&logoColor=white" alt="X üzerinde @claudeebum hesabını takip et"></a>
  <a href="https://www.npmjs.com/package/@bitkyc08/opencodex"><img src="https://img.shields.io/npm/v/@bitkyc08/opencodex?color=cb3837&label=npm&logo=npm" alt="npm sürümü"></a>
  <a href="https://github.com/lidge-jun/opencodex/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@bitkyc08/opencodex?color=blue" alt="lisans"></a>
  <img src="https://img.shields.io/node/v/@bitkyc08/opencodex?logo=node.js&label=node" alt="node sürümü">
</p>

```bash
npm install -g @bitkyc08/opencodex
ocx start
```

<table>
<tr>
<td width="50%" valign="middle">

### Claude Code, istediğiniz modelle

Seçici Claude Code'un kendi seçicisi. Arkasındaki beyin değil.

</td>
<td width="50%">
  <img src="../assets/claude-code-models.gif" alt="opencodex üzerinden yönlendirilen bir modeli çalıştıran Claude Code — durum çubuğunda etkin model olarak gpt-5.6-luna-medium görünüyor" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Codex, istediğiniz modelle

Bir sağlayıcı seçin ve başlayın — aynı iş akışı, farklı beyin.

</td>
<td width="50%">
  <img src="../assets/demo.gif" alt="opencodex demosu — Codex uygulamasında OpenAI dışı bir yönlendirilmiş modelle görev çalıştırma" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Claude Desktop, istediğiniz modelle

Opus yanıtlıyor, sonra görevi bir GPT-5.6 Sol alt ajanına devrediyor.

</td>
<td width="50%">
  <img src="../assets/claude-desktop-subagent.gif" alt="Claude Opus 4.8 olarak yanıtlayan, ardından opencodex üzerinden bir GPT-5.6 Sol alt ajanı başlatan Claude Desktop" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Grok Build, istediğiniz modelle

Sol oturumu yürütüyor ve bir Kimi K3 alt ajanını çağırıyor.

</td>
<td width="50%">
  <img src="../assets/grok-build-subagent.gif" alt="opencodex üzerinden GPT-5.6 Sol çalıştıran ve bir Kimi K3 alt ajanı çağıran Grok Build" width="100%">
</td>
</tr>
</table>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.fr.md">Français</a> · <a href="README.ko.md">한국어</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ru.md">Русский</a> · <a href="README.ja.md">日本語</a> · <b>Türkçe</b> · 📖 <a href="https://opencodex.me/tr/"><b>Tüm dokümantasyon →</b></a>
</p>

opencodex, Codex'in Responses API'sini sağlayıcınızın konuştuğu protokole çeviren hafif bir yerel
proxy'dir — akış, araç çağrıları, akıl yürütme belirteçleri ve görseller, iki yönde de. Claude, Gemini,
Grok, GLM, DeepSeek, Kimi, Qwen, Ollama ya da başka herhangi bir LLM'i Codex, Claude Code, Claude
Desktop ve Grok Build ile kullanın. Codex kimlik doğrulaması için bir **ChatGPT hesap havuzu** da
yönetebilir: hesapları ekleyin, kotalarını kontrol panelinden tazeleyin ve yeni oturumlar en az
kullanılan sağlıklı hesaba kendiliğinden gitsin; mevcut dizilerse onları başlatan hesaba bağlı kalsın.

## Hızlı başlangıç

### Kişisel kurulum

```bash
npm install -g @bitkyc08/opencodex   # Node 18+; Bun çalışma zamanı otomatik olarak paketlenir
ocx start                         # proxy + kontrol paneli, localhost:10100
```

Arka planda çalıştırmak için `ocx service` kullanın.

**http://localhost:10100** adresini açın ve her şeyi web kontrol panelinden yapılandırın: sağlayıcı
ekleyin (40'tan fazla hazır sağlayıcı ya da herhangi bir OpenAI uyumlu uç nokta), model seçin, hesap
yönetin. `ocx gui` paneli istediğiniz zaman yeniden açar.
Codex kimlik doğrulaması için bir **ChatGPT hesap havuzu** da yönetebilir. Birden fazla ChatGPT / Codex
hesabı ekleyin, 5 saatlik / haftalık / 30 günlük kotalarını panelden tazeleyin. Kota yönlendirmesinde
yeni oturumlar en az kullanılan sağlıklı hesabı kullanabilir; round-robin ve fill-first kendi
politikalarını izler. Mevcut Codex dizileri normalde onları başlatan hesaba bağlı kalır, böylece uzun
SSH, tmux ya da mobil oturumlar konuşmanın ortasında hesap değiştirmez — ancak kota yeniden
değerlendirmesi, failover, hesabın devre dışı bırakılması, bağlılığın süresinin dolması ya da 401/403 ve
429 toparlanması bu bağı yeniden kurabilir. Yalnızca diğerleri tükendiğinde kullanılmasını istediğiniz
bir hesap varsa — genellikle Codex Desktop girişiniz — hesaplara bir seçim sırası verin.

### Sponsorlar

Her yukarı akış protokol değişiminde opencodex'in bakımını sürdürebilmesi sponsorlar sayesinde.
İlgileniyor musunuz? [SPONSORS.md](../SPONSORS.md) dosyasına bakın.

<!-- sponsors:main — one banner, model developers only; empty until a Main sponsor signs -->

<!-- sponsors:standard — one row per sponsor, in order of signing -->
<table>
<tbody>
<tr>
<td width="180"><a href="https://www.orcarouter.ai/?utm_source=opencodex&utm_medium=readme"><img src="../assets/sponsors/orcarouter.png" alt="OrcaRouter" width="150"></a></td>
<td>Bu projeye sponsor olduğu için <a href="https://www.orcarouter.ai/?utm_source=opencodex&utm_medium=readme">OrcaRouter</a>'a teşekkürler! OrcaRouter, üretimdeki yapay zekâ için tek bir OpenAI uyumlu yapay zekâ ağ geçidi: her istemi puanlayıp çıtanızı geçen modele gönderen uyarlanabilir yönlendirme, otomatik failover, kod olarak yazılan yönlendirme kuralları, istem önbelleğiyle birlikte sıfır marjlı sağlayıcı fiyatlandırması ve 200'den fazla modeldeki her çağrıda koruma kuralları, bir ajan güvenlik duvarı ve istek günlükleri. Add provider seçicisinden <code>OrcaRouter</code> seçin ya da <code>ocx provider add orcarouter</code> çalıştırın; uyarlanabilir yönlendirici <code>orcarouter/auto</code>.</td>
</tr>
<tr>
<td width="180"><a href="https://www.packyapi.com/register?aff=k5KT"><img src="../assets/sponsors/packycode.png" alt="PackyCode" width="150"></a></td>
<td>Bu projeye sponsor olduğu için <a href="https://www.packyapi.com/register?aff=k5KT">PackyCode</a>'a teşekkürler! PackyCode, Claude Code, Codex, Gemini ve daha fazlası için aktarma hizmeti sunan istikrarlı ve yüksek başarımlı bir API aktarma sağlayıcısıdır. Otomatik failover, akıllı yönlendirme ve sınırsız eşzamanlılıkla yapay zekâyı gerçek bir üretkenlik aracına dönüştürür. <a href="https://www.packyapi.com/register?aff=k5KT">Bu bağlantıdan kaydolun</a> ve hemen başlayın! Add provider seçicisinden <code>PackyCode</code> seçin ya da <code>ocx provider add packycode</code> çalıştırın.<br><sub>PackyCode 是一家稳定、高效的 API 中转服务商，提供 Claude Code、Codex、Gemini 等多种中转服务。具备自动故障转移、智能路由和无限并发等多种功能，让 AI 编程成为真正的生产力工具。<a href="https://www.packyapi.com/register?aff=k5KT">点此链接注册</a>，立即开始使用！</sub></td>
</tr>
</tbody>
</table>

---

<details>
<summary>Docker Compose</summary>

Depo, digest ile sabitlenmiş, root olmayan bir Compose derlemesi içerir. Ana makinede Git ve Bun kuruluysa,
her imaj derlemesinden önce standart uyumluluk manifestosunu üretin, ardından veri düzlemi belirtecini
stdin üzerinden bir kez ilklendirip hub'ı başlatın:

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun scripts/generate-compatibility-version.ts
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
curl --fail --silent http://127.0.0.1:10100/healthz
curl --fail --silent http://127.0.0.1:10100/readyz
```

Varsayılan ana makine bağlaması `127.0.0.1:10100`. Uzaktan erişime açmak için
`OPENCODEX_BIND_ADDRESS=<LAN-or-Tailscale-IP> docker compose up -d` gerekir; `0.0.0.0` tüm ana
makine arayüzlerini açar. Erişimi bir güvenlik duvarı ve kimlik doğrulamalı bir TLS/tailnet ön yüzüyle
kısıtlayın. Üretilen JSON izlenmez; imaja `.git` olmadan kopyalanır. Kaynak değiştiğinde yeniden
üretin ve üretimle derleme arasında kaynağa dokunmayın. Derleme; eski manifestoları, eksik ya da uyuşmayan
dosyaları, fazladan kaynak dosyalarını ve sembolik bağlantıları reddeder. Kayıtlı her SHA-256 değerini
derleme bağlamıyla ve kopyalanan çalışma zamanı dosyalarıyla karşılaştırır: `package.json`,
`bun.lock` ve özellikle dahil edilen `scripts/model-metadata.source.json`.

Belirteç ve değişken durum `ocx-state` adlı volume içinde kalır; imaja, Compose dosyasına, ortama ya da
kabuk argümanlarına hiçbir kimlik bilgisi konmaz. Sağlayıcı kurulumu, kimlik doğrulamalı kabul kontrolleri,
uzaktan yönetim ve geri alma için
[Remote Hub dağıtım kılavuzuna](https://opencodex.me/tr/guides/remote-hub/) bakın.

</details>

<details>
<summary>Kaynaktan kurulum (en güncel dev)</summary>

**macOS / Linux:**

```bash
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex && ~/.bun/bin/bun install
~/.bun/bin/bun run src/cli/index.ts start
```

**Windows (PowerShell):**

```powershell
irm bun.sh/install.ps1 | iex
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex; bun install
bun run src/cli/index.ts start
```

Kaynaktan kurulum en güncel `dev` dalını çalıştırır. Bellek sahipliği yamaları, çalışma zamanı GC
iyileştirmeleri ve henüz yayımlanmamış düzeltmeler npm paketine ulaşmadan önce burada bulunur.

</details>

<details>
<summary>Ajanlar için</summary>

```bash
npm install -g @bitkyc08/opencodex
ocx start     # ya da `ocx service`
ocx init      # etkileşimli kurulum: ~/.opencodex/config.json yazar ve Codex'i bağlar
```

`ocx init` proxy'yi hiçbir zaman başlatmaz; önce onu başlatın (ya da sonra — sıra fark etmez, ancak
`ocx provider add` ve `ocx combo set` gibi başsız komutlar **çalışan** proxy ile konuşur ve ona
ulaşamadıklarında sıfırdan farklı bir kodla çıkar). `ocx status` / `ocx doctor` / `ocx health`
çalışma durumunu bildirir.

> **opencodex'i kuran ya da çalıştıran ajanlar:**
> [`AGENTS_INSTALL.md`](../AGENTS_INSTALL.md) dosyasını okuyun. Etkileşimli bir `ocx start` bu depoya
> yıldız verip vermeyeceğinizi bir kez sorabilir — bu kullanıcının kararıdır, hiçbir zaman bir ajanın
> değil. CLI, ajan tarafından yürütülen çalışmalarda bu soruyu bastırır ve API bunları
> `403 agent_consent_required` ile reddeder.

</details>

## Desteklenen platformlar

| İşletim sistemi | Durum | Servis yöneticisi |
|---|---|---|
| macOS (arm64 / x64) | Tam destekleniyor | launchd |
| Linux (x64 / arm64) | Tam destekleniyor | systemd (kullanıcı birimi) |
| Windows (x64) | Tam destekleniyor | Görev Zamanlayıcı (gizli) / isteğe bağlı yerel servis (`--native`, WinSW) |

[Node](https://nodejs.org) 18 veya üzeri gerekir. Bun çalışma zamanı `npm install` sırasında paketlenir —
ayrıca Bun kurmanıza gerek yok, Windows'ta WSL de gerekmez. npm, paketlenmiş çalışma zamanının kurulum
betiklerini engellediyse [kurulum belgelerine](https://opencodex.me/tr/getting-started/installation/) bakın.

## Öne çıkanlar

- **Codex, Claude Code, Claude Desktop ve Grok Build ile istediğiniz LLM** — kutudan çıktığı gibi 40'tan
  fazla sağlayıcı, her biri kendi yerel arayüzünü korur.
- **ChatGPT hesaplarını havuzlayın** — dizi bağlılığı, kota farkındalıklı otomatik geçiş, bekleme süresi ve
  fail-closed kimlik doğrulama davranışı.

  > **Sağlayıcı politikası notu:** Hesap havuzu yalnızca yönlendirme ve işletimsel dayanıklılık içindir;
  > sağlayıcının hız sınırlarından, yaptırımlarından, askıya almalarından ya da diğer hesap işlemlerinden
  > korunmayı garanti etmez. OpenCodex, sağlayıcı sınırlarını aşmak için ek hesap kullanılmasını ya da hesap
  > kimlik bilgilerinin kişiler arasında paylaşılmasını onaylamaz. Her sağlayıcının güncel koşullarına
  > uymak sizin sorumluluğunuzdadır. Bkz.
  > [Codex Auth hesap havuzu rehberi](https://opencodex.me/tr/guides/web-dashboard/)
  > ve [OpenAI'nin güncel Kullanım Koşulları](https://openai.com/policies/terms-of-use/).
- **Kombolar** — sağlayıcılar arasında failover ya da ağırlıklı round-robin yapan tek bir sanal model
  kimliği. [Kombo rehberine](https://opencodex.me/tr/guides/combos/) bakın.
- **Her modelde alt ajanlar** — yönlendirilmiş modelleri Codex'in alt ajan seçicisinde gösterin, v1/v2
  yüzey denetimi ve yedek zincirleriyle birlikte.
  [Alt ajan rehberine](https://opencodex.me/tr/guides/sub-agent-surface/) bakın.
<!-- sponsors:main-first-mention -->
- **Bir kez giriş yapın, API anahtarını atlayın** — xAI, Anthropic ve Kimi için OAuth; ya da
  `codex login` oturumunu iletin, bir anahtar yapıştırın veya `${ENV_VAR}` referansları kullanın.
- **Web araması ve görü yardımcıları** — OpenAI dışı modeller, ChatGPT girişiniz üzerinden çalışan bir
  yardımcı süreç sayesinde gerçek web araması ve görsel anlama kazanır.
- **Ne olup bittiğini görün** — kontrol paneli sağlayıcıları, OAuth durumunu, model seçimini ve önbellek
  belirteç sayılarını içeren canlı bir istek günlüğünü gösterir.
- **Temiz çıkış, sıfır artık** — `ocx stop` Codex'i özgün yapılandırmasına geri döndürür.
- **Sınırlı bellek sahipliği** — uzun ömürlü her önbelleğin, halka arabelleğinin ve protokol çevirisi
  deposunun sonlu bir üst sınırı, bayt bütçesi ya da etkin bir uzlaştırması vardır. Yapılandırma yeniden
  yüklendiğinde sınırsız hiçbir `Map` ya da `Set` hayatta kalmaz.

<details>
<summary>Bellek sahipliği ayrıntıları</summary>

OpenCodex, süreçte tutulan durumu 36 kategoride izler. Her birinin belgelenmiş bir sınırı vardır:

- **12 tutulan depo** (istek günlüğü, hata ayıklama halkaları, görsel önbelleği, model önbelleği, görü
  açıklamaları, imleç blob'ları, responses devamlılığı vb.) bayt olarak hesaplanır ve uygulamanın sahip
  olduğu bellek bütçesiyle (varsayılan 256 MiB) tahliye edilir.
- **4 gözlenen arabellek** (çevirici biriktiricileri, görsel/OAuth/Grok kuyrukları) tahliye edilmeden,
  yalnızca uçuştaki bayt baskısı için izlenir.
- **24 state-store kaydı**, süre dolumu taramalarını (60 sn aralık) ve yapılandırma kuşağı uzlaştırmasını
  yürüterek eski sağlayıcı/hesap anahtarlarını kaldırır.
- **Yol ve parmak izi notları** (çalışma alanı meta verileri, sağlamlaştırılmış kimlikler, kurulum
  tuzları, mod ipucu yetenekleri) ekleme sıralı LRU sınırları kullanır (8–128 girdi).
- **Model önbelleği kuşak mezar taşları** uzlaştırmadan sonra silinir; genel bir kuşak artışı, uçuştaki
  eski keşiflerin kaldırılmış sağlayıcıları yeniden doldurmasını engeller.
- **Lab olay kimliği yinelenme ayıklaması** diskten alınan bir defter kilidi altında çalışır; süreç
  düzeyinde RAM dizini yoktur.

Canlı tutulan baytları, tahliye sayaçlarını ve gözcü örneklerini incelemek için yönetici belirteciyle
`GET /api/system/memory` çağrısını yapın.

</details>

## Model yönlendirme

`provider/model` söz dizimiyle yapılandırılmış herhangi bir sağlayıcıyı ve modeli hedefleyin:

```bash
codex -m "anthropic/claude-opus-5" "Bu yığın izini açıkla"
codex -m "google/gemini-3-pro" "auth.ts için birim testleri yaz"
codex -m "ollama/llama3" "Bu fonksiyonu yeniden düzenle"
```

Varsayılan sağlayıcıyı kullanmak ya da model adı desenine göre otomatik eşleştirmek için `provider/`
önekini atlayın. İçinde `/` bulunan sağlayıcı model kimlikleri, iç eğik çizgileri `-` ile
değiştirilmiş biçimde sunulur; eğik çizgili tam biçim de çalışmaya devam eder. Ayrıntılar:
[model yönlendirme belgeleri](https://opencodex.me/tr/guides/model-routing/).

## Sağlayıcılar ve adaptörler

<!-- sponsors:main-first-mention -->
OpenAI (ChatGPT girişi ya da API anahtarı), Anthropic, Google Gemini, xAI, Kimi, Azure OpenAI, Ollama
(yerel + Cloud), Cursor (deneysel) ve her OpenAI uyumlu uç nokta — ayrıca DeepSeek, Groq, OpenRouter,
Together, Fireworks, Cerebras, Mistral, Hugging Face, NVIDIA NIM, MiniMax, Qwen Cloud, Qoder Global ve CN
(resmî PAT + CLI), SiliconFlow ve daha fazlası. Tam liste: `ocx init` ya da
[sağlayıcı belgeleri](https://opencodex.me/tr/guides/providers/).

## CLI

```bash
ocx init                       # etkileşimli kurulum (config yazar, Codex'i bağlar, shim önerir)
ocx start [--port 10100]       # proxy'yi ön planda başlat
ocx stop                       # durdur + yerel Codex'i geri yükle
ocx service [install|repair|restart|start|stop|status|uninstall|remove]  # arka plan servisi
ocx codex-shim install         # `codex` her başladığında proxy'yi isteğe bağlı başlat
ocx health [--json]            # proxy'nin şu an ayakta olup olmadığını kontrol et
ocx ready [--json] [--wait [--timeout <seconds>]]  # eşitleme sonrası hazırlığı kontrol et
ocx status                     # proxy çalışıyor mu?
ocx gui                        # web kontrol panelini aç
ocx provider <...>             # sağlayıcıları yönet (list/add/edit/test/remove)
ocx account <...>              # ChatGPT hesaplarını ve API anahtarı havuzlarını yönet
ocx combo <...>                # failover / round-robin kombolarını yönet
ocx v2 <...>                   # çoklu ajan v1/v2 yüzey denetimleri
ocx update [--tag preview]     # opencodex'i güncelle
```

Sabitlenmemiş başlatmalar, tercih edilen bağlantı noktası meşgulse başka bir boş bağlantı noktasına
geçebilir; açıkça verilen bir `--port` asla değişmez. Tam başvuru:
[CLI belgeleri](https://opencodex.me/tr/reference/cli/).

### Sağlık ve hazırlık

`GET /healthz` proxy'nin o anki canlılığını bildirir. Kimlik doğrulaması gerektirmeyen `GET /readyz`
uç noktası, eşitleme sonrası hazırlığı arındırılmış `{service, version, uptime, pid, port, status}` JSON
kimliğiyle bildirir. `status` değeri `ready` olduğunda `200` döner; `pending` ve nihai
`failed` durumları `Retry-After: 1` ile `503` döner.

`ocx ready [--json] [--wait [--timeout <seconds>]]` varsayılan olarak tek bir yoklama yapar. `--wait`
varsayılan olarak 45 saniyeye kadar yoklar, ancak nihai `failed` durumunu gördüğü anda çıkar;
`--timeout <seconds>` 1–300 saniyelik bir sınır koyar, `--wait` gerektirir ve yalnızca pozitif tam
sayı kabul eder. CLI `--json` çıktısı `{ready, status, pid, port}` biçimindedir; `status` değeri
`ready`, `pending`, `failed` ya da `unreachable` olur.

| Çıkış | Sonuç |
| --- | --- |
| `0` | Hazır |
| `1` | Hazır değil: pending, failed, zaman aşımı ya da ulaşılamıyor |
| `64` | Geçersiz argüman |

`/readyz` içermeyen eski bir proxy `unreachable` olarak fail-closed davranır ve 1 koduyla çıkar;
`ocx health` ise uyumlu kalır.

### Otomatik başlatma: servis mi shim mi

Çökme sonrası yeniden başlayan, sürekli açık bir proxy için **servisi** (`ocx service`) kullanın. Arka
plan artalan süreci olmadan hafif, isteğe bağlı başlatma için **shim**'i
(`ocx codex-shim install`) kullanın. Kaldırmak için `ocx service uninstall` /
`ocx codex-shim uninstall`.

### Kaldırma

```bash
ocx uninstall                  # durdur, servis/shim kaldır, yerel Codex'i geri yükle, durumu temizle
npm uninstall -g @bitkyc08/opencodex
```

## Uzaktan erişim

opencodex varsayılan olarak `127.0.0.1` adresine bağlanır ve ek bir kimlik doğrulaması gerektirmez.
Geri döngünün dışına bağlanmak (`"hostname": "0.0.0.0"`) bir bearer belirteci **gerektirir**: proxy
`OPENCODEX_API_AUTH_TOKEN` olmadan başlamayı reddeder ve her istemci isteği bu belirteci
`x-opencodex-api-key` olarak taşımalıdır. Ayrıntılar:
[yapılandırma başvurusu](https://opencodex.me/tr/reference/configuration/).

## Belgeler

Herkese açık belgeler — kurulum, sağlayıcılar, yönlendirme, kombolar, alt ajanlar, yardımcı süreçler,
entegrasyonlar ve CLI/yapılandırma/yönetim API'si başvuruları — [`docs-site/`](../docs-site) içinden
derlenir ve **[opencodex.me](https://opencodex.me/tr/)** adresinde yayımlanır.

Bakımcılar için doğruluk kaynağı notları [`structure/`](../structure) altında, katkıda bulunan kurulumu
[`CONTRIBUTING.md`](../CONTRIBUTING.md) içinde, güvenlik bildirimi ise
[`SECURITY.md`](../SECURITY.md) içindedir. Açıklanmamış güvenlik açıklarını herkese açık bir issue
yerine [GitHub özel güvenlik açığı bildirimi](https://github.com/lidge-jun/opencodex/security/advisories/new)
üzerinden gizlice bildirin.
Teknik kanal yalnızca bu formdur; ayrı bir güvenlik e-posta adresi yoktur. Sonraki yazışmalar özel
bildirimin içinde kalır; herkese açık bir issue yalnızca koordinasyon taşıyabilir, güvenlik açığının
ayrıntılarını asla. Bildirimin alındığını onaylamak onu incelemekle aynı şey değildir ve ilk yanıt
için bir süre taahhüt edilmez.

## Geliştirme

Kaynak geliştirmesi `PATH` üzerinde `bun` CLI gerektirir. Bu, yalnızca kurulu `ocx` komutlarının
kullandığı, yayımlanmış npm paketiyle gelen Bun çalışma zamanından ayrıdır.

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run typecheck
bun run test
```

**[Katkıda bulunma](../CONTRIBUTING.md)** belgesine bakın.

Bir bakımcının devralması ya da yeniden uygulamasıyla gelen ve commit'inde özgün yazarı anılmayan katkılar
**[CREDITS.md](../CREDITS.md)** içinde kayıt altına alınır.

## Sorumluluk reddi

opencodex bağımsız, toplulukça sürdürülen bir projedir ve **OpenAI, Anthropic ya da başka herhangi bir sağlayıcıyla bağlantılı değildir, onlar tarafından onaylanmamıştır**.

Bazı sağlayıcılar — özellikle Anthropic (Claude) — API trafiğini üçüncü taraf bir proxy üzerinden geçiren hesapları askıya alabilir ya da kısıtlayabilir. **Kullanım riski size aittir (UAYOR).** Bir sağlayıcıyı bağlamadan önce, proxy tabanlı erişime izin verildiğini doğrulamak için hizmet koşullarını inceleyin. opencodex bakımcıları, yukarı akış sağlayıcılarının aldığı hesap kararlarından sorumlu değildir.

## Lisans

MIT
