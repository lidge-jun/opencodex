---
title: Çekme isteği kalite sözleşmesi
description: OpenCodex çekme istekleri için inceleme hazırlığı, katkıda bulunan sorumluluğu, güven yolları ve kapatma politikası.
---

## Bir şeyi düzeltmek için izne ihtiyacınız yoktur

Gerçekten karşılaştığınız bir hata için plansız bir çekme isteği memnuniyetle
karşılanır. Bu projenin en iyi düzeltmelerinin birçoğu tam olarak bu şekilde
geldi — araç çağrılarından sonra takılan yönlendirilmiş bir model, yanlış model
parametreleri gönderen bir sağlayıcı, araç sonuçlarından çıkarılan görseller.
Bunların hiçbiri bir planlama tartışmasıyla başlamadı ve böyle bir tartışmayı
zorunlu kılan bir kapı hepsini kaybettirirdi.

Daha büyük veya tasarım odaklı çalışmalar için önce bir konu (issue) açmak
gerçekten yardımcı olur; yaklaşım üzerinde anlaşmak sizi yanlış şeyi inşa
etmekten kurtarır. Bu bir tavsiyedir, kabul koşulu değildir.

## Hazır bir çekme isteğinin iddia ettiği şey

Bir çekme isteğini (PR) incelemeye hazır olarak işaretlemek, değişikliğin
eksiksiz, anlaşılmış ve test edilmiş olduğu iddiasıdır. Bunu açmak, dalın
sorumluluğunu bakımcılara devretmez.

Yazarların değiştirilen her satırı anlaması, herhangi bir doğrulama iddiasının
arkasındaki kesin komutları ve sonuçları belirtmesi, davranış değişiklikleri
için odaklanmış regresyon kapsamı eklemesi ve CI ile inceleme geri
bildirimlerini çözmek için hazır bulunması beklenir. Bakımcılar sorunları tespit
eder; katkıda bulunanların dallarını onarmaları, eksik testleri yazmaları veya
otomatik bulguları sizin adınıza yamalara dönüştürmeleri beklenmez.

Belirtilmiş komutlar ve sonuçlar olmadan "Test edildi" veya "CI geçiyor" demek
bir kanıt değildir.

## Otomatik kapılar

İnsan incelemesinden önce üç belirleyici kontrol çalışır ve her hata mesajı size
tam olarak neyi değiştirmeniz gerektiğini söyler:

- **PR kalitesi (`enforce-target`).** Çekme istekleri `dev` dalını hedeflemeli
  ve gerçek bir açıklama taşımalıdır: Neyin neden değiştiğine dair bir **Özet**
  (Summary) artı bir **Test planı** (veya eşdeğer içerik). Fark (diff) `gui/`
  altındaki dosyaları değiştirdiğinde veya GitHub büyük bir fark için eksik bir
  değiştirilen dosya listesi döndürdüğünde, açıklama UI değişikliğinin bir ekran
  görüntüsünü içermelidir; denetim, ekran görüntüsü mevcut olana kadar PR'ı
  taslakta tutar ve yorum yapar. Eksik dosya listeleri muhafazakar bir
  yaklaşımla GUI değişikliği olarak değerlendirilir. Bir bakımcı,
  `gui-screenshot-waived` etiketini ekleyerek bir `gui/` değişikliği, yanlış
  pozitif GUI yolu sınıflandırması veya eksik dosya listesi yanlış pozitifi için
  ekran görüntüsü gereksiniminden feragat edebilir; bu etiketin eklenmesi veya
  kaldırılması kapıyı hemen yeniden değerlendirir. "no gui changes" gibi eski
  bakımcı yorumları geriye dönük uyumluluk için sonraki PR olayında hala
  tanınır, ancak yorumların kendisi artık ayrıcalıklı PR kapısını tetiklemez.
  Katkıda bulunan bir kişi ekran görüntüsü gereksiniminden kendi kendine feragat
  edemez.
Katkıda bulunan PR'ları (depo yazma izni olmayan yazarlar) taslak olarak açılır
ve açıklamadaki dört kutulu incelemeye hazırlık kontrol listesi tamamlanana
kadar orada kalır: yerel CI yeşil, dal en son `dev` commit'inde, tüm doğru Codex
ve CodeRabbit bulguları düzeltildi ve incelemeye hazır onayı. Her kutu
işaretlendikten sonra kontrol, PR'ı incelemeye hazır olarak işaretler ve
`MAINTAINERS.md` dosyasında listelenen bakımcıları bilgilendirir (yazar hariç).
Kapının durumu ve "ne yapılacağı", her çalıştırmada yeniden yazılan tek bir
birleştirilmiş bot yorumunda yer alır, böylece bakılacak tam olarak tek bir yer
vardır. Tamamlama, PR head'inin işaret ettiği tam commit'e bağlıdır: daha sonra
yeni commit'ler push'lanırsa, kapı PR'ı tekrar taslağa taşır, kontrol listesini
ve bakımcı bildirimini sıfırlar ve en son koda göre kutuları tekrar test edip
işaretlemenizi ister. `dev` dalına yeniden hedefleme, yanlış dal mesajını
otomatik olarak temizler ve kapı tarafından hatırlanır; taslak, kontrol listesi
tamamlanana kadar kalır.
Bir tamamlama kabul edilmeden önce kapı, kontrol listesinin kendisinin kontrol
edebileceği iddiaları doğrular: dal en son `dev` commit'inde veya en fazla 10
commit gerisinde olmalı ve geçerli head üzerinde bir inceleme botu tarafından
yazılan her Codex ve CodeRabbit inceleme konusu çözülmelidir (diğer yazarların
çözülmemiş konuları engellemez). Yerel CI kutusu yalnızca bir yazar beyanıdır —
fork katkıda bulunanları depo CI'ını başlatamaz; bir bakımcının başlatması
gerekir — bu nedenle kapı bunu asla çürütmez; yeni bir push yine de her kutuyu
sıfırlar. Fark aralığının dışına düşen ve yalnızca geçerli head üzerindeki bir
inceleme gövdesinde bildirilen CodeRabbit bulguları, bir bot inceleme konusu
açıkken çözülmemiş sayıya eklenir; her bot konusunu çözmek kutuyu temizler.
Çürütülen bir iddia eşleşen kutunun işaretini kaldırır ve PR'ı taslakta tutar.
Kontrol listesi tamamlandığında ve her kapı yeşil olduğunda, kapı hazır olma
anında görünür bir durum işaretçisi olarak bir `review-ready` etiketi ekler.
CodeRabbit durum yorumu düzenlemeleri PR kapısını tetiklemez. CodeRabbit'in
başarılı `CodeRabbit` commit durumu, `status` olayı aracılığıyla güvenilen
varsayılan dal kapısını uyandırır. Kapı, bu durum SHA'sını geçerli head'i hala
eşleşen tam olarak bir açık PR ile eşleştirir, ardından kontrol listesini,
etiketi, yorumu veya taslak durumunu değiştirmeden önce canlı inceleme
konularını ve inceleme gövdelerini yeniden okur. Belirsiz veya eski bir SHA
ilişkisi yok sayılır ve kapının yazma yetkisine sahip belirteciyle hiçbir
PR-head kodu yürütülmez.

- **Hijyen (Hygiene).** Davranış değişiklikleri bir teste ihtiyaç duyar; yeni
  lint veya tip bastırmaları, odaklanmış veya atlanmış testler, boş catch
  blokları, düzenlenen üretilmiş çıktılar ve manifestosu olmadan değiştirilen
  bir kilit dosyası (lockfile) açık bir onay etiketine ihtiyaç duyar. Bir kaynak
  dosyadaki yalnızca yorum değişikliği bir davranış değişikliği değildir ve test
  gerektirmez.
- **Çapraz platform CI.** Test paketi her çekme isteği için Linux'ta parçalı
  (sharded) ve macOS'ta tam olarak çalışır. Windows, dağıtım sınırında çalışır —
  `main` veya `preview` dalına yükseltmede — bu nedenle yavaş veya kararsız bir
  Windows çalıştırıcısı çekme isteğinizin ne zaman yeşile döneceğine karar
  veremez.
Bu, temel dalı ne olursa olsun **her** çekme isteği için çalışır — temeli başka
bir açık PR'ın head'i olan yığılmış (stacked) bir alt öğe dahil. İşlerin çalışıp
çalışmayacağına temel dal değil `paths:` filtresi karar verir: yalnızca
dokümanlara veya `devlog/` dizinine dokunan bir PR hiçbir şeyi kuyruğa almaz.

- **Tür etiketi (Type label).** `label` denetimi, PR başlığınızdan `bug` /
  `enhancement` / `documentation` / `chore` etiketlerini türetir. Tanınabilir
  bir önek içermeyen bir başlık (`stack 3/5: …`), genellikle kurallara uygun
  kalan PR commit'lerine geri döner; `chore` ailesi commit'leri (`test:`, `ci:`,
  `refactor:`), bir `fix:` veya `feat:` commit'inden daha üstün sayılmaz.
  Türleri gerçekten karıştıran bir PR tahmin edilmek yerine etiketsiz bırakılır
  ve bir insanın belirlediği bir etiketin üzerine asla yazılmaz.

CodeRabbit her PR'ı inceler ve bulguları tavsiye niteliğindedir. Doğru anladığı
şeyleri ele alın; yanlış olduğunda nedenini belirtin. Bir birleştirmeyi
engellemez.

### Bir iş akışı değişikliği ne zaman yürürlüğe girer?

`enforce-target` ve `label` güvenilen varsayılan dal otomasyonunu kullanır. PR
kapısı, her ikisi de depo varsayılan dalından yüklenen `pull_request_target`
üzerinde ve CodeRabbit `status` olaylarında çalışır; bu nedenle yazma yeteneğine
sahip davranış yalnızca kapı revizyonu `main` dalına yükseltildikten sonra
değişir. Çapraz platform CI iş akışı `pull_request` üzerinde çalışır ve
hedeflenen dalda yer aldığı anda yürürlüğe girer.

## Desteklenen yüzeyler (Sponsored surfaces)

Kimlik doğrulama, kimlik bilgisi işleme, GitHub Actions iş akışları, sürüm
otomasyonu ve bağımlılık kurulumu, birleşmeden önce bir bakımcının değişikliğe
sponsor olmasını (`maintainer-sponsored`) gerektirir. Bu yüzeylerdeki hatalı bir
birleştirme maliyetlidir ve geri alınması zordur, bu nedenle yalnızca bu
yüzeyler bu şekilde denetlenir. Diğer her şey açıktır.

## Bir çekme isteği kapatıldığında

Çözülmemiş inceleme geri bildirimleriyle takılan bir PR, nedeni açıkça
belirtilerek kapatılabilir. Kapatma, katkıda bulunan hakkında bir hüküm
değildir: belirtilen neden çözüldükten sonra yeniden açın veya temiz bir
tanesiyle değiştirin. Neden açık değilse sorun.


