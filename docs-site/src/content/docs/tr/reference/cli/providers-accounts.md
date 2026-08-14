---
title: CLI Sağlayıcılar, Hesaplar ve Modeller
description: Sağlayıcı yapılandırması, kimlik bilgileri, kota ve model kataloğu komutları.
---

Bu komutlar yukarı akış sağlayıcılarını yapılandırır, hesapların kimliğini
doğrular, kimlik bilgisi havuzlarını yönetir ve Codex'e sunulan model kataloğunu
kontrol eder.

## Sağlayıcılar

### `ocx provider <alt-komut>`

Etkileşimsiz sağlayıcı yönetimi. Kayıt defteri girdileri ada göre beslenir; özel
bir ad hem `--adapter` hem de `--base-url` gerektirir.

| Alt komut | Desteklenen bayraklar | Eylem |
| --- | --- | --- |
| `list` | `--json` | Yapılandırılmış sağlayıcıları ve kalan kayıt defteri girdilerini listeleyin. |
| `add <ad>` | `--adapter <adapter>`, `--base-url <url>`, `--api-key <key>`, `--default-model <model>`, `--set-default`, `--force`, `--json`, `--sync` | Bir kayıt defteri/özel sağlayıcı ekleyin. `--force` üzerine yazar; `--sync`, insan çıktısı modunda çalışan bir proxy'yi yeniler. |
| `edit <ad>` | sağlayıcı alan bayrakları, `--headers <json>`, `--json` | Anahtar havuzlarını değiştirmeden doğrulanmış canlı sağlayıcı alanlarını düzenleyin. `--headers` özel istek başlıklarını birleştirir; temizlemek için `{}` veya `-` iletin. |
| `test <ad>` | `--json` | Gerçek yukarı akış model uç noktasını araştırın. |
| `show <ad>` | `--json` | Maskelenmiş API anahtarlarıyla yapılandırmayı gösterin. |
| `remove <ad>` | `--json` | Varsayılan olmayan bir sağlayıcıyı kaldırın; son sağlayıcı kaldırılamaz. |
| `set-default <ad>` | `--json` | Mevcut bir sağlayıcıyı varsayılan olarak seçin. |
| `selected <ad>` | `--set <ids>`, `--clear`, `--json` | Sağlayıcı model izin listesini okuyun veya güncelleyin. |
| `quota` | `--refresh`, `--json` | Sağlayıcı kota raporlarını okuyun. |
| `presets` | `--json` | Kontrol paneli sağlayıcı önayarlarını listeleyin. |
| `account-mode` | `pool`, `direct`, `--json` | Havuzlanmış veya doğrudan Codex hesap yönlendirmesini seçin. |

```bash
ocx provider list --json
ocx provider test ark
ocx provider add anthropic --api-key sk-ant-... --set-default --sync
ocx provider add local-dev --adapter openai-chat --base-url http://localhost:11434/v1
ocx provider show anthropic --json
ocx models --provider anthropic --json
ocx models live --provider ark --json
```

:::caution[Özel başlıklar bir kimlik bilgisi kanalı değildir]
`--headers`, gizli olmayan istek meta verileri içindir — yönlendirme ipuçları,
kiracı veya proje seçicileri, izleme kimlikleri. Kimlik doğrulama materyali
koyacak bir yer **değildir** ve doğrulayıcı standart kimlik bilgisi başlık
adlarını (`Authorization`, `X-Api-Key`, `Cookie` ve geri kalanı) `apiKey` /
`authMode` işaretçisi ile reddeder.

Doğrulayıcı `X-My-Token` gibi rastgele bir adı tanıyamaz, bu nedenle sınır sizin
saygı duymanız gereken bir sınırdır. Önemli olmasının iki nedeni:

- JSON bir komut satırı argümanıdır, bu nedenle içindeki bir sır kabuk geçmişine
  ve makinedeki diğer herhangi bir sürecin CLI herhangi bir şeyi maskelemeden
  önce okuyabileceği süreç listesine düşer.
- Başlık değerleri, kendi depolama ve maskeleme yoluna sahip olan API
  anahtarlarının aksine `config.json` dosyasında açık metin olarak kalıcı hale
  getirilir.

Gizli olan her şey için `--api-key` veya bir OAuth girişi kullanın.
:::

## Kimlik Doğrulama

### `ocx login <saglayici>`

Sağlayıcının kayıtlı giriş akışını başlatın. OAuth sağlayıcıları bir tarayıcı
açar ve otomatik olarak yenilenen kimlik bilgilerini `~/.opencodex/` altında
saklar; API anahtarı girişi sağlayıcıları anahtar kontrol panellerini açar,
anahtarı sorar, mümkün olduğunda doğrular ve ortaya çıkan sağlayıcı
yapılandırmasını kaydeder. Komut ad eksik veya bilinmediğinde geçerli olarak
kabul edilen OAuth ve API anahtarı sağlayıcı kimliklerini yazdırır.

`ocx status` / `ocx doctor` yeniden kimlik doğrulama gerektiğini veya bir
terminal yenileme hatasını bildirdikten sonra **yeniden kimlik doğrulaması
yapmak** için aynı komutu kullanın (veya kontrol panelinde Yeniden Kimlik
Doğrula'yı kullanın). Codex havuz hesapları genel bir `ocx login` sağlayıcısı
değildir — bunun yerine kontrol paneli Codex hesap havuzu (Yeniden Kimlik
Doğrula) veya başsız `ocx account reauth` akışı aracılığıyla yeniden kimlik
doğrulaması yapın.

```bash
ocx login xai
ocx login anthropic
```

Zaten çalışan bir proxy yeni kimlik bilgisini yeniden başlatmadan alır: CLI
diskten o tek sağlayıcıyı yeniden yüklemesini ister ve istek kendi kimlik
bilgisini taşımaz. Çalışan proxy bu isteği kabul edemezse — çoğunlukla
onaylanmış yeniden yüklemeden önceki bir derlemeden başladığı için — giriş yine
de başarılı olur ve kimlik bilgisi yine de diske yazılır, ancak canlı süreç
önceki kimlik bilgisini sunmaya devam eder. CLI bunu belirtir ve yeniden
başlatmanızı ister:

```
⚠️  A proxy is running but could not reload this provider (unattested-target).
   The credential is saved to disk; the running proxy keeps using the previous one.
   Restart it to pick this up: ocx restart
```

### `ocx logout <saglayici>`

Bir sağlayıcı için saklanan OAuth kimlik bilgisini kaldırın.

## Hesaplar ve anahtar havuzları

### `ocx account <alt-komut>`

Çalışan proxy aracılığıyla sağlayıcı hesaplarını ve API anahtarı havuzlarını
listeleyin ve değiştirin. Sağlanan yardım arayüzü şöyledir:

```text
Usage: ocx account <list|current|use|refresh|auto-switch|priority|login|reauth|code|cancel|remove|add-key|reset-credits> ...

list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).
current <provider>  Show the active account or key.
use <provider> <id> Switch the active credential; 'main' selects the Codex App login.
refresh <provider>  Force-refresh Codex or provider quota reports.
auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.
priority <provider> <id|main> [first|earlier|normal|later|last|-100..100|reset]  Selection order; omit the value to read it.
remove <provider> <id> --yes  Remove a stored account or key after an existence check.
add-key <provider> [--label <label>]  Add a key read only from piped stdin.
login/reauth/code/cancel  Run browser or manual-code auth from a headless shell.
reset-credits <id|main> [--consume --yes]  Inspect or consume Codex reset credits.
Switching the active account takes effect immediately; running threads move on their next request, and in-flight requests keep the account they captured.
A selection-order change applies from the next unbound request and never moves a bound thread.
```

Tüm alt komutlar proxy'nin çalışmasını gerektirir; CLI kaydedilen çalışma zamanı
portunu otomatik olarak çözer. Başarılı işlemler 0 ile çıkar. Geçersiz kullanım,
bilinmeyen bir sağlayıcı veya hesap/anahtar kimliği, erişilemeyen bir proxy veya
bir API hatası 1 ile çıkar. Kimlik bilgisi alanları tam olarak yönetim API'sinin
döndürdüğü gibi (maskelemesi dahil) görüntülenir; ham API anahtarları ve OAuth
belirteçleri asla döndürülmez. Görüntüleme kolaylıkları kontrol paneli gibi
istemci tarafında sentezlenir: `main`, `openai` hesap havuzundaki Codex App
girişi için CLI takma adıdır, e-postası olmayan OAuth hesapları `Account N`
olarak görünür ve plan/etiket sütunu plan, maskelenmiş e-posta, etiket ve
maskelenmiş anahtar arasında geri döner.

`--json` hesap satırları bu ortak şekli kullanır (isteğe bağlı alanlar
kullanılamadığında atlanır):

```json
{
  "provider": "openai",
  "type": "codex | oauth | api-key",
  "id": "__main__",
  "label": "plus",
  "email": "m***@example.com",
  "plan": "plus",
  "masked": "sk-ab****wxyz",
  "priority": 0,
  "active": true,
  "needsReauth": false,
  "quota": null
}
```

### `ocx account list [provider] [--json] [--all]`

Bir sağlayıcı olmadan Codex havuzunu, OAuth hesaplarını ve yapılandırılmış API
anahtarı havuzlarını listeler. `--all` bulunmadıkça boş sağlayıcılar atlanır.
Bir sağlayıcı ile yalnızca bu kimlik bilgisi ailesini listeler. İnsan çıktısı
`PROVIDER TYPE ID PLAN/LABEL PRIORITY STATUS` kullanır; manuel olarak seçilen
bir Codex satırı `selected` olarak işaretlenir. `PRIORITY`, imzalı Codex seçim
sırasıdır (ayarlanmadığında `0`) ve OAuth hesapları ve API anahtarları gibi
sıralamanın geçerli olmadığı satırlar için `-` gösterir. Saklanan bir Kiro
hesabı mevcut olduğunda çıktı Kiro'nun tek bir giriş yuvasına sahip olduğunu ve
tekrar oturum açmanın geçerli hesabın yerini alacağını belirtir. Boş bir sonuç
yine de başarıdır. `--json` şunu döndürür:

```text
{ accounts: AccountRow[], notes: string[] }
```

### `ocx account current <provider> [--json]`

Aktif hesabı veya anahtarı gösterir. Manuel sabitleme içermeyen bir Codex havuzu
öncelik duyarlı otomatik seçimi bildirir: en yüksek öncelikli uygun katman
seçilir ve kota yönlendirmesi altında bu katmandaki en düşük kullanımlı hesap
seçilir; etkin bir kimlik bilgisi olmayan başka bir aile bu durumu bildirir ve
yine de 0 ile çıkar. `--json` şunu döndürür:

```text
{ provider, type, activeId: string | null, autoSwitchThreshold?: number, account: AccountRow | null }
```

### `ocx account use <provider> <account-or-key-id|main> [--json]`

Mevcut bir Codex hesabını, OAuth hesabını veya API anahtarını seçer. `openai`
için `main` Codex App girişini seçer. Bir Codex Havuzu seçimi süreç içi yerel
bağlılığı temizler ve mevcut görünür bir görevden gelen istekler de dahil olmak
üzere bir sonraki isteğe uygulanır; proxy yeniden başlatması veya bağlılık
çıkarma işlemi de bir görevi bağımsız bırakabilirken devam eden istekler
yakaladıkları hesabı tutar. Bu yalnızca Havuz yönlendirmesini denetler; Direct
modu arayana ait/yerel ana kimlik bilgisini kullanmaya devam eder. Kullanıma
dayalı proaktif geçiş, 401/403 yeniden kimlik doğrulaması, 429/retry-after
soğuma süreleri, hariç tutma ve çıktı öncesi 429/402 arıza kurtarma daha sonra
başka bir uygun Havuz hesabını seçebilir. Bu kurtarma yolları kullanıma dayalı
geçiş kapalı olduğunda da aktif kalır. OpenCodex bir hesap değişikliğinden sonra
görüşmeyi yeniden oynatır, ancak sağlayıcı tarafındaki istem önbelleği soğuk
olabilir. Bilinmeyen sağlayıcılar veya kimlikler 1 ile çıkar.
Bir **401/403** durumunda, App girişi o hesabın süreç içi yerel bağlılığını
temizler ve yeniden kimlik doğrulama gerektirir.
Bir **429** durumunda, opencodex `Retry-After`'a uyar, hesap soğuma süresini
başlatır, bağlılığı temizler ve isteği başka bir uygun Havuz hesabına
döndürebilir. Bu arıza geçişleri `autoSwitchThreshold: 0` ile aktif kalır; bu
ayar yalnızca kullanıma dayalı proaktif geçişi devre dışı bırakır.
`--json` şunu döndürür:

```text
{ ok: true, provider, type, activeId }
```

### `ocx account refresh <provider> [--json]`

Codex havuzu için `ocx account refresh openai [--json]` kullanın. Hesap
kotalarını yenilemeye zorlar ve kullanılabilir haftalık/aylık yüzdeleri ve
sıfırlama sürelerini yazdırır; eksik kota verileri %0 olarak değil, bilinmeyen
olarak bildirilir. JSON zarfı her Codex satırında `quota` ile birlikte `{
accounts: AccountRow[] }` şeklindedir.

OAuth ve API anahtarı sağlayıcıları için bu, sağlayıcı kota raporu uç noktasını
yenilemeye zorlar; bir belirteç yeniden girişi veya düz bir hesap listesi
yeniden okuması değildir. `--json`, `{ provider, report: ProviderQuotaReport |
null }` döndürür. Desteklenen bir kota raporu olmayan bir sağlayıcı `<provider>
için kota raporu yok` yazdırır ve 0 ile çıkar. Bilinmeyen sağlayıcılar ve
yönetim API'si arızaları 1 ile çıkar; başarısız olan veya zaman aşımına uğrayan
bir yukarı akış kota probu bunun yerine kontrol panelinin kota çubuklarıyla
eşleşen null veya eski bir rapora düşer (çıkış 0).

### `ocx account auto-switch <provider> <on|off|status|threshold <0-100>> [--json]`

Yalnızca `openai` Codex hesap havuzunu denetler. `on` %80'i ayarlar, `off` %0'ı
ayarlar, `status` geçerli değeri okur ve `threshold <n>` 0 ile 100 arasında bir
tamsayı kabul eder. Diğer sağlayıcılar ve geçersiz değerler 1 ile çıkar.
`--json` şunu döndürür:

```text
{ provider, autoSwitchThreshold: number, enabled: boolean }
```

### `ocx account priority <provider> <account-id|main> [<-100..100|first|earlier|normal|later|last|reset>] [--json]`

Bir Codex havuz hesabının seçim sırasını okur veya ayarlar: **daha yüksek olan
daha önce kullanılır**, varsayılan `0`'dır ve aralık `-100` ile `100`
arasındadır. Yalnızca `openai` Codex havuzu sıralanır, bu nedenle diğer
sağlayıcılar 1 ile çıkar. `main`, diğer herhangi bir havuz hesabı gibi sıralanan
Codex Desktop girişini hedefler — `ocx account priority openai main last`, onu
yedek olarak tutma şeklinizdir.

Önayar kelimeleri küçük tamsayıların yerine geçer: `first` `+2`, `earlier` `+1`,
`normal` `0`, `later` `-1` ve `last` `-2`'dir. `reset`, hesabı varsayılana
döndürür ve saklanan girdisini bırakır. **Değeri atlamak**, bir tane yazmak
yerine geçerli sırayı **okur**.

Sıralama hangi hesapların kullanılabilir olduğunu değil, hangi hesapların önce
değerlendirileceğini seçer: seçim hala uygun hesaplar arasında çalışır, hala
kota payına sahip en yüksek sıra katmanını alır ve `accountPoolStrategy`'nin
içinde seçim yapmasına izin verir. Duraklatma, soğuma süresi ve yeniden kimlik
doğrulama etkilenmez. Değişiklikler yalnızca yeni başlatılan oturumlardan değil,
**bir sonraki bağımsız istekten** itibaren geçerlidir: önceliklendirme daha
yüksek bir sıra pay kazandığı anda bağımsız bir isteği yukarı taşır. Bir hesaba
zaten bağlı olan iş parçacıkları normalde o hesap boşalana kadar onu tutar; bir
yeniden kimlik doğrulama hatası, bir kota soğuma süresi veya bir geçici arıza
serisi bundan önce bağlamayı serbest bırakır. Kabul edilen herhangi bir yazma,
hangi hesap tutarsa tutsun manuel bir "bu hesabı şimdi kullan" sabitlemesini de
serbest bırakır, bir hesabın zaten sahip olduğu sırayı saklayan bir yazma dahil
— bu, geçerli olarak seçilen hesabı tutarken bir sabitlemeyi temizlemenin tek
yoludur. (Aktif hesabı yönetim API'si aracılığıyla temizlemek de bir sabitlemeyi
serbest bırakır, ancak bu seçimi de onunla birlikte bırakır.) Erişilemeyen bir
proxy, bilinmeyen bir hesap kimliği veya kabul edilen kümenin dışındaki bir
değer 1 ile çıkar. `--json` şunu döndürür:

```text
{ ok: true, provider, id, priority: number, preset: string | null }
```

### `ocx account login|reauth|code|cancel ...`

Başsız bir kabuktan tarayıcı tabanlı veya manuel kodlu hesap kimlik
doğrulamasını çalıştırın. Sağlayıcıya özgü komut şekli için `ocx account --help`
kullanın. Bir Codex hesap girişi kaydedilirse ancak model kataloğu yenilemesi
beklemede kalırsa insan çıktısı yine de başarıyla çıkar ve stderr'e sabit `ocx
sync` kurtarma rehberliği yazdırır. `--json`, stdout'u ayrıştırılabilir tutar ve
insan uyarısı olmadan tamamlanan giriş durumunda `catalogRefreshPending: true`
taşır.

### `ocx account remove <provider> <id|main> --yes [--json]`

Bu korumalı, etkileşimsiz silme işlemi `--yes` gerektirir. Silmeden önce
kimliğin var olduğunu doğrular; eksik bir kimlik DELETE göndermeden 1 ile çıkar.
Ana Codex App girişi kaldırılamaz, bu nedenle `remove openai main --yes`
reddedilir. Silme işleminden sonra aile tekrar okunur: sabitlenmiş Codex
hesabını kaldırmak sabitlemeyi temizler ve otomatik seçime döner; OAuth kalan
ilk hesabı yükseltir veya hiçbirini bildirmez; API anahtarı havuzları kalan ilk
anahtarı yükseltir veya hiçbirini bildirmez. `--json` başarı ve başarısızlık
şekilleri şunlardır:

```text
{ ok: true, provider, id, removedActive: boolean, promotedActiveId: string | null, catalogRefreshPending?: boolean }
{ error: string } // stderr, cikis 1
```

`catalogRefreshPending` yalnızca Codex kaldırmalarında bulunur. `true` olduğunda
hesap silme işlemi zaten kaydedilmiştir; insan çıktısı stderr'e genel `ocx sync`
kurtarma rehberliği yazdırır ve yine de 0 ile çıkar. OAuth hesabı ve API
anahtarı kaldırma zarfları bu alanı kazanmaz.

### `ocx account add-key <provider> [--label <label>] [--json]`

Bir API anahtarı sağlayıcısı için bir anahtar ekler ve etkinleştirir. Anahtar
yalnızca TTY olmayan yönlendirilmiş/borulanmış stdin'den okunur; etkileşimli TTY
girişi, boş girdi, OAuth/Codex sağlayıcıları ve API arızaları 1 ile çıkar.
Anahtar, bir etiketin içinde göründüğü durumlar da dahil olmak üzere asla
yankılanmaz. Bir gizli dizi yöneticisini veya bir here-string'i tercih edin:

```bash
ocx account add-key openrouter --label personal <<< "$OPENROUTER_API_KEY"
security find-generic-password -w openrouter | ocx account add-key openrouter --json
```

`--json`, `{ ok: true, id: string | null, label?: string }` döndürür ve asla
anahtarı içermez.

### `ocx account reset-credits <id|main> [--consume --yes]`

Bir hesap için Codex sıfırlama kredilerini inceleyin. Bir krediyi tüketmek
yıkıcıdır ve hem `--consume` hem de `--yes` gerektirir.

### `ocx account main <alt-komut>`

OpenCodex hesap havuzu yönlendirmesini değiştirmeden adlandırılmış yerel Codex
ana giriş profillerini yönetin:

```text
ocx account main doctor [--json]
ocx account main list [--json]
ocx account main register <etiket> [--json]
ocx account main add <etiket>
ocx account main switch <profil-id-veya-etiket> --yes [--json]
ocx account main recover [--rollback --yes] [--json]
```

Değiştiren her komut çalışan proxy tarafından döndürülen kurallı etkin
`CODEX_HOME`'u bildirir. Bu yol arayanın `CODEX_HOME`'undan farklı olabilir;
JSON'ı destekleyen komutlar aynı değeri `effectiveCodexHome` olarak açığa
çıkarır.

Sürüm 1 dosya tabanlı Codex kimlik doğrulamasını destekler, saklanan profilleri
AES-256-GCM ile şifreler ve şifreleme anahtarını işletim sistemi kimlik bilgisi
deposunda tutar. `add`, ortaya çıkan kimlik bilgisini içe aktarmadan önce resmi
Codex giriş akışını hazırlar. Profilleri değiştirmeden önce Codex'i kapatın;
başarılı bir geçiş yerel görevleri ve geçmişi korur, ardından Codex'in yeniden
başlatılmasını gerektirir. Profil durumunu incelemek için `doctor` ve kesintiye
uğrayan bir geçişi tamamlamak veya geri almak için `recover` kullanın. `switch`,
profil kimliğini veya etiketini kabul eder.

v1 kurtarma matrisi, bir işlem dosyası yeniden adlandırma yoluyla yayınlandıktan
sonra çıkan bir OpenCodex sürecini kapsar. Bir işletim sistemi veya çekirdek
çökmesi ya da ani güç kaybı genelinde dayanıklılık iddia etmez:
`atomicWriteFileAsync()`, dosyayı veya üst dizinini `fsync` yapmaz.

Şifrelenmiş kasa, geçiş günlüğü, kurtarma işaretçisi ve günlük karantinası
kurallı `<gercek CODEX_HOME>/.opencodex-native-main-profiles` dizininde bulunur,
böylece bu Codex ana dizinini paylaşan her OpenCodex örneği tek bir sahip ve tek
bir kurtarma durumu gözlemler. Düz metin giriş hazırlığı her
`<OPENCODEX_HOME>/native-main-profile-staging` dizini altında yalıtılmış olarak
kalır.

Yerel ana trafiğe veya günlük kurtarmaya izin verilmeden önce yaşam boyu sahibi
özel kimlik bilgisi talebini alır ve yalnızca tam
`auth.json.ocx.<pid>.<sequence>.tmp` çökme kalıntılarını kaldırır. Her aday
değişmeyen kurallı `CODEX_HOME` altında tek bağlantılı normal bir dosya olarak
kalmalıdır; kesilir, temizlenir ve ardından bağlantısı kesilir. Bağlantı/yeniden
ayrıştırma ikameleri, kimlik değişiklikleri ve diğer belirsizlikler yerel ana
trafiği kapalı tutarken yakın eşleşen adlar asla otomatik olarak kaldırılmaz.
Bu, aynı işletim sistemi kullanıcısı olarak çalışan kötü niyetli bir sürece
karşı değil, işbirlikçi OpenCodex çökmelerine karşı koruma sağlar. Bu kullanıcı
ve `CODEX_HOME`'u içeren dosya sistemi güvenilir kalır ve kesme işlemi yazma
üzerine kopyalama depolamasından, anlık görüntülerden veya SSD kalıntısından
fiziksel silme vaat etmez.

Önizleme derlemeleri `<OPENCODEX_HOME>/native-main-profiles` kullanmıştır. Bu
düzen asla sessizce içe aktarılmaz. `doctor` eski profil durumunu bildirirse
aynı `CODEX_HOME`'u paylaşan her OpenCodex proxy'sini durdurun. Ardından eşleşen
`*.vault.json`, `*.journal.json`, kurtarma işaretçisini ve başvurulan herhangi
bir günlük karantinası dosyasını yalnızca sahip izinlerini koruyarak birlikte
kurallı dizine yedekleyip taşıyın ya da eski önizleme kümesini kaldırıp `ocx
account main register`'ı tekrar çalıştırın. Birden fazla eski kök arasında seçim
yapmayın veya paylaşım yapan herhangi bir proxy etkinken her iki düzeni de
çalıştırmayın.
Windows'ta önceki büyük/küçük harf katlanmış ana kimlik ile anahtarlanan
önizleme durumu taşınmak yerine sıfırlanmalıdır çünkü şifrelenmiş AAD'si ve
işletim sistemi anahtarlık kimliği kasıtlı olarak yeniden kullanılmaz.

## Modeller

### `ocx models [alt-komut]` · `ocx model <alt-komut>`

`ocx model`, `ocx models`'ın bir takma adıdır. Alt komut olmadan yapılandırılmış
sağlayıcılarda statik olarak beslenen modelleri listeler. `--provider`
yapılandırılmış bir sağlayıcıyı filtreler ve `--json` model meta verilerini
döndürür. `live` çalışan kataloğu okur; `add`, `edit`, `remove` ve `list-custom`
manuel katalog girdilerini yönetir; `enable`, `disable` ve `provider`
görünürlüğü kontrol eder; `selected` bir sağlayıcı izin listesini kontrol eder;
`context` sağlayıcı bağlam sınırlarını kontrol eder; ve `shadow` arka plan gölge
çağrı müdahalesini yönetir.

Kontrol panelinin sunduğu model başına her işlem burada mevcuttur, bu nedenle
başsız bir kurulum bir kataloğu yönetmek için asla GUI'ye ihtiyaç duymaz. `add`,
`remove` ve `list-custom` yapılandırma dosyasına karşı çalışır ve bir katalog
senkronizasyonu aracılığıyla çalışan bir proxy'ye uygulanır; geri kalanı canlı
yönetim API'si ile konuşur ve proxy'nin çalışmasını gerektirir (`ocx start` veya
kurulu bir servis).

| Alt komut | Desteklenen bayraklar | Eylem |
| --- | --- | --- |
| `list` (varsayılan) | `--provider <ad>`, `--json` | Yapılandırılmış sağlayıcılarda beslenen modelleri listeleyin. |
| `live` | `--provider <ad>`, `--json` | Çalışma zamanında keşfedilen modeller de dahil olmak üzere çalışan kataloğu okuyun. Satırlar `native`/`routed`, `custom` ve `enabled`/`disabled` olarak bayraklanır. |
| `add <saglayici> <modelId>` | `--display-name <ad>`, `--context-window <tokens>`, `--modalities <text,image,audio>` | Sağlayıcı kataloğunun bildirmediği bir modeli kaydedin. |
| `edit <custom-id>` | `--model-id <id>`, `--display-name <ad\|->`, `--context-window <tokens\|0>`, `--modalities <text,image,audio\|->`, `--json` | Özel bir modeli düzenleyin. `-` bir alanı temizler; `0` bağlam penceresini temizler. |
| `remove <custom-id\|provider/modelId>` | `--yes` | Özel bir modeli silin. Stdin etkileşimli bir terminal olmadığında `--yes` gerektirir. |
| `list-custom` | `--json` | Diğer alt komutların aldığı `custom-id` ile tüm özel modelleri gösterin. |
| `enable <provider/model\|native-model>` | `--native`, `--json` | Bir modeli Codex için görünür yapın. |
| `disable <provider/model\|native-model>` | `--native`, `--json` | Bir modeli Codex'ten gizleyin. |
| `provider <ad> <on\|off>` | `--json` | Tek bir yazmada bir sağlayıcının her modelini etkinleştirin veya devre dışı bırakın. |
| `selected <saglayici>` | `--set <id,id...>`, `--clear`, `--json` | Sağlayıcı model izin listesini okuyun veya değiştirin. `--clear` her modelin sunulması için izin listesini kaldırır. |
| `context <status\|value <tokens> [--set-all]\|provider <ad> on [--value <tokens>]\|provider <ad> off\|all <on\|off>>` | `--json` | Küresel olarak veya sağlayıcı başına bağlam penceresi sınırını okuyun veya ayarlayın. `value <tokens> --set-all` ayrıca her yönlendirilen sağlayıcıyı yeniden yönlendirir (kontrol paneli anahtarı gibi); bu olmadan değer yalnızca varsayılan olur. `provider ... on --value <tokens>` yalnızca o sağlayıcı için açık bir sınır belirler (`--value` yalnızca `on` ile geçerlidir). |
| `shadow <status\|set> [model\|-]` | `--enabled <on\|off>`, `--json` | Codex'in arka plan yardımcı çağrıları için değiştirme modelini okuyun veya ayarlayın. `-` modeli temizler. `status` ayrıca proxy'nin müdahale ettiği yardımcı slug'ları olan `sourceModels`'ı bildirir (varsayılan: `gpt-5.6-luna`; 0.144.x'e kadar olan istemciler açık bir `sourceModels` geçersiz kılmasının geri yükleyebileceği `gpt-5.4-mini` kullanmıştır). |

```bash
ocx models live --json                                  # Codex'in şu anda gerçekte görebildikleri
ocx models disable anthropic/claude-haiku-4             # bir yönlendirilen modeli gizle
ocx models enable gpt-5.6-sol                           # eğik çizgi yok, bu yüzden yerel olarak kabul edilir
ocx models provider zenmux off                          # gürültülü bir sağlayıcıyı toptan gizle
ocx models selected anthropic --set claude-opus-5,claude-fable-5
ocx models selected anthropic --clear                   # izin listesini tekrar kaldır
ocx models add deepseek deepseek-v4 --display-name 'DeepSeek V4' --context-window 128000 --modalities text,image
ocx models list-custom --json                           # düzenleme/kaldırma için custom-id'yi oku
ocx models remove deepseek/deepseek-v4 --yes
```

Eğik çizgi içeren bir model seçici yönlendirilir (`anthropic/claude-opus-5`);
yalın bir kimlik yerel bir OpenAI modeli olarak kabul edilir, bu nedenle
`--native` yalnızca aksi takdirde yönlendirilmiş görünecek bir kimlik için bu
okumayı zorlamak için gereklidir.

`--modalities` yalnızca `text`, `image` ve `audio` kabul eder. Codex bu alanı
kapalı bir enum olarak ayrıştırır ve başka herhangi bir değer içeren tüm bir
kataloğu reddeder, bu nedenle `add`, `edit` ve yönetim API'si katalog
yazıcısının daha sonra çıkarması gereken bir şeyi saklamak yerine hatalı değeri
reddeder (#759).


