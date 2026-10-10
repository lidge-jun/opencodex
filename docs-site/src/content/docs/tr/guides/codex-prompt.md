---
title: Codex İstem Katmanları
description: Codex'in gerçekte ne gönderdiğini görün, ihtiyacınız olmayan bölümleri kapatın ve kendi talimatlarınızı katmanlar olarak ekleyin.
---

Codex istemini katmanlardan oluşturur: kendi temel talimatları, proje
belgeleriniz, izin ve ortam bağlamı, yüklediğiniz beceriler ve daha fazlası.
**Codex Set → Prompt** bu yığını gösterir, her katmanın maliyetini belirtir ve
istemediğiniz bölümleri kapatmanıza olanak tanır.

## Liste ne gösterir?

Her satır, oluşturma sırasındaki konumunu, varsa onu yöneten yapılandırma
anahtarını ve gerçekte gönderilen içeriğin boyutunu içerir.

Konumlar arasında boşluklar vardır. Bu bilinçli bir tercihtir: sayılar gerçek
oluşturma indeksleridir ve bunlardan ikisi aşağıda **Geçiş bildirimleri** altında
listelenir. Her grubu birden başlayarak yeniden numaralandırmak, Codex'in
kullanmadığı bir sıralamayı gösterirdi.

### Beş katman türü

| Tür | Yapabilecekleriniz |
|---|---|
| Buradan değiştirilebilir | Gerçek bir anahtar. `config.toml` içine bir anahtar yazar. |
| Özellik bayraklı | Gerçektir, ancak bu sayfa yerine `[features]` ayarlarından değiştirilir. |
| Her zaman açık | Codex'in hiçbir yerinde kapatma anahtarı yoktur. |
| Değişimde gönderilir | Bir geçişi bildirir, bu nedenle yalnızca bir şey değiştiğinde görünür. |
| Uzantı katmanı | Listelenemez. Codex bunları göstermez. |

Kapatma anahtarı olmayan bir katman, devre dışı bırakılmış bir anahtar yerine
hiç anahtar göstermez. Soluk bir kontrol, bu özelliğin var olduğunu ancak geçici
olarak kullanılamadığını düşündürürdü; durum böyle değildir.

## Bir katmanı okuma

Gönderdiği metni görmek için katman adına tıklayın. İletişim kutusu bunu
`codex debug prompt-input` üzerinden okur; dolayısıyla bir açıklama değil,
gerçekte gönderilen metindir.

Bazen gösterilecek bir şey olmaz ve iletişim kutusu hangi nedenin geçerli
olduğunu belirtir:

- **Dosya var ancak boş.** `~/.codex/AGENTS.md` dosyanız sıfır bayttır, bu
  nedenle katmanın gönderecek bir şeyi yoktur. İletişim kutusu yolu belirtir.
- **Okuduğumuz turda hiçbir şey göndermedi.** Katmanlar yalnızca değiştiklerinde
  yeniden gönderilir, dolayısıyla değişmemiş bir katman tek bir örnekte yer almaz.
- **Temel istem model kataloğundan okunur.** Codex onu okunabilir listenin dışından
  gönderir; bu nedenle iletişim kutusu, seçili modelin katalog kaydından ya da
  ayarladıysanız `model_instructions_file` ile belirtilen dosyadan okur. Katalogda
  yalnızca genişletilmemiş bir şablon varsa, bu metin Codex'in gönderdiği metin
  olmadığı için gösterilmediği belirtilir.
- **İstem okunamadı.** İnceleme bu makinede başarısız oldu.

Okuma, kontrol panelinin çalıştığı dizinden değil, genel Codex ana dizininizden
(`~/.codex`) alınır.

## Özel katmanlar

**+ Add layer** kendi talimatlarınızı sona ekler. Özel katmanlar
`developer_instructions` içinde birleştirilir ve bu eklemelidir — Codex kendi
talimatlarını korur, sizinkiler de bunlara eklenir.

:::note
Bu, bilinçli olarak `model_instructions_file` değildir. Bu anahtar temel isteme
ekleme yapmak yerine onu DEĞİŞTİRİR; dolayısıyla **+** düğmesini buna bağlamak,
bir katmanı ilk kaydettiğinizde Codex'in kendi talimatlarını silerdi.
:::

Özel katmanlar kendi aralarında numaralandırılır, çünkü bu sırayla tek bir
bölümde birleştirilirler; yerleşik katmanların arasına girmezler.

Satırdaki oklarla veya satırın herhangi bir yerindeyken `Alt` + `Up` / `Alt` +
`Down` ile sıralamayı değiştirin. Sıra, birleştirme sırasıdır.

Panel, etkin katmanların toplam boyutunu `developer_instructions` için 128 KiB
sınırına karşı gösterir ve birleştirilmiş metnin daraltılabilir bir önizlemesini
sunar — bölümü sınırın üzerine taşıyacak bir katman, kaydettikten sonra değil
kaydetmeden önce görülür.

Bir katmanı silmek önce onay ister, ardından birkaç saniyeliğine **Geri al**
seçeneği sunar: katman eski konumuna döner; böylece sırası önemli bir liste
yanlışlıkla yapılan bir hareketi atlatır.

### Ön ayarlar

**+ Add layer** beş başlangıç noktası sunar: kısa çıktı, düzenlemeden önce plan,
gerekçeyi açıklama, önce test ve Korece yanıtlar. Her biri, önceden doldurulmuş
ve tamamen düzenlenebilir normal düzenleyiciyi açar — ön ayar bir başlangıç
noktasıdır ve kaydettiğiniz şey normal bir özel katmandır.

Ön ayarlar, herhangi birinin istemini kopyalamak yerine bir yaklaşımı özlü
biçimde aktarmak için yazdığımız kendi metinlerimizdir. Her biri kaynağını belirtir.

### Düzenleme sırasında katmanlar arasında geçiş

Düzenleyicide önceki/sonraki kontrolleri ve bir konum göstergesi vardır.
Kaydedilmemiş düzenlemeler siz geçiş yaparken korunur; böylece düzenleme
sırasında iki katmanı karşılaştırabilir ve yazdıklarınızı kaybetmeden geri
dönebilirsiniz.

### Uyumluluk uyarıları

Düzenleyici, bir katman yazıldığı şekliyle çalışmayacak bir şey söylediğinde
uyarır: farklı bir kimlik iddia etmek, kayıt defterinin tanımladığı bir aracın
adını vermek, hiçbir şeyin genişletmediği şablon yer tutucuları kullanmak veya
Codex'in daha sonra oluşturduğu ortam bilgilerini belirtmek. Ayrıca yapıştırılmış
kimlik bilgilerini (bir katmandaki API anahtarı her istekte düz metin olarak
modele gider), modele önceki talimatlarını bırakmasını söyleyen ifadeleri ve
Korece yazılmış Codex dışı bir kimliği de işaretler.

Bunlar uyarıdır ve kaydetmeyi asla engellemez. Codex'i geçersiz kılmak
istiyorsanız bunu yapabilirsiniz; uyarı yalnızca bunun bir kaza değil, bilinçli
bir karar olmasını sağlar.

## Temel istem varyantları

Temel istem, ek katmanlardan önce Codex’in kendi talimatlarıdır. Seçici, varsayılan
istemi ve `~/.codex/opencodex-prompt-base/` içinde saklanan en fazla iki varyantı sunar.
Varsayılan seçenekte düzenlenecek metin yoktur; onu seçmek `model_instructions_file`
anahtarını yapılandırmanızdan kaldırır.

:::caution
Bir varyant Codex’in temel talimatlarının **yerini alır**. Mevcut davranışı koruyarak
talimat eklemek için özel bir katman kullanın.
:::

Düzenleyici, seçenekler arasında gezinirken kaydedilmemiş değişiklikleri korur ve
kapatırken bunları silmeden önce onay ister. Yazarken gövde boyutu ölçülür; her
varyantın gövdesi en fazla 64 KiB olabilir.

### Temel istemi zaten başka bir dosya değiştiriyorsa

`model_instructions_file` sizin veya başka bir aracın yazdığı bir dosyayı gösteriyorsa,
seçici yolu gösterir ve anahtarı sessizce başka bir dosyaya yönlendirmez.
**Varyant olarak içe aktar** önce kurulacak metnin tamamını gösterir: `# ` satırında
başlık, ardından satır sonları ve sekmeleri normalleştirilmiş gövde. Onaylamadan önce
başlığı düzenleyebilirsiniz. Normalleştirilmiş gövde en fazla 64 KiB (`bodyBytes`)
olabilir; başlıkla birlikte dosyanın tamamı biraz daha büyüktür (`serializedBytes`).
Onay bir hash ile bu önizlemeye bağlanır. Dosya veya başlık değişirse, görmediğiniz
metni kurmak yerine içe aktarma reddedilir. Varsayılana dönmek için anahtarı kendiniz
kaldırabilirsiniz.

Değişiklikler yeni oturumlarda geçerli olur; açık oturumlar başlangıçtaki istemi korur.

## opencodex dışında yazılan talimatlar

`developer_instructions` zaten varsa ve opencodex tarafından yazılmadıysa panel
bunun üzerine yazmaz. Bunun yerine metni bir katman olarak içe aktarmayı önerir:
önce mevcut değeri görürsünüz ve siz onaylayana kadar hiçbir şey yazılmaz.

## Bir şeyler eşitlenmediğinde

Kaydedilen katmanlar ile `config.toml` içindeki değer uyuşmazsa panel bunu
belirtir ve sessizce düzeltmek yerine **Repair** seçeneğini sunar. Onarım
yollarından ikisi yazdığınız metni yeniden yazar, bu nedenle işlem bilinçli
olarak başlatılmalıdır. Yarım kalmış bir yazma ("journal present"), kilit altında
yalnızca günlükte kayıtlı dosya durumlarını kullanarak kurtarılır. Geçerli liste
yeniden kaydedilmez ve eksik içerik üretilmez. Dosyalar kayıtlı durumların hiçbiriyle
eşleşmiyorsa kurtarma reddedilir ve tanılama için mevcut veriler korunur. Yenilenen
panel kalan uyuşmazlıkları gösterir. Bir katman dosyası kaybolmuşsa onarım,
herhangi bir şeye dokunmadan önce bir yedek yazar.

## Değişiklikler ne zaman etkili olur?

Değişiklikler yeni başlatılan oturumlara uygulanır. Çalışmakta olan bir oturum,
başlangıçta kullandığı istem ayarlarını korur.

## Bu sayfa neyi okur, neyi okumaz?

opencodex tek bir yapılandırma dosyasını, yani `config.toml` dosyanızı okur.
Codex ayarlarını birkaç katmandan çözümler; dolayısıyla buradaki bir değer,
Codex'in sonunda hesapladığı değer olmak zorunda değil, SİZİN dosyanızda yazan
değerdir.

## Bu sayfanın yazdığı anahtarlar

Bunlar opencodex'in kendi yapılandırmasında değil, Codex'in `config.toml` dosyasında bulunur.

| Anahtar | Varsayılan | Katman |
|---|---|---|
| `include_permissions_instructions` | `true` | İzinler |
| `include_collaboration_mode_instructions` | `true` | İş birliği modu |
| `include_environment_context` | `true` | Ortam bağlamı |
| `include_apps_instructions` | `true` | Uygulamalar |
| `skills.include_instructions` | `true` | Beceriler |
| `developer_instructions` | ayarlanmamış | Sırayla birleştirilen özel katmanlarınız |
| `model_instructions_file` | ayarlanmamış | Bir varyant seçildiğinde temel istem |

Yazma işlemi satır bazlıdır: yorumlarınız ve biçimlendirmeniz korunur, opencodex'in tanımadığı bir anahtar silinmek yerine olduğu gibi bırakılır.

Bulunmayan bir anahtar `false` olarak değil, varsayılanı olarak okunur. Panel dosyanızda gerçekten bulunan değeri gösterir ve bir anahtar ayarlanmamışsa bunu belirtir.

Açık bir değer taşıyan satır ayrıca **Varsayılana sıfırla** sunar; bu, varsayılanı geri yazmak yerine
anahtar satırını siler. Codex varsayılanı daha sonra değiştirirse onu takip etmeye devam eden tek durum
budur — `key = true` yazmak bugünün varsayılanını bir geçersiz kılma olarak dondurur.

Basit değer düzenleyicisi, anahtarı yazmadan veya sıfırlamadan önce dizileri, satır içi tabloları ve çok satırlı dizeleri reddederek özgün baytları korur. İçe aktarma, okunamayan yapılandırmayı açıkça bildirir. Salt okunur başlık önizlemesi sırasında alan düzenlenebilir; onay hâlâ o başlığa bağlı bir önizleme gerektirir. Ölçümdeki HTTP veya ağ hataları, başka bir ölçümün sürdüğü mesajı yerine hata olarak gösterilir.
