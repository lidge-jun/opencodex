---
title: Model Sıralaması
description: opencodex'in Codex seçicisindeki ve spawn_agent model geçersiz kılmalarındaki model sırasını nasıl belirlediği.
---

Codex model seçicisi, opencodex yapılandırmasındaki sağlayıcı bildirimlerinin
veya model dizilerinin sırasını korumaz. Nihai sırası, aynı önceliği paylaşan
yönlendirilmiş modeller için belirleyici bir alfabetik sırayla birlikte katalog
önceliklerinden gelir.

## Codex'in uyguladığı kural

Codex'in models-manager'ı, seçicide görünen katalog girdilerini artan sırada
`priority`'ye göre sıralar. Katalog dizi sırasını atar, bu nedenle oluşturulan
bir JSON dizisinde bir girdiyi daha öne taşımak onu seçicide daha öne taşımaz.
Uygulama bu kısıtlamayı doğrudan `src/codex/catalog/sync.ts` içine kaydeder.

Bu nedenle opencodex, dizi konumuna güvenmek yerine daha düşük öncelikler
atayarak öne çıkan yerleşimi denetler. Aksi belirtilmedikçe, aşağıdaki sabit
öncelikler ve işlenmiş örnek, uygun Codex hesap seçicisi olmayan bir kataloğu
açıklar. `N` uygun seçici ile öne çıkan öncelikler adım olarak `N` kullanır:
yapılandırılmış `i` derecesindeki yalın bir yerel seçenek, `j` seçicinin sıfır
tabanlı konumu olmak üzere `i * N + j` önceliklerinde seçici satırlarına
genişler; yönlendirilmiş bir seçenek `i * N` kullanır; ve tam bir seçici
nitelikli seçenek seçicisi için `i * N + j` kullanır. Seçilmeyen yönlendirilmiş
satırlar bu seçici gruplarının dışına taşınır. Codex yine de yalnızca seçicide
görünen ilk beş satırı tanıtır.

İlgili seçicisiz öncelikler şunlardır:

| Katalog girdisi | Öncelik | Kaynak |
| --- | ---: | --- |
| `subagentModels[i]` | `i` (`0` - `4`) | `src/codex/catalog/sync.ts` içindeki öne çıkan sıra haritası |
| Diğer yönlendirilen modeller | `5` | `src/codex/catalog/sync.ts` içindeki yönlendirilen girdi oluşturma |
| Varsayılan olarak yerel GPT slug'ları | `9` | `src/codex/catalog/sync.ts` içindeki yerel girdi oluşturma |
| Öne çıkan bir liste varken seçilmeyen yerel modeller | En az `featured.length + 100` | `src/codex/catalog/sync.ts` içindeki yerel katalog birleştirme |

Yönetim API'si `src/server/management/agent-settings-routes.ts` içinde `slice(0,
5)` ile `subagentModels`'ı beş girdiyle sınırlar. Bu, yalnızca ilk beş model
geçersiz kılmasını tanıtan Codex `spawn_agent` yüzeyiyle eşleşir. Bu beş modelin
dışındaki modeller ana seçicide görünür kalabilir ve tam kimlikleriyle
çağrılabilir.

## Eşitlikler nasıl sıralanır?

Tüm sıradan yönlendirilen modellerin önceliği `5`'tir, bu nedenle bir eşitlik
bozucuya ihtiyaçları vardır. Katalog girdileri oluşturulmadan önce
`gatherRoutedModels()`, yönlendirilen model listesini sağlayıcı adına ve
ardından model kimliğine göre alfabetik olarak sıralar
(`src/codex/catalog/provider-fetch.ts`).

Bu, aşağıdaki yapılandırma ayrıntılarının hiçbirinin nihai sırayı değiştirmediği
anlamına gelir:

- `providers` nesnesindeki anahtarların bildirim sırası;
- bir sağlayıcının `models` dizisindeki kimliklerin sırası.

`orderForSubagents()` daha sonra yapılandırılmış öne çıkan seçimleri
`subagentModels` ile aynı sırada öne taşımak için kararlı bir sıralama kullanır.
Öne çıkmayan modeller daha önce belirlenen sağlayıcı/kimlik alfabetik göreli
sırasını korur (`src/codex/catalog/sync.ts`). Girdiler oluşturulduğunda öne
çıkan sıra da `0` ile `4` arasındaki önceliklere dönüştürülür, böylece Codex'in
öncelik sıralaması bu öndeki diziyi korur.

## Görünürlük sıralamadan ayrıdır

`selectedModels` ve `disabledModels` hangi yönlendirilen modellerin
gösterileceğine karar verir; bunlar sıralama denetimleri değildir.
`filterCatalogVisibleModels()` her iki seçimi de `Set` aramalarına dönüştürür ve
dizileri sıra olarak kullanmadan toplanan listeyi filtreler
(`src/codex/catalog/provider-fetch.ts`).

Sonuç olarak `selectedModels` veya `disabledModels`'ı yeniden sıralamanın seçici
konumu üzerinde hiçbir etkisi yoktur. Yalnızca bir modelin dahil edilip
edilmediğini değiştirebilir.

## Geçerli seçici deseni

Uygun hesap seçicisi olmadığında ve boş olmayan bir öne çıkanlar listesi
olduğunda ortaya çıkan sıra şöyledir:

1. `0` ile `4` arasındaki önceliklerle tam olarak yapılandırılmış
   `subagentModels` sırasındaki modeller.
2. `5` önceliğinde sağlayıcıya ve ardından model kimliğine göre alfabetik olarak
   sıralanmış kalan tüm yönlendirilen modeller.
3. Katalog birleştirme sırasında öne çıkan bloğun altına itilen seçilmemiş yerel
   modeller.

`subagentModels` olmadan yönlendirilen modeller `5` önceliğinde kalır, yerel GPT
girdileri normal önceliklerini kullanır (opencodex tarafından oluşturulan
girdiler için normalde `9`) ve yönlendirilen grup sağlayıcı/kimlik olarak
alfabetik kalır.

## Örnek

`subagentModels`'ın bu beş kimliği tam olarak bu sırada içerdiğini varsayalım:

```toml
subagentModels = [
  "gpt-5.5",
  "opencode-go/glm-5.2",
  "anthropic/claude-opus-4-6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]
```

Seçici aşağıdaki gibi başlar:

| Seçici konumu | Model | Öncelik | Neden orada görünüyor? |
| ---: | --- | ---: | --- |
| 1 | `gpt-5.5` | `0` | İlk `subagentModels` seçimi |
| 2 | `opencode-go/glm-5.2` | `1` | Sağlayıcısı `anthropic`'ten sonra sıralansa bile ikinci seçim |
| 3 | `anthropic/claude-opus-4-6` | `2` | Üçüncü seçim |
| 4 | `gpt-5.6-sol` | `3` | Dördüncü seçim |
| 5 | `gpt-5.6-terra` | `4` | Beşinci seçim |
| 6 | `anthropic/claude-fable-5` | `5` | Sağlayıcı/kimlik alfabetik sırasına göre kalan ilk yönlendirilen kimlik |
| 7 ve sonrası | Kalan yönlendirilen modeller | `5` | Alfabetik olarak sağlayıcı, ardından alfabetik olarak model kimliği |
| Yönlendirilen modellerden sonra | Kalan yerel modeller | `featured.length + 100` veya üzeri | Seçilmemiş yereller öne çıkan bloğun altına taşınır |

İlk beş girdi `spawn_agent`'a tanıtılan geçersiz kılmalardır; geri kalanı normal
seçici sırasında devam eder. Hesap seçicileriyle beş girdi sınırı, yalın yerel
seçimler seçici nitelikli gruplara genişletildikten sonra geçerlidir.

## Sırayı değiştirme

Öndeki model sırasını özelleştirmenin desteklenen yolu `subagentModels`'ı
yeniden sıralamaktır. Kontrol panelinin **Alt Ajanlar** sayfası yalın yerel ve
yönlendirilen kimlikleri yeniden sıralayabilir. Tam
`<seçici>/<yerel-openai-modeli>` seçimleri için `ocx agent subagents set`
kullanın veya opencodex yapılandırmasını düzenleyin; kontrol paneli bu seçimleri
listelemez ve kadroyu kaydederse bunları atlar. En fazla beş yapılandırılmış
kimlik kullanın. Hesap seçicileriyle tek bir yalın yerel seçenek birden çok
seçici nitelikli katalog satırına genişleyebilir, bu nedenle yapılandırılmış
seçimler ve tanıtılan satırlar birebir olmak zorunda değildir.

Şu anda `OcxConfig` içinde genel bir `modelOrder`, `providerOrder` veya öncelik
haritası ayarı yoktur. Desteklenen sıralama alanı `subagentModels`'dır;
`disabledModels` ve her sağlayıcının `selectedModels` alanı görünürlük
alanlarıdır. Kalan seçici sırasını değiştirmek bir yapılandırma düzenlemesinden
ziyade kod düzeyinde bir davranış değişikliği gerektirir.


