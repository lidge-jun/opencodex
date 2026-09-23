---
title: v1 neden varsayılan alt ajan arayüzü?
description: v2 şifreli görev sınırlamasının neyi bozduğu, OpenCodex'in neden artık v1 sunduğu ve yine de v2 istiyorsanız ne yapacağınız.
---

OpenCodex, alt ajan arayüzü **v1** olarak kurulur. Dashboard, Models ve Subagents
sayfaları **base** veya **v2** moduna geçmeden önce onay ister; bu sayfa da o
onayın bağlantı hedefidir. CLI onay istemez.

Nedeni dar ve nettir: v2'de ChatGPT yerel modelinden yönlendirilen modele
devredilen görevi yönlendirilen model okuyamaz. İnsanların en sık kullandığı
devir biçimi budur — GPT ebeveyninin Grok, Claude veya GLM çocuğu oluşturması —
ve v2'de her seferinde başarısız olur.

## Bu durumda ne görürsünüz?

Boş çocuk görevi sessizce oluşturulmak yerine spawn reddedilir:

```json
{
  "error": {
    "code": "unreadable_encrypted_agent_task",
    "message": "Routed V2 worker task is encrypted for the native ChatGPT backend and cannot be read by the selected provider. Use plaintext V2 agent-message delivery or select a native ChatGPT model."
  }
}
```

HTTP 400 döner ve şifreli metin hiçbir zaman geri yansıtılmaz. Güvenli biçimde
başarısız olmak bilinçlidir: okunamayan yükü iletmek çocuğa boş talimat verip
güvenle yanlış yanıt üretmesine yol açardı.

## Neden olur?

![İki yol aynı devri karşılaştırıyor. v1'de ChatGPT ebeveyni OpenCodex üzerinden düz metin görev gönderir; görev sağlayıcı sınırını aşar ve yönlendirilen çocuk onu okur. v2'de ebeveyn ChatGPT arka ucunun ürettiği encrypted_content gönderir; OpenCodex şifresini çözemez, bu nedenle görev sağlayıcı sınırında durur ve istek unreadable_encrypted_agent_task ile başarısız olur.](../../../../assets/subagent-v2-encrypted-task.svg)

v1'de ebeveyn çocuğun görevini düz metin olarak üretir. OpenCodex onu okur,
yönlendirir ve yönlendirilen çocuk uygulanabilir bir görev alır.

v2'de ebeveyn, ChatGPT arka ucunun ürettiği `encrypted_content` olarak görevi
verir. Anahtar o arka uçta kalır. OpenCodex anahtara hiç sahip olmadığından
proxy'nin çözebileceği veya yeniden yazabileceği bir şey yoktur: değer, bir
bayrağın arkasındaki düz metin değil gerçekten şifreli metindir. Bu yüzden
sorun yapılandırma hatası değil yapısaldır ve proxy tarafı ayarlarla çözülemez.

Üç topoloji etkilenmez; bu, hatanın şeklini açıklar:

| Topoloji | v1 | v2 |
| --- | --- | --- |
| ChatGPT ebeveyninden yönlendirilen çocuğa | çalışır | **başarısız** |
| Yönlendirilen ebeveynden yönlendirilen çocuğa | çalışır | çalışır |
| ChatGPT ebeveyninden ChatGPT çocuğa | çalışır | çalışır — arka uç kendi ürettiği şifreli metni çözebilir |

Arka uç kendi şifreli metnini her zaman okuyabilir. Yalnızca sınır geçişi bozulur.

## Yukarı akışta düzeltildi mi?

Henüz değil; önemli olan yarısı için de değil. Yukarı akış,
[openai/codex#35845](https://github.com/openai/codex/pull/35845) değişikliğini
birleştirerek düz metin iş birliği iletilerini destekledi, ancak bu *alma*
tarafıdır. Zaten üretilmiş düz metni işler; OpenAI ebeveynine onu ürettirmez.

Gönderme tarafı hâlâ açıktır:
[#36376](https://github.com/openai/codex/issues/36376), Windows, macOS ve Linux'ta
CLI 0.146 ile 0.151 arasında yeniden üretildi; [#37197](https://github.com/openai/codex/issues/37197)
ise eksik parçayı, yani gönderme tarafı teslim politikasını, doğrudan belirtir.
İkisinde de bakım sorumlularının bir taahhüdü veya tahmini bitiş tarihi yoktur.

OpenCodex bunun sonucunu [#92](https://github.com/lidge-jun/opencodex/issues/92)
olarak kaydetti ve planlanmadığı için kapattı: bu depoda çözülecek bir şey
yoktur; konu, buradaki bakım sorumlularını bekleyen görev değil yukarı akış
işine işarettir.

## Üç mod şimdi ne yapıyor?

| Mod | Arayüz | Ne zaman seçilmeli? |
| --- | --- | --- |
| **v1** (varsayılan) | Her model klasik ad alanlı spawn araçlarını sunar. Spawn başka bir modeli doğrudan adlandırabilir. | Sağlayıcılar arasında görev devreden herkes. Sunulan varsayılan budur. |
| **base** | Yukarı akış model sabitlemeleri: Sol ve Terra v2, Luna v1 kullanır; sabitlenmemiş modeller Codex'in kendi bayrağını izler. | Codex'in model başına amaçlanan arayüzünü ve yalnızca tek sağlayıcı içinde görev devrini istiyorsanız. |
| **v2** | Her model düz eşzamanlı araçları sunar. | Yeni eşzamanlı oturum modelini istiyorsanız ve ebeveyn ile çocuk sınırın aynı tarafındaysa. |

base ilk değil ikinci sıradadır, çünkü sabitlemeleri insanların en sık görev
devrettiği iki model olan Sol ve Terra'yı v2'ye koyar. base bu sorun için ara
ayar değildir; ChatGPT'den yönlendirilen çocuğa spawn söz konusu olduğunda v2
gibi davranır.

## Zaten base veya v2 seçtiyseniz

Sizin için hiçbir şey değiştirilmez. Bu varsayılanı sunan sürüme yükseltmek
mevcut ayarı yeniden yazmaz; kontrol paneli bildirimi bir kez gösterir ve
yanıtınızı bekler.

- **Continue**, mevcut modu korur ve tekrar sormaz.
- **Switch to v1**, v1'i uygular ve tekrar sormaz.

Her iki yanıt da kaydedilir ve bildirim geri gelmez. Yanıtlamadan kapatırsanız
kontrol panelini sonraki açışınızda yeniden görünür.

Mod değişiklikleri **yeni** Codex oturumlarına uygulanır. Seçimden sonra yeni
oturum başlatın; uzun süredir çalışan bir App ana bilgisayarı eski arayüzü
gösteriyorsa `ocx sync` çalıştırıp o Codex arayüzünü yeniden başlatın.

## Yine de v2 istiyorsanız

Çoğu kullanıcının denemesi gereken sırayla dört yol vardır:

1. **ChatGPT'yi v1'de tutun.** v2 içindeki `keepNativeChatGptOnV1` anahtarı, Sol ve Terra'yı v1 arayüzünde bırakır; böylece Grok veya Claude oluşturabilirler. Yönlendirilen ebeveynler ise v2 alır. İkisini birlikte kullanmaya en yakın yol budur.
2. **Tek sağlayıcı içinde görev devredin.** Yönlendirilen ebeveynden yönlendirilen çocuğa görev v2'de düz metindir ve normal çalışır.
3. **Doğrudan anahtar kimlik doğrulamalı Responses geçidine güvenin.** `allowEncryptedV2AgentTasks: true` ile açıkça işaretlediğiniz sağlayıcı, 400 yerine opak yükü alır. Bunu yalnızca yükü tüketebildiğini bildiğiniz hedef için yapın.
4. **`agentTaskRecovery` etkinleştirin.** Deneyseldir ve varsayılan olarak kapalıdır. Kota, gecikme ve belgelenmemiş davranışa bağımlılık pahasına çoğu yeni spawn'ı ChatGPT arka ucundan kurtarır; ileti türü takipleri ve çok parçalı zarfları yine kaybeder.

Her birinin ayrıntıları için [Alt Ajan Arayüzü](/tr/guides/sub-agent-surface/),
ayarlar için [Ajan yapılandırması](/tr/reference/configuration/agents/) sayfasına
bakın.

## Bu sayfa ne zaman kalkacak?

Yukarı akış sürümü ChatGPT yerel ebeveynin yönlendirilen çocuk görevini düz
metin olarak üretmesini sağladığında bu varsayılanın gerekçesi ortadan kalkar.
O zaman varsayılan base'e döner, onay görünmez ve bu sayfa tavsiye yerine
tarihsel bilgi olur.

## Modu değiştirme

Dashboard, Models ve Subagents aynı v1/base/v2 anahtarını taşır ve üçü de base
veya v2 öncesinde sorar. CLI üzerinden:

```bash
ocx v2 status
ocx v2 mode v1
```

CLI onay istemez. Aynı ayardır; bu sayfanın anlattıklarını bilerek seçin.
