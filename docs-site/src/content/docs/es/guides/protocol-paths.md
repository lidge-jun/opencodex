---
title: "Rutas de protocolo"
description: "Cómo una solicitud en el Responses, Chat Completions o Messages API llega a un proveedor, cómo obtener una vista previa y rastrear esa ruta, y los switches por etapas que la cambian."
---

opencodex sirve a tres API de cliente: **Responses** (`/v1/responses`), **Chat Completions** (`/v1/chat/completions`) y **Messages** (`/v1/messages`). Cada proveedor recibe un cable ascendente, decidido por su adaptador. Cuando el cliente API y el cable ascendente difieren, la solicitud se convierte en el camino de entrada y la respuesta se convierte en el camino de regreso. Esta página explica cómo se nombra esa ruta, cómo verla antes y después de una solicitud y qué ajustes la cambian.

Los ajustes de esta página están desactivados de forma predeterminada, salvo `antigravityDirect`, que está activado. Esta excepción permite la ruta directa de Antigravity cuando corresponde; las demás opciones requieren activación explícita.

<a id="delivery-modes"></a>

## Modos de entrega

Una ruta es una lista de saltos desde el cliente API al cable ascendente. Los saltos son los tres API nombres, `ir` (petición de adaptador-neutral de opencodex y formulario de evento), y `responses-internal` (Responses JSON o SSE producido sólo como un puente interno, nunca visto por un cliente).

| Modo | Descripción | Ruta de solicitud de ejemplo |
| --- | --- | --- |
| `native` | Mismo API en ambos extremos; el cuerpo del cliente es lo que recibe el proveedor | `chat > chat` |
| `translated` | Convertido una vez, a través del códec del cable de destino o el IR | `chat > responses`, `responses > ir > messages` |
| `legacy-bridge` | Convertido a través de la forma interna Responses primero | `chat > responses-internal > ir > messages` |
| `blocked` | Rechazado antes de que nada fuera enviado | Ninguno |

`native` describe cómo viaja una solicitud. No es un veredicto de compatibilidad: una ruta nativa todavía puede cumplir con un proveedor que rechaza un campo, y los resultados verificados de Compatibility Lab son una cosa separada.

Con cada apagado, una ruta de proveedor único elegible toma estos caminos:

| Cliente API → aguas arriba | Ruta |
| --- | --- |
| Responses → Responses | Nativo |
| Responses → Chat o Messages | Traducido a través de IR |
| Chat → Chat | nativo (JSON cuando el cliente envía `stream: false`) |
| Chat → Responses, Messages → Responses | traducido a través del codec Responses |
| Chat → Messages, Messages → Chat | Puente legado |
| Messages → Messages | nativo solo cuando el llamante reenvía su propia credencial Anthropic; el puente heredado para una clave opencodex administra |

Los combos, las políticas de enrutamiento y el esfuerzo sintético o las filas de modelos rápidos toman el puente heredado de Chat y Messages a menos que un interruptor a continuación indique lo contrario.

<a id="feature-effects"></a>

## Efectos de función

Algunas características de solicitud no pueden sobrevivir a cada conversión. Por ejemplo, los campos de Chat `n`, `logprobs`, `logit_bias`, `seed`, `audio` y `prediction` no tienen lugar en un cuerpo Responses, y el campo Messages `top_k` se deja caer en el camino hacia Responses. opencodex registra cada efecto como `passthrough`, `translated`, `degraded` o `unsupported` (mostrado como *Caído* en el tablero de instrumentos). Estos se declaran desde el código de los convertidores; no son resultados medidos.

<a id="preview-a-path"></a>

## Previsualizar una ruta

Una vista previa se calcula solo a partir de su configuración. No envía nada a ningún proveedor, no avanza la rotación combinada y no se registra.

- Panel de control: **API** página, **Solicitar vista previa de ruta**.
- CLI:

  ```bash
  ocx api explain --model combo/main --inbound chat --feature request.seed
  ocx api explain --model claude-sonnet-4-5 --inbound messages --json
  ```

La vista previa enumera cada ruta candidata con su ruta de solicitud, modo de entrega, efectos de características y si la política `reject` (abajo) la rechazaría. `ocx api protocols --json` enumera los nombres de las características que acepta. Una solicitud Messages que reenvía la propia credencial Anthropic del llamante se muestra con `caller-credential-required` en lugar de suponerse, porque una vista previa no tiene llamante.

<a id="trace-a-request"></a>

## Rastrear una solicitud

Cada solicitud que llegó a un proveedor, o fue rechazada antes de enviar, registra la ruta que realmente tomó en su fila de registro: el modo final y las rutas, las razones, los efectos de las características y una ruta por intento físico. En el panel de control, **Troncos** muestra una insignia de ruta, un filtro **Ruta de protocolo** y una sección **Ruta de protocolo** en el detalle de la solicitud. Las filas más antiguas no tienen datos de trayectoria y lo dicen; nada se adivina.

<a id="unrepresentable-features"></a>

## Características irrepresentables

`protocols.unrepresentable` decide lo que sucede cuando una solicitud lleva una característica que su trayectoria caería:

- `legacy` (predeterminado): la solicitud se envía como antes, y la pérdida solo aparece en los efectos de la característica de seguimiento.
- `reject`: la solicitud se rechaza con HTTP 400 antes de que se envíe nada, nombrando solo las claves de características. Chat respuestas `invalid_request_error` con código `unsupported_feature`; Messages respuestas `invalid_request_error`. El trazo es `blocked`.

Bajo `reject`, una ruta directa se juzga en el ingreso una vez que su proveedor y el alambre se establecen. Los combos y las políticas no se juzgan en el ingreso; con `nativeChatCombos` encendido, un combo de Chat juzga a cada candidato y omite uno que no puede llevar la solicitud.

<a id="rollout-switches"></a>

## Interruptores de despliegue

Estos interruptores preparan los nuevos caminos. Cada uno por defecto está apagado excepto `antigravityDirect`, y un interruptor que está apagado no cambia nada.

| Interruptor | Cuando esté |
| --- | --- |
| `nativeChatCombos` | Un candidato de chat elegible dentro de un combo se envía de forma nativa desde su propia copia del cuerpo del cliente; los otros candidatos mantienen el puente. |
| `managedMessagesNative` | Una solicitud Messages cuya ruta es un proveedor de Anthropic autenticado por clave directa se envía como Messages en lugar de a través del puente. Las rutas que necesitan un comportamiento de solo puente (un esfuerzo anclado, elisión de habilidades bloqueadas, el sidecar de búsqueda web, preprocesamiento de visión, filas sintéticas) permanecen en el puente. |
| `managedMessagesNativeOAuth` | Nativo Messages para el proveedor sin agrupar `anthropic` OAuth en `api.anthropic.com`. Efectivo solo junto con `managedMessagesNative`; un conjunto de cuentas Anthropic OAuth agrupado permanece en el puente. |
| `directEncoders` | Para un flujo ascendente no Responses, la respuesta a un cliente Chat o Messages se codifica directamente a partir de los eventos del adaptador en lugar de a través del flujo interno Responses. El lado de la solicitud no cambia. |
| `antigravityDirect` | **Activado por defecto**; establecerlo en `false` para apagarlo. Una solicitud de Chat o Messages cuya ruta es un proveedor Google Antigravity salta el cuerpo interno Responses en ambas direcciones: la conversación se decodifica desde el cuerpo del cliente directamente en lo que compila el adaptador Google, y la respuesta se codifica directamente como con `directEncoders`. El camino lee `chat -> ir -> other` o `messages -> ir -> other`. Las configuraciones de solicitud (modelo, esfuerzo, límites, elección de herramientas) aún pasan por las políticas habituales, por lo que la rotación de la cuenta, las reglas de esfuerzo y el uso no cambian. Combos, políticas, una herramienta de búsqueda web alojada, imágenes para un modelo marcado solo texto, un modelo que la intercepción de llamada de sombra podría reescribir y texto que el proxy reescribe (un catálogo de habilidades, un enlace de imagen generada) permanecen en el puente y la fila de registro nombra la razón. |
| `shadowPlan` | Al final de cada Chat o solicitud Messages, el plan que una vista previa habría predicho se compara con la ruta que tomó la solicitud; un desacuerdo agrega `planMismatch: true` al registro de ruta de la fila de registro. No se envía ninguna segunda solicitud. |

Cámbialos con el CLI o editando `protocols` en `config.json` ([referencia](/es/reference/configuration/server/#protocol-paths-protocols)):

```bash
ocx api policy                                   # show the current policy; changes nothing
ocx api policy --rollout shadowPlan=on           # change one switch
ocx api policy --unrepresentable reject
```

`ocx api policy` escribe solo cuando pasa una bandera de configuración, y solo cuando la ejecuta.

<a id="shadow-plan"></a>

### Plano de sombra

`shadowPlan` es el primer paso seguro: no cambia ninguna solicitud. Comprueba si la vista previa está de acuerdo con la realidad para el tráfico que realmente envías. La comparación utiliza la ruta en la que se estableció la solicitud (para un combo, el objetivo que respondió), y compara el modo de entrega, el cable ascendente y la ruta de la solicitud. La ruta de respuesta no se compara, porque `directEncoders` lo cambia y la vista previa no modela ese cambio. No se comparan una solicitud de Messages enviada por el llamante y un rechazo de compatibilidad de Claude. Responses solicitudes no se comparan.

`planMismatch` aparece en el `protocolTrace` de una fila devuelta por `GET /api/logs`. El panel de control aún no lo muestra.

<a id="what-has-not-moved-yet"></a>

## Lo que aún no se ha movido

Estos caminos todavía utilizan el puente interno Responses o no están cubiertos:

- El chat y las solicitudes Messages todavía se decodifican en un cuerpo con forma de Responses antes de la IR, incluso en una ruta traducida. La excepción es una solicitud de Chat o Messages a una única ruta Google Antigravity, a menos que `antigravityDirect` se establezca en `false`.
- Los candidatos de la política de enrutamiento, combos alcanzados a través de una fila de esfuerzo, combos candidatos mientras `nativeChatCombos` está apagado y Messages combos.
- Direct (`directEncoders`) cubre solo una ruta concreta, no Responses en la entrega de transmisión. Los hijos combinados y de políticas, la compactación enrutada, los adaptadores de ejecución-giro (Cursor, Devin, los CLI de agentes de codificación, CodeBuddy) y los giros laterales mantienen el puente.
- Un candidato combinado nativo de Chat que falla en la banda antes de cualquier salida no pasa al siguiente candidato; uno puenteado lo haría.
- Los sidecares de búsqueda, visión y generación de imágenes web solo funcionan en la tubería Responses.
- `previous_response_id`, `store`, `background`, y características de la suspensión de compactación Responses.
- Los adaptadores cuyo cable no es ninguna de las tres API (Gemini, Kiro, Cursor y otros) se traducen a través del IR sin reivindicaciones de características.
- Messages nativo administrado a Anthropic de primera parte preservar un coherente observado Claude Code CLI agente de usuario, UUID de sesión y encabezados SDK permitidos en la actualización y selección de cuenta de token. La colocación de credenciales sigue siendo propiedad de un proxy y la lista de permisos beta aún se aplica. Desaparecidos o no válidos usa los encabezados de compatibilidad existentes; los hosts compatibles y Responses generados retienen su comportamiento actual. Los encabezados por sí solos no autorizan solicitudes ni establecen soporte oficial. El agente de TypeScript SDK `sdk-ts` punto de entrada usuario-agente se reconoce con el mismo requerido encabezados de identidad, preservando sus betas de características nativas permitidas en las solicitudes Anthropic de origen.
- El chat nativo de más de OAuth no está planeado. Nativo Messages sobre Anthropic OAuth cubre solo una cuenta no agrupada; un conjunto de cuentas agrupadas permanece en el puente.
- La ruta nativa gestionada Messages reenvía los valores de `anthropic-beta` del llamante solo desde una lista de permisos corta y solo a `api.anthropic.com`, deja caer los campos de nivel superior fuera de su lista de permisos sin un efecto de característica, y no aplica `claudeCode.stabilizePromptCache`. Un cliente reconocido Claude Code mantiene `context-management-2025-06-27` junto con su campo de cuerpo `context_management`. Para la clave Anthropic de origen y las solicitudes OAuth, cualquier cliente nativo Messages puede enviar `thinking-binding-controls-2026-08-01` con `thinking.block_binding` en pensamiento adaptativo o habilitado. Las tiras proxy que anidaban en el campo cuando la beta está ausente o el destino no lo soporta, preservando el resto de la configuración pensante. Los puntos finales de proveedores en la nube y los proveedores compatibles con terceros no heredan el soporte beta de terceros. El emparejamiento utiliza el encabezado final, incluidas las betas configuradas por el operador; solo una beta es válida para [Diagnósticos de transformación del pensamiento](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking). Los nombres beta caídos aparecen una vez en el registro proxy como `anthropic-beta-dropped=<names>`.
