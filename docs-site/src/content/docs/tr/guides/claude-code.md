---
title: Claude Code
description: Claude Code içerisinden yönlendirilen herhangi bir modeli kullanın — opencodex aynı port üzerinden Anthropic Messages API'sini ve ağ geçidi model keşfini sunar.
---

opencodex, `/v1/responses` uç noktasının yanında `POST /v1/messages` (artı
`count_tokens`) sunar; böylece Claude Code, sıfır ekstra kimlik doğrulama
işlemiyle yönlendirilen tüm sağlayıcıları — OAuth girişleri, hesap havuzları,
anahtar yük devretme ve sidecar'lar dahil — kullanabilir.

## Claude OAuth hesap havuzu (deneysel)

Sağlayıcılar kontrol panelinden (`ocx login anthropic` / hesap ekle) birden
fazla Claude hesabına giriş yapabilirsiniz. Varsayılan olarak her istek yalnızca
**aktif** hesabı kullanır.

**Deneysel, isteğe bağlı** bir Claude hesap havuzu
(`anthropicAccountPool.enabled`), bu OAuth hesapları arasında yapışkan oturum
bağlılığı ve 429 bekleme süresi (cooldown) yük devretmesi ekler. Yalnızca
**yeni** oturumlar için `anthropicAccountPool.strategy` uygun hesaplar arasından
seçim yapar: `quota` (varsayılan), `autoSwitchThreshold` üzerinde olduğunda
bilinen en düşük 5 saatlik kullanımı seçer; `round-robin` eşit olarak dağıtır
(`stickyLimit`, varsayılan `1`); `fill-first`, bekleme süresi, yeniden kimlik
doğrulama veya eşiğe kadar aktif hesabı tüketir, ardından ilerler. **Varsayılan
olarak kapalıdır**, bir GUI uyarısı gösterir ve sahada kapsamlı olarak test
edilmemiştir — Anthropic otomatik rotasyona benzeyen hesapları kısıtlayabilir;
rotasyon sağlayıcı yaptırımlarına karşı koruma sağlamaz.

Etkinleştirildiğinde operasyonel sözleşme:

- Yukarı akıştan gelen **429**, varsa `Retry-After` (yoksa varsayılan bir geri
  çekilme) kullanarak o hesabı soğutur, bağlılıklarını temizler ve aynı istek
  içinde uygun başka bir hesaba dönebilir (sınırlı).
- Bağlılık **işleme özeldir (process-local)** (proxy yeniden başlatıldığında
  kaybolur).
- **401/403** kimlik bilgisi hataları hesabı karantinaya alır (`needsReauth`),
  böylece yeniden kimlik doğrulanana kadar seçimden hariç tutulur.
- Uygun tüm hesaplar soğutuluyorsa, proxy bilindiğinde `Retry-After` ile
  birlikte **429** (401 değil) döndürür.

Bkz.
[Yapılandırma](/tr/reference/configuration/#anthropicaccountpool-experimental).

## Hızlı Başlangıç

```bash
ocx claude
```

`ocx claude`, proxy'nin çalıştığından emin olur, ardından ortam değişkenleri
bağlanmış olarak Claude Code'u başlatır:

| Değişken | Değer |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:<port>` |
| `ANTHROPIC_AUTH_TOKEN` | Yalnızca proxy bir API anahtarı gerektirdiğinde — aksi takdirde AYARLANMAZ, böylece claude.ai girişiniz (abonelik + bağlayıcılar) aktif kalır |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` (yerel `/model` seçici keşfi) |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Otomatik bağlam sıkıştırma eşiği (varsayılan `829800`); yalnızca otomatik bağlam etkinleştirildiğinde enjekte edilir |
| `ANTHROPIC_MODEL` | `claudeCode.model` (isteğe bağlı) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `claudeCode.tierModels.haiku ?? claudeCode.smallFastModel` (isteğe bağlı; eski `ANTHROPIC_SMALL_FAST_MODEL` da geçerlidir) |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,FABLE}_MODEL` | `claudeCode.tierModels.*` (isteğe bağlı) |
| `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | `alwaysEnableEffort` açık olduğunda `1` (koşullu) |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `DISABLE_COMPACT` | `maxContextTokens` ayarlandığında eski bağlam geçersiz kılma (koşullu) |

Kendi dışa aktardığınız değişkenler her zaman önceliklidir. Ekstra argümanlar
doğrudan iletilir: `ocx claude -p "hello"`.

Bir istisna, öncelikle değil, bir değişkenin *nereden* geldiğiyle ilgilidir.
Paketlenmiş Bun çalışma zamanı bir projedeki `.env` / `.env.local` dosyasını
otomatik olarak yükler, bu nedenle başlattığınız dizindeki sahipsiz bir
`ANTHROPIC_API_KEY`, kasıtlı bir dışa aktarma gibi görünürdü — ve sağlıklı bir
claude.ai aboneliğini sessizce API faturalandırması lehine devre dışı bırakırdı.
`ocx claude` artık yalnızca bir proje dotenv dosyasının getirdiği Anthropic
kimlik bilgilerini yok sayar. Kabuğunuzda dışa aktardığınız bir değer, her
kimlik doğrulama modunda her zaman geçerlidir. Bir API anahtarını kasıtlı olarak
kullanmak için, onu bir proje dosyasında bırakmak yerine dışa aktarın (`export
ANTHROPIC_API_KEY=...`).

## Kimlik doğrulama modu (Auth mode)

Claude Code'un bir ağ geçidiyle konuşabilmesi için `ANTHROPIC_AUTH_TOKEN` içinde
bir belirtece ihtiyacı vardır, ancak bu değişkeni ayarlamak aynı zamanda
claude.ai girişinizi ve bağlayıcılarını da devre dışı bırakır. İkisinden
hangisini istediğiniz opencodex'in bakabileceği bir şeye bağlıdır, bu nedenle
varsayılan olarak bunu yapar.

**Claude → Claude Code** altında **Kimlik doğrulama modu**'nu **Otomatik**
(varsayılan) olarak bırakın; opencodex her başlatmada karar verir:

| Ne bulur? | Ne yapar? |
| --- | --- |
| Bir Claude girişi (`~/.claude.json` OAuth hesabı, `.credentials.json`, macOS anahtarlığı veya dışa aktarılmış `ANTHROPIC_API_KEY`) | Belirteci ayarlanmamış olarak bırakır, böylece aboneliğiniz ve bağlayıcılarınız çalışmaya devam eder |
| Hiçbir Claude kimlik doğrulaması yok | Yer tutucu bir belirteç enjekte eder, böylece Claude Code sizden giriş yapmanızı istemeyi bırakır ve proxy üzerinden yönlendirilir |
| Anlaşılamıyor (okunamayan anahtarlık, bozuk dosya) | Abonelik olduğunu varsayar ve bir uyarı yazdırır — başarısız bir okumada ödeme yapan bir aboneyi asla proxy'ye taşımaz |

Bu, her başlatmada yeniden hesaplanır, hatırlanmaz; böylece giriş yapmak veya
çıkış yapmak, yeniden yapılandırılacak hiçbir şey olmadan bir sonraki `ocx
claude` çalıştırmasında algılanır.

Sabit olmasını istediğinizde açıkça **Abonelik (Subscription)** veya **Proxy**
seçeneğini belirleyin. Açık bir seçim `claudeCode.authMode` içinde saklanır ve
algılama bunu asla geçersiz kılmaz — daha sonra giriş veya çıkış yapsanız bile.
Kararı geri devretmek için Otomatik seçeneğine geri dönün.

macOS'ta otomatik bağlantı (`claudeCode.systemEnv`) aynı çözümlemeyi takip eder,
bu nedenle `ocx` dışında başlatılan düz bir `claude` aynı şekilde davranır. Bu
dosya, proxy başladığında veya ayarları kaydettiğinizde yenilenen bir anlık
görüntüdür; `ocx claude` ise her zaman canlı olarak çözümler.

## Sistem ortamı entegrasyonu (macOS)

## Claude Desktop profili

Claude Desktop, Claude Code'dan ayrı bir profil kullanır. Mevcut her rotayı dört
aileden birine (Opus, Fable, Sonnet veya Haiku) yerleştirmek için kontrol
panelinde **Claude → Desktop** sayfasını açın. Tüm rotalar yeni bir profilde
Opus ile başlar. İlk Opus rotası genel varsayılan olur ve boş olmayan her
ailenin her zaman bir aile varsayılanı vardır.

İsterseniz bir satırı başka bir aileye sürükleyin. Sürükleme isteğe bağlıdır:
Her satırda fare, dokunmatik veya klavye ile çalışan görünür bir taşıma denetimi
de bulunur. Bir ailenin varsayılanını seçmek için **Varsayılan yap**'ı kullanın,
ardından **Kaydet ve Desktop'a uygula**'yı seçin. Boş ailelere izin verilir.
Kaydedilen bir varsayılan geçici olarak kullanılamıyorsa, geri dönene kadar o
ailedeki ilk kullanılabilir rota kullanılır.

Aynı profili komut satırından da yönetebilirsiniz:

```bash
ocx claude desktop [apply]
ocx claude desktop show [--json]
ocx claude desktop move <route> <opus|fable|sonnet|haiku> [--default]
ocx claude desktop default <opus|fable|sonnet|haiku> <route|none>
ocx claude desktop export <path|->
ocx claude desktop import <path> [--apply]
```

`ocx claude desktop` ve `apply`, geçerli profili Claude Desktop'a yazar. `show`
okunabilir bir özet sunar; betikler için `--json` ekleyin. `export -`, standart
çıktıya sürümlenmiş JSON yazar. İçe aktarma, kaydetmeden önce dosyanın tamamını
doğrular, böylece geçersiz bir dosya geçerli profili değiştirmeden bırakır.
Geçerli bir içe aktarılan profili hemen Desktop'a yazmak için `--apply` ekleyin.
`none` seçeneğini yalnızca boş bir aile için kullanın; boş olmayan her aile bir
varsayılanı korumalıdır.

Uygulama işlemi, Claude Desktop'ın gerçek Electron kullanıcı verisi
`configLibrary` dizinine yazar: macOS'ta `~/Library/Application
Support/Claude/configLibrary`, Windows'ta `%APPDATA%\Claude\configLibrary` ve
Linux'ta `${XDG_CONFIG_HOME:-~/.config}/Claude/configLibrary`. Açık bir
kütüphane geçersiz kılma için `OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR` veya
alternatif bir Desktop kullanıcı verisi kökü için `CLAUDE_USER_DATA_DIR`
değerini ayarlayın. Eski `Claude-3p` dizini otomatik olarak okunmaz veya
silinmez.

Anthropic harici rotalar, `claude-opus-4-8-2026MMDD` gibi kararlı takma adlar
alır. Tarih benzeri kısım, modelin çıkış tarihi değil, sentetik bir rota
yuvasıdır. Gerçek Anthropic Claude rotaları kendi gerçek kimliklerini korur.
Yeni rotalar varsayılan olarak Opus ailesine gider, ancak bir rotayı taşımak
çağırdığı sağlayıcıyı veya modeli değiştirmez. Eski uygulama bayrakları
`--static`, `--hybrid` ve `--discovery-only` mevcut betikler için kullanılabilir
durumda kalır.

## Sistem Ortamı Entegrasyonu

`claudeCode.systemEnv` değeri `true` olarak ayarlandığında (varsayılan:
**kapalı**), `ocx start`, `ANTHROPIC_BASE_URL` ve ilgili Claude Code ortam
değişkenlerini sistem genelinde enjekte etmek için `launchctl setenv` kullanır.
Yeni terminal pencereleri ve sekmeleri, bu nedenle `ocx claude` sarmalayıcısına
gerek kalmadan düz `claude` komutlarını proxy üzerinden yönlendirir. Zaten açık
olan kabuklar etkilenmez ve yeniden açılmalıdır.

`ocx stop` ve proxy'nin kapatılması **enjekte edilen anahtarları kaldırır**
(önceki değerleri geri yüklemez — yalnızca opencodex'in enjekte ettiği
anahtarlar kaldırılır). Proxy ayrıca `~/.opencodex/claude-env.sh` dosyasını
yazar; `ocx start`, bunu otomatik olarak yükleyen `.zshrc` kaynak kancasını
yalnızca çalıştırılabilir Claude Code CLI `PATH` içinde bulunduğunda kurar.
Claude Code yoksa veya sistem ortamı entegrasyonu etkin değilse başlangıç işlemi
ve `ocx ensure`, OpenCodex tarafından eklenen kancayı kaldırır. Claude Desktop ayrı
bir profil kullanır ve shell kancasının kurulmasını tetiklemez.

Yapılandırmada `claudeCode.systemEnv: false` ile veya GUI anahtarıyla devre dışı
bırakın. Bu özellik yalnızca macOS içindir; diğer platformlarda `ocx claude`
kullanın.

## Yerel Claude doğrudan geçişi (abonelik geçişi)

Hiçbir kimlik doğrulama geçersiz kılma ayarlanmadığında, Claude Code claude.ai
OAuth girişini korur ve proxy'ye gönderir. Hiçbir takma adın veya model
eşlemesinin talep etmediği orijinal `claude*`/`anthropic*` modelleri için
istekler, kimlik bilginizle birlikte **birebir** `api.anthropic.com` adresine
iletilir — betalar, düşünme imzaları, istem önbellekleme ve faturalandırma
kimliği tamamen yerel kalır ve yönlendirilen modeller aynı oturumda seçici takma
adları aracılığıyla çalışmaya devam eder.

**Başlık işleme:** hop-by-hop başlıkları artı `host`, `content-length`,
`accept-encoding`, `x-opencodex-api-key` ve `origin` iletmeden önce her zaman
kaldırılır. Geri döngü olmayan bir bağlantıda, yerel doğrudan geçiş
`x-opencodex-api-key` içinde geçerli bir proxy kimlik bilgisi de gerektirir;
`Authorization` ve `x-api-key` o zaman yalnızca Anthropic'e ait olur. Her iki
sağlayıcı başlığında bulunan bir proxy kabul sırrı kaldırılırken, diğer
başlıktaki gerçek bir sağlayıcı kimlik bilgisi korunur. Belirsiz virgülle
birleştirilmiş kimlik bilgisi başlıkları iletilmez.

Doğrudan geçiş şu koşulların tümü karşılandığında tetiklenir:
`nativePassthrough` `false` olmadığında; model `claude` veya `anthropic` ile
başladığında; taşıyıcı belirteç veya `x-api-key` `sk-ant-` ile başladığında;
takma ad/model haritası çözümlemesi aynı modeli değişmeden döndürdüğünde; ve
geri döngü olmayan bir bağlantıda özel proxy kabul başlığı geçerli olduğunda. Bu
aynı zamanda "claude.ai connectors are disabled" uyarısının artık `ocx claude`
ile görünmediği anlamına gelir.

`claudeCode.nativePassthrough: false` ile devre dışı bırakın;
`claudeCode.anthropicBaseUrl` ile başka bir yeri işaret edin.

## /model seçici ("From gateway")

Claude Code 2.1.129+, `GET /v1/models?limit=1000` aracılığıyla ağ geçidi
modellerini keşfeder ve bunları yerel `/model` seçicisinde "From gateway"
etiketiyle listeler. Seçici yalnızca `claude` veya `anthropic` ile başlayan
kimlikleri kabul ettiğinden, opencodex yönlendirilen modelleri kararlı, tersine
çevrilebilir takma adlar olarak sunar:

| Yüzey | Format | Örnek |
| --- | --- | --- |
| Claude Code CLI | `claude-ocx-<provider>--<model>` (düz) veya `claude-ocx2-…` (kaçışlı) | `claude-ocx-openai--gpt-5.6-sol` |
| Claude Desktop 3P | `claude-opus-4-8-<code>` (3 karakterli base36 karması) | `claude-opus-4-8-ncb` |

Proxy, istek başına aileyi seçer: `?ids=cli` veya `?ids=desktop` kazanır; aksi
takdirde `claude-code/*` kullanıcı aracısı okunabilir CLI biçimini alır ve diğer
istemciler Desktop karmasını alır. Her iki aile de süresiz olarak kodu çözer —
her iki biçimde `settings.json` içine kaydedilen bir model çalışmaya devam eder.
Her girdi, `gemini-3-pro (gemini)` gibi dürüst bir görünen adın yanı sıra Claude
Desktop'ın üçüncü taraf ağ geçidi modunun çaba seçicisini sunabilmesi için resmi
ModelInfo biçiminde tam model yeteneklerini (akıl yürütme çabası merdiveni,
düşünme türleri) taşır. Gerçek Anthropic modelleri kurallı kimliklerini korur.
Sentetik 2026 tarihi bir çıkış tarihi değil, dahili bir yuvadır. Eski karma
takma adlar ve eski yapılandırmalardan gelen `claude-ocx-<provider>--<model>`
kimlikleri hala çözümlenir.

Claude Desktop'ın altbilgi seçicisi zaten çalışan bir 3P görüşmesi için modeli
değiştirmezse, o görüşmede `/model <id>` komutunu kullanın. OpenCodex seçici
durumunu gözlemleyemez; her isteğin taşıdığı model kimliğini yönlendirir. Sonucu
**Logs → requestedModel** altında onaylayın.

Yetkili 1M bağlam penceresine sahip modeller fazladan bir `…[1m]` seçici satırı
alır: bunu seçmek Claude Code'un bu model için tam 1M bağlam hesabı yapmasını
sağlar (otomatik sıkıştırma açık kalır) — proxy yönlendirmeden önce işaretçiyi
kaldırır.
Birini seçmek, onu Claude Code'un `settings.json` `model` alanına kaydeder;
gelen istekler takma adı yönlendirilen modele geri çözer. Eski Claude Code
sürümlerinde seçici yerel kalır — `ANTHROPIC_MODEL` aracılığıyla yuvaları
ayarlayın veya `/model` ile yönlendirilen herhangi bir kimliği yazın (Claude
Code dizeleri doğrudan iletir).

**Takma ad dilbilgisi kuralları:** sağlayıcı `/` veya `--` içeremez veya
`native` değerine eşit olamaz. Düz model kimlikleri (`/` veya `~` içermeyen) v1
önekini `claude-ocx-…` korur. `/` veya `~` içeren model kimlikleri, kaçışlarla
(`/` → `~s`, `~` → `~t`) v2 önekini `claude-ocx2-…` basar, örn.
`openrouter/anthropic/claude-opus-4-8` →
`claude-ocx2-openrouter--anthropic~sclaude-opus-4-8`. v1 takma adları harfi
harfine çözülür (böylece `~s` / `~t` iki karakterli dizilerini içeren geçmiş bir
model kimliği korunur); v2 takma adları kaçışları genişletir. Okunabilir formun
ifade edemediği rotalar karma takma ada geri döner. Model kimlikleri `--`
İÇEREBİLİR (çözümleme yalnızca ilk `--` üzerinde bölünür); `--` içeren yerel
slug'lar karma forma geri döner.

**Model çözümleme sırası:** `[1m]` işaretçisi kaldırılır → okunabilir takma ad
çözülür → Desktop karma takma adı çözülür → `modelMap` tam eşleşmesi → tarih
kaldırılmış eşleşme (`-20250514` kaldırılır) → doğrudan geçiş.

Her girdi, `gemini-3-pro (gemini)` gibi bir görünen adın yanı sıra resmi
`ModelInfo` biçiminde tam model yeteneklerini (akıl yürütme çabası merdiveni,
düşünme türleri) taşır. Gerçek Anthropic modelleri her iki yüzeyde de kurallı
kimliklerini korur.

### Bağlam değişkeni `[1m]` işaretçisi

Yetkili bağlam penceresi 1M olan (veya otomatik bağlam altında 200k üzerinde ve
en az sıkıştırma eşiğinde olan) modeller fazladan bir `…[1m]` seçici satırı
alır. Bunu seçmek Claude Code'un tam 1M bağlam hesabı yapmasını sağlar. Proxy,
takma ad çözümleme ve yönlendirmeden önce büyük/küçük harfe duyarsız `[1m]`
sonekini kaldırır.

## Otomatik bağlam (200k tavanı olmayan büyük bağlamlı modeller)

Claude Code, tanımadığı herhangi bir model için 200k token hesabı yapar.
**Otomatik bağlam** (varsayılan olarak açık) bunu düzeltir:

1. Gerçek penceresi 200k'nın üzerinde **ve** en az otomatik sıkıştırma eşiğinde
   olan modeller, seçici satırlarında ve ortam yuvalarında `[1m]` işaretçisini
   alır.
2. Görüşmenin bu noktada otomatik olarak özetlenmesi için
   `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (varsayılan `829800`, aralık
   `100000`–`1000000`) enjekte edilir.

Üç yapılandırma durumu:

- **yok / `true`:** etkin (varsayılan)
- **`false`:** devre dışı — işaretçi yok, sıkıştırma penceresi enjeksiyonu yok
- **eski `maxContextTokens` ayarlandı:** otomatik bağlam örtük olarak devre
  dışıdır

Sıkıştırma değeri Claude sayfasında ayarlanabilir. **Uyarı:** bir modelin gerçek
penceresinin üzerine çıkarmak o modeli bozar — sohbet özetleme tetiklenmeden
önce hata verir.

1M altı yerel Anthropic modelleri hiçbir zaman otomatik olarak işaretlenmez.
Kendi dışa aktardığınız değerler her zaman kazanır (proxy hangi modellerin
işaretlenmesinin güvenli olduğuna karar vermek için SİZİN değerinizi kullanır).
Geçersiz elle düzenlenen yapılandırma değerleri 829,800'ya geri döner.

### Geçerli model ortamı (Effective model environment)

`effectiveModelEnv`, `ocx claude` / sistem ortamı / kabuk dosyası tarafından
enjekte edilen altı yuvayı hesaplar: `ANTHROPIC_MODEL`, dört
`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` ve eski
`ANTHROPIC_SMALL_FAST_MODEL`. Geçerli Haiku, her iki Haiku değişkenine beslenen
`tierModels.haiku ?? smallFastModel` değeridir.

Hem `tierModels.haiku` hem de `smallFastModel` bulunmadığında, OpenCodex her iki
yardımcı değişkeni de ayarlanmamış bırakır; Claude Code daha sonra yerel
sağlayıcı ücretlerine neden olabilecek yerel yardımcı modelini (şu anda Sonnet)
seçer.

## Kadro ajanları (injectAgents)

`ocx claude` (ve sistem ortamı arka plan programı), öne çıkan alt ajan kadronuzu
(Alt Ajanlar sekmesi, en fazla 5 model) artı `ocx-self`'i
`~/.claude/agents/ocx-*.md` içine senkronize eder.

- **`ocx-self`**, `/model` seçici varsayılanınızı sabitler (`claudeCode.model`'e
  geri döner); ikisi de olmadığında atlanır. Model kalıtımı KULLANMAZ.
- Her ajan gövdesi bir `<!-- ocx-route: <model> -->` yönergesi içerir — proxy
  bunu gerçek rotayı sabitlemek için kullanır. Agent aracının `model` argümanı
  bu nedenle etkisizdir; yer tutucu olarak `"haiku"` iletin.
- Frontmatter takma adı taşır; yönlendirme yönerge güdümlüdür.
- Yalnızca `generated-by: opencodex` içeren işaretçi doğrulamalı `ocx-*.md`
  dosyalarının üzerine yazılır veya budanır; kendi ajanlarınıza asla dokunulmaz.
- Dosyalar dosya başına atomik olarak senkronize edilir (yaz + yeniden
  adlandır).
- `enabled: false` veya `injectAgents: false` doğrulanmış sahipliğe sahip tüm
  tanımları budar.
- GUI PUT ve kadro değişiklikleri hemen yeniden senkronize edilir;
  başlatıcı/sistem ortamı başlatma sırasında senkronize edilir.

Dağıtım: `subagent_type: "ocx-gpt-5-6-sol"`. 1M yetenekli hedefler `[1m]`
işaretini otomatik olarak taşır.

## Paketlenmiş yetenek atlama (blockedSkills)

Claude Code'un paketlenmiş `claude-api` yeteneği, Claude model adları
anıldığında otomatik olarak tetiklenen yaklaşık 840KB (~136k token) Anthropic
dokümantasyonu enjekte eder. Yönlendirilen modeller bu paket üzerinde
eğitilmemiştir, bu nedenle varsayılan olarak opencodex **yönlendirilen**
isteklerde yeteneğin içeriğini kısa bir taslakla (stub) değiştirir. Yerel
Anthropic doğrudan geçişine dokunulmaz.

**İki taşıyıcı işlenir:**

1. **Araç sonucu taşıyıcısı:** asistan `Skill(...)` çağrıları — küçük harfe
   dönüştürülmüş JSON girdisi engellenen bir ad içerdiğinde eşleştirilen
   `tool_result` gövdesi bir taslakla değiştirilir.
2. **Metin bloğu taşıyıcısı:** `Base directory for this skill: ` ile başlayan
   ≥10.000 karakterlik bir kullanıcı metin bloğu — dizin temel adı engellenen
   bir ada eşit olduğunda eşleşir (büyük/küçük harfe duyarsız).

`claudeCode.blockedSkills` ile yapılandırın (varsayılan `["claude-api"]`; `[]`
atlamayı tamamen devre dışı bırakır). Taslak, araç çağrısı/sonuç eşleşmesini
sağlam tutar.

## Model haritası (müdahale / interception)

`claudeCode.modelMap`, yönlendirmeden önce gelen Anthropic model kimliklerini
yeniden yazar:

```json
{
  "claudeCode": {
    "modelMap": {
      "claude-sonnet-4-5": "gemini/gemini-3-pro",
      "claude-haiku-4-5": "gemini/gemini-3-flash"
    }
  }
}
```

Arama sırası: keşif takma adı → tam kimlik → tarih soneki kaldırılmış kimlik
(`-20250514` kaldırılır) → doğrudan geçiş.

## Sidecar matrisi: web araması ve görsel anlama

Yönlendirilen modellerin tümü aynı barındırılan araçlara veya görsel desteğine
sahip değildir. opencodex, ana model yanıt vermeden önce bu boşlukları doldurur:

- **Web araması sidecar'ı** gerçek barındırılan aramayı çalıştırır, ardından
  yönlendirilen modele yanıtı ve kaynakları bir araç sonucu olarak verir.
- **Vizyon sidecar'ı**, `noVisionModels` içinde listelenen bir modeli çağırmadan
  önce ekli bir görseli açıklar, ardından görseli bu açıklamayla değiştirir.

Her iki sidecar da iki arka uçtan birini kullanabilir:

| Arka uç | Nasıl çalışır? | Ne gerektirir? |
| --- | --- | --- |
| `openai` | ChatGPT `forward` sağlayıcısı aracılığıyla küçük bir GPT modeli | Bir ChatGPT girişi ve etkin bir `authMode: "forward"` sağlayıcısı |
| `anthropic` | Saklanan Anthropic OAuth aracılığıyla Claude; web araması `web_search_20250305` kullanır ve vizyon görseli açıklama için Claude'a gönderir | Aktif saklanan hesabı `needsReauth` olarak işaretlenmemiş etkin bir `adapter: "anthropic"`, `authMode: "oauth"` sağlayıcısı |

Açık bir `backend` her zaman kazanır. Atlandığında opencodex, kullanılabilir
saklanan bir Anthropic OAuth hesabı varsa `anthropic`'i seçer; aksi takdirde
`openai`'yi seçer. Kullanılabilir bir kimlik bilgisi olmadan açıkça `anthropic`
seçmek **kapalı olarak başarısız olur (fail closed)**: opencodex sessizce
ChatGPT kimlik bilgilerini ödünç almaz veya arka uçları değiştirmez. OpenAI arka
ucu da benzer şekilde hem giriş kimlik doğrulaması hem de bir iletme sağlayıcısı
olmadan kapalı kalır.

Claude gelen yönlendirilmiş tekrarları, ana ChatGPT girişini dahili isteğe
ekler, böylece Claude Code'un gelen taşıyıcısı yalnızca proxy kimlik bilgisi
olsa bile OpenAI sidecar'ları erişilebilir kalır. Bu taşıyıcı asla yönlendirilen
ana sağlayıcıya iletilmez.

```json
{
  "webSearchSidecar": {
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "maxSearchesPerTurn": 3
  },
  "visionSidecar": {
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "maxDescriptionsPerTurn": 8
  }
}
```

`maxDescriptionsPerTurn`, bir ana model turundaki yeni görsel açıklamalarını
sınırlar. Önbellek isabetleri ve devam eden mükerrer açıklamalar sınırı
tüketmez. `data:` görselleri için başarılı açıklamalar arka uç, model, ayrıntı,
görsel baytları ve istek bağlamına göre önbelleğe alınır; böylece aynı görsel ve
bağlam çifti her tekrarda tekrar açıklanmaz. Uzak `https:` görselleri asla
önbelleğe alınmaz çünkü içerikleri değişebilir.

Her anahtar için [yapılandırma referansı](/tr/reference/configuration/#sidecars)
bölümüne bakın. Anthropic-OAuth web araması ve görsel açıklaması, deponun mevcut
Claude Code OAuth parmak izi emsalini yeniden kullanır, ancak uzun gözetimsiz
çalıştırmalar için bunlara güvenmeden önce hesabınız ve iş yükünüzle kapsamlı
olarak test edilmelidir.

## Akıl yürütme çabası (Reasoning effort)

Claude Code'un `/effort` ayarı adaptör genelinde korunur:

| Hat formatı | Eşleme |
| --- | --- |
| `thinking.type: "adaptive"` + `output_config.effort` | Çaba doğrudan iletilir (`minimal`\|`low`\|`medium`\|`high`\|`xhigh`\|`max`\|`ultra`) |
| `thinking.type: "enabled"` + `budget_tokens` | ≤4096→`low`, ≤16384→`medium`, üzeri→`high` |
| `thinking.type: "disabled"` | `reasoning: { effort: "none" }`; özet atlanır |

Çözümlenen değer, istek günlüğünün **Reasoning effort** sütununda görünür.

## Gelen çeviri (Messages → Responses)

Proxy, her Anthropic Messages API isteğini Codex Responses API formatına
dönüştürür:

| Messages girdisi | Responses çıktısı |
| --- | --- |
| Üst düzey `system` | `instructions` (`\n\n` ile birleştirilmiş metin blokları) |
| `messages[].role: "system"` | Ayrıca `instructions` içine katlanır |
| Kullanıcı metni / görsel | `input_text` / `input_image` (base64 → veri URL'si) |
| Asistan metni | `output_text` |
| Asistan `tool_use` | `function_call` (`input` → JSON dizgeleştirilmiş `arguments`) |
| Kullanıcı `tool_result` | `function_call_output` (`is_error` → `[tool error]` öneki) |
| `thinking` / `redacted_thinking` tekrarı | Bırakılır |
| Fonksiyon araçları | `{type: "function"}` (`web_search*` → `{type: "web_search"}`) |
| `tool_choice` | `auto`→`auto`, `none`→`none`, `any`→`required`, adlandırılmış fonksiyon→`{type:"function",name}`, barındırılan WebSearch/web_search→`{type:"web_search"}` |
| `max_tokens` | `max_output_tokens` |
| `stop_sequences` | `stop` |

**Hata durumları (400):** hatalı biçimlendirilmiş JSON; eksik/boş `model`;
eksik/boş `messages`; desteklenmeyen rol; `tool_use_id` içermeyen `tool_result`;
kimlik/ad içermeyen `tool_use`; ad içermeyen adlandırılmış `tool_choice`.

## Giden çeviri (Responses → Messages SSE)

| Responses olayı | Messages SSE |
| --- | --- |
| `response.created` | `message_start` + `ping` |
| Kalp atışı (Heartbeat) | `ping` |
| Metin farkları | `content_block_start` → `content_block_delta` (metin) → `content_block_stop` |
| Akıl yürütme özeti/metni | Sentetik imzalı `thinking` bloğu |
| Fonksiyon çağrısı çerçeveleri | `input_json_delta` ile `tool_use` bloğu |
| Terminal olayı | `message_delta` → `message_stop` |
| Terminalden önce EOF | 502 tarzı `api_error` |

**Durdurma nedeni eşlemesi:** `completed` → `tool_use` (herhangi bir araç
çağrısı varsa) veya `end_turn`; `incomplete/max_output_tokens` → `max_tokens`;
`incomplete/content_filter` → `refusal`.

**Hata taksonomisi:** 400 `invalid_request_error`, 401 `authentication_error`,
402 `billing_error`, 403 `permission_error`, 404 `not_found_error`, 409
`conflict_error`, 413 `request_too_large`, 429 `rate_limit_error`, 504
`timeout_error`, 529 `overloaded_error`, diğer 5xx `api_error`. `Retry-After`
korunur.

## İstem önbellekleme ve token kullanımı

**Anthropic yönlendirmeli istekler:** adaptör araçlar, sistem içeriği ve sondan
bir önceki kullanıcı mesajı için önbellek kesme noktalarını ve ayrıca üst düzey
otomatik `cache_control` yönetimini sağlar. Kararlı turlar normalde yaklaşık
%99,9 önbellek isabet oranı üretir.

**Yerel OpenAI/ChatGPT yönlendirmesi:** önbellek bağlılığı için oturum kapsamlı
bir `prompt_cache_key` (varsa `metadata.user_id`'den türetilir, bir sistem
içeriği karmasına geri döner) ve `session_id` başlığı türetir. Önbellek anahtarı
modeli ve tam araç şemalarını içerir.

**Token matematiği:** Anthropic çıktısı `cached_tokens` ve `cache_write_tokens`
değerlerini `input_tokens`'tan çıkararak bunları `cache_read_input_tokens` ve
`cache_creation_input_tokens` olarak gösterir. İstek günlükleri bunları hem
`cachedInputTokens` hem de `cacheReadInputTokens` içinde okumalar,
`cacheCreationInputTokens` içinde yazmalar olacak şekilde kapsayıcı
`inputTokens`'a geri eşler. Kullanım sayfası önbellek isabetlerini ve önbellek
oluşturmayı ayrı ayrı bildirir.

**count_tokens:** yönlendirilen modeller bir yaklaşım kullanır (serileştirilmiş
sistem + mesajlar + araçlar). `sk-ant-` kimlik bilgisine sahip yerel Anthropic
modelleri isteği gerçek Anthropic `/v1/messages/count_tokens` uç noktasına
iletir.

## Hata ayıklama yakalama (Debug capture)

`ocx debug claude on|off|status|reset`, `OCX_CLAUDE_DEBUG=1` veya `PUT
/api/debug {"claude": true}` gelen yakalamayı denetler. `GET
/api/claude/inbound-debug`, `{enabled, entries}` (en yeni ilk, 20'lik halka)
döndürür.

Her girdi şunları kaydeder: `at`, `endpoint`, `model`, `resolvedModel`,
`stream`, `maxTokens`, `thinkingType`, `thinkingBudgetTokens`,
`outputConfigEffort`, `metadataKeys`, `hasMetadataUserId`, `hasSystem`, ham
`anthropicBeta` ve kullanıcı kimliği / sistem için sekiz karakterlik HMAC
eşitlik etiketleri. **Hiçbir istem metni, ham nesne veya çalıştırmalar arası
kararlı karma saklanmaz.** Claude hata ayıklamasını devre dışı bırakmak halkayı
hemen temizler.

## GUI (Claude sayfası)

Kontrol paneli kenar çubuğunda özel bir **Claude** sayfası (API altında) ve bir
**Claude ON** geçiş anahtarı (etiket kasıtlı olarak her dilde aynıdır) bulunur.
Sayfa şunları gösterir:

- Gelen acil durdurma anahtarı (etkinleştirme geçişi)
- Hızlı başlangıç (`ocx claude`) ve manuel ortam bloğu
- Hızlı Mod seçici (Otomatik / AÇIK / KAPALI)
- Otomatik bağlam geçişi ve sıkıştırma eşiği açılır menüsü
- Alt ajan otomatik kayıt geçişi
- Model müdahale (modelMap) düzenleyicisi
- Seçici takma adlarının canlı önizlemesi

`GET /api/claude-code`, geçerli varsayılanları, yapılandırmayı, bağlam penceresi
kayıt defterini, geçerli ortamı, kullanılabilir rota kimliklerini, takma adları
ve portu döndürür. `PUT /api/claude-code` kısmidir ve atlanan alanları korur;
`null` bağlam/engelleme listesi/sıkıştırma penceresi değerlerini sıfırlar.

## Sorun Giderme

**Claude Code "Did 0 searches" diyor** — Geçerli derlemeler, tamamlanan
Responses `web_search_call` öğelerini
`usage.server_tool_use.web_search_requests` dahil olmak üzere eşleştirilmiş
Anthropic `server_tool_use` ve `web_search_tool_result` bloklarına dönüştürür.
Eski bir derleme aramayı tamamladıysa ancak Claude Code hala sıfır saydıysa
opencodex'i güncelleyin.

**Bir sidecar etkinleşmiyor** — `backend: "openai"` için ChatGPT'ye giriş
yaptığınızı ve etkin bir `authMode: "forward"` sağlayıcısına sahip olduğunuzu
onaylayın. `backend: "anthropic"` için etkin saklanan Anthropic OAuth hesabının
`needsReauth` olarak işaretlenmediğini onaylayın. Bu kimlik bilgisi olmadan açık
bir Anthropic seçimi kasıtlı olarak kapalı şekilde başarısız olur.

**"claude.ai connectors are disabled"** — Kabuğunuzda bir `ANTHROPIC_API_KEY`
veya `ANTHROPIC_AUTH_TOKEN` ayarlanmıştır. `ocx claude` kasıtlı olarak
`ANTHROPIC_API_KEY` AYARLAMAZ; dışa aktardıysanız kaldırın. `ocx claude`,
`ANTHROPIC_BASE_URL`, keşif, otomatik bağlam ve yapılandırılmış model yuvalarını
enjekte eder — ancak asla `ANTHROPIC_API_KEY` enjekte etmez.

**Modeller /model seçicisinde görünmüyor** —
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` değerinin ayarlandığını
doğrulayın (`ocx claude` ile otomatik). `~/.claude/cache/gateway-models.json`
konumundaki ağ geçidi model önbelleğini yenilemek için `ocx claude` komutunu
çalıştırın. `claudeCode.enabled` değerinin `false` olmadığını kontrol edin.

**Port değişikliğinden sonra eski ortam** — Proxy portu değiştiyse eski kabuklar
eski bir `ANTHROPIC_BASE_URL` değerine sahip olabilir. Yeni bir terminal açın
veya `ocx claude` komutunu yeniden çalıştırın.

**Büyük modele rağmen 200k bağlam tavanı** — Seçicide `[1m]` varyantını seçin
veya otomatik bağlamı etkinleştirin (varsayılan olarak açık). Seçici hiçbir
`[1m]` satırı göstermiyorsa, modelin yetkili bağlam penceresi otomatik
sıkıştırma eşiğinin altında olabilir.

**Yetenek yüklemelerinden kaynaklanan yüksek token sayısı** — Paketlenmiş
`claude-api` yeteneği (~136k token) Claude model adları anıldığında otomatik
olarak yüklenir. Bu, yerel doğrudan geçiş için normaldir; yönlendirilen
modellerde opencodex varsayılan olarak bunu taslakla değiştirir (`blockedSkills:
["claude-api"]`).

**Alt ajan yanlış modele gönderiliyor** — Kadro ajanları (`ocx-*`), Agent
aracının `model` argümanını değil, `<!-- ocx-route: ... -->` yönergelerini
kullanır. Yönergenin hedeflenen rotayla eşleştiğinden emin olun. Model yer
tutucusu olarak `"haiku"` iletin.

