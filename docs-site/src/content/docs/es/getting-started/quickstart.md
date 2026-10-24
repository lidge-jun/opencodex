---
title: "Inicio rápido"
description: "Configura tu primer proveedor y conecta OpenAI Codex a través de opencodex con tres comandos."
---

Esta guía te lleva desde una instalación nueva hasta ejecutar Codex con un modelo de otro proveedor distinto de OpenAI.

<a id="standalone-binary-no-npm"></a>

## Binario independiente, sin npm

También puedes usar el archivo de una versión que incluye el binario `ocx` y el entorno de ejecución Bun, sin npm. Extráelo de modo que el directorio `gui/dist` quede junto al binario y ejecuta `./ocx start`.

<a id="1-run-the-setup-wizard"></a>

## 1. Ejecuta el asistente de configuración

```bash
ocx init
```

`ocx init` te guía por estos pasos:

1. **Elegir un proveedor**: selecciona uno de los 105 preajustes del registro integrado o `custom` para introducir una URL base y un adaptador.
2. **Clave API**: pega una clave o indica una variable de entorno como `${ANTHROPIC_API_KEY}`.
3. **Modelo predeterminado**: para proveedores con clave, locales o personalizados, acepta el preajuste o introduce un identificador de modelo.
4. **Puerto del proxy**: `10100` de forma predeterminada.
5. **¿Integrar con Codex?** En una configuración habitual de bucle local, opencodex añade `openai_base_url` en la raíz de `$CODEX_HOME/config.toml` (de forma predeterminada, `~/.codex/config.toml`) para que el proveedor integrado `openai` de Codex apunte al proxy. Las conexiones remotas o LAN usan una entrada de proveedor dedicada con un encabezado de autenticación de API.
6. **¿Instalar el shim de inicio automático?** Si lo habilitas, al iniciar `codex` se ejecuta primero `ocx ensure`.

El resultado se guarda en `$OPENCODEX_HOME/config.json` (de forma predeterminada, `~/.opencodex/config.json`).

`ocx init` solo crea una configuración si no existe ninguna. Si ya hay una válida, la conserva y termina; usa `ocx config` o el dashboard para actualizarla. Las entradas no válidas, ilegibles o que sean enlaces simbólicos se conservan y se notifican como errores. Si otro proceso crea la configuración durante el asistente, se conserva su archivo y el asistente se detiene antes de administrar copias de seguridad o proponer la integración.

EOF o Ctrl+C antes de crear el archivo cancela la configuración. Cancelar después conserva el archivo guardado. Su creación inicial requiere soporte y permisos para enlaces duros en ese sistema de archivos; si falla, el asistente se detiene sin intentar sobrescribirlo. Si no termina de crear el archivo o limpiar los temporales, inspecciona el directorio antes de reintentar: puede quedar una configuración completa o un archivo temporal privado.

Si el asistente informa de que no pudo asegurar los permisos iniciales, el sistema de archivos o la cuenta no pudieron aplicar los permisos privados requeridos (ACL de NTFS en Windows). Esto ocurre antes de escribir el contenido. Un fallo al publicar mediante enlace duro es distinto: los permisos privados se aplicaron, pero no se pudo publicar el archivo completo o no se puede confirmar el resultado.

Inspecciona el directorio elegido antes de reintentar. Conserva cualquier `config.json` existente; no lo borres para forzar al asistente a continuar. Para una instalación nueva, elige una ubicación con permiso de escritura que admita enlaces duros y permisos privados. Un directorio local NTFS es adecuado en Windows si tu cuenta puede aplicar sus ACL. Por ejemplo, elige una ubicación nueva en la misma terminal antes de ejecutar el asistente:

```powershell
# Windows PowerShell: choose a fresh directory on a local NTFS volume.
$env:OPENCODEX_HOME = Join-Path $env:LOCALAPPDATA "opencodex-local"
ocx init
```

```sh
# macOS/Linux: choose a fresh directory on a filesystem with hard links and Unix permissions.
export OPENCODEX_HOME="$HOME/.opencodex-local"
ocx init
```

Usa el mismo `OPENCODEX_HOME` en los comandos posteriores y en el servicio que ejecute el proxy. Cambiar esta variable selecciona otra ubicación de configuración; no migra una instalación existente. El asistente no usa como alternativa la escritura directa ni un cambio de nombre que reemplace archivos: crear un archivo exclusivo y escribir después en él podría exponer contenido parcial.

:::note[Entradas del despliegue de GPT-5.6]
La versión estable actual incluye GPT-5.6 Sol/Terra/Luna para el paso directo de ChatGPT, OpenAI con clave API, OpenRouter y el adaptador experimental de Cursor. Solo funcionan si la cuenta del proveedor tiene acceso. Los preajustes de OpenAI con clave API y OpenRouter anuncian una ventana de contexto utilizable de 922.000 tokens; Cursor conserva los metadatos de su propio adaptador.
:::

<a id="2-start-the-proxy"></a>

## 2. Inicia el proxy

```bash
ocx start            # defaults to port 10100
ocx start --port 8080
```

Al iniciar, opencodex:

- Escribe su PID en `~/.opencodex/ocx.pid` y rechaza un segundo inicio.
- Descubre los modelos disponibles cuando el proveedor lo permite y **sincroniza las entradas nativas y enrutadas en el catálogo de modelos de Codex**.
- Escucha en `http://localhost:<port>/v1`.

Una instancia activa de opencodex con el mismo `OPENCODEX_HOME` impide iniciar otra, aunque el nuevo puerto esté libre. Detén primero esa instancia con `ocx stop`, o usa otro `OPENCODEX_HOME` para una instancia independiente. Si un proceso ajeno ocupa el puerto solicitado, `ocx start` lo identifica; elige un puerto libre con `ocx start --port <port>`. Nunca cambia de puerto automáticamente, para evitar que queden dos proxies activos y Codex apunte al más reciente.

Compruébalo:

```bash
ocx status
ocx gui       # open the dashboard on the live port
```

<a id="3-use-codex"></a>

## 3. Usa Codex

Codex se comunica con opencodex de forma transparente:

```bash
codex "Refactor this function for readability"
```

Para elegir un modelo enrutado concreto, usa el formato `provider/model` que muestra el selector de Codex:

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

<a id="choose-sub-agent-models-optional"></a>

## Elegir modelos de subagentes, opcional

Una configuración nueva incluye `gpt-6-astra`, `gpt-6.1-sol` y `gpt-6-luna` en el selector de subagentes de Codex. Abra `ocx gui` para sustituirlos o reordenar hasta cinco modelos nativos o enrutados. El panel también permite elegir un modelo preferido de subagentes y su esfuerzo de razonamiento. Consulte [Interfaz de subagentes](/es/guides/sub-agent-surface/) para elegir v1/base/v2 y conocer cuándo se aplican las instrucciones, los valores nativos predeterminados y las alternativas.

<a id="logging-in-instead-of-pasting-a-key"></a>

## Iniciar sesión en lugar de pegar una clave

Algunos proveedores permiten iniciar sesión con una cuenta mediante OAuth y renovar las credenciales automáticamente:

```bash
ocx login xai          # or: anthropic, kimi, kiro, google-antigravity, cursor
ocx logout xai
```

El proveedor predeterminado de OpenAI **no necesita una clave**: reenvía directamente las credenciales existentes de `codex login`. Consulta [Proveedores](/es/guides/providers/).

<a id="stopping--restoring"></a>

## Detener y restaurar

```bash
ocx stop          # stop the proxy and restore native Codex
ocx restore       # restore native Codex without stopping (alias: ocx eject)
ocx restore back  # route Codex through the still-running proxy again
```

<a id="startup-ownership-could-not-be-verified"></a>

## No se pudo verificar la propiedad al iniciar

Si al iniciar aparecen `Shared-client owner could not be verified` y `refusing startup`, OpenCodex no pudo determinar de forma segura si otro proxy controla las opciones compartidas de los clientes. Se detiene antes de publicar otro entorno de ejecución o modificar esas opciones. Reintenta cuando se recupere la conectividad local; un servicio en segundo plano ya instalado reintenta mediante su gestor de servicios. Un tiempo de espera agotado no convierte permanentemente el proceso nuevo en una instancia secundaria.

No es necesario habilitar IPv6 en el bucle local. El inicio comprueba si puede vincular cada dirección de bucle local y omite las familias no disponibles. Si se agota el tiempo de espera de una familia disponible, se detiene hasta que pueda verificar la propiedad.

<a id="next"></a>

## Siguientes pasos

- [Cómo funciona](/es/getting-started/how-it-works/): qué sucede con cada solicitud.
- [Proveedores](/es/guides/providers/): todas las formas de autenticación.
- [Configuración](/es/reference/configuration/): referencia completa de `config.json`.
