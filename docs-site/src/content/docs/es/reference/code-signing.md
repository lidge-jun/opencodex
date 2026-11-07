---
title: "Firma de código en Windows"
description: "Cómo OpenCodex firma sus binarios de Windows mediante SignPath Foundation, cómo verificar las firmas y qué política aplica."
---

OpenCodex está incorporando firmas Authenticode de [SignPath Foundation](https://signpath.org) en sus descargas de Windows: el ejecutable independiente `ocx.exe` y el instalador de escritorio `OpenCodex-<version>-windows-x64.msi`. Una firma identifica al editor ante Windows, SmartScreen y los antivirus y permite comprobar que el archivo no cambió después de compilarlo. Puede reducir los avisos y falsos positivos por binarios sin firma como el de [#7207](https://github.com/lidge-jun/opencodex/issues/7207). No garantiza que SmartScreen lo acepte ni demuestra que el archivo sea seguro: [Microsoft explica](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation) que un binario recién firmado todavía puede mostrar avisos de reputación.

La incorporación está en curso. El flujo de publicación ya está preparado y SignPath lo valida con un certificado de prueba. Hasta que se emita el certificado de producción, los archivos de Windows se publican sin firma y SmartScreen puede pedir confirmación (**Más información → Ejecutar de todas formas**). Después de ese cambio, el flujo intentará firmarlos en producción mediante **SignPath Foundation**. Si la firma o su verificación falla, la versión puede incluir el archivo original sin firmar, como se explica más abajo.

<a id="code-signing-policy"></a>

## Política de firma de código

Firma gratuita proporcionada por [SignPath.io](https://about.signpath.io/), con certificado de [SignPath Foundation](https://signpath.org/).

- Personas que realizan commits y revisiones: [lidge-jun](https://github.com/lidge-jun).
- Aprobador: [lidge-jun](https://github.com/lidge-jun).

Cada solicitud de firma de una versión se aprueba manualmente en SignPath antes de usar el certificado. Solo se firman los binarios compilados desde el código de este repositorio mediante GitHub Actions. Los archivos de terceros incluidos, como los módulos de llavero precompilados, conservan su forma original: la política de SignPath Foundation prohíbe firmarlos con el certificado del proyecto.

<a id="privacy"></a>

### Privacidad

Este programa no transfiere información a otros sistemas de red salvo que lo solicite expresamente el usuario o quien lo instale u opere. En la práctica, OpenCodex reenvía las solicitudes a los proveedores configurados. También consulta metadatos de versiones en GitHub y el registro npm para buscar actualizaciones; esas consultas no incluyen prompts, credenciales ni datos de uso.

<a id="verifying-a-download"></a>

## Verificar una descarga

En PowerShell, comprueba el archivo descargado:

```powershell
Get-AuthenticodeSignature .\OpenCodex-<version>-windows-x64.msi | Format-List Status, SignerCertificate
Get-AuthenticodeSignature .\ocx.exe | Format-List Status, SignerCertificate
```

Una versión firmada muestra `Status : Valid` y un certificado cuyo sujeto identifica a `SignPath Foundation`. En el Explorador puedes ver la misma información en **Propiedades → Firmas digitales**. Cada archivo publicado tiene un `.sha256` junto a él en la página de versiones; puedes compararlo con `Get-FileHash <file> -Algorithm SHA256`.

<a id="what-gets-signed"></a>

## Qué archivos se firman

| Archivo | Contenido firmado |
|---|---|
| `ocx-<version>-bun-windows-x64.zip` | El `ocx.exe` del archivo. El ZIP y su `.sha256` se generan a partir del binario firmado. |
| `OpenCodex-<version>-windows-x64.msi` | El instalador y todos los `.exe` que instala, incluida la aplicación de escritorio y su `ocx.exe`. |

La firma del actualizador de escritorio (`.msi.sig`) y `latest.json` se generan a partir del instalador firmado. Así, las actualizaciones dentro de la aplicación instalan los mismos bytes que ofrece la página de versiones.

<a id="for-maintainers"></a>

## Para mantenedores

El flujo de publicación (`.github/workflows/release.yml`) firma mediante la acción oficial `signpath/github-action-submit-signing-request`. Lee un secreto y tres variables del repositorio:

| Nombre | Tipo | Valor |
|---|---|---|
| `SIGNPATH_API_TOKEN` | Secreto | Token API del usuario de CI de SignPath |
| `SIGNPATH_ORGANIZATION_ID` | Variable | Identificador de la organización de SignPath |
| `SIGNPATH_PROJECT_SLUG` | Variable | `opencodex` |
| `SIGNPATH_SIGNING_POLICY_SLUG` | Variable | `test-signing` actualmente; `release-signing` cuando se emita el certificado |

Las configuraciones de artefactos de SignPath son `windows-standalone-zip` (un `ocx.exe` en la raíz del ZIP) y `windows-msi-zip` (un `.msi` en la raíz del ZIP, con firma profunda).

La firma nunca bloquea una publicación. El resultado depende de la política:

| Política | Simulación | Publicación real |
|---|---|---|
| Sin token o con configuración incompleta | Sin firma | Sin firma, con un aviso o advertencia |
| `test-signing` | Firmado con el certificado de prueba y conservado solo como artefacto del workflow | Sin firma, con un aviso; nunca se distribuye un certificado de prueba |
| `release-signing` | Firmado y verificado como confiable | Firmado y verificado como confiable |

Si la solicitud de firma falla, agota el tiempo o se rechaza, o si falla la verificación, el trabajo registra una advertencia y publica el archivo original sin firmar. El MSI conserva su firma original del actualizador cuando existe; el ejecutable independiente `ocx.exe` no tiene firma del actualizador.

**Cambiar al certificado de producción.** Cuando SignPath lo emita, establece `SIGNPATH_SIGNING_POLICY_SLUG` en `release-signing` desde la configuración del repositorio (Settings → Secrets and variables → Actions → Variables). No hace falta modificar el workflow. Desde entonces, cada publicación, incluidas las simulaciones, abre dos solicitudes: una para el binario independiente y otra para el instalador. Un aprobador debe aceptar ambas en [app.signpath.io](https://app.signpath.io) mientras la ejecución espera. El flujo espera hasta una hora por solicitud antes de continuar con archivos sin firmar.

**Probar sin publicar.** El workflow **Windows signing test** (`.github/workflows/windows-signing-test.yml`, solo ejecución manual y sin parámetros) compila `ocx.exe` y el MSI en servidores Windows de GitHub, firma ambos con `test-signing`, verifica las firmas y los conserva como artefactos de corta duración. No publica nada ni usa la política de publicación.
