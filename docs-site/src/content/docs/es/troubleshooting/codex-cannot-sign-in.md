---
title: "Codex no puede iniciar sesión ni cargar"
description: "Qué comprobar si Codex no puede iniciar sesión o si todas las solicitudes fallan después de configurar opencodex."
---

Si Codex se detiene en una pantalla de inicio de sesión, informa que no puede cargar los requisitos de inicio de sesión o falla en todas las solicitudes de modelo después de configurar opencodex, la causa más probable es que Codex todavía esté apuntado al proxy opencodex mientras el proxy no se está ejecutando. Esto se informó como [#5261](https://github.com/lidge-jun/opencodex/issues/5261).

<a id="why-this-happens"></a>

## Por qué sucede esto

En la configuración de loopback predeterminada, opencodex no le da a Codex un proveedor separado. Apunta el propio proveedor Codex incorporado de `openai` en el proxy, escribiendo una anulación de raíz en `$CODEX_HOME/config.toml` (`%USERPROFILE%\.codex` en Windows):

```toml
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex (undo: ocx restore)
openai_base_url = "http://127.0.0.1:10100/v1"
# Auto-injected by opencodex (undo: ocx restore)
experimental_realtime_ws_base_url = "http://127.0.0.1:10100/v1"
```

Esas líneas están en el disco, por lo que sobreviven a un reinicio. Si el proxy no se está ejecutando cuando se inicia Codex, esa dirección no responde a nada, y Codex no tiene un segundo punto final al que recurrir. La pantalla que obtienes no dice nada sobre opencodex, por lo que es fácil malinterpretar el estado como un problema Codex.

El proxy puede estar ausente por razones ordinarias. La aplicación de la integración Codex no instala un servicio en segundo plano, es decir, un paso separado `ocx service install`, por lo que después de un reinicio puede no haber nada para recuperar el proxy. Una tarea programada registrada Windows comienza en el inicio de sesión en lugar de en el arranque, y también se puede deshabilitar, no iniciar o perder el puerto a otro proceso.

<a id="get-codex-working-again"></a>

## Haga que Codex vuelva a funcionar

Elija el resultado que desee. Ambos son seguros para ejecutar mientras el proxy está abajo.

**Mano Codex a su propia cuenta y puntos finales:**

```bash
ocx restore
```

Esto elimina el enrutamiento inyectado, la anulación en tiempo real y el puntero de catálogo opencodex, y no necesita proxy en ejecución, ninguna sesión de panel de control ni red. Codex se registra y corre normalmente después. Cuando se quiere opencodex atrás, `ocx restore back` vuelve a señalar Codex en el proxy.

**O vuelva a iniciar el proxy:**

En una primera terminal, inicie el proxy en primer plano y déjela abierta:

```bash
ocx start
```

En una segunda terminal, compruebe que `ocx ready --json` indique `ready: true` antes de instalar el servicio. Después, repita las comprobaciones para verificar el servicio resultante:

```bash
ocx ready --json
ocx status --json
ocx service install   # keep it running across restarts
ocx ready --json
ocx status --json
ocx service status --json
```

La instalación explícita del servicio detiene el proxy independiente registrado antes de iniciar el servicio administrado; por eso la primera terminal puede finalizar durante la instalación. Si esa limpieza no puede completarse de forma segura, la instalación se rechaza. Después comprueba que un entorno OpenCodex responda en el puerto del servicio instalado. La consulta de disponibilidad anterior a la instalación solo verifica el proxy independiente. Usa las comprobaciones posteriores de disponibilidad, estado del proxy y estado del servicio para verificar el cambio de supervisor.

`ocx status` informa si el proxy está respondiendo y si Codex está actualmente enrutado a través de él. `ocx doctor` explica el mismo estado con más detalle y nombra la reparación que recomienda.

<a id="if-ocx-is-not-available"></a>

## Si ocx no está disponible

Puede deshacer el enrutamiento a mano. Abra `$CODEX_HOME/config.toml` y elimine tres cosas: la línea `openai_base_url`, la línea `experimental_realtime_ws_base_url` y cualquier línea `model_catalog_json` que termine en `opencodex-catalog.json`. Elimina el comentario `# Auto-injected by opencodex` que se encuentra directamente encima de cada uno de los dos primeros junto con ellos.

Vaya por el nombre de la clave, no por el comentario. opencodex utiliza el mismo comentario de propiedad sobre otras claves que administra, como una `developer_instructions` inyectada, y eliminarlas no le ayudará a iniciar sesión mientras le cuesta la configuración que desee recuperar.

Los comentarios de propiedad independientes repetidos no cambian los valores TOML ni el enrutamiento. La reinyección y eliminación en la mesa del proveedor consumen el marcador desnudo exacto o su forma `(undo: ocx restore)` inmediatamente por encima de `[model_providers.opencodex]`. El texto del marcador dentro de otro comentario de usuario o una cadena multilínea se conserva; los comentarios existentes separados de la tabla no son reclamados por esa transformación. La propiedad de enrutamiento raíz utiliza un marcador adyacente exacto en una asignación raíz estructural. Un valor inyectado coincidente registrado en la revista también demuestra la propiedad después de que una aplicación Codex reescriba comentarios. Citar el marcador en un comentario de usuario o una cadena multilínea no prueba la propiedad. Los reemplazos administrados `web_search` registran la asignación original completa, incluidos los valores multilínea, por lo que volver a encenderla o restaurarla de nuevo puede devolverla. La eliminación y la captura validan las asignaciones completas sin convertir un entero válido de 64 bits en un número JavaScript. La propiedad basada en el valor todavía requiere una decodificación de valor exitosa; se rechazan las asignaciones inválidas o incompletas. La eliminación de retroceso compacta las líneas en blanco del documento fuera de los valores multilínea, preservando las líneas en blanco dentro de esos valores.

Elimine la línea `model_catalog_json` **con** el enrutamiento, no por sí solo. Un `model_catalog_json` que nombra un archivo que ya no existe hace que Codex no cargue su configuración, que se parece al mismo bloqueo por una razón diferente.

<a id="accounts-that-would-not-add-or-display"></a>

## Cuentas que no agregarían ni mostrarían

Las fallas al agregar cuentas al grupo, o las cuentas agregadas que no aparecen, son un asunto separado del bloqueo anterior, incluso cuando ocurren en la misma sesión. El grupo de cuentas es servido por la administración del proxy API, por lo que tanto el flujo `ocx account login openai` como la lista del panel de control necesitan un proxy en ejecución antes de que cualquier otra cosa pueda funcionar. El inicio de sesión del navegador también vuelve a `http://localhost:1455/auth/callback`, una dirección fija que no puede moverse a otro puerto. Si algo más contiene el puerto 1455, o no se puede iniciar un navegador, utilice el flujo de dispositivos en su lugar:

```bash
ocx account login openai --device
```

Consulte [Codex Integración](/es/guides/codex-integration/) para conocer qué escribe la inyección y cómo se elige el enrutamiento.

<a id="oauth-refresh-capacity-reached"></a>

## Capacidad de actualización OAuth alcanzada

Si una solicitud Responses reporta `OAuth token refresh capacity reached`, espere al menos un segundo antes de volver a intentarlo. El proxy limita el trabajo de actualización pendiente OAuth a 256 consumidores por proceso, incluidas las solicitudes que esperan la misma actualización. Una solicitud desconectada mantiene su reserva de actualización hasta que se resuelve el trabajo; las solicitudes que usan credenciales nuevas en caché aún pueden continuar.

Antes de que comience una respuesta, este rechazo temporal devuelve HTTP 503 con `Retry-After: 1`. Un flujo que ya ha comenzado en su lugar termina con un error del servidor. El rechazo de capacidad no marca la cuenta como necesaria de reautenticación, por lo que el inicio de sesión de nuevo no es necesario para este error. Una actualización que nunca se asienta puede seguir ocupando capacidad; el límite no impone un plazo de actualización.
