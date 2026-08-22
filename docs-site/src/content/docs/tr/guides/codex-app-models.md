---
title: Codex App model seçicisi
description: opencodex modellerinin paylaşılan Codex kataloğu aracılığıyla Codex App, Codex CLI ve Codex TUI içinde nasıl göründüğü.
---

opencodex, Codex App'i yamalamaz. Codex CLI/TUI'nin kullandığı aynı Codex
yapılandırmasını ve model kataloğunu yazar. Uygulama sunucusu (app-server) bu
paylaşılan durumu okur, ancak bazı Codex Desktop sürümleri oluşturucuda
(renderer) ikinci bir uzak model izin listesi uygular ve yönlendirilen satırları
seçiciden kaldırabilir.

OpenAI girdileri iki kimlik bilgisi rotası kullanır: yerel Codex girişi ve ad
alanlı `openai-apikey/<model>` API anahtarı aktarımı. `codexAccountMode`'u Pool
ve Direct arasında değiştirmek tek başına seçici kimliklerini değiştirmez.
Bununla birlikte, hesap nitelikli seçici satırları `codexAccountPickerEnabled`
tarafından etkinleştirildiğinde ve `codexAccountNamespaces`, eşlenen hesapları
hala mevcut olan uygun seçicilere sahip olduğunda, opencodex eşlenen hesaplar
için ayrı `<seçici>/<yerel-openai-modeli>` satırları ekler ve yalın yerel
satırları Codex seçicisinden gizler. Seçici etiketleri, yerleşik bir hesap rolü
anlamı olmayan, kullanıcı tarafından seçilen genel adlardır. Nitelikli bir
satırı seçmek yalnızca eşlenen hesabını kullanır, aktif Havuz hesabını
değiştirmez ve hedef kullanılamadığında hesap değiştirmek yerine kapalı olarak
başarısız olur. Codex'in hesap kapsamlı kataloğu henüz opencodex'in statik
kümesinde olmayan görünür, API destekli bir OpenAI ailesi kimliği içeriyorsa,
tam kimlik uygun ana hesap seçicileri için seçici nitelikli bir satır olarak
korunur; ilgisiz bir hesaba kopyalanmaz ve yalın veya API anahtarı model
listesine eklenmez. Satır, gerçek bir katalog satırının sahip olduğu alan
şekliyle eşleştirilir, bu da hatalı biçimlendirilmiş girdileri filtreler —
önbellek kullanıcıya ait bir dosya olduğundan kimliğin bir yukarı akış
yanıtından geldiğini kanıtlamaz. Bkz. [Tam Codex hesap
seçicileri](/tr/reference/configuration/routing/#exact-codex-account-selectors).

`gpt-daybreak-blue-latest`, hesap nitelikli satırlar için bu yalnızca gözlem
kuralını takip eder ve yalın yerel izin listesine eklenmez. Ayrı, açık bir
`customModels` girdisi, kurallı Codex girişi iletme sağlayıcısı aracılığıyla
aynı hat kimliğini `openai/gpt-daybreak-blue-latest` olarak ortaya çıkarabilir:

```json
{
  "customModels": [
    {
      "id": "daybreak-codex-forward",
      "provider": "openai",
      "modelId": "gpt-daybreak-blue-latest"
    }
  ]
}
```

Yalnızca bu tam sağlayıcı, uç nokta ve model kimliği sabitlenmiş Sol yetenek
anlık görüntüsünü alır: 922.000 bağlam, 829.800 otomatik sıkıştırma, yerel akıl
yürütme merdiveni ve yerel Codex araç meta verileri. İstek yine de
`gpt-daybreak-blue-latest` gönderir; opencodex bunu Sol'a yeniden yazmaz, yalın
bir satır oluşturmaz ve hesap yetkisi vermez. Ayrı olarak faturalandırılan
`openai-apikey/daybreak-blue-latest` API satırı farklı bir rotadır ve 922.000
/ 922.000 sınırları asla Codex girişi satırına kopyalanmaz.

`codexAccountNamespaces` haritası boş olduğunda, hesap nitelikli seçici
satırları kapalıdır. `codexAccountPickerEnabled` boş olmayan bir haritayla
atlanırsa, geriye dönük uyumluluk için etkin olarak değerlendirilir. Eşlemeleri
silmeden veya tam `<seçici>/<yerel-openai-modeli>` yönlendirmesini devre dışı
bırakmadan oluşturulan nitelikli satırları gizlemek ve seçicideki yalın yerel
satırları geri yüklemek için `false` olarak ayarlayın.

API GPT-5.6 ve Daybreak girdileri 922.000 bağlam / 922.000 maksimum girdi
kullanır ve `*-pro` seçici kimlikleri, günlükler, kullanım ve seçici durumu
sanal kimliği korurken `reasoning.mode: "pro"` ile temel hat modeline
çözümlenir. API kataloğu tam olarak on kimliğe sabitlenmiştir: `gpt-5.5`,
`gpt-5.6`, Sol/Terra/Luna, bunların üç Pro sanal kimliği, `daybreak-red-latest`
ve `daybreak-blue-latest`; genel bir `gpt-5.6-pro` takma adı yoktur. Sıkıştırma
istekleri seçilen katmanı korur ancak bir akıl yürütme nesnesi olmadan temel
modeli gönderir.

Seçici kimliği tarafından temsil edilen kimlik bilgisi rotasını seçin.
Sağlayıcılar sayfasında Pool/Direct'i değiştirin; aşağıdaki `<seçici>`,
`codexAccountNamespaces` aracılığıyla eşlenen kullanıcı tarafından seçilen genel
bir etikettir:

```text
gpt-5.6-sol                         # Pool veya Direct üzerinden yalın Codex girişi rotası
<seçici>/gpt-5.6-sol                # bu seçici tarafından eşlenen saklanan Codex hesabı
openai-apikey/gpt-5.6-sol           # API anahtarı
openai/gpt-daybreak-blue-latest     # açık Codex iletme özel satırı (922.000)
<seçici>/gpt-daybreak-blue-latest   # kullanılabilir olduğunda gözlemlenen hesap nitelikli yerel kimlik
openai-apikey/daybreak-blue-latest  # ayrı API anahtarı rotası (922.000 / 922.000)
```

Yeni kurulumlar ve kayıtlı modu olmayan yapılandırmalar varsayılan olarak
Pool'dur. Geçerli yapılandırmalar işaretçi 2'yi kullanır ve sevk edilen v1
kaynağını `~/.opencodex/config.json.pre-openai-tiers-v2.bak` konumunda tutar; şu
şekilde geri yükleyin:

```sh
cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json
```

Daha önceki v1 üç sağlayıcılı yapılandırmalar otomatik olarak tek seçenek
duyarlı satıra geçer.

## Desktop uzak izin listesi sınırlaması

`codex debug models` ve uygulama sunucusu `model/list` yönlendirilen bir modeli
içeriyor ancak Desktop bunu göstermiyorsa yukarı akış [Codex issue
#19694](https://github.com/openai/codex/issues/19694) konusunu kontrol edin.
Uzak `use_hidden_models` politikası etkinken, Desktop yalnızca yerel
`available_models` listesindeki kimlikleri tutabilir ve katalog görünürlüğü
`hide` olan yerel satırları da görüntüleyebilir. Yalnızca katalog yenilemeleri
ve proxy yeniden başlatmaları bu oluşturucu politikasını değiştiremez.

Eşdeğer bir yönlendirilmiş model için opencodex açık, varsayılan olarak kapalı
bir yerel takma ad kombo modu sağlar. Dürüst bir özel görüntüleme etiketiyle
izin listesine alınmış yalın bir slug yayınlar ve kurallı OpenAI
yönlendirmesinden önce bu tam slug'ı yapılandırılmış kombo üzerinden
yönlendirir. Ayrıca uyumluluk takma adları mevcutken devre dışı bırakılmış yalın
yerel satırları etkili katalogdan çıkarır, böylece Desktop `visibility`'yi yok
sayarak onları yeniden canlandıramaz. Komut, devre dışı bırakma anahtarı
anlambilimi ve güvenlik kısıtlamaları için [Codex Desktop yerel izin listesi
uyumluluğu](/tr/guides/combos/#codex-desktop-native-allowlist-compatibility)
bölümüne bakın.

## Entegrasyon yolu

`ocx init`, `ocx start` ve `ocx sync` paylaşılan Codex yapılandırmasını ve
kataloğunu proxy'ye bağlar; yapılandırma enjeksiyonu, katalog senkronizasyonu,
dolgular (shims), WebSocket geri dönüşü ve geri yükleme mekanikleri için [Codex
Entegrasyonu](/tr/guides/codex-integration/) sayfasına bakın.

## Yönlendirilen modeller neden görünür?

Codex'in model seçicisi Codex biçimli katalog girdileri bekler. opencodex,
yönlendirilen girdileri yerel bir Codex model şablonunu klonlayarak ve ardından
yönlendirilen model kimliğini değiştirerek oluşturur:

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

Klon akıl yürütme seviyeleri, kabuk türü, API destek bayrakları ve temel
talimatlar gibi katı ayrıştırıcı alanlarını korur. opencodex daha sonra OpenAI
hizmet katmanı meta verileri de dahil olmak üzere rotanın yerine getiremeyeceği
yerel yetenekleri kaldırır.

## Mevcut kararlı model kapsamı

Yerel geri dönüş kümesi `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`,
`gpt-5.3-codex-spark` ve GPT-5.6 Sol/Terra/Luna modellerini içerir. GPT-5.5/5.4
ailesi için opencodex, kurulu Codex kataloğunun daha zengin canlı girdilerini
korur ve yalnızca eksik bir girdiyi sentezler. Paketlenmiş yukarı akış anlık
görüntüsü yalnızca eski şablon yaklaşımı yerine gerçek model başına kimliği ve
meta verileri sağladığı GPT-5.6 için kullanılır.

| Rota | Seçici kimlikleri ve katalog meta verileri |
| --- | --- |
| Codex girişi (hesap nitelikli satırlar devre dışı) | `gpt-5.6-sol`, `gpt-5.6-terra` ve `gpt-5.6-luna` gibi yalın yerel kimlikler; Pool veya Direct `codexAccountMode` aracılığıyla seçilir. GPT-5.6 satırları 922.000 tokenlik bir katalog penceresi kullanır. |
| Codex girişi (uygun seçicilerle hesap nitelikli satırlar etkin) | Uygun seçici ve desteklenen yerel model başına bir `<seçici>/<yerel-openai-modeli>` satırı; her satır yalnızca eşlenen hesabını kullanır ve yalın yerel satırlar seçiciden gizlenir. Yerel meta veriler ve bağlam pencereleri korunur. |
| Codex girişi (açık Daybreak iletme satırı) | Yalnızca tam `customModels` satırı kurallı `openai` sağlayıcısında yapılandırıldığında `openai/gpt-daybreak-blue-latest`. Daybreak hat kimliğini korur ve sabitlenmiş Sol yetenek anlık görüntüsünü kullanır (922.000 bağlam; 829.800 otomatik sıkıştırma). |
| OpenAI (API anahtarı) | Tam olarak on ad alanlı satır: `gpt-5.5`, `gpt-5.6`, Sol/Terra/Luna, üç `*-pro` sanal kimliği ve iki Daybreak takma adı (onunun tümü için 922.000 bağlam; 922.000 maksimum girdi) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`, `openrouter/openai/gpt-5.6-terra`, `openrouter/openai/gpt-5.6-luna` (922.000) |
| Cursor | Statik geri dönüş `cursor/gpt-5.6-sol`, `cursor/gpt-5.6-terra` ve `cursor/gpt-5.6-luna` (1.000.000) artı `cursor/grok-4.5` ve `cursor/grok-4.5-fast` (500.000) içerir; canlı hesap keşfi hangilerinin görünür kalacağına karar verir. |
| xAI | Canlı keşif yetkilidir. Geri dönüş kataloğu `xai/grok-4.6` içerir ve varsayılan olarak `xai/grok-4.5`'tir; her ikisinin de 500.000 tokenlik pencereleri vardır. Grok 4.6, `low` / `medium` / `high` / `xhigh` (yukarı akış varsayılanı: `high`) sunarken, Grok 4.5 `high` ile durur. |

Sabitlenmiş GPT-5.6 girdileri tam yukarı akış merdivenini korur. Sol ve Terra
`low`'dan `ultra`'ya kadar sunar; Luna `max` ile durur. Sol varsayılan olarak
`low`, Terra ve Luna ise `medium`'dur. Açık Codex iletme Daybreak Blue satırı,
hat kimliğini değiştirmeden Sol'un merdivenini ve varsayılanını devralır.
`ultra`, maksimum akıl yürütme artı proaktif yetkilendirme için istemciye
yönelik bir seçimdir ve arka uca `max` olarak ulaşır. Bir seçici girdisi
yalnızca kataloğun hazır olduğu anlamına gelir: bağlı hesap veya API anahtarının
bu modeli kullanma yetkisine sahip olması gerekir.

## Yerel ve yönlendirilen model geçişleri

Kontrol paneli Modeller sayfası, yalın yerel kimlikler ve yönlendirilen
`provider/model` kimlikleri için `disabledModels` geçişlerini ortaya çıkarır.
Hesap nitelikli `<seçici>/<yerel-openai-modeli>` kimlikleri de `disabledModels`
tarafından desteklenir, ancak kontrol paneli bu tam seçici satırlarını
listelemez veya değiştirmez; bunları yapılandırmaya manuel olarak ekleyin:

- Yönlendirilen kimlikler ad alanlıdır (`provider/model`). Birini devre dışı
  bırakmak onu senkronize edilen katalogdan ve `/v1/models` listesinden hariç
  tutar.
- Hesap nitelikli yerel kimlikler `<seçici>/<yerel-openai-modeli>` kullanır.
  `disabledModels`'a bir tane eklemek yalnızca o seçici satırını gizler.
- Yerel GPT kimlikleri yalın slug'lardır. Birini devre dışı bırakmak katalog
  girdisini tutar ancak `visibility`'yi `hide` olarak değiştirir ve daha sonra
  yeniden etkinleştirmek için tam girdiyi korur; yalın satırı ve o model için
  her seçici nitelikli klonu keşiften gizler.
- En az bir yerel takma ad kombosu yapılandırıldığında, devre dışı bırakılmış
  yalın yerel satırlar gizli tutulmak yerine çıkarılır çünkü etkilenen Desktop
  sürümleri gizli bayrağını yok sayar. Yerel bir takma ad tarafından gölgelenen
  yalın bir yerel slug Modeller sayfasından da çıkarılır, bu nedenle orada yerel
  bir anahtarı yoktur; yalnızca gölgelenmemiş yerel satırlar değiştirilebilir
  kalır. Senkronizasyon, gölgelenmemiş devre dışı bırakılmış bir satır yeniden
  etkinleştirildiğinde bozulmamış yerel meta verileri geri yükler.
- Gölgelenmemiş yerel satırlar desteklenen statik kümeden gelir, bu nedenle
  devre dışı bırakılmış gölgelenmemiş bir model kontrol panelinde görünür kalır
  ve tekrar açılabilir.

Görünürlük geçişi anlık görüntü yükseltmelerinden sonra çalışır ve yönetim
API'si kataloğu yeniler ve bir geçişten sonra Codex'in model önbelleğini eski
olmaya zorlar.

## Çoklu ajan yüzey modu

Modeller sayfası v1/base/v2 kontrolü, her seçici girdisinin hangi Codex
işbirliği yüzeyini kullanacağını değiştirir; kurallı mod, yetkilendirme,
kalıtım, geri dönüş ve şifrelenmiş görev davranışı için [Alt Ajan
Arayüzü](/tr/guides/sub-agent-surface/) sayfasına bakın.

## Akıl yürütme üst katmanları

Akıl yürütme katmanı görünürlüğü, v1/base/v2 yüzey modundan bağımsızdır.
Üretilen akıl yürütme yetenekli girdiler `max` bildirir, böylece doğrudan alt
ajan çaba geçersiz kılmaları doğrulanır; geçerli üretilen yönlendirilen girdiler
ve daha eski yerel GPT girdileri de `ultra` bildirir. Tam yukarı akış GPT-5.6
merdivenleri korunur, bu nedenle Luna `max`'a sahiptir ancak `ultra`'ya sahip
değildir.

Hatta, yönlendirilen adaptörler desteklenmeyen katmanları eşler veya sabitler.
Gerçek merdiveni `xhigh` ile duran daha eski yerel modeller için
`nativeEffortClamp`, doğrudan bir `max` veya bir `ultra` seçimini `xhigh`'a
eşler (örneğin GPT-5.5). Sol, Terra ve Luna gerçek bir `max` basamağına
sahiptir.

## Hızlı katman kuralları

Codex hızlı modu şu şekilde saklar:

```toml
service_tier = "fast"

[features]
fast_mode = true
```

Ancak model kataloğu ve çalışma zamanı istek katmanı kimliği `priority`
kullanır. opencodex bu ayrımı korur. Yerel OpenAI doğrudan geçiş modelleri hızlı
desteği korur; yönlendirilen sağlayıcılar yetenek geçişlidir — `service_tier`
yalnızca sağlayıcı `supportsServiceTier: false` bildirdiğinde kaldırılır (kayıt
defteri kurallı OpenAI'yi `true`, DeepSeek ve Volcengine Ark'ı `false` olarak
sınıflandırır), sınıflandırılmamış özel ağ geçitleri ise arayan tarafından
sağlanan değerleri dokunulmadan korur ve asla bir enjeksiyon almaz. Hızlı
seçenek yerine getirilemediği yerlerde asla tanıtılmaz ve özel ağ geçitleri
`true` ile açıkça dahil olabilir.

## Alt ajan seçimi

Codex, seçicide görünen katalog girdilerini artan `priority` değerine göre
sıralar ve ilk beşini `spawn_agent` model geçersiz kılmaları olarak bildirir.
Kontrol paneli Alt Ajanlar sayfası en fazla beş yalın yerel kimliği veya
yönlendirilen `provider/model` kimliğini seçip kaydedebilir. Manuel olarak
yapılandırılan `subagentModels` ayrıca hesap nitelikli
`<seçici>/<yerel-openai-modeli>` kimliklerini de kabul eder, ancak kontrol
paneli bu tam kimlikleri sunmaz; sayfayı kaydetmek listenin yerine kontrol
panelinde görünen seçenekleri koyar. opencodex seçilen sırada düşük katalog
öncelikleri atar; hesap nitelikli seçici satırları etkinleştirildiğinde yalın
yerel seçimler seçici nitelikli gruplara genişler. Diğer modeller tam kimlikle
çağrılabilir durumda kalır.

Öne çıkan model listesi, Kontrol Panelinin **Alt ajan yetkilendirmesi**
seçiminden ayrıdır. Codex'in önce hangi geçersiz kılmaları sunacağını denetler;
tek başına bir model seçmez veya yetkilendirmeyi tetiklemez.

## Desktop uzak sunucuları

Codex Desktop'ın uzak sunucu modu, seçiciyi istemcinin kendi `available_models`
izin listesine göre filtreler (uzak `use_hidden_models` ayarı açıkken etkindir).
Yönlendirilen katalog girdileri hala yüklenir ve sunulur — `model/list` bunları
döndürür ve paketlenmiş CLI bunları okur — ancak Desktop oluşturucusu
oluşturmadan önce bu yalnızca yerel izin listesinde olmayan her şeyi bırakır.
opencodex'in bu listeye hiçbir kancası yoktur; yukarı akış hatası
[openai/codex#19694](https://github.com/openai/codex/issues/19694) adresinde
izlenmektedir.

Desktop izin listesi için bir denetim sunana kadar:

- Modeli doğrudan uzak makinedeki `~/.codex/config.toml` dosyasında ayarlayın,
  örneğin `model = "input/grok-4.5"`. Seçici `Custom` gösterebilir, ancak
  istekler yine de yapılandırılmış yönlendirilen modeli kullanır.
- Desktop seçicisi yerine Codex CLI veya TUI kullanın; bunlar izin listesini
  uygulamaz ve yönlendirilen modelleri normal şekilde listeler.

## Model durumunu yenileme

Seçici hala eski girdileri gösteriyorsa kataloğu yenileyin ve hedef Codex
yüzeyini yeniden başlatın:

```bash
ocx sync
```

opencodex, katalog görünürlüğü, önceliği veya meta verileri her değiştiğinde
`models_cache.json` dosyasını kasıtlı olarak eski bir önbellek sarmalayıcısıyla
yeniden yazar, böylece bir sonraki Codex model yenilemesi yeni kataloğu okur.


