---
title: "Instalación"
description: "Instala el proxy opencodex (ocx), prepara sus requisitos y comprueba que funciona."
---

opencodex instala dos comandos equivalentes, `ocx` y `opencodex`. Ambos inician el mismo servidor HTTP local escrito para Bun. Las solicitudes se envían al proveedor seleccionado por el enrutamiento. Los sidecars opcionales de visión y búsqueda web también pueden usar tu sesión de ChatGPT cuando un modelo enrutado los necesite.

<a id="desktop-terminal-command"></a>

## Comando terminal de escritorio

Una instalación estable de OpenCodex Desktop configura `ocx` para las terminales nuevas al iniciar la aplicación. Abre una terminal nueva y ejecuta `ocx status` u `ocx doctor` para inspeccionar el primer ejecutable de PATH. En macOS y en instalaciones de Linux con paquetes `.deb`, un bloque administrado al final de los archivos de inicio de zsh, bash y fish coloca `~/.opencodex-desktop/bin` primero en PATH y usa el lanzador de escritorio. Windows coloca el directorio del `ocx.exe` incluido al principio del `Path` del usuario. Las terminales ya abiertas, los alias, las cachés de shell y los cambios posteriores de PATH pueden seleccionar otro comando; en Windows también puede tener prioridad una entrada del PATH del sistema. Usa el ajuste de comando de terminal de la aplicación para reparar, desactivar o eliminar esta configuración. AppImage queda excluido.

En macOS y Linux, si todavía se ejecuta el lanzador de npm/pnpm, este delega los comandos compatibles en la CLI de Desktop cuando su registro está habilitado y supera las comprobaciones de propiedad, permisos y seguridad de archivos. Windows no usa esa delegación: las terminales nuevas seleccionan el `ocx.exe` de Desktop mediante el orden del `Path` del usuario. El error `record-unsafe` indica que el registro o su directorio no superó una comprobación de seguridad. Abre OpenCodex Desktop para reparar el comando, o usa `OCX_NO_DESKTOP_HANDOFF=1` en una invocación del paquete en macOS/Linux. La actualización o eliminación del paquete y la inspección interna conservan su ruta habitual. `OCX_NO_DESKTOP_HANDOFF=1` solo suprime la delegación de esa invocación; no cambia el lanzador de Desktop seleccionado directamente ni el PATH.

<a id="prerequisites"></a>

## Requisitos previos

| Requisito | Por qué |
| --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | `ocx` se ejecuta con Bun, que se incluye automáticamente al instalar con npm o pnpm. **No** necesitas instalar Bun por separado. |
| **[OpenAI Codex](https://openai.com/codex)** (CLI, aplicación o SDK) | Es el cliente al que opencodex sirve como proxy. opencodex escribe en `$CODEX_HOME/config.toml` (por defecto, `~/.codex/config.toml`). |
| Una cuenta de proveedor o clave API | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, un punto final compatible con OpenAI o su inicio de sesión ChatGPT. |

<a id="install"></a>

## Instalar

```bash
npm install -g @bitkyc08/opencodex
```

Con pnpm 10.4 o posterior:

```bash
pnpm add -g --allow-build=bun @bitkyc08/opencodex
```

:::note[¿npm bloqueó el script postinstall de Bun?]
Las versiones recientes de npm pueden bloquear el script postinstall de Bun (`npm warn
install-scripts ... blocked because they are not covered by allowScripts`) y dejar sin preparar el entorno incluido. Tras intentar la recuperación permitida del entorno incluido, el lanzador puede usar un ejecutable Bun situado en un directorio absoluto de PATH si es una versión estable con la misma versión mayor y una versión completa igual o superior a la de la dependencia. Con la dependencia actual 1.4.4, esto admite 1.4.4 o posterior dentro de la versión mayor 1. Las comprobaciones de versión e identidad exigen que `bun --version` coincida con `Bun.version` informado por `bun -e`. En POSIX se comprueba toda la ruta, incluidos los directorios y componentes alcanzados mediante enlaces simbólicos. Cada directorio y enlace recorrido, y el ejecutable resuelto, deben pertenecer a root o al usuario efectivo del lanzador. Los directorios y el ejecutable resuelto no pueden permitir escritura al grupo ni a otros usuarios; no se usan los bits de permisos de los enlaces simbólicos. Se rechazan ancestros compartidos con escritura como `/tmp`, incluso con sticky bit: proteger solo el ejecutable y su directorio inmediato no basta. Un aviso de una línea en stderr identifica la versión de Bun seleccionada. Bun sigue incluido en el paquete; instalarlo por separado es opcional.

Si no hay un entorno utilizable y falta la dependencia `bun`, el error lo indica. En macOS también muestra la CLI de Desktop si encuentra un ejecutable en
`/Applications/OpenCodex.app/Contents/MacOS/ocx` o
`~/Applications/OpenCodex.app/Contents/MacOS/ocx`. Puedes invocar esa ruta explícitamente: esta recuperación no delega automáticamente en ella ni instala un lanzador en PATH.

Para reparar el entorno incluido, reinstala el paquete permitiendo el script de Bun. Incluye siempre el nombre del paquete: la sugerencia abreviada de npm lo omite y reinstala el directorio actual.

```bash
npm install -g --allow-scripts=bun @bitkyc08/opencodex

# if the original install used sudo, keep using sudo:
sudo npm install -g --allow-scripts=bun @bitkyc08/opencodex
```
:::

Verifique que ambos alias de comando estén en su `PATH`:

```bash
ocx --version
opencodex --version
```

Antes de iniciar, detener o reiniciar el proxy, gestionar el servicio o actualizar desde la CLI de Bun, puede aparecer un aviso breve en stderr si las versiones de la CLI y el proxy no coinciden. Es informativo y conserva el código de salida; las salidas JSON y de ayuda no lo activan. Las actualizaciones de npm/pnpm que gestiona el lanzador de Node antes de iniciar la CLI de Bun no muestran este aviso. `ocx status`, `ocx doctor` y `ocx resolve` ya informan de estas diferencias en sus diagnósticos.

Si instalas el servicio desde un shell con fnm, nvm, mise, asdf o volta, OpenCodex excluye del PATH del servicio los directorios multishell ligados a esa sesión. En Linux selecciona un lanzador `ocx` duradero si está disponible; de lo contrario usa el Bun del paquete. Ejecuta `ocx service repair` si un servicio anterior se instaló desde un directorio multishell. En macOS, la reparación recarga launchd si cambia la lista guardada.

<a id="standalone-binary-no-npm"></a>

## Binario independiente (sin npm)

Las descargas de versiones también incluyen un binario `ocx` para las plataformas compatibles de macOS, Linux y Windows. Incluye Bun y el dashboard, por lo que no requiere npm, Node ni una instalación separada de Bun. Descarga el archivo de tu plataforma, extráelo y ejecuta:

```bash
./ocx --version
./ocx start
```

Los directorios extraídos `gui/dist` y `keyring` deben permanecer junto al binario. El primero sirve el dashboard y el segundo contiene el enlace nativo de la plataforma con el almacén de credenciales del sistema operativo.

En Windows, [Firma de código en Windows](/es/reference/code-signing/) explica cómo se firma `ocx.exe` y cómo verificarlo.

<a id="release-channels"></a>

### Canales de liberación

El canal estable `latest` ya incluye el catálogo de GPT-5.6 Sol/Terra/Luna para ChatGPT, la API de OpenAI con clave, OpenRouter y las rutas experimentales de Cursor. La disponibilidad sigue dependiendo de la cuenta del proveedor: una entrada de catálogo no concede acceso. Usa el canal preview solo para probar versiones preliminares de opencodex:

```bash
npm install -g @bitkyc08/opencodex@preview
ocx update --tag preview
```

<a id="run-from-source"></a>

## Correr desde la fuente

Para hackear el propio opencodex:

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy   # starts the proxy API in dev mode (src/cli/index.ts start)
bun run dev:gui     # starts the dashboard dev server (another terminal)
```

`bun run dev` es un alias de `bun run dev:proxy`. La API del proxy expone `/healthz`, `/v1/responses` y `/api/*`. `GET /` sirve el dashboard empaquetado cuando `bun run build:gui` ha generado `gui/dist`. Para desarrollar la interfaz, inicia el frontend por separado con `bun run dev:gui`.

<a id="what-gets-created"></a>

## Lo que se crea

opencodex guarda sus datos en `$OPENCODEX_HOME` (por defecto, `~/.opencodex`). Los archivos de integración de Codex están en `$CODEX_HOME` (por defecto, `~/.codex`).

| Ruta | Finalidad |
| --- | --- |
| `$OPENCODEX_HOME/config.json` | Sus proveedores, proveedor predeterminado, puerto y opciones. |
| `$OPENCODEX_HOME/ocx.pid` | PID del proxy en ejecución (guarda de instancia única). |
| `$OPENCODEX_HOME/runtime-port.json` | El PID vivo, el nombre de host y el puerto —, incluido un puerto asignado al sistema operativo cuando `config.port` es `0`. |
| `$OPENCODEX_HOME/auth.json` | Las credenciales OAuth almacenadas (cuando `ocx login`). |
| `$OPENCODEX_HOME/catalog-backup*.json` | Codex copias de seguridad del catálogo de modelos hechas antes de que opencodex lo edite. |
| `$CODEX_HOME/config.toml` | Cuando el proxy se vincula a loopback, opencodex añade `openai_base_url` en la raíz, dentro de su bloque delimitado por marcadores. Con una vinculación fuera de loopback, utiliza `model_provider = "opencodex"` y `[model_providers.opencodex]` para que Codex pueda enviar el encabezado de autenticación de la API. |
| `$CODEX_HOME/opencodex.config.toml` | Perfil de referencia/retroceso escrito junto a la configuración principal de Codex. |
| `$CODEX_HOME/opencodex-catalog.json` | Catálogo de modelos nativos y enrutados sincronizados utilizado por Codex. |

:::note
opencodex no borra tu configuración de Codex. Cada inyección es reversible: `ocx stop`, `ocx restore` u `ocx eject` eliminan las líneas añadidas por opencodex y restauran el uso nativo de Codex.
:::

<a id="next"></a>

## Siguiente

Continuar a la [Inicio rápido](/es/getting-started/quickstart/) para configurar su primer proveedor, o leer [Cómo funciona](/es/getting-started/how-it-works/) para la arquitectura.
