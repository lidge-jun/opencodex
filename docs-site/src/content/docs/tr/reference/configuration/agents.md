---
title: Ajan Yapılandırması
description: Çoklu ajan yüzeyleri, yetkilendirme rehberliği, tercih edilen modeller, geri dönüş zincirleri, yerel varsayılan senkronizasyonu ve çaba sınırları.
---

Ajan ayarları hangi Codex işbirliği yüzeyinin tanıtılacağını ve opencodex'in
devredilen işleri nasıl yönlendireceğini, yönlendireceğini ve sınırlayacağını
kontrol eder.

## Ajan alanları

| Alan | Tip | Varsayılan | Anlamı |
| --- | --- | --- | --- |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | `v1` her katalog modelini v1 olarak damgalar; `v2` her modeli v2 olarak damgalar. `default` yukarı akış sabitlemelerini geri yükler (Sol/Terra v2, Luna v1) ve aksi takdirde yerel `multi_agent_v2` bayrağını takip eder. Yeni oturumlara uygulanır. |
| `subagentModels?` | `string[]` | `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.4-mini` | Alt ajan seçicisinde ilk olarak öne çıkan en fazla beş yalın yerel, hesap nitelikli `<secici>/<yerel-openai-modeli>` veya yönlendirilen `saglayici/model` kimliği. Kontrol paneli yalnızca yalın yerel ve yönlendirilen kimlikleri sunar ve kaydederken tam hesap nitelikli seçimleri atlar; tam seçimler için `ocx agent subagents set` kullanın veya yapılandırmayı düzenleyin. Açık bir boş liste korunur. |
| `injectionModel?` | `string` | — | Proxy kaynaklı v2 yetkilendirme rehberliğinde kullanılan tercih edilen yerel veya yönlendirilen alt ajan modeli. |
| `injectionEffort?` | `string` | — | Yalnızca `injectionModel` ile anlamlı olan tercih edilen çaba (`low` ile `ultra` arası). |
| `injectionPrompt?` | `string` | — | Yerleşik v2 rehberlik gövdesinin yerini alır. `{{model}}`, `{{effort}}`, `{{roster}}` ve `{{fallback}}` destekler. Yapılandırılmış bir `injectionModel`, özel istemi oluşturmak için yeterlidir. |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | Yalnızca opencodex kaynaklı v1/v2 geliştirici rehberliğini denetler; yerel ajan varsayılanlarını, araçları, yönlendirmeyi, kadroları veya çaba sınırlarını değiştirmez. |
| `syncCodexSubagentDefaults?` | `boolean` | `false` | Senkronizasyon/yeniden başlatma sırasında `injectionModel` ve isteğe bağlı `injectionEffort`'ı Codex'in yerel varsayılanları olarak yazmayı etkinleştirin. `injectionModel` gerektirir. |
| `subagentModelFallback?` | `string[]` | `[]` | Oluşturulan çocuk turları için öncelik sıralı küresel geri dönüş modelleri. |
| `subagentModelFallbackByModel?` | `Record<string, string[]>` | `{}` | İstenen birincil model kimliğine göre anahtarlanan birincil model başına geri dönüş zincirleri. Bu, rol başına geri dönüş meta verileri için desteklenen yerdir; Codex ajan TOML içindeki `model_fallback`, Codex 0.146+'nın rolü atlamasına neden olur (#1190). |
| `subagentModelFallbackPollMs?` | `number` | `60000` | Kullanılabilirlik probu önbellek aralığı. 1000 ms'nin altındaki değerler varsayılana geri döner. |
| `effortCap?` | `string` | — | Uygun v2 ana turları ve işaretlenmiş çocuk turları için kesin tavan. `low` ile `ultra` arasını kabul eder. |
| `subagentEffortCap?` | `string` | — | Yalnızca oluşturulan çocuk turları için ek tavan. Her iki sınır da geçerli olduğunda daha düşük olan kazanır. |
| `agentTaskRecovery?` | `object` | — | Yönlendirilen sağlayıcılara gönderilen arka uçta şifrelenmiş v2 görevleri için deneysel isteğe bağlı kurtarma. `enabled: true` olmadıkça devre dışıdır; bkz. [Şifrelenmiş v2 görev kurtarma](#sifrelenmis-v2-gorev-kurtarma). |

Arayüzü kontrol paneli veya `ocx v2 status|on|off|mode <v1|default|v2>|threads
<n>|mode-hint <metin|--clear>` ile yönetin. Mod değişiklikleri yeni oturumlara
uygulanır. `maxConcurrentThreadsPerSession`, bir `config.json` anahtarı değil,
bir `PUT /api/v2` alanıdır; `ocx v2 threads <n>`, v2 etkinleştirildikten sonra
Codex'in `$CODEX_HOME/config.toml` dosyasındaki `[features.multi_agent_v2]`
altına `max_concurrent_threads_per_session` yazar.

**Ultra modu** (Alt Ajanlar kontrol paneli anahtarı, `PUT /api/v2` alanı
`multiAgentModeHintText` ve `ocx v2 mode-hint`), Codex'in
`$CODEX_HOME/config.toml` dosyasında
`features.multi_agent_v2.multi_agent_mode_hint_text` yazar. CLI `ocx v2
mode-hint` komutu, `multi_agent_v2` devre dışı bırakıldığında bile bu anahtarı
kalıcı hale getirir; özelliği açıp kapatmaz. İpucu, codex-rs'in çabadan
türetilen çoklu ajan politikasını geçersiz kılar, böylece herhangi bir model ve
herhangi bir akıl yürütme çabası Proaktif yetkilendirme istemini alır; akıl
yürütme çabasını **değiştirmez**. Bir `null` değeri anahtarı kaldırır, böylece
çabadan türetilen politika (ultra = proaktif, aksi takdirde açık) devam eder;
boş veya yalnızca boşluk içeren değerler reddedilir çünkü mevcut bir boş
geçersiz kılma ultra kaynaklı Proaktif mesajı bile bastırır. Alt Ajanlar kontrol
panelinin Ultra modu **açık** anahtarı hem yerel özelliği hem de açık bir v2
yüzeyini (`multiAgentMode: "v2"`, `ocx v2 mode v2` ile eşdeğer) gerektirir; tek
başına `ocx v2 on` bu kontrol paneli geçidini karşılamaz.

Yönetim API'si `GET`/`PUT /api/v2`, `/api/injection-model`, `/api/effort-caps`,
`/api/subagent-models` ve `/api/subagent-model-fallback` uç noktalarını sunar.
Enjeksiyon modeli güncellemeleri kısmidir; özel istem bu API'deki `prompt`
alanıdır.

Codex Auth sayfası ayrıca Codex'in kendi `default_mode_request_user_input`
özellik bayrağını açıp kapatabilir (`GET`/`PUT
/api/codex-auth/features/default-mode-request-user-input`). Bunu etkinleştirmek,
resmi `codex features enable|disable` CLI'sı aracılığıyla Codex'in
`$CODEX_HOME/config.toml` dosyasına `[features] default_mode_request_user_input
= true` ekler (formatı koruyan düzenleme, devre dışı bırakıldığında tekrar
kaldırılır), bu da Codex'in bir Varsayılan mod oturumunu duraklatmasına ve
`request_user_input` aracıyla size sorular sormasına olanak tanır. Bayrak yukarı
akışta geliştirilme aşamasındadır ve yalnızca yeni oturumlara uygulanır; yüklü
Codex derlemesi bayrağı henüz tanımadığında anahtar yüksek sesle başarısız olur.

## Kadro ve rehberlik

Geçerli v2 kadrosu, yapılandırılmış, seçicide görünen, önceliğe göre sıralanmış,
v2 ile uyumlu ve enjekte edilen katalogda bulunan ilk beş modeldir. V2
uygunluğu, açık bir `"v2"`, `null` veya bulunmayan yukarı akış sabitlemesini
uygun olarak değerlendirir; gerçek bir `"v1"` sabitlemesi hariç tutulur. Hariç
tutulan girdiler daha sonra uygun olabilmeleri için yapılandırmada kalır.

Arayüz algılama araç şeklini kullanır. `send_input`, `resume_agent` veya
`close_agent` içeren ad alanlı bir `spawn_agent` v1'dir. `send_message`,
`followup_task`, `interrupt_agent` veya `list_agents` içeren düz bir
`spawn_agent` v2'dir.

V1 rehberliği yalnızca `max` veya `ultra` çabada proaktif metindir. V2, yalnızca
tercih edilen bir model, uygun kadro veya geri dönüş zinciri mevcut olduğunda
proxy kaynaklı bir geliştirici mesajı alır. Yerleşik v2 rehberliğinin 700
karakterlik bir bütçesi vardır ve gerekirse önce kadroyu bırakır. Rehberlik
yeniden oynatma önekleri genelinde tekilleştirilir ve sondaki
`compaction_trigger`'dan önce eklenir.

`injectionModel` ve `injectionEffort`, yerel varsayılan senkronizasyonu
etkinleştirilmedikçe tavsiye niteliğindedir. Yerleşik v2 metni Codex'ten
`fork_turns: "none"` ile `spawn_agent`'a desteklenen model/çaba geçersiz
kılmalarını iletmesini ister. Özel bir `injectionPrompt`, eksik değerleri boş
bir dizeyle değiştirir.

## Yerel Codex varsayılan senkronizasyonu

Etkinleştirildiğinde `syncCodexSubagentDefaults`, işaretçi sahipliğindeki
`[agents] default_subagent_model` ve `default_subagent_reasoning_effort`
alanlarını yazar. Kullanıcıya ait işaretlenmemiş mevcut hedef alanları çakışma
olarak değerlendirilir ve yetkili kalır; kısmi veya belirsiz TOML yazımları
kapalı olarak başarısız olur. `injectionModel`'ı temizlemek katılımı da
temizler. Bu varsayılanlar yeni oluşturulan Codex görevlerini etkiler ve
kendileri yetkilendirmeye neden olmaz.

## Geri dönüş zinciri

Oluşturulan çocuk geri dönüş sırası şöyledir:

1. istenen birincil model;
2. `subagentModelFallbackByModel`'dan model başına zincirler (birincil modelle
   anahtarlanan); ardından
3. küresel `subagentModelFallback` girdileri.

Rol başına geri dönüş zincirleri opencodex yapılandırmasında yer almalıdır.
`$CODEX_HOME/agents/*.toml` içine `model_fallback` yazmak Codex 0.146+'nın tüm
rol dosyasını bilinmeyen bir alan olarak reddetmesine ve rolü atlamasına neden
olur (#1190). TOML'daki eski bir `model_fallback` satırı geriye dönük uyumluluk
için hala okunur, ancak `ocx doctor` bunu bayraklar.

opencodex devre dışı bırakılmış, yönlendirilemez, sağlıksız, soğumada olan veya
kota eşiği adaylarını atlar. Kullanılabilirlik anlık görüntüsü
`subagentModelFallbackPollMs` boyunca önbelleğe alınır. Şifrelenmiş çocuk
görevleri zinciri kurallı yerel ChatGPT hedefleriyle kısıtlayabilir; hiçbiri
şifrelenmiş yükü okuyamazsa istek okunamayan şifreli metni başka bir yere
yönlendirmek yerine başarısız olur.

```json
{
  "multiAgentMode": "v2",
  "subagentModels": ["gpt-5.5", "anthropic/claude-sonnet-5"],
  "injectionModel": "gpt-5.5",
  "injectionEffort": "high",
  "syncCodexSubagentDefaults": true,
  "subagentModelFallback": ["gpt-5.4-mini"],
  "subagentModelFallbackByModel": {
    "gpt-5.5": ["gpt-5.4-mini"]
  },
  "subagentModelFallbackPollMs": 60000,
  "subagentEffortCap": "high"
}
```

## Şifrelenmiş v2 görev kurtarma

`agentTaskRecovery`, yönlendirilen bir v2 çocuğu oluşturan yerel bir ChatGPT
ebeveyni için deneysel bir uyumluluk yoludur. Varsayılan olarak devre dışıdır.
Açıkça etkinleştirildiğinde ve nihai yönlendirilen çocuk görevi aksi takdirde
okunamayan bir Fernet yükü içerdiğinde, opencodex iletme modu kimlik
doğrulamasıyla sabit `https://chatgpt.com/backend-api/codex/responses` uç
noktasına ham bir Responses doğrudan geçiş isteği kullanır. ChatGPT düz metin
görevini zorunlu bir fonksiyon çağrısı aracılığıyla döndürür; opencodex daha
sonra yönlendirilen sağlayıcı dağıtımından önce yalnızca bu görev öğesini
standart bir kullanıcı mesajına dönüştürür.

Bu yerel şifre çözme değildir ve Codex hat protokolünü düzeltmez. Belgelenmemiş
ChatGPT arka uç davranışına bağlıdır ve bir arka uç değişikliğinden sonra
çalışmayı durdurabilir. Kurtarılan görev model çıktısıdır, kriptografik olarak
doğrulanmış bir düz metin değildir, bu nedenle bayt bayt doğruluk garanti
edilmez. Kapsamlı bir önbellek ıskalaması kimliği doğrulanmış bir ChatGPT isteği
ekleyebilir, hesap kotasını tüketebilir ve yönlendirilen istekten önce gecikme
ekleyebilir. Aynı kapsamlı görev için eşzamanlı istekler bir kurtarma isteğini
paylaşır. Başlangıç, özellik her etkinleştirildiğinde bir uyarı yazdırır.

Kabul ve saklama kasıtlı olarak dardır:

- kurtarma yalnızca proxy geri döngüye bağlıyken kullanılabilir;
- yalnızca eşleşen bir ChatGPT taşıyıcı/hesap çiftine sahip yerel bir Codex
  arayanı uygundur. Bu, `authMode: "forward"` ile kurallı `openai` sağlayıcısı
  tarafından kullanılan kimlik bilgisi şeklidir; kurtarma yalnızca gelen
  istekteki çifti kullanır ve asla API anahtarı kimlik doğrulamasının, başka bir
  sağlayıcı kimlik bilgisinin veya başka bir Codex hesabının yerine geçmez;
- `x-opencodex-api-key`, `x-api-key`, genel API kimlik bilgileri veya bir proxy
  kabul sırrı kullanan arayanlar mevcut `unreadable_encrypted_agent_task`
  hatasını korur;
- ham ChatGPT kimlik bilgileri yalnızca sabit kodlanmış ChatGPT uç noktasına
  gönderilir ve istek gövdesine, günlüklere, önbellek anahtarlarına veya
  sağlayıcı isteğine asla yerleştirilmez; bellek içi önbellek kapsamı yalnızca
  arayan kimlik bilgisinin ve hesabının süreç açısından rastgele anahtarlanmış
  bir özetini kullanır;
- kurtarma isteği yalnızca `authorization`, eşleşen `chatgpt-account-id`,
  `originator` ve isteğe bağlı `openai-beta` ve `user-agent` meta verilerini
  iletir; opencodex `content-type` ve `accept`'i kendisi ayarlar ve başka hiçbir
  arayan başlığı bu sınırı geçmez;
- kurtarılan düz metin asla günlüğe kaydedilmez veya kalıcı hale getirilmez;
  süreç içi yerel önbellek kimlik bilgisi, üst iş parçacığı ve şifreli metin
  kapsamındadır, 15 dakika sonra sona erer ve hem yapılandırılmış girdi sayısı
  (varsayılan olarak 200, maksimum 512) hem de toplam 8 MiB ile
  sınırlandırılmıştır;
- hatalı biçimlendirilmiş herhangi bir zarf, başarısız kurtarma, zaman aşımı
  veya doğrulama hatası mevcut kapalı başarısız olma hatasını korur; istemci
  iptali 499 döndürür. Hiçbir yol şifreli metni yönlendirilen sağlayıcıya
  iletmez.

### Tehdit modeli

Bu yol, yerel yerel Codex arayanının zaten geçerli bir ChatGPT kimlik bilgisine
sahip olduğunu ve sabit ChatGPT uç noktasının kimliğini doğrulamak için
güvenildiğini varsayar. Özelliği düz metin kahini olarak kullanan genel
proxy/API anahtarı arayanlarına, kimlik bilgilerini başka bir hedefe yeniden
yönlendirmeye, hesaplar arası veya iş parçacıkları arası önbellek yeniden
kullanımına ve hassas veri günlüğüne kaydetme veya kalıcılığına karşı koruma
sağlar. Kabul, her önbellek aramasından önce belirteç yayıncısını, hedef
kitleyi, Codex istemcisini, geçerlilik/başlangıç sınırlarını ve tam hesap
eşleşmesini kontrol eder; uç nokta imza yetkilisi olarak kalır.

Aynı işletim sistemi kullanıcısı olarak çalışan başka bir sürece, güvenliği
ihlal edilmiş bir ChatGPT arka ucuna veya kurtarma modeline, şifrelenmiş görev
içindeki istem enjeksiyonuna, model transkripsiyon hatalarına veya çalışan
proxy'nin bellek incelemesine karşı koruma sağlamaz. Bu nedenle kurtarma çıktısı
kimliği doğrulanmış düz metin yerine güvenilmeyen model çıktısı olarak
değerlendirilmelidir.

```json
{
  "agentTaskRecovery": {
    "enabled": true,
    "model": "gpt-5.6-sol",
    "timeoutMs": 45000,
    "cacheEntries": 200
  }
}
```

Bunu yalnızca ek kimliği doğrulanmış istek, kota kullanımı, süreç içi düz metin
sınırı ve özel arka uç bağımlılığı kabul edilebilir olduğunda etkinleştirin.
Olmadıklarında yerel bir ChatGPT çocuğunu veya v1 heterojen yetkilendirmesini
tercih edin.

Bu kurtarma yolu doğrudan yönlendirilen çocuklara uygulanır. Aynı anda en fazla
32 kurtarma isteği etkin olabilir; ek ıskalamalar kapalı olarak başarısız olur.
Kombo yönlendirmesi şifrelenmiş görevler için mevcut yalnızca yerel filtresini
korur ve kurtarmayı çağırmaz.

## Çaba sınırları

Sınırlar yalnızca v2 işbirliği özelliğine uygulanır: bir ana tur araçları v2'yi
açığa çıkardığında uygundur, bir çocuk ise yaprak araçları artık işbirliğini
açığa çıkarmasa bile `x-codex-turn-metadata` içinde tam codex-rs
`x-openai-subagent: collab_spawn` veya `"subagent_kind": "thread_spawn"`
işaretçileri taşıdığında uygundur. V1 ana turları, `multiAgentMode: "v1"`,
sıkıştırma, inceleme ve bellek birleştirme turları sınırları atlar.

Sınırlar yalnızca çabayı düşürür. Sınırın üzerindeki veya altındaki bildirilen
en yüksek basamağa otururlar. Bir modelin çaba kontrolü yoksa veya desteklenen
hiçbir basamak uymuyorsa opencodex çabayı kaldırır ve sağlayıcı varsayılanının
uygulanmasına izin verir. `max` ve `ultra` kabul edilirken kontrol paneli `low`
ile `xhigh` arasını sunar.

v1, varsayılan ve v2 davranışının yeni başlayanlara yönelik açıklaması için [Alt
ajan yüzeyleri](/tr/guides/sub-agent-surface/) sayfasına bakın.


