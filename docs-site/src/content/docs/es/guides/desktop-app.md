---
title: "Aplicación de escritorio"
description: "Instala y usa OpenCodex Desktop en macOS, Windows y Linux."
---

OpenCodex Desktop combina una bandeja nativa con el dashboard web. Su CLI incluida busca un proxy local existente; la aplicación solo inicia su propio entorno de ejecución cuando confirma que no hay ninguno.

El dashboard se sirve desde la dirección del proxy local encontrado (puerto `10100` de forma predeterminada). La aplicación de escritorio integra ese dashboard y su entorno de ejecución.

<a id="install"></a>

## Instalar

### macOS

Descarga `OpenCodex-<version>-macos.dmg` desde la [última versión](https://github.com/lidge-jun/opencodex/releases). Abre el DMG y arrastra `OpenCodex.app` a Aplicaciones. Se requiere macOS 13 o posterior.

Las versiones publicadas de `OpenCodex.app` tienen firma de Developer ID y certificación de Apple. Al abrirlas por primera vez, macOS normalmente solo pide la confirmación habitual para una aplicación descargada. Si sigue bloqueándola, usa **Configuración del Sistema → Privacidad y seguridad → Abrir de todos modos**.

### Windows

Descarga `OpenCodex-<version>-windows-x64.msi` y ejecuta el instalador. La firma de código a través de SignPath Foundation se está incorporando ([firma de código en Windows](/es/reference/code-signing/)). Hasta que una versión incluya esa firma, Windows SmartScreen puede advertir que el instalador no está firmado. Elige **Más información → Ejecutar de todas formas** después de confirmar que lo descargaste de la página de versiones.

### Linux

Descarga `OpenCodex-<version>-linux-x86_64.AppImage` o `OpenCodex-<version>-linux-amd64.deb` desde la página de versiones.

Para AppImage:

```bash
chmod +x OpenCodex-<version>-linux-x86_64.AppImage
./OpenCodex-<version>-linux-x86_64.AppImage
```

Para distribuciones basadas en Debian:

```bash
sudo apt install ./OpenCodex-<version>-linux-amd64.deb
```

El icono de la bandeja requiere un entorno de escritorio compatible con AppIndicator.

<a id="first-launch"></a>

## Primer inicio

La aplicación ejecuta `ocx resolve --json` con su CLI incluida y se conecta al proxy local si ya hay uno accesible. Solo inicia su propio entorno de ejecución cuando la CLI confirma que no existe otro; un resultado incierto se muestra como un fallo de inicio. Después abre el dashboard en su vista web, usando la dirección de bucle local encontrada. Si se inicia oculta en la bandeja al abrir sesión, conserva la página ligera de arranque y carga el dashboard cuando lo abres desde la bandeja o vuelves a iniciar la aplicación.

Usa **Open dashboard** (abrir dashboard) u **Open in browser** (abrir en el navegador) en la bandeja para alternar entre el dashboard integrado y tu navegador habitual. La bandeja también permite buscar actualizaciones.

En Windows, aceptar **Take over** (tomar el control) permite hasta 90 segundos para detener de forma segura el entorno de ejecución existente, transferir su control e iniciar el que incluye la aplicación. El tiempo que tardes en decidir no cuenta para ese límite. Mantén la aplicación abierta mientras termina; si falla, usa **Retry** (reintentar) para volver a buscar el entorno de ejecución actual.

En macOS, cerrar el dashboard mantiene la aplicación en la barra de menús. Vuelve a abrir OpenCodex desde el Dock o Finder para recuperar el dashboard sin reiniciar el proxy.

En Windows, **Start at Login** (iniciar al abrir sesión) registra la ruta del ejecutable entre comillas para el usuario actual, incluidas las instalaciones en `Program Files`. Los registros habilitados se actualizan una vez al iniciar la aplicación. Las entradas que hayas deshabilitado desde la bandeja o el Administrador de tareas permanecen deshabilitadas.

<a id="using-the-ocx-cli-with-the-desktop-app"></a>

## Usar la CLI ocx con Desktop

Las instalaciones estables de macOS, Windows y del paquete deb de Linux configuran automáticamente el comando `ocx` incluido para las terminales nuevas al iniciar Desktop. Abre **Comando de terminal**, junto a **Actualización de Desktop** en la barra lateral del dashboard, o **Terminal command…** en la bandeja, para desactivarlo, repararlo o quitarlo. Desactivar **Usar el comando ocx de Desktop en las terminales nuevas** elimina la configuración administrada. **Quitar comando de terminal** también conserva esa opción desactivada para los próximos inicios. AppImage y los inicios en desarrollo no realizan esta configuración.

macOS y Linux usan un shim en `~/.opencodex-desktop/bin`, el archivo auxiliar compartido `path.sh` y bloques administrados en los archivos de inicio de zsh, bash y fish. Desktop registra la propiedad y los datos de recuperación en `~/.opencodex-desktop/cli.json`; borrar ese registro no elimina el comando ni sus bloques de shell. El archivo `/usr/bin/ocx` del paquete deb no cambia. Windows añade el directorio de instalación al principio del `Path` del usuario y conserva las demás entradas. Un comando del `Path` del sistema puede seguir teniendo prioridad; Desktop informa de ese conflicto como configuración parcial y no modifica el `Path` del sistema.

Después de habilitar o reparar el comando, abre una terminal nueva. Comprueba `type -a ocx` en macOS/Linux, o `Get-Command ocx -All` y `where.exe ocx` en Windows. Las terminales ya abiertas, los alias, las rutas absolutas y los cambios posteriores de PATH todavía pueden seleccionar otro ejecutable. La configuración persiste después de cerrar Desktop. Si falta el paquete de la aplicación, el shim POSIX falla con instrucciones para repararlo o quitarlo, en lugar de seleccionar otro `ocx` sin avisar.

En POSIX, el shim conserva las opciones de Anthropic exportadas por la shell cuando dispone de las herramientas de verificación del inicio. Si esa verificación falla, o si se ejecuta directamente en Windows, la CLI incluida sigue eliminando las opciones de entorno de Anthropic que no sean de confianza.

En macOS, Linux y Windows, `ocx status` y `ocx doctor` identifican OpenCodex Desktop cuando verifican que la aplicación ejecuta su proxy incluido, incluso si no existe un registro de propiedad. `ocx status` muestra `Runtime supervisor: OpenCodex Desktop`; ninguno de los dos comandos recomienda reparar un servicio de CLI para ese entorno. En macOS y Linux, activa **Start at Login** en el menú de OpenCodex en lugar de instalar un servicio en segundo plano. La protección del inicio solo reconoce a la aplicación cuando verifica su registro de inicio de sesión; si no puede verificarlo, sigue las indicaciones de Desktop que muestra el estado.

La página de inicio muestra entonces **En ejecución · Inicio de sesión no verificado** en la fila de Desktop. En macOS, **Start at Login** solo aparece marcado cuando se puede verificar ese mismo registro. En caso contrario, queda sin marcar y explica la causa:

- **disabled by macOS** abre Configuración del Sistema → General → Ítems de inicio y extensiones, donde puedes permitir que OpenCodex se abra al iniciar sesión.
- **another OpenCodex copy** indica que el registro pertenece a otra copia de la aplicación; desactívalo desde esa copia.
- **registered app is missing** indica que la aplicación registrada ya no existe; elimina `~/Library/LaunchAgents/OpenCodex.plist` y vuelve a activar la opción.
- **status unknown** indica que no se pudo leer el registro.

Mientras la aplicación ejecute el proxy, el instalador del servicio en segundo plano permanece deshabilitado en la página de inicio. Para usar ese servicio, cierra OpenCodex y ejecuta `ocx service install` en una terminal. El shim de inicio de Codex sí se puede instalar desde esa página.

Si al iniciar Codex el shim no encuentra un proxy, espera a que OpenCodex lo reinicie. En macOS, puede abrir OpenCodex si estaba cerrado y su propiedad registrada coincide con un registro válido de **Start at Login**; en los demás casos informa de un error en lugar de iniciar un segundo proxy. La reapertura automática usa la ruta de la aplicación de ese registro y comprueba que su ejecutable principal coincida con el ejecutable de Desktop registrado. Si el registro falta, está desactualizado o es incoherente, abre OpenCodex manualmente; no se elige otra copia con el mismo identificador como alternativa. Si el shim muestra "activation not confirmed", añade `. ~/.opencodex/codex-shell-env.sh` al archivo de inicio de tu shell después de las demás opciones de PATH.

La CLI incluida está en `/Applications/OpenCodex.app/Contents/MacOS/ocx` en macOS y en `/usr/bin/ocx` para el paquete deb de Linux. Ejecuta ese archivo con `status` para comprobar el proxy de la aplicación. Windows también verifica la supervisión activa, pero allí **Start at Login** permanece sin verificar y Desktop no se considera una protección del inicio.

Mientras la CLI detecte que Desktop supervisa el proxy, `ocx service install`, `repair`, `start` y `restart` se rechazan antes de modificar el servicio, incluso sin propiedad registrada o sin un inicio de sesión verificado. Cierra OpenCodex y ejecuta `ocx service install` para transferir la gestión del inicio a la CLI. Un `ocx start` duplicado identifica a Desktop como supervisor.

Usa **Check for Updates…** en la bandeja para actualizar la aplicación. La CLI compilada incluida informa `installer: "standalone"` y `reason: "standalone_install"` mediante `ocx system update check`, con `canUpdate: false` e instrucciones para usar las actualizaciones de Desktop. `ocx update` rechaza reemplazar el paquete mientras Desktop supervise el proxy, incluso si se trata de otra instalación de npm/Bun; cierra OpenCodex antes de actualizar esa instalación. Si se acepta `ocx restart`, informa de que Desktop iniciará el reemplazo y espera a que esté disponible. Una CLI más reciente del PATH no puede usar `ocx restart` para reemplazar el proxy de la aplicación por su propio entorno de ejecución.

El comando de terminal `ocx stop` detiene el proxy, pero Desktop puede volver a iniciarlo tras una espera breve. Usa **Stop proxy** o **Quit** en la bandeja para mantenerlo detenido. La salida habitual de `stop` recuerda esto por stderr; `ocx stop --json` omite tanto la comprobación de supervisión como ese aviso.

Estas protecciones son avisos preventivos de las CLI y los entornos de ejecución actuales; las versiones anteriores pueden carecer de ellos. Una comprobación que detecte Desktop pero no termine de verificarlo también bloquea la operación. Una vez bloqueada, otra comprobación inconclusa no elimina el bloqueo: es necesario confirmar que Desktop ya no supervisa el proxy. Si nunca se detectó Desktop, una comprobación inconclusa o incompatible mantiene el comportamiento previo del comando. Las protecciones basadas en la propiedad registrada se aplican de forma independiente.

<a id="startup-safety-on-macos-and-linux"></a>

## Protección del inicio en macOS y Linux

La protección del inicio reconoce **Aplicación de escritorio** cuando un diagnóstico reciente verifica que la aplicación supervisa su proxy incluido y confirma el registro de **Start at Login** de esa misma aplicación. La propiedad registrada se conserva por separado; detectar supervisión no crea una declaración de propiedad.

En Linux, el componente de inicio automático escribe la entrada en `~/.config/autostart/OpenCodex.desktop`, incluso si se definió `$XDG_CONFIG_HOME`. La protección del inicio lee esa entrada y el identificador de instalación bajo `~/.config`. Si `$XDG_CONFIG_HOME` apunta a otro lugar, la sesión busca un directorio distinto de inicio automático; por eso el estado permanece **En riesgo**.

La entrada solo cuenta si no tiene `Hidden=true` ni `X-GNOME-Autostart-enabled=false`, y tampoco condiciones `OnlyShowIn`, `NotShowIn` o `TryExec`. Su campo `Exec` debe contener una ruta absoluta a `opencodex-desktop` sin comillas, espacios, escapes ni códigos de campo, seguida exactamente por `--autostart`. El ejecutable resuelto debe seguir llamándose `opencodex-desktop` y tener el `ocx` incluido a su lado. La protección del inicio lee dos veces toda la cadena de evidencias y solo reconoce la protección cuando ambas lecturas coinciden.

Las instalaciones AppImage permanecen **En riesgo**: el inicio automático registra la ruta del archivo AppImage externo, mientras el proceso de Desktop se ejecuta dentro de su punto de montaje. Esa relación no se puede verificar y no se reconoce como protección.

Una comprobación ausente o desactualizada mantiene el estado **En riesgo**. Si Desktop tiene la propiedad del proxy pero no se puede verificar su protección, vuelve a abrir OpenCodex y comprueba **Start at Login**. La instalación o reparación del servicio y del lanzador permanece deshabilitada mientras exista esa propiedad; `ocx restore` sigue disponible para deshacer el enrutamiento de Codex.

Las actualizaciones normales de Desktop reemplazan la CLI incluida por la versión con la comprobación de inicio corregida. No necesitas conservar un parche local entre actualizaciones.

## Zoom

En macOS y Linux, Cmd (macOS) o Ctrl (Linux) con `+`, `-` y `0`, o Ctrl con la rueda del ratón, cambia el zoom entre el 50 % y el 300 % en pasos del 10 %. `0` vuelve al 100 %. La barra lateral muestra ese mismo nivel junto al selector de tema: `-`, el porcentaje actual y `+`. Pulsar el porcentaje restablece el 100 %. El nivel se guarda y se vuelve a aplicar al iniciar la aplicación.

El dashboard procede del proxy al que se conecta la aplicación. Si ese proxy es antiguo, conserva el comportamiento anterior (pasos del 20 %, sin guardar el nivel ni mostrar controles en la barra lateral) hasta que se actualice el proxy. Windows usa el zoom propio del motor del navegador, que no se guarda.

<a id="keeping-the-proxy-running"></a>

## Mantener el proxy en ejecución

La aplicación mantiene en ejecución el proxy que inició. Si ese proxy se reinicia a sí mismo —después de **Conectar como Child**, de reiniciar la memoria desde el dashboard o de desconectar un Child— la aplicación inicia el nuevo proxy en el mismo puerto y recarga el dashboard abierto. Suele tardar alrededor de un segundo, o algunos segundos si ya se había reiniciado en los dos minutos anteriores. Así, **Stop proxy** sigue alcanzando al proxy y **Quit** también lo termina.

Si el proxy termina sin que se le haya pedido (por un fallo o por `ocx stop` desde una terminal), la aplicación vuelve a iniciarlo tras una espera que aumenta de 3 a 30 segundos mientras sigan los fallos. Si deja de responder en su puerto, la aplicación lo detecta en unos 15 segundos y se recupera del mismo modo. Para un proxy que no inició ella (por ejemplo, un servicio en segundo plano o uno iniciado manualmente), primero espera aproximadamente un minuto a que vuelva.

Durante la recuperación, la aplicación no detiene ni reemplaza un proxy que otro proceso ya ejecute en ese puerto: se conecta a él sin pedir tomar su control. Esto incluye el proxy de un Child que un servicio haya reiniciado después de **Conectar como Child**; la aplicación se conecta y muestra el dashboard del Child. Si el puerto lo ocupa algo que no puede utilizar, como un proxy vinculado a otra dirección distinta de `127.0.0.1`, deja de reintentar y espera a que eso cambie. Si la recuperación termina mientras está abierta la página de actualización, esa página permanece visible.

**Stop proxy** y **Quit** en la bandeja mantienen el proxy detenido. El botón **Detener** del dashboard no detiene un proxy ejecutado por la aplicación, porque esta volvería a iniciarlo: muestra la explicación y no cambia nada. Las decisiones y sus motivos se registran en `runtime-supervisor.log`, dentro del directorio de registros de la aplicación (`~/Library/Logs/com.opencodex.desktop` en macOS).

<a id="usage-in-the-tray"></a>

## Uso en la bandeja

En macOS y Windows, pulsa el icono de la bandeja para abrir una ventana compacta de uso. **Show usage** también la abre, incluidos los escritorios Linux cuya bandeja no transmite los clics. En Linux, el dashboard se abre al iniciar, incluso cuando el entorno de escritorio no muestra un icono de bandeja.

La ventana muestra los totales de hoy y de 30 días, el gráfico de uso configurado, una lista compacta de modelos y los límites por proveedor o cuenta. Junto a las barras aparecen las cuentas regresivas de restablecimiento de cuota; pasa el puntero para ver la hora exacta. Las opciones de **Barra de menús y widget** controlan las secciones y el gráfico visibles. Los proveedores ocultos se excluyen del título, los totales, las cuotas y el gráfico.

El gráfico incluye la actividad del intervalo actual. Un indicador de datos parciales significa que algunos datos no se pueden atribuir con fiabilidad. La ausencia de mediciones no se representa como uso cero. En Windows y Linux, desplázate dentro de la ventana para llegar a Actualizar y Dashboard al final de una lista larga de cuentas.

En macOS, la ventana usa controles nativos SwiftUI y un panel AppKit desplazable. Se usa Liquid Glass de Apple en macOS 26 o posterior; los sistemas anteriores usan el material nativo de los paneles emergentes. El encabezado y los botones Actualizar y Dashboard permanecen visibles al desplazarse por listas largas de cuentas. También puedes abrir la ventana con **View → Show Usage** (Comando-Mayús-U). Pulsa Escape o haz clic fuera para cerrarla.

El menú de la bandeja muestra las solicitudes y los tokens de hoy, con el costo estimado si está habilitado. Usa el mismo día local que el widget. Elige **Refresh now** para actualizar inmediatamente; la aplicación también actualiza los datos cada 60 segundos. Las preferencias de visualización están en **Barra de menús y widget** del dashboard. Desactivar **Hoy** oculta el resumen y desactivar **Costo** quita el costo del resumen.

El uso no disponible o expresamente no medido se muestra como `—`, en lugar de como un cero medido. Elegir el encabezado de solo icono elimina el contador anterior. Las abreviaturas conservan los ceros enteros: diez millones de tokens son `10M`, no `1M`.

<a id="updates"></a>

## Actualizaciones

Elige **Check for Updates…** en la bandeja para buscar actualizaciones inmediatamente. Las versiones publicadas también las buscan después del inicio y cada seis horas.

Cuando el actualizador de Tauri encuentra una versión más reciente, aparece un punto azul en el icono de la barra de menús de macOS o en la bandeja de Windows/Linux, cuando esta está disponible. El dashboard integrado muestra la misma señal de actualización de Desktop. Un navegador conectado al mismo proxy sigue mostrando el estado de actualización del paquete del proxy. Si la aplicación deja de informar durante unos tres minutos, el indicador integrado pasa a estado desconocido hasta que se reconecta. El punto indica disponibilidad; la instalación sigue requiriendo una acción explícita.

En Desktop, pulsa el botón de actualización del dashboard para abrir la página de actualización de la aplicación. Allí puedes buscar de nuevo, instalar una actualización firmada pendiente o volver al dashboard. La misma instalación está disponible desde la bandeja. Si falla, la actualización sigue disponible para reintentar. La aplicación también recupera el proxy que detuvo para instalarla, de modo que Codex no se quede sin proxy por una actualización fallida. Esta página funciona también en Linux sin icono de bandeja. El dashboard de un navegador normal administra, en cambio, la instalación del paquete de ese proxy.

Antes de instalar, las actualizaciones se verifican con la clave pública del actualizador firmado del proyecto. En macOS, las actualizaciones desde la aplicación descargan `OpenCodex-<version>-macos.app.tar.gz`; el DMG se usa para la primera instalación. El manifiesto de publicación solo se genera cuando está configurado el secreto de la clave del actualizador y exige entonces que las cuatro plataformas tengan firma.

## Widget

La aplicación macOS incluye la extensión WidgetKit de OpenCodex. Consulta la [guía de la aplicación de barra de menús de macOS](/es/guides/macos-menu-bar/) para configurar el widget y conocer los detalles de las instantáneas locales.

<a id="uninstall"></a>

## Desinstalar

Antes de desinstalar una versión de Desktop compatible, abre **Comando de terminal** en el dashboard o **Terminal command…** en la bandeja y elige **Quitar comando de terminal**. Desktop solo elimina su configuración administrada que no haya sido modificada. Los bloques o archivos modificados se conservan y se notifican; resuelve esos problemas antes de borrar la aplicación. Desinstalar directamente no garantiza que se limpien los archivos de shell o el `Path` del usuario.

En macOS, arrastra `OpenCodex.app` desde Aplicaciones a la Papelera. En Windows, quita OpenCodex desde **Aplicaciones instaladas**. En sistemas Linux basados en Debian, ejecuta:

```bash
sudo apt remove opencodex
```

Para AppImage, elimina el archivo descargado.

Si no se puede leer la configuración guardada de la barra de menús, se rechazan las ediciones parciales para conservar el archivo. Restáuralo o restablece expresamente la configuración del complemento antes de editar de nuevo.
