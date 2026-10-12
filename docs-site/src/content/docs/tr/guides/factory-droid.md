---
title: Factory Droid köprüsü
description: Factory Droid modellerini yerel ve Responses uyumlu bir köprü aracılığıyla opencodex'e bağlayın.
---

Factory Droid bir ajan çalışma zamanıdır; belgelenmiş bir OpenAI uyumlu çıkarım uç noktası değildir. Dahili Factory LLM URL'sine yöneltilen özel sağlayıcı `403 Forbidden` döndürüyorsa yalnızca opencodex adaptörünü değiştirmek veya sağlayıcı başlıkları eklemek, bu özel rotayı desteklenen genel API'ye dönüştürmez.

Çalışan entegrasyon şöyledir:

```text
Text-only Responses client
  -> opencodex (http://127.0.0.1:10100/v1/responses)
  -> local Responses bridge (http://127.0.0.1:11435/v1/responses)
  -> official droid exec command
  -> Factory account and selected model
```

Böylece Factory kimlik bilgisi resmî Droid istemcisinde kalır. OpenCodex yalnızca yerelde kullanılan ayrı bir köprü belirteci alır.

## Başarısız olanlar ve nedenleri

| Belirti | Neden | Çözüm |
| --- | --- | --- |
| Factory LLM URL'sinden `403 Forbidden` | URL, üçüncü taraf istemciler için belgelenmiş genel amaçlı bir OpenAI uç noktası değildir | Factory'yi resmî Droid CLI veya SDK aracılığıyla çağırın |
| `/models/models` adresinde `404` | Sağlayıcının temel URL'si zaten `/models` ile bitiyordu | `baseUrl` olarak API kökünü kullanın; keşif yolunu eklemeyin |
| Model araması başarısız | Köprü tam bir canlı katalog sunmuyor | `liveModels: false` ayarlayın ve sabit bir `models` listesi sağlayın |
| Geri döngü sağlayıcısı reddediliyor | Özel ağ erişimi varsayılan olarak reddedilir | `allowPrivateNetwork: true` değerini yalnızca geri döngü köprüsü için ayarlayın |
| `${DROID_BRIDGE_TOKEN}` çözümlenemiyor | Değişken opencodex servis ortamında yok | Onu yalnızca etkileşimli kabuğa değil, servis sürecine ekleyin |
| `OutputTextDelta without active item` | Köprü, çıktı öğesi ve içerik parçasını açmadan önce metin farkı yayımladı | Tam Responses SSE yaşam döngüsünü sırayla yayımlayın |

Dolayısıyla aynı Factory kimlik bilgisi `droid exec` içinde çalışırken belgelenmemiş LLM URL'sine doğrudan istek yine `403` döndürebilir. Bu sonuçlar farklı ürünleri sınar; çelişki sayılmamalıdır.

## Ön koşullar

1. [Droid CLI'ı](https://docs.factory.ai/droid-cli/quickstart) kurup oturum açın.
2. Sınırlı ve etkileşimsiz bir isteğin çalıştığını doğrulayın:

   ```bash
   droid exec --model glm-5.2 --output-format json "Reply with DROID_OK only."
   ```

3. `droid exec` (veya resmî Droid SDK) çağıran ve aşağıdakileri sunan yerel bir köprü çalıştırın:

   - `GET /healthz`
   - `GET /v1/models`
   - `POST /v1/responses`

Factory, `droid exec` komutunu etkileşimsiz otomasyon yüzeyi olarak belgeler ve betikler için JSON çıktısı önerir. Daha uzun ömürlü entegrasyon için [Droid Exec rehberinde](https://docs.factory.ai/droid-exec/overview) akış JSON-RPC ile resmî TypeScript ve Python SDK'larını da belgeler.

## Köprü sözleşmesi

Köprüyü `127.0.0.1` adresine bağlayın, rastgele üretilmiş bir bearer belirteci isteyin, istek boyutlarını sınırlayın ve model kimlikleri için izin listesi kullanın. En küçük köprü, Responses `input` alanının yalnızca şu biçimlerini kabul eder:

- boş olmayan bir dize; veya
- yalnızca `message` öğelerinden oluşan dizi. Her iletinin `user`, `developer`, `system` veya `assistant` rolü ve dize içerik ya da yalnızca metin içeren parçaları (girdi rolleri için `input_text`, asistan geçmişi için `output_text`) olmalıdır.

Droid'i çağırmadan önce isteğin tamamını doğrulayın. Girdi parçası görsel veya dosyaysa, `tools` herhangi bir araç tanımı içeriyorsa ya da `input` bir araç çağrısı veya sonucu (`function_call`, `function_call_output`, `custom_tool_call` veya `custom_tool_call_output`) içeriyorsa Responses biçiminde bir `invalid_request_error` ile HTTP `400` döndürün. `unsupported_bridge_input` gibi kararlı, köprüye özgü bir kod kullanın ve iletide reddedilen alanı belirtin. `stream: true` olsa bile bunu SSE'yi başlatmadan önce yapın; desteklenmeyen içeriği asla atmayın, dizeye çevirmeyin veya isteme düzleştirmeyin.

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "unsupported_bridge_input",
    "param": "tools",
    "message": "The minimal Droid bridge does not accept tool definitions."
  }
}
```

Kabul edilen istekte köprü şunları yapmalıdır:

1. kabul edilen Responses `input` alanını bir isteme dönüştürmek;
2. `droid exec --model <id> --output-format json <prompt>` çağırmak;
3. son `result` ve `session_id` değerlerini ayrıştırmak;
4. bir OpenAI Responses zarfı döndürmek; ve
5. devam gerektiğinde `previous_response_id` değerini Droid oturum kimliğiyle eşlemek.

Akış yanıtlarında şu yaşam döngüsünü sırayla yayımlayın:

```text
response.created
response.output_item.added
response.content_part.added
response.output_text.delta
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
```

Köprüyü `0.0.0.0` üzerinden sunmayın ve Factory kimlik bilgisini köprünün bearer belirteci olarak yeniden kullanmayın.

## OpenCodex sağlayıcı yapılandırması

`droid` kimliğini açıkça belirterek özel sağlayıcıyı oluşturun:

```bash
ocx provider add droid \
  --adapter openai-responses \
  --base-url http://127.0.0.1:11435/v1 \
  --default-model glm-5.2 \
  --allow-private-network
```

Bu, `providers.droid` yapılandırma girdisini oluşturur. Kontrol panelinde **Providers → droid → Edit JSON** bölümünü açıp bu sağlayıcının değerini şununla değiştirin:

```json
{
  "adapter": "openai-responses",
  "baseUrl": "http://127.0.0.1:11435/v1",
  "responsesPath": "/responses",
  "allowPrivateNetwork": true,
  "authMode": "key",
  "apiKey": "${DROID_BRIDGE_TOKEN}",
  "liveModels": false,
  "models": ["glm-5.2", "glm-5.2-fast", "kimi-k3"],
  "defaultModel": "glm-5.2"
}
```

Model kimlikleri örnektir. Yalnızca `droid exec` komutunun oturum açılan Factory hesabıyla kullanabildiği modelleri tutun. Bu sağlayıcıya Factory'ye özgü çıkarım başlıkları eklemeyin: yukarı akış hedefi Factory HTTP uç noktası değil, yerel köprüdür.

Sağlayıcıyı kaydettikten veya sabit kataloğunu değiştirdikten sonra, yeni oturumların güncellenmiş kataloğu okuması için Codex'i eşitleyip yeniden başlatın:

```bash
ocx sync --restart-codex
ocx doctor
```

`--restart-codex`, eşleşen app-server süreçlerini yeniden başlatır ve Codex masaüstü uygulamasını tamamen kapatıp yeniden açar; canlı konuşmalar sona erer. Masaüstü uygulaması çalışmaya devam etsin istiyorsanız `--restart-app-server-only` kullanın. Yeniden başlatmayı yalnızca bu oturumları bitirdikten veya kaydettikten sonra çalıştırın.

## Tam rotayı doğrulama

Her sınırı ayrı ayrı denetleyin:

```bash
curl -fsS http://127.0.0.1:11435/healthz
ocx doctor
ocx access test droid/glm-5.2 --protocol responses
```

Sağlayıcı satırı veya model seçici girdisi yalnızca katalogda göründüğünü kanıtlar. Entegrasyon, Responses probu `droid/<model>` rotası üzerinden döndükten sonra çalışıyor sayılır.

## Geçerli sınırlama

Yukarıdaki en küçük köprü metni ve Responses SSE yaşam döngüsünü çevirir. Tam çift yönlü Codex işlev/araç çağrısı protokolünü **uygulamaz**. Codex App ve `codex exec`, istem araç çağırmamasını söylese bile normalde araç tanımları gönderir; geçerli Codex CLI'da bu tanımları kaldıran genel bir bayrak yoktur. En küçük köprü, bu istekleri yukarıdaki `400` sözleşmesiyle reddetmelidir. Araç tanımları, araç çağrıları, araç sonuçları, izinler, iptal ve zengin Droid olayları, Factory'nin akış JSON-RPC modu veya resmî bir Droid SDK üzerine kurulu durum bilgisi tutan köprü gerektirir. `ocx access test` başarısını Codex ajan veya araç yolu doğrulaması değil, metin yolu doğrulaması olarak değerlendirin.
