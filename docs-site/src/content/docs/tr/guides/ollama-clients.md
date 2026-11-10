---
title: Ollama uyumlu istemciler
description: Ollama API'sini konuşan araçları opencodex'e yönlendirin ve yapılandırdığınız sağlayıcı modellerini kullanın.
---

opencodex, Ollama HTTP API'sinin bir alt kümesine yanıt verir; böylece yalnızca Ollama ile konuşabilen bir araç,
opencodex'te zaten yapılandırdığınız modelleri kullanabilir. İstekler Chat Completions yoluna çevrilir ve seçilen
sağlayıcıya gönderilir. opencodex makinenizde model indirmez, saklamaz veya çalıştırmaz.

## Bir istemciyi bağlama

Proxy adresini Ollama ana makinesi olarak kullanın. Varsayılan yerel kurulum için:

```bash
export OLLAMA_HOST=http://127.0.0.1:10100
curl "$OLLAMA_HOST/api/tags"
```

Proxy bir API anahtarı istediğinde (örneğin `0.0.0.0` bağlamasında) anahtarı `/v1/chat/completions` için
olduğu gibi gönderin; örneğin `Authorization: Bearer <opencodex key>`. Model kapsamı olan bir anahtar yalnızca izin
verilen modelleri görür ve kullanır. Bu uç noktalar yalnızca ana dinleyicide sunulur; kimlik doğrulamasız loopback
dinleyicisi, Remote Link ve hub yönetim girişi bunları sunmaz.

## Uç noktalar

| Uç nokta | Davranış |
| --- | --- |
| `GET /api/version` | opencodex sürümü. |
| `GET /api/tags` | Yapılandırılmış sağlayıcı modelleri, `provider/model` adlarıyla. |
| `POST /api/show` | `{ "model": "provider/model" }` yalnızca bilinen bilgileri döndürür; dosya boyutu, özet, şablon veya lisans yoktur. |
| `POST /api/chat` | `system`, `user`, `assistant` ve `tool` mesajlarıyla sohbet. |
| `POST /api/generate` | İsteğe bağlı `system` ile tek bir istem. |

Diğer tüm `/api/*` yolları opencodex yönetim API'sinin parçası olarak kalır.

## Desteklenen istek alanları

- `model`: `/api/tags` içindeki bir ad.
- `stream`: varsayılan `true` (satırla ayrılmış JSON). Tek bir JSON yanıtı için `false` kullanın.
- `images`: kullanıcı mesajlarında (chat) veya istekte (generate) base64 PNG, JPEG, GIF ya da WebP.
- `tools` (yalnızca chat): fonksiyon araçları. Asistan mesajını her çağrının `id` değeri dahil değiştirmeden
  geri gönderin; bir `tool` sonucu `tool_call_id` ile, yoksa `tool_name` ile eşleştirilir.
- `options`: `temperature`, `top_p`, `num_predict` ve `stop`.
- `format`: yalnızca `"json"`.

Her `/api/chat` isteği, tüm assistant mesajlarında **toplam en fazla 1.024 araç çağrısı** kabul eder;
sonucu zaten bulunan çağrılar da bu sayıya dahildir. Sınır aşılırsa istek sağlayıcıya ulaşmadan HTTP 400
döndürür. Konuşma geçmişini kısaltıp yeniden gönderin; tuttuğunuz her araç sonucuyla birlikte ilgili
assistant araç çağrısını da koruyun.

Bunların dışındaki her şey yok sayılmak yerine HTTP 400 ile reddedilir: `think`, `keep_alive`, `suffix`,
`raw`, `template`, `context`, diğer `options`, JSON şeması biçimindeki `format` ve görsel URL'leri. Ollama'nın
model yönetimi ve embedding uç noktaları sağlanmaz.

Kombolar, yönlendirme ilkeleri, `--fast` veya effort takma adları ve çağıranın kendi kimlik bilgilerini ileten
sağlayıcılar burada seçilemez. Bu istekler yukarı akışa hiçbir şey gönderilmeden başarısız olur.

## Yanıtlar

Tamamlanan bir yanıt `done: true` ve `stop`, `tool_calls` ya da `length` değerinde bir `done_reason`
taşır. `prompt_eval_count` ve `eval_count`, sağlayıcı kullanım bildirdiğinde görünür; süre alanları bildirilmez.
Bir akış, yukarı akış yanıtı tamamen bittikten sonra tam olarak bir `done: true` satırı gönderir.

Hatalar Ollama biçimindeki `{ "error": "message" }` yapısını kullanır ve HTTP durumunu korur; hız sınırları ve
yoğunluk retlerinde `Retry-After` de bulunur. İçerik filtresi veya bilinmeyen bir nedenle durdurulan yanıt normal bir
durma olarak değil, hata olarak döndürülür. Bir akış başladıktan sonra başarısız olursa son satırı bir `error` nesnesidir
ve ardından `done: true` satırı gelmez.

İstekler diğer trafik gibi panodaki istek günlüğünde görünür ve `x-opencodex-request-id` yanıt başlığı
ilgili satırı belirtir.
