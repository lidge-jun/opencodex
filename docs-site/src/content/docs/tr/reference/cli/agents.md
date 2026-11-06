---
title: CLI Ajanlar, Yönlendirme ve Entegrasyonlar
description: Çoklu ajan, kombo, gözlemlenebilirlik, erişim, entegrasyon, sistem ve yapılandırma komutları.
---

Bu komutlar ajan politikasını ve yönlendirmesini denetler, canlı proxy'yi
inceler ve desteklenen istemcileri opencodex'e bağlar.

## Ajan politikası

### `ocx agent <status|injection|effort|subagents|fallback|sidecar> ...`

Başsız (headless) çoklu ajan kadrosunu, çaba sınırlarını, istem enjeksiyonunu,
geri dönüşü ve sidecar ayarlarını yönetin. Geçerli politika için `status`
kullanın. Yüzey modlarının, delegasyonun, çabanın ve geri dönüş davranışının
birbirine nasıl uyduğunu görmek için [Alt ajan
yüzeyleri](/tr/guides/sub-agent-surface/) sayfasına bakın.

```bash
ocx agent subagents set ark/model-a,openai/gpt-5.5
ocx agent sidecar web --enabled off
```

`--enabled off`, kontrol panelindeki **Kapalı (Off)** satırıyla aynı anahtardır: OpenCodex
sidecar'ı çalıştırmayı bırakır ve Codex entegrasyonu `~/.codex/config.toml` dosyasına
`web_search = "disabled"` yazar; tek arama yolu olarak bir MCP arama sunucusunun kullanılmasını bu
sağlar. `--enabled on` bu satırı yeniden kaldırır. Kaydetme anahtarı gerçekten değiştirdiğinde
komut tetiklediği Codex tarafı yazmayı bildirir (`--json` içinde `codexWebSearch`, aksi
halde son satırda `Codex config:`) ve yazma yapılamadığında `ocx sync` adresini gösterir.
Bayrak `vision` için de çalışır.

### `ocx v2 <status|on|off|mode <v1|default|v2>|threads <n>|mode-hint <text|--clear>>`

Codex `multi_agent_v2` özellik bayrağını ve üç durumlu çoklu ajan yüzey modunu
yönetin.

| Alt komut | Eylem |
| --- | --- |
| `status` (varsayılan) | Geçerli v2 bayrağını, çoklu ajan modunu ve iş parçacığı eşzamanlılığını bildirin. |
| `on` | `multi_agent_v2` özelliğini etkinleştirin ve kataloğu yeniden senkronize edin. |
| `off` | `multi_agent_v2` özelliğini devre dışı bırakın ve kataloğu yeniden senkronize edin. |
| `mode v1` | Tüm modelleri v1'e zorlayın, yerel v2'yi devre dışı bırakın ve aktif iş parçacığı sınırını koruyun. |
| `mode default` | Yukarı akış model yüzeyi sabitlemelerine saygı gösterin. |
| `mode v2` | Tüm modelleri v2'ye zorlayın, yerel v2'yi etkinleştirin ve aktif iş parçacığı sınırını koruyun. |
| `threads <n>` | Aktif v1/v2 iş parçacığı sınırını en az 1 olan bir tamsayıya ayarlayın. |
| `mode-hint <text>` | Her model ve çaba için Proaktif yetkilendirme ipucunu (Ultra modu) ayarlayın. |
| `mode-hint --clear` | İpucunu kaldırın, böylece çabadan türetilen politika (ultra = proaktif) devam eder. |

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 on
ocx v2 threads 16
ocx v2 mode-hint "Proactive multi-agent delegation is active."
ocx v2 mode-hint --clear
```

`mode` alt komutu, opencodex yapılandırmasına `multiAgentMode` yazar ve Codex
kataloğunu yeniden senkronize eder. Mod ve bayrak geçişleri geçerli sayısal iş
parçacığı sınırını geçerli v1/v2 Codex anahtarları arasında taşır; başarısız bir
geçiş orijinal `config.toml`'u geri yükler. Değişiklikler yeni Codex
oturumlarına uygulanırken çalışan oturumlar sabitlenmiş yüzeylerini korur.

`mode-hint`, `multi_agent_v2` şu anda devre dışı bırakılmış olsa bile Codex'in
`$CODEX_HOME/config.toml` dosyasına
`features.multi_agent_v2.multi_agent_mode_hint_text` yazar. Komut yalnızca
geçersiz kılmayı kalıcı hale getirir; özelliği etkinleştirmez veya devre dışı
bırakmaz, bu nedenle ipucu eşleşen bir Codex yüzeyi etkinken yürürlüğe girer.
İpucu, codex-rs'nin çabadan türetilen çoklu ajan politikasını geçersiz kılar,
böylece herhangi bir model ve herhangi bir akıl yürütme çabası Proaktif
yetkilendirme istemini alır. Akıl yürütme çabasının kendisini **değiştirmez**.
Eksik bir argüman veya yalnızca boşluk içeren bir değer reddedilir; yalnızca
`--clear` ipucunu kaldırır. Alt Ajanlar kontrol panelinin Ultra modu **açık**
anahtarının daha katı bir kapısı vardır: yerel özelliğin açık bir v2 yüzeyiyle
(`ocx v2 mode v2`) etkinleştirilmesini gerektirir; tek başına `ocx v2 on` bu
kontrol paneli kapısını karşılamaz.

## Kombo yönlendirme

### `ocx combo <list|show|set|remove> ...` · `ocx route combo ...`

Kombo yük devretme ve round-robin sanal modellerini yönetin. `ocx route combo`
hiyerarşik takma addır; combo şu anda desteklenen yönlendirme kaynağıdır.
Hedefler `saglayici/model[:agirlik],saglayici/model[:agirlik]` kullanır.

```bash
ocx combo list
ocx route combo set reliable --targets ark/model-a:2,openai/gpt-5.5
```

`set`, `--strategy`, `--sticky`, `--effort`, `--alias`, `--rename-from`,
`--native-alias` ve `--display-name <etiket|->` (`-` etiketi temizler) kabul
eder. Yerel bir takma ad yalnızca şu anda desteklenen, niteliksiz tek bir yalın
OpenAI model kimliğini yakalar. Yalın `gpt-5.6-*` yerel takma adları Codex
Pool/Direct kimlik bilgilerini kullanır. Hesap nitelikli OpenAI rotaları ayrı
kalırken, `openai-apikey/gpt-5.6-*` gibi sağlayıcı nitelikli rotalar
yapılandırılmış API anahtarlarını kullanır ve asla yerel takma ada düşmez.
Uyumluluk çiftini etkinleştirmeden önce kılavuzdaki güvenlik ve görünürlük
sözleşmesini okuyun.

Yönlendirme davranışı ve yapılandırma rehberliği için
[Kombolar](/tr/guides/combos/) sayfasına bakın.

## Gözlemlenebilirlik ve hata ayıklama

### `ocx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...`

Proxy isteklerini, kullanımını, depolamasını, belleğini ve hata ayıklama
verilerini inceleyin. Doğrudan takma adlar şunlardır:

| Takma ad | Eşdeğer kaynak |
| --- | --- |
| `ocx logs [filtreler] [--follow] [--json\|--jsonl]` | `ocx observe logs` |
| `ocx usage [--range <today\|1d\|7d\|30d\|all>] [--surface <all\|codex\|claude\|grok>] [--provider <name>] [--model <id>] [--json]` | `ocx observe usage` |
| `ocx storage [--json]` | `ocx observe storage` |
| `ocx memory [--json]` | `ocx observe memory` |

```bash
ocx observe usage --range 30d --json
```

Bazı kullanım kayıtları dahil edilemiyorsa okunabilir çıktı, okunabilir satır olmadığında da uyarı gösterir. Gösterilen toplamlar yalnızca okunabilir kayıtları yansıtır. Filtreyle eşleşen okunabilir kayıt yoksa toplam satırları yerine uyarı ve yönlendirme gösterilir; atlanan kayıtlar eşleşme içerebilir. `--json`, yanıttaki `usageIncomplete` tanısını ve nedenini korur.

### `ocx debug <provider|usage|injection|claude> <on|off|status|reset|logs [-f]>`

Çalışan proxy'nin yönetim API'si aracılığıyla çalışma zamanı hata ayıklama
geçersiz kılmalarını okuyun veya değiştirin.

```bash
ocx debug provider on|off|status|reset
ocx debug provider logs [-f|--follow]
ocx debug usage on|off|status|reset
ocx debug usage logs [-f|--follow]
```

Kapsam belirtilmediğinde `ocx debug` kullanımı ve proxy durdurulduğunda bir
sonraki başlangıç ortamı varsayılanlarını yazdırır. Sağlayıcı hata ayıklaması
varsayılan olarak `OCX_DEBUG=1`'den gelir (eski `OCX_DEBUG_FRAMES=1` de
çalışır); kullanım hata ayıklaması varsayılan olarak
`OPENCODEX_USAGE_DEBUG=1`'den gelir.

## API erişimi

### `ocx access <key|endpoints|models|test> ...`

OpenCodex erişim API anahtarlarının listesini, harici uç noktaları ve modelleri inceleyin. `ocx api-key`, `ocx access key` komut ailesinin takma adıdır.

Anahtar oluşturma ve anahtar yenilemeyi başlatma işlemleri, hem metin hem de JSON çıktısında yalnızca bir kez gösterilen açık metin kimlik bilgisi döndürür. Ajanlar bu adımları, ajan oturumu dışında bir insanın doğrudan kullandığı terminale bırakmalıdır. Anahtarın kendisini sohbette istemeyin; yalnızca yapılandırmanın ve bağlantı testinin tamamlandığına dair onayı ve gizli olmayan anahtar ile yenileme kimliklerini alın.

```bash
ocx access key list --json
```

Yeni anahtarın yapılandırılıp doğrulanması, eski anahtarı iptal etme izni değildir. Yenilemeyi kesinleştirmek veya eski anahtarı silmek için o anahtarın iptaline yönelik ayrıca açık izin gerekir. İzin verilen işlemden sonra listeyi yeniden kontrol edin. Doğrudan API çağrılarıyla bu süreci aşmaya çalışmayın.

## İstemci entegrasyonları

### `ocx integration <claude|grok> ...`

Desteklenen Claude ve Grok entegrasyonlarını yönetin. Aşağıdaki doğrudan komut
aileleri istemciye özgü denetimlerini ortaya çıkarır.

### `ocx claude [claude argumanlari...]`

Proxy'nin çalıştığından emin olun, ardından `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` ve
`config.claudeCode` model yuvalarıyla Claude Code'u başlatın. Yönlendirilen
modeller, Claude Code 2.1.129 veya daha yenisi ile kararlı yuva takma adları
aracılığıyla yerel `/model` seçicisinde görünür. Daha eski sürümlerde
`ANTHROPIC_MODEL` veya `/model <id>` ile seçin. Kullanıcı tarafından dışa
aktarılan `ANTHROPIC_*` değişkenleri her zaman önceliklidir.

Claude Desktop profil komutları şunlardır:

```text
ocx claude desktop [apply]                         Dört aileli profili kaydedin ve uygulayın
ocx claude desktop show [--json]                   Rotaları, aileleri ve varsayılanları gösterin
ocx claude desktop move <route> <family> [--default]
ocx claude desktop default <family> <route|none>
ocx claude desktop export <path|->                 Sürümlenmiş JSON dışa aktarın (`-` = stdout)
ocx claude desktop import <path> [--apply]         JSON doğrulayın ve içe aktarın
```

Aileler `opus`, `fable`, `sonnet` ve `haiku`'dur; yeni rotalar `opus` ile
başlar. `none` yalnızca o aile boş olduğunda geçerlidir. Eski uygulama
bayrakları `--static`, `--hybrid` ve `--discovery-only` desteklenmeye devam
eder. Claude Code ayarları için `ocx claude config <status|set> ...` kullanın.

### `ocx codex [codex args...]`

Anahtar yalnızca yapılandırma ve ad alanları diğer güvenlik sorumlularının değişikliklerine karşı korunduğunda sağlanır; geçerli kullanıcı ve ayrıcalıklı işletim sistemi yetkilileri güvenilirdir. Aynı kullanıcının süreçlerine güvenilir: yazma yetkinize sahip bir aktör OpenCodex anahtar dosyanızı zaten okuyabilir. Doğrulama ile yerel başlatma arasında aynı kullanıcının yapılandırmayı değiştirmesi bu tehdit modelinin kapsamı dışındadır; başlatıcı aktarım sırasında yapılandırmayı dondurmaz.

Normal Windows kurulumunda varsayılan ProgramData izinleri diğer kullanıcıların dizin oluşturmasına izin verir. Bu nedenle `ProgramData\OpenAI\Codex` yokken bile otomatik kimlik bilgileri verilmez. ProgramData altındaki sistem Codex yapılandırma klasörü mevcut olmalı ve yalnızca Administrators/SYSTEM tarafından yazılabilir olmalıdır; üst dizinler de diğer kullanıcıların değiştirmesine karşı korunmalıdır. Bir yöneticiden dizin politikasını incelemesini isteyin. opencodex ACL’leri kendisi hiçbir zaman değiştirmez ve hazırlık komutu sağlamaz.

Alternatif olarak anahtarı kendiniz sağlayabilirsiniz; örneğin `OPENCODEX_API_AUTH_TOKEN` ortam değişkenini dışa aktarabilirsiniz. `ocx codex` bu değeri değiştirmez. Mevcut sistem yapılandırma dosyaları otomatik kimlik bilgilerini engellemeye devam eder ve ayrıca incelenmelidir. Her engelleme nedeni, anahtar değeri, anahtar dosyası içeriği veya yolu içermeyen kısa ve belirli bir stderr satırı üretir.

Bilinmeyen bir Codex alt komutu seçilmesini önlemek için tek sözcüklü istemden önce `--` kullanın.

Makine yapılandırma alanı, diğer kullanıcıların eksik sistem dosyalarını oluşturmasını da engellemelidir. Korunmayan Windows ProgramData/OpenAI/Codex alanı otomatik belirteci engeller; dizin oluşturulmaz. macOS yalnızca ret içeren ACL’leri ve salt okunur izinleri kabul eder. Yazma, ekleme, silme, öznitelik, güvenlik veya sahip değişikliği veren her izin, önce bir ret olsa da reddedilir. Bilinmeyen etiketler ve inceleme hataları da reddedilir.

Yeni hizmet belirteci yalnızca argv aşağıdaki izin listesinde olduğunda, boş olmayan HTTP(S)/ALL proxy veya `CODEX_*`/`OPENAI_*`/`AZURE_OPENAI_*` ortam geçersiz kılmaları bulunmadığında (kanonik `CODEX_HOME` izinlidir) ve home/config/system ad alanları sahiplik denetimlerini geçtiğinde okunur. Yapılandırma yalnızca denetlenmiş anahtarları ve tam yönetilen loopback sağlayıcısını içermeli; ek kimlik bilgisi tüketicisi veya yapılandırma katmanı bulunmamalıdır. `-c`/`--config`, `-p`/`--profile`, bilinmeyen bayraklar ve `resume`/`fork` dahil liste dışındaki her argüman belirteci engeller ve değer içermeyen tanı üretir; açık kimlik bilgileri ve özgün argümanlar korunur.

Kanonik dizin ve `config.toml` geçerli kullanıcıya ait olmalıdır. POSIX group/other yazmasını reddeder; Windows sahip SID’sini doğrular ve geçerli kullanıcı, SYSTEM ve Administrators dışındaki DACL yazma izinlerini reddeder. Üst yol değiştirme izinleri de denetlenir. macOS ayrıca zorunlu Codex tercihlerinin bulunmamasını gerektirir. Bu kontroller aynı kullanıcı veya yönetici olarak çalışan kötü amaçlı işlemleri yalıtmaz.

| Allowlist | Flags |
| --- | --- |
| Switches | `--no-daemon`, `--json`, `--ephemeral`, `--skip-git-repo-check`, `--no-alt-screen`, `--full-auto`, `--dangerously-bypass-approvals-and-sandbox`, `--search` |
| One value | `--model`/`-m`, `--sandbox`/`-s`, `--ask-for-approval`/`-a`, `--image`/`-i` |



Otomatik kimlik bilgisi yükleme, `CODEX_HOME` içindeki `~` ve boşlukları değişmez yol olarak yorumlar, doğrular ve aynı kurallı mutlak yolu alt sürece aktarır. Okunamayan dizinde yükleme atlanır. Büyük/küçük harfe bakılmaksızın boş olmayan `HTTP_PROXY`, `HTTPS_PROXY` veya `ALL_PROXY` değeri varsa `NO_PROXY` ne olursa olsun yükleme atlanır; reddedilen başlatmalar ve kullanıcının dışa aktardığı kimlik bilgileri değiştirilmez. Yeni token aktarılırken alt sürecin `NO_PROXY` ve `no_proxy` değerlerine mevcut istisnalar korunarak `127.0.0.1` ve `::1` eklenir. `features.respect_system_proxy` etkinleştirilirse veya `--enable`/`--disable` aktarılırsa otomatik yükleme atlanır.

Başlatıcı proxy'yi başlatmayı dener ve özgün argümanları Codex'e aktarır; yapılandırmayı yeniden yazmaz. Yerel Codex ve yabancı ağ geçidi yolları proxy başlangıcını atlar. Bilinmeyen yol uyarıp başlangıcı dener; başarısızlık uyarır ve devam eder. Yardım, sürüm ve `login`, `doctor`, `help` gibi iç komutlar başlangıcı ve otomatik belirteç okumayı atlar.

Eksik `OPENCODEX_API_AUTH_TOKEN`, yalnızca seçili provider'ın tüm taşıma yapılandırması bu kurulumun yapılandırılmış loopback dinleyicisi veya kayıtlı yerel istemci bağlantısı için yönetilen blokla eşleştiğinde bu kurulumun `service-api-token` dosyasından okunur. Adlar ve açıklamalar yetki vermez. Bilinmeyen veya uzak hedefler, varsayılan profile, proje yapılandırması, `OPENAI_BASE_URL` ve iletilen `-c`/`--config`, `-p`/`--profile`, `-C`/`--cd`, `--remote` otomatik okumayı atlar. Kullanıcının dışa aktardığı kimlik bilgileri ve argümanlar korunur; belirteç dosyası geçersiz kılmaları ve yönetim belirteci çakışmaları reddedilir.

Yalnızca eşleşen (`matched`) autostart wrapper arkasındaki Codex’i doğrudan başlatır. İnceleme istisnası dahil bilinmeyen durum doğrulanmış bypass gerektirir; yönetilen Windows CMD wrapper’ları `OCX_SHIM_BYPASS=1` ile çalışmadan önce güncel şablonun tamamıyla eşleşmelidir. Normal npm başlatıcıları desteklenir. Doğrulanamayan veya eski wrapper, Codex başlamadan çıkış kodu 1 ile reddedilir; `ocx codex-shim install` ile yenileyin. Bu başlatma shim’i onarmaz; içerik denetimi Windows backing dosyasının kaynağını veya eşzamanlı yol değişimini güvenceye almaz.

Başlatıcı yardımı: `ocx help codex`; Codex yardımı: `ocx codex --help`. Sonraki düz `codex` çalıştırmasının davranışı korunur.

### `ocx opencode [opencode argumanlari...]`

Proxy'nin çalıştığından emin olun, ardından OpenCode'un satır içi çalışma zamanı
katmanında (`OPENCODE_CONFIG_CONTENT`) üretilen `provider.opencodex` ve
`providers.opencodex` bloklarıyla opencode'u başlatın. Mevcut satır içi yapılandırma korunur ve bu
başlatma için yalnızca bu iki anahtar değiştirilir. Mevcut bir geçersiz
kılma hakkında uyarmak için genel veya proje `opencode.json` dosyaları
okunabilir, ancak diskteki dosyalar asla değiştirilmez. Yönlendirilen modeller
`opencodex/<saglayici>/<model>` olarak görünür. Daha sonra düz `opencode`
başlatmak tam olarak eskisi gibi davranır.

### `ocx grok <status|exclude|include|set|clear|apply> ...`

Grok Build model çitini yönetin ve uygulayın.

## İstemci yapılandırma dışa aktarma

### `ocx export --client <opencode|pi|omp|hermes|openclaw|kimi|gajae|dsh|mcode|zcode|prime|aside|raycast|omo|cline|kilo|commandcode|droid>`

Çalışan proxy'ye bağlı bir istemci yapılandırmasını yazdırın. Komut, `opencodex`
sağlayıcı bloğunu — temel URL, model listesi ve istemcinin kimlik bilgisi
referansı veya geri döngü yer tutucusu — seçilen istemcinin yerel formatında
serileştirir.

Proxy çalışıyor olmalıdır; komut canlı portunu çözer, `/api/models` okur ve
yalnızca Codex'in şu anda görebildiği modelleri yayınlar.

| Bayrak | Eylem |
| --- | --- |
| `--client <opencode\|pi\|omp\|hermes\|openclaw\|kimi\|gajae\|dsh\|mcode\|zcode\|prime\|aside\|raycast\|omo\|cline\|kilo\|commandcode\|droid>` | Gerekli. İstemci yapılandırma lehçesini seçer. |
| `--json` | Betikler için stdout üzerinde oluşturulan belgeyi JSON olarak yazdırın. Bu, seçilen istemcinin yerel formatı YAML, TOML veya JSON5 olsa bile JSON'dur. |
| `--out <path>` | İstemcinin yerel yapılandırma formatını `<path>` konumuna yazın. Mevcut bir dosyanın üzerine yazmayı reddeder. |
| `--force` | `--out`'un mevcut bir dosyanın üzerine yazmasına izin verin. |

```bash
ocx export --client opencode                     # yapılandırma artı hedef, birleştirme uyarısı ve sayılar
ocx export --client pi --json > pi-models.json   # bir boru veya fark için JSON belgesi
ocx export --client omp --out ./omp-models.yml    # yerel OMP YAML
ocx export --client opencode --out ~/opencodex-opencode.json
```

`--json` olmadan önce oluşturulan yapılandırma, ardından kurallı hedef yolu,
birleştirme uyarısı, istemcinin sahip olduğu ortam dışa aktarma satırı ve kaç
satırın bağlam sınırlarını atladığını içeren bir model sayısı (istemci bunlar
için kendi varsayılanlarını uygular) gelir.

| İstemci | Kurallı hedef | İndirme dosya adı | Ortam değişkeni |
| --- | --- | --- | --- |
| `opencode` | `~/.config/opencode/opencode.json` (`XDG_CONFIG_HOME` ayarlandığında kazanır) | `opencode.json` | `OPENCODEX_OPENCODE_API_KEY` |
| `pi` | `~/.pi/agent/models.json` (ayarlandığında `PI_CODING_AGENT_DIR` öncelikli; göreli değer reddedilir) | `pi-models.json` | yok — blok değişmez `opencodex-loopback` taşır |
| `omp` | `~/.omp/agent/models.yml` (boş olduğunda bile `OMP_PROFILE`, `PI_PROFILE`'a üstün gelir; adlandırılmış profiller eve göre `PI_CONFIG_DIR` dizin adını kullanır ve `PI_CODING_AGENT_DIR`'i yok sayar, varsayılan profil ise `PI_CODING_AGENT_DIR`'in kazanmasına izin verir) | `omp-models.yaml` | yok — geri döngü yer tutucusu |
| `hermes` | `~/.hermes/config.yaml` | `hermes-config.yaml` | `OPENCODEX_HERMES_API_KEY` |
| `openclaw` | `~/.openclaw/openclaw.json` | `openclaw.json5` | `OPENCODEX_OPENCLAW_API_KEY` |
| `kimi` | `~/.kimi-code/config.toml` | `kimi-config.toml` | yok — geri döngü yer tutucusu |
| `gajae` | `~/.gjc/agent/models.yml` | `gajae-models.yaml` | gizli olmayan geri döngü yer tutucusu |
| `dsh` | `$DSH_HOME/settings.yaml` (varsayılan `~/.dsh/settings.yaml`) | `settings.yaml` | yok — gizli olmayan geri döngü bearer yer tutucusu |
| `mcode` | `~/.minimax/config.yaml` (ayarlandığında `MINIMAX_DATA_DIR`, ardından eski `MAVIS_DATA_DIR` öncelikli; göreli değer reddedilir) | `mcode-config.yaml` | yok — geri döngü yer tutucusu |
| `zcode` | `~/.zcode/v2/config.json` (ayarlandığında `ZCODE_DATA_DIR` öncelikli; göreli değer reddedilir) | `config.json` | yok — geri döngü yer tutucusu |
| `prime` | `~/.prime/agent/models.json` (ayarlandığında `PRIME_AGENT_CODING_AGENT_DIR` öncelikli; göreli değer reddedilir) | `prime-models.json` | yok — geri döngü yer tutucusu |
| `aside` | Aside'ın kendi `accounts.json` dosyasının güncel olarak gösterdiği hesap için `~/.aside/u/<account>/models.json`; okunamayan bir manifest, gelişigüzel bir hesaba düşmek yerine reddedilir | `aside-models.json` | yok — geri döngü yer tutucusu |
| `raycast` | `~/.config/raycast/ai/providers.yaml`, macOS ve Windows'ta aynı (Raycast `XDG_CONFIG_HOME` değerini dikkate almaz) | `raycast-providers.yaml` | yok — yalnızca geri döngü, `api_keys` girdisi yazılmaz |
| `omo` | `~/.omo/agent/models.json` (ayarlandığında sırasıyla `OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR` öncelikli; göreli değer reddedilir) | `omo-models.json` | yok — geri döngü yer tutucusu |
| `kilo` | `~/.config/kilo` altında ilk bulunan `kilo.jsonc`, `kilo.json`, `opencode.jsonc`, `opencode.json` veya `config.json` (`XDG_CONFIG_HOME` bu dizini taşır); hiçbiri yoksa `kilo.jsonc` kullanılır | `kilo.jsonc` | `OPENCODEX_KILO_API_KEY` |
| `commandcode` | `~/.commandcode/providers.json` (Windows’ta varsayılan ana dizin kullanılırken: `HOME ?? USERPROFILE` değerini yalnızca boş veya sırf boşluklardan oluşmayan mutlak bir Windows yoluysa kullanır, aksi halde `homedir()` kullanılır; ayrıca verilen ana dizin korunur; sonuna `.commandcode\providers.json` eklenir) | `providers.json` | yalnızca geri döngü; `apiKey: false`; ortam değişkeni gerekmez |
| `droid` | `~/.factory/settings.json` (`%USERPROFILE%\.factory\settings.json` on Windows) | `factory-settings.json` | yalnızca loopback; ortam değişkeni gerekmez |

Bu yollar varsayılandır. Varsayılan ev dizininde kalan `~/.zcode/v2/setting.json` içindeki mutlak `dataBaseDir`, depoyu `<dataBaseDir>/.zcode/v2/provider_config.json` konumuna taşır. `ZCODE_DATA_DIR` doğrudan `.zcode` kökünü belirtir ve ayardan önceliklidir; `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` sağlayıcı dosyası için önceliklidir. Okunamayan, bozuk veya göreli ayarlar yeni uygulamaları ve yenilemeleri engeller. Mevcut sahiplik ve geri alma kayıtları korunur. [İngilizce yol ve geri alma kurallarına](https://opencodex.me/guides/integrations/#zcode-314-and-later) bakın.

Raycast dışa aktarımı, `providers` dizisinde tek bir `id: opencodex` öğesi içeren bağımsız
bir `providers.yaml` belgesidir: `name: OpenCodex`, proxy'nin `/v1` temel URL'si ve
`abilities` alanıyla birlikte yönlendirilen her model (`tools` ve `system_message` her
zaman destekli, `vision` kataloğun giriş modalitelerinden, `reasoning_effort` modelin bir
çaba merdiveni varsa, `temperature` akıl yürütme modelleri için kapalı). Özel sağlayıcılar
bir Raycast Pro özelliğidir ve Raycast dosyayı izlediği için kaydedilen bir değişiklik
yeniden başlatma gerekmeden etkili olur. Format
[manual.raycast.com/ai/custom-providers](https://manual.raycast.com/ai/custom-providers)
adresinde belgelenmiştir. Hiçbir `api_keys` girdisi yazılmaz; bu yüzden bu dışa aktarım
yalnızca geri döngü içindir ve geri döngü dışı bir bağlama reddedilir.

opencode `{env:OPENCODEX_OPENCODE_API_KEY}` değerini enterpole eder. Üretilen Pi
ve OMP dışa aktarımları bir ortam değişkeni gerektirmez: her biri değişmez
`opencodex-loopback` yer tutucusunu taşır. Bu önemlidir çünkü her iki istemci de
model listelerini oluştururken `apiKey`'i çözer ve mevcut bir yapılandırma
ayarlanmamış bir ortam referansı içerdiğinde tüm sağlayıcıyı gizler. Proxy geri
döngüde üretilen yer tutucuyu asla kontrol etmez. OMP sağlayıcı düzeyinde
başlıkları destekler, ancak bu ilk entegrasyon kasıtlı olarak yalnızca geri
döngü olarak kalır; uzaktan `x-opencodex-api-key` bağlantısı ertelenmiştir.

:::caution[Birleştirin, asla üzerine yazmayın]
`ocx export` asla gerçek istemci yapılandırmanızı yazmaz. Hedef elle
birleştirmeniz için yazdırılır ve `--out`, `--force` olmadan mevcut bir dosyanın
üzerine yazmayı reddeder; çünkü bir yapılandırmanın üzerine yazmak içindeki
diğer sağlayıcıları, ajanları ve MCP girdilerini yok eder.
:::

Hiçbir anahtar asla serileştirilmez. Yapılandırmalar belgelenmiş bir ortam
referansı veya gizli olmayan bir geri döngü yer tutucusu taşır. Geri döngü adresi (`127.0.0.1`) tek başına anahtarsız erişimi kanıtlamaz; hedefin politikasını ve uç noktasını kontrol edin. Seçili anahtarla model/ses CLI komutları geri döngüde de açık anahtar girişi gerektirir. Referans
verilen bir değişkeni yalnızca istemci şeması desteklediğinde ve proxy geri
döngünün ötesine bağlandığında ayarlayın; kabul anahtarlarının nasıl verildiğini
görmek için [Uzaktan erişim](/tr/reference/configuration/server/#uzaktan-erişim)
bölümüne bakın. Yukarı akış sağlayıcılarının kendi anahtarları tamamen ayrı bir
şeydir ve [Sağlayıcılar](/tr/guides/providers/) bölümüne göre yapılandırılır.
Oluşturulan gjc entegrasyonu gizli olmayan bir loopback yer tutucusu kullanır; ortam değişkeni gerekmez. Yalnızca loopback desteklenir, uzak erişim kimlik bilgileri yapılandırılmaz.

Aynı yük `GET /api/client-config` tarafından sunulur ve kontrol panelinin API
sekmesinde işlenir; böylece CLI, API ve GUI aynı baytları kullanır.

## Çalışma zamanı ve yapılandırma

### `ocx system <status|settings|startup|diagnostics|sync|codex-app-server|codex-restart|update|codex-cli-update> ...`

Başsız çalışma zamanı ayarlarını, başlatmayı, senkronizasyonu, tanılamayı ve
güncellemeleri yönetin.

`ocx system codex-restart --yes`, `ocx sync --restart-codex` ile aynı modül
üzerinden Codex app-server'larını yeniden başlatır. Model seçici uygulama
açılırken oluşturulduğu için Codex masaüstü uygulamasını güncel model kataloğu yazılmadan önce başlatılmışsa veya bu istek `model_catalog_json` bağını değiştirdiyse tamamen kapatıp yeniden başlatır. Aksi
halde uygulama açık kalır, kendi app-server'ını yeniden başlatır ve
gönderilmemiş taslakları ve bekleyen onayları korur. Uygulama veya katalog
durumu okunamazsa tam yeniden başlatma yapılır. Proxy'nin kendisi Codex
uygulamasının içinde çalışıyorsa masaüstü yeniden başlatması, tamamlayamayacağı
bir devri vaat etmek yerine eyleme geçirilebilir bir iletiyle reddeder.

Bu isteğin `model_catalog_json` bağını değiştirmesi de kabuk katalog dosyası yazıldıktan sonra başlamış olsa bile masaüstünün yeniden başlatılmasını gerektirir.

```bash
ocx system settings --stream-mode eager-relay
```

`ocx system update` OpenCodex'in kendisini günceller. Codex CLI için ayrı, salt okunur komutu kullanın:

```bash
ocx system codex-cli-update check --json
```

`check` kayıt defterini sorgulamaz ve Codex’i çalıştırmaz. POSIX üzerinde çözümleyicinin seçtiği kanonik yol, yayımlanmış başlatıcının yakaladığı ortam adayıyla aynıysa `selectionAttested: true` olabilir. Bağlantılı npm-global paket bildirimi sahipliği doğrularsa ve aday sürüm bildirildiyse bu sürüm bildirimdeki sürümle eşleşirse `managed: true` olabilir; kalıcı adaylar doğrulanmaz. Windows x64 ayrıca kanıta bağlı mutlak standart npm `codex.cmd` ile tutulan tanıtıcılara bağlı bir Node/npm araç zincirini (varsa önek-yerel, yokluğu doğrulanırsa başlatıcı mimarisine bağlanmış yakalanan PATH çifti) ve önek içinde doğrulanmış platform desteğini destekler; yeniden ayrıştırmayı reddeden tutulan tanıtıcılar kullanır. Diğer Windows düzenleri ertelenmiş veya yönetimsiz kalır. Windows'taki bir `managed` sonucu yalnızca gözlemlenen kurulum düzenini sınıflandırır: bağlı Node/npm, güncelleyicinin salt okunur meta veri araç zinciridir ve sonraki bir `codex.cmd` çağrısının hangi yorumlayıcıyı çözeceğine dair bir güvence değildir. Doğrudan Bun/kaynak çalıştırması başlatıcı kanıtı sağlamaz. `plan`, yalıtılmış geçici npm yapılandırması, önbelleği ve günlükleriyle resmî kayıt defterini sorgular; etkin oturumları veya eksik süreç gözlemini reddeder. Yazılım kurmaz ve süreçlere sinyal göndermez. Windows x64 apply, doğrulanmış özel yazma yetkisine sahip sınırlı bir npm öneki gerektirir ve ilgisiz paketleri ve shim'leri korur; desteklenmeyen gözlemlenen düzenler `applicable: false` ve `refusal: windows_apply_disabled` döndürür; yalnızca PATH seçimi, OpenCodex otomatik başlatma sarmalayıcıları ve global/vendor geri dönüşü ertelenmiş kalır. [Komutların ve ret nedenlerinin tam açıklamasına (İngilizce)](/reference/cli/agents/#read-only-codex-cli-update-plan) bakın.

Windows üzerinde `CODEX_CLI_PATH=codex` gibi yalın bir komut, uzak yol veya aygıt yolu aday olarak yakalanırsa `candidate_path_unavailable` bildirilir. Aday yakalanmıştır; ancak yolu bu inceleme için uygun değildir.

#### Windows x64 kurulumunu açıkça gözlemleme

```text
ocx system codex-cli-update attest [--json]
ocx system codex-cli-update attest --candidate <absolute-path> --npm-prefix <absolute-path> --npm-cli <absolute-path> --node <absolute-path> [--json]
```

`attest`, seçili veya açıkça belirtilen bir Windows x64 npm kurulumunu yalnızca okuyan isteğe bağlı bir işlemdir. Seçenek verilmezse komut, güvenilir başlatıcı anlık görüntüsünün belirlediği seçili adayı (yapılandırılmış `CODEX_CLI_PATH` veya yakalanan PATH üzerindeki ilk `codex`) gözlemler; opencodex sarmalayıcısı, yeniden adlandırılmış `codex.opencodex-real.cmd` npm yedeğine çözümlenir. Dört mutlak yolun tümünü sağlamak keşfi geçersiz kılar; keşif yalnızca yol önerir ve tutulan tanıtıcı gözlemi nihai otoritedir. `--candidate`, standart npm `<prefix>/codex.cmd` veya `<prefix>/node_modules/@openai/codex/bin/codex.js` yoludur. `--npm-cli`, `node_modules/npm/bin/npm-cli.js` ile bitmeli; `--node` açık bir `node.exe` belirtmelidir. Uygulama paketleri, tanınan sürüm yöneticisi yerleşimleri, npm yedeği olmayan opencodex shim’leri ve özel sarmalayıcılar reddedilir.

Sınırlı okuma boyunca yerel tanıtıcılar üst dizinleri ve dosyaları açık tutar. Desteklenmeyen platformlar, yeniden ayrıştırma noktaları/junction, çakışan yazıcılar, güvenli olmayan yollar ve aşırı büyük dosyalar reddedilir. Sabit rapor yol içermez: `status`, `observed` veya `refused` olur ve `installationIdentityObserved` sunulur. `selectionAttested`, `managed` ve `applyAllowed` daima `false` kalır. Raporlanan ret 0 çıkış kodu üretebildiğinden `status` alanını denetleyin.

Kimlik veya özet yalnızca gözlem anındaki dosyaları tanımlar; kalıcı güncelleme izni değildir. Seçilen çalışma zamanını, geçmiş yükleyiciyi, etkin npm yapılandırmasını veya araçların gerçekliğini kanıtlamaz. Verilen Node yalnızca gözlemlenir; başlatıcının onu seçeceği kanıtlanmaz. Hiçbir hedef çalıştırılmaz; kayıt deposu isteği, kurulum, yapılandırma yazımı veya süreç denetimi yapılmaz. Mevcut Windows `check`, aday veya yapılandırma dosya sistemi G/Ç işlemlerini hâlâ yapmaz.

### `ocx config [show|get|set|unset|validate|export|import] ...`

`ocx config [show] [--json] [--source]`, çalışan bir proxy olmadan yerel yapılandırmayı gösterir. `show` atlandığında bayraklardan biri veya ikisi herhangi bir sırayla kullanılabilir. `--source`, tanılama kaynağını, hataları ve uyarıları içerir ve yalnızca görüntüleme için kabul edilir. `--json`, açıkça belirtilen bir eylemden önce gelebilir; çalıştırılan eylemi değiştirmez. Yinelenen `--json` veya `--source` bayrakları ve bilinmeyen bağımsız değişkenler reddedilir.

Doğrulanmış OpenCodex yapılandırmasını inceleyin ve güvenle değiştirin. `show`
ve `get` sırları maskeler. İçe aktarma yazmadan önce doğrular ve `--yes`
gerektirir.

### Forced Claude Code subagent model

The Subagents page offers **Force all subagents onto one model**, off by default. Select an exposed roster-style id, such as `combo/tev-auto`, then enable the switch. The roster is offered first; unavailable saved roster entries cannot be force targets.

`ocx agent subagents force combo/tev-auto` sets `claudeCode.subagentModelForce`; `ocx agent subagents force -` clears it. `ocx agent status` reports the setting. `GET /api/subagent-models` returns `force`, `forceAvailable`, and `forceStatus`; `PUT` accepts `{ "force": "combo/tev-auto" }` or `{ "force": null }` without changing the roster. Omitting `force` leaves it unchanged. Invalid or unexposed targets are rejected on write; stale targets are reported and skipped at launch.

This takes effect on the **next routed `ocx claude` launch**, injecting `CLAUDE_CODE_SUBAGENT_MODEL` as an explicit proxy alias (with `[1m]` only for an authoritative million-token window; native Claude targets use a reversible native alias) and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. Each nonempty shell-exported variable independently wins. Native launches inject neither variable; plain `claude` is not affected. No plugin files or `settings.json` are modified by this setting.

Claude Code **2.1.257 or newer** is required for FORCE. Plugin and built-in agents (including Explore/Plan) and per-call model arguments are overridden. Forks and subagent skills with `model: inherit` keep the main conversation model. The main loop and Haiku/small-fast sidecars are unaffected. Existing roster files remain available.

The dashboard warns about old or unknown CLI versions, unavailable targets, and either variable already present in `settings.json` → `env` (which overrides launch env). Detection is read-only and server-local: it cannot inspect another launch shell, another machine, or project-local settings. An unknown result is not proof of force support.

## Hermes / Command Code: model names

Hermes and Command Code support `--model-names alias|routed` (API: `modelNames`).
The default is `routed`, independent of `preferModelAliasIds`. A connection
stores its mode; later Apply without the option preserves it. Alias mode uses
only provider-qualified aliases that the router proves equivalent; missing,
unsafe or colliding aliases fall back to routed keys. Combos keep their keys.
Removed/renamed aliases migrate on the next successful managed refresh, with
foreign-edit refusal. Named Hermes profiles need explicit Apply.

`ocx export --client hermes --model-names alias --json` previews a current
already loaded catalog without writing client files or managed state; a cold or
stale catalog returns unavailable. Explicit `--out` writes an export artifact.
See the [English integration guide](/guides/integrations/#opt-in-alias-model-names)
for the canonical workflow.
