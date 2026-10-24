---
title: "Agentes, enrutamiento e integraciones de CLI"
description: "Comandos multiagente, combo, observabilidad, acceso, ruta de protocolo, integración, sistema y configuración."
---

Estos comandos controlan la política del agente y el enrutamiento, inspeccionan el proxy en vivo y conectan los clientes compatibles con opencodex.

<a id="agent-policy"></a>

## Política del agente

### `ocx agent <status|injection|effort|subagents|fallback|roles|sidecar|memory-models|compaction-routing> ...`

Administre la lista de agentes múltiples sin cabeza, los límites de esfuerzo, la inyección rápida, la reserva y la configuración del sidecar. Utilice `status` para la política actual. Vea [Superficies de los subagentes](/es/guides/sub-agent-surface/) para ver cómo encajan entre sí los modos de superficie, la delegación, el esfuerzo y el comportamiento alternativo.

```bash
ocx agent subagents set ark/model-a,openai/gpt-5.5
```

`ocx agent roles` es para omo (Codex / LazyCodex). Enumera cada rol de agente Codex en `$CODEX_HOME/agents` con su pin de modelo y si `~/.omo/omo.jsonc` se puede actualizar, o dice que LazyCodex no está instalado, en cuyo caso `set` es rechazado. `ocx agent roles set <role> <model> [--effort <level>]` reescribe solo la línea de la raíz `model` de ese rol, y su línea `model_reasoning_effort` con `--effort`, y refleja tanto en omo.jsonc como `[codex].agents.<role>` como `model` y `reasoning`. Un esfuerzo para el que LazyCodex no tiene nivel, como `ultra`, se escribe solo en el archivo de rol. Una falta omo.jsonc, o uno que contiene comentarios, se deja sin cambios y el comando lo dice. Véase [omo ( Codex / LazyCodex) modelos de rol](/es/guides/integrations/#omo-codex--lazycodex-role-models).

```bash
ocx agent roles set explorer xai/grok-4.5 --effort medium
```

`ocx agent roles suggest` es omo (Codex / LazyCodex) solamente, rechazado como `set` cuando LazyCodex no está instalado. Dimensiona cada rol con una llamada al modelo predeterminado Codex (o `--model`) e imprime un modelo propuesto y un esfuerzo por rol sin escribir nada. `--apply` escribe cada propuesta a través de la misma escritura que `set`, saltándose y nombrando los roles cuyo modelo y esfuerzo ya coinciden. Véase [Asignación automática](/es/guides/integrations/#auto-assign).

La salida de sugerencias legible por humanos muestra caracteres de control de terminal como escapes visibles. Utilice `--json` cuando necesite los valores de sugerencia originales sin que se escape la presentación.

`ocx agent injection suggest <work>` hace lo mismo para el modelo de delegación: mide el trabajo descrito, propone el modelo suficiente más barato y un esfuerzo de la lista del seleccionador de delegación, y no escribe nada a menos que se dé `--apply`, lo que ahorra a través de la misma escritura que `injection set`. Véase [Modelo de delegación y esfuerzo](/es/guides/sub-agent-surface/#delegation-model-and-effort).

`ocx agent sidecar web --list` y `ocx agent sidecar vision --list` imprimen los modelos que el servidor ofrece actualmente para cada sidecar: el conjunto filtrado exacto que muestra el selector de tablero (filas visibles para el selector más las ranuras de autenticación Luna/Haiku con nombre de inicio de sesión, intersectadas con la disponibilidad del ejecutor para la búsqueda web, menos los modelos de solo texto para la visión). Las listas legibles por humanos muestran el backend de cada modelo entre paréntesis. Una escritura de búsqueda web `--model` resuelve esa fila ofrecida por el servidor y persiste su backend y modelo juntos, por lo que cambiar a una opción Anthropic no puede mantener un backend OpenAI (o viceversa). Las escrituras van a la misma ruta de administración que la GUI y están sujetas a la misma puerta por sidecar: la búsqueda web rechaza un par backend / modelo fuera del conjunto de la lista (miembro cerrado), mientras que la visión rechaza solo un modelo que probablemente no pueda ver (ids desconocidos permanecen escribibles).

```bash
ocx agent sidecar web --list
ocx agent sidecar web --model gpt-5.6-luna
ocx agent sidecar web --enabled off
```

`--enabled off` es el mismo switch que la fila Off del Dashboard: OpenCodex deja de ejecutar el sidecar y la integración Codex escribe `web_search = "disabled"` en `~/.codex/config.toml`, que es lo que permite que un servidor de búsqueda MCP sea la única ruta de búsqueda. `--enabled on` elimina esa línea de propiedad del marcador de nuevo. Cuando el guardar mueve realmente el interruptor, el comando informa que el Codex -side escribe que se activó (`codexWebSearch` en `--json`, una línea `Codex config:` posterior de lo contrario) y apunta a `ocx sync` cuando no podía suceder; un guardar que deja el interruptor donde estaba no tiene nada que informar e imprime ninguna línea `Codex config:`. La bandera funciona para `vision` también.

<a id="injection-defaults-and-sidecar-runtime-settings"></a>

### Configuración predeterminados de inyección y entorno de ejecución del sidecar

```bash
ocx agent injection status --json
ocx agent injection set --sync-codex-defaults off --json
ocx agent injection status --json
ocx agent sidecar web --stream-routed-output on --json
ocx agent sidecar vision --timeout-ms 30000 --json
ocx agent sidecar status --json
```

Ejecutar escribe solo para el cambio solicitado. La inyección `--sync-codex-defaults on|off` actualiza `syncCodexSubagentDefaults`; modelo/esfuerzo/pronta/orientación omitido permanece intacto, y `-` borra modelo/esfuerzo/pronta. El recibo ha normalizado realmente `model`, `effort`, `prompt`, `multiAgentGuidanceEnabled` y `syncCodexSubagentDefaults`, no un resultado de catálogo fabricado.

Web `--reasoning` sigue siendo compatible. `--max-descriptions` y `--timeout-ms` son solo de visión; el tiempo de espera acepta enteros de 1 a 2147483647 milisegundos. `--stream-routed-output` es solo web. Las escrituras parciales conservan la configuración de hermanos. El recibo de nueva opción expone solo el estado público seleccionado `webSearch` o `vision` y `codexWebSearch` aplica el informe. `{applied:false, reason, retryable}` distingue el aplazamiento/rechazo de aplicación nativa de una configuración guardada; una nueva configuración faltante o no coincidente no está verificada y no es cero. Lee el estado para ver los ajustes completos observados, incluido el razonamiento web. No vuelvas a intentar ciegamente el rechazo de la propiedad.

<a id="memory-and-compaction-routing-overrides"></a>

### Anulaciones de enrutamiento de memoria y compactación

```bash
ocx agent memory-models show --json
ocx agent memory-models set --extract-model <route> --extract-effort high --consolidation-model <route> --json
ocx agent memory-models show --json
ocx agent compaction-routing show --json
ocx agent compaction-routing set --model <route> --effort high --triggers manual,auto --sources '<exact-source>,<provider>/*' --json
ocx agent compaction-routing show --json
```

Cada conjunto reemplaza el bloque entero. La memoria acepta el modelo de extracción/consolidación y los pares de esfuerzo opcionales; se rechaza un esfuerzo sin el modelo de esa fase. Las fases omitidas usan su ruta existente/predeterminada, no una canalización detenida. `--file memory.json` en cambio lee el bloque en sí:

```json
{"extract":{"model":"example/model","reasoningEffort":"high"}}
```

Un archivo de memoria explícito `{}` es válido y sigue siendo un bloque de anulación vacío; `ocx agent memory-models clear --json` escribe null. Ambos significan que no hay una anulación personalizada, no un procesamiento de memoria deshabilitado. El modo de archivo es exclusivo con opciones escalares. Los archivos UTF-8 regulares o `--file -` canalizados utilizan el contrato de entrada limitada de 4 MiB/30 segundos, incluido un límite de solicitud seriado de 4 MiB.

Los archivos de compactación contienen `model`, `reasoningEffort` opcional, `triggers` y `sourceModels`. Los disparadores son únicos `manual` / `auto`; los selectores de fuente deben ser exactos y únicos, o patrones de proveedor /. Los disparadores omitidos usan los valores predeterminados del servidor; las fuentes omitidas seleccionan todas las fuentes, no el alcance personalizado anterior. `ocx agent compaction-routing clear --json` escribe null y restaura el enrutamiento de compactación ordinario sin deshabilitar la compactación. Ninguna llamada de modelo sintético verifica estos ahorros.

Las lecturas devuelven solo `{memoryModels: blockOrNull}` o `{compactionRouting: blockOrNull}`. Escribe agrega `catalogRefreshPending`: salidas falsas 0 sin prometer a cada cliente aplicado, salidas verdaderas 1 después de guardar. La evidencia pendiente faltante/malformada es nula con `verification:"unverified"` y salida 1. Lee antes de la recuperación.

### `ocx effort [status|set|clear]`

Inspeccione o cambie los límites del esfuerzo de razonamiento del agente principal y del subagente a través del proxy en vivo o la configuración local cuando no haya proxy disponible. Los valores máximos son `low`, `medium`, `high`, `xhigh`, `max` y `ultra`; `-` borra la tapa seleccionada. `none` y `minimal` no son niveles de límite y se rechazan antes de probar el proxy o enviar una actualización, incluso cuando otra opción en el mismo comando es válida. Siguen siendo válidos para `--injection`, que establece el esfuerzo de inyección por separado en lugar de una tapa.

```bash
ocx effort status --json
ocx effort set --main high --subagent low
ocx effort set --subagent -
```

Status conserva los valores de límite de entorno de ejecución/almacenados existentes e informa de los valores no admitidos en `warnings` (una matriz vacía cuando no se admite ninguna). Las mismas advertencias aparecen en la salida humana y nombran el campo que se ignora con un comando de corrección. El estado nunca repara o reescribe esos valores. Un campo de subagente ignorado no elimina un límite principal válido. `ocx effort clear` limpia ambas tapas mientras retiene la configuración de esfuerzo de inyección separada. Véase [Superficies de los subagentes](/es/guides/sub-agent-surface/) para las superficies de solicitud donde se aplican tapas.

### `ocx v2 <status|on|off|mode <v1|default|v2>|keep-native-v1 <on|off>|threads <n>|mode-hint <text|--clear>>`

Administre el indicador de características Codex `multi_agent_v2` y el modo de superficie multiagente de tres estados. Estos funcionan localmente por defecto. `--live` utiliza el proxy de ejecución seleccionado sin respaldo local; ambos objetivos admiten `--json`. Vuelva a leer el estado en el mismo objetivo después de un cambio y distinga la configuración almacenada del comportamiento de la nueva sesión.

| Subcomando | Medidas adoptadas |
| --- | --- |
| `status` (por defecto) | Reportar el indicador v2 actual, el modo multiagente y la concurrencia de subprocesos. |
| `on` | Habilite la función global `multi_agent_v2`; los cambios locales vuelven a sincronizar el catálogo. Rechazado mientras el pin híbrido v2 está activo porque la anulación global lo derrotaría. |
| `off` | Desactive la función `multi_agent_v2` y vuelva a sincronizar el catálogo. |
| `mode v1` | Forzar a todos los modelos a v1, deshabilitar v2 nativo y preservar el límite de subproceso activo. |
| `mode default` | Respete los pines de superficie del modelo aguas arriba. |
| `mode v2` | Forzar los modelos a v2 y preservar el límite de rosca activa. Con `keep-native-v1` desactivado, habilite la v2 nativa global; con ella, deshabilite la anulación global y use pines de catálogo. |
| `keep-native-v1 on\|off` | Bajo `mode v2`, mantenga los modelos nativos ChatGPT en v1 y los modelos enrutados en v2. Habilitarlo desactiva la anulación global de V2 antes de la sincronización del catálogo. |
| `threads <n>` | Establezca el límite de hilo v1/v2 activo en un número entero de al menos 1. |
| `mode-hint <text>` | Establezca la sugerencia de delegación proactiva (modo Ultra) para cada modelo y esfuerzo. |
| `mode-hint --clear` | Elimine la sugerencia para que se reanude la política derivada del esfuerzo (ultra + proactiva). |

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 on
ocx v2 threads 16
ocx v2 mode-hint "Proactive multi-agent delegation is active."
ocx v2 mode-hint --clear
```

El subcomando `mode` escribe `multiAgentMode` a la configuración opencodex y vuelve a sincronizar el catálogo Codex. Las transiciones de modo y bandera mueven el límite de subproceso numérico actual entre las teclas v1/v2 Codex válidas; una transición fallida restaura el `config.toml` original. Los cambios se aplican a las nuevas Codex sesiones, mientras que las sesiones en ejecución mantienen su superficie fija.

Codex resuelve una anulación global habilitada de `multi_agent_v2` antes del pin de catálogo del modelo seleccionado. Por lo tanto, el contrato híbrido `keep-native-v1` mantiene esa anulación global apagada; de lo contrario, una fila nativa estampada `v1` aún comenzaría en V2 y produciría tareas secundarias cifradas en el backend.

`mode-hint` escribe `features.multi_agent_v2.multi_agent_mode_hint_text` en Codex 's `$CODEX_HOME/config.toml` incluso cuando `multi_agent_v2` está actualmente deshabilitado. El comando solo persiste la anulación; no habilita ni deshabilita la función, por lo que la sugerencia tiene efecto cuando una superficie coincidente Codex está activa. La sugerencia anula la política multiagente derivada de esfuerzo de codex-rs, por lo que cualquier modelo y cualquier esfuerzo de razonamiento recibe el mensaje de delegación proactiva. **no** cambia el esfuerzo de razonamiento en sí. Se rechaza un argumento faltante o un valor de solo espacio en blanco; solo `--clear` elimina la sugerencia. El modo Ultra **on** del panel de Subagents tiene una puerta más estricta: requiere que la función nativa esté habilitada con una superficie v2 explícita ( `ocx v2 mode v2` ); `ocx v2 on` por sí solo no satisface esa puerta del tablero.

<a id="explicit-v2-target-and-outcome"></a>

#### Objetivo y resultado explícitos de la versión 2

```bash
ocx v2 status --json
ocx v2 status --live --json
ocx v2 mode v1 --live --json
ocx v2 status --live --json
```

La escritura en vivo utiliza la ruta de gestión existente. Sólo explícito en vivo `mode` acepta `--acknowledge-surface-advisory`; añadirlo sólo cuando se reconoce que se solicita asesoramiento. Modo local y estado/encendido/apagado/mantenimiento nativo/hilos/pista rechazarlo. No hay reconocimiento automático.

Para el texto literal reservado, pase un operando citado después de `--`:

```bash
ocx v2 mode-hint --live --json -- '--clear'
```

Esto almacena literal `--clear`; sin `--`, `mode-hint --clear` elimina la pista. El sufijo no se escanea en busca de ayuda, en vivo, JSON o controles claros; los controles pertenecen antes de `--`. Los operandos adicionales y las banderas duplicadas se niegan antes de la mutación.

El local JSON es `{ok, target:"local", action, changed, state, sync}` usando el estado post-escritura real. Modo/mantenimiento-nativo y modificado on/off mantienen su intento de sincronización real incluso sin un puerto descubierto; hilos/sugerencias y on/off sin cambios no agregan sincronización. Un resultado de sincronización ausente/malformado no se verifica con la salida 1, no con éxito. `changed` o estado puede ser desconocido después de la falla; no reclame la reversión. Los informes de estado en vivo validaron el estado/asesor/recomendación con `target:"live"`; escribe añadir `ok:true` y `catalogRefresh`. Solo la actualización comprometida y no degradada sale 0. HTTP 502 puede significar un estado nativo parcialmente aplicado: inspeccionar antes de volver a intentarlo. Los errores de uso local retienen la salida 1; los nuevos errores de uso en vivo usan la salida 2.

<a id="combo-routing"></a>

## Ruteo combinado

### `ocx combo <list|show|set|remove|stats> ...` · `ocx route combo ...`

Gestione la conmutación por error combinada y los modelos virtuales round-robin. `ocx route combo` es el alias jerárquico; combos y perfiles de enrutamiento son recursos distintos. Los objetivos combinados usan `provider/model[:weight],provider/model[:weight]`.

```bash
ocx combo list
ocx route combo set reliable --targets ark/model-a:2,openai/gpt-5.5
```

`set` acepta `--strategy`, `--sticky`, `--effort`, `--alias`, `--rename-from`, `--native-alias` y `--display-name <label|->` (`-` borra la etiqueta). Un alias nativo captura solo un identificador de modelo OpenAI no calificado actualmente soportado. Bare `gpt-5.6-*` alias nativos utilizan Codex Pool / Direct credenciales. Las rutas con calificación de cuenta OpenAI siguen siendo distintas, mientras que las rutas con calificación de proveedor como `openai-apikey/gpt-5.6-*` usan su clave configurada API y nunca caen a través del alias nativo. Lea el contrato de seguridad y visibilidad en la guía antes de habilitar el par de compatibilidad. El método de decisión se elige mediante dos opciones mutuamente excluyentes únicamente cuando la estrategia efectiva es JEV: al indicar `--strategy jev` o al omitir `--strategy` en un combo JEV existente. `--decision-provider <provider|->` nombra una fila `jev-decision` configurada (por ejemplo, una Ollama `tev1` autoalojada) como un servidor compatible con System One. `--decision-model <route|->` nombra una ruta opencodex ordinaria (por ejemplo `ollama/qwen3:4b`) que responde a la misma opción que JSON; no puede ser este combo o cualquier combo JEV. Un combo JEV nuevo usa TypeSafe si se omiten ambas opciones; uno existente conserva su método de decisión hasta cambiarlo mediante una de ellas. `--decision-timeout <ms|->` establece el plazo de decisión (1000-120000, por defecto 4000); `-` elimina cualquiera de los tres.

`ocx combo set <id> --decision-quota-signals on|off|-` controla la evidencia consultiva por combo. `--decision-quota-tiers '{"limited":80}'` configura umbrales parciales; `-` los borra. Ambas opciones son exclusivas de JEV. Si se omiten, se conservan al sustituir destinos con `--targets-file` o `--targets` y al renombrar. Si no se indica `--strategy`, un combo existente conserva su estrategia: JEV mantiene su método, cuotas y fijación de sesión; un combo nuevo usa failover por defecto. Si una política JEV conservada rechaza los destinos nuevos, el comando identifica esa política y no guarda nada. Desactivar las señales conserva los umbrales; salir de JEV elimina ambos ajustes. Esto aporta datos de cuota al backend elegido, sin añadir consultas a proveedores, selección de cuentas ni exclusiones obligatorias. Véase [valores predeterminados, vigencia y privacidad](/es/guides/combos/#advisory-quota-signals-for-jev).

`ocx combo set <id> --session-pin <duration|->`, exclusivo de JEV, mantiene la sesión en el destino que JEV eligió mientras siga activa, permitiendo reutilizar la caché del proveedor. La duración es un plazo de inactividad: `90s`, `20m`, `1h` o milisegundos, entre un minuto y 24 horas. `-` lo desactiva. Véase [Fijación de sesión para JEV](/es/guides/combos/#session-pin-for-jev).

`ocx combo test [--combo <id>] [--decision-provider <provider|jev> | --decision-model <route>]
[--decision-timeout <ms>]` envía una sonda de decisión sintética a través de un método combinado guardado o una selección no guardada e informa de la puerta, el backend y la latencia; puede pasar una llamada de decisión. `ocx combo discover [--query <text>]` enumera las filas configuradas de System One y los modelos de catálogo que parecen modelos de decisión, con el punto final derivado.

Para metadatos de destino estructurados, inspeccione la ayuda sin conexión y el combo actual:

```bash
ocx combo set --help
ocx combo list --json
ocx combo show reliable --json
```

Un documento `--targets-file` es una matriz ordenada no vacía, por ejemplo, esta forma con valores de proveedor/modelo reemplazados por candidatos configurados reales:

```json
[{"provider":"example","model":"raw/model","weight":1,"reasoningEfforts":["high"],"modelProfile":"Reasoning tasks","lastResort":false}]
```

Los campos opcionales son `weight`, `reasoningEfforts`, `modelProfile` y `lastResort`. Esfuerzos son una lista única no vacía de `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; vacío/ninguno/mínimo modelo personalizado semántica no se aplican. Los archivos o `-` canalizados explícitamente tienen un límite de 4 MiB y un plazo de lectura de 30 segundos; el cuerpo de administración serializado también debe ajustarse a 4 MiB. Los campos desconocidos se niegan antes de la escritura.

```bash
ocx combo set reliable --targets-file targets.json --image-input auto --reasoning-effort-mode strict --json
ocx combo show reliable --json
```

`--targets-file` y `--targets` son mutuamente excluyentes. Omitir ambos preserva metadatos de destino completos para ediciones parciales; los archivos de reemplazo preservan el orden y el `lastResort: false` explícito. `--image-input auto|disabled` y `--reasoning-effort-mode strict|adaptive` preservan la omisión, mientras que `auto` y `strict` explícitos anulan los valores deshabilitados/adaptativos guardados. El modo Razonamiento-esfuerzo está separado del `--effort-mode fallback|force`, que gobierna el esfuerzo predeterminado. `--allow-metered-targets on|off` otorga o borra el consentimiento del operador para los objetivos combinados marcados en un proxy de solo loopback; las personas que llaman públicas y vinculadas aún necesitan el consentimiento de clave configurada. `--native-alias on|off` conserva explícito falso; la bandera desnuda legado significa verdadero. Desactivarlo puede requerir el alias claro previsto, `--native-alias off --alias -`, para evitar retener un alias nativo incompatible. Establecer/renombrar es un upsert sin CAS, así que vuelve a leerlo después de los cambios. El recibo es `{success, id, model, combo, catalogRefresh}`; la actualización del catálogo omitida, fallida o degradada devuelve un valor distinto de cero después de guardar.

<a id="observe-combo-decision-statistics"></a>

### Observar las estadísticas de decisiones combinadas

```bash
ocx combo stats reliable --range 30d --json
```

Utilice el ID combinado almacenado exacto de list/show, no su modelo público o alias. Los rangos son `7d`, `30d` (predeterminado) y `all`. Esto lee observaciones JEV registradas sin ejecutar una sonda de decisión pagada. Inspeccione las decisiones, los intentos de modelo, los intentos medidos, los tokens de modelo y los tokens de decisión por separado. Mantenga las proporciones de cobertura `measuredModelAttempts/modelAttempts` y `decisionUsageReported/decisions` con los totales. Los promedios nulos no están disponibles, no son cero. Conservar `usageIncomplete`, `historyTruncated`, `entriesTruncated`, recuentos de entrada caída y límites de ventana instantánea. Cero observaciones no prueban el éxito. No hay costos monetarios ni ahorros comparativos en este informe.

Consulte [Combos](/es/guides/combos/) para obtener orientación sobre el comportamiento de enrutamiento y la configuración.

<a id="fallback-off"></a>

## Desactivar el fallback

### `ocx fallback <status|off|on|clear|local> ...`

```bash
ocx fallback status --json
ocx fallback off --kind provider
ocx fallback on --route combo/coding
ocx fallback clear --provider anthropic --kind model
ocx fallback local on --device mac-studio
```

`off`, `on` y `clear` aceptan `--kind model|provider|all` (por defecto, `all`) y como máximo un alcance: `--provider <name>`, `--route <selector>` o `--device <id|alias>`. Sin alcance explícito, modifican el ajuste global. Un dispositivo configurado en off siempre rechaza el fallback; en los demás casos, la ruta tiene prioridad sobre el proveedor y este sobre el ajuste global. `local` guarda si un dispositivo puede usar sus propios proveedores mientras el Home no esté disponible, un permiso que consulta GOAT; OpenCodex sigue devolviendo `home_unreachable` en ese caso. Los comandos se comunican con el proxy en ejecución; en un Remote Link Child, `status` consulta el Home y las escrituras se rechazan. Consulta [Desactivar el fallback](/es/guides/fallback-off/).

<a id="routing-profiles"></a>

## Perfiles de enrutamiento

Los perfiles existentes apoyan la inspección y evaluación a través del API en vivo:

```bash
ocx route policy list --json
ocx route policy show reliable --json
ocx route policy dry-run reliable --model-context 128000 --tools --image --structured-output --json
```

Solo ejecute esta evaluación con autoridad para activar Lab en el destino. La administración POST puede activar Lab e iniciar la automatización que ya está habilitada allí, incluidas las sondas ascendentes. Use list/show para la observación sin ese efecto de activación.

Reemplazar `reliable` con un ID listado. `evaluate` es un alias para `dry-run`; ambos envían requisitos al evaluador del perfil guardado sin una solicitud de inferencia. La creación, actualización y eliminación utilizan el flujo de trabajo explícito de archivo/revisión a continuación. Combo escribe editar un recurso separado. Los perfiles faltantes devuelven la salida 4 y los operandos faltantes devuelven 2.

<a id="edit-a-routing-profile-with-its-observed-revision"></a>

### Editar un perfil de enrutamiento con su revisión observada

Crear/actualizar puede activar la automatización de Lab y ya habilitada, incluidas las sondas ascendentes. Sólo guárdalos con esa autoridad. La lista/presentación son observacionales; primero lea la ayuda fuera de línea y guarde el perfil previsto:

```bash
ocx route policy update --help
ocx route policy show reliable --json > profile.observed.json
jq 'del(.id, .model, .revision) | if .alias == null then del(.alias) else . end' profile.observed.json > profile.next.json
```

Editar y revisar el siguiente archivo; mantener el archivo observado sin cambios. La entrada contiene solo `alias`, `candidates`, `require`, `optimize`, `limits`, `unknownEvidence` y `compatibility` editables con campos anidados admitidos. `id`, `model`, `revision`, las claves desconocidas y el alias nulo no son entradas editables. El servidor sigue validando la semántica de proveedor, alias y políticas. `--file -` acepta stdin canalizado; los archivos/stdin UTF-8 regulares tienen el contrato de lectura de 4 MiB y de 30 segundos acotado.

```bash
ocx route policy update reliable --file profile.next.json --expected-revision '<exact-revision-from-observed-show>' --json
ocx route policy show reliable --json
```

Utilice la revisión opaca original explícitamente. HTTP 409 / exit 5 significa volver a leer show, revisar los cambios concurrentes y reconstruir la edición. Nunca busque silenciosamente una revisión de reemplazo, vuelva a intentar o convierta la actualización en crear. Para un nuevo ID autorizado, utilice `ocx route policy create <new-id> --file profile.next.json --json` sin revisión. La eliminación autorizada es `ocx route policy remove <id> --yes --json` y no tiene guardia de revisión.

Create/update devuelve `{success, id, model, profile, catalogRefresh}` con el nuevo `profile.revision`; quita `{success, id, catalogRefresh}`. Solo la actualización comprometida y no degradada sale 0. Un recibo guardado con salidas de actualización saltadas/fallidas/degradadas 1: inspeccione antes de la recuperación en lugar de repetir la escritura de configuración.

<a id="compatibility-lab"></a>

## Laboratorio de compatibilidad

Lab es la inspección local **y** explícita de pruebas / automatización de gestión. Las lecturas usan la proyección local y no requieren una administración en ejecución API:

```bash
ocx lab status --json
ocx lab catalog --json
ocx lab subjects --limit 10 --json
ocx lab automation status --json
ocx lab automation runs --limit 10 --json
ocx lab public community --json
```

`subject`, `observations`, `event`, `artifact` y `production-signals` siguen el linaje de evidencia local. La familia pública ofrece vista previa/exportación por `--event <id>` repetido, verificación/importación a través de `--file <bundle.json>`, y contexto comunitario. Exportar e importar escribe evidencia local. La verificación puede imprimir su resultado y aún salir de no cero cuando el paquete no es criptográficamente válido.

El manual `lab run` selecciona una capa y un escenario y puede gastar la cuota ascendente. Lea `ocx help lab` y la hoja correspondiente antes de estas operaciones autorizadas. Una política local guardada no prueba que un programador de proxy que ejecuta por separado la haya adoptado. Estos controles CLI no exponen la edición de políticas de automatización completa ni la cancelación de ejecución.

<a id="observability-and-debug"></a>

## Observabilidad y depuración

### `ocx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...`

Inspeccione las solicitudes de proxy, el uso, el almacenamiento, la memoria y los datos de depuración. Los alias directos son:

| Alias | Recursos equivalentes |
| --- | --- |
| `ocx logs [filters] [--follow] [--json\|--jsonl\|--events]` | `ocx observe logs` |
| `ocx usage [--range <today\|1d\|7d\|30d\|all>] [--since <timestamp> --until <timestamp>] [--surface <all\|codex\|claude\|grok>] [--provider <name>] [--model <id>] [--api-key-id <id>] [--search <text>] [--top <1-1000>] [--json]` | `ocx observe usage` |
| `ocx usage compare [--range <today\|1d\|7d\|30d>] [--json]` | `ocx observe usage compare` |
| `ocx storage [--json]` | `ocx observe storage` |
| `ocx memory [--json]` | `ocx observe memory` |

```bash
ocx observe usage --range 30d --json
ocx usage --since 2026-09-01T09:00:00Z --until 2026-09-01T10:59:59.999Z --json
```

`--since` y `--until` deben suministrarse juntos. Aceptan milisegundos de época enteros o fechas ISO completas con una zona horaria explícita, incluyen ambos puntos finales y anulan `--range`. Los límites no válidos o invertidos fallan antes de la solicitud. La salida humana imprime el intervalo solicitado; `--json` incluye `customWindow`, `since` y `until`. Todavía se aplican los filtros de superficie/proveedor/modelo existentes. Estos comandos consultan el proxy en ejecución; no proporcionan informes sin conexión.

`--range today` (alias `1d` ) informa el día local actual. `--provider` y `--model` reducen el informe a un objetivo ascendente, distinto del `--surface`, que selecciona el cliente llamante (Codex, Claude Code, Grok) en lugar del proveedor que atiende la solicitud.

La vista predeterminada imprime la solicitud, el token y los totales de costos estimados, además de los desgloses por proveedor y por modelo. Los costos son equivalentes al precio de lista de API, no un recibo de facturación: los planes de suscripción y los créditos del proveedor se facturan por separado, y las solicitudes sin fila de precios coincidentes se cuentan como `unpriced` / `unmetered` en lugar de doblar como cero.

```bash
ocx usage --range today --provider xai
```

Cuando no se pueden incluir algunos registros de uso, la salida humana advierte, incluso cuando hay cero filas legibles. Los totales mostrados reflejan solamente registros legibles. Si un filtro no tiene coincidencias legibles, la salida muestra la advertencia y la guía en lugar de las líneas totales; los registros omitidos pueden contener coincidencias. `--json` preserva el diagnóstico y la razón del nivel de respuesta `usageIncomplete`.

<a id="compare-a-range-with-the-previous-equal-window"></a>

### Comparar un rango con la ventana igual anterior

```bash
ocx usage compare --range today --json
ocx usage compare --range 7d --provider xai
```

`ocx observe usage compare` es la forma familiar equivalente. El comando lee `GET /api/usage` dos veces: el rango nombrado termina ahora, luego el mismo rango evaluó una ventana igual antes (un día local para `today` / `1d`, siete para `7d`, treinta para `30d`). El rango predeterminado es `30d`. `--range all` se rechaza porque el historial abierto no tiene una ventana igual anterior. `--since` y `--until` no son aceptados; las ventanas se derivan. Los filtros de superficie, proveedor, modelo y API teclas se aplican a ambas lecturas. La salida humana imprime el cambio actual, anterior, firmado delta y porcentual. `--json` es `{schemaVersion,range,current,previous,delta,change,incomplete}`. Las dos lecturas son secuenciales, no una instantánea atómica. La opción personalizada `since` / `until` en cada respuesta debe coincidir con la ventana solicitada. Ambas lecturas usan la misma conexión y credencial. Si la conexión, la cuenta o la credencial cambian durante el comando, se informa de un desajuste del propietario y se le pide que vuelva a intentar en lugar de imprimir una comparación.

<a id="page-indexed-request-history"></a>

### Historial de solicitudes indexadas de página

```bash
ocx logs history --provider xai --status 200 --limit 50 --json
ocx logs history --cursor '<nextCursor>' --json
ocx logs get <request-id> --json
```

`ocx observe logs history` y `ocx observe logs get` son las formas familiares equivalentes. Estos leen el índice de historial de solicitudes derivado, no el reciente anillo `ocx logs`. `--limit` es 1-100 (por defecto 50). `--from` y `--to` aceptan milisegundos de época o fechas ISO completas con una zona horaria y son inclusivos. `--json` devuelve `{entries,hasMore,nextCursor,index}`. `--jsonl` emite filas solamente; cuando existen más páginas, `nextCursor=…` se imprime en stderr para que un llamante pueda reanudar sin mezclar el token en el flujo de filas. Los partidos vacíos tienen éxito. `get` devuelve una fila canónica por ID de solicitud; `ocx logs explain` sigue siendo la vista de decisión de ruta para ese mismo ID.

<a id="filter-a-bounded-log-snapshot"></a>

### Filtrar una instantánea de registro limitado

```bash
ocx logs filter --surface claude --status errors --time-window 1h --scan-limit 2000 --limit 50 --json
```

`ocx observe logs filter` es la forma familiar equivalente. Esto lee una ventana reciente, filtra localmente y luego mantiene las coincidencias más recientes en su orden original. `--scan-limit` controles obtenidos filas (1-2000, por defecto 2000); `--limit` controles filas devueltas (1-2000, por defecto 200). JSON informa `{schemaVersion:1,logs,cursor,filters,window:{scanLimit,loaded,matched,returned,limit}}`. Los recuentos describen esta ventana observada, no toda la historia. JSONL solo emite filas; las coincidencias vacías tienen éxito. Cursor metadatos no es un token de búsqueda reanudable.

Los selectores incluyen `--surface all|codex|claude|grok`, `--status all|success|errors`, `--time-window all|15m|1h|24h`, `--model`, `--provider`, `--conversation` (alias `--conversationId`), `--intercepted-only`, `--min-tok-per-sec`, `--max-tok-per-sec` y `--protocol-mode all|native|translated|legacy-bridge|blocked|none`. La igualdad de modelo/proveedor se recorta y no distingue entre mayúsculas y minúsculas, incluidos los modelos resueltos/servidos y los intentos. Claude incluye Desktop; Codex significa superficie ausente. El éxito es HTTP 200-299, errores 400-599. Los límites inferiores de tiempo son inclusivos. La velocidad utiliza tok/s de valor-bueno observado, con valores mínimos y máximos inclusivos; los valores no disponibles fallan los filtros de velocidad activos. El protocolo ninguno incluye trazas ausentes o no válidas. La coincidencia de conversaciones utiliza los mismos ID de hash que los registros ordinarios. La interceptación selecciona marcadores de reescritura con valor de cadena.

Banderas desconocidas/repetidas/conflictivas, límites inválidos y eventos siguientes/fallos antes del descubrimiento. Las lecturas malformadas, de gran tamaño o fallidas no son cero, no son resultados vacíos. Para reducir el tamaño de la respuesta, reduzca el límite de exploración; reducir el límite de salida no cambia la búsqueda. Para la transmisión, use los formularios de seguimiento separados a continuación.

<a id="search-usage-model-rows"></a>

### Buscar filas de modelo de uso

```bash
ocx usage --range 7d --search 'model-a' --json
```

`--search` coincide con una subcadena recortada que no distingue entre mayúsculas y minúsculas en el modelo, proveedor o modelo resuelto después de leer el informe. Ordena las filas del modelo descendiendo tokens totales con lazos estables y mantiene hasta 100 por defecto. JSON agrega `modelView:{query,matchedModelCount,returnedModelCount,limit:100,truncated}`; la salida humana etiqueta la vista y muestra las filas de modelos seleccionadas. Los totales de los informes, las filas proveedor/día/cuenta, los filtros exactos y los metadatos incompletos/ventana permanecen sin cambios. Ninguna coincidencia de modelo no significa que no se utilice el informe.

Una consulta en blanco explícita (`--search=`) selecciona la vista top-100; la omisión de la búsqueda conserva el resultado existente. Exacto `--provider` / `--model` todavía alcance el informe subyacente. La búsqueda no amplía el auto alcance de la clave seleccionada o del cliente conectado y nunca se envía como un nuevo parámetro de consulta de Hub API.

`ocx usage --top 25` (también `ocx observe usage --top 25`) establece el límite de la tabla del modelo humano a un número entero de 1 a 1000. El valor predeterminado es 10, o 100 con `--search`; el límite se aplica después del filtrado de búsqueda. Solo cambia la visualización local: los totales de los informes, las filas de proveedores/cuentas y los parámetros API permanecen sin cambios. Con `--json`, se ignora un `--top` válido; JSON conserva su informe completo existente o vista de búsqueda de 100 filas. Límites no válidos devuelven la salida 2 antes de buscar.

<a id="saved-companion-usage-totals"></a>

### Totales de uso de compañeros guardados

```bash
ocx companion show --json
ocx companion usage --json
```

El segundo comando lee los ajustes complementarios guardados, luego hoy y el uso de 30d secuencialmente en el mismo entorno de ejecución de administración. Aplica las preferencias guardadas `models` y `hiddenProviders` y conserva los costos y tokens desconocidos / no medidos. La selección de modelo nulo significa todo; una selección vacía significa nada. No cambia la configuración, opera ventanas nativas o retransmite a través de un cliente conectado.

JSON devuelve `schemaVersion:1`, `filters`, `settingsUpdatedAt`, `settingsCorrupt`, `settingsFallback`, `ranges` y `partial`. Cada rango tiene `status:"available"` con `data` filtrado, o `status:"unavailable"`. Un rango no disponible establece el parcial y la salida 1 mientras que retiene el otro rango. Los datos incompletos disponibles conservan sus propios metadatos; no se mide en cero. Los valores predeterminados válidos del servidor retienen una marca de tiempo de configuración nula y establecen un retroceso; los valores predeterminados del archivo corrupto también establecen corruptos y advierten en la salida humana. Los ajustes incorrectos se detienen antes de que se lea el uso. Estas lecturas no son una instantánea atómica. Cada GET tiene una fecha límite de búsqueda/cuerpo de 10 segundos después del descubrimiento y un límite de respuesta de 32 MiB; esta no es una fecha límite de comando completo. Las señales salen 130/143 sin resultados tardíos.

<a id="follow-request-windows-or-injection-sequences"></a>

### Siga las ventanas de solicitud o secuencias de inyección

```bash
ocx logs --help
ocx logs --limit 200 --json
ocx logs --follow --events --limit 200
```

`--events` requiere seguir e implica JSONL; se acepta la redundancia `--jsonl`. `--json` sigue siendo de un solo disparo y entra en conflicto con los siguientes / eventos. Cada línea events-v1 es `{schemaVersion:1,type:"snapshot"|"append",rows,cursor,limit}`. Reemplace la ventana del consumidor en la instantánea, agregue/recortar en el agregado, preservando el orden y los ID repetidos. Se emiten instantáneas iniciales vacías y de reinicio/eliminación; las encuestas vacías estables permanecen en silencio. Las matrices heredadas son instantáneas con cursor nulo, no con cursores inventados. Estas son ventanas observadas, no una repetición sin pérdidas del tráfico que se pierde entre las urnas o después del desalojo del anillo.

`ocx logs --follow --jsonl --limit 200` conserva la salida en forma de fila. Vuelve a emitir eventos modificados, incluyendo el mismo estado de ID / enmiendas de token y ID repetidos. No colapse todo por ID de solicitud. Esta salida heredada no puede codificar eliminaciones, reinicios u orden de ventana exacto; elija eventos cuando esas distinciones importan. El límite de seguimiento de registro es 1-2000, por defecto 200.

```bash
ocx observe injection --limit 500 --json
ocx observe injection --follow --jsonl --limit 500
```

La inyección emite `{seq,at,line}` filas ordenadas, donde `at` es milisegundos de época; el `after` interno avanza con seq. El límite de seguimiento es 1-2000, por defecto 500. JSON es one-shot y JSONL requiere seguir. La observación no permite la captura. Las encuestas vacías no identifican la captura de desactivados ni prueban la ausencia de brechas. La deriva en entorno de ejecución detectable se detiene; no se pueden excluir intervalos de reinicio/última N indetectables sin un marcador de época/intervalo API.

Ambos bucles de seguimiento utilizan esperas de un segundo en serie, fechas límite de búsqueda/cuerpo de 10 segundos y límites de respuesta de 32 MiB. Errores de malformado/sobredimensionado/transporte se detienen con stderr y salida 1, sin reintento/reconexión automática. Reducir el límite para ventanas de gran tamaño. SIGINT/Ctrl-C sale 130, SIGTERM 143, sin encuestas/salida posteriores. Inspeccione el estado de salida y las filas retenidas en lugar de tratar la cancelación como un historial completo.

<a id="companion-timeline-and-key-scoped-usage"></a>

### Línea de tiempo complementaria y uso de key-scoped

```bash
ocx companion timeline --help
ocx companion timeline --hours 24 --bucket-minutes 60 --metric total --aggregation sum --grouping model --model example/model-a --hide-provider excluded-provider --json
```

Reemplace los ID ficticios con los filtros seleccionados. Repita `--model` para los ID de proveedor/modelo individuales (se permiten las barras anidadas; no CSV); repita `--hide-provider` para excluir a los proveedores. Positivo `--provider` no está soportado. Las horas son 6/24/72/168, los minutos del cubo 1-1440 con un máximo de 2000 cubos, métrico total/entrada/salida/caché, suma de agregación/promedio/máx, modelo de agrupación/modelAccount. El API limita las entradas de filtro a 100 elementos. Esto lee el uso sin cambiar la configuración del compañero.

Compruebe `appliedFilters.models/hiddenProviders`. Los límites de la línea de tiempo son segundos de época, con final exclusivo, a diferencia de la ventana personalizada de milisegundos del uso ordinario. El final debe coincidir con el depósito de tiempo de solicitud, o su sucesor inmediato si la solicitud cruza un límite de depósito; se rechaza una ventana alineada más antigua. Las series vacías retienen los metadatos del bucket/filtro. `missingMeasurements` y `truncated` deben permanecer visibles: los puntos sin relleno no demuestran un uso cero completo.

En un host de gestión no cliente:

```bash
ocx access key list --json
ocx usage --api-key-id key-example --range 7d --json
```

Utilice un identificador de clave real no secreto. El CLI requiere un acuse de recibo de respuesta exacto en `filter.apiKeyId`; los filtros ignorados fallan en lugar de mostrar totales no explorados. Un ID desconocido reconocido puede devolver `matched:false` y vaciar el tráfico, no 404. Mantenga los datos incompletos/de ventana personalizada. Los clientes conectados rechazan `--api-key-id` antes del acceso o transporte de clave inscrita; lo omiten para el uso de Hub auto-solamente existente o realizan la vista de clave seleccionada en el Hub. Ninguna autoridad de gestión de concesiones de claves de datos.

### `ocx debug <provider|usage|injection|claude> <on|off|status|reset|logs [-f]>`

Lea o cambie las anulaciones de depuración en entorno de ejecución a través de la administración del proxy en ejecución API.

```bash
ocx debug provider on|off|status|reset
ocx debug provider logs [-f|--follow]
ocx debug usage on|off|status|reset
ocx debug usage logs [-f|--follow]
```

Sin alcance, `ocx debug` imprime el uso y, cuando se detiene el proxy, el entorno de siguiente inicio predeterminado. Depuración de proveedores por defecto desde `OCX_DEBUG=1` (también funciona el legado `OCX_DEBUG_FRAMES=1`); depuración de uso por defecto desde `OPENCODEX_USAGE_DEBUG=1`.

<a id="api-access"></a>

## Acceso API

### `ocx access <key|endpoints|models|test|audio> ...`

Inspeccione las claves de admisión, los puntos finales externos y los modelos con la familia de acceso. `ocx api-key` alias la familia de claves de acceso. La creación y el inicio de rotación devuelven una credencial de texto sin formato de una sola vez en el texto y la salida JSON. Los agentes deben dejar esos pasos a un terminal operado por humanos fuera de la sesión de agente; solicite solo confirmación y claves no secretas / ID de rotación, nunca la credencial.

```bash
ocx access key list --json
```

Después de que el humano configure y verifique el reemplazo, realizar su rotación o eliminar la clave antigua requiere una autoridad de revocación explícita separada. Los seguimientos no secretos seguros son `ocx access key rotate commit <id> <rotation-id> --json` y `ocx access key rotate abort <id> <rotation-id> --json`, con autoridad para la acción elegida. Volver a la lista después. El estado pendiente ausente por sí solo no prueba la confirmación: la expiración o el aborto también pueden borrarlo. No envíe el consentimiento emitiendo directamente la solicitud de gestión de devolución secreta.

<a id="rename-one-key-without-changing-its-access-policy"></a>

### Cambiar el nombre de una clave sin cambiar su política de acceso

```bash
ocx access key rename key-example 'Research client' --json
ocx access key list --json
```

Utilice un ID único real o un nombre inequívoco. Renombrar envía solo `{id,name}` y conserva los alcances del proveedor/modelo; no rota/elimina una clave. La respuesta contiene id/name/createdAt y allowedProviders / allowedModels opcional, nunca texto sin formato o un prefijo. La lista sigue enmascarada. Los nombres están libres de control, recortados, no vacíos y como máximo 64 unidades de cadena JavaScript. La secuencia de lectura/cambio de nombre no es CAS; inspeccione la lista enmascarada después de un resultado desconocido antes de volver a intentarlo. El alias raíz `api-key rename` utiliza el mismo comando.

<a id="explicit-key-model-and-audio-checks"></a>

### Modelo de clave explícita y comprobaciones de audio

Descubre la sintaxis instalada sin contactar con upstream:

```bash
ocx access test --help
ocx access audio transcribe --help
ocx access audio live-check --help
```

Las solicitudes de modelos, las cargas de audio y las verificaciones de sesiones en vivo requieren una autorización explícita del operador para esa operación ascendente en particular y una posible cuota/costo. El operador suministra la clave seleccionada desde una fuente privada aprobada en un terminal operado por humanos fuera de la sesión de agente. Los agentes no deben capturarlo o pedirlo en el chat. Nunca lo ponga en argv / medio ambiente. Estos son el lado ocx de esa tubería privada, no las indicaciones de teclas interactivas directas o un lote de agente:

```bash
ocx access test example/model --protocol responses --api-key-stdin --json
ocx access audio transcribe sample.wav --model gpt-4o-mini-transcribe --api-key-stdin --json
ocx access audio live-check --model gpt-live-1-codex --api-key-stdin --json
```

Elija solo la tarea autorizada y el modelo/archivo real. Se rechaza la entrada TTY. La entrada está limitada a 4096 bytes/30 segundos, ASCII imprimible UTF-8 válido, sin espacios en blanco externos, controles o líneas adicionales; se permite un LF/CRLF final. Esto cubre deliberadamente las claves emitidas actualmente, no todos los valores Unicode que la configuración del servidor podría aceptar. Las ocurrencias exactas de la clave suministrada en el texto permitido se convierten en `[redacted]`; las codificaciones arbitrarias no se garantizan detectadas. No se imprime ningún portador de claves codificado.

Los objetivos son el origen de servicio local comprobado o el origen de concentrador inscrito normalizado existente, con la identidad comprobada alrededor del trabajo asíncrono. No hay un origen personalizado, administración o reserva de clave inscrita, seguimiento de redireccionamiento, caché de credenciales o reintento automático. El operador solo informa al agente sobre el resultado no secreto.

<a id="model-control-and-response-limits"></a>

#### Control del modelo y límites de respuesta

Los protocolos son chat (predeterminado), respuestas o mensajes. El modo de clave seleccionada primero envía un control mal formado sin credenciales: JSON a ese punto final. Solo la clave nativa requerida 401 avanza a una solicitud de modelo de 16 tokens fija usando la clave suministrada. El control tiene un presupuesto de respuesta de 5 segundos/4096 bytes; la solicitud tiene un presupuesto de respuesta de 60 segundos/2 MiB que incluye lecturas del cuerpo. Los controles sin autorización/no reconocidos se detienen antes de la inferencia. La contabilidad de registro/admisión local puede seguir ocurriendo.

JSON es `{schemaVersion:1,control:{outcome,status?},request:{outcome,status?},response?}`. La respuesta segura contiene el protocolo, el texto ordenado, la finalización completa/limitada y los recuentos de tokens medidos opcionales. Una respuesta de longitud limitada utilizable es `limited`; las respuestas de rechazo / filtro de contenido / herramienta o mal formadas no son compatibles, incluso con HTTP 2xx. Los metadatos de error, ID, herramientas y razonamiento no se imprimen. El fallo operativo retiene un informe versionado más stderr/salida 1 fijo; salidas de entrada de gramática/clave no válidas 2 sin un informe fabricado.

El éxito solo dice: "La solicitud sin credenciales fue rechazada; la solicitud del modelo que usa la clave suministrada tuvo éxito". Los cambios de política del oyente entre las llamadas siguen siendo posibles; esto no certifica el alcance de la clave, la admisión atómica o la identidad de facturación. Sin `--api-key-stdin`, la prueba heredada JSON sigue siendo su carga útil original y no dice nada sobre una clave recién seleccionada.

<a id="transcription-and-live-readiness"></a>

#### Transcripción y preparación en vivo

La transcripción requiere un archivo regular no vacío de hasta 25.000.000 bytes, con un límite de lectura local de 30 segundos y un cuerpo multipart de hasta 32 MiB. Admite `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` o `whisper-1`, según el destino. La carga y la respuesta comparten un único límite de 130 segundos; la respuesta no puede superar 2 MiB. Si tiene éxito, devuelve solo `{text}`, incluso si está vacío, y oculta la clave exacta. Si falla, deja stdout vacío, escribe un diagnóstico fijo en stderr y termina con un código distinto de cero; no devuelve un objeto JSON de error ni el cuerpo sin procesar.

El audio utiliza la admisión de clave explícita sin el control del modelo. La verificación en vivo envía solo session.update y session.close fijas. La preparación requiere session.started o session.updated con ID de sesión nativa no en blanco en 15 segundos; el socket abierto o session.created solo es insuficiente. Después de la preparación, espera como máximo 2 segundos para el cierre normal del código-1000. Cada cuadro UTF-8 tiene un límite de 64 KiB, suma 2 MiB; no hay un historial de cuadros retenidos.

En vivo JSON es `{schemaVersion:1,ready,close:"confirmed"|"unverified",check:"session-readiness",event?}`. El fallo operacional preserva esa observación sin marcos en bruto. Disposición parcial con salidas cerradas no verificadas 1; un cierre normal posterior no puede borrar un error anterior. Salida de señales 130/143. Esto comprueba la disponibilidad/cierre solamente, no el micrófono, la carga, la ejecución de la herramienta, la liberación de ida y vuelta de voz completa o el arrendamiento del servidor. La apertura de la sesión previa no está garantizada gratis. Ninguna reconexión o reintento es automático.

### `ocx api <protocols|explain|policy> ...`

Inspeccione y establezca cómo viajan las solicitudes entre las API del cliente y los cables del proveedor. Vea [Rutas de protocolo](/es/guides/protocol-paths/) para el vocabulario.

| Comando | Ruta | Cambia el estado |
| --- | --- | --- |
| `ocx api protocols [--provider <name>] [--json]` | `GET /api/protocols` | No |
| `ocx api explain --model <id> --inbound <responses\|chat\|messages> [--feature <key>]... [--json]` | `POST /api/protocols/plan` | No |
| `ocx api policy [--json]` | `GET /api/protocols` | No |
| `ocx api policy [--messages <on\|off>] [--unrepresentable <legacy\|reject>] [--rollout <switch>=<on\|off>]... [--json]` | `PATCH /api/protocols/settings` | Sí |

- `protocols` imprime la versión del contrato, si cada cliente API está atendido y por qué, la política no representable, cada interruptor de implementación y la revisión de la política. `--provider` agrega el cable ascendente que recibe el proveedor, quién lo decidió y los modelos en otro cable.
- `explain` previsualiza la ruta que tomaría un modelo de un cliente API. `--feature` es repetible y acepta una lista separada por comas; `ocx api protocols --json` enumera las claves de características conocidas. La vista previa se calcula a partir de la configuración: no se envía nada aguas arriba, no se avanza en la rotación combinada y la entrada no se registra.
- `policy` sin una bandera de configuración solo se lee. Con uno, envía un solo cambio al proxy en ejecución, que lo valida, guarda la configuración y responde con la nueva política. `--messages off` también desactiva la integración Claude, como lo hace el conmutador del tablero de instrumentos. Los nombres y las combinaciones de conmutación son validados por el proxy; por ejemplo, se rechaza `--rollout managedMessagesNativeOAuth=on` a menos que `managedMessagesNative` ya esté activado o activado en el mismo commando.

```bash
ocx api explain --model combo/main --inbound chat --feature request.seed,request.tools
ocx api policy --rollout shadowPlan=on
```

Los errores de uso salen 2 antes de que se envíe cualquier solicitud. `--json` imprime el cuerpo de gestión API tal cual.

<a id="client-integrations"></a>

## Integraciones de clientes

<a id="basic-integration-commands"></a>

### Comandos básicos de integración

| Comando | Medidas adoptadas |
| --- | --- |
| `ocx integration client status [--client <id>] [--profile <id>] [--json]` | Lea todas las integraciones de archivos administrados, un cliente o perfiles de Aside. `show` y `list` alias `status`. |
| `ocx integration client history [--client <id>] [--profile <id>] [--json]` | Lea las operaciones de reversión y la disponibilidad de instantáneas. `journal` alias `history`. |
| `ocx integration client enable --client <id> [--profile <id>] [--overwrite-conflict] [--json]` | Aplicar la integración de archivos administrados. Sobrescribir un bloque en conflicto requiere la bandera explícita. |
| `ocx integration client disable --client <id> [--profile <id>] [--json]` | Elimine la integración administrada seleccionada a través de su propietario de tiempo de ejecución. |
| `ocx integration client restore --op <opId> [--client aside --profile <id>] [--confirm-drift] [--json]` | Restaurar una operación registrada; reemplazar ediciones posteriores requiere confirmación explícita de deriva. |
| `ocx integration native [list] [--json]` | Leer estado de integración nativa. |
| `ocx integration native <claude\|claude-desktop\|codex\|grok> <on\|off> [--json]` | Escriba la configuración del cliente nativo seleccionado a través de su propietario en tiempo de ejecución. |

Estos comandos requieren un proxy en ejecución. `--profile` selecciona un ID de cuenta de Aside no negativo y requiere `--client aside`; perfiles omitidos seleccionan el agregado para lecturas y todos los perfiles para habilitación/desactivación sin atar. Conmutaciones nativas cambian la configuración del cliente; Cursor tiene comandos de inspección de solo lectura separados a continuación. Para obtener una vista previa y opciones de escritura limitada, continúe con las recetas a continuación.

<a id="preview-and-recover-managed-file-integrations"></a>

### Vista previa y recuperación de integraciones de archivos administrados

```bash
ocx integration client preview --client hermes --operation apply --json
ocx integration client restore --op op-example --preview --json
```

`op-example` es ficticio; use una identificación de la historia. Las operaciones de vista previa se aplican, sobrescriben y desactivan; la restauración utiliza `--preview` en su comando existente. Revise los cambios estructurales y `canApply` / `willChange`; rechazo válido / salidas no opcionales 0 sin aplicar. Habilitar/deshabilitar/restaurar acepta la opción `--plan-fingerprint` para un compromiso vinculado explícito. Direct escrituras de legado permanecen disponibles. Para previsualizar o escribir vinculado se requiere `--client aside --profile N`. La confirmación de deriva y la sobreescritura nunca son automáticas; las salidas de enlace obsoletas 5 con stdout vacío y una instrucción de revisualización en stderr. Siga el [recetas completas de vista previa/compromiso y deriva](/es/guides/integrations/#preview-and-bind-a-terminal-write).

Droid aplica/sobrescribe los soportes repetidos `--reasoning-default MODEL=EFFORT` para el reemplazo completo del mapa, o el exclusivo `--clear-reasoning-defaults` para `{}`. La omisión preserva el mapa. Repita el mapa exacto en vista previa y confirmación; ver [Droid valores predeterminados](/es/guides/integrations/#factory-droid).

La eliminación de historial es irreversible y requiere un opId exacto más `--yes`: `ocx integration client history remove --op op-example --yes --json` aborda la revista global. Sólo `--client aside` y opcional `--profile N` proporcionan alcances de eliminación más estrechos. La última fila está protegida. `snapshotRemoved:false` sale 1 después de la jubilación con la limpieza incompleta; no vuelva a intentar la eliminación o la reversión de la reclamación.

`ocx integration client sync --client aside --json` actualiza los perfiles elegibles a través del propietario certificado, sin selector de perfil o reserva local. El vacío `results` es una observación exitosa de perfiles no elegibles; una fila fallida hace que el agregado sea distinto de cero mientras conserva otros éxitos. Lea los hechos de estado y recuperación antes de volver a intentarlo; [Los controles de Aside](/es/guides/integrations/#aside-profile-controls) explican la intención del perfil versus el estado del archivo.

<a id="inspect-cursor-without-installing-it"></a>

### Inspeccione Cursor sin instalarlo

```bash
ocx integration native cursor status --json
ocx integration native cursor local-installer --json
```

El estado puede recopilar el inventario del modelo; la búsqueda del instalador puede obtener un manifiesto público. No se descargan/instalan ni cambian el Cursor. El estado distingue la credencial del modo de puerta de enlace de marcador de posición; el marcador de posición no es una credencial de acceso. El instalador `{available:false,url:null,version:null,reason:null}` es válido, incluso cuando Private Inference ya está instalado. Una lectura no disponible válida sale de 0.

### `ocx integration <claude|grok> ...`

Administre las integraciones Claude y Grok compatibles. Las familias de comandos directos a continuación exponen sus controles específicos del cliente.

### `ocx claude [claude args...]`

Asegúrese de que el proxy se está ejecutando, luego inicie Claude Code con `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` y las ranuras del modelo de `config.claudeCode`. Los modelos encaminados aparecen en el selector nativo `/model` a través de alias de ranura estables con Claude Code 2.1.129 o más reciente. En versiones anteriores, seleccione con `ANTHROPIC_MODEL` o `/model <id>`. Las variables `ANTHROPIC_*` exportadas por el usuario siempre tienen prioridad.

Los comandos de perfil Claude Desktop son:

```text
ocx claude desktop [apply]                         Save and apply the four-family profile
ocx claude desktop show [--json]                   Show routes, families, and defaults
ocx claude desktop status [--json]                 Show applied state, drift, and health
ocx claude desktop move <route> <family> [--default]
ocx claude desktop default <family> <route|none>
ocx claude desktop export <path|->                 Export versioned JSON (`-` = stdout)
ocx claude desktop import <path> [--apply]         Validate and import JSON
```

Las familias son `opus`, `fable`, `sonnet`, y `haiku`; nuevas rutas comienzan en `opus`. `none` es válido Sólo cuando la familia está vacía. Legado aplicar banderas `--static`, `--hybrid`, y `--discovery-only`
seguir siendo apoyados. Uso `ocx claude config <status|set> ...` para la configuración de Claude Code.

<a id="read-or-save-the-selected-runtimes-desktop-profile"></a>

#### Leer o guardar el perfil de escritorio del entorno de ejecución seleccionado

Los comandos show/import existentes son locales. La familia `profile` se dirige al entorno de ejecución de la administración en ejecución y puede recopilar el inventario del modelo:

```bash
ocx claude desktop profile show --json > desktop-observed.json
jq '.profile' desktop-observed.json > desktop-profile.json
```

Editar/revisar el perfil versionado, preservando los marcadores aplicados propiedad del servidor. Para un guardado autorizado, lea de nuevo:

```bash
ocx claude desktop profile import desktop-profile.json --json
ocx claude desktop profile show --json
```

Import acepta el perfil en sí, no la respuesta externa `{profile,models,rendered,port}`, utilizando archivos JSON regulares limitados o stdin explícito `-` (4 MiB / 30 segundos). Devuelve esos campos observados más `ok:true`, es decir, guardados solo. `--apply` y se rechazan las banderas en modo nativo; la función de guardado en entorno de ejecución no tiene respaldo local. Apply es una acción de escritorio existente separada en su máquina, así que verifique el host/contexto antes de elegirlo. Los modelos renderizados no son prueba de aplicación nativa.

### `ocx opencode [opencode args...]`

Asegúrese de que el proxy se está ejecutando, después inicia OpenCode con los bloques `provider.opencodex` y `providers.opencodex` generados en la capa de entorno de ejecución en línea de OpenCode (`OPENCODE_CONFIG_CONTENT`). El bloque heredado mantiene a los clientes V1 trabajando con mapas variantes; el bloque V2 lleva matrices nativas para las mismas opciones de esfuerzo de razonamiento y valores predeterminados. La configuración en línea existente se conserva y solo se reemplazan esas dos claves para este lanzamiento. Los archivos globales o de proyecto `opencode.json` se pueden leer para advertir sobre una anulación existente, pero los archivos en el disco nunca se modifican. Los modelos enrutados aparecen como `opencodex/<provider>/<model>`. El lanzamiento del plain `opencode` más tarde se comporta exactamente como antes.

### `ocx grok <status|exclude|include|set|clear|apply> ...`

Administre y aplique la valla modelo Grok Build.

<a id="client-config-export"></a>

## Exportación de configuración de cliente

### `ocx export --client <opencode|pi|omp|hermes|openclaw|kimi|gajae|dsh|mcode|zcode|prime|aside|raycast|omo|cline|kilo|commandcode|droid>`

Imprima una configuración de cliente conectada al proxy en ejecución. El comando serializa el bloque del proveedor `opencodex` (URL base, lista de modelos y el marcador de posición de referencia de credenciales o loopback del cliente) en el formato nativo del cliente seleccionado.

El proxy debe estar ejecutándose; el comando resuelve su puerto activo, lee `/api/models` y emite solo los modelos Codex que puede ver actualmente.

Las exportaciones de OpenCode y Kilo preservan los límites efectivos del modelo, las capacidades conocidas, las opciones de razonamiento declaradas y los valores predeterminados, incluidos los metadatos heredados por las filas personalizadas. Las anulaciones explícitas aún ganan; no se inventan capacidades desconocidas y valores predeterminados. El lanzador de OpenCode utiliza los mismos metadatos. Consulte [Integraciones de clientes](/es/guides/integrations/) para conocer el comportamiento de actualización y actualización administrados.

| Bandera | Medidas adoptadas |
| --- | --- |
| `--client <opencode\|pi\|omp\|hermes\|openclaw\|kimi\|gajae\|dsh\|mcode\|zcode\|prime\|aside\|raycast\|omo\|cline\|kilo\|commandcode\|droid>` | Requerido. Selecciona el dialecto de configuración del cliente. |
| `--json` | Imprima el documento generado como JSON en stdout para scripts. Esto es JSON incluso cuando el formato nativo del cliente seleccionado es YAML, TOML o JSON5. |
| `--out <path>` | Escriba el formato de configuración nativo del cliente en `<path>`. Se niega a reemplazar un archivo existente. |
| `--force` | Permite que `--out` reemplace un archivo existente. |

```bash
ocx export --client opencode                     # config plus destination, merge warning, and counts
ocx export --client pi --json > pi-models.json   # JSON document for a pipe or a diff
ocx export --client omp --out ./omp-models.yml    # native OMP YAML
ocx export --client opencode --out ~/opencodex-opencode.json
```

Sin `--json`, la configuración generada conduce, luego la ruta de destino canónica, la advertencia de fusión, la línea de exportación env donde el cliente tiene uno y un recuento de modelos con cuántas filas omite los límites de contexto (el cliente aplica sus propios valores predeterminados para esos).

| Cliente | Destino canónico | Descargar nombre de archivo | Env var |
| --- | --- | --- | --- |
| `opencode` | `~/.config/opencode/opencode.json` (`XDG_CONFIG_HOME` gana cuando se establece) | `opencode.json` | `OPENCODEX_OPENCODE_API_KEY` |
| `pi` | `~/.pi/agent/models.json` (`PI_CODING_AGENT_DIR` gana cuando se establece; se rechaza un valor relativo) | `pi-models.json` | ninguno - el bloque lleva el literal `opencodex-loopback` |
| `omp` | `~/.omp/agent/models.yml` (`OMP_PROFILE` gana sobre `PI_PROFILE`, incluso cuando está vacío; los perfiles con nombre usan el nombre de directorio `PI_CONFIG_DIR` relativo a la casa e ignoran `PI_CODING_AGENT_DIR`, mientras que el perfil predeterminado permite que `PI_CODING_AGENT_DIR` gane) | `omp-models.yaml` | Ninguno - Loopback placeholder |
| `hermes` | `~/.hermes/config.yaml` | `hermes-config.yaml` | `OPENCODEX_HERMES_API_KEY` |
| `openclaw` | `~/.openclaw/openclaw.json` | `openclaw.json5` | `OPENCODEX_OPENCLAW_API_KEY` |
| `kimi` | `~/.kimi-code/config.toml` | `kimi-config.toml` | Ninguno - Loopback placeholder |
| `gajae` | `~/.gjc/agent/models.yml` | `gajae-models.yaml` | marcador de posición de bucle de retroceso no secreto |
| `dsh` | `$DSH_HOME/settings.yaml` (por defecto `~/.dsh/settings.yaml` ) | `settings.yaml` | ninguno - marcador de posición de portador de bucle de retorno no secreto |
| `mcode` | `~/.minimax/config.yaml` (`MINIMAX_DATA_DIR`, luego el legado `MAVIS_DATA_DIR`, gana cuando se establece; se rechaza un valor relativo) | `mcode-config.yaml` | Ninguno - Loopback placeholder |
| `zcode` | `~/.zcode/v2/config.json` (`dataBaseDir` en la página de inicio predeterminada `setting.json` reubica la raíz; `ZCODE_DATA_DIR` gana cuando se establece; se rechazan los valores relativos) | `config.json` | Ninguno - Loopback placeholder |
| `prime` | `~/.prime/agent/models.json` (`PRIME_AGENT_CODING_AGENT_DIR` gana cuando se establece; se rechaza un valor relativo) | `prime-models.json` | Ninguno - Loopback placeholder |
| `aside` | `~/.aside/u/<account>/models.json` para la cuenta de Aside `accounts.json` nombres como actual; un manifiesto ilegible se rechaza en lugar de por defecto a una cuenta | `aside-models.json` | Ninguno - Loopback placeholder |
| `raycast` | `~/.config/raycast/ai/providers.yaml` en macOS y Windows por igual (Raycast no honra `XDG_CONFIG_HOME`) | `raycast-providers.yaml` | ninguno - solo loopback, no se escribe ninguna entrada `api_keys` |
| `omo` | `~/.omo/agent/models.json` (`OMO_CODING_AGENT_DIR`, luego `SENPI_CODING_AGENT_DIR`, luego `PI_CODING_AGENT_DIR` gana en ese orden cuando se establece; se rechaza un valor relativo) | `omo-models.json` | Ninguno - Loopback placeholder |
| `kilo` | primero existente `kilo.jsonc`, `kilo.json`, `opencode.jsonc`, `opencode.json`, o `config.json` bajo `~/.config/kilo` (`XDG_CONFIG_HOME` reubica ese directorio); utiliza `kilo.jsonc` cuando no existe ninguno | `kilo.jsonc` | `OPENCODEX_KILO_API_KEY` |
| `commandcode` | `~/.commandcode/providers.json` (en Windows con el inicio predeterminado: usar `HOME ?? USERPROFILE` solo si no está en blanco y Windows-absoluto, de lo contrario `homedir()`; se conserva una vivienda suministrada por separado; adjuntar `.commandcode\providers.json`) | `providers.json` | solo loopback; `apiKey: false`; no hay variable de entorno |
| `droid` | `~/.factory/settings.json` ( `%USERPROFILE%\.factory\settings.json` en Windows) | `factory-settings.json` | loopback solamente; no hay variable de entorno |

La exportación DSH administrada requiere DSH 0.1.0-rc.6 o más reciente y solo posee `llm-pi-ai.providers.opencodex`. DSH recarga ese proveedor; el modelo predeterminado del usuario y `deepseek-official` permanecen intactos. Esta exportación es solo loopback y no tiene credenciales reales. La importación de DSH 0.1.7 y más reciente `settings.yaml` una vez en el primer perfil que arranca y luego lo cambia el nombre, por lo que la integración del panel escribe el mismo proveedor en la fila `llm-pi-ai` del perfil de escritorio `$DSH_HOME/profiles/desktop/cordis.patch.yml` una vez que existe ese perfil.

OpenCode interpola `{env:OPENCODEX_OPENCODE_API_KEY}`. Las exportaciones de Pi y OMP generadas no requieren una variable de entorno: cada una lleva el marcador de posición literal `opencodex-loopback`. Esto es soportante porque ambos clientes resuelven `apiKey` mientras construyen sus listas de modelos y ocultan a todo el proveedor cuando una configuración existente contiene una referencia env no establecida. El proxy nunca comprueba el marcador de posición generado en loopback. OMP admite encabezados a nivel de proveedor, pero esta integración inicial permanece deliberadamente solo en bucle; se aplaza el cableado remoto `x-opencodex-api-key`.

La exportación de Raycast es un documento independiente `providers.yaml` con un elemento `id: opencodex` en la secuencia `providers`: `name: OpenCodex`, el proxy `/v1` URL base, y cada modelo encaminado con su `abilities` (`tools` y `system_message` siempre soportado, `vision` de las modalidades de entrada del catálogo, `reasoning_effort` cuando el modelo tiene una escalera de esfuerzo, `temperature` para los modelos de razonamiento). Custom Providers es una función de Raycast Pro, y Raycast observa el archivo, por lo que un cambio guardado entra en vigencia sin reiniciarlo. El formato está documentado en [manual.raycast.com/ai/proveedores personalizados](https://manual.raycast.com/ai/custom-providers). No se escribe la entrada `api_keys`, por lo que esta exportación es solo loopback y se rechaza un enlace que no sea loopback.

Las exportaciones de MCode, ZCode y Prime son solo loop-back por la misma razón y también llevan el marcador de posición `opencodex-loopback` en lugar de una credencial real. El agente principal lee el mismo contrato de `models.json` que Pi, por lo que las dos exportaciones producen el mismo documento; solo el destino difiere. Se rechaza una ruta relativa en cualquiera de esas tres anulaciones de entorno, porque el proxy y el cliente pueden tener directorios de trabajo diferentes y de lo contrario no estarían de acuerdo sobre qué archivo se quiere decir.

ZCode 3.8.1 puede guardar los metadatos de contexto por defecto y derivados del entorno de ejecución `reasoning`, `limit.output` en las entradas generadas `provider.opencodex.models`. El estado de integración administrado trata solo aquellas adiciones documentadas como deriva actualizable. La identidad del proveedor y la configuración de conexión, incluyendo `options.baseURL`, la membresía del modelo, los nombres, las modalidades y cualquier límite de contexto OpenCodex emitido con autoridad permanecen protegidos; editándolos informa `conflict / foreign-edit` en lugar de sobrescribir el archivo. Un registro de propiedad creado por una versión anterior de OpenCodex puede recuperarse automáticamente cuando el catálogo generado no cambia. Si tanto el catálogo como el bloque cambiaron, vuelva a aplicar solo después de revisar el archivo porque el registro anterior no puede probar qué cambio fue derivado de ZCode.

:::caution[Combina la configuración; no la reemplaces]
`ocx export` nunca escribe su configuración de cliente real. El destino está impreso para que usted se fusione con mano, y `--out` se niega a sobrescribir un archivo existente sin `--force`, porque reemplazando a config destruye los otros proveedores, agentes y entradas MCP que ya están en él.
:::

Ninguna llave se serializa nunca. Los Configs llevan una referencia de entorno documentada o un marcador de posición de bucle de retroceso no secreto. Una dirección de loopback (`127.0.0.1`) sola no establece la admisión sin llave: compruebe la política de destino y el punto final. Los comandos de modelo/audio de clave seleccionada aún requieren una entrada de clave explícita en loopback. Establezca una variable referenciada solo cuando el esquema del cliente la admita y el proxy se vincule más allá del bucle de retorno; consulte [Acceso remoto](/es/reference/configuration/server/#remote-access) para conocer cómo se emiten las claves de admisión. Las claves para los propios proveedores ascendentes son una cosa completamente separada, configuradas por [Proveedores](/es/guides/providers/). La integración gjc generada utiliza un marcador de posición de bucle de retroceso no secreto y no necesita ninguna variable de entorno. Sigue siendo solo loopback; no configura las credenciales de admisión remotas.

La misma carga útil es servida por `GET /api/client-config` y renderizada en la pestaña API del tablero de instrumentos, por lo que el CLI, el API y la GUI usan los mismos bytes.

<a id="runtime-and-configuration"></a>

## Tiempo de ejecución y configuración

### `ocx system <status|settings|startup|diagnostics|sync|codex-app-server|codex-restart|update|codex-cli-update> ...`

Gestione la configuración, el inicio, la sincronización, los diagnósticos y las actualizaciones en entorno de ejecución sin cabeza.

`ocx system codex-restart --yes` reinicia Codex servidores de aplicaciones a través del mismo módulo que `ocx sync --restart-codex`. Se cierra y vuelve a lanzar la aplicación de escritorio Codex cuando la aplicación se lanzó antes de que se escribiera el catálogo de modelos actual o esta solicitud cambió su vinculación `model_catalog_json`, porque el selector de modelos se creó en el lanzamiento. De lo contrario, la aplicación permanece abierta, reaparece su propio servidor de aplicaciones y mantiene los borradores no guardados y las aprobaciones pendientes. Si no se puede leer el estado de la aplicación o del catálogo, se reinicia por completo. Cuando el proxy se está ejecutando dentro de la aplicación Codex, el reinicio del escritorio se niega con un mensaje procesable en lugar de prometer un traspaso que no puede completar.

Un enlace `model_catalog_json` modificado por esta solicitud también fuerza el reinicio del escritorio, incluso cuando el shell se inició después de que se escribió el archivo de catálogo.

```bash
ocx system settings --stream-mode eager-relay
```

Otros booleanos del sistema toman encendido/apagado: `--show-codex-credits`, `--account-picker`, `--main-account-hard-lock`, `--ultra-fast-tier` y `--fast-rows`. Escriben solo campos explícitos y pueden combinarse con las opciones del sistema existentes. Mostrar créditos es una preferencia de visualización, no una opción de crédito pagado; el sistema Ultra Fast está separado del proveedor Fast.

Ultra Fast es una configuración opt-in, por defecto desactivado. Con `--ultra-fast-tier on`, el catálogo generado agrega la opción de velocidad ultrarrápida a `gpt-6-astra` y `gpt-6.1-sol` nativos (incluidas las filas vinculadas a la cuenta), por lo que el selector Codex lo ofrece junto a Fast. Ultrafast requiere un plan ChatGPT elegible; el catálogo no puede verificar eso, así que active la configuración solo si su plan lo incluye. Otros modelos y la velocidad predeterminada no se modifican.

Para los modelos enrutados, la convergencia de sincronización y catálogo retiene las entradas `ultrafast` suministradas por el operador de una fila enrutada existente en `service_tiers` y `additional_speed_tiers` junto con su capacidad Fast actual. Las declaraciones pertenecen a la pieza exacta del proveedor/modelo; no se copian a otros modelos. La configuración no crea declaraciones faltantes ni restaura modelos eliminados. Apagarlo elimina Ultra Fast de las filas enrutadas ordinarias y la opción nativa generada en la siguiente regeneración del catálogo.

El modo Fast del proxy decide lo que llega al backend: cuando no está configurado, una solicitud Ultrafast seleccionada se reenvía como `service_tier: "ultrafast"`; `fastMode: true` reemplaza cualquier nivel con Fast (`priority`), y `fastMode: false` elimina el nivel. Deje el modo Rápido sin configurar para usar Ultrarápido.

```bash
ocx system settings --json
ocx system settings --show-codex-credits on --json
ocx system settings --json
```

Nueva opción escribe informe `{ok:true, settings: observedFields, catalogRefreshPending}`. Ultra Fast realiza la lectura GET del mismo objetivo porque PUT omite ese valor. Una observación faltante/incompatible/leída permanece `verification:"unverified"` con `unverifiedFields` y una salida distinta de cero después de la aceptación; los valores solicitados nunca se sustituyen por observaciones. Los switches de escritorio combinados conservan datos almacenados/efectivos y los aplican. El catálogo pendiente o la aplicación nativa diferida/rechazada es distinta de una configuración guardada. Falsa pendiente no es prueba de que cada cliente ha recargado.

`ocx system update` actualiza el propio OpenCodex. La superficie de inspección separada Codex CLI es:

```bash
ocx system codex-cli-update check --json
```

`check` no realiza ninguna solicitud de registro de paquetes e inspecciona la evidencia de procedencia de candidatos configurados limitada, incluida una evidencia de ubicación y propiedad ejecutable redactada. El contexto de lanzador publicado de confianza autentica la instantánea candidata, no la ejecución exitosa de Codex. En POSIX, la selección se certifica solo cuando el solucionador en entorno de ejecución selecciona el mismo candidato de entorno canónico sin ejecutarlo. Un manifiesto vinculado npm-global puede establecer `managed: true` cuando prueba la propiedad y, si se informa de una versión candidata, esa versión coincide con el manifiesto; los candidatos persistentes permanecen sin certificar. El informe JSON expone `candidateAvailable`, `candidateVersion`, `candidateSource` y `selectionAttested`. Inspeccionar el candidato configurado requiere un contexto de lanzador publicado de confianza; un lanzamiento Bun /source directo no tiene tal prueba, ignora el estado del candidato ambiental y persistente, y puede informar `candidate_unavailable` en POSIX. En Windows este primer segmento no realiza ninguna E/S candidata o de sistema de archivos de configuración: solo un candidato de entorno absoluto capturado por prueba puede recibir etiquetas de paquete de aplicaciones o gestor de versiones léxicas; cada otro candidato Windows falla cerrado. Debido a que ese segmento nunca consulta el estado persistente, una ejecución Windows sin informes de candidatos de entorno capturados `windows_inspection_deferred` en lugar de `candidate_unavailable`: el comando no puede observar si está instalado un Codex CLI, por lo que informa el aplazamiento en lugar de afirmar que no existe ningún candidato. El comando no ejecuta Codex o un administrador de paquetes, reparar una shim, escribir configuración o estado de caché, detener un proceso o instalar nada. Los estados de shim independientes, ambiguos y no verificados, reconocidos y agrupados en aplicaciones se informan como no administrados o desconocidos y nunca se clasifican como administrados.

En Windows, un comando desnudo capturado como `CODEX_CLI_PATH=codex`, una ruta remota o una ruta de dispositivo informa `candidate_path_unavailable` en su lugar. Esos casos tienen un candidato capturado; su trayectoria no es elegible para esta inspección.

<a id="read-only-codex-cli-update-plan"></a>

#### Plan de actualización de solo lectura Codex CLI

```bash
ocx system codex-cli-update plan --channel latest --json
```

Ejecute a través del lanzador de nodos publicado con el `CODEX_CLI_PATH` previsto en el entorno de shell. El plan requiere una instalación global certificada de POSIX npm y una versión de manifiesto de paquete vinculada. Consulta el registro oficial npm para una versión exacta, integridad SHA-512 y tarball del mismo origen, utilizando el PATH capturado del lanzador y la configuración, caché y registros temporales aislados npm. La configuración del proxy y `NODE_EXTRA_CA_CERTS` siguen siendo compatibles; la limpieza es el mejor esfuerzo. No se ejecuta el comando Codex.

Un plan aplicable reporta `applicable: true` y una plataforma de enlace determinista `planId`, resumen de la raíz de la instalación, versión instalada, versión / integridad del canal y destino. El plan nunca se mantiene. Rechaza rebajas, versiones ya actuales, Codex sesiones activas y observación de procesos incompletos. Windows devuelve `windows_inspection_deferred` antes de las consultas de registro/proceso. Una denegación sale 0: inspeccionar `applicable` y `refusal`. El argv de instalación impreso es indicativo; este comando no instala nada, no cambia el estado de la aplicación y nunca señala una sesión. No se expone ningún comando apply y un ID de plan no es una autorización de instalación.

<a id="explicit-installation-observation-on-windows-x64"></a>

#### Observación explícita de la instalación en Windows x64

```text
ocx system codex-cli-update attest [--json]
ocx system codex-cli-update attest --candidate <absolute-path> --npm-prefix <absolute-path> --npm-cli <absolute-path> --node <absolute-path> [--json]
```

`attest` es un opt-in, observación de solo lectura de una instalación Windows x64 npm. Sin opciones, identifica el candidato seleccionado a partir de la instantánea del lanzador de prueba: el `CODEX_CLI_PATH` configurado o el primer `codex` en el PATH capturado, con un envoltorio OpenCodex que resuelve su respaldo `codex.opencodex-real.cmd` npm renombrado. Suministrar los cuatro caminos absolutos anula el descubrimiento; el descubrimiento solo propone caminos y la observación manual sigue siendo la autoridad. `--candidate` debe nombrar el estándar npm `<prefix>/codex.cmd` o `<prefix>/node_modules/@openai/codex/bin/codex.js`. `--npm-cli` debe terminar en `node_modules/npm/bin/npm-cli.js`; `--node` nombra un `node.exe` explícito. Los paquetes de aplicaciones, los diseños de administradores de versiones reconocidos, las shims opencodex sin su respaldo npm y los envoltorios personalizados son rechazados.

Los controladores nativos mantienen los directorios y archivos antecesores durante las lecturas limitadas. Las plataformas no soportadas, los puntos/secciones de análisis, los escritores en conflicto, las rutas inseguras y los archivos de gran tamaño son rechazados. El informe fijo no contiene rutas: `status` es `observed` o `refused`, con `installationIdentityObserved`; `selectionAttested`, `managed` y `applyAllowed` permanecen `false`. Compruebe `status`, no solo el código de salida del proceso: un rechazo informado puede salir 0.

Una identidad o resumen observado describe esos archivos durante esta observación. No es un permiso de actualización duradero y no prueba el entorno de ejecución seleccionado, el instalador anterior, la configuración efectiva del npm o la autenticidad de la herramienta. El ejecutable Node suministrado solo se observa; no se ha demostrado que sea el que seleccionaría un lanzador. No se ejecuta ningún destino; no se produce ninguna solicitud de registro, instalación, escritura de configuración o control de procesos. El comando existente Windows `check` todavía no realiza ninguna E/S del sistema de archivos candidato/configuración.

### `ocx config [show|get|set|unset|validate|export|import] ...`

`ocx config [show] [--json] [--source]` muestra la configuración local sin un proxy en ejecución. Omitir `show` también funciona con cualquiera de las banderas o ambas, en cualquier orden. `--source` incluye campos de fuente de diagnóstico, error y advertencia y solo se acepta para su visualización. `--json` puede preceder a una acción explícita; no cambia qué acción se ejecuta. Se rechazan las banderas `--json` o `--source` repetidas y los argumentos desconocidos.

Inspeccione y modifique de forma segura la configuración validada del OpenCodex. `show` y `get` secretos de máscaras. Importar valida antes de escribir y requiere `--yes`.

La visualización y la mutación eliminan las credenciales de las URL proxy al tiempo que retienen el host y el puerto. `direct` y los valores de proxy sin credenciales se mantienen legibles. `export` conserva las credenciales para que la copia de seguridad pueda restaurar la configuración; almacenar los archivos exportados como secretos.

<a id="usage-from-a-connected-client"></a>

### Uso desde un cliente conectado

`ocx usage` lee el concentrador conectado con la clave de datos registrada de este cliente. La salida humana identifica la fuente del concentrador y el alcance de la clave del cliente; `--json` devuelve los mismos datos de alcance. Los filtros de rango, superficie, proveedor / modelo y los límites personalizados `--since` / `--until` permanecen disponibles. Los desgloses de cuentas y los registros de otros clientes no se comparten. Un concentrador antiguo o no disponible produce un error explícito en lugar de sustituir el uso local; actualice el concentrador si no admite esta lectura.

El punto final del plano de datos de solo lectura es `GET /v1/usage`, usando `x-opencodex-api-key` con una clave de cliente configurada. En todo el entorno y las claves de administración son rechazadas. Acepta `range`, `surface`, `provider`, `model`, `since` y `until`; se rechazan las opciones desconocidas / repetidas y los identificadores de clave seleccionados por el llamante. Las filas sobredimensionadas omitidas retienen la advertencia explícita de historial incompleto.

<a id="explain-a-listed-request"></a>

## Explicar una solicitud listada

La salida `ocx logs` humana incluye `id=<request-id>`. Pase ese valor a `ocx logs explain <request-id>` para inspeccionar las decisiones de enrutamiento. Las filas sin ID o con caracteres de control en su ID omiten el campo en lugar de mostrar una clave de búsqueda diferente. JSON y la salida JSONL conservan su esquema existente.

<a id="routing-profile-lookup-status"></a>

## Estado de búsqueda del perfil de enrutamiento

`ocx route policy show <id>` sale 4 cuando el perfil no existe. Faltan o no son válidos los argumentos de comando. Los scripts pueden distinguir un perfil que falta del uso incorrecto.

<a id="upstream-error-details"></a>

## Detalles de error ascendentes

Cuando una envolvente de error ascendente contiene varios campos de mensaje, OpenCodex usa la primera cadena no en blanco en su orden de prioridad establecido. Los campos vacíos o mal formados ya no ocultan un diagnóstico alternativo válido.

<a id="forced-claude-code-subagent-model"></a>

### Modelo de subagente forzado Claude Code

La página Subagentes ofrece **Forzar un modelo para todos los subagentes**, una opción **desactivada de forma predeterminada**. Selecciona un identificador disponible en la lista, como `combo/tev-auto`, y después activa la opción. Primero se ofrece la lista de modelos; las entradas guardadas que ya no estén disponibles no se pueden usar como destino forzado.

`ocx agent subagents force combo/tev-auto` conjuntos `claudeCode.subagentModelForce`; `ocx agent subagents force -` lo aclara. `ocx agent status` informa de la configuración. `GET /api/subagent-models` devuelve `force`, `forceAvailable` y `forceStatus`; `PUT` acepta `{ "force": "combo/tev-auto" }` o `{ "force": null }` sin cambiar la lista. Omitir `force` lo deja sin cambios. Los objetivos inválidos o no expuestos son rechazados en la escritura; los objetivos obsoletos son reportados y omitidos en el lanzamiento.

Esto tiene efecto en el **siguiente inicio enrutado de `ocx claude`**, inyectando `CLAUDE_CODE_SUBAGENT_MODEL` como un alias proxy explícito (con `[1m]` solo para una ventana autorizada de un millón de tokens; los objetivos nativos Claude usan un alias nativo reversible) y `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. Cada variable no vacía exportada por el shell gana independientemente. Los lanzamientos nativos no inyectan ninguna variable; el plano `claude` no se ve afectado. No hay archivos de plugin o `settings.json` se modifican por esta configuración.

Claude Code **2.1.257 o más reciente** es necesario para la fuerza. Los argumentos de modelo de complemento y agentes incorporados (incluyendo Explorar/Planear) y por llamada se anulan. Las bifurcaciones y las habilidades de subagente con `model: inherit` mantienen el modelo de conversación principal. El bucle principal y los sidecars de pequeño-rápido no se ven afectados. Los archivos de la lista existentes permanecen disponibles.

El panel de control advierte sobre versiones antiguas o desconocidas de CLI, objetivos no disponibles y cualquiera de las variables ya presentes en `settings.json` → `env` (que anula env de lanzamiento). La detección es de solo lectura y local en el servidor: no puede inspeccionar otro shell de lanzamiento, otra máquina o la configuración local del proyecto. Un resultado desconocido no es prueba de apoyo a la fuerza.
