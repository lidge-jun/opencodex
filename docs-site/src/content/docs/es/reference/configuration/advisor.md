---
title: "Advisor"
description: "Consulta independiente a un modelo experto, con políticas manuales, previas a la tarea o adaptativas basadas en evidencia."
---

El asesor es un modelo experto independiente que revisa la tarea del modelo principal y devuelve recomendaciones. OpenCodex controla toda la consulta: el proxy incorpora una herramienta sintética `advisor` al turno, la ejecuta mediante el enrutamiento habitual y entrega las recomendaciones al modelo principal para que continúe. Este no delega, no crea subagentes ni maneja credenciales del proveedor para consultar al asesor.

Es distinto de los [subagentes](/es/reference/configuration/agents/), que el modelo principal inicia mediante las herramientas de colaboración de Codex. El asesor es un sidecar del proxy que el cliente no ve como herramienta; también puede asesorar a un modelo que nunca cree subagentes.

<a id="configuration"></a>

## Configuración

En **Advisor**, bajo **Subagentes** en la barra lateral del dashboard, elige el modelo experto desde el catálogo. Se guarda el identificador exacto: nativo, de proveedor, de cuenta concreta, personalizado o de combo. Los modelos deshabilitados o pendientes de su selección inicial no se ofrecen como nuevas opciones. Si una selección guardada desaparece del catálogo, permanece visible con una advertencia hasta que la cambies o la borres. Un error al cargar el catálogo conserva la selección y permite reintentar. Elige un modelo que pueda devolver recomendaciones de texto: aparecer en el catálogo no garantiza compatibilidad con esta consulta. La CLI y la API siguen aceptando las cadenas de modelo admitidas por el router.

```json
{
  "advisor": {
    "enabled": true,
    "model": "gpt-6-astra",
    "effort": "max",
    "policy": "preflight",
    "contextSharingConsent": "v1"
  }
}
```

| Campo | Tipo | Predeterminado | Significado |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | Interruptor principal. Deshabilitado no añade comportamiento del asesor a las solicitudes. Habilitarlo no registra consentimiento. |
| `model?` | `string` | — | Modelo experto. Admite un modelo nativo sin prefijo (`gpt-6-astra`), un `provider/model` explícito (`anthropic/claude-sonnet-4-6`, `xai/grok-...`) o un modelo nativo de una cuenta concreta. El asesor y el modelo principal pueden usar proveedores distintos. |
| `effort?` | `string` | `"max"` | Esfuerzo de razonamiento de la consulta (`low` a `ultra`). |
| `policy?` | `"manual" \| "preflight" \| "adaptive"` | `"manual"` | Cuándo se consulta al asesor. |
| `maxConsultationsPerTask?` | `integer` | `3` | Límite de intentos por tarea adaptativa, de 1 a 3, incluidas las consultas manuales. |
| `timeoutMs?` | `number` | `120000` | Plazo de la consulta mediante loopback. |
| `contextSharingConsent?` | `"v1"` | Ausente | Consentimiento del operador para enviar el contexto al proveedor del asesor. Solo `"v1"` es vigente. Un valor ausente, obsoleto o diferente impide enviar el contexto. |

Puedes administrarlo en **Advisor** —la casilla para compartir contexto empieza desmarcada— o con `ocx advisor status`, `ocx advisor on --ack-context-sharing`, `ocx advisor consent`, `ocx advisor consent --revoke`, `ocx advisor off` y `ocx advisor set --model <model> --effort <effort> --policy <manual|preflight|adaptive>`. Si falta consentimiento, `ocx advisor on` sin `--ack-context-sharing` muestra la explicación y se detiene sin habilitar el intercambio entre proveedores. `ocx advisor set` no concede consentimiento.

<a id="policies"></a>

## Políticas

- **`manual`**: solo se consulta cuando el modelo principal llama explícitamente a la herramienta sintética `advisor`. El proxy intercepta la llamada; el cliente no la ve y no se ejecuta como herramienta local.
- **`preflight`**: OpenCodex intenta además una consulta automática por tarea. Después de la primera señal de orientación —una llamada a herramienta del asistente o un resultado de herramienta posterior al último mensaje del usuario—, consulta al asesor antes del siguiente turno del modelo principal. No requiere que este llame a la herramienta. El disparador es una aproximación determinista, no una detección semántica de que el modelo esté atascado. Si la consulta falla, la tarea continúa y el fallo no se trata como una recomendación válida. Se puede volver a consultar cuando caduque la entrada de fallo en el registro de deduplicación; así, una interrupción temporal no desactiva permanentemente la política.
- **`adaptive`**: añade consultas tras una reparación fallida al intento inicial de `preflight`. Debe observar una validación que termine con error, una edición de archivo posterior que tenga éxito y una nueva ejecución del **mismo comando en el mismo directorio de trabajo** que vuelva a fallar. Una validación exitosa borra el estado de fallo. Una comprobación iniciada antes de la edición no cuenta como reintento posterior. Los intentos iniciales y los de reparación tienen registros de deduplicación separados. Solo los clientes con identidad de conversación estable reciben consultas adaptativas automáticas.

<a id="adaptive-budget-and-evidence"></a>

### Presupuesto y evidencia adaptativa

```sh
ocx advisor set --policy adaptive --max-consultations 2
ocx advisor activity --json
```

El presupuesto cuenta **intentos** manuales y automáticos a través de distintas solicitudes y cambios del modelo principal. El servidor reserva cada intento antes de enviarlo, en el archivo privado `advisor-budget.sqlite` de `OPENCODEX_HOME`; reiniciar el proxy no restablece ese presupuesto. Un resumen criptográfico de la identidad de conversación y del último límite de tarea del usuario identifica la tarea. Las reservas caducan 24 horas después del primer intento: es una aproximación acotada de la duración de una tarea, no un presupuesto monetario diario ni una sesión permanente. Solo se guardan resúmenes, recuentos y vencimientos. Hay capacidad para 512 tareas activas; si el presupuesto está lleno, bloqueado o no disponible, se omite la consulta y el modelo principal continúa. Una consulta enviada que falla o pierde la conexión conserva su reserva porque pudo generar consumo. Revocar el consentimiento antes del envío no consume el presupuesto. Sin una identidad estable se conserva el acceso manual limitado a cada solicitud, pero no se realizan consultas adaptativas automáticas. Las políticas `manual` y `preflight` conservan su deduplicación anterior por tarea.

El recolector reconoce llamadas de shell emparejadas con un código de salida numérico explícito: `exec_command`, `shell_command`, `shell`, `Bash` y sondeos finales de `write_stdin`. Admite comandos habituales de Bun/npm/pnpm/yarn para test, typecheck, lint, check y build, además de `pytest`, `python -m pytest`, `tsc`, `eslint`, `cargo test/check/clippy/build` y `go test/vet`. Reconoce ediciones exitosas mediante `apply_patch`, `Write`, `Edit`, `write_file` o `edit_file`. También reconoce llamadas individuales a helpers de Code Mode con argumentos JSON literales; las claves pueden ir sin comillas. No usa como disparadores JavaScript arbitrario, lotes, tuberías o sustituciones de shell, ediciones mediante shell, salidas ambiguas ni texto de error sin evidencia estructurada. Examina como máximo los últimos 512 mensajes desde la última tarea del usuario. Antes de la transcripción general, el contexto de reparación incluye la validación, extractos limitados del primer fallo y de su repetición, y referencias a los mensajes originales.

<a id="consent"></a>

## Consentimiento

No se envía el contexto hasta que el operador registra el consentimiento `v1` para compartirlo. Una divulgación futura de mayor alcance podría exigir `v2` en vez de reutilizar el consentimiento anterior. El entorno de ejecución comprueba esta condición: un valor ausente u obsoleto impide ejecutar el asesor (`advisor_context_sharing_consent_required`) sin hacer fallar la solicitud de programación. Ningún modelo ni texto de la tarea puede otorgar ese consentimiento.

<a id="what-the-advisor-sees"></a>

## Qué ve el asesor

Una consulta puede enviar:

- La última tarea del usuario.
- Texto del usuario, del asistente y del desarrollador visible en la conversación analizada.
- Llamadas a herramientas y sus argumentos.
- Resultados de herramientas.
- El catálogo de herramientas del modelo principal y sus descripciones.
- La identidad del modelo principal y el modelo del asesor configurado.
- Una pregunta específica opcional cuando el modelo principal llama a `advisor()`.

El proveedor del asesor puede ser distinto del proveedor del modelo principal.

Las consultas respetan el ámbito de modelos capturado para la clave API del solicitante, su consentimiento para combos de pago y los límites de fallback del dispositivo. También respetan los límites del host definidos por la clave de admisión del propio Advisor: `OPENCODEX_API_AUTH_TOKEN` o el archivo de token del servicio, cuando estén configurados y este proxy los acepte; en caso contrario, la primera clave API configurada. Solo en ese último caso importa el orden: la primera clave debe poder acceder al modelo del asesor, o todas las consultas quedarán no disponibles. Si se configura un token de entorno o de servicio, ese token controla la consulta. Las mismas reglas se aplican a los combos, los modelos de decisión anidados y los reintentos. Si no se pueden cumplir, el modelo principal recibe un aviso de que la consulta no está disponible.

Por ejemplo, una clave `laptop` con `allowMeteredComboTargets: false` no puede generar gasto en objetivos medidos de combos mediante Advisor; `fallback.devices.laptop.provider: false` también impide sus saltos de fallback entre proveedores. Un solicitante de loopback sin clave sigue necesitando `allowMeteredTargets: true` en el combo. Si ambas claves tienen `allowMeteredComboTargets: true` y el combo tiene `allowMeteredTargets: true`, Advisor puede usar sus objetivos medidos, incluso desde el listener de loopback de un enlace público. El servidor captura la política del solicitante al autenticar la solicitud, antes de esperar capacidad o leer el cuerpo; las ediciones posteriores de claves o fallback no pueden ampliar los permisos de esa consulta. Esto también abarca los auxiliares de visión enrutada, las solicitudes de compactación y sus modelos de decisión, y cada reintento candidato dentro de un turno WebSocket. Cada turno WebSocket nuevo captura su propia política.

OpenCodex no añade a ese prompt claves API de proveedores, encabezados de autorización, tokens OAuth, secretos internos de configuración, variables del entorno del proceso ni razonamiento interno oculto. Tampoco descifra ni reenvía razonamiento cifrado privado del proveedor. **No se eliminan secretos del contenido de la tarea.** Una clave pegada en ella, un secreto en un archivo leído por una herramienta o un token impreso en su salida puede enviarse. OpenCodex no realiza prevención general de fuga de datos (DLP).

<a id="authority"></a>

## Autoridad

Una consulta manual devuelve un resultado para la llamada `advisor` realizada por el modelo principal. Es un objeto JSON: `advice` contiene el texto del asesor y `status` lo establece el entorno de ejecución.

La consulta automática mantiene la instrucción fija de transporte en un mensaje de desarrollador y coloca el consejo JSON citado en un **mensaje consultivo de rol usuario** separado. El texto generado por el asesor nunca entra en mensajes de desarrollador o sistema, incluso cuando OpenAI Chat traduce las instrucciones de desarrollador al rol sistema. Anthropic puede transportar ese mensaje consultivo sin inventar una llamada a herramienta. El escape JSON impide alterar la estructura o falsificar campos; no garantiza aislamiento frente a inyección de instrucciones. Un protocolo dedicado a resultados de consulta podría distinguir mejor las recomendaciones del texto normal del usuario.

Cada solicitud admite como máximo tres consultas, incluidos los intentos automáticos, y cuatro continuaciones del modelo principal controladas por el asesor. Al agotar las consultas se retira la herramienta `advisor`. Una llamada repetida recibe un último resultado de límite emparejado; si se vuelve a llamar, un error 502 `advisor_continuation_limit` termina la solicitud sin otra llamada oculta al modelo principal. Este límite se comparte con los reintentos por finalización vacía.

Los turnos de búsqueda web basados en `fetch` admiten la misma consulta manual. El bucle de búsqueda intercepta las llamadas `web_search` y `advisor` en el orden emitido por el modelo principal: habilitar búsqueda alojada no oculta la herramienta del asesor. Las iteraciones de búsqueda y del asesor tienen asignaciones separadas; una llamada real a una herramienta del cliente devuelve el control al cliente. Los turnos `runTurn` y los sidecars de imagen o video mantienen sus limitaciones existentes. La contabilidad incluye una sola vez cada turno del modelo principal, incluido el intento rechazado por el límite de continuaciones del asesor.

La supresión de consultas no depende de textos del asesor: la deduplicación automática usa el registro del servidor. Un mensaje de desarrollador, aunque copie el texto de transporte, no suprime la consulta `preflight`.

<a id="cost-and-accounting"></a>

## Costos y registro de actividad

Cada consulta es una llamada real adicional al modelo. Se registra bajo el **modelo asesor**, separada de los tokens del modelo principal. Cada una genera una línea `[advisor]` con disparador, duración, estado y consumo, de modo que puede comprobarse en los registros.

**Actividad reciente del asesor** y `GET /api/advisor/activity` muestran los últimos 100 registros de metadatos de este proceso, conservados hasta 24 horas. El dashboard los actualiza cada cinco segundos mientras están visibles. Incluyen disparador, estado, modelos principal y experto, duración, tokens de entrada y salida informados, esfuerzo solicitado y esfuerzo convertido por el adaptador. Un rechazo por presupuesto aparece como bloqueado. No contienen texto de tareas, comandos, recomendaciones, identificadores de hilos ni cuerpos de error del proveedor. Se borran al reiniciar el proxy.

El esfuerzo convertido describe lo que serializó el adaptador; no garantiza el razonamiento interno del proveedor. Un esfuerzo o consumo no informado queda como desconocido, no como consumo cero ni compatibilidad confirmada. No se infiere una puntuación de adopción de recomendaciones ni un costo monetario exacto.

<a id="failure-behavior"></a>

## Comportamiento ante fallos

Un fallo del asesor permite que la tarea continúe. Si una consulta ya enviada falla por modelo no disponible, proveedor mal configurado o plazo agotado, el modelo principal recibe un aviso breve de indisponibilidad: `<opencodex_advisor_unavailable>` para `preflight` o un resultado de herramienta con error para una consulta manual. Solo una consulta cancelada no añade ningún mensaje, porque quien la solicitó ya se desconectó. Si nunca se envió una consulta —asesor deshabilitado, sin modelo o sin consentimiento vigente—, no se añade un aviso `preflight`. Una llamada manual a `advisor()` sin consentimiento devuelve un resultado que lo solicita y no envía contexto. Estos fallos no hacen fallar la solicitud de programación ni cambian el modelo principal de la sesión.

<a id="limitations"></a>

## Limitaciones

- Los turnos nativos OpenAI passthrough —modelos del pool ChatGPT— no reciben la herramienta sintética. El asesor cubre proveedores enrutados mediante traducción. La consulta `preflight` se aplica a los adaptadores de ejecución de turnos; la herramienta no.
- No hay detección semántica de bloqueo, revisión de finalización, escalada de niveles, varios asesores ni votación. La consulta adaptativa exige la evidencia estructurada de validación, edición y reintento descrita arriba.
- El registro de deduplicación `preflight` pertenece al proceso. Tras reiniciar el proxy, una tarea en curso puede recibir un intento adicional.
