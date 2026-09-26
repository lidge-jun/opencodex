---
title: Danışman
description: OpenCodex'in sahibi olduğu uzman danışma sidecar'ı — yapılandırılan uzman model yönlendirilen worker'lara tavsiye döndürür; manual ve preflight politikaları.
---

Danışman, worker'ın görevini inceleyen ve tavsiye döndüren bağımsız bir uzman modeldir. Danışmayı uçtan uca OpenCodex sahiplenir: proxy, worker'ın turuna sentetik `advisor` aracını enjekte eder, danışmayı normal yönlendirme otoritesi aracılığıyla kendisi yürütür ve tavsiyeyi geri enjekte ederek özgün worker'ın devam etmesini sağlar. Worker'ın bir şey devretmesine, spawn etmesine veya sağlayıcı kimlik bilgisi taşımasına gerek yoktur.

Bu, alt ajan yüzeyinden farklıdır (bkz. [Ajan yapılandırması](/tr/reference/configuration/agents/)): alt ajanlar, Codex'in işbirliği araçları üzerinden worker tarafından başlatılan delegasyondur. Danışman, istemcinin hiç görmediği proxy tarafı bir sidecar'dır — hiçbir şey spawn etmeyen bir worker bile tavsiye alabilir.

## Yapılandırma

```json
{
  "advisor": {
    "enabled": true,
    "model": "gpt-6-astra",
    "effort": "max",
    "policy": "preflight"
  }
}
```

| Alan | Tür | Varsayılan | Anlam |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | Ana anahtar. Kapalıyken istek yolunda hiçbir danışman davranışı olmaz. |
| `model?` | `string` | — | Uzman model. Yönlendiricinin kabul ettiği herhangi bir model dizisi: çıplak yerel model (`gpt-6-astra`), açık `provider/model` (`anthropic/claude-sonnet-4-6`, `xai/grok-...`) veya hesap nitelemeli yerel model. Sağlayıcılar arası tam desteklenir. |
| `effort?` | `string` | `"max"` | Danışman çağrısının muhakeme düzeyi (`low`–`ultra`). |
| `policy?` | `"manual" \| "preflight"` | `"manual"` | Ne zaman danışılır. |
| `timeoutMs?` | `number` | `120000` | Loopback danışma zaman aşımı. |

Panodaki **Advisor** sayfası veya `ocx advisor status|on|off|set --model <model> --effort <effort> --policy <manual|preflight>` ile yönetin.

## Politikalar

- **`manual`** — yalnızca worker sentetik `advisor` aracını açıkça çağırdığında danışılır. Çağrı proxy tarafından yakalanır, istemciye hiç gösterilmez ve yerel araç olarak yürütülmez.
- **`preflight`** — OpenCodex ayrıca görev başına en az bir danışma garanti eder. Worker ilk yönelim kanıtını (son kullanıcı mesajından sonra en az bir araç sonucu) ürettikten sonra, worker aracı hiç çağırmasa da proxy uzmana danışır ve worker'ın bir sonraki turundan önce tavsiyeyi enjekte eder. Tetikleyici deterministik, belgelenmiş bir yaklaşımdır; anlamsal bir "takıldı" dedektörü değildir.

## Danışmanın gördüğü şey

Danışma yükü, yalnızca worker modelinin zaten görmesine izin verilen ayrıştırılmış konuşmadan oluşur: kullanıcı görevi, konuşma, araç çağrıları ve sonuçları, worker'ın araç kataloğu ve iki tarafın model kimliği. Danışman düzyazı tavsiye döndürür; tanınabilir `<opencodex_advisor>` sarmalayıcısıyla geri enjekte edilir ve sistem yetkisi yoktur. Düşünce zinciri aktarılmaz, şifreli sağlayıcı içeriği çözülmez ve kimlik bilgileri ya da ortam sırları yüke binmez.

## Maliyet ve hesap

Her danışma gerçek bir ek model çağrısıdır. Worker'ın token sayılarına asla katılmaz; **danışman modeli** altında kullanımda görünür ve her danışma tetikleyici, süre, durum ve kullanımı içeren bir `[advisor]` günlük satırı yazar — böylece bir danışman çağrısı her zaman günlüklerden kanıtlanabilir.

## Hata davranışı

Danışman fail-open davranır: uzman model kullanılamıyorsa, yanlış yapılandırıldıysa veya zaman aşımına uğrarsa, worker kısa ve yanıltıcı olmayan bir "danışman kullanılamıyor" bağlamı alır (preflight için hiçbir şey enjekte edilmeyebilir) ve göreve devam eder. Danışma hatası kodlama isteğini asla başarısız kılmaz ve oturumun ana modelini asla değiştirmez.

## PR1 sınırlamaları

- Yerel OpenAI passthrough turları (ChatGPT havuzu worker'ları) sentetik aracı almaz; danışman desteği yönlendirilen (çevrilen) sağlayıcıları kapsar. Preflight danışması run-turn bağdaştırıcılarına uygulanır; araç uygulanmaz.
- Uyarlanabilir tetikleyici yok: takılma algılama, tekrarlayan başarısızlık analizi, yükseltme katmanları, çoklu danışman veya oylama yok. Yalnızca `manual` ve `preflight`.
- Preflight tekilleştirme defteri süreç içindedir; proxy yeniden başlatıldıktan sonra devam eden bir görev bir preflight danışması daha alabilir.
