---
title: "Arquitectura"
description: "opencodex integra el mapa del módulo —, el puente AdapterEvent, el analizador de solicitudes y el almacenamiento en caché."
---

opencodex es un único proceso Bun. Una solicitud ingresa como OpenAI Responses, se normaliza a un modelo interno, se enruta, se envía a un proveedor a través de un adaptador y se vuelve a Responses SSE. Véase [Cómo funciona](/es/getting-started/how-it-works/) para el flujo de extremo a extremo.

<a id="module-map"></a>

## Mapa del módulo

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

Varios archivos de entrada anteriormente grandes ahora preservan la compatibilidad como fachadas: `codex/catalog.ts` exporta sus `codex/catalog/*.ts` módulos enfocados, `server/management-api.ts` despachos a `server/management/*.ts`, `server/responses.ts` exportaciones `server/responses/*.ts`, y `bridge.ts` reexportaciones `bridge/*.ts`. Una fachada es la ruta de importación estable, no la implementación: cada paso a continuación nombra el módulo que posee el código, y `structure/transports/responses.md` lleva el inventario completo del propietario para la superficie Responses.

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

- **Messages** - `input` elementos se convierten en un normalizado `OcxMessage[]`: usuario / desarrollador / asistente / toolResult. `reasoning` artículos se convierten en bloques de pensamiento; `function_call`, `custom_tool_call`, y `tool_search_call` artículos se convierten en llamadas de herramientas, sus `*_output` contrapartes se convierten en resultados de herramientas.
- **Herramientas** - herramientas de función pasan a través; **namespaced (MCP) las herramientas se aplanan** a `namespace__name` (y restaurado en el camino de regreso); **freeform** herramientas (p. ej. `apply_patch`) y **tool_search** herramientas de descubrimiento están marcadas; **Herramientas alojadas** ( `web_search`, image gen,...) se dejan caer y se reinyectan por un sidecar sólo si va a manejarlos.
- **Imágenes** - preservado como partes de contenido real (URL de datos o https remoto), nunca alineado como texto.
- **Banderas de características** - `_webSearch` (búsqueda web alojada solicitada), `_structuredOutput` (`text.format` es json_schema / json_object), y `_compactionRequest` (compactación remota v2).

<a id="the-bridge"></a>

## El puente

`bridge/sse.ts` convierte el flujo interno `AdapterEvent` del adaptador en Responses SSE que Codex entiende:

| AdaptadorEvent | Responses SSE emitido |
| --- | --- |
| `text_delta` | `response.output_text.delta` → `…done`, `response.content_part.done`, `response.output_item.done` |
| `thinking_delta` | `response.reasoning_summary_text.delta` → `…done`, artículo cerrar |
| `reasoning_raw_delta` | Un artículo crudo `reasoning_text` (o un sobre de ida y vuelta oculto) |
| `thinking_signature` / `redacted_thinking` | Conservado en un sobre de razonamiento `encrypted_content` |
| `tool_call_start` | `response.output_item.added` (tipo: `function_call` / `custom_tool_call` / `tool_search_call` ) |
| `tool_call_delta` | `response.function_call_arguments.delta` (omitido para forma libre / tool_search) |
| `tool_call_end` | `response.function_call_arguments.done` → `response.output_item.done` |
| `web_search_call_begin` / `web_search_call_end` | Un artículo vivo `web_search_call` más citas de URL |
| `heartbeat` | Marca la actividad ascendente; ningún elemento de salida visible por el usuario |
| `done` | `response.completed` (con uso) |
| `error` | `response.failed` (con `last_error`) |

El puente también envía un **latido para mantener la conexión activa** (RC3). Durante el silencio del proveedor, emite el comentario SSE `: opencodex heartbeat` cada 2 segundos para reiniciar el temporizador de inactividad de Codex. Los analizadores de eventos descartan estos comentarios sin generar eventos, por lo que los decodificadores estrictos de Responses no reciben variantes desconocidas. El **tiempo de espera por inactividad** predeterminado es de 300 segundos para un proveedor público y está desactivado para uno local (`stallTimeoutSec`; `0` lo desactiva en todos los casos). Al agotarse, se cancela el flujo del proveedor y se emite `response.incomplete` con la razón `upstream_stall_timeout`, para que una conexión bloqueada no detenga Codex indefinidamente.

Las llamadas a herramientas se desambiguan en tres tipos de elementos Responses usando el mapa de espacios de nombres, el conjunto de formularios libres y el conjunto de búsqueda de herramientas capturados por el analizador, de modo que MCP espacios de nombres, `apply_patch` herramientas de formularios libres de estilo y `tool_search` ejecutados por el cliente son de ida y vuelta. Una variante `buildResponseJSON()` produce un único objeto de respuesta que no es de flujo continuo a partir de los mismos eventos.

<a id="management-api-oauth-and-usage"></a>

## Administración API, OAuth y uso

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

OAuth implementaciones en vivo en `oauth/`; tokens de acceso se cargan o actualizan inmediatamente antes de una llamada enrutada, mientras que `oauth/token-guardian.ts` puede actualizar proactivamente sólo los proveedores cuya política lo permite. Refresh se coordina con un solo vuelo en proceso, un bloqueo de archivos por cuenta y CAS de generación para que los escritores concurrentes no puedan bloquear una credencial más nueva. Una proyección de salud compartida (`oauth/health.ts`) alimenta `ocx status`, `ocx doctor`, la administración API y el tablero de instrumentos. Codex / ChatGPT credenciales de grupo y afinidad proceso-local hilo vivo por debajo de `codex/` y se mantienen fuera de las respuestas de gestión; afinidad borra en `401` / `403` / `429` (no fijado a través de límites de velocidad) y no persiste a través de reinicios. El uso de solicitudes se normaliza a `OcxUsage`, aparece en Responses eventos de terminal y se agrega por `usage/` para el panel de control y los diagnósticos JSONL opcionales.

<a id="transport-and-compaction"></a>

## Transporte y compactación

`server/index/serve-options.ts` sirve HTTP / SSE en `/v1/responses` por defecto. Si Codex intenta una actualización Responses WebSocket mientras que `websockets` es `false`, opencodex devuelve `426 upgrade_required`; Codex luego vuelve a HTTP para esa sesión. Cuando se establece `"websockets": true`, el mismo punto final acepta la actualización y utiliza el puente WebSocket.

Independientemente de esa configuración orientada al cliente, las solicitudes canónicas de reenvío ChatGPT con nivel raíz `stream: true` pueden usar el transporte aguas arriba Codex de WebSocket en el estable Bun 1.4.0 o más reciente. La ruta canónica ChatGPT conserva la intent HTTP Responses Lite en los metadatos de la trama WS y deriva su sugerencia de enrutamiento del modelo saliente real y el nivel de servicio. Los metadatos iniciales de la cuota/modelo ascendente se convierten en cabeceras de respuesta HTTP limitadas; las actualizaciones de cuotas posteriores se atribuyen a la cuenta de servicio, no se agregan retroactivamente a las cabeceras ya enviadas. Un fallo después de que se envió una solicitud WS no desencadena un reenvío automático HTTP. Estas asignaciones no habilitan la configuración WebSocket orientada al cliente ni cambian la selección de transporte de otros proveedores. El paquete Bun 1.3.14, prelanzamientos e identidades de entorno de ejecución no verificables usa HTTP / SSE. Las respuestas WS ascendentes exitosas mantienen el contrato SSE descendente y la derivación `tee()` a través de un relé de un solo lector ansioso limitado (4 MiB por trama sin procesar / envolvente y una cola de productores de 8 MiB). El desbordamiento de cola cierra el flujo ascendente y emite un evento terminal de flujo descendente `response.failed` seguido por `[DONE]`.

Para el modelo saliente final `gpt-5.3-codex-spark`, el reenvío canónico ChatGPT desactiva explícitamente Responses Lite tanto en la cabecera HTTP como en los metadatos de trama WS nativos, incluso cuando un alias selecciona Spark, pero solo cuando el cuerpo saliente no lleva ningún elemento `additional_tools` con una matriz `tools` no vacía. Ese grupo ES la forma de entrega de herramientas Lite, por lo que un cuerpo de Spark que todavía lo usa mantiene Lite ON incluso si un llamante o un encabezado configurado dijeron lo contrario; de lo contrario, el marco anunciaría que no es Lite mientras que las herramientas existen solo en la forma Lite. Una identidad Lite cambiada retira el socket anterior; las solicitudes elegibles posteriores con la misma identidad pueden reutilizar el socket nuevo. Otros modelos y puertas de enlace mantienen su política Lite existente. Los metadatos nativos mal formados todavía caen de nuevo a HTTP con su cuerpo sin cambios.

Cuando un proveedor rechaza una solicitud de flujo continuo con HTTP 413 antes de que comience SSE, OpenCodex emite un evento de terminal `response.failed` con `context_length_exceeded` en lugar de retransmitir el estado desconocido reintentable. Esto permite que Codex detenga su bucle de reconexión y aplique su propia política de compresión de contexto en el siguiente turno. OpenCodex no elimina silenciosamente mensajes o imágenes; reduzca la entrada actual o reintente después de la compactación. Las personas que no llaman API continúan recibiendo el HTTP 413 del proveedor.

La compactación de contexto Codex funciona para modelos enrutados. `server/responses/compact.ts` maneja `POST /v1/responses/compact` ejecutando un giro de resumen enrutado interno y devolviendo el historial compactado, mientras que `responses/parser.ts` y `bridge/sse.ts` manejan la compactación remota v2 `compaction_trigger` gira emitiendo exactamente un elemento de salida `compaction` sintético.

<a id="caching--the-catalog"></a>

## El almacenamiento en caché y el catálogo

- `codex/model-cache.ts` mantiene una caché TTL por proveedor, en memoria, de resultados en vivo de `/models` (por defecto 5 min, que coincide con la propia caché de Codex), con una recuperación obsoleta cuando falla una extracción.
- `codex/catalog/sync.ts`, exportado a través de la fachada `codex/catalog.ts`, fusiona modelos enrutados en el catálogo de Codex como entradas con nombre, clasifica primero [Modelos de subagentes](/es/guides/codex-integration/#the-subagent-picker), filtra `disabledModels` y puede restaurar completamente el catálogo prístino desde una copia de seguridad única.

<a id="reasoning-effort"></a>

## Esfuerzo de razonamiento

`reasoning-effort.ts` traduce las etiquetas de razonamiento de Codex en los valores de cable de cada proveedor. El catálogo Codex anuncia etiquetas Codex acepta (`low` / `medium` / `high` / `xhigh` / `max`), pero los proveedores anteriores pueden admitir solo un subconjunto más pequeño o requerir un alias real. El módulo:

- Define el canónico `CODEX_REASONING_LEVELS` y su orden de clasificación.
- Sujeta un esfuerzo solicitado al nivel soportado más cercano cuando el nivel exacto no está disponible.
- Resuelve anulaciones por modelo y por proveedor `reasoningEffortMap` para asignaciones de cables personalizadas.
- Deja de lado el esfuerzo por completo para los modelos enumerados en `noReasoningModels`.

Qwen3.8-Max es una excepción explícita de esfuerzo directo al antiguo contrato de presupuesto Qwen3.x. Alibaba Token Plan registra su escalera compatible con upstream como `low`, `medium` y `xhigh` (el valor predeterminado), y envía el valor efectivo como `reasoning_effort`; Codex -sólo las tapas de compatibilidad están sujetas a `xhigh` en el cable. El enriquecimiento del registro en entorno de ejecución repara metadatos preestablecidos persistentes anteriores que todavía clasifican este modelo como un modelo `thinking_budget`.

<a id="core-types"></a>

## Tipos de núcleo

El modelo interno vive en `types.ts`: `OcxParsedRequest`, `OcxContext`, la unión `OcxMessage`, `OcxContentPart` (texto / imagen), `OcxToolCall`, `OcxTool`, `AdapterEvent`, y los tipos de configuración (`OcxConfig`, `OcxProviderConfig`). Dos ayudantes son ampliamente utilizados: `namespacedToolName()` y `modelInList()` (tolerante `:size` -etiqueta que coincide con `noVisionModels` / `noReasoningModels`).


<a id="incomplete-quota-terminals"></a>

### Terminales de cuota incompletos

Una respuesta directa nativa que termina con evidencia de cuota o límite de tasa en una terminal `incomplete` registra el fallo de la cuota de la cuenta y la salud de la reaparición. Estructurado `incomplete_details.reason` y códigos de error son aceptados sin un mensaje; ordinarios de límite de salida, filtrado, dirección y pérdida incompleta no enfrían una cuenta. La clasificación de la política cibernética mantiene su precedencia. El terminal no se reproduce después de la salida, y la selección de solicitud de cuenta fija permanece fija.

Las solicitudes compactas remotas pueden almacenar su respuesta en búfer durante más tiempo que el tiempo de espera inactivo de la solicitud del servidor. Ese tiempo de espera del oyente se deshabilita después de que se acepte el cuerpo de la solicitud; aún se aplican los plazos de cancelación del cliente y de operación ascendente.

La compactación enrutada amortiguada trata el texto no vacío y los deltas de razonamiento como progreso sin exponer texto de resumen parcial. Los comentarios, deltas vacíos y keepalives de la puerta de enlace no restablecen el regulador de pérdida de eventos del adaptador. El tiempo de espera por defecto permanece 300 segundos; el contenido de compactación encriptado se conserva sin cambios.

El almacenamiento en búfer de respuesta compacta nativa también impone una fecha límite de inactividad de byte de cuerpo usando `stallTimeoutSec` (300 segundos para un flujo ascendente público, deshabilitado para uno local y deshabilitado en todas partes cuando se establece en `0`). Los fragmentos no vacíos restablecen esa fecha límite; un cuerpo estancado devuelve HTTP 504, la cancelación del cliente retiene HTTP 499 y la limpieza no espera una promesa de cancelación ascendente atascada. Se conservan el techo de respuesta de 32 MiB y los bytes originales del cuerpo.

Un error canónico de creación rechazada WebSocket aguas arriba puede convertirse en un HTTP 4xx solo antes de que se confirme la respuesta y después de las comprobaciones de correlación de flujo. Las cabeceras de cuota permitidas se acotan y reconstruyen sin cabeceras de entramado ascendentes; la respuesta JSON no se puede almacenar en caché. Los errores posteriores al compromiso y 5xx mantienen la ruta sin reenvío.

Cuando la recuperación de la tarea de agente encriptada rechaza una tarea enrutada, su error 400 existente puede incluir un `recovery_reason` limitado: `unsupported_envelope`, `admission_denied`, `recovery_unavailable`, `caller_cancelled`, `input_changed`, `recovery_http_rejected`, `recovery_timeout`, `recovery_aborted`, `recovery_transport_error` o `recovery_invalid_output`. El rechazo HTTP requiere una respuesta observada sin éxito. La salida no válida incluye UTF-8 no válido, cuerpos de gran tamaño, flujos de recuperación mal formados o incompletos y asignaciones inválidas o conflictivas. La cancelación de una persona que llama tiene prioridad sobre una fecha límite propia, que tiene prioridad sobre los fallos de decodificación/transporte. `recovery_aborted` describe una recuperación compartida cancelada independientemente de esa persona que llama. Los camareros de vuelos compartidos reciben el mismo error subyacente a menos que se cancele individualmente; solo se almacena en caché el texto sin formato correcto. Los diagnósticos no contienen ningún error de flujo ascendente o texto de carga útil. El campo se omite cuando no existe un resultado de recuperación clasificado, y las ramas de combo existentes que devuelven el error de destino original mantienen esa respuesta. `recovery_unavailable` incluye capacidad de caché/solamente vuelo y no prueba que se intentó una solicitud ascendente. No se permite reintento o aceptación de envolvente más amplia.
