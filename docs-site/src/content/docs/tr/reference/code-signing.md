---
title: Windows kod imzalama
description: OpenCodex Windows dosyalarının SignPath Foundation ile imzalanması, imzaların doğrulanması ve projenin kod imzalama ilkesi.
---

OpenCodex, bağımsız `ocx.exe` ve `OpenCodex-<version>-windows-x64.msi` masaüstü
yükleyicisi için [SignPath Foundation](https://signpath.org) üzerinden Authenticode
kod imzalamaya geçiyor. İmza, Windows'a, SmartScreen'e ve antivirüs ürünlerine
dosyayı kimin yayımladığını ve derlemeden sonra değiştirilmediğini bildirir.
Bu, [#7207](https://github.com/lidge-jun/opencodex/issues/7207) gibi imzasız
dosyalardan kaynaklanan yanlış alarmları önlemeye yardımcı olur.

Geçiş sürüyor. Yayın iş akışı hazır; SignPath bunu test sertifikasıyla doğruluyor.
Üretim sertifikası verilene kadar Windows yayın dosyaları imzasız kalır ve
SmartScreen bir kez **Ek bilgi → Yine de çalıştır** seçimini isteyebilir.
Geçişten sonra yayımlanan sürümler **SignPath Foundation** imzası taşır.

## Kod imzalama ilkesi

Ücretsiz kod imzalama [SignPath.io](https://about.signpath.io/), sertifika ise
[SignPath Foundation](https://signpath.org/) tarafından sağlanır.

- Kod katkısı yapanlar ve inceleyenler: [lidge-jun](https://github.com/lidge-jun)
- Onaylayanlar: [lidge-jun](https://github.com/lidge-jun)

Sertifika kullanılmadan önce her yayın imzalama isteği SignPath'te elle onaylanır.
Yalnızca bu deponun kaynaklarından GitHub Actions ile derlenen dosyalar imzalanır.
Önceden derlenmiş keyring eklentileri gibi sürüme eklenen üçüncü taraf dosyaları
özgün hallerini korur; SignPath Foundation ilkesi bunların proje sertifikasıyla
imzalanmasını yasaklar.

### Gizlilik

Bu program; kullanıcı, kuran kişi veya çalıştıran kişi açıkça istemedikçe başka
ağ sistemlerine bilgi aktarmaz. OpenCodex, istekleri yapılandırdığınız sağlayıcılara
iletir. Yeni sürümler için GitHub ve npm kayıt deposundan yayın meta verilerini
de okur; bu kontroller istemlerinizi, kimlik bilgilerinizi veya kullanım verilerinizi
taşımaz.

## İndirmeyi doğrulama

PowerShell'de indirdiğiniz dosyayı kontrol edin:

```powershell
Get-AuthenticodeSignature .\OpenCodex-<version>-windows-x64.msi | Format-List Status, SignerCertificate
Get-AuthenticodeSignature .\ocx.exe | Format-List Status, SignerCertificate
```

İmzalı sürüm `Status : Valid` ve konusunda `SignPath Foundation` bulunan bir
imzalayan sertifikası gösterir. Aynı bilgi Dosya Gezgini'nde **Özellikler → Dijital
İmzalar** altındadır. Yayın sayfasında her dosyanın yanında bir `.sha256` dosyası
da bulunur; bunu `Get-FileHash <file> -Algorithm SHA256` çıktısıyla karşılaştırın.

## İmzalanan dosyalar

| Dosya | İmzalanan içerik |
| --- | --- |
| `ocx-<version>-bun-windows-x64.zip` | Arşivdeki `ocx.exe`. ZIP ve `.sha256`, imzalı dosyadan oluşturulur. |
| `OpenCodex-<version>-windows-x64.msi` | Yükleyici ve kurduğu tüm `.exe` dosyaları: masaüstü uygulaması ile paketlenmiş `ocx.exe`. |

Masaüstü güncelleyici imzası (`.msi.sig`) ve `latest.json`, imzalı yükleyiciden
üretilir; uygulama içi güncellemeler yayın sayfasındaki aynı baytları kurar.

## Proje bakımını yapanlar için

`.github/workflows/release.yml`, resmi
`signpath/github-action-submit-signing-request` eylemini kullanır. Bir gizli değer
ve üç depo değişkeni okur:

| Ad | Tür | Değer |
| --- | --- | --- |
| `SIGNPATH_API_TOKEN` | Gizli değer | SignPath CI kullanıcısının API tokenı |
| `SIGNPATH_ORGANIZATION_ID` | Değişken | SignPath kuruluş kimliği |
| `SIGNPATH_PROJECT_SLUG` | Değişken | `opencodex` |
| `SIGNPATH_SIGNING_POLICY_SLUG` | Değişken | Şimdilik `test-signing`; sertifika verilince `release-signing` |

SignPath çıktı yapılandırmaları: `windows-standalone-zip` (ZIP kökünde tek
`ocx.exe`) ve `windows-msi-zip` (ZIP kökünde tek `.msi`, iç dosyaları da imzalanır).

İmzalama, yayını engellemez. İşleyiş seçilen ilkeye bağlıdır:

| İlke | Deneme çalıştırması | Gerçek yayın |
| --- | --- | --- |
| Token yok veya yapılandırma eksik | İmzasız | Bildirim veya uyarıyla imzasız |
| `test-signing` | Test sertifikasıyla imzalanır, yalnızca iş akışı çıktısı olarak tutulur | Bildirimle imzasız; test sertifikası hiçbir zaman yayımlanmaz |
| `release-signing` | İmzalanır ve güvenilirliği doğrulanır | İmzalanır ve güvenilirliği doğrulanır |

İstek başarısız olur, zaman aşımına uğrar veya reddedilirse ya da doğrulama
başarısız olursa iş uyarı kaydeder; imzasız dosyayı özgün güncelleyici imzasıyla yayımlar.

**Üretim sertifikasına geçiş:** SignPath sertifikayı verince depo değişkeni
`SIGNPATH_SIGNING_POLICY_SLUG` değerini `release-signing` yapın
(Settings → Secrets and variables → Actions → Variables). İş akışını değiştirmek
gerekmez. Bundan sonra deneme çalıştırmaları dahil her yayın iki imzalama isteği
açar: bağımsız dosya ve yükleyici. Çalıştırma beklerken onaylayan kişi ikisini de
[app.signpath.io](https://app.signpath.io) üzerinde onaylamalıdır. İş akışı her
istek için en fazla bir saat bekler, sonra imzasız yayımlar.

**Yayımlamadan test etme:** **Windows signing test** iş akışı
(`.github/workflows/windows-signing-test.yml`, yalnızca elle başlatılır, girdi
almaz) GitHub Windows çalıştırıcılarında `ocx.exe` ve MSI derler. İkisini de
`test-signing` ile imzalar, imzaları doğrular ve test imzalı dosyaları kısa süreli
iş akışı çıktıları olarak saklar. Hiçbir şey yayımlamaz, yayın ilkesini kullanmaz.
