---
title: Model Yönlendirme
description: opencodex'in belirli bir model kimliğine hangi sağlayıcının hizmet vereceğine nasıl karar verdiği.
---

Codex bir model istediğinde, `router.ts` bunu tam olarak bir yapılandırılmış
sağlayıcıya çözer. Kurallar **sırayla** denetlenir; ilk eşleşen kazanır.

OpenAI için, yapılandırılmış bir `<seçici>/gpt-*` kimliği, kombo veya sağlayıcı
ad alanları değerlendirilmeden önce `codexAccountNamespaces` aracılığıyla tam
olarak bir saklanan Codex hesabına eşlenir. Yalın `gpt-*` kimlikleri bunun
yerine kurallı `openai` sağlayıcısını seçer. `codexAccountMode`, model kimliğini
değiştirmeden Pool (varsayılan, ana artı eklenen hesaplar) veya Direct (geçerli
arayan/ana taşıyıcı) seçer. `openai-apikey/<model>` açıkça API anahtarı
aktarımını seçer. Bu kimlik bilgisi rotaları birbirine geri dönmez (fall through
yapmaz).

## Öncelik Sırası

1. **Tam Codex hesap seçicisi** — kimlik `<seçici>/<yerel-openai-modeli>` ise ve
   seçici `codexAccountNamespaces` içinde yapılandırılmışsa, istek yalnızca
   eşlenen saklanan hesabı kullanır ve yalın yerel modeli yukarı akışa gönderir.
   Kullanılamayan tam hedefler, Pool, Direct veya sağlayıcı yönlendirmesi
   üzerinden devam etmek yerine kapalı olarak başarısız olur.

   ```text
   side/gpt-5.6-sol → sağlayıcı "openai", model "gpt-5.6-sol", hesap seçicisi "side"
   ```

2. **Kombo kimliği veya takma adı** — en az bir kombo yapılandırılmışken,
   kurallı bir `combo/<kimlik>` veya yapılandırılmış kombo takma adı, sağlayıcı
   ad alanları denetlenmeden önce somut hedefini seçer. Yapılandırılmış hiçbir
   kombo olmadığında, kelimenin tam anlamıyla `combo` olarak adlandırılan eski
   bir fiziksel sağlayıcı normal bir sağlayıcı ad alanı olarak kalır. Hedef
   seçimi ve yük devretme davranışı için [Kombolar](/tr/guides/combos/)
   sayfasına bakın.

3. **Açık `sağlayıcı/model`** — kimlik `/` içeriyorsa ve ondan önceki kısım
   yapılandırılmış bir sağlayıcının adıysa, o sağlayıcı kullanılır ve kimlik
   eğik çizgiden sonraki kısma indirgenir.

   ```text
   anthropic/claude-opus-5     →  sağlayıcı "anthropic",   model "claude-opus-5"
   ollama-cloud/glm-5.2        →  sağlayıcı "ollama-cloud", model "glm-5.2"
   openrouter/openai/gpt-5.6-sol → sağlayıcı "openrouter",  model "openai/gpt-5.6-sol"
   ```

Bu, açık yönlendirilen sağlayıcı formudur ve Codex'in model seçicisinin
yönlendirilen modeller için kullandığı formdur. Aynı genel kimlik
yapılandırılmış bir kombo takma adıysa kural 2 kazanır. Adlandırılmış sağlayıcı
devre dışı bırakılmışsa bu açık form yönlendirmek yerine hata fırlatır.

4. **Yalın yerel OpenAI ailesi kimliği** — `gpt-*`, `o1-*`, `o3-*` veya `o4-*`
   gibi bir kimlik, kurallı etkinleştirilmiş `openai` sağlayıcısını ve onun
   yapılandırılmış Pool veya Direct hesap modunu kullanır.

5. **Bir sağlayıcının `defaultModel`'i** — herhangi bir sağlayıcının
   `defaultModel`'i kimliğe eşitse, o sağlayıcı kullanılır (kimlik
   değiştirilmeden iletilir).

6. **Yerleşik önek desenleri** — kimlik bilinen model ailesi önekleriyle
   eşleştirilir, ardından bu addaki (veya ad önekindeki) yapılandırılmış bir
   sağlayıcıya yönlendirilir:

   | Önekler | Sağlayıcı |
   | --- | --- |
   | `claude-`, `claude-sonnet-`, `claude-opus-`, `claude-haiku-` | `anthropic` |
   | `llama-`, `mixtral-`, `gemma-` | `groq` |

Bu eşleştirici ada dayalıdır ve `defaultModel` / `models[]` taramalarından
farklı olarak şu anda `disabled` bayrağı true olan eşleşen bir sağlayıcıyı
filtrelemez.

7. **Bir sağlayıcının `models[]`'i** — hiçbir önek kuralı kazanmadıysa ve aktif
   bir sağlayıcı kimliği kendi `models[]` içinde listeliyorsa, o sağlayıcı
   kullanılır. Kural 4, başka bir sağlayıcının `models[]` iddiası eşleşmeden
   önce yalın bir `gpt-*` kimliğini zaten kurallı etkinleştirilmiş `openai`
   sağlayıcısına gönderir.

8. **Varsayılan sağlayıcı** — hiçbir şey eşleşmediyse kimlik değiştirilmeden
   `config.defaultProvider`'a gönderilir. (Hiçbir varsayılan sağlayıcı
   yapılandırılmamışsa veya devre dışıysa yönlendirme hata fırlatır.)

## API anahtarları ve ortam değişkenleri

Hangi rota seçilirse seçilsin sağlayıcının `apiKey`'i `resolveEnvValue()`
aracılığıyla çözümlenir: istek zamanında ortamdan `${OPENAI_API_KEY}` veya
`$OPENAI_API_KEY` değeri genişletilir, bu nedenle sırların asla `config.json`
içinde yaşaması gerekmez.

## Katalog görünürlüğü ve bağlam sınırları

Yönlendirme ve katalog görünürlüğü ayrı kontrollerdir:

- `disabledModels`, ad alanlı yönlendirilen kimlikleri Codex kataloğundan ve
  `/v1/models` listesinden gizler; yalın bir yerel GPT slug'ı `visibility:
  "hide"` ile katalogda tutulur. Bu model için doğrudan bir isteği
  **reddetmez**.
- Bir sağlayıcının boş olmayan `selectedModels` alanı başka bir katalog izin
  listesidir. Canlı keşif ve doğrudan yönlendirme hala çalışır; yalnızca katalog
  ve `/v1/models` yayını daraltılır.
- `provider.disabled: true`, bu sağlayıcıyı katalog keşfinden kaldırır. Açık
  `sağlayıcı/model` istekleri başarısız olur ve `defaultModel` / `models[]`
  taramaları bunu atlar.
- `providerContextCaps`, sağlayıcı başına Codex tarafından görülebilen bağlam
  sınırlarını uygular. `contextCapValue` kontrol paneli varsayılanıdır
  (varsayılan olarak 350.000), ancak bir sağlayıcı `providerContextCaps` içinde
  yer alana kadar tek başına hiçbir şey yapmaz. Kontrol paneli değerini
  değiştirmek, yalnızca "tüm yönlendirilen sağlayıcılara uygula" açık olduğunda
  etkinleştirilmiş her sağlayıcıyı yeniden yönlendirir; aksi takdirde her
  sağlayıcı kendi sınırını korur. Sınırlar yalnızca bilinen bir bağlam
  penceresini düşürür; asla bir pencereyi yükseltmez veya yukarı akış modelinin
  gerçek sınırını değiştirmez.

```json
{
  "contextCapValue": 350000,
  "providerContextCaps": {
    "anthropic": 350000,
    "cursor": 350000
  }
}
```

## İpuçları

- `<seçici>/<yerel-openai-modeli>` ile **açıkça bir Codex hesabını hedefleyin**
  (kural 1). Bu rota tamdır ve kapalı olarak başarısız olur; asla sessizce başka
  bir hesaba geçmez.
- **Yönlendirilen modeller için açık olun.** Bu tam genel kimlik bir kombo takma
  adı olmadığında `sağlayıcı/model`'i (kural 3) tercih edin. Doğrudan
  sağlayıcıyı adlandırır ve katalog senkronizasyonundan sonra Codex'in
  seçicisinde gösterdiği şeyle eşleşir.
- Bir sağlayıcıda **`models[]` veya `defaultModel` tohumlayın**, böylece kısa
  kimlikler (kurallar 5/7) `sağlayıcı/` öneki olmadan çözümlenir.
- **Önek desenleri bir kolaylıktır**, bir garanti değildir: yalnızca bu adda bir
  sağlayıcı (örneğin `anthropic` veya `groq`) gerçekten yapılandırılmışsa
  çözümlenirler.

Bu kuralların okuduğu sağlayıcı alanları için
[Yapılandırma](/tr/reference/configuration/) sayfasına bakın.


