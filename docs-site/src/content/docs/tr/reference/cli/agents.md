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
```

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

OpenCodex kabul API anahtarlarını yönetin ve harici uç noktaları ile modelleri
inceleyin. `ocx api-key <list|create|remove> ...`, `ocx access key`'in bir takma
adıdır.

```bash
ocx access key create deployment
```

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

### `ocx export --client <opencode|pi|omp|hermes|openclaw|kimi|gajae|dsh|mcode|zcode|prime>`

Çalışan proxy'ye bağlı bir istemci yapılandırmasını yazdırın. Komut, `opencodex`
sağlayıcı bloğunu — temel URL, model listesi ve istemcinin kimlik bilgisi
referansı veya geri döngü yer tutucusu — seçilen istemcinin yerel formatında
serileştirir.

Proxy çalışıyor olmalıdır; komut canlı portunu çözer, `/api/models` okur ve
yalnızca Codex'in şu anda görebildiği modelleri yayınlar.

| Bayrak | Eylem |
| --- | --- |
| `--client <opencode\|pi\|omp\|hermes\|openclaw\|kimi\|gajae\|dsh\|mcode\|zcode\|prime>` | Gerekli. İstemci yapılandırma lehçesini seçer. |
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
| `gajae` | `~/.gjc/agent/models.yml` | `gajae-models.yaml` | `OPENCODEX_GAJAE_API_KEY` |
| `dsh` | `$DSH_HOME/settings.yaml` (varsayılan `~/.dsh/settings.yaml`) | `settings.yaml` | yok — gizli olmayan geri döngü bearer yer tutucusu |
| `mcode` | `~/.minimax/config.yaml` (ayarlandığında `MINIMAX_DATA_DIR`, ardından eski `MAVIS_DATA_DIR` öncelikli; göreli değer reddedilir) | `mcode-config.yaml` | yok — geri döngü yer tutucusu |
| `zcode` | `~/.zcode/v2/config.json` (ayarlandığında `ZCODE_DATA_DIR` öncelikli; göreli değer reddedilir) | `config.json` | yok — geri döngü yer tutucusu |
| `prime` | `~/.prime/agent/models.json` (ayarlandığında `PRIME_AGENT_CODING_AGENT_DIR` öncelikli; göreli değer reddedilir) | `prime-models.json` | yok — geri döngü yer tutucusu |

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
referansı veya gizli olmayan bir geri döngü yer tutucusu taşır. Bir geri döngü
proxy'si (`127.0.0.1`, varsayılan) hiçbir kabul anahtarı gerektirmez. Referans
verilen bir değişkeni yalnızca istemci şeması desteklediğinde ve proxy geri
döngünün ötesine bağlandığında ayarlayın; kabul anahtarlarının nasıl verildiğini
görmek için [Uzaktan erişim](/tr/reference/configuration/#remote-access)
bölümüne bakın. Yukarı akış sağlayıcılarının kendi anahtarları tamamen ayrı bir
şeydir ve [Sağlayıcılar](/tr/guides/providers/) bölümüne göre yapılandırılır.
Gajae istisnadır: `OPENCODEX_GAJAE_API_KEY` provider kimlik bilgisini ortamdan
sağlar, ancak şeması uzaktan kabul başlığını gönderemediği için üretilen Gajae
entegrasyonu yalnızca geri döngüde çalışır.

Aynı yük `GET /api/client-config` tarafından sunulur ve kontrol panelinin API
sekmesinde işlenir; böylece CLI, API ve GUI aynı baytları kullanır.

## Çalışma zamanı ve yapılandırma

### `ocx system <status|settings|startup|diagnostics|sync|codex-app-server|codex-restart|update|codex-cli-update> ...`

Başsız çalışma zamanı ayarlarını, başlatmayı, senkronizasyonu, tanılamayı ve
güncellemeleri yönetin.

```bash
ocx system settings --stream-mode eager-relay
```

`ocx system update` OpenCodex'in kendisini günceller. Codex CLI için ayrı, salt okunur komutu kullanın:

```bash
ocx system codex-cli-update check --json
```

`check` paket kayıt defterine istek göndermez ve yapılandırmada belirtilen kurulum adayına ilişkin provenance kanıtını, maskelenmiş yürütülebilir dosya konumu ve sahiplik kanıtı dâhil, sınırlı biçimde inceler. Yayımlanmış başlatıcıdan gelen güvenilir bağlam aday anlık görüntüsünü doğrular; Codex'in başarıyla çalıştırıldığını doğrulamaz. Bu tek seferlik komut Codex'i hiçbir zaman çalıştırmadığından, ortamdan ve kalıcı kayıtlardan gelen adaylar yalnızca raporlanır (`managed: false`, genellikle `selection_unattested`). JSON çıktısında `candidateAvailable`, `candidateVersion` ve `candidateSource` alanları bulunur; `selectionAttested` değeri ise `false` kalır. Yapılandırmada belirtilen kurulum adayını incelemek için yayımlanmış başlatıcıdan gelen güvenilir bağlam gerekir; Bun ile veya kaynak koddan doğrudan başlatıldığında bu kanıt bulunmadığından ortamdaki ve kalıcı kayıtlardaki aday durumu yok sayılır ve `candidate_unavailable` bildirilebilir. Windows'ta bu ilk parça, aday veya yapılandırma yollarında hiçbir dosya sistemi G/Ç işlemi yapmaz. Yalnızca güvenilir başlatıcının yakaladığı mutlak bir ortam adayı sözcüksel olarak uygulama paketi ya da sürüm yöneticisi etiketi alabilir; diğer tüm Windows adayları kapalı başarısızlıkla reddedilir. Komut Codex veya bir paket yöneticisi çalıştırmaz, shim'i onarmaz, yapılandırmaya ya da önbellek durumuna yazmaz, hiçbir süreci durdurmaz ve hiçbir şey kurmaz. Uygulamayla birlikte paketlenmiş adaylar, tanınan sürüm yöneticisi yollarında bulunan adaylar, doğrulanmamış bağımsız adaylar ve belirsiz shim durumları `unmanaged` veya `unknown` olarak raporlanır; hiçbir zaman `managed` olarak sınıflandırılmaz.

### `ocx config <show|get|set|unset|validate|export|import> ...`

Doğrulanmış OpenCodex yapılandırmasını inceleyin ve güvenle değiştirin. `show`
ve `get` sırları maskeler. İçe aktarma yazmadan önce doğrular ve `--yes`
gerektirir.
