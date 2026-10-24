---
title: "Configuración de agentes"
description: "Modos multiagente, guía de delegación, modelos preferidos, cadenas de respaldo, sincronización de valores nativos y límites de esfuerzo."
---

La configuración de agentes determina qué interfaz de colaboración de Codex se anuncia y cómo opencodex orienta, enruta y limita el trabajo delegado.

<a id="agent-fields"></a>

## Campos de agentes

<a id="skills-catalog-refresh"></a>

### Actualización del catálogo de habilidades

`skills.catalog_refresh` acepta `"per_session"` (predeterminado) o `"per_turn"` en el archivo `config.json` de opencodex. El modo por sesión reutiliza las primeras instrucciones de habilidades recibidas para la conversación, de modo que los cambios del catálogo entre turnos no alteren el prefijo de la caché del prompt. El modo por turno reenvía el catálogo actual del cliente. Consulta [Mantener estable el catálogo de habilidades](/es/guides/codex-prompt/#keeping-the-skills-catalog-stable) para conocer la configuración y la duración de las instantáneas.

<a id="astra-roster-upgrade"></a>

### Actualización de la lista de Astra

En el primer inicio después de actualizar, las listas existentes de `subagentModels` reciben `gpt-6-astra` en primer lugar. Se conservan las primeras cuatro opciones únicas distintas de Astra y se descarta la quinta opción anterior. Si se conserva `gpt-5.5`, pasa al final. Por tanto, la antigua lista predeterminada queda como Astra, Sol, Terra, Luna y 5.5. Una lista antigua sin configurar recibe los valores predeterminados actuales; una lista antigua explícitamente vacía pasa a ser `["gpt-6-astra"]`. Las entradas de Astra existentes no se duplican.

La lista predeterminada actual es `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`. En el primer inicio después de actualizar se eliminan las entradas retiradas de las listas guardadas: `gpt-5.6-sol` y `gpt-5.6-luna` pasan a ser `gpt-6-sol` y `gpt-6-luna` en su misma posición, y se elimina cualquier otro modelo `gpt-5.5` o `gpt-5.6`. Los identificadores con `/` (rutas `provider/model` u opciones que especifican una cuenta) se conservan tal como están escritos. Una lista que solo contenía modelos retirados recibe la lista predeterminada actual; una lista vacía permanece vacía.

GPT-6.1 Sol sustituyó a GPT-6 Sol como modelo predeterminado el 30 de septiembre de 2026. En el primer inicio tras esa actualización, un `gpt-6-sol` sin prefijo en una lista guardada pasa a ser `gpt-6.1-sol` en la misma posición, sin duplicarlo si 6.1 Sol ya figura en ella. GPT-6 Sol sigue disponible: puedes volver a añadirlo después y se conservará.

El marcador interno `subagentModelsVersion` (actualmente `3`) hace que cada migración se ejecute una sola vez. Después puedes reordenar la lista, quitar Astra o guardar una lista vacía sin que el inicio vuelva a cambiar tus opciones. Los modelos desactivados permanecen desactivados. La disponibilidad de Astra sigue dependiendo de la compatibilidad del proveedor con tu cuenta.

| Campo | Tipo | Predeterminado | Significado |
| --- | --- | --- | --- |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | `v1` marca todos los modelos del catálogo como v1; `v2` los marca como v2. `default` restaura las asignaciones del proveedor (Sol/Terra v2, Luna v1) y, en los demás casos, sigue la opción nativa `multi_agent_v2`. Se aplica a las sesiones nuevas. |
| `keepNativeChatGptOnV1?` | `boolean` | `false` | Cuando `multiAgentMode` es `"v2"`, desactiva la anulación global de V2, marca las entradas nativas de ChatGPT como v1 y conserva las enrutadas en v2. Codex resuelve la anulación global antes que las asignaciones del catálogo: ambas partes son necesarias para que un agente principal de ChatGPT cree subagentes enrutados sin tareas cifradas por el backend ([#92](https://github.com/lidge-jun/opencodex/issues/92)). Se ignora en `v1` y `default`. |
| `subagentModels?` | `string[]` | `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna` | Hasta cinco identificadores nativos sin prefijo, con cuenta `<selector>/<native-openai-model>` o enrutados `provider/model` que aparecen primero en el selector de subagentes. El panel ofrece identificadores nativos sin prefijo y enrutados para nuevas selecciones; al guardar conserva los identificadores exactos de cuenta ya configurados, aunque no estén disponibles en el catálogo actual. Para añadir un identificador exacto de cuenta nuevo, usa `ocx agent subagents set` o edita la configuración. Tras la [migración única de Astra](#astra-roster-upgrade), se conserva una lista explícitamente vacía. |
| `injectionModel?` | `string` | — | Modelo de subagente nativo o enrutado preferido que se menciona en la guía de delegación v2 redactada por el proxy. |
| `injectionEffort?` | `string` | — | Esfuerzo preferido (de `low` a `ultra`); solo tiene efecto junto con `injectionModel`. |
| `injectionPrompt?` | `string` | — | Sustituye el cuerpo de la guía v2 integrada. Admite `{{model}}`, `{{effort}}`, `{{roster}}` y `{{fallback}}`. Basta con configurar `injectionModel` para generar el prompt personalizado. |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | Solo controla la guía de desarrollador v1/v2 redactada por opencodex; no cambia los valores nativos de agentes, las herramientas, el enrutamiento, las listas ni los límites de esfuerzo. |
| `syncCodexSubagentDefaults?` | `boolean` | `false` | Permite escribir `injectionModel` y el `injectionEffort` opcional como valores nativos de Codex al sincronizar o reiniciar. Requiere `injectionModel`. |
| `subagentModelFallback?` | `string[]` | `[]` | Modelos globales de respaldo, en orden de prioridad, para los turnos de subagentes creados. |
| `subagentModelFallbackByModel?` | `Record<string, string[]>` | `{}` | Cadenas de respaldo por modelo principal, indexadas por su identificador solicitado. Esta es la ubicación admitida para los metadatos de respaldo por rol; incluir `model_fallback` en el TOML de un agente hace que Codex 0.146+ omita ese rol (#1190). |
| `subagentModelFallbackPollMs?` | `number` | `60000` | Duración de la caché de comprobaciones de disponibilidad. Los valores inferiores a 1000 ms usan el predeterminado. |
| `codexRoleTiers?` | `{ fast?, standard?, frontier?: string[] }` | — | Nivel de capacidad de los modelos indicados para la [asignación automática de roles](/es/guides/integrations/#auto-assign). Esos modelos reciben el nivel indicado; los demás se clasifican por precio. No se proponen modelos sin precio que no estén en la lista. |
| `effortCap?` | `string` | — | Límite máximo para los turnos principales v2 que cumplan los requisitos y para los turnos de subagentes que lleven los marcadores correspondientes. Admite de `low` a `ultra`. |
| `subagentEffortCap?` | `string` | — | Límite adicional solo para turnos de subagentes creados. Cuando se aplican ambos límites, prevalece el menor. |
| `plaintextV2AgentMessages?` | `boolean` | — (sin configurar) | Opción experimental que solo se ejecuta al establecerla explícitamente en `true`. Pide a los agentes principales v2 nativos de ChatGPT que cumplan los requisitos emitir en texto sin cifrar los argumentos de mensaje de `spawn_agent`, `send_message` y `followup_task`. Consulta [Mensajes de agentes v2 en texto sin cifrar](#plaintext-v2-agent-messages). |
| `agentTaskRecovery?` | `object` | — | Recuperación experimental de tareas v2 cifradas por el backend que se envían a proveedores enrutados. Está desactivada salvo que se indique `enabled: true`; consulta [Recuperación de tareas v2 cifradas](#encrypted-v2-task-recovery). |

Configura el modo desde el panel o con `ocx v2 status|on|off|mode <v1|default|v2>|keep-native-v1 <on|off>|threads <n>|mode-hint <text|--clear>`. Los cambios de modo se aplican a sesiones nuevas. `maxConcurrentThreadsPerSession` es un campo de `PUT /api/v2`, no una clave de `config.json`; después de activar v2, `ocx v2 threads <n>` escribe `max_concurrent_threads_per_session` dentro de `[features.multi_agent_v2]` en el archivo `$CODEX_HOME/config.toml` de Codex.

**Delegación siempre proactiva**, en Subagentes → Avanzado (antes **Modo Ultra**), cambia el criterio para delegar sin cambiar el esfuerzo de razonamiento. Su configuración predefinida conserva las instrucciones del usuario, los límites de autoridad, el alcance de la tarea y las reglas de las herramientas. El interruptor del panel, el campo `multiAgentModeHintText` de `PUT /api/v2` y `ocx v2 mode-hint` escriben `features.multi_agent_v2.multi_agent_mode_hint_text` en el archivo `$CODEX_HOME/config.toml` de Codex. El comando `ocx v2 mode-hint` guarda esta clave incluso cuando `multi_agent_v2` está desactivado; no activa la función. Cuando la interfaz nativa está activa, esta indicación sustituye la política multiagente que codex-rs deriva del esfuerzo. Un valor `null` elimina la clave y restaura la política derivada del esfuerzo (ultra = proactiva; los demás niveles = explícita). Se rechazan los valores vacíos o compuestos solo por espacios, porque una anulación vacía suprimiría incluso el mensaje proactivo derivado de ultra. El interruptor **Delegación siempre proactiva** del panel de Subagentes requiere tanto la función nativa como un modo v2 explícito (`multiAgentMode: "v2"`, equivalente a `ocx v2 mode v2`); `ocx v2 on` por sí solo no cumple ese requisito.

`GET` y `PUT /api/v2` también devuelven `multiAgentModeHintRecommendation: { text, revision }`. El panel usa ese texto del servidor al activar o restaurar la configuración predefinida, sin un texto alternativo fijo. Si un servidor anterior omite la recomendación o devuelve un valor mal formado, no se puede instalar ni restaurar la configuración predefinida; sigue siendo posible editar o borrar una indicación personalizada existente. **Restaurar configuración predefinida** solo cambia el borrador local; **Guardar** lo conserva.

Leer la configuración, actualizar campos ajenos o cambiar de versión no migra una indicación guardada. Solo una actualización explícita cuyo texto coincida byte por byte con uno de los dos preajustes antiguos reconocidos de OpenCodex se sustituye por la recomendación actual. Los demás textos personalizados válidos, incluidas las variantes de espacios, se conservan byte por byte. Antes de escribir se sigue comprobando la compatibilidad con esta función, y los cambios se aplican a sesiones nuevas de Codex.

La API de administración expone `GET`/`PUT /api/v2`, `/api/injection-model`, `/api/effort-caps`, `/api/subagent-models` y `/api/subagent-model-fallback`. Las actualizaciones del modelo de inyección son parciales; en esa API el prompt personalizado corresponde al campo `prompt`.

La página de autenticación de Codex también permite cambiar la opción nativa `default_mode_request_user_input` (`GET`/`PUT /api/codex-auth/features/default-mode-request-user-input`). Al activarla se añade `[features] default_mode_request_user_input = true` al archivo `$CODEX_HOME/config.toml` de Codex mediante el comando oficial `codex features enable|disable`, con una edición que conserva el formato y se elimina al desactivar la opción. Esto permite que Codex pause una sesión en modo Default para preguntar con `request_user_input`. La función está en desarrollo en el proyecto original y solo afecta a sesiones nuevas; si la compilación instalada todavía no la reconoce, el interruptor muestra un error explícito.

<a id="roster-and-guidance"></a>

## Lista de modelos y guía

La lista v2 efectiva comprende los primeros cinco modelos configurados, visibles en el selector y ordenados por prioridad que estén presentes en el catálogo inyectado y no estén marcados explícitamente como `"disabled"`. Una asignación `"v2"` explícita permite subagentes recursivos; `"v1"`, `null` o la ausencia de asignación siguen permitiendo subagentes sin delegación adicional. Las entradas excluidas permanecen en la configuración para poder cumplir los requisitos más adelante.

El modo se detecta por la estructura de las herramientas. Un `spawn_agent` dentro de un espacio de nombres, junto con `send_input`, `resume_agent` o `close_agent`, indica v1. Un `spawn_agent` plano, junto con `send_message`, `followup_task`, `interrupt_agent` o `list_agents`, indica v2.

La guía v1 solo usa texto proactivo en `max` o `ultra`. V2 recibe un mensaje de desarrollador del proxy únicamente cuando existe un modelo preferido, una lista de modelos aptos o una cadena de respaldo. La guía v2 integrada tiene un presupuesto de 700 caracteres y, si hace falta, omite primero la lista. Se eliminan duplicados entre los prefijos del historial reproducido y la guía se inserta antes de un `compaction_trigger` final.

Tanto la guía v2 integrada como el cuerpo de `injectionPrompt` usan `<opencodex_subagent_guidance>`, separado de los mensajes nativos `<multi_agent_mode>` de Codex. El texto integrado informa el modelo preferido resuelto, la lista y la cadena de respaldo sin ordenar la delegación ni imponer cambios de modelo o de `fork_turns`. Los cuerpos personalizados conservan su contenido y la sustitución de marcadores. `injectionModel` e `injectionEffort` siguen siendo recomendaciones salvo que se active la sincronización de valores nativos; los marcadores personalizados sin valor se sustituyen por una cadena vacía.

La eliminación de duplicados compara el texto exacto más reciente de cada familia de etiquetas. Cuando ambos valores usan la nueva familia del proxy, volver de una guía personalizada a la integrada añade el valor actual; los cambios intermedios del modo nativo no duplican una guía del proxy que no haya cambiado. Se conserva el historial nativo y el que lleva etiquetas antiguas. Cambiar esta envoltura no identifica al autor de mensajes anteriores ni revoca instrucciones previas. La etiqueta antigua por sí sola no permite clasificar historiales de versiones mixtas y no se garantiza la detección de transiciones en ellos.

<a id="native-codex-default-sync"></a>

## Sincronización de valores nativos de Codex

Al activarse, `syncCodexSubagentDefaults` escribe los campos `[agents] default_subagent_model` y `default_subagent_reasoning_effort` que pertenecen al marcador de opencodex. Los campos de destino sin marcador que pertenecen al usuario se consideran conflictos y siguen teniendo prioridad; las escrituras TOML parciales o ambiguas se rechazan. Borrar `injectionModel` también desactiva esta opción. Estos valores afectan a las tareas nuevas de Codex y no provocan delegación por sí mismos.

<a id="fallback-chain"></a>

## Cadena de respaldo

El orden de respaldo para los turnos de subagentes creados es:

1. El modelo principal solicitado.
2. Las cadenas por modelo de `subagentModelFallbackByModel`, indexadas por el modelo principal.
3. Las entradas globales de `subagentModelFallback`.

Las cadenas por rol deben estar en la configuración de opencodex. Escribir `model_fallback` en `$CODEX_HOME/agents/*.toml` hace que Codex 0.146+ rechace todo el archivo por un campo desconocido y omita el rol (#1190). Una línea antigua `model_fallback` todavía se lee por compatibilidad, pero `ocx doctor` la señala.

opencodex omite candidatos desactivados, sin ruta, con problemas de funcionamiento, en espera de recuperación o que hayan alcanzado el umbral de cuota. La instantánea de disponibilidad se conserva durante `subagentModelFallbackPollMs`. Las tareas cifradas limitan la cadena a destinos nativos canónicos de ChatGPT y a rutas directas de Responses con clave que se hayan declarado de confianza mediante `allowEncryptedV2AgentTasks: true`. Si ninguno puede consumir la carga cifrada, la solicitud falla sin enviarla a otro destino que no pueda leerla. El enrutamiento de Combos prueba primero un destino nativo canónico disponible; cuando ninguno es seleccionable o se agotan sus intentos y `agentTaskRecovery` está activado, recupera una vez el `NEW_TASK` cifrado antes de enviarlo al destino enrutado. La recuperación de Combos solo se ejecuta en turnos de subagentes creados; la ruta enrutada directa también recupera tareas al cambiar de modelo en medio de un hilo.

```json
{
  "multiAgentMode": "v2",
  "subagentModels": ["gpt-6.1-sol", "anthropic/claude-sonnet-5"],
  "injectionModel": "gpt-6.1-sol",
  "injectionEffort": "high",
  "syncCodexSubagentDefaults": true,
  "subagentModelFallback": ["gpt-6-luna"],
  "subagentModelFallbackByModel": {
    "gpt-6.1-sol": ["gpt-6-luna"]
  },
  "subagentModelFallbackPollMs": 60000,
  "subagentEffortCap": "high"
}
```

<a id="plaintext-v2-agent-messages"></a>

## Mensajes de agentes v2 en texto sin cifrar

`plaintextV2AgentMessages` no está configurado en una instalación nueva y solo se ejecuta al establecerlo explícitamente en `true`. El cliente debe usar el protocolo Responses y el destino final debe usar el transporte canónico de reenvío de ChatGPT Codex: `adapter: "openai-responses"`, `authMode: "forward"` y la URL base exacta `https://chatgpt.com/backend-api/codex`. Nunca se reescriben los proveedores de OpenAI con clave API, las pasarelas personalizadas compatibles con OpenAI, las rutas cuyo destino final sea otro proveedor ni las solicitudes que no usen Responses.

Para una solicitud v2 apta, opencodex reconoce el catálogo por un espacio de nombres `collaboration` de nivel superior con un hijo directo `spawn_agent`. El catálogo puede estar en `tools` de nivel superior o, cuando no existe `tools`, en `additional_tools` del primer elemento de entrada de desarrollador (Responses Lite). El catálogo explícito de nivel superior tiene prioridad; los catálogos de rol de usuario y los posteriores del historial no activan la opción. Se elimina `parameters.properties.message.encrypted: true`, si existe, únicamente de `spawn_agent`, `send_message` y `followup_task`. ChatGPT reserva tanto `collaboration` como esos tres nombres de herramientas, por lo que la solicitud usa alias privados fijos para las cuatro identidades. Antes del cambio, opencodex comprueba los catálogos de nivel superior y de `additional_tools`, los espacios de nombres anidados, las declaraciones `tool_search_output`, `tool_choice` y las llamadas anteriores para detectar conflictos con los alias o el espacio de nombres privado. Ante cualquier conflicto, toda la solicitud se conserva sin cambios. OpenCodex restaura solo los alias correspondientes a esa solicitud en las respuestas JSON, SSE y WebSocket antes de que Codex reciba la llamada. Se conserva `encrypted_function_args: []` para que los clientes compatibles reconozcan el mensaje como texto sin cifrar.

Esta ruta no añade solicitudes de recuperación y, por tanto, no consume la cuota adicional de ChatGPT asociada a una entrada ausente de la caché de `agentTaskRecovery`. No puede cambiar tareas que ya estén cifradas. Si la solicitud ya declara el alias privado o una referencia conflictiva, opencodex la conserva sin cambios; la recuperación activada por separado aún puede atender una tarea enrutada que se cifre después. Si ChatGPT rechaza o ignora el esquema modificado, o si el cliente no reconoce los campos de respuesta de texto sin cifrar, la llamada puede fallar. OpenCodex no reintenta la solicitud principal con el esquema original, porque podría duplicar el consumo de cuota o las llamadas a herramientas.

La restauración recorre un máximo de 10.000 identidades por respuesta. Si se agota ese presupuesto, la respuesta JSON acotada devuelve HTTP 502 y una transmisión devuelve `response.failed`; ninguna ruta envía los alias privados a Codex ni guarda la respuesta rechazada para continuar mediante `previous_response_id`.

En las llamadas reescritas correctamente, la opción elimina el cifrado de aplicación de los argumentos de mensaje de agentes. HTTPS sigue cifrando el transporte de red, pero el texto puede aparecer en el historial de tareas de Codex, las solicitudes al proveedor enrutado, `responses-state.json` o sus archivos auxiliares y, si está activada la captura de depuración, `usage-debug.jsonl`. El comportamiento depende de campos no documentados del esquema y de la respuesta de ChatGPT y puede dejar de funcionar tras actualizar el cliente o el backend. Al iniciar se muestra una advertencia mientras la opción esté activada.

```json
{
  "plaintextV2AgentMessages": true
}
```

El comando equivalente es `ocx config set plaintextV2AgentMessages true`. Reinicia el proxy después de cambiar la configuración.

<a id="encrypted-v2-task-recovery"></a>

## Recuperación de tareas v2 cifradas

`agentTaskRecovery` es una ruta experimental de compatibilidad para tareas v2 cifradas por el backend que llegan a un proveedor enrutado. Admite dos casos: un agente principal nativo de ChatGPT que crea un subagente v2 enrutado, y un hilo activo que cambia de un modelo nativo de ChatGPT a uno enrutado y reproduce en cada turno posterior un mensaje de agente cifrado por el backend ([#4089](https://github.com/lidge-jun/opencodex/issues/4089)). Está desactivada de forma predeterminada. Al activarla explícitamente, si la tarea final enrutada contiene una carga Fernet ilegible, opencodex hace una solicitud de paso directo de Responses al destino fijo `https://chatgpt.com/backend-api/codex/responses`, con autenticación de reenvío. ChatGPT devuelve la tarea en texto sin cifrar mediante una llamada a función forzada; opencodex convierte únicamente ese elemento en un mensaje de usuario estándar antes de enviarlo al proveedor enrutado. La recuperación directa, la reproducción del historial en caché y el detector de tareas ilegibles reconocen los cuatro tipos de mensajes de agentes de codex-rs: `NEW_TASK`, `MESSAGE`, `FOLLOWUP_TASK` y `FINAL_ANSWER`. La recuperación de Combos sigue limitada a turnos de subagentes creados. La envoltura de `FINAL_ANSWER` puede omitir la línea `Task name`; en ese caso no existe una dirección de cabecera que comparar con el destinatario del elemento y se omite solo esa comprobación. Se mantienen la comparación del remitente y el ámbito de la caché, que sigue incluyendo al destinatario estructurado.

Esto no descifra localmente ni corrige el protocolo de Codex. Depende de comportamiento no documentado del backend de ChatGPT y puede dejar de funcionar si cambia. La tarea recuperada es salida de un modelo, no texto sin cifrar verificado criptográficamente: no se garantiza fidelidad byte por byte. Una entrada ausente de la caché puede añadir una solicitud autenticada a ChatGPT, consumir cuota de la cuenta y aumentar la latencia antes de la solicitud enrutada. Las solicitudes concurrentes para la misma tarea y el mismo ámbito comparten una sola recuperación. Al iniciar se muestra una advertencia mientras la función esté activada.

La admisión y la conservación están limitadas deliberadamente:

- La recuperación solo está disponible mientras el proxy esté vinculado a loopback.
- Solo se admite un cliente nativo de Codex con un par de token bearer y cuenta de ChatGPT coincidente. Es el tipo de credencial del proveedor canónico `openai` con `authMode: "forward"`. La recuperación usa únicamente el par recibido y nunca lo sustituye por autenticación con clave API, credenciales de otro proveedor ni otra cuenta de Codex.
- Los clientes que usen `x-opencodex-api-key`, `x-api-key`, credenciales API genéricas o un secreto de acceso al proxy siguen recibiendo `unreadable_encrypted_agent_task`.
- Las credenciales originales de ChatGPT solo se envían al destino fijo de ChatGPT; nunca se incluyen en el cuerpo, los registros, las claves de caché ni la solicitud al proveedor. El ámbito de la caché en memoria usa un resumen de la credencial y la cuenta del cliente, calculado con una clave aleatoria por proceso.
- La recuperación solo reenvía `authorization`, el `chatgpt-account-id` coincidente, `originator` y, opcionalmente, `openai-beta` y `user-agent`. opencodex establece `content-type` y `accept`; ningún otro encabezado del cliente cruza ese límite.
- El texto recuperado nunca se registra ni persiste. La caché del proceso está delimitada por credencial, hilo principal y texto cifrado, caduca a los 15 minutos y tiene dos límites: la cantidad configurada de entradas (200 de forma predeterminada, 512 como máximo) y 8 MiB en total.
- Una envoltura mal formada, una recuperación fallida, un tiempo de espera agotado o un error de validación conservan el rechazo seguro existente; la cancelación del cliente devuelve 499. Ninguna de esas rutas reenvía el texto cifrado al proveedor enrutado.

La recuperación acepta una secuencia consecutiva de hasta 32 partes cifradas completas con estructura Fernet, con un máximo de 2 MiB de texto cifrado combinado. Las partes conservan su orden y sus límites en una sola solicitud autenticada. La identidad de caché incluye la secuencia; la entrada original vuelve a validarse antes de sustituir la tarea. Los fallos HTTP conservan la razón de diagnóstico acotada existente. No generan reintentos internos salvo que se configure `retries`: con un valor de 1 a 2, opencodex repite la misma solicitud admitida solo ante un estado transitorio del proveedor (500/502/503/504/52x) o un fallo de transporte, tras una espera breve con variación aleatoria y dentro de la misma credencial, plazo y operación compartida. Los estados terminales y las salidas de recuperación inválidas nunca se reintentan.

Los tokens divididos no se reconstruyen para recuperarlos. Una secuencia acotada cuya concatenación exacta tenga estructura Fernet sigue clasificada como texto cifrado al normalizar los campos de texto sin cifrar. Si la tarea no contiene texto legible independiente, se rechaza sin hacer una recuperación ni una solicitud al proveedor enrutado. El texto legible independiente conserva la política existente de contenido mixto. Otras representaciones fragmentadas no están admitidas; esto no ofrece recuperación general de tokens divididos ni garantiza fidelidad multipart del proveedor.

<a id="threat-model"></a>

### Modelo de amenazas

Esta ruta presupone que el cliente nativo local de Codex ya tiene una credencial válida de ChatGPT y que se confía en el destino fijo de ChatGPT para autenticarla. Protege frente a clientes genéricos del proxy o con clave API que intenten usar la función como un oráculo de texto sin cifrar, el envío de credenciales a otro destino, la reutilización de caché entre cuentas o hilos y el registro o la persistencia de datos sensibles. Antes de cada consulta a la caché, la admisión comprueba emisor, audiencia, cliente Codex, fechas de validez y coincidencia exacta de cuenta; el destino sigue siendo la autoridad que valida la firma.

No protege frente a otro proceso del mismo usuario del sistema operativo, un backend de ChatGPT o un modelo de recuperación comprometido, la inyección de instrucciones dentro de la tarea cifrada, errores de transcripción del modelo ni la inspección de memoria del proxy. Por ello, la salida recuperada debe tratarse como salida de modelo no confiable y no como texto autenticado.

```json
{
  "agentTaskRecovery": {
    "enabled": true,
    "model": "gpt-5.6-sol",
    "timeoutMs": 45000,
    "cacheEntries": 200,
    "retries": 0
  }
}
```

Activa esta opción solo si aceptas la solicitud autenticada adicional, el consumo de cuota, la presencia de texto sin cifrar en el proceso y la dependencia del backend privado. En caso contrario, prefiere un subagente nativo de ChatGPT o la delegación heterogénea v1.

Esta recuperación se aplica a subagentes enrutados directamente y a la creación de `NEW_TASK` cifrados en Combos. Puede haber **como máximo 32 solicitudes de recuperación activas a la vez**; las solicitudes adicionales sin entrada de caché se rechazan. Un Combo con un destino nativo canónico disponible sigue enviándole el texto cifrado directamente: la recuperación solo se ejecuta cuando no se puede seleccionar ningún destino nativo. Después de agotar la actualización de la cuenta guardada de Pool y la repetición con esa misma cuenta, la recuperación puede usar la credencial del cliente entrante para un destino enrutado disponible sin probar otra cuenta nativa. Los rechazos por política siguen siendo terminales. Una recuperación fallida o la falta o el agotamiento de destinos provocan el rechazo sin reenviar texto cifrado a un proveedor enrutado.

<a id="effort-caps"></a>

## Límites de esfuerzo

Los límites solo se aplican a la colaboración v2: un turno principal cumple los requisitos cuando sus herramientas exponen v2; un subagente los cumple si lleva los marcadores exactos de codex-rs `x-openai-subagent: collab_spawn` o `"subagent_kind": "thread_spawn"` en `x-codex-turn-metadata`, aunque sus herramientas ya no expongan colaboración. Los turnos principales v1, `multiAgentMode: "v1"`, la compactación, la revisión y la consolidación de memoria quedan exentos.

Los límites solo reducen el esfuerzo. Se elige el nivel anunciado más alto que no supere el límite. Si el modelo no tiene control de esfuerzo o no admite ningún nivel que cumpla el límite, opencodex omite el esfuerzo y deja que se aplique el valor predeterminado del proveedor. Se aceptan `max` y `ultra`, aunque el panel ofrece de `low` a `xhigh`.

Los límites configurados también se aplican a turnos nativos aptos de Chat Completions que no lleven una asignación de esfuerzo por modelo. La conversión al formato del proveedor se ejecuta al aplicar una asignación o al cambiar el valor por un límite; si no ocurre ninguna de esas cosas, se conserva la representación original enviada por el cliente nativo.

Consulta [Modos de subagentes](/es/guides/sub-agent-surface/) para una explicación inicial de v1, default y v2.

<a id="global-model-effort-pins"></a>

## Asignaciones globales de esfuerzo por modelo

El mapa opcional de nivel raíz `modelPinnedEfforts` completa o sustituye el esfuerzo recibido cuando no existe una asignación por modelo del proveedor ni una asignación para todo el proveedor. Por ejemplo:

```json
{
  "modelPinnedEfforts": {
    "example-provider/example-model": "high"
  }
}
```

La búsqueda consulta primero el selector final antes de normalizar el prefijo del proveedor; después, el destino completo `provider/model`; y, por último, el identificador del modelo de origen sin prefijo. Los alias originales de Combos y los identificadores sintéticos de filas de esfuerzo no son claves de asignaciones globales: configura el destino concreto. Los valores predeterminados de esfuerzo de filas sintéticas y de Combos se conservan como entrada efectiva antes de aplicar la asignación. Cada destino elegido resuelve su propia asignación, luego los límites aplicables y la normalización del protocolo. Las solicitudes de compactación quedan exentas. `none` omite el esfuerzo y usa el comportamiento predeterminado del proveedor; no garantiza que se desactive el razonamiento.

`GET /api/effort-caps` incluye el mapa. `PUT /api/effort-caps` acepta `modelPinnedEfforts` junto con los límites existentes: los campos omitidos no cambian, `null` borra el mapa y una entrada con `null` o `""` elimina solo esa clave. Una actualización combinada inválida no modifica los límites ni las asignaciones. Guardar una asignación no cambia la lista de subagentes destacados.
