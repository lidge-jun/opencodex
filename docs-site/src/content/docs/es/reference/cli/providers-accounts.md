---
title: "Proveedores, cuentas y modelos de CLI"
description: "Comandos de configuración, credenciales, cuota y catálogo de proveedores."
---

Estos comandos configuran proveedores ascendentes, autentican cuentas, administran grupos de credenciales y controlan el catálogo de modelos expuesto a Codex.

Los errores de argumento sobrante de `account list`, `account current`, perfiles principales nativos y comandos de proveedor redactan valores de opciones de credenciales, incluidos `--code`, `--token`, `--api-key`, `--key`, `--secret`, `--password` y `--admin-token`, en ambos formularios `--option value` y `--option=value`. El registro de proveedores locales utiliza `ocx provider add <name> --api-key <key>`; se rechaza un `--api-key=<key>` en línea con su valor editado. `ocx provider edit` no acepta `--api-key`.

<a id="providers"></a>

## Proveedores

### `ocx provider <subcommand>`

Gestión de proveedores no interactivos. Las entradas del registro se siembran por nombre; un nombre personalizado requiere tanto `--adapter` como `--base-url`.

| Subcomando | Banderas soportadas | Medidas adoptadas |
| --- | --- | --- |
| `list` | `--json`, `--jsonl` | Listar los proveedores configurados y las entradas de registro restantes; `--jsonl` emite un objeto de proveedor configurado por línea. |
| `add <name>` | `--adapter <adapter>`, `--base-url <url>`, `--api-key <key>`, `--responses-path <path>`, `--auth-mode <key\|forward\|oauth\|local>`, `--default-model <model>`, `--set-default`, `--force`, `--json`, `--sync`, `--live` | Guardar localmente de forma predeterminada; `--sync` intenta la sincronización del cliente en cualquier modo de salida. `--live` escribe a través del proxy en ejecución y no puede combinar con `--sync`. `--force` permite la sobreescritura. |
| `edit <name>` | banderas de campo de proveedor, `--headers <json>`, `--model-context-tier <model=default\|long_context>`, `--upstream-http-version <http1.1\|->`, `--fast <on\|off>`, `--context-window <N\|->`, `--json` | Edite los campos de proveedores activos validados sin reemplazar los grupos de claves. Repita `--model-context-tier` para varios modelos de Copiloto. `--headers` fusiona encabezados de solicitud personalizados; pase `{}` o `-` para borrarlos. |
| `test <name>` | `--model <id>`, `--yes`, `--json` | Verifique el descubrimiento; con `--model`, solicite una prueba de finalización confirmada. |
| `show <name>` | `--json` | Mostrar la configuración con las claves API enmascaradas. |
| `remove <name>` | `--json`, `--live`, `--yes` | La eliminación local rechaza el proveedor predeterminado y el último. La eliminación en vivo requiere `--yes` y utiliza comprobaciones de dependencia del servidor, reasignación predeterminada y limpieza de cuenta / modelo personalizado. |
| `set-default <name>` | `--json`, `--live` | Seleccione un valor predeterminado local o actualice el proxy en ejecución con `--live`. |
| `pacing <name>` | `--json`, `--enabled <on\|off>`, `--rpm <number>`, `--min-interval-ms <integer>`, `--max-concurrent <integer>`, `--file <FILE\|->` | Lea las reglas configuradas y el estado en tiempo de ejecución; actualice escalares o reemplace las reglas de un archivo. Las banderas de archivo y escalar son exclusivas. |
| `snapshot` | `--json` | Lee del proxy en ejecución un documento público del editor de proveedores, con los datos sensibles ocultos y validado. |
| `apply` | `--baseline <FILE\|->`, `--file <FILE\|->`, `--yes`, `--json` | Aplique un documento editor revisado con una comparación de línea de base; las eliminaciones / cambios de nombre requieren `--yes`. |
| `selected <name>` | `--set <ids>`, `--clear`, `--json` | Lea o actualice la lista de permisos del modelo de proveedor. |
| `quota` | `--refresh`, `--json` | Lea los informes de cuotas de proveedores. |
| `resets` | `--limit <n>`, `--json` | Listar los restablecimientos de ventana de cuota detectados recientemente. |
| `presets` | `--json` | Listar los ajustes preestablecidos del proveedor del panel de control. |
| `account-mode` | `pool`, `direct`, `--json` | Seleccione el enrutamiento de cuenta agrupado o directo Codex. |
| `import-cc-switch` | `--source <FILE>`, `--provider <id>`, `--apply`, `--restore`, `--allow-private-network`, `--json` | Previsualiza, aplica de forma selectiva o revierte entradas de proveedor sin claves desde una base de datos SQLite de CC-Switch (`cc-switch.db`) o un archivo JSON antiguo. |

```bash
ocx provider list --json
ocx provider list --jsonl        # one configured provider object per line
ocx provider test ark
ocx provider add anthropic --set-default --sync
ocx provider add local-dev --adapter openai-chat --base-url http://localhost:11434/v1
ocx provider show anthropic --json
ocx provider edit github-copilot --model-context-tier gpt-5.6-luna=long_context
ocx models --provider anthropic --json
ocx models live --provider ark --json
```

`--jsonl` escribe solo proveedores configurados, un objeto JSON por línea, y omite el resumen `registryCount` de `--json`. Cada objeto tiene los mismos campos que un elemento en la matriz `configured`. Utilícelo para scripts que procesan un objeto de proveedor configurado por línea. `--json` y `--jsonl` no se pueden combinar.

Cada fila configurada también incluye `active`. Es `false` cuando este dispositivo está enlazado con un Home (como Remote Link Child o cliente en modo Hub): la fila describe configuración local que queda sustituida por los proveedores del Home y no atiende solicitudes mientras el enlace esté conectado. Es `true` cuando la fila sí atiende solicitudes, incluso si no se puede leer el estado del enlace. Las filas nunca contienen credenciales: `baseUrl` elimina las credenciales incluidas en la autoridad de la URL y oculta valores de consulta con nombres de credenciales, como `key` o `token`, conservando parámetros normales como `api-version`.

:::caution[Los encabezados personalizados no son un canal para credenciales]
`--headers` es para los metadatos de solicitud no secreta — sugerencias de enrutamiento, inquilino o selectores de proyectos, identificaciones de rastreo. Es **no** un lugar para poner autenticación material, y el validador rechaza los nombres de encabezado de credenciales estándar (`Authorization`, `X-Api-Key`, `Cookie`, y el resto) con un puntero a
`apiKey` / `authMode`.

El validador no puede reconocer un nombre arbitrario como `X-My-Token`, por lo que el límite es suyo para respetar. Dos razones por las que importa:

- El JSON es un argumento de línea de comandos, por lo que un secreto en él aterriza en la historia de la shell y en la lista de procesos, donde cualquier otro proceso en la máquina puede leerlo antes de que el CLI redacte algo.
- Los valores de encabezado se mantienen en `config.json` en texto claro, a diferencia de las claves API, que tienen su propio camino de almacenamiento y enmascaramiento.

Utilice el inicio de sesión de credenciales compatible o el flujo stdin para la entrada secreta. No coloque claves en una transcripción de agente o copiarlas en ejemplos de comandos.
:::

<a id="local-saves-and-live-provider-state"></a>

### Estado de los locales guardados y del proveedor en vivo

Comience con el descubrimiento fuera de línea: `ocx provider --help`, luego `--help` de la hoja. `list` y `show` leen la configuración local; `add`, `remove` y `set-default` también usan configuración local a menos que se indique `--live`. Otras operaciones de administración de proveedores a continuación requieren un proxy en ejecución. Compruebe `ocx ready --json` y `ocx status --json` antes del trabajo en vivo para confirmar el objetivo y la versión previstos. Una lista local no establece que el proxy adoptó un cambio guardado.

Local `provider add <name> --json` informa `needsSync: true`. Añadir `--sync` realmente intenta la sincronización tanto en JSON como en los modos de salida humanos. Su recibo añade `sync: {status, ok}`; solo `status: "applied"` con `ok: true` despeja `needsSync`. Sin proxy (`not-running`), una sincronización rechazada o fallida devuelve un valor distinto de cero al tiempo que conserva el guardado local. Los resultados omitidos por políticas o solo por catálogo pueden salir con 0 con `needsSync: true`; no son una sincronización de cliente aplicada. La propiedad del catálogo o los rechazos de seguridad de la configuración guardada dejan el catálogo sin cambios, hacen que el comando salga con 1 y muestran la guía de recuperación en la salida humana o `sync.warning` en JSON, incluso si la inyección de configuración tuvo éxito.

Para cambios en vivo autorizados:

```bash
ocx provider snapshot --json
ocx provider add anthropic --live --json
ocx provider set-default anthropic --live --json
ocx provider snapshot --json
```

Live add utiliza los ajustes preestablecidos del objetivo y rechaza un proveedor existente observado sin `--force`. El upsert de comprobación y servidor no son atómicos: los cambios simultáneos pueden acelerarse. Los proveedores personalizados todavía necesitan `--adapter` y `--base-url`. `--live` nunca vuelve a caer en un salvamento local; combinarlo con `--sync` no es válido. Las credenciales pertenecen al login humano soportado o al flujo stdin, no a CLI ejemplos.

Para eliminar un proveedor autorizado, utilice `ocx provider remove <name> --live --yes --json`. El servidor comprueba las dependencias y aplica la reasignación predeterminada y la limpieza de la cuenta/modelo personalizado. Inspeccione el recibo y lea de nuevo el destino después de escribir.

Un recibo en vivo puede ser `{"success":true,"name":"example","catalogRefresh":{"status":"committed","changed":true,"degraded":false,"notices":[]}}`. `success` significa que la configuración persistió; no prueba por sí misma la convergencia del catálogo. Por ejemplo, `{"success":true,"name":"example","catalogRefresh":{"status":"skipped","reason":"busy","retryable":true}}` sale con 1 aunque el guardado haya tenido éxito. Una actualización fallida o los saltos por `stale`, `refused` y `catalog-unavailable` también devuelven un valor distinto de cero. Conserve los avisos degradados. Una actualización nula, ausente o `not-requested` puede salir con 0 sin una sincronización de cliente. Lea el estado antes de recuperarse; no repita una escritura persistida para reparar la convergencia. Los errores usan prosa segura en stderr, incluso en el modo JSON, en lugar de un sobre de error JSON.

`provider test <name>` sin `--model` comprueba la conectividad del descubrimiento de modelos aguas arriba. Una conexión fallida sale con 1; el éxito y un catálogo estático sin un punto final de descubrimiento aplicable salen con 0. `applicable: false` es un resultado esperado de catálogo estático, no una inferencia exitosa ni una conexión fallida.

Para enviar una solicitud de finalización para un modelo elegido, utilice:

```bash
ocx provider test my-relay --model my-model
ocx provider test my-relay --model my-model --yes --json
```

Esta prueba puede incurrir en cargos del proveedor. Un terminal interactivo pide confirmación; `--yes` acepta la advertencia de cargo. El uso no interactivo y `--json` requieren `--yes`. Usar `--yes` sin `--model` es un error de uso. Rechazar la confirmación no envía ninguna solicitud y sale con 1. El comando usa la API de gestión del proxy en ejecución.

La prueba de finalización envía el mensaje fijo `Reply exactly OK.`, solicita un límite de salida de 32 tokens, se detiene después de 20 segundos o 64 KiB y nunca reintenta ni hace conmutación por error. Es compatible con proveedores de OpenAI Chat y Responses con autenticación por clave o locales, incluidas las anulaciones de cable por modelo. Las configuraciones deshabilitadas, de OAuth, de autenticación reenviada y de adaptador o transporte no soportados devuelven una razón de aplicabilidad sin enviar una finalización. Los perfiles TLS, las fijaciones de versión HTTP, la limitación de ritmo de solicitudes habilitada y los ejecutores personalizados con una anulación de proxy de proveedor no son compatibles actualmente.

Los resultados incluyen el tiempo hasta el primer delta de texto (TTFT), la latencia total, los identificadores de modelo solicitados y de cable, los metadatos saneados del modelo ascendente y una comparación distinta de coincidencia, discrepancia o desconocido. Los metadatos ausentes o conflictivos son desconocidos. La comparación usa el id ascendente antes del enmascaramiento, frente al id realmente enviado tras el manejo de alias y sufijos. Los metadatos informados por el proveedor no pueden verificar la identidad del modelo: `identityVerified` es siempre `false`. No se devuelve el texto generado. Una finalización fallida sale con 1; el éxito y un resultado no aplicable salen con 0.

<a id="transport-settings-and-request-pacing"></a>

### Configuración de transporte y ritmo de solicitud

`provider edit` ya está en vivo. Utilice `--upstream-http-version http1.1` para fijar ese protocolo, o `--upstream-http-version -` para borrarlo. `--fast on|off` alterna rápidamente; `--context-window N` establece una anulación de proveedor positiva y `--context-window -` la borra. Los ajustes omitidos permanecen sin cambios; cero no es una operación clara.

```bash
ocx provider pacing anthropic --json
ocx provider pacing anthropic --enabled on --rpm 30 --min-interval-ms 1000 --max-concurrent 2 --json
ocx provider pacing anthropic --json
```

La lectura devuelve `{provider, rules, status}`. `rules: null` significa no configurado; `status` contiene observaciones separadas de cola/temporización en entorno de ejecución. Los indicadores numéricos solos no habilitan un bloque no configurado; `--enabled off` desactiva el ritmo. RPM acepta valores fraccionarios positivos validados. Intervalo/concurrencia requieren enteros positivos.

Las ediciones escalares preservan las reglas del modelo observadas, pero PATCH reemplaza todo el bloque sin CAS, por lo que se puede sobrescribir una edición concurrente. Utilice la instantánea/aplicar debajo cuando se requiera una comparación de línea base. Para un objeto de reglas completas, incluyendo reglas específicas del modelo, use `ocx provider pacing anthropic --file pacing.json --json`. Un archivo de reglas mínimas es `{"enabled":true,"requestsPerMinute":30}`. El modo archivo reemplaza todo el bloque y no se puede combinar con banderas escalares. `--file -` lee stdin canalizado; se aplican los límites de entrada a continuación.

<a id="snapshot-edit-and-apply-with-a-baseline"></a>

### Instantánea, editar y aplicar con una línea de base

Mantenga el mismo host previsto y el contexto CLI en estos pasos. La fijación de objetivos dura dentro de una invocación; las instantáneas no contienen ningún token de identidad de destino.

```bash
ocx provider snapshot --json > providers.baseline.json
cp providers.baseline.json providers.next.json
```

Edite el siguiente archivo y revise la diferencia mientras conserva la línea base original. Cada documento contiene exactamente `{defaultProvider, providers}`. Snapshot es una proyección de editor de solo lectura, no una exportación de configuración sin procesar. No agregue campos secretos, derivados o desconocidos: las credenciales, cualquier campo `headers` y los marcadores de visualización (`hasApiKey`, `hasHeaders`, `xaiResponsesOptInState`, `initialModelSelection`) no son editables por lotes. La exportación de configuración sin procesar puede exponer credenciales y pertenece a un terminal operado por humanos fuera de una sesión de agente.

```bash
ocx provider apply --baseline providers.baseline.json --file providers.next.json --json
ocx provider snapshot --json
```

Agregue `--yes` solo para eliminaciones o cambios de nombre revisados y autorizados. Batch PUT conserva los valores privados intactos y utiliza la línea de base pública para detectar conflictos. No realiza la limpieza de cuentas OAuth que ejecuta DELETE al eliminar un proveedor individual. HTTP 409 devuelve el código de salida 5: tome una nueva instantánea, revise los cambios simultáneos y reconstruya la edición propuesta. No reemplace la línea base ni vuelva a intentarlo automáticamente. Los resultados de escritura desconocidos requieren inspección, no una suposición de retroceso.

Use archivos UTF-8 JSON regulares o explícitos canalizados `-`; como máximo una entrada por lotes puede ser stdin. Cada entrada tiene un límite de 4 MiB y una fecha límite de lectura de 30 segundos. La solicitud serializada combinada `{baseline,next}` también debe ajustarse a 4 MiB. Interactivo stdin, archivos especiales, banderas conflictivas, campos no válidos y eliminaciones no confirmadas son rechazadas antes de la mutación con código de salida 2. Los errores de entrada nunca se hacen eco de los valores enviados.

<a id="keyless-cc-switch-provider-import"></a>

### Importar proveedores de CC-Switch sin claves

```bash
ocx provider import-cc-switch --source ~/.cc-switch/cc-switch.db
ocx stop
ocx provider import-cc-switch --source ~/.cc-switch/cc-switch.db --provider my-provider --apply
# Start the proxy in another terminal (or run ocx ensure), then add credentials:
ocx start
printf '%s\n' "$API_KEY" | ocx account add-key my-provider

# Separate rollback path (stop the proxy first; removes unedited keyless entries only):
ocx stop
ocx provider import-cc-switch --restore
```

`ocx provider import-cc-switch` solo extrae una lista explícita de metadatos no secretos: identificadores de proveedor, tipos de aplicación, URL base, protocolos y modelos predeterminados. La fuente debe ser una base SQLite regular de CC-Switch o un archivo JSON antiguo. Los bytes de la fuente y de las configuraciones incluidas se leen temporalmente para inspeccionarlos; los campos secretos, nombres libres y comentarios TOML se omiten a nivel de bytes, sin convertirlos en cadenas, escribirlos ni registrarlos. Los búferes temporales se ponen a cero en `finally`.

Como protección adicional, la URL base debe tener la forma `http(s)://host[:port]` con una ruta vacía o de 1 a 4 segmentos de API en minúsculas `[a-z0-9._-]`, como `/v1`, `/api/v1` o `/compatible-mode/v1`. También se valida la sintaxis de los identificadores y modelos; los valores no conformes se rechazan sin mostrarlos. La fuente se abre una vez y se verifica mediante el descriptor con `O_NOFOLLOW | O_NONBLOCK`. SQLite se deserializa solo para lectura en memoria, sin archivos temporales. Se rechazan bases con varios enlaces duros (`nlink > 1`), para que una ruta alternativa no evite las comprobaciones de archivos auxiliares. Si un archivo hermano `-wal` o `-journal` contiene datos, se pide cerrar CC-Switch o consolidar la base y volver a intentarlo. Usa solo una fuente local de confianza y verifica cada identificador, modelo y `baseUrl` mostrado antes de añadir credenciales.

- **Previsualizar (predeterminado):** requiere `--source <FILE>`, no escribe nada e informa de las entradas descubiertas, elegibles, conflictivas y no válidas.
- **Aplicar (`--apply`):** requiere `--source <FILE>` y el proxy detenido (`ocx stop`); se rechaza en un Child de Remote Link. Repite `--provider <id>` para elegir entradas concretas o añade `--allow-private-network` para permitir destinos de loopback o red privada. Aunque no hayas previsualizado, muestra cada identificador, modelo predeterminado y destino antes de guardar entradas sin claves y registrar `$OPENCODEX_HOME/cc-switch-provider-import-journal.json`. Los muestra por `stdout` en modo texto y por `stderr` con `--json`. Se rechaza otra aplicación mientras exista un diario activo. Verifica los destinos, inicia el proxy (`ocx start` en otra terminal u `ocx ensure`) y añade las credenciales con `printf '%s\n' "$API_KEY" | ocx account add-key <provider>` por stdin canalizado o con `ocx login <provider>`.
- **Restaurar (`--restore`):** es una ruta de reversión separada. Requiere el proxy detenido (`ocx stop`), se rechaza en un Child de Remote Link y no admite `--source`, `--provider` ni `--allow-private-network`. Inspecciona `auth.json` solo para lectura a nivel de bytes y rechaza la operación si es ilegible o no válido. Solo elimina proveedores del diario activo que aún coincidan con el estado importado sin claves y que no sean `defaultProvider` ni estén referenciados por enrutamiento, combos, fallback, cuentas OAuth o claves API.

<a id="authentication"></a>

## Autenticación

<a id="diagnosing-missing-main-account-quota"></a>

### Diagnosticar la cuota de cuenta principal faltante

`ocx account list openai --quota --refresh --json` incluye un objeto `quotaRefresh` en la fila de la cuenta principal cuando esa operación intenta una lectura de uso WHAM. La respuesta existente `GET /api/codex-auth/accounts?refresh=1` expone el mismo diagnóstico.

Su `status` es `ok`, `not_reported` (no hay cuota parseable en una respuesta exitosa), `http_error`, `timeout`, `network_error`, `invalid_response`, o `internal_error`. Solo `http_error` incluye un `httpStatus` numérico. Este objeto no incluye ninguna respuesta sin procesar, mensaje de error, credencial o identificador de cuenta. Las lecturas de solo caché, los aplazamientos de credenciales y las instantáneas de cuenta invalidadas lo omiten; los servidores más antiguos también lo omiten. La ausencia no es prueba de éxito. Un estado de no éxito HTTP permanece `http_error` incluso si su cuerpo de error no se puede leer; `timeout` y `network_error` describen fallos antes de cabeceras o mientras se lee una respuesta exitosa.

Un inicio de sesión válido no garantiza que esta solicitud de uso por separado tenga éxito. Estas categorías no cambian las reglas de autenticación, selección de cuenta o actualización de cuota, y no convierten cuota desconocida en uso cero. Este diagnóstico actualmente cubre la cuenta principal nativa, no las actualizaciones de la cuenta de grupo. Al informar sobre la cuota faltante, comparta la categoría y el estado HTTP en lugar de archivos de credenciales o una captura de red en bruto.

### `ocx login <provider>`

Inicie el flujo de acceso registrado del proveedor. Los proveedores de cuentas estilo OAuth abren un navegador y almacenan las credenciales bajo `~/.opencodex/` (los tokens renovables rotan automáticamente; las concesiones de claves duraderas como OrcaRouter se reutilizan hasta que el proveedor las revoca); los proveedores de inicio de sesión con clave API abren su panel de control de claves, solicitan la clave, la validan cuando es posible y guardan la configuración del proveedor resultante. El comando imprime los identificadores de proveedor OAuth y de clave API actualmente aceptados cuando el nombre falta o es desconocido.

Los inicios de sesión fallidos OAuth salen con el estado 1 e imprimen un diagnóstico fijo: el estado HTTP y el código de error estándar OAuth (como `invalid_grant` ) cuando el proveedor devuelve uno, `network_error` o `timeout` cuando no se pudo llegar al proveedor, `configuration_error` con el motivo de que una configuración local como un espacio de nombres de cuenta Codex bloquea el inicio de sesión y `oauth_authentication_failed` de lo contrario. Pool 2 ( `anthropic2`) también informa `configuration_error` antes de solicitar cuando un proveedor personalizado posee ese nombre o su archivo de configuración no se puede leer o analizar.

Utilice el mismo comando para **reautenticar** después de que `ocx status` / `ocx doctor` informe de que se requiere reautenticación o de un fallo definitivo de renovación (o utilice Reauthenticate en el panel de control). Las cuentas del grupo Codex no son uno de esos proveedores OAuth o de clave API, pero `ocx login codex` llega a ellas de todos modos: se dirige al inicio de sesión del grupo de cuentas, por lo que `ocx login codex --reauth` es lo mismo que `ocx account reauth codex`. El grupo de cuentas Codex del panel (Reauthenticate) también lo hace. Esa ruta se ejecuta dentro del proxy, por lo que necesita uno en ejecución.

Para el proveedor OAuth de ChatGPT, un código OAuth terminal explícito que confirma una concesión de actualización caducada o revocada exige iniciar sesión de nuevo. Las descripciones de texto libre por sí solas nunca requieren una nueva autenticación. Los fallos temporales del servicio de tokens, los tiempos de espera y la cancelación dejan la cuenta elegible para una actualización posterior. El intercambio de tokens del navegador y la actualización tienen cada uno un plazo de 30 segundos por búsqueda que cubre los encabezados y el cuerpo. Los errores derivados de HTTP muestran solo el estado y un código OAuth permitido. La cancelación, el tiempo de espera y los fallos de transporte utilizan mensajes fijos sin el motivo o la causa originales.

```bash
ocx login xai
ocx login anthropic
ocx login orcarouter-oauth # browser consent + S256 PKCE
ocx login orcarouter       # paste an existing API key
ocx login anthropic --headless # no browser, no local port
```

`--headless` ejecuta el inicio de sesión **code-display** para hosts cuyo navegador no puede llegar a la devolución de llamada de loopback del proxy (contenedores o servidores remotos). El comando muestra una URL de autorización; apruébala en cualquier navegador y pega la cadena `code#state` que muestra el proveedor. No se abre un puerto de devolución de llamada ni se inicia un navegador. Lo admiten `anthropic` y `anthropic2`. Como `xai` no tiene página de código, `--headless` inicia su autorización de dispositivo: muestra una URL y un código corto que confirmas en cualquier navegador y termina sin pegar nada. Cualquier otro proveedor termina mostrando la lista de proveedores compatibles. Para cuentas Codex usa `ocx account login codex --device`; `ocx login codex --headless` se rechaza. En el flujo code-display hay 10 minutos para pegar un único código; si falla el intercambio, inicia otra sesión. Un inicio correcto activa la cuenta del proveedor, igual que con el navegador.

La reautenticación OAuth conserva la configuración del operador, como selecciones de modelo, anulaciones de precios, y preferencias de conmutación por error de cuenta. Campos de transporte/autenticación de inicio de sesión y de registro Se actualizan los metadatos del catálogo. Un proveedor de live-discovery mantiene su modelo predeterminado seleccionado; un El proveedor estático puede reemplazar un valor predeterminado que ya no existe en su catálogo actualizado.

Para Antigravity, un `401` ascendente puede actualizar la credencial OAuth de la cuenta rechazada y volver a intentar la solicitud una vez. El reintento utiliza el proyecto Cloud Code Assist de esa credencial. Si la actualización falla o no hay ningún proyecto utilizable disponible, la solicitud devuelve un error de autenticación; use el flujo de reautenticación anterior. Un segundo `401` no inicia otro ciclo de refresco/reintentar. Un `403` que solicita verificar la cuenta pone en cuarentena esa credencial como `needs-reauth(verify)`; cuando la conmutación por error de la cuenta está habilitada, la solicitud puede volver a intentar en otra cuenta elegible. Complete la verificación de la cuenta de Google, luego ejecute `ocx login google-antigravity`. La actualización silenciosa del token no borra este requisito de verificación. Si OpenCodex no puede guardar la cuarentena, este intercambio de adaptador conserva el `403` original sin otro envío de recuperación; la cuenta no se ha puesto en cuarentena de forma duradera. Si no se puede construir o admitir una solicitud de hermano para el envío, el intercambio entrega el `403` original a través del formato de error normal. Un combo adjunto o una ruta de directiva aún pueden aplicar sus reglas de reserva existentes.

Para las solicitudes de búsqueda web basadas en la búsqueda, la rotación automática de hermanos solo acepta un sobre de error Google completo y limitado que contiene `error.details[].reason === "VALIDATION_REQUIRED"`. La redacción de verificación por sí sola no rota. Esta recuperación con alcance de solicitud utiliza el token y el proyecto del hermano sin que persista una marca de `needs-reauth`; la cancelación, la salida comprometida, el agotamiento del presupuesto o un hermano no disponible conserva el error.

Un proxy que ya se está ejecutando recoge la nueva credencial sin un reinicio: el CLI le pide que vuelva a cargar ese proveedor desde el disco, y la solicitud no tiene credenciales propias. Si el proxy en ejecución no puede aceptar esa solicitud, la mayoría de las veces porque comenzó a partir de una compilación anterior a la recarga certificada, el inicio de sesión aún tiene éxito y la credencial todavía se escribe en el disco, pero el proceso en vivo sigue sirviendo al anterior. El CLI lo dice y te pide que reinicies:

```
⚠️  A proxy is running but could not reload this provider (unattested-target).
   The credential is saved to disk; the running proxy keeps using the previous one.
   Restart it to pick this up: ocx restart
```

### `ocx logout <provider>`

Quite la credencial OAuth almacenada localmente de forma predeterminada. `--json` informa de `{schemaVersion:1, ok, provider, removed}`; las credenciales ausentes devuelven `reason: "not_found"` y salen con 4, mientras que una eliminación sale con 0.

Para un cierre de sesión solicitado en el proxy en ejecución, `ocx logout <provider> --live --json` acepta proveedores OAuth públicos y devuelve `{schemaVersion:1, success:true, provider, live:true}`. No cierra la sesión de Codex/native-main ni elimina una cuenta seleccionada. Nunca elimina las credenciales locales antes de la solicitud en vivo ni recurre a la eliminación local tras un fallo.

<a id="accounts-and-key-pools"></a>

## Cuentas y grupos de claves

<a id="pool-policy-account-thresholds-and-paid-credit-intent"></a>

### Política Pool, umbrales de cuenta e intención de crédito pagado

Lee la ayuda sin conexión y, a continuación, la política del objetivo seleccionado antes de cambiarla:

```bash
ocx account pool --help
ocx account pool openai --json
ocx account pool anthropic --json
```

Estas son las lecturas de gestión en vivo. La respuesta incluye `provider`, `kind`, `supported`, la política almacenada nullable, `enabledEffective` y opcional `inert`. Sólo los campos nombrados por `supported` se pueden escribir; nulo no es falso, y una política inerte no es agrupación activa. Los umbrales cero y `enabled:false` son independientes. Utilice `--enabled on|off`, `--threshold 0..100`, `--strategy`, `--sticky 1..100` y `--quota-window` solo donde sea compatible. OpenAI no admite escrituras de agrupación/ventana habilitadas; `reset-first` es para OpenAI y grupos OAuth genéricos (nunca Anthropic), `least-loaded` solo para Kiro, y las ventanas de Anthropic son `five-hour`, `weekly`, `max-utilization`. Los campos omitidos permanecen sin cambios. Los campos de lectura DTO como rutas, concurrencia por cuenta o Anthropic `nativeMessages` no implican un setter en este comando; use solo las opciones CLI enumeradas. Un guardado que devuelve `warning: "config_bookkeeping_failed"` se persistió, pero necesita una lectura nueva para confirmar el estado en vivo.

```bash
ocx account pool anthropic --threshold 80 --quota-window five-hour --json
ocx account pool anthropic --json
ocx account auto-switch openai status --account <id-or-alias-or-main> --json
```

Un `--account` explícito selecciona el umbral OpenAI por cuenta. Las acciones son `status`, `on` (80), `off` (0), `inherit` (nulo), o `threshold N` (0-100). Sin `--account`, el comando de conmutación automática existente permanece en el grupo. El resultado es `{ok, id, autoSwitchThresholdOverride, autoSwitchThreshold}`; lea la anulación anulable y el valor efectivo observado por separado.

El uso de crédito pagado después de la cuota incluida es una política distinta que requiere una intención de gasto explícita. `ocx account credits openai <id-or-alias-or-main> on|off --json` apunta a una cuenta. `ocx account credits openai --all on|off --json` es exclusivo con ese selector: en los registros de ID seleccionables actuales más principal, se borra la lista. Los recibos son `{ok, id, creditsAfterLimit}` o `{ok, all, ids}`; conservar los ID devueltos reales y leer de nuevo `ocx account list openai --json`. Mostrar saldos de crédito con `--show-codex-credits` no habilita esta póliza. No permita que los créditos se recuperen de una lectura de inicio de sesión o de cuota fallida.

<a id="quota-activation-and-reset-grant-observations"></a>

### Observaciones de activación y reset-grant de cuotas

```bash
ocx account quota-activation openai <id-or-alias-or-main> --window fiveHour off --json
ocx account list openai --json
ocx account anthropic-reset-grants --json
```

La activación de cuotas acepta `fiveHour` o `weekly`, deliberadamente diferente de Anthropic pool `five-hour`. Escribe un toggle de cuenta/ventana; habilitar puede programar la actualización de cuota. `{ok, id, window, enabled, available}` reporta la política y la disponibilidad observada, no la actualización completada. La habilitación no disponible puede devolver 409; la desactivación todavía está permitida. Nunca consume una concesión de reinicio.

Anthropic reset-grants acepta un ID de cuenta Anthropic exacto opcional, no un selector alias/principal Codex; la omisión utiliza la opción activa/retroactiva existente. El GET puede contactar con el servicio de estado ascendente. Reporta elegibilidad/razón, recuento de subvenciones, fechas anulables, tiempo de reutilización, operación pendiente y disponibilidad de revistas. Las subvenciones vacías no son lo mismo que el estado no disponible. Nunca consume una subvención o reanuda un gasto pendiente. El consumo sigue siendo una operación GUI humana.

<a id="use-remaining-included-quota"></a>

### Utilizar la cuota incluida restante

Para seguir utilizando una cuenta seleccionada más allá de un umbral de conmutación proactiva o el umbral de protección de cuenta principal, habilite explícitamente su preferencia de cuota restante:

```bash
ocx account use-remaining openai main on
ocx account use openai main
ocx account use-remaining openai main status --json
ocx account use-remaining openai main off
```

Reemplace `main` con un ID o alias de cuenta de grupo único para orientar una cuenta agregada. Al habilitar esto, se desactiva el cambio de uso proactivo para esa cuenta. Para el inicio de sesión principal, también mueve ambos umbrales efectivos de bloqueo duro al 100%, por lo que una lectura del 95% aún puede admitir una solicitud. La preferencia persiste en los reinicios hasta que se desactiva; la configuración del umbral original permanece almacenada y se reanuda la aplicación cuando está desactivada. No selecciona una cuenta en sí ni anula la programación de round-robin, la pausa manual / automática, las verificaciones de derechos, la reautenticación o los tiempos de reutilización ascendentes. El permiso de crédito pagado sigue siendo una configuración separada; habilitar esto nunca opta por una cuenta en créditos o canjea una subvención de restablecimiento. La cerradura rígida principal por defecto todavía se niega al 100%.

`GET /api/codex-auth/accounts/use-remaining?id=<account-id>` lee la política en vivo. `PUT /api/codex-auth/accounts/use-remaining` acepta `{ id, useRemainingQuota: boolean }`. Ambos requieren la autenticación de gestión existente. Este control está expuesto actualmente a través de los CLI y API.

<a id="main-account-quota-protection"></a>

### Protección de la cuota de cuenta principal

En **Codex ajustes → Multi-auth → Ajustes avanzados**, **Bloquear cuenta principal** está activado por defecto junto a Ultra Fast. Apagarlo se aplica inmediatamente; volver a encenderlo primero muestra las consecuencias, y la cancelación no cambia la configuración. La tarjeta de la cuenta principal muestra la supervisión, el uso desconocido o un bloque de directiva actual incluso cuando se cierra la configuración avanzada.

El valor predeterminado sigue a lo que hace una cuenta principal drenada en Codex Desktop: una vez que la ventana de la cuenta ChatGPT informa **0%** restante, Desktop deshabilita su botón de envío y la cuenta deja de aceptar turnos hasta que la ventana se restablece. Mantener el tráfico propio de ocx por debajo de ese punto mantiene la cuenta utilizable ([#5694](https://github.com/lidge-jun/opencodex/issues/5694)). El coste es Luna Reserve: mientras el bloque esté vigente, Reserve en esa cuenta principal no podrá activarse. Para que la cuenta principal se agote y se entregue a Reserve, apague el interruptor.

El **Ventana de 5h y la ventana semanal cada bloque por su cuenta**: la ventana de 5h alcanza el 90% o la ventana semanal alcanza el 98% de bloques de inmediato, incluso cuando el otro todavía tiene espacio para la cabeza. Las cuentas solo mensuales usan su ventana mensual. El bloque se libera automáticamente, con el interruptor todavía encendido, una vez que cada ventana de bloqueo informa una nueva lectura por debajo de su umbral (un 0% de recuentos de reinicio); la siguiente observación en el umbral bloquea nuevamente. Configure `codexMainAccountHardLockThresholds` en `config.json` con los porcentajes opcionales `short` y `long`, por ejemplo `{ "short": 90, "long": 98 }`. Ambos deben ser números enteros de 80 a 100, y `short` no debe exceder `long`; campos omitidos utilizan los valores predeterminados. La configuración API acepta el mismo objeto y devuelve los valores efectivos en `mainAccountHardLock.thresholds`.

**Mientras que el bloqueo bloquea, las solicitudes pueden recaer en otro modelo en lugar de fallar.** La fila **Retroceso mientras está bloqueado** se encuentra al lado del interruptor de protección y funciona como la fila de llamada a la sombra: elegir un modelo, por ejemplo `deepseek/deepseek-chat`, enciende la redirección inmediatamente, se le aplica el esfuerzo de pensamiento opcional y el interruptor pausa la redirección sin olvidar el modelo. Mientras que el bloque está en vigor y no Codex cuenta puede servir a una solicitud de un modelo nativo Codex, esa solicitud se encamina al modelo de reserva (con el esfuerzo configurado) en lugar de ser rechazada. Una cuenta Pool utilizable todavía sirve la solicitud primero; selectores calificados por el proveedor, combos, filas calificadas por la cuenta y Luna Reserve mantienen sus propios destinos; y se ignora una reserva que nombra un modelo Codex nativo, porque el reencaminamiento gpt-? solo volvería a ingresar el mismo rechazo. La cerradura en sí no cambia: se suelta por sí misma como antes, y el desvío termina con ella. Configurar `codexMainAccountHardLockFallback` en `config.json` como `{ "model": "deepseek/deepseek-chat", "reasoningEffort": "low" }`; `enabled: false` pausa el desvío mientras mantiene el modelo. Una sección ausente, un modelo omitido o una sección mal formada significa que las solicitudes son rechazadas como de costumbre; `reasoningEffort` debe ser un esfuerzo declarado. La configuración API acepta el mismo objeto, rechaza escrituras inválidas antes de la mutación y `null` borra la sección.

El panel de control y el `ocx status` muestran **posible uso fuera del opencodex** cuando las lecturas nuevas aumentan en al menos un punto en el mismo episodio de reinicio sin actividad reciente de la cuenta principal a través de este proxy. Esta es una observación de asesoramiento, no una prueba: un giro de larga duración también puede causarlo. La cerradura no puede evitar el agotamiento del tráfico exterior. El aviso de proceso local borra los cambios de identidad o de restablecimiento y caduca después de seis horas o en el restablecimiento observado, lo que ocurra primero. `ocx status --json` expone el estado, los umbrales efectivos, el tipo de ventana de bloqueo y la advertencia opcional `externalUsage` bajo `mainAccountHardLock` cuando hay evidencia de gestión en vivo disponible.

Una lectura ilegible de 5h no puede ocultar un bloque semanal. El uso desconocido no fabrica un cero, y una lectura faltante no borra una tupla de bloqueo ya medida. Un tiempo de reinicio predicho solo no lo desbloquea. Mientras está bloqueado, la recuperación comprueba los metadatos de uso propio en un horario limitado de 5/10/20/40/60 minutos, por lo que se observa un restablecimiento canjeado fuera de opencodex antes del restablecimiento previsto; el primer cheque espera cinco minutos, los cheques permanecen al menos cinco minutos de diferencia y el siguiente cheque se introduce al último restablecimiento de bloqueo conocido. Un principal en pausa o requerido para la re-autenticación no recibe ninguna comprobación antes de su reset predicho. Un `Retry-After` más largo también retrasa la preparación de perfiles y tokens. Solo el uso nuevo y válido o la evidencia autorizada de ausencia de ventana pueden levantar el bloqueo. En el modo Pool, una cuota `--refresh` evita la frescura de la memoria caché, pero aún honra el ritmo de lectura fallida; una lectura diferida no hace ningún nuevo intento de diagnóstico. Otros límites de pausa, reautenticación y aguas arriba permanecen independientes.

La protección trata una nueva respuesta de uso WHAM válida como un reemplazo para la lectura de 5 horas anterior cuando su ventana principal dura explícitamente **al menos 24 horas** e informa sobre el uso válido, o su ventana principal es explícitamente `null` y un secundario medido proporciona el uso semanal. En cualquier caso, las ventanas secundarias / terciarias deben ser explícitamente `null` o explícitamente durar al menos 24 horas e informar el uso válido. Esto sigue el límite corto / largo del analizador, por lo que una ventana de un día califica, así como ventanas semanales / mensuales. La ventana actual sigue utilizando el mismo umbral de ventana larga configurado (98% por defecto). Esto se basa en la única instantánea reportada; no se requieren observaciones repetidas. Cualquier campo de ventana omitido, una duración desconocida o encabezados de respuesta parcial no pueden borrar un bloque anterior. Las respuestas totalmente nulas con solo créditos y lecturas complementarias mensuales tampoco pueden establecer la recuperación. El proxy comprueba la credencial almacenada de nuevo antes de aplicar una respuesta retardada. Un archivo ilegible o portador reemplazado no puede actualizar la memoria caché de uso, liberar el bloqueo o poner en cuarentena la nueva credencial, incluso para la misma cuenta sin leer la segunda cuota. Su uso ordinario analizado aún se puede devolver al llamante solicitante, sin actualizaciones de estado compartido o evidencia de recuperación. La tarjeta de cuenta muestra el uso publicado en caché, manteniendo su cuota alineada con el estado de bloqueo; Direct cuota de proveedor omite una respuesta no publicada y su informe en caché anterior. Las identidades de cuentas en conflicto y las respuestas obsoletas 401/403 retienen la información almacenada en caché actual y no pueden borrar o establecer el estado de reautenticación de la cuenta actual.

Responses a las solicitudes enviadas con la credencial principal identificada actualizan su uso en caché desde sus cabeceras de cuota, ya sea que el proxy sustituya la credencial almacenada o el llamante envíe la misma credencial. Una respuesta se aplica solo si esa credencial sigue siendo la credencial principal observada cuando llega; una credencial propiedad del llamante para otra cuenta o espacio de trabajo nunca actualiza el uso de la cuenta principal.

La opción persistente es `"codexMainAccountHardLock"` en OpenCodex `config.json`. Una tecla ausente o `true` significa encendido; solo un `false` explícito lo apaga, y eso es lo que se almacena al desactivar la opción. El valor predeterminado cambió aquí: la política solía ser opt-in y el interruptor antiguo eliminó la clave cuando estaba apagada, por lo que una instalación que la había desactivado ahora se lee como activada. Si desea el comportamiento anterior, apáguelo una vez para registrar la opción de exclusión. La protección cubre nuevas solicitudes utilizando la cuenta principal identificada, no el último 2% en sí: las solicitudes que ya se están ejecutando, las credenciales de llavero propiedad del llamante sin igual y el tráfico fuera del proxy aún pueden gastar cuota. Las cuentas agregadas y otros proveedores permanecen disponibles.

Con la protección activada, una startup propia restaura la vinculación de identidad en memoria de la credencial principal después de la recuperación y limpieza del perfil nativo, por lo que un bloque de políticas persistente sobrevive a un reinicio. Las solicitudes Direct, exact-main, main-fallback y main-pin pueden recibir brevemente 503 mientras está pendiente esa vinculación; las cuentas Pool almacenadas saludables siguen siendo elegibles durante todo el proceso. No se lee ninguna credencial de un hogar de servicio extranjero o no confirmado para esta inicialización.

Mientras que esta política bloquea la principal, la Reserva Luna en esa cuenta también está bloqueada. Mantenerse por debajo del agotamiento de la cuota ordinaria puede evitar la activación de la reserva. Deshabilitar el switch restaura el manejo local normal, no el derecho ascendente adicional. Utilice la acción de actualización de cuota de cuenta para obtener una nueva observación; no se consume automáticamente ningún crédito de reinicio.

<a id="luna-reserve-alongside-routed-models"></a>

### Luna Reserve junto a modelos enrutados

El [Modo de escritorio](/es/guides/codex-integration/#authless-codex-desktop-opt-in) opcional mantiene inactiva la puerta del selector de solo reserva de Desktop. También deshabilita el manejo automático de reservas de Desktop: Reserve es una opción de modelo explícita, no una alternativa automática.

Mantenga habilitado el proveedor OpenAI integrado en modo de reenvío ChatGPT, habilite el selector de modelo de cuenta y configure un selector público para la cuenta principal almacenada. Con el modo sin autenticación de loopback efectivo habilitado, `ocx sync` incluye `<main-selector>/gpt-reserve` junto con los modelos de proveedores enrutados. Un `gpt-reserve` sin calificar, un selector de cuenta añadida y el descubrimiento de modelos con clave API no se añaden al catálogo. La configuración sin autenticación se ignora para el enrutamiento de clientes remotos o para un oyente que necesita un encabezado de admisión. Cuando los oyentes públicos y locales se ejecutan juntos, la reserva de compatibilidad solo se aplica a las solicitudes admitidas por el oyente local. Una solicitud pública autenticada permanece en la ruta normal aunque se origine en la misma máquina; los encabezados de la solicitud no pueden seleccionar la directiva local.

Habilite el modo de escritorio sin autorización con `ocx system settings --desktop-authless on`, ejecute `ocx sync`, luego salga completamente y vuelva a abrir Codex Desktop para que vuelva a cargar la configuración y el catálogo reescritos. Siga el [canónica flujo de trabajo de escritorio authless](/es/guides/codex-integration/#authless-codex-desktop-opt-in).

Cada solicitud de compatibilidad comprueba una autorización de servidor vinculada a credenciales, almacenada en caché durante un máximo de 60 segundos. OpenCodex envía el encabezado de capacidad de reserva en una lectura de uso de cuenta principal propia y requiere que el uso ordinario no esté permitido, la bandera de Reserva Luna y exactamente un cubo de reserva permitido. La evidencia faltante, denegada, rancia o no coincidente rechaza la solicitud; no cambia de cuentas ni usa silenciosamente la Luna ordinaria. El uso pasivo puede revocar la autorización, pero no puede crearla. El tiempo de reutilización global, la pausa, la reautenticación y el bloqueo de la cuenta principal aún se aplican. Apague el bloqueo duro si desea usar Reserve en una cuenta principal agotada; al hacerlo, no otorga derecho al servidor. Esta ruta de compatibilidad admite solicitudes de conversación y compactación, no se reserva como un ayudante de visión o búsqueda web o un modelo de relé de búsqueda independiente. Elija otro modelo para esos ayudantes.

El selector prefiere los metadatos de reserva reales. Cuando no se ha observado ninguno, utiliza una adaptación de metadatos de Luna explícitamente marcada, siguiendo el mapeo preestablecido de Reserva o Luna de Desktop. Una entrada visible no es prueba de disponibilidad. Se verificaron las rutas de origen del escritorio y las rutas respaldadas por accesorios; no se usó una cuenta activa de reserva en vivo para validar esta ruta de compatibilidad.

### `ocx account <subcommand>`

Haga una lista y cambie de cuentas de proveedores y grupos de claves API a través del proxy en ejecución. La superficie de ayuda enviada es:

```text
Usage: ocx account <list|history|current|use|clear|refresh|auto-switch|alias|priority|pause|resume|reset-affinity|pause-exhausted|strategy|sticky|remove|clear-cooldown|add-key|import|import-orca|login|reauth|code|cancel|reset-credits|grok-reset-coupons|main> ...

list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).
history openai <pool-account-id> [--limit <1-200>]  Recent routing decisions for one Codex pool account.
current <provider>  Show the active account or key.
use <provider> <id|alias|main|auto> Switch the active credential; 'main' selects the Codex App login, 'auto' clears the selection unless an account carries that id.
clear <provider>  Clear the manual Codex account selection unconditionally.
refresh <provider>  Force-refresh Codex or provider quota reports.
auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.
alias <provider> <id|alias> <display-name|->  Set or clear an account's display name; '-' clears it.
pause <provider> <id|alias|main>  Hold an account out of automatic selection.
resume <provider> <id|alias|main>  Return a paused account to automatic selection.
pause-exhausted <provider>  Pause every account whose quota is spent.
clear-cooldown <openai|anthropic> <id|alias|main>  Drop a cooldown the proxy set after an upstream failure.
reset-affinity <anthropic|anthropic2> [--json]  Confirm all session bindings are cleared, even with no accounts; selection and pause state stay unchanged. Run on the Home; a Remote Link Child names the Home and sends no request.
strategy <provider> [<quota|round-robin|fill-first|least-loaded|reset-first>]  Pool placement strategy; least-loaded is Kiro-only.
sticky <provider> [<1-100>]  Requests a bound thread keeps on one account; omit the value to read it.
priority <provider> <id|alias|main> [first|earlier|normal|later|last|-100..100|reset]  Selection order; omit the value to read it.
remove <provider> <id|alias|main> --yes  Remove a stored account or key after an existence check.
add-key <provider> [--label <label>]  Add a key read only from piped stdin.
login/reauth/code/cancel  Run browser or manual-code auth from a headless shell.
reset-credits <id|main> [--consume --yes]  Inspect or consume Codex reset credits.
grok-reset-coupons [<id>] [--consume --yes] [--token-id <token-id>] [--operation-id <uuid>]  Inspect or redeem Grok reset coupons.
import <provider> --format <format> (--file <path>|--stdin)  Import credentials from a named external format.
import-orca --source <dir> --registry <file> [--apply]  Preview or apply imports from Orca-managed Codex homes.
main <doctor|list|register|add|reauth|switch|recover>  Manage the Codex App login the pool calls 'main'.
Switching the active account takes effect immediately; running threads move on their next request, and in-flight requests keep the account they captured.
A selection-order change applies from the next unbound request and never moves a bound thread.
```

Los subcomandos de cuenta requieren que el proxy se ejecute y resuelvan automáticamente su puerto de entorno de ejecución registrado, excepto `import-orca`: la vista previa es solo local, y `import-orca --apply` requiere que el proxy esté detenido. Las operaciones exitosas salen con 0. El uso no válido, un proveedor o id de cuenta/clave desconocido, un proxy inalcanzable o un fallo de la API salen normalmente con 1. Para `reset-affinity`, HTTP 404 sale con 4 y HTTP 409 sale con 5; los demás fallos de la API y los resultados no confirmados salen con 1. Los campos de credenciales se muestran exactamente como los devuelve la API de gestión (incluido su enmascaramiento); las claves API sin procesar y los tokens OAuth nunca se devuelven. Las comodidades de visualización se sintetizan en el cliente, igual que en el panel: `main` es el alias de la CLI para el inicio de sesión de Codex App en el grupo de cuentas `openai`, las cuentas OAuth sin correo electrónico aparecen como `Account N`, y la columna de plan/etiqueta recurre al plan, al correo electrónico enmascarado, a la etiqueta y a la clave enmascarada.

Las filas de la cuenta `--json` usan esta forma común (los campos opcionales se omiten cuando no están disponibles):

```json
{
  "provider": "openai",
  "type": "codex | oauth | api-key",
  "id": "__main__",
  "label": "plus",
  "email": "m***@example.com",
  "plan": "plus",
  "masked": "sk-ab****wxyz",
  "priority": 0,
  "active": true,
  "needsReauth": false,
  "quota": null
}
```

### `ocx account import-orca --source <orca-data-directory> --registry <orca-data.json> [--apply] [--json]`

Reutilice los inicios de sesión locales administrados por Orca Codex sin otro inicio de sesión del navegador. El directorio fuente debe contener `codex-accounts/<account>/home/auth.json`. Proporcione el directorio de datos de Orca y el perfil elegido `orca-data.json` explícitamente. Solo se consideran las cuentas registradas en ese perfil; las casas de cuentas sobrantes o eliminadas no se importan. Cada hogar debe llevar el marcador de Orca correspondiente `.orca-managed-home`. El comando no escanea hogares no relacionados ni hosts remotos.

```powershell
# Windows: preview only; no account is registered.
ocx account import-orca --source "$env:APPDATA\orca" --registry "$env:APPDATA\orca\profiles\local-default\orca-data.json" --json

# Finish active proxy requests and stop the proxy before applying.
ocx stop
ocx account import-orca --source "$env:APPDATA\orca" --registry "$env:APPDATA\orca\profiles\local-default\orca-data.json" --apply
ocx start
```

Los perfiles más antiguos de Orca pueden usar `orca-data.json` directamente debajo del directorio de datos. En otras plataformas, pase el directorio de datos local de Orca y el registro de perfil con el mismo diseño. El importador omite identidades ya presentes en el inicio de sesión principal nativo, el grupo de cuentas o el almacén de credenciales, incluidos los duplicados dentro de la fuente. Esto utiliza deliberadamente el ID de cuenta ChatGPT como un depósito conservador: los miembros separados que comparten un ID de cuenta del espacio de trabajo también se omiten, no se fusionan ni se importan individualmente. La repetición de una importación conserva las cuentas existentes. Si una importación anterior se detuvo entre guardar credenciales y registrar la fila de grupo, reintentar puede finalizar ese registro con el mismo ID solo cuando su registro pendiente intacto aún coincida con el origen. Las entradas no válidas se cuentan por código de razón fijo. Un resultado mixto con al menos una cuenta elegible sale con éxito; un resultado en el que cada entrada descubierta no es válida sale con un código distinto de cero. La salida contiene códigos de cuenta y razón, no correos electrónicos, identificadores de cuenta, rutas o tokens.

**Orca conserva la propiedad de actualización.** OpenCodex almacena un enlace fuente de solo lectura y una instantánea de token de acceso, nunca el token de actualización de Orca. Al resolver las credenciales, vuelve a leer la fuente y verifica que todavía pertenece a la identidad importada. Orca debe mantener ese inicio de sesión disponible y actualizado. Las credenciales de origen ausentes, malformadas, caducadas o cuya identidad no coincide se rechazan; OpenCodex no vuelve a la instantánea anterior ni actualiza el inicio de sesión de origen. Este es un enlace local, no una exportación portátil o una transferencia de propiedad de actualización. Las solicitudes que ya se envían aguas arriba mantienen las credenciales que capturaron.

Las cuentas nuevas se registran como **validación pendiente**. Después de iniciar el proxy, abra **Codex Auth** y haga clic en **Actualizar las cuotas** para autorizar el paso de validación del modelo existente, que puede consumir una pequeña cantidad de cuota. La importación sin conexión y el análisis JWT no establecen la autenticación ascendente. La actualización de la cuota CLI por sí sola no realiza esa validación. El importador nunca inicia ni detiene la aplicación, cambia los archivos de Orca o cambia la cuenta del grupo activo.

Las cuentas guardadas del grupo ChatGPT se pueden listar, mostrar en el dashboard y actualizar aunque no exista un directorio nativo de Codex. Listarlas no crea ese directorio ni cierra la sesión nativa de la cuenta principal. Desactivar la integración de Codex no desactiva la consulta de cuota de una sesión nativa existente. Una ruta explícita inválida en `CODEX_HOME` sigue siendo un error de configuración. El almacenamiento inseguro de `OPENCODEX_HOME` también produce un error aunque falte el directorio de Codex. La resolución del directorio predeterminado rechaza archivos, enlaces rotos y directorios padre que no puedan recorrerse.

### `ocx account list [provider] [--json] [--all] [--quota [--refresh]]`

Sin un proveedor, enumera el grupo Codex, las cuentas OAuth y los grupos de claves API configurados. Los proveedores vacíos se omiten a menos que esté presente `--all`. Con un proveedor, enumera solo esa familia de credenciales. La salida legible usa `PROVIDER TYPE ID PLAN/LABEL PRIORITY STATUS`; una fila Codex elegida manualmente está marcada con `selected`. `PRIORITY` es el orden de selección Codex con signo (`0` cuando no está establecido) y muestra `-` en las filas donde el orden no se aplica, como las cuentas OAuth y las claves API. Con dos cuentas Kiro almacenadas, el límite de tasa, la cuota mensual confirmada y las denegaciones de suspensión pueden rotar a una cuenta elegible antes de la salida; la evidencia positiva de la lista de modelos en caché se prefiere entre las cuentas elegibles antes que la estrategia de grupo ordinaria. La rotación reactiva se activa por presencia y no se puede desactivar: `oauthAccountFailover.enabled: false` rechaza la preferencia de la cuenta previa al envío, no la recuperación ante rechazos, y una anulación del proveedor tiene prioridad; `ocx account login kiro` añade cuentas al grupo de una en una. Un resultado vacío sigue siendo un éxito. `--json` devuelve:

Las filas JSON de Codex incluyen `slotId`, igual al `id` registrado, y `slotKind`, con valor `native-main` o `pool`. Si el proxy puede verificar la identidad del usuario y de la cuenta del proveedor, también incluye `upstreamAccountKey`: `uai1_` seguido de 64 caracteres hexadecimales en minúscula. Dentro de `openai`, claves iguales identifican posiciones del mismo usuario; conserva cada posición y su estado de cuota por separado. La clave solo vale para esta instalación y puede cambiar al rotar el token de administración. Si falta, no deduzcas coincidencias por correos enmascarados ni valores de cuota. No se muestran identificadores originales del proveedor, declaraciones de identidad ni credenciales.

```text
{ accounts: AccountRow[], notes: string[] }
```

Un listado de proveedores vacío nombra el siguiente comando en la salida humana y JSON `notes`:
`ocx account login <provider>` para OAuth/Codex, o `ocx account add-key <provider>`
con una fuente de canalización controlada por humanos para las claves API. Un listado global vacío puntos a `ocx account login <provider>` y `ocx help account login`.

Las filas de la cuenta incluyen una etiqueta `health` validada y, cuando la recuperación está disponible, `healthAction`. La salida humana imprime la recuperación debajo de la tabla. La reautenticación apunta a la cuenta almacenada con `ocx account reauth <provider> --id <id>`; la principal nativa usa `ocx account main reauth --device`. La verificación del proveedor, los conflictos de credenciales y la validación pendiente conservan una orientación distinta. Codex filas preservan el `creditsAfterLimit` booleano del servidor en list/current JSON; las filas humanas muestran `paid-credits: on` solo cuando el permiso está habilitado. Estas lecturas no cambian el permiso de crédito pagado.

`--quota` agrega una columna `QUOTA` con el uso propio de cada cuenta, para los proveedores que admiten una sonda por cuenta (Anthropic, Kiro, Google Antigravity y Devin hoy). Es opt-in porque el proxy sondea el flujo ascendente una vez por credencial almacenada; el listado predeterminado permanece como una lectura local. `--refresh` omite el resultado almacenado en caché. Una cuenta sin cuota por cuenta muestra `-`, y una cuya sonda falló muestra `unavailable` - en blanco se leería como "no uso" en lugar de "no medido". `--json` lleva el desglose completo por cuenta, no solo las ventanas resumidas.

Los grupos de claves API también admiten `ocx account list <provider> --quota [--refresh]`. Sin `--quota`, su listado no solicita una investigación de cuotas. La lectura opt-in utiliza el propietario de la cuota de cada clave almacenada; `--refresh` solicita nuevas pruebas de que propietario y puede ponerse en contacto con el proveedor de upstream. No reemplaza las claves almacenadas o leer el agregado de todo el proveedor devuelto por `account refresh`.

Las filas JSON de claves API conservan `quotaMode` (`probe`, `passive`, `unsupported`), `quota` opcional o nulo, y `quotaUnavailable` cuando se devuelve. La cuota pública puede incluir ventanas personalizadas, saldos de crédito en USD, créditos de Kiro y horarios de actualización, no solo los porcentajes al estilo Codex. La salida legible distingue entre no admitido, no medido, no disponible y mediciones reales. Desconocido no es cero; el cero observado se conserva. Los campos consumidos mal formados, o una fila de clave devuelta sin evidencia de modo de cuota, fallan en lugar de fabricar soporte. Un grupo vacío sigue siendo válido. Las claves permanecen enmascaradas.

Google Antigravity filas llevan las mismas ventanas `Gem` / `Cla` que la cuota a nivel de proveedor, calculada a partir de la credencial propia de esa cuenta y el id del proyecto Cloud Code Assist. La sonda por cuenta siempre habla con el host Cloud Code Assist de Google a través del transporte saliente anclado, independientemente de un `baseUrl` configurado: una URL base personalizada es una opción de enrutamiento para solicitudes, no una segunda fuente de Google que representa una credencial almacenada. Una cuenta sin un ID de proyecto, o una cuya sonda se redirige o falla, muestra `unavailable`. Cuando el descubrimiento de modelos de reserva proporciona lecturas de cuotas, las pantallas detalladas retienen hasta 256 diagnósticos de modelos con distintas etiquetas limitadas. Estas filas no afectan los titulares de resumen del proveedor, la gravedad, la clasificación de la cuenta, el enrutamiento o las notificaciones de reinicio.

Las filas de Devin provienen de la `GetUserStatus` de Cognition para la propia clave de esa cuenta, enviada a su host api-server permitido. Si una credencial anterior no tiene host, la sonda utiliza la URL base del proveedor configurada cuando se incluye en la lista de permisos o el valor predeterminado de EE. Muestran las ventanas de fecha diaria y semanal que expone el plan, y una ventana de crédito mensual solo en un plan de crédito facturado que informa un saldo de crédito; una estrategia de facturación desconocida usa esa reserva de crédito solo si ambas fechas de reinicio están ausentes. Las ventanas vencidas diarias y semanales permanecen ocultas sin convertirse en una cuota de crédito mensual. Un saldo ilimitado, o un estado sin saldo en absoluto, no muestra ninguna ventana de crédito. Solo una tecla rechazada (401) borra una lectura almacenada en memoria caché; otros fallos de sondeo retienen la última lectura.

```text
$ ocx account list anthropic --quota
PROVIDER   TYPE   ID        PLAN/LABEL         PRIORITY  STATUS  QUOTA
anthropic  oauth  1278f8da  a***r@examp***.com  -                5h 7% wk 62%
anthropic  oauth  e112f28b  k***1@examp***.net  -        active  5h 9% wk 45%
```

Kiro factura una asignación mensual y no reporta una ventana más corta, por lo que sus cuentas rinden una cifra de `mo`:

```text
$ ocx account list kiro --quota
PROVIDER  TYPE   ID        PLAN/LABEL         PRIORITY  STATUS  QUOTA
kiro      oauth  3f0a91c2  a***r@examp***.com  -        active  mo 15%
kiro      oauth  8b24de70  k***1@examp***.net  -                mo 88%
```

`ocx account list kiro` marca una cuenta excluida de la selección automática como `not-auto-selected(<reason>)`. JSON lleva `autoSelectable` y, cuando es falso, un `skipReason` cerrado (`paused`, `needs_reauth`, `suspended`, `cooldown` o `quota_exhausted`). Todavía se puede enviar un singleton activo o un pool totalmente excluido. Kiro `providerCredits` proviene de los valores medidos `meteringEvent`: la última lectura dentro de una respuesta física se conserva, y los envíos facturados por separado se agregan al gasto de la solicitud. Los créditos nunca se estiman a partir de tokens.

Con dos o más cuentas Kiro iniciadas, la tasa de solicitud, la cuota mensual confirmada y las negativas de suspensión confirmadas pueden rotar antes de la salida. El agotamiento mensual excluye solo ese inicio de sesión hasta que se restablezca o expire la evidencia; el servicio completado borra un veredicto anterior. Los rechazos de cuota incluyen los motivos exactos `MONTHLY_REQUEST_COUNT` y `OVERAGE_REQUEST_LIMIT_EXCEEDED` en HTTP 400 o 429. Los planes que permiten consumo adicional pueden seguir atendiendo solicitudes aunque el indicador mensual llegue al 100 %. La rotación reactiva permanece disponible cuando la preferencia proactiva de la cuenta está desactivada. Las cuentas se agregan una a la vez: `ocx account login kiro` delega en el Kiro CLI y añade la nueva cuenta al grupo. En el panel de control, las cuentas Login y Add también ofrecen inicio de sesión de dispositivos Builder ID, Google y GitHub junto con la opción Kiro CLI; el inicio de sesión de dispositivo nativo agrega una cuenta sin cerrar sesión en el CLI. Los usuarios de un perfil de organización (IAM Identity Center) comparten su perfil ARN, por lo que una cuenta Kiro CLI se identifica por ese perfil junto con los informes `kiro-cli whoami` de correo electrónico para la sesión. Por lo tanto, dos usuarios de la misma organización siguen siendo cuentas separadas, y al iniciar sesión el mismo usuario vuelve a actualizar la cuenta de ese usuario. Cuando `kiro-cli whoami` no reporta ningún usuario, el perfil solo identifica la cuenta como antes. Si ese perfil ya tiene una cuenta con un usuario conocido, tal inicio de sesión solo actualiza la cuenta cuya sesión Kiro CLI almacenada continúa; se rechaza cualquier otro inicio de sesión en lugar de reemplazar una cuenta, y un inicio de sesión de cuenta Agregar conmuta el Kiro CLI de nuevo a su sesión anterior. Ejecute `kiro-cli whoami` para confirmar el usuario que ha iniciado sesión y, a continuación, vuelva a intentarlo. Reautenticar una cuenta guardada antes de que se conozca a su usuario registra al usuario que inicia sesión, a menos que ese usuario ya tenga otra cuenta del mismo perfil. Para agregar una cuenta sin el Kiro CLI, use `ocx account login kiro --method builder-id`, `--method google` o `--method github`. Abra la URL de verificación impresa, ingrese el código de usuario y espere la aprobación. `--no-wait` imprime el ID de flujo; cancélalo con `ocx account cancel kiro --flow <flow-id>`. El inicio de sesión nativo solo agrega cuentas. Para volver a autenticar uno, retíralo y agrégalo de nuevo. Un ARN de perfil social repetido crea otra ranura e imprime `duplicate_profile_arn`; las ranuras llevan cada una su propio estado de cuota y carga. Kiro puede optar por la colocación proactiva de `least-loaded` con `pool.kernel` y la preferencia de cuenta habilitada. La preferencia de modelo proactiva también requiere que la preferencia de cuenta esté habilitada explícitamente a nivel mundial o para Kiro; una configuración no establecida o falsa deja una cuenta activa saludable en su lugar. Las listas de modelos se aprenden después de que una cuenta sirve, por lo que un hermano inactivo puede inicialmente no tener evidencia. Un ID de modelo ausente de cada lista almacenada en caché todavía se envía aguas arriba. Su límite opcional `maxConcurrentPerAccount` es una cola limitada por cuenta: una cuenta completa seleccionada espera hasta 250 ms, luego devuelve 503 `account_capacity` con `Retry-After: 1`. El límite es local para cada proceso proxy y no mueve una solicitud; la rotación reactiva permanece disponible después de un rechazo.

### `ocx account current <provider> [--json]`

Muestra la cuenta o clave activa. Un grupo Codex sin anclaje manual informa de la selección automática con prioridad: se elige el nivel elegible de mayor prioridad y, dentro de ese nivel, se selecciona la cuenta de menor uso con enrutamiento por cuota; otra familia sin credenciales activas informa de ese estado y aun así sale con 0. `--json` devuelve:

```text
{ provider, type, activeId: string | null, autoSwitchThreshold?: number, account: AccountRow | null }
```

### `ocx account use <provider> <account-or-key-id|alias|main|auto> [--json]`

`auto` borra la selección manual para que el grupo vuelva a colocar el trabajo según su propia estrategia, a menos que una cuenta Codex lleve literalmente el id `auto`, que gana por precedencia de id exacto; `ocx account clear <provider>` siempre restaura la selección automática. Cualquier cuenta Codex puede nombrarse por el alias establecido con `ocx account alias` en lugar de por su id; eso también vale para `priority`, `pause`, `resume`, `clear-cooldown`, `remove` y `alias`. Para las cuentas Codex, `auto`, `main` y `__main__` están reservados sin distinguir mayúsculas y minúsculas y no se pueden asignar como alias. Los nombres de visualización de OAuth y de clave API mantienen sus reglas existentes.

Selecciona una cuenta Codex, una cuenta OAuth o una clave API existente. Para `openai`, `main` selecciona el inicio de sesión de Codex App. Una selección de Pool Codex borra la afinidad y se aplica a la siguiente solicitud, incluida la de una tarea visible existente. Los vínculos de las solicitudes con un id de sesión (incluidos los turnos normales de Codex CLI y App y de los subagentes), o de las solicitudes sin sesión ancladas a su padre inmediato, pueden sobrevivir a un reinicio ordenado del proxy, durante hasta 24 horas de inactividad, cuando el guardado final de afinidad al apagar tiene éxito. Las cadenas sin sesión más profundas y los vínculos con el inicio de sesión principal de Codex App solo viven en memoria y se reasignan tras el reinicio; la expulsión, la eliminación de la cuenta, un nuevo inicio de sesión, un cierre inesperado o un restablecimiento de afinidad pueden dejar una tarea sin vínculo, mientras que las solicitudes en curso conservan la cuenta que capturaron. Esto controla solo el enrutamiento de Pool; el modo Direct sigue usando la credencial principal nativa o propiedad del llamante. La conmutación proactiva basada en el uso, la reautenticación 401/403, los enfriamientos 429/retry-after, la exclusión y la recuperación de fallos 429/402 previos a la salida pueden seleccionar más tarde otra cuenta Pool elegible. Esas rutas de recuperación siguen activas cuando la conmutación basada en el uso está desactivada. OpenCodex reproduce la conversación tras un cambio de cuenta, pero la caché de prompts del lado del proveedor puede estar fría. Los proveedores o ids desconocidos salen con 1. En un **401/403**, el inicio de sesión de App borra la afinidad local al proceso de esa cuenta y exige reautenticación. En un **429**, opencodex respeta `Retry-After`, inicia el enfriamiento de la cuenta, borra la afinidad y puede rotar la solicitud a otra cuenta Pool elegible. Estas transiciones de fallo siguen activas con `autoSwitchThreshold: 0`; esa configuración desactiva solo la conmutación proactiva basada en el uso. `--json` devuelve:

```text
{ ok: true, provider, type, activeId }
```

### `ocx account clear <provider> [--json]`

Borre la selección manual de la cuenta Codex sin resolver un identificador de cuenta, por lo que funciona incluso cuando una cuenta se llama literalmente `auto`. Solo para grupos Codex; otros tipos de proveedor no tienen selección automática que restaurar.

### `ocx account pause|resume <provider> <id|alias|main> [--json]`

Las cuentas pausadas por el opt-in [Política de pausa automática por proveedor](/es/reference/configuration/providers/#auto-pause-permanently-refused-accounts) usan los mismos comandos. El listado muestra la razón de pausa fija; la reanudación lo borra.

Pausa o reanuda una cuenta en el grupo Codex, Anthropic, OAuth genérico o de claves API, incluido `google-antigravity`. Para el grupo Codex, `main` identifica solo la cuenta Codex incorporada; las cuentas OAuth deben identificarse por id o por un alias único. Una cuenta OAuth pausada queda excluida de la selección de solicitudes, de la conmutación por error 429 y de la renovación proactiva de tokens, y no se puede seleccionar manualmente. Pausar la cuenta activa cambia a la siguiente cuenta utilizable cuando existe una. Si todas las cuentas están en pausa, las solicitudes de ese grupo devuelven 403 hasta que se reanude una cuenta.

Para proveedores Anthropic y genéricos OAuth, identifique la cuenta por id o por un alias único exacto o insensible a mayúsculas y minúsculas. La respuesta JSON informa el id de la cuenta, el estado de pausa y el id de la cuenta activa.

La pausa Anthropic se aplica incluso cuando la agrupación proactiva está deshabilitada, incluida la afinidad de sesión y 429 sucesores. Sobrevive al reinicio y la reautenticación, conserva las credenciales y la salud, y no interrumpe un turno ya enviado. Eliminar la cuenta elimina su estado de pausa. Los umbrales de conmutación automática Anthropic por cuenta no forman parte de este control.

La reserva de pausa automática de Anthropic mantiene el orden de las cuentas, omite las cuentas pausadas y las cuentas que requieren reautenticación, y excluye las importaciones de Claude Code que expiran en 60 segundos. Las cuentas heredadas sin un origen registrado siguen siendo elegibles utilizando solo sus propias credenciales almacenadas y la actualización normal del token almacenado; nunca adoptan las credenciales de disco CLI. Se puede seleccionar una importación Claude Code aún válida con más tiempo restante. Más tarde, la readopción automática acepta un token compartido, de acceso no vacío o de actualización. Si ambos tokens rotan, OpenCodex requiere una prueba UUID de cuenta autenticada tanto para el portador almacenado como para el importado. Guarda esa prueba en privado cuando está disponible desde el inicio de sesión, la actualización o la búsqueda de perfil; las etiquetas de cuenta, el correo electrónico, la organización y la ubicación del archivo de credenciales no pueden sustituirla.

Cuando el portador antiguo ha expirado y no se ha guardado ninguna prueba de cuenta vinculada, la recuperación automática puede ser imposible. Un perfil no disponible o un par girado no verificado deja la cuenta almacenada sin cambios y no reproduce un token de actualización potencialmente consumido. Use el inicio de sesión explícito para importar la credencial actual Claude Code. Importar conserva ranuras sin identidad no relacionadas y puede crear una cuenta separada; seleccione la cuenta deseada y elimine ranuras obsoletas solo después de verificarlas. Un error de búsqueda de perfil puede dejar una nueva importación sin identidad, con la misma limitación de recuperación automática.

Si no se permite ninguna reserva, la detección de cuotas y modelos en vivo espera una cuenta activa utilizable. Puede seleccionar explícitamente una cuenta heredada sin pausa existente con `ocx account use anthropic <account-id-or-alias>`; su propia credencial válida y la actualización normal de token almacenado permanecen disponibles incluso cuando no se registró su fuente de credenciales original.

```bash
ocx account pause google-antigravity <account-id-or-alias>
ocx account resume google-antigravity <account-id-or-alias>
ocx account resume anthropic <account-id-or-alias> --if-healthy
```

### `ocx account clear-cooldown <openai|anthropic> <id|alias|main> [--json]`

Elimina un tiempo de reutilización de fallos de proceso local sin cambiar las credenciales almacenadas. Utilice `openai` para una cuenta de grupo Codex o `anthropic` para una cuenta Anthropic OAuth; otros proveedores son rechazados. Ambos formularios aceptan un identificador de cuenta o alias único, mientras que `main` es específico del grupo Codex.

```bash
ocx account clear-cooldown anthropic <id-or-alias>
```

El comando reporta el éxito incluso cuando no hay tiempo de reutilización activo, con `cleared: false` en JSON. El borrado de un tiempo de reutilización de Anthropic también avanza la generación de cuentas para que una investigación de cuotas en vuelo más antigua no pueda restaurar el estado borrado o publicar la elegibilidad obsoleta derivada de la cuota después.

### `ocx account refresh <provider> [--json]`

Para el grupo Codex, use `ocx account refresh openai [--json]`. Se actualiza a la fuerza las cuotas de cuenta e imprime los porcentajes semanales / mensuales disponibles y los tiempos de reinicio; los datos de cuotas faltantes se informan como desconocidos, no como 0%. Su envolvente JSON es `{ accounts: AccountRow[] }`, con `quota` en cada fila Codex.

Para proveedores OAuth y de clave API, esto fuerza la actualización del punto final de informes de cuota del proveedor; no es un nuevo inicio de sesión de token ni una simple relectura de la lista de cuentas. `--json` devuelve `{ provider, report: ProviderQuotaReport | null }`. Un proveedor sin un informe de cuota compatible imprime `no quota report available for <provider>` y sale con 0. Los proveedores desconocidos y los fallos de la API de gestión salen con 1; una sonda de cuota ascendente que falla o expira se degrada a un informe nulo o desactualizado (código de salida 0), lo que coincide con las barras de cuota del panel.

### `ocx account auto-switch <provider> <on|off|status|threshold <0-100>> [--json]`

Controla el umbral del grupo Codex `openai`, o almacena un umbral para un grupo OAuth genérico. `on` almacena el 80%, `off` almacena el 0% y `threshold <n>` acepta 0–100. Un umbral de grupo genérico dirige la selección solo mientras `pool.kernel` está activado con `strategy: "fill-first"`; con el indicador desactivado, guardar uno no habilita la conmutación basada en umbral. Nunca cambia la anulación de habilitación del proveedor ni desactiva la rotación reactiva 429. `status` y la salida de las mutaciones de grupos genéricos usan la respuesta confirmada del servidor. Para grupos genéricos, `poolEnabled` es la anulación almacenada del proveedor (`null` significa no especificado), no el estado efectivo heredado; `inert: true` significa que el umbral se almacena pero no se aplica, `inert: false` significa que el grupo lo está aplicando, y un `inert` ausente es una capacidad desconocida, que nunca informa `enabled: true`. Se rechazan los proveedores de clave API y los valores no válidos.

### `ocx account auto-switch anthropic … --account <id>`

Para Anthropic OAuth, use `ocx account auto-switch anthropic threshold 90 --account <id>` (entero 0-100), `off --account <id>` (0), `on --account <id>` (80), `inherit --account <id>` (reseteo) o `status --account <id>` (solo lectura); agregue `--json` para la salida estructurada. La tarjeta de cuenta ofrece la misma palanca de umbral personalizado. Faltante / nulo hereda `anthropicAccountPool.autoSwitchThreshold` (predeterminado 80); 0 deshabilita la conmutación basada en el uso para esa cuenta, no la pausa o la recuperación reactiva 429. Las anulaciones sobreviven al reinicio y al reinicio y se eliminan con la cuenta. Con la agrupación habilitada, la cuota y el relleno primero comparan cada fuente/candidato con su propio umbral en la ventana de cuota seleccionada. La precedencia manual/afinidad, el comportamiento sin identidad de round-robin/fill-first, el retroceso de cuota desconocida y el retroceso totalmente drenado permanecen sin cambios. Round-robin no está controlado por el uso; los grupos deshabilitados ignoran estos umbrales. Las listas de permisos de ruta de modelo aún restringen a todos los candidatos.

```text
openai: { provider, autoSwitchThreshold: number, enabled: boolean }
generic OAuth: { provider, autoSwitchThreshold: number | null, enabled: boolean, poolEnabled: boolean | null, inert: boolean | null }
```

### `ocx account preserve-signed-in openai [on|off|status] [--apply-to-bound] [--json]`

Optar por **use primero otras cuentas elegibles y mantenga la identidad de escritorio iniciada como reserva ChatGPT / Codex**. Una invocación desnuda o `status` lee la política del proxy en ejecución, los ID de entrada afectados, el pin manual y la siguiente opción no vinculada. `on` persiste `codexPreserveSignedInAccount: true`; `off` restaura su pedido de cuenta personalizada existente sin volver a escribir ninguna prioridad.

El grupo reservado incluye entradas nativas de `__main__` y de grupos ordinarios con el mismo correo electrónico de miembro normalizado de ChatGPT cuenta/espacio de trabajo seleccionado de **y**. Compartir un espacio de trabajo solo es insuficiente. El grupo sigue el inicio de sesión físico más reciente observado por el ciclo de vida de inicio de sesión nativo del proxy; ninguna credencial de solicitud entrante puede definirlo. Si la evidencia del miembro/espacio de trabajo no está disponible, `identityKnown: false` informa que solo se puede identificar la principal. El estado obtiene una nueva observación propia; un perfil nativo ocupado o ilegible devuelve 503 sin aplicar el cambio.

Las cuatro estrategias Codex prefieren otras identidades con margen de cuotas, preservando el orden personalizado dentro de cada grupo. Las entradas reservadas permanecen como reserva cuando los niveles preferidos se agotan. **Fallback puede consumir la cuota de inicio de sesión**, sujeto al modelo de acceso existente, pausa, tiempo de reutilización, reautenticación, bloqueo estricto y cheques de consentimiento de crédito pagado. Esta política no otorga el consentimiento de crédito pagado.

Las fijaciones existentes saludables permanecen en su lugar, y los pines manuales y las rutas de modelo exactas calificadas para la cuenta anulan la preferencia. Para aplicarlo al trabajo en curso, ejecute:

```bash
ocx account preserve-signed-in openai on --apply-to-bound
```

Esto libera explícitamente solo los enlaces afectados y cualquier pin manual afectado para el **siguiente solicitud**; Las solicitudes en vuelo mantienen su cuenta capturada. Permanecen fijaciones y pasadores no relacionados. El trabajo en movimiento puede perder su caché de solicitud de calor, y las cargas o el estado de continuación de la cuenta pueden evitar un movimiento. `codexAccountPriorityFailback` sigue siendo un opt-in separado, con su actual cuota-estrategia, umbral positivo y nuevas condiciones de observación, sino que también puede mover el trabajo hacia un grupo preferido.

Para **Nunca use esta identidad a través del grupo.**, use `ocx account pause openai main` en su lugar: la pausa vinculada excluye las entradas del grupo principal y coincidente sin cambiar el archivo de inicio de sesión del escritorio. Solo se controlan las solicitudes que alcanzan OpenCodex. Esto no desbloquea un compositor de escritorio ya desactivado ni promete arreglar la conmutación de cuotas del lado del cliente.

### `ocx account priority <provider> <account-id|alias|main> [<-100..100|first|earlier|normal|later|last|reset>] [--json]`

Lee o establece el orden de selección de una cuenta del grupo Codex: **un valor más alto se usa antes**, el predeterminado es `0` y el rango va de `-100` a `100`. Solo se ordena el grupo Codex `openai`, por lo que otros proveedores salen con 1. `main` apunta al inicio de sesión de Codex Desktop, que se ordena como cualquier otra cuenta del grupo. `ocx account priority openai main last` solo baja esa entrada; use `preserve-signed-in` (arriba) para reservar también sus entradas ordinarias correspondientes del grupo.

Las palabras preestablecidas representan números enteros pequeños: `first` es `+2`, `earlier` es `+1`, `normal` es `0`, `later` es `-1` y `last` es `-2`. `reset` devuelve la cuenta al valor predeterminado y elimina su entrada almacenada. **Omitir el valor leído** el orden actual en lugar de escribir uno.

Ordenar selecciones qué cuentas se consideran primero, no cuáles son utilizables: la selección aún se ejecuta entre las cuentas elegibles, tomando el nivel de orden más alto que aún tiene margen de cuota y dejando `accountPoolStrategy` para elegir dentro de él. La pausa, el tiempo de reutilización y la reautenticación no se ven afectados. Los cambios se aplican desde el **siguiente solicitud no vinculada**, no solo desde las sesiones recién iniciadas: la preferencia mueve una solicitud no vinculada tan pronto como un orden superior recupera espacio libre. Los hilos ya vinculados a una cuenta normalmente la mantienen hasta que se agota esa cuenta; un fallo de reautenticación o un tiempo de reutilización de la cuota aún liberan el enlace inmediatamente. Una racha de fallos transitorios (5xx y otros fallos no contingentes que alcanzan `upstreamFailoverThreshold`, por defecto 3) ya no elimina un enlace en vivo: la solicitud es servida por otra cuenta mientras se mantiene el enlace, y la tarea vuelve a su propia cuenta tan pronto como esa cuenta vuelve a servir. Si la cuenta sigue fallando después de 10 minutos, la vinculación se libera normalmente. Esta retención es independiente de `pool.cacheAffinity`. Cualquier escritura aceptada también libera un pin manual "usar esta cuenta ahora", en cualquier cuenta que la tenga, incluyendo una escritura que almacena el pedido que una cuenta ya tenía - esta es la única manera de borrar un pin mientras se mantiene la cuenta que está seleccionada actualmente. (Borrar la cuenta activa a través de la administración API libera un pin también, pero deja caer esa selección junto con él.) `--json` devuelve:

```text
{ ok: true, provider, id, priority: number, preset: string | null }
```

### `ocx account login|reauth|code|cancel ...`

Ejecute la autenticación de cuenta basada en navegador o por código manual desde un shell sin interfaz. Utilice `ocx account --help` para la forma de comando específica del proveedor. Si se guarda un inicio de sesión de cuenta Codex pero su validación o la actualización del catálogo de modelos sigue pendiente, tanto el modo humano como el JSON salen con 1. El inicio de sesión guardado sigue visible; no reinicie la autenticación solo porque el trabajo de seguimiento esté pendiente. La salida humana imprime en stderr la guía de recuperación fija de `ocx sync` para un catálogo pendiente. `--json` mantiene stdout analizable y conserva las marcas de pendiente sin la advertencia humana.

Las nuevas opciones de inicio de sesión son específicas de flujo:

| Flujo | `--open-browser on\|off` | `--add-account on\|off` |
| --- | --- | --- |
| Proveedor ordinario fresco OAuth | Compatible con proveedores con capacidad de navegador | Se admite; se omiten los valores predeterminados para agregar una cuenta |
| Reauth proveedor ordinario | Flujos compatibles con el navegador solamente | Rechazado; la omisión retiene el comportamiento reauth |
| Inicio de sesión del navegador Codex | Apoyado | Rechazado |
| Dispositivo Codex, autorización de dispositivo xAI, o kimi/nous/github-copilot nativo | Rechazado | Rechazado para Codex; reglas ordinarias OAuth para otros proveedores |
| Nativo Kiro `--method` | Rechazado | Rechazado; este flujo es solo para agregar |

Explícita add-off cuenta permite la preferencia de importación existente; no elimina una cuenta. Omission conserva los valores predeterminados anteriores de CLI. El operador debe completar la verificación del navegador/dispositivo. Mantenga `flowId`, ID de cuenta y código de verificación separados; una concesión de dispositivo devuelta no es un lanzamiento exitoso del navegador. `--no-wait --json` informa el traspaso, no el inicio de sesión completo. Conservar el estado pendiente, caducado, cancelado, pendiente de validación y pendiente de catálogo; nunca reinicie silenciosamente un flujo, credenciales de captura o verificación completa para el operador.

`ocx account login openai --device` ejecuta el inicio de sesión de código de dispositivo de OpenAI en lugar de la devolución de llamada del navegador. Utilícelo cuando el host proxy no tiene navegador, o cuando nada puede alcanzar su `localhost:1455`: un contenedor, un VPS o cualquier concentrador alcanzado a través de SSH:

```bash
ocx account login openai --device --no-wait --json
# Read the returned flowId, URL and deviceCode; the operator completes verification.
```

Abre esa URL en otra máquina e introduce el código corto para completar el inicio de sesión. Sin `--no-wait`, el comando sondea hasta que termines; para el pool de Codex espera los 15 minutos de la concesión de dispositivo, en lugar de los 5 minutos del inicio con navegador.

`ocx account login xai --device` inicia la autorización de dispositivo de xAI en lugar de su callback `127.0.0.1:56121`. Muestra la URL de verificación y un código corto para confirmar en cualquier navegador, sondea según el intervalo del proveedor y termina sin pegar nada. El plazo procede de `expires_in` en la respuesta de autorización de xAI, con un límite de 30 minutos y un sondeo como máximo por segundo; una concesión caducada se informa y no se reintenta. Si xAI responde a un sondeo con `429` o `5xx`, `Retry-After` determina esa espera en lugar del intervalo, siempre dentro del plazo de la concesión. Se rechaza cualquier redirección en las solicitudes de dispositivo y el inicio falla inmediatamente como error de autenticación, sin reintentar como error de red o código. `kimi`, `nous` y `github-copilot` aceptan la opción sin efecto porque ya usan exclusivamente el flujo de dispositivo; un proveedor sin esa concesión la rechaza. Como no hay nada que pegar, se rechaza `--device` con `--code`. En xAI, `--json` requiere `--no-wait`: `ocx account login xai --device --no-wait --json` devuelve un único objeto JSON con la URL de verificación, el código y el ID de flujo. Completa la autorización en un navegador; el proxy continúa en segundo plano. Cancela ese intento con `ocx account cancel xai --flow <flow-id>`; sin `--flow` se cancela el más reciente.

El dashboard no ofrece así la concesión de dispositivo del proveedor. En el modal para añadir cuentas, **«No abrir un navegador en la máquina proxy»** solo impide que el proxy abra el navegador: conserva el protocolo del flujo en modo `callback` y debes completar la URL de autorización. Elegir un flujo de dispositivo es un control independiente cuando existe: el modal de cuentas Codex ofrece **Device code login** y el inicio de dispositivo nativo de Kiro se inicia desde su propio panel, nunca desde esa casilla. No hay control en el dashboard para la autorización de dispositivo xAI; usa `ocx account login xai --device`.

### `ocx account remove <provider> <id|alias|main> --yes [--json]`

Esta eliminación protegida y no interactiva requiere `--yes`. Antes de eliminar, verifica que el id exista; un id ausente sale con 1 sin enviar DELETE. El inicio de sesión principal de Codex App no se puede eliminar, por lo que
`remove openai main --yes` se rechaza. Tras la eliminación, la familia se vuelve a leer: eliminar la cuenta Codex anclada borra el anclaje y vuelve a la selección automática; OAuth promueve la primera cuenta restante o informa de que no queda ninguna; los grupos de claves API promueven la primera clave restante o informan de que no queda ninguna. Las formas de éxito y fallo de `--json` son:

```text
{ ok: true, provider, id, removedActive: boolean, promotedActiveId: string | null, catalogRefreshPending?: boolean }
{ error: string } // stderr, exit 1
```

`catalogRefreshPending` solo está presente en eliminaciones de Codex. Cuando es `true`, la eliminación de la cuenta ya está guardada; la salida humana imprime la guía de recuperación genérica de `ocx sync` en stderr y aun así sale con 0. Los sobres de eliminación de cuentas OAuth y de claves API no incluyen este campo.

### `ocx account add-key <provider> [--label <label>] [--json]`

Añade y activa una clave para un proveedor de clave API. La clave se lee solo desde stdin canalizado/redirigido que no sea TTY; la entrada TTY interactiva, la entrada vacía, los proveedores OAuth/Codex y los fallos de la API salen con 1. La clave nunca se repite, incluso cuando aparece dentro de una etiqueta. Prefiera un gestor de secretos o un here-string:

```bash
ocx account add-key openrouter --label personal <<< "$OPENROUTER_API_KEY"
security find-generic-password -w openrouter | ocx account add-key openrouter --json
```

`--json` devuelve `{ ok: true, id: string | null, label?: string }` y nunca incluye la clave.

### `ocx account reset-credits <id|main> [--consume --yes]`

Inspeccione los créditos de reinicio Codex para una cuenta. Consumir un crédito es destructivo y requiere `--consume` y `--yes`.

Después de un `reset` confirmado, el nuevo uso puede recuperar el tiempo de reutilización derivado del restablecimiento compartido elegible existente de la misma cuenta. Las cuentas en pausa, las cuentas que necesitan reautenticación y los tiempos de reutilización propiedad de una sonda en curso quedan excluidos de esta recuperación. Una actualización de uso fallida u ocupada tras el consumo confirmado no requiere otro crédito: vuelva a comprobar el uso en lugar de repetir `--consume`. El éxito del consumo no garantiza la capacidad de rotación; consulte el [contrato de recuperación de la API de gestión](/es/reference/management-api/#codex-authentication-delegation) para restablecer/reproducir, frescura y límites de alcance.

### `ocx account grok-reset-coupons [<account-id>] [--consume --yes [--token-id <id>] [--operation-id <uuid>]] [--json]`

Inspecciona los cupones restantes o canjea uno por una cuenta xAI / Grok.

Cuando se invoca sin `--consume`, devuelve los tokens de cupón disponibles y las ventanas de validez:

```bash
ocx account grok-reset-coupons
ocx account grok-reset-coupons acc_xai_01 --json
```

Canjear un cupón de reinicio muta el estado de facturación y agota permanentemente un token de cupón. `--consume` requiere estrictamente `--yes`:

```bash
ocx account grok-reset-coupons --consume --yes
ocx account grok-reset-coupons --consume --yes --token-id <token-id>
```

Pase `--operation-id <uuid>` (debe ser un UUIDv4 válido) para garantizar la liquidación idempotente. Si la red cae o se vuelve a intentar la orden, IDs de operación idénticas reproducen el resultado grabado de forma duradera en lugar de consumir un segundo cupón.

El comando sale con un valor distinto de cero a menos que el código establecido sea `redeemed` (incluido un `redeemed` reproducido). Cuando el resultado no está confirmado (un código establecido ausente o no reconocido, `attempt_unresolved`, `attempt_in_progress`, `attempt_reconcile_failed`, `operation_state_changed`, `operation_token_mismatch`, `attempt_mark_failed` o `ledger_unavailable`/`capacity` con un id de operación), imprime el `--operation-id` que debe conservar; vuelva a ejecutar con ese mismo id en lugar de iniciar una nueva operación. Un rechazo registrado (`auth_failed`, `fetch_resets_failed`, `no_coupons_available`, `coupon_unavailable` o `token_unresolved`), como un fallo repetido, imprime `Coupon was not redeemed (<code>)`; cualquier otro código establecido cuenta como no confirmado.

### `ocx account main <subcommand>`

Gestione los perfiles de inicio de sesión principal nativos con nombre Codex sin cambiar el enrutamiento del grupo de cuentas OpenCodex:

```text
ocx account main doctor [--json]
ocx account main list [--json]
ocx account main register <label> [--json]
ocx account main add <label>
ocx account main reauth --device [--no-wait] [--json]
ocx account main reauth status --flow <id> [--json]
ocx account main reauth cancel --flow <id> [--json]
ocx account main switch <profile-id-or-label> --yes [--json]
ocx account main recover [--rollback --yes] [--json]
```

Una lista de perfil nativo vacía sugiere `ocx account main add <label>` en salida humana y JSON `notes`; no asume que esté disponible un inicio de sesión nativo existente.

`ocx account main reauth --device --no-wait --json` escribe un objeto JSON a stdout en caso de éxito, sin la línea `follow up:` legible por humanos. Utilice su `flowId` con `ocx account main reauth status --flow <id> --json` para comprobar el progreso.

Cada comando de mutación reporta el `CODEX_HOME` efectivo canónico devuelto por el proxy en ejecución. Esta ruta puede diferir de la `CODEX_HOME` de la persona que llama; las órdenes que soportan JSON exponen el mismo valor que `effectiveCodexHome`.

La versión 1 admite la autenticación Codex basada en archivos, cifra los perfiles almacenados con AES-256-GCM y mantiene la clave de cifrado en el almacén de credenciales del sistema operativo. `add` etapas de la oficial Codex flujo de inicio de sesión antes de importar la credencial resultante. Cierre Codex antes de cambiar de perfil; un switch exitoso conserva las tareas locales y el historial, luego requiere que se reinicie Codex. Utilice `doctor` para inspeccionar el estado del perfil y `recover` para terminar o revertir una transición interrumpida. `switch` acepta el ID de perfil o su etiqueta.

`reauth` vuelve a autenticar la identidad principal nativa *existentes* con un código de dispositivo OpenAI (#3898) en lugar de inscribir un nuevo perfil. Es la ruta de recuperación del concentrador sin cabeza: no se requiere ninguna aplicación local Codex, ningún binario `codex` y ningún llavero del sistema operativo. El inicio de sesión del dispositivo debe completarse para la misma cuenta ChatGPT que ya tiene la ranura principal nativa; la escritura de credenciales está cercada por la reivindicación exclusiva y una instantánea de ruta/hash/inodo, y la salida del comando lleva solo el ID de flujo, el URL de verificación, el código del dispositivo y el estado. La ruta de inicio de sesión del grupo permanece solo en el grupo y sigue rechazando `__main__`; la superficie equivalente del tablero de instrumentos es el Re-login de la tarjeta principal Codex Auth con control de código del dispositivo.

La matriz de recuperación v1 cubre un proceso OpenCodex que sale después de que un archivo de transacción ha sido publicado por cambio de nombre. No reclama durabilidad en un fallo del sistema operativo o kernel o pérdida de energía repentina: `atomicWriteFileAsync()` no `fsync` ni el archivo ni su directorio padre.

La bóveda cifrada, el diario de conmutación, el marcador de recuperación y la cuarentena del diario viven en el directorio canónico `<real CODEX_HOME>/.opencodex-native-main-profiles`, por lo que cada OpenCodex instancia compartida en Codex casa observa un propietario y un estado de recuperación. La puesta en escena de inicio de sesión de texto sin formato permanece aislada bajo cada directorio `<OPENCODEX_HOME>/native-main-profile-staging`.

Antes de que se admita el tráfico principal nativo o la recuperación del diario, el propietario de por vida acepta el reclamo de credencial exclusivo y elimina solo los residuos de accidentes exactos de `auth.json.ocx.<pid>.<sequence>.tmp`. Cada candidato debe seguir siendo un archivo regular vinculado bajo el canónico inalterado `CODEX_HOME`; está truncado, ruborizado y luego no vinculado. Las sustituciones de enlaces/reparaciones, los cambios de identidad y otras ambiguedades mantienen cerrado el tráfico principal nativo, mientras que los nombres casi perdidos nunca se eliminan automáticamente. Esto protege contra las fallas cooperativas OpenCodex, no un proceso malicioso que ya se está ejecutando como el mismo usuario del sistema operativo. Ese usuario y el sistema de archivos que contiene `CODEX_HOME` siguen siendo de confianza, y el truncamiento no promete el borrado físico del almacenamiento de copia en escritura, instantáneas o remanencia SSD.

Previsualizar las compilaciones utilizadas `<OPENCODEX_HOME>/native-main-profiles`. Ese diseño nunca se importa en silencio. Si `doctor` informa el estado del perfil heredado, detenga cada proxy OpenCodex que comparta el mismo `CODEX_HOME`. Luego, haga una copia de seguridad y mueva el marcador de recuperación coincidente `*.vault.json`, `*.journal.json` y cualquier archivo de cuarentena de diario referenciado juntos al directorio canónico mientras conserva los permisos de solo propietario, o elimine el conjunto de vista previa antiguo y ejecute `ocx account main register` nuevamente. No elija entre varias raíces antiguas ni ejecute ambos diseños mientras cualquier proxy de uso compartido esté activo. En Windows, el estado de vista previa en clave de la identidad inicial plegada por mayúsculas y minúsculas anterior debe restablecerse en lugar de moverse porque su AAD encriptado y la identidad del anillo de claves del sistema operativo no se reutilizan intencionalmente.

<a id="models"></a>

## Modelos

### `ocx models [subcommand]` · `ocx model <subcommand>`

`ocx model` es un alias de `ocx models`. Sin subcomando, lista los modelos sembradas estáticamente en proveedores configurados. `--provider` filtra un proveedor configurado y `--json` devuelve metadatos del modelo. `live` lee el catálogo en ejecución; `add`, `edit`, `remove` y `list-custom` gestionan las entradas de catálogo manuales; `enable`, `disable` y `provider` controlan la visibilidad; `selected` controla una lista de proveedores; `context` controla los límites de contexto del proveedor; y `shadow` gestiona la interceptación de llamadas de sombra de fondo.

Los precios modelo son estimaciones en USD por millón de tokens. `ocx models --json` incluye un objeto `price` con tasas `cost4` y su fuente; `ocx models price --json` guarda `cost` para la anulación guardada e informa las tasas resueltas en `effectiveCost`. Los precios manuales (incluido el cero) tienen prioridad, seguidos del catálogo compartido y las devoluciones de precios oficiales verificadas. Los modelos desconocidos devuelven `null`; no se inventa ningún precio. Los valores predeterminados automáticos se derivan de la lectura y no pueblan `modelCosts` en su configuración, por lo que las actualizaciones del catálogo siguen siendo efectivas. Use `set-price` para ahorrar tarifas específicas del proveedor.

`price --json` también conserva una política de `promptLengthPricing` guardada en `cost`; las cuatro tasas de `effectiveCost` son las tasas base, antes de evaluar la longitud rápida o el nivel de una solicitud. Utilice **Modelos → Precio** o la administración API para editar una directiva de longitud de prompt. Los comandos `set-price` existentes reemplazan las cuatro tarifas base y mantienen la política de umbral plana o personalizada guardada del modelo; `--auto` elimina tanto las tarifas como cualquier política.

Descubra la sintaxis de comandos con `ocx models --help` antes del trabajo en vivo. `list-custom` lee la configuración local; `add` y `remove` salvan localmente a menos que se les dé `--live`. La costumbre local escribe de forma oportunista cuando existe un proxy. El resto de las operaciones de gestión de modelos utilizan el proxy en ejecución. Compruebe la preparación y la versión antes de las llamadas en vivo; la inspección sin conexión no requiere iniciar un proxy. Las anulaciones de nombre de pantalla para modelos descubiertos tienen su propio comando, separado del modelo personalizado `edit`.

| Subcomando | Banderas soportadas | Medidas adoptadas |
| --- | --- | --- |
| `list` (por defecto) | `--provider <name>`, `--json` | Lista de modelos sembrados en proveedores configurados, con precios estimados de entrada/salida. |
| `live` | `--provider <name>`, `--json` | Lea el catálogo en ejecución, incluidos los modelos descubiertos en tiempo de ejecución. Las filas están marcadas `native` / `routed`, `custom`, y `enabled` / `disabled`. |
| `price <provider/model>` | `--json` | Lea la anulación manual guardada y el precio efectivo, incluidos los valores predeterminados automáticos del catálogo. |
| `set-price <provider/model>` | `--input <rate>`, `--output <rate>`, `--cache-read <rate>`, `--cache-write <rate>`, `--auto`, `--json` | Establezca los precios de visualización en USD por 1 millón de tokens. Se requieren entradas/salidas cuando se establece; las tasas de caché omitidas se vuelven cero. `--auto` elimina solo la anulación de este modelo. |
| `add <provider> <modelId>` | `--display-name <name>`, `--context-window <tokens>`, `--modalities <text,image,audio>`, `--reasoning-efforts <levels>`, `--default-reasoning-effort <level>`, `--live`, `--json` | Registre un modelo personalizado localmente o, con `--live`, en el proxy en ejecución. |
| `edit <custom-id>` | `--model-id <id>`, `--display-name <name\|->`, `--context-window <tokens\|0>`, `--modalities <text,image,audio\|->`, `--json` | Edite un modelo personalizado. `-` despeja un campo; `0` borra la ventana de contexto. |
| `remove <custom-id\|provider/modelId>` | `--yes`, `--live`, `--json` | Elimine un modelo personalizado localmente o en el destino en vivo. La eliminación en vivo y la eliminación local de JSON requieren `--yes`; el modo de texto local retiene la confirmación interactiva. |
| `display-name <provider/raw-model-id>` | `--set <text>` o `--clear`, `--json` | Establezca o borre la anulación de visualización del modelo descubierto; conserve el ID de flujo ascendente sin procesar. |
| `order status` | `--json` | Lea el orden/modo guardado, los candidatos enrutados y el estado destacado conocido. |
| `order set` | `--models <CSV>` o `--mode <default\|alphabetical\|provider\|most-used>`, `--json` | Establezca una permutación enrutada completa u obtenga un orden preestablecido. |
| `order reset` | `--json` | Borrar el orden y el modo guardados, conservando la selección destacada. |
| `list-custom` | `--json` | Mostrar todos los modelos personalizados con el `custom-id` los otros subcomandos toman. |
| `enable <provider/model\|native-model>` | `--native`, `--json` | Haga que un modelo sea visible hasta Codex. |
| `disable <provider/model\|native-model>` | `--native`, `--json` | Ocultar un modelo de Codex. |
| `provider <name> <on\|off>` | `--json` | Habilitar o deshabilitar cada modelo de un proveedor en una sola escritura. |
| `selected <provider>` | `--set <id,id...>`, `--clear`, `--json` | Lea o sustituya la lista de permisos del modelo de proveedor. `--clear` elimina la lista de permisos para que se ofrezca cada modelo. |
| `preset show` | `--provider <name>`, `--json` | Lea las versiones preestablecidas enviadas y el modo aplicado, opcionalmente para un proveedor. |
| `preset apply <provider>` | `--all`, `--json` | Aplicar el preajuste seleccionado; `--all` borra la lista de permisos. Un ajuste preestablecido de coincidencia cero deja la selección sin cambios e informa `fallback: "preset-empty"`. |
| `new-policy [on\|off]` | `--provider <name>`, `--json` | Lea o cambie la política de exposición para los modelos recién descubiertos; la omisión del proveedor selecciona la política global. Un proveedor de lectura puede reportar `inherit`. |
| `new-arrivals` | `--json` | Lea los descubrimientos recientes registrados por el proveedor; no fuerza un nuevo descubrimiento aguas arriba. |
| `context <status\|value <tokens> [--set-all]\|provider <name> on [--value <tokens>]\|provider <name> off\|all <on\|off>>` | `--json` | Lea o establezca el límite de la ventana de contexto, globalmente o por proveedor. `value <tokens> --set-all` también vuelve a apuntar a cada proveedor enrutado (como el conmutador del panel de control); sin él, el valor solo se convierte en el predeterminado. `provider ... on --value <tokens>` establece un límite explícito solo para ese proveedor (`--value` Es válido con `on` solamente). |
| `shadow <status\|set> [model\|-]` | `--enabled <on\|off>`, `--json` | Lee o configura el modelo de reemplazo para las llamadas de ayudante de fondo del Codex. `-` borra el modelo. `status` también reporta `sourceModels`, el ayudante lanza las intercepciones proxy (por defecto: `gpt-6-luna`, `gpt-5.6-luna`; clientes a través de 0.144.x usaron `gpt-5.4-mini`, que una anulación explícita `sourceModels` puede restaurar). |

```bash
ocx models live --json                                  # what Codex can actually see right now
ocx models disable anthropic/claude-haiku-4             # hide one routed model
ocx models enable gpt-5.6-sol                           # no slash, so it is treated as native
ocx models provider zenmux off                          # hide a noisy provider wholesale
ocx models selected anthropic --set claude-opus-5,claude-fable-5
ocx models selected anthropic --clear                   # drop the allowlist again
ocx models add deepseek deepseek-v4 --display-name 'DeepSeek V4' --context-window 128000 --modalities text,image
ocx models list-custom --json                           # read the custom-id for edit/remove
ocx models remove deepseek/deepseek-v4 --yes
```

Se enruta un selector de modelo con una barra (`anthropic/claude-opus-5`); un id desnudo se trata como un modelo nativo OpenAI, por lo que `--native` solo se necesita para forzar esa lectura para un id que de otro modo parecería enrutado.

`--modalities` solo acepta `text`, `image`, y `audio`. Codex analiza ese campo como un enum cerrado y rechaza un catálogo completo que contiene cualquier otro valor, por lo que `add`, `edit` y la administración API rechazan el valor malo en lugar de almacenar algo que el escritor del catálogo tendría que eliminar más tarde (#759).

<a id="live-custom-models-and-local-save-outcomes"></a>

### Modelos personalizados en vivo y resultados de guardado locales

Utilice nombres de proveedores configurados e ID de modelo ascendente sin procesar. Para una adición o eliminación en vivo autorizada, inspeccione el objetivo previsto y vuelva a leer después:

```bash
ocx ready --json
ocx status --json
ocx models add <provider> <raw-model-id> --live --display-name 'Research model' --context-window 128000 --modalities text --json
ocx models live --json
```

Guarde el `id` devuelto almacenado. La eliminación usa `ocx models remove <complete-stored-id> --live --yes --json` o un selector de proveedor/modelo inequívoco de ese objetivo. Las etiquetas de visualización y los prefijos de ID no son selectores. No hay reserva local, eliminación protegida por revisión o reintento de ID alternativo. `models list-custom --json` es una lista local, no un registro en vivo leído para otro objetivo.

Sin `--live`, el JSON de añadir/eliminar devuelve `{action, model, needsSync, sync}`. Si no hay proxy, `sync: {"status":"not-attempted","ok":false}`, `needsSync: true` y la salida es 0: el guardado local tuvo éxito y la sincronización oportunista no se intentó. Los fallos o rechazos de una sincronización intentada devuelven un código distinto de cero mientras conservan el guardado. Solo una sincronización aplicada por completo borra `needsSync`; un éxito omitido por la política puede salir con 0 con `needsSync` aún verdadero. La eliminación con JSON requiere `--yes` incluso en un terminal interactivo.

<a id="display-names-and-picker-identities"></a>

### Mostrar nombres e identidades de selector

```bash
ocx models display-name <provider>/<raw-model-id> --set 'Research model' --json
ocx models live --json
```

Este comando divide por la primera barra y conserva cada barra restante en el id de modelo ascendente sin procesar. No sustituya un id de selector público codificado o un alias. `--clear` es la alternativa a `--set` y envía null. Las anulaciones de etiqueta no cambian los precios ni la identidad pública. Un resultado reconocido como guardado pero con actualización fallida tiene `saved: true` y código de salida 1; inspeccione el estado antes de otra escritura.

```bash
ocx models order status --json
ocx models live --json
ocx models order set --models '<complete-public-id-permutation>' --json
ocx models order status --json
```

El pedido manual utiliza los identificadores públicos en `pickerAvailable`, cada candidato enrutado exactamente una vez, con los modelos destacados actuales en su orden inicial requerida exacta. Las entradas en blanco, duplicadas, faltantes, desconocidas y ambiguas se niegan. El CLI vuelve a leer los ajustes y las identidades del modelo inmediatamente antes del PUT manual; el estado modificado devuelve el conflicto. Este es un chequeo observacional, no CAS, así que léalo después. Nunca silenciosamente deja caer identidades natales o modifica la selección ofrecida.

Alternativamente, seleccione `--mode alphabetical`, `--mode provider` o `--mode most-used`. Estos ajustes preestablecidos no preceden al prefijo de la función manual. La mayoría de las lecturas utilizadas son de todos los tiempos, el uso de toda la superficie, retiene a los candidatos no clasificados y rechaza la historia incompleta. Tanto los modos manuales como los modos no predeterminados rechazan los pedidos guardados que contienen ID nativas desnudas. Si se pretende borrar esa orden guardada, use primero `ocx models order reset --json` o `ocx models order set --mode default --json`. No reajuste automáticamente el rechazo.

Las escrituras personalizadas y de orden en vivo incluyen `catalogRefresh`. Solo una actualización confirmada y no degradada sale con 0; una actualización omitida, fallida o degradada devuelve el recibo guardado con código de salida 1. El recibo de un pedido `applied` es la lista destacada, no la convergencia del cliente. Los resultados desconocidos requieren inspección, no una suposición de reversión.

<a id="apply-a-preset-and-verify-selection"></a>

### Aplicar un preajuste y verificar la selección

```bash
ocx models preset show --provider anthropic --json
ocx models preset apply anthropic --json
ocx models selected anthropic --json
ocx models new-policy --provider anthropic --json
ocx models new-policy off --provider anthropic --json
ocx models new-policy --provider anthropic --json
ocx models new-arrivals --json
```

Las escrituras requieren la intención de cambiar la política de selección o descubrimiento. Lee la selección y la política; un ajuste preestablecido guardado puede dejar intacta la selección anterior. `preset apply <provider> --all` es el modo compatible con todos los modelos; el preajuste personalizado del panel de control deshabilitado no agrega otro modo seleccionable.

<a id="mark-one-model-text-only"></a>

### Marcar un solo texto de modelo

Use `ocx provider add mine --adapter openai-chat --base-url https://example.com/v1 --default-model model-a --text-only` al registrar un proveedor, o `ocx provider edit mine --model model-a --text-only` para un proveedor existente. Add puede usar `--model` o su modelo predeterminado; editar requiere `--model`. La bandera actualiza solo los modelos exactos `modelCapabilities.inputModalities` a `["text"]`, preservando otros modelos y ejes.

<a id="cached-quota-history"></a>

### Historial de cuotas en caché

Los cheques automáticos de agotamiento de la cuenta OpenAI distinguen los créditos de uso comprados de los tickets de restablecimiento. El gasto permanece desactivado de forma predeterminada: habilite **Usar créditos** para esa cuenta (almacenada en `creditCodexAccountIds`). Solo que la aceptación junto con un saldo gastable positivo fresco o créditos ilimitados puede mantener una cuenta elegible después de que el uso incluido alcance el 100%; un límite de rechazo o exceso de edad aún bloquea esa evidencia. La evidencia de crédito expira después de cinco minutos, y los encabezados de uso no renuevan su reloj. `pause-exhausted` utiliza esta regla. Restablecer tickets por sí solo nunca otorga espacio libre automático, y una respuesta de solo créditos no puede borrar un tiempo de reutilización de la solicitud. El bloqueo de la cuenta principal por defecto sigue siendo una política local separada y no se levanta por el interruptor de créditos.

`ocx account history openai <pool-account-id> [--limit 1-200] [--json]` lee las observaciones almacenadas sin ponerse en contacto con el proveedor. La salida separa el tiempo de observación real, WHAM o fuente de encabezado de respuesta, familia de ventanas y porcentaje de uso. Como máximo 200 observaciones por cuenta se conservan durante 30 días, con límites de almacenamiento global.

Cuando una misma cuenta de grupo sigue informando dos ventanas de siete días distintas (por ejemplo, 100% usado con un restablecimiento en unas horas y después 24% usado con un restablecimiento la semana siguiente), la fila de la cuenta incluye `weeklyQuotaConflicts` con el uso, el restablecimiento, la fuente y la hora de la última observación de cada ventana. La columna QUOTA de `ocx account list openai --quota` añade `(weekly windows conflict)`, y la tarjeta del panel de control explica que el restablecimiento que muestra puede no devolver la asignación completa. OpenCodex no elige ninguna de las dos ventanas y no cambia por ello la selección de cuenta, los bloqueos estrictos ni el uso de créditos. La advertencia desaparece cuando ha pasado la hora de restablecimiento más temprana.

La actualización ordinaria de tokens conserva la historia. La reautenticación, eliminación o reemplazo de cuenta retira la publicación anterior. No se incluyen las sondas principales nativas realizadas antes de publicar un inicio de sesión. La historia que falta significa observaciones insuficientes, no uso cero. Este comando no gasta cuota. Las estimaciones efectivas, cuando se apoyan en observaciones, llevan las limitaciones a continuación.

La producción histórica también incluye estimaciones efectivas de tokens informados cuando las observaciones de la misma ventana y el uso atribuible los respaldan. Cada estimación incluye un recuento de muestras y baja confianza. El redondeo de las cuotas, el uso externo y la continuidad supuesta de la etiqueta de registro limitan la inferencia; no es la asignación de token de su proveedor. La evidencia del libro mayor faltante o truncado devuelve evidencia insuficiente. `--limit` controles muestran el historial, no la entrada de estimación limitada.

### `ocx account routes anthropic`

Lea las rutas guardadas del modelo Anthropic OAuth, reemplácelas de una matriz local JSON o deslícelas:

```sh
ocx account routes anthropic --json
ocx account routes anthropic --file routes.json
ocx account routes anthropic --clear
```

El archivo está limitado a 64 KiB. El servidor valida cada ruta y la almacena bajo `anthropicAccountPool.routes`; las escrituras requieren el proxy en ejecución. Use los ID de cuenta almacenados de `ocx account list anthropic --json`. Las reglas solo afectan al grupo habilitado y nunca afirman que una cuenta tiene derecho a un modelo. Los registros de solicitudes identifican una regla coincidente como `route:#<n>` (posición de lista basada en 1), sin su nombre de operador.

Los ayudantes de visión y búsqueda web coinciden con su propio modelo de forma independiente y pueden fallar localmente cuando su ruta estricta no tiene una cuenta elegible. Véase [Anthropic enrutamiento de cuenta de ayudante](/es/reference/configuration/providers/#anthropicaccountpool-experimental).


`reset-affinity` confirma que se borraron todos los vínculos de sesión de Anthropic sin exigir cuentas, cambiar selección o pausas. Se ejecuta en Home; un Child informa del Home sin enviar. HTTP 404 termina con 4, 409 con 5 y otros errores o resultado no confirmado con 1.

Cuando el saldo es desconocido, `quotaUnknownReason` explica `no_balance_source`, sin lector; `passive_not_observed`, sin observación pasiva; `read_failed`, lectura fallida; `not_read`, lector aún no usado, por ejemplo clave pausada; o `not_reported`, lectura correcta sin saldo. Filas de sondeo incluyen `quotaReadAt`, milisegundos epoch del último intento, incluso fallido. Solo `quotaMode: "probe"`, como OpenRouter, DeepSeek, Ollama Cloud, Moonshot, Venice o Abliteration, informa un saldo medido. La salida humana usa `unsupported: balance UNKNOWN (no balance source)` o `probe: mo 12%; read 3 min ago`, nunca cero por desconocido. OAuth sin observación muestra `UNKNOWN (not observed yet)`. CLIs antiguas ignoran los nuevos campos; motivos desconocidos se omiten.

<a id="resume-if-healthy"></a>

#### Reanudar solo si está sana

`ocx account resume <provider> <account-id-or-alias> --if-healthy` permite un supervisor sin atención, pero solo reanuda después de leer con éxito el uso de esa cuenta: WHAM para Pool Codex o el token almacenado para Anthropic. Pausas automáticas `oauth_organization_disabled` y `account_permission_denied` nunca se levantan así. Un token Anthropic caducado no se renueva en esta prueba: `credential_expired` exige login nuevo. Otros OAuth y la principal Codex devuelven `health_check_unsupported`; pools de claves rechazan la opción. Un rechazo termina con 3 y motivo, o `{ "ok": false, "resumed": false, "reason": ... }` con JSON. Un login o reautenticación explícitos limpian pausas automáticas de la credencial anterior; una manual espera `ocx account resume`.

Un enfriamiento Anthropic 429 con ventanas de cuota identificadas se puede levantar al observar margen en todas: el barrido de instancias OAuth activas consulta aproximadamente cada minuto, o diez mientras sigan agotadas. Un 429 solo con Retry-After conserva su plazo. Clear-cooldown sigue siendo el override manual.

`ocx models` sin subcomando lista modelos locales guardados, semillas y caché de descubrimiento de ese proceso, no el catálogo del proxy. `reasoningEfforts` solo aparece con JSON: null es escala desconocida o no consultada, también si exigiría abrir el llavero; `[]` es escala explícitamente vacía o razonamiento desactivado, como `noReasoningModels`. Usa `ocx models live` para el catálogo activo. `new-policy [on\|off\|admit]` permite `admit`, que añade llegadas a `selectedModels` personalizado; sin proveedor selecciona política global y una lectura de proveedor puede decir inherit.
