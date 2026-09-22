---
title: Yerel ana giriş profilleri
description: Saklanan yerel Codex giriş profillerini OpenCodex Pool yönlendirmesinden ayrı yönetin.
---

## Yerel giriş, Pool seçimi değildir

**Codex Set → Multi-auth** içinde ana hesap kartının hemen altındaki ayrı
**Native main login** panelinde **Manage main login** seçeneğini açın. Aynı panel,
Providers hesap çalışma alanında ana kartın yanında da görünür. Sonraki Pool
isteği için seçilen hesabı değil, fiziksel Codex girişini yönetir. Integrations
sekmesi eklemez veya mevcut Pool denetimlerinin yerini almaz.

Gösterilen **Effective CODEX_HOME**, OpenCodex sunucusuna aittir. Uzak bir kontrol
paneli kullanıldığında bu, tarayıcıdan farklı bir bilgisayar olabilir.
**Registered active profile**, şifreli profil deposunda kayıtlı sahibi gösterir;
sunucu geçişten önce fiziksel girişi doğrular. Bu yüzden OpenCodex dışında
değiştirilen bir giriş sessizce üzerine yazılmak yerine sahiplik uyuşmazlığı
hatası üretebilir.

## Kaydetme ve geçiş yapma

Mevcut uygulama girişini kaydetmek için **Save current as profile** seçeneğini
kullanın. Zaten kayıtlı etkin bir giriş için bu işlem etiketi günceller; yeni
bir hesap kaydetmez. Profil değiştirmek için desteklenen dosya kimlik bilgisi
deposu ve kullanılabilir bir işletim sistemi anahtar deposu gerekir. Tanılama
kodları denetimlerin neden kullanılamadığını açıklar; anahtar deposu veya
sahiplik hatasını aşmak için Pool kimlik bilgilerini yerel giriş dosyasına
kopyalamayın. Ana kartın mevcut yerel cihaz yeniden kimlik doğrulama işlemi
sürerken panel devre dışıdır.

Saklı ve etkin olmayan bir profilin yanından **Switch** seçin. Hedef etiketi ve
sunucu tarafındaki ev dizinini inceleyin, bu dizini kullanan yerel Codex'i
durdurun, ardından durdurma onayını işaretleyip gönderin. Onaydan önce hiçbir
kimlik bilgisi değişikliği gönderilmez. Panel göndermeden hemen önce geçerli ev
dizinini, etkin sahibi ve kurtarma durumunu yeniden okur. Durum değiştiyse yeni
durumu inceleyip tekrar onaylayın. Kilitler, süreç denetimleri, devam eden
isteklerin bitirilmesi, etkinleştirme ve geri alma için mevcut arka uç yetkili
kalmaya devam eder.

Başarıdan sonra gösterilen yeniden başlatma gereğini izleyin ve yerel Codex'i o
ev diziniyle yeniden açın. Panel profil durumunu yeniden okur ve mevcut hesap
denetleyicisini yeniler. Pool seçimi/yapılandırması değişikliklerini çağırmaz;
sağlayıcı anahtarlarını, görevleri veya geçmişi düzenlemez. Mevcut arka uç,
CLI iş akışındaki gibi yerel `__main__` kimliğini uzlaştırmaya devam eder.

## Kurtarma ve önceki profiller

Bunlar farklı işlemlerdir:

- **Recover interrupted change**, yarım kalmış bir arka uç işlemini uzlaştırır. **Restore pending transaction**, o işlemin geri alınmasını ister. Her ikisi de ayrı bir durdurma onayı gerektirir. Hasarlı profil listesi okunamasa da tanılama bekleyen kurtarma bildiriyorsa bu denetimler kullanılabilir kalır.
- Başarılı bir geçişten sonraki **Return to previously displayed**, geçişten önce gösterilen profili normal, onaylı geçiş iş akışıyla seçer. Bu kısayol yalnızca sayfa belleğinde tutulur, ev dizini ve beklenen etkin sahiple sınırlıdır; sayfa yeniden yüklendiğinde veya proxy/sahip değiştiğinde kaybolur. API işlemin kaynak profilini döndürmez; bu nedenle sunucuca doğrulanmış bir geri alma günlüğü değildir: başka bir operatör ön denetim okuması ile geçişiniz arasında girişi değiştirmiş olabilir. Yeniden yükledikten sonra istediğiniz kayıtlı profili doğrudan seçin.

Bir ağ hatası, yazmanın başarısız olduğunu veya geri alındığını kanıtlamaz.
Panel, yanıt kaybolsa bile gönderilmiş bir değişiklikten sonra sunucu durumunu
yeniden okur ve işlemi otomatik olarak yeniden denemez. Yenileme başarısızsa
başarılı bir değişiklik geri alınmış gibi bildirilmez. Başka işlemden önce
yenileyip tanılamayı inceleyin. Mevcut `ocx account main doctor` komutu sunucu
tarafı tanılama sağlar.

## Bu aşamanın kapsamı

Bu panel, mevcut `/api/native-main-profiles` sınırını kullanarak profilleri
listeler, kaydeder, değiştirir ve kurtarır. Giriş süreçleri başlatmaz veya
hazırlık yazıcısı belirteçlerini açığa çıkarmaz. Başka bir yerel giriş eklemek,
mevcut `ocx account main add` CLI iş akışında kalır; tarayıcıdan kayıt, #3417
numaralı konunun ayrı bir devam işidir. Geçerli ana yuvanın mevcut cihaz
yeniden kimlik doğrulaması farklı bir iş akışıdır ve bu panel onun yerini almaz.

Profil verileri tarayıcı depolamasına yazılmaz. İstemci yalnızca genel alanları
gösterir, ham sunucu iletileri yerine izin listesindeki hata kodlarını sunar ve
uygulamanın mevcut kimliği doğrulanmış fetch sarmalayıcısını kullanır. Arka ucun
yönetim kimlik doğrulaması, GUI oturumu/CSRF ve rota kabul denetimleri değişmez.
