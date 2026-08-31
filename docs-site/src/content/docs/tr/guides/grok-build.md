---
title: Grok Build
description: xAI Grok Build CLI içerisinden opencodex ile yönlendirilen herhangi bir modeli kullanın — proxy çalışırken modeller ~/.grok/config.toml içine otomatik olarak kaydedilir.
---

opencodex, yerel portunda OpenAI uyumlu bir `POST /v1/chat/completions` (ve
`/v1/responses`) sunar ve Grok Build, OpenAI uyumlu sunuculara karşı özel
modelleri destekler. Bu entegrasyonla başlayarak opencodex, görünür kataloğunun
tamamını otomatik olarak Grok Build'e kaydeder — manuel yapılandırma düzenlemesi
gerekmez.

## Otomatik Kayıt (Auto-registration)

`~/.grok` dizini mevcut olduğunda `ocx start` (ve `ocx ensure` / `ocx restart`),
`~/.grok/config.toml` dosyasına yönetilen bir blok yazar:

```toml
# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"
extra_headers = { "x-opencodex-grok" = "1" }

[model.ocx-gpt-5-6-sol]
model = "gpt-5.6-sol"
model_provider = "opencodex"
name = "OCX gpt-5.6-sol"
context_window = 272000
supports_reasoning_effort = true
reasoning_effort = "low"

[[model.ocx-gpt-5-6-sol.reasoning_efforts]]
id = "low"
value = "low"
label = "Low"
description = "Quick, fast implementations"
default = true
# ... remaining rungs for this model, then one [model.ocx-*] table per visible model,
# each referencing model_provider = "opencodex" ...
# <<< opencodex managed block <<<
```

- **Eklemelidir (Additive):** çitin dışındaki kendi yapılandırmanıza asla
  dokunulmaz. Önceden var olan bir dosyaya ilk enjeksiyondan önce
  `~/.grok/config.toml.bak-opencodex` konumuna tek seferlik bir yedek yazılır.
- **Eşkuvvetlidir (Idempotent):** her `ocx start` (ve otomatik başlatma
  etkinleştirildiğinde `ocx ensure`), çitle çevrili bloğu geçerli katalogla
  değiştirir.
- **Kaldırıldığında temizlenir:** `ocx stop`, `ocx eject`, `ocx uninstall` ve
  zarif servis dışı arka plan programı kapatması, çitle çevrili bloğu kaldırır
  ve dosyanızı bayt bayt geri yükler. Bir servis yöneticisi altında kaldırma
  `ocx stop`/`ocx uninstall` üzerinden gerçekleşir (servis modu süreçleri
  kasıtlı olarak yeniden başlatmalar boyunca bloğu korur).
- **Çakışma güvenlidir:** kendi `[model.*]` tablolarınız tarafından zaten
  tanımlanmış takma adlara saygı duyulur (opencodex kendi girdilerine sonek
  ekler); hasarlı bir çit (bitiş işareti olmayan başlangıç işareti) herhangi bir
  otomatik değişikliği reddeder ve manuel onarım ister.

Ardından Grok Build içinde bir model seçin:

```bash
grok models          # yerel grok modellerinin yanında ocx-* girdilerini listeler
grok -m ocx-anthropic-claude-opus-4-8 -p "hello"
# veya TUI içinde: /model ocx-anthropic-claude-opus-4-8
```

## Akıl yürütme çabası (Reasoning effort)

Grok Build'in `/effort` (ve `--effort`) ayarı yalnızca katalog girdisi merdiveni
bildiren modeller için çalışır: model listesi getirme işlemi ham `GET
/v1/models` yanıtını okur ve buradaki girdiler `supports_reasoning_effort` artı
`reasoning_efforts` menü seçeneklerini taşımalıdır. Merdivenin Grok ile uyumlu
bir izdüşümü, yönetilen her `[model.*]` tablosuna `supports_reasoning_effort`, varsayılan
`reasoning_effort` ve `[[model.<alias>.reasoning_efforts]]` seçim satırlarıyla
yazılır. Yönlendirilen model girdileri için opencodex, yapılandırılmış sağlayıcı
katmanlarını (`reasoningEfforts` / `modelReasoningEfforts` ve
`modelDefaultReasoningEfforts` varsayılanı) yansıtır. Bu meta veriler proxy
tarafından yapılandırılmış merdiveni açıklar; adaptörler akıl yürütmeyi taklit
edebilir veya seviyeleri sağlayıcıya özgü alanlarla eşleyebilir. Boş bir katman
listesine sahip modeller çaba denetimi göstermez. Yerel GPT-5.6 girdileri,
sabitlenmiş yukarı akış akıl yürütme merdivenlerini korur. Modelin bildirdiği
geçerli Grok katmanları, `none` ve `minimal` dahil olmak üzere korunur. Codex'e özgü
`ultra` dahil desteklenmeyen veya yinelenen katmanlar dosyadan çıkarılır; yazılan her
seçenek seçilebilir durumda kalır.

Grok Build, opencodex ile Responses API üzerinden konuşur. Bir rota akıl yürütme
merdivenini bildirdiğinde, Responses passthrough `reasoning.summary` değerini
yapılandırıldığı şekilde iletir; böylece akıl yürütme izleri Responses reasoning
öğeleri olarak Grok'a doğrudan ulaşır. Modelin akıl yürütmesini sürdürüp izi
gizlemek isteyen bir istemci `reasoning.summary: "none"` ayarlayabilir.
Açıkça belirtilen `reasoning.summary`, rotanın varsayılan değerine üstünlük tanır.

## Kimlik doğrulama notu

Grok Build, geri döngüde (loopback) bile özel modeller için boş olmayan bir API
anahtarı gerektirir. Enjekte edilen girdiler bir yer tutucu
(`opencodex-loopback`) taşır — opencodex geri döngü bağlantıları için kabul
anahtarlarını yok sayar, bu nedenle gerçek bir sır söz konusu değildir.

**Otomatik kayıt yalnızca geri döngü içindir.** opencodex geri döngü olmayan bir
ana bilgisayarı bağladığında — her arabirimi açığa çıkaran `0.0.0.0` ve `::`
joker karakterleri dahil — istekler gerçek kabul belirtecinize ihtiyaç duyar ve
yönetilen bir blok bunu güvenli bir şekilde taşıyamaz. Değişmezi yazmak
sırrınızı `~/.grok/config.toml` dosyasına koyar ve bir sonraki `ocx
start`/`ensure`/`restart` sırasında orada ayarladığınız her şeyin üzerine yazar.
Bu nedenle opencodex bu durumda hiçbir şey yazmaz (ve daha önceki bir geri döngü
bağlantısından kalan tüm blokları kaldırır) ve modelleri yönetilen işaretçilerin
dışında kendiniz yapılandırırsınız, burada opencodex'in yaptığı hiçbir şey
onları ezemez. Tam tablo için [Manuel
tarif](#otomatik-kayit-olmadan-manuel-tarif) bölümüne bakın ve hem `base_url`
(gerçekte `grok` çalıştırdığınız yerden erişilebilen bir ana bilgisayar) hem de
`api_key` (`OPENCODEX_API_AUTH_TOKEN` değeriniz) ayarlayın.

Burada `api_key`'i `env_key` ile değiştirmeyin. Çözümlenemeyen bir
`env_key` isteği durdurmaz — Grok, xAI
oturum belirtecinize geri döner ve bunu girdinin adlandırdığı `base_url`'e
gönderir; bu da bir LAN dağıtımı için xAI olmayan düz metin bir HTTP uç
noktasıdır.

Provider girdisine enjekte edilen `api_key`, bu modeller için Grok'un kimlik bilgisi
zincirinde ilk sırada yer alır; bu nedenle opencodex'e karşı yapılan dönüşler ek
bir Grok girişi gerektirmez. Yerel grok modelleri ve doğrudan xAI ile iletişim
kuran herhangi bir donanım özelliği için normal `grok login` / `XAI_API_KEY`
kurulumunuzu koruyun.

## Otomatik kayıt olmadan manuel tarif

`~/.grok/config.toml` dosyasını kendiniz yönetiyorsanız — veya opencodex geri
döngü olmayan bir bağlantıdaysa — `# >>> opencodex managed block`
işaretçilerinin dışına bir `[model_providers.opencodex]` bloğu ve bunu
referans alan model başına tablolar ekleyin:

```toml
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

Ağ üzerinden erişilebilen bir proxy için `base_url`'i `grok`'un gerçekten
bağlanabileceği adrese yönlendirin ve kabul belirtecinizi kullanın:

```toml
[model_providers.opencodex]
base_url = "http://192.168.1.10:10100/v1"   # 127.0.0.1 değil, erişilebilir ana bilgisayar
api_backend = "responses"
api_key = "OPENCODEX_API_AUTH_TOKEN_DEGERINIZ"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

Yönetilen blok artık `[model_providers.<id>]` kalıtımını kullanıyor, bu da Grok Build 0.2.109 veya sonrasını gerektirir (2026-07-21'de yayınlandı). Eski sürümlerde devralınan `base_url` çıkarım yönlendirmesine uygulanmaz — yükseltin veya her `[model.*]` tablosunda model başına doğrudan alanlar (`base_url`/`api_backend`/`api_key`) kullanın.

Nokta içeren herhangi bir takma adı tırnak içine alın: yalın `[model.grok-4.5]`,
`grok-4.5` kimliği değil, üç segmentli bir anahtar yoludur. Oluşturulan takma
adlar bu nedenle noktalardan tamamen kaçınır.

## Bilinen sınırlamalar

- **Servis kurulu `ocx restart`:** çalışan proxy yeniden başlatma
  yetkilendirmesine ve tahliye koordinasyonuna sahiptir, kurulu servis
  yöneticisi ise eski süreç çıktıktan sonra yenisini başlatır. Servis denetimi
  kurulu kalır. Geri döngü otomatik kaydında, yönetilen blok devir teslim
  boyunca yerinde kalır; geri döngü olmayan dağıtımlar bunun yerine manuel
  olarak yönetilen Grok yapılandırmasını kullanır. Komut yalnızca aynı port
  üzerinde farklı, kimliği doğrulanmış bir süreç sağlıklı olduğunda başarılı
  olur.
- **Yapılandırma okuma zamanlaması:** en öngörülebilir sonuçlar için önce
  opencodex'i başlatın, ardından `grok`'u başlatın. Grok Build
  `~/.grok/config.toml` dosyasını izler ve `[model]` tablosu gerçekten
  değiştiğinde (içeriğe göre karşılaştırılan yaklaşık bir saniyelik bir gecikme)
  yeniden yükler, böylece yenilenen bir blok yeniden başlatma olmadan açık bir
  oturuma ulaşır. Grok'un neyi ayrıştırdığını doğrulamak için `grok inspect`
  komutunu çalıştırın: yüklediği yapılandırma kaynaklarını listeler ve
  reddettiği herhangi bir alan hakkında uyarır. Çözümlenen model listesini
  yazdırmaz. Güncel Grok Build, geçersiz model alanlarını uyarıyla atlar ve model
  girdisinin kalanını korur. Bir TOML sözdizimi hatası dosyanın yüklenmesini
  engeller. opencodex dosyayı atomik olarak yazar; Grok her yeniden yüklemede
  eksiksiz bir belge görür.
- **Katalog güncellemeleri:** çitle çevrili blok, enjeksiyon anındaki kataloğu
  yansıtır. Sağlayıcılar veya modeller ekledikten sonra yenilemek için `ocx
  ensure` çalıştırın (veya proxy'yi yeniden başlatın).
