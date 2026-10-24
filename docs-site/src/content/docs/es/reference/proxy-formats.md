---
title: "Formatos de API del proxy"
description: "Referencia a nivel de cable para las superficies Responses, Chat Completions, Anthropic Messages, catálogo de modelos, WebSocket, tiempo real y compactación."
---

opencodex presenta un proxy local en varios dialectos de cliente. Un cliente Codex puede hablar el Responses API, una aplicación compatible con OpenAI puede hablar Chat Completions, y Claude Code puede hablar Anthropic Messages sin requerir que cada proveedor de origen implemente todos los formatos.

La ruta de traducción normal es:

```text
client dialect → internal Responses model → provider adapter → provider wire format
provider events → internal adapter events → client dialect
```

La representación Responses es el centro del puente. Las rutas nativas compatibles pueden omitir partes de la traducción y pasar una solicitud, pero la autenticación, el enrutamiento, el control de admisión y la seguridad de la respuesta aún ocurren en el límite del proxy. Configure el oyente y las claves de admisión en [Configuración](/es/reference/configuration/); use [Combos](/es/guides/combos/) cuando un identificador de modelo público seleccione entre varios objetivos.

<a id="mimo-bare-tool-call-recovery"></a>

## Recuperar llamadas sin estructura de MiMo

En las rutas de chat OpenAI traducidas, los identificadores de modelo `mimo-v2` y `mimo-v2.*` punteados pueden recuperar un bloque completo de `<tool_call>` como una llamada a una herramienta de forma libre declarada exacta cuando la respuesta no contiene llamadas de herramienta estructurada. Se conserva la prosa alrededor del bloque; los ejemplos de código cercado e inline, encabezados anidados, herramientas no declaradas y envolturas identificadas siguen siendo literales. La recuperación está limitada a 128 llamadas, 4 MiB en total y 2 MiB por candidato. La prosa larga puede liberar el marcado original antes de la recuperación de la terminal; los errores nunca envían llamadas recuperadas.

<a id="upstream-redirects"></a>

## Redirecciones ascendentes

Las solicitudes de modelo, imagen, video y búsqueda que contienen credenciales no siguen automáticamente las redirecciones de HTTP, incluidas las redirecciones del mismo origen. Configure la URL final de API en lugar de un alias de redirección. Una redirección no hace que el servidor vuelva a enviar las credenciales o el cuerpo de la solicitud a su destino. El propietario de la respuesta conserva su error existente o comportamiento de retransmisión; las rutas nativas Responses y compactas pueden devolver los 3xx y `Location` originales al cliente. El comportamiento de la redirección del cliente es independiente de esta política de transporte del servidor.

<a id="console-upload-rejections"></a>

## Rechazos de carga de consola

Una consola exacta o una consola Go `Invalid upload request.` HTTP 400 desde un punto final canónico de generación OpenCode Zen/Go recibe un reintento después de 800 ms. El proxy reutiliza la misma solicitud serializada y registra la recuperación en Logs. Otros 400 errores, destinos personalizados, cancelaciones y rechazos repetidos de carga siguen siendo fallas. Esto no reintenta respuestas de modelo filtradas o flujos interrumpidos.

<a id="codex-native-ordinary-lite-hosted-search-history"></a>

## Historial de búsquedas alojadas de Codex-nativo Lite ordinario

Cuando la solicitud de salida final no declara ninguna herramienta de búsqueda alojada (no hay ninguna entrada `web_search` o `web_search_preview` en `tools` o en un contenedor Lite `additional_tools`, incluso después de que se eliminaron las herramientas alojadas no admitidas del proveedor), cada destino Responses recibe el historial `web_search_call` repetido sin referencia como las mismas notas de referencia de asistente etiquetadas que se describen a continuación, con o sin la aceptación. Native Sol respondió a dicho historial con un genérico `server_error` (#7250), por lo que una conversación que se buscó en otro modelo puede continuar en una ruta cuya solicitud actual no tiene herramienta de búsqueda. Una herramienta de función llamada `web_search` no es una declaración alojada. No se agrega ninguna herramienta de búsqueda, no se vuelve a ejecutar la búsqueda y no se inventa ningún resultado; las celdas `item_reference` de la misma entrada permanecen estructurales. Una solicitud que declare la búsqueda alojada mantiene el historial estructural a menos que se aplique la opción de aceptación a continuación.

Las solicitudes ordinarias que declaran la búsqueda alojada conservan el historial de búsqueda alojada estructural de forma predeterminada, incluidas las solicitudes Responses Lite. Para optar por las notas de referencia con pérdida, establezca `providers.openai.projectResponsesLiteHostedSearchHistory: true` en `config.json` (un booleano real, no la cadena `"true"`). El ajuste por defecto por proveedor se desactiva; omisión o `false` mantiene el historial estructural. Incluso cuando está habilitado, la proyección se aplica a giros ordinarios y solicitudes nativas v2 `compaction_trigger` cuyo destino final es exactamente canónico ChatGPT Codex `/responses` y cuya intención de solicitud efectiva selecciona explícitamente Responses Lite. Convierte el historial restante `web_search_call` sin referencia en notas de referencia de asistente etiquetadas. El encabezado final `x-openai-internal-codex-responses-lite` selecciona Lite solo cuando su valor es exactamente `true`; un `false` explícito anula los metadatos de la trama. Sin un valor de cabecera reconocido, se utiliza un valor de `client_metadata.ws_request_header_x_openai_internal_codex_responses_lite` de mapa de cadenas válido de `true`, que coincide con el manejo de metadatos WS existente. La intención efectiva no-Lite o no reconocida retiene el historial estructural; los metadatos mal formados no anulan un HTTP `true` explícito. Los nombres de modelo, la autenticación de suscripción, las declaraciones alojadas que faltan y `additional_tools` solos no seleccionan esta directiva; no se reescribe ningún encabezado o metadatos para que se aplique. Una vez habilitado, se aplica a nuevos hilos/bifurcaciones, continuaciones de modelos cruzados y errores/reiniciaciones de caché, sin configuración de diagnóstico. Solo una nota puente válida del mismo alcance demuestra una llamada/resultado de función original que se puede restaurar primero; un prefijo de ID, nombre de modelo o nota faltante no puede determinar el emisor. Se conserva una celda alojada exactamente referenciada por una misma entrada `item_reference.id`. `store:false` elimina las referencias anteriores, y su historial alojado restante puede ser proyectado. Las declaraciones de herramientas/Lite `additional_tools`, las opciones, los pares de llamadas/resultados del cliente, el texto cifrado de razonamiento/nativo, el orden no alojado y el historial sin procesar de la persona que llama conservan sus contratos existentes.

Dentro de ese límite de Lite opcional, se trata de un **política de historia lossy** explícito, no una afirmación de que las llamadas alojadas son un esquema no válido o que todos los errores ascendentes son fijos. Las notas llevan metadatos de estado/acción no confiables y URL/título/tipo permitidos tanto de fuentes de acción como de nivel superior, nunca instrucciones o cuerpos de página recuperados: 2.048 unidades UTF-16 por cadena, 20 entradas por lista, 65.536 bytes seriados para todas las notas proyectadas, luego una nota de omisión. Los ID y los campos desconocidos se eliminan de las celdas convertidas. HTTP / SSE y WS comparten el constructor ordinario final.

Aparte de la regla de la ausencia de declaración anterior, OpenAI API público y otros destinos no ganan proyección ordinaria o nativa compacta. Native `/responses/compact` sigue siendo su ruta de salida opaca oficial/oficial/endpoint/account-scrub y conserva el historial estructural alojado. Los resúmenes portátiles/enrutados reutilizan su comportamiento de activación de proyección y referencia predeterminado existente; el renderizador compartido también conserva las fuentes de nivel superior listadas allí. No se introduce ningún nuevo reintento, clasificación de fuentes o resumen de compactación.

<a id="empty-search-answers"></a>

## Respuestas de búsqueda vacías

Después de la búsqueda alojada, un pase de respuesta forzada limpio pero vacío recibe un intento de respuesta adicional con herramientas eliminadas y resultados existentes retenidos. Esto puede dar lugar a otra solicitud de modelo. Una segunda respuesta vacía falla; las llamadas mal formadas y los resultados de rechazo o truncamiento del proveedor se conservan sin este reintento.

<a id="xai-policy-refusals"></a>

## Rechazos de política xAI

Algunos xAI Chat Completions denegaciones llegan como HTTP 403 con un modelo exacto de sentencia de denegación como `I can't help with that request.` en lugar de HTTP 200 más `finish_reason: content_filter`. Codex trata un 403 como un fallo de transporte, por lo que el turno del usuario nunca se registra y se vuelve a intentar la misma solicitud.

En un no-combo Responses solicitud, OpenCodex reescrituras que permiten incluir 403 en un
HTTP 200 Responses Carga útil con `status: "incomplete"` y
`incomplete_details.reason: "content_filter"`. La reescritura se ejecuta en el openai-chat ruta del adaptador y en el paso de respuestas abiertas (grok-4.6 / grok-4.5 OAuth). Streaming utiliza el mismo límite incompleto. Vacío o espacios en blanco 403 cuerpos permanecen Errores. Suscripción, crédito, derecho y `not allowed to use this
model` 403 errores de permanencia. La conmutación por error combinada sigue viendo el HTTP 403 original.

<a id="cursor-context-overflow"></a>

## Desbordamiento de contexto Cursor

El primer desbordamiento de contexto desnudo de Cursor se muestra al cliente. Las solicitudes elegibles posteriores con un hilo de cliente estable pueden recuperarse con hasta tres repeticiones de conversación por alcance retenido. La asignación en memoria expira después de una hora de inactividad, desalojo o reinicio. Las solicitudes sin un hilo estable, ayudantes aislados, reanudaciones de resultados de herramientas, salida parcial, compactación y errores de cuota no utilizan esta recuperación. Los desbordamientos elegibles continuos mantienen activa la asignación existente incluso después de agotarse; no la reponen. Esto no infiere si una tarea está progresando.

<a id="live-sideband-connection-failures"></a>

## Fallos de conexión de banda lateral en vivo

El proxy completa el protocolo de enlace de banda lateral en directo ascendente antes de aceptar el cliente WebSocket. Un rechazo ascendente falla la actualización con 502; un tiempo de espera de enlace de diez segundos devuelve 504, y la cancelación del cliente devuelve 499. Bun no expone el estado de enlace ascendente exacto, por lo que un 404/410 ascendente no puede reenviarse actualmente con precisión. Una conexión exitosa conserva los marcos de sesión iniciales en orden. Esta política de apretón de manos está separada del transporte Responses WebSocket.

<a id="undeclared-tool-calls"></a>

## Llamadas de herramientas no declaradas

En el punto final Responses, cuando una solicitud declara un catálogo de herramientas, una respuesta de paso a través nativa que llama a una herramienta ejecutada por el cliente fuera de ese catálogo falla el turno en lugar de retransmitir la llamada: un evento `response.failed` con el código de error `undeclared_tool_call`, luego `data: [DONE]`; JSON almacenado en memoria intermedia devuelve HTTP 502 con el mismo código. El rechazo se ejecuta antes de que la respuesta pueda entrar en estado de continuación, y se desactiva solo para `authMode: "forward"` proveedores o una solicitud sin catálogo declarado.

Los puntos finales Chat Completions y Messages honran catálogos de herramientas diferidos: esos clientes pueden declarar un catálogo parcial y descubrir el resto en entorno de ejecución a través de su propio registro de herramientas, que, no la instantánea del catálogo traducida, posee el límite de declaración completo. Una llamada fuera de la lista declarada se retransmite para que el cliente valide; una llamada inventada contra un `tools: []` explícitamente vacío todavía se rechaza, porque no existe ningún registro diferido bajo una declaración vacía. Esto se aplica a las rutas nativas administradas y las respuestas traducidas, incluidas las llamadas de herramientas de cliente en las respuestas finales de búsqueda alojada, imagen o video. Solo se aplica la declaración del turno actual; los catálogos omitidos, parciales y solo alojados mantienen su comportamiento existente. Las rutas de reenvío de llamadas conservan su exención y las operaciones internas alojadas no se ven afectadas. Esas denegaciones mantienen el código `undeclared_tool_call` en cada cable:

- **Chat Completions:** una trama `data:` que contiene un objeto OpenAI-estilo `error` que lleva el código, entonces el flujo se cierra sin una finalización satisfactoria o `[DONE]`; JSON almacenado en memoria intermedia devuelve HTTP 502 con el código.
- **Messages:** un Anthropic `event: error` marco cuyo cuerpo es
  `{ "type": "error", "error": { "type": "api_error", "code": "undeclared_tool_call", ... } }`, sin éxito `message_stop` o `[DONE]`; almacenado en memoria intermedia JSON devuelve HTTP 502 `api_error`
  con el código. Una violación del catálogo determinista nunca se informa como una violación reintentable.
  `overloaded_error` (HTTP 529).

Native Messages también reconoce definiciones de herramientas de mensajes de sistema en línea junto con `tools: []`. Esos nombres permanecen accesibles hasta que se eliminen permanentemente; una declaración en línea no autoriza herramientas de cliente no relacionadas. Alojado MCP llamadas y servidor-herramienta argumento arroyos conservan su forma nativa.

Por separado, en cada cable de entrada, un proveedor `default.`-namespace call está normalizado de nuevo al nombre de la herramienta desnuda que declaró la solicitud (`default.Read` → `Read`).

<a id="endpoint-overview"></a>

## Visión general de punto final

| Superficie del cliente | Punto final | Resultado exitoso no-stream | Resultado de transmisión o socket exitoso |
| --- | --- | --- | --- |
| OpenAI Responses | `POST /v1/responses` | Responses JSON | Responses SSE o Responses JSON marcos de texto sobre WebSocket |
| OpenAI Chat Completions | `POST /v1/chat/completions` | `chat.completion` JSON | `chat.completion.chunk` SSE terminado en `[DONE]` |
| Anthropic Messages | `POST /v1/messages` | Anthropic `message` JSON | Anthropic Messages SSE |
| Anthropic recuento de tokens | `POST /v1/messages/count_tokens` | `{ "input_tokens": number }` | No se requiere |
| Descubrimiento del modelo | `GET /v1/models` | Catálogo o instantánea de escritorio explícita | No se requiere |
| Transcripción de archivos | `POST /v1/audio/transcriptions` | `{ "text": string }` o texto sin formato | No se admite en este punto final de archivo |
| Dictado de streaming | `WS /v1/audio/transcriptions/stream` | No se requiere | Dictado de escritorio JSON eventos |
| Voz y tiempo real | `POST /v1/live`, `POST /v1/realtime/calls` | Respuesta retransmitida de creación de llamadas | Una banda lateral separada WebSocket retransmite tramas en ambas direcciones |
| Responses compactación | `POST /v1/responses/compact` | Historial de reemplazo JSON | No se requiere |

<a id="file-transcription"></a>

## Transcripción de archivos

Conexiones > Las claves API tienen **Dictado** y **Voz en vivo** bloques. Introduzca una clave de datos OpenCodex, no una clave de proveedor o administración. Cargas de dictado el archivo que seleccione y ofrece cancelación y copia de la transcripción. Voz en vivo
**Comprobar la conexión** abre una sesión sin acceso al micrófono ni a los marcos de audio, espera el reconocimiento de la sesión del proveedor y se desconecta después de un minuto o cuando salga del panel. La clave solo queda en la memoria de ese panel.
**Configurado, no verificado** describe la configuración del proveedor, no la cuenta salud o derecho. Utilice la acción explícita para observar un resultado. Los ejemplos usan nunca incluya el secreto ingresado. Un servidor más antiguo sin metadatos de audio deja estos controles no disponibles.

`POST /v1/audio/transcriptions` acepta una clave de plano de datos OpenCodex en `Authorization: Bearer`, `x-opencodex-api-key` o `x-api-key`, incluso en un oyente local. Se rechaza una clave no válida suministrada explícitamente. Suba un archivo de audio como multiparte `file` y proporcione `model=gpt-4o-transcribe` para una cuenta ChatGPT conectada. OpenCodex resuelve la credencial ascendente; nunca proporcione un token ChatGPT como la clave API del cliente.

```bash
curl "$OPENCODEX_BASE_URL/audio/transcriptions" \
  -H "Authorization: Bearer $OPENCODEX_API_KEY" \
  -F 'model=gpt-4o-transcribe' \
  -F 'file=@recording.wav' \
  -F 'language=ko'
```

Configure `OPENCODEX_BASE_URL` en su URL de proxy que termina en `/v1`. Los campos opcionales son `prompt`, `language`, y `response_format` ( `json`, el valor predeterminado, o `text` ). El resultado JSON contiene `text` solamente. Los archivos no deben estar vacíos y no deben tener más de 25.000.000 bytes; los cuerpos de varias partes están limitados a 32 MiB y los campos de texto a 16 KiB. El límite del cuerpo del oyente configurado puede imponer un techo más pequeño. Los campos duplicados o sin soporte, incluyendo `stream`, son rechazados. Este punto final no promete marcas de tiempo, diarización, subtítulos o metadatos de uso de tokens.

La ruta de suscripción ChatGPT usa `gpt-4o-transcribe` como identificador de compatibilidad y no envía un nombre de modelo al punto final de transcripción privado. No es evidencia del modelo interno del backend. Un proveedor de claves OpenAI API habilitado también admite `gpt-4o-mini-transcribe` y `whisper-1`; cuando se selecciona un proveedor ChatGPT, un fallo de autenticación no cambia silenciosamente a ese proveedor pagado. El modo Direct utiliza la cuenta principal almacenada según las reglas de admisión de perfil existentes; El modo Pool utiliza la cuenta almacenada seleccionada. Las credenciales faltantes, caducadas o que se agotan devuelven un error. La cancelación detiene la solicitud de salida y el contenido de audio no está escrito para solicitar el historial.

<a id="streaming-dictation"></a>

## Dictado de streaming

`WS /v1/audio/transcriptions/stream` es una extensión OpenCodex para una cuenta ChatGPT conectada. Está separado del protocolo público de transcripción en tiempo real de OpenAI. Autenticar con los mismos encabezados de clave proxy que la transcripción de archivos. Los clientes del navegador en su lugar ofrecen estos dos WebSocket subprotocolos:

```text
opencodex-audio
opencodex-key.<canonical-base64url-of-UTF8-proxy-key>
```

Solo `opencodex-audio` es seleccionado en la respuesta. La codificación es la sintaxis de transporte, no el cifrado. Las cabeceras de credenciales explícitas HTTP tienen prioridad. ChatGPT tokens permanecen en el proxy; un API-clave-solo aguas arriba no puede servir este protocolo de dictado.

Después de conectar, envíe:

```json
{"type":"session.start","config":{"input_audio_format":"pcm16","sample_rate_hz":48000,"num_channels":1,"max_buffer_size_bytes":4194304,"max_utterance_duration_ms":30000,"session_ttl_ms":300000,"provider_mode":"streaming_sse","transcript_delivery_mode":"segment","vad":{"type":"server_vad","threshold":0.5,"prefix_padding_ms":300,"silence_duration_ms":500}}}
```

Utilice la frecuencia de muestreo real de audio PCM16 mono. Espere `session.started`, luego envíe `{"type":"audio.append","audio":"<base64 PCM bytes>"}`. Estos son JSON marcos de texto, no archivos WAV o binarios WebSocket marcos. La puerta de enlace acepta tasas de muestreo de 8,000 a 192,000 Hz; El soporte ascendente depende de la cuenta / servicio. Los marcos de cliente están limitados a 64 KiB y las sesiones a cinco minutos. Los campos Event/Config no soportados o mal formados cierran el flujo con el código 1008.

`transcript.segment` y `transcript.final` contienen `utterance_id`, `revision` y `text`. Reemplace el texto anterior por la misma expresión cuando su revisión aumente; no concatene las revisiones. Terminar con `{"type":"session.close"}` y esperar el texto final y `session.updated` con `session.status="closed"`.

## `POST /v1/responses`

Esta es la forma nativa del plano de datos opencodex. El cuerpo de la solicitud debe ser un objeto JSON con un `model` no vacío. `input` puede ser una cadena o una matriz de Responses artículos.

<a id="caller-conversation-header"></a>

### Cabecera de conversación de llamante

Para HTTP `POST /v1/responses`, `POST /v1/messages`, y `POST /v1/chat/completions`, un cliente puede enviar un estable
`x-session-id` para cada conversación. Cuando no `session_id`, `session-id`, o `thread-id`
está presente, opencodex promueve el marcador para `session_id`. Identidad Grok administrada en Responses también tiene prioridad. Incluso un encabezado explícito vacío suprime la promoción.

Use 1-128 letras ASCII, dígitos, `.`, `_`, `:` o `-`, comenzando con una letra o dígito. Se recortan los espacios en blanco circundantes; se ignoran los marcadores no válidos o faltantes. La admisión de Loopback preserva el marcador. La admisión autenticada deriva un identificador opaco del marcador y el principal de credenciales admitido, por lo que las credenciales diferentes no comparten un identificador recién promovido. La rotación cambia este identificador; las solicitudes autenticadas sin un principal de confianza se dejan sin cambios.

Utilice marcadores distintos para conversaciones distintas. Esto preserva la continuidad de la conversación para los consumidores intermedios, pero no garantiza un éxito de caché ascendente o ahorros medidos. WebSocket marcos, compactos, y count_tokens no utilizan esta promoción.

En el despacho canónico ChatGPT -respaldado Responses, un `session_id` explícito no vacío gana. De lo contrario, el primer alias no vacío entre `session-id`, luego `thread-id`, suministra `session_id` si su valor es seguro; un alias ganador no válido suprime la identidad más débil. Los valores de cabecera vacíos se eliminan antes de este paso en cada ruta (selección de cabecera de autenticación Responses y los puentes Claude Messages y Chat Completions), por lo que una cabecera vacía cuenta como ausente: una `session-id` vacía permite una victoria `thread-id` válida. La sesión derivada de metadatos Claude solo se aplica cuando no queda ninguna cabecera canónica no vacía o alias. Los alias mantienen sus nombres originales en el cable; sus valores de llamada sin procesar validados se reenvían como un `session_id` explícito, sin el alcance principal utilizado para el `x-session-id` promocionado. Esta conversión de salida no cambia la afinidad de entrada. Los destinos personalizados y API clave no cambian, y no se inventa ninguna identidad para las solicitudes sin un marcador de conversación.

Para clientes de terceros, mantenga un marcador de propiedad de la persona que llama por conversación, incluidas las solicitudes repetidas de `curl`. Un prefijo de sistema/herramientas compartido `prompt_cache_key` o idéntico es una cohorte de caché, no prueba de que dos solicitudes pertenezcan a una conversación. Las solicitudes sin un marcador de conversación no reciben una sesión estable inventada. OpenCodex tampoco se hace pasar por Codex sintetizando un `originator`; un originador suministrado por la persona que llama conserva sus reglas de reenvío normales. La continuidad del encabezado no establece un éxito de caché: compare los tokens de entrada en caché informados del flujo ascendente para sus propias solicitudes de prefijo repetido. Un recuento de escritura en caché omitido no es evidencia de no escritura.

<a id="accepted-request-fields"></a>

### Campos de solicitud aceptados

| Zona | Forma aceptada |
| --- | --- |
| Modelo y entrada | Requerido `model` no vacío; cadena opcional `input` o una matriz de elementos |
| Elementos del mensaje | `user`, `developer`, `system` y `assistant` mensajes; contenido de cadena o bloques de contenido mecanografiado apropiados para el rol |
| Bloques de contenido | Texto, imágenes de entrada, archivos de entrada, texto de salida, rechazos y bloques de resumen/texto de razonamiento donde su elemento principal los permita |
| Historial de herramientas | `function_call`, `function_call_output`, `custom_tool_call`, y `custom_tool_call_output` artículos |
| Herramientas | Herramientas de función más entradas de herramientas incorporadas o alojadas sueltas; `tool_choice` acepta `auto`, `none`, `required`, opciones de función / personalizadas con nombre, opciones alojadas o `allowed_tools` |
| Razonamiento | `reasoning.effort` y `reasoning.summary` (`auto`, `concise`, `detailed` o `none`) |
| Continuación y almacenamiento en caché | `previous_response_id`, `store`, y `prompt_cache_key` |
| Controles de generación | `max_output_tokens`, `temperature`, `top_p`, `stop`, `presence_penalty`, y `frequency_penalty` |
| Servicio y ejecución | `stream`, `service_tier`, `parallel_tool_calls`, `instructions`, `metadata`, y `user` |
| Campos extendidos Responses | `background`, `include`, `prompt`, `text` y `truncation` se aceptan para rutas compatibles |

Los tipos de elementos desconocidos se aceptan como elementos de tipo suelto para la compatibilidad directa. Los adaptadores traducidos manejan solo los tipos de artículos que reconocen y pueden rechazar una característica que su proveedor no puede representar. En la ruta canónica ChatGPT Codex hacia adelante, los mensajes de entrada de solo texto `system` se pliegan en el nivel superior `instructions`, y se elimina `truncation` porque ese destino rechaza ambas formas públicas Responses. Otros Responses destinos los preservan. El mismo límite canónico elimina los marcadores `prompt_cache_breakpoint` anidados solo para el cliente y elimina las entradas `item_reference` solo en las continuaciones `store: false`; el emparejamiento de llamada de herramienta/resultado no cambia. `metadata` se elimina en cada ruta de avance para la compatibilidad con el canónico ChatGPT backend, que lo rechaza. `max_output_tokens` se elimina solo en esa ruta canónica, que rechaza el campo por completo; cada otro destino directo recibe el límite de salida del llamante sin cambios, pero el límite limita el giro solo cuando el destino lo impone.

Los ID de archivo de imagen son referencias con alcance de proveedor, no bytes de imagen portátiles. Responses passthrough los conserva; los adaptadores de traducción reciben un marcador de texto `[image: file_id]` para partes de imagen solo de archivo en mensajes o salidas de función / herramienta personalizada. Utilice una URL de imagen o una URL de datos base64 cuando el modelo traducido necesite ver la imagen. Los artículos alojados `computer_call_output` requieren una ruta de paso Responses; las rutas traducidas devuelven HTTP 400 en lugar de dejar caer silenciosamente la captura de pantalla. Para una observación de captura de pantalla sin semántica de herramienta informática alojada, use un usuario `input_image`.

<a id="json-and-sse-output"></a>

### Salida JSON y SSE

Con `stream: true`, la respuesta es `text/event-stream`. El puente emite Responses eventos como `response.created`, elementos de salida y deltas de texto / herramienta, y exactamente un terminal `response.completed`, `response.failed` o `response.incomplete` evento. Una corriente normal termina con `data: [DONE]`.

Con `stream: false` o no `stream`, los mismos eventos del adaptador se recopilan en un objeto Responses JSON. Ambas formas conservan el modelo seleccionado, los elementos de salida, el estado del terminal y el uso. La ruta canónica ChatGPT Codex todavía usa `stream: true` en su solicitud de solo flujo ascendente porque ese destino es SSE solo; OpenCodex valida de manera limitada y pliega el flujo de terminales de nuevo a la forma JSON que el cliente solicitó. Esta coerción de transporte no altera un valor `store` explícito. El primer terminal debe ser válido; un terminal posterior no puede reemplazar uno no válido. Los índices de salida deben ser contiguos y estar cubiertos por un elemento completado o la salida del terminal, por lo que un delta de texto / herramienta dejado abierto por un terminal disperso falla cerrado en lugar de convertirse en JSON parcial. La ruta limita cada trama a 4 MiB, cada transcripción y fuente de reconstrucción a 32 MiB, la corriente a 100.000 tramas y la salida reconstruida a 10.000 elementos. El `stallTimeoutSec` configurado gobierna tanto el primer byte de cuerpo aguas arriba como los espacios silenciosos posteriores. Cuando ese reloj de parada está desactivado (`0`, incluido el valor predeterminado para un flujo ascendente local), no caduca inmediatamente; solo permanece el techo de giro almacenado de 15 minutos independiente. Un EOF, trama mal formada o sobredimensionada, error de lectura, bloqueo, cancelación o terminal faltante devuelve un error en lugar de JSON parcial con HTTP 200. Las llamadas de streaming no han cambiado.

Cuando un proveedor filtra o trunca una respuesta, una llamada de herramienta inconclusa permanece `incomplete` tanto en JSON como en SSE. La salida parcial se conserva, y el puente no emite un evento de finalización de argumento para esa llamada abierta. Las llamadas ya completadas mantienen su estado. Esto preserva el resultado del proveedor.

En el cable de transmisión de Responses, una parada explícita de filtro de contenido no reproducible de Anthropic (`refusal` / `content_filter`) o Kiro (`CONTENT_FILTERED` / `GUARDRAIL_INTERVENED`) termina con `response.failed`, `error.code: "invalid_prompt"` y `retryable: false`. Esto evita que los clientes que reintentan flujos incompletos vuelvan a enviar el contexto rechazado. Se conservan el uso y la salida parcial. Los sidecars de búsqueda e imagen web se detienen sin ejecutar llamadas de esa iteración rechazada o preguntar al modelo nuevamente, en cada cable entrante.

Responses JSON almacenado temporalmente retiene `status: "incomplete"`; Chat Completions retiene `finish_reason: "content_filter"`, y Messages retiene `stop_reason: "refusal"`. Un filtro de contenido sin un veredicto explícito no reintentable, límites de token, puestos y EOF mantienen su comportamiento incompleto existente.

Las razones explícitas incompletas usan el mismo vocabulario en las respuestas respaldadas por adaptadores y en la entrega nativa Responses JSON, SSE y WebSocket: los alias de límite de salida como `length` y `max_tokens` se convierten en `max_output_tokens`, y los alias de rechazo/filtro como `refusal` se convierten en `content_filter`. Otras razones permanecen sin cambios, junto con el mensaje, la capacidad de reintento y el uso del proveedor. Los codificadores Direct Chat y Messages aplican la misma asignación.

En la implementación pendiente de `dev` para #4112, un final aguas arriba HTTP 413 en esta superficie se clasifica como `invalid_request_error` / `context_length_exceeded`. Los llamantes que no son de flujo continuo retienen HTTP 413 con un JSON `error`; los llamantes de flujo continuo retienen el fallo del terminal SSE. Ambos usan un mensaje fijo en lugar de exponer el cuerpo de error ascendente. La compactación sintética enrutada propaga el fallo clasificado; esto no reduce la entrada ni vuelve a intentar la compactación. Los errores de transferencia compacta nativa y de límite de admisión local retienen sus contratos separados.

Para el paso a través de HTTP / SSE nativo, una cancelación de cliente sin un terminal ascendente observado se registra como `499` con `closeReason: "client_cancel"` y no penaliza el grupo de cuentas. Esto se aplica tanto a la inspección de salida como al relé ansioso, incluido el tráfico de reescritura Windows, incluso cuando la lectura aguas arriba se rechaza antes de que se ejecute el gancho de cancelación del cuerpo de respuesta. Un terminal capturado durante el drenaje de desconexión posterior limitado conserva su resultado real.

Si falla la reescritura de paso a través nativa, incluso cuando excede el presupuesto de la memoria intermedia de traducción, el relé informa del fallo sin esperar a que finalice la inspección ascendente. Cancela el trabajo ascendente y emite `response.failed` seguido de `data: [DONE]`; un desbordamiento de presupuesto utiliza el código de error `translation_buffer_limit`.

Responses SSE acepta terminaciones de líneas CR, LF y CRLF, incluidas las terminaciones mixtas y la división de CRLF en trozos de red. La validación de herramientas, la traducción de chat, la inspección de terminales y la proyección WebSocket utilizan los mismos límites de eventos. Una terminación solo CR no espera a que se cierre la conexión ascendente.

Los fotogramas Responses SSE orientados al cliente están limitados a 4 MiB por fotograma, medidos en bytes sin procesar antes del delimitador de bloques SSE. En HTTP, una trama aguas arriba no terminada que excede el límite falla cerrada con un evento sintético `response.failed` seguido por `data: [DONE]`. En el puente Responses WebSocket, la misma condición emite un 502 `websocket_protocol_error` y cancela el lector aguas arriba. Una trama de terminal completa Responses es autoritativa: bytes posteriores sobredimensionados o malformados después de que ese terminal se caiga en lugar de reemplazar el giro completo con un fallo de transporte.

:::note
Para passthrough nativo, un evento terminal Responses tiene autoridad. Un prematuro `data: [DONE]` es mantenido hasta ese evento. En la ruta nativa ordinaria, un HTTP 200 EOF limpio sin un terminal analizado Emite una `response.incomplete` con `incomplete_details.reason: "adapter_eof"`, seguido por un
`data: [DONE]`; terminal sintácticamente válido sin delimitador JSON se acepta exactamente una vez, mientras JSON mal formado o truncado permanece incompleto. Para los proveedores que optaron por el terminal de modelo reparación, sufijos tipo terminal sin marco y un prematuro `data: [DONE]` en el error EOF cerrado con
`missing_terminal_event` cuando no se puede promover un candidato del ciclo de vida completo; un candidato completo Se promueve para `response.completed`. Alta confianza `cyber_policy`
Las formas de terminal se normalizan `response.failed` con `error.code: "cyber_policy"` por semántica registro/contabilidad (estado 400), mientras que una respuesta HTTP transmitida ya iniciada sigue siendo 200. Esto El límite de petición comprometida no vuelve a intentarlo ni a reproducirse y no resuelve
[#2423](https://github.com/lidge-jun/opencodex/issues/2423) o
[#2486](https://github.com/lidge-jun/opencodex/issues/2486).
:::

Para la transmisión directa canónica ChatGPT, el sistema estable Bun 1.4.0 o posterior puede usar de forma transparente el transporte WebSocket aguas arriba de Codex. En el paquete Bun 1.3.14, las versiones preliminares y las identidades de entorno de ejecución no verificables usan HTTP / SSE. El adaptador WS aguas arriba mantiene el mismo contrato aguas abajo SSE, limita tanto el marco JSON sin procesar como su envolvente SSE a 4 MiB, y cierra el flujo arriba cuando su cola de bytes de 8 MiB se desbordaría. Ese desbordamiento emite un evento `response.failed` terminal aguas abajo seguido por `[DONE]`.

El WebSocket aguas arriba comprueba `NO_PROXY` / `no_proxy` primero. De lo contrario, utiliza el primer valor no vacío `HTTPS_PROXY`, `https_proxy`, `ALL_PROXY` o `all_proxy`; `HTTP_PROXY` por sí solo no proxy una conexión WSS. HTTP y HTTPS URL proxy se pasan a Bun. Si el valor seleccionado no es válido o utiliza un protocolo no compatible, opencodex omite el intento WebSocket y utiliza HTTP / SSE en lugar de marcar el flujo ascendente directamente.

Estas reglas pertenecen al transporte WebSocket ascendente, independientemente del proveedor seleccionado. adaptador. HTTP Las solicitudes fetch basadas en Responses, incluida la reserva SSE, utilizan el
[fetch de salida configurada](/es/reference/configuration/server/#server-fields). Un servidor proxy SOCKS5 — conjunto con `config.proxy` o heredado de un SOCKS5 `ALL_PROXY` — utiliza el túnel incorporado de OpenCodex cuando
`NO_PROXY`/`no_proxy` No exime al objetivo. Esquema específico
`HTTP_PROXY`/`HTTPS_PROXY` Los valores retienen el manejo nativo de HTTP(S) de Bun, mientras que un manejo que no es SOCKS
`ALL_PROXY` No es un nativo HTTP fetch ruta. `config.proxy` llena faltante
`HTTP_PROXY`/`HTTPS_PROXY` valores; el valor específico del esquema resultante también tiene prioridad sobre Un existente `ALL_PROXY` para WebSocket. Para un HTTPS de origen que requiere un proxy, establezca
`HTTPS_PROXY` o `config.proxy`; `HTTP_PROXY` solo deja tanto WSS y su HTTPS reserva sin un proxy de esquema coincidente.

Cada objeto de uso del terminal Responses incluye ambos objetos de detalle, incluso cuando el proveedor no informó esos detalles:

```json
{
  "input_tokens": 0,
  "output_tokens": 0,
  "total_tokens": 0,
  "input_tokens_details": { "cached_tokens": 0 },
  "output_tokens_details": { "reasoning_tokens": 0 }
}
```

Cuando esté disponible, `input_tokens_details` También puede incluir `cache_write_tokens`. El siempre presente Los objetos de detalle son una garantía de compatibilidad para clientes Responses estrictos; cero puede significar "no" No necesariamente "el proveedor no realizó tal trabajo".

Para Anthropic aguas arriba, un `usage.output_tokens_details.thinking_tokens` reportado se conserva como Responses `output_tokens_details.reasoning_tokens` y Chat `completion_tokens_details.reasoning_tokens`, para JSON y respuestas de transmisión. Ya está incluido en el total del token de salida, no se agrega nuevamente; los detalles faltantes o no válidos no se estiman a partir del texto de pensamiento visible. Véase [Contrato de uso de Anthropic](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost).

<a id="correlating-a-response-with-its-request-log"></a>

### Correlacionar una respuesta con su registro de solicitudes

Cada respuesta HTTP Responses admitida lleva un encabezado `x-opencodex-request-id` que contiene un id generado por proxy del formulario `ocx-<32 hex>`. Es la clave que vincula una respuesta a su fila en el registro de solicitudes y en los informes de uso.

El proxy siempre genera este valor y sobrescribe cualquier id suministrado por el llamante o devuelto por el flujo ascendente, por lo que es único para este proxy y seguro para confiar como una clave de correlación. El encabezado se nombra en `Access-Control-Expose-Headers`, que es lo que permite al navegador JavaScript leerlo de origen cruzado: un encabezado personalizado `x-` es invisible para `response.headers.get()` incluso cuando está en el cable.

Responses rechazado en la autenticación o la admisión de origen nunca llegan a este envoltorio y no llevan ninguna identificación.

Las respuestas registradas `POST /v1/chat/completions` también llevan `x-opencodex-request-id`, expuesto a través de CORS, para JSON, transmisión, errores de controlador y rechazos de pre-controlador registrados. Este es el id de la historia de la puerta de enlace, independiente del id de finalización del cuerpo de respuesta. Los valores de llamada y ascendente no pueden reemplazarlo. Los rechazos sin un propietario de registro de solicitudes, incluidos los rechazos de autenticación, origen, drenaje y giro activo, no llevan identificación. Los encabezados de transmisión identifican la fila del historial final antes de guardar el uso final.

Las respuestas `POST /v1/messages` registradas llevan el mismo identificador de historial de solicitudes de OCX en **ambos** `request-id` y `x-opencodex-request-id`. Esto se aplica a las respuestas nativas y traducidas, streaming y JSON, y los rechazos registrados. Claude Code puede usar sus metadatos `requestId` persistentes de `request-id` para unir transcripciones futuras a esa fila de historia de OCX.

En respuestas entregadas nativas y errores HTTP aguas arriba, un Anthropic opaco aguas arriba `request-id` que coincide con `req_[A-Za-z0-9_-]{1,128}` se conserva por separado como `x-opencodex-upstream-request-id`. Es una identificación de diagnóstico del proveedor, no una clave del libro mayor de OCX. Se omiten los identificadores de flujo ascendente faltantes o no conformes, y los identificadores de adaptador traducidos. Estas cabeceras de respuesta se pueden leer a través de CORS junto con las cabeceras expuestas existentes.

No se agrega ningún ID de OCX a los rechazos de autenticación, origen, drenaje o giro activo que no tienen propietario de registro de solicitudes, o al count_tokens. Los encabezados de transmisión identifican la fila del historial final del turno; no dan fe de que el uso final ya se haya guardado. Las transcripciones antiguas sin una clave compartida permanecen sin vincular; la marca de tiempo o la similitud de token no es una unión exacta.

<a id="websocket-upgrade-on-the-same-path"></a>

### Actualización WebSocket en la misma ruta

Cuando `websockets` está habilitado, un cliente puede actualizar `/v1/responses` en lugar de abrir un POST HTTP. La autenticación y la admisión de origen ocurren durante el apretón de manos WebSocket. No se repiten dentro de cada cuadro.

Esta actualización orientada al cliente es independiente de la selección transparente ascendente ChatGPT WebSocket descrita anteriormente; la configuración `websockets` controla solo el punto final orientado al cliente.

El cliente envía JSON marcos de texto:

```json
{
  "type": "response.create",
  "model": "provider/model",
  "input": "Hello",
  "tools": [],
  "generate": true
}
```

Todo excepto `type` se convierte en el cuerpo de solicitud Responses, y el proxy fuerza la transmisión para el giro. Un nuevo `response.create` reemplaza y cancela el giro anterior en ese zócalo. `response.processed` se acepta como un acuse de recibo sin opción. Se ignoran los tipos de fotogramas no analizables o no relacionados.

Los marcos de servidor son marcos de texto JSON. La salida de transmisión exitosa utiliza las mismas JSON cargas útiles que aparecerían en SSE `data:` líneas, sin la envolvente SSE o `[DONE]`. Un resultado interno que no es de flujo continuo se vuelve a enmarcar como `response.created`, cero o más tramas `response.output_item.done`, luego una trama terminal. Los errores usan este sobre:

```json
{
  "type": "error",
  "status": 502,
  "error": {
    "type": "upstream_error",
    "message": "..."
  },
  "headers": {}
}
```

Un marco de calentamiento con `generate: false` no llama a un flujo ascendente. Devuelve un `response.created` sintético seguido de `response.completed`, ambos con un id de respuesta vacío y sin salida.

:::note
Cuando WebSockets está desactivado, un intento de actualización recibe HTTP 426 con código
`upgrade_required`. Codex trata ese resultado de apretón de manos como una señal para volver a HTTP para el sesión. No es un giro modelo fallido.
:::

## `POST /v1/chat/completions`

Este punto final acepta OpenAI -compatible Chat Completions solicitudes con un requerido `model` y un no vacío `messages` matriz. Traduce los mensajes del sistema, usuario, asistente y herramienta en los elementos internos Responses; traduce las herramientas de función, la elección de herramientas, imágenes, esfuerzo de razonamiento y formatos de respuesta compatibles; ejecuta el canal de enrutamiento Responses normal; luego traduce el resultado de nuevo.

Las URL de imagen y las URL de datos base64 usan partes de contenido de Chat `image_url`. La traducción conserva los valores soportados `detail` (`auto`, `low`, `high`). En las rutas traducidas, OpenCodex también acepta matrices de resultados de herramientas portadoras de imágenes como una extensión de compatibilidad: Responses rutas retienen la salida estructurada, mientras que el adaptador `openai-chat` envía imágenes de herramientas en un mensaje de usuario siguiente porque el contenido de la herramienta de chat es de solo texto. Otros adaptadores posteriores tienen su propia ubicación específica del proveedor. Los resultados de texto sin formato siguen siendo cadenas. El passthrough nativo sigue su contrato ascendente; el soporte de imágenes aún depende del modelo seleccionado y la configuración del proveedor.

El razonamiento es parte de esa traducción. `reasoning_effort` (o `reasoning.effort`) se convierte en interno `reasoning.effort`. Debido a que el analizador sintáctico Responses oculta el pensamiento a menos que se establezca `reasoning.summary` y no sea `none`, Chat Completions solicita que se solicite un esfuerzo por defecto a `reasoning.summary: "auto"`, por lo que los flujos de pensamiento se devuelven como `delta.reasoning_content`. Los clientes todavía pueden ocultar rastros con `include_reasoning: false` o `reasoning.summary: "none"`. Un `reasoning.summary` explícito de `auto`, `concise`, `detailed`, o `none` gana sobre `include_reasoning`.

Cuando el modelo es Claude, la respuesta también incluye `reasoning_details` con el formato que usa OpenRouter: `{"type": "reasoning.text", "text", "signature", "format": "anthropic-claude-v1"}` para cada bloque de pensamiento firmado y `{"type": "reasoning.encrypted", "data", ...}` para cada bloque redactado, en `message` o como `delta.reasoning_details` (cada entrada llega completa en un solo fragmento). Devuelve el array sin cambios en el mensaje del asistente, junto a sus `tool_calls`, para que Claude conserve el razonamiento entre pasos de herramientas. La firma es opaca y coincide con la que reciben los clientes de `/v1/messages`. OpenCodex solo lo reproduce cuando el modelo se enruta directamente a la API de Anthropic (`api.anthropic.com`) como ruta única. En cualquier otro destino, o si una entrada está mal formada (tipo o formato desconocidos, o falta de firma), el turno usa el texto simple de `reasoning_content`. Una entrada cuyo texto o firma se haya modificado se reenvía tal como está y Anthropic la rechaza; devuelve el array exactamente como lo recibiste.

La salida estructurada es parte de esa traducción: `response_format` con `json_object` o `json_schema` se reenvía a los modelos `openai-chat` enrutados. En `POST /v1/responses` el campo de petición equivalente es `text.format`: rutas nativas Responses lo conservan en el cuerpo bruto Responses, y se traduce a `response_format` cuando el modelo se dirige a un proveedor `openai-chat`. Un modelo listado en el `noStructuredOutputModels` del proveedor omite `response_format` en ese cable de chat; los modelos hermanos mantienen la traducción. Los backends no clasificados reciben el campo y devuelven su propio error en lugar de que el proxy adivine su capacidad.

La salida de no transmisión tiene `object: "chat.completion"`. La salida de transmisión utiliza SSE objetos con `object: "chat.completion.chunk"`, deltas de elección, una opción de terminal con `finish_reason` y `data: [DONE]`. La información de llamada de herramientas y de uso se traducen de vuelta donde los eventos de origen los llevan.

Si una solicitud de Chat de flujo continuo recibe un resultado JSON Responses completo aguas arriba, el proxy sintetiza SSE desde la finalización convertida. Conserva el contenido de respuesta y razonamiento, las llamadas de herramienta de función (con un flujo separado `index` para cada llamada), el uso y el convertido `finish_reason`, incluidos `tool_calls` y `length`. Este respaldo entrega el resultado completado en trozos; no puede proporcionar entrega token por token antes de que llegue la respuesta JSON aguas arriba. No emite una solicitud de inferencia adicional. Una respuesta incompleta causada por el límite de token de salida o el filtrado de contenido retiene `length` o `content_filter`, incluso si incluye la salida de la herramienta. Otros límites incompletos devuelven un error ascendente en lugar de reclamar un final normal.

El texto de rechazo permanece separado del texto de respuesta: las terminaciones JSON usan `message.refusal` nullable, y los fragmentos de transmisión usan `delta.refusal`. Chat nativo JSON -a- SSE y SSE -a- JSON conversiones preservan ese campo; relé de transmisión nativa conserva deltas de rechazo del proveedor. En los flujos traducidos Responses, las partes de rechazo se almacenan en memoria intermedia hasta el evento terminal y se emiten una vez en su orden de salida/contenido original. Las instantáneas repetidas o dispersas compatibles no duplican ni borran el texto. Las instantáneas de rechazo contradictorias y el desbordamiento del búfer producen un error escrito sin un acabado exitoso o `[DONE]`. Esto preserva el rechazo ascendente; no introduce una decisión de política de proxy.

Debido a que la ruta de ejecución interna está basada en Responses, un adaptador de proveedor puede imponer un conjunto de características más estrecho. Por ejemplo, una característica de solicitud que no puede ser representada por el adaptador seleccionado se devuelve como un error en lugar de cambiar silenciosamente su significado.

<a id="post-v1messages-and-count_tokens"></a>

## `POST /v1/messages` y `count_tokens`

Estos puntos finales hablan el dialecto Anthropic Messages utilizado por Claude Code y clientes compatibles. La mayoría de las solicitudes se traducen a Responses, se enrutan normalmente, luego se traducen a Anthropic JSON o Anthropic SSE.

En las solicitudes Messages traducidas, la repetición razonada comparte el presupuesto de traducción de la solicitud. La admisión del sobre incluye la sobrecarga de la copia de codificación/decodificación, no solo la longitud de la firma original. Las solicitudes que excedan este presupuesto devuelven HTTP 413 con `translation_buffer_limit`; las firmas y los datos de razonamiento opacos nunca se truncan para hacer que una solicitud se ajuste. Native Anthropic passthrough conserva su contrato de tamaño de cuerpo separado.

Las fuentes de imagen Base64 y URL se traducen en mensajes de usuario y resultados de herramientas anidados. Las imágenes respaldadas por archivos (`source.type: "file"`) requieren un paso nativo de Anthropic; las rutas traducidas devuelven un error fijo de HTTP 400 que solicita la entrada de base64 o URL. OpenCodex no resuelve el almacenamiento de archivos de otro proveedor ni carga la imagen referenciada en nombre del llamante.

Cuando el historial de reproducción contiene un resultado de herramienta portadora de imagen sin su llamada adyacente, los adaptadores Anthropic y Command Code retienen la imagen en un portador de usuario etiquetado con procedencia en lugar de incrustar sus bytes en el texto de solicitud. No inventan una llamada de herramientas exitosa. Los resultados para llamadas pendientes válidas todavía preceden a estos operadores, preservando el contrato de emparejamiento ascendente.

Para los modelos externos Cursor, las capturas de pantalla data-URL en el lote activo de resultados de herramientas de seguimiento se adjuntan a la solicitud de continuación. El límite de conexión activa de 12 imágenes existente se aplica a todo el lote. Las etiquetas de origen delimitadas permanecen al lado de los archivos adjuntos, incluso si se poda la historia anterior. El manejo de Native Composer/ MCP, la recuperación de imágenes históricas y la política de omisión de URL remota no se modifican; esto no promete que todos los modelos puedan ver todas las fuentes de imágenes.

El pase nativo Anthropic solo es elegible cuando todos estos son verdaderos:

- passthrough nativo no ha sido deshabilitado en la configuración Claude Code;
- el modelo solicitado comienza con `claude` o `anthropic`;
- la solicitud lleva un portador nativo Anthropic o una credencial `x-api-key`;
- en un oyente que no es de bucle de retorno, la solicitud también incluye una admisión de proxy válida solo en `x-opencodex-api-key`; y
- ningún alias configurado o mapa de modelo reclama ese id de modelo para un destino encaminado.

Una solicitud elegible se reenvía en el dialecto Anthropic para que los encabezados beta nativos, las firmas de pensamiento y la identidad de suscripción permanezcan de extremo a extremo. De lo contrario, toma el Responses ida y vuelta.

El encabezado de admisión dedicado nunca se reenvía. También se eliminan los secretos de admisión proxy encontrados en `Authorization` o `x-api-key`; se conserva una credencial Anthropic genuina separada. Las cabeceras de credenciales unidas por coma ambiguas fallan en lugar de ser reenviadas.

`POST /v1/messages/count_tokens` sigue la misma resolución de modelo y decisión de paso. Una solicitud elegible nativa se reenvía al punto final de recuento de Anthropic. Otras solicitudes utilizan la estimación documentada local sobre el contenido, los mensajes y las herramientas del sistema y devuelven:

```json
{ "input_tokens": 123 }
```

Un ID de escritorio en forma de fecha no resuelto también puede ser un modelo nativo genuino que falta en el descubrimiento. Messages y count-tokens devuelven HTTP 503 con el error `desktop_model_mapping_unavailable` fijo cuando la evidencia disponible no puede resolver ese ID; esto no establece que el modelo no es válido. Los alias de hash heredados desconocidos todavía devuelven HTTP 400. Ninguno de los casos quita la fecha o vuelve a otra ruta. Los ID conocidos, las asignaciones registradas y las coincidencias exactas `modelMap` mantienen su comportamiento existente, incluidos los ID nativos reales reconocidos. Actualizar el descubrimiento del modelo o volver a aplicar el perfil del concentrador conectado antes de volver a intentarlo; reintentar solo no garantiza la resolución.

## `GET /v1/models`

Sin `format=desktop-config`, los contratos de catálogo ordinarios son:

| Contrato | Desencadenante | Forma de nivel superior | Comportamiento de ID de modelo |
| --- | --- | --- | --- |
| Anthropic lista de modelos | `anthropic-version` o `?flavor=anthropic`, sin `client_version` | `{ "data": [...] }` con entradas de información del modelo Anthropic | Claude Code recibe identificadores legibles; Desktop puede recibir su familia de alias específica de perfil |
| Catálogo Codex | `client_version` parámetro de consulta | `{ "models": [...] }` | Las entradas nativas y enrutadas llevan los más ricos campos de catálogo Codex, visibilidad, esfuerzo, WebSocket y metadatos de agentes múltiples. |
| Plain OpenAI lista | Ninguno de los gatillos | `{ "object": "list", "data": [...] }` | Los id nativos visibles están desnudos; los id enrutados son alias o `provider/model` |

<a id="desktop-configuration-snapshot"></a>

### Instantánea de configuración del escritorio

`GET /v1/models?ids=desktop&format=desktop-config` selecciona explícitamente la instantánea de escritorio, independientemente de la detección de agente de usuario. La respuesta es `{ "version": 1, "models": [...] }` con `Cache-Control: no-store`. El cliente conectado envía `Accept: application/json`, `anthropic-version: 2023-06-01` y su credencial de datos existente; no se involucra la carga de tokens o perfiles de administrador. Las entradas son los modelos de configuración de escritorio emitidos por el concentrador, no las filas de catálogo Codex.

La combinación de este formato con `ids=cli` o cualquier `client_version` devuelve HTTP 400. Sin el selector de formato, los contratos ordinarios anteriores permanecen sin cambios. Cuando Claude está deshabilitado, la instantánea es `{ "version": 1, "models": [] }`; Connected Desktop apply trata esto como no disponible y no escribe un perfil de reemplazo. Los antiguos hubs que devuelven un catálogo ordinario en lugar de la versión 1 no son compatibles; el cliente no recurre a los ID generados localmente.

La instantánea sigue siendo un contrato de lista de modelos de solo lectura; no es una rotación de claves ni una carga de perfil API. La migración, recuperación y desconexión de claves de escritorio conectadas funcionan a través del ciclo de vida del cliente existente. La rotación conserva las entradas y selecciones del modelo; CLI `rotation` distingue `committed` de `rolled_back`. Desconectar restaura la configuración propia o informa de una reserva estándar heredada conocida, preservando los campos de usuario y selecciones válidas posteriores. Los conflictos o la recuperación incompleta impiden una reclamación de finalización. Reinicie el escritorio para cargar los cambios de disco; la desconexión no revoca automáticamente la clave de concentrador. Véase [Claude Desktop ciclo de vida](/es/guides/claude-code/). La repetición de pensamiento y el trabajo de caché rápida permanecen separados en [#3719](https://github.com/lidge-jun/opencodex/issues/3719).

<a id="post-v1live-and-realtime-sideband"></a>

## `POST /v1/live` y banda lateral en tiempo real

<a id="external-api-keys"></a>

### Claves API externas

Los clientes externos usan una clave OpenCodex en cualquier encabezado de credencial de audio compatible, o el par de subprotocolos del navegador descrito anteriormente. Independiente `WS /v1/live?model=gpt-live-1-codex` utiliza el protocolo Frameless; un modelo omitido por defecto a ese identificador y `gpt-live-1` es su alias proxy. Esta no es una afirmación de que cada clave pública OpenAI Realtime SDK o API sea compatible con GPT-Live.

Para una nueva conexión independiente, envíe la inicialización compatible con la fuente a continuación después de que se abra el socket y espere a `session.started` con un `session.id` no vacío. Un evento de sesión actualizada con la misma forma también es aceptado por el cliente nativo.

```json
{"type":"session.update","session":{"instructions":"","audio":{"output":{"voice":"cove"}},"delegation":{"type":"client"}}}
```

Frameless utiliza `input_audio.append` y `output_audio.delta`, a diferencia del dictado `audio.append`. Una comprobación solo de conexión no necesita micrófono ni marcos de audio; envíe `{"type":"session.close"}` y cierre el zócalo después de la preparación. Los eventos de delegación son solicitudes de trabajo, no señales de preparación, y el cliente externo posee su ejecución y respuestas.

Para WebRTC, publique una oferta de SDP a `/v1/live` como multiparte `sdp` y opcional JSON `session`, JSON `{sdp, session?}` o `application/sdp` en bruto. La respuesta contiene la respuesta y un proxy relativo `Location` con un ID de llamada `rtc_ocx_` opaco. Unirse a esa ubicación utilizando la misma clave proxy. El proxy resuelve el proveedor de creación y la cuenta física incluso si cambia la selección Pool. Los alias desconocidos, caducados u otras claves fallan antes de una conexión ascendente. La rotación de claves del cliente conserva la propiedad por ID de clave; la sustitución de una credencial ascendente con clave requiere una nueva llamada. Las bandas laterales de llamada existentes no necesitan otra actualización de sesión.

Los enlaces de llamadas duran 30 minutos, están limitados a 1024 entradas por servidor y finalizan en el reinicio del servidor. Los tiempos de vida del socket están limitados de forma independiente; los medios viajan directamente sobre WebRTC y no están representados. El proxy nunca ejecuta solicitudes de delegación. La disponibilidad de la cuenta OpenAI se establece por la respuesta ascendente real, no por la presencia de un nombre de modelo en el panel de control.

<a id="native-codex-compatibility"></a>

### Compatibilidad nativa con Codex

Las personas que llaman en modo clave nativo API en el oyente local de confianza pueden usar la credencial exacta configurada para el nivel canónico OpenAI API. Otros valores de soporte presentados requieren una clave proxy registrada o un par de token/cuenta ChatGPT explícito, coincidente; un prefijo de clave arbitraria no es prueba de credenciales nativas. Las llamadas nativas locales de confianza sin credenciales conservan su comportamiento existente.

`POST /v1/live` acepta la superficie de creación de llamadas sin marco de la aplicación ChatGPT / Codex. `POST /v1/realtime/calls` acepta la superficie de creación de llamadas en tiempo real OpenAI. opencodex selecciona una ruta de familia OpenAI elegible, normaliza la solicitud de creación de llamada para el modo de autenticación ascendente y retransmite la respuesta limitada.

Después de la creación de la llamada, los clientes pueden unirse a una banda lateral WebSocket usando cualquier formulario entrante admitido:

- `/v1/live/{callId}`
- `/v1/realtime/calls/{callId}`
- `/v1/realtime?call_id={callId}`

El proxy normaliza la URL de unión ascendente y luego retransmite de forma transparente el texto y los marcos binarios en ambas direcciones. Las cabeceras de protocolo de cliente se conservan mientras que la autenticación ascendente sigue siendo propiedad de proxy.

La creación de la llamada y la conexión de banda lateral deben usar la misma cuenta de OpenAI; de lo contrario, el servidor de origen rechaza la conexión (`404`). Ambas operaciones llevan los encabezados `session-id` y `thread-id` de Codex. En Pool, la cuenta queda vinculada a ese par dentro del proceso: la conexión reutiliza la cuenta que creó la llamada. Direct reenvía la credencial bearer actual de quien realiza la solicitud en ambas operaciones. Los encabezados de cliente retransmitidos son exactamente `openai-alpha`, `x-session-id`, `session-id`, `thread-id`, `originator`, `x-oai-attestation`, `x-codex-turn-metadata` y `voice-session-id`, que identifica la sesión de voz del cliente y es distinto del `x-session-id` de tiempo real (`LIVE_CLIENT_PROTOCOL_HEADERS` en `src/server/live.ts`). Cada encabezado solo se retransmite si lo envió el cliente; no se inventa ninguno. El proxy controla `Authorization` y el ID de cuenta de ChatGPT en sus rutas: Pool usa la cuenta guardada y Direct la credencial validada del cliente; un proveedor con clave API usa su propia credencial bearer. Codex solo envía esta conexión al proxy cuando `experimental_realtime_ws_base_url` apunta a él. `ocx start` inyecta esa clave junto con `openai_base_url`; consulta [Integración con Codex](/es/guides/codex-integration/).

## `POST /v1/responses/compact`

La compactación devuelve el historial de reemplazo para los clientes que necesitan acortar una larga conversación Responses.

| Tipo de ruta | Comportamiento |
| --- | --- |
| Canonical ChatGPT o ruta oficial OpenAI | Prueba el punto final nativo `/responses/compact` con la autenticación de cuenta y modelo resuelta; HTTP 404 vuelve a caer a un giro de compactación regular Responses |
| Puerta de enlace `openai-responses` explícitamente incorporada | `supportsNativeCompactEndpoint: true` intenta el punto final v1 nativo para la clave/local/directa usando el transporte Responses normal del proveedor; HTTP 404 utiliza respaldo portátil; OAuth conserva la compactación enrutada y la resolución de credenciales |
| Otro modelo ruteado | Ejecuta un giro de compactación interno, sin transmisión, sin herramientas con un `compaction_trigger`; requiere exactamente un artículo sintético `compaction` cuyo `encrypted_content` es un sobre `ocx1:`; decodifica ese resumen en el historial de reemplazo v1 |

La capacidad de punto final v1 personalizada es independiente de la v2 `supportsNativeCompactionTrigger` y de la `decodesNativeCompactionBlobs` para la reproducción. Ninguno otorga la identidad canónica OpenAI o el reenvío de credenciales de llamada. Las anulaciones de proveedores cruzados siguen siendo portátiles; el éxito v2 solo no establece soporte para `/responses/compact`. Véase [configuración del proveedor](/es/reference/configuration/providers/).

Si el punto final compacto nativo devuelve HTTP 404, OpenCodex vuelve a intentar la compactación a través de un giro regular Responses con el mismo selector de modelo y encabezados de sesión. Canonical ChatGPT giros de reserva utilizan aguas arriba SSE; el llamante compacto todavía recibe JSON. Se conserva un elemento de compactación opaco nativo completo, mientras que un resumen `ocx1:` se decodifica en el historial de usuario de reemplazo. Los giros de reserva fallidos o incompletos devuelven un error en lugar del historial de reemplazo. Otros estados compactos nativos conservan su manejo existente.

Codex nombra un modelo de la familia OpenAI (por ejemplo `gpt-5.6-sol`) para sus vueltas de compactación, independientemente de a qué proveedor se dirija el operador. Las solicitudes ordinarias reservan dichos identificadores para el proveedor canónico `openai`. En la superficie de compactación solamente - `POST
/v1/responses/compact` y un giro `POST /v1/responses` que lleva un `compaction_trigger` - un modelo nativo desnudo sin un proveedor canónico `openai` habilitado vuelve al `defaultProvider` configurado como el resumen en lugar de devolver 404. La alternativa se aplica solo cuando el proveedor predeterminado está habilitado y no es en sí mismo una entrada de la familia OpenAI; los selectores calificados para la cuenta como `side/gpt-5.6-sol` aún fallan. El proxy registra un aviso por proveedor cuando se activa esta reserva. Las configuraciones con un proveedor canónico `openai` habilitado no cambian.

Los cuerpos entrantes tanto en `/v1/responses` como en `/v1/responses/compact` conservan el límite de admisión de 256 MiB de cable/descompresión compartido. El rechazo de tamaño a nivel de aplicación devuelve HTTP 413 con `type` y `code` ambos `invalid_request_error`. Su mensaje incluye un sufijo de diagnóstico limitado, por ejemplo:

```text
Decompressed request body exceeds 268435456 bytes [measurement=decoded_lower_bound; bytes=268435457]
```

| Medición | Significado de `bytes` |
| --- | --- |
| `declared_wire` | `Content-Length` numérico declarado por el remitente; rechazado antes de la lectura, no un tamaño decodificado medido |
| `observed_wire_lower_bound` | Bytes de alambre encontrados cuando se lee detenido; el cuerpo completo puede ser más grande |
| `decoded_exact` | Tamaño exacto de la memoria intermedia suministrada al descodificador de identidad o devuelta por un descodificador |
| `decoded_lower_bound` | Límite de admisión más uno después de abortar la inflación; un límite inferior, nunca el tamaño decodificado exacto |

El sufijo contiene solo una categoría fija y un valor de byte numérico finito. Los cuerpos rechazados no se leen ni se inflan más, se analizan para el recuento de artículos o se retienen para el diagnóstico. Los errores heredados sin procedencia de medición retienen el mensaje de solo límite. El oyente de Bun puede rechazar un cuerpo de alambre sobredimensionado antes de que se ejecute el diagnóstico de la aplicación, por lo que no cada 413 lleva este sufijo. Un diagnóstico de límite inferior no puede establecer el tamaño completo de la carga útil compacta. El límite de admisión y el comportamiento de reintento no cambian.

Las respuestas compactas nativas se almacenan en búfer con un máximo separado de 32 MiB, incluidas las respuestas cuyos `Content-Length` declarados ya exceden el límite. Los fallos específicos de los compactos incluyen:

| Situación | Tipo o código | Descripción |
| --- | --- | --- |
| 400 | `invalid_request_error` | Inválido JSON /forma del cuerpo o modelo faltante |
| 404 | `invalid_request_error` | El modelo solicitado no se puede enrutar |
| 499 | `client_cancelled` | El cliente canceló mientras reenviaba o almacenaba búfer |
| 502 | `compact_response_too_large` | La salida compacta nativa superó los 32 MiB |
| 502 | `upstream_error` | Fallo de conexión, lectura o compactación sintética |
| 502 | `invalid_response_error` | El giro sintético no produjo exactamente un artículo de compactación `ocx1:` válido y no vacío. |

<a id="authentication-matrix"></a>

## Matriz de autenticación

En un enlace de solo retorno de bucle, la admisión del plano de datos no requiere una clave configurada. En un aprieto remoto, utilizar la matriz de abajo. "Dedicado" significa `X-OpenCodex-API-Key`Las otras columnas significan
`Authorization: Bearer ...` y `x-api-key`.

| Superficie | Dedicado | Portador | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` HTTP y WebSocket | Aceptado | Aceptado | Rechazado |
| `/v1/responses/compact` | Aceptado | Aceptado | Rechazado |
| `/v1/chat/completions` | Aceptado | Aceptado | Rechazado |
| `/v1/messages` y `/v1/messages/count_tokens` | Aceptado | Aceptado | Aceptado |
| `/v1/models` | Aceptado | Aceptado | Aceptado |
| `/v1/live`, `/v1/realtime/calls`, y la banda lateral se une | Aceptado | Aceptado | Aceptado |

Responses -las solicitudes de familia y chat aceptan una clave proxy en el encabezado dedicado o el campo Portador. En rutas nativas, la credencial Codex almacenada seleccionada reemplaza al portador de admisión; en otras rutas se elimina. Nunca es una credencial ascendente. Utilice la cabecera dedicada cuando también suministre un portador de proveedor separado.

Una ruta sin llave, no OAuth Cursor puede usar ese portador de llamante separado, pero nunca un secreto proxy o enriquecimiento principal automático ChatGPT. La selección combinada/de políticas y las reescrituras reales de sombra/encadenamiento de hilos no transfieren credenciales de llamadas sin procesar a nuevos objetivos. El encaminamiento canónico OpenAI puede restaurar el portador no proxy único del llamante después de un cambio de ruta interno solo cuando su JWT lleva una reclamación de cuenta ChatGPT y cualquier cabecera de cuenta explícita coincide con esa reclamación. Reenviar la autenticación del llamante a los sidecars opcionales OpenAI requiere un único JWT y un `chatgpt-account-id` explícito coincidente. Los portadores opacos no se restauran a través de los cambios de ruta, incluso con un encabezado de cuenta explícito. De lo contrario, el destino final necesita su propia credencial configurada, OAuth o almacenada; de lo contrario, falla localmente. Un marcador de creación de hilo por sí solo no elimina las credenciales.

El enriquecimiento principal almacenado opcional del chat para una solicitud Cursor sin clave se aplaza hasta que se planifique realmente un ayudante OpenAI y esté disponible un candidato canónico Direct. Una solicitud de Cursor no relacionada no adquiere una reivindicación principal nativa a través de este enriquecimiento, por lo que no retrasa la conmutación de perfil. Las credenciales de ayuda siguen obedeciendo a las vallas de inicio y de conmutación y permanecen separadas del portador Cursor. Pool y los ayudantes calificados para la cuenta conservan su selección de cuenta existente.

La repetición Claude retiene la autenticación principal solo como una instantánea en memoria reclamada por turnos y la reconstruye solo para una ruta canónica final ChatGPT.

:::caution
Las claves del plano de datos no son credenciales de gestión. La administración API utiliza un secreto de administración separado; ver [API de administración](/es/reference/management-api/). Nunca reutilices un secreto para ambos aviones.
:::

<a id="common-error-vocabulary"></a>

## Vocabulario de error común

Los errores usan la envolvente del dialecto del cliente cuando es necesario, pero estos significados de estado/código son estables:

| Situación | Tipo o código | Descripción |
| --- | --- | --- |
| 401 | `authentication_error` | Una credencial de admisión proxy requerida no está disponible o no es válida |
| 403 | `origin_rejected` | Una solicitud de plano de datos Responses / OpenAI o una actualización WebSocket provienen de un origen no permitido |
| 503 | `combo_unavailable` | Todos los objetivos del combo seleccionado no están disponibles, en tiempo de reutilización, desactivados o no son elegibles |
| 400 | `unreadable_encrypted_agent_task` | Una tarea de trabajador encriptada v2 no tiene un objetivo canónico ChatGPT elegible o un objetivo de autenticación de clave directa Responses explícitamente confiable con `allowEncryptedV2AgentTasks: true` que puede consumirlo |
| 426 | `upgrade_required` | El Responses WebSocket transporte está desactivado o la actualización falló; use HTTP |

Anthropic -los fallos de origen se representan en la envolvente de error de Anthropic, por lo que el rechazo de origen es un 403 `permission_error` en ese dialecto en lugar del cuerpo OpenAI -estilo `origin_rejected`.

<a id="encrypted-content-hygiene"></a>

## Higiene de contenido cifrado

El proxy trata el texto cifrado de backend genuino como opaco. El texto cifrado estructuralmente válido se conserva byte por byte: opencodex no lo descifra, traduce su contenido o lo vuelve a cifrar para otro proveedor.

Algunos ganchos de agentes han colocado históricamente texto de control en una ranura `encrypted_content`. Por compatibilidad, el proxy separa ese texto plano en partes de texto mientras conserva cualquier Fernet estructuralmente válido que se ejecute sin cambios. Si un `agent_message` pierde todas las partes encriptadas durante esa reparación, se convierte en un mensaje de usuario normal. Si una tarea v2 actual permanece genuinamente encriptada pero el destino enrutado seleccionado no puede leer el texto cifrado nativo ChatGPT, opencodex falla con `unreadable_encrypted_agent_task` en lugar de enviar bytes ilegibles a ese proveedor. Consulte [Superficie del subagente](/es/guides/sub-agent-surface/) para conocer el comportamiento del cliente en torno a las tareas de los trabajadores.

La historia también se maneja, y de manera diferente, porque perder un mensaje repetido no debe terminar una conversación. Un `agent_message` reproducido que mezcla texto legible con texto cifrado de extremo posterior no se puede bajar a un mensaje público, por lo que un destino Responses encaminado recibiría de otro modo el texto cifrado junto con un tipo de elemento que solo declara el extremo posterior ChatGPT. Antes del envío, opencodex reemplaza ese texto cifrado con `[encrypted content omitted]`, el mismo marcador que ya sustituye después de un fallo de descifrado ascendente, lo que deja el elemento bajable y el texto legible intacto. El proveedor nunca ve el texto cifrado o el elemento privado, y la conversación continúa. Los objetivos combinados se reparan individualmente, ya que cada uno recibe su propia copia de la solicitud. El canónico ChatGPT Codex backend está exento porque es el destino que acuña y puede leer esos bytes; un proveedor `forward` señaló a cualquier otro origen no está exento. Las rutas `allowEncryptedV2AgentTasks` de confianza explícita y los cables Chat o Anthropic traducidos no se ven afectados, al igual que otros tipos de elementos, como los blobs de razonamiento y de salida de herramientas, que mantienen su recuperación de fallo de descifrado existente.

<a id="switching-providers-in-an-existing-conversation"></a>

### Cambiar de proveedor en una conversación existente

Un elemento de razonamiento repetido lleva `encrypted_content` que solo el proveedor y la credencial que lo produjo pueden leer. Cuando opencodex sabe que la conversación fue atendida por última vez por un proveedor diferente, elimina esa mancha antes de enviarla y guarda el resumen del artículo. Si ese proveedor también usó un punto final o una credencial diferente, el identificador `rs_…` del elemento también se elimina, porque nombra un elemento que el nuevo destino no puede buscar. Cuando no puede saber, por ejemplo después de un reinicio proxy, el nuevo destino rechaza el blob en su lugar: OpenAI y Azure OpenAI responden `400 invalid_encrypted_content`. opencodex luego reenvía la solicitud una vez sin el estado de razonamiento del proveedor anterior. El blob se va, y también lo hace el id `rs_…` del elemento de razonamiento, porque ese id nombra un elemento que el proveedor anterior almacenó y el nuevo destino respondería `Item with id 'rs_…' not found`.

Esta recuperación se aplica a todos los adaptadores que hablan el cable Responses, así `openai-responses` y
`azure-openai` Comportarse de la misma manera. Después de una recuperación exitosa, los giros posteriores de esa conversación en el mismo destino, deje caer el estado extranjero antes del primer envío para los próximos cinco minutos, sin otro viaje rechazado. El reenvío cuenta con el presupuesto de envío normal de la solicitud. Un ordinario 400 y un 429 nunca se vuelven a intentar de esta manera, y tampoco lo es un 5xx, con una estrecha. excepción: un 502 cuyo cuerpo es la herramienta encriptada exacta descifra el rechazo, enviado para una solicitud que lleva la salida de la herramienta cifrada, obtiene el mismo reenvío único. Un segundo rechazo llega a cliente sin cambios. Si eso sucede, inicie una nueva conversación en el proveedor de destino.

<a id="malformed-tool-call-history"></a>

### Historial de llamadas de herramientas mal formado

Las solicitudes enrutadas toleran los argumentos de función serializados mal formados como un objeto vacío. Dos reparaciones de historial acotado preservan argumentos utilizables: falta un prefijo de objeto JSON, y el rastro de MiMo `</function></tool_call>` sobre con una cita de cierre o soporte que falta. Una reparación debe decodificar a un objeto JSON. Se conservan los valores válidos de JSON que contienen esas etiquetas.
