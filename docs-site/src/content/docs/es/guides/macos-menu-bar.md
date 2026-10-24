---
title: "Barra de menús de macOS"
description: "Usa la bandeja, el panel nativo de uso y el widget de OpenCodex Desktop en macOS."
---

El elemento de la barra de menús forma parte de OpenCodex Desktop. Muestra el uso del proxy local y abre un panel nativo de uso. La aplicación también incluye el dashboard y una extensión de WidgetKit. Consulta la [guía de escritorio](/es/guides/desktop-app/) para instalarla en otras plataformas.

<a id="install"></a>

## Instalar

Descarga `OpenCodex-<version>-macos.dmg` de la [última versión](https://github.com/lidge-jun/opencodex/releases), abre el DMG y arrastra `OpenCodex.app` a Aplicaciones. La aplicación requiere macOS 13 o posterior; el widget, macOS 14 o posterior.

<a id="first-launch"></a>

## Primer inicio

Las versiones publicadas de `OpenCodex.app` llevan firma de Developer ID, usan el entorno de ejecución reforzado y están notarizadas por Apple, con el comprobante adjunto. En el primer inicio, macOS normalmente solo pide la confirmación habitual para una aplicación descargada. Si sigue bloqueándola, abre **Configuración del Sistema → Privacidad y seguridad → Abrir de todos modos**. Las compilaciones propias llevan firma ad hoc; consulta [Compilar desde el código fuente](#build-from-source).

Al abrirse, la aplicación muestra el progreso de inicio en una ventana. En el primer inicio activa una vez **Iniciar al iniciar sesión (Start at Login)**; puedes desactivarlo desde la bandeja. Esa opción solo aparece marcada cuando esta copia está registrada y macOS no ha desactivado el elemento de inicio. En otro caso, la etiqueta explica el motivo; consulta [Aplicación de escritorio](/es/guides/desktop-app/). Los inicios posteriores mediante ese elemento ocultan la ventana y mantienen la bandeja disponible.

<a id="menu-bar-and-usage-panel"></a>

## Barra de menús y panel de uso

La barra muestra de forma predeterminada los tokens totales de hoy. En el dashboard, abre **Uso → Barra de menús y widget** o `#usage/companion` para elegir solicitudes, tokens, costo estimado, cuota o solo el icono.

Usa **Show Usage (Mostrar uso)** en la bandeja para abrir el panel nativo. Incluye totales de hoy y de 30 días, un gráfico de uso, la lista de modelos y los límites de proveedores y cuentas según tus preferencias de visualización. Los totales incluyen tokens y solicitudes, además del costo estimado si está activado. Las filas de cuota muestran ventana, porcentaje y restablecimiento. Las mediciones ausentes aparecen como `—` y los datos parciales se marcan como incompletos.

Los controles nativos son **Refresh**, **Dashboard** y **Settings**. **Dashboard** abre Uso en la ventana de escritorio y **Settings**, la pestaña Barra de menús y widget de Uso. La bandeja también ofrece **Open Dashboard**, **Open in Browser**, **Start at Login** (iniciar al iniciar sesión), **Stop proxy**, **Check for Updates…**, **Install update** cuando hay una actualización y **Quit**. **Stop proxy** siempre aparece, pero solo está disponible si la aplicación inició el proxy; uno iniciado por separado sigue funcionando. Cerrar la ventana o pulsar Command-Q oculta la aplicación cuando hay bandeja; usa **Quit** para salir por completo.

El botón de actualización del dashboard abre la página de actualizaciones de la aplicación y usa la misma actualización firmada que la bandeja.

El texto de la bandeja se actualiza cada 60 segundos. Mientras está abierto, el panel nativo también se actualiza cada 60 segundos; **Refresh** solicita una actualización inmediata.

## Widget

En macOS 14 o posterior, abre OpenCodex.app una vez y haz Control-clic en un área vacía del escritorio. Elige **Editar widgets**, busca **OpenCodex** y añade el tamaño deseado. Los tamaños combinan estado del proxy, tokens y solicitudes de hoy, costo estimado, cuotas y gráfico de uso. La extensión lee una instantánea local escrita por la aplicación: contiene datos de visualización, no claves API ni datos originales de cuentas. La aplicación la actualiza cada cinco ciclos de bandeja de 60 segundos, aproximadamente cada cinco minutos mientras el proxy está conectado. WidgetKit también solicita una nueva línea temporal después de cinco minutos.

<a id="connecting-to-the-proxy"></a>

## Conectar con el proxy

La aplicación pide a su CLI incluida ejecutar `ocx resolve --json`. Se conecta a un proxy local accesible existente o inicia su entorno incluido solo si la CLI confirma que no hay ninguno escuchando. Si la detección es incierta, informa el problema en lugar de crear un segundo proxy. Usa el puerto resuelto en `127.0.0.1`.

Para las solicitudes de administración prueba primero sin token. Si recibe HTTP 401, reintenta con `OPENCODEX_ADMIN_AUTH_TOKEN` del entorno de la aplicación o con el archivo `admin-api-token` del directorio de configuración resuelto. No usa el Llavero de macOS para ese token. La aplicación no puede conectarse a un proxy que solo escuche en una dirección inaccesible mediante loopback.

<a id="build-from-source"></a>

## Compilar desde el código fuente

En macOS 13 o posterior, con Bun, Rust y las herramientas Swift/Xcode disponibles, compila el dashboard desde la raíz y después ejecuta los comandos de escritorio desde `desktop/`:

```bash
bun install
bun run build:gui
cd desktop
bun install
bun run prepare-sidecar
bun run prepare-widget
bun run build:local
```

`build:local` genera la aplicación y el DMG sin requerir una clave de firma del actualizador de Tauri. Ejecutar `bunx tauri build` directamente sí requiere `TAURI_SIGNING_PRIVATE_KEY`, porque también genera el artefacto de actualización. El widget usa firma ad hoc salvo que se configure `MACOS_SIGN_IDENTITY`; los paquetes locales de escritorio también llevan firma ad hoc. La aplicación funciona, pero macOS no registra una extensión de widget con esa firma y normalmente no aparece el widget. `build:local` siempre firma la aplicación de forma ad hoc: configurar solo `MACOS_SIGN_IDENTITY` no basta. Para registrar el widget, tanto la aplicación como la extensión deben estar firmadas por el mismo equipo de Developer ID, como ocurre en las versiones publicadas. Usa una versión publicada si necesitas el widget.

<a id="uninstall"></a>

## Desinstalar

Desactiva **Iniciar al iniciar sesión (Start at Login)** en la bandeja si estaba activado y mueve `OpenCodex.app` de Aplicaciones a la Papelera. Esto elimina la CLI incluida y la extensión del widget, pero conserva el estado de `$OPENCODEX_HOME` y cualquier servicio `ocx` instalado por separado. La aplicación también guarda un identificador de instalación y marcadores de inicio en su directorio de configuración, además de una instantánea del widget en `~/Library/Containers/com.opencodex.desktop.widget/Data/Library/Application Support/OpenCodex/snapshot.json`; moverla a la Papelera no borra esos archivos.
