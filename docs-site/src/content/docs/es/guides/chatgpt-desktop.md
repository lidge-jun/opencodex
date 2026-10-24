---
title: "Shim del app-server de ChatGPT Desktop (experimental)"
description: "Experimento opcional para macOS que reescribe los campos de bloqueo por cuota general en la salida estándar del app-server incluido."
---

Este experimento **solo funciona en macOS y está desactivado de forma predeterminada**. Filtra la salida estándar JSON-RPC del app-server incluido con ChatGPT para abrir los bloqueos conocidos debidos únicamente a la cuota general. No aumenta la cuota de la cuenta ni obliga al servicio del proveedor a aceptar solicitudes que rechaza.

Habilítelo en el archivo `config.json` de OpenCodex:

```json
{
  "chatgptDesktop": { "appServerShim": true }
}
```

Después, ejecute:

```bash
ocx chatgpt launch
ocx chatgpt status
```

`launch` crea un lanzador ejecutable en el directorio de configuración de OpenCodex, cierra ChatGPT si está en ejecución y vuelve a abrirlo con `open -a <bundle> --env CODEX_CLI_PATH=<launcher>`. Busca la aplicación por su identificador de paquete, `com.openai.codex`, por lo que también admite instalaciones en `~/Applications` o en otro volumen. Nunca cierra ni abre otra aplicación que simplemente comparta el nombre «ChatGPT». Guarde primero el trabajo en curso: esta operación reinicia la aplicación. No requiere un proxy de OpenCodex en ejecución.

Para eliminar el lanzador y volver a abrir la aplicación sin esa sustitución:

```bash
ocx chatgpt restore
```

La restauración conserva el valor configurado. Establezca `chatgptDesktop.appServerShim` en `false` o elimínelo para impedir futuros inicios explícitos con el shim. Abrir normalmente la aplicación desde Dock o Spotlight no aplica el shim automáticamente.

Si ChatGPT no está instalado (no se encuentra un paquete `com.openai.codex`), `restore` solo elimina el lanzador: no puede volver a abrir ninguna aplicación y termina con un error.

<a id="rewrite-boundary"></a>

## Alcance de la reescritura

Solo se consideran las notificaciones `account/rateLimits/updated` y las respuestas cuyo resultado de nivel superior contiene `rateLimits`, `rateLimitsByLimitId` u `ordinaryUsageAllowed`. Se eliminan los marcadores simples `rate_limit_reached`. Los campos conocidos de bloqueo por cuota (`allowed`, `limit_reached` / `limitReached`, `ordinaryUsageAllowed`) solo pasan al estado permitido cuando hay evidencia de que el bloqueo se debe a la cuota general: se ha eliminado un marcador de ese tipo o una ventana de uso alcanza el 100%. Un campo bloqueado por un motivo que no aparece en los datos recibidos permanece bloqueado. Las restricciones del espacio de trabajo, los créditos, los tipos desconocidos de límite alcanzado y los controles de gasto mantienen cerrado el acceso por uso.

El uso mostrado conserva los datos reales: porcentajes, fechas de restablecimiento, duración de las ventanas, información del plan y otros campos de presentación se mantienen como se recibieron. Los mensajes JSON-RPC ajenos a este caso, la salida anidada de herramientas, los metadatos que bloquean el envío de conversaciones y las líneas malformadas se transmiten sin cambios. Solo se vuelven a serializar las líneas modificadas; los demás bytes conservan su codificación y sus finales de línea originales. La entrada estándar, la salida de errores y el código de salida del binario real mantienen su conexión directa con la aplicación.

<a id="executable-and-environment-security"></a>

## Seguridad del ejecutable y del entorno

El lanzador generado tiene permisos `0755` e incorpora la ruta del ejecutable actual de OpenCodex y, en instalaciones desde el código fuente, la ruta de entrada de la CLI. `CODEX_CLI_PATH` indica a ChatGPT que ejecute ese lanzador en lugar de iniciar directamente su binario incluido. Mantenga bajo su control el lanzador, su directorio de configuración y la instalación de OpenCodex: modificar esas rutas cambia el código que ejecuta la aplicación. El lanzador usa `exec` para ejecutar el binario incluido en el paquete detectado. Si ese paquete no contiene un binario app-server, `launch` rechaza la operación sin escribir el lanzador.

Antes de escribirlo, `launch` comprueba también que el paquete y su binario app-server pertenezcan a usted o a root, que ni el grupo ni otros usuarios puedan modificarlos y que superen la verificación estricta de firma de código con el identificador de equipo de OpenAI (`2DC432GLL2`). Se rechaza cualquier paquete que incumpla una comprobación, incluido uno que pertenezca a otra cuenta. El lanzador se escribe primero en un archivo temporal y después se coloca en su destino mediante un cambio de nombre; un enlace simbólico existente en esa ruta se reemplaza, sin seguirlo.

Antes de cerrar o abrir la aplicación, `restore` aplica las mismas comprobaciones de propiedad, permisos y firma al paquete y al ejecutable principal de la aplicación. Funciona con la opción experimental desactivada y sin un binario app-server incluido. Si falla la verificación de confianza o la reapertura, conserva el lanzador existente para permitir la recuperación.

Ambos comandos comprueban también todos los directorios que contienen el paquete hasta la raíz del sistema de archivos. Rechazan directorios de otra cuenta, enlaces simbólicos y directorios superiores ordinarios que permitan escritura al grupo o a otros usuarios. Los directorios de instalación propiedad de root y del grupo de administradores, y los directorios de confianza con bit sticky, conservan su tratamiento habitual de permisos. Estas comprobaciones abarcan propiedad, permisos POSIX y firma; no se ha verificado el comportamiento de las ACL nativas ni de las políticas de propiedad de volúmenes.

Esta integración no instala certificados, puertos de escucha de red, PAC ni procesos de vigilancia en segundo plano. No registra los mensajes ni el entorno de la aplicación. El estado informa si el proceso de ChatGPT en ejecución lleva la sustitución esperada del lanzador.

Si falla la detección de la aplicación o la inspección de procesos, `status` informa `unknown` en lugar de `not running`. `launch` y `restore` se niegan a volver a abrir una aplicación si no pueden confirmar que haya terminado; en ese caso, la restauración conserva el lanzador. Resuelva el error de inspección y vuelva a intentarlo. `launch` comprueba el estado antes de escribir el lanzador, pero una inspección posterior puede fallar después de esa actualización atómica: los comandos no garantizan un reinicio íntegro o una reversión completa.

<a id="failure-behavior-and-known-limits"></a>

## Comportamiento ante fallos y límites conocidos

Si la plataforma no es macOS, falta el entorno de ejecución de OpenCodex o falla la autoprueba del filtro, el lanzador ejecuta el binario original con su salida estándar intacta. La ausencia del binario app-server incluido es una excepción: no hay otro binario al que recurrir y el lanzador termina con un error (véase más abajo). Si el filtro supera la autoprueba y después termina inesperadamente durante la sesión, cierra la tubería. No se ha verificado qué hace entonces el app-server incluido: podría recibir SIGPIPE o un error de escritura, y Desktop podría iniciarlo de nuevo mediante el mismo lanzador. El modo de paso directo del filtro limita este problema a su terminación o caída: una excepción de reescritura deja pasar esa línea sin cambios, y un fallo inesperado del mecanismo de reescritura hace que el resto del flujo se transmita como bytes sin procesar.

El experimento depende de la ruta del binario incluido, de que la aplicación respete `CODEX_CLI_PATH` y de la estructura actual de los campos RPC. Las actualizaciones pueden cambiar estos elementos. Si la instalación de OpenCodex se mueve o elimina, falla la comprobación previa del lanzador y se ejecuta el binario original. Ejecute de nuevo `ocx chatgpt launch` después de mover la instalación. Si una actualización de la aplicación mueve o elimina el propio binario app-server incluido, el lanzador no puede iniciarlo: escribe en la salida de errores un mensaje que menciona `ocx chatgpt launch` y `ocx chatgpt restore`, y termina. Desktop no puede iniciar su app-server hasta que ejecute uno de esos comandos. Una sola línea de salida de más de 8 MiB se transmite sin analizar, en lugar de almacenarse en búfer.

Este shim independiente no reescribe los metadatos de conversaciones ni enruta solicitudes a modelos. Otros bloqueos de la aplicación o rechazos del proveedor pueden seguir impidiendo el envío. Que el lanzador esté conectado o que la autoprueba del filtro pase no demuestra que los datos de bloqueo de la aplicación atraviesen esa tubería.

Las observaciones del informante en [#6196](https://github.com/lidge-jun/opencodex/issues/6196), del 2 y el 13 de octubre de 2026, describen un shim conectado con el botón Send todavía desactivado al agotarse la cuota de forma normal. Con Desktop 26.1007.30912 y OpenCodex 2.84.0, no observó mensajes RPC de límites de uso que pudieran reescribirse, mientras que el bloqueo de la interfaz usaba otro transporte de datos de uso. El shim no puede reescribir datos que nunca llegan a su filtro de salida estándar. Son informes específicos de esas compilaciones, sin una nueva verificación en vivo ni una prueba de que todas las versiones de Desktop usen el mismo transporte.

El comportamiento pendiente del cuadro de redacción con una sesión iniciada sigue registrado en #6196. El éxito anterior con una configuración combinada de shim e intercepción no demuestra que el shim por sí solo sea suficiente. La intercepción de #6365 se cerró sin integrarse y no forma parte de una solución publicada.
