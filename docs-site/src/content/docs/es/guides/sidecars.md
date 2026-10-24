---
title: "Sidecars: búsqueda web y visión"
description: "Añade búsqueda web y comprensión de imágenes a los modelos enrutados mediante sidecars de ChatGPT, Anthropic y otros backends explícitos."
---

No todos los modelos enrutados ofrecen **búsqueda web alojada** o **entrada de imágenes** de forma nativa. opencodex cubre esas capacidades con dos sidecars. Ambos admiten una sesión de ChatGPT mediante un proveedor `forward` o credenciales Anthropic OAuth guardadas. La búsqueda también admite Grok OAuth con el backend `xai` seleccionado explícitamente. Los errores del sidecar se devuelven como resultados de herramienta o marcadores de imagen, sin hacer fallar todo el turno.

:::note[Selección automática del backend]
La configuración explícita de `backend` tiene prioridad. Cuando no se configura, cada sidecar usa su propio valor predeterminado:
**Búsqueda web** usa `openai` por defecto; `anthropic` y `xai` solo se usan cuando se configuran explícitamente. El backend de búsqueda web `xai` requiere una cuenta Grok OAuth almacenada y utilizable, y no cambia a otro backend si esa cuenta no está disponible.
**Visión** usa `anthropic` cuando un proveedor Anthropic OAuth habilitado tiene una cuenta activa que no está marcada como `needsReauth`; de lo contrario, usa `openai`. Seleccionar `anthropic` explícitamente sin esa credencial rechaza la operación. Visión solo admite `openai`, `anthropic` y `routed`; los modelos de visión xAI elegibles usan `routed`. Para ambos sidecars, `openai` requiere autenticación de inicio de sesión ChatGPT y un proveedor `forward` habilitado.
:::

<a id="additional-web-search-backends-explicit-only"></a>

### Backends de búsqueda web adicionales (solo explícitos)

Además de ChatGPT y Claude, hay tres backends de búsqueda adicionales. Todos requieren **selección explícita**: encontrar una credencial no los activa. Si falta la credencial necesaria, no se crea un plan de sidecar ni se sustituye por otro backend; la solicitud sigue la ruta normal.

| Backend | Ejecución | Credenciales | Notas |
| --- | --- | --- | --- |
| `xai` | Grok alojado `web_search` (+ opt-in `x_search` ) en `api.x.ai` Responses | Almacenado Grok OAuth (`ocx login xai`) | `webSearchSidecar.xSearch` permite la búsqueda X con `allowedXHandles` / `excludedXHandles` (máximo 20, mutuamente excluyentes) e ISO `fromDate` / `toDate`. Modelo predeterminado `grok-4.6`. |
| `gemini` | `google_search` puesta a tierra en el transporte Antigravity | Almacenado Antigravity OAuth con un proyecto descubierto (`ocx login google-antigravity`) | Modelo predeterminado `gemini-3.8-flash`; el razonamiento selecciona el nivel coincidente. |
| `exa` | Exa Search API (resumen de resultados no LLM) | `webSearchSidecar.exaApiKey` | La clave es solo escritura a través de la administración API (nunca se hizo eco, se redactó desde los registros). No se aplica ningún modelo de sidecar. |

<a id="web-search-sidecar"></a>

## Sidecar de búsqueda web

Cuando Codex solicita `web_search` para un modelo enrutado sin paso, opencodex:

1. **Sustituye** la herramienta alojada `web_search` por una función sintética `web_search(query)` que el modelo enrutado puede invocar. Conserva las opciones originales para la llamada al sidecar.
2. Ejecuta el modelo en un pequeño **bucle de agente**. Cuando llama a `web_search`, el sidecar OpenAI usa `web_search` con `gpt-5.6-luna` por defecto; el de Anthropic usa `web_search_20250305` con `claude-sonnet-5`. La respuesta y sus citas se convierten en un resultado de herramienta. El backend xAI usa la búsqueda alojada `web_search` con `grok-4.6` por defecto y añade `x_search` a la misma solicitud si está habilitado.
3. **Repite** hasta que el modelo responda o el total de consultas reales alcance `maxSearchesPerTurn` (3 por defecto). Al alcanzar el límite, retira la herramienta de búsqueda y solicita una respuesta final. Las llamadas a herramientas reales del cliente, como `apply_patch` o shell, terminan el turno para que Codex las reciba.

Cuando el modelo agrupa varias consultas en una llamada `web_search`, sus resultados comparten un resultado de herramienta de 8.000 caracteres. El presupuesto se divide entre las consultas antes de que se corte nada, por lo que ninguna consulta desaparece del resultado. Las respuestas acortadas y las fuentes no listadas están marcadas con sus tamaños originales, lo que permite que el modelo indique los resultados recortados de las búsquedas que no encontraron nada. Los giros de salida estructurada reciben la misma información que un documento válido JSON. Si una llamada solicita más consultas de las que un resultado puede describir, opencodex enumera el estado de cada consulta sin su contenido y cuenta las consultas que no pudo enumerar.

Cada iteración del modelo enrutado solicita `stream: true` al proveedor. Sin embargo, opencodex almacena por defecto todos los eventos semánticos antes de decidir si buscar o devolver la respuesta final. Solo obtiene de inmediato el estado y los encabezados finales de la primera iteración, junto con sus rotaciones de claves por 429. Las llamadas sintéticas de búsqueda y las salidas preliminares no se muestran al cliente como salida del modelo.

La opción `webSearchSidecar.streamRoutedModelOutput`, desactivada por defecto (`false`), transmite en vivo los deltas iniciales de texto y razonamiento de cada iteración, igual que la ruta sin sidecar. Esa ventana de transmisión se cierra definitivamente al comenzar la primera llamada a herramienta; la decisión de interceptar `web_search` sigue siendo atómica y la reproducción final omite lo ya transmitido. Esto hace visible el texto emitido antes de decidir buscar, que el modo almacenado descartaría, y parte de ese texto puede repetirse en la respuesta posterior. La vista general ofrece **Transmitir respuestas en vivo** en la tarjeta de búsqueda web (`PUT /api/sidecar-settings`, campo `webSearch.streamRoutedModelOutput`).

Esta opción también se aplica a los adaptadores que gestionan sus propios turnos, incluidos Devin y Cursor. Cuando los sidecars de búsqueda y de imagen/vídeo son elegibles, la búsqueda tiene prioridad. Un primer evento OAuth 429 gira la cuenta en la solicitud inicial y en cada solicitud de respuesta posterior a la búsqueda, reproduciendo la solicitud con la herramienta de búsqueda y los resultados recopilados. La cancelación de una solicitud detiene las búsquedas posteriores, y la salida del bucle de búsqueda retenido comparte el límite de la memoria intermedia de traducción de la solicitud; exceder ese límite falla la respuesta en lugar de iniciar otra iteración del modelo.

El texto de la fase de comentario de Kiro es independiente de esta opción: ya se transmite antes del evento terminal en el modo almacenado. Con o sin `streamRoutedModelOutput`, solo se retienen los eventos necesarios para decidir si buscar —las llamadas a herramientas y todo lo posterior al inicio de la primera llamada— hasta resolver la interceptación atómica de `web_search`.

El resultado inyectado se envuelve en un límite de datos no confiables, con límite de longitud y desduplicado por URL de origen. En los giros de salida estructurada (`json_schema` / `json_object`) se entrega como compacto JSON en lugar de prosa. Para los modelos con ruta de solo texto, también se le dice al modelo de búsqueda que describa imágenes relevantes en palabras e incluya sus URL de origen.

```json
{
  "webSearchSidecar": {
    "enabled": true,
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "reasoning": "low",
    "maxSearchesPerTurn": 3,
    "routedModelStallTimeoutMs": 200000,
    "timeoutMs": 200000,
    "streamRoutedModelOutput": false
  }
}
```

El backend explícito xAI usa la credencial almacenada creada por `ocx login xai`. Su bloque opcional `xSearch` permite la búsqueda X y puede restringirlo a una lista de identificadores y un rango de fechas ISO:

```json
{
  "webSearchSidecar": {
    "backend": "xai",
    "model": "grok-4.6",
    "xSearch": {
      "enabled": true,
      "allowedXHandles": ["xai"],
      "fromDate": "2026-08-01",
      "toDate": "2026-08-21"
    }
  }
}
```

`allowedXHandles` y `excludedXHandles` son mutuamente excluyentes y admiten como máximo 20 cadenas cada uno. Las fechas usan `YYYY-MM-DD`. Una escritura mal formada en la API de administración devuelve `400`. Si el bloque persistido es inválido, se rechaza el plan en lugar de ampliar la búsqueda silenciosamente.

El razonamiento `minimal` no se utiliza porque el backend alojado rechaza las herramientas en ese esfuerzo. Una búsqueda fallida se devuelve al modelo enrutado como un resultado de error limitado, lo que le permite responder desde el contexto que ya tiene.

Hay cuatro tiempos de espera independientes. `stallTimeoutSec` es el límite base de inactividad de eventos del puente. `connectTimeoutMs` (`200000` por defecto) cubre únicamente DNS, TCP, TLS y los encabezados finales. `webSearchSidecar.routedModelStallTimeoutMs`, disponible solo en el archivo de configuración (`200000` por defecto, entero `1..2147483647`), limita la inactividad de bytes de respuesta de cada iteración del modelo y se reinicia con cada byte no vacío. `webSearchSidecar.timeoutMs` limita por separado cada solicitud de búsqueda alojada. El watchdog efectivo del puente usa `max(base stall, connect timeout, routed-model stall, sidecar timeout) + 30 seconds`. El límite de inactividad del modelo no es un límite de duración total de generación. Si el error ocurre antes de iniciar SSE, se devuelve JSON con un estado no 2xx; si ocurre después de enviar los encabezados, se comunica mediante SSE `response.failed`.

<a id="vision-sidecar"></a>

## Sidecar de visión

El preajuste del proveedor registra `zai-glm-5-3` de Mistral como modelo de solo texto. Si el sidecar de visión está habilitado y disponible, OpenCodex describe las imágenes adjuntas y envía sus descripciones a GLM. El catálogo de Codex anuncia adjuntos de imagen para esta ruta. Después de actualizar, ejecuta `ocx sync` y cierra por completo y vuelve a abrir Codex Desktop, o recarga la ventana de VS Code. Sin una opción de reinicio, la sincronización no reinicia un app-server existente de Codex, que puede conservar el catálogo anterior. También puedes usar `ocx sync --restart-codex` para sincronizar y reiniciar los procesos de Codex coincidentes y Desktop. Termina antes el trabajo activo: ese reinicio finaliza las conversaciones en curso. Consulta la [referencia de sincronización y reinicio](/es/reference/cli/lifecycle/#ocx-sync---restart-codex---restart-app-server-only). Después de abrirlo de nuevo, elige `mistral/zai-glm-5-3` y comprueba que puedas adjuntar imágenes. No necesitas modificar la modalidad del modelo. Mistral documenta la entrada nativa en su [referencia de GLM 5.3](https://docs.mistral.ai/models/zai-glm-5-3).

El enrutamiento de imágenes tiene en cuenta las capacidades del modelo. Antes del envío, opencodex resuelve sus modalidades de entrada a partir de evidencia del proveedor en ejecución, declaraciones explícitas del operador, metadatos del backend y del registro, y metadatos generados. Si el destino es de solo texto, el sidecar describe la imagen **antes** de la llamada principal y la reemplaza por texto en su posición original. Si se confirma que admite imágenes, las recibe directamente. Para los modelos personalizados desconocidos se conserva el comportamiento de compatibilidad, sin suponer que son de solo texto.

Para la ruta canónica ChatGPT Codex, opencodex utiliza el paquete de metadatos `openai-codex` en lugar de los metadatos públicos OpenAI API, por lo que se respetan las diferencias de modalidad específicas del backend. La ruta rápida nativa de Chat utiliza la misma puerta y no puede omitir un veredicto conocido de solo texto. Sin un plan de sidecar disponible, las imágenes en bruto se eliminan antes de un backend probado solo de texto. Con `visionSidecar.enabled: false`, el catálogo de modelos no agrega entrada de imagen respaldada por sidecar a los modelos de solo texto, incluidas las filas personalizadas y los miembros combinados. Se conservan el soporte de imagen nativa y las modalidades de imagen configuradas explícitamente. Omitir `enabled` mantiene activado el anuncio de sidecar; la visibilidad del catálogo no establece que las credenciales o la capacidad de sidecar estén disponibles. Los combos anuncian la entrada de imágenes solo cuando cada miembro acepta imágenes, ya sea de forma nativa o a través de un sidecar habilitado, y la configuración `imageInput` del combo no está deshabilitada, por lo que los clientes como la aplicación Codex permiten archivos adjuntos en lugar de bloquearlos antes de que se ejecute el sidecar. Cuando `visionSidecar.model` está ausente o en blanco, la ruta de ejecución OpenAI, el tablero de instrumentos y la administración API usan el retroceso `gpt-5.6-luna`. El inicio sigue migrando un valor `gpt-5.4-mini` heredado explícitamente persistente a `gpt-5.6-luna`; esa migración se aplica a un valor almacenado, no a un campo de modelo ausente. Guardar un combo multimodal desde el panel inscribe automáticamente a sus miembros que no son imagen: la página Combos los envía como `visionSidecarTargets` en `PUT /api/combos`, que escribe la declaración exacta de solo texto en el proveedor del miembro, por lo que no se necesita editar y recargar la configuración manual. La inscripción nunca sobrescribe una declaración con capacidad de imagen existente, y los miembros cuyas modalidades son desconocidas o no tienen entrada de texto no están inscritos: el panel los nombra y mantiene el interruptor de imagen del combo no disponible. El modelo DeepSeek `deepseek-flash` de origen es multimodal nativo (`text` y `image`) y no usa este sidecar por defecto. `noVisionModels` explícitas o declaraciones de solo texto siguen siendo autoritativas. El primer partido `deepseek-chat`, `deepseek-reasoner` y `deepseek-v4-flash` permanece respaldado por sidecar por defecto; Las rutas Zen no han cambiado y no se probaron en esta actualización.

- Las imágenes pueden provenir de mensajes de usuario, desarrollador y resultado de herramientas, incluidos los `view_image` de Codex.
- En la ruta OpenAI (paso de inicio de sesión ChatGPT), cada imagen se envía al modelo de visión configurado sobre el punto final Responses con el `reasoning.effort` seleccionado (`low` por defecto), y su descripción reemplaza la parte de imagen en línea. La ruta Anthropic utiliza el punto final Messages con su propia asignación de pensamiento-presupuesto e ignora esta configuración específica OpenAI.
- Para los modelos nativos con metadatos de capacidad conocidos, el razonamiento no compatible se normaliza al peldaño más alto soportado en o por debajo del nivel solicitado; si no existe ninguno, se usa el peldaño más bajo soportado. Los modelos desconocidos o personalizados siguen siendo permisivos cuando no hay metadatos de capacidad confiables.
- Las descripciones se ejecutan con concurrencia limitada (3 a la vez, orden de entrada preservado). El contexto del usuario enviado al descritor tiene un límite de 800 caracteres, y cada descripción inyectada tiene un límite de 2.000 caracteres. La solicitud no envía `max_output_tokens`, que el backend ChatGPT rechaza.
- Las URL de las imágenes se validan antes del reenvío: las URL de datos deben usar `png` / `jpeg` / `jpg` / `webp` / `gif`, y los datos de base64 están limitados a aproximadamente 20 MB. Solo se aceptan los esquemas `data:` y `https:`; las imágenes `https` remotas son buscadas por el backend OpenAI, no por el proxy.
- La coincidencia de `noVisionModels` ignora un sufijo Ollama-style `:size`, por lo que una entrada `gpt-oss` también cubre `gpt-oss:120b`.
- Si falla la descripción, el modelo recibe un marcador de error de procesamiento corto. (Sin un plan de sidecar disponible, no se intenta ninguna descripción - la imagen sin procesar se elimina, como se describió anteriormente).
- `maxDescriptionsPerTurn` (por defecto 8) limita las nuevas descripciones por turno de modelo principal. Los golpes de caché y los duplicados del mismo turno no lo consumen. Las descripciones de imágenes exitosas de `data:` se almacenan en caché por backend, modelo, detalle, bytes de imagen y contexto de mensaje, más el esfuerzo de razonamiento en las claves de caché de OpenAI (las de Anthropic lo omiten, ya que ese campo se ignora allí); las imágenes mutables de `https:` no se almacenan en caché.

La API de administración y el selector del dashboard muestran modelos capaces de aceptar imágenes. Si está disponible el backend correspondiente, siempre se ofrecen `gpt-5.6-luna` (OpenAI) y `claude-haiku-4-5` (Anthropic) como opciones de referencia. `PUT /api/sidecar-settings` puede conservar un identificador personalizado o aún desconocido por el catálogo. Un sidecar de visión enrutado configurado explícitamente sigue siendo utilizable salvo que la evidencia demuestre que no acepta imágenes. Así se conserva la elección del operador sin enviar bytes de imagen a un modelo confirmado como de solo texto.

```json
{
  "visionSidecar": {
    "enabled": true,
    "backend": "openai",
    "model": "gpt-5.6-luna",
    "reasoning": "medium",
    "maxDescriptionsPerTurn": 8,
    "timeoutMs": 45000
  }
}
```

Un modelo está marcado solo con texto por proveedor:

```json
{
  "providers": {
    "ollama-cloud": {
      "baseUrl": "https://ollama.com/v1",
      "noVisionModels": ["glm-5.2", "gpt-oss", "qwen3-coder", "deepseek-v4-flash"]
    }
  }
}
```

<a id="dashboard-controls-and-disabling"></a>

## Controles del panel de control y desactivación

La tarjeta del sidecar de visión en el dashboard permite activarlo o desactivarlo y configurar `maxDescriptionsPerTurn` y `timeoutMs`, además del modelo, el backend y el razonamiento. Desactivarlo conserva todos esos ajustes para la próxima activación.

`PUT /api/sidecar-settings` acepta los mismos campos. Las actualizaciones parciales no modifican las claves omitidas. `timeoutMs` admite enteros entre 1 y 2147483647 ms, los mismos límites del entorno de ejecución.

Si cambia el estado efectivo del sidecar de visión, al guardar también se actualizan el catálogo administrado de Codex y la caché de modelos. Si la actualización no termina, la respuesta incluye `catalogRefreshPending: true`. El ajuste guardado se conserva. Publicar el catálogo no demuestra que un cliente en ejecución lo haya recargado.

La tarjeta del sidecar de búsqueda web tiene un control equivalente: la primera opción del selector es **Desactivado**. Elegirla tiene dos efectos: OpenCodex deja de interceptar `web_search` y la integración de Codex escribe `web_search = "disabled"` en `~/.codex/config.toml`. Codex sigue anunciando su herramienta alojada `web_search` hasta que su propia configuración la desactiva; el modelo puede llamar a cualquier herramienta anunciada. Para que un servidor MCP sea la única vía de búsqueda, se necesitan ambos cambios.

`web_search` es una clave de Codex con los valores `disabled`, `cached`, `indexed` y `live`. OpenCodex solo escribe `disabled` mientras el sidecar está desactivado y retira la línea de su propiedad al volver a activarlo: si la herramienta nativa siguiera desactivada, no habría llamadas que interceptar. Esta escritura requiere que `~/.codex/config.toml` esté administrado mediante `ocx sync`. La respuesta de administración la informa como `codexWebSearch`; la tarjeta de búsqueda advierte si no se pudo escribir y `ocx agent sidecar web --enabled off` indica si se escribió. Solo se intenta cuando al guardar cambia el estado efectivo. Si no cambió, se devuelve `not_requested` y no se imprime información adicional. Si el operador había configurado manualmente una línea raíz `web_search`, se reemplaza mientras el sidecar está desactivado para evitar claves TOML duplicadas. Su texto exacto se guarda en el diario de Codex y se restaura en su ubicación al reactivar el sidecar, incluso si la línea se añadió después de la instantánea del diario, algo que `ocx restore` por sí solo no puede cubrir. Ese registro también permite reconocer la línea `disabled` de OpenCodex si Codex reescribe `config.toml` y elimina el comentario de propiedad.

También puedes establecer `enabled: false` directamente en `config.json`. La búsqueda y la descripción de imágenes mediante Anthropic OAuth reutilizan la identificación existente de Claude Code OAuth, pero requieren pruebas prolongadas con la cuenta y la carga de trabajo previstas.

Vea el [Referencia de configuración](/es/reference/configuration/server/#sidecars) para cada campo.
