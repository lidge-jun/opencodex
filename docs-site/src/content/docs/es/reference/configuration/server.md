---
title: "Configuración de servidor y entorno de ejecución"
description: "Listener, acceso remoto, claves de admisión, tiempos de espera, almacenamiento, sidecars, llamadas auxiliares e inicio del entorno."
---

La configuración del servidor controla la forma en que el proxy local escucha, protege el tráfico remoto, administra los recursos y ejecuta las funciones de ayuda en torno a las solicitudes del proveedor.

<a id="server-fields"></a>

## Campos del servidor

`completeOnMaxOutputTokens` es un booleano opcional, `false` de forma predeterminada. Actívalo para que una respuesta de texto de Responses traducida y limitada por tokens se indique como `completed` en lugar de `incomplete`. El texto sigue truncado: OpenCodex lo conserva exactamente, incluido cualquier Markdown sin terminar. Solo admite salida de texto plano no vacía. Quedan excluidas las llamadas a herramientas y operaciones alojadas, aunque hayan terminado, el razonamiento, `text.format` con `json_schema` o `json_object`, la compactación, los turnos explícitamente sin terminar, los errores y la ausencia de eventos terminales. El agotamiento de la ventana de contexto y `pause_turn` siguen siendo incompletos. Chat Completions, Anthropic Messages y el paso directo nativo de Responses, incluida su salida WebSocket nativa, conservan su comportamiento de finalización.

| Campo | Tipo | Predeterminado | Descripción |
| --- | --- | --- | --- |
| `completeOnMaxOutputTokens?` | `boolean` | `false` | Activa la finalización de las respuestas de texto de Responses traducidas que cumplan las condiciones y alcancen el límite de tokens. El texto sigue truncado; se aplican las exclusiones anteriores. |
| `port` | `number` | `10100` | Puerto de escucha proxy. |
| `hostname?` | `string` | `"127.0.0.1"` | Dirección de escucha. Fuera de loopback se requiere un token de admisión de datos, buscado en este orden: `OPENCODEX_API_AUTH_TOKEN`, `OCX_API_TOKEN_FILE` y el archivo instalado `service-api-token`, accesible solo por su propietario. No es necesario exportarlo manualmente. Véase [Acceso remoto](#remote-access). |
| `proxy?` | `string` | — | URL de proxy de salida HTTP(S) o SOCKS5 (`socks5://host:port`), `${ENV_VAR}` o `"auto"`. Las URL HTTP se aplican a `HTTP_PROXY` / `HTTPS_PROXY` si no están definidas. SOCKS5 utiliza el transporte de OpenCodex y también se expone mediante `ALL_PROXY` (`ocx start --socks5`); en este proceso se elimina el `HTTP(S)_PROXY` heredado. Loopback permanece en `NO_PROXY`. `"auto"` lee una vez al iniciar la configuración estática HTTP/HTTPS de WinINET en Windows o de macOS. Las variables HTTP(S) heredadas omiten esa detección; en macOS también lo hacen `ALL_PROXY`/`all_proxy`. Windows conserva por separado `http=` y `https=`; un `ProxyServer` sin prefijo se aplica a ambos. macOS convierte las IP literales, `*` y el patrón válido `*.<domain>` en la exclusión `.<domain>` de Bun. Este patrón también excluye el dominio raíz `<domain>`. Los rangos de enlace local exactos `169.254/16`, `169.254.0.0/16` y `fe80::/10` se omiten con un diagnóstico: sus IP literales usan el proxy. Otros CIDR, patrones y excepciones de host simple hacen que se rechace la detección sin alterar el entorno del proxy. No se siguen configuraciones desactivadas o mal formadas, PAC/WPAD, configuraciones que solo usan SOCKS ni cambios en vivo. Reinicie después de cambiar los ajustes del sistema. |
| `noProxy?` | `string \| string[]` | — | Hosts que omiten `proxy`; se combinan con las entradas heredadas de `NO_PROXY` y las de loopback. La cadena admite la sintaxis de `NO_PROXY` separada por comas o `${ENV_VAR}`. |
| `emptyCompletionRetry?` | `boolean` | `false` | Activa un único reintento idéntico de Responses cuando el turno no contiene texto ni llamadas a herramientas. Incluye flujos que terminan antes del evento final y fallos `MALFORMED_FUNCTION_CALL` de Vertex AI anteriores a cualquier salida. El reintento puede generar un cobro. `OCX_EMPTY_COMPLETION_RETRY=0` lo desactiva sin modificar la configuración. Los turnos Combo y de compactación enrutada quedan excluidos. |
| `dropCodexSafetyBuffering?` | `boolean` | `false` | Elimine las sugerencias opcionales orientadas al cliente de los campos canónicos Codex Responses passthrough: los dos encabezados de respuesta `x-codex-safety-buffering-enabled` / `x-codex-safety-buffering-faster-model`, los eventos `response.metadata` cuyo tipo de metadatos es `safety_buffering` y los campos `safety_buffering` de nivel superior. Se conservan otros encabezados, datos de respuesta, rechazos de políticas y fallos. Esto no inhabilita la aplicación de la seguridad del proveedor o el almacenamiento en búfer aguas arriba. Los metadatos nativos `codex.response.metadata.headers` WebSocket y `/responses/compact` están fuera de este filtro. |
| `stallTimeoutSec?` | `number` | `300` (público) / desactivado (local) | Segundos sin progreso significativo del proveedor (Responses y Chat nativo) antes de cortar el flujo. Si no se configura, un proveedor **local** (loopback, dirección privada o nombre `.local`/`.lan`) no tiene este límite; uno público tiene 300 s. Un valor positivo se aplica a ambos (mínimo 1 s); `0` desactiva el supervisor de inactividad en todos los casos. Así, un modelo local que sigue conectado puede permanecer en silencio mientras envía señales de mantenimiento. Las Responses canónicas de ChatGPT que se convierten de SSE a JSON sin streaming conservan un límite total independiente de 15 minutos. Las lecturas pendientes del cuerpo de `/v1/responses/compact` comparten este presupuesto, pero su valor predeterminado es 300 s incluso con un proveedor local, porque la ruta almacena el cuerpo completo mientras conserva una reserva de turno activo. Un valor explícito, incluido `0`, tiene prioridad. |
| `oauthOpenBrowser?` | `boolean` | `true` | Permite abrir el navegador en la máquina que ejecuta el proxy al iniciar sesión. Omitir el campo o usar `true` conserva esa apertura; solo `false` la desactiva. Es útil si necesita otro perfil de navegador o si el panel está en otra máquina: el inicio de sesión comienza igualmente y se devuelve y muestra la URL. `POST /api/oauth/login` y `POST /api/codex-auth/login` admiten un booleano `openBrowser` por solicitud que tiene prioridad sobre este ajuste; el panel ofrece la misma opción junto al botón de inicio de sesión. Ambas rutas informan `browserLaunch`: `started`, `failed` (el panel indica que no se pudo abrir) o `skipped`. Los flujos con código de dispositivo nunca abren el navegador. |
| `connectTimeoutMs?` | `number` | `200000` (público) / desactivado (local) | Plazo por intento desde el envío hasta el primer encabezado del proveedor, incluidos DNS, TCP, TLS y la espera de encabezados. Termina antes del cuerpo y es independiente de `stallTimeoutSec`. Sin configurar, un destino local (loopback, privado o nombre `.local`/`.lan`) no tiene plazo y uno público usa 200 s. Un valor positivo se aplica a ambos; `0` o un valor no positivo desactiva el plazo en todos. Así un modelo local puede dedicar minutos al prefill sin interrumpir un turno sano. |
| `shutdownTimeoutMs?` | `number` | `5000` | Plazo para finalizar los turnos de forma ordenada antes de abortar los que sigan activos. |
| `websockets?` | `boolean` | `false` | Anuncie y admita la ruta Responses WebSocket orientada al cliente. False mantiene a los clientes en HTTP / SSE; no desactiva una optimización WS canónica elegible de ChatGPT. Las solicitudes de entrada completa pueden reutilizar una conexión ascendente dentro de la misma credencial, cuenta, subproceso y turno seleccionados; la política de enlace cambiada o la identidad faltante mantienen las solicitudes en conexiones separadas. Esto no recorta la entrada HTTP ni crea ID de respuesta anterior. |
| `codexNativeSteering?` | `boolean` | `false` | Control experimental durante un turno nativo en el endpoint Responses WebSocket. Requiere `websockets: true`, proveedor y cliente compatibles, y una cuenta, modelo y conjunto de herramientas fijos. Los parámetros de generación validados pueden cambiar en continuaciones explícitas de resultados guardados. No habilita modelos traducidos ni una alternativa por HTTP. Véase [Control nativo](/es/guides/codex-integration/#experimental-native-mid-turn-steering). |
| `codexNativeInjection?` | `boolean` | `false` | Inyección experimental de resultados de funciones guardados en turnos multiagente WebSocket nativos compatibles. Requiere `websockets: true`, `multi_agent.enabled` explícito y un proveedor apto. Es independiente del control durante el turno; no vuelve a ejecutar herramientas ni crea una recuperación automática. Véase [Inyección nativa](/es/guides/codex-integration/#experimental-native-function-result-injection). |
| `nativeReasoningRetention?` | `{ modelSwitch?: boolean; accountSwitch?: boolean }` | ambos `false` | Permite reenviar el razonamiento cifrado al cambiar de un modelo o una cuenta conocidos dentro del mismo backend canónico de ChatGPT. La retención entre cuentas es experimental. Consulta [Retención del razonamiento nativo](#native-reasoning-retention). |
| `workflowBudget?` | `{ maxConcurrentChildren?: number; maxPhysicalSends?: number; maxDistinctChildren?: number }` | `8` / `256` / `64` | Límites por tarea: turnos simultáneos, envíos al proveedor por ventana de 10 minutos y subagentes distintos por ventana. Los campos omitidos conservan su valor integrado. Consulta [Límites del flujo de trabajo](#workflow-limits). |
| `corsAllowOrigins?` | `string[]` | `[]` | Orígenes exactos adicionales permitidos por CORS. Los orígenes de Loopback siempre están permitidos. Se admiten orígenes de extensión de navegador basados en autoridad como `chrome-extension://<extension-id>`; `*` no es un comodín. Firefox y Safari regeneran la extensión UUID (por instalación / por lanzamiento del navegador), así que actualice la entrada cuando cambie el origen. |
| `apiKeys?` | `OcxApiKey[]` | `[]` | Credenciales generadas `ocx_…` para admitir tráfico de datos fuera de loopback. Se administran desde el panel y no autorizan las API de administración; estas utilizan la credencial independiente indicada en la [referencia de administración](/es/reference/management-api/). |
| `storageCleanupPolicy?` | `StorageCleanupPolicy` | desactivada | Política de limpieza de sesiones archivadas que requiere activación explícita. Nunca se habilita implícitamente. |
| `usageLedgerMaxBytes?` | `number` | Sin configurar | Techo opt-in en bytes para `usage.jsonl`. Ausente significa que el historial de solicitudes crece sin límite, lo que se mantiene como predeterminado. Véase [tamaño del historial de uso](#usage-history-size). |
| `appOwnedMemoryBudgetMb?` | `number` | `256` | Límite en MiB para registros, cachés, blobs y cargas de continuación propios de la aplicación que se pueden desalojar. Rango 64–4096; no limita el RSS del proceso. |
| `metricsExport.enabled?` | `boolean` | `false` | Habilite las métricas de solicitud agregada local de proceso en `GET /api/metrics` autenticado. Se requiere reiniciar; el modo desactivado devuelve 404 y no inicia ninguna actividad de exportador. |
| `serviceHealthRecovery.enabled?` | `boolean` | `false` | Recuperación opt-in para el servicio en segundo plano: un pequeño proceso centinela sondea `/healthz` y, cuando el proxy permanece vivo pero no responde nada durante aproximadamente un minuto de sondas consecutivas, lo termina para que el administrador del servicio (Task Scheduler, launchd, systemd, WinSW) lo reinicie. Solo el hijo de servicio administrado inicia uno; las solicitudes del proceso bloqueado no se reproducen. Como máximo tres recuperaciones por hora. Reiniciar requerido. La recuperación automática requiere una dirección de enlace numérica (o la asignación localhost/wildcard predeterminada); Los nombres de enlace DNS no se supervisan. Una dirección grabada o puerto modificados detiene la supervisión. |
| `spend?` | `{ root?: { maxTokens?: number }; identity?: { maxTokens?: number }; pool?: { maxTokens?: number }; retentionDays?: number }` | Sin configurar | Límites persistentes de tokens, desactivados hasta que se configura uno. Cada ámbito incluye el gasto liquidado, las reservas en curso y el gasto pendiente de resolver: `root` abarca una tarea y todas sus subtareas, `identity` una cuenta en todas las tareas que atiende y `pool` un grupo de proveedores. La solicitud solo se admite si hay capacidad en los tres ámbitos; crear un ID de tarea nuevo por solicitud no evita estos límites. Cada reserva incluye toda la entrada y el límite de salida exigible, suponiendo que no se aprovecha ningún prefijo en caché. El modo de solo observación también escribe en el registro; por eso cada servidor conserva la reserva de escritor único del directorio de estado, y otra instancia explícita debe usar su propio `OPENCODEX_HOME`. El gasto se conserva tras un reinicio normal si las escrituras llegaron al sistema de archivos, pero no se garantiza que sobreviva a un corte eléctrico porque cada anexión no se sincroniza físicamente. Subir o eliminar un límite solo modifica la capacidad de las solicitudes iniciadas después; las que ya están en curso mantienen su política inicial. `maxTokens` debe ser un entero positivo (0 rechazaría todo); `retentionDays` admite 1–365 y usa 7 de forma predeterminada. Las claves desconocidas se rechazan. El rechazo local devuelve HTTP 429 con `x-opencodex-local-refusal: workflow_spend_exhausted` e identifica el ámbito y el límite; no se contacta al proveedor. Con un límite aplicable también se rechaza el envío si no puede registrarse su reserva, incluso cuando se agotó la capacidad de seguimiento. Sin un límite aplicable se mantiene el modo de solo observación. |
| `codexAutoStart?` | `boolean` | `true` | Permite que el shim de Codex ejecute `ocx ensure` antes de iniciar Codex. Con `false`, ensure no realiza ninguna acción. |
| `codexShimAutoRestore?` | `boolean` | `true` | Restaura el shim instalado cuando una actualización externa de Codex lo reemplaza al completarse. Se puede desactivar mediante `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0`. |
| `codexDesktopAuthless?` | `boolean` | `false` | Enrutamiento de Codex Desktop sin inicio de sesión, con activación explícita y solo en loopback: inyecta el proveedor dedicado `opencodex` con `requires_openai_auth = false`. Se ignora fuera de loopback. `ocx system settings --desktop-authless on`. Véase [Integración con Codex](/es/guides/codex-integration/#authless-codex-desktop-opt-in). |
| `codexAccountPickerEnabled?` | `boolean` | Sin configurar | Controla si se anuncian las filas generadas del catálogo con cuenta específica (`<selector>/<model>`). Al habilitarlo, completa un `codexAccountNamespaces` ausente o vacío con los selectores predeterminados; `false` oculta esas filas sin eliminar los enlaces exactos de enrutamiento. Si se omite, un mapa de selectores manual no vacío sigue activo. La fila Luna Reserve también requiere una cuenta específica: solo se escribe cuando un selector apunta a la cuenta principal de Codex. Si se omite, la sincronización registra el motivo y la acción necesaria para recuperarla. |
| `codexAccountNamespaces?` | `Record<string, string>` | Sin configurar | Mapa de selectores públicos a cuentas de Codex. El inicio de sesión principal usa el marcador de configuración `@main`; las cuentas añadidas usan su ID. Normalmente se genera al habilitar `codexAccountPickerEnabled`. Un mapa vacío significa que no hay filas con cuenta específica, incluida Luna Reserve. |
| `codexClientCompaction?` | `boolean` | `false` | Activa explícitamente la compactación del cliente Codex en loopback autenticado. Usa el proveedor dedicado `opencodex` con `requires_openai_auth = true`, evitando que las nuevas compactaciones enrutadas almacenen estado `ocx1:` de OpenCodeX. Si también está habilitado, `codexDesktopAuthless` tiene prioridad y conserva `requires_openai_auth = false`. El enrutamiento V2 de subagentes no cambia. `ocx system settings --client-compaction on`. Véase [Integración con Codex](/es/guides/codex-integration/#client-side-compaction-opt-in). |
| `codexProviderDisplayName?` | `string` | `"OpenCodex Proxy"` | Nombre visible del proveedor `opencodex` inyectado en Codex, escrito en el campo `name` de `config.toml` y del perfil de referencia. Solo cambia la presentación: el enrutamiento utiliza el ID `opencodex`, por lo que renombrarlo no mueve `model_provider = "opencodex"` ni la cabecera `[model_providers.opencodex]`, y conserva los hilos asociados a ese ID. Codex exige un nombre; use una etiqueta neutra si lo prefiere. Un valor vacío, de más de 128 caracteres o con caracteres de control se ignora y se sustituye por el predeterminado. |
| `codexMainAccountHardLock?` | `boolean` | `true` | Bloquea nuevas solicitudes que coincidan con la identidad de la cuenta principal cuando se alcance el umbral de su ventana. Solo `false` explícito lo desactiva. Véase [Protección de la cuenta principal](/es/reference/cli/providers-accounts/#main-account-quota-protection). |
| `codexMainAccountHardLockThresholds?` | `{ short?: number; long?: number }` | `{ short: 90, long: 98 }` | Umbrales independientes para las ventanas de 5 h y semanal/mensual. Enteros entre 80 y 100, con `short <= long`. Los valores persistidos no válidos vuelven a los predeterminados; la API rechaza las escrituras inválidas antes de modificar la configuración. |
| `codexMainAccountHardLockFallback?` | `{ enabled?: boolean; model?: string; reasoningEffort?: string }` | desactivado | Mientras el bloqueo esté activo y ninguna cuenta de Codex pueda atender la solicitud, redirige las solicitudes de modelos nativos de Codex a `model` con `reasoningEffort`. `enabled: false` pausa la alternativa y conserva el modelo. Sin la sección o el modelo se mantiene el rechazo; una cuenta Pool utilizable sigue teniendo prioridad. `reasoningEffort` debe ser un esfuerzo declarado. Una sección persistida no válida desactiva la alternativa y la API rechaza escrituras inválidas antes de modificar el estado. Véase [Protección de la cuenta principal](/es/reference/cli/providers-accounts/#main-account-quota-protection). |
| `nativeMainRefresh?` | `"codex" \| "opencodex"` | automático | Determina quién renueva el inicio de sesión nativo principal de ChatGPT en `CODEX_HOME`. `"codex"` consulta el binario de Codex mediante app-server `getAuthStatus` (Codex 0.130.0 o posterior, localizado con la misma resolución que `ocx sync`, incluido el paquete de ChatGPT) y nunca escribe `auth.json`; también funciona con credenciales guardadas en el llavero del sistema. Si falta el archivo, las solicitudes nativas Pool y Direct guardadas consultan el inicio de sesión actual de Codex, también tras reiniciar; los cierres de sesión y cambios de cuenta se aplican en la siguiente consulta. Cada respuesta del llavero es autoritativa para esa consulta: un token ausente o retenido deja esa materialización no disponible y una respuesta posterior puede reutilizar incluso el mismo bearer. No se conserva un rechazo permanente; las solicitudes que ya tienen un token pueden terminar sin volver a comprobarlo al enviar. Las credenciales en archivo no cambian. Un cambio de cuenta verificado elimina las restricciones de cuota de la anterior antes de seleccionar; en la primera consulta tras reiniciar, un registro de cuota válido debe identificar otra cuenta para eliminarlas. La misma cuenta conserva sus restricciones y las pausas manuales no cambian. Las consultas de cuota de las tarjetas, la preparación inicial del Pool y la recuperación inactiva de cuota principal también usan ese inicio de sesión; la recuperación pasiva conserva la cuarentena de reautenticación por tráfico. `"opencodex"` conserva el escritor protegido de `auth.json` de OpenCodex. Si se omite y hay un binario compatible, elige `"codex"`; sin él, tanto la omisión como `"codex"` recurren al escritor protegido. `ocx doctor` muestra el modo activo. |
| `resetCreditAutoRedeem?` | `{ enabled?: boolean; leadTimeMinutes?: number }` | desactivado | Activación explícita: canjear el crédito de restablecimiento más pronto de la cuenta principal Codex `leadTimeMinutes` (1–60, por defecto 10) antes de que expire. Cada intento vuelve a leer la lista de crédito ascendente primero y se salta cuando el crédito se ha ido (por ejemplo, canjeado a mano); `redeem_request_id` Es journalizado en `$OPENCODEX_HOME/reset-credit-auto-redeem.json` antes de la llamada, por lo que un bloqueo reproduce la misma solicitud idempotente en lugar de gastar un segundo crédito. Los servidores que comparten este directorio de configuración coordinan las reservas y liquidaciones para que un proceso no reemplace el registro de solicitud de otro. Los registros solo llevan una clave de cuenta hash. |
| `syncResumeHistory?` | `boolean` | `true` | Compatibilidad reversible con el historial de Codex App. Los metadatos originales se respaldan y se restauran mediante `ocx stop` / `ocx restore`. |
| `spendPoolAliases?` | `Record<string, string>` | Sin configurar | Mapa explícito de alias históricos de grupos, calculados con sal, a proveedores canónicos. Mantenga esta clave en el nivel superior, fuera de `spend`. Véase [Continuidad histórica de los grupos](#historical-pool-continuity). |
| `shadowCallIntercept?` | `{ enabled?: boolean; model?: string; sourceModels?: string[] }` | desactivado | Redirige llamadas auxiliares reconocidas de Codex al modelo elegido, conservando su esfuerzo de razonamiento. Los prefijos predeterminados son `gpt-6-luna` y `gpt-5.6-luna`. El panel ofrece un interruptor por origen; las generaciones Terra (`gpt-6.1-terra` y `gpt-5.6-terra`) y el antiguo `gpt-5.4-mini` permanecen desactivados hasta seleccionarlos. Debe quedar al menos un origen activo; desactiva el interruptor principal para detener todas las llamadas de sombra. |
| `memoryModels?` | `{ extract?: { model: string; reasoningEffort?: string }; consolidation?: { model: string; reasoningEffort?: string } }` | desactivado | Enruta las dos fases de memoria de Codex a un modelo elegido, con un esfuerzo de razonamiento opcional por fase. Véase [Enrutamiento de memoria](#memory-routing). |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | activado si está disponible | Opciones del asistente de búsqueda web. |
| `visionSidecar?` | `OcxVisionSidecarConfig` | activado si está disponible | Opciones del asistente de descripción de imágenes. |
| `images?` | `OcxImagesConfig` | selección automática de OpenAI | Opciones del relay independiente de imágenes para `image_gen` de Codex. |

En Linux x64/arm64 con soporte para pidfd, la recuperación del servicio vincula la terminación a la identidad del proceso del proxy en el kernel; la reutilización del PID no puede redirigirla. El mensaje de supervisión del centinela termina en `(pidfd)`. Los kernels o arquitecturas sin soporte conservan la comprobación existente del PID del proceso padre activo y registran esa alternativa. Otros fallos de vinculación desactivan la recuperación para ese proxy. macOS conserva la comprobación del proceso padre activo y Windows su vinculación al identificador de proceso.

<a id="native-reasoning-retention"></a>

## Retención del razonamiento nativo

El resumen del panel ofrece dos opciones independientes: conservar el razonamiento al cambiar de modelo y conservarlo al cambiar de cuenta. Ambas están desactivadas de forma predeterminada. También puede guardar esta política en `config.json`:

```jsonc
{
  "nativeReasoningRetention": {
    "modelSwitch": true,
    "accountSwitch": false
  }
}
```

Este ejemplo conserva el razonamiento `encrypted_content` al cambiar a un modelo conocido dentro del mismo destino nativo de ChatGPT y con la misma credencial. Establezca `accountSwitch` en `true` solo si desea el reenvío experimental entre cuentas. Si cambian tanto el modelo como la cuenta, deben estar activadas ambas opciones. La política se aplica a cada destino nativo real de un Combo y a los reintentos del grupo; no habilita la retención para destinos de terceros ni para los que usan claves API.

La retención permite que OpenCodex reenvíe el texto cifrado recibido; no confirma que el proveedor acepte o reutilice ese razonamiento. Un rechazo de descifrado detectado activa la recuperación existente con limpieza limitada, y ese rechazo tiene prioridad sobre ambas opciones. Las referencias de respuestas y conversaciones, los ID de razonamiento ajeno, las restricciones de cuenta de los archivos subidos y el aislamiento de la caché mantienen sus propias reglas de propiedad. Los bloques de compactación nativa conservan su limpieza habitual; el saneamiento nativo directo de `/v1/responses/compact` no cambia.

Utilice `GET /api/native-reasoning-retention` para leer los booleanos efectivos y `PUT` con un objeto booleano parcial para modificarlos. `PUT` con JSON `null` restaura ambos valores predeterminados. Los campos no válidos y las claves desconocidas se rechazan; un bloque mal formado en el archivo desactiva la retención y genera una advertencia. Los cambios desde el panel o la API se aplican a las solicitudes posteriores. Los cambios locales con `ocx config set/unset` requieren reiniciar el proxy.

<a id="workflow-limits"></a>

## Límites del flujo de trabajo

OpenCodex limita cuánto puede expandirse una tarea. Cada tarea incluye la conversación raíz, identificada por el encabezado del cliente `x-codex-parent-thread-id`, y todos los subagentes que crea. Se aplican tres límites de cantidad. Las solicitudes que superan alguno se rechazan localmente con HTTP 429 y un encabezado `x-opencodex-local-refusal` que identifica el límite (`workflow_concurrency_exhausted`, `workflow_sends_exhausted` o `workflow_children_exhausted`); no se contacta con ningún proveedor.

| Campo | Predeterminado | Permitido | Significado |
| --- | --- | --- | --- |
| `maxConcurrentChildren` | `8` | 2–64 | Turnos simultáneos de una tarea. Siempre se reserva un espacio para la conversación raíz, por lo que los subagentes disponen de uno menos. |
| `maxPhysicalSends` | `256` | 1–10000 | Envíos al proveedor, incluidos los reintentos, tras los cuales se rechazan las solicitudes nuevas de la tarea durante el resto de la ventana de 10 minutos. El contador se comprueba al admitir una solicitud: los reintentos de solicitudes ya admitidas y las solicitudes admitidas en paralelo pueden superar el límite total. |
| `maxDistinctChildren` | `64` | 1–1024 | Hilos de subagentes distintos que una tarea puede iniciar durante esa misma ventana. |

Los valores predeterminados sirven para la mayoría de las instalaciones. Súbelos si un flujo que necesita muchos subagentes alcanza los límites repetidamente; bájalos para frenar antes una expansión descontrolada:

```jsonc
{
  "workflowBudget": {
    "maxConcurrentChildren": 16,
    "maxPhysicalSends": 1024
  }
}
```

La página **Subagentes** del dashboard muestra los límites efectivos y permite editarlos. `GET /api/workflow-budget/settings` devuelve sus valores efectivos, predeterminados y rangos permitidos. Un `PUT` parcial actualiza los campos indicados y JSON `null` restablece los predeterminados. Los cambios del dashboard o la API se aplican a la siguiente solicitud sin reiniciar y nunca restablecen el consumo acumulado de una tarea; para perdonar ese consumo se mantiene `POST /api/workflow-budget/clear`. Un bloque mal formado en el archivo se ignora con una advertencia y conserva los límites integrados. Los cambios locales mediante `ocx config set/unset` requieren reiniciar el proxy. La ventana de 10 minutos, el espacio reservado para la conversación interactiva y el máximo de 512 tareas registradas no son configurables.

<a id="upstream-transport-recovery"></a>

## Recuperación de transporte ascendente

Mientras que el canónico ChatGPT upstream WebSocket espera el primer evento Responses después de enviar el marco de creación, observa la vitalidad en lugar de una fecha límite fija. Cuando el socket admite pings de protocolo, el proxy lo hace cada 15 segundos. Cualquier trama entrante (cuota, metadatos de respuesta o un pong) restablece un reloj de silencio de 90 segundos, por lo que un socket sin soporte de ping aún permanece activo en sus propias tramas, y solo 90 segundos sin nada en absoluto establece la solicitud como un HTTP 504 con un error `upstream_no_response`. Por lo tanto, un origen lento pero vivo espera la fecha límite del cliente o la `connectTimeoutMs` (200 s por defecto para destinos públicos, desactivado para locales salvo configuración explícita), lo que ocurra primero; un tiempo de espera de conexión que se dispara después de que se envió el marco de creación se establece como el mismo 504. Un zócalo que se cierra o comete errores antes del primer evento Responses se establece como un HTTP 502 con `upstream_closed_before_response`. El proxy no vuelve a intentar ninguno de los estados por sí mismo: la trama ya puede estar ejecutándose aguas arriba, por lo que el cliente aplica su propia política de reintento exactamente como lo haría cuando se conecta directamente al backend. La única excepción es que 502 en un proveedor que optó por `retryOnReset`, se describe a continuación. Una vez que la respuesta ha comenzado, una gota más tarde las superficies dentro de la corriente como antes. `stallTimeoutSec` no está relacionado con esta ventana.

Un envío ordinario HTTP tiene un tercer caso. Cuando la conexión muere antes de que llegue cualquier cabecera de respuesta, el proxy no puede decir si el modelo ya procesó la solicitud, por lo que se niega a enviarla de nuevo y responde HTTP 429 con `upstream_reset_replay_refused`. El estado es deliberado: un 5xx aquí es una instrucción para la mayoría de los clientes, incluido el Codex, para enviar todo el turno de nuevo, que es el duplicado que existe la negativa a evitar. No `Retry-After` se adjunta, y la respuesta lleva `x-should-retry: false`, que los oficiales OpenAI y Anthropic SDK leen antes de sus propias reglas de estado - sin él, esos clientes vuelven a intentar un 429 en su propio horario y vuelven a enviar el turno de todos modos. El mismo comportamiento de rechazo de reproducción se aplica en `/v1/responses` y `/v1/chat/completions`, ya sea que la solicitud se reenvíe de forma nativa o se traduzca. Las solicitudes `/v1/messages` enrutadas se traducen a través de Responses y proyectan el mismo estado, código y encabezados de reintento en una envolvente de error en forma de Anthropic. El proxy no realiza rotación de claves, conmutación por error de cuenta o repetición del mismo objetivo en él, ni registra el rechazo como evidencia de límite de tasa o cuota contra la credencial que tenía. Las solicitudes del lado de la herramienta de llamada, como la visión y la búsqueda web, se reproducen normalmente, porque repetirlas no puede duplicar un turno.

Las solicitudes nativas ChatGPT Responses y compactas HTTP cuyas cadenas serializadas JSON son de al menos 1 MiB en UTF-8 usan cargas de byte-búfer para evitar que Bun restablezca una carga de cadena grande antes de que lleguen los encabezados de respuesta. Esto conserva el contenido de la solicitud y no permite reintentos automáticos. Un restablecimiento de conexión genuino sigue la política de rechazo de reproducción anterior.

Un proveedor nativo Responses puede optar por reemplazar ese envío con [`retryOnReset`](/es/reference/configuration/providers/#provider-entries-ocxproviderconfig). La misma concesión cubre el caso en el que la conexión sobrevive a la cabecera y el cuerpo SSE muere entonces llevando solo eventos de control, porque el llamante no ha observado nada en ninguno de los dos. También cubre el canónico ChatGPT WebSocket anterior: un socket que se cierra o errores antes del primer evento Responses se sustituye por un HTTP enviar, nunca por un segundo socket. Un enchufe silencioso mantiene su 504, y nunca se reemplaza un giro de dirección o inyección nativo. Un reemplazo ocurre solo cuando la solicitud es autónoma (`store: false`, entrada completa, herramientas ejecutadas por el cliente solamente, sin estado de continuación del lado del servidor), y una solicitud lógica obtiene el número configurado de reemplazos en total, en cada tramo de recuperación y cada hijo combinado, no uno cada uno. La denegación regresa tan pronto como se gaste esa subvención, la pierna no se envíe o un reemplazo falla por cualquier otra razón. Una solicitud que ya ha emitido una salida o una llamada de herramienta mantiene el rechazo independientemente. Una persona que llama y cancela a mitad del reemplazo obtiene la cancelación, no el rechazo.

Para la recuperación de WebSocket, "antes del primer evento Responses" es más estricto que "antes del primer texto": incluso `response.created`, un evento de herramienta o una respuesta de soporte de uso cierra la ventana de reemplazo. Los metadatos de ping/pong y cuotas por sí solos no lo hacen. Un cierre posterior del zócalo no puede convertir una cancelación ya establecida o un tiempo de espera de conexión/silencio en un reintento de HTTP.

`noProxy` acepta una cadena separada por comas o una matriz. Ambos formularios agregan entradas sin reemplazar un `NO_PROXY` heredado:

```jsonc
{ "proxy": "http://proxy.corp:8080", "noProxy": "internal.example,10.0.0.0/8" }
```

```jsonc
{ "proxy": "http://proxy.corp:8080", "noProxy": ["internal.example", "10.0.0.0/8"] }
```

SOCKS5 (escuchadores de puertos mixtos incluidos) pertenece al `ALL_PROXY`, no al `HTTP_PROXY`:

```jsonc
{ "proxy": "socks5://127.0.0.1:10808" }
```

`ocx start --socks5` escribe ese valor; `ocx start --socks5-off` lo aclara.

HTTPS solicitudes a través de SOCKS5 tienen una fecha límite separada de 30 segundos TLS apretón de manos. Un apretón de manos detenido falla sin deshabilitar la verificación del certificado; la cancelación de la llamada puede detenerlo antes.

Si una compilación de desarrollo anterior cambió los metadatos del historial de reanudación antes de que existiera el soporte de copia de seguridad, ejecute `ocx recover-history --legacy-openai --yes` para forzar la recuperación del proveedor nativo. Forzar-reetiqueta cada fila de mensajes de usuario `opencodex`, incluido el historial legítimo de proveedores dedicados; revise la advertencia de alcance completo en la referencia del ciclo de vida antes de ejecutarla.

<a id="native-chat-timeouts-and-completion"></a>

### Tiempos de espera y finalización del chat nativo

Native Chat también utiliza `stallTimeoutSec` mientras espera la salida de flujo ascendente, con el mismo valor predeterminado local vs público: un presupuesto no establecido está deshabilitado para un flujo ascendente local y 300 s para uno público, y `0` lo deshabilita en todas partes. El texto no vacío, el razonamiento, el rechazo, las actualizaciones de herramientas y los marcos de finalización renuevan la asignación; los comentarios de mantenimiento, los marcos de solo rol y el uso por sí solos no lo hacen. Esperar a que un cliente lento lea pausa la asignación. Una pérdida produce `upstream_stall_timeout`: una trama de error para clientes de transmisión en tiempo real, o HTTP 502 para clientes que no son de transmisión en tiempo real. La cancelación antes de un resultado de terminal devuelve un error de cancelación en lugar de una respuesta parcial exitosa. Los resultados de los búferes aceptan tanto el encuadre LF como CRLF SSE, incluidos los datos multilínea.

<a id="codex-quota-network-diagnostics"></a>

## Diagnósticos de red de cuota Codex

La fila principal de la cuenta Codex puede incluir `quotaRefresh` cuando se intentó una búsqueda de cuota. Esto describe que fetch, no cuota restante, modelo de acceso o permiso para reintentar. Las lecturas en caché y las filas sin un fetch pueden omitirlo; la ausencia no significa éxito. Un valor de cuota de `null` significa no disponible, no cuota cero.

Para solicitar datos nuevos y mostrar solo el diagnóstico en PowerShell:

```powershell
$quotaReport = ocx account list openai --quota --refresh --json | ConvertFrom-Json
$quotaReport.accounts |
    ForEach-Object { if ($_.quotaRefresh) { $_.quotaRefresh } } |
    ConvertTo-Json -Depth 3
```

Si no hay diagnóstico presente, esta proyección no produce ningún objeto de diagnóstico. Comparta solo estos campos al comparar los modos de red, en lugar de la lista completa de cuentas.

| `quotaRefresh.status` | Descripción |
| --- | --- |
| `ok` | Se completó la extracción y se analizó un objeto de cuota. |
| `not_reported` | La respuesta no contenía ningún objeto de cuota utilizable. |
| `http_error` | El flujo ascendente devolvió un fallo de HTTP; `httpStatus` contiene su código de estado. |
| `timeout` | Se agotó el tiempo de espera de la cuota. |
| `network_error` | La solicitud falló antes de una respuesta clasificada HTTP. |
| `invalid_response` | La respuesta no fue un documento de cuota utilizable. |
| `internal_error` | Un paso de actualización interno falló. |

Sólo `http_error` incluye `httpStatus`. Otros estados no implican HTTP 0 o un problema de derecho de cuenta. Un `http_error` también puede incluir `code` cuando el proveedor nombra una razón por la que solo se corrige un nuevo inicio de sesión (`token_invalidated`, `invalid_refresh_token`, `invalid_workspace_selected`). Una respuesta `token_invalidated` indica una sesión revocada; la fila muestra `needsReauth: true` con el último plan conocido.

Si el endpoint de tokens rechaza la autorización principal de renovación almacenada, las solicitudes automáticas dejan de reintentar esa misma autorización aunque una actualización de uso tenga éxito. Inicia sesión de nuevo con `codex login` para sustituir la credencial. El proceso conserva hasta 64 registros de rechazo asociados al perfil y a la autorización; reiniciar el proxy o expulsar un registro antiguo permite una comprobación nueva. Los límites de solicitudes y los fallos del servidor siguen siendo reintentables y no retiran esa autorización. Las credenciales proporcionadas por el cliente siguen siendo de su propiedad.


<a id="which-proxy-path-is-used"></a>

### ¿Qué ruta proxy se utiliza?

El servicio proxy en ejecución obtiene la cuota. Utiliza su propio entorno, no el shell interactivo que más tarde se ejecuta `ocx account list`. Configure la configuración o el entorno proxy del servicio y, a continuación, reinicie el servicio; cambiar variables en otro terminal no actualiza un servicio que ya se esté ejecutando.

Un `proxy` no establecido deja variables proxy heredadas sin cambios. Una URL proxy explícita HTTP (S) llena `HTTP_PROXY` y `HTTPS_PROXY` solo donde no están establecidos. `"proxy": "auto"` lee la configuración Windows estática de WinINET o macOS estática HTTP / HTTPS una vez en el inicio. Las variables de entorno proxy existentes tienen prioridad; macOS descubrimiento también se salta heredado `ALL_PROXY` / `all_proxy`. Una excepción macOS `*.<domain>` se convierte en `.<domain>`: `foo.local` deriva para `*.local`, `xlocal` no, y el ápice desnudo `local` también deriva. Los CIDR locales de enlace exacto se eliminan con una advertencia, por lo que los literales de IP locales de enlace usan el proxy. Otras excepciones no representables rechazan el descubrimiento sin cambiar las variables proxy. La detección automática no resuelve los ajustes de PAC/WPAD, SOCKS-only o los cambios de proxy en vivo. Utilice una configuración de proxy HTTP estática compatible o una URL de proxy HTTP (S) explícita cuando sea necesario.

Compare el diagnóstico en la misma máquina y cuenta en los dos modos de red. Una prueba TUN exitosa por sí sola no identifica por qué falló la ruta proxy HTTP del servicio y no establece una corrección general.

<a id="connection-reuse-for-specific-upstream-hosts"></a>

## Reutilización de conexión para hosts de origen específicos

Algunos upstreams mantienen una conexión abierta después de haber dejado de servirla. La siguiente solicitud reutiliza ese socket agrupado y falla sin llegar al proveedor. `OCX_FRESH_CONNECTION_HOSTS` nombra a los hosts que nunca deben reutilizar una conexión agrupada, como una variable de entorno en lugar de un campo de configuración, por lo que se puede aplicar a una máquina sin editar la configuración compartida:

```bash
OCX_FRESH_CONNECTION_HOSTS="api.example.com, relay.example.net" ocx start
```

El valor es una lista separada por comas de nombres de host. El emparejamiento es insensible a las mayúsculas, cubre cada host nombrado y sus subdominios, e ignora los puntos principales, por lo que `.example.com` y `example.com` coinciden ambos con `api.example.com`. No incluya un esquema, puerto o ruta. Una variable vacía o sin establecer deja el comportamiento de conexión predeterminado sin cambios.

Un envío coincidente lleva `Connection: close` y se envía con keep-alive deshabilitado. La decisión se toma en contra de la dirección realmente utilizada en el cable, por lo que todavía se aplica cuando un proveedor de transporte reescribe el destino después de la selección de credenciales. La latencia por solicitud aumenta ligeramente para esos hosts, ya que cada solicitud paga un nuevo protocolo TCP y TLS; nombre solo los hosts que lo necesitan.

<a id="remote-access"></a>

## Acceso remoto

El enlace predeterminado `127.0.0.1` es solo loopback. Una dirección de no retorno de bucle tal como `0.0.0.0` o una IP de red Tailscale requiere autenticación de token tanto en `/api/*` como en el plano de datos.

Usted no tiene que producir ese token. `ocx service install` proporciona uno en un enlace no loopback, en este orden: `OPENCODEX_API_AUTH_TOKEN` desde el shell de instalación, luego un archivo existente de solo propietario `service-api-token`, luego 32 bytes aleatorios nuevos. El resultado se escribe `0600` y el envoltorio de lanzamiento (launchd plist, systemd unidad, Windows envoltorio) lee el archivo al inicio, por lo que el valor nunca entra en una definición de servicio o argv. Un primer plano `ocx start` aplica la misma precedencia - entorno, luego `OCX_API_TOKEN_FILE`, luego el `service-api-token` instalado - por lo que une un nombre de host non-loopback sin un token exportado también.

Un **token de administración de administración** es rechazado en cualquier lugar que pueda aparecer - la variable de entorno o un archivo reutilizado `service-api-token` - y el mensaje nombra el remedio para ese lugar: desconfigurar la variable, o eliminar el archivo y ejecutar `ocx service repair`. Ambas comprobaciones se ejecutan antes del cortocircuito de bucle de retorno, porque el envoltorio de lanzamiento lee el archivo en `OPENCODEX_API_AUTH_TOKEN` sea cual sea el nombre de host, por lo que un archivo de token de administrador cerca la administración API cerrada incluso en un enlace de bucle de retorno. `ocx status` informa que el estado como `admin-collision (file)` en un concentrador.

La configuración de la variable usted mismo todavía se admite para un operador que desee poseer el valor:

```bash
export OPENCODEX_API_AUTH_TOKEN="your-secret-token"
ocx start
```

Los clientes deben enviar:

```text
x-opencodex-api-key: your-secret-token
```

| Punto final | `Authorization: Bearer` | `x-opencodex-api-key` | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` | No aceptado | **requerido** | No aceptado |
| `/v1/chat/completions` | No aceptado | **requerido** | No aceptado |
| `/v1/messages` | aceptado | aceptado | aceptado |
| `/v1/messages/count_tokens` | aceptado | aceptado | aceptado |
| `/v1/models` | aceptado | aceptado | aceptado |

Responses y Chat Completions reservan `Authorization` para el posible paso Codex Direct, por lo que solo se acepta el encabezado de admisión dedicado allí. El `apiKeys` generado por el panel puede reemplazar el token de entorno después del inicio; los candidatos se comparan en tiempo constante.

Messages y `count_tokens` siguen aceptando los tres formularios de admisión para la compatibilidad con el cliente encaminado. El passthrough nativo Anthropic es más estricto en un enlace no loopback: la admisión proxy debe usar `x-opencodex-api-key`, mientras que `Authorization` y `x-api-key` están reservados para las credenciales Anthropic. Cualquier secreto de admisión proxy colocado en esos encabezados de proveedor se elimina antes del reenvío.

:::caution[Exposición a la LAN]
A `0.0.0.0` bind expone el proxy y el acceso del proveedor configurado a la LAN. Utilícelo solo en el confiable redes con un fuerte token.
:::

<a id="local-clients-that-cannot-receive-the-token"></a>

### Clientes locales que no pueden recibir el token

Un enlace remoto requiere una credencial de cada persona que llama, incluidas las locales. Eso rompe un caso específico: un `codex app-server` lanzado por un proceso host que resuelve el punto de entrada Codex directamente (`require.resolve('@openai/codex/bin/codex.js')`) nunca pasa a través de la shim `codex` generada, por lo que nunca hereda `OPENCODEX_API_AUTH_TOKEN` y cada llamada de modelo falla con `401` antes de que se abra un flujo.

`unauthenticatedLoopbackListener` abre un segundo oyente vinculado a `127.0.0.1` que admite sin una credencial. El oyente principal no ha sido tocado - las personas que llaman a distancia todavía necesitan el token.

```json
{
  "hostname": "0.0.0.0",
  "port": 10100,
  "unauthenticatedLoopbackListener": { "enabled": true, "port": 10200 }
}
```

`ocx sync` luego escribe `base_url = "http://127.0.0.1:10200/v1"` en el bloque de proveedor Codex administrado y omite el encabezado de autenticación, por lo que un servidor de aplicaciones generado directamente funciona sin ninguna fontanería de credenciales.

Cuando establece `port`, debe diferir del puerto proxy. Nunca se asigna al sistema operativo: un puerto efímero cambiaría en los reinicios mientras que los servidores de aplicaciones que ya se ejecutan conservarían el anterior `base_url`.

Omitir `port` selecciona la forma **compañero** - el oyente enlaza el puerto proxy en `127.0.0.1`:

```json
{
  "hostname": "100.76.170.81",
  "port": 10100,
  "unauthenticatedLoopbackListener": { "enabled": true }
}
```

Los clientes remotos marcan `100.76.170.81:10100` con una credencial; los procesos locales marcan `127.0.0.1:10100` sin una. Esa es la dirección que toda integración local ya escribe, por lo que `ocx claude`, Claude Desktop, Cursor y la inyección system-env siguen trabajando en un host cuyo enlace público no pueden alcanzar. El formulario complementario se acepta solo cuando `hostname` es una dirección específica no loopback, no comodín: en `127.0.0.1`, `localhost` o `0.0.0.0` el oyente público ya tiene esa dirección loopback, por lo que OpenCodex rechaza el par en el momento de la escritura y en el inicio en lugar de fallar el segundo enlace. En esos enlaces no necesita al oyente en absoluto: un enlace de bucle de retorno ya admite llamadas locales.

Con un conjunto de `port`, las integraciones locales siguen al oyente: `ocx claude`, la inyección `system-env`, el perfil Claude Desktop, el valor de puerta de enlace Cursor y el asistente de visión enrutado todos escriben `http://127.0.0.1:<listener port>`, el mismo puerto `ocx sync` escribe en Codex. En la forma complementaria, esas mismas integraciones siguen escribiendo el puerto proxy, que es donde está el socket complementario.

**Reinicie el proxy después de cambiar este campo, en cualquier forma.** Los sockets se unen una vez en el inicio y los valores de cliente exportados se escriben desde el puerto resuelto, por lo que un proxy en ejecución mantiene su respuesta anterior, en un oyente portado que es la diferencia entre una solicitud servida y un `404` del oyente.

En un `runtimeRole: "hub"`, este campo también es la puerta de entrada para saber si el concentrador reescribe la configuración del cliente local **Su propio**. Con el oyente desactivado, `ocx sync`, `ocx ensure` y `ocx restore back` omiten las escrituras propias del concentrador Codex / Grok / Claude y lo dicen, nombrando `unauthenticatedLoopbackListener` en lugar del conmutador `clientIntegrations`.

El oyente sólo sirve `POST /v1/responses`, su actualización WebSocket, `POST /v1/responses/compact`,
`POST /v1/messages` (el cable Anthropic Claude Code y Claude Desktop hablar),
`POST /v1/chat/completions` (el cable de chat OpenAI Cursor y el asistente de visión hablan),
`POST /v1/alpha/search` (el relé de búsqueda web nativo Codex), `GET /v1/models`, y el tiempo real superficie de voz: las actualizaciones independientes WebSocket, creación de llamadas WebRTC (`POST /v1/live`,
`POST /v1/realtime/calls`), y la banda lateral con teclas se unen a las actualizaciones (`/v1/live/{callId}`,
`/v1/realtime/calls/{callId}`, `/v1/realtime?call_id=`) Todo lo demás, incluyendo `/api/*`,
`/healthz`, `/readyz` y el dashboard, vuelve `404` — gestión local lee como
`ocx claude`'s descubrimiento llamada ir a la superficie de gestión autenticada con una gestión Credencial, nunca aquí.

:::danger[Esta interfaz no requiere autenticación]
Cada proceso en la máquina puede usar este oyente. Gasta cuota de cuenta y proveedor pagado credenciales, y puede agotar la capacidad de giro compartida que dependen los clientes remotos autenticados encendido. No lo habilite en un host compartido o multi-tenant.

Vinculación a `127.0.0.1` significa que el kernel rechaza conexiones remotas, pero no detiene un navegador: una página que visita puede hacer que su navegador se conecte a `127.0.0.1`. Por lo tanto, el oyente misma `Host` y `Origin` como un enlace de bucle de retorno ordinario. Desactivado por defecto.
:::

<a id="ssh-port-forwarding"></a>

### Reenvío de puertos SSH

El uso remoto no requiere un enlace remoto. Mantén el loopback y reenvíalo:

```bash
ssh -L 20100:localhost:10100 you@remote
```

Cualquier puerto local funciona. Las solicitudes cuyo host se resuelve en `localhost`, `127.0.0.1` o `::1` permanecen en bucle, independientemente del puerto, por lo que `http://localhost:20100/v1` funciona. Establecer la URL base en el cliente; `ocx` escribe solo la dirección local predeterminada `127.0.0.1` en la configuración del cliente administrado.

Las devoluciones de llamada del proveedor OAuth escuchan en un puerto remoto fijo. Inicie sesión en la máquina remota o reenvíe ese puerto también:

```bash
ssh -L 20100:localhost:10100 -L 1455:localhost:1455 you@remote
```

Si un puerto de devolución de llamada registrado ya está en uso y la superficie de inicio de sesión ofrece entrada manual, OpenCodex mantiene el URI de redirección registrado y aún devuelve la URL de autorización del proveedor. Complete el inicio de sesión del proveedor, luego pegue la URL de redirección final desde la barra de direcciones del navegador o el código de autorización en OpenCodex. El flujo pendiente conserva el estado y la validación PKCE. Las llamadas sin entrada manual aún fallan.

:::caution[El bucle local reenviado no requiere autenticación]
Llanura `ssh -L` escucha en su bucle local y es seguro para el enlace no autenticado predeterminado. No lo hagas uso `ssh -g -L`, amplia publicación de contenedores o modos de reenvío que exponen el lado del cliente en
`0.0.0.0`. Vinculación explícita con `ssh -L 127.0.0.1:20100:localhost:10100` cuando no están seguros.
:::

<a id="account-email-masking-privacy"></a>

## Enmascaramiento de correo electrónico de la cuenta (`privacy`)

Los correos electrónicos de la cuenta almacenados están enmascarados en todas partes que dejan el proxy: las listas de cuentas del panel de control, `GET /api/codex-auth/accounts`, `GET /api/oauth/status` y la sección de inicios de sesión `ocx status` muestran `p***n@example.com` en lugar de la dirección registrada.

| Campo | Tipo | Predeterminado | Descripción |
| --- | --- | --- | --- |
| `privacy.maskEmails?` | `boolean` | `true` | Configurar a `false` para mostrar los correos electrónicos de la cuenta almacenados en su totalidad. Ausente, `true`, y cualquier valor mal formado siguen enmascarando, por lo que sólo un `false` deliberada revela una dirección. |

Apáguelo cuando ejecute muchas cuentas en una máquina que controle y no pueda distinguirlas de los formularios enmascarados. Lea el indicador como una decisión de divulgación en lugar de una preferencia de visualización: la administración no siempre es loopback, por lo que en un concentrador configurado con `remoteGui`, una dirección desenmascarada llega a todos los principales de administración que pueden llegar al concentrador, no solo a alguien sentado en la máquina. La bandera mueve solo el campo de correo electrónico: los tokens, los tokens de actualización y los identificadores de cuenta permanecen redactados de cualquier manera.

```json
{ "privacy": { "maskEmails": false } }
```

`ocx config set privacy.maskEmails false` falla con `config parent path not found` hasta que el bloque existe, porque `config set` entra en los objetos existentes y nunca los crea. Escribe todo el objeto en su lugar - `ocx config set privacy '{"maskEmails":false}'` - o añadir el bloque a `config.json` a mano.

<a id="storage-cleanup"></a>

## Limpieza de almacenamiento

`storageCleanupPolicy` está deshabilitado por defecto. Cuando está habilitado, se ejecuta en `startup`, `daily`, `weekly` o `manual` después de que los bytes archivados superan `trigger.archivedBytesOver`. Selecciona los archivos más antiguos hacia `target.reduceToBytes` o `target.removeOldestPercent`. `mode` por defecto es `quarantine`; use `permanent` solo como una opción destructiva explícita. La política persiste `lastRun` y `nextRun`. Configurelo en la página de almacenamiento o con `GET` / `PUT /api/storage/cleanup-policy`; inicie una ejecución manual con `POST /api/storage/cleanup-policy/run`.

<a id="usage-history-size"></a>

## Tamaño del historial de uso

`usageLedgerMaxBytes` no se establece por defecto, y unset significa que el historial de solicitudes en `usage.jsonl` crece sin límite. Nada borra el historial que no pediste haber borrado.

Configurar a un techo de bytes y el proxy recorta el archivo después de un apéndice cruza, manteniendo las filas enteras más nuevas y dejando caer la más antigua. Se recorta un poco por debajo del techo en lugar de exactamente a él, por lo que el siguiente apéndice no vuelve a cruzar inmediatamente la línea. El valor mínimo aceptado es 1 MiB; un número menor, o uno que no es un número entero seguro, deja el límite fuera en lugar de fallar la configuración.

Las filas se copian byte por byte y nunca se reescriben, por lo que cada campo sobrevive a un ajuste, incluidos los campos de una compilación más reciente que escribió que uno más antiguo no entiende. El reemplazo se rechaza directamente si algo se agrega al libro mayor mientras se ejecuta, por lo que una solicitud registrada durante un ajuste nunca se pierde; el siguiente agregado se vuelve a intentar. Recortar también actualiza lo que muestra el panel de control, por lo que `/api/logs` deja de servir filas que el libro mayor ya no tiene.

No hay control de tablero para esto todavía; configúrelo en `config.json` o con `ocx config set usageLedgerMaxBytes <bytes>`.

<a id="catalog-auto-refresh-catalogautorefresh"></a>

## Auto-actualización de catálogo (`catalogAutoRefresh`)

Habilitado de forma predeterminada cuando OpenCodex administra su cliente local Codex: la sección o `enabled` pueden estar ausentes. El proxy actualiza su catálogo de modelos cada 60 minutos, con una actualización inicial unos tres minutos después del inicio. Cuando se desactiva la integración Codex, o la instancia se ejecuta como un concentrador o junto a otro proxy en vivo, la actualización de fondo se ejecuta solo con un `"enabled": true` explícito, y nunca lee Codex fuentes.

```json
{
  "catalogAutoRefresh": { "enabled": true, "intervalMinutes": 60 }
}
```

| Campo | Predeterminado | Descripción |
| --- | --- | --- |
| `enabled` | `true` | Ajuste a `false` para desactivar la actualización automática. |
| `intervalMinutes` | `60` | Actualizar la cadencia; los valores positivos por debajo de 15 se fijan a 15. `0` desactiva la actualización. |

Cada actualización observa el catálogo incluido del entorno de ejecución Codex seleccionado, luego calienta las listas de modelos Codex autenticadas antes de converger en la lista servida. Las fallas de origen utilizan la evidencia existente y vuelven a intentarlo en una marca posterior. Las ediciones de cadencia y habilitación tienen efecto en una marca posterior.

Un modelo nativo de OpenAI que la lista de Codex de su cuenta ChatGPT enumera, pero que esta versión OpenCodex aún no conoce, se agrega con los metadatos que se publican para ella (nombre, niveles de razonamiento, ventana de contexto). OpenCodex recuerda tales modelos en `discovered-native-models.json` en su directorio de inicio y olvida uno que no se ha visto durante 14 días. Un lanzamiento posterior que envía el modelo se hace cargo de su fila.

La ejecución de Codex sesiones conserva una lista de modelos en memoria. Cuando el conjunto servido cambia mientras se están ejecutando Codex servidores de aplicaciones, el proxy registra una sugerencia de reinicio y registra `reloadRequired` en su estado de actualización automática. Ejecute `ocx sync --restart-codex` cuando esté listo para reiniciar esas sesiones. La actualización automática nunca los reinicia.

Cuando una actualización en segundo plano cambia el conjunto servido, OpenCodex también actualiza las integraciones de clientes que ya ha escrito: un bloque Grok Build existente, el perfil de puerta de enlace Claude Desktop que aplicó (solo mientras ese perfil aún está seleccionado y sin editar, manteniendo su modo estático, híbrido o de descubrimiento), y los bloques propios de integraciones de archivos como OpenCode, Kilo, Pi, omo y Aside. Nunca se conecta a un cliente por primera vez, nunca actualiza Cline (detenga Cline y ejecute `ocx sync` en su lugar) y se salta clientes locales en un concentrador sin el oyente de bucle invertido. Un cliente que no pudo actualizar se cuenta en el registro proxy; `ocx sync` lo vuelve a intentar.

<a id="quota-reset-notifications-quotaresetnotify"></a>

## Notificaciones de restablecimiento de cuotas (`quotaResetNotify`)

Desactivado por defecto. Cuando la sección está ausente, no se ejecuta ninguna detección, no se inicia ningún temporizador y no se escribe ningún archivo de estado.

Habilite que se le diga cuando se restablece una ventana de uso, tanto el rollover programado que puede predecir como un restablecimiento fuera de banda que no puede:

```json
{
  "quotaResetNotify": {
    "enabled": true,
    "webhookUrl": "https://hooks.slack.com/services/...",
    "kinds": ["scheduled", "surprise"],
    "pollSeconds": 900
  }
}
```

| Campo | Predeterminado | Descripción |
| --- | --- | --- |
| `enabled` | `false` | Interruptor maestro. También requiere al menos un fregadero, abajo. |
| `kinds` | ambos | `scheduled` (la fecha límite pasó) o `surprise` (cuota devuelta antes). |
| `pollSeconds` | `900` | Intervalo de sondeo inactivo; piso 600. `0` solo observa tráfico en vivo. |
| `webhookUrl` | — | `https` Objetivo POST para el evento JSON. tratado como un secreto. |
| `allowPrivateNetwork` | `false` | Permitir un destino de bucle invertido o de red privada. |
| `timeoutMs` | `5000` | Tiempo de espera de Webhook. |
| `command` | — | Array Argv se ejecuta con el evento JSON en stdin. |

`enabled: true` sin que `webhookUrl` ni `command` se resuelvan: un subsistema habilitado sin ningún lugar para entregar es una configuración incorrecta, no un estado medio encendido.

El piso es de 600 segundos porque una encuesta más rápida no puede ver nada nuevo: la observación está limitada por la caché de 10 minutos por cuenta, por lo que un intervalo más corto solo agrega carga a un punto final de cuota que limita la tasa. Se adopta un valor configurado en la siguiente marca sin reiniciar.

Establezca `pollSeconds` a `0` solo si acepta que se note un restablecimiento mientras el proxy está inactivo en la próxima solicitud en lugar de cuando suceda. La encuesta existe porque el caso de la noche a la mañana es el que vale la pena conocer.

<a id="the-delivered-event"></a>

### El evento entregado

```json
{
  "type": "quota_reset",
  "kind": "surprise",
  "scope": "codex",
  "accountTag": "k3f9x2ab",
  "window": "weekly",
  "percentBefore": 96,
  "percentAfter": 4,
  "previousResetAt": 1772000000000,
  "resetAt": 1772400000000,
  "detectedAt": 1771900000000
}
```

`accountTag` es un hash salado por instalación, no un identificador de cuenta: distingue sus cuentas entre sí sin decirle al receptor quiénes son. No se incluye ningún correo electrónico, token, ruta o URL.

`detectedAt` es cuando el proxy AVISO, no cuando el restablecimiento ocurrió. La observación está limitada por la caché del proveedor de 5 minutos y la caché de 10 minutos por cuenta, por lo que el instante de reinicio solo se puede entre corchetes entre dos observaciones.

<a id="security-notes"></a>

### Notas de seguridad

`webhookUrl` es una credencial - para Slack y Discord, mantener la URL es suficiente para publicar - por lo que se redacta por `ocx config show` y se excluye de `ocx config export`.

Un destino webhook que se resuelve a una dirección privada o loopback es rechazado a menos que establezca `allowPrivateNetwork: true`. El proxy puede llegar a los hosts que su navegador no puede, incluidos los puntos finales de metadatos en la nube, por lo que el valor predeterminado asume un receptor externo.

`webhookUrl` debe utilizar `https`. La carga útil y la URL en sí son sensibles, y un objetivo `http` los pondría en texto claro; un valor `http` se rechaza cuando la configuración se escribe en lugar de degradarse en silencio.

Se rechaza una redirección en lugar de seguirla. La verificación de destino anterior valida la URL que configuró, por lo que después de un `3xx` entregaría la carga útil en algún lugar no validado: un punto final público podría rebotar el POST en loopback o una dirección de metadatos. Configure directamente la URL final; un informe de entrega redirigido `blocked-destination`.

`command` es una matriz argv y nunca se pasa a través de una carcasa, por lo que sus valores no pueden convertirse en una superficie de inyección de carcasa. La entrega se intenta una vez; no hay reintento.

Lea las detecciones recientes con `ocx provider resets` o `GET /api/quota-resets`.

<a id="api-surfaces-apisurfaces"></a>

## API superficies (`apiSurfaces`)

Responses (`/v1/responses`) y Chat Completions (`/v1/chat/completions`) siempre se sirven. El Messages API (`/v1/messages` y `/v1/messages/count_tokens`) se puede cerrar por sí solo.

| Clave | Tipo | Predeterminado | Descripción |
| --- | --- | --- | --- |
| `apiSurfaces.messages.enabled?` | `boolean` | herede | `true` sirve el Messages API, `false` rechaza ambas rutas con 403. Unset hereda `claudeCode.enabled`, por lo que una integración Claude que está desactivada también cierra Messages. |

Un valor presente pero mal formado (un no objeto `apiSurfaces` o `messages`, o un no booleano `enabled`) cierra el Messages API en lugar de volver al valor heredado. Ambas rutas siempre están de acuerdo.

La página API del panel de control muestra una tarjeta por cada API con la fuente de la configuración (explícita, heredada de la configuración Claude o no válida) y una palanca para Messages. Desactivar Messages allí escribe `apiSurfaces.messages.enabled: false` **y** `claudeCode.enabled: false` en el mismo guardar, por lo que una versión proxy más antigua que este ajuste, que solo lee `claudeCode.enabled`, mantiene el punto final cerrado después de una degradación. Encenderlo escribe solo `apiSurfaces.messages.enabled: true`; una versión anterior sigue `claudeCode.enabled` y puede mantener Messages cerrado, que es la dirección segura.

<a id="protocol-paths-protocols"></a>

## Vías de protocolo (`protocols`)

Cómo una solicitud Chat Completions o Messages puede comunicarse con un proveedor. Todos los valores predeterminados para el comportamiento antes de que existieran estas claves; consulte [Rutas de protocolo](/es/guides/protocol-paths/) para los modos de entrega, la vista previa y el seguimiento por solicitud.

| Clave | Tipo | Predeterminado | Descripción |
| --- | --- | --- | --- |
| `protocols.unrepresentable?` | `"legacy" \| "reject"` | `"legacy"` | `legacy` envía una solicitud cuya ruta deja caer una característica y registra la pérdida en la traza. `reject` lo rechaza con HTTP 400 antes de cualquier envío, nombrando solo las claves de función. |
| `protocols.rollout.nativeChatCombos?` | `boolean` | `false` | Enviar un candidato de chat elegible dentro de un combo de forma nativa desde su propia copia del cuerpo del cliente. |
| `protocols.rollout.managedMessagesNative?` | `boolean` | `false` | Envíe el Messages de forma nativa a un proveedor Anthropic directo y autenticado por clave en lugar de a través del puente interno Responses. |
| `protocols.rollout.managedMessagesNativeOAuth?` | `boolean` | `false` | Nativo Messages para el proveedor `anthropic` OAuth en `api.anthropic.com`, incluyendo grupos de cuentas almacenadas. Requiere `managedMessagesNative`. Para el proveedor `anthropic` establecido, un grupo habilitado proporciona verdadero para banderas nativas ausentes cuando `anthropicAccountPool.nativeMessages` está ausente o verdadero. Los indicadores explícitos falsos/malformados y una preferencia de grupo falso/malformado permanecen desactivados. Otros proveedores y pool-off mantienen el comportamiento de despliegue explícito. Las solicitudes agrupadas elegibles retienen la selección compartida, la afinidad y la recuperación previa de salida limitada. Los UUID de cuenta JSON-string `metadata.user_id` reconocidos están alineados con la credencial OAuth de servicio; se conservan los campos de dispositivo y sesión. |
| `protocols.rollout.directEncoders?` | `boolean` | `false` | Codifique el chat y las respuestas Messages de un flujo ascendente no Responses directamente de los eventos del adaptador. |
| `protocols.rollout.antigravityDirect?` | `boolean` | `true` | Envíe una solicitud de chat o Messages a una sola ruta Google Antigravity sin el cuerpo interno Responses en cualquier dirección. La configuración de la solicitud aún pasa por las políticas habituales, y una solicitud que el carril no puede llevar usa el puente. Establecer `false` para apagarlo. |
| `protocols.rollout.shadowPlan?` | `boolean` | `false` | Compare cada ruta de Chat o solicitud Messages con el plan que predice una vista previa y marque un desacuerdo como `planMismatch` en su fila de registro. No envía nada extra. |

Los bloques de protocolo mal formados conservan una directiva nativa deshabilitada conservadora cuando se cargan desde el disco. Las banderas nativas ausentes válidas pueden heredar valores predeterminados de grupo Anthropic elegibles; las banderas falsas o malformadas explícitas permanecen desactivadas. Las escrituras validadas rechazan la entrada malformada.

```json
{
  "protocols": {
    "unrepresentable": "legacy",
    "rollout": { "shadowPlan": true }
  }
}
```

`ocx api policy` muestra los valores resueltos y los cambia a través del proxy de ejecución (`--unrepresentable <legacy|reject>`, `--rollout <switch>=<on|off>`, `--messages <on|off>` para [`apiSurfaces`](#api-surfaces-apisurfaces)). Escribe solo cuando se da una bandera de ajuste. Las páginas API y `PATCH /api/protocols/settings` del panel de control utilizan la misma validación.

## Claude Code (`claudeCode`)

Esta configuración rige `/v1/messages`, `/v1/messages/count_tokens`, el lanzador `ocx claude` y la página del panel de control Claude. Si el Messages API se sirve en absoluto se decide por [`apiSurfaces`](#api-surfaces-apisurfaces), que hereda `claudeCode.enabled` mientras que unset.

| Clave | Tipo | Predeterminado | Descripción |
| --- | --- | --- | --- |
| `claudeCode.bodyStallSec?` | `number` | `90` | El presupuesto de inactividad del cuerpo pasa a través de nativo en segundos mientras una lectura está pendiente, no la duración total. Mínimo 1; exactamente `0` desactiva. |
| `claudeCode.bodyMaxBytes?` | `number` | `67108864` | Tapa corporal de paso natural acumulativa para respuestas transmitidas y tamponadas. Exactamente `0` se deshabilita. |
| `claudeCode.compatibility?` | `"shadow" \| "enforce"` | Sin configurar | Admisión de compatibilidad opcional para solicitudes `/v1/messages` traducidas. `shadow` registra características no compatibles y continúa; `enforce` devuelve un 400 en forma de Anthropic antes de la inferencia. El paso a través de Native Anthropic permanece sin cambios. |
| `claudeCode.authMode?` | `"proxy" \| "subscription"` | Automático | Cómo maneja el lanzamiento el `ANTHROPIC_AUTH_TOKEN`. Detecta automáticamente cada lanzamiento; nunca se anula un valor explícito. |
| `claudeCode.authModeMigratedAt?` | `string` | Sin configurar | Marcador interno de actualización única. No lo configure manualmente. |
| `claudeCode.classifierModel?` | `string` | Sin configurar | Objetivo explícito para los giros del clasificador de modo automático Claude Code, como `provider/model` calificado (por ejemplo `RelayA/claude-opus-5`). El modo automático envía controles de seguridad desnudos como el `claude-opus-5` sin proveedor, por lo que sin esto caen a través del `defaultProvider`, que puede no hablar Anthropic en absoluto. No se infiere nada automáticamente: solo se utiliza un objetivo que usted declara aquí. |
| `claudeCode.classifierFallbacks?` | `string[]` | Sin configurar | Se utilizan los objetivos de clasificador ordenados cuando no se establece `classifierModel`. El mismo formulario clasificado `provider/model`; la primera entrada utilizable gana. Una entrada explícita `modelMap` para el modelo clasificador todavía supera a ambos. |
| `claudeCode.desktopModelVisibility?` | `{ mode: "include" \| "exclude"; routes: string[] }` | Sin configurar | Rutas `provider/model` que figuran en la lista de la pasarela de Claude Desktop. `include` muestra solo `routes` y mantiene ocultos los modelos nuevos; `exclude` muestra todas salvo `routes` y añade los nuevos. Sin configurar, muestra todos los modelos disponibles. Si la selección no deja ninguno disponible, el escritor recurre a todos, incluidas las rutas normalmente ocultas; ajusta la selección para limitarla de nuevo. Solo afecta a las listas estáticas e híbridas de Claude Desktop; se configura desde **Conectar → Claude Desktop**. |
| `claudeCode.subagentEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | herede | Esfuerzo escrito a `~/.claude/agents/ocx-*.md` generado; separado de Codex guía y tapas del proxy. Reiniciar a través de `ocx claude` para regenerar. |

La política de compatibilidad se aplica a Claude Code, Desktop y otros clientes que utilizan Messages traducido, incluidas `?beta=true` y solicitudes que no son de transmisión. Todos los objetivos traducidos utilizan la misma política conservadora, incluidos los adaptadores Anthropic y Responses nativos. Rechaza el contenido del documento, la repetición de pensamiento/reflexión, las herramientas de búsqueda y ejecución alojadas, las referencias de búsqueda de herramientas, la carga diferida activa, las herramientas estrictas, los modos de llamada no predeterminados, los formatos de salida estructurada, la intención explícita del nivel de servicio, las características del conector MCP, la gestión de contexto, los contenedores, la colocación de inferencias y los campos o bloques de protocolo no compatibles.

Unset conserva la traducción heredada. Las sugerencias de caché, los ejemplos de entrada de herramientas y la configuración de pensamiento/esfuerzo ordinario se admiten deliberadamente con una posible degradación: esta configuración no garantiza puntos de interrupción de caché o TTL, ejemplos retenidos, presupuestos de pensamiento exactos o traducción sin pérdidas. Los encabezados beta por sí solos no se validan para el soporte de características. La evidencia de sombra contiene solo códigos de protocolo fijos y razones derivadas, retenidos en los registros de solicitudes y `usage.jsonl` y restaurados al reiniciar. Un modo no válido no desactivado devuelve un error de configuración 503 fijo en la traducción Messages. Configure el valor en `config.json` y reinicie el proxy para cargarlo; no hay un setter de GUI dedicado. Los tokens de conteo y las APIs directas Responses /Chat están fuera de esta política; el conteo exitoso de tokens no implica la admisión Messages. Esta configuración no agrega un límite de autorización global.

Auto auth selecciona la suscripción cuando se encuentra la autenticación Claude almacenada, proxy cuando no se encuentra ninguna y suscripción con una advertencia cuando la detección no es concluyente. Véase [Claude Code modo auth](/es/guides/claude-code/#auth-mode).

<a id="retained-requests-after-compaction"></a>

## Solicitudes retenidas después de la compactación

Para los proveedores traducidos y las puertas de enlace Responses enrutadas, OpenCodex enmarca automáticamente las solicitudes de usuario de texto plano antes del último punto de control Codex legible como contexto histórico. Pide que no se repitan los informes de los puestos de control completados; el texto retenido sigue estando disponible para los trabajos pendientes dentro de su autorización vigente. La entrada posterior del usuario tiene prioridad, incluidas pausas, cancelaciones y cambios de alcance. Un punto de control no otorga ningún permiso nuevo.

Esto está habilitado de forma predeterminada y no necesita configuración. Se conservan el texto original de la solicitud y el historial canónico de hilos/reproducción. El paso nativo OpenAI Responses, los giros de resumen, los envoltorios de contexto, las imágenes/archivos y los elementos de asistente/herramienta no se modifican. El encuadre se aplica a los puntos de control de texto sin formato que comienzan con el prefijo de resumen de Codex; los puntos de control decodificados de OpenCodex conservan su guía de continuación existente. El sintetizador del lado del cliente gira usando el indicador de compactación estándar de Codex también evita el encuadre. El encuadre es una instrucción rápida, por lo que el comportamiento del modelo puede variar.

<a id="compaction-routing"></a>

## Enrutamiento de compactación

En **Tablero → Visión de conjunto → Enrutamiento de compactación**, elija un modelo, que activa que se aplica a, un esfuerzo de razonamiento opcional, y si la anulación cubre todos los modelos de origen o sólo fuentes seleccionadas. Para las fuentes seleccionadas, compruebe los modelos individuales o las entradas `provider/*` de todo el proveedor y, a continuación, haga clic en **Guardar**. Seleccione **Usar el modelo de conversación** y guarde para eliminar la anulación. Los cambios se aplican a la siguiente solicitud de compactación sin reiniciar el proxy.

Establecer `compactionRouting` en OpenCodex `config.json` para anular las solicitudes de compactación del modelo Codex. La configuración está desactivada cuando se omite.

```json
{
  "compactionRouting": {
    "model": "provider/model-id",
    "reasoningEffort": "low",
    "triggers": ["manual"]
  }
}
```

`model` acepta ID de modelo nativo, ID de modelo calificado por proveedor y combos configurados. La opción `sourceModels` limita la anulación a los ID de modelo entrantes exactos o a los patrones `provider/*`, por ejemplo, `["kimi/*", "google-antigravity/*"]`. El emparejamiento es sensible a las mayúsculas. Omítelo por el comportamiento existente de todo modelo; las listas vacías, duplicadas o mal formadas no son válidas. El selector de alcance de fuente del panel de control puede editar la lista de permisos y conserva los selectores guardados ausentes del catálogo actual. La lista de verificación del modelo muestra como máximo 300 entradas coincidentes; use su campo de búsqueda para estrechar catálogos grandes sin eliminar las selecciones guardadas. También puede editarlo a través de `config.json` o `PUT /api/settings`. Esto comprueba el modelo de compactación entrante, no un modelo de conversación inferido. Si Codex envía un modelo de compactación nativo desnudo para un hilo enrutado, no coincide con esos patrones de proveedor y mantiene su ruta existente. Este comportamiento conservador protege GPT, pero puede dejar algunas compactaciones automáticas en la ruta nativa. Los turnos ordinarios de no compactación nunca cambian.

`reasoningEffort` es opcional; omítelo para preservar el esfuerzo entrante. Las declaraciones admitidas son `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` y `ultra`. Las reglas de esfuerzo del proveedor existentes aún se aplican. El punto final nativo `/responses/compact` mantiene su comportamiento existente y no reenvía los ajustes de razonamiento.

`triggers` nombres cuya compactación solicita la anulación cubre, utilizando Codex 's propios `compaction.trigger` valores: `"manual"` para un `/compact` que escribió, `"auto"` para la compactación automática Codex se ejecuta cuando un hilo se acerca a su límite de contexto. Omit `triggers` y la anulación se aplica solo al manual `/compact`, dejando la compactación automática exactamente donde se dirige hoy. Utilice `["auto"]` o `["manual", "auto"]` para enrutar la compactación automática también.

La compactación automática de enrutamiento es lo que permite que un hilo largo en un proveedor enrutado siga adelante cuando se agota la cuota canónica OpenAI. Codex elige un modelo nativo desnudo para el giro de compactación, y OpenCodex reserva eso para un proveedor canónico habilitado `openai` siempre que exista, por lo que la compactación falla con un error de cuota antes de que comience el giro enrutado aunque el hilo en sí se ejecute en otro lugar. El nombre `"auto"` apunta aquí la compactación a un modelo calificado por el proveedor con sus propias credenciales y cuota solo cuando se omite `sourceModels` o coincide con el modelo entrante. Una lista que contiene solo `provider/*` entradas no cubre un modelo de compactación nativo desnudo.

OpenCodex solo cambia las solicitudes con metadatos explícitos de `request_kind: "compaction"` cuyo `compaction.trigger` es uno de los valores que enumeró, enviado a `/v1/responses/compact` o a `/v1/responses` con un elemento de entrada `compaction_trigger`. Más tarde, las conversaciones mantienen su enrutamiento y configuración originales. Los metadatos faltantes, mal formados o conflictivos no activan la anulación, incluso en clientes más antiguos sin metadatos de activación; cuando se suministran varias copias de los metadatos, deben nombrar el mismo activador. Las solicitudes WebSocket usan los metadatos de cada trama en lugar de los metadatos de enlace anteriores de la conexión.

El proveedor del modelo seleccionado recibe toda la conversación para resumirla, incluidas las conversaciones que normalmente se ejecutan en otro proveedor. Un combo selecciona un objetivo por su estrategia de enrutamiento y puede volver a intentar la misma conversación en otro objetivo después de un fallo reintentable, por lo que uno o más objetivos pueden recibirlo. El panel de control indica esto junto al selector de modelos y nombra al proveedor de destino, o a los proveedores de destino del combo, una vez que se elige un modelo. Cuando la anulación cubre la compactación automática, esa transferencia ocurre sin que usted la solicite, en cualquier punto que Codex decida compactar; el panel del tablero también lo dice. La anulación reutiliza los manejadores de compactación y los formatos de resumen existentes. Cuando el modelo seleccionado comparte el proveedor del modelo de conversación y la identidad de enrutamiento de cuenta (nombre del proveedor, modo de cuenta Codex y espacio de nombres de cuenta), la solicitud mantiene la credencial del llamante y puede usar el punto final compacto nativo de ese backend. De lo contrario, incluso cuando cualquiera de los lados es un combo o el modelo de conversación se recuerda como un objetivo combinado, OpenCodex ejecuta el sintetizador portátil en su lugar, por lo que el resumen permanece legible cuando la conversación se reanuda en su propio modelo, y la credencial de la persona que llama no se cruza con el otro proveedor. El modelo seleccionado debe admitir el tamaño de entrada y el contenido. Para los resúmenes portátiles Responses, los elementos de historial `web_search_call` alojados se etiquetan como notas de referencia del asistente, porque la solicitud de resumen no tiene herramientas. Estado conocido, consultas de búsqueda, URLs visitadas, patrones de búsqueda y metadatos de origen se conservan, con valores largos y listas cortadas y como máximo 64 KiB de notas por solicitud de resumen; se omiten el estado opaco y los campos desconocidos o mal formados. Estas notas describen las acciones de búsqueda anteriores, no el contenido de la página ni las nuevas instrucciones. El texto de la respuesta existente, las citas y los resultados de la herramienta ordinaria siguen estando disponibles. Las solicitudes Lite retienen `parallel_tool_calls=false`, que el flujo ascendente requiere incluso sin declaraciones de herramientas. Esto cambia solo la solicitud de resumen, no el historial almacenado o la compactación nativa; un resumen fallido no reemplaza el historial. Reinicie el proxy después de editar `config.json` a mano. Las reservas del panel de control se aplican de inmediato.

<a id="reasoning-retention-during-compaction"></a>

### Razonamiento de retención durante la compactación

La retención de razonamiento legible requiere activación explícita como opción avanzada y está **desactivada de forma predeterminada**. Solo `reasoningRetention.enabled: true` lo habilita; un bloque omitido, `enabled: false`, o límites heredados sin `enabled: true` dejan sin cambios el comportamiento de compactación ordinario. Cuando se habilita para las solicitudes v1 `POST /v1/responses/compact` y v2 `compaction_trigger` enrutadas, el razonamiento legible permanece local mientras que el modelo seleccionado resume otro contexto. Después de que un resumen legible tenga éxito, el texto retenido exacto regresa junto con él en mensajes de contexto histórico enmarcados, no como un nuevo razonamiento o instrucciones auxiliares. La compactación repetida retiene esos mensajes de nuevo. Los giros posteriores ordinarios los repiten como historia.

```json
{
  "reasoningRetention": {
    "enabled": true,
    "maxContextPercent": 20,
    "maxTokens": 100000
  }
}
```

Ambos límites son opcionales y, **cuando la retención está habilitada**, usan de forma predeterminada `20` por ciento y `100000` tokens estimados. Se aplica el menor entre el porcentaje de la ventana de contexto del modelo de compactación y el límite absoluto de tokens; si se desconoce esa ventana, solo se aplica el absoluto. La estimación incluye el marco de contexto histórico de cada mensaje retenido, no solo su razonamiento.

Si se supera el límite, el texto legible se guarda íntegramente en `reasoning-archive/`, dentro del directorio de OpenCodex resuelto (normalmente `~/.opencodex/reasoning-archive/`). El modelo que resume recibe una nota con la ruta en lugar del texto, y el resumen legible final identifica ese archivo. Los archivos nuevos son privados para el usuario en POSIX. Un archivo es provisional hasta que un historial de reemplazo correcto devuelve su ruta, en el resumen legible o en un aviso junto a un resultado nativo tras la conmutación de un Combo v1 enrutado. Los errores, cancelaciones y resúmenes inválidos eliminan el archivo del intento actual. Los reintentos internos lo reutilizan y se conservan los archivos anteriores que sí terminaron correctamente. Una compactación fallida no devuelve un historial de reemplazo.

Los límites de porcentaje y tokens acotan el razonamiento que vuelve al contexto, **no el almacenamiento acumulado de archivos**. Cada archivo contiene solo el razonamiento legible admitido en esa solicitud; su tamaño de entrada está limitado por `maxInboundBodyBytes` (256 MiB de forma predeterminada, configurable hasta 512 MiB), más pequeños separadores entre bloques.

El directorio de archivos tiene un límite independiente, fijado en el código, de **512 MiB y 256 archivos**. Incluye los archivos completos, los restos provisionales y los demás archivos regulares del directorio. Un recorrido acotado y en streaming se detiene cuando ya es seguro que debe rechazar la operación; las entradas que no sean archivos regulares o que no puedan inspeccionarse provocan un rechazo seguro. Una transacción SQLite en un archivo adyacente serializa el recorrido, la creación exclusiva, la escritura y el cierre entre los procesos que usan este mecanismo. La capacidad se comprueba **antes de escribir el contenido de un archivo nuevo**; adquirir el bloqueo y registrar la propiedad local todavía puede escribir archivos de bloqueo o metadatos. Este límite no garantiza que haya espacio físico libre ni controla las escrituras de versiones anteriores o herramientas externas. **No hay vencimiento automático ni limpieza de archivos en segundo plano**.

Si el almacenamiento está lleno, la compactación enrutada rechaza el contenido nuevo con HTTP 503 `reasoning_archive_quota_exceeded`: revisa y elimina manualmente los archivos antiguos antes de reintentar la misma solicitud. HTTP 503 `reasoning_archive_busy` indica que otro proceso mantiene el bloqueo; espera a que termine y reintenta. HTTP 503 `reasoning_archive_unavailable` requiere comprobar los permisos del directorio y el estado del almacenamiento. Estas respuestas no exponen rutas del sistema de archivos ni causas internas y no inventan un plazo Retry-After. Un archivo rechazado no trunca el razonamiento ni elimina archivos anteriores; una compactación fallida no devuelve un historial de reemplazo.

Los límites de porcentaje/token volvieron en contexto, **Almacenamiento de archivo no acumulativo**. Cada archivo contiene solo razonamiento legible admitido en esa solicitud; la admisión de la solicitud está limitada por `maxInboundBodyBytes` (256 MiB por defecto, configurable hasta 512 MiB), además de pequeños separadores de bloques. El directorio del archivo tiene un techo compilado separado en **512 MiB y 256 archivos**, contando archivos comprometidos, remanentes provisionales y otros archivos regulares en ese directorio. Una exploración de transmisión limitada se detiene una vez que el rechazo es seguro; las entradas no regulares o no inspectables se niegan a cerrarse. Una transacción hermana SQLite serializa el escaneo, la creación exclusiva, la escritura y el cierre entre los escritores que cooperan. La comprobación de capacidad se ejecuta **antes de que se escriba una nueva carga útil de archivo**; adquirir el bloqueo y grabar la propiedad local aún puede escribir archivos de bloqueo o metadatos. Este límite no es una garantía física de espacio libre y no impone escrituras por compilaciones antiguas o herramientas externas. Hay **sin caducidad automática o limpieza de archivo de fondo**.

El directorio de archivos tiene un límite independiente, fijado en el código, de **512 MiB y 256 archivos**. Incluye los archivos completos, los restos provisionales y los demás archivos regulares del directorio. Un recorrido acotado y en streaming se detiene cuando ya es seguro que debe rechazar la operación; las entradas que no sean archivos regulares o que no puedan inspeccionarse provocan un rechazo seguro.
Una transacción SQLite en un archivo adyacente serializa el recorrido, la creación exclusiva, la escritura y el cierre entre los procesos que usan este mecanismo. La capacidad se comprueba **antes de escribir el contenido de un archivo nuevo**; adquirir el bloqueo y registrar la propiedad local todavía puede escribir archivos de bloqueo o metadatos.
Este límite no garantiza que haya espacio físico libre ni controla las escrituras de versiones anteriores o herramientas externas. **No hay vencimiento automático ni limpieza de archivos en segundo plano**.

Si el almacenamiento está lleno, la compactación enrutada rechaza el contenido nuevo con HTTP 503 `reasoning_archive_quota_exceeded`: revisa y elimina manualmente los archivos antiguos antes de reintentar la misma solicitud. HTTP 503 `reasoning_archive_busy` indica que otro proceso mantiene el bloqueo; espera a que termine y reintenta. HTTP 503 `reasoning_archive_unavailable` requiere comprobar los permisos del directorio y el estado del almacenamiento. Estas respuestas no exponen rutas del sistema de archivos ni causas internas, y no inventan un plazo Retry-After. Un archivo rechazado no trunca el razonamiento ni elimina archivos anteriores; una compactación fallida no devuelve un historial de reemplazo.

Los archivos seleccionados permanecen hasta que elimine manualmente sus archivos, incluso después de deshabilitar la retención o restablecer la configuración. Son texto plano, contienen razonamientos de conversación potencialmente sensibles y comparten la casa OpenCodex resuelta de esa instancia proxy. Eliminar un archivo hace que cualquier notificación de ruta existente no pueda recuperar su contenido; guarde primero todo lo que necesite. Un bloqueo de proceso o una escritura / limpieza del sistema de archivos fallida también pueden dejar un archivo provisional que requiere limpieza manual.



**Dashboard → Overview → Configuración avanzada → Razonamiento retención** proporciona el interruptor explícito y ambos límites; **Reiniciar y apagar** elimina la anulación y desactiva la retención. GET/PUT `/api/settings` expone `reasoningRetention`: null borra el bloque, y la omisión lo conserva. `enabled` debe ser un booleano cuando esté presente. Los porcentajes deben ser mayores que 0 y como máximo 100; los límites de token deben ser enteros positivos y los campos desconocidos son rechazados. Las ediciones de mano no válidas deshabilitan solo este bloque con una advertencia, manteniendo la configuración y los proveedores no relacionados.

El texto cifrado y las firmas de proveedores privados no se descifran ni se copian en mensajes retenidos portátiles. Una respuesta de compactación opaca nativa aguas arriba conserva su elemento de salida y texto cifrado exactos. Si la conmutación por error combinada v1 enrutada alcanza un resultado nativo después de retener el razonamiento legible, el historial de reemplazo también incluye los mensajes históricos retenidos o un aviso que nombra su archivo. Los puntos finales nativos compactos mantienen su comportamiento existente.

La ruta v2 todavía devuelve exactamente un elemento de compactación. Su sobre propiedad de proxy `ocx2:` almacena el resumen y el razonamiento histórico retenido por separado como JSON / Base64; esto es codificación, no encriptación del proveedor. Las solicitudes posteriores restauran mensajes históricos separados, y la compactación repetida retiene el razonamiento nuevamente. Los viejos resúmenes `ocx1:` permanecen apoyados. La recuperación de compactación de emergencia opt-in también conserva esta separación para JSON y SSE. La recuperación explícita de la historia nativa también restaura mensajes de razonamiento histórico y resumen separados.

<a id="memory-routing"></a>

## Enrutamiento de memoria

En **Dashboard → Visión de conjunto → Enrutamiento de memoria**, elija un modelo y un esfuerzo de razonamiento opcional para cada una de las dos fases de memoria de Codex, luego haga clic en **Guardar**. Seleccione **Off** y guarde para eliminar la anulación. Los cambios se aplican a la siguiente solicitud de memoria sin reiniciar el proxy.

Establecer `memoryModels` en OpenCodex `config.json` para enrutar esas solicitudes. Con el bloque omitido, ambas fases mantienen su ruta existente. Las fases son independientes: configurar una deja a la otra sola.

```json
{
  "memoryModels": {
    "extract": { "model": "provider/model-id", "reasoningEffort": "low" },
    "consolidation": { "model": "provider/model-id", "reasoningEffort": "medium" }
  }
}
```

`extract` es el pase que resume una sesión terminada en una memoria en bruto; `consolidation` es la ejecución de un solo agente que fusiona esas memorias en bruto en los archivos bajo `$CODEX_HOME/memories`. `model` acepta identificadores de modelo nativos, identificadores de modelo calificados por el proveedor y combos configurados. `reasoningEffort` es opcional; omítelo para mantener el esfuerzo Codex solicitado. Las declaraciones admitidas son `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` y `ultra`. Codex códigos duros `low` para extracto y `medium` para consolidación, por lo que un esfuerzo configurado reemplaza ese valor.

OpenCodex reconoce estas solicitudes de metadatos de giro propio de Codex: `request_kind: "memory"` en el encabezado `x-codex-turn-metadata` marca un pase de extracto, y `thread_source:
"memory_consolidation"` marca el hilo de consolidación. En HTTP, una solicitud cuyos nombres de cabecera `x-openai-subagent` `memory_consolidation` cuenta como un pase de consolidación solo cuando los metadatos de turno están ausentes. Los metadatos explícitos no relacionados con la memoria ganan sobre esa reserva. El identificador del modelo no es deliberadamente una señal: el paso de extracción se ejecuta en el mismo modelo de ayudante Codex que se usa para los títulos y los mensajes de confirmación, por lo que una regla basada en el modelo también capturaría las llamadas de ayudante ordinarias. Los metadatos faltantes, mal formados o conflictivos no activan la anulación; cuando se suministran varias copias de los metadatos, deben nombrar la misma fase. WebSocket solicitudes utilizan metadatos de cada trama en lugar de metadatos de enlace anterior de la conexión - el puente vuelve a unir la cabecera `x-openai-subagent` del enlace a cada trama, de modo que la cabecera nombra la conexión, no el paso actual, y no es una señal websocket.

Una fase configurada gana cuando `shadowCallIntercept` coincide con la misma solicitud. Una fase omitida mantiene su enrutamiento actual, incluida cualquier regla de llamada a la sombra existente que coincida con su modelo. El proveedor del modelo seleccionado recibe el texto de sesión Codex que resume la memoria, incluidas las sesiones que normalmente se ejecutan en otro proveedor; el panel del panel lo indica junto a los selectores de modelos. Una fase cuyo objetivo dejó de resolverse (el proveedor está deshabilitado o eliminado, o su combo ya no existe) falla esa llamada de memoria con `409` y el código de error `memory_model_target_unavailable` en lugar de volver al proveedor predeterminado. El registro de solicitudes nombra la fase (`memory-extract` o `memory-consolidation`) como la razón de enrutamiento. Reinicie el proxy después de editar `config.json` a mano. Las reservas del panel de control se aplican de inmediato.

<a id="shadow-calls"></a>

## Llamadas de sombra

Codex utiliza modelos auxiliares pequeños para títulos y mensajes de commit. Activa `shadowCallIntercept` para redirigir prefijos reconocidos a otro modelo configurado, conservando el esfuerzo de razonamiento. El panel lista los orígenes admitidos y guarda un interruptor por origen mediante `PUT /api/shadow-call-settings`; `GET` devuelve `sourceModels` activos y el inventario `sourceModelOptions`. Un `sourceModels` no vacío reemplaza los prefijos predeterminados: incluye `gpt-6-luna` y, para clientes 0.145.0–0.153.x, `gpt-5.6-luna` si aún deben interceptarse. La API rechaza prefijos vacíos, duplicados, con espacios o calificados por proveedor; admite hasta 32 de 128 caracteres y rechaza un destino que se cruce con los orígenes seleccionados. Una lista rechazada devuelve `code: "shadow_call_source_invalid"` y un conflicto de destino `code: "shadow_call_target_invalid"`, para mostrar el mensaje adecuado en lugar de confundir cada `400` con un fallo de red. Debe quedar al menos un origen activo; el interruptor principal detiene todos.

La consolidación de memoria es independiente: Codex pide Terra y `memoryModels.consolidation` controla esa fase. Terra también es un modelo normal de primer plano y subagentes, por lo que sus interruptores están desactivados por defecto. Seleccionar la generación Terra activa solo redirige la consolidación al destino de sombra si no hay un modelo de consolidación configurado; una fase de Memory Routing configurada prevalece. El inventario conserva `gpt-6.1-terra` y `gpt-5.6-terra`, etiquetados como `Memory`.

Los ids de modelo sin proveedor que coincidan son elegibles para interceptación, pero los turnos explícitos de usuario conservan su modelo: `x-codex-turn-metadata` debe contener `request_kind: "turn"` y `thread_source: "user"`. Los hijos generados también conservan el modelo cuando los identifica `x-openai-subagent: collab_spawn` en la conexión HTTP o WebSocket, o `subagent_kind: "thread_spawn"` en los metadatos. En WebSocket solo se usan los metadatos de cada trama `client_metadata["x-codex-turn-metadata"]`; los del upgrade no clasifican tramas posteriores. Los metadatos ausentes o inválidos conservan el comportamiento de interceptación. Los auxiliares también pueden llevar `request_kind: "turn"`, por lo que ese campo solo no los exime. La procedencia de mantenimiento, como `x-openai-subagent: compact` / `review` o `thread_source: "memory_consolidation"`, sigue siendo elegible, sujeta al enrutamiento de memoria configurado. Estas reglas se aplican a destinos concretos y combos.

```json
{
  "shadowCallIntercept": {
    "enabled": true,
    "model": "gpt-5.5",
    "sourceModels": ["gpt-6-luna", "gpt-5.6-luna"]
  }
}
```

<a id="when-the-target-is-unavailable"></a>

### Cuando el objetivo no está disponible

El reemplazo es el único destino que eligió el operador, por lo que un objetivo que deja de resolver falla la llamada de ayuda en lugar de enviarla a otro lugar. Cuando el proveedor del objetivo está desactivado o eliminado, o su combo ya no existe, una solicitud interceptada devuelve `409` con el código de error `intercept_target_unavailable` antes de que algo se envíe aguas arriba. El registro de solicitudes registra el mismo código. La solicitud no se pasa al modelo de ayudante nativo y no vuelve al proveedor predeterminado, porque cualquiera de los dos cambiaría el destino, las credenciales y el costo sin su elección. Un objetivo combinado o de perfil de enrutamiento aún falla entre sus propios miembros. Un objetivo calificado como `provider/model` cuyo segmento de proveedor no designa nada configurado se trata de la misma manera, y la configuración API se niega a guardar uno. Un ID de modelo desnudo que se resuelve a través del proveedor predeterminado sigue siendo válido.

Deshabilitar (`PATCH /api/providers?name=<provider>` con `disabled: true`) o eliminar un proveedor que el objetivo resuelve que aún tiene éxito; la respuesta agrega `dependentShadowIntercept: { model, enabled }` y el panel de control muestra una advertencia. Volver a habilitar al proveedor, o elegir otro objetivo, restaura la intercepción.

<a id="sidecars"></a>

## Sidecares

### `images` (`OcxImagesConfig`)

| Campo | Tipo | Predeterminado | Descripción |
| --- | --- | --- | --- |
| `provider?` | `string` | selección automática OpenAI | Explícito personalizado API -clave `openai-responses` proveedor para `/v1/images/generations` y `/v1/images/edits`. Los ID gestionados por el registro son rechazados. |
| `timeoutMs?` | `number` | `300000` | Tiempo de espera de solicitud completa para una solicitud de imágenes independiente. |

La selección explícita falla cuando el proveedor falta, está inhabilitado, es incompatible o carece de una clave utilizable; nunca vuelve a caer en otra cadena de pago. El punto final debe implementar las OpenAI Imágenes API trayectorias y la forma de respuesta esperada por Codex.

Ambos bucles de búsqueda mantienen `web_search` declarado después de que se agote el presupuesto de búsqueda. Las llamadas adicionales reciben un resultado emparejado de límite alcanzado sin otra búsqueda física; como máximo, las iteraciones del modelo `maxSearchesPerTurn + 3` se ejecutan antes de un error de terminal. Las herramientas ordinarias de llamadas y la cancelación aún terminan el ciclo. La recuperación de respuesta vacía elimina todas las herramientas.

### `webSearchSidecar` (`OcxWebSearchSidecarConfig`)

Los adaptadores RunTurn también utilizan el sidecar de búsqueda configurado. Los giros de búsqueda preservan los latidos del corazón de progreso. Un primer evento OAuth 429 rota la cuenta en la solicitud inicial y en cada solicitud de respuesta posterior a la búsqueda. La repetición mantiene la herramienta de búsqueda y los resultados recopilados. Con `emptyCompletionRetry: true`, una respuesta vacía antes del límite de búsqueda recibe un reintento usando la conversación actual y los resultados recopilados. La recuperación sin herramientas existente después del límite de búsqueda sigue estando disponible independientemente de esa configuración. Las fallas aguas arriba detienen el turno en lugar de desencadenar otra búsqueda.

| Campo | Tipo | Predeterminado | Descripción |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | encendido cuando usable | Interruptor maestro. Cuando false, OpenCodex deja de interceptar `web_search` Y la integración Codex escribe `web_search = "disabled"` en `~/.codex/config.toml`. |
| `backend?` | `"openai" \| "anthropic" \| "xai" \| "gemini" \| "exa"` | `openai` | La selección explícita tiene prioridad; si se omite, se usa `openai`. `anthropic` y `xai` se ejecutan solo cuando están configurados explícitamente; `gemini` y `exa` permanecen reservados hasta que sus ejecutores naveguen. |
| `model?` | `string` | backend-dependiente | `gpt-5.6-luna` para OpenAI, `claude-sonnet-5` para Anthropic o `grok-4.6` para xAI. `gpt-5.4-mini` explícito heredado migra al inicio. |
| `exaApiKey?` | `string` | Ninguno | Clave de operador para el backend `exa`. Solo escritura: las lecturas de administración nunca devuelven el valor almacenado. |
| `xSearch?` | `object` | omitido | xAI -sólo opt-in para alojado `x_search`: `enabled`, mutuamente exclusivos `allowedXHandles` / `excludedXHandles` matrices (máximo 20), e ISO `fromDate` / `toDate` (`YYYY-MM-DD`). |
| `reasoning?` | `string` | `low` | Esfuerzo de sidecar. `minimal` es rechazado con búsqueda web. |
| `maxSearchesPerTurn?` | `number` | `3` | Búsquedas reales permitidas por turno de modelo principal. |
| `routedModelStallTimeoutMs?` | `number` | `200000` | Fecha límite de inactividad del modelo raw-body. Entero 1-2147483647; cada fragmento no vacío lo restablece. |
| `timeoutMs?` | `number` | `60000` | Fecha límite para una búsqueda alojada. |

El backend OpenAI requiere un inicio de sesión ChatGPT y un proveedor habilitado ChatGPT `forward`. Claude -las repeticiones enrutadas entrantes inyectan la autenticación principal ChatGPT en la solicitud interna. El backend Anthropic usa la credencial almacenada activa de un proveedor habilitado Anthropic OAuth. Un backend Anthropic explícitamente seleccionado sin cuenta utilizable falla cerrado en lugar de retroceder. El ejecutor Anthropic utiliza su herramienta nativa `web_search_20250305`. El backend xAI requiere una cuenta Grok OAuth almacenada utilizable, utiliza `web_search` alojado y agrega `x_search` alojado cuando `xSearch.enabled` es verdadero. La entrada de gestión `xSearch` mal formada devuelve `400`; un bloque persistente mal formado falla cerrado durante la planificación. Los carriles `gemini` y `exa` nunca se activan a partir del descubrimiento de credenciales o reserva; el operador debe seleccionarlos explícitamente. `exaApiKey` se acepta en escrituras pero se omite de las respuestas de administración.

Cuatro relojes rigen la búsqueda: base `stallTimeoutSec`, `connectTimeoutMs`, inactividad del modelo enrutado y tiempo de espera de búsqueda alojada. El supervisor del puente efectivo es el máximo más 30 segundos. El puesto en ruta es un guardia de inactividad, no un plazo de generación total.

### `visionSidecar` (`OcxVisionSidecarConfig`)

| Campo | Tipo | Predeterminado | Descripción |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | encendido cuando usable | Interruptor maestro de descripción de imágenes. |
| `backend?` | `"openai" \| "anthropic"` | Automático | La selección explícita tiene prioridad; si se omite, se prefiere una credencial Anthropic OAuth almacenada y utilizable y, de lo contrario, `openai`. |
| `model?` | `string` | backend-dependiente | `gpt-5.6-luna` para OpenAI o `claude-sonnet-5` para Anthropic. |
| `maxDescriptionsPerTurn?` | `number` | `8` | Descripciones nuevas sin acierto de caché admitidas por turno principal. `0` deshabilita las llamadas; los valores no válidos usan el valor predeterminado. |
| `timeoutMs?` | `number` | `45000` | Traer tiempo fuera. Entero 1-2147483647. |

La visión se activa solo para las imágenes enviadas a un modelo en el `noVisionModels` de su proveedor. OpenAI tiene los mismos requisitos de inicio de sesión/reenvío que la búsqueda; Anthropic explícitamente seleccionado falla cerrado sin una credencial utilizable. Las descripciones exitosas de `data:` usan una caché limitada en clave por backend, modelo, detalle, bytes de imagen y contexto de mensaje normalizado. Los hits y duplicados del mismo turno no consumen el límite. Las imágenes remotas `https:` y las descripciones fallidas o vacías no se almacenan en caché.

Anthropic OAuth sidecars reutilización opencodex existentes Claude Code OAuth huella dactilar. Realice una prueba prolongada con la cuenta y la carga de trabajo previstas.

<a id="remote-hub-keys-and-defaults"></a>

## Claves y valores predeterminados del concentrador remoto

`runtimeRole` valores predeterminados a `standalone`. Un concentrador usa `hub.managementPublicOrigin`, `hub.managementIngress` de solo bucle (`enabled:false` cuando está ausente) y `remoteGui.allowedTailscaleUsers` exacto (vacío cuando está ausente). Una clave de datos de cliente vive en `service-api-token`, nunca `config.json`; la rotación puede crear temporalmente `service-api-token.prev`. Las tiendas de uso no se reflejan.

| Clave | Tipo | Predeterminado cuando está ausente | Lo que hace |
| --- | --- | --- | --- |
| `hub.managementPublicOrigin` | cadena | Sin configurar | Origen canónico de administración que anuncia un hub y que puede abrirse en un navegador, por ejemplo, la URL HTTPS mostrada por Tailscale Serve. Es el valor que `/readyz` informa como `managementUrl` cuando `runtimeRole` es `hub`. Si no se configura, el hub usa el origen por el que llegó cada solicitud; un cliente detrás de otro frontend podría recibir una dirección inaccesible. |
| `hub.dataPublicOrigin` | cadena | Sin configurar | El origen canónico de un cliente remoto debe marcar para el plano **datos**, por ejemplo, el origen HTTPS un frontend TLS publica delante de la red Tailscale. Solo asesoramiento: nunca es una dirección de enlace y cambiarla no mueve ningún socket. `ocx hub invite` lo imprime como el URL posicional de la línea `ocx connect`, que se remonta a `http://<hostname>:<port>`, que es una dirección LAN / tailnet que una máquina remota puede no ser capaz de alcanzar más de TLS, así que configúralo en cualquier concentrador con un frontend. A diferencia de la mayoría de las claves opcionales, **no** se deja caer silenciosamente cuando se forma mal: se rechaza un error tipográfico en el momento de la escritura, porque volver a la dirección bind es exactamente lo que el campo existe para evitar. |
| `hub.managementIngress` | `{enabled:false}` o `{enabled:true, port}` | `{enabled:false}` | Un oyente adicional solo de administración para un frontend local HTTPS. El nombre de host no es configurable: cuando está habilitado, el socket siempre enlaza `127.0.0.1`, y solo se admiten las rutas GUI, session-bootstrap y de administración API. Las rutas del plano de datos se rechazan antes del envío. |
| `remoteGui.allowedTailscaleUsers` | string[] | `[]` (vacío - nadie) | Se permite que las identidades de inicio de sesión exactas de Tailscale se emitan en una sesión GUI remota automática. Los `Tailscale-User-Login` El encabezado es de confianza **solo** en la entrada de gestión separada; una lista vacía significa que ninguna identidad remota puede acuñar una sesión, que es el valor predeterminado seguro en lugar de un descuido. Las identidades se comparan exactamente, por lo que un error tipográfico niega silenciosamente el acceso. |
| `remoteGui.allowInsecureHttp` | booleano | Sin configurar | **Jubilado - no tiene efecto.** Una vez permitió un intercambio de emparejamiento de una sola vez sobre el texto sin bucle HTTP. Una concesión de emparejamiento ahora solo cruza loopback o autenticado HTTPS. La clave todavía se analiza para que un `config.json` existente siga cargando (el esquema es estricto, y dejar caer la clave directamente haría que una configuración más antigua no se cargue por completo); un `true` persistente se informa una vez y luego se ignora. Elimínelo de su configuración. |

Un concentrador al que se puede acceder desde un navegador necesita `hub.managementPublicOrigin` y al menos una entrada en `remoteGui.allowedTailscaleUsers`. Establecer el origen sin la lista de usuarios produce un concentrador que se anuncia a sí mismo correctamente y luego rechaza cada sesión; establecer la lista de usuarios sin el origen produce sesiones apuntadas a cualquier origen que la solicitud haya utilizado.

`dataPublicOrigin` y `managementPublicOrigin` son dos anuncios independientes, y en una implementación real son dos sockets diferentes: la administración es el ingreso solo de bucle publicado en 443, los datos son el enlace de red trasera publicado en su propio puerto HTTPS. Son las dos mitades de lo que `ocx hub invite` imprime, y `managementPublicOrigin` es el más estricto de los dos: una concesión de emparejamiento lo registra como el origen del propio servidor de la concesión y el intercambio se compara con él, por lo que `ocx hub invite --management-url` solo puede *confirmar* el valor configurado y rechaza uno que difiera. `--data-url` realmente es una anulación, porque nada está ligado a ella. Con ni `dataPublicOrigin` ni `--data-url` establecidos, `invite` vuelve a la dirección de enlace - y en un enlace de loopback o comodín, donde eso resolvería el propio loopback de esta máquina, rechaza en lugar de anunciar una dirección que la otra máquina no puede usar.

Un centro que sirve a sus propios clientes locales también establece [`unauthenticatedLoopbackListener`](#local-clients-that-cannot-receive-the-token). Su forma complementaria sin puerto es lo que hace que un hub sea un despliegue de puerto único, y se rechaza en un loopback o comodín `hostname`, donde el oyente público ya tiene `127.0.0.1:<port>`.


<a id="experimental-native-response-controls"></a>

## Controles de respuesta nativos experimentales

`codexNativeSteering` y `codexNativeInjection` habilitan rutas de control nativo por WebSocket independientes y **desactivadas de forma predeterminada**. Consulta la guía sobre [rutas y ajustes de control compatibles](/es/guides/codex-integration/#steering-continuation-settings), [resultados tipados y aprobaciones explícitas](/es/guides/codex-integration/#rich-tool-results-and-explicit-approvals-after-response-completion) y [plazos de confirmación y contexto conservado](/es/guides/codex-integration/#steering-confirmation-deadlines-and-retained-context).

<a id="forced-claude-code-subagent-model"></a>

### Modelo de subagente forzado Claude Code

La página Subagentes ofrece **Forzar un modelo para todos los subagentes**, una opción **desactivada de forma predeterminada**. Selecciona un identificador disponible en la lista, como `combo/tev-auto`, y después activa la opción. Primero se ofrece la lista de modelos; las entradas guardadas que ya no estén disponibles no se pueden usar como destino forzado.

`ocx agent subagents force combo/tev-auto` conjuntos `claudeCode.subagentModelForce`; `ocx agent subagents force -` lo aclara. `ocx agent status` informa de la configuración. `GET /api/subagent-models` devuelve `force`, `forceAvailable` y `forceStatus`; `PUT` acepta `{ "force": "combo/tev-auto" }` o `{ "force": null }` sin cambiar la lista. Omitir `force` lo deja sin cambios. Los objetivos inválidos o no expuestos son rechazados en la escritura; los objetivos obsoletos son reportados y omitidos en el lanzamiento.

Esto tiene efecto en el **siguiente inicio enrutado de `ocx claude`**, inyectando `CLAUDE_CODE_SUBAGENT_MODEL` como un alias proxy explícito (con `[1m]` solo para una ventana autorizada de un millón de tokens; los objetivos nativos Claude usan un alias nativo reversible) y `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. Cada variable no vacía exportada por el shell gana independientemente. Los lanzamientos nativos no inyectan ninguna variable; el plano `claude` no se ve afectado. No hay archivos de plugin o `settings.json` se modifican por esta configuración.

Claude Code **2.1.257 o más reciente** es necesario para la fuerza. Los argumentos de modelo de complemento y agentes incorporados (incluyendo Explorar/Planear) y por llamada se anulan. Las bifurcaciones y las habilidades de subagente con `model: inherit` mantienen el modelo de conversación principal. El bucle principal y los sidecars de pequeño-rápido no se ven afectados. Los archivos de la lista existentes permanecen disponibles.

El panel de control advierte sobre versiones antiguas o desconocidas de CLI, objetivos no disponibles y cualquiera de las variables ya presentes en `settings.json` → `env` (que anula env de lanzamiento). La detección es de solo lectura y local en el servidor: no puede inspeccionar otro shell de lanzamiento, otra máquina o la configuración local del proyecto. Un resultado desconocido no es prueba de apoyo a la fuerza.

<a id="historical-pool-continuity"></a>

## Continuidad histórica de los grupos

Los techos de grupo de proveedores usan el proveedor enrutado canónico. Para cada proveedor `P` actualmente configurado, OpenCodex enlaza automáticamente su alias de grupo salado, `h(pool, P)`, a `P` cuando se leen saldos. No se necesita un automapeo manual o cálculo de sal para los techos de proveedores independientes. Esta regla también se aplica a los saldos históricos retenidos con ese alias exacto.

Los registros de solicitudes todavía usan etiquetas de visualización específicas de la cuenta. Una etiqueta histórica diferente, incluyendo una cuenta ordinal, no establece la propiedad del proveedor. Con `spend.pool.maxTokens`, cada saldo original contribuye una vez a su grupo de proveedores vinculados o, cuando aún no está unido y es positivo, a cada grupo de candidatos. El uso establecido, reservado y no resuelto cuenta; el uso desconocido no es un reembolso. Por lo tanto, el historial no vinculado puede restringir un grupo que de otro modo no se usaría. El orden de la cuenta corriente y los nombres que se muestran no resuelven ese historial. Los techos de raíz e identidad siguen siendo independientes.

Para etiquetas históricas distintas cuya propiedad haya verificado, agregue asignaciones al objeto `spendPoolAliases` de nivel superior en `config.json`. Cada clave es un alias hexadecimal en minúsculas de 32 caracteres exacto del diario de esta instalación; cada valor es el ID exacto de un proveedor canónico verificado y configurado actualmente, sin espacio en blanco circundante. Mantenga la evidencia para el mapeo y mantenga el diario y la sal en privado.

Vinculaciones automáticas y asignaciones explícitas se aplican solo cuando se leen los saldos. No mueven saldos originales ni persisten vínculos de identidad en la revista. La eliminación de un mapeo histórico explícito hace que el historial se desvincule de nuevo a menos que su alias sea el propio alias de un proveedor actualmente configurado. Mantenga el `spendPoolAliases` fuera del `spend`, porque las versiones anteriores rechazan campos desconocidos dentro de esa sección estricta. Las asignaciones no válidas se rechazan en escrituras; las ediciones de mano inválidas retienen los techos y la admisión de grupos de rechazos. Un alias de grupo salado de un proveedor configurado no puede asignarse a otro proveedor. Esto se comprueba de nuevo cuando el proveedor establece cambios. La validación lee una sal existente sin crear una.

El historial no vinculado expira solo después de que su última actividad sea estrictamente más antigua que `spend.retentionDays`. La presión de capacidad no puede acortar ese intervalo para la historia positiva desconocida. Las reservas en vivo y los objetivos iniciales permanecen protegidos, incluso a cero tokens. La limpieza persiste en un registro de eliminación de diario normal antes de la admisión utiliza el total reducido. Los grupos conocidos mantienen las protecciones ordinarias activas/agotadas. Ninguna herramienta automática reconstruye asignaciones no verificables.

<a id="token-reservations-and-reporting"></a>

### Reservas de tokens e informes

Cuando se aplica un techo de raíz, identidad o grupo, el primer envío físico para cada destino/clave seleccionado requiere una reserva de capacidad normal. Si eso no se puede registrar, el envío se rechaza antes de que llegue a aguas arriba. Los reintentos estables reutilizan los alcances de esa reserva; un objetivo/clave diferente necesita uno nuevo. `L` es el límite de envío físico de toda la solicitud, congelado cuando se inicia la solicitud (por defecto cuatro; el perfil de solicitud de OAuth acotado existente permite hasta dieciocho). Cada envío físico adicional comparte este límite finito.

El estado de aplicación, los límites de token de raíz/identidad/grupo aplicables y `L` se capturan cuando se inicia cada solicitud. Los cambios de configuración se aplican solo a las solicitudes iniciadas después del cambio. Las solicitudes que ya se están ejecutando mantienen su política de partida para todos los reintentos y continuaciones: habilitar o bajar un techo no las aprieta, y elevar o quitar un techo no las relaja. Una solicitud que se inició en modo de solo observación permanece solo observación hasta que finaliza.

Los informes retrasados retienen el uso ya iniciado. La liquidación de la terminal espera a los reporteros, y las identificaciones de envío se olvidan solo después de que su contabilidad sea duradera; olvidar una identificación no elimina su saldo. Los límites de límite se reintentan, no la factura final: el uso real o los reintentos ya iniciados pueden exceder una estimación de token, y su responsabilidad total sigue siendo contada. Sin límite máximo aplicable, el comportamiento se mantiene solo en observación, incluidas las reservas omitidas cuando la capacidad de seguimiento está llena. No se agregan puntos de control de identidad para el tráfico no configurado.

Claude CLI, CodeBuddy y Qoder cuentan cada invocación CLI como un envío. Su primera invocación todavía necesita una reserva normal y se rechaza si esa reserva no se puede obtener. Los intentos internos de CLI y los giros de herramientas no consumen por separado este límite de envío de toda la solicitud; su costo se establece a partir del uso informado real, incluidas las cantidades por encima de la estimación inicial. Esta excepción preserva el uso de CLI con techos de gasto configurados mientras limita el número de invocaciones secundarias.

<a id="rollback-to-2800-contract-c"></a>

### Retroceder a 2.80.0: contrato C

Los nuevos registros utilizan el formato v1 existente y el dominio alias `pool`. **2.80.0 sin modificar los lee usando sus propias reglas por etiqueta**, incluyendo la compactación y retención ordinaria. No hay necesidad de backport, valla lanzador o comando de reconciliación. Mantenga el diario actual y sal: restaurar una copia anterior pierde el gasto registrado desde esa copia.

Esto no preserva la agregación canónica después de la degradación, ni promete la misma asignación restante que 2.80.0 habría calculado para el mismo tráfico sin la actualización. Puede reservar nuevo tráfico bajo etiquetas de cuenta. En la re-actualización, las auto-vinculaciones actuales del proveedor configurado y las asignaciones explícitas de alias se aplican a los saldos originales aún retenidos por 2.80.0. Los puntos de control nuevos no contienen metadatos de enlaces de identidad que un lector antiguo debe conservar.

Las revistas escritas por compilaciones experimentales no publicadas con `pool-current` alias o `poolContinuity` metadatos están excluidas de este contrato de compatibilidad, incluidos los puntos de control posteriores que llevan esos alias. Sus saldos originales y los objetivos de envío siguen siendo un historial no vinculado conservador hasta que expira la retención normal; no se convierten ni se eliminan inmediatamente.

Un registro de diario no válido completo (incluyendo un `null` final) hace que la admisión configurada se rechace. La compactación aún puede preservar la contabilidad válida en un punto de control limpio; el rechazo en vivo permanece hasta que un reinicio limpio lo reproduce. Una línea final desgarrada e inconmensurable mantiene el comportamiento de recuperación existente. Las denegaciones de almacenamiento / corrupción usan `workflow_spend_undurable`; los archivos inseguros y las fallas de propiedad siguen siendo errores de almacenamiento. Los fallos de validación de Alias utilizan `workflow_pool_history_unresolved`.

<a id="local-upstream-timeout-classification"></a>

## Clasificación de plazos para proveedores locales

La localidad es una política de plazos, no una autorización de acceso a la red. Se clasifica el destino HTTP(S) configurado sin consultar DNS: `localhost` exacto sin distinguir mayúsculas y con punto final opcional, `0.0.0.0`, IPv4 loopback (127/8), direcciones privadas RFC 1918 y link-local (169.254/16), IPv6 loopback, link-local (fe80::/10), unique-local (fc00::/7), equivalentes IPv4 mapeados y nombres terminados en `.local` o `.lan`. Otros nombres DNS mantienen los plazos públicos aunque resuelvan a loopback; destinos mal formados y esquemas no admitidos también. `localhost.example` es público.

Desactivar el reloj de encabezados conserva la cancelación del cliente y cualquier plazo global envolvente. Un `stallTimeoutSec` positivo explícito sigue limitando el silencio local del cuerpo; sin configurar los relojes locales no hay límite automático antes de los encabezados. Las lecturas JSON locales nativas Chat/Messages usan el presupuesto local de silencio; las públicas conservan `max(connectTimeoutMs ?? 200000, 5000)`. Las lecturas del cuerpo compacto mantienen 300 segundos por defecto, incluso localmente. Los presupuestos de los sidecars de imagen y búsqueda no cambian.

`opencodeClientExport` opcional controla `headerTimeoutMs`, `chunkTimeoutMs` y `timeoutMs` del proveedor OpenCode generado: milisegundos positivos o `false` para desactivar. Omitirlos conserva los valores de OpenCode y los inválidos no se emiten. Se escriben para todo el proveedor en opciones V1 y settings V2. Consulta [modelos locales lentos](/es/guides/opencode/#slow-local-models-prefill-timeouts).

El ajuste opcional `omoClientExport.api`, disponible solo en el archivo de configuración, selecciona el protocolo del bloque de proveedor administrado de omo, basado en Pi: `openai-completions` (predeterminado) u `openai-responses`. Se ignoran los demás valores. Solo omo lo utiliza. Después de añadir, cambiar o eliminar la clave, reinicia el proxy (`ocx service restart` si usa un servicio, o `ocx stop` y después `ocx start`) y actualiza **Conectar → omo** en el dashboard. Actualizar usa la configuración del proxy en ejecución; no vuelve a cargar el archivo. Consulta [Integraciones](/es/guides/integrations/).
