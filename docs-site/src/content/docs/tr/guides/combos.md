---
title: "Kombolar: yük devretme ve yük dengeleme"
description: Yük devretme veya ağırlıklı yük dengeleme için tek bir sanal modeli birden çok sağlayıcıya yönlendirin.
---

Bir **kombo (combo)**, gerçek sağlayıcı/model hedeflerinin sıralı bir listesini
sunan tek bir sanal modeldir. İstemciniz `combo/<kimlik>` ister; opencodex bir
hedef seçer, isteği o somut `sağlayıcı/model`'e yeniden yazar ve ilk hedefte
yeniden denenebilir bir arıza olduğunda başka bir hedefi deneyebilir.

Bu, aşağıdakilerden birini istediğinizde yararlıdır:

- **Yük Devretme (Failover):** bir modeli tercih edin, ancak yedekleri hazır
  tutun.
- **Yük Dengeleme (Load Balancing):** başarılı istekleri ağırlıklı gruplar
  halinde modellere veya sağlayıcılara dağıtın.

Kombolar normal sağlayıcı yönlendirmesinin önünde yer alır. `sağlayıcı/model`
seçicileri sizin için yeniyse önce [Model
Yönlendirme](/tr/guides/model-routing/) sayfasını okuyun.

## 60 saniyelik hızlı başlangıç

Bu örnek, birinci olarak Anthropic ve ikinci olarak OpenAI ile `combo/main`
oluşturur. Her iki sağlayıcı da zaten var olmalı ve etkinleştirilmelidir.

```bash
ocx combo set main --targets anthropic/claude-opus-4-8,openai/gpt-5.6-sol
```

Varsayılan strateji yük devretmedir, bu nedenle normal bir istek
`anthropic/claude-opus-4-8`'e gider. Bu denemede yeniden denenebilir bir hata
olursa opencodex `openai/gpt-5.6-sol`'a geçebilir.

Sanal modeli normalde bir model kimliği sağlayacağınız her yerde kullanın:

```json
{
  "model": "combo/main",
  "input": "Explain why the sky looks blue."
}
```

Kaydedilen tanımı onaylayın:

```bash
ocx combo show main
```

:::tip
Yük devretme ve eşit ağırlıklarla başlayın. Yalnızca kasıtlı olarak trafiği
dağıtmak istediğinizde round-robin'e geçin ve yalnızca eşit dağıtım uygun
olmadığında ağırlık ekleyin.
:::

## Kombo adları nasıl çalışır?

`ocx combo set <kimlik>` komutundaki kombo kimliği bir harf veya rakamla
başlamalıdır. Daha sonra toplamda 64 karaktere kadar harfler, rakamlar, `.`, `_`
veya `-` içerebilir. Kurallı model kimliği her zaman `combo/<kimlik>` olur;
örneğin `main` kimliği `combo/main` haline gelir.

`combo/` ad alanı, kombolar yapılandırıldığı sürece ayrılmıştır. `combo` adlı
bir sağlayıcı onu işgal edemez ve bir kombo kimliği yapılandırılmış bir
sağlayıcı adını yineleyemez.

İsteğe bağlı bir takma ad, komboya farklı bir genel model adı verir. Bir takma
ad:

- bir kimlikle aynı karakterleri kullanır;
- `daily-fast` gibi yalın olabilir veya `team/daily-fast` gibi bir `/`
  içerebilir;
- `combo` olamaz veya `combo/` ile başlayamaz;
- başka bir kombo takma adını yineleyemez; ve
- normalde `gpt-`, `o1-`, `o3-`, `o4-` veya `codex-` ile başlayan yalın bir
  yerel OpenAI ailesi adı olamaz. Aşağıdaki açık Desktop uyumluluk modu tek
  istisnadır.

Bir takma ad ayarlandığında bile kurallı `combo/<kimlik>` formu yine de
çözümlenir. Kurallı arama takma ad eşleştirmesinden önce çalışır, bu nedenle bir
takma ad başka bir kombonun kurallı kimliğini devralamaz.

:::note
Takma adlar istemcilerin talep ettiği genel adı değiştirir; kombonun saklanan
kimliğini veya arkasındaki somut sağlayıcı/model seçicilerini değiştirmez.
:::

## Codex Desktop yerel izin listesi uyumluluğu

Bazı Codex Desktop sürümleri, uygulama sunucusu `model_catalog_json`'ı zaten
yükledikten sonra uzak bir yalnızca yerel `available_models` izin listesi
uygular. `Nova1/codex-gpt-5.6-sol` gibi normal yönlendirilen kimlikler daha
sonra CLI tarafından kullanılabilir ancak Desktop seçicisinde bulunmaz. Bu,
[opencodex #241](https://github.com/lidge-jun/opencodex/issues/241) tarafından
izlenen yukarı akış [Codex Desktop
hatasıdır](https://github.com/openai/codex/issues/19694).

Eşdeğer bir yönlendirilmiş hedefi denetlediğinizde, bir kombo açıkça bir yerel
slug'ı devralabilir:

```bash
ocx combo set nova-sol \
  --targets Nova1/codex/gpt-5.6-sol \
  --alias gpt-5.6-sol \
  --native-alias \
  --display-name 'Nova1 - codex-gpt-5.6-sol'
```

Bu mod kasıtlı olarak isteğe bağlıdır ve hem `--native-alias` hem de boş olmayan
bir görüntüleme etiketi gerektirir. Takma ad, bu opencodex sürümü tarafından
desteklenen yerel model kimliklerinden biri olmalıdır; yalnızca yerel aile öneki
kabul edilmez çünkü kaldırma işlemi yetkili meta verileri geri
yükleyebilmelidir. Yönlendirilen hedefin keşif yanıtı yalnızca bir model kimliği
sağladığında, uyumluluk satırı eksik bağlam, modalite ve akıl yürütme meta
verilerini değiştirdiği yerel kimlikten doldurur. Açık hedef sınırları yine de
kazanır, bu nedenle bu geri dönüş asla bir bağlam sınırını yükseltmez veya
bildirilen yetenekleri geçersiz kılmaz. Tam yönlendirme önceliğini değiştirir:
`gpt-5.6-sol` istekleri, kurallı OpenAI yerel aile rotasından önce
`combo/nova-sol`'a çözümlenir. Katalog, yinelenen yerel ve kombo satırları
değil, yapılandırılmış görüntüleme etiketine sahip tek bir yalın satır içerir.
Yalnızca yalın `gpt-5.6-sol` slug'ı yakalanır. `main/gpt-5.6-sol` gibi hesap
nitelikli satırlar ve `openai-apikey/gpt-5.6-sol` gibi sağlayıcı nitelikli
satırlar ayrı OpenAI rotaları olarak kalır; sağlayıcı nitelikli API anahtarı
rotası asla yerel takma ada düşmez.

Görünürlük anahtarları belirsiz kalmaz:

- `combo/nova-sol`, uyumluluk kombosunu keşiften gizler.
- `disabledModels` içindeki yalın `gpt-5.6-sol` girdisi, uykudaki yerel OpenAI
  satırı anlamına gelmeye devam eder; şu anda bu genel slug'a sahip olan komboyu
  gizlemez.
- En az bir yerel takma ad yapılandırıldığında, devre dışı bırakılmış yalın
  yerel satırlar `visibility: "hide"` olarak tutulmak yerine geçerli Codex
  kataloğundan çıkarılır. Bu, Desktop'ın izin listesinin göstermemesi gereken
  satırları yeniden canlandırmasını önler. Modeller sayfası yine de
  gölgelenmemiş yerel anahtarları listeler ve birini yeniden etkinleştirmek
  korunmuş veya geçerli yerel meta verilerini geri yükler.

:::caution
Yerel bir takma ad kasıtlı olarak birinci taraf gibi görünen bir model kimliğini
devralır. Yalnızca hedef operasyonel olarak eşdeğer olduğunda kullanın ve seçici
satırını dürüstçe etiketleyin. Komboyu kaldırmak bir sonraki senkronizasyonda
normal yerel yönlendirmeyi ve katalog kimliğini geri yükler.
:::

## Bir strateji seçin

### Yük Devretme (Failover): sıralı birincil ve yedekler

`failover`, yapılandırma sırasındaki ilk uygun hedefi seçer. Bir hedef,
sağlayıcısı mevcut olduğunda, etkinleştirildiğinde, soğumada olmadığında ve
herhangi bir özel istek kısıtlamasını işleyebildiğinde uygundur. Ağırlıklar ve
`stickyLimit` bu stratejiyi etkilemez.

Bu sıra verildiğinde:

1. `anthropic/claude-opus-4-8`
2. `openai/gpt-5.6-sol`
3. `google/gemini-3-pro`

her istek Anthropic ile başlar. Yeniden denenebilir bir Anthropic hatası bu
isteği OpenAI'ye taşır; yeniden denenebilir bir OpenAI hatası onu Google'a
taşıyabilir. Bir terminal hatası kalan hedefleri denemek yerine hemen durur.

### Round-robin: pürüzsüz ağırlıklı gruplar

`round-robin` pürüzsüz ağırlıklı round-robin kullanır. Daha büyük bir hedef
ağırlığı, payının tamamını tek bir uzun blok olarak göndermeden bu hedefe zaman
içinde daha büyük bir pay verir. `stickyLimit`, bir sonraki ağırlıklı seçimden
önce seçilen hedefte kaç başarılı isteğin kalacağını denetler.

İki başarılı istekten oluşan gruplarla 2:1 oranında bir kombo oluşturun:

```bash
ocx combo set balanced \
  --targets anthropic/claude-opus-4-8:2,openai/gpt-5.6-sol:1 \
  --strategy round-robin \
  --sticky 2
```

Hedefleri **A** (ağırlık 2) ve **B** (ağırlık 1) olarak adlandırırsak, ilk altı
ağırlıklı seçim `A, B, A, A, B, A` olur. `stickyLimit` 2 olduğu için her seçim
iki başarılı istek boyunca aktif kalır:

| Başarılı istek | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Hedef | A | A | B | B | A | A | A | A | B | B | A | A |

Uzun vadeli pay hala 2:1'dir. Yeniden denenebilir bir hata geçerli yapışkan
grubu sonlandırır, bu hedefi soğutur ve aynı istek için başka bir uygun hedef
seçer.

:::caution
Ağırlıklar görecelidir, yüzde değildir. `2,1` ve `200,100` ağırlıkları aynı
oranı ifade eder. Niyeti ileten küçük değerleri tercih edin.
:::

## Bir hedef başarısız olduğunda ne olur?

Kombo hataları **atlama (hop)** hataları ve **uç (terminal)** hatalar olarak
ikiye ayrılır.

| Sonuç | Davranış |
| --- | --- |
| HTTP 401, 403, 404, 408, 429 veya herhangi bir 5xx | Hedefi soğutun ve bir sonraki uygun hedefe atlayın. |
| Sınıflandırılmış kimlik doğrulama, abonelik, kota, hız sınırı, aşırı yük veya yukarı akış sunucu hatası | Yalnızca durum yeterli olmadığında bile hedefi soğutun ve atlayın. |
| İstemci iptali (499), `origin_rejected`, siber politika reddi, bağlam taşması veya geçersiz istek | Durun ve hatayı döndürün; başka bir hedef isteği geçerli kılmaz. |
| Diğer sınıflandırılmamış hatalar | Durun ve hatayı döndürün. |

Atlanan bir hedef varsayılan olarak 60 saniye boyunca soğuma süresine girer.
Yukarı akış yanıtı geçerli bir `Retry-After` değeri içeriyorsa opencodex bunun
yerine onu kullanır. Sayısal saniyeler ve HTTP tarihi değerleri kabul edilir ve
her soğuma süresi en fazla 10 dakika ile sınırlandırılır.

Geçerli istek denenen aynı hedefi asla yeniden denemez. Daha sonraki istekler
soğuma süresi dolana kadar onu atlar. Uygun hiçbir hedef kalmazsa proxy
`error.code = "combo_unavailable"` ile HTTP 503 döndürür.

:::note
Yük devretme kasıtlı olarak sınırlandırılmıştır. Hedefe özgü kullanılabilirlik,
kimlik doğrulama, kota ve aşırı yük hatalarına yardımcı olur; arayan hatalarını
veya politika retlerini gizlemez.
:::

## Varsayılan akıl yürütme çabası

`defaultEffort`, yalnızca bunların tümü doğru olduğunda `reasoning.effort`
sağlar:

1. kombonun boş olmayan (non-null) bir varsayılanı vardır;
2. arayan bir çaba ayarlamamıştır; ve
3. seçilen hedefin kataloğu tam olarak bu çabayı bildirmektedir.

İstekte bir `reasoning` nesnesi yoksa opencodex bir tane oluşturur. Bir `effort`
özelliği olmadan `reasoning` varsa diğer alanları korur ve varsayılanı ekler.
Arayan tarafından sağlanan bir çabanın üzerine asla yazılmaz.

Hedef yeteneği bilinmediğinde veya yapılandırılan çabayı içermediğinde opencodex
varsayılanı atlar ve hedefin kendi davranışını değiştirmeden bırakır.
Desteklenen değerler `low`, `medium`, `high`, `xhigh`, `max` ve `ultra`'dır;
çabayı tamamen arayana ve hedefe bırakmak için alanı atlayın veya `null` olarak
ayarlayın.

## Şifrelenmiş v2 alt ajan görevleri

Codex v2 alt ajanları için önemli bir sınırlama vardır ([sorun
#92](https://github.com/lidge-jun/opencodex/issues/92)). Yerel bir üst ajan,
yeni oluşturulan bir çalışanın görevini yalnızca yerel ChatGPT arka ucu için
basılmış şifreli metin olarak gönderebilir. Harici bir sağlayıcı bu yükü
okuyamaz.

Böyle bir istek için bir kombo, yeniden denenebilir bir arızadan sonra da dahil
olmak üzere uygun hedeflerini kurallı yerel ChatGPT rotalarına filtreler.
Kombonun şifre çözme yeteneğine sahip hiçbir hedefi yoksa opencodex göndermeden
önce durur ve HTTP 400 döndürür:

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "unreadable_encrypted_agent_task"
  }
}
```

Bu, görevin okunabilir talimatlar alamayacak bir sağlayıcıya gönderilmesini
engeller. Okunabilir düz metin görevleri normal kombo stratejisini kullanır.

Dört kurtarma seçeneğiniz vardır:

1. Çocuk için yerel bir ChatGPT modeli seçin.
2. Komboya kurallı bir yerel ChatGPT hedefi ekleyin.
3. Farklı sağlayıcılar arasında yetkilendirme için v1 yüzeyini kullanın.
4. Arayanı denetliyorsanız, görevi düz metin v2 `agent_message` içeriği olarak
   yeniden gönderin.

v1/base/v2 modları ve tam şifrelenmiş görev iş akışı için [Alt Ajan
Arayüzü](/tr/guides/sub-agent-surface/) sayfasına bakın.

## Komboları yönetme

### Kontrol Paneli

Yerel kontrol panelini açın ve **Modeller → Kombolar** seçeneğini belirleyin.
Çalışma alanı komboları oluşturur, düzenler, yeniden adlandırır ve kaldırır;
hedef seçicisi ise devre dışı bırakılmış modelleri ve iç içe geçmiş komboları
hariç tutar.

### CLI

Birincil komutlar şunlardır:

```bash
ocx combo list
ocx combo show <kimlik>
ocx combo set <kimlik> --targets saglayici/model[:agirlik],...
ocx combo remove <kimlik> --yes
```

`set` ayrıca `--strategy`, `--sticky`, `--effort`, `--alias`, `--native-alias`,
`--display-name` ve `--rename-from` kabul eder. Bu alanı temizlemek için
`--effort`, `--alias` veya `--display-name` değeri olarak `-` kullanın.
`--native-alias`, şu anda desteklenen yalın bir yerel model takma adı ve boş
olmayan bir görüntüleme adı gerektirir. `create` ve `update`, `set`'in takma
adlarıdır; `delete`, `remove`'un takma adıdır; ve aynı alt komutlar `ocx route
combo` altında mevcuttur.

### Yönetim API'si

Başsız istemciler `/api/combos` üzerinde `GET`, `PUT` ve `DELETE` kullanır.
`GET` normalleştirilmiş kombo tanımlarını listeler, `PUT` bir tane oluşturur
veya değiştirir (ve birini yeniden adlandırabilir) ve `DELETE` kimlik sorgu
parametresini alır. Kimlik doğrulama ve istek/yanıt ayrıntıları [Yönetim API'si
referansı](/tr/reference/management-api/) içindedir.

Kalıcı hale getirilmiş tam yapılandırma için bkz.
[Yapılandırma](/tr/reference/configuration/).

## Yapılandırma referansı

Kombolar, kombo kimliğine göre anahtarlanan üst düzey `combos` nesnesinde
saklanır:

```json
{
  "combos": {
    "balanced": {
      "targets": [
        { "provider": "anthropic", "model": "claude-opus-4-8", "weight": 2 },
        { "provider": "openai", "model": "gpt-5.6-sol", "weight": 1 }
      ],
      "strategy": "round-robin",
      "stickyLimit": 2,
      "defaultEffort": "high",
      "alias": "team/balanced"
    }
  }
}
```

| Alan | Gerekli | Varsayılan | Kurallar |
| --- | --- | --- | --- |
| `targets` | Evet | — | Yapılandırılmış `{ provider, model, weight? }` hedeflerinin boş olmayan sıralı dizisi. Yinelenen sağlayıcı/model çiftleri reddedilir. |
| `targets[].weight` | Hayır | `1` | 1 ile 10.000 arasında tam sayı. Round-robin tarafından kullanılır; yük devretme tarafından yok sayılır. |
| `strategy` | Hayır | `"failover"` | `"failover"` veya `"round-robin"`. |
| `stickyLimit` | Hayır | `1` | Round-robin seçimi başına 1 ile 100 arasında başarılı istek tam sayısı. |
| `defaultEffort` | Hayır | `null` | `low`, `medium`, `high`, `xhigh`, `max` veya `ultra`; yalnızca arayan çabayı atladığında ve hedef desteği bildirdiğinde uygulanır. |
| `alias` | Hayır | yok | İsteğe bağlı kırpılmış genel model kimliği; yukarıdaki takma ad kurallarını kullanın. Boş bir değer takma ad yok olarak saklanır. |
| `nativeAlias` | Hayır | `false` | Şu anda desteklenen yalın bir yerel `alias`'ın yönlendirme ve katalog önceliği almasına açıkça izin verin. Asla takma addan çıkarılmaz. |
| `displayName` | Hayır | yok | Sınırlı salt görüntüleme katalog etiketi. `nativeAlias` true olduğunda gerekli ve boş değildir. |

## Sorun Giderme

### `combo/<kimlik>` neden 404 döndürüyor?

Kombo kimliği bilinmiyor. Yanıt, `invalid_request_error` türünde HTTP 404'tür.
`ocx combo list` çalıştırın, yazımı ve büyük/küçük harf durumunu kontrol edin ve
yönetim komutunuzun model isteklerini alan çalışan aynı opencodex örneğine
yazdığını onaylayın.

### Neden `combo_unavailable` alıyorum?

Her hedef şu anda uygun değildir: örneğin sağlayıcısı devre dışıdır,
soğumaktadır, bu istek için zaten denenmiştir veya şifrelenmiş bir v2 görevi onu
hariç tutmaktadır. Hedef sağlayıcı durumunu ve son yukarı akış hatalarını
kontrol edin. Soğuma süreleri için 60 saniyelik varsayılanı veya yukarı akış
`Retry-After` süresini (asla 10 dakikadan fazla olamaz) bekleyin, ardından
yeniden deneyin.

### Takma adım neden reddedildi?

Önce takma ad dilbilgisini ve ayrılmış adları kontrol edin. Yinelenen bir takma
ad veya geçersiz şekil HTTP 400 olarak reddedilir. İlk bölümü yapılandırılmış
bir Codex hesap ad alanı olan eğik çizgili bir takma ad HTTP 409 olarak
reddedilir; farklı bir takma ad ad alanı seçin. CLI ve kontrol paneli sunucunun
tam doğrulama mesajını görüntüler.

### Yük devretme ilk hatadan sonra neden durdu?

Hata hedefe özgü olmaktan ziyade uç (terminal) bir hataydı. Geçersiz girdiyi
düzeltin, aşırı büyük bir bağlamı azaltın, bir politika reddini işleyin veya
reddedilen istek kaynağını düzeltin. Kombolar bu durumlar için atlama yapmaz.


