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
Codex'in daha sonra oluşturduğu ortam bilgilerini belirtmek.

Bunlar uyarıdır ve kaydetmeyi asla engellemez. Codex'i geçersiz kılmak
istiyorsanız bunu yapabilirsiniz; uyarı yalnızca bunun bir kaza değil, bilinçli
bir karar olmasını sağlar.

## opencodex dışında yazılan talimatlar

`developer_instructions` zaten varsa ve opencodex tarafından yazılmadıysa panel
bunun üzerine yazmaz. Bunun yerine metni bir katman olarak içe aktarmayı önerir:
önce mevcut değeri görürsünüz ve siz onaylayana kadar hiçbir şey yazılmaz.

## Bir şeyler eşitlenmediğinde

Kaydedilen katmanlar ile `config.toml` içindeki değer uyuşmazsa panel bunu
belirtir ve sessizce düzeltmek yerine **Repair** seçeneğini sunar. Onarım
yollarından ikisi yazdığınız metni yeniden yazar, bu nedenle işlem bilinçli
olarak başlatılmalıdır. Bir katman dosyası kaybolmuşsa onarım, herhangi bir şeye
dokunmadan önce bir yedek yazar.

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

Yazma işlemi satır bazlıdır: yorumlarınız ve biçimlendirmeniz korunur, opencodex'in tanımadığı bir anahtar silinmek yerine olduğu gibi bırakılır.

Bulunmayan bir anahtar `false` olarak değil, varsayılanı olarak okunur. Panel dosyanızda gerçekten bulunan değeri gösterir ve bir anahtar ayarlanmamışsa bunu belirtir.
