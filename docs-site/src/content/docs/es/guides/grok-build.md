---
title: "Grok Build"
description: "Usa modelos enrutados por opencodex desde Grok Build CLI de xAI; se registran en ~/.grok/config.toml mientras el proxy está activo."
---

opencodex sirve un OpenAI -compatible `POST /v1/responses` en su puerto local, y Grok Build soporta modelos personalizados contra OpenAI -compatible con servidores. A partir de esta integración, opencodex registra todo su catálogo visible en Grok Build automáticamente, sin necesidad de edición de configuración manual.

<a id="auto-registration"></a>

## Auto-registro

Cuando `~/.grok` existe, `ocx start` (y `ocx ensure` / `ocx restart`) escribe un bloque administrado en `~/.grok/config.toml`:

```toml
# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"
extra_headers = { "x-opencodex-grok" = "1" }

[model.ocx-gpt-5-6-sol]
model = "gpt-5.6-sol"
model_provider = "opencodex"
name = "OCX gpt-5.6-sol"
context_window = 272000
supports_reasoning_effort = true
reasoning_effort = "low"

[[model.ocx-gpt-5-6-sol.reasoning_efforts]]
id = "low"
value = "low"
label = "Low"
description = "Quick, fast implementations"
default = true
# ... remaining rungs for this model, then one [model.ocx-*] table per visible model,
# each referencing model_provider = "opencodex" ...
# <<< opencodex managed block <<<
```

- **Aditivo:** su propia configuración fuera de la valla nunca se toca. Antes de la primera inyección en un archivo preexistente, se escribe una copia de seguridad de una sola vez en `~/.grok/config.toml.bak-opencodex`.
- **Idempotente:** cada `ocx start` (y `ocx ensure` mientras el inicio automático está habilitado) reemplaza el bloque cercado con el catálogo actual.
- **Eliminado en desmontaje:** `ocx stop`, `ocx eject`, `ocx uninstall`, y el elegante daemon sin servicio de apagado desmonta el bloque vallado y restaura tu archivo byte por byte. Bajo un administrador de servicios, el desmontaje pasa por `ocx stop` / `ocx
  uninstall` (los procesos en modo servicio mantienen el bloque intencionalmente en todas las reapariciones).
- **Conflict-safe:** alias ya definidos por sus propias mesas `[model.*]` (opencodex sufijos de sus propias entradas); una valla dañada (marcador de inicio sin marcador final) rechaza cualquier cambio automático y pide reparación manual.

A continuación, elija un modelo dentro Grok Build:

```bash
grok models          # lists ocx-* entries alongside native grok models
grok -m ocx-anthropic-claude-opus-4-8 -p "hello"
# or in the TUI: /model ocx-anthropic-claude-opus-4-8
```

<a id="reasoning-effort"></a>

## Esfuerzo de razonamiento

Grok Build 's `/effort` (y `--effort`) sólo funciona para los modelos cuya entrada de catálogo anuncia la escalera: su lista de modelos lee la respuesta cruda `GET /v1/models`, y las entradas allí deben llevar `supports_reasoning_effort` más `reasoning_efforts` opciones de menú. Una proyección compatible con Grok de esa escalera se escribe en cada tabla `[model.*]` administrada ( filas `supports_reasoning_effort`, `reasoning_effort` predeterminadas y `[[model.<alias>.reasoning_efforts]]` de selector) de modo que el menú está presente cuando Grok lee el modelo desde `config.toml`. Para las entradas de modelo enrutadas, opencodex refleja los niveles de proveedor configurados ( `reasoningEfforts` / `modelReasoningEfforts`, y el valor predeterminado de `modelDefaultReasoningEfforts`). Estos metadatos describen la escalera enrutada configurada por proxy. Los adaptadores pueden emular el razonamiento o mapear niveles en campos específicos del proveedor. Los modelos enrutados con una escalera configurada muestran el control de esfuerzo en Grok Build al igual que lo hacen en Codex. Los modelos con una lista de niveles vacía no mantienen ningún control de esfuerzo, igualando el comportamiento de Codex. Las entradas nativas de GPT-5.6 están separadas: preservan y exponen sus escalas de razonamiento ascendente ancladas en lugar de los metadatos enrutados configurados por el proveedor. Los Grok peldaños válidos, incluidos los `none` y `minimal`, se conservan cuando se anuncian. Los peldaños no soportados o duplicados, incluyendo Codex -sólo `ultra`, se omiten del archivo, manteniendo cada opción de selector emitida seleccionable.

Grok Build habla con opencodex sobre el Responses API. Cuando la ruta anuncia una escalera de razonamiento, el paso Responses avanza `reasoning.summary` según lo configurado, por lo que las trazas de pensamiento alcanzan Grok de forma nativa como Responses elementos de razonamiento. Establecer `reasoning.summary: "none"` si un cliente quiere que el modelo piense sin devolver el rastro. Un `reasoning.summary` explícito gana sobre el valor predeterminado de la ruta.

<a id="authentication-note"></a>

## Nota de autenticación

Grok Build requiere una clave API no vacía para modelos personalizados incluso en bucle. Las entradas inyectadas llevan un marcador de posición (`opencodex-loopback`) - opencodex ignora las claves de admisión para las conexiones de bucle invertido, por lo que no hay ningún secreto real involucrado.

**El registro automático es solo loopback.** Cuando opencodex enlaza un host no loopback - incluyendo los comodines `0.0.0.0` y `::`, que exponen todas las interfaces - las solicitudes necesitan su token de admisión real, y un bloque administrado no puede llevar uno de forma segura. Escribir el token literal pondría tu secreto en `~/.grok/config.toml` y sobrescribiría lo que establezcas allí en el siguiente `ocx start` / `ensure` / `restart`. Por lo tanto, opencodex no escribe nada en ese caso (y elimina cualquier bloque sobrante de un enlace de bucle de retroceso anterior), y configura los modelos usted mismo fuera de los marcadores administrados, donde nada opencodex puede golpearlos. Vea [Receta manual](#manual-recipe-without-auto-registration) para la tabla exacta, y establezca `base_url` (un host que es realmente accesible desde donde ejecuta `grok`) y `api_key` (su `OPENCODEX_API_AUTH_TOKEN`).

No reemplace `api_key` con `env_key` aquí. Un `env_key` que no se resuelve no detiene la solicitud - Grok cae a través de su token de sesión xAI y lo envía a cualquier `base_url` los nombres de entrada, que para una implementación de LAN es un punto final HTTP de texto plano que no es xAI.

El `api_key` inyectado en la entrada del proveedor se encuentra primero en la cadena de credenciales de Grok para estos modelos, por lo que las vueltas contra opencodex no necesitan un inicio de sesión Grok adicional. Mantenga su configuración normal `grok login` / `XAI_API_KEY` para los modelos de grok nativos y cualquier función de arnés que contacte directamente con xAI.

<a id="manual-recipe-without-auto-registration"></a>

## Receta manual (sin auto-registro)

Si no te gusta `~/.grok/config.toml` — o opencodex está en un enlace no loopback — agregar a `[model_providers.opencodex]` tablas de bloques y por modelo que hacen referencia a él, fuera del
`# >>> opencodex managed block` marcadores:

```toml
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

Para un proxy accesible a través de la red, el punto `base_url` en la dirección `grok` puede marcar y usar su token de admisión:

```toml
[model_providers.opencodex]
base_url = "http://192.168.1.10:10100/v1"   # the reachable host, not 127.0.0.1
api_backend = "responses"
api_key = "your-OPENCODEX_API_AUTH_TOKEN"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

Esto usa la herencia `[model_providers.<id>]`, que requiere Grok Build 0.2.109 o posterior (liberado 2026-07-21). En versiones anteriores, el heredado `base_url` no se aplica al enrutamiento de inferencia - actualización, o volver a los campos directos por modelo (`base_url` / `api_backend` / `api_key` en cada tabla `[model.*]`).

Citar cualquier alias que contenga un punto: bare `[model.grok-4.5]` es una ruta clave de tres segmentos, no el id `grok-4.5`. Los alias generados evitan los puntos completamente por esta razón.

<a id="known-limitations"></a>

## Limitaciones conocidas

- **Instalación del servicio `ocx restart`:** el proxy en ejecución posee la autorización de reinicio y la coordinación de drenaje, mientras que el administrador de servicios instalado inicia el reemplazo después de que finalice el proceso anterior. La supervisión del servicio permanece instalada. En el registro automático de bucle de retorno, el bloque administrado también permanece en su lugar a través del traspaso; en su lugar, las implementaciones que no son de bucle de retorno utilizan la configuración administrada manualmente Grok. El comando solo tiene éxito después de que un proceso diferente verificado por identidad esté activo en el mismo puerto.
- **Configure el tiempo de lectura:** inicia primero opencodex, luego lanza `grok` para obtener los resultados más predecibles. Grok Build observa `~/.grok/config.toml` y se recarga cuando la tabla `[model]` realmente cambia (aproximadamente un segundo de rebote, en comparación con el contenido), por lo que un bloque actualizado alcanza una sesión abierta sin reiniciar. Para confirmar lo que Grok analizó, ejecute `grok inspect`: enumera las fuentes de configuración que cargó y advierte sobre cualquier campo que rechazó. No imprime la lista de modelos resueltos. El modelo Grok Build actual informa y omite campos de modelo no válidos mientras conserva el resto de la entrada del modelo. Un error de sintaxis TOML aún evita que el archivo se cargue. opencodex escribe atómicamente, por lo que Grok observa un documento completo en cada recarga.
- **Actualizaciones del catálogo:** el bloque vallado refleja el catálogo en el momento de la inyección. Después de agregar proveedores o modelos, ejecute `ocx ensure` (o reinicie el proxy) para actualizarlo.

<a id="devin-rate-limits"></a>

## Límites de solicitudes Devin

Si Devin rechaza una solicitud directa con un límite de velocidad antes de producir una salida o realizar una acción, OpenCodex devuelve HTTP 429 con un error JSON. Grok puede reconocer entonces el límite en lugar de mostrar un error genérico 500 de un flujo de HTTP 200 fallido. Si la respuesta incluye `Retry-After`, siga ese retraso antes de volver a intentarlo. Las cuotas agotadas sin una sugerencia de reinicio no reciben un retraso predeterminado. La conmutación por error de la cuenta OAuth existente todavía se aplica. Este manejo HTTP 429 también se aplica a las solicitudes Responses que no son de transmisión.

Para las solicitudes de transmisión, OpenCodex espera hasta el tiempo de espera configurado para este rechazo temprano. Si esa espera expira, se abre la respuesta SSE y permite que el supervisor de flujo existente maneje las paradas. Después de que se envían las cabeceras HTTP, un fallo posterior permanece en la secuencia como `response.failed`.
