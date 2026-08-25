---
title: Katkıda Bulunma
description: opencodex geliştirme — kurulum, düzen, kurallar ve yeni bir sağlayıcı veya adaptör ekleme.
---

## Kurulum

Kaynak kod üzerinde geliştirme yapmak için `PATH` ortam değişkeninizde `bun` CLI
aracının bulunması gerekir. Yayınlanan npm paketi kullanıcılar için kendi Bun
çalışma zamanını paketler, ancak bu depodaki betikler yerel Bun kurulumunuz
üzerinden çalışır.

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy    # geliştirme modunda proxy API
bun run dev:gui      # kontrol paneli geliştirme sunucusu (başka bir terminalde)
bun run typecheck    # bun x tsc --noEmit
bun run test:changed              # routine import-graph test selection
bun test tests/router.test.ts     # routine focused test
bun run test                      # complete suite (PR-ready / explicit ask)
```

`bun run dev`, `bun run dev:proxy` komutunun bir takma adıdır. Kontrol paneli
geliştirme sunucusu `bun run dev:gui` ile çalışır; `GET /` adresindeki
paketlenmiş kontrol paneli ise `bun run build:gui` (`gui/dist`) tarafından
üretilir.

## Derleme ve test komutları

Kök paket Bun-yerel TypeScript kullanır; ayrı bir sunucu derleme adımı yoktur.
Yerel komutların CI ile eşleşmesi için depodaki betikleri kullanın:

```bash
bun run typecheck                 # katı TypeScript denetimi
bun run test                      # tests/ paketinin tamamı
bun test tests/router.test.ts     # odaklanmış test dosyası
bun run build:gui                 # Vite GUI derlemesi + paket hazırlığı
bun run privacy:scan              # CI tarafından kullanılan kimlik/gizlilik taraması
bun run prepare:package           # paket başlatıcılarını ve varlıklarını yenileme
```

Testlerin çoğu düz `tests/*.test.ts` Bun testleridir. `tests/helpers/`
paylaşılan test ortamlarını (fixtures) ve `tests/e2e-style/` daha geniş yerel
parite senaryolarını içerir. Değiştirdiğiniz alt sistemin mevcut testlerinin
yakınında odaklanmış bir regresyon testi bulundurun; paylaşılan yönlendirme,
adaptörler, yapılandırma veya sunucu davranışları için test paketinin tamamını
çalıştırın.

Okumakta olduğunuz dokümantasyon sitesi `docs-site/` (Astro + Starlight)
dizinindedir:

```bash
cd docs-site && bun install && bun dev
```

## Dokümantasyon yayınlama

Genel dokümantasyon GitHub Pages üzerinde <https://opencodex.me/> adresinde
yayınlanır. `.github/workflows/deploy-docs.yml` iş akışı, `docs-site/**`
dizinini veya iş akışının kendisini etkileyen `main` dalı gönderimlerinde
çalışır, `docs-site`'ı derler ve oluşturulan siteyi dağıtır. Dokümantasyon
değişikliklerini göndermeden önce çalıştırın:

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

## CI ve sürümler

GitHub Actions iş akışları kasıtlı olarak yalın tutulur:

- **Çapraz platform CI** (`.github/workflows/ci.yml`), çalışma zamanı, testler,
  paket, betik, TypeScript veya iş akışı dosyalarını etkileyen çekme
  isteklerinde ve `main` gönderimlerinde çalışır. Bun matrisi; Linux, Windows ve
  macOS üzerinde kurulum, tip denetimi, testler, gizlilik taraması, sürüm
  yardımcısı duman testi, GUI derlemesi ve `ocx help` adımlarını kapsar. İkinci
  bir üç işletim sistemli hat, paketin yerleşik çalışma zamanını kullanarak ayrı
  bir Bun kurulu olmadan npm global kurulumunun çalıştığını kanıtlar.
- **Sürüm** (`.github/workflows/release.yml`) manuel olarak yürütülür. İkinci
  bir tam CI hattı görevi görmez; deneme çalıştırması (dry-run) veya yayınlama
  öncesinde tam sürüm commit'inin (`GITHUB_SHA`) zaten başarılı bir Çapraz
  Platform CI çalıştırmasına sahip olmasını gerektirir.
- **Hareketsiz bilgi bekleyenler** (`.github/workflows/stale-needs-info.yml`)
  varsayılan dalda günlük olarak çalışır. 14 gün boyunca etkinlik olmayan
  `needs-info` etiketli açık sorunlar bir uyarı alır; 7 gün daha hareketsiz
  kalırlarsa planlanmadı olarak kapatılırlar. Herhangi bir güncelleme hareketsiz
  uyarısını temizler. Uzun vadeli çalışmaları açık tutmak için `needs-info`
  etiketini kaldırın (örneğin bir sorunu `roadmap` aşamasına taşırken).
- **Sorun kalitesi** (`.github/workflows/enforce-issue-quality.yml`), yeni ve
  düzenlenen sorunlarda şablon yapısını doğrular, tür etiketlerini (`bug`,
  `enhancement`, `provider-compatibility`, `documentation`) uygular ve form
  Alanı alanından artı hafif başlık/Özet sezgisel yöntemlerinden ortogonal
  **alan** etiketleri ekler: `provider`, `account-pool`, `catalog`, `gui`,
  `cli`, `proxy`, `platform`, `streaming`, `tools`, `install` ve `service`.
  Tür/süreç etiketleri ayrı kalır, böylece bu eksenleri daraltmadan `bug` +
  `account-pool` filtrelemesi yapabilirsiniz. Sağlayıcı başına yeni etiketler
  uydurmak yerine Alan açılır menüsünü tercih edin. Alan: Dokümantasyon ikinci
  bir alan etiketi eklemez (dokümantasyon formu zaten `documentation` etiketini
  tanımlar). Bakımcılar, iş akışı varsayılan dala geçtikten sonra
  workflow_dispatch `backfill_open_areas` ile tüm açık sorunlara alan
  etiketlerini yeniden uygulayabilir.

Sürümler için yardımcıyı kullanın:

```bash
bun run release <version>           # sürüm artışını commit/push eder; yayınlama iş akışı varsayılan olarak kuru çalıştırmadır (dry-run)
bun run release <version> --publish # CI onaylı kuru çalıştırma anlaşıldıktan sonra yayınlayın
bun run release:watch               # en yeni Sürüm iş akışı çalıştırmasını izleyin
```

## Dallar

- `dev` — tek entegrasyon hedefi. Çekme isteğinizi burada açın.
- `main` — yalnızca sürümler içindir. `dev` dalından bakımcı kontrollü yükseltme
  ile ilerler; doğrudan buna karşı özellik çekme istekleri açmayın.
- `preview` — ön sürüm treni.

Go yerel portunu taşıyan `dev2-go` hattı ve onunla birlikte çift hat taşıma
politikası kullanımdan kaldırılmıştır. Geçmişi
[lidge-jun/opencodex-go-archive](https://github.com/lidge-jun/opencodex-go-archive)
adresinde salt okunur olarak yayınlanmaktadır. `dev` dalındaki Bun-yerel
TypeScript tek çalışma zamanı hattıdır.

Rebase çekme istekleri memnuniyetle karşılanır. Eski bir dalı mevcut head
seviyesine getirmek gürültü değil, normal bir katkıdır — açıklamadaki kaynak
commit'leri belirtin.

## Çekme istekleri

- Hedef **`dev`** dalıdır. **`main`** dalına karşı özellik veya düzeltme çekme
  istekleri açmayın.
- **`main`** yerine geçerli **`dev`** ucundan dallanın. Gerekli
  **`enforce-target`** denetimi, çekme isteği tabanının çok gerisinde kalırken
  birleştirme tabanı **`main`** ucunda oturan head'leri reddeder (#644'te
  görülen hata modu).
- Gerçek bir açıklama yazın: Neyin neden değiştiğine dair bir **Özet** (Summary)
  ve bir **Test planı** (veya eşdeğer içerik). Boş gövdeler, yalnızca yer tutucu
  metinler ve gerçek satır sonları yerine kaçışlı `\n` kullanan açıklamalar
  denetimden geçemez.
- Başlık veya açıklama `gui`'den bahsediyorsa açıklamaya UI değişikliğinin bir
  ekran görüntüsünü ekleyin; `enforce-target` denetimi ekran görüntüsü mevcut
  olana kadar açıklama düzenlemelerinde yeniden çalışır.
- Bu depodaki iş akışı değişiklikleri **`pull_request_target`** kullanır.
  Güncellenmiş zorlama mantığı yalnızca iş akışı depo varsayılan dalına
  yükseltildikten sonra geçerli olur — #631'de belgelenen operasyonel uyarı.

## Proje bakımcıları

Mevcut bakımcılar, sorumlulukları ve inceleme ile birleştirme politikası
[`MAINTAINERS.md`](https://github.com/lidge-jun/opencodex/blob/main/MAINTAINERS.md)
dosyasında belgelenmiştir. Depo ve güvenliğe duyarlı yollar için GitHub inceleme
sahipliği `.github/CODEOWNERS` dosyasında bildirilmiştir.

## Kurallar

- **Yalnızca ES Modülleri** (`import`/`export`), TypeScript, `strict` modu. `bun
  x tsc --noEmit` çıktısını temiz tutun.
- **Dosya başına en fazla ~500 satır** — sorumluluğa göre bölün (`web-search/`
  ve `vision/` sidecar'ları tek bir `index.ts` arkasındaki küçük, odaklanmış
  modüllerin iyi örnekleridir).
- **Sınırlarda asenkron hataları yakalayın** — sidecar'lar istek yoluna asla
  hata fırlatmaz; zarif bir işaretleyiciye indirgenirler.
- **Yapı SOT** — geçerli bakımcı değişmezleri `structure/` dizininde yer alır.
  Herkese açık kullanıcı iş akışlarını `docs-site/` dizininde ve geçmiş inceleme
  notlarını `docs/` dizininde tutun.
- **Dışa aktarımları (exports) koruyun** — diğer modüller bunlara bağımlı
  olabilir.

## Kataloğa sağlayıcı ekleme

Tüm sağlayıcı seçicileri ve tohumları kurallı kayıt defterinden
(`src/providers/registry.ts`) türetilir:

```ts
{
  id: "my-provider",
  label: "My Provider",
  baseUrl: "https://api.example.com/v1",
  adapter: "openai-chat",
  authKind: "key",
  dashboardUrl: "https://example.com/keys",
  models: ["model-a", "model-b"],
  defaultModel: "model-a",
  noVisionModels: ["model-a"],   // salt metin modeller → vision sidecar görselleri açıklar
},
```

`src/providers/derive.ts` bu girdiyi `ocx init`, `ocx provider`, kontrol paneli
önayarları, API anahtarı girişi ve OAuth yapılandırma tohumlarına besler.
`enrichProviderFromCatalog()`, model meta verilerini ve yetenek
sınıflandırmalarını kaydedilen sağlayıcı yapılandırmasına kopyalar. OAuth
protokol uygulamaları halen `src/oauth/` içinde yer alır; tek başına kayıt
defteri meta verileri bir OAuth akışı değildir.

### Kurallı bir önayar için gereken kanıtlar

Bir kayıt defteri girdisi sürdürülen bir taahhüttür: opencodex, kullanıcının API
anahtarının gönderildiği hedefi sağlar. Bu nedenle bir önayar, çalışan bir kod
yolu değil, birincil kaynak kanıtı gerektirir. Bir sağlayıcı ekleyen veya
yükselten çekme istekleri açıklamada aşağıdakilerin tümünü sağlamalıdır:

- **Belgelenmiş OpenAI uyumlu uç noktalar.** Sohbet uç noktası için ve girdi
  `liveModels: true` olarak ayarlandığında kimliği doğrulanmış model keşif uç
  noktası (genellikle `GET /v1/models`) için sağlayıcının kendi API referansını
  bağlayın. Başarılı bir test ortamı (fixture) testi bunun yerini tutamaz:
  yukarı yönlü sözleşmeyi değil, bizim kod şeklimizi kanıtlar.
- **Hizmet şartları ve işleten tüzel kişilik.** Boş veya yer tutucu bir yasal
  sayfa, uç noktayı kimin çalıştırdığını veya kullanıcı trafiğinin hangi şartlar
  altında işlendiğini belirlemez.
- **Toplayıcılar için yeniden satış veya yönlendirme yetkilendirmesi.** Claude,
  GPT, Gemini veya diğer üçüncü taraf modellere erişim satan bir ağ geçidi,
  bunlara yönlendirme yetkisini göstermelidir. Kullanıcılar yerleşik bir önayarı
  doğrulanmamış bir satıcı olarak değil, bakımı yapılan bir rota olarak okur.
- **Belirtilmiş bir bakım sahibi.** Temel URL, kimlik doğrulama veya katalog
  sözleşmesi değiştiğinde önayarı kimin güncelleyeceğini ve bir kesintinin nasıl
  bildirileceğini belirtin.
- **Alıntılanabilir bir doğrulama tarihi.** `src/providers/free-directory.ts`
  içindeki `lastVerified` işleyişine benzer şekilde birincil kaynağı ve
  denetlendiği tarihi kaydedin. Doğrulanmamış bir satırdaki tarih, kimsenin
  üretmediği bir kaynağı iddia eder.

Kendi hizmetlerini ekleyen katkıda bulunanlar memnuniyetle karşılanır ve mevcut
önayarların birkaçı bu şekilde gelmiştir. İnceleyenlerin bunu tartabilmesi için
çekme isteği açıklamasında bağlılığı açıklayın; bağlılık bir ret nedeni değildir
ve kanıt çıtasını da düşürmez.

Kanıt eksik olduğunda dürüst yer, kurallı kayıt defteri yerine
`src/providers/free-directory.ts` içindeki bir referans satırıdır. Dizin
satırları açık bir `verification` derecesi (`official`, `primary`, `unverified`)
taşır ve etkisizdir: Kullanıcılar özel OpenAI uyumlu akış üzerinden hizmete yine
de ulaşabilirken, opencodex arkasında duramayacağı bir önayarın tanıtımını
yapmaktan kaçınır. Yukarıdaki kanıtlar oluştuktan sonra satırı kayıt defterine
yükseltin.

## Adaptör ekleme

`src/adapters/` dizininde `ProviderAdapter`'ı uygulayın
([Adaptörler](/tr/reference/adapters/) bölümüne bakın), adını
`src/server/adapter-resolve.ts` içine kaydedin ve çıktısını dahili
`AdapterEvent`'lere bağlayın. Görsel işleme için `image.ts`'yi yeniden kullanın
ve sıradan akış/araç çağrıları için `openai-chat.ts`'yi takip edin; yalnızca
adaptör aktarım yeniden denemelerine sahip olduğunda `fetchResponse`'u veya
Cursor gibi gerçekten çift yönlü bir aktarım için `runTurn`'u kullanın. `tests/`
altında odaklanmış testler ekleyin ve genel paket API'sine ait olduğunda
fabrikayı `src/index.ts` dosyasından dışa aktarın.

## Bittiğini iddia etmeden önce doğrulayın

Değişikliğinizi kanıtlayan en dar komutu çalıştırın — tipler için `bun run
typecheck`, davranış için odaklanmış bir `bun test tests/<ad>.test.ts` veya
çalışma zamanı probu, ardından etkilenen yüzeye uygun daha geniş kapılar.
opencodex büyük partiler yerine küçük, doğrulanabilir commit'leri tercih eder.


