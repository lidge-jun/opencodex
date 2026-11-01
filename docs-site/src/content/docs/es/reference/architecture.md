---
title: "Arquitectura"
description: "Mapa de módulos de opencodex, puente AdapterEvent, analizador de solicitudes y caché."
---

opencodex se ejecuta en un único proceso Bun. Una solicitud llega como OpenAI Responses, se normaliza al modelo interno, se enruta y se envía al proveedor mediante un adaptador. La respuesta vuelve a convertirse en Responses SSE. Consulta [Cómo funciona](/es/getting-started/how-it-works/) para conocer el flujo completo.

<a id="module-map"></a>

## Mapa de módulos

```
src/
├── cli/                # ocx command dispatch, init, status, provider commands
├── server/             # Bun.serve, /v1/* proxy, /api/* management API, WS bridge
├── codex/              # Codex config injection, catalog sync, auth/account integration
├── providers/          # provider metadata, API-key pool, quota and labels
├── adapters/           # wire adapters, shared guards/utilities, Cursor protobuf transport
├── oauth/              # OAuth providers, API-key catalog, token store/refresh
├── usage/              # request usage extraction, JSONL logs, summaries, totals
├── lib/                # runtime, process, retry, privacy, token estimate helpers
├── web-search/         # web-search sidecar (synthetic tool, loop, executor, parser)
├── vision/             # vision sidecar (describe + plan)
├── config.ts           # ~/.opencodex/config.json, defaults, PID, env resolution
├── router.ts           # model id → provider + adapter
├── bridge.ts           # facade over bridge/
├── bridge/             # AdapterEvent stream → Responses SSE (sse.ts) / JSON (response-json.ts)
├── reasoning-effort.ts # reasoning-effort translation, clamping, and catalog levels
├── responses/
│   ├── parser.ts       # Responses request → OcxParsedRequest
│   ├── schema.ts       # Zod validation
│   └── compaction.ts   # remote compaction prompts, envelopes, compact history
├── service.ts          # launchd / systemd / Task Scheduler background service
├── types.ts            # core interfaces + helpers (modelInList, namespacedToolName)
└── index.ts            # public entry
```

Varios archivos de entrada que antes eran grandes conservan ahora la compatibilidad como fachadas: `codex/catalog.ts` exporta sus módulos especializados `codex/catalog/*.ts`; `server/management-api.ts` delega en `server/management/*.ts`; `server/responses.ts` exporta `server/responses/*.ts`; y `bridge.ts` reexporta `bridge/*.ts`. La fachada mantiene estable la ruta de importación, mientras la implementación reside en esos módulos. Los pasos siguientes indican el módulo responsable; `structure/transports/responses.md` contiene el inventario completo de responsables de la interfaz Responses.

<a id="request-flow"></a>

## Flujo de solicitudes

`server/index/serve-options.ts` posee el límite HTTP y delega el plano de datos Responses a la fachada `server/responses.ts` y sus módulos `server/responses/*.ts`:

1. `server/index/serve-options.ts` aplica CORS y la autenticación de API, registra los metadatos del ciclo de vida y rechaza trabajo nuevo durante el drenaje con HTTP 503, JSON `error.code: "server_restarting"` y `Retry-After: 5`. La respuesta usa la política CORS del servidor receptor. Atiende `GET /v1/models`, `POST /v1/responses`, `POST /v1/responses/compact` y `POST /v1/images/generations` / `POST /v1/images/edits` (reenviados por `server/images.ts` a un proveedor de la familia OpenAI para la herramienta integrada `image_gen` de Codex). `server/live.ts` gestiona `POST /v1/live` / `POST /v1/realtime/calls`, la unión WebSocket `/v1/live/{callId}` o `/v1/realtime?call_id=`, y se admite la actualización opcional WebSocket en `/v1/responses`.
2. `server/responses/request-prepare.ts` descomprime y analiza JSON, expande la entrada de `previous_response_id` recordada localmente, si existe, y llama a `responses/parser.ts`.
3. `router.ts` resuelve un identificador sin prefijo o `provider/model`. El servidor resuelve la afinidad de cuenta de Codex, actualiza OAuth cuando es necesario y aplica la credencial elegida.
4. Antes de la llamada principal, `vision/` describe las imágenes de los modelos incluidos en `noVisionModels`. Si no existe una ruta sidecar segura, se eliminan las imágenes en lugar de enviarlas a un proveedor de texto.
5. `server/adapter-resolve.ts` aplica las opciones de protocolo por modelo y construye el adaptador. Responses reenvía el cuerpo nativo; Cursor usa su transporte bidireccional `runTurn`; los adaptadores traducidos construyen, envían y analizan la solicitud.
6. En modelos enrutados que solicitan la herramienta alojada `web_search`, `web-search/` expone una función sintética, ejecuta la búsqueda real mediante el backend configurado (el sidecar de OpenAI/ChatGPT o Anthropic), devuelve los resultados al modelo y repite hasta el límite configurado. Los adaptadores HTTP ordinarios usan el bucle basado en fetch. Los que implementan `runTurn`, incluido Cursor, usan el bucle independiente `runTurnWebSearchLoop` de `server/responses/run-turn-execution.ts` cuando el plan de búsqueda cumple los requisitos.
7. `bridge/sse.ts` / `bridge/response-json.ts` generan Responses SSE o JSON. `server/request-log.ts` y `usage/` recogen estado terminal, latencia, etiquetas de proveedor y modelo y el uso de tokens disponible sin modificar la respuesta.

La estimación de entrada previa al envío sigue lo que realmente envía el adaptador enrutado. Para los modelos `openai-chat` excluidos por la política efectiva de repetición de pensamiento de chat (una lista explícita `preserveReasoningContentModels`, o detección DeepSeek Flash/Pro cuando no está configurado), el adaptador elimina el pensamiento de asistente repetido, por lo que la estimación también lo excluye; el historial que nunca llega al proveedor, por lo tanto, no puede causar un rechazo de límite de contexto local. Los modelos que preservan el razonamiento, y otros adaptadores, envían ese pensamiento y aún lo cuentan.

<a id="the-parser"></a>

## El analizador

`responses/parser.ts` valida la solicitud entrante con `responses/schema.ts` (Zod), luego construye un `OcxParsedRequest`:

- **Mensajes**: los elementos de `input` se normalizan como `OcxMessage[]`, con mensajes de usuario, desarrollador, asistente o resultados de herramientas (toolResult). Los elementos `reasoning` se convierten en bloques de pensamiento; `function_call`, `custom_tool_call` y `tool_search_call`, en llamadas a herramientas; y sus correspondientes elementos `*_output`, en resultados de herramientas.
- **Herramientas**: las herramientas de función se conservan. Las herramientas con espacio de nombres (MCP) se aplanan como `namespace__name` y recuperan su espacio de nombres al devolver la respuesta. Se marcan las herramientas de formato libre (como `apply_patch`) y las de descubrimiento **tool_search**. Las herramientas alojadas (`web_search`, generación de imágenes, etc.) se eliminan del conjunto enviado al adaptador y un sidecar solo las vuelve a incorporar si va a ejecutarlas.
- **Imágenes**: se conservan como partes de contenido reales (URL de datos o URL HTTPS remota), sin convertirlas en texto.
- **Indicadores de funciones**: `_webSearch` indica una búsqueda web alojada solicitada; `_structuredOutput`, que `text.format` es json_schema o json_object; y `_compactionRequest`, una compactación remota v2.

<a id="the-bridge"></a>

## El puente

`bridge/sse.ts` convierte el flujo interno `AdapterEvent` del adaptador en Responses SSE que Codex entiende:

| AdapterEvent | Responses SSE emitido |
| --- | --- |
| `text_delta` | `response.output_text.delta` → `…done`, `response.content_part.done`, `response.output_item.done` |
| `thinking_delta` | `response.reasoning_summary_text.delta` → `…done`, cierre del elemento |
| `reasoning_raw_delta` | Un elemento `reasoning_text` sin procesar, o una envolvente oculta para conservarlo al reenviarlo |
| `thinking_signature` / `redacted_thinking` | Conservado en un sobre de razonamiento `encrypted_content` |
| `tool_call_start` | `response.output_item.added` (tipo: `function_call` / `custom_tool_call` / `tool_search_call` ) |
| `tool_call_delta` | `response.function_call_arguments.delta` (omitido para forma libre / tool_search) |
| `tool_call_end` | `response.function_call_arguments.done` → `response.output_item.done` |
| `web_search_call_begin` / `web_search_call_end` | Un elemento activo `web_search_call` y citas de URL |
| `heartbeat` | Señala actividad del proveedor, sin generar un elemento visible para el usuario |
| `done` | `response.completed` (con uso) |
| `error` | `response.failed` (con `last_error`) |

El puente también envía un **latido para mantener la conexión activa** (RC3). Durante el silencio del proveedor, emite el comentario SSE `: opencodex heartbeat` cada 2 segundos para reiniciar el temporizador de inactividad de Codex. Los analizadores de eventos descartan estos comentarios sin generar eventos, por lo que los decodificadores estrictos de Responses no reciben variantes desconocidas. El **tiempo de espera por inactividad** predeterminado es de 300 segundos para un proveedor público y está desactivado para uno local (`stallTimeoutSec`; `0` lo desactiva en todos los casos). Al agotarse, se cancela el flujo del proveedor y se emite `response.incomplete` con la razón `upstream_stall_timeout`, para que una conexión bloqueada no detenga Codex indefinidamente.

El mapa de espacios de nombres y los conjuntos de herramientas de formato libre y de búsqueda que registra el analizador permiten distinguir tres tipos de elementos Responses. Así se conservan al enviar y recibir los espacios de nombres MCP, las herramientas de formato libre como `apply_patch` y las llamadas `tool_search` ejecutadas por el cliente. `buildResponseJSON()` genera una única respuesta sin streaming a partir de los mismos eventos.

<a id="management-api-oauth-and-usage"></a>

## API de administración, OAuth y uso

`server/management-api.ts` sirve al panel y delega los grupos de rutas en
`server/management/*.ts`. Sus rutas `/api/*` cubren la configuración y los ajustes
filtrados, la gestión de proveedores y grupos de claves, la selección de modelos,
los límites de contexto y los controles v2, la sincronización del catálogo, los
diagnósticos y registros de depuración, el uso y las cuotas, los sidecars, las
actualizaciones, las claves API de cliente generadas, OAuth, la selección y gestión
de cuentas Codex y la parada ordenada.

El acceso de administración a `/api/*` utiliza la credencial independiente
`OPENCODEX_ADMIN_AUTH_TOKEN` o el token administrativo generado; el panel utiliza
sesiones de administración. La admisión de modelos en `/v1/*` usa credenciales del
plano de datos, como `OPENCODEX_API_AUTH_TOKEN` o las claves API de cliente
configuradas. `server/auth-cors.ts` exige una credencial de datos al escuchar fuera
de loopback. Un token de modelos no concede acceso administrativo.
Las entradas de `corsAllowOrigins` amplían la lista de orígenes locales permitidos.

Las implementaciones OAuth están en `oauth/`. Los tokens de acceso se cargan o renuevan inmediatamente antes de una llamada enrutada. `oauth/token-guardian.ts` puede renovarlos de forma anticipada únicamente en los proveedores cuya política lo permita. La renovación coordina una sola operación en curso por proceso, un bloqueo de archivo por cuenta y una comparación e intercambio (CAS) de generación, para impedir que escrituras simultáneas sobrescriban una credencial más reciente.

La proyección compartida de estado (`oauth/health.ts`) alimenta `ocx status`, `ocx doctor`, la API de administración y el dashboard. Las credenciales del grupo Codex/ChatGPT y la afinidad de los hilos con las cuentas se gestionan en `codex/` y no se incluyen en las respuestas administrativas. La afinidad es local al proceso: se elimina ante `401`, `403` o `429`, sin mantener una cuenta fijada tras un límite de solicitudes, y no se conserva al reiniciar.

El uso de cada solicitud se normaliza como `OcxUsage`, se incluye en los eventos finales de Responses y se agrega mediante `usage/` para el dashboard y los diagnósticos JSONL opcionales.

<a id="transport-and-compaction"></a>

## Transporte y compactación

`server/index/serve-options.ts` sirve HTTP / SSE en `/v1/responses` por defecto. Si Codex intenta una actualización Responses WebSocket mientras que `websockets` es `false`, opencodex devuelve `426 upgrade_required`; Codex luego vuelve a HTTP para esa sesión. Cuando se establece `"websockets": true`, el mismo punto final acepta la actualización y utiliza el puente WebSocket.

Independientemente de esa opción del cliente, las solicitudes canónicas de reenvío a ChatGPT con `stream: true` en la raíz pueden usar el transporte WebSocket de Codex hacia el proveedor en Bun estable 1.4.0 o posterior. Esa ruta conserva la intención de HTTP Responses Lite en los metadatos de la trama WS y calcula la indicación de enrutamiento a partir del modelo y el nivel de servicio que realmente envía. Los metadatos iniciales de cuota y modelo se convierten en encabezados HTTP de respuesta acotados. Las actualizaciones posteriores de cuota se atribuyen a la cuenta que atendió la solicitud, sin añadirlas a encabezados ya enviados. Un fallo posterior al envío WS no provoca un reenvío automático por HTTP. Estas reglas no habilitan la opción WebSocket del cliente ni cambian el transporte de otros proveedores.

El Bun 1.3.14 incluido, las versiones preliminares y los entornos cuya identidad no se puede verificar usan HTTP/SSE. Las respuestas WS correctas conservan el contrato SSE hacia el cliente y evitan `tee()` mediante un relé acotado que lee anticipadamente con un solo lector: 4 MiB por trama, sin procesar o encapsulada, y una cola de producción de 8 MiB. Si la cola se desborda, se cierra la conexión con el proveedor y se envían al cliente un evento final `response.failed` y `[DONE]`.

Para el modelo saliente final `gpt-5.3-codex-spark`, el reenvío canónico ChatGPT desactiva explícitamente Responses Lite tanto en la cabecera HTTP como en los metadatos de trama WS nativos, incluso cuando un alias selecciona Spark, pero solo cuando el cuerpo saliente no lleva ningún elemento `additional_tools` con una matriz `tools` no vacía. Ese grupo ES la forma de entrega de herramientas Lite, por lo que un cuerpo de Spark que todavía lo usa mantiene Lite ON incluso si un llamante o un encabezado configurado dijeron lo contrario; de lo contrario, el marco anunciaría que no es Lite mientras que las herramientas existen solo en la forma Lite. Una identidad Lite cambiada retira el socket anterior; las solicitudes elegibles posteriores con la misma identidad pueden reutilizar el socket nuevo. Otros modelos y puertas de enlace mantienen su política Lite existente. Los metadatos nativos mal formados todavía caen de nuevo a HTTP con su cuerpo sin cambios.

Cuando un proveedor rechaza una solicitud de flujo continuo con HTTP 413 antes de que comience SSE, OpenCodex emite un evento de terminal `response.failed` con `context_length_exceeded` en lugar de retransmitir el estado desconocido reintentable. Esto permite que Codex detenga su bucle de reconexión y aplique su propia política de compresión de contexto en el siguiente turno. OpenCodex no elimina silenciosamente mensajes o imágenes; reduzca la entrada actual o reintente después de la compactación. Las llamadas a la API sin streaming siguen recibiendo el HTTP 413 del proveedor.

La compactación de contexto de Codex funciona con modelos enrutados. `server/responses/compact.ts` atiende `POST /v1/responses/compact` mediante un turno interno de resumen enrutado y devuelve el historial compactado. Por su parte, `responses/parser.ts` y `bridge/sse.ts` atienden los turnos `compaction_trigger` de compactación remota v2 y emiten exactamente un elemento sintético de salida `compaction`.

<a id="caching--the-catalog"></a>

## El almacenamiento en caché y el catálogo

- `codex/model-cache.ts` mantiene en memoria una caché por proveedor con TTL de los resultados de `/models`: 5 minutos de forma predeterminada, como la de Codex. Si la consulta falla, puede usar los resultados anteriores aunque hayan caducado.
- `codex/catalog/sync.ts`, exportado mediante la fachada `codex/catalog.ts`, incorpora los modelos enrutados al catálogo de Codex con sus espacios de nombres. Ordena primero los [modelos de subagentes](/es/guides/codex-integration/#the-subagent-picker) destacados, filtra `disabledModels` y permite restaurar el catálogo original desde una copia de seguridad creada una sola vez.

<a id="reasoning-effort"></a>

## Esfuerzo de razonamiento

`reasoning-effort.ts` traduce las etiquetas de esfuerzo de razonamiento de Codex a los valores enviados a cada proveedor. El catálogo anuncia etiquetas admitidas por Codex (`low` / `medium` / `high` / `xhigh` / `max`), pero el proveedor puede admitir solo algunas o necesitar un alias específico. El módulo:

- Define los niveles canónicos `CODEX_REASONING_LEVELS` y su orden.
- Ajusta el esfuerzo solicitado al nivel compatible más cercano si el nivel exacto no está disponible.
- Resuelve las opciones `reasoningEffortMap` por modelo y proveedor para personalizar los valores del protocolo.
- Omite por completo el esfuerzo en los modelos incluidos en `noReasoningModels`.

Qwen3.8-Max constituye una excepción de esfuerzo directo frente al contrato anterior de presupuesto de Qwen3.x. Alibaba Token Plan declara los niveles `low`, `medium` y `xhigh` (predeterminado), y envía el valor efectivo como `reasoning_effort`. Solo los niveles superiores añadidos por compatibilidad con Codex se limitan a `xhigh` al enviarlos al proveedor. El enriquecimiento del registro durante la ejecución corrige los metadatos guardados de versiones anteriores que aún clasifican el modelo como `thinking_budget`.

<a id="core-types"></a>

## Tipos principales

El modelo interno se define en `types.ts`: `OcxParsedRequest`, `OcxContext`, la unión `OcxMessage`, `OcxContentPart` (texto o imagen), `OcxToolCall`, `OcxTool`, `AdapterEvent` y los tipos de configuración `OcxConfig` y `OcxProviderConfig`. Se usan ampliamente las funciones auxiliares `namespacedToolName()` y `modelInList()`; esta última compara modelos en `noVisionModels` y `noReasoningModels` tolerando las etiquetas `:size`.


<a id="incomplete-quota-terminals"></a>

### Terminales de cuota incompletos

Una respuesta nativa reenviada que termina en `incomplete` con evidencia de cuota o límite de solicitudes registra el fallo de cuota de la cuenta y actualiza el estado usado por el fallback de subagentes. Se aceptan `incomplete_details.reason` y códigos de error estructurados aunque no haya un mensaje. Las respuestas incompletas por límite de salida, filtrado, control del turno o falta de progreso no ponen la cuenta en enfriamiento. La clasificación de políticas de ciberseguridad conserva su precedencia. Después de emitir salida no se repite el turno; las solicitudes fijadas a una cuenta conservan esa selección.

Las solicitudes compactas remotas pueden almacenar su respuesta en búfer durante más tiempo que el tiempo de espera inactivo de la solicitud del servidor. Ese tiempo de espera del oyente se deshabilita después de que se acepte el cuerpo de la solicitud; aún se aplican los plazos de cancelación del cliente y de operación ascendente.

La compactación enrutada con respuesta en búfer considera progreso los deltas no vacíos de texto y razonamiento, sin exponer un resumen parcial. Los comentarios, deltas vacíos y keepalives de la pasarela no reinician el detector de falta de progreso del adaptador. El plazo predeterminado sigue siendo de 300 segundos y el contenido cifrado de compactación se conserva intacto.

El almacenamiento en búfer de una respuesta de compactación nativa también limita el tiempo sin recibir bytes del cuerpo mediante `stallTimeoutSec`: 300 segundos para un proveedor público, desactivado para uno local y desactivado en todos los casos con `0`. Los fragmentos no vacíos reinician el plazo. Un cuerpo detenido produce HTTP 504; la cancelación del cliente conserva HTTP 499. La limpieza no espera indefinidamente una promesa de cancelación del proveedor. Se mantienen el máximo de respuesta de 32 MiB y los bytes originales del cuerpo.

Un error canónico de creación rechazada WebSocket aguas arriba puede convertirse en un HTTP 4xx solo antes de que se confirme la respuesta y después de las comprobaciones de correlación de flujo. Las cabeceras de cuota permitidas se acotan y reconstruyen sin cabeceras de entramado ascendentes; la respuesta JSON no se puede almacenar en caché. Los errores posteriores al compromiso y 5xx mantienen la ruta sin reenvío.

Si la recuperación de una tarea de agente cifrada rechaza una tarea enrutada, el error 400 existente puede incluir un `recovery_reason` de este conjunto: `unsupported_envelope`, `admission_denied`, `recovery_unavailable`, `caller_cancelled`, `input_changed`, `recovery_http_rejected`, `recovery_timeout`, `recovery_aborted`, `recovery_transport_error` o `recovery_invalid_output`. El rechazo HTTP requiere haber observado una respuesta sin éxito. Una salida inválida incluye UTF-8 incorrecto, cuerpos demasiado grandes, streams mal formados o incompletos y asignaciones inválidas o contradictorias. La cancelación del cliente tiene prioridad sobre el plazo propio de la operación; este tiene prioridad sobre los fallos de decodificación o transporte. `recovery_aborted` indica que se canceló una recuperación compartida por una causa independiente de ese cliente. Los clientes que esperan la misma operación reciben el mismo fallo, salvo que se cancelen individualmente. Solo se guarda en caché el texto plano recuperado correctamente. Los diagnósticos no contienen errores originales del proveedor ni texto de la carga útil. Si no hay un resultado clasificado, se omite el campo. Las ramas de combo que devuelven el error original del destino conservan esa respuesta. `recovery_unavailable` también incluye la falta de capacidad de caché o de operaciones compartidas; no demuestra que se haya intentado consultar al proveedor. Esto no habilita reintentos ni admite nuevos formatos de envoltorio.
