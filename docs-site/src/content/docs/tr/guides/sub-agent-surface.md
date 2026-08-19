---
title: Alt Ajan Arayüzü (v1 / base / v2)
description: Codex'in tüm modeller genelinde alt ajanları nasıl oluşturup yöneteceğini kontrol edin.
---

## Alt ajanlar nedir?

Bir alt ajan, ana ajanın odaklanmış bir görev için oluşturabileceği ayrı bir
Codex çalışanıdır. Kendi bağlamına ve araçlarına sahiptir, bu sayede birkaç
bağımsız görev paralel olarak çalışabilir. opencodex bu çalışanları hangi Codex
işbirliği yüzeyinin açığa çıkaracağını, Codex'in onlar için hangi modelleri
sunacağını ve başarısız bir modelin nasıl geri dönebileceğini denetler. Ana
ajanınızın ne zaman devretmesi gerektiğine karar vermez.

## Modlar

**Yeni oturumlar** için modu seçin. Mevcut oturumlar başladıkları arayüzü korur.

| Mod | Codex ne alır? | Kim seçmelidir? |
| --- | --- | --- |
| **v1** | Klasik ad alanlı `spawn_agent`, `send_input`, `resume_agent` ve `close_agent` araçları. Bir spawn doğrudan başka bir modeli seçebilir. | Farklı sağlayıcılar arasında, özellikle yerelden yönlendirilen çocuklara güvenilir delegasyona ihtiyaç duyan yeni başlayanlar. |
| **base** (varsayılan) | Yukarı akış model sabitlemeleri: GPT-5.6 Sol/Terra v2 kullanır, Luna v1 kullanır ve sabitlenmemiş modeller Codex'in `multi_agent_v2` özellik bayrağını takip eder. | Çoğu kullanıcı. Küresel olarak birini zorlamadan her model için Codex'in hedeflenen arayüzünü takip eder. |
| **v2** | Eşzamanlı oturumlarla düz `spawn_agent`, `send_message`, `followup_task`, `interrupt_agent` ve ajan listesi araçları. | Daha yeni eşzamanlı iş akışını isteyen ve model kalıtımını ve aşağıdaki şifrelenmiş görev sınırlamasını anlayan kullanıcılar. |

:::tip[Emin değil misiniz?]
**base** ile başlayın. Sağlayıcılar arası yetkilendirmenin öngörülebilir şekilde
çalışması gerektiğinde **v1**'i seçin. Yalnızca her katalog girdisi genelinde
daha yeni oturum modelini özellikle istediğinizde **v2**'ye zorlayın.
:::

## Nasıl çalışır?

Seçilen mod, Codex'in okuduğu her katalog girdisindeki `multi_agent_version`
alanını denetler:

- **v1**, her modele `multi_agent_version = "v1"` damgalar.
- **base**, yukarı akış sabitlemelerini geri yükler. Sabitlenmemiş girdiler
  yerel `multi_agent_v2` özellik bayrağını takip eder.
- **v2**, her modele `multi_agent_version = "v2"` damgalar; ancak **ChatGPT'yi v1'de tut** etkinken bu kural dışıdır: ChatGPT yerel satırları `"v1"` kalır, yönlendirilen ve combo satırları `"v2"` kalır.

opencodex bunu hem canlı `/v1/models` kataloğuna hem de diske senkronize edilen
kataloğa son geçiş olarak uygular. Bir mod değişikliğinin yeni oluşturulan App,
CLI ve TUI oturumlarını tutarlı bir şekilde etkilemesinin nedeni budur.

Bir v2 kadrosu için uygunluğun üç durumu vardır: `"v2"` damgalı, açıkça `null`
olarak ayarlanmış veya `multi_agent_version` alanı olmayan bir girdi uygundur.
Gerçek bir `"v1"` sabitlemesi hariç tutulur çünkü modelin diğer işbirliği
yüzeyine ait olduğunu belirtir.

## Yetkilendirme modeli ve çaba

Kontrol panelinin **Alt ajan yetkilendirmesi** üç ilgili ayarı denetler:

- `injectionModel`, opencodex rehberliğinde adı geçen tercih edilen çalışan
  modelidir.
- `injectionEffort`, bu model için talep edilecek isteğe bağlı
  `reasoning_effort` değeridir.
- `injectionPrompt`, yerleşik v2 rehberlik metninin yerini alır.

`multiAgentGuidanceEnabled` varsayılan olarak açıktır ve her iki yüzeyde de
opencodex tarafından yazılan rehberlik için ana anahtardır. Kapatılması hem v2
atama bloğunu hem de v1 proaktif metnini bastırır.

Dizi biçimli durum bilgisi olmayan Responses istekleri için opencodex,
oluşturulan rehberliği geliştirici `additional_tools` dahil olmak üzere öndeki
sistem ve geliştirici meta verilerinden sonra ve konuşma girdisinden önce
yerleştirir. Durum bilgili `previous_response_id` devamları, etiketli rehberliği
yalnızca güvenilen yeniden oynatma önekindeki en son etiketli öğeyle
eşleştiğinde yeniden kullanır. Diğer oluşturulan rehberlik, bu önekte tam olarak
oluşturulmuş bir geliştirici öğesi mevcut olduğunda yeniden kullanılır.
Rehberlik değiştiğinde öndeki araç protokolü ilk sırada kalır ve değişiklik
geçerli konuşma girdisinden önce eklenir.

Bunlar ana ajana verilen talimatlardır, proxy tarafında bir spawn yönlendiricisi
değildir. v2'de tam geçmişli bir çatal üst modeli devralır ve model veya çaba
geçersiz kılmalarını reddeder. Bu nedenle rehberlik, `model` veya
`reasoning_effort` iletirken Codex'e `fork_turns: "none"` (veya `"3"` gibi
pozitif bir kısmi tur sayısı) kullanmasını ve görev mesajını bağımsız hale
getirmesini söyler.

Özel `injectionPrompt` metni dört yer tutucunun tümünü kullanabilir:

| Yer tutucu | Şununla değiştirilir |
| --- | --- |
| `{{model}}` | Bu istek için geçerli tercih edilen model. Yalın bir yerel `injectionModel`, yalnızca isteğin kendisi açık bir hesap seçicisini hedeflediğinde hesap nitelikli olur. Çözümlenmemiş veya belirsiz bir yalın değer boş bir dize haline gelir; çözümlenmemiş açık bir hesap nitelikli veya yönlendirilmiş kimlik değişmeden kalır |
| `{{effort}}` | Yapılandırılmış `injectionEffort` veya boş bir dize |
| `{{roster}}` | Çözümlenen seçicide görünen, arayüzle uyumlu kadro |
| `{{fallback}}` | Yapılandırılmış genel geri dönüş rehberliği |

Yerleşik v2 rehberliğinin 700 karakterlik bir bütçesi vardır. Bütçeyi aşacaksa
opencodex temel spawn talimatlarını kesmek yerine önce kadroyu bırakır. Yerleşik
rehberlik yalnızca tercih edilen bir model, uygun kadro veya geri dönüş zinciri
çözümlendiğinde devreye girer. Yapılandırılmış bir `injectionModel` özel bir
istem oluşturmak için yeterlidir; yalın bir değer benzersiz şekilde
çözümlenemezse `{{model}}` boş bir dizeye genişler.

v1'de opencodex yalnızca `max` veya `ultra` çabada yukarı akış tarzı proaktif
yetkilendirme rehberliğini enjekte eder. v1'de tercih edilen bir model, kadro,
geri dönüş listesi veya özel istem eklemez.

Varsayılan olarak kapalı olan `syncCodexSubagentDefaults` seçeneği rehberlikten
ayrıdır. opencodex aktif Codex yönlendirmesine sahip olduğunda senkronizasyon
veya yeniden başlatma, seçilen değerleri Codex TOML'a işaretçi sahipliğindeki
`[agents] default_subagent_model` ve `default_subagent_reasoning_effort`
girdileri olarak yazabilir. opencodex yalnızca kendi işaretçilerini taşıyan
alanları günceller veya kaldırır. Hedef alanlardan biri kullanıcıya aitse çift
kısmen yazılmak yerine değiştirilmeden bırakılır; belirsiz TOML yazılmadan
reddedilir. Harici sağlayıcı yöneticileri ve kullanıcıya ait kök yönlendirmesi
de yetkili kalır.

## Geri dönüş zincirleri (Fallback chains)

Oluşturulan bir çalışan için opencodex şu öncelik sırasını oluşturur:

1. İstenen birincil model.
2. opencodex yapılandırmasındaki `subagentModelFallbackByModel`'dan, istenen
   birincil modelle anahtarlanan model başına bir zincir.
3. opencodex yapılandırmasındaki genel `subagentModelFallback` listesi.

Rol başına geri dönüş zincirleri `$CODEX_HOME/agents/*.toml` içinde değil,
opencodex yapılandırmasında yer alır. Codex 0.146+ ajan rol dosyalarını katı bir
şekilde serileştirir ve `model_fallback`'i bilinmeyen bir alan olarak reddeder,
bu da tüm rol tanımını atlar (#1190). opencodex geriye dönük uyumluluk için
TOML'dan eski bir `model_fallback` satırını yine de okuyabilir, ancak `ocx
doctor` bu konuda uyarır ve Codex'in kendisi etkilenen rolü yok sayar.

İlk oluşum korunurken yinelenen model kimlikleri kaldırılır. Seçim sırasında
opencodex devre dışı bırakılmış, yönlendirilemez, devre dışı bırakılmış bir
sağlayıcı tarafından desteklenen, sağlıksız olarak işaretlenmiş, bir soğuma
süresi içinde olan, kullanılabilir bir havuzlanmış Codex hesabı eksik olan veya
yapılandırılmış kota eşiğinin ötesinde olan adayları atlar. Kullanılabilirlik
probları `subagentModelFallbackPollMs` (varsayılan olarak 60 saniye) boyunca
önbelleğe alınır.

Geri dönüş, uyumsuz şifrelenmiş görevleri okunabilir kılmaz. Çocuk görevi
ChatGPT için şifrelendiğinde, zincirde daha önce harici bir model görünse bile
seçim kurallı yerel ChatGPT hedefleriyle sınırlandırılır.

## Şifrelenmiş v2 görev teslimi

Codex, bir v2 yerelden yönlendirilen çocuk görevini yalnızca arka uçta
şifrelenmiş `encrypted_content` olarak gönderebilir. Bu yük yerel ChatGPT arka
ucu tarafından okunabilir, ancak harici bir sağlayıcı tarafından okunamaz. Bu,
bilinen [#92 sınırlamasıdır](https://github.com/lidge-jun/opencodex/issues/92).

opencodex boş veya okunamayan bir görevi iletmek yerine güvenli bir şekilde
başarısız olur:

- Doğrudan yerel olmayan bir rota `error.code =
  "unreadable_encrypted_agent_task"` ile HTTP 400 döndürür ve şifreli metni
  yankılamaz.
- Bir kombo, yeniden denemeler de dahil olmak üzere bu görev için yalnızca
  kurallı yerel ChatGPT hedeflerini değerlendirir. Hiçbiri yoksa aynı 400
  hatasını döndürür.
- Okunabilir bir düz metin görevi normal rota ve geri dönüş davranışını korur.

Kurtarma seçenekleri, yerel bir ChatGPT çocuğu seçmek, komboya yerel bir ChatGPT
hedefi eklemek, heterojen sağlayıcı yetkilendirmesi için v1 kullanmak veya
arayanı denetlediğinizde görevi düz metin v2 `agent_message` içeriği olarak
yeniden göndermektir.

Deneysel, varsayılan olarak devre dışı bırakılmış bir `agentTaskRecovery`
seçeneği, `authMode: "forward"` ile kurallı `openai` sağlayıcısı tarafından
kullanılan gelen kimlik bilgisi şeklini kullanarak sabit ChatGPT `/responses` uç
noktasına ham Responses doğrudan geçişi aracılığıyla bu belirli yerelden
yönlendirilen şekli kurtarabilir. Kurtarma yalnızca proxy geri döngüye bağlıyken
kullanılabilir. Asla API anahtarı kimlik doğrulamasının, başka bir sağlayıcı
kimlik bilgisinin veya başka bir Codex hesabının yerine geçmez. Yalnızca
`authorization`, eşleşen `chatgpt-account-id`, `originator` ve isteğe bağlı
`openai-beta`/`user-agent` meta verileri iletilir; `content-type` ve `accept`
yerel olarak oluşturulur ve başka hiçbir arayan başlığı sınırı geçmez. Kotayı
tüketir, gecikme ekler, kurtarılan düz metni sınırlı bir bellek içi önbellekte
kısa süre tutar ve belgelenmemiş ChatGPT arka uç davranışına bağlıdır. Bir model
kurtarılan metni döndürdüğü için bayt bayt doğruluk garanti edilmez. Genel/API
anahtarlı proxy arayanlarını reddeder ve herhangi bir arızada
`unreadable_encrypted_agent_task`'i korur. Tam güven sınırı ve yapılandırma için
[Ajan yapılandırması: Şifrelenmiş v2 görev
kurtarma](/tr/reference/configuration/agents/#encrypted-v2-task-recovery)
bölümüne bakın. Kombo yönlendirmesi değişmeden kalır ve şifrelenmiş görevler
için yalnızca kurallı yerel ChatGPT hedeflerini değerlendirmeye devam eder.

## Modu değiştirme

### GUI

- **Kontrol Paneli** → ilk istatistik hücresi: **v1**, **base** veya **v2**'yi
  seçin.
- **Modeller** → üst satır bölümlenmiş kontrol: aynı küresel modu seçin.
- **Kontrol Paneli** → **Alt ajan yetkilendirmesi**: rehberlik modelini/çabasını
  ve yerel varsayılan katılımını ayarlayın.
- **Alt Ajanlar**: kadroyu seçip sıralayın ve küresel geri dönüş zincirini
  yapılandırın.

### CLI

İşbirliği arayüzü ve yerel özellik ayarları için `ocx v2` kullanın:

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 mode v2
ocx v2 threads 8
```

Yetkilendirme, kadro, çaba sınırı ve geri dönüş ayarları için `ocx agent`
kullanın:

```bash
ocx agent status
ocx agent injection set --model anthropic/claude-sonnet-5 --effort xhigh
ocx agent subagents set gpt-5.6-sol,anthropic/claude-sonnet-5
ocx agent fallback set gpt-5.4-mini,xai/grok-4.5 --poll-ms 60000
ocx agent effort set --subagent max
```

Boş bırakılabilir bir `ocx agent injection` değerini temizlemek için `-` iletin
veya bir kadro veya geri dönüş listesi için ilgili `clear` eylemini kullanın.
Tüm komut aileleri için [CLI referansına](/tr/reference/cli/) bakın.

### API

Yönetim API'si eşleşen `GET` ve `PUT` uç noktalarını sunar:

| Uç nokta | Yönettiği |
| --- | --- |
| `/api/v2` | Arayüz modu, yerel özellik bayrağı ve iş parçacığı ayarları |
| `/api/injection-model` | Tercih edilen model, çaba, özel istem, rehberlik ve yerel varsayılan senkronizasyonu |
| `/api/effort-caps` | Ana ajan ve alt ajan çaba tavanları |
| `/api/subagent-models` | En fazla beş modelden oluşan sıralı kadro |
| `/api/subagent-model-fallback` | Küresel geri dönüş sırası ve yoklama aralığı |

Örneğin:

```bash
curl -X PUT http://localhost:10100/api/v2 \
  -H 'Content-Type: application/json' \
  -d '{"multiAgentMode":"v2"}'

curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model":"anthropic/claude-sonnet-5","effort":"xhigh"}'
```

## SSS

### Bir delegasyon modeli seçmek Codex'i onu spawn etmeye zorlar mı?

Hayır. Rehberlik bir model önerebilir ve yerel varsayılan senkronizasyonu bir
Codex varsayılanı sağlayabilir, ancak ana ajan yine de yetkilendirip
yetkilendirmeyeceğine kendisi karar verir.

### v2 çocuğum neden üst modeli kullandı?

Tam geçmişli bir v2 çatalı üst modeli devralır. Bir model veya çaba geçersiz
kılmasını iletmeden önce `fork_turns` değerini `"none"` veya pozitif bir kısmi
sayıya ayarlayan bir spawn kullanın.

### Yapılandırılmış bir model neden v2 kadrosunda eksik?

Seçicide gizlenmiş olabilir, beş modelli görüntüleme sınırının dışında olabilir,
katalogda eksik olabilir veya v1'e sabitlenmiş olabilir. Bir `"v2"`, `null` veya
bulunmayan arayüz değeri uygundur; gerçek bir `"v1"` sabitlemesi uygun değildir.

### Mod değişiklikleri çalışan oturumları etkiler mi?

Hayır. Modu değiştirdikten sonra yeni bir Codex oturumu başlatın. Uzun süredir
çalışan bir App ana bilgisayarı hala eski katalog durumunu gösteriyorsa `ocx
sync` çalıştırın ve bu Codex arayüzünü yeniden başlatın.

### opencodex kataloğa güvenemediğinde ne olur?

opencodex, diskteki model kataloğunu geçerli kullanıcıya ait her Codex
app-server'ının başlangıç zamanıyla karşılaştırarak dört durumdan birini üretir:

| Durum | Anlamı | v2 rehberliği |
|---|---|---|
| `fresh` | Her app-server katalog yazıldıktan sonra başladı | Tam rehberlik: tercih edilen model, kadro, geri dönüşler |
| `not_running` | Hiçbir app-server algılanmadı | Tam rehberlik |
| `stale` | En az bir app-server katalogdan önceye dayanıyor | **opencodex kaynaklı model rehberliği yok** |
| `unknown` | Karşılaştırma yapılamadı | **opencodex kaynaklı model rehberliği yok** |

`stale` ve `unknown` için opencodex diskten türetilen kendi iddialarını — tercih
edilen model, kadro, geri dönüş ve özel rehberlik — alıkoyar çünkü çalışan Codex
disk kataloğunun tanıttığı şeyi spawn edemeyebilir.

Modele `model` veya `reasoning_effort` ayarlamayı durdurmasını **söylemez**. Bu
gözlem kullanıcı için her app-server genelinde küreseldir, oysa gelen bir istek
hiçbir gönderen kimliği taşımaz; bu nedenle eski bir süreç önümüzdeki isteğe
atfedilemez. Bu temelde geçersiz kılmaları yasaklamak, gayet taze olabilecek bir
oturum için aktif `spawn_agent` aracının meşru olarak tanıttığı seçenekleri
engeller. Aktif araç şeması yetkili kalır.

`unknown`, `stale` ile eşanlamlı değildir. Karşılaştırmanın kendisinin başarısız
olduğu anlamına gelir — okunamayan bir katalog zaman damgası, okunamayan bir
süreç başlangıç zamanı veya başarısız bir süreç numaralandırması — ve `ocx
doctor` tarafından ayrı olarak bildirilir. `stale`, yalnızca algılanan her Codex
app-server'ı son katalog yazımından sonra başladığında temizlenir; `unknown`'u
mutlaka temizlemez.

Yalnızca gerçek bir değişiklik sayılır. Sonucu diskte zaten bulunan katalogla
bayt bayt aynı olan bir senkronizasyon dosyaya dokunulmadan bırakır, bu nedenle
proxy'yi yeniden başlatmak veya değişmemiş bir model kümesini yeniden senkronize
etmek çalışan bir Codex'in eski görünmesine neden olmaz.

### Akıl yürütme çabası

`injectionEffort` yalnızca yetkilendirilmiş çalışan rehberliğini ve açıkça
etkinleştirildiğinde yerel Codex alt ajan varsayılanlarını etkiler. Üst oturumun
çabasını değiştirmez. `ultra`, Codex'in `max`'a dönüştürdüğü istemciye yönelik
bir üst katmandır; opencodex daha sonra seçilen sağlayıcı için değeri eşler veya
sabitler.

### Bağlam sınırı

Model bağlam sınırı alt ajan modundan bağımsızdır. Modeller sayfasında
yapılandırın; yerel OpenAI modelleri gerçek bağlam pencerelerini korur.


