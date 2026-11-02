---
title: "API de administración"
description: "Autenticación, errores y endpoints del plano de administración de opencodex."
---

El Management API es el plano de control de opencodex. El panel de control en `http://localhost:10100` es un cliente de él; los proveedores, modelos, combos, cuentas, configuraciones, diagnósticos y comandos del ciclo de vida de `ocx` sin cabeza también son clientes. El API solo está disponible mientras el proxy se está ejecutando.

Utilice el [Panel de control web](/es/guides/web-dashboard/) para un cliente interactivo, o esta referencia al construir la automatización. Los valores persistentes siguen en última instancia [Configuración](/es/reference/configuration/).

<a id="authentication-model"></a>

## Modelo de autenticación

El Management API tiene su propia credencial de administración, independientemente de las claves del plano de datos API. En el inicio, opencodex lo resuelve en este orden:

1. `OPENCODEX_ADMIN_AUTH_TOKEN`, cuando se establece.
2. Un token `ocx_admin_*` generado en un archivo secreto endurecido.

El token respaldado por archivos se acepta solo después de que se hayan endurecido sus permisos de directorio y archivo o ACL. Si eso no se puede garantizar, la autenticación de administración falla y el API devuelve 503 hasta que se suministra un token de entorno o se repara el estado del archivo.

Envíe el token de administración en cualquier forma:

```http
X-OpenCodex-API-Key: <admin-token>
```

```http
Authorization: Bearer <admin-token>
```

:::caution
El administrador token debe diferir de cada credencial del plano de datos. Startup rechaza una gestión Credencial que entra en conflicto con una clave de admisión proxy. No ponga el administrador token en Codex, Claude Code, u otro cliente modelo; autoriza mutaciones en el plano de control.
:::

<a id="loopback-dashboard-sessions"></a>

### Sesiones de panel de Loopback

En un enlace de loopback, el cuadro de mandos puede recibir una credencial `ocx_session_*` de corta duración. Cada sesión dura cinco minutos y está vinculada al origen exacto del panel de control. Las solicitudes seguras deben coincidir con ese origen. Los métodos inseguros también requieren el navegador `Origin` y el token CSRF de la sesión.

Cuando se requiere autenticación de plano de datos, que incluye enlaces remotos, la secuencia de arranque de bucle de retorno no acuña una sesión. Un panel de control remoto obtiene una sesión de 12 horas solo a través de una identidad Tailscale de confianza (`remoteGui.allowedTailscaleUsers` en la entrada de administración Tailscale) o una concesión de emparejamiento de un solo uso; cada solicitud autorizada la extiende. De lo contrario, un operador remoto se autentica con el token de administración sin procesar y el panel de control lo solicita nuevamente después de una recarga porque la sesión solo vive en la memoria de la página. Véase [Hub remoto](/es/guides/remote-hub/).

<a id="common-errors"></a>

## Errores comunes

Todas las filas de punto final por debajo heredan estos errores de límite. La columna "Errores notables" muestra resultados adicionales específicos de la ruta en lugar de repetir esta tabla.

| Situación | Tipo o código | Descripción |
| --- | --- | --- |
| 401 | `opencodex admin token required` | La sesión de token de administrador o GUI no se encuentra, no es válida, ha caducado, no coincide con el origen o falta evidencia de CSRF |
| 403 | `cross-origin request blocked` | El origen de la solicitud está fuera de la lista de permisos de administración |
| 404 | `not_found` | Ninguna ruta de administración coincide con el método y la ruta |
| 413 | `request body too large` | Un cuerpo POST, PUT o PATCH excede el límite de administración de 2 MiB |
| 503 | `management API unavailable` | La inicialización o endurecimiento de credenciales de administrador no está disponible |
| 503 | `oauth_mutation_busy` | Otra mutación de la credencial OAuth sostiene al escritor; la respuesta incluye `Retry-After: 1` |
| 503 | `catalog_busy` | La recolección de catálogos ya está a su capacidad; la respuesta incluye `Retry-After: 1` |

<a id="endpoint-matrix"></a>

## Matriz de punto final

<a id="agent-and-client-settings"></a>

### Configuración de agente y cliente

| Método y ruta | Finalidad | Errores notables |
| --- | --- | --- |
| `GET, PUT /api/v2` | Leer o cambiar la configuración nativa del modo v2 y el subproceso de múltiples agentes | 400 ajustes no válidos; 502 Fallo de transición o persistencia |
| `GET, PUT /api/injection-model` | Leer o configurar el modelo de subagente inyectado, los ajustes de esfuerzo, prompt y orientación | 400 modelo, esfuerzo o cuerpo no válidos |
| `POST /api/injection-model/suggest` | Dimensionar una carga de trabajo delegada descrita y proponer un modelo de delegación y esfuerzo sin escribir | 400 trabajos o modelos no válidos; 409 sin modelo de tamaño |
| `GET, PUT /api/effort-caps` | Leer o establecer límites globales y de esfuerzo de razonamiento de subagentes | 400 valor de escalera no válido |
| `GET, PUT /api/subagent-models` | Leer u ordenar los modelos anunciados a los sub-agentes | 400 lista inválida o más de cinco modelos |
| `GET, PUT /api/subagent-model-fallback` | Leer o establecer la cadena de reserva ordenada y el intervalo de sondeo | 400 lista inválida o intervalo de sondeo |
| `GET /api/grok` | Leer el estado de configuración administrada Grok y los modelos candidatos | Error de lectura de 400 estados |
| `PUT /api/grok/selection` | Persisten los modelos Grok excluidos | 400 selección no válida o sobredimensionada |
| `POST /api/grok/apply` | Aplicar configuración persistente Grok a través de la sincronización administrada | 409 `grok_apply_busy`; 400/500 aplican fracaso |
| `GET /api/grok/reset-coupons?accountId=...` | Leer los tokens de restablecimiento de facturación Grok restantes y las ventanas de validez para la cuenta xAI activa o especificada | 400 cuentas perdidas; 401 no autenticado; 502 upstream gRPC -Error web |
| `POST /api/grok/reset-coupons/consume` | Canjee un cupón de reinicio elegible. Cuerpo `{ accountId?, tokenId?, operationId? }`. Opcional `operationId` (UUIDv4) hace que la redención sea idempotente: repetir el mismo ID reproduce el resultado duradero sin doble redención. | 400 inválido JSON /UUID; 401 no autenticado; 409 `operation_id_owned_by_another_account` / `coupon_unavailable` / `operation_token_mismatch` / `operation_state_changed` / `attempt_in_progress` / `attempt_unresolved`; 502 error ascendente; 503 capacidad del libro mayor / `ledger_unavailable`; 500 `attempt_mark_failed` |
| `GET /api/anthropic/reset-grants?accountId=...` | Lea las concesiones de restablecimiento de límite de uso Claude de una cuenta Anthropic OAuth: elegibilidad, restablece izquierda de cada concesión, ventana de validez y las ventanas que se borra, además de cualquier intento no confirmado todavía reintentable | 400 sin cuenta de juego; 401 Re-autenticación necesaria; 502 aguas arriba no disponible |
| `POST /api/anthropic/reset-grants/consume` | Gasta una subvención de reinicio. Cuerpo `{ accountId, grantId, operationId }`; `operationId` es un UUIDv4 enviado aguas arriba como el ID de solicitud, por lo que repetirlo vuelve a intentar la misma reivindicación. Requiere una sesión de panel. Un `reset` establecido levanta el tiempo de reutilización local de la cuenta solo cuando es un rechazo de cuota registrado antes de que la reclamación se publicara por primera vez y las ventanas que la subvención informó cubren cada ventana que la negativa nombró (ambas ventanas cuando no nombró ninguna). Una denegación registrada mientras la reclamación estaba en vuelo, una denegación de derecho o una ventana descubierta permanece, incluso en una repetición del mismo ID. La cuota en caché se elimina y el uso se vuelve a leer con una nueva solicitud, por lo que el grupo puede seleccionar la cuenta antes de la fecha límite anterior. Las exclusiones de familias modelo permanecen hasta que esa relectura prueba que una familia ya no es rechazada. | 400 cuerpos inválidos; 401 Re-autenticación necesaria; 403 `session_required`; 409 `grant_not_usable`, `in_flight`, `unresolved_prior_operation`, `unknown_outcome_expired`, `operation_identity_mismatch`; 500 `journal_write_failed`; 502 `unknown_outcome`; 503 diario ocupado, no disponible, o lleno |
| `GET, PUT /api/claude-desktop` | Lee o guarda el perfil enrutado/nativo y la visibilidad de modelos de Claude Desktop. PUT requiere un `profile` válido, incluso al configurar o borrar `visibility` (omitirlo conserva el valor; `null` lo borra). Un cuerpo que solo incluya visibilidad devuelve 400. | 400 perfil ausente o no válido, asignación no válida o no disponible, visibilidad no válida o que oculte todos los modelos disponibles; 409 cambio del perfil o de la visibilidad enviada durante el descubrimiento/guardado |
| `POST /api/claude-desktop/apply` | Escribe el perfil guardado en la configuración administrada de Claude Desktop | 400/500 fracaso de escritura |
| `GET, POST /api/codex/desktop-compatibility/certificate` | Inspeccione o prepare explícitamente el certificado de compatibilidad Windows | 403 requiere un panel local emparejado para POST; 409 estado rancio, ocupado o incompleto |
| `GET, POST /api/codex/desktop-compatibility/runtime` | Inspeccionar o iniciar, detener, iniciar o ejecutar una prueba de compatibilidad nativa limitada | 403 requiere un panel local emparejado para POST; 409 compilación sin soporte, certificado no confiable o estado incompleto |
| `GET, POST /api/codex/desktop-compatibility/settings` | Leer o guardar la preferencia de observación del siguiente inicio con su revisión actual | 403 requiere un panel local emparejado para POST; 409 Configuración obsoleta, inválida o no confirmada |
| `GET /api/claude-desktop/status` | Compara el perfil guardado con el aplicado, consulta el estado de Desktop y devuelve `appliedModels: { name: string; label: string }[] \| null`. Es la lista estática del perfil seleccionado en disco; no verifica el proceso de Desktop. `null` indica que no hay un perfil de pasarela aplicado o una lista estática legible, incluido el modo de solo descubrimiento; no significa que la lista esté vacía. | 400 fallo al leer el estado |
| `GET, PUT /api/claude-code` | Leer o actualizar la configuración de la puerta de enlace Claude Code, el modo de autenticación, el mapa de modelos, el contexto, el agente y el sidecar | 400 campo o forma no válidos |

`tokenId`, cuando se suministra, debe ser una cadena no vacía; los valores no válidos devuelven `400 invalid_token_id` antes de que se lean las credenciales o se abra el libro mayor. Dentro de la ventana de retención de 30 días, un mismo `operationId` reintento que omite `accountId` usa la cuenta registrada, incluso si la cuenta activa cambió. Un ejecutable `open` retry que omite `tokenId` utiliza su token grabado. Todavía se rechaza una cuenta o token diferente explícito. Un fallo definitivo despeja una espera especulativa coincidente en el tablero, permitiendo un nuevo intento explícitamente confirmado; los resultados desconocidos reales permanecen retenidos.

Un intento es reclamado de manera duradera antes de la redención. Solo una respuesta de canje confirmada puede registrar `redeemed`; un cupón que falta en la lista restante no prueba que esta operación haya tenido éxito. Después de un tiempo de espera o de un acuerdo perdido, los reintentos inspeccionan la disponibilidad sin volver a canjear y devuelven `attempt_unresolved`; un intento reciente devuelve `attempt_in_progress`. Una negativa de inspección tardía establece solo una operación `open`. En la misma transacción, un ganador de terminal definitivo que coincida con la identidad se reproduce con HTTP 200 y su código original; un ganador no resuelto o con identidad no coincidente devuelve `operation_state_changed`, preservando la guía de recuperación del mismo ID. Un libro mayor ilegible o bloqueado devuelve `ledger_unavailable` sin enviar una redención.

Una vez que una persona que llama suministra un `operationId`, cada respuesta que no puede probar que la operación se resuelve lleva ese `operationId` en el nivel superior y mantiene a la persona que llama en él: `attempt_unresolved`, `attempt_in_progress`, `attempt_reconcile_failed`, `operation_state_changed`, `operation_token_mismatch`, `attempt_mark_failed`, `ledger_unavailable` y el libro mayor `capacity` (el libro mayor completo no puede reservar el ID, por lo que una solicitud anterior que lo mantiene aún puede abrirlo más tarde). Esto incluye rechazos antes de que se abra el libro mayor: un `tokenId` mal formado, una cuenta desconocida o una consulta de cuenta fallida bajo un retorno de ID 409 `attempt_in_progress` suministrado con el ID, porque otra solicitud ya puede contener esa operación. Un rechazo de autenticación definitivo se registra atómicamente como una operación `failed` vinculada al cupón solicitado, por lo que un reintento lo reproduce; nunca se reproduce una operación existente para un cupón diferente. Una lista de reinicio restante fallida establece una operación no reclamada como `fetch_resets_failed`. Una respuesta de canje cuenta como confirmada solo cuando su marco gRPC -Web está completo y cada `grpc-status` que lleva tiene el mismo valor válido; estados o bytes en conflicto después de la devolución del remolque 502 `attempt_unresolved` y abandona la operación `attempted`.

Un reembolso no confirmado devuelve HTTP 502 con `error.code: "attempt_unresolved"` y el efectivo `operationId`. Preservar ese ID; un ID de reemplazo iniciaría una operación diferente. El CLI crea el ID antes de enviar e imprime la guía `--operation-id` si la entrega o la respuesta es incierta. Los registros `open` de la versión anterior y los registros `redeem_failed` no confirmados se ponen en cuarentena como inciertos; nunca autorizan otra redención.

El panel de control en **Prestadores xAI Grok** enumera los cupones restantes y sus ventanas de validez de la insignia de boleto de cada cuenta. Envía un `operationId` acuñado por el cliente. Después de una entrega incierta o una respuesta de resultado desconocido, el panel retiene ese intento para la sesión de pestaña del navegador, incluso en el cuadro de diálogo cerrar / volver a abrir, navegación de página y recarga. La retención se escribe antes de que la solicitud se envíe y se borre solo mediante una respuesta definitiva para el mismo `operationId`. Disponibilidad actualiza el problema GET solamente y nunca autorizar otro consumir POST. `ocx account grok-reset-coupons` es el terminal equivalente.

Claude reseteos de uso funcionan de la misma manera de **Proveedores? Anthropic? Cuentas**. Cada fila de cuenta iniciada lleva una insignia de ticket con sus reinicios restantes, y el diálogo pasa uno después de una segunda confirmación. Un reinicio rellena los límites de 5 horas y semanales sin mover el día de reinicio semanal. Cuando una reclamación no responde, el diálogo mantiene su `operationId` y ofrece un reintento con esa misma ID durante diez minutos, que es como el propio cliente Claude Code se recupera; una nueva operación para la misma concesión se rechaza hasta entonces. El gasto es solo en el panel: el token de administración solo obtiene `403 session_required`.

Para ver los conceptos detrás de la lista de modelos y el comportamiento cifrado de la tarea del trabajador, consulte [Superficie del subagente](/es/guides/sub-agent-surface/).

<a id="client-integration-rollback-journal"></a>

### Diario de reversión de la integración del cliente

| Método y ruta | Finalidad | Errores notables |
| --- | --- | --- |
| `GET /api/client-integrations/journal?client=...` | Lista de operaciones de reversión, opcionalmente para un cliente. Cada fila incluye el indicador `deletable` calculado por servidor. | 400 clientes no válidos |
| `DELETE /api/client-integrations/journal?opId=...` | Retire una operación de reversión anterior y elimine su instantánea cuando sea posible. El éxito regresa `snapshotRemoved`; `false` significa que se retuvo la limpieza para el reintento de mantenimiento. | Faltan 400 `opId`; 404 operación faltante o ya retirada; 409 nueva operación para ese cliente |

La eliminación agrega una lápida en lugar de reescribir el diario. La operación más reciente para cada cliente está protegida en el lado del servidor, por lo que el punto de deshacer actual permanece disponible. Para Aside, la protección es por perfil, y las filas del diario incluyen `profileId`.

<a id="aside-profile-controls"></a>

### Aside controles de perfil

Utilice estas rutas dedicadas con un proxy compatible. `{profileId}` es un ID de cuenta entero no negativo registrado devuelto por la lista de perfiles; no es una ruta del navegador.

| Método y ruta | Finalidad | Errores notables |
| --- | --- | --- |
| `GET /api/client-integrations/aside/profiles` | Lista `profiles[]`, deseado `enabledCount` / `allEnabled`, actual `appliedCount`, y `total` | HTTP 200 puede contener un agregado vacío e inseguro con un `error` cuando el descubrimiento no está disponible |
| `PUT /api/client-integrations/aside/profiles` | Establezca el estado deseado de cada perfil registrado y aplíquelo; cuerpo `{ "enabled": true }`, con `overwriteConflict` opcional al habilitar | 400 cuerpos inválidos; 409 operación ocupada; 500 preferencia-salvar fracaso; 207 denegaciones por perfil |
| `GET /api/client-integrations/aside/profiles/{profileId}` | Lea el perfil deseado `enabled` y el estado de integración real | 400 ID no válido; 404 perfil no registrado |
| `PUT /api/client-integrations/aside/profiles/{profileId}` | Cambiar un perfil con el mismo cuerpo que el PUT a granel, dejando las preferencias de los hermanos sin cambios | 400 cuerpo/ID no válido; 404 perfil desconocido; 409 ocupado o rechazo; 500 fallos de escritura/guardar |
| `GET /api/client-integrations/aside/profiles/journal` | Historial de listas en todos los perfiles registrados de Aside | Las filas incluyen `profileId`, disponibilidad de instantáneas, `undoable` y `deletable` |
| `GET /api/client-integrations/aside/profiles/{profileId}/journal` | Enumerar el historial de un perfil, incluidas las operaciones heredadas coincidentes | 400 ID no válido; 404 perfil desconocido |
| `DELETE /api/client-integrations/aside/profiles/journal?opId=...` | Retirar una operación anterior, resolviendo su perfil de la historia | 400 identificaciones perdidas; 404 falta de funcionamiento; 409 nueva operación para su perfil |
| `DELETE /api/client-integrations/aside/profiles/{profileId}/journal?opId=...` | Retirar una operación anterior que pertenezca al perfil seleccionado | Los mismos errores de eliminación; una operación no puede apuntar a un perfil diferente |
| `POST /api/client-integrations/aside/profiles/{profileId}/restore` | Deshacer una operación usando `{ "opId": "..." }`; opcional `confirmDrift: true` permite reemplazar ediciones posteriores | 404 Falta la operación/perfil; 409 ocupado, desajuste o confirmación de deriva requerida; 410 instantánea expirada; 500 fallos de escritura/guardar |
| `POST /api/client-integrations/aside/sync` | Actualizar perfiles habilitados a través del propietario de la mutación del servidor; cuerpo `{}` | 400 selector de cuerpo/perfil no vacío; 409 ocupados; 207 denegaciones por perfil |

<a id="previewing-an-integration-change"></a>

## Vista previa de un cambio de integración

Una vista previa informa lo que un cambio haría sin hacerlo. Estas rutas no escriben nada: sin instantáneas, sin registro de propiedad, sin fila de diario, sin bloqueo y sin mantenimiento o recuperación.

| Ruta | Finalidad | Respuestas notables |
| --- | --- | --- |
| `POST /api/client-integrations/preview` | Plan `apply`, `overwrite` o `disable` para un cliente; cuerpo `{ "clientId": "...", "operation": "..." }` | 400 cliente no válido u operación; 400 `invalid_aside_profile_path`; 409 `integration_preview_unavailable` |
| `POST /api/client-integrations/restore/preview` | Planificar un deshacer; cuerpo `{ "opId": "...", "confirmDrift": false }` | 404 operación desconocida; 400 `invalid_aside_profile_path`; 409 `integration_preview_unavailable` |
| `POST /api/client-integrations/aside/profiles/{profileId}/preview` | Planifique un cambio en el perfil de Aside, incluyendo `restore` con un `opId` | 400 cuerpo inválido o solicitud no especificada; 404 perfil u operación desconocidos, 409 `integration_preview_unavailable` |

Un plan lleva `version`, `clientId`, `operation`, `state`, `foreignEdit`, una lista `changes` de `kind` y `path` pares, un `fingerprint`, `canApply`, `willChange` opaco y un `refusalReason` y `profileId` opcionales. Las rutas son rutas de esquema gestionadas o los marcadores fijos `$snapshot`, `$ownership` y `$journal`; una posición elegida en entorno de ejecución aparece como `*`. No se devuelve ningún valor de configuración, ubicación del archivo o identidad del miembro seleccionado.

`canApply: true` con `willChange: false` significa que la operación tiene éxito y no cambia nada en el documento del cliente administrado, como aplicar lo que ya se aplica.

Un cambio de perfil de Aside aún guarda una cosa en ese caso. Confirmar que registra la preferencia de sincronización deseada para ese perfil antes de que se toque cualquier documento de cliente, deshabilitando así un perfil cuyo bloque administrado ya está ausente almacena la preferencia y deja el documento y su historial intactos.

`integration_preview_unavailable` significa que actualmente no se conserva ninguna lista de modelos utilizables. Un proxy recién iniciado es una forma de estar en ese estado; una lista retirada porque la configuración o la caché del proveedor movida es otra. La lectura `GET /api/client-integrations` establece uno cuando el descubrimiento tiene éxito y la configuración puede ser identificada, por lo que es el remedio habitual en lugar de una garantía.

<a id="confirming-a-previewed-change"></a>

## Confirmar un cambio previsualizado

Las rutas de mutación aceptan `operation` y `planFingerprint` junto con su cuerpo existente. Envíe ambos o ninguno: se rechaza una solicitud que lleve uno, al igual que una cuya `operation` no esté de acuerdo con el cambio solicitado. Aparte de las vinculaciones se aplican a un solo perfil, porque una huella dactilar no puede describir varios archivos que cambian independientemente.

El servidor vuelve a planificar antes de escribir nada y devuelve `409 integration_preview_stale` con un `plan` recién calculado cuando la confirmación ya no describe lo que sucedería. Decidir de nuevo en contra del nuevo plan; la solicitud no se vuelve a intentar automáticamente.

Una huella digital es un cheque optimista, nunca una autorización. La autenticación de la administración y cada regla de propiedad aún deciden si un cambio puede ocurrir.

Bulk PUT devuelve `{ ok, clientId, changed, state, message, results }`; cada resultado identifica su `profileId` e informa el resultado del escritor. La sincronización devuelve `{ ok, clientId, results }`, con resultados de actualización por perfil. Ambos devuelven HTTP 200 cuando todos los intentos devueltos tienen éxito y HTTP 207 con `ok: false` cuando cualquier intento se niega. HTTP 207 es un sobre de resultado parcial, incluso cuando todos los intentos de perfil se niegan: inspeccione cada resultado en lugar de tratar una respuesta 2xx como un éxito completo. Un no-op exitoso puede tener `changed: false`; la sincronización no intenta desactivar los perfiles. El perfil único escribe y restaura el retorno HTTP 200 en caso de éxito o el estado de error correspondiente en caso de rechazo.

Los cambios explícitos guardan las preferencias deseadas antes de escribir archivos. Un fallo de guardado de preferencias deja los archivos de perfil sin cambios. Un rechazo de archivo posterior preserva la intención guardada y escribe con éxito; inspeccione el perfil afectado antes de volver a intentarlo. Los rechazos pueden incluir `snapshotPath` y `residual: true` cuando la recuperación no terminó. Restaurar también reconcilia el estado deseado del perfil de destino, por lo que la siguiente sincronización no invierte Deshacer. Devolución `snapshotRemoved`; `false` significa que la limpieza de instantáneas aún necesita mantenimiento.

Los alias heredados `GET, PUT /api/client-integrations/aside` siguen disponibles. Los clientes nuevos deben usar las rutas dedicadas anteriores para que un proxy antiguo no pueda ignorar un selector de perfil. Consulte [Aparte de controles de perfil](/es/guides/integrations/#aside-profile-controls) para ver las órdenes CLI y la secuencia de actualización, reinicio y reintento del proxy.

<a id="remote-workspace"></a>

### Espacio de trabajo remoto

Requiere el modo Hub y `OCX_REMOTE_WORKSPACE_ENABLED=1` en el proceso Hub. El estado de deshabilitado es legible; las mutaciones se niegan sin inicializar los servicios del espacio de trabajo.

| Método y ruta | Finalidad | Errores notables |
| --- | --- | --- |
| `GET /api/remote-workspace` | Lea equipos emparejados, capacidades actuales, tiempos de ejecución de Hub e instantáneas de sesión | Estado desactivado cuando el rol de Hub o el opt-in explícito están ausentes |
| `POST /api/remote-workspace/pairing` | Crear un código de inscripción de un solo uso de diez minutos | Sesión de GUI emparejada por el operador solamente; 429 capacidad de emparejamiento |
| `GET /api/remote-workspace/runtimes` | Leer Codex, Claude Code, y la disponibilidad de Pi en el Hub | — |
| `GET, POST /api/remote-workspace/sessions` | Listar sesiones o iniciar una vinculada a un dispositivo, root, tiempo de ejecución y modo de acceso | POST requiere una sesión de GUI emparejada por el operador; 409 objetivo fuera de línea/no disponible/no válido |
| `POST /api/remote-workspace/sessions/{id}/prompt` | Continuar la sesión del modelo vinculado | Sesión de GUI emparejada por el operador solamente; 409 turno activo, ejecutor sin conexión o falla de reanudación |
| `DELETE /api/remote-workspace/sessions/{id}` | Detener el tiempo de ejecución del modelo y la sesión de Ejecutor encriptado | Sesión de GUI emparejada por el operador solamente; 404 sesión desconocida |
| `DELETE /api/remote-workspace/devices/{id}` | Revocar una computadora y detener sus sesiones | Sesión de GUI emparejada por el operador solamente; 404 - Artículo no encontrado |

La inscripción del ejecutor intercambia un código de un solo uso en `POST /remote-workspace/pair` y luego abre `/remote-workspace/agent` como un WebSocket saliente autenticado por el portador. Esos dos puntos finales de máquina no son la autoridad de gestión general API. El portador tiene alcance de dispositivo, y cada sesión de trabajo agrega un apretón de manos E2EE firmado. Diez códigos de emparejamiento fallidos de un retorno de pares observado en el núcleo `429` con `Retry-After` para el resto de la ventana fija de diez minutos. Los clientes de Tailscale Serve comparten el bucket de pares de loopback del oyente de administración; el encabezado de identidad no se usa para la regulación porque un proceso local directo podría forjarlo. Consulte [Espacio de trabajo remoto](/es/guides/remote-workspace/) para conocer los límites de confianza y flujo del usuario final.

Las instantáneas de sesión incluyen `resumable`. Se vuelve cierto sólo después de que el entorno de ejecución del agente de codificación seleccionado tenga un historial duradero; en particular, una nueva sesión Claude Code permanece falsa hasta que se complete su primer aviso.

### Combos

| Método y ruta | Finalidad | Errores notables |
| --- | --- | --- |
| `GET /api/combos` | Lista de combos normalizados y sus ID de modelo público | El trabajo del catálogo puede devolver `catalog_busy` |
| `PUT /api/combos` | Crea, sustituye o renombra un combo. | 400 si el identificador, destino, configuración o cambio de nombre son inválidos, o hay una colisión ordinaria; un 400 de validación también identifica el primer campo superior inválido en `field`, por ejemplo `targets` o `decisionProvider`. 409 si hay colisión con el espacio de nombres de una cuenta Codex. |
| `DELETE /api/combos?id=...` | Eliminar un combo y borrar su estado de selección/enfriamiento | 400 identificaciones faltantes; 404 - Categoría no encontrada |

Consulte [Combos](/es/guides/combos/) para conocer las estrategias de destino, los tiempos de reutilización, los alias y los fallos de enrutamiento.

<a id="codex-prompt-layers"></a>

### Capas de aviso Codex

| Método y ruta | Finalidad | Errores notables |
| --- | --- | --- |
| `GET /api/codex-prompt` | Lea la instantánea de la capa de solicitud: capas, variantes base, selección y estado de deriva | — |
| `GET /api/codex-prompt/text` | Sondear el texto visible por el modelo mediante `codex debug prompt-input`; un único presupuesto por cliente incluye metadatos, espera compartida y ejecución; los metadatos síncronos se comprueban al regresar por si venció el plazo | Un sondeo no disponible degrada a un estado en el cuerpo, no a un error HTTP; el timeout conserva las instrucciones base leídas localmente; una cancelación externa anterior sigue cancelada |
| `PUT /api/codex-prompt/toggle` | Habilitar o deshabilitar una capa conmutable | 400 cuerpo inválido o capa desconocida; 409 `stale_revision`, `layer_not_toggleable` |
| `PUT /api/codex-prompt/custom` | Reemplazar el conjunto de capas personalizadas | 400 cuerpo inválido, `invalid_characters`, `body_too_large` cuando una capa UTF-8 normalizada excede 65.536 bytes, `composed_too_large` sobre 131.072 bytes; 409 `stale_revision` |
| `PUT /api/codex-prompt/base/select` | Seleccione el indicador de base predeterminado o una variante almacenada | 400 cuerpo no válido, `unknown_layer` para una identificación que no coincide con ninguna variante almacenada; 409 `stale_revision`, `developer_instructions_not_owned` cuando la base actual es externa |
| `PUT /api/codex-prompt/base` | Crear (`id` omitido o `id: null`), editar o eliminar (`delete: true`) una variante base. Un `id` suministrado es solo de edición y debe hacer referencia a una variante almacenada. `body` se normaliza (pestañas expandidas, CR/CRLF doblado a LF) antes de medirse o almacenarse | 400 cuerpo inválido, `unknown_layer` para el id `default` o un id que no coincide con ninguna variante almacenada, `body_too_large` cuando el cuerpo UTF-8 normalizado excede 65.536 bytes; 409 `stale_revision` |
| `POST /api/codex-prompt/adopt` | Importar `developer_instructions` desde `config.toml` como capa personalizada | 400 cuerpo inválido, `invalid_characters`, `body_too_large`, `composed_too_large`; 409 `config_unreadable`, `nothing_to_adopt`, `adopt_unsupported_form`, `stale_revision` |
| `POST /api/codex-prompt/repair` | La deriva de reparación entre `config.toml` y la proyección propia | 400 cuerpos inválidos; 409 `config_unreadable`, `nothing_to_repair`, `repair_unsupported`, `stale_revision` |

Vea [Codex capas de solicitud](/es/guides/codex-prompt/) para el modelo de capa y las claves que escribe cada capa.

<a id="configuration-startup-sync-and-updates"></a>

### Configuración, inicio, sincronización y actualizaciones

| Método y ruta | Finalidad | Errores notables |
| --- | --- | --- |
| `GET /api/config` | Devolver el DTO de configuración redactado y seguro para la administración | — |
| `PUT /api/config` | Deshabilitado protector de reemplazo de configuración completa | 405; use endpoints enfocados en su lugar |
| `GET, PUT /api/settings` | Lea la configuración de tiempo de ejecución/arranque o actualice el inicio automático, el modo de transmisión, el presupuesto de memoria propiedad de la aplicación y `codexAccountPickerEnabled` | 400 actualización no válida, no objeto o vacía |
| `GET, PUT /api/native-reasoning-retention` | Leer resuelto booleanos modelo/cuenta razonamiento-retención; PUT parcial conserva campos omitidos, JSON `null` restaura valores predeterminados. Véase [Retención de razonamiento nativo](/es/reference/configuration/server/#native-reasoning-retention). | 400 campo desconocido, tipo no válido o cuerpo no-objeto/no-nulo |
| `GET, PUT /api/workflow-budget/settings` | Leer los límites efectivos por tarea, sus valores predeterminados y rangos permitidos; un PUT parcial conserva los campos omitidos y JSON `null` restaura los predeterminados. Consulta [Límites del flujo de trabajo](/es/reference/configuration/server/#workflow-limits). | 400 campo desconocido, valor no entero o fuera de rango, o cuerpo que no sea objeto ni null |
| `GET /api/startup-health` | Leer servicio en caché/salud de inicio de shim | — |
| `POST /api/startup-action` | Instalar o reparar el servicio o la cuña Codex | 400 acciones inválidas; Fracaso de 500 acciones |
| `GET, POST /api/windows-tray` | Leer el estado de la bandeja Windows o instalar/iniciar/detener/desinstalar | 400 plataforma/acción no soportada; 500 fallo de operación |
| `GET /api/diagnostics/project-config` | Leer las advertencias de configuración del proyecto en caché | — |
| `POST /api/sync` | Sincronice el catálogo de modelos actual en Codex | 500 sincronización fallida |
| `GET /api/update/check` | Compruebe de forma asíncrona el canal de paquetes `latest` o `preview` y actualice la caché del paquete en caso de éxito | 400 etiqueta inválida |
| `POST /api/update/run` | Comprobar de forma asíncrona una versión nueva e iniciar su actualización, opcionalmente seguida de reinicio | 400 cuerpo inválido; 409 `update_restart_unsupervised` si el proxy se ejecuta dentro de una unidad systemd distinta del servicio de usuario de OpenCodex, o el proceso de actualización no puede salir de su cgroup (con o sin reinicio, porque la actualización detiene primero el proxy); otros estados de conflicto o error del trabajo |
| `GET /api/update/status` | Consultar periódicamente un trabajo de actualización por su id | 404 trabajo desconocido |
| `GET, PUT /api/sidecar-settings` | Lea o actualice la configuración del modelo/backend del sidecar de la visión y la búsqueda web | 400 forma inválida, backend o límite |
| `GET, PUT /api/shadow-call-settings` | Leer o actualizar la interceptación de llamadas de sombra, incluido `sourceModels`; GET también devuelve el inventario `sourceModelOptions` del entorno | 400 forma o valor inválido, incluidos prefijos vacíos, duplicados, con espacios o proveedor, más de 32 prefijos o más de 128 caracteres por prefijo; los fallos de lista llevan `code: shadow_call_source_invalid` y los conflictos de destino `code: shadow_call_target_invalid` |

<a id="logs-usage-and-storage"></a>

### Registros, uso y almacenamiento

Los registros de solicitud retienen `servedModel` cuando el flujo ascendente identifica el modelo que respondió, y `wireModel` cuando el modelo enviado flujo ascendente difiere del modelo orientado al cliente. El panel de control muestra `wire → served` cuando esas identidades difieren; su descripción conserva ambos valores. La evidencia del modelo ascendente faltante permanece ausente en lugar de inferirse del modelo solicitado.

Las filas de solicitudes fallidas pueden incluir diagnósticos `upstreamErrorType`, `upstreamErrorCode` y `upstreamRequestId`. En la ruta Codex aguas arriba WebSocket, un error desnudo seguido de EOF retiene los códigos de límite de velocidad, sobrecarga o rechazo de cliente reconocidos en el terminal fallido sintetizado. Los registros de solicitudes registran estos como 429 para `rate_limit_exceeded` / `rate_limit_error`, 503 para `server_is_overloaded` / `overloaded_error`, y 400/401/403/404 para `invalid_request_error` / `authentication_error` / `permission_error` / `not_found_error`. Un tipo reconocido sin un código usa el mismo estado. En la ruta de transmisión, un código explícito desconocido registra el estado 5xx de la envoltura Codex WebSocket como un entero de nivel superior `status` o `status_code` (uno de los dos, no ambos); de lo contrario, y para los llamantes JSON almacenados en memoria intermedia, sigue siendo un fallo genérico 502. El terminal de cliente mantiene `upstream_server_error` para códigos desconocidos de cualquier manera. El estado de error desnudo es provisional: un terminal genuino completado, fallido o incompleto lo reemplaza antes de la grabación de salud de la cuenta. La prioridad de rechazo no cambia. Este mapeo de diagnóstico no agrega reproducción o reintento automático.

`GET /api/logs` acepta un opaco opcional `cursor` de su respuesta anterior. La envoltura conserva `logs`, `total`, `generatedAt` y `timeZone`, y añade `cursor` y `reset`. Sin un cursor devuelve la ventana filtrada completa. Un prefijo válido sin cambios devuelve solo las filas anexas; `reset: true` reemplaza la ventana del cliente después de editar, desalojar, consultar cambios o reiniciar. Los cursores no válidos devuelven HTTP 400 con `error.code: "invalid_cursor"`. La autenticación no ha cambiado. El panel de control vuelve a las instantáneas completas de los servidores más antiguos. Esto reduce los bytes de respuesta para ventanas estables; la proyección del servidor permanece limitada por el tamaño de ventana actual.

Los valores `/api/logs` `displayMetrics.decodeTokPerSecond` exitosos llevan `timingBasis: "generation-window" | "legacy-post-visible-output"` junto con `kind`, `value` y `estimated: true`; los valores de intento identifican su propia ventana. Los resultados no disponibles mantienen su `reason` existente y sin base de tiempo. El campo se deriva solo en el tiempo de lectura: el JSONL almacenado, el `tokPerSecond` de extremo a extremo, los DTO de historial de solicitudes y el rendimiento agregado no cambian. Los DTO más antiguos pueden omitir el campo; los clientes deben tratar la base de tiempo como desconocida en ese caso. El panel de control nombra estos métodos **Ventana de generación** y **Después de la salida visible**, con **Tiempo desconocido** para una base faltante o desconocida. Los detalles de la solicitud muestran **Velocidad de salida durante la generación (est.)**, **Velocidad de salida después de la primera salida visible (est.)** o **Tasa de salida (est.; método de temporización desconocido)** y una explicación visible del método de temporización cuando hay una tasa disponible.

| Método y ruta | Finalidad | Errores notables |
| --- | --- | --- |
| `GET /api/logs` | Registros de solicitud en memoria filtrados por consulta | — |
| `GET, PUT /api/debug` | Leer indicadores de depuración; establecer, borrar o restablecer categorías de captura | 400 actualización no válida o vacía |
| `GET /api/debug/logs` | Leer entradas de registro de proveedor/debug limitadas | — |
| `GET /api/debug/usage-logs` | Leer entradas de depuración de uso limitadas | — |
| `GET /api/debug/injection-logs` | Leer las entradas de depuración de inyección de guía limitadas | — |
| `GET /api/claude/inbound-debug` | Leer el estado y las entradas de depuración entrantes Claude | — |
| `GET /api/usage` | Escanee el libro mayor de uso en agregados compactos de filas legibles, luego pliegue gradualmente los apéndices verificados; resuma por ventana personalizada preestablecida o inclusiva y superficie del cliente, con un desglose de `accounts` Codex codificado por etiquetas de registro no PII estables. | 400 límites personalizados no válidos; 500 `{ "error": "read_failed" }` si el almacenamiento no se puede leer |
| `GET /api/usage?jev=1` | El proyecto persistía las decisiones JEV y su objetivo físico envía. Opcional `comboId` selecciona un Combo; `range` acepta `7d`, `30d` o `all` (por defecto `30d`). | 400 inválido `comboId`; 500 `{ "error": "read_failed" }` si el libro mayor no se puede leer |
| `GET /api/usage/timeline` | Uso por modelo/cuenta; acepta `hours`, `bucketMinutes`, `metric`, `aggregation`, `grouping`, `models` separados por comas y filtros `hiddenProvider` repetidos | 400 consultas o límites no válidos |
| `GET /api/metrics` | Devuelve métricas de texto de Prometheus locales para solicitudes y cuota Kiro en caché. Kiro cuentas utilizan etiquetas de resumen opacas limitadas; los identificadores de cuentas y credenciales en bruto nunca se exportan. | 404 cuando `metricsExport.enabled` no era cierto al inicio; se requiere autenticación de administración ordinaria y las credenciales del plano de datos no otorgan acceso |
| `GET /api/storage` | Escanear el uso de almacenamiento Codex por cubo | Devuelve una carga útil de `error: "scan_failed"` en caso de error de escaneo |
| `POST /api/storage/cleanup/preview` | Vista previa de la limpieza de la sesión archivada y devuelve un resumen vinculante | 400 `invalid_json` o `invalid_percent` |
| `POST /api/storage/cleanup` | Cuarentena o eliminar permanentemente el conjunto archivado previamente | 400 entradas no válidas; 409 estado viciado/ocupado/referenciado; 500 sistema de archivos/error de base de datos |
| `GET /api/storage/trash` | Lista de entradas de limpieza en cuarentena | 500 `trash_list_failed` |
| `POST /api/storage/trash/restore` | Restaurar una entrada en cuarentena | 400 identificación inválida; Error 404: Faltan los archivos 409 conflicto ocupado/destino; 500 falla de restauración |
| `GET /api/storage/trash/restore/test-stream` | Gancho de corriente de restauración de solo prueba | 404 `not_available` cuando los ganchos de prueba están apagados |
| `GET, PUT /api/storage/cleanup-policy` | Leer o actualizar la política de limpieza programada y el estado del trabajo | 400 Política inválida |
| `POST /api/storage/cleanup-policy/run` | Iniciar una ejecución manual de política de limpieza | 409 `already_running`; 500 `cleanup_failed` |
| `GET /api/storage/cleanup-policy/test-stream` | Solo prueba de la política de flujo de gancho | 404 `not_found` cuando no está disponible |

Los identificadores del modelo de línea de tiempo se dividen en la primera barra, por lo que se admiten los identificadores nativos anidados, como `github-models/openai/gpt-4.1`. Las exclusiones del proveedor se aplican antes de que el exceso de series se pliegue en `other`; el objeto aditivo `appliedFilters` se hace eco de los filtros de modelo/proveedor normalizados. La cubeta final incluye el intervalo parcial actual. Los ajustes complementarios no se aplican implícitamente a las llamadas generales API.

`GET /api/metrics` devuelve `Content-Type: text/plain;version=0.0.4`. Los contadores e histogramas se reinician cuando se reinicia el proceso; `opencodex_metrics_process_start_time_seconds` identifica ese límite. Los cubos del histograma son acumulativos y terminan con `le="+Inf"`, igual a la cuenta de la familia.

| Familia métrica | Etiquetas | Descripción |
| --- | --- | --- |
| `opencodex_logical_requests_total` | `protocol`, `result` | Una observación por solicitud lógica finalizada. |
| `opencodex_physical_sends_total` | `protocol` | El flujo ascendente real envía sumas de intentos finalizados. |
| `opencodex_recoveries_total` | `protocol`, `recovery` | Diferentes tipos de recuperación observados por intento, proyectados a una clase cerrada. |
| `opencodex_request_failures_total` | `protocol`, `cause` | Solicitudes finalizadas que no entregaron respuesta, por la causa que derivó la grabadora. Solo contra; ningún histograma lleva una causa. |
| `opencodex_request_duration_seconds` | `protocol`, `result` | Histograma de duración de cubo fijo para solicitudes finalizadas. |
| `opencodex_ttft_seconds` | `protocol`, `result` | Histograma TTFT de cubo fijo para solicitudes con primera salida observada. |
| `opencodex_ttft_missing_total` | `protocol`, `result` | Conteo complementario para solicitudes sin TTFT observado. |
| `opencodex_metrics_process_start_time_seconds` | Ninguno | Límite de reinicio local del proceso. |
| `opencodex_kiro_quota_{used_credits,limit_credits,used_percent,seconds_to_reset}` | `account` (opaco `o` más seis dígitos hexadecimales; como máximo 32 cuentas reales distintas) | Lecturas de plan Kiro en caché coincidentes con identidad. Las lecturas faltantes, rancias, de fecha futura o pasadas por reajuste no emiten muestras; el raspado nunca escudriña aguas arriba. |

La etiqueta `recovery` toma una de un conjunto fijo de clases: `transient`, `connection`, `credential`, `rate_limit`, `quota`, `policy`, `ciphertext`, `payload`, `empty_completion`, `effort_downgrade`, `fast_downgrade` y `other`. El conjunto de recuperación está cerrado; Kiro Los indicadores de cuotas usan solo la etiqueta de resumen de cuenta opaca descrita anteriormente, nunca un identificador de cuenta en bruto. `fast_downgrade` registra un rechazo rápido Anthropic reparado a velocidad estándar; es distinto de la clase `effort_downgrade` de esfuerzo de razonamiento. `rate_limit`, `quota`, `policy` y `ciphertext` están separados porque la respuesta del operador difiere: esperar el límite, pasar a otra cuenta, cambiar el mensaje o dejar caer el estado cifrado obsoleto. Una mancha de razonamiento opaca rechazada cuenta como `ciphertext` en lugar de `payload`.

Si una fila escaneada excede el límite de tamaño del analizador existente, `GET /api/usage` y `GET /api/keys` mantienen los agregados de la fila legible y agregan `usageIncomplete: true` con `usageIncompleteReason: "oversized_rows"` al nivel de respuesta. Este diagnóstico sobrevive a las respuestas almacenadas en caché y añade incrementales, incluidos los resultados vacíos o no coincidentes; una reconstrucción lo vuelve a calcular. Ningún proveedor, modelo o identificador de clave API se acorta para hacer un ajuste de fila. Una bandera ausente no es prueba de que todos los registros del libro mayor fueran válidos. Esto está separado de `historyTruncated`, `entriesTruncated` y cobertura de medición de token.

La proyección JEV informa de recuentos y puertas de decisión, aplicados frente a elecciones abiertas por error, latencia/confianza de decisión, tokens de decisión informados con TypeSafe, recuentos de envío de destino físico, totales de token/caché de modelo disponibles, selecciones de esfuerzo de razonamiento y solicitudes enviadas a un objetivo que no sea la elección inicial de JEV. `attempts` se suman de cada intento persistente `sendCount`; una fila de envío cero no es una reserva. Un objeto de uso reportado se cuenta una vez incluso cuando se vuelve a intentar, por lo que el recuento de intentos medidos puede ser menor que el recuento de envíos físicos. La cardinalidad del modelo está limitada; una fila explícita de desbordamiento agrega identidades adicionales sin dejar caer los totales de resumen.

Las estadísticas JEV utilizan el mismo libro mayor de solo apéndice `usage.jsonl` y escáner cooperativo como uso ordinario. Las lecturas en frío escanean el libro mayor actual, las encuestas sin cambios no leen ningún archivo y el crecimiento verificado dobla solo el sufijo adjunto. Las solicitudes idénticas simultáneas comparten una exploración. El registro JEV persistente está cerrado y libre de contenido: ID combinado, proveedor/modelo/esfuerzo seleccionado, puerta de decisión, latencia, confianza/probabilidad opcional y uso de decisión numérica opcional. Nunca almacena mensajes, encabezados, credenciales, argumentos de herramientas o respuestas TypeSafe sin procesar. Las filas sobredimensionadas conservan el mismo diagnóstico positivo `usageIncomplete` que el punto final de uso ordinario.

Los nuevos intentos xAI en `usage.jsonl` incluyen un tiempo de solicitud `credentialSource`: `grok-oauth` para el transporte de llaves resuelto Grok CLI OAuth, o `xai-api-key` para el transporte público xAI API. Esta etiqueta fija no contiene credenciales ni identificador de cuenta. Pertenece a cada elemento en `attempts`, por lo que el total de tokens agregados de un combo no debe atribuirse a su proveedor final. Los destinos personalizados y las filas históricas omiten el campo; los consumidores no deben inferir el uso de la suscripción desde la configuración actual, el nombre del modelo o la clave entrante API. El registro informa el uso, no los montos de la factura de suscripción.

Los intentos de clave API también registran `accountLogLabel` como `k` seguido de 32 dígitos hexadecimales en minúsculas. La etiqueta es los primeros 128 bits de SHA-256 sobre
`JSON.stringify(["ocx-key-account-v1", providerName, entryId ?? null, reference])`. La referencia es el valor de clave configurado capturado para la solicitud física, antes del entorno. o resolución de llavero. Las claves RAW, las referencias y los identificadores de grupo no se escriben en el campo etiqueta. Un consumidor puede derivar la misma etiqueta de su configuración local sin resolver secretos. Cambiar una clave o referencia literal cambia la etiqueta; reemplazando el secreto detrás de una clave sin cambios. referencia mantiene la misma cuenta lógica. Los registros sin etiquetar más antiguos no se pueden atribuir de manera confiable.

La selección de claves se registra después de que las solicitudes en cola se han reconstruido para la selección actual. Cuando un reintento cambia claves, `attempts` retiene un registro separado para la clave anterior, incluyendo el uso reportado de respuestas fallidas. El uso faltante sigue sin ser reportado. Los terminales adaptadores encaminados se observan antes de que los bucles de imagen/búsqueda o las protecciones de continuación combinen su uso. Los consumidores suman los intentos planos por proveedor / cuenta y no vuelven a agregar el combo total de padres. Estos registros identifican el uso; los porcentajes de cuotas de proveedores permanecen separados de las observaciones anteriores.

`GET /api/usage` lee `~/.opencodex/usage.jsonl` desde el principio hasta la instantánea del libro mayor actual en un arranque en frío. Procesa fragmentos fijos de 1 MiB y conserva el estado agregado compacto en lugar de cada fila de solicitud normalizada. Las actualizaciones posteriores validan el límite de línea anterior y solo doblan filas completas recién añadidas. Las llamadas simultáneas comparten la misma actualización. Los predicados de rango y superficie se aplican al agregado de la fila legible, por lo que la ventana de bytes de lectura anterior y la tapa de la fila analizada no pueden omitir un prefijo de archivo anterior de los totales de 7 días, 30 días o todos los historiales. `managementUsageMaxReadBytes` sigue siendo aceptado para la compatibilidad con lectores heredados limitados, pero cambiarlo ya no expande o reduce el historial resumido por este punto final.

Pase `since` y `until` para seleccionar un intervalo personalizado inclusivo. Cada uno acepta la época Unix de enteros **milisegundos**, o una fecha ISO completa con una zona horaria explícita. Se rechazan las fechas no válidas, los valores negativos o fuera de rango, los límites invertidos y un único límite. Los límites personalizados anulan `range`; la respuesta mantiene el campo preestablecido `range` para compatibilidad y agrega `customWindow: true`, el `since` exacto y `until`. `generatedAt` sigue siendo el momento en que se produjo el informe.

Las ventanas personalizadas filtran las entradas del libro mayor individuales antes de la agregación diaria, incluidos los primeros y últimos días parciales. Conservan los filtros `surface`, `provider`, `model` y `apiKeyId` y nunca reutilizan o sobrescriben los resúmenes preestablecidos sin filtrar. El gráfico diario permanece limitado a 366 días calendario locales; los totales cubren el intervalo completo solicitado. Los campos de ventana instantánea describen el libro mayor escaneado antes del filtro de tiempo, para que puedan extenderse más allá de los límites solicitados.

La página Uso acepta entradas locales de fecha/hora. Su minuto final seleccionado incluye todo el minuto hasta `:59.999`. Elegir un ajuste preestablecido o borrar la ventana personalizada restaura el comportamiento del ajuste preestablecido. Esto agrega una selección exacta del rango y estimaciones de costos existentes; no agrega depósitos de gráficos por hora ni informes fuera de línea.

El libro mayor en entorno de ejecución es solo para anexar. Reemplazarlo o truncarlo, o cambiar los precios locales / entradas de zona horaria, desencadena una reconstrucción completa. Si edita manualmente una fila anterior en su lugar mientras el proxy se está ejecutando, reinicie el proxy (o reemplace el archivo) antes de confiar en el nuevo total; las actualizaciones incrementales verifican el límite del apéndice, no todos los bytes agregados previamente.

La respuesta todavía incluye `historyTruncated`, `truncatedPrefixBytes`, `entriesTruncated` y `entriesDropped` para que los clientes más antiguos puedan consumir la misma forma de cable. Un escaneo de libro entero exitoso reporta `false`, `0`, `false` y `0`, respectivamente. Estos son campos de compatibilidad heredados, no una señal de que el punto final lee solo una cola de tamaño configurado.

Para `GET /api/usage?range=30d&surface=codex`, `accounts` contiene una fila por cada etiqueta de grupo Codex observada. Cada fila reporta `accountLogLabel`, totales de tokens, `usageCoverageRatio` y un `estimatedCostUsd` opcional basado en el precio de visualización actualmente configurado. Las superposiciones del usuario activo `modelCosts` tienen prioridad sobre el catálogo verificado incluido y las reservas de precios, y el uso histórico se vuelve a estimar a partir del precio activo cuando se lee el resumen. Esta es una estimación API -equivalente, no un cargo por suscripción. Las nuevas solicitudes del grupo principal usan la etiqueta reservada `main`; las filas `openai` desnudas heredadas permanecen en un cubo ambiguo en lugar de reasignarse de la configuración actual.

Los precios de los modelos manuales también se pueden editar desde **Modelos → Precio**. Una insignia de precio manual sobrevive a las recargas de catálogo. Los precios se almacenan en `providers.<name>.modelCosts` y sobreviven a la sincronización del catálogo. Tasas de usuario explícitas de todo cero significan una estimación conocida de cero; **Restablecer a automático** elimina la anulación y restaura el catálogo habitual. Estos siguen siendo estimaciones de pantalla, no facturas.

`GET /api/providers/{provider}/model-costs` devuelve `{ provider, modelCosts }`, con entradas de cuatro velocidades desinfectadas y su directiva opcional `promptLengthPricing`, tecleada por el ID exacto del modelo ascendente. `PUT` en la misma ruta acepta `{ modelId, cost }`, donde `cost` contiene `{ input, output, cacheRead, cacheWrite }` y opcionalmente `promptLengthPricing`, o es `null` para reiniciar. Las cuatro tarifas deben ser números finitos de 0 a 1,000,000, en USD por tokens de 1M. Los campos desconocidos y las tasas malformadas son rechazadas. Una escritura conserva las anulaciones de otros modelos y devuelve `{ ok: true, provider, modelId, cost }`; reset devuelve `cost: null`.

El cuadro de diálogo **Precio del modelo** ofrece **Automático**, **Tarifa fija** y **Umbral personalizado** precios de duración rápida. Automático (también el valor predeterminado cuando la directiva está ausente) conserva las reglas de contexto de catálogo con las tasas base guardadas. Flat desactiva los ajustes de contexto. Custom selecciona cuatro tarifas alternativas absolutas utilizando un número entero seguro positivo `thresholdTokens` y `comparison` (`"gt"` para `>`, `"gte"` para `≥`). Todos los tokens de prompt cuentan, incluidas las lecturas y escrituras en caché; la salida no. Las tarifas seleccionadas se aplican a toda la solicitud, incluida la salida, no solo a los tokens en exceso. Custom reemplaza la regla de contexto del catálogo tanto por debajo como por encima de su umbral. Las tarifas personalizadas son tarifas de velocidad estándar: se aplica un ajuste rápido / prioritario aplicable una vez después de la selección de la tarifa y sigue la relación de prioridad del catálogo para ese modelo. Solo un modelo cuya relación de catálogo es `lower-bound` informa `priorityLowerBound: true`; un modelo sin regla de catálogo aplica cualquier multiplicador de prioridad una vez. `{ "mode": "automatic" }` se acepta en la escritura y se almacena como una política ausente, por lo que los recibos GET y PUT nunca lo contienen. **Restablecer a automático** elimina toda la anulación, incluidas las tasas base y la política. Ver el [ejemplo de configuración](../configuration/providers/#prompt-length-pricing).

```bash
ocx models price ollama/custom-model --json
ocx models set-price ollama/custom-model --input 0.50 --output 1.50
ocx models set-price ollama/custom-model --input 0 --output 0
ocx models set-price ollama/custom-model --auto
```

Omitió CLI tasas de lectura en caché/escritura en caché predeterminadas a cero. Use `--cache-read` y `--cache-write` para establecerlos explícitamente. Un nombre de proveedor sigue siendo una identidad de configuración exacta; las etiquetas de visualización de cuentas no son nombres de proveedor editables.

Las filas en `models`, `providers` y `days[].models` también llevan `cacheHitRate`: la parte de tokens de entrada servidos de la memoria caché del proveedor, sujetada a `[0, 1]`. Es `null` - nunca `0` - cuando el proveedor informó que no hay telemetría de caché o la fila no tiene tokens de entrada, porque "no hay datos de caché" y "una tasa de éxito genuina del 0%" son hechos diferentes y un gráfico que los hace similares es engañoso.

:::caution
Los puntos finales de limpieza de almacenamiento pueden mover o eliminar permanentemente los datos de sesión archivados. Siempre vista previa primero y presentar el resumen devuelto. Prefiera la cuarentena cuando sea necesaria la recuperación.
:::

Los manifiestos de recuperación de limpieza se publican atómicamente, conservando el registro completo anterior si un reemplazo falla antes de la publicación. Esto no revierte una purga permanente: la restauración aún puede fallar cuando una sesión grabada no tiene ningún archivo de implementación sobreviviente.

<a id="models-and-catalog"></a>

### Modelos y catálogo

| Método y ruta | Finalidad | Errores notables |
| --- | --- | --- |
| `GET /api/catalog` | Devuelve el documento de catálogo Codex instalado. Los clientes remotos deberían preferir el plano de datos `GET /v1/catalog`, que aún requiere una credencial de plano de datos ordinaria pero no un token de administración. | 404, catálogo no encontrado |
| `GET /api/models` | Devolver el tablero de instrumentos/ filas del modelo CLI | `catalog_busy` cuando la recolección está saturada |
| `GET /api/client-config?client=...` | Cree una configuración de cliente de solo lectura para cualquier integración de archivos compatible | 400 clientes no admitidos; 503 catálogo no disponible |
| `PUT /api/disabled-models` | Reemplazar la lista de modelos compartidos deshabilitados | 400 inválido JSON |
| `PUT /api/model-visibility` | Cambiar atómicamente la visibilidad a nivel de proveedor o modelo | 400 proveedor, alcance, objetivo o entidad no válidos; 409 `initial_model_selection_pending` (refresque la lista de modelos y vuelva a intentarlo) |
| `GET, POST /api/custom-models` | Listar modelos personalizados o agregar uno | 400 campos no válidos; Falta el proveedor 404; 409 modelo duplicado |
| `PUT, DELETE /api/custom-models/{id}` | Editar o eliminar un modelo personalizado | 400 identificación/campos no válidos; Error: 404 Artículo no encontrado 409 modelo duplicado |
| `GET, PUT /api/selected-models` | Leer listas de proveedores y disponibilidad, o reemplazar una lista de proveedores | 400 proveedores/cuerpo ausentes; 404 proveedor desconocido; PUNTO 409 `initial_model_selection_pending` |
| `GET, PUT /api/model-presets` | Leer resúmenes preestablecidos o elegir el modo preestablecido/todo/personalizado | 400 modo no válido o preajuste no compatible; 404 proveedor desconocido; PUNTO 409 `initial_model_selection_pending` |
| `PUT /api/model-settings` | Editar los ejes de capacidad de un modelo enrutado en su lugar | 400 proveedores que faltan / modelId, proveedores desconocidos o nativos / combo, campo mal formado, campo desconocido, ID de modelo no exacto o un esfuerzo predeterminado no válido para la escalera resultante; 500 cuando no se pudo guardar la configuración (la configuración en vivo no se modificó) |

`PUT /api/model-settings` toma `{ provider, modelId }` más cualquiera de `contextWindow`, `inputModalities`, `reasoningEfforts` y `defaultReasoningEffort`. Escribe los mapas por modelo a nivel de proveedor que ya lee el entorno de ejecución (`modelContextWindows`, `modelCapabilities.<modelId>.inputModalities`, `modelReasoningEfforts`, `modelDefaultReasoningEfforts`), por lo que una fila editada mantiene su procedencia de descubrimiento en lugar de ser reemplazada por un modelo personalizado. `inputModalities` acepta `text`, `image` y `audio`; `reasoningEfforts` debe ser un subconjunto de los esfuerzos que conoce el entorno de ejecución. Los campos de solicitud desconocidos se rechazan por nombre. `modelId` debe ser exacto, sin espacios en blanco circundantes, caracteres de control, longitud excesiva o un nombre de propiedad de objeto reservado. `contextWindow` debe ser `null` o un entero seguro positivo.

Cada campo es opcional, y `null` **borra** la declaración en lugar de escribir un valor predeterminado, que devuelve el hecho al registro, el catálogo y el proveedor. Una matriz `inputModalities` vacía también se borra, mientras que una matriz `reasoningEfforts` vacía se almacena como una anulación explícita de "este modelo no tiene peldaños de razonamiento". El borrado `inputModalities` también elimina la entrada `modelInputModalities` heredada exacta para ese modelo, por lo que una restauración no puede dejar una declaración anterior en vigor; las claves familiares compartidas con otros modelos permanecen. Se elimina un mapa por modelo vaciado en lugar de dejarlo como `{}`. Una solicitud que no cambia nada responde `changed: false` con el estado almacenado. El recibo también reporta `saved` (si esta solicitud publicó la configuración), `hasOverrides` (si alguno de los cuatro ejes permanece almacenado) y `catalogRefresh` (`committed`, `skipped` o `failed`). Estos campos distinguen una opción prohibida con declaraciones almacenadas de un modelo sin nada que restaurar. Una solicitud cambiada persiste atómicamente; un fallo de guardado no publicado deja la configuración viva sin cambios. Después de la publicación, el servidor elimina el resultado `/models` almacenado en caché del proveedor e informa el resultado del catálogo. Una escritura publicada seguida de un error de contabilidad devuelve `saved: true` con una actualización omitida. El conjunto hornea pistas resueltas en las filas que almacena en caché, y un golpe de caché solo puede bajar una ventana configurada, por lo que una anulación elevada o desactivada devolvería la respuesta anterior para todo el TTL. Solo los proveedores encaminados son direccionables: `openai` es el carril de paso nativo y `combo` es una fila sintética, por lo que tampoco lo es un proveedor cuyos mapas por modelo provienen de estos hechos. Mostrar nombre no es parte de esta ruta; use `PUT /api/providers/{provider}/model-display-names`.

`GET /api/models` informa el `contextWindowDeclared` almacenado exacto por separado del `contextWindow` efectivo. El editor de Modelos comienza desde la declaración y muestra la ventana efectiva como una pista heredada cuando no existe ninguna declaración. Si se desconoce un resultado de guardado, o se ha realizado el guardado correctamente, pero la lista de modelos no se ha recargado, el cuadro de diálogo deshabilita las escrituras adicionales y ofrece una recarga de solo lectura. Después de una recarga exitosa, vuelva a abrir la fila para inspeccionar los valores almacenados. Un `catalogRefresh` que falló, o se omitió con `retryable: true`, deja el guardar en su lugar y muestra una advertencia para ejecutar Sync; un salto no reintentable significa que no se administró el catálogo Codex y es un guardar limpio.

Un modelo manual reemplaza la fila del panel Modelos con el mismo proveedor e ID de modelo. Para OpenAI, la fila manual mantiene `openai/<model>` y admite los mismos controles de visibilidad que otros modelos enrutados; al eliminarlo, se restaura la fila del panel de control nativa. Las filas nativas con calificación de cuenta explícita permanecen separadas. Esto no cambia el nombre de las rutas nativas ni cambia los derechos de cuenta. Los objetivos de visibilidad no nativos OpenAI deben coincidir con un modelo manual configurado.

Las solicitudes PUT válidas a `/api/selected-models` y `/api/model-presets` devuelven HTTP 409 con el código `initial_model_selection_pending` hasta que esté disponible una lista de modelos inicial confiable. Actualizar el descubrimiento del modelo (por ejemplo, `GET /api/models`) y volver a intentarlo después de que tenga éxito.

La visibilidad/selección exitosa escribe a `/api/disabled-models`, `/api/model-visibility`, `/api/selected-models` y `/api/model-presets` para informar los resultados de seguimiento en `catalogRefresh` y `clientIntegrations` cuando se ejecuta esa ruta de actualización. HTTP 200 y `ok: true` confirman la selección guardar; no garantizan todos los catálogos de clientes actualizados. Inspeccione `clientIntegrations[]` para `ok: false`, `client`, opcional Aparte `profileId`, y el rechazo `reason`; los detalles de recuperación también pueden incluir `refusalReason`, `snapshotPath` y `residual`. La página Modelos mantiene la selección guardada y muestra una advertencia de actualización del cliente por separado. Inspeccione las integraciones y resuelva el problema notificado antes de volver a intentar `ocx sync`. Los campos de resultado que faltan de un servidor antiguo no establecen una recuperación exitosa.

<a id="oauth-accounts-provider-keys-and-data-plane-keys"></a>

### Cuentas OAuth, claves de proveedor y claves de plano de datos

OAuth filas de cuenta siempre incluyen `plan`: una etiqueta de suscripción validada o `null` cuando se desconoce. Anthropic niveles de perfil informan etiquetas como `max_20x`, `max_5x` o `pro`; Antigravity prefiere el nivel pagado (por ejemplo `g1-pro-tier`) sobre el nivel actual. Las etiquetas se leen al iniciar sesión/importar o actualizar, nunca se infieren de los porcentajes de cuota.

| Método y ruta | Finalidad | Errores notables |
| --- | --- | --- |
| `GET /api/oauth/providers` | Enumerar proveedores con flujos de inicio de sesión públicos OAuth | — |
| `GET /api/key-providers` | Lista de proveedores configurados a través de API -key login | — |
| `POST /api/oauth/login` | Inicie un inicio de sesión o flujo de adición de cuenta OAuth. `mode: "code"` inicia un inicio de sesión de visualización de código (solo Anthropic) y devuelve `mode`, `flowId`, `expiresAt` | 400 proveedor desconocido/inválido, `mode` inválido, `code_mode_unsupported`; `oauth_mutation_busy` |
| `POST /api/oauth/login/code` | Envía una URL de devolución de llamada manual o un código de autorización. Para un flujo de visualización de código (con `flowId`) devuelve el resultado de intercambio de token `{ok, account}` / `{ok:false, error}` | 400 proveedor/código no válido, `state_mismatch`, `invalid_or_expired_code`, `provider_unreachable`, `malformed_input`; 409 `no_pending_login`; `oauth_mutation_busy` |
| `POST /api/oauth/login/cancel` | Cancelar un flujo público en curso OAuth o descartar su fallo establecido; un `flowId` opcional nombra un flujo de visualización de código (se rechaza un flujo de otro proveedor) | 400 proveedor desconocido |
| `GET /api/oauth/status` | Encuestar un proveedor's OAuth flow | 400 proveedor desconocido |
| `POST /api/oauth/logout` | Eliminar la credencial de proveedor seleccionada | 400 proveedor desconocido; `oauth_mutation_busy` |
| `GET /api/oauth/accounts` | Lista de cuentas enmascaradas; Anthropic y OAuth filas de cuentas genéricas incluyen su estado `paused`. Kiro filas incluyen `autoSelectable` y un `skipReason` cerrado cuando se excluyen de la selección automática; un singleton activo todavía puede enviar. La cuota sigue siendo opt-in. | 400 proveedor no válido |
| `DELETE /api/oauth/accounts` | Eliminar una cuenta | 400 proveedor/identificador no válido; 404 falta la cuenta; `oauth_mutation_busy` |
| `PUT /api/oauth/accounts/active` | Seleccione la cuenta activa OAuth | 400 proveedor/cuenta no válido; 404 falta la cuenta; 409 cuenta pausada; `oauth_mutation_busy` |
| `PUT /api/oauth/accounts/pause` | Pausa o reanuda una cuenta Anthropic o genérica OAuth. `{ provider, accountId, paused }`; pausar la cuenta activa selecciona la siguiente cuenta utilizable cuando esté disponible. La pausa es duradera e independiente de la habilitación del grupo; la reanudación preserva la salud y las credenciales. | 400 proveedor no soportado o cuerpo inválido; 404 falta la cuenta; `oauth_mutation_busy` |
| `GET, PUT, PATCH /api/pool/settings` | Leer o actualizar la política del grupo para cualquier tipo (códice, antrópico, genérico); responde con las mismas claves para los tres y declara en `supported` que la clase honra | 400 proveedor desconocido, un campo que el tipo no admite, o un valor no válido |
| `GET, PUT, PATCH /api/oauth/accounts/pool` | Política heredada por grupo para Anthropic y proveedores genéricos OAuth; reemplazada por `/api/pool/settings` y mantenida para clientes existentes | 400 proveedor de códice o api-key, o política inválida |
| `POST /api/oauth/accounts/clear-cooldown` | Borrar una cuenta OAuth tiempo de reutilización | 400 proveedor/cuenta no válido |
| `PUT /api/oauth/accounts/alias` | Establecer o borrar un alias de cuenta OAuth | 400 proveedor/cuenta/alias no válido |
| `GET, POST, DELETE /api/providers/keys` | Enumerar las claves de proveedor enmascaradas, agregar/activar una o eliminar una | 400 entradas no válidas; Error 404 - Error 404 Categoría no encontrada |
| `PUT /api/providers/keys/active` | Seleccione la clave activa de un proveedor | 400 entradas no válidas; Error 404 - Error 404 Categoría no encontrada |
| `PUT /api/providers/keys/alias` | Establecer o borrar un alias de clave de proveedor | 400 entradas no válidas; Error 404 - Error 404 Categoría no encontrada |
| `GET, POST, PATCH, DELETE /api/keys` | Listar, crear, editar o eliminar claves de admisión de plano de datos | 400 cuerpo/identificación no válido; Error 404: Errores técnicos |

`POST /api/oauth/login/cancel` también puede descartar el intento de inicio de sesión fallido establecido seleccionado. Deja intactas las credenciales almacenadas y los resultados de inicio de sesión exitosos; el estado luego informa el flujo restante o inactivo. La cancelación de un intento en curso aún registra su resultado cancelado.

Para Anthropic, `routes` es una matriz ordenada de `{name, match, accounts, fallback?}` reglas en ambos puntos finales de configuración. Los ecos GET y de escritura incluyen `routes` (`null` cuando están ausentes); los DTO unificados exponen `routes: null` para otros tipos. Se rechaza un `routes` suministrado de otro tipo. La omisión preserva las reglas, `[]` no coincide con nada, y `null` las limpia. Los valores `accounts` se almacenan ID; los ID eliminados siguen siendo válidos en una regla, por lo que volver a agregar una cuenta puede restaurar el enrutamiento. Las respuestas de gestión conservan nombres configurados válidos; los registros de solicitudes identifican una coincidencia solo como `route:#<n>` (posición de lista basada en 1). Si una regla almacenada editada a mano no es válida, ambos ajustes GET devuelven `routes: null` y un diagnóstico `routesError` en lugar de presentar esa regla como válida; el valor almacenado permanece disponible para corrección. Reglas válidas o ausentes omiten `routesError`.

Las respuestas de la lista de credenciales se enmascaran deliberadamente. Los tokens de acceso OAuth y las claves completas del proveedor API no se devuelven a los clientes del panel de control.

<a id="protocol-paths"></a>

### Rutas de protocolo

| Método y ruta | Finalidad | Errores notables |
| --- | --- | --- |
| `GET /api/protocols` | Devuelve la versión del contrato de protocolo, qué API se sirven, la configuración del protocolo, la revisión de directiva actual y las características de la solicitud que entiende una vista previa | — |
| `GET /api/protocols?provider=<name>` | El mismo cuerpo más `provider`: `{ name, adapter, adapterSource, authMode, upstream, modelOverrides: [{ model, adapter, source }] }` — el cable que recibe el proveedor y quién lo decidió (`hard-pin`, `operator`, `registry`, `provider-default`), con hasta 64 modelos en un cable diferente (`modelOverridesTruncated: true` más allá de eso). Ninguna credencial o base URL | 400 caracteres vacíos, repetidos, más de 200 caracteres o caracteres de control; 404 ningún proveedor con ese nombre |
| `POST /api/protocols/plan` | Vista previa de la ruta que tomaría una solicitud: `{ "model": "...", "inbound": "responses" \| "chat" \| "messages", "features": [...] }` devuelve la ruta de solicitud y respuesta de cada candidato de ruta, el modo de entrega, la fidelidad, los efectos de características y las razones | 400 inválido JSON, campo desconocido, modelo de más de 200 caracteres, desconocido entrante, o más de 24 / características desconocidas |
| `PATCH /api/protocols/settings` | Cambiar la configuración del protocolo: `{ "messagesEnabled"?: boolean, "unrepresentable"?: "legacy" \| "reject", "rollout"?: { ...boolean switches } }`. Devuelve el mismo cuerpo que `GET /api/protocols`. Cierre Messages también establece `claudeCode.enabled` a `false` en el mismo salvo; al abrirlo escribe solamente `apiSurfaces.messages.enabled` | 400 inválido JSON, cuerpo vacío, campo desconocido, tipo incorrecto, o `rollout.managedMessagesNativeOAuth` sin `rollout.managedMessagesNative`; 409 configuración ocupada; 500 guardar falló (nada cambia) |

Una vista previa se calcula a partir de la configuración sola. No envía nada a ningún proveedor, no cuesta nada, no avanza la rotación combinada y no se registra. La página API en el panel muestra la misma vista previa en **Solicitar vista previa de ruta**. Un modo de entrega de `native` describe cómo se desplaza la solicitud; no es una verificación de compatibilidad.

El formulario `?provider=` respalda la sección **Protocolo del proveedor** de la configuración de un proveedor. Informa el formato opencodex enviado a ese proveedor; no abre ni cierra ningún cliente API. Para cambiar el adaptador para todo el proveedor, guarde la configuración del proveedor como de costumbre (`PATCH /api/providers`).

`PATCH /api/protocols/settings` es el único escritor aquí y respalda la palanca Messages en la página API. El CLI conduce estas rutas con `ocx api protocols`, `ocx api explain` y `ocx api policy`. Los interruptores de despliegue están por etapas y desactivados por defecto ([Rutas de protocolo](/es/guides/protocol-paths/#rollout-switches)); consulte [API superficies](/es/reference/configuration/server/#api-surfaces-apisurfaces) para ver cómo interactúa la configuración Messages con `claudeCode.enabled` a través de actualizaciones y degradaciones.

<a id="home-identity-and-the-served-by-header"></a>

### Identidad del Home y encabezado served-by

`GET /healthz` incluye `instanceId`, el identificador opaco del Home de esta instalación: `home_` seguido de 32 caracteres hexadecimales, generado al azar una sola vez por instalación. Coincide con `producer.homeId` de `GET /api/quota-pool`, se conserva entre reinicios y nunca es un nombre de equipo ni se deriva de él. Cada respuesta a `GET /v1/models` incluye ese mismo valor en el encabezado `x-opencodex-served-by`, para identificar el Home que respondió sin leer registros. Un Remote Link Child retransmite el encabezado del Home sin cambios; Codex en un cliente en modo Hub consulta directamente la respuesta del Hub. Así, el encabezado identifica el Home que sirvió la lista de modelos desde cualquier dispositivo. `GET /readyz` anuncia `served-by-header` en `features` cuando la compilación lo admite.

Justo después del primer arranque, antes de que exista el archivo de identidad, o cuando ese archivo no se pueda leer, se omiten tanto `instanceId` como el encabezado; nunca se envía un valor vacío. Borrar `quota-pool-identity.json` del directorio de OpenCodex cambia el identificador y todas las referencias de cuentas del pool de cuotas en el siguiente arranque. Un proxy en ejecución sigue informando el identificador que ya leyó.

<a id="providers"></a>

### Proveedores

| Método y ruta | Finalidad | Errores notables |
| --- | --- | --- |
| `GET /api/providers` | Listar la configuración del proveedor redactado y el estado de descubrimiento | — |
| `POST /api/providers` | Agregar o reemplazar un proveedor validado y, opcionalmente, hacerlo predeterminado | 400 destino o configuración no válido/peligroso; 409 Colisión de espacio de nombres |
| `PATCH /api/providers?name=...` | Actualizar los campos de proveedor permitidos (incluido un bloque `headers` combinado), estado habilitado/por defecto o modo de cuenta OpenAI | 400 campo no válido o transición; 404 proveedor desconocido |
| `DELETE /api/providers?name=...` | Eliminar un proveedor, reasignar el valor predeterminado cuando sea posible | 404 proveedor desconocido; 409 `last_provider`; 409 `provider_has_dependent_combos` |
| `POST /api/providers/test?name=...` | Realizar una sonda de conectividad/descubrimiento de proveedor en vivo limitada | 404 proveedor desconocido; las fallas normalmente se devuelven como evidencia `ok: false` |
| `GET /api/provider-quotas` | Leer los informes de cuotas de proveedores; `refresh=1` fuerzas refrescan | — |
| `GET /api/quota-pool` | Consultar el pool pasivo de cuotas `ocx.quota-pool/1`, con ventanas por cuenta y agrupadas y referencias opacas de cuentas. Solo usa datos en caché: nunca realiza sondeos ni actualiza las cuotas, e ignora `refresh`. Las ventanas agrupadas son una estimación ponderada por plan de las lecturas de los últimos 30 minutos de las cuentas enrutables, más una ventana `availability` cuando ninguna cuenta puede trabajar. También está disponible desde un Child de Remote Link o un cliente de Hub en `/api/machine/hub-relay/api/quota-pool` | — |
| `GET /api/quota-resets` | Listar los restablecimientos de la ventana de cuota detectados recientemente y si la detección está habilitada; `limit=<n>` limita el conteo | 400 inválido `limit` |
| `GET /api/fallback` | Consultar el estado `ocx.fallback/1`: ajustes globales efectivos, excepciones por proveedor y ruta, dispositivos con permiso de fallback local y los últimos 20 fallbacks ejecutados o rechazados. También se puede consultar desde un Remote Link Child mediante `/api/machine/hub-relay/api/fallback` (se omiten los alias de enlaces) | — |
| `PUT /api/fallback` | Establecer o eliminar ajustes: una escritura `{ scope: "global"\|"provider"\|"route"\|"device", key?, setting: "model"\|"provider"\|"localFallback", value: true\|false\|null }`, o `{ writes: [ … ] }` con hasta 8 escrituras aplicadas en una sola modificación de configuración; `localFallback` es por dispositivo; la clave de dispositivo puede ser un alias de enlace. Devuelve el estado nuevo | 400 cuerpo inválido; 404 `unknown_device` (no se escribe nada); 409 `config_unavailable` |
| `GET, PUT /api/provider-context-caps` | Leer o actualizar los límites de contexto globales, de todos los proveedores o de un solo proveedor | 400 solicitud inválida; 404 proveedor desconocido |
| `GET /api/provider-presets` | Devolver preajustes de proveedor de GUI derivados del registro en tiempo de ejecución | — |

Las respuestas de consulta de proveedores incluyen el booleano opcional `inferContextWindow` cuando está configurado. PATCH solo acepta un booleano o `null` para quitar este ajuste; omitirlo conserva el valor anterior. Un POST con el mismo nombre también conserva el ajuste omitido, incluido un `false` guardado; un booleano enviado explícitamente tiene prioridad. Consulta [Ventanas de contexto en proveedores personalizados](/es/reference/configuration/providers/#context-windows-on-custom-providers): esta opción solo se aplica a proveedores personalizados y está desactivada de forma predeterminada.

Cuando el punto final de cuota-resumen de Antigravity no tiene una respuesta utilizable, los informes de cuota también pueden incluir ventanas de uso de Cloud Code Assist por modelo cuando la respuesta de descubrimiento de modelo los proporciona. Estas mediciones son de diagnóstico; una ventana de modelo ausente no establece que el modelo no está disponible.

Con `quota=1`, una fila de cuenta de Anthropic o Antigravity cuya consulta no haya obtenido cuota incluye `quotaUnavailable: true` y, si se conoce la causa, un código fijo `quotaFailure`: `account_unavailable` (vuelve a iniciar sesión), `access_denied`, `rate_limited`, `timeout`, `transport_error`, `upstream_error` o `response_unusable` (reintenta más tarde), entre otros. El código nunca contiene texto del proveedor y un fallo de cuota nunca cambia el `health` de la fila.

La respuesta de límite de contexto del proveedor incluye `caps` (límites activos) y `values` (últimos valores seleccionados, retenidos mientras están desactivados). Habilitar un proveedor sin `value` restaura su selección, o utiliza el `contextCapValue` global en la primera habilitación. Esto también se aplica a OpenAI: el interruptor no selecciona un modo especial 922k. Una tapa activa limita cada ventana nativa; los modelos con una ventana de contexto largo compatible pueden expandirse solo hasta su propio techo compatible. La actualización del valor global con `{ "value": 600000, "setAll": true }` cambios solo permitió límites de proveedores; los proveedores deshabilitados mantienen sus selecciones recordadas cuando se habilitan más tarde. Por el contrario, `{ "setAll": true }` sin `value` permite a cada proveedor configurado el valor global actual, reemplazando sus selecciones recordadas. Desactivar una tapa no activa su valor recordado ni borra la selección.


`provider_has_dependent_combos` es una barrera de seguridad: eliminar o editar los combos dependientes antes de eliminar a su proveedor.

<a id="sidebar-and-consent-bound-actions"></a>

### Acciones de barra lateral y vinculadas al consentimiento

| Método y ruta | Finalidad | Errores notables |
| --- | --- | --- |
| `GET /api/github/star` | Leer el estado de la estrella del repositorio a través de la sesión `gh` del usuario | Códigos de resultados fijos específicos del estado |
| `POST /api/github/star` | Protagoniza el repositorio solo desde una acción humana autenticada | 403 `agent_consent_required` para personas que llaman por agentes sin evidencia de sesión en el panel de control |
| `GET /api/update/badge` | Lee la insignia del paquete almacenado en caché sin una búsqueda del registro; la caché faltante, de canal incorrecto o de 40 horas de edad devuelve `unknown: true`. `surface=desktop&session=<id>` solo lee esa sesión de aplicación de escritorio. | 400 superficie no válida; la sesión de escritorio faltante o caducada devuelve `unknown: true` |
| `POST /api/update/desktop-snapshot` | El shell de escritorio publica su estado de visualización Tauri -updater a través del cliente proxy vinculado | 403 si está presente una cabecera `Origin` o el principal no es el `admin-token` sin procesar; 400 campos no válidos; 413 sobre 1 KiB |

La instantánea del escritorio es un estado de visualización temporal, no una solicitud de instalación. El proxy almacena un máximo de 32 sesiones en memoria y expira un segundo 180 después de su último latido. Un navegador normal sin surface-desktop continúa leyendo la insignia del paquete.

El proxy comprueba la instalación de un paquete elegible después del inicio cuando falta su caché o tiene más de 20 horas, y comprueba la frescura cada hora. Configure `OCX_DISABLE_UPDATE_CHECK=1` para deshabilitar las comprobaciones automáticas. Las solicitudes explícitas de verificación y ejecución aún funcionan.

:::caution
La autenticación de administración prueba el acceso al proxy; no prueba el consentimiento para gastar el proxy. identidad del usuario. Un agente no debe recorrer `agent_consent_required`. El usuario debe elegir si se debe estrellar el repositorio.
:::

<a id="system-lifecycle"></a>

### Ciclo de vida del sistema

`POST /api/system/restart` mantiene el drenaje de 60 segundos por defecto, incluyendo solicitudes sin cuerpo o `{}`. Una persona que llama autenticada puede enviar explícitamente un cuerpo JSON tal como `{"drainGraceMs":2000}` para elegir una gracia de solicitud activa/drenaje con alcance más corta. El valor debe ser un entero de 1 a 60000 milisegundos. Los cuerpos o valores inválidos devuelven 400 antes de iniciar un drenaje; el límite de cuerpo de gestión estándar todavía se aplica. La capacidad de reinicio local de destino conserva la gracia predeterminada; la configuración de esta opción de cuerpo requiere una sesión de administración o token de administración (de lo contrario, 403). La respuesta `drainTimeoutMs` reporta la gracia aceptada. Las llamadas repetidas conservan la gracia del primer reinicio aceptado y no cambian su fecha límite.

La gracia se mide a partir de la aceptación, incluyendo el retraso de la respuesta. El organismo de control de limpieza permanece 60 segundos y la preparación para el reemplazo conserva su presupuesto separado de 70 segundos. Una gracia corta puede interrumpir un giro que ya se ha ejecutado aguas arriba. Verifique su resultado antes de volver a enviarlo; OpenCodex no agrega repetición automática de trabajo ambiguo, y un reemplazo saludable no prueba que el reenvío sea seguro. El tablero de instrumentos, CLI, la bandeja y los reinicios automáticos continúan usando el valor predeterminado de 60 segundos.

Durante un drenaje de reinicio, las nuevas solicitudes de plano de datos reciben HTTP 503 con JSON `error.type: "server_error"`, `error.code: "server_restarting"`, y el mensaje "OpenCodex se está reiniciando; reintente esta solicitud". Responses retiene `Retry-After: 5` y la política CORS del oyente receptor. Este código permite que cada versión Codex vuelva a intentar el 503 sin informar la capacidad del modelo; los errores de sobrecarga del proveedor conservan su asignación separada.

| Método y ruta | Finalidad | Errores notables |
| --- | --- | --- |
| `GET /api/system/memory` | Devuelve métricas de proceso escalar, montón, flujo, estado de respuesta, vigilancia y turno activo. Los diagnósticos del estado de respuesta incluyen el estado de desbordamiento-escritura, fallas consecutivas, clase de falla segura de privacidad fija y últimas marcas de tiempo de falla / éxito. `spillLastWriteFailureOrigin` es `retry_returned_timeout`, `timeout_memo_refusal`, o nulo; acumulativo `spillAclRetryReturnedTimeouts` y `spillAclTimeoutMemoRefusals` cuentan publicaciones fallidas; acumulativo `spillCapacityRefusals` y `spillHeadroomEvictions` cuentan continuaciones rechazadas en el techo del derrame y continuaciones desalojadas para hacer espacio para una más nueva. Véase [Windows diagnósticos de derrames](/es/troubleshooting/windows-memory/) para la semántica local de procesos. Los errores crudos y los caminos nunca son devueltos. | — |
| `POST /api/system/restart` | Iniciar un reinicio del proceso consciente de drenaje sin quitar la inyección del cliente; opcional JSON `drainGraceMs` acorta explícitamente la gracia predeterminada de 60s | Devuelve 202; las llamadas repetidas informan de la gracia existente; 400 cuerpo inválido o gracia |
| `POST /api/stop` | Detenga el servicio, restaure el Codex nativo, elimine la inyección administrada Grok y drene el proxy | 409 conflicto de propiedad del servicio; 409 `respawnable_service` cuando un contenedor Windows Task Scheduler podría reenviar el proxy y el llamante no es `ocx stop` (no se cambia nada); 409 `self_unload_service` cuando este proxy se está ejecutando como el servicio instalado launchd / systemd, porque detener el administrador desde dentro terminaría el proceso antes de que se restaure el Codex nativo - ejecute `ocx stop` en su lugar (no se cambia nada); 409 cuando el administrador instalado se niega a detenerse; 409 `service_state_unknown` cuando no se puede leer el estado del Programador de tareas (no se cambia nada; reparar la consulta y volver a intentarlo) |
| `GET /api/system/codex-app-server` | Informe si los servidores de aplicaciones Codex en ejecución son anteriores al catálogo actual del modelo | — |
| `POST /api/system/codex-restart` | Actualiza el catálogo y después reinicia los app-servers de Codex. Si Codex Desktop está abierto, intenta reiniciarlo para recargar el selector; los campos de `desktopApp` informan si se rechazó el reinicio, quedaron procesos activos o falló el relanzamiento. Aunque Desktop haya iniciado después de la fecha del catálogo, `desktopApp.pickerState: "unknown"` indica que no se puede confirmar qué enlace `model_catalog_json` cargó: una sincronización anterior pudo cambiar el enlace de un catálogo ya existente. Si Desktop no es más reciente que el catálogo, o esta solicitud cambió su enlace, el estado es `stale`. Si está cerrado, devuelve `desktopApp.reason: "no_targets"`; `pickerState` puede ser `not_running` o `stale` si esta solicitud cambió el enlace. Si el proxy se ejecuta dentro de Codex App, se rechaza el reinicio de Desktop en lugar de delegarlo. | Devuelve 200 con `code: partially_stopped` si algún proceso sigue activo. |

<a id="codex-authentication-delegation"></a>

### Delegación de autenticación Codex

`GET /api/settings` reporta el efectivo `codexAccountPickerEnabled` booleano. Un `PUT` que contiene ese booleano estricto inicializa los selectores de cuenta seguros para la privacidad al habilitar un mapa vacío, conserva las etiquetas de selector existentes al deshabilitar o volver a habilitar, persiste primero y luego solicita una convergencia de catálogo limitada solo cuando cambia la visibilidad efectiva del selector. La respuesta exitosa incluye `catalogRefreshPending`: `false` significa que la confirmación del catálogo se completó (o no se necesitó actualización), mientras que `true` significa que se guardó la configuración, pero `POST /api/sync` se debe usar para volver a intentar la actualización del catálogo. La persistencia o el fallo de asignación de selector devuelve la configuración en memoria y no ejecuta la convergencia.

El despachador de administración raíz delega cada solicitud `/api/codex-auth/*` al administrador de cuentas Codex. Sus rutas son:

| Método y ruta | Finalidad | Errores notables |
| --- | --- | --- |
| `GET, POST, DELETE /api/codex-auth/accounts` | Listar/actualizar o eliminar cuentas Codex. POST se mantiene como un punto final de compatibilidad deshabilitado; las respuestas de DELETE exitosas incluyen `catalogRefreshPending`. | POST siempre devuelve 403 `manual_import_disabled`; 400 entrada de DELETE inválida |
| `PUT /api/codex-auth/accounts/alias` | Establecer o borrar un alias de cuenta | 400 cuenta/alias inválidas |
| `PUT /api/codex-auth/accounts/pause` | Pausa o reanuda manualmente una cuenta y sus entradas principales/de grupo coincidentes existentes; devuelve `affectedAccountIds` | 400 cuenta/estado no válido; 404 Cuenta perdida 503 identidad principal ocupada o ilegible |
| `PUT /api/codex-auth/accounts/pause-exhausted` | Pausa las cuentas cuya cuota se ha agotado | Los fallos de bloqueo de mutación se convierten en 503 |
| `PUT /api/codex-auth/accounts/credits` | Permitir o dejar de gastar ChatGPT créditos después del límite de uso. Cuerpo `{ id, creditsAfterLimit }` para una cuenta, incluyendo `__main__`: true agrega el id a `creditCodexAccountIds`, false lo elimina. Cuerpo `{ all }` para el conmutador global: listas verdaderas `__main__` y cada cuenta de grupo, false borra la lista. Se aplica a la siguiente selección. | 400 ID no válido o valor no booleano; 404 falta la cuenta |
| `PUT /api/settings` con `codexQuotaAutoRefresh: { id, window, enabled }` | Habilitar o deshabilitar la activación automática de ventana de 5 horas o semanal para una cuenta | 400 id/ventana/estado no válidos; 404 Cuenta perdida 409 Ventana no disponible |
| `POST /api/codex-auth/accounts/clear-cooldown` | Borrar el tiempo de reutilización en tiempo de ejecución para una cuenta o todas las cuentas | 400 ID no válido |
| `GET, PUT /api/codex-auth/active` | Leer o seleccionar la cuenta activa | 400 cuenta inválida o faltante; 409 conflicto pausado/fila de legado o `account_selection_unavailable` |
| `PUT /api/codex-auth/auto-switch` | Establezca el umbral de cuota global con `{ threshold }`, o una anulación de cuenta con `{ id, threshold }`; `null` restaura la herencia global, y `__main__` selecciona el inicio de sesión del escritorio | 400 identificación inválida/umbral; 404 falta la cuenta |
| `GET /api/codex-auth/preserve-signed-in` | Lea la política, actual `affectedAccountIds`, `identityKnown`, `nextAccountId`, `nextUsesSignedInQuota` (próxima opción real, incluso cuando está desactivado), `pinnedAccountId`, `bindings`, `priorityFailbackEnabled` y `fallbackConsumesSignedInQuota` | 503 perfil nativo ocupado/ilegible |
| `PUT /api/codex-auth/preserve-signed-in` | Estricto `{ enabled: boolean, applyToBound?: boolean }`; explícito `applyToBound: true` requiere habilitado, libera fijaciones afectadas/pin para la próxima solicitud; informes `releasedPin` | 400 cuerpos inválidos; 503 perfil nativo ocupado/ilegible |
| `PUT, PATCH /api/codex-auth/pool-strategy` | Actualizar la estrategia de selección de grupos de cuentas Codex | 400 estrategia/configuración no válida |
| `PUT /api/codex-auth/failover` | Establecer el umbral de conmutación por error de la cuenta | 400 umbral inválido |
| `GET /api/codex-auth/quota` | Leer el estado de la cuota en caché por cuenta | — |
| `GET /api/codex-auth/low-quota-events?limit=20` | Lea solo los últimos eventos de registro/aviso y pausa-guardar de 0-100 cuotas bajas de este servidor (por defecto 20); incluye el ID de cuenta y el estado (`logged` para la alerta de solo registro predeterminada o un host sin un notificador compatible); `delivered` cuando el notificador del sistema operativo aceptado aceptó la notificación; `failed` cuando falló o se agotó el tiempo; `cancelled` cuando su episodio terminó primero; `succeeded` para una reserva de pausa completada) | 400 límite no válido; se requiere autenticación de administración |
| `GET /api/codex-auth/reset-credits` | Inspeccione la elegibilidad de reset-credit para una cuenta | 400 ID de cuenta faltante; paso de estado ascendente; Fallo de búsqueda 500 |
| `POST /api/codex-auth/reset-credits/consume` | Consume un crédito de reinicio elegible. Opcional `operationId` (UUIDv4) hace que la redención sea idempotente: el mismo id reproduce un resultado duradero en lugar de gastar un segundo crédito. | 400 identificación de cuenta faltante o inválida `operationId`; 409 `identity_mismatch` cuando el id pertenece a otra cuenta; paso de estado ascendente; 503 `server_busy`, `capacity`, o `unavailable`; 500 consumen fracaso |
| `POST /api/codex-auth/login` | Iniciar inicio de sesión o reautenticación Codex | 400 solicitudes no válidas; estados de inicio de sesión conflictivos/ocupados |
| `POST /api/codex-auth/login/code` | Envíe un código manual para un flujo de inicio de sesión Codex | 400 flujo/código no válido |
| `POST /api/codex-auth/login/cancel` | Cancele solo el inicio de sesión pendiente Codex identificado por `{ "flowId": "..." }` | 400 ID de flujo faltante, desconocido o no pendiente |
| `GET /api/codex-auth/login-status` | Sondear un flujo o estado de inicio de sesión de la cuenta. Un flujo de cuenta nueva completado incluye `catalogRefreshPending: true` solo cuando se necesita recuperación. | Informe de flujos desconocidos `expired`; no hay informes de flujo activo `idle` |

`PUT /api/codex-auth/active` requiere `{ "accountId": "<id>" }` o un `{ "accountId": null }` explícito para borrar la selección. La reselección de la cuenta actual es una selección explícita incluso si otro proceso cambió la cuenta guardada. El servidor conserva la configuración guardada no relacionada y rechaza los objetivos eliminados o pausados desde que se cargó el panel de control. Una configuración guardada no disponible o no válida deja sin cambios la selección en vivo y la afinidad anteriores; vuelve a cargar los ajustes antes de volver a intentarlo. Una respuesta exitosa describe la selección comprometida. Las reglas de cuota y conmutación por error existentes aún pueden liberar un pin; `pinDrained` reporta una razón de drenaje actualmente conocida.

Para el consumo de crédito de reposición, se suministra un `operationId` diferente mientras que la misma cuenta física tiene una operación inconclusa que se une a esa operación como un alias. Su reintento utiliza el ID de solicitud de flujo ascendente original y registra el resultado bajo esa misma identidad, por lo que las solicitudes posteriores con el ID original o un alias conocido reproducen el resultado almacenado sin otra solicitud de consumo. Una identificación nunca antes vista proporcionada después de la liquidación inicia un nuevo canje explícito; los clientes que reintententan una acción existente deben mantener su identificación.

Después de un manual confirmado `reset`, OpenCodex comprueba el uso nuevo para esa misma cuenta y puede conciliar su tiempo de reutilización derivado del reinicio compartido preexistente elegible de inmediato. Las cuentas en pausa, las cuentas que requieren reautenticación y los tiempos de reutilización que ya son propiedad de una sonda en vuelo permanecen excluidas de esta recuperación; se conservan sus tiempos de reutilización. El uso comenzó antes del restablecimiento, el uso incompleto o agotado, una cuenta cambiada y un fallo de cuota más reciente no califican. Las respuestas de uso de cuenta principal más antiguas no pueden reemplazar una observación publicada más reciente. Si el uso necesita actualización de credenciales, la recuperación requiere el linaje confirmado de esa actualización; una credencial reemplazada externamente no califica simplemente porque pertenece a la misma cuenta. Se conservan `Retry-After` explícitos, los tiempos de reutilización de reserva, los ajustes de pausa, los pines y la cuenta seleccionada. `already_redeemed` y la repetición duradera no prueban un nuevo restablecimiento y no obtienen este comportamiento de recuperación.

Una actualización de uso fallido o ocupado después de un `reset` o `already_redeemed` confirmado no convierte el consumo completado en un error: la respuesta sigue siendo HTTP 200 con su consumo `code`, omitiendo `remaining` cuando no se obtuvo un recuento fresco. Esta respuesta confirma el resultado de consumo, no que la cuenta ahora esté enrutable. Actualizar el uso para comprobar la disponibilidad; no consuma otro crédito para reintentar una actualización de uso fallido.

Si se guarda una nueva fila de configuración de cuenta pero la configuración de credenciales no puede finalizar, OAuth `login-status` informa `status: "error"` con `code: "codex_credential_persistence_failed"`, `accountId`, `needsReauth: true` y `catalogRefreshPending: true` opcional; los detalles del error de almacenamiento no están expuestos. La fila de la cuenta permanece guardada: vuelva a autenticarla o eliminarla antes de volver a intentar la creación de la cuenta.

Tiempos de espera de bloqueo de escritura de configuración o actualización de credenciales bajo esta declaración de familia delegada HTTP 503 con código `CONFIG_MUTATION_LOCK_UNAVAILABLE`. Los clientes deben volver a intentarlo en breve en lugar de tratar esa respuesta como un fracaso permanente de la cuenta.

Creación y eliminación de credenciales/configuración de confirmación de cuenta antes de la convergencia del catálogo. Un intento de catálogo fallido o diferido nunca hace retroceder la mutación de la cuenta duradera y nunca refleja los detalles internos del proveedor, la cuenta, la ruta o la credencial; los clientes reciben solo el booleano de finalización. La eliminación de una cuenta conserva su enlace selector para rutas exactas fallan cerrado mientras la cuenta está ausente y el mismo selector se restaura si se agrega esa cuenta id nuevo.

<a id="windows-compatibility-certificate-setup"></a>

## Configuración del certificado de compatibilidad Windows

`GET /api/codex/desktop-compatibility/certificate` devuelve el estado del certificado público: soporte, estado, huella digital, caducidad, aviso de renovación, observación de confianza y cualquier operación activa. La respuesta también informa `mutationAuthorized` para la sesión y entrada actuales; es una orientación de solo lectura y cada mutación comprueba de nuevo la autorización. Nunca genera una clave, descifra material privado o registra la confianza del sistema operativo. La confianza del certificado por sí sola no significa que se esté ejecutando un relé de compatibilidad o que se haya verificado la clave privada en este proceso.

POST acepta `action: "prepare" | "trust" | "remove-trust" | "renew"` y `confirmed: true`. Las acciones de confianza también requieren la mayúscula exacta SHA-256 `fingerprint` devuelta por estado. Estas mutaciones requieren una sesión GUI emparejada por el operador desde una entrada loopback confiable; tanto un token de administración como una sesión GUI loopback emitida automáticamente reciben 403. Están destinados a un flujo de confirmación local, no a la inscripción de certificados desatendida.

Prepare almacena una autoridad restringida de 30 días con una clave privada protegida por DPAPI del usuario actual Windows. Las preparaciones posteriores lo reutilizan. Las acciones de confianza nunca crean un estado faltante ni reemplazan silenciosamente una raíz caducada. La eliminación se niega mientras Codex se está ejecutando o no se puede establecer la propiedad del proceso. La cancelación o la finalización incierta del comando del sistema operativo se comprueba contra el almacén de certificados real. El estado desconocido sigue siendo un error en lugar de autorizar un reintento automático. Las respuestas no contienen PEM, claves privadas, datos de cuenta o salida de subproceso.

La renovación requiere la huella digital actual y una aplicación Codex ausente. Verifica la eliminación de la confianza del certificado anterior antes de publicar un reemplazo cifrado validado. La eliminación rechazada o incierta conserva la identidad antigua. El reemplazo está preparado pero no es de confianza; regístrelo con una confirmación separada de `trust` utilizando su nueva huella digital. Un intento obsoleto no puede reemplazar la nueva identidad de nuevo. No se conserva ninguna cadena de copia de seguridad de certificado.

Esta configuración API no habilita un relé, cambia el inicio de sesión, altera el uso, reinicia Codex o instala un vigilante. La protección de CurrentUser no aísla los secretos de otros procesos que se ejecutan como el mismo usuario del sistema operativo.

<a id="experimental-windows-compatibility-runtime"></a>

## Experimental entorno de ejecución de compatibilidad Windows

`GET /api/codex/desktop-compatibility/runtime` es una lectura de estado inerte. POST requiere una sesión GUI local emparejada por el operador y `{ action, confirmed: true }`, donde la acción es `start`, `stop`, `observe`, `launch` o `apply`. Solo `apply` requiere adicionalmente `accountWideConsent: true`. El punto final es experimental. El panel de control lo expone bajo **Codex Set → Compatibilidad con equipos de escritorio**; el conmutador **Reanudar la observación cuando se inicia OpenCodex** guarda la preferencia opcional `desktopCompatibility.startOnProxyStart`. El modo cliente administrado OpenCodex no ofrece estos controles locales ni los envía al concentrador compartido.

Abre el panel en su origen loopback configurado. Antes de cambiar la compatibilidad, ejecuta el comando del panel `ocx gui pair --origin "<dashboard-origin>"` e introduce allí su código de un solo uso. Los controles permanecen desactivados hasta verificar la nueva sesión local; emparejar no cambia por sí mismo la confianza del certificado, el estado del entorno ni la preferencia de inicio automático.

Start requiere un certificado de confianza ya preparado, un inicio de sesión basado en archivos nativos recién verificados ChatGPT y la versión evaluada Codex Windows build `26.924.2738.0`. Comienza en el modo Observar. HTTP / HTTPS y los proxys de salida SOCKS5 autenticados usan la misma selección explícita para HTTP, verificación de identidad y sockets actualizados. NO_PROXY es honrado; los fracasos nunca vuelven a intentarlo directamente. Una configuración no válida o no compatible devuelve `egress_proxy_invalid`. Start nunca registra un certificado o cambia el inicio de sesión. Launch conserva la identidad del paquete y rechaza una aplicación que ya se está ejecutando. Los puertos PAC y CONNECT persisten después de la primera vinculación exitosa y se reutilizan en el reinicio. `connection_unavailable` significa fallo de enlace; `connection_invalid` o `connection_changed` significa que la identidad de punto final almacenada no podría aceptarse. Estos fallos nunca giran silenciosamente los puertos ni sobrescriben el registro de conexión existente. Reiniciar vuelve a Observar, no a Aplicar. `native_routing_unverified` significa que el enrutamiento raíz/perfil nativo no se puede emparejar con el oyente OpenCodex vinculado a este proceso. El estado de entorno de ejecución puede exponer `contextFailure` para esta condición o `build_unverified`. Estos estados desactivan la corrección de respuesta sin reclamar una reparación de la aplicación.

Una respuesta de estado también puede llevar `buildAssessment`, los metadatos públicos de la última comprobación de compilación completada: `assessedVersion` (el paquete exacto contra el que se evaluó este entorno de ejecución), `observedVersion`, `verified` y `completedAt`. Registra una observación pasada, no una lectura de instalación en vivo: un entorno de ejecución detenido, una actualización de la aplicación o una verificación pendiente o interrumpida pueden dejarla más antigua que el paquete instalado, y solo una verificación completa la reemplaza. `observedVersion` es nulo a menos que el descubrimiento coincida con la familia de paquetes evaluados y el punto de entrada; una compilación más nueva identificada mantiene su propia versión con `verified` false, y `verified` siempre describe el paquete observado en `completedAt`, nunca lo que se instale más tarde. El campo está ausente hasta que el servicio crea su sonda durante el inicio y `null` hasta que la sonda termina una comprobación; el estado de lectura nunca inicia una.

Aplicar requiere una instantánea de agotamiento elegible observada recientemente y dura como máximo tres minutos en la capa de respuesta. Cambia dos banderas de puerta de cuenta-UI, no porcentajes de uso, créditos, restricciones de gasto o límites de servidor. La respuesta de uso no identifica el modelo seleccionado: esta prueba no puede prometer un efecto limitado a modelos externos. Una activación aceptada o una respuesta producida no prueba que la aplicación haya aceptado la nueva instantánea o habilitado su compositor. Un registro de uso original disponible o protegido devuelve el controlador a Observar e invalida las correcciones pendientes. El agotamiento posterior requiere otra solicitud de aplicación explícita. El enrutamiento raíz/proveedor/retroceso modificado invalida el contexto de observación del entorno de ejecución hasta que se detiene/inicia; revertir esa configuración no la reactiva.

Observar desactiva la corrección y actualiza solo los flujos de uso validados. Stop cierra los oyentes y las conexiones de este entorno de ejecución; el PAC incluye `DIRECT` de reserva. El certificado permanece instalado para su reutilización. Detenga el entorno de ejecución y cierre Codex antes de eliminar la confianza o renovar el certificado. Informes de limpieza fallidos `cleanup-required`; no afirma que el entorno de ejecución esté apagado. El inicio de sesión del sistema operativo, la configuración del proxy del sistema y los archivos de aplicación no se modifican con estos comandos de entorno de ejecución.

El punto final de configuración independiente devuelve `{ startOnProxyStart, revision }`. POST requiere `{ startOnProxyStart: boolean, revision, confirmed: true }` de una sesión GUI local emparejada por el operador en una entrada loopback confiable; una sesión sin emparejar recibe 403. Una revisión obsoleta rechaza la escritura; una actualización válida conserva los campos de configuración no relacionados y verifica el resultado persistente. Esta preferencia afecta el siguiente inicio proxy, nunca el estado actual en entorno de ejecución, el inicio de la aplicación o una prueba de Aplicar. Una respuesta incierta debe ser seguida por GET, no un intento automático de POST. La configuración no válida o faltante se conserva en lugar de recrearse.

<a id="choosing-a-client"></a>

## Elegir un cliente

Para la administración ordinaria, el [Panel de control web](/es/guides/web-dashboard/) ofrece el flujo de trabajo guiado más seguro. Para hosts sin cabeza y automatización, use los comandos correspondientes `ocx`: llaman a esto mismo en vivo API y devuelven un resultado distinto de cero cuando el proxy es inalcanzable o la operación falla. Direct HTTP es más útil para integraciones que necesitan los contratos de punto final exactos anteriores.

<a id="remote-sessions-and-data-key-rotation"></a>

## Sesiones remotas y rotación de datos

`POST /api/keys/rotate {id}` inicia una superposición de diez minutos y devuelve el nuevo secreto de datos una vez. `POST /api/keys/rotate/commit {id,rotationId}` lo compromete; `DELETE /api/keys/rotate {id,rotationId}` lo aborta. Todos requieren autenticación de administración; las claves de datos no pueden llamarlos. `POST /api/session/logout` requiere el `gui-session` actual, que coincida con Origin y CSRF. Un token de administración recibe 403 y nunca puede acuñar o intercambiar en una sesión de consentimiento.

<a id="anthropic-account-usage-threshold"></a>

## Umbral de uso de la cuenta Anthropic

`PUT /api/oauth/accounts/auto-switch`

Anthropic OAuth solamente; `{ provider: "anthropic", accountId, threshold }` acepta el número entero 0-100 o nulo para heredar. El umbral faltante no es válido. La anulación almacenada sobrevive al reinicio y se elimina con la cuenta.

Los DTO de la lista de cuentas incluyen `autoSwitchThresholdOverride` (entero/nulo), `autoSwitchThreshold` (por defecto del grupo) y `effectiveAutoSwitchThreshold`. 0 deshabilita solo la conmutación basada en el uso; nunca deshabilita la pausa o la recuperación 429.

HTTP: 400 inválido/no soportado; 404 Cuenta perdida `oauth_mutation_busy` en la contención de bloqueo.

<a id="forced-claude-code-subagent-model"></a>

### Modelo de subagente forzado Claude Code

La página Subagentes ofrece **Forzar un modelo para todos los subagentes**, una opción **desactivada de forma predeterminada**. Selecciona un identificador disponible en la lista, como `combo/tev-auto`, y después activa la opción. Primero se ofrece la lista de modelos; las entradas guardadas que ya no estén disponibles no se pueden usar como destino forzado.

`ocx agent subagents force combo/tev-auto` conjuntos `claudeCode.subagentModelForce`; `ocx agent subagents force -` lo aclara. `ocx agent status` informa de la configuración. `GET /api/subagent-models` devuelve `force`, `forceAvailable` y `forceStatus`; `PUT` acepta `{ "force": "combo/tev-auto" }` o `{ "force": null }` sin cambiar la lista. Omitir `force` lo deja sin cambios. Los objetivos inválidos o no expuestos son rechazados en la escritura; los objetivos obsoletos son reportados y omitidos en el lanzamiento.

Esto tiene efecto en el **siguiente inicio enrutado de `ocx claude`**, inyectando `CLAUDE_CODE_SUBAGENT_MODEL` como un alias proxy explícito (con `[1m]` solo para una ventana autorizada de un millón de tokens; los objetivos nativos Claude usan un alias nativo reversible) y `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. Cada variable no vacía exportada por el shell gana independientemente. Los lanzamientos nativos no inyectan ninguna variable; el plano `claude` no se ve afectado. No hay archivos de plugin o `settings.json` se modifican por esta configuración.

Claude Code **2.1.257 o más reciente** es necesario para la fuerza. Los argumentos de modelo de complemento y agentes incorporados (incluyendo Explorar/Planear) y por llamada se anulan. Las bifurcaciones y las habilidades de subagente con `model: inherit` mantienen el modelo de conversación principal. El bucle principal y los sidecars de pequeño-rápido no se ven afectados. Los archivos de la lista existentes permanecen disponibles.

El panel de control advierte sobre versiones antiguas o desconocidas de CLI, objetivos no disponibles y cualquiera de las variables ya presentes en `settings.json` → `env` (que anula env de lanzamiento). La detección es de solo lectura y local en el servidor: no puede inspeccionar otro shell de lanzamiento, otra máquina o la configuración local del proyecto. Un resultado desconocido no es prueba de apoyo a la fuerza.
