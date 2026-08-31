---
title: "Sidecar'lar: Web Arama & Vizyon"
description: Yerel ChatGPT sidecar'ları aracılığıyla yönlendirilen modellere gerçek web araması ve salt metin modellere görsel anlama yeteneği kazandırın.
---

Yönlendirilen modellerin tümü barındırılan **web araması** veya yerel **görsel
girişi** sunmaz. opencodex bu yetenekleri iki sidecar ile doldurur. Her biri bir
ChatGPT girişi (`forward`) sağlayıcısı veya saklanan bir Anthropic OAuth
sağlayıcısı aracılığıyla çalışabilir; web araması açık `xai` arka ucuyla saklanan Grok OAuth'ı da kullanabilir. Sidecar hataları tüm turu başarısız kılmak
yerine sınırlı araç sonuçları veya görsel işaretçileri haline gelir.

:::note[Otomatik arka uç seçimi]
Açık `backend` yapılandırması kazanır. Web araması ayarlanmadığında her zaman `openai` kullanır;
Vision kullanılabilir bir Anthropic OAuth hesabı varsa `anthropic`, yoksa `openai` kullanır.
Kullanılabilir kimlik bilgisi olmadan açık `anthropic` veya `xai` geri dönüş yapmadan
başarısız olur. `openai`, hem ChatGPT girişi kimlik doğrulamasını hem de
etkinleştirilmiş bir `forward` sağlayıcısını gerektirir.
:::

## Web arama sidecar'ı

Codex, doğrudan geçiş olmayan bir yönlendirilmiş model için barındırılan
`web_search` istediğinde opencodex:

1. Barındırılan `web_search` aracını **bırakır** ve bunun yerine yönlendirilen
   modele sentetik bir `web_search(query)` fonksiyon aracını sunar. Orijinal
   barındırılan araç seçenekleri sidecar çağrısı için tutulur.
2. Yönlendirilen modeli küçük bir **ajan döngüsünde** çalıştırır. Model
   `web_search`'i çağırdığında opencodex seçilen sidecar arka ucunu kullanır:
   OpenAI varsayılan olarak `gpt-5.6-luna` ile barındırılan `web_search`'i
   çalıştırır; Anthropic varsayılan olarak `claude-sonnet-5` ile
   `web_search_20250305`'i çalıştırır. xAI varsayılan olarak `grok-4.6` ile hosted
   `web_search` çalıştırır ve `xSearch.enabled` true olduğunda aynı isteğe `x_search` ekler.
   Akışlı yanıt ve alıntılar bir araç sonucu haline gelir.
3. Model yanıt verene veya toplam gerçek sorgu bütçesi `maxSearchesPerTurn`'e
   (varsayılan 3) ulaşana kadar **döngüye girer**, ardından arama aracını
   kaldırır ve nihai bir yanıta zorlar. `apply_patch` veya kabuk gibi gerçek
   istemci araçları turu sonlandırır, böylece bu çağrılar Codex'e ulaşır.

Her yönlendirilen model yinelemesi yukarı akışta `stream: true` ister, ancak
varsayılan olarak opencodex arama yapmaya veya nihai yanıtı döndürmeye karar
vermeden önce anlamsal olayları dahili olarak tamamen arabelleğe alır. Yalnızca
ilk yinelemenin nihai başlıkları/durumu ve 429 anahtar rotasyonları hevesli bir
şekilde alınır. Böylece sentetik arama çağrıları ve ön çıktılar asla istemci
tarafından görülebilen model çıktısı olarak açığa çıkarılmaz.

İsteğe bağlı `webSearchSidecar.streamRoutedModelOutput` (varsayılan `false`),
bunun yerine her yinelemenin öndeki metin/düşünme farklarını canlı olarak
yayınlar — istemci, tıpkı sidecar'sız yolda olduğu gibi model ürettiği anda
çıktıyı görür. Canlı pencere ilk araç çağrısı sınırında kalıcı olarak kapanır,
bu nedenle `web_search`'i müdahale etme kararı atomik kalır ve hiçbir şey asla
iki kez teslim edilmez (uç yeniden oynatma zaten akışlanan şeyi atlar).
Ödünleşim: modelin arama yapmaya karar vermeden *önce* yaydığı metin —
arabellekli modun sessizce bıraktığı — görünür hale gelir ve arama sonrası
yanıtta kısmen tekrarlanabilir. Kontrol Paneli genel bakış sayfası bunu web
arama sidecar kartındaki **Yanıtları canlı yayınla (Stream answers live)**
anahtarı olarak sunar (`PUT /api/sidecar-settings` ile
`webSearch.streamRoutedModelOutput`).

Kiro yorumu bu seçenekten bağımsızdır: yorum aşaması metni arabellekli modda uç
olaydan önce zaten akış yapar ve bu atlama değişmez — `streamRoutedModelOutput`
olsun veya olmasın, atomik `web_search` kararı için yalnızca arama kararı
olayları (araç çağrıları ve ilk araç çağrısı sınırından sonraki her şey)
arabelleğe alınmış olarak kalır.

Enjekte edilen sonuç, güvenilmeyen bir veri sınırına sarılır, uzunlukla
sınırlandırılır ve kaynak URL'ye göre tekilleştirilir. Yapılandırılmış çıktı
turlarında (`json_schema` / `json_object`), düzyazı yerine kompakt JSON olarak
teslim edilir. Salt metin yönlendirilen modeller için arama modeline ilgili
görselleri kelimelerle açıklaması ve kaynak URL'lerini eklemesi de söylenir.

```json
{
  "webSearchSidecar": {
    "enabled": true,
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "reasoning": "low",
    "maxSearchesPerTurn": 3,
    "routedModelStallTimeoutMs": 200000,
    "timeoutMs": 200000,
    "streamRoutedModelOutput": false
  }
}
```

`minimal` akıl yürütme kullanılmaz çünkü barındırılan arka uç bu çabada araçları
reddeder. Başarısız bir arama, yönlendirilen modele sınırlı bir hata sonucu
olarak döndürülür ve zaten sahip olduğu bağlamdan yanıt vermesine olanak tanır.

Dört ayrı saat geçerlidir. `stallTimeoutSec` temel köprü olayı durma bütçesidir.
`connectTimeoutMs` (varsayılan `200000`) yalnızca DNS/TCP/TLS ve nihai yanıt
başlıklarını kapsar. Yalnızca yapılandırma dosyasındaki
`webSearchSidecar.routedModelStallTimeoutMs` (varsayılan `200000`, tam sayı
`1..2147483647`), her yönlendirilen model yinelemesi için sürekli ham yanıt
baytı hareketsizliğini sınırlar ve her boş olmayan baytta sıfırlanır.
`webSearchSidecar.timeoutMs` ayrı olarak bir barındırılan arama isteğini
sınırlar. Geçerli köprü denetleyicisi `max(temel durma, bağlantı zaman aşımı,
yönlendirilen model durması, sidecar zaman aşımı) + 30 saniye`dir. Yönlendirilen
durma, toplam bir üretim zaman aşımı değildir. SSE başlamadan önceki arızalar
2xx olmayan JSON döndürür; yanıt başlıkları başladıktan sonraki üretim arızaları
`response.failed` SSE olarak teslim edilir.

## Vizyon sidecar'ı

Yönlendirilen model sağlayıcısının `noVisionModels` listesinde yer aldığında ve
bir istek görsel taşıdığında, opencodex ana çağrıdan **önce** her görseli
açıklar ve onu metinle değiştirir. `visionSidecar.model` olmadığında veya boş
olduğunda, OpenAI yürütme yolu, Kontrol Paneli ve yönetim API'si `gpt-5.4-mini`
geri dönüşünü kullanır. Başlangıç hala açıkça kalıcı hale getirilmiş eski bir
`gpt-5.4-mini` değerini `gpt-5.6-luna`'ya geçirir; bu geçiş, bulunmayan bir
model alanına değil, saklanan bir değere uygulanır.

- Görseller, Codex'in `view_image`'ı da dahil olmak üzere kullanıcı, geliştirici
  ve araç sonucu mesajlarından gelebilir.
- OpenAI yolunda (ChatGPT girişi doğrudan geçişi), her görsel seçilen
  `reasoning.effort` (varsayılan olarak `low`) ile Responses uç noktası
  üzerinden yapılandırılmış vizyon modeline gönderilir ve açıklaması satır içi
  görsel parçasının yerini alır. Anthropic yolu, kendi düşünme bütçesi
  eşlemesiyle Messages uç noktasını kullanır ve bu OpenAI'ye özgü ayarı yok
  sayar.
- Bilinen yetenek meta verilerine sahip yerel modeller için desteklenmeyen akıl
  yürütme, talep edilen seviyedeki veya altındaki en yüksek desteklenen basamağa
  normalleştirilir; hiçbiri yoksa en düşük desteklenen basamak kullanılır.
  Güvenilir yetenek meta verileri olmadığında bilinmeyen veya özel modeller izin
  verici kalır.
- Açıklamalar sınırlı eşzamanlılıkla çalışır (aynı anda 3, girdi sırası
  korunur). Açıklayıcıya gönderilen kullanıcı bağlamı 800 karakterle
  sınırlandırılmıştır ve enjekte edilen her açıklama 2.000 karakterle
  sınırlandırılmıştır. İstek, ChatGPT arka ucunun reddettiği
  `max_output_tokens`'ı göndermez.
- Görsel URL'leri iletilmeden önce doğrulanır: veri URL'leri `png` / `jpeg` /
  `jpg` / `webp` / `gif` kullanmalıdır ve base64 verileri yaklaşık 20 MB ile
  sınırlıdır. Yalnızca `data:` ve `https:` şemaları kabul edilir; uzak `https`
  görselleri proxy tarafından değil, OpenAI arka ucu tarafından getirilir.
- `noVisionModels` eşleştirmesi Ollama tarzı bir `:size` sonekini yok sayar, bu
  nedenle bir `gpt-oss` girdisi `gpt-oss:120b`'yi de kapsar.
- Açıklama başarısız olursa model kısa bir işleme hatası işaretçisi alır.
  Kullanılabilir hiçbir sidecar planı yoksa ham görsel salt metin bir arka uca
  iletilmek yerine kaldırılır.
- `maxDescriptionsPerTurn` (varsayılan 8), ana model turu başına yeni
  açıklamaları sınırlar. Önbellek isabetleri ve aynı turdaki kopyalar bunu
  tüketmez. Başarılı `data:` görsel açıklamaları arka uç, model, ayrıntı, görsel
  baytları ve mesaj bağlamına göre önbelleğe alınır — artı OpenAI
  anahtarlarındaki akıl yürütme çabası (Anthropic anahtarları bunu atlar, çünkü
  bu alan orada yok sayılır); değişken `https:` görselleri önbelleğe alınmaz.

Yönetim API'si ve Kontrol Paneli seçicisi artık gerçekten görsel girdisi kabul
edebilen modelleri listeler. Eşleşen arka uç kullanılabilir olduğunda
`gpt-5.6-luna` (OpenAI) ve `claude-haiku-4-5` (Anthropic) her zaman temel
seçenekler olarak sunulur. `PUT /api/sidecar-settings`, salt metin olduğu
bilinen bir modeli reddeder, ancak özel veya katalog öncesi adların çalışmaya
devam etmesi için bilinmeyen bir kimliği yine de kabul eder.

```json
{
  "visionSidecar": {
    "enabled": true,
    "backend": "openai",
    "model": "gpt-5.6-luna",
    "reasoning": "medium",
    "maxDescriptionsPerTurn": 8,
    "timeoutMs": 45000
  }
}
```

Bir model, sağlayıcı başına salt metin olarak işaretlenir:

```json
{
  "providers": {
    "ollama-cloud": {
      "baseUrl": "https://ollama.com/v1",
      "noVisionModels": ["glm-5.2", "gpt-oss", "qwen3-coder", "deepseek-v4-pro"]
    }
  }
}
```

## Kontrol paneli denetimleri ve devre dışı bırakma

Kontrol Paneli Vizyon sidecar kartı, sidecar'ı etkinleştirebilir veya devre dışı
bırakabilir, mevcut model, arka uç ve akıl yürütme denetimlerinin yanı sıra
`maxDescriptionsPerTurn` ve `timeoutMs` ayarlarını belirleyebilir. Sidecar'ı
devre dışı bırakmak bu ayarları silmez; tekrar açmak önceki modeli, arka ucu,
akıl yürütmeyi, zaman aşımını ve sınırı korur.

`PUT /api/sidecar-settings` aynı alanları kabul eder. Kısmi güncellemeler
atlanan anahtarları değiştirmeden bırakır. `timeoutMs` çalışma zamanı tamsayı
sınırlarını kullanır (1–2147483647 ms).

Dosyayı doğrudan düzenlemeyi tercih ediyorsanız `config.json` içinde yine de
`enabled: false` ayarlayabilirsiniz. Anthropic-OAuth araması ve görsel
açıklaması mevcut Claude Code OAuth parmak izi emsalini yeniden kullanır, ancak
hedeflenen hesap ve iş yükü ile kapsamlı bir şekilde test edilmelidir.

Her alan için [Yapılandırma referansı](/tr/reference/configuration/#sidecars)
bölümüne bakın.

