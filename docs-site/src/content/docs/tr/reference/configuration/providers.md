---
title: Sağlayıcı Yapılandırması
description: Sağlayıcı girdileri, kimlik doğrulama, uç noktalar, model katalogları, kotalar, bağlam sınırları ve sağlayıcıya özgü seçenekler.
---

Bir sağlayıcı, opencodex'e bir modelin nerede yaşadığını, hangi hat adaptörünü
konuştuğunu ve isteklerin nasıl doğrulandığını söyler.

## Sağlayıcı ile ilgili üst düzey alanlar

| Alan | Tip | Varsayılan | Anlamı |
| --- | --- | --- | --- |
| `providers` | `Record<string, OcxProviderConfig>` | — | Sağlayıcı adından sağlayıcı yapılandırmasına eşleme haritası. |
| `openaiProviderTierVersion?` | `2` | geçiş tarafından ayarlanır | Tek seçenek duyarlı OpenAI projeksiyonunu tamamlandı olarak işaretler. |
| `disabledModels?` | `string[]` | — | Codex kataloğundan ve `/v1/models` listesinden gizlenen, ancak doğrudan proxy çağrılarından engellenmeyen modeller. Yönlendirilen bir kimlik listelerden kaldırılır. Hesap nitelikli bir yerel kimlik yalnızca o seçici satırını gizler; yalın bir yerel GPT kimliği, yalın satırı ve o model için her hesap seçici satırını gizler. Kontrol paneli Modeller sayfası yalnızca yönlendirilen ve yalın yerel satırları gösterir; seçici nitelikli bir satırı gizlemek için doğrudan bu yapılandırma alanını kullanın. |
| `providerContextCaps?` | `Record<string, number>` | `{}` | Sağlayıcı başına Codex tarafından görülebilen bağlam sınırları. Bir sınır yalnızca bilinen bir bağlam penceresini düşürür. |
| `contextCapValue?` | `number` | `350000` | Kontrol paneli bağlam sınırı kontrolleri tarafından kullanılan varsayılan değer. Değiştirilmesi, yalnızca "tüm yönlendirilen sağlayıcılara uygula" açık olduğunda değeri mevcut bir `providerContextCaps` girdisi olmayan sağlayıcılar da dahil olmak üzere yönlendirilen her sağlayıcıya uygular; aksi takdirde her sağlayıcı kendi sınırını korur. |
| `codexAccounts?` | `CodexAccount[]` | `[]` | Codex Auth tarafından yönetilen ChatGPT/Codex havuz hesabı meta verileri. Sırlar ayrı olarak `codex-accounts.json` içinde yer alır. |
| `pausedCodexAccountIds?` | `string[]` | `[]` | Duraklatıldığında ana `__main__` hesabı da dahil olmak üzere, devam ettirilene kadar Havuz seçiminden hariç tutulan hesaplar. |
| `codexAccountNamespaces?` | `Record<string, string>` | — | İsteğe bağlı olarak rastgele bir genel model seçiciden saklanan bir Codex hesap hedefine eşleme. Hesap nitelikli seçici satırları etkinleştirildiğinde, hedefi mevcut olan her seçici, Codex seçicisine ayrı `<seçici>/<yerel-openai-modeli>` satırları ekler; her satır yalnızca o hesabı kullanır. Herhangi bir seçici etkinken, yalın yerel satırlar seçicide gizlenir, ancak açıkça devre dışı bırakılmadıkça kimlikleri yönlendirilebilir kalır ve ham `/v1/models` tarafından listelenir. |
| `codexAccountPickerEnabled?` | `boolean` | harita boşken kapalı | Uygun `codexAccountNamespaces` eşlemelerinin hesap nitelikli Codex seçici satırları oluşturup oluşturmayacağını denetler. `true`, eşlenen satırların görünmesine izin verir. Boş olmayan bir haritayla atlanırsa, geriye dönük uyumluluk için etkin olarak değerlendirilir; harita boşsa kapalıdır. `false`, eşlemeleri silmeden veya tam `<seçici>/<yerel-openai-modeli>` yönlendirmesini devre dışı bırakmadan oluşturulan satırları gizler ve yalın yerel seçici satırlarını geri yükler. |
| `activeCodexAccountId?` | `string` | — | Sonraki istek için manuel olarak seçilen Havuz hesabı. Seçim iş parçacığı bağlılığını temizler; devam eden istekler yakalanan kimlik bilgilerini korur. |
| `codexAccountPriorities?` | `Record<string, number>` | — | Codex havuzu için hesap başına seçim sırası: hesap kimliği → `-100` ile `100` arası tam sayı, **daha yüksek olan daha önce kullanılır**, yoksa `0` anlamına gelir. Bu bir öncelik sırası sınırıdır, bir uygunluk sınırı değildir: seçim, zaten uygun olan hesapları hala kota payı bulunan en yüksek katmana daraltır ve `accountPoolStrategy` daha sonra bu katman içinde seçim yapar. Bir katman, yalnızca her üye `autoSwitchThreshold` üzerinde olduğunda, soğumada olduğunda, yumuşak kaçınıldığında, duraklatıldığında veya yeniden kimlik doğrulama gerektiğinde atlanır — bilinmeyen kota asla bir katmanı boşaltmaz. Sıralama asla uygun olmayan bir hesabı seçilebilir yapmaz ve zaten bir hesabı olan bir iş parçacığını asla yeniden bağlamaz. Ana `__main__` hesap eşit şartlarda katılır, bu sayede Codex Desktop girişi en son tükenecek şekilde ayarlanabilir. Hiçbir girdi olmadığında havuz tam olarak eskisi gibi davranır. Hatalı biçimlendirilmiş bir harita bir konsol uyarısıyla yok sayılır (sıralama kapalı, yapılandırma onarımı yok). `ocx account priority` ve Codex Auth sayfası tarafından yönetilir. |
| `activeCodexAccountPinned?` | `string` | — | Operatörün en son elle seçtiği hesap kimliği. Ayarlandığı sürece, pin tükenme, hariç tutma, silme veya açık bir yük devretme/yükseltme ile serbest bırakılana kadar daha yüksek bir `codexAccountPriorities` katmanı onu öncelikleyemez. Sınırlı katman içindeki sıradan round-robin hareketi onu serbest bırakmaz. Herhangi bir `codexAccountPriorities` girdisi yazmak da pini serbest bırakır, böylece bir sıra var olmadan önce yapılan bir pin daha sonra ayarlanan bir pinin önüne geçemez. `GET /api/codex-auth/active`, hem geçerli hesabın sabitlenip sabitlenmediğini (`pinned`) hem de tavanı taşıyan hesabı (`pinnedAccountId`) bildirir. |
| `autoSwitchThreshold?` | `number` | `80` | Proaktif geçiş için kullanım eşiği. `quota`, bir sonraki isteklerinde hem bağlı hem de bağımsız görevleri yeniden değerlendirebilir; `fill-first` bunu yalnızca bağımsız atama için tükenme noktası olarak kullanır; normal `round-robin` seçimi bunu kullanmaz. Puan, bilinen en sıcak 5 saatlik, haftalık veya 30 günlük kota penceresini kullanır. `0`, yalnızca kullanıma dayalı proaktif geçişi devre dışı bırakır, bağımsız atamayı veya arıza kurtarmayı devre dışı bırakmaz. |
| `accountPoolStrategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | Yeni/bağımsız Codex istekleri için atama stratejisi. Bir istek, canlı (üst iş parçacığı kimliği, kota kapsamı) bağlılığı olmadığında bağımsızdır; görünür mevcut bir görev, proxy yeniden başlatmasından veya bağlılık sıfırlamasından sonra bağımsız hale gelebilir. `quota`, aktif bir hesap olmadığında en düşük kullanımlı uygun hesabı seçer, `autoSwitchThreshold` altında uygun bir aktif hesabı tutar ve eşikten sonra bağımsız bir isteği taşıyabilir veya bağlı bir görevi proaktif olarak daha düşük kullanımlı uygun bir hesaba yeniden bağlayabilir. `round-robin`, bağımsız istekleri eşit olarak dağıtır; `fill-first`, soğuma, kullanılamama veya yapılandırılmış tükenme eşiğine kadar bağımsız istekleri aktif hesaba atamaya devam eder. |
| `accountPoolStickyLimit?` | `number` | `1` | İlerlemeden önce bir round-robin seçiminde tutulan yeni/bağımsız görev atamaları; sayaç yukarı akış başarısından sonra değil, bir görev bağlandığında ilerler. Aralık 1–100. |
| `upstreamFailoverThreshold?` | `number` | `3` | Gelecekteki yeni oturumların yük devretmesinden önceki ardışık geçici arızalar. Devre dışı bırakmak için `0` ayarlayın. Düzenli Responses ve yerel sıkıştırma gönderimleri için kanıtlanmış bağlantı öncesi DNS/TCP erişilebilirlik arızaları sağlayıcı-ana bilgisayar düzeyinde izlenir: hesap sağlığını, hesap soğuma sürelerini, iş parçacığı/oturum bağlılığını, aktif hesap seçimini veya Havuz yönlendirmesini asla etkilemez ve bu eşiğe asla sayılmaz. |
| `upstreamHostCircuitThreshold?` | `number` | `0` | Yerel OpenAI iletme Responses ve sıkıştırma gönderimlerinde kanıtlanmış bağlantı öncesi DNS/TCP arızaları için isteğe bağlı devre eşiği. `0` devre dışı bırakır; `1`–`20`, bu kadar terminal mantıksal istekten sonra 30 saniyelik bir sağlayıcı-kaynak soğuma süresi açar. Açıkken istekler, hesap seçiminden veya yukarı akış gönderiminden önce `Retry-After` ile `503` alır; soğuma süresinden sonra bir yarı açık isteğe izin verilir. Zaman aşımları ve HTTP yanıtları asla sayılmaz ve herhangi bir HTTP yanıtı devreyi kapatır. Yalnızca sabitlenmiş hesabı olmayan Codex Havuz yönlendirmesi için geçerlidir; `codexAccountMode: "direct"` ve hesap nitelikli seçiciler için etkisizdir. |
| `modelCacheTtlMs?` | `number` | `300000` | Sağlayıcı başına `/models` önbelleği için tazelik penceresi. |
| `cacheRetention?` | `"none" \| "short" \| "long"` | `"short"` | Anthropic istem önbelleği politikası: devre dışı, 5 dakikalık kısa ömürlü veya 1 saatlik uzatılmış. |
| `tokenGuardian?` | `OcxTokenGuardianConfig` | kapalı | İsteğe bağlı proaktif OAuth yenileme ve Codex hesabı ısınma politikası. |

Seçici adları kullanıcı tarafından seçilen genel etiketlerdir; opencodex bunlara
hiçbir hesap rolü anlambilimi atamaz. `codexAccountNamespaces` anahtarları 1–64
karakterdir, başında ve sonunda bir ASCII harf veya rakam bulunur, içinde
harfler, rakamlar, `.`, `_` veya `-` yer alır. Ayrılmış JavaScript nesne adları
reddedilir. Her değer geçerli bir havuz hesabı kimliği (asla dahili `__main__`
değil) veya Codex Desktop hesabı için `"@main"` değeridir. Sağlayıcı ve ayrılmış
`openai` / `combo` / `policy` çakışmaları büyük/küçük harfe duyarsız olarak
denetlenir; ad alanlı bir kombo veya yönlendirme profili takma adı, bir seçiciyi
ad alanı öneki olarak yeniden kullanamaz ve yapılandırılmış havuz kimlikleri
veya seçici hedefleri de bir seçiciyi yeniden kullanamaz. Ham hesap kimliklerini
ve e-postalarını gizli tutun; seçici genel addır. Tam seçim davranışı ve
önceliği için [Yönlendirme Yapılandırması](/tr/reference/configuration/routing/)
sayfasına bakın.

Codex Auth kontrol paneli kontrolü, açık bir `codexAccountPickerEnabled` alanına
sahip haritalara sahiptir. Boş bir yönetilen haritayı etkinleştirmek gizlilik
açısından güvenli seçiciler oluşturur; daha sonraki hesap eklemeleri, seçici
satırları gizliyken bile mevcut seçicileri yeniden adlandırmadan bu haritayı
genişletir. Bayrağı atlayan elle yazılmış bir harita manuel kalır ve asla
otomatik olarak genişletilmez. Bir hesabı silmek eşlemesini korur, böylece
eksikken tam rotalar kapalı olarak başarısız olur; aynı hesap kimliğini tekrar
eklemek yeni bir tane ayırmak yerine mevcut genel seçiciyi geri yükler.

## Ayrılmış OpenAI sağlayıcıları

`openai` ve `openai-apikey` sabit ayrılmış kimliklerdir.
`openai.codexAccountMode` varsayılan olarak `"pool"` değerindedir ve ana hesap
artı eklenen hesaplar arasında seçim yapar; `"direct"` yalnızca geçerli
arayan/ana girişi kullanır. API yalnızca yapılandırılmış API anahtarını veya
anahtar havuzunu kullanır. Yalın bir model veya `openai-apikey/<model>`
kullanın; rotalar arası kimlik bilgisi geri dönüşü yoktur. API GPT-5.6 satırları
922.000 bağlam / 922.000 maksimum girdi meta verisi taşır ve Pro sanal
kimlikleri `reasoning.mode: "pro"` ile temel hat modeline yeniden yazılır.

`openaiProviderTierVersion: 2`, geçerli tek sağlayıcılı projeksiyonu işaretler.
opencodex, sevk edilen bir v1 yapılandırmasını geçirmeden önce farklı bir yedeği
değiştirmeden `config.json.pre-openai-tiers-v2.bak` oluşturur ve bilinen eski ad
alanlı seçilmiş kimlikleri yalın kimliklere yeniden yazar.

## Sağlayıcı girdileri (`OcxProviderConfig`)

| Alan | Tip | Anlamı |
| --- | --- | --- |
| `adapter` | `string` | `openai-chat`, `openai-responses`, `anthropic`, `google`, `kiro`, `cursor`, `azure-openai` (veya takma ad `azure`) seçeneklerinden biri. |
| `baseUrl` | `string` | Yukarı akış API temel URL'si. Çoğu yerleşik sabit uç nokta uyumsuzluğu yok sayar; çakışma güvenli anahtar önayarları aynı adlı daha eski özel bir hedefi korur. |
| `responsesPath?` | `string` | Anahtar kimlik doğrulamalı `openai-responses` istekleri için göreli kaynak yolu. `/` ile başlamalı ve şema, sorgu veya parça içermemelidir. |
| `supportsServiceTier?` | `boolean` | Üç durumlu `service_tier` yeteneği. `true`: hızlı mod enjekte edebilir ve arayan değerleri korunur. `false`: alan kaldırılır ve asla enjekte edilmez (desteklemediği belgelenen yukarı akış bunu almamalıdır). Yok: sağlayıcı sınıflandırılmamıştır — arayan tarafından sağlanan değerler dokunulmadan korunur ve hızlı mod asla enjekte etmez. Kayıt defteri kurallı OpenAI'yi (`true`), DeepSeek'i ve Volcengine Ark'ı (`false`) sınıflandırır; bunu yalnızca katmanları gerçekten destekleyen özel ağ geçitleri için açıkça ayarlayın. |
| `preserveResponsesReasoningContent?` | `boolean` | Düz metin akıl yürütme içeriğini boşaltmak yerine (boşaltma ChatGPT arka ucunun kuralıdır) tekrarlanan Responses akıl yürütme öğelerinde tutun. DeepSeek gibi sözleşmesi akıl yürütme tekrarını kabul eden yukarı akışlar için etkinleştirin. Proxy tarafından basılan `ocxr1` zarfları her zaman kaldırılır. |
| `disabled?` | `boolean` | Sağlayıcıyı diskte tutun ancak yönlendirmeden ve model/katalog listelerinden hariç tutun. |
| `apiKey?` | `string` | API anahtarı veya istek zamanında çözümlenen bir `${ENV_VAR}` / `$ENV_VAR` başvurusu. |
| `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Anthropic anahtar başlığı stili. Varsayılan olarak yerel `x-api-key`; yalnızca anahtar kimlik doğrulamalı `anthropic` sağlayıcıları için geçerlidir. |
| `apiKeyPool?` | `ApiKeyPoolEntry[]` | Çoklu anahtar havuzu. `apiKey` aktif girdiyi yansıtır; her öğe `id`, `key`, isteğe bağlı `label` ve isteğe bağlı sayısal `addedAt` değerine sahiptir. |
| `defaultModel?` | `string` | Bu sağlayıcı açık bir model olmadan seçildiğinde kullanılan model. |
| `models?` | `string[]` | Tohum/geri dönüş model listesi. `liveModels: false` olduğunda bunlar keşfedilen tek modellerdir. |
| `liveModels?` | `boolean` | Başlatmada/senkronizasyonda canlı kataloğu getirin (varsayılan `true`). Özel sağlayıcılar `${baseUrl}/models` kullanır; yerleşikler bir kayıt defteri URL'si ve filtresi kullanabilir. |
| `selectedModels?` | `string[]` | Keşiften sonra katalog izin listesi. Boş olmaması yalnızca bu kimlikleri gösterir; boş veya atlanmış olması keşfedilen tüm modelleri gösterir. |
| `contextWindow?` | `number` | Yukarı akış meta verileri olmadığında sağlayıcı genelinde bağlam geri dönüşü; aksi takdirde daha küçük canlı meta verileri koruyan bir sınır. Modeller kontrol paneli bunu `providerContextCaps` alanından ayrı olarak gösterir. |
| `modelContextWindows?` | `Record<string, number>` | Model başına bağlam geri dönüşleri/sınırları. Bunlar `contextWindow`'u geçersiz kılar: bilinmeyen bir pencere yapılandırılmış değeri kullanırken, daha küçük canlı meta veriler yetkili kalır. |
| `modelInputModalities?` | `Record<string, string[]>` | Model başına girdi ipuçları, örn. `["text"]` veya `["text", "image"]`. |
| `modelMaxInputTokens?` | `Record<string, number>` | Katalog otomatik sıkıştırma ipuçları için kullanılan pozitif model başına maksimum girdi sınırları. |
| `defaultMaxOutputTokens?` | `number` | İstemci `max_output_tokens` değerini atladığında sağlayıcı genelinde `openai-chat` geri dönüşü. |
| `modelMaxOutputTokens?` | `Record<string, number>` | Pozitif model başına `openai-chat` geri dönüş bütçeleri; tam/kalıp eşleşmeleri sağlayıcı varsayılanını yener. |
| `modelCosts?` | `Record<string, Cost4>` | Sağlayıcının tam yukarı akış model kimliğine göre anahtarlanan model başına görüntüleme fiyatları (1M token başına USD) — bir sağlayıcı tanımlayıcısı veya yönlendirilen `provider/model` etiketi değil, örn. `{ "deepseek-v4-flash": { "input": 0.14, "output": 0.28, "cacheRead": 0.0028, "cacheWrite": 0 } }`. Herhangi bir model kimliği geçerli bir anahtardır — özel sağlayıcılar `openai-chat` adaptörü aracılığıyla herhangi bir OpenAI uyumlu uç noktayı hedefleyebilir ve yerel veya dahili sağlayıcı kimlikleri yerleşik kataloglarda bulunmasalar bile çalışır. Kullanıcı tarafından yapılandırılan fiyatlar Günlükler `~$` ve Kullanım tahminlerinde yerleşik katalogları yener; geçmiş girdiler geçerli katmandan yeniden fiyatlandırılır, bu nedenle bir fiyatı düzenlemek geçmiş toplamları değiştirebilir. Geri dönüş sırası: kullanıcı `modelCosts` → jawcode kataloğu → beklenen fiyat katmanı → model düzeyinde satıcı geri dönüşü ve tamamen sıfır bir girdi bu dizideki bir sonraki kaynağa düşer. Her oran en fazla 1.000.000 (1M token başına USD) olan negatif olmayan sonlu bir sayı olmalıdır; aralık dışı satırlar yönetim sınırı tarafından reddedilir ve yükleme sırasında bırakılır. Yalnızca görüntüleme zamanı tahmini: katmanlar yönlendirmeyi, hesap seçimini, kotaları veya faturalandırmayı asla etkilemez. |
| `headers?` | `Record<string, string>` | Ek yukarı akış başlıkları. Yetkilendirme, çerezler, API anahtarı başlıkları, gömülü yeni satırlar ve geçersiz adlar reddedilir. |
| `openRouterRouting?` | `OpenRouterProviderRouting` | Varsayılan OpenRouter `order`, `only` ve `allowFallbacks` tercihleri; yalnızca `openai-chat` ile kurallı OpenRouter için geçerlidir. |
| `modelOpenRouterRouting?` | `Record<string, OpenRouterProviderRouting>` | Sağlayıcı genelindeki OpenRouter tercihinin yerini alan tam model kimliği geçersiz kılmaları. |
| `authMode?` | `"key" \| "forward" \| "oauth" \| "local"` | Kimlik doğrulama modu (varsayılan `key`). OAuth/abonelik kimlik bilgileri `config.json` dışında saklanır; `local`, kayıt defteri girdisi izin veren sağlayıcılarla sınırlıdır. |
| `codexAccountMode?` | `"pool" \| "direct"` | Yalnızca kurallı `openai`; varsayılan olarak Pool. Direct havuz durumunu atlar. |
| `refreshPolicy?` | `"proactive" \| "lazy-only" \| "disabled"` | Bu OAuth sağlayıcısının Token Guardian politikasını geçersiz kılın. |
| `reasoningEfforts?` | `string[]` | Bildirilecek ve gönderilecek sağlayıcı genelinde Codex akıl yürütme etiketleri. `google` adaptör sağlayıcıları için yapılandırılmış bir merdiven `thinkingLevel` yeteneğini de iddia eder: doğrudan ve Vertex görsel olmayan istekleri seçilen çabayı `generationConfig.thinkingConfig.thinkingLevel` olarak gönderirken, Cloud Code Assist zarfa özgü yolunu kullanır. |
| `modelReasoningEfforts?` | `Record<string, string[]>` | Model başına etiketler. Boş bir liste çaba denetimini gizler. `reasoningEfforts`'ta olduğu gibi, yapılandırılmış her `google` adaptör merdiveni `thinkingLevel` yeteneğini iddia eder; doğrudan ve Vertex görsel olmayan istekleri düz Gemini yolunu kullanırken, Cloud Code Assist bunu istek zarfı altında gönderir. |
| `modelSupportsReasoningSummaries?` | `Record<string, boolean>` | Özetlerin bildirilmesini durdurmak ve özet teslim alanlarını kaldırmak için bir modeli `false` olarak ayarlayın. |
| `modelReasoningSummaryDelivery?` | `Record<string, "sequential" \| "sequential_cutoff" \| "concurrent" \| "concurrent_cutoff">` | Model başına Responses teslim enum'ı; mevcut bir teslim alanını yeniden yazar. |
| `modelAdapters?` | `Record<string, string>` | Karışık hatlı ağ geçitleri için model başına `openai-chat` veya `openai-responses` hat geçersiz kılma. Açık girdiler kayıt defteri varsayılanlarını yener. OpenCode Go önayarı, kardeş modelleri belgelenmiş hatlarında bırakırken `gpt-5.6-luna` için Responses'ı seçer; DeepSeek, `deepseek-v4-flash` için yerel Responses seçebilir; ve GitHub Copilot, GPT-5 ailesi (`gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`) için yalnızca Responses varsayılanlarını bildirir çünkü bu modeller ajan trafiği için `/chat/completions`'ı reddeder. Yerleşik varsayılanı olmayan modeller (örneğin `gpt-5.4-nano`) burada dahil edilebilir. Tek hatlı yukarı akış pinleri ve kurallı ChatGPT iletme geçersiz kılmaları reddeder. |
| xAI Responses katılımı (panel) | anahtar | Yalnızca `xai` için `grok-4.5` ve `grok-4.6` `modelAdapters` girdilerini atomik olarak ayarlar veya temizler. Tek girdi, sonraki anahtar yazımı ikisini eşitleyene kadar karma durum olarak görünür. Diğer geçersiz kılmalar ve katman davranışı değişmez. |
| `modelPreferHostedTools?` | `Record<string,string[]>` | Barındırılan bir araç ad alanı ayıran iletme harici Responses ağ geçitleri için tam model dahil etme. Şu anda yalnızca `["image_generation"]` kabul eder; eşleşen bir model `openai-responses` hattını kullanmalı ve bu barındırılan aracı desteklemelidir. Çakışan istemci `image_gen` bildirimlerini kaldırır ve arayan araç seçimini korumak için seçicilerini yeniden yazar. OpenAI API sanal `-pro` modelleri için önce seçilen genel kimlik eşleştirilir ve çözümlenen temel hat model kimliği bir geri dönüştür. `modelAdapters` önce genel kimliği, ardından temel kimliği çözer; ikinci çözümleme son hattı belirler. Diğer modeller normal takma ad davranışını korur. |
| `reasoningEffortMap?` | `Record<string, string>` | Akıl yürütme etiketleri için sağlayıcı genelinde hat takma adları. |
| `modelReasoningEffortMap?` | `Record<string, Record<string, string>>` | Akıl yürütme etiketleri için model başına hat takma adları. |
| `reasoningWireFormat?` | `"gateway-object"` | `reasoning_effort` yerine `reasoning: { enabled, effort }` kabul eden OpenAI uyumlu ağ geçitleri için. ClinePass önayarı bunu otomatik olarak ayarlar. |
| `noReasoningModels?` | `string[]` | Akıl yürütme/düşünme parametrelerini reddeden modeller. |
| `noTemperatureModels?` | `string[]` | Arayan tarafından belirtilen `temperature` değerini reddeden modeller. |
| `noTopPModels?` | `string[]` | Arayan tarafından belirtilen `top_p` değerini reddeden modeller. |
| `noPenaltyModels?` | `string[]` | Varlık/frekans cezalarını reddeden modeller. |
| `noStructuredOutputModels?` | `string[]` | `openai-chat` uç noktası `response_format`'ı reddeden tam model kimlikleri. Yalnızca tam bir istenen model eşleşmesi alanı atlar; yapılandırılmış çıktı çevirisi diğer her `openai-chat` modeli için etkin kalır. |
| `parallelToolCalls?` | `boolean` | Paralel araç çağrılarını açıp kapatın. OpenAI Chat varsayılan olarak açıktır; sohbet harici adaptörler yalnızca açık `true` durumunda bildirir. |
| `responsesItemIdRepair?` | `{ message?: string[]; reasoning?: string[]; repairMissingTerminalIds?: boolean; repairInvalidIds?: boolean }` | Tam yer tutucu kimlikleri, eksik terminal kimlikleri ve (`repairInvalidIds` ile) kurallı `msg_`/`rs_` öneki eksik olan mesaj/akıl yürütme kimlikleri için varsayılan olarak devre dışı bırakılmış aşağı akış SSE onarımı. Fonksiyon çağrısı kimlikleri asla yeniden yazılmaz. Yerleşik DeepSeek son ikisini varsayılan olarak etkinleştirir. |
| `responsesSnapshotRepair?` | `boolean` | SSE ve JSON'daki seyrek Responses yaşam döngüsü anlık görüntüleri için varsayılan olarak devre dışı bırakılmış istemciye yönelik onarım. Ham inceleme ve kalıcılık değişmeden kalırken eksik kurallı durumu, çıktıyı ve araç meta verilerini doldurur. |
| `retryOn429?` | `{ enabled?: boolean; attempts?: number; intervalMs?: number; maxIntervalMs?: number; respectRetryAfter?: boolean }` | Yalnızca API anahtarı sağlayıcıları (`authMode: "key"`). İsteğe bağlı aynı hedef 429 yeniden denemesi: `retryOn429` olmadığında özellik kapalıdır; nesnenin varlığı `enabled: false` olmadığı sürece özelliği etkinleştirir. 429'da proxy bekler (yukarı akış `Retry-After` veya sabit aralık) ve herhangi bir anahtar yük devretmesinden önce aynı istek üzerinde aynı anahtarla aynı isteği yeniden oynatır — ana metin turu kurtarma döngüsü, Responses doğrudan geçiş hattı, görsel/video köprüsü, web araması sidecar'ı ve terminal devamları genelinde. Yalnızca akış öncesi HTTP 429 yanıtları yeniden oynatma için uygundur; özel `runTurn` aktarımları HTTP yeniden deneme döngüsünün dışındadır. `attempts`, ilk 429'dan sonraki aynı anahtar yeniden oynatmalarını sayar (toplam gönderim = `attempts` + 1) ve ana kurtarma döngüsü, terminal koruma devamı ve köprü yeniden denemeleri tarafından paylaşılan tek bir istek genelinde bütçedir. `attempts`'ı tüketmek yalnızca daha fazla aynı anahtar yeniden oynatmasını durdurur: normal anahtar yük devretmesi veya nihai hata işleme daha sonra kullanılabilir hedeflere göre geçerli olur — anahtar kimlik doğrulamalı doğrudan geçiş hattında yük devretme yoktur, bu nedenle tükenen 429 olduğu gibi görünür. Codex'in kendisi 429'u asla yeniden denemez, bu nedenle tek anahtarlı sağlayıcılar için tek savunma budur. Varsayılanlar: `enabled: true`, `attempts: 3`, `intervalMs: 5000`, `maxIntervalMs: 60000` (tek bir bekleme `maxIntervalMs` ile sınırlandırılır, kendisi de 600000 ile sınırlandırılır), `respectRetryAfter: true`. |
| `autoToolChoiceOnlyModels?` | `string[]` | `tool_choice`'u yalnızca `auto` veya `none` kabul eden modeller; zorunlu seçimlerin derecesi düşürülür. |
| `preserveReasoningContentModels?` | `string[]` | Sohbet geçmişinde önceki asistan `reasoning_content`'ini gerektiren modeller. |
| `requiresReasoningPlaceholderModels?` | `string[]` | Yukarı akışı `reasoning_content` eksik olan bir tool_call devamını reddeden modeller (DeepSeek düşünme modu); yeniden oynatma önbelleği kaçırdığında minimum bir yer tutucu enjekte edilir. Varsayılan olarak `preserveReasoningContentModels`; devre dışı bırakmak için `[]` ayarlayın. |
| `thinkingToggleModels?` | `string[]` | Bir çaba merdiveni yerine `thinking.enabled` kullanan sohbet modelleri. |
| `thinkingBudgetModels?` | `string[]` | Tamsayı `thinking_budget` kullanan sohbet modelleri; çaba bir bütçe kesirine eşlenir. |
| `noVisionModels?` | `string[]` | Vizyon sidecar'ı üzerinden gönderilen salt metin modeller; eşleştirme bir Ollama `:size` etiketini tolere eder. |
| `escapeBuiltinToolNames?` | `boolean` | Anthropic uyumlu ağ geçitleri için yerleşik araç adlarından kaçış yapın ve döndürülen çağrılarda bunları geri yükleyin. |
| `anthropicEofTolerance?` | `boolean` | Yalnızca görünür metin veya eksiksiz bir JSON nesnesi araç girdisi alındığında, Anthropic uyumlu bir ağ geçidinin `message_stop` öncesinde biten bir akışı tamamlamasına izin verin. Varsayılan olarak kapalıdır. |
| `googleMode?` | `"ai-studio" \| "vertex" \| "cloud-code-assist"` | Google aktarım/kimlik doğrulama modu. Varsayılan `ai-studio`. |
| `project?` | `string` | Vertex veya Antigravity Cloud Code Assist proje kimliği. |
| `location?` | `string` | Vertex konumu; ortam geri dönüşü `GOOGLE_CLOUD_LOCATION`'dır. |
| `mcpServers?` | `Record<string, CursorMcpServerConfig>` | Yalnızca Cursor: stdio veya Akışlanabilir HTTP MCP sunucuları. |
| `desktopExecutor?` | `DesktopExecutorConfig` | Yalnızca Cursor: harici bilgisayar kullanımı ve ekran kaydetme komutları. |
| `unsafeAllowNativeLocalExec?` | `boolean` | Cursor eski boolean değeri, yalnızca daha yeni alan ayarlanmadığında `nativeLocalExec: "on"` değerine eşdeğerdir. |
| `nativeLocalExec?` | `"off" \| "codex-sandbox" \| "on"` | Cursor yerel yürütme politikası. `off` varsayılandır; `codex-sandbox` şu anda `off` gibi kapalı olarak başarısız olur. |

API anahtarı sağlayıcıları değişmez bir anahtar veya bir ortam referansı
tutabilir. OAuth sağlayıcıları `ocx login` tarafından doldurulan kimlik bilgisi
deposunu kullanır; abonelik destekli Claude Code başlatma davranışı
[`claudeCode.authMode`](/tr/reference/configuration/server/#claude-code) altında
yapılandırılır.

## Sağlayıcı teşhis giden güvenliği

Kontrol paneli bağlantı testleri ve canlı model keşfi sınırlı bir yalnızca GET
aktarımı kullanır. Giden bir proxy olmadan opencodex ana bilgisayar adını bir
kez çözer ve yalnızca bu doğrulanmış adrese bağlanır. HTTPS orijinal Host, SNI
ve sertifika doğrulamasını korur; sağlayıcı yapılandırması sertifika
denetimlerini devre dışı bırakamaz.

`HTTP_PROXY`, `HTTPS_PROXY` veya `ALL_PROXY` geçerli olduğunda bu işlemler
Bun'ın yerel getirmesini korur. URL ve değişmez adres denetimleri hala çalışır,
ancak proxy son rotayı, DNS yanıtını ve eşi seçer, bu nedenle opencodex bu eşi
sabitleyemez veya doğrulayamaz. Bu açık bir güvenlik sınırlamasıdır.

Özel/yerel hedefler `allowPrivateNetwork: true` ve giden bir proxy etkin
olduğunda eşleşen bir `NO_PROXY` girdisi gerektirir. Geri döngü otomatik olarak
eklenir; her LAN ana bilgisayarını açıkça listeleyin çünkü CIDR girdileri
yorumlanmaz. Eşleştirici tam ana bilgisayarları, etki alanı soneklerini, isteğe
bağlı bağlantı noktalarını, köşeli ayraçlı IPv6'yı ve `*` işaretini destekler;
örneğin `192.168.1.50`'yi açıkça listeleyin. Meta veriler ve bağlantı yerel
hedefleri engellenmiş olarak kalır. Teşhis istekleri yönlendirmeleri reddeder ve
kimlik bilgisi kaldırılmış bir hedef bildirir. Sıradan sağlayıcı isteği yeniden
yönlendirme incelemesi bu teşhis korumasından ayrı kalır.

## Codex hesap havuzu

Havuz hesapları eklemek ve kotaları yenilemek için kontrol panelinde **Codex
Auth** kullanın. `config.json` gizli olmayan meta verileri saklar; erişim ve
yenileme belirteçleri güçlendirilmiş kimlik bilgisi deposunu kullanır. Havuz
yönlendirmesi yeni/bağımsız atamayı, kullanıma dayalı proaktif geçişi ve arıza
kurtarmayı ayırır. Bağlı bir görev normalde bağlılığı korur, ancak `quota`,
kullanım eşiği aşıldıktan sonraki bir sonraki isteğinde onu yeniden
bağlayabilir; duraklatma, soğuma, yeniden kimlik doğrulama ve arıza işleme ise
yönlendirmeyi bağımsız olarak temizleyebilir veya taşıyabilir. Bağımsız bir
isteğin canlı hesap bağlaması yoktur; bu, proxy yeniden başlatmasından veya
bağlılık sıfırlamasından sonra mevcut görünür bir görevi içerebilir. Akış öncesi
bir 429 veya 402, kullanıma dayalı proaktif geçiş kapalı olsa bile aynı istekte
uygun alternatif bir hesapta bir kez yeniden dener. Hesap değişiklikleri görüşme
bağlamını korur ve yeniden oynatır, ancak hesaplar arasında sağlayıcı tarafı
istem önbelleği yeniden kullanımı garanti edilmez ve önbelleğin tekrar ısınması
gerekebilir.

Bir **401/403** durumunda App girişi bu hesabın işleme özel bağlılığını temizler
ve yeniden kimlik doğrulama gerektirir. Bir **429** durumunda opencodex
`Retry-After`'ı dikkate alır, hesap soğuma süresini başlatır, bağlılığı temizler
ve isteği başka bir uygun Havuz hesabına döndürebilir. Bu arıza geçişleri
`autoSwitchThreshold: 0` ile etkin kalır; bu ayar yalnızca kullanıma dayalı
proaktif geçişi devre dışı bırakır.

Bir hesabı duraklatmak kota meta verilerini korur ancak onu geçişten, yük
devretmeden, kurtarma problarından ve manuel etkinleştirmeden hariç tutar.
Ayrıca o hesabın iş parçacığı bağlılıklarını da temizler. Devam eden istekler
yakalanan kimlik bilgilerini korur; daha sonraki turlar yeniden yönlendirilir.
Her hesap duraklatılırsa, Havuz yönlendirmesi sessizce birini seçmek yerine
başarısız olur. **Tükenenleri duraklat (Pause exhausted)**, kullanılabilir
kimlik bilgilerine sahip uygun hesapları yeniler ve yalnızca %100 olduğu yeni
onaylanan hesapları duraklatır; bilinmeyen veya başarısız yenilemeler değişmeden
kalır.

| Strateji | Davranış |
| --- | --- |
| `quota` (varsayılan) | Aktif bir hesap yoksa 5 saatlik, haftalık ve 30 günlük pencerelerde en düşük kullanımlı uygun hesabı seçin. Aksi takdirde `autoSwitchThreshold` altında uygun bir aktif hesabı tutun; eşiği aştıktan sonra bağımsız bir istek veya bağlı bir görevin bir sonraki isteği daha düşük kullanımlı uygun bir hesaba geçebilir. `0`, bu kullanım odaklı yeniden değerlendirmeyi devre dışı bırakır, arıza kurtarmayı devre dışı bırakmaz. |
| `round-robin` | Bağımsız istekleri uygun hesaplar arasında eşit olarak atayın. `autoSwitchThreshold` normal round-robin seçimini değiştirmez. `accountPoolStickyLimit` (1–100), başarılı yukarı akış yanıtlarını değil, bir seçimdeki atamaları sayar. |
| `fill-first` | Bağımsız istekleri soğuma, yeniden kimlik doğrulama veya yapılandırılmış tükenme eşiğine kadar aktif hesaba atayın; bilinmeyen kullanım geçişe zorlamaz. Sağlıklı bağlı görevler bağlılığı korur. |

Rotasyon, sağlayıcı yaptırımlarına karşı koruma sağlamaz; çoklu hesap kullanımı
sağlayıcı şartlarını ihlal edebilir.

### `anthropicAccountPool` (deneysel)

Bu isteğe bağlı özellik, `auth.json` içinde zaten saklanan birden fazla
Anthropic OAuth hesabını havuzlar. Varsayılan olarak kapalıdır ve sahada
kapsamlı olarak test edilmemiştir. Aynı kuruluştaki hesaplar kotayı paylaşabilir
ve otomatik rotasyon sağlayıcı kısıtlamalarını tetikleyebilir.

| Anahtar | Tip | Varsayılan | Açıklama |
| --- | --- | --- | --- |
| `anthropicAccountPool.enabled?` | `boolean` | `false` | Yapışkan bağlılığı ve 429 soğuma yük devretmesini etkinleştirin. |
| `anthropicAccountPool.autoSwitchThreshold?` | `number` | `80` | Yeni oturumlar için bu eşikte veya üzerinde bilinen en düşük önbelleğe alınmış 5 saatlik kullanımı seçin. `0` kota seçimini devre dışı bırakır. |
| `anthropicAccountPool.strategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | Yeni oturum stratejisi; kota yalnızca 5 saatlik çubukları kullanır. |
| `anthropicAccountPool.stickyLimit?` | `number` | `1` | Bir round-robin seçiminde tutulan başarılı yeni oturum bağlamaları. Aralık 1–100. |

Etkinleştirildiğinde 429, `Retry-After`'dan veya varsayılan bir geri çekilmeden
sınırlı soğuma kaydeder ve istek içinde dönebilir. Bağlılık işleme özeldir ve
boyut sınırlıdır. Kimlik bilgisi 401/403, hesabı yeniden kimlik doğrulama
gerektiriyor olarak işaretler. Uygun tüm hesaplar soğuyorsa istemciler bir
kimlik doğrulama hatası değil, bilindiğinde `Retry-After` ile 429 alır.

:::caution[Deneysel]
Anthropic hesap politikası riskini anlamadığınız sürece bunu devre dışı bırakın.
Emin olmadığınızda manuel `ocx account use anthropic <id>` geçişini tercih edin.
:::

### Yönetilen kayıt biçimleri

`apiKeys[]` girdileri `id`, `name`, oluşturulan `key` ve ISO `createdAt`
dizelerini içerir. `codexAccounts[]` girdileri isteğe bağlı `plan`,
`chatgptAccountId` ve gizlilik açısından güvenli `logLabel` ile birlikte `id`,
`email` ve `isMain` gerektirir. Bu kayıtlar normalde kontrol paneli tarafından
yönetilir.

### `tokenGuardian` (`OcxTokenGuardianConfig`)

| Alan | Tip | Varsayılan | Anlamı |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | Genel proaktif yenileme anahtarı. |
| `tickSeconds?` | `number` | `21600` | Tarama aralığı (6 saat, minimum 60 saniye). |
| `jitterSeconds?` | `number` | `300` | Bir taramadan önceki rastgele gecikme. |
| `concurrency?` | `number` | `3` | Maksimum eşzamanlı yenileme. |
| `leadSeconds?` | `number` | `900` | Bir tıkın ötesinde ekstra yenileme ön süresi. |
| `failureBackoffBaseSeconds?` | `number` | `300` | İlk geçici arıza geri çekilmesi. |
| `failureBackoffMaxSeconds?` | `number` | `3600` | Geri çekilme tavanı ve kalıcı arıza gecikmesi. |
| `codexWarmupEnabled?` | `boolean` | `false` | Sentetik Codex havuz hesabı doğrulamasına dahil olun. |
| `codexWarmupMaxAgeSeconds?` | `number` | `691200` | 8 gün sonra bir hesabı yeniden doğrulayın. |
| `codexWarmupModel?` | `string` | `gpt-5.4-mini` | İsteğe bağlı ısınma için kullanılan yerel model. |

## Sabit sağlayıcı uç noktaları

Yönlendirme, adaptörden önce bir sağlayıcı uç noktasını çözer. Çoğu yerleşik
için kayıt defteri uç noktası yapılandırılmış `baseUrl`'i yener. Dört girdi türü
yapılandırılmış URL'yi korur:

- geçersiz kılma etkin sağlayıcılar: `ollama`, `vllm`, `lm-studio`, `litellm`,
  `qwen-cloud` ve `alibaba-token-plan-intl`;
- `azure-openai` ve `cloudflare-ai-gateway` gibi kullanıcı tarafından doldurulan
  kayıt defteri şablonları;
- aynı adlı daha eski bir özel hedefi koruyan yükseltilmiş sabit API anahtarı
  önayarları; ve
- kayıt defterinde bulunmayan sağlayıcılar.

Adaptörler çözümlenen URL'yi daha sonra ayarlayabilir. Örneğin Kiro, kurallı
`runtime.{region}.kiro.dev` için içe aktarılan kimlik bilgisinin API bölgesini
takip eder. Bkz. [Adaptörler](/tr/reference/adapters/).

Yönlendirme `baseUrl`'i attığında opencodex kayıt defteri uç noktasını ve
yalnızca yapılandırılmış kaynağı günlüğe kaydeder; yapılandırılmış bir yolun
kendisi bir kimlik bilgisi içerebilir. Kullanılmayan URL'yi kaldırın veya
hedeflenen bölgeyle eşleşen sağlayıcı girdisini seçin. `alibaba-token-plan`
Pekin'e sabitlenirken, `alibaba-token-plan-intl` uluslararası uç noktaları
kapsar.

Bozuk bir `openai-responses` ağ geçidi için onarım sağlayıcı nesnesine aittir:

```json
{
  "providers": {
    "custom-gateway": {
      "adapter": "openai-responses",
      "baseUrl": "https://gateway.example/v1",
      "apiKey": "${GATEWAY_KEY}",
      "responsesItemIdRepair": {
        "reasoning": ["rs_0"],
        "message": ["msg_0"],
        "repairMissingTerminalIds": true
      }
    }
  }
}
```

Yer tutucu listeleri tam eşleşmelerdir. Normal/durum bilgili Responses
sağlayıcıları için alanı ayarlanmamış bırakın, böylece doğrudan geçiş bayt bayt
aynı kalır.

## Cursor sağlayıcısı (`adapter: "cursor"`)

Cursor köprüsü deneyseldir. `ocx login cursor` komutundan sonra
`providers.cursor`'ı ekleyin veya düzenleyin. Cursor Router'ın optimizasyon
merdiveni ayrı Codex kimlikleri olarak sunulur çünkü seçici Cursor'a özgü model
parametrelerini işleyemez:

| Codex modeli | Cursor Router modu |
| --- | --- |
| `cursor/auto` | Takım/hesap varsayılanı |
| `cursor/auto-cost` | Maliyet |
| `cursor/auto-balance` | Denge |
| `cursor/auto-intelligence` | Zeka |

Açık varyantlar, Cursor'ın `default` modelini `optimization` parametresiyle
göndererek her istekte seçimi korur. Canlı keşif `default`'u atladığında
kullanılabilir kalırlar.

Cursor sunucu güdümlü yerel araçlar varsayılan olarak devre dışıdır. Codex kendi
onayı ve sanal alan politikasıyla `apply_patch` ve `exec_command` gibi kendi
araçlarını kullanmaya devam eder:

- `"off"` (varsayılan), Cursor yerel `read`, `write`, `delete`, `ls`, `grep`,
  `shell` ve `fetch` yürütmesini reddeder.
- `"on"`, güvenilen yerel yürütmeyi seçer ve Codex onay/sanal alan anlambilimini
  atlar.
- `"codex-sandbox"` uyumluluk için tutulur ancak `"off"` gibi kapalı olarak
  başarısız olur; istek düzyazısı güvenilir sanal alan kanıtı değildir.

```json
{
  "providers": {
    "cursor": {
      "adapter": "cursor",
      "baseUrl": "https://api2.cursor.sh",
      "authMode": "oauth",
      "defaultModel": "auto",
      "nativeLocalExec": "off"
    }
  }
}
```

Alanı üst düzeyde değil `providers.cursor` üzerinde ayarlayın. Kontrol panelinde
**Sağlayıcılar → Cursor → JSON Düzenle**'yi kullanın, kaydedin ve yeniden
başlatın. Eski `unsafeAllowNativeLocalExec: true`, yalnızca `nativeLocalExec`
ayarlanmadığında `nativeLocalExec: "on"` değerine eşittir. MCP, ekran kaydı ve
bilgisayar kullanımı `mcpServers` ve `desktopExecutor` tarafından ayrı ayrı
denetlenir.

Her `mcpServers.<ad>`, `command` (stdio) veya `url` (Akışlanabilir HTTP) kabul
eder. Stdio ayrıca `args`, `env` ve `cwd` kabul eder; HTTP `headers` kabul eder.
Her ikisi de `enabled` (varsayılan true) ve `toolPrefix` destekler.
`desktopExecutor`, `computerUseCommand`, `recordScreenCommand`, `cwd`, `env` ve
`timeoutMs` (varsayılan `30000`) kabul eder. Komutlar `sh -c` aracılığıyla
çalışır, stdin'den bir JSON isteği okur ve stdout'a bir JSON sonucu yazmalıdır.

:::caution[Güvenlik]
Varsayılan geri döngü bağlantısı, çok kullanıcılı bir ana bilgisayardaki diğer
kullanıcılar da dahil olmak üzere herhangi bir yerel süreci kimlik doğrulama
olmadan kabul eder. Tüm veri düzlemi arayanlarına güvenilmedikçe ve Codex onay
ve sanal alan anlambilimini kasıtlı olarak atlamayı kabul etmedikçe yerel
yürütmeyi kapalı bırakın.
:::

## OpenRouter sağlayıcı yönlendirmesi

OpenRouter bir modeli birkaç çıkarım sağlayıcısı aracılığıyla sunabilir.
`openRouterRouting` istekleri tercih edilen sağlayıcılarda tutar;
`modelOpenRouterRouting` tam model kimlikleri için onun yerini alır. Bu, istem
önbelleği bağlılığı için yararlıdır çünkü önbellek desteği, saklama, isabet
oranları ve fiyatlandırma çıkarım sağlayıcısına göre değişir.

Sağlayıcı adları OpenRouter slug'larıdır. `allowFallbacks: false` kapalı olarak
başarısız olur; `true`, sıralı listeden sonra başka bir uygun sağlayıcıya izin
verir. `only` her zaman bir izin listesidir.

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "openRouterRouting": {
        "order": ["deepseek"],
        "allowFallbacks": false
      },
      "modelOpenRouterRouting": {
        "anthropic/claude-sonnet-5": {
          "only": ["anthropic"],
          "allowFallbacks": false
        }
      }
    }
  }
}
```

Model anahtarları, dış opencodex sağlayıcı öneki olmadan tam yerel OpenRouter
kimlikleridir. `openrouter/anthropic-claude-sonnet-5` seçimi model kuralını
uygulamadan önce yerel `anthropic/claude-sonnet-5`'i geri yükler.

## Statik model izin listeleri

Yalnızca `models`'ı göstermek için `liveModels: false` ayarlayın. `models` boşsa
veya atlanırsa sağlayıcı yönlendirilen hiçbir modeli göstermez. Canlı keşif,
önbelleğe almadan önce 4 MiB'den veya 2.000 ham model satırından fazlasını
reddeder; yerleşik önayarlar daha düşük sınırlar kullanabilir ve sohbete uygun
satırlara filtre uygulayabilir. Büyük boyutlu veya hatalı biçimlendirilmiş
sonuçlar eski/yapılandırılmış geri dönüşü takip eder. Geçerli bir sıfır uygun
sonuç yetkili kalır ve sessizce değiştirilmez veya kesilmez.

Keşfin hala çalışması gerektiğinde ancak Codex ve `/v1/models` içinde yalnızca
seçilen kimliklerin görünmesi gerektiğinde `selectedModels` kullanın. Kontrol
paneli daha sonraki izin listesi değişiklikleri için keşfedilen tam listeyi
korur.

Önizleme GPT-5.6 geri dönüş girdileri aynı mekanizmayı kullanır. OpenAI API
anahtarı önayarı temel ve Pro kimliklerini `922000` bağlam ve `922000` maksimum
girdi ile tohumlar; OpenRouter `openai/gpt-5.6-sol`, `openai/gpt-5.6-terra` ve
`openai/gpt-5.6-luna`'yı `922000` bağlam ile tohumlar. Pool/Direct `922000`
bildirir; senkronize edilen katalog `xhigh`'ı ayrı tutarken `max` bildirir.

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "liveModels": false,
      "models": ["deepseek/deepseek-v4-flash", "qwen/qwen3-coder-plus"]
    }
  }
}
```

## Tam örnek

```json
{
  "port": 10100,
  "defaultProvider": "openai",
  "providers": {
    "openai": {
      "adapter": "openai-responses",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "authMode": "forward"
    },
    "anthropic": {
      "adapter": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "authMode": "oauth",
      "defaultModel": "claude-sonnet-4-6"
    },
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "${OLLAMA_API_KEY}",
      "defaultModel": "glm-5.2",
      "noVisionModels": ["glm-5.2", "gpt-oss", "qwen3-coder", "deepseek-v4-pro"]
    }
  },
  "subagentModels": ["anthropic/claude-opus-5", "ollama-cloud/glm-5.2"],
  "disabledModels": [],
  "websockets": false,
  "webSearchSidecar": {
    "maxSearchesPerTurn": 3,
    "routedModelStallTimeoutMs": 200000,
    "timeoutMs": 60000
  },
  "visionSidecar": { "enabled": true }
}
```

