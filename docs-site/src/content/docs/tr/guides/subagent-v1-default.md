---
title: v1 neden varsayılan alt ajan arayüzü?
description: v2 şifreli görev sınırlamasının neyi bozduğu, OpenCodex'in neden artık v1 sunduğu ve yine de v2 istiyorsanız ne yapacağınız.
---

OpenCodex, alt ajan arayüzü **v1** olarak kurulur. Dashboard, Models ve Subagents
sayfaları **base** veya **v2** moduna geçmeden önce onay ister; bu sayfa da o
onayın bağlantı hedefidir. CLI onay istemez.

Değişmemiş şifreli v2 yolunda, ChatGPT yerel modelinden yönlendirilen modele
devredilen okunamayan görev sağlayıcı sınırında başarısız olur. Aşağıdaki deneysel
seçenek yeni görev mesajlarının üretimini değiştirir; mevcut şifreli mesajları çözmez.

## Düz metin görev mesajlarıyla isteğe bağlı V2

**V2 · düz metin görevler** (`v2-plaintext`), genel V2 zorlamasını kapalı tutarak
yeni sohbetler için V2 katalog sabitlemelerini seçer. V2 görev adlarını, hiyerarşiyi,
takip mesajlarını, iptali ve eşzamanlılığı korur; uygun kurallı ChatGPT Responses
istekleri için deneysel düz metin derleyicisini kullanır. Mevcut sohbetler kayıtlı
seçimlerini korur ve güncelleme bu açık seçeneği kendiliğinden seçmez. Derleyici,
mevcut V2 oturumlarının sonraki uygun istekleri dahil, her uygun istekte geçerli
ayarı izler.

Bu modda yerel yanıt kimliğiyle devam, kabul edilmiş aynı opencodex API anahtarı
kimliğini ve isteğin kendi `thread-id` değerini gerektirir; üst iş parçacığı kimliği
çocuğun saklanan görevine erişim sağlamaz. Kimliklerden biri yoksa, proxy yeniden
başlatıldıysa veya eski bağlı olmayan önbellek girdileri kullanılıyorsa konuşmanın
tamamını `previous_response_id` olmadan yeniden gönderin. Bu modda saklanan durum,
mod değiştikten sonra da bağlı kalır. Varsayılan `v1`, geri döngü çağıranları dahil
bağlı olmayan durum için mevcut üst iş parçacığı kapsamındaki devamı korur.

Kontrol paneli, görev metninin Codex geçmişinde, seçilen sağlayıcıya gönderilen
isteklerde ve disk üzerindeki devam anlık görüntüleri veya taşmaları dahil yerel
yanıt/hata ayıklama durumunda kalabileceğinin onaylanmasını ister. HTTPS ve kimlik
doğrulama korunur; ek kurtarma modeli çağrısı yapılmaz. Mevcut şifreli metnin şifresi
çözülmez, saklanan geçmiş yeniden yazılmaz ve devre dışı bırakma saklanan kopyaları
silmez. Desteklenmeyen arka uç veya istemci davranışı yine başarısız olabilir. Normal
v1 ve karma yerel-v1/yönlendirilmiş-v2 modları kullanılabilir.

```bash
ocx v2 mode v2-plaintext --live --acknowledge-plaintext-agent-messages
```

Canlı hedefi `ocx v2 status --live --json` ile kontrol edin. Yerel hedef için her iki komuttan `--live` seçeneğini çıkarın ve `ocx v2 status --json`
ile durumu okuyun; yapılandırılan durum ve katalog yakınsaması, başarılı bir gerçek
görev devriyle aynı şey değildir. Çıkmak için başka bir mod seçin; bağımsız olarak
ayarlanmış `plaintextV2AgentMessages` değeri korunur.

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

Şifreli v2 yolunda ebeveyn, ChatGPT arka ucunun ürettiği `encrypted_content` olarak görevi
verir. Anahtar o arka uçta kalır. OpenCodex anahtara hiç sahip olmadığından
proxy'nin çözebileceği veya yeniden yazabileceği bir şey yoktur: değer, bir
bayrağın arkasındaki düz metin değil gerçekten şifreli metindir. Bu yüzden
mevcut şifreli metnin sorunu yapılandırma hatası değil yapısaldır; düz metin seçeneği onu çözmez, yeni mesajları farklı üretir.

Hiçbir proxy ayarı yerel şifre çözmeyi etkinleştirmez. Deneysel `agentTaskRecovery`, uygun görevleri kurtarmak için ChatGPT arka ucuna başvurabilir; şifreli metni yerel olarak çözmez. Yukarıdaki yetkilendirme, uygunluk ve hata sınırları geçerlidir.

Aşağıdaki karşılaştırma şifreli v2 yolu içindir; düz metin seçeneği uygun yeni görevleri farklı üretir:

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

## Modlar şimdi ne yapıyor?

| Mod | Arayüz | Ne zaman seçilmeli? |
| --- | --- | --- |
| **v1** (varsayılan) | Her model klasik ad alanlı spawn araçlarını sunar. Spawn başka bir modeli doğrudan adlandırabilir. | Sağlayıcılar arasında görev devreden herkes. Sunulan varsayılan budur. |
| **base** | Yukarı akış model sabitlemeleri: Sol ve Terra v2, Luna v1 kullanır; sabitlenmemiş modeller Codex'in kendi bayrağını izler. | Codex'in model başına amaçlanan arayüzünü ve yalnızca tek sağlayıcı içinde görev devrini istiyorsanız. |
| **v2** | Her model düz eşzamanlı araçları sunar. | Yeni eşzamanlı oturum modelini istiyorsanız ve ebeveyn ile çocuk sınırın aynı tarafındaysa. |
| **v2-plaintext** | Genel zorlama kapalıyken yeni oturumlar için V2; uygun ChatGPT görev mesajları düz metin. | Açık onayla deneysel düz metin iletimini istiyorsanız. |

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

Katalog modu değişiklikleri **yeni** Codex oturumlarına uygulanır; düz metin derleyicisi mevcut V2 oturumlarının sonraki uygun isteklerini de etkiler. Seçimden sonra yeni
oturum başlatın; uzun süredir çalışan bir App ana bilgisayarı eski arayüzü
gösteriyorsa `ocx sync` çalıştırıp o Codex arayüzünü yeniden başlatın.

## Yine de v2 istiyorsanız

Çoğu kullanıcının denemesi gereken sırayla dört yol vardır:

1. **ChatGPT'yi v1'de tutun.** v2 içindeki `keepNativeChatGptOnV1` anahtarı, Sol ve Terra'yı v1 arayüzünde bırakır; böylece Grok veya Claude oluşturabilirler. Yönlendirilen ebeveynler ise v2 alır. İkisini birlikte kullanmaya en yakın yol budur.
2. **Tek sağlayıcı içinde görev devredin.** Yönlendirilen ebeveynden yönlendirilen çocuğa görev v2'de düz metindir ve normal çalışır.
3. **Doğrudan anahtar kimlik doğrulamalı Responses geçidine güvenin.** `allowEncryptedV2AgentTasks: true` ile açıkça işaretlediğiniz sağlayıcı, 400 yerine opak yükü alır. Bunu yalnızca yükü tüketebildiğini bildiğiniz hedef için yapın.
4. **`agentTaskRecovery` etkinleştirin.** Deneyseldir ve varsayılan olarak kapalıdır. ChatGPT arka ucu üzerinden okunamayan şifreli `NEW_TASK`, `MESSAGE`, `FOLLOWUP_TASK` ve `FINAL_ANSWER` öğelerini kurtarır. Bunun bedeli kota, gecikme ve belgelenmemiş davranışa bağımlılıktır; kombo kurtarma yalnızca spawn edilmiş çocuk turlarıyla sınırlı kalır ve bölünmüş belirteç parçaları hâlâ desteklenmez.

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

## Eşzamanlı alt ajan sınırı

**Models → Model settings** içindeki alt ajan sınırı, ana ajan hariç eşzamanlı alt ajanların
azami sayısını belirler. Genel v2 bayrağı kapalı olan hibrit mod dahil v1, base ve v2'de
kullanılabilir. Arayüz modu bu sınırdan bağımsız olarak seçilir.

Sınırı artırmak daha fazla alt ajana izin verir; onları otomatik oluşturmaz veya daha hızlı
çalışmayı garanti etmez. Değişiklikten sonra yeni bir Codex oturumu başlatın. Uzun süredir çalışan
App ana bilgisayarı eski sınırı kullanmaya devam ediyorsa o ana bilgisayarı yeniden başlatın.
