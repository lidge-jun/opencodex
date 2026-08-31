---
title: Sağlayıcılar
description: opencodex'in bir LLM sağlayıcısıyla kimlik doğrulaması yapmasının ve konuşmasının her yolu — OAuth, API anahtarı, ChatGPT iletme ve yerel.
---

Bir **sağlayıcı**, bir yukarı akış LLM uç noktası artı ona nasıl ulaşılacağıdır:
bir adaptör, bir temel URL, bir kimlik doğrulama modu ve isteğe bağlı bir model
listesi. Sağlayıcılar `~/.opencodex/config.json` içinde `providers` altında
bulunur.

## OpenAI hesap modları

| Sağlayıcı kimliği | Kullanım | Kimlik bilgisi/hesap kuralı |
| --- | --- | --- |
| `openai` | Codex girişi | Pool (varsayılan) ana hesap artı eklenen hesapları seçer; Direct yalnızca geçerli arayan/ana girişi kullanır. |
| `openai-apikey` | OpenAI API | Yalnızca yapılandırılmış API anahtarı/anahtar havuzu; Codex hesaplarını asla okumaz. |

Sağlayıcılar sayfasındaki Pool/Direct seçeneğiyle yalın `gpt-5.6-sol` kullanın
veya API için `openai-apikey/gpt-5.6-sol` kullanın. Kimlik bilgisi rotaları asla
birbirine geri dönmez (fall through yapmaz). API rotası 922.000 bağlam /
922.000 maksimum girdi meta verisi yayınlar. `sol-pro`, `terra-pro` ve
`luna-pro` sanal kimlikleri, hat temel modeli artı `reasoning.mode: "pro"`
kullanırken seçilen genel kimliklerini korur.

Yerleşik `openai` sağlayıcısı eksikse veya devre dışıysa, kontrol paneli
Hesaplar seçicisi ve Codex Auth sayfası onu geri yükleyebilir: bulunmayan
satırlar kurallı önayardan oluşturulur, devre dışı bırakılmış kurallı satırlar
kayıtlı mod veya model ayarlarını değiştirmeden yeniden etkinleştirilir ve
kurallı olmayan `openai` satırlarına bu kurtarma yolu sunulmaz.

### Sağlayıcılar genel bakış havuz kapasitesi

Pool modundaki Codex girişi için Sağlayıcılar genel bakışı, sağlayıcı toplamı
olarak rastgele bir hesabı sunmak yerine havuzun kullanılan kapasitesinin
yapılandırılmış ağırlıklı bir tahminini gösterir. Aynı satır ayrıca geçerli
etkin hesabın ham kota yüzdesini de gösterir; böylece havuz tahminini yeni bir
isteğin kullanacağı hesaptan ayırt edebilirsiniz.

Sıfırlama bilgisi mevcut olduğunda genel bakış, bir sonraki sıfırlama zamanını
ve bu sıfırlamanın kurtarması beklenen kapasiteyi `+%N havuz kapasitesi` olarak
gösterir. **Eksik kapsam (Incomplete coverage)**, bir veya daha fazla havuz
hesabının örneğin planları veya kotaları bilinmediği, okumaları eski olduğu veya
hesap duraklatıldığı ya da yeniden kimlik doğrulama gerektirdiği için tahmine
güvenli bir şekilde katkıda bulunamadığı anlamına gelir.

**Kısmi pencere kapsamı (partial window coverage)** uyarısı, dahil edilen bazı
hesapların bir kota penceresini bildirdiği ancak diğerini bildirmediği anlamına
gelir. Genel bakış bu pencereleri ayrı tutar ve eksik okumayı o pencere için
kullanım olarak değerlendirmek yerine etkilenen her pencereyi eksik olarak
işaretler.

Bu tahmin yalnızca görüntüleme amaçlıdır. Hesap seçimini, oturum bağlılığını,
otomatik geçişi, soğuma sürelerini veya diğer herhangi bir yönlendirme kararını
değiştirmez. Bireysel hesap durumu ve yönlendirme kontrolleri için [Codex Auth
hesap havuzu](/tr/guides/web-dashboard/#codex-auth-ve-hesap-havuzlari) bölümünü
kullanın.

Sevk edilen v1 yapılandırmaları otomatik olarak işaretçi 2'ye ve tek bir seçenek
duyarlı satıra geçer. Orijinal yapılandırma
`~/.opencodex/config.json.pre-openai-tiers-v2.bak` konumunda bir kez tutulur;
`cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json`
ile geri yükleyin.

## Kimlik doğrulama modları

Sağlayıcı yapılandırmaları üç `authMode` değerini kabul eder (`key`
varsayılandır). Yerleşik kayıt defteri yerel önayarları da ayrı olarak
etiketler; bunlar normalde hem `authMode` hem de `apiKey`'i atlar.

| `authMode` | Nasıl kimlik doğrular | Tarafından kullanılır |
| --- | --- | --- |
| `key` | API anahtarınızı gönderir (`Authorization: Bearer …` veya adaptör başına `x-api-key` / `api-key`). Anahtar bir sabit değer veya bir `${ENV_VAR}` başvurusu olabilir. | Çoğu sağlayıcı. |
| `forward` | **Gelen Codex kimlik doğrulama başlıklarınızı** birebir sağlayıcıya iletir — hiçbir anahtar saklanmaz. Bu, ChatGPT girişi doğrudan geçişidir. | OpenAI (`openai-responses` adaptörü). |
| `oauth` | Saklanan bir OAuth erişim belirtecini çözer (süresi dolmadan önce otomatik olarak yenilenir) ve bunu taşıyıcı anahtar olarak kullanır. | xAI, Anthropic, Kimi, Kiro, Google Antigravity, Cursor, Command Code, GitHub Copilot, Nous Portal. |

[`retryOn429`](/tr/reference/configuration/) aynı anahtarla 429 yeniden oynatma
özelliği yalnızca API anahtarı sağlayıcıları için geçerlidir (`authMode:
"key"`). OAuth, iletme ve yerel önayarlar hariç tutulur — kimlik bilgileri asla
aynı belirteç üzerinde yeniden oynatılmamalıdır ve yerel çalışma zamanlarının
korunacak uzak bir anahtarı yoktur. İsteğe bağlıdır: seçenek olmadığında özellik
kapalıdır; nesnenin varlığı `enabled: false` olmadığı sürece etkinleştirir.

## 1. ChatGPT girişi (iletme / doğrudan geçiş)

`openai` sağlayıcısı **hiçbir API anahtarına** ihtiyaç duymaz. Direct, kimlik
bilgilerini mevcut `codex login`'inizden iletir; Pool, aynı arka ucu kullanmadan
önce bir ana veya eklenen Codex hesabını çözer:

```json
{
  "openai": {
    "adapter": "openai-responses",
    "baseUrl": "https://chatgpt.com/backend-api/codex",
    "authMode": "forward"
  }
}
```

Yalnızca özenle seçilmiş bir başlık kümesi iletilir (`FORWARD_HEADERS`:
yetkilendirme, ChatGPT hesap kimliği, OpenAI beta/originator/oturum — bkz.
[Adaptörler](/tr/reference/adapters/)). Bu yol aynı zamanda [web araması ve
vizyon sidecar'larını](/tr/guides/sidecars/) çalıştıran yoldur.

ChatGPT doğrudan geçiş kataloğu, bunları kullanabilen hesaplar için yalın
GPT-5.6 Sol/Terra/Luna slug'larını (`gpt-5.6-sol`, `gpt-5.6-terra`,
`gpt-5.6-luna`) da katmanlar.

## 2. Hesap girişi (OAuth)

Sekiz sağlayıcı önayarı OAuth girişini kullanır — artı deneysel resmi olmayan
bir cihaz akışı köprüsü aracılığıyla GitHub Copilot. opencodex bunların kimlik
bilgilerini `~/.opencodex/auth.json` içinde saklar ve otomatik olarak yeniler.
`chatgpt` ayrıca oturum açma CLI'sı tarafından kabul edilir; bir `forward` modu
sağlayıcı girdisi oluştururken bir ChatGPT kimlik bilgisi alır.

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx login nous         # Nous Portal (cihaz yetkisi; ücretsiz + ücretli modeller)
ocx login kiro         # kiro-cli kimlik bilgilerini içe aktarın (veya belirteç geri dönüşü)
ocx login google-antigravity
ocx login cursor       # bağımsız Cursor PKCE girişi
ocx login command-code # Command Code tarayıcı OAuth (veya ~/.commandcode/auth.json içe aktarma)
ocx login github-copilot  # GitHub cihaz akışı → Copilot belirteci (Copilot Pro/Business)
ocx login chatgpt      # bağımsız ChatGPT OAuth girişi
ocx logout <saglayici>
```

| Sağlayıcı | Adaptör | Temel URL | Notlar |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://cli-chat-proxy.grok.com/v1` | OAuth ayrı Grok CLI abonelik ağ geçidini kullanır. API anahtarı geçersiz kılması `https://api.x.ai/v1` kullanır ve Priority Processing ekleyebilir. Canlı öncelikli Grok kataloğu; `grok-4.5` geri dönüş varsayılanıdır. |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude modelleri; canlı model listesi `/v1/models` üzerinden getirilir. |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi K2.7/K2.6/K2.5 kodlama modelleri. |
| `nous` | `openai-chat` | `https://inference-api.nousresearch.com/v1` | Nous Research abonelik ağ geçidi (Hermes Agent'ın kullandığı aynı arka uç). `portal.nousresearch.com`'a karşı cihaz yetkilendirmesi girişi; erişim belirteci istek başına çıkarım JWT'sidir. Oturum açmış hesaptan canlı olarak keşfedilen karışık ücretli + `:free` model kataloğu (`tencent/hy3:free`, `stepfun/step-3.7-flash:free`, ...). Yenileme belirteçleri tek kullanımlıktır ve her yenilemede döndürülür. |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | İlk oturum açma, kurulu ve oturum açılmış `kiro-cli` oturumunu içe aktarır (Unix'te `curl -fsSL https://cli.kiro.dev/install` &#124; `bash` ile kurun; Windows PowerShell'de `irm 'https://cli.kiro.dev/install.ps1'` &#124; `iex` kullanın; ardından `kiro-cli login` çalıştırın). **Hesap ekle**, `kiro-cli` oturumunu kapatır, `kiro-cli` tarafından kullanılan hesabı değiştiren yeni bir tarayıcı girişi başlatır ve hesap kapsamlı profil meta verilerini saklar. Mevcut OpenCodex hesapları korunur ve iptal veya başarısızlık önceki `kiro-cli` oturumunu geri yükler. |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | Cloud Code Assist hattı üzerinden Google OAuth. Canlı keşif CCA'nın kimlik doğrulamalı `v1internal:fetchAvailableModels` uç noktasını kullanır ve oturum açmış hesap için kullanılabilir olan ajan modellerini yayınlar; sürdürülen katalog geri dönüş olarak kalır. |
| `cursor` | `cursor` | `https://api2.cursor.sh` | Deneysel PKCE girişi, canlı HTTP/2 aktarımı ve hesap filtreli model keşfi. |
| `github-copilot` | `openai-chat` | `https://api.githubcopilot.com` | Deneysel. GitHub cihaz akışı + `copilot_internal` değişimi (VS Code OAuth istemcisi). Aktif bir Copilot aboneliği gerektirir; resmi bir üçüncü taraf API değildir. |

Uç bir Nous yenileme hatasından sonra yeniden kimlik doğrulamak için `ocx login
nous` çalıştırın.

Kurallı Kimi Coding Plan önayarları için (`kimi` hesap girişi ve `kimi-code` API
anahtarı), opencodex Chat Completions isteğine yalnızca arayan tarafından
sağlanan kararlı bir `prompt_cache_key` iletir; asla bir tane oluşturmaz. Kimi,
Code Plan önbellek isabet oranlarını artırmak için gerekli olarak kararlı bir
oturum/görev anahtarı belgelerken, anahtarsız istekler anahtarsız kalır. Dahil
edilmiş bir yukarı akış alanı reddederse opencodex bunu kaldırmaz ve yeniden
denemez veya kayıtlı yapılandırmayı değiştirmez. Diğer sağlayıcılar varsayılan
olarak reddedilir kalır.

OAuth'u [web kontrol panelinden](/tr/guides/web-dashboard/) de
başlatabilirsiniz.

### Birden fazla OAuth hesabı

Kimlik bilgileri kararlı bir hesap kimliği veya e-posta içeren OAuth
sağlayıcıları birden fazla oturum tutabilir. Sağlayıcılar sayfası bu hesapları
bir açılır menüde gösterir, başka bir tane eklemenize izin verir ve diğerlerinin
oturumunu kapatmadan etkin hesabı değiştirir. Normal oturum açmada kimliği olmayan
Kimi kimlik bilgileri etkin yuvanın yerini alır; açık **Hesap ekle** akışı mevcut
yuvayı korur ve ayrı yeni yuvayı etkinleştirir. Kiro hesapları profil ARN'sine göre
anahtarlanır. `chatgpt` her zaman tek yuvalıdır çünkü Codex havuz hesaplarının
ayrı bir defteri vardır. Belirteçler `~/.opencodex/auth.json` içinde kalır;
`/api/oauth/accounts` yalnızca maskelenmiş meta verileri döndürür.

### Cockpit Tools Antigravity içe aktarma

v1 için OpenCodex, yalnızca `google-antigravity` sağlayıcısı için bir **Cockpit
Tools Antigravity** JSON dışa aktarımını içe aktarır. Sağlayıcılar kontrol
panelinde, bu sağlayıcının Hesaplar sekmesinden yerel JSON dosyasını seçin.
Kontrol paneli dosya içeriğini veya kimlik bilgisi değerlerini göstermez;
yalnızca içe aktarılan, güncellenen, başarısız olan ve desteklenmeyen sayıları
bildirir. Diğer Cockpit sağlayıcıları v1'de reddedilir.

CLI, dışa aktarmayı yalnızca bir dosyadan veya standart girdiden kabul eder —
asla bir komut argümanına yapıştırmayın:

```bash
ocx account import google-antigravity --format cockpit-tools --file <yol> [--json]
cat accounts.json | ocx account import google-antigravity --format cockpit-tools --stdin [--json]
```

Satır içi JSON ve fazladan konumsal argümanlar reddedilir. Dışa aktarılan
dosyaları gizli tutun ve içe aktardıktan sonra silin veya güvenli bir şekilde
saklayın.

### OAuth güvenilirliği

opencodex, eşzamanlı isteklerin kimlik bilgisi deposuyla yarışmaması için
belirteç yenilemeyi ve Codex havuz yönlendirmesini koordine eder. Bu
güvenilirlik ve tanılama çalışmasıdır — sağlayıcı yaptırımlarından, hız
sınırlarından veya hesap işlemlerinden korumayı **garanti etmez**.

**Yenileme koordinasyonu.** Yönlendirilen bir aramadan önce süresi dolmuş bir
erişim belirteci `(sağlayıcı, hesap)` başına bir kez yenilenir:

1. Süreç içi tek uçuş — eşzamanlı arayanlar bir yenileme vaadini paylaşır.
2. Hesap başına dosya kilidi — süreçler arası yazıcılar aynı hesap üzerinde
   serileşir.
3. Nesil CAS — yalnızca saklanan kimlik bilgisi nesli hala eşleştiğinde kalıcı
   hale getirin; daha yeni bir yazıcı kazanır ve daha eski bir yenileme sonucu
   onun üzerine yazamaz.

Uç yenileme hataları sonsuza kadar yeniden denemek yerine hesabı yeniden kimlik
doğrulama gerektiriyor olarak işaretler.

**Soğuma süreleri (Codex havuzu).** Yukarı akış `429` / kota yanıtları
`Retry-After`'dan, kota `reset` başlıklarından (sınırlı) veya kısa bir
varsayılan geri çekilmeden sabit bir soğuma süresi ayarlar. Açık bir
`Retry-After` soğuma süresindeki hesaplar erken araştırılmaz; sıfırlamadan
türetilen soğuma süreleri, sağlayıcıyı boğmadan kurtarmanın algılanabilmesi için
tempolu bir araştırma kiralama süresi alabilir. Sıfırlamadan türetilen yerel
model soğuma süreleri bilinen bağımsız kota gruplarını da korur:
`gpt-5.3-codex-spark`, aynı hesabın paylaşılan GPT-5.6 Terra/Luna kotasını
denemesini engellemezken, bu paylaşılan gruptaki modeller yine de birbirini
korur. Açık `Retry-After` ve varsayılan soğuma süreleri her zaman hesap
genelinde kalır.

**Oturum bağlılığı.** Codex iş parçacığı→hesap bağlılığı işleme özeldir
(yalnızca bellek içindedir; proxy yeniden başlatmalarında kalıcı değildir).
Kimlik bilgisi hatalarında (`401` / `403`) hesap yeniden kimlik doğrulama için
karantinaya alınır ve bu hesap için bağlılıklar temizlenir. `429`'da hesap
soğuma süresine girer, bağlılıklar temizlenir ve havuz seçimi dönebilir — iş
parçacıkları bir hız sınırı yanıtı boyunca sabitlenmez.

**Codex istemci meta verileri.** ChatGPT iletme yolu, özenle seçilmiş
`FORWARD_HEADERS` izin listesinden geçer (yetkilendirme, `chatgpt-account-id`,
originator, oturum/iş parçacığı kimlikleri ve ilgili Codex başlıkları — bkz.
[Adaptörler](/tr/reference/adapters/)). Havuz modu yalnızca seçilen kimlik
bilgisiyle eşleşecek şekilde yetkilendirmeyi ve `chatgpt-account-id`'yi yeniden
yazar. opencodex, arayan kişi bunları göndermediğinde resmi istemci kimliği
(örneğin `originator`, oturum veya iş parçacığı başlıkları) **uydurmaz**.

**Tanılama ve yeniden kimlik doğrulama.** İnsan tarafından okunabilir `ocx
status`, bir OAuth sağlık bloğu yazdırır (maskelenmiş hesap kimlikleri, belirteç
yok). `ocx doctor`, yazılabilir depo / tek uçuş denetimleri ve bir kurtarma
Eylemi içeren UYARI satırlarıyla bir OAuth güvenilirlik bölümü ekler. Bir OAuth
sağlayıcı hesabının yeniden kimlik doğrulaması gerektiğinde `ocx login
<saglayici>` çalıştırın (veya kontrol panelinde Yeniden Kimlik Doğrula'yı
kullanın). Codex havuz hesapları bir `ocx login` sağlayıcısı değildir — kontrol
paneli Codex hesap havuzu aracılığıyla yeniden kimlik doğrulaması yapın. CLI
referansında [`ocx status` / `ocx doctor`](/tr/reference/cli/) bölümüne bakın.

### Kiro kimlik bilgisi içe aktarma

Kiro oturum açma Kiro CLI'yı bekler: Unix'te `curl -fsSL
https://cli.kiro.dev/install | bash` ile kurun; Windows PowerShell'de `irm
'https://cli.kiro.dev/install.ps1' | iex` kullanın; ardından `kiro-cli login`
ile oturum açın. Bir `kiro-cli` oturumu olmadan `ocx login kiro`, yapıştırılmış
bir erişim belirtecine veya `KIRO_ACCESS_TOKEN` ortam değişkenine geri döner.

`ocx login kiro` içe aktarma yolu platform Kiro CLI depolarını arar ve SQLite
veritabanlarını salt okunur olarak açar. İki ortam değişkeni kaynak ve belirteç
satırı seçimini açık hale getirir:

- `KIROCLI_DB_PATH` standart olmayan bir Kiro CLI SQLite veritabanını seçer. Yol
  zaten mevcut olmalıdır; bu içe aktarma yolu sırasında opencodex veritabanı,
  WAL veya SHM dosyalarını oluşturmaz veya değiştirmez.
- `KIROCLI_TOKEN_KEY`, bir veritabanı birden fazla belirsiz belirteç satırı
  içerdiğinde tam `auth_kv` belirteç anahtarını seçer. Eksik bir seçim tahmin
  etmek yerine girişi başarısız kılar.

Windows'ta içe aktarma `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3` dosyasını arar.
Zorunlu/hesap ekleme girişi yerel CLI ikili dosyasına da ihtiyaç duyar:
opencodex önce `PATH`'i kullanır, ardından
`%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe` ve `C:\Program
Files\Kiro-Cli\kiro-cli.exe`'ye geri döner.

Başarılı bir içe aktarmadan sonra opencodex içe aktarılan kimlik bilgisini
`~/.opencodex/auth.json` dosyasına kalıcı hale getirir. Bu değişkenleri ve
seçilen veritabanını gizli tutun. Hata raporlarına veritabanı dosyalarını veya
ham oturum açma tanılamalarını eklemeyin.

**Hesap ekle** ayrı bir yazma iş akışıdır: geçerli oturumun anlık görüntüsünü
alır, `kiro-cli` oturumunu kapatır ve yeni tarayıcı girişini içe aktarır. Oturum
açma iptal edilirse veya başarısız olursa (OpenCodex kimlik bilgisini kalıcı
hale getirirken dahil), geri alma işlemi önceki oturum anlık görüntüsünü
yayınlamadan önce Kiro CLI veritabanını değiştirir ve geçerli WAL, SHM ve günlük
sidecar'larını kaldırır.

Bu geri alma yalnızca bir anlık görüntüden mümkün olduğundan, bir oturum deposu
mevcut olduğunda ancak yakalanamadığında (okunamayan dosya, uyumsuz şema veya
belirsiz bir belirteç seçimi), `KIROCLI_DB_PATH` / `KIRO_CLI_DB_FILE` içe
aktarma okumalarını canlı CLI deposundan uzaklaştırdığında veya mevcut bir
birincil CLI veritabanında tanınan bir belirteç satırı olmadığında **Hesap
ekle** `kiro-cli` oturumunu kapatmayı reddeder. Normal `kiro-cli` veri yolu
altındaki okunamayan veritabanını onarın veya kaldırın, bu içe aktarma
seçicilerini kaldırın ve ardından yeniden deneyin. Mevcut bir `kiro-cli` oturumu
olmayan bir makineden oturum açmak bundan etkilenmez.

## 3. API anahtarı kataloğu

opencodex 79 yerleşik önayar ile birlikte gelir: 67 anahtar tabanlı, sekiz
OAuth, üç yerel ve bir varsayılan ChatGPT iletme önayarı. Kontrol panelinin
**Sağlayıcı ekle** seçicisi bir anahtar sağlayıcısının kontrol panelini açar,
anahtarı doğrular ve saklar; doğrulama sağlayıcıya özgüdür. Dikkate değer
girdiler:

**ClinePass**, [Cline'ın şartları](https://cline.bot/tos) altında Cline Bot Inc.
tarafından işletilen [resmi abonelik
kataloğu](https://docs.cline.bot/getting-started/clinepass) ve [Chat Completions
uç noktası](https://docs.cline.bot/api/chat-completions) ile bir Cline API
anahtarı kullanır. `cline-pass/cline-pass/kimi-k3` gibi yönlendirilen bir kimlik
kasıtlıdır: ilk segment opencodex sağlayıcısını seçerken, `cline-pass/kimi-k3`
yukarı akışa gönderilen tam model slug'ıdır. ClinePass kotası, dönen 5 saatlik,
haftalık ve aylık limitler genelinde hesap tarafından paylaşılır. 2026-08-13
tarihli canlı bir araştırma, her statik ClinePass modelinin ağ geçidi girdi
sınırında `low`, `medium`, `high`, `xhigh` ve `max` değerlerini kabul ettiğini
doğrulamıştır. opencodex bu talep edilen katmanları korur; arka uca özgü
normalleştirme ClinePass'ın sorumluluğunda kalır.

**Cline**, 100'den fazla modelde (OpenRouter tarzı `anthropic/claude-sonnet-4-6`
gibi kimlikler) kullandıkça öde faturalandırmasında aynı API anahtarı ve uç
noktasıdır. Cline'ın promosyonel ücretsiz modelleri API üzerinden değil,
yalnızca Cline IDE/CLI içinde mevcuttur; `minimax/minimax-m2.5` belgelenmiş API
ücretsiz deneme modelidir.

| Sağlayıcı | Temel URL |
| --- | --- |
| **OpenAI (API anahtarı)** | `https://api.openai.com/v1` |
| **Anthropic (API anahtarı)** | `https://api.anthropic.com` |
| **OpenRouter** | `https://openrouter.ai/api/v1` |
| **Cline** | `https://api.cline.bot/api/v1` |
| **ClinePass** | `https://api.cline.bot/api/v1` |
| **Ollama Cloud** | `https://ollama.com/v1` |
| Google Gemini · Google Vertex AI | `https://generativelanguage.googleapis.com` · `https://aiplatform.googleapis.com` |
| Azure OpenAI | `https://{resource}.openai.azure.com/openai` |
| Umans AI · Neuralwatt | `https://api.code.umans.ai` · `https://api.neuralwatt.com/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| MiniMax · MiniMax (CN) | `https://api.minimax.io/v1` · `https://api.minimaxi.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| Cerebras | `https://api.cerebras.ai/v1` |
| Chutes | `https://llm.chutes.ai/v1` |
| DeepInfra | `https://api.deepinfra.com/v1/openai` |
| Hyperbolic | `https://api.hyperbolic.xyz/v1` |
| Nscale Serverless Inference | `https://inference.api.nscale.com/v1` |
| Vultr Serverless Inference | `https://api.vultrinference.com/v1` |
| Baseten Model APIs | `https://inference.baseten.co/v1` |
| Command Code | `https://api.commandcode.ai/provider/v1` |
| SambaNova Cloud | `https://api.sambanova.ai/v1` |
| Nebius Token Factory | `https://api.tokenfactory.nebius.com/v1` |
| DigitalOcean Serverless Inference | `https://inference.do-ai.run/v1` |
| Scaleway Generative APIs | `https://api.scaleway.ai/v1` |
| Featherless AI | `https://api.featherless.ai/v1` |
| Novita AI | `https://api.novita.ai/openai/v1` |
| Together | `https://api.together.xyz/v1` |
| Fireworks | `https://api.fireworks.ai/inference/v1` |
| Moonshot (Kimi API) · Kimi (kodlama) | `https://api.moonshot.ai/v1` · `https://api.kimi.com/coding/v1` |
| Hugging Face | `https://router.huggingface.co/v1` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` |
| Z.AI (GLM Kodlama) | `https://api.z.ai/api/coding/paas/v4` |
| Zhipu AI (BigModel) | `https://open.bigmodel.cn/api/paas/v4` |
| Qwen Cloud | Token planı (varsayılan): `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` · Kullandıkça öde: `https://dashscope.aliyuncs.com/compatible-mode/v1` · veya Özel |
| Tencent Cloud Coding Plan | `https://api.lkeap.cloud.tencent.com/coding/v3` |
| SiliconFlow | `https://api.siliconflow.cn/v1` |
| Volcengine Ark · Coding Plan · Agent Plan | `https://ark.cn-beijing.volces.com/api/v3` · `https://ark.cn-beijing.volces.com/api/coding/v3` · `https://ark.cn-beijing.volces.com/api/plan/v3` |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Xiaomi MiMo (OpenAI Chat) | `https://api.xiaomimimo.com/v1` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| GitLab Duo | `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic` |
| …ve daha fazlası | opencode zen, Vercel AI Gateway, Venice, NanoGPT, Synthetic, Qianfan, Alibaba, Parallel, ZenMux, LiteLLM |

**OpenCode Zen** (`opencode-zen`) ve anahtarsız **OpenCode Free** önayarı
`https://opencode.ai/zen/v1` adresini paylaşır. Bu ağ geçidindeki ücretsiz
modeller genellikle yaklaşık 15–20 istek/dakika civarında kısa pencereli bir
patlama sınırına ulaşır (topluluk tarafından ölçülmüştür; OpenCode RPM
yayınlamaz). Zen, `Retry-After` / `X-RateLimit-*` başlıkları olmadan genel hız
sınırı 429 yanıtları döndürebilir. Bu, OpenCode'un tanıttığı anahtarsız masaüstü
kotasından ayrıdır (`opencode-free` üzerinde 5 saatte yaklaşık 200 Big
Pickle/ücretsiz model isteği). Zen böyle bir 429'da `Retry-After`'ı atladığında
opencodex istemci hatasına sağlayıcı rehberliği ve sentetik bir `Retry-After`
ekler; bir yukarı akış `Retry-After`'ı yine de önceliklidir. Aynı anahtarla
bekle ve yeniden dene özelliği [`retryOn429`](/tr/reference/configuration/)
aracılığıyla isteğe bağlı kalır.

Çoğu bir taşıyıcı anahtarla `openai-chat` adaptörünü kullanır; yalnızca
Anthropic uyumlu bir uç nokta sunan birkaç tanesi (örneğin **Xiaomi MiMo**)
`anthropic` adaptörünü (`x-api-key`) kullanır. Volcengine Agent Plan,
`openai-responses` aracılığıyla yerel Responses uç noktasını kullanır. Yerleşik
DeepSeek önayarı da `deepseek-v4-flash`'ı yerel Responses uç noktası üzerinden
yönlendirir ve yukarı akış SSE akışını etkin tutar. Bu model tüm çıktı öğelerini
bitirir ancak son Responses olayını atlarsa opencodex beş saniyelik model
kapsamlı bir yetkisiz kullanım onarımı uygular; hatalı biçimlendirilmiş veya
kısmi akışlar başarılı olarak bildirilmek yerine tamamlanmamış olarak kapanır.

> **Üç Volcengine faturalandırma rotası:** `volcengine` kullandıkça öde Ark API'sidir, `volcengine-coding-plan` Coding Plan kotasını tüketir ve `volcengine-agent-plan` Agent Plan kotasını tüketir. Aynı ürün için verilen anahtarı ve uç noktayı kullanın; sıradan `/api/v3` uç noktası bir Plan aboneliği mevcut olduğunda bile kullandıkça öde ücretlerine neden olabilir. Önayarlar özenle seçilmiş statik model katalogları kullanır çünkü Ark'ın `/models` yanıtı yerleştirme, görsel, video ve 3D kaynaklarını da içerir, Coding ağ geçidi aynı geniş kataloğu döndürür ve Agent Plan ağ geçidinin `/models` kaynağı yoktur. Kullandıkça öde varsayılan olarak `doubao-seed-2-1-pro-260628`'dir; seçilmiş kataloğu güncel DeepSeek ve GLM metin modellerini de içerir. Coding Plan varsayılan olarak `ark-code-latest`, Agent Plan ise varsayılan olarak `deepseek-v4-pro`'dur.

> **Volcengine Plan kullanım kısıtlaması:** Volcengine, Coding Plan ve Agent Plan kotasını yalnızca desteklenen yapay zeka kodlama araçları içinde geçerli olarak belgeler ve genel API çağrıları için bir plan anahtarı kullanmanın aboneliği askıya alabileceği veya hesabı yasaklayabileceği konusunda uyarır. Codex veya Claude Code'u opencodex üzerinden yönlendirmek belgelenmiş kullanımdır; diğer otomasyonları bir plan anahtarına yönlendirmek değildir. Kullandıkça öde `volcengine` rotası böyle bir kısıtlama taşımaz.

**Chutes keşfi.** `chutes` önayarı Chutes'un sabit paylaşılan OpenAI uyumlu LLM
ağ geçidini kullanır. Genel `/v1/models` kataloğunu okur, yalnızca
`supported_features` alanı `tools` bildiren satırları tutar, eğik çizgi içeren
model kimliklerini ve güvenli canlı meta verileri korur ve keşfi 256 KiB ve 128
ham satırla sınırlar. Bu katalog genel olduğundan sağlanan bir anahtarın geçerli
olduğunu kanıtlayamaz; sohbet istekleri yine de yapılandırılmış Bearer
anahtarını kullanır. Kullanıcı tarafından dağıtılan özel Chute ana
bilgisayarları ve Chutes'un LLM dışı API'leri özel sağlayıcı alanı olarak kalır.
[Chutes kontrol panelinden](https://chutes.ai/auth/start) bir anahtar oluşturun.

**DeepInfra keşfi.** Anahtar tabanlı `deepinfra` OpenAI Chat Completions
sağlayıcısı, bir Bearer API anahtarıyla `openai-chat` adaptörünü kullanır. Kayıt
defterine ait model listesi URL'si yalnızca `chat` olarak etiketlenen satırları
tutar, eğik çizgi içeren yerel model kimliklerini korur ve canlı keşfi 512 KiB
ve 512 ham satırla sınırlar. [DeepInfra kontrol
panelinde](https://deepinfra.com/dash/api_keys) anahtarlar oluşturun.

**Hyperbolic keşfi.** Önayar `/v1/models`'ı yapılandırılmış taşıyıcı anahtarla
okur, eğik çizgi içeren yerel model kimliklerini korur ve canlı keşfi 256 KiB ve
256 ham satırla sınırlar. Yalnızca sunucusuz metin ve vizyon-dil sohbetini
kapsar; Hyperbolic'in ayrı görsel, ses ve GPU uç noktaları kapsam dışıdır.
[Hyperbolic](https://app.hyperbolic.ai) üzerinden anahtarlar oluşturun.

**Nscale ve Vultr keşfi.** Her iki önayar da sağlayıcının kimlik doğrulamalı
`/v1/models` kataloğundan okur, yerel kimlikleri korur ve keşfi 256 KiB ve 256
ham satırla sınırlar. Nscale'in kataloğu sohbet, görsel ve yerleştirme
modellerini bir modalite alanı olmadan karıştırır, bu nedenle önayar yalnızca
Nscale'in resmi araç çağırma API örneği tarafından kullanılan model olan
`meta-llama/Llama-3.1-8B-Instruct` modelini kabul eder. Vultr şu anda araç
çağırmayı yalnızca `kimi-k2-instruct` için belgeler, bu nedenle önayarı yalnızca
bu modeli sunar. Diğer satırlar sağlayıcı eşdeğer ajan-araç kanıtı yayınlayana
kadar gizli kalır. [Nscale Console](https://console.nscale.com) içinde bir
Nscale servis belirteci oluşturun; [Vultr Console](https://my.vultr.com)
içindeki abonelik genel bakışından Vultr'un çıkarım anahtarını kopyalayın.

**Command Code keşfi.** Önayar, sabit Sağlayıcı API ana bilgisayarından Command
Code'un `/provider/v1/models` listesini okur, sağlayıcı yerel kimliklerini korur
ve keşfi 256 KiB ve 256 ham satırla sınırlar. `ocx login command-code`, tarayıcı
oturum açma yoluyla OAuth'u destekler (mevcut Command Code CLI kullanıcıları
için `~/.commandcode/auth.json`'dan isteğe bağlı yerel CLI kimlik bilgisi içe
aktarma ile); model kataloğu hesap kapsamlıdır ve oturum açtıktan sonra kimlik
doğrulamalı keşif uç noktasından gelir. Sohbet istekleri yapılandırılmış Bearer
anahtarını kullanır. [Command Code Studio](https://commandcode.ai/studio/)
üzerinden anahtarlar oluşturun.

**Command Code kotası.** Pano ve `ocx account refresh`, kanonik `https://api.commandcode.ai` ana bilgisayarında `/alpha/billing/credits` pencerelerini (5 saat ve haftalık) sorgular. OAuth önayarı (`command-code`) kayıtlı hesap bearer'ını kullanır; Provider-API anahtar önayarı (`commandcode`) etkin yapılandırılmış anahtarı kullanır. Kullanıcının değiştirdiği benzer bir temel URL asla sorgulanmaz. Command Code dönem harcamasını da bildirirse kalan monthly / purchased / free credits USD penceresi olarak gösterilir.

**SambaNova Cloud keşfi.** Önayar, sabit API ana bilgisayarından SambaNova
Cloud'un genel `/v1/models` listesini okur, sağlayıcı yerel kimliklerini korur
ve keşfi 128 KiB ve 128 ham satırla sınırlar. Katalog kimlik doğrulamasız
olduğundan, CLI giriş akışı genel yanıtı kanıt olarak kabul etmek yerine
anahtarı doğrulanamaz olarak bildirir. Sohbet istekleri yine de yapılandırılmış
Bearer anahtarını kullanır ve SambaNova'nın henüz desteklemediği paralel
fonksiyon çağrılarını devre dışı bırakır. Özel SambaStudio dağıtım uç noktaları
kapsam dışıdır. [SambaNova Cloud](https://cloud.sambanova.ai/apis) içinde
anahtarlar oluşturun.

**Nebius Token Factory keşfi.** Önayar, kimlik doğrulamalı ayrıntılı model
kataloğunu ister ve yerleştirme ile görsel oluşturma modellerini hariç tutarak
yalnızca mimarisi metin üreten satırları tutar. Eğik çizgi içeren yerel
kimlikleri artı bildirilen bağlam ve girdi modalitesi meta verilerini korur ve
keşfi 512 KiB ve 512 ham satırla sınırlar. Özel dağıtım ana bilgisayarları
kapsam dışıdır. [Nebius Token Factory](https://tokenfactory.nebius.com) içinde
anahtarlar oluşturun.

**DigitalOcean keşfi.** Önayar, sabit paylaşılan Sunucusuz Çıkarım ana
bilgisayarına karşı bir model erişim anahtarı kullanır ve kimlik doğrulamalı
`/v1/models` yanıtını DigitalOcean'ın belgelere dayalı Chat Completions izin
listesiyle kesiştirir. Bilinmeyen, yalnızca Responses olan, yerleştirme ve medya
oluşturma kimlikleri kapalı olarak başarısız olur. Keşif 256 KiB ve 256 ham
satırla sınırlandırılmıştır; ajana özgü ve özel ana bilgisayarlar kapsam
dışıdır. [DigitalOcean Kontrol
Paneli](https://cloud.digitalocean.com/model-studio/manage-keys) içinde bir
anahtar oluşturun.

**Scaleway keşfi.** Önayar, kimlik doğrulamalı model listesini Scaleway'in
belgelenmiş Sunucusuz Chat Completions izin listesiyle kesiştirir. Bilinmeyen,
yalnızca Responses olan, yerleştirme, transkripsiyon ve diğer medya modeli
kimlikleri kapalı olarak başarısız olur; keşif 128 KiB ve 128 ham satırla
sınırlandırılmıştır. Varsayılan Projenin paylaşılan uç noktasını kullanır; proje
nitelikli URL'ler ve özel dağıtımlar özel bir sağlayıcı gerektirir. [Scaleway
konsolunda](https://console.scaleway.com/generative-api) bir API anahtarı
oluşturun.

**Featherless keşfi.** Önayar, sabit OpenAI uyumlu ana bilgisayara karşı kimlik
doğrulaması yapar ve yalnızca yukarı akışta sohbete ve geçerli plana göre
filtrelenen ilk 100 popüler modeli ister. Kayıt defteri kuralları daha sonra her
satır bağımsız olarak plan kullanılabilirliği, Hugging Face kapısı olmadığını ve
`features.tool_use: true` olduğunu bildirmedikçe kapalı olarak başarısız olur.
Keşif 128 KiB ve 100 ham satırla sınırlandırılmıştır, bu nedenle hizmetin on
binlerce modelli kataloğu hiçbir zaman tam olarak indirilmez veya önbelleğe
alınmaz. `/v1/models` kimlik doğrulamalı veya kimlik doğrulamasız çağrılabilir
olarak belgelendiğinden, sağlanan bir anahtarın geçerli olduğunu kanıtlayamaz;
sohbet istekleri yine de yapılandırılmış Bearer anahtarını kullanır. Featherless
şartları bireysel planları etkileşimli/prototip kullanımı için ayırır; rastgele
uygulamalar bir Scale planı gerektirir. [Featherless kontrol
panelinde](https://featherless.ai/account/api-keys) bir anahtar oluşturun.

**Novita keşfi.** Anahtar tabanlı önayar `openai-chat` adaptörünü kullanır ve
Bearer anahtarını yalnızca Novita'nın sabit OpenAI uyumlu ana bilgisayarına
gönderir. Genel model listesi, hem `model_type: chat` hem de `chat/completions`
uç noktasını bildiren satırlara filtrelenir ve keşif 512 KiB ve 256 ham satırla
sınırlandırılır. Model kimlikleri, eğik çizgiyle ayrılmış kimlikler de dahil
olmak üzere tam olarak Novita'nın döndürdüğü gibi korunmalı ve yönlendirmeden
önce normalleştirilmemeli veya yeniden yazılmamalıdır. Katalog genel olduğundan,
oturum açma başarılı bir liste yanıtını kanıt olarak kabul etmek yerine anahtarı
doğrulanamaz olarak bildirir. Model yetenekleri farklılık gösterir, bu nedenle
önayar sağlayıcı genelinde paralel araç çağrılarını veya OpenAI
`reasoning_effort`'ı tanıtmaz. [Novita'nın anahtar
yöneticisinde](https://novita.ai/settings/key-management) bir anahtar oluşturun.

> **Baseten kapsamı:** Önayar yalnızca Baseten'in paylaşılan [Model API'lerini](https://docs.baseten.co/inference/model-apis/overview) kapsar. Yerel kullanım için kişisel bir [API anahtarı](https://docs.baseten.co/organization/api-keys) veya paylaşılan/üretim kullanımı için **Call Model APIs** erişimine sahip bir takım anahtarı kullanın. Özel Truss `predict` uç noktaları farklı ana bilgisayarlar ve şemalar kullanır ve bu önayar tarafından yönlendirilmez. Bu önayar için canlı keşif 1 MiB yanıt ve 256 ham model satırıyla sınırlandırılmıştır.

### A6API kredi kotası

`authMode: "key"` ve kurallı `https://api.a6api.com` veya
`https://api.a6api.com/v1` temel URL'sini kullanan özel bir `openai-chat`
sağlayıcısı, kontrol panelinde ve `ocx account refresh <saglayici>` komutundan
bir A6API kredi sayacı alır. Sağlayıcı adı rastgeledir; algılama kurallı HTTPS
uç noktasını kullanır. Sayaç, hesabın kesin kredi sınırını kullanarak A6API
belirteç birimlerini USD'ye dönüştürür ve tüketilen yüzdeyi artı kalan krediyi
görüntüler. Belirteç sona ermesi bir kota sıfırlaması olarak gösterilmez çünkü
sona erme kredinin yenilendiği anlamına gelmez.

```json
{
  "providers": {
    "my-a6": {
      "adapter": "openai-chat",
      "authMode": "key",
      "baseUrl": "https://api.a6api.com/v1",
      "apiKey": "${A6API_API_KEY}"
    }
  }
}
```

Kota probları kurallı A6API ana bilgisayarına yalnızca etkin anahtarı gönderir
ve yönlendirmeleri reddeder. Hatalı biçimlendirilmiş, negatif veya dahili olarak
tutarsız faturalandırma toplamları yanıltıcı bir çubuk yerine hiçbir rapor
üretmez.

> **Tencent Cloud Coding Plan kullanım kısıtlaması:** Tencent bu aboneliği yalnızca etkileşimli kodlama araçları için belgeler. Genel API otomasyonu, özel uygulama arka uçları ve etkileşimsiz toplu kullanım yasaktır ve plan anahtarının askıya alınmasına neden olabilir.

> **İki GLM rotası:** `zai`, Z.AI uluslararası kodlama planı aboneliğidir; `zhipu-bigmodel`, Zhipu'nun yerel BigModel kullandıkça öde uç noktasıdır. Farklı ana bilgisayarlar, farklı anahtarlar, farklı faturalandırma — biri için verilen bir anahtar diğerine karşı kimlik doğrulaması yapmaz.

### Birden fazla API anahtarı

Anahtar tabanlı sağlayıcılar birden fazla anahtar da tutabilir. Sağlayıcılar
sayfası aracılığıyla bir anahtar eklemek onu `provider.apiKeyPool` altında
saklar, aktif hale getirir ve `provider.apiKey`'e yansıtır; böylece yönlendirme
ve adaptörler daha önceki gibi aynı alanı okumaya devam eder. Aynı açılır menü
anahtarları değiştirebilir veya kaldırabilir; yönetim API'si
`/api/providers/keys`'dir ve yalnızca maskelenmiş anahtarları döndürür.

### Terminalden hesap değiştirme

Kontrol panelini açmadan aynı Codex, OAuth ve API anahtarı havuzlarını incelemek
veya değiştirmek için `ocx account list`, `ocx account current` ve `ocx account
use` komutlarını kullanın. Komutlar, JSON çıktısı ve yeni oturum davranışı için
[CLI referansına](/tr/reference/cli/#ocx-account-subcommand) bakın.

### GPT-5.6 önizleme yolları

GPT-5.6 Sol/Terra/Luna, canlı kataloglar geride kalsa bile `ocx sync`'in
modelleri görünür tutabilmesi için sağlayıcı geri dönüş listelerine
tohumlanmıştır:

| Codex rotası | Tohumlanan model kimlikleri | Codex tarafından görülebilen bağlam |
| --- | --- | --- |
| Codex girişi (Pool veya Direct) | `gpt-5.6-*` | 922.000 |
| OpenAI (API anahtarı) | `openai-apikey/gpt-5.6-*` artı `*-pro` | 922.000 (922.000 maksimum girdi) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`, `openrouter/openai/gpt-5.6-terra`, `openrouter/openai/gpt-5.6-luna` | 922.000 |
| Cursor | `cursor/gpt-5.6-sol`, `cursor/gpt-5.6-terra`, `cursor/gpt-5.6-luna` | 1.000.000 |

Yerel GPT-5.6 girdileri sabitlenmiş yukarı akış akıl yürütme merdivenlerini
korur (örneğin Luna `max`'a sahiptir ancak `ultra`'ya sahip değildir).
Yönlendirilen girdiler sağlayıcı meta verilerini ve akıl yürütme eşlemelerini
kullanır. Dört yolun tümü yukarı akış geçişli kalır; Cursor'ın canlı keşfi
ayrıca statik tohumunu oturum açmış hesabın kullanabileceği modellere göre
filtreler.

:::note[Ağ geçitleri ve abonelik proxy'leri]
Bir sağlayıcı, bir "ajan" ürünü olup olmadığına göre **değil**, opencodex'in
eşleşen bir hat adaptörüne sahip olmasına göre dahil edilir. Geçerli adaptör
kimlikleri `openai-chat`, `openai-responses`, `anthropic`, `google` (AI Studio,
Vertex ve Antigravity/Cloud Code Assist modları), `azure` / `azure-openai`,
`kiro` ve `cursor`'dır. Yerel Amazon Bedrock gibi bu uygulamalardan birine sahip
olmayan tescilli bir API doğrudan desteklenmez. **GitHub Copilot**,
yapıştırılmış bir API anahtarı değil, bir GitHub cihaz akışı girişini kısa
ömürlü bir Copilot API belirteci ile değiştiren bir OAuth sağlayıcısıdır (`ocx
login github-copilot`). **GitLab Duo**, OpenAI uyumlu uç noktasında bir
anahtar/abonelik belirteci ağ geçidi olarak kalır. **Cloudflare AI Gateway**,
URL'ye doldurulan hesap + ağ geçidi kimliklerinize ihtiyaç duyar.

Copilot karma hatlı bir katalog sunar: GPT-5 ailesi (`gpt-5.3-codex`, `gpt-5.4`,
`gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`) ajan
trafiği için `/chat/completions`'ı reddeder, bu nedenle opencodex yerleşik
varsayılan olarak bu modelleri Responses API üzerinden yönlendirirken diğer tüm
Copilot modelleri sohbet tamamlamalarında kalır. Öncelik sırası: sabit hat
sabitlemesi → açık [`modelAdapters`](/tr/reference/configuration/providers/)
girdiniz → kayıt defteri varsayılanı → sağlayıcı genelinde adaptör. Yerleşik
varsayılanı olmayan bir modeli (örneğin `gpt-5.4-nano`) Responses'a dahil etmek
için `"modelAdapters": { "gpt-5.4-nano": "openai-responses" }` ayarlayın.

Cursor deneysel bir adaptör olarak ayrı izlenir. `adapter: "cursor"`, `ocx
init`'te ve kontrol paneli Sağlayıcı Ekle seçicisinde Cursor'ın statik geri
dönüş model kataloğu meta verileriyle deneysel bir yerel yapılandırma girdisi
olarak görünür. Bir Cursor erişim belirteci yapılandırıldığında opencodex
Cursor'ın canlı HTTP/2 aktarımını kullanır. Paketlenmiş geri dönüş tohumu
`gpt-5.6-sol` / `terra` / `luna` (1M bağlam), `grok-4.5` / `grok-4.5-fast`
(500K) ve `kimi-k3` (262K) içerir; canlı keşif hesap için hangilerinin görünür
kalacağına karar verir. Cursor, Kimi K3'ü yalnızca çaba sonekli hat kimlikleri
olarak sunar, bu nedenle `cursor/kimi-k3` bir `low` / `high` / `max` merdiveni
gösterir ve modelin belgelenmiş API varsayılanıyla eşleşecek şekilde varsayılan
olarak `max` olur. Cursor sunucu güdümlü yerel
okuma/yazma/silme/ls/grep/shell/fetch yürütmesi varsayılan olarak devre dışıdır
çünkü Codex'in onay ve sanal alan yolunu atlar; yalnızca güvenilen yerel
denemeler için (veya kontrol panelinde **Sağlayıcılar → Cursor → JSON Düzenle**
aracılığıyla) `~/.opencodex/config.json` içindeki `providers.cursor` nesnesinde
`unsafeAllowNativeLocalExec: true` ayarlayın. Tam bir örnek için [Yapılandırma
referansı](/tr/reference/configuration/#cursor-saglayicisi-adapter-cursor)
bölümüne bakın. MCP, ekran kaydı ve bilgisayar kullanımı yürütücü kancaları
olarak mevcuttur; yapılandırılmış bir yerel yürütücü olmadan opencodex isteği
politika engellemek yerine tipli yürütücü yok sonuçları döndürür. Cursor OAuth
ve canlı model keşfi bu deneysel adaptör için etkinleştirilmiştir; Cursor
anahtar girişi listelerinde hala gösterilmez.
:::

### Ollama Cloud

Ollama Cloud, [ollama.com/settings/keys](https://ollama.com/settings/keys)
adresinden alınan bir anahtarla `https://ollama.com/v1` adresinde yapılandırılan,
barındırılan (yerel olmayan) bir Ollama'dır. opencodex ona OpenAI uyumlu yüzey
yerine Ollama'nın kendi REST API'si (`POST /api/chat`) üzerinden erişir ve model
listesini sağlayıcıdan keşfeder; böylece yeni Ollama Cloud modelleri yapılandırma
değişikliği olmadan görünür. opencodex, bulut serisini vizyon
yeteneğine göre sınıflandırır, böylece [vizyon sidecar'ı](/tr/guides/sidecars/)
yalnızca salt metin modeller için devreye girer. Salt metin modeller (örneğin
`glm-5.2`, `deepseek-v4-pro`, `gpt-oss`, `qwen3-coder`, `minimax-m2.x`,
`nemotron-3-*`) `noVisionModels` içinde listelenir; vizyon yerel modeller
(örneğin `kimi-k2.6`, `minimax-m3`, `gemma4`, `qwen3.5`,
`gemini-3-flash-preview`) listelenmez. Eşleştirme Ollama'nın `:size`
etiketlerine toleranslıdır, bu nedenle `gpt-oss`, `gpt-oss:120b` ve
`gpt-oss:20b`'yi kapsar.

Ollama şu anda yapılandırılmış çıktıyı Ollama Cloud'da desteklemediğini belgeliyor. Kanonik
`ollama-cloud` için opencodex, yapılandırılmış çıktı isteklerini (`text.format`) serbest metni
sessizce döndürmek yerine net bir hatayla reddeder; yerel ve özel `ollama-native` uç noktaları
Ollama'nın yerel `format` davranışını korur.

## 4. Yerel sağlayıcılar

opencodex'i yerel bir OpenAI uyumlu sunucuya yönlendirin — genellikle boş bir
anahtarla:

| Sağlayıcı | Temel URL |
| --- | --- |
| Ollama (yerel) | `http://localhost:11434/v1` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |

## Herhangi bir OpenAI uyumlu uç nokta

Bir sağlayıcı Chat Completions konuşuyorsa `openai-chat` adaptörü bunu işler —
kontrol panelinde **Özel (Custom)**'ı veya `ocx init`'te `custom`'ı seçin ve
temel URL'yi girin. Her sağlayıcı alanı için (`headers`, `noReasoningModels`,
`noVisionModels`, `models`, …) [Yapılandırma
referansı](/tr/reference/configuration/) bölümüne bakın.

## Sağlayıcılar genel bakışında hız sınırları

Sağlayıcılar genel bakışının **Hız sınırları (Rate limits)** bölümü, mevcut
olduğunda her sağlayıcının kendi kullanım/faturalandırma uç noktasından
yenilenen canlı kullanım çubuklarını gösterir. Çubuklar bir pencerenin (5
saatlik, haftalık, aylık veya sağlayıcıya özgü) ne kadarının tüketildiğini
gösterir.

Canlı araştırmaya sahip sağlayıcılar: OpenAI/Codex, Anthropic, xAI, Cursor,
Kimi, Google Antigravity, OpenRouter, DeepSeek, ClinePass, Z.AI, MiniMax,
Moonshot, Venice, Synthetic, DeepInfra, Neuralwatt ve a6api destekli herhangi
bir özel sağlayıcı.
