---
title: Replit ağ geçidi eşlikçisi
description: Replit AI Integrations üzerinden OpenAI Chat ve Anthropic Messages aktaran kendi Replit dağıtımınızla opencodex'i eşleştirin — isteğe bağlı özel iş akışı, kanonik kayıt defteri ön ayarı değil.
---

**Replit ağ geçidi eşlikçisi**, **Replit dağıtımınızın içinde** çalışan
[`integrations/replit-gateway`](https://github.com/lidge-jun/opencodex/tree/dev/integrations/replit-gateway)
paketindeki kullanıcıya ait bir Bun servisidir. Repl ortamındaki Replit AI Integrations kimlik
bilgilerini okur ve opencodex'e iki yerel tel uç noktası sunar:

```text
opencodex (yerel)
  -> HTTPS + ağ geçidi anahtarınız
  -> Replit dağıtımınız (integrations/replit-gateway)
  -> Replit AI Integrations üst akışı (OpenAI Chat / Anthropic Messages)
```

opencodex `AI_INTEGRATIONS_*` sırlarını asla almaz. opencodex'in yerelde sakladığı ve her istekte
`Authorization: Bearer …` olarak gönderdiği ayrı bir **ağ geçidi anahtarı**
(`REPLIT_GATEWAY_KEY`) sağlarsınız.

> **Yalnızca özel iş akışı.** `replit` ve `replit-anthropic` **kanonik kayıt defteri ön ayarları
> değildir.** opencodex resmi bir Replit sağlayıcısı iddia etmez; yazılı Replit yetkisi olana kadar
> kayıt defteri yükseltmesi engellenir ([Kanıt kapısı](#kanıt-kapısı)).

> **Deneysel — dağıtım doğrulanmadı.** Kod ve v1 sözleşme `experimental-pending-canary`; **canlı Replit dağıtımı doğrulanmadı.**

## Gereksinimler

- Hesabınız veya kuruluşunuz için
  [Replit AI Integrations](https://docs.replit.com/features/integrations/replit-ai-integrations)
  kullanılabilen **ücretli Replit planı**.
- Replit Agent'ın Repl'e OpenAI ve Anthropic yönetilen entegrasyonları eklemesini istediğinde **manuel
  onay**. opencodex Replit oturum açma, faturalandırma veya entegrasyon diyaloglarını otomatikleştirmez.
- Herkese açık **HTTPS** kökeninde (genelde `https://<repl>.replit.app`) erişilebilir dağıtılmış ağ
  geçidi paketi.
- Pano sihirbazı veya CLI kurulumu için çalışan opencodex vekil sunucusu (`ocx start`).

Dağıtım ve yapılandırma için
[paket README](https://github.com/lidge-jun/opencodex/blob/dev/integrations/replit-gateway/README.md).

## Ağ geçidini dağıtma (özet)

1. `integrations/replit-gateway/` dizinini bir Bun Repl'e kopyalayın.
2. `loadGatewayConfigFromEnv()` ve `createGatewayServer()` çağıran, ardından
   `Bun.serve({ fetch: gateway.fetch, port, hostname: "0.0.0.0" })` yapan `server.ts` ekleyin.
3. Replit arayüzünde **OpenAI** ve **Anthropic** yönetilen entegrasyonlarını onaylayın.
4. **Değerleri yazdırmadan gözlemlenen `AI_INTEGRATIONS_*` adlarını doğrulayın** (aşağı).
5. `REPLIT_GATEWAY_KEY` (**32–512** yazdırılabilir ASCII), `REPLIT_GATEWAY_PUBLIC_ORIGIN`, model izin listeleri ve dört kesin entegrasyon adını ayarlayın.
6. `GET /healthz` ve kimlik doğrulamalı `GET /v1/models` başarısını doğrulayın.

### Replit ortam adları (doğrulanmamış gözlemlenen sözleşme)

Gerekli: `AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY`, `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`, `AI_INTEGRATIONS_ANTHROPIC_API_KEY`. **Resmi platform dışı Replit sözleşmesi değil**; **canary bekliyor**.

```bash
printenv | grep '^AI_INTEGRATIONS_' | cut -d= -f1 | sort -u
```

Ağ geçidi anahtarı **32–512** yazdırılabilir ASCII:

```bash
openssl rand -base64 48 | tr -d '\n'
```

Yalnızca Replit Secrets ve opencodex eşleştirmede saklayın; git'e koymayın.

## opencodex ile eşleştirme

Kurulum, dağıtım kökeninden türetilen **iki** özel sağlayıcı yazar:

| Sağlayıcı kimliği | Bağdaştırıcı | temel URL | Notlar |
| --- | --- | --- | --- |
| `replit` | `openai-chat` | `<origin>/v1` | `GET /v1/models` ile canlı model keşfi |
| `replit-anthropic` | `anthropic` | `<origin>` | Bearer taşıma; `liveModels: false` |

Aynı ağ geçidi anahtarını paylaşırlar. Çift değişiminde türetilmeyen alanlar (seçili modeller, pacing,
kimlik bilgisi olmayan özel üst bilgiler) korunur.

### CLI — `ocx provider install-replit`

```bash
export REPLIT_GATEWAY_KEY='your-gateway-key'
ocx provider install-replit --origin https://my-app.replit.app
```

Anahtar kaynağı (biri): `REPLIT_GATEWAY_KEY`, `--stdin`, `--gateway-key-file <path>`. Anahtar **argv'de
olmamalı**.

Yararlı bayraklar: `--allow-custom-domain`, `--replace`, `--set-default`, `--json`.

Yapılandırma yazılmadan önce opencodex yalnızca **ücretlendirilmeyen** uç noktaları sondalar:
`GET <origin>/healthz`, `GET <origin>/v1/models` (Bearer).

### Pano sihirbazı

**Providers** sayfasında **Replit gateway…** düğmesine tıklayın:

1. **HTTPS kökeni** ve **ağ geçidi anahtarını** girin.
2. `.replit.app` üzerinde değilse **Allow custom domain** etkinleştirin.
3. İsteğe bağlı kurulumdan sonra **replit**'i varsayılan sağlayıcı yapın.
4. Başarıda health ve models sondası süreleri gösterilir.

Çift zaten varsa **Replace pair** öncesi açık onay gerekir. Kanonik kayıt defteri ön ayarı **olmadığı**
belirtilir.

## Özel etki alanı opt-in

Varsayılan `.replit.app` HTTPS kökenleri. Opt-in **sahiplik kanıtlamaz** ve DNS rebinding/TLS **operasyonel sorumluluğunu kaldırmaz**. opencodex HTTPS sözdizimi, kurulum öncesi destination/DNS değerlendirmesi ve HTTPS sondalarını **yapar** — **anlık** kontrollerdir.

## Soğuk başlangıç

Boşta kalan Repl'ler uyuyabilir. İlk istek yavaş olabilir veya `upstream_error`/`upstream_timeout`
dönebilir. Kurulum sondası zaman aşımı 8 sn. Ücretli üst akış otomatik yeniden denenmez.

## Ağ geçidi sınırları (v1)

| Sınır | Varsayılan |
| --- | --- |
| Maks. istek gövdesi | 32 MiB |
| Maks. üst bilgi | 32 KiB |
| Maks. eşzamanlı istek | 10 |
| Üst akış zaman aşımı | 300 sn |
| İstemci zaman aşımı | 310 sn |

Üst akış HTTP yönlendirmeleri reddedilir. İzin verilen aralıklar paket README'de.

## Hata kategorileri

Ağ geçidi kararlı JSON hata kategorileri döndürür (gizli bilgi veya gövde asla yansıtılmaz):

`auth_failed`, `config_invalid`, `request_too_large`, `headers_too_large`,
`unsupported_content_encoding`, `model_not_allowed`, `concurrency_limited`, `upstream_timeout`,
`client_timeout`, `client_aborted`, `redirect_rejected`, `upstream_error`, `internal`.

Yaygın HTTP eşlemeleri: `401` kimlik doğrulama, `400` izin verilmeyen model, `413` gövde çok büyük, `415` kodlanmış gövde, `429` eşzamanlılık, `408` istemci zaman aşımı, `504` üst akış zaman aşımı, `502` üst akış/yönlendirme hatası.

## Yerel yetenekler (v1)

**Desteklenir** — OpenAI Chat ve Anthropic Messages bayt akışı. SSE `: heartbeat\n\n` yalnızca **tam satır sınırlarında**.

**Gecikmeli LF ilkesi:** CRLF parçalanır ve `\n` gecikirse `\r` heartbeat zamanlaması için satır sonu sayılabilir. **Yük baytları değiştirilmez**; nadir split-CRLF'te **zamanlama** farklı olabilir.

## v1'de desteklenmeyen

- Kanonik Replit kayıt defteri ön ayarı veya seçici kutucuğu
- Bu ağ geçidi üzerinden Google Gemini, OpenRouter vb.
- OpenAI Responses, görüntü, ses, transkripsiyon
- OpenAI ↔ Anthropic protokol çevirisi
- Otomatik üst akış yeniden denemesi, önbellek, normalleştirme
- Tarayıcı CORS
- identity dışı `Content-Encoding`
- `replit-anthropic` üzerinde canlı model keşfi
- Replit hesap, onay veya dağıtım otomasyonu

## Gizlilik, krediler ve şartlar

- **Kimlik bilgisi sınırı:** Yalnızca ağ geçidi anahtarı `~/.opencodex/config.json` içinde saklanır.
- **Faturalandırma:** Replit AI Integrations kullanımı kamu API fiyatlarıyla Replit kredilerinden düşülür.
- **Şartlar:** Planınıza uygun **Replit şartları**. [ToS](https://replit.com/terms-of-service) (**Replit, Inc.**); **Pro/Enterprise** için [Commercial Agreement](https://replit.com/commercial-agreement). **Platform dışı yönlendirme yetkisi alınmadı.**
- **Günlükler:** Yalnızca meta veri; yönetim yanıtlarında anahtar yok.

## Kanıt kapısı

opencodex sağlayıcı ön ayarlarını yalnızca birincil kaynak kanıtıyla sürdürür
([Katkıda bulunma — kanonik ön ayar kanıtı](/contributing/#evidence-required-for-a-canonical-preset)).
Replit eşlikçisi **bugün bu çubuğu karşılamıyor**.

| Kanıt öğesi | Durum (2026-08-22 doğrulandı) |
| --- | --- |
| **Platform dışı** OpenAI Chat + Anthropic Messages | **Kurulmadı** |
| `AI_INTEGRATIONS_*` adları | **Doğrulanmamış gözlem**; canary bekliyor |
| Şartlar ve tüzel kişi | ToS — **Replit, Inc.**; Pro/Enterprise: Commercial Agreement |
| Platform dışı yönlendirme | **Alınmadı** |
| Adlandırılmış bakım sahibi | **opencodex:** [@lidge-jun](https://github.com/lidge-jun), [@Ingwannu](https://github.com/Ingwannu) ([`MAINTAINERS.md`](https://github.com/lidge-jun/opencodex/blob/main/MAINTAINERS.md)). **Replit:** bu iş akışının ortağı değil. |
| Atıflanabilir doğrulama tarihi | **2026-08-22** |

**Kayıt defteri yükseltmesi engelli.** `replit`/`replit-anthropic` `src/providers/registry.ts` içinde yok.

## Ayrıca bakın

- [Paket README](https://github.com/lidge-jun/opencodex/blob/dev/integrations/replit-gateway/README.md)
- [Tasarım özelliği](https://github.com/lidge-jun/opencodex/blob/dev/docs/superpowers/specs/2026-08-22-replit-gateway-design.md)
- [Sağlayıcılar](/guides/providers/)
- [Web panosu](/guides/web-dashboard/)
