---
title: "Advisor"
description: "Consulta independiente de expertos con políticas adaptativas manuales, previas y basadas en la evidencia."
---

El asesor es un modelo de experto independiente que revisa la tarea del trabajador y devuelve el asesoramiento. OpenCodex posee la consulta de extremo a extremo: el proxy inyecta una herramienta sintética `advisor` en el turno del trabajador, ejecuta la consulta a través de la autoridad de enrutamiento normal y vuelve a inyectar el consejo para que el trabajador original continúe. El trabajador nunca delega, genera nada o lleva credenciales de proveedor.

Esto es distinto de la superficie del subagente (ver [Configuración del agente](/es/reference/configuration/agents/)): los subagentes son la delegación iniciada por el trabajador a través de las herramientas de colaboración de Codex. El asesor es un sidecar del lado del proxy que el cliente nunca ve, incluso un trabajador que nunca genera nada puede ser aconsejado.

<a id="configuration"></a>

## Configuración

En la página del panel de control **Consejero** (debajo de la fila de la barra lateral **Subagentes**), elija el modelo experto en el selector de catálogo. Guarda el identificador de catálogo exacto, incluidos los selectores nativos, proveedores, calificados para cuentas, personalizados y combinados. Los modelos deshabilitados y los modelos que esperan la selección inicial no se ofrecen como nuevas opciones. Un identificador guardado que falta en el catálogo seleccionable permanece visible con una advertencia y se conserva hasta que elija otro modelo o lo borre. Los fallos de carga del catálogo preservan la selección y proporcionan Reintento. Elija un modelo que pueda devolver consejos de texto: el catálogo no garantiza la compatibilidad de la consulta. Los modelos CLI y API continúan aceptando cadenas de modelos compatibles con el router.

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

| Campo | Tipo | Predeterminado | Descripción |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | Interruptor maestro. Deshabilitado significa cero comportamiento del asesor en la ruta de la solicitud. La habilitación no registra el consentimiento. |
| `model?` | `string` | — | El modelo experto. Cualquier cadena de modelo que el router acepte: un modelo nativo desnudo (`gpt-6-astra`), un `provider/model` explícito (`anthropic/claude-sonnet-4-6`, `xai/grok-...`), o un modelo nativo calificado para la cuenta. El proveedor cruzado es totalmente compatible: el trabajador y el asesor no necesitan compartir un proveedor. |
| `effort?` | `string` | `"max"` | Esfuerzo de razonamiento para la llamada del asesor (`low` a `ultra`). |
| `policy?` | `"manual" \| "preflight" \| "adaptive"` | `"manual"` | Cuando se consulta al asesor. |
| `maxConsultationsPerTask?` | `integer` | `3` | Asignación de tareas adaptable (1-3 intentos), incluyendo llamadas manuales. |
| `timeoutMs?` | `number` | `120000` | Tiempo de espera de consulta de Loopback. |
| `contextSharingConsent?` | `"v1"` | ausente | Consentimiento del operador para enviar el contexto de la tarea al proveedor de Asesor configurado. Sólo `"v1"` es actual. Ausente, rancio o cualquier otro valor significa que no se envía ningún contexto de tarea. |

Gestione desde la página del panel de control **Consejero** (la casilla de verificación de intercambio de contexto comienza sin marcar) o con `ocx advisor status`, `ocx advisor on --ack-context-sharing`, `ocx advisor consent`, `ocx advisor consent --revoke`, `ocx advisor off` y `ocx advisor set --model <model> --effort <effort> --policy <manual|preflight|adaptive>`. `ocx advisor on` sin `--ack-context-sharing` no permite compartir entre proveedores cuando falta el consentimiento: imprime esta divulgación y se detiene. `ocx advisor set` no otorga consentimiento.

<a id="policies"></a>

## Políticas

- **`manual`** - solo una llamada explícita del trabajador a la herramienta sintética `advisor` consulta. La llamada es interceptada por el proxy, nunca se muestra al cliente y nunca se ejecuta como una herramienta local.
- **`preflight`** - OpenCodex también intenta una consulta por tarea automáticamente. Cuando el trabajador ha presentado su primera evidencia de orientación (una llamada a la herramienta asistente O un resultado de la herramienta después del último mensaje del usuario), el proxy consulta al asesor e inyecta el consejo antes del próximo turno del trabajador, incluso si el trabajador nunca llama a la herramienta. El disparador es una aproximación determinista y documentada, no un detector semántico de "modelo atascado". Un intento de consulta que no se trata silenciosamente como un consejo: la tarea se reintenta después de que expire la entrada del libro mayor del fracaso, por lo que una interrupción temporal del asesor no silencia permanentemente la política.
- **`adaptive`** - agrega consultas de reparación fallida al intento inicial de prevuelo. El proxy debe observar una validación de error completada, un resultado de herramienta de edición de archivos exitoso posterior y una nueva ejecución del error **mismo comando en el mismo directorio de trabajo** nuevamente. Una validación de aprobación borra su estado de fallo. Una comprobación iniciada antes de la edición no puede contar como un reintento después de la edición. Las etapas inicial y de reparación fallida tienen reclamaciones de dedup separadas. Solo los clientes con una identidad de conversación estable reciben consultas adaptativas automáticas.

<a id="adaptive-budget-and-evidence"></a>

### Presupuesto y pruebas adaptables

```sh
ocx advisor set --policy adaptive --max-consultations 2
ocx advisor activity --json
```

El presupuesto de tareas adaptable cuenta manual y automático **Intentos**, a través de solicitudes y cambios de modelo de trabajador. El servidor reserva un intento antes del envío en un archivo privado `advisor-budget.sqlite` en `OPENCODEX_HOME`; los reinicios proxy no lo restablecen. Una tarea se identifica por un resumen de la identidad de la conversación y el límite más reciente de la tarea del usuario. Las reservas expiran 24 horas después del primer intento, por lo que esta es una aproximación limitada de la tarea y la vida útil, no una sesión permanente o un presupuesto monetario diario. Solo se almacenan los resúmenes, los recuentos y los tiempos de caducidad. Hay espacio para 512 tareas en vivo; un presupuesto completo, no disponible o bloqueado omite la llamada de experto mientras el trabajador continúa. Las llamadas despachadas que fallan o están desconectadas retienen su reserva porque pueden haber incurrido en uso. El consentimiento revocado antes del envío no gasta ninguna asignación. Los clientes sin una identidad estable mantienen un acceso manual y limitado a solicitudes, pero no reciben consultas adaptativas automáticas. Las versiones `manual` y `preflight` heredadas conservan su comportamiento anterior de eliminación de tareas.

El colector reconoce llamadas de shell emparejadas con estado de salida numérico explícito, incluyendo `exec_command`, `shell_command`, `shell`, `Bash` y sondeos de terminal `write_stdin`. Los comandos admitidos incluyen comandos comunes Bun / npm /pnpm/yarn test, typecheck, lint, check y build, `pytest`, `python -m pytest`, `tsc`, `eslint`, `cargo test/check/clippy/build` y `go test/vet`. Las ediciones de archivos usan resultados exitosos de `apply_patch`, `Write`, `Edit`, `write_file` o `edit_file`. Se reconocen los ayudantes de modo de código único con JSON argumentos literales (se aceptan claves vacías); JavaScript arbitrario, lotes, tuberías / sustituciones de shell, ediciones basadas en shell, salida ambigua y prosa de error por sí sola no proporcionan ningún desencadenante. A lo sumo se examinan los últimos 512 mensajes desde la última tarea de usuario. El contexto de reparación fallida incluye la validación, extractos de fallas primero y repetido limitado, y referencias de mensajes fuente antes de la transcripción general.

<a id="consent"></a>

## Consentimiento

El contexto de la tarea no se envía hasta que el operador registra el consentimiento de compartición de contexto `v1`. El consentimiento se versiona para que una divulgación posterior y más amplia pueda requerir `v2` en lugar de reutilizar esta subvención. El runtime lo impone. Un valor perdido o obsoleto deja al asesor inejecutable (`advisor_context_sharing_consent_required`) sin fallar la solicitud de codificación. Ninguno de los modelos, ni ninguna cadena en la tarea, puede otorgar el consentimiento.

<a id="what-the-advisor-sees"></a>

## Lo que ve el asesor

Una consulta puede enviar:

- La última tarea del usuario
- texto de usuario, asistente y desarrollador visible en la conversación analizada
- Llamadas a herramientas y argumentos de herramientas
- resultados de la herramienta
- el catálogo y las descripciones de la herramienta de trabajo
- la identidad del trabajador y el modelo de Asesor configurado
- una pregunta de enfoque opcional cuando el trabajador llama al `advisor()`

El proveedor de Asesor configurado puede diferir del proveedor de trabajador.

OpenCodex no inserta claves de proveedor API, encabezados de autorización, tokens OAuth, secretos de configuración de backend, entorno de proceso o cadena de pensamiento oculta en ese indicador. No descifra ni reenvía el razonamiento cifrado proveedor-privado. **El contenido de la tarea no se edita en secreto.** Se puede enviar una clave pegada en la tarea, un secreto en un archivo que leen las herramientas o un token impreso por una herramienta o registro. OpenCodex no ejecuta DLP general.

<a id="authority"></a>

## Autoridad

El asesoramiento manual es un resultado de herramienta para la llamada `advisor` realizada por el trabajador. El resultado es un objeto JSON. Su campo `advice` es el texto del modelo Advisor. Su `status` se establece por el entorno de ejecución.

El prevuelo automático mantiene la instrucción de transporte en entorno de ejecución fija en un mensaje de desarrollador y coloca el aviso JSON citado en un **mensaje de aviso de usuario** separado. El texto generado por el asesor nunca ingresa contenido de desarrollador/sistema, incluso cuando se traduce OpenAI. Anthropic puede llevar ese aviso sin una llamada de herramienta inventada. JSON evita la ruptura estructural y los campos forjados; no puede garantizar el aislamiento de inyección rápida. Un protocolo de consulta-resultado dedicado podría distinguir más fuertemente el asesoramiento de la entrada ordinaria del usuario.

Cada solicitud permite como máximo tres consultas, incluidos intentos automáticos, y cuatro continuaciones de trabajadores propiedad de un asesor. Después del agotamiento de la consulta, se elimina la herramienta `advisor`. Una llamada repetida recibe un resultado de límite emparejado final; si el trabajador la llama de nuevo, el tecleo 502 `advisor_continuation_limit` finaliza la solicitud sin otra llamada oculta del trabajador. El enlace se comparte con los reintentos de finalización vacía.

La supresión no lee cadenas de Advisor. El dedup automático es el libro mayor propiedad del servidor. Un mensaje de desarrollador, incluido uno que copia el texto de transporte, no suprime el prevuelo.

<a id="cost-and-accounting"></a>

## Coste y contabilidad

Cada consulta es un modelo de llamada adicional real. Aparece en uso bajo el **modelo de asesor**, nunca se fusionó con los recuentos de tokens del trabajador, y cada consulta escribe una línea de registro `[advisor]` con desencadenante, duración, estado y uso, por lo que una llamada de asesor siempre se puede probar a partir de los registros.

La sección **Actividad reciente del asesor** y `GET /api/advisor/activity` muestran los últimos 100 registros de metadatos de consulta de este proceso, retenidos hasta por 24 horas. El panel de control los actualiza cada cinco segundos mientras están visibles. Los registros incluyen modelos de activación, estado, trabajador y experto, duración, tokens de entrada / salida informados, esfuerzo solicitado y esfuerzo mapeado por adaptador. La denegación del presupuesto se muestra como bloqueada. Los registros no contienen texto de tarea, comandos, consejos, identificadores de subprocesos ni cuerpos de error del proveedor y se borran al reiniciar el proxy.

El esfuerzo mapeado describe lo que el adaptador serializó, no una garantía sobre el razonamiento oculto del proveedor. El esfuerzo o uso no reportado permanece desconocido; nunca se presenta como uso cero o soporte de razonamiento confirmado. No se infiere una puntuación de adopción de consejos ni un costo monetario exacto.

<a id="failure-behavior"></a>

## Comportamiento de fracaso

Un fallo del asesor no bloquea la tarea. Si una consulta ya enviada (DISPATCHED) falla por un modelo no disponible, una configuración incorrecta del proveedor o un tiempo de espera agotado, el trabajador recibe un aviso breve de que el consejo no está disponible y continúa. En la consulta previa al trabajo se usa un mensaje `<opencodex_advisor_unavailable>`; en la consulta manual, un resultado de herramienta con error. Una consulta cancelada (CANCELLED) no inyecta nada porque quien la solicitó ya no está. Si el plan nunca llega a enviar una consulta —asesor deshabilitado, sin modelo o sin consentimiento vigente para compartir contexto— tampoco se inyecta un aviso previo. Una llamada manual a `advisor()` sin ese consentimiento devuelve un resultado que lo solicita y no envía datos. Los errores del asesor nunca hacen fallar la solicitud de programación ni cambian el modelo principal de la sesión.

<a id="limitations"></a>

## Limitaciones

- Los giros de paso nativos OpenAI (ChatGPT -trabajadores del grupo) no obtienen la herramienta sintética; el soporte del asesor cubre los proveedores enrutados (traducidos). La consulta previa se aplica a los adaptadores de ejecución-giro; la herramienta no.
- No hay detección semántica atascada, revisión de finalización, escalada de niveles, múltiples asesores o votación. La consulta adaptativa requiere la validación/edición/evidencia de reintento estructurada descrita anteriormente.
- El libro mayor de desarrollo previo al vuelo es local de proceso; después de un reinicio proxy, una tarea en progreso puede recibir un intento más de prevuelo.
