---
title: "Grok Build"
description: "Usa modelos enrutados por opencodex desde Grok Build CLI de xAI; se registran en ~/.grok/config.toml mientras el proxy está activo."
---

opencodex ofrece un endpoint `POST /v1/responses` compatible con OpenAI en su puerto local, y Grok Build admite modelos personalizados que se conectan a servidores compatibles con OpenAI. Con esta integración, opencodex registra automáticamente todo su catálogo visible en Grok Build, sin necesidad de editar la configuración a mano.

<a id="auto-registration"></a>

## Registro automático

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

- **Aditivo:** tu configuración fuera de los delimitadores nunca se modifica. Antes de la primera inserción en un archivo existente, se guarda una única copia de seguridad en `~/.grok/config.toml.bak-opencodex`.
- **Idempotente:** cada `ocx start` (y `ocx ensure` mientras el inicio automático esté habilitado) sustituye el bloque delimitado por el catálogo actual.
- **Eliminación al detener:** `ocx stop`, `ocx eject`, `ocx uninstall` y el apagado ordenado del daemon sin servicio eliminan el bloque delimitado y restauran tu archivo byte por byte. Con un administrador de servicios, la eliminación se realiza mediante `ocx stop`/`ocx uninstall` (los procesos en modo servicio conservan intencionalmente el bloque entre reinicios).
- **Protección frente a conflictos:** se respetan los alias que ya hayas definido en tus tablas `[model.*]` (opencodex añade sufijos a sus propias entradas). Si los delimitadores están dañados (hay un marcador de inicio sin marcador de fin), se rechaza cualquier cambio automático y se solicita una reparación manual.

A continuación, elige un modelo en Grok Build:

```bash
grok models          # lists ocx-* entries alongside native grok models
grok -m ocx-anthropic-claude-opus-4-8 -p "hello"
# or in the TUI: /model ocx-anthropic-claude-opus-4-8
```

<a id="reasoning-effort"></a>

## Esfuerzo de razonamiento

Los controles `/effort` y `--effort` de Grok Build solo funcionan con modelos cuya entrada del catálogo anuncia una escala de niveles: al obtener la lista de modelos, Grok lee la respuesta sin procesar de `GET /v1/models`, cuyas entradas deben incluir `supports_reasoning_effort` y las opciones de menú `reasoning_efforts`. En cada tabla `[model.*]` administrada se escribe una representación de esa escala compatible con Grok (`supports_reasoning_effort`, el valor predeterminado `reasoning_effort` y las filas del selector `[[model.<alias>.reasoning_efforts]]`), para que el menú esté disponible cuando Grok lea el modelo de `config.toml`. Para los modelos enrutados, opencodex refleja los niveles configurados del proveedor (`reasoningEfforts` / `modelReasoningEfforts` y el valor predeterminado de `modelDefaultReasoningEfforts`). Estos metadatos describen la escala de la ruta configurada en el proxy. Los adaptadores pueden emular el razonamiento o convertir los niveles en campos específicos del proveedor. Los modelos enrutados con una escala configurada muestran el control de esfuerzo en Grok Build igual que en Codex. Los modelos con una lista de niveles vacía no muestran ese control, en consonancia con Codex. Las entradas nativas de GPT-5.6 son independientes: conservan y exponen las escalas de razonamiento fijadas de origen, en lugar de los metadatos de enrutamiento configurados por el proveedor. Se conservan los niveles válidos de Grok, incluidos `none` y `minimal`, cuando se anuncian. Los niveles no admitidos o duplicados, incluido `ultra`, exclusivo de Codex, se omiten del archivo para que todas las opciones del selector puedan seleccionarse.

Grok Build se comunica con opencodex mediante la API Responses. Cuando la ruta anuncia una escala de razonamiento, el paso directo de Responses reenvía `reasoning.summary` según la configuración, de modo que las trazas de razonamiento llegan a Grok de forma nativa como elementos de razonamiento de Responses. Establece `reasoning.summary: "none"` si el cliente quiere que el modelo razone sin devolver la traza. Un valor explícito de `reasoning.summary` tiene prioridad sobre el valor predeterminado de la ruta.

<a id="authentication-note"></a>

## Nota de autenticación

Grok Build requiere una clave API no vacía para los modelos personalizados, incluso en loopback. Las entradas insertadas contienen un marcador de posición (`opencodex-loopback`): opencodex ignora las claves de admisión en las conexiones de loopback, por lo que no se utiliza ningún secreto real.

**El registro automático solo funciona en loopback.** Cuando opencodex escucha en una dirección que no es de loopback, incluidos los comodines `0.0.0.0` y `::`, que exponen todas las interfaces, las solicitudes necesitan tu token de admisión real y un bloque administrado no puede incluirlo de forma segura. Escribir el token literal dejaría tu secreto en `~/.grok/config.toml` y sobrescribiría lo que hayas configurado allí en el siguiente `ocx start`/`ensure`/`restart`. Por eso, en ese caso opencodex no escribe nada (y elimina cualquier bloque que quede de una configuración anterior en loopback). Debes configurar los modelos por tu cuenta fuera de los marcadores administrados, donde opencodex no puede sobrescribirlos. Consulta la tabla exacta en [Receta manual](#manual-recipe-without-auto-registration) y establece tanto `base_url` (un host accesible desde donde ejecutas `grok`) como `api_key` (tu `OPENCODEX_API_AUTH_TOKEN`).

No sustituyas `api_key` por `env_key` aquí. Si `env_key` no se resuelve, la solicitud no se detiene: Grok usa como alternativa tu token de sesión de xAI y lo envía a la URL indicada por `base_url`, que en un despliegue en LAN es un endpoint HTTP sin cifrar que no pertenece a xAI.

El `api_key` insertado en la entrada del proveedor ocupa el primer lugar en la cadena de credenciales de Grok para estos modelos, por lo que las interacciones con opencodex no requieren otro inicio de sesión en Grok. Conserva tu configuración habitual de `grok login` / `XAI_API_KEY` para los modelos nativos de Grok y las funciones del entorno de ejecución que contacten directamente con xAI.

<a id="manual-recipe-without-auto-registration"></a>

## Receta manual (sin registro automático)

Si gestionas `~/.grok/config.toml` por tu cuenta, o si opencodex escucha en una dirección que no es de loopback, añade un bloque `[model_providers.opencodex]` y tablas para cada modelo que hagan referencia a él, fuera de los marcadores `# >>> opencodex managed block`:

```toml
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

Para un proxy accesible a través de la red, configura un frontend TLS antes de proporcionar tu token de admisión y apunta `base_url` a su dirección HTTPS. Como alternativa, utiliza un túnel local y su dirección de loopback. Grok almacena el valor literal de `api_key` en `~/.grok/config.toml`; restringe el acceso al archivo y mantenlo fuera del control de versiones y de las copias de seguridad compartidas.

```toml
[model_providers.opencodex]
base_url = "https://proxy.example.com/v1"   # configured TLS frontend
api_backend = "responses"
api_key = "your-OPENCODEX_API_AUTH_TOKEN"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

Esto utiliza la herencia de `[model_providers.<id>]`, que requiere Grok Build 0.2.109 o posterior (publicado el 2026-07-21). En versiones anteriores, el `base_url` heredado no se aplica al enrutamiento de inferencia: actualiza Grok Build o utiliza campos directos por modelo (`base_url`/`api_backend`/`api_key` en cada tabla `[model.*]`).

Pon entre comillas cualquier alias que contenga un punto: `[model.grok-4.5]` sin comillas es una ruta de claves de tres segmentos, no el identificador `grok-4.5`. Por eso, los alias generados evitan por completo los puntos.

<a id="known-limitations"></a>

## Limitaciones conocidas

- **`ocx restart` con un servicio instalado:** el proxy en ejecución se encarga de autorizar el reinicio y coordinar la finalización de las solicitudes en curso, mientras que el administrador de servicios instalado inicia el reemplazo cuando termina el proceso anterior. La supervisión del servicio permanece instalada. Si el registro automático usa loopback, el bloque administrado también se conserva durante el relevo; los despliegues fuera de loopback utilizan una configuración de Grok administrada manualmente. El comando solo tiene éxito cuando un proceso diferente, cuya identidad se ha verificado, está en buen estado en el mismo puerto.
- **Momento de lectura de la configuración:** inicia primero opencodex y después `grok` para obtener los resultados más predecibles. Grok Build observa `~/.grok/config.toml` y recarga cuando cambia realmente el contenido de la tabla `[model]` (con una espera de aproximadamente un segundo para agrupar cambios), por lo que un bloque actualizado llega a una sesión abierta sin reiniciarla. Para confirmar lo que Grok ha leído, ejecuta `grok inspect`: enumera las fuentes de configuración cargadas y advierte sobre los campos rechazados. No imprime la lista de modelos resueltos. La versión actual de Grok Build informa de los campos de modelo no válidos y los omite, pero conserva el resto de la entrada. Un error de sintaxis TOML sí impide cargar el archivo. opencodex escribe de forma atómica, por lo que Grok recibe un documento completo en cada recarga.
- **Actualizaciones del catálogo:** el bloque delimitado refleja el catálogo en el momento de su inserción. Después de añadir proveedores o modelos, ejecuta `ocx ensure` (o reinicia el proxy) para actualizarlo.

<a id="devin-rate-limits"></a>

## Límites de solicitudes de Devin

Si Devin rechaza una solicitud directa por un límite de solicitudes antes de producir una salida o realizar una acción, OpenCodex devuelve HTTP 429 con un error JSON. Así, Grok puede reconocer el límite en lugar de mostrar un error genérico 500 por un flujo HTTP 200 fallido. Si la respuesta incluye `Retry-After`, respeta ese tiempo antes de volver a intentarlo. Cuando la cuota se agota sin indicar cuándo se restablece, no se añade una espera predeterminada. Sigue aplicándose la conmutación por error entre cuentas OAuth existente. Este tratamiento de HTTP 429 también se aplica a las solicitudes Responses sin streaming.

Para las solicitudes con streaming, OpenCodex espera este rechazo temprano hasta que vence el tiempo de espera por inactividad configurado. Si vence, abre la respuesta SSE y deja que el supervisor de flujo existente gestione los bloqueos. Una vez enviadas las cabeceras HTTP, cualquier fallo posterior permanece dentro del flujo como `response.failed`.
