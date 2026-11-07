---
title: "Interfaz de subagentes (v1 / base / v2)"
description: "Controle cómo Codex genera y gestiona subagentes en todos los modelos."
---

<a id="what-sub-agents-are"></a>

## Qué son los subagentes

Un subagente es un trabajador separado Codex que el agente principal puede crear para una tarea enfocada. Tiene su propio contexto y herramientas, por lo que varias tareas independientes pueden ejecutarse en paralelo. opencodex controla qué superficie de colaboración Codex expone a esos trabajadores, qué modelos Codex ofrece para ellos y cómo un modelo fallido puede retroceder. No decide cuándo su agente principal debe delegar.

<a id="modes"></a>

## Modos

Elija el modo para **Nuevas sesiones**. Las sesiones existentes mantienen la superficie con la que comenzaron.

| Modo | Herramientas de Codex | Para quién se recomienda |
| --- | --- | --- |
| **v1** (predeterminado) | Herramientas clásicas en un espacio de nombres: `spawn_agent`, `send_input`, `resume_agent` y `close_agent`. Al crear un subagente se puede elegir otro modelo directamente. | Para quienes delegan entre proveedores, especialmente desde un agente nativo hacia subagentes enrutados. Es el modo que incluye una instalación nueva. |
| **base** | Asignaciones originales por modelo: GPT-5.6 Sol/Terra usan v2; Luna, v1. Los demás siguen la opción `multi_agent_v2` de Codex. | Para quienes quieren conservar esas asignaciones y usan modelos principales y subagentes del mismo lado del límite de proveedores. Sol y Terra quedan en v2. |
| **v2** | Herramientas planas `spawn_agent`, `send_message`, `followup_task`, `interrupt_agent` y listado de agentes, con sesiones concurrentes. | Para quienes necesitan el flujo concurrente y comprenden la herencia de modelos y la limitación de tareas cifradas descrita abajo. |

En **v2**, la opción **Mantener ChatGPT en v1** (`keepNativeChatGptOnV1`) conserva Sol/Terra en v1 para que puedan crear subagentes Grok o Claude. Los agentes principales nativos de ChatGPT cifran el cuerpo de las tareas `NEW_TASK` en v2 y los modelos enrutados no pueden leerlo. Los agentes principales enrutados permanecen en v2, donde las tareas de sus subagentes son texto plano. Para este modo híbrido, OpenCodex desactiva la anulación global `multi_agent_v2`, porque Codex la aplica antes que los ajustes por modelo del catálogo. Es una opción de v2, no un cuarto modo de catálogo.

:::tip[¿Tienes dudas?]
Usa **v1**, el modo predeterminado. Elige **base** o **v2** solo si el modelo principal y el subagente están del mismo lado del límite de proveedores: en ambos modos, una tarea enviada desde un modelo nativo de ChatGPT a uno enrutado llega cifrada y falla. La opción híbrida de v2 descrita arriba evita ese cruce conservando los modelos nativos en v1. El dashboard pide confirmación antes de elegir base o v2 y enlaza a [Por qué v1 es el valor predeterminado](/es/guides/subagent-v1-default/).
:::

<a id="model-switches-and-side-chat-compaction"></a>

## Interruptores de modelo y compactación de chat lateral

Codex puede compactar la historia heredada antes del primer turno de un chat lateral o después de un cambio de modelo. Un disparador compara los marcadores de compatibilidad `comp_hash` de los modelos anteriores y de destino: cuando ambos están presentes y difieren, Codex se compacta incluso si el historial se ajusta al contexto del destino.

OpenCodex representa compatibilidad desconocida para modelos enrutados como `comp_hash: null`, en lugar de inventar un marcador `"opencodex"` o copiar uno de una plantilla nativa. Las reconstrucciones de catálogo también borran esos marcadores antiguos en OpenCodex filas retenidas durante una interrupción de descubrimiento del proveedor. Los modelos nativos y los alias explícitos Codex-forward mantienen sus marcadores ascendentes, por lo que aún se aplican verificaciones de incompatibilidad nativa genuinas. Este comportamiento es independiente de la superficie del subagente v1/v2 y del modelo configurado para realizar la compactación.

El contexto normal y la compactación de límite de token todavía se aplican. Este cambio elimina el desajuste de hash sintético; no selecciona qué mensajes visibles hereda un chat lateral ni restaura los mensajes originales de un contexto ya compactado. El soporte de contenido del proveedor sigue siendo una restricción separada.

<a id="external-task-input"></a>

## Entrada de tarea externa

Codex puede entregar la entrada inicial o seguimiento de una tarea en una envolvente en forma de resultado sin un `call_id`. En las rutas traducidas, OpenCodex reconoce solo la forma completa de `function_call_output` con `id`, `name` y `namespace` sin espacios en blanco y salida de texto/imagen compatible, luego la trata como un turno de usuario. Esto también inicia el nuevo límite de conversación durante la continuación y borra el razonamiento pendiente del turno anterior. La guía para desarrolladores generada se coloca antes de la tarea actual tanto en los mensajes analizados como en el historial sin procesar guardado, preservando el mismo orden cuando se reproduce ese historial.

Los sobres mal formados, vacíos, opacos o incompletos aún fallan en la validación. Los resultados reales de la herramienta mantienen su `call_id` requerido; el paso nativo y la compactación enrutada (portátil) aplican el mismo mapeo de giro de usuario a sus cuerpos sin procesar; el `/responses/compact` directo mantiene su manejo de entrada sin procesar existente. Véase [el contrato del adaptador](/es/reference/adapters/#external-task-input-on-translated-responses-routes).

<a id="how-it-works"></a>

## Cómo funciona

El modo seleccionado controla el campo `multi_agent_version` en cada entrada de catálogo Codex dice:

- **v1** sellos `multi_agent_version = "v1"` en cada modelo.
- **base** restaura los pines de aguas arriba. Las entradas sin pines siguen la bandera de la característica nativa `multi_agent_v2`.
- **v2** sellos `multi_agent_version = "v2"` en todos los modelos, excepto cuando **Mantener ChatGPT en v1** está habilitado: ChatGPT -las filas nativas permanecen `"v1"` y las filas enrutadas o combinadas permanecen `"v2"`.

opencodex aplica esto como el pase final tanto al catálogo en vivo `/v1/models` como al catálogo sincronizado al disco. Es por eso que un cambio de modo afecta a las nuevas sesiones de App, CLI y TUI creadas de manera consistente.

Para una lista v2, la elegibilidad tiene tres estados: una entrada sellada `"v2"`, explícitamente establecida en `null`, o con ningún campo `multi_agent_version` es elegible. Se excluye un pin genuino `"v1"` porque establece que el modelo pertenece a la otra superficie de colaboración.

<a id="which-models-spawn_agent-advertises"></a>

## Qué modelos anuncia `spawn_agent`

Codex muestra como máximo cinco modelos en la descripción de `spawn_agent`. Los elige ordenando las filas visibles del catálogo por `priority`, de menor a mayor, y tomando las cinco primeras. La lista de la página **Subagentes** (`subagentModels`) influye en esa selección al asignar a sus modelos las prioridades más bajas, en el orden configurado (`0` a `4` si no hay selectores de cuenta). No limita la selección exclusivamente a esos modelos.

Si destacas entre uno y cuatro modelos, Codex completa los espacios restantes con las siguientes filas por prioridad. Esas filas no las elegiste tú y el dashboard no muestra cuáles son. Dependen del catálogo:

| Catálogo | Filas que completan los espacios restantes |
| --- | --- |
| Sin selectores de cuenta de Codex | Las demás filas enrutadas `provider/model`. Todas tienen prioridad `5`, por lo que se ordenan alfabéticamente por proveedor y después por identificador de modelo. Las filas GPT nativas no destacadas usan `featured.length + 100 + sourcePriority`, conservando su orden de origen detrás de esas filas enrutadas. |
| Con selectores de cuenta de Codex | Las filas nativas calificadas por cuenta (`<selector>/<native-model>`), inmediatamente después de las destacadas. Las filas enrutadas no destacadas pasan a la prioridad `1005` y quedan detrás. |

Por ejemplo, sin selectores de cuenta y con esta lista:

```json
{ "subagentModels": ["xai/grok-4.5", "anthropic/claude-sonnet-5"] }
```

| Posición | Modelo | Prioridad | Motivo |
| ---: | --- | ---: | --- |
| 1 | `xai/grok-4.5` | `0` | Primera entrada de la lista |
| 2 | `anthropic/claude-sonnet-5` | `1` | Segunda entrada de la lista |
| 3 | `deepseek/deepseek-v4-flash` | `5` | Primera fila enrutada restante en orden alfabético |
| 4 | `google/gemini-3-pro` | `5` | Siguiente fila enrutada |
| 5 | `moonshot/kimi-k3` | `5` | Siguiente fila enrutada |
| 6+ | `zai/glm-5.2`, y después las filas GPT nativas | `5`, y después `102 + sourcePriority` | Fuera de las cinco primeras |

La prioridad nativa de origen usa primero el descubrimiento actual, después la copia de seguridad intacta, la prioridad de origen conservada para el mismo modelo y la instantánea del proveedor, con `9` como valor de respaldo. Las sincronizaciones repetidas y los cambios entre destacar y dejar de destacar conservan esa prioridad sin el desplazamiento de banda. La lista en vivo, el catálogo publicado y la caché coinciden para las mismas entradas. Consulta [Orden de modelos](/es/guides/model-ordering/) para conocer la validación y las anulaciones del orden del selector.

Con la lista vacía, opencodex no fija ninguna prioridad y se eligen las cinco filas según las prioridades habituales del catálogo.

Los modelos que completan la lista se anuncian normalmente, así que el agente principal puede elegirlos. La lista tampoco es una lista de permisos: Codex acepta un modelo del catálogo que esté fuera de las cinco primeras filas si el agente principal lo nombra exactamente. Para controlar lo que anuncia Codex:

- Destaca cinco modelos. Una lista completa no deja espacios por rellenar.
- Desactiva un modelo que no quieras que se ofrezca, o exclúyelo de `selectedModels` de su proveedor. Sale del selector y no puede completar un espacio.
- `modelPickerOrder` cambia las prioridades usadas para ordenar. Una lista formada solo por modelos enrutados mueve sus filas no destacadas a `1000` o más, de modo que las filas enrutadas que no figuren en ella completan primero los espacios. Si contiene un identificador nativo sin calificar, ordena todo el selector, incluidas las filas destacadas: las filas de la lista ocupan los espacios antes que cualquier fila que no figure en ella. Véase [Orden de modelos](/es/guides/model-ordering/).

En v2, Codex excluye las filas con valor fijo `"disabled"` antes de elegir las cinco; el resto funciona igual. La guía v2 de opencodex (`{{roster}}`) solo nombra los modelos configurados que estén entre esas cinco filas. Por eso los modelos de relleno aparecen en la descripción de la herramienta de Codex, pero no en la guía de opencodex. Codex lee el catálogo al iniciar una sesión, así que los cambios de la lista se aplican a sesiones nuevas.

<a id="delegation-model-and-effort"></a>

## Modelo de delegación y esfuerzo

El **Delegación de subagentes** del panel de control controla tres configuraciones relacionadas:

- `injectionModel` es el modelo de trabajador preferido nombrado en la guía opencodex.
- `injectionEffort` es el `reasoning_effort` opcional para solicitar ese modelo.
- `injectionPrompt` reemplaza el texto de guía v2 incorporado.

La opción **Sugerir**, junto al modelo de delegación, pide una breve descripción del trabajo que Codex suele delegar. Realiza una llamada a tu modelo predeterminado de Codex para evaluar la tarea y propone el modelo más económico que resulte suficiente, con un nivel de esfuerzo de los disponibles en el selector. También explica los motivos y qué señales justificarían subir o bajar de nivel. La sugerencia no se aplica hasta pulsar **Usar este**: ese botón guarda el modelo y el esfuerzo igual que una selección manual. Los niveles se obtienen de `codexRoleTiers` o del precio, como en la [asignación automática de roles](/es/guides/integrations/#auto-assign), pero sin las puntuaciones medidas que esta última puede leer de fuentes configuradas.

`multiAgentGuidanceEnabled` por defecto está encendido y es el switch maestro para opencodex, guía de autoría en ambas superficies. Apagarlo suprime tanto el bloque de designación v2 como el texto proactivo v1.

Para las solicitudes Responses sin estado en forma de matriz, opencodex coloca la guía generada después de los metadatos líderes del sistema y del desarrollador, incluido el desarrollador `additional_tools`, y antes de la entrada conversacional. `previous_response_id` continuaciones reutilizan la guía etiquetada solo cuando coincide con el último elemento etiquetado en su prefijo de reproducción de confianza. Otra guía generada se reutiliza cuando existe un elemento de desarrollador generado exacto en ese prefijo. Cuando la guía cambia, el protocolo de la herramienta líder permanece primero y el reemplazo se inserta antes de la entrada conversacional actual.

Estas son instrucciones para el agente principal, no un router de generación del lado del proxy. En v2, una bifurcación de historia completa hereda el modelo padre y rechaza anulaciones de modelo o esfuerzo. Por lo tanto, la guía le dice a Codex que use `fork_turns: "none"` (o un recuento de giro parcial positivo como `"3"`) cuando pase `model` o `reasoning_effort`, y que haga que el mensaje de tarea sea autónomo.

El texto personalizado `injectionPrompt` puede usar los cuatro marcadores de posición:

| Marcador de posición | Reemplazado por |
| --- | --- |
| `{{model}}` | El modelo preferido efectivo para esta solicitud. Un `injectionModel` nativo desnudo solo está calificado para la cuenta cuando la solicitud se dirige a un selector de cuenta explícito. Un valor desnudo no resuelto o ambiguo se convierte en una cadena vacía; un id explícito no resuelto calificado o encaminado permanece sin cambios. |
| `{{effort}}` | El `injectionEffort` configurado, o una cadena vacía |
| `{{roster}}` | La lista resuelta de selector visible y superficie compatible |
| `{{fallback}}` | La guía de respaldo global configurada |

La guía v2 incorporada tiene un presupuesto de 700 caracteres. Si superara el presupuesto, opencodex eliminaría la lista primero en lugar de truncar las instrucciones básicas de generación. La guía integrada se activa solo cuando se resuelve un modelo preferido, una lista elegible o una cadena de reserva. Un `injectionModel` configurado es suficiente para representar un mensaje personalizado; si un valor desnudo no puede resolverse de manera única, `{{model}}` se expande a una cadena vacía.

En la v1, opencodex inyecta la misma orientación de delegación proactiva que el preajuste recomendado de v2 solo a `max` o `ultra` esfuerzo. Solo cambia el desencadenador de delegación: no se necesita ninguna solicitud de delegación por separado; todavía se aplican las instrucciones de usuario, la autoridad, el alcance de la tarea y las reglas de la herramienta de colaboración. No agrega un modelo preferido, una lista, una lista de reserva o un mensaje personalizado en la v1. En el modo de código Codex, opencodex ve las herramientas v1 cuando la descripción de la herramienta `exec` las enumera. Cuando Codex los aplaza para la búsqueda de herramientas, lo que hace para cada modelo de catálogo opencodex, opencodex se basa en la lista de herramientas diferidas que Codex Desktop envía con la conversación; si esa lista nombra `multi_agent_v1`, se agrega la guía proactiva. Un cliente Codex que no envía la lista no da opencodex ninguna señal de que v1 está disponible, por lo que la guía no se agrega allí.

La opción `syncCodexSubagentDefaults` está **desactivada por defecto** y es independiente de la guía para el agente. Si opencodex administra el enrutamiento activo de Codex, al sincronizar o reiniciar puede escribir los valores elegidos en `[agents] default_subagent_model` y `default_subagent_reasoning_effort`, con sus marcadores de propiedad, dentro del TOML de Codex. Solo actualiza o elimina campos que conservan esos marcadores. Si editas un valor administrado, la siguiente sincronización conserva tu valor, retira el marcador y trata el campo como tuyo desde entonces. La restauración también conserva esas ediciones aunque reproduzcan contenidos inyectados anteriormente. Si cualquiera de los dos campos pertenece al usuario, deja ambos intactos; un TOML ambiguo impide escribir. También respeta los gestores externos y el enrutamiento raíz definido por el usuario.

<a id="fallback-chains"></a>

## Cadenas de fallback

Para un trabajador generado, opencodex crea este orden de prioridad:

1. El modelo primario solicitado.
2. Una cadena por modelo de `subagentModelFallbackByModel` en opencodex config, tecleada por el modelo primario solicitado.
3. La lista global `subagentModelFallback` en opencodex config.

Las cadenas de reserva per-rol pertenecen a la configuración opencodex, no a la `$CODEX_HOME/agents/*.toml`. Codex 0.146+ estrictamente deserializa los archivos de rol de agente y rechaza `model_fallback` como un campo desconocido, lo que omite toda la definición de rol (#1190). opencodex todavía puede leer una línea `model_fallback` heredada del TOML para la compatibilidad con versiones anteriores, pero `ocx doctor` advierte al respecto y Codex en sí ignorará el rol afectado.

Los identificadores de modelos duplicados se eliminan mientras se conserva la primera aparición. Durante la selección, opencodex omite candidatos que están deshabilitados, no enrutables, respaldados por un proveedor deshabilitado, marcados como no saludables, dentro de un tiempo de reutilización, falta una cuenta Codex agrupada utilizable o más allá del umbral de cuota configurado. Las sondas de disponibilidad se almacenan en caché durante `subagentModelFallbackPollMs` (60 segundos por defecto).

Fallback no hace legibles las tareas cifradas incompatibles. Cuando la tarea hija se cifra para ChatGPT, la selección se restringe a ChatGPT objetivos nativos canónicos y rutas de autenticación de clave directa Responses explícitamente confiables con `allowEncryptedV2AgentTasks: true`, incluso si otro modelo externo aparece antes en la cadena. Los combos siguen siendo canónicos.

<a id="encrypted-v2-task-delivery"></a>

## Entrega de tareas cifradas v2

Codex puede enviar una tarea hijo v2 nativa a enrutada solo como `encrypted_content` encriptado en el backend. Esa carga útil puede ser leída por el backend nativo ChatGPT, pero no por un proveedor externo. Este es el conocido [limitación #92](https://github.com/lidge-jun/opencodex/issues/92).

opencodex falla de manera segura en lugar de reenviar una tarea vacía o ilegible:

- Una ruta no nativa directa inelegible devuelve HTTP 400 con `error.code = "unreadable_encrypted_agent_task"` y no hace eco del texto cifrado. Un proveedor elegible de clave directa Responses que opte explícitamente por `allowEncryptedV2AgentTasks: true` recibe el texto cifrado opaco y evita este error.
- Un combo primero considera objetivos canónicos nativos ChatGPT. Si no hay ninguno disponible o se agotan sus intentos, la recuperación habilitada puede hacer que la tarea sea legible para un destino enrutado disponible. Sin una recuperación exitosa y un objetivo elegible, el texto cifrado ilegible nunca se reenvía.
- Una tarea de texto plano legible mantiene la ruta normal y el comportamiento de reserva.

Las opciones de recuperación son seleccionar un hijo nativo ChatGPT, confiar explícitamente en un relé de clave-auth directa Responses que puede consumir la carga útil opaca, agregar un destino nativo ChatGPT al combo, usar v1 para la delegación de proveedor heterogéneo o reenviar la tarea como contenido de texto plano v2 `agent_message` cuando se controla la persona que llama.

Una opción experimental, desactivada por defecto `agentTaskRecovery` puede recuperar esta forma específica nativa a la ruta a través de un paso de Responses sin procesar al punto final fijo ChatGPT `/responses` utilizando la forma de credencial entrante utilizada por el proveedor canónico `openai` con `authMode: "forward"`. La recuperación solo está disponible mientras el proxy está vinculado a loopback. Nunca sustituye la autenticación de clave API, otra credencial de proveedor u otra cuenta Codex. Solo `authorization`, que coincide con `chatgpt-account-id`, `originator` y metadatos opcionales `openai-beta` / `user-agent` se reenvían; `content-type` y `accept` se generan localmente, y ninguna otra cabecera de llamada cruza el límite. Consume cuota, agrega latencia, retiene brevemente el texto plano recuperado en una caché en memoria limitada y depende del comportamiento del backend indocumentado ChatGPT. Debido a que un modelo devuelve el texto recuperado, la fidelidad byte por byte no está garantizada. Rechaza a los llamantes genéricos/proxy API. Recuperación fallida antes de que cualquier intento nativo devuelva `unreadable_encrypted_agent_task`; después de que los intentos nativos hayan fallado, se retiene su último error. Consulte [Configuración del agente: recuperación de tareas cifradas v2](/es/reference/configuration/agents/#encrypted-v2-task-recovery) para conocer los límites y la configuración de confianza completos.

La misma recuperación también cubre un hilo en vivo cambiado de un modelo nativo ChatGPT a uno enrutado. Tal hilo reproduce un mensaje de agente cifrado acuñado en cada turno posterior, por lo que antes de [#4089](https://github.com/lidge-jun/opencodex/issues/4089) falló en cada turno y la única solución fue comenzar un nuevo hilo. Ese turno de interruptor no es un turno de aparición, por lo que la ruta directa ya no restringe la recuperación a turnos de subagentes creados; la recuperación combinada aún lo hace.

El enrutamiento combinado prefiere un objetivo canónico nativo seleccionable ChatGPT para tareas cifradas. Si ninguno es utilizable, o los intentos de autorización nativa se agotan, una recuperación habilitada explícitamente puede hacer que la tarea sea legible para un destino enrutado disponible. Toda la confianza de recuperación y los protectores de no persistencia anteriores siguen siendo aplicables; un objetivo nativo configurado pero deshabilitado o que se enfría no bloquea esta reserva, y la cancelación nunca se convierte en un error de tarea ilegible.

<a id="rejected-encrypted-history"></a>

## Rechazado el historial cifrado

Un servidor upstream Responses puede rechazar partes cifradas en la salida anterior de la función/herramienta personalizada o el contenido `agent_message` con `Encrypted function output content could not be decrypted or decoded.`. Antes de que se confirme cualquier salida, opencodex reemplaza esas partes con `[encrypted content omitted]` y reconstruye la solicitud una vez. El contenido legible circundante permanece intacto; el contenido omitido no es descifrado o recuperado por este reintento.

Si la solicitud reconstruida recibe otro SSE `error` desnudo seguido por EOF, ambos modos de retransmisión conservan el mensaje de error en un terminal `response.failed` en lugar de informar `adapter_eof`. Otros `response.failed` eventos aguas arriba siguen SSE fallas. Esta recuperación de historial no cambia las restricciones de entrega de tareas v2 cifradas descritas anteriormente.

<a id="changing-the-mode"></a>

## Cambiar el modo

### GUI

- **Tablero** → primera celda de estadística: elija **v1**, **base** o **v2**.
- **Modelos** → control segmentado de la fila superior: elija el mismo modo global.
- **Tablero** → **Delegación de subagentes**: establece el modelo/esfuerzo de guía y la opción de opt-in por defecto nativa.
- **Subagentes**: elija y ordene la lista y configure la cadena de reserva global.

### CLI

Utilice `ocx v2` para la configuración de la superficie de colaboración y las funciones nativas:

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 mode v2
ocx v2 threads 8
```

Utilice `ocx agent` para la configuración de delegación, lista, límite de esfuerzo y reserva:

```bash
ocx agent status
ocx agent injection set --model anthropic/claude-sonnet-5 --effort xhigh
ocx agent injection suggest "read-only searches across the repo" --apply
ocx agent subagents set gpt-5.6-sol,anthropic/claude-sonnet-5
ocx agent fallback set gpt-5.6-luna,xai/grok-4.5 --poll-ms 60000
ocx effort set --subagent max
```

El comando de nivel superior `ocx effort` es el punto de entrada canónico para la inspección de esfuerzo y tapas (p. ej. `ocx effort high`, `ocx effort status`, `ocx effort clear`), con `ocx agent effort` preservado como una ruta compatible con versiones anteriores. Obsérvese que `ocx effort clear` elimina las tapas de agente principal y subagente activo mientras deja intacta la delegación `injectionEffort` (use `ocx effort set --injection -` o `ocx agent injection set --effort -` para borrar el esfuerzo de inyección).

Pase `-` para borrar un valor nullable de `ocx agent injection`, o use la acción relevante de `clear` para una lista o lista de reserva. Vea el [CLI referencia](/es/reference/cli/) para todas las familias de comando.

### API

La gestión API expone los puntos finales coincidentes `GET` y `PUT`:

| Punto final | Administra |
| --- | --- |
| `/api/v2` | Modo de superficie, bandera de función nativa y configuración de subprocesos |
| `/api/injection-model` | Modelo preferido, esfuerzo, prompt personalizado, orientación y sincronización predeterminada nativa |
| `/api/effort-caps` | Límites máximos de esfuerzo del agente principal y del subagente |
| `/api/subagent-models` | Lista de pedidos de hasta cinco modelos |
| `/api/subagent-model-fallback` | Orden de reserva global e intervalo de encuesta |

Por ejemplo:

```bash
curl -X PUT http://localhost:10100/api/v2 \
  -H 'Content-Type: application/json' \
  -d '{"multiAgentMode":"v2"}'

curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model":"anthropic/claude-sonnet-5","effort":"xhigh"}'
```

## FAQ

<a id="does-choosing-a-delegation-model-force-codex-to-spawn-it"></a>

### ¿La elección de un modelo de delegación obliga a Codex a generarlo?

No. La guía puede recomendar un modelo, y la sincronización nativa predeterminada puede proporcionar un valor predeterminado de Codex, pero el agente principal aún decide si delegar.

<a id="why-did-my-v2-child-use-the-parent-model"></a>

### ¿Por qué mi subagente v2 usó el modelo principal?

Una bifurcación v2 con el historial completo hereda el modelo del agente principal. Para indicar otro modelo o esfuerzo de razonamiento al crear el subagente, establezca `fork_turns` en `"none"` o en un recuento parcial positivo.

<a id="why-is-a-configured-model-missing-from-the-v2-roster"></a>

### ¿Por qué falta un modelo configurado en la lista de v2?

Puede estar oculto por el selector, fuera del límite de visualización de cinco modelos, falta en el catálogo o anclado a v1. Un `"v2"`, `null`, o el valor de superficie ausente es elegible; un verdadero `"v1"` pin no lo es.

<a id="why-does-spawn_agent-list-models-i-did-not-feature"></a>

### ¿Por qué `spawn_agent` muestra modelos que no destaqué?

Codex completa hasta cinco posiciones según la prioridad de las filas del catálogo. Si destacas menos de cinco modelos, las filas siguientes ocupan los espacios restantes. Véase [Qué modelos anuncia `spawn_agent`](#which-models-spawn_agent-advertises).

<a id="do-mode-changes-affect-running-sessions"></a>

### ¿Los cambios de modo afectan a las sesiones en ejecución?

No. Inicie una nueva sesión Codex después de cambiar el modo. Si un host de aplicaciones de larga duración aún muestra un estado de catálogo obsoleto, ejecute `ocx sync` y reinicie esa superficie Codex.

<a id="what-happens-when-opencodex-cannot-trust-the-catalog"></a>

### ¿Qué sucede cuando opencodex no puede confiar en el catálogo?

opencodex compara el catálogo del modelo en el disco con la hora de inicio de cada Codex app-server propiedad del usuario actual, produciendo uno de los cuatro estados:

| Estado | Descripción | v2 Orientación |
|---|---|---|
| `fresh` | Todos los servidores de aplicaciones comenzaron después de que se escribió el catálogo | Orientación completa: modelo preferido, plantel, fallbacks |
| `not_running` | No se detectó ningún servidor de aplicaciones | Orientación completa |
| `stale` | Al menos un servidor de aplicaciones precede al catálogo | **No opencodex - Guía del modelo** |
| `unknown` | La comparación no se pudo hacer | **No opencodex - Guía del modelo** |

Para `stale` y `unknown`, opencodex retiene sus propias reclamaciones derivadas del disco - modelo preferido, lista, reserva y orientación personalizada - porque el Codex en ejecución puede no ser capaz de generar lo que anuncia el catálogo de discos.

Esto **no** indica al modelo que deje de configurar `model` o `reasoning_effort`. La observación abarca todos los app-servers del usuario, mientras que la solicitud entrante no identifica al proceso que la envió. Por tanto, no se puede atribuir un proceso obsoleto a esa solicitud. Prohibir las anulaciones basándose en esa observación bloquearía opciones que la herramienta activa `spawn_agent` puede anunciar legítimamente en una sesión nueva. El esquema de la herramienta activa sigue siendo la autoridad.

`unknown` no es sinónimo de `stale`. Significa que la comparación en sí falló - una marca de tiempo de catálogo ilegible, un tiempo de inicio de proceso ilegible o una enumeración de proceso fallido - y se informa por separado por `ocx doctor`. `stale` se borra solo después de que cada Codex app-server detectado se inicia después de la escritura final del catálogo; no necesariamente se borra `unknown`.

En Windows, esta comprobación de aviso utiliza el descubrimiento asíncrono de PowerShell/CIM en la ruta de solicitud v2. Las comprobaciones en frío simultáneas comparten un descubrimiento en vuelo. Los estados observados se almacenan en caché durante cinco segundos; un error `unknown` se almacena en caché durante solo 250 milisegundos, por lo que un error CIM transitorio se reintenta rápidamente. Una consulta de CIM lenta o defectuosa puede retrasar o suprimir solo la guía del modelo OpenCodex; no bloquea el bucle de eventos Bun, `/healthz` o el tráfico proxy no relacionado. Las operaciones explícitas del ciclo de vida CLI /service conservan el recopilador de procesos síncrono y cerrado por error, ya que pueden señalar procesos.

Solo un cambio real cuenta. Una sincronización cuyo resultado es idéntico en bytes al catálogo ya en disco deja el archivo intacto, por lo que reiniciar el proxy o volver a sincronizar un conjunto de modelos sin cambios no hace que un Codex en ejecución parezca obsoleto.

<a id="reasoning-effort"></a>

### Esfuerzo de razonamiento

`injectionEffort` afecta solo a la orientación del trabajador delegado y, cuando está explícitamente habilitada, a los valores predeterminados del subagente Codex nativo. No cambia el esfuerzo de la sesión de padres. `ultra` es un nivel superior orientado al cliente que Codex convierte a `max`; opencodex luego mapea o fija el valor para el proveedor seleccionado.

<a id="context-cap"></a>

### Cap. de contexto

El límite de contexto del modelo es independiente del modo de subagente. Configure en la página Modelos; los modelos nativos OpenAI conservan sus ventanas de contexto real.

El campo experimental `plaintextV2AgentMessages` no se establece en una nueva configuración y se ejecuta solo cuando se establece en `true`. La persona que llama debe usar el cable Responses y el destino final debe usar `adapter: "openai-responses"`, `authMode: "forward"` y la URL base exacta `https://chatgpt.com/backend-api/codex`. OpenAI API - proveedores clave, pasarelas compatibles personalizadas, rutas a otros proveedores, y no Responses personas que llaman están excluidos. Para una nueva llamada a la herramienta ChatGPT v2 nativa elegible, la opción asigna alias con alcance de solicitud al espacio de nombres y tres nombres reservados de la herramienta de mensajes, elimina el marcador de mensajes y restaura las identidades originales en la respuesta. Maneja `spawn_agent`, `send_message` y `followup_task` y no agrega ninguna petición de recuperación. HTTPS permanece encriptado, pero el texto de la tarea se puede conservar en el historial Codex, las solicitudes del proveedor de rutas y el estado de respuesta/depuración local. El texto cifrado existente no cambia, y la opción depende del comportamiento indocumentado ChatGPT y Codex. Véase [Configuración del agente: Mensajes de agente de texto sin formato v2](/es/reference/configuration/agents/#plaintext-v2-agent-messages). Si una respuesta de flujo continuo ChatGPT no lleva ningún tipo de contenido, o una que no es ni `application/json` ni un flujo de eventos reconocible, opencodex comprueba un prefijo de evento Responses limitado antes de restaurar los nombres de herramienta de mensaje. Una respuesta `application/json` toma el camino JSON limitado en su lugar. La sonda espera como máximo `stallTimeoutSec` por su prefijo, y un cuerpo que permanece silencioso, no reconocido o ilegible falla en cerrarse en lugar de alcanzar Codex como una respuesta exitosa.
