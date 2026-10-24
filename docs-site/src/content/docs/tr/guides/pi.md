---
title: "Pi Entegrasyonu"
description: "Inflection Pi ve hafif sohbet modellerini OpenCodex üzerinden bağlama rehberi."
---

Pi, sağlayıcılarını tek bir genel JSON dosyasından okur. opencodex Pi’yi başlatmaz; `ocx export`, temel URL, model listesi ve gizli olmayan yerel anahtar yer tutucusunu içeren `opencodex` sağlayıcı bloğunu üretir. Bu bloğu mevcut yapılandırmanızla birleştirin.

## Quickstart

Start the proxy, then print the config:

```bash
ocx start
```

Bu işlemi çalışır durumda bırakın. İkinci bir terminalde yapılandırmayı yazdırın:

```bash
ocx export --client pi
```

JSON’dan sonra hedef yol, birleştirme uyarısı, loopback kullanım ipucu ve doğrulanmış bağlam sınırları olan model sayısı yazdırılır. Bu dışa aktarım yalnızca kimlik doğrulamasız loopback proxy’sini destekler; uzak erişim kimlik doğrulamasını yapılandırmaz.

```json
{
  "providers": {
    "opencodex": {
      "baseUrl": "http://127.0.0.1:10100/v1",
      "api": "openai-completions",
      "apiKey": "opencodex-loopback",
      "compat": {
        "sendSessionAffinityHeaders": true,
        "supportsDeveloperRole": false
      },
      "models": [
        {
          "id": "anthropic/claude-opus-5",
          "name": "Claude Opus 5 (anthropic)",
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 128000
        }
      ]
    }
  }
}
```

Oluşturulan Pi sağlayıcılarında `compat.sendSessionAffinityHeaders` etkinleştirilir. Sağlayıcıyı birleştirirken veya elle düzenlerken bu ayarı koruyun: Pi sabit bir oturum kimliği gönderir ve OpenCodex bu kimlikten kanonik OpenCode Go hedefi için oturum yakınlığı üretir. `cacheRetention` değeri `none` olduğunda Pi kimliği göndermeyebilir.

Oluşturulan Pi sağlayıcıları ayrıca `compat.supportsDeveloperRole` değerini `false` yapar; böylece Pi sistem istemini `developer` yerine `system` rolüyle gönderir. OpenCodex Chat Completions rollerini olduğu gibi iletir ve OpenAI uyumlu bazı sağlayıcılar `developer` rolünü 400 hatasıyla reddeder; `system` rolünü hepsi kabul eder.

Model ids are the proxy's canonical selectors, so routed models appear as
`provider/model`
(`anthropic/claude-opus-5`) and native OpenAI slugs stay unprefixed
(`gpt-5.6-sol`). The `name`
suffix — `(anthropic)`, `(native)`, `(routed)` — is what makes two same-named
models from
different upstreams distinguishable in Pi's picker.

## Where it goes

Pi's global model config is:

```text
~/.pi/agent/models.json
```

:::caution[Merge, never replace]
`ocx export` never writes that file. Merge the `providers.opencodex` block into
it — replacing the
file destroys every other provider you have configured there. `--out` exists for
a scratch path
and refuses to overwrite an existing file without `--force`:

```bash
ocx export --client pi --out ~/opencodex-pi-models.json
ocx export --client pi --json > ~/opencodex-pi-models.json   # or redirect the byte-exact JSON
```

:::

The exported block is a static snapshot, not a live view. Re-run `ocx export`
after adding a
provider or changing model visibility, and merge the new block over the old one.

## The admission key

Dışa aktarılan `apiKey`, gizli olmayan `opencodex-loopback` yer tutucusudur. Anahtar için ortam değişkeni dışa aktarmanız gerekmez. Dışa aktarıcı yalnızca kimlik doğrulamasız loopback proxy’sine izin verir; uzak veya token ile korunan proxy’leri reddeder. Sağlayıcı kimlik bilgileri [Sağlayıcılar](/tr/guides/providers/) sayfasında açıklanan opencodex yapılandırmasında kalır. Üst sağlayıcının anahtarını bu Pi bloğuna koymayın. Uzak erişim için proxy erişim kimlik doğrulamasını destekleyen bir entegrasyon kullanın. Yer tutucuyu değiştirmek Pi için uzak dışa aktarımı etkinleştirmez.

## Model metadata

`contextWindow` and `maxTokens` are emitted only when the catalog reports an
authoritative context
window. When it does not, both fields are omitted for that model and Pi applies
its own defaults;
`ocx export` prints how many rows fell into that case.

Çıktı sınırı, katalogdaki veya oluşturulan meta verilerdeki bilinen model sınırını kullanır. Yalnızca sınır bilinmiyorsa `32000` kullanılır. Çıktı sınırı her zaman bağlam penceresiyle sınırlanır; `32000` altındaki bilinen sınırlar da korunur.

Two fields are deliberately absent. `cost` requires all four price fields and
opencodex has no
price data for routed models — emitting zeros would assert that every model is
free. `reasoning` is
a boolean in Pi while the catalog carries an effort ladder, and mapping one onto
the other would be
a guess.

## Schema status

:::note[Unverified against a real install]
The shape above follows Pi's published custom-provider documentation. It has
**not** been verified
against a real `~/.pi/agent/models.json` on a machine with Pi installed. If Pi
rejects the exported
block, the mismatch is on our side — please
[open an issue](https://github.com/lidge-jun/opencodex/issues) with what Pi
reported.
:::

## Requirements

A running opencodex proxy (`ocx start`) and Pi installed. `ocx export` reads the
live catalog
through the proxy's management API, so a config can never be emitted with an
empty model list.


