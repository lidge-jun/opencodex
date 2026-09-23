---
title: Geçici dosyaların disk kullanımı
description: responses-state.json.ocx.*.tmp dosyalarının ne olduğu, neden birikebildikleri ve nasıl temizlenecekleri.
---

Bazı kullanıcılar, opencodex ev dizinlerinde (varsayılan `~/.opencodex`)
`responses-state.json.ocx.<pid>.<seq>.tmp` biçiminde adlandırılmış ve her
yeniden başlatmadan sonra büyüyen gigabaytlarca dosya buldu.

## Bu dosyalar nedir?

opencodex, `previous_response_id` zincirlerinin proxy yeniden başlatıldıktan
sonra da sürmesi için bir devam önbelleği tutar. Anlık görüntüyü atomik olarak
yazar: içerik önce geçici dosyaya gider, ardından gerçek dosya tek adımda
değiştirilir. Bu, yazma ortasında bir çökme olduğunda yarım yazılmış bir anlık
görüntünün kalmasını önler.

Geçici dosya normalde değiştirme tamamlanır tamamlanmaz kaldırılır. Süreç iki
adım arasında ölürse dosya kalır.

Anlık görüntüye ekleme yapılmayıp tamamı yeniden yazıldığı için her dosya
24 MB'a kadar çıkabilir. Birkaç yüz terk edilmiş dosya bu yüzden hızla birikir.

**Bunlar kalıcı durum değil, önbellektir.** Silmek, devam eden konuşma
zincirlerinin bağlamı bir kez yeniden göndermesi dışında bir kayba neden olmaz.
Bu dosyalarda yapılandırma, kimlik bilgisi veya geçmiş bulunmaz.

## Neden birikebilirlerdi?

Temizlik zaten vardı, ancak tek bir anda çalışıyordu: proxy devam önbelleğini
ilk kez yüklediğinde. Bu, sürecin bir şey yazmasından *önce* olur. Bunun iki
sonucu vardı.

Çöküp yeniden başlayan proxy, önceki sürecin henüz bıraktığı geçici dosyayı
göremeyecek kadar erken temizlerdi (o anda yazılmakta olan dosyalara dokunulmaması için
15 dakikalık bir bekleme süresi vardır) ve süreç boyunca bir daha bakmazdı.
Her yeniden başlatma bir dosya daha eklerdi.

Daha kötüsü, temizlik sahibi süreç kimliği hâlâ çalışan dosyaları atlardı.
Yeniden başlatmanın ardından işletim sistemi aynı süreç kimliklerini yeniden
verebilir; eski bir dosya kalıcı olarak çalışan bir sürece ait sanılabilirdi.
Büyümenin yeniden başlatmaları izlemesinin nedeni budur.

## opencodex şimdi ne yapıyor?

Temizlik yalnızca başlangıçta bir kez çalışmak yerine proxy'nin normal arka
plan zamanlayıcısında yinelenir; çalışan proxy terk edilmiş dosyaları kendi
başına toplar. Ayrıca geçerli açılıştan eski dosyalar için süreç kimliği
denetimini yok sayar, çünkü çalışan hiçbir süreç onlara sahip olamaz.

Güvenlik kuralları değişmedi: 15 dakikadan yeni dosya kaldırılmaz ve proxy
kendi yazdığı dosyayı hiçbir zaman kaldırmaz.

## Anlık görüntü ne sıklıkla yazılır?

Yazmalar geciktirilerek birleştirilir ve gecikme **gerçekte son yazılan anlık
görüntünün** boyutundan türetilir: dosya küçükken sonraki yazma değişiklikten
yaklaşık iki saniye sonrasına planlanır; 24 MB sınırına yaklaştığında bekleme
en fazla otuz saniyeye uzar. Yeni büyüyen önbellek bir kez daha kısa bekler;
uzun aralık bir sonraki yazmadan itibaren geçerli olur. Boşaltma yalnızca bu
süreç aynı dosyaya aynı baytları zaten yazdıysa, dosya diskte hâlâ aynıysa ve
Windows dışındaki sistemlerde kipi hâlâ yalnızca sahibine açıksa atlanır.
Yeni bir süreç özdeş anlık görüntüyü bir kez yeniden yazar. İçeriği veya
izinleri proxy'nin altından değişen dosya ise olduğu gibi bırakılmak yerine
güçlendirilmiş yoldan yeniden yazılır.

Her olağan arka plan çevrimi en fazla bir tam atomik yeniden yazma yapar. Yazma
sürerken devam önbelleği değişirse opencodex tüm anlık görüntüyü hemen yeniden
yazmak yerine normal gecikmeli çevrimde bir takip yazması planlar. Düzgün
kapatma, devam eden istekler bittikten sonra sınırlı yeniden deneme davranışını
korur; böylece son anlık görüntü süreç çıkmadan yetişebilir.

Bunlar birlikte, önbellek büyüdükçe tüm dosyayı iki saniyede bir yeniden
serileştirip değiştirmek yerine yazma hızını yaklaşık sabit tutar.

Düzgün kapatma zamanlayıcıyı beklemeden hemen boşaltır. Uzun bekleme esas
olarak sert sonlandırmada en son devam girdilerinin kaybolabileceği pencereyi
genişletir; bunlar yukarıda belirtildiği gibi önbellektir. Bu boşaltma yine
bir disk yazmasıdır ve diğerleri gibi başarısız olabilir. Bu yüzden dolu veya
salt okunur bir diskteki kapatma da aynı girdileri kaybettirebilir.

## Önceden birikmiş dosyaları temizleme

Proxy çalışıyorsa bu işlem bir iki dakika içinde kendiliğinden olur.

Proxy **başlamıyorsa** — yığının en hızlı büyüdüğü durum — komut satırından
denetleyip temizleyin:

```bash
ocx doctor
```

"Response-state temp files" bölümü, temizlenebilir dosya sayısını ve kullandıkları
alanı bildirir. Yalnızca raporlar; hiçbir şeyi değiştirmez.

Bunları gerçekten kaldırmak için:

```bash
ocx doctor --reclaim-response-temps
```

Her iki komut da çalışan proxy olmadan çalışır. Başka bir sürecin kilitlediği
dosyalar zorla kaldırılmak yerine bildirilir. Sonraki temizlemede yeniden
denenirler: proxy çalışırken otomatik olarak, değilse bu komutu sonraki
çalıştırmanızda.

Çok büyük bir birikim tek geçişi aşarsa komut kalan dosya sayısını söyler;
böylece yeniden çalıştırabilirsiniz.

Bu işlem özellikle yanıt durumu anlık görüntüsü geçici dosyalarını kapsar.
Diğer bileşenler benzer adlı kendi geçici dosyalarını yazar; bunlara burada
dokunulmaz.
