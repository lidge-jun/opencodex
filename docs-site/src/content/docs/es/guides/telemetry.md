---
title: Telemetría y privacidad
description: Estadísticas diarias anónimas de uso, consentimiento y límites para agentes, desactivación, vista previa de datos y conservación del recolector.
---

opencodex incluye telemetría diaria anónima para conocer las versiones, plataformas, canales de instalación, tipos de proveedor y familias generales de modelos utilizados, así como las causas de fallo de las solicitudes. El endpoint público de solo lectura `GET /v1/stats` ofrece estadísticas del proyecto para el [panel público](/es/dashboard/): instalaciones activas y nuevas, actividad de 365 días, minutos activos, resultados, cinco categorías de tokens, distribución diaria y por periodo de proveedores y modelos, las 50 versiones principales, sistemas y arquitecturas, canales y causas de error. `/v1/stats` nunca devuelve los hashes diarios de instalación (`installDayHash`) ni los de límite de tasa (`ip_hash`).

La telemetría está **activada de forma predeterminada**, pero **no se envía nada hasta que una persona vea el aviso**.

<a id="how-consent-and-the-default-on-rule-work"></a>

## Consentimiento y activación predeterminada

Una instalación nueva, o una que actualice a una versión con telemetría sin una decisión guardada, empieza en `awaiting-notice`. En ese estado no envía datos.

El envío solo se activa después de que una persona vea la información o registre su decisión:

1. **Aviso del dashboard (`TelemetryConsentCard`)**: aparece en un proxy independiente o Home al iniciar o actualizar sin decisión guardada ni desactivación por entorno. Los Child de Remote Link delegan la gestión al Home. La casilla **Compartir estadísticas diarias anónimas de uso** está marcada. **Continuar** guarda `decision: "accepted"`, o `"declined"` si se desmarca, además de `decidedAt` y `noticeShownAt`, mediante `PUT /api/telemetry`. Escape, el fondo, cerrar o cargar la página sin continuar no registra **nada**. No hay endpoint de solo aviso; sin decisión vuelve a aparecer en la siguiente apertura hasta elegir en el aviso, **Detalles del proxy** o la CLI.
2. **Pregunta de terminal interactiva**: `ocx start`, `ocx init` y `ocx service install` muestran qué se envía, qué se excluye, que los agregados son públicos en `opencodex.me/dashboard`, cómo verlos con `ocx telemetry status --json` y cómo desactivar con `ocx telemetry disable`, `OCX_TELEMETRY=0`, `DO_NOT_TRACK=1` o **Detalles del proxy**. Después preguntan una vez `Share anonymous usage statistics? [Y/n]` si stdin y stdout son TTY (`isatty`), `OCX_SERVICE` no está definida e `isAgentDriven()` es false. Intro o `y` guarda `decision: "accepted"`, `decidedAt` y `noticeShownAt`; `n` guarda `decision: "declined"`.
3. **Activación explícita**: el interruptor **Compartir estadísticas anónimas de uso** de **Detalles del proxy**, que ya muestra los datos, guarda `decision: "accepted"`. `ocx telemetry enable [--json]` exige una terminal humana interactiva, ambos flujos TTY, sin `OCX_SERVICE` ni `isAgentDriven()`, muestra la misma información y pide confirmación `[Y/n]`, Sí predeterminado.

`resolveTelemetryStatus` (`src/telemetry/consent.ts`) aplica esta precedencia:

| Condición, primera coincidencia | Estado efectivo | `reason` |
| --- | --- | --- |
| `OCX_TELEMETRY` es `0`, `false`, `off` o `no` | Desactivada | `env-ocx-telemetry` |
| `DO_NOT_TRACK` es `1`, `true` o `yes` | Desactivada | `env-do-not-track` |
| `telemetry.decision === "declined"` | Desactivada | `declined` |
| `telemetry.decision === "accepted"` | Activada | `accepted` |
| `telemetry.decision` no está definida y `telemetry.noticeShownAt` sí | Activada | `default-on` |
| Ambas no están definidas | Desactivada | `awaiting-notice` |

<a id="agent-driven-starts-never-enable-telemetry"></a>

## Los arranques de agentes nunca activan la telemetría

Un agente de IA o sistema de automatización nunca debe responder ni reconocer el aviso en tu nombre:

- En agentes o CI, detectados mediante `CLAUDECODE`, `CODEX_THREAD_ID`, `CURSOR_TRACE_ID`, `CI` y otros indicadores de `isAgentDriven()`, terminales sin TTY o servicios (`OCX_SERVICE=1`), esos comandos omiten la pregunta. Imprimen como máximo un aviso por versión, registrado en `<OPENCODEX_HOME>/.telemetry-deferred`, sin escribir `noticeShownAt` ni `decision`. Se mantiene `awaiting-notice` hasta que uses personalmente el dashboard o una terminal fuera del agente.
- `PUT /api/telemetry` exige una sesión humana vigente del dashboard (`hasHumanDashboardSession`). El token administrativo o una sesión de dispositivo recordado no bastan: HTTP `403`, `code: "agent_consent_required"`.
- `ocx telemetry enable` exige stdin y stdout TTY, ausencia de `OCX_SERVICE` y no ser `isAgentDriven()`. De lo contrario termina con `1`, `agent_consent_required` o `tty_required`, y dirige al dashboard.
- `ocx config set telemetry` y `ocx config unset telemetry` se rechazan para todos. `ocx config import` ignora cualquier bloque importado `telemetry` y conserva intacto el estado persistente.
- Desactivar con `ocx telemetry disable`, `OCX_TELEMETRY=0` o `DO_NOT_TRACK=1` siempre está permitido, también en scripts y agentes.

Como al dar una estrella en GitHub, estas comprobaciones cubren las rutas habituales de CLI y API frente a agentes (`AGENT_ENV_VARS`) y tokens administrativos. La política también prohíbe que un agente local edite `config.json` o cree una sesión loopback para registrar tu consentimiento.

<a id="how-to-turn-telemetry-off"></a>

## Desactivar la telemetría

Puedes desactivarla en cualquier momento:

1. **Instalador de Windows**: la página de MSI resume los datos, enlaza la [declaración de privacidad](/es/reference/code-signing/#privacy) y muestra marcada **Enviar estadísticas anónimas de uso**. Desmárcala, o pasa `OCX_TELEMETRY_CHOICE=optout` a `msiexec /qn`. La aplicación guarda `"decision": "declined"` al primer arranque de cada cuenta, antes de resolver o iniciar un proxy. En una instalación nueva guarda primero la decisión en `telemetry-state.json` hasta que exista `config.json`, para que siga funcionando `ocx init`. La elección es de todo el equipo, también en despliegues silenciosos de administrador, y se conserva al actualizar desde la aplicación. Solo `send` mantiene la opción; `optout` sin distinción de mayúsculas, o cualquier otro valor, la desactiva. Cada decisión se aplica una vez por cuenta; continuar en un instalador posterior sin cambiar la casilla conserva la decisión anterior y no sobreescribe una elección posterior del dashboard. Si guardar falla, el proxy que inicia la aplicación recibe `OCX_TELEMETRY=0` y se reintenta en segundo plano y al abrir de nuevo. Dejar la casilla marcada no inicia el envío ni reactiva una cuenta que lo desactivó: aún se muestra el aviso. Un servicio de `ocx service install` puede arrancar sin Desktop; la decisión de un instalador posterior lo alcanza al abrir la aplicación. Usa `ocx telemetry disable` para detener el envío de inmediato.
2. **Aviso del dashboard**: desmarca **Compartir estadísticas diarias anónimas de uso** y pulsa **Continuar**.
3. **Detalles del proxy**: abre Inicio en el [dashboard](/es/guides/web-dashboard/), sección **Telemetría**, `#proxy-telemetry`, y desactiva **Compartir estadísticas anónimas de uso**.
4. **CLI**:

   ```bash
   ocx telemetry disable
   ```

   Guarda `"decision": "declined"` en `config.json` y, solo después de persistirla, elimina `<OPENCODEX_HOME>/telemetry-id.json`. Si `mutatePersistedConfig` devuelve `unavailable` o lanza un error al activar o desactivar, la CLI termina con error y sin mensaje de éxito; no elimina el archivo si no se guardó el rechazo.
5. **`OCX_TELEMETRY=0`**: defínela en el entorno del proxy; acepta `false`, `off` o `no`, sin distinguir mayúsculas.
6. **`DO_NOT_TRACK=1`**: acepta también `true` o `yes`, sin distinguir mayúsculas.

Las variables solo llegan a procesos que las heredan. Un servicio systemd, launchd o del Programador de tareas no ve las exportaciones de tu terminal interactiva: configúralas en el entorno del servicio o usa un control persistente. `ocx telemetry status` consulta al proxy activo y muestra su estado efectivo.

Ambas variables prevalecen sin editar `config.json`. Al observarlas al arrancar en `src/server/background-lifecycle.ts`, aunque no se active el temporizador, o en cada ciclo del planificador, se guardan mediante escritura atómica sin seguir enlaces `ineligibleThroughDay` con el día UTC actual (`YYYY-MM-DD`) y `envOptOutActiveSince` en `<OPENCODEX_HOME>/telemetry-state.json`, y se elimina `<OPENCODEX_HOME>/telemetry-id.json`. El marcador cubre todos los días que siga ejecutándose el proxy iniciado con la variable. Al detenerse ordenadamente, o en el primer ciclo sin ella tras un fallo, se extiende `ineligibleThroughDay` hasta ese día. Ningún día cubierto, incluido el final, se envía después; el siguiente envío apto crea otro ID. Con la variable activa, el dashboard deshabilita el interruptor e identifica cuál prevalece.

<a id="how-to-see-the-exact-payload"></a>

## Ver los datos exactos

`GET /api/telemetry` y `ocx telemetry status [--json]` generan `preview` para el **mismo día UTC completo que enviaría el planificador**: el apto pendiente más antiguo dentro de siete días, con `previewEligible: true`. Si no hay ninguno, por falta de consentimiento, por ser el día de la decisión, por desactivación o porque ya se enviaron, muestran el último día completo para inspección con `previewEligible: false`, sin prometer su envío.

- **CLI, lectura humana y vista previa JSON**:

  ```bash
  ocx telemetry status
  ```

- **CLI, instantánea estructurada**:

  ```bash
  ocx telemetry status --json
  ```

  Consulta `GET /api/telemetry` si hay proxy activo; si está detenido, genera la misma instantánea con `config.json` y `usage.jsonl` locales.
- **Dashboard**: pulsa **Vista previa del JSON** en el aviso o junto al interruptor de **Detalles del proxy** para ver **Qué se envía**, **Nunca se envía** y el JSON exacto.

Antes del primer informe, o después de eliminar `telemetry-id.json` al desactivar, no hay ID en disco y `installDayHash` aparece como 64 ceros: `0000000000000000000000000000000000000000000000000000000000000000`.

<a id="what-is-collected"></a>

## Qué se recoge

Cada informe corresponde a un día UTC completo (`YYYY-MM-DD`). `validateTelemetryPayloadV1` de `src/telemetry/contract.ts` lo valida antes de salir del proxy y al llegar al recolector. Se rechazan claves desconocidas y valores ajenos a las listas predefinidas.

Ejemplo real producido por `buildTelemetryPayloadV1` (`src/telemetry/payload.ts`):

```json
{
  "schemaVersion": 1,
  "batchId": "c2bf1164-d009-4111-a8a6-902d55f727c7",
  "day": "2026-11-06",
  "installDayHash": "456b15e3a95d8665bbd9a40ac2cae49986aec3f03b78b6dd601df49abfc406d4",
  "newInstall": false,
  "env": {
    "version": "2.99.0",
    "releaseChannel": "latest",
    "os": "darwin",
    "arch": "arm64",
    "installChannel": "npm-global"
  },
  "activeMinutes": 312,
  "requests": {
    "completed": 840,
    "failed": 12,
    "incomplete": 3,
    "aborted": 5
  },
  "models": [
    {
      "providerKind": "anthropic",
      "modelFamily": "claude-opus",
      "requests": 400,
      "inputTokens": 184200,
      "cacheReadTokens": 6410000,
      "cacheWriteTokens": 512000,
      "outputTokens": 96400,
      "reasoningTokens": 28100
    },
    {
      "providerKind": "chatgpt",
      "modelFamily": "gpt-6",
      "requests": 460,
      "inputTokens": 210500,
      "cacheReadTokens": 5890000,
      "cacheWriteTokens": 0,
      "outputTokens": 112300,
      "reasoningTokens": 44800
    }
  ],
  "errors": {
    "rate-limit": 7,
    "upstream-fault": 5
  }
}
```

| Campo | Contenido |
| --- | --- |
| `schemaVersion` | Entero fijo `1`. |
| `batchId` | UUID v4 aleatorio generado al construir el informe. |
| `day` | Día UTC completo (`YYYY-MM-DD`) entre los últimos siete días UTC completos. |
| `installDayHash` | `sha256(installId + ":" + day)`, 64 caracteres hexadecimales minúsculos; cambia cada día UTC. |
| `newInstall` | `true` solo en el primer informe del `telemetry-id.json` local actual; después `false`. |
| `env.version` | Versión que cumple `^\d+\.\d+\.\d+(-preview\.\d{8}(\.\d+)?)?$`, como `2.40.1`, `2.6.15-preview.20260701`, `2.6.15-preview.20260701.1` o `2.7.9-preview.20260712.2`; el cliente elimina metadatos `+build` y `validateTelemetryPayloadV1` los rechaza. |
| `env.releaseChannel` | `"latest"` o `"preview"`. |
| `env.os` | `"darwin"`, `"linux"`, `"win32"` u `"other"`. |
| `env.arch` | `"x64"`, `"arm64"` u `"other"`. |
| `env.installChannel` | `"npm-global"`, `"pnpm-global"`, `"bun-global"`, `"mise"`, `"standalone"`, `"desktop"`, `"docker"`, `"source"` o `"unknown"`. |
| `activeMinutes` | Minutos UTC distintos (`0`–`1440`) de `day` con alguna solicitud registrada en `usage.jsonl`. |
| `requests` | Recuentos por resultado predefinido: `completed`, `failed`, `incomplete` y `aborted`. |
| `models` | Hasta 64 pares únicos `(providerKind, modelFamily)` por día. Si hay más, se conservan las 63 filas principales por solicitudes y tokens y el resto se suma en `"other"` / `"other"`. Cada intento de `combo` se atribuye a su proveedor y modelo; `models[].requests` puede superar `requests`. Cada fila incluye `requests` y cinco contadores sin solapamiento: `inputTokens`, entrada sin caché; `cacheReadTokens`; `cacheWriteTokens`; `outputTokens`, salida sin razonamiento; y `reasoningTokens`. Su suma es `usageDisplayTotalTokens`. |
| `errors` | Solicitudes no completadas por causa predefinida: `transport-unsent`, `transport-ambiguous`, `upstream-declined`, `rate-limit`, `quota-exhausted`, `credential-rejected`, `policy-refusal`, `parameter-rejected`, `ciphertext-refusal`, `payload-too-large`, `payload-rejected`, `upstream-fault`, `empty-output`, `client-cancelled`, `local-refusal`. |

Valores predefinidos de `providerKind` (26): `openai`, `chatgpt`, `anthropic`, `claude-subscription`, `google`, `vertex`, `xai`, `deepseek`, `moonshot`, `qwen`, `zai`, `minimax`, `mistral`, `openrouter`, `groq`, `cerebras`, `together`, `fireworks`, `cursor`, `kiro`, `copilot`, `devin`, `ollama`, `lmstudio`, `local-other`, `other`.

Valores predefinidos de `modelFamily` (19): `gpt-6`, `gpt-5`, `gpt-4`, `o-series`, `codex`, `claude-opus`, `claude-sonnet`, `claude-haiku`, `gemini-3`, `gemini-2`, `grok`, `deepseek`, `qwen`, `kimi`, `glm`, `minimax`, `mistral`, `llama`, `other`.

<a id="what-is-never-collected"></a>

## Qué nunca se recoge

Los datos de telemetría nunca incluyen:

- Prompts, respuestas, trazas de razonamiento, argumentos de herramientas o cuerpos de solicitudes y respuestas.
- Claves API, tokens OAuth de acceso o renovación, cookies ni tokens administrativos o del plano de datos.
- ID de cuenta, correos, identificadores de organización, facturación o planes.
- Nombres o claves de proveedores elegidos por el usuario, IDs personalizados ajenos a `modelFamily`, que pasan a `"other"`, ni `baseUrl` o URLs de proxy personalizados.
- Nombres de host, IP local o del proveedor, MAC, números de serie, directorios de trabajo o rutas.
- Errores libres del proveedor o trazas de pila.
- Uso del día de consentimiento o aviso (`formatUtcDay(decidedAt ?? noticeShownAt)`) ni anterior: solo días completos posteriores, `day > formatUtcDay(decidedAt ?? noticeShownAt)`.
- Uso de un día cubierto por `OCX_TELEMETRY=0` o `DO_NOT_TRACK=1`, incluido el último día del proceso con esa variable y el del fin de la desactivación: `day <= ineligibleThroughDay`; tampoco se envía nada mientras exista `envOptOutActiveSince`.

<a id="public-profile-and-rank-opt-in"></a>

## Perfil y posición públicos, con activación explícita

Por separado, puedes conectar un **perfil público** para aparecer en la [clasificación](/es/dashboard/#leaderboard) y ver tu posición del último día, semana y mes. Está desactivado hasta que lo conectes personalmente y no cambia tu elección de telemetría anónima. Requiere que esté activa porque usa los mismos agregados diarios locales.

- **Conectar**: desde *Perfil público y clasificación* en Inicio, o `ocx telemetry profile connect --handle <handle> [--name <display name>] [--avatar <colour>]` en terminal interactiva, con No predeterminado. Elige nombre público de 3–24 letras minúsculas, dígitos o guiones, nombre visible y color de una paleta. No pide correo ni cuenta. Guarda el secreto del recolector en `<OPENCODEX_HOME>/telemetry-profile.json`, modo `0600`; nunca se muestra, imprime ni devuelve por la API del dashboard. El recolector solo guarda su SHA-256. Se rechaza a agentes con `agent_consent_required`, terminales no interactivas con `tty_required` y sesiones recordadas.
- **Información pública**: nombre público, nombre visible, color, posición y, por día, solicitudes, cinco categorías de tokens y totales por `modelFamily`. Las respuestas de perfiles y clasificación llevan `x-robots-tag: noindex`; la [página del dashboard](/es/dashboard/#leaderboard) es pública y las representa en el navegador.
- **Envío**: desde el día completo posterior al de conexión, como máximo uno por ciclo y siete días atrás, `POST /v1/profiles/me/days` envía esos totales. No incluye ID de instalación, hash diario, ID de lote, versión, plataforma, canal, tipo o nombre de proveedor, error, prompt, respuesta, clave, cuenta ni ruta. Usa su propio temporizador. Se suspende si la telemetría está desactivada por entorno, rechazada o pendiente del aviso; el perfil permanece conectado y se reanuda al activarla.
- **Consultar**: `ocx telemetry profile status` muestra perfil, siguiente día apto y posiciones; `ocx telemetry profile status --json` incluye el JSON exacto como `preview`. La tarjeta muestra el perfil y posiciones.
- **Desconectar**: desde la tarjeta o `ocx telemetry profile disconnect`, siempre permitido, también a agentes, sin proxy o con telemetría desactivada. Elimina perfil y todos sus días del recolector. Sin conexión, la eliminación queda pendiente, cesa el envío y se reintenta en cada ciclo y arranque. Desconectar y conectar reemplaza el secreto.
- **Clasificación**: se clasifican los totales positivos por periodo con ranking de competición; los empates comparten posición. Los datos son autodeclarados y se comprueban coherencia y límites diarios. Cada día se acepta una sola vez; gana el primer envío.
- **Control de abuso**: nombres reservados; nombres visibles de 1–32 letras, dígitos, espacios y `. _ ' -` que no parezcan direcciones web; cinco creaciones por red y hora, límites de envíos por perfil, eliminación a los 14 días de perfiles que nunca envían y posibilidad de ocultarlos por los mantenedores.
- **Inicio de sesión con GitHub**: aún no está disponible; requiere una aplicación OAuth que los mantenedores no han creado.

<a id="storage-retention-and-collector-source"></a>

## Almacenamiento, conservación y código del recolector

- **ID local de instalación y rotación diaria del hash**: cuando la telemetría envía su primer informe, el proxy crea `<OPENCODEX_HOME>/telemetry-id.json` (modo `0600`) con un UUID v4 aleatorio. El UUID sin procesar nunca sale de su máquina; cada informe envía solo `sha256(installId + ":" + day)`. Como la fecha UTC se aplica al hash junto con el UUID, el hash de una instalación cambia cada día y no puede vincularse entre días en el servidor. Rechazar la telemetría o ejecutarla con `OCX_TELEMETRY=0` o `DO_NOT_TRACK=1` elimina `telemetry-id.json` de inmediato, y volver a habilitarla más adelante genera un UUID nuevo.
- **Agregación de un día en streaming**: `src/telemetry/aggregate.ts` recorre `usage.jsonl` con `scanUsageLedgerCooperatively`; acumula solo el día UTC en `onEntry`, sin guardar filas en memoria.
- **Planificación y exclusión de días anteriores**: `src/telemetry/scheduler.ts` usa un temporizador sin retener el proceso, fuera de la ruta de solicitudes, a los 30–60 segundos y cada seis horas con variación aleatoria. Cada ciclo tiene `AbortSignal`, cancelado por `stopProcessLoops` o `nudgeTelemetryScheduler`, relee `config.json` y envía como máximo **un** día completo, el pendiente más antiguo de los últimos siete, a `https://telemetry.opencodex.me/v1/events`, con diez segundos de timeout. Exige `day > formatUtcDay(decidedAt ?? noticeShownAt)` y `day > ineligibleThroughDay`. Justo antes de enviar vuelve a comprobar consentimiento y entorno. HTTP `429` o `503` guarda `retryAfterUntil` en `<OPENCODEX_HOME>/telemetry-state.json`; respeta `Retry-After` o espera unos 15–20 minutos. Los marcadores de días enviados se depuran a los 30 días. Un recolector no disponible falla silenciosamente sin afectar al proxy ni marcar el día como enviado.
- **Un informe por instalación y día**: el recolector evita duplicados por `(day, install_day_hash)` en un lote condicional atómico D1 de `daily_installs`, `daily_totals`, `daily_models` y `daily_errors`. Reenviar el mismo `installDayHash` y día no suma de nuevo.
- **Hash por hora para límites de tasa, sin IP en bruto**: se admiten **120 informes por hora** y clave, considerando NAT/CGNAT, con HTTP `429` y `Retry-After`. La clave usa únicamente `cf-connecting-ip` de Cloudflare: IPv4 tal cual o prefijo IPv6 /64; ignora `x-forwarded-for`. Aplica sal secreta y hora UTC: `sha256(RATE_LIMIT_SALT + "\0" + bucketHour + "\0" + key)` en `rate_limits`. La tarea horaria `15 * * * *` elimina cada bloque dentro de unas dos horas y 15 minutos.
- **Instalaciones-día, grupos pequeños y datos no autenticados**: `totals.activeInstalls` e `installs` de `GET /v1/stats` suman instalaciones diarias, no usuarios únicos del periodo. `totals.avgDailyActiveInstalls` calcula `install-days / days in range`, redondeado a un decimal. La protección de grupos pequeños se aplica por día y clave antes de sumar: `providers`, `models`, `versions`, `platforms`, `channels`, `errors` y `dailyByProvider` solo incluyen valores comunicados por **10 instalaciones distintas** ese día. `daily_models`, `daily_errors`, `daily_provider_installs` y `daily_family_installs` cuentan cada informe una vez por clave. Las versiones, plataformas y canales pequeños se agrupan en `"other"`, publicado si llega a diez; proveedores, modelos y errores pequeños se omiten. `totals`, `daily` y `heatmap` no se filtran, por lo que pueden aproximarse valores por resta. `POST /v1/events` **no está autenticado** y permite informes falsificados dentro de sus límites. Nueve informes falsos y uno real sobre una clave rara alcanzan diez y permiten restar la parte falsa. La instalación sigue anónima; el límite de tasa encarece el abuso, sin impedirlo. Por ello el dashboard indica **datos comunicados por instalaciones de opencodex**.
- **Conservación**: `daily_installs`, con hash diario, versión, canal de versión, sistema, arquitectura, canal de instalación, `new_install` y `active_minutes`, se elimina a los 400 días. Los contadores diarios del proyecto `daily_totals`, `daily_models` y `daily_errors`, sin filas individuales por instalación, se conservan indefinidamente.
- **Despliegue primero en el recolector y código auditable**: cliente en [`src/telemetry/`](https://github.com/lidge-jun/opencodex/tree/main/src/telemetry) y Worker de Cloudflare con D1 en [`services/telemetry-collector/`](https://github.com/lidge-jun/opencodex/tree/main/services/telemetry-collector). Ambos usan `src/telemetry/contract.ts`; las nuevas categorías o contratos se despliegan primero en el recolector, antes de una versión del cliente que los envíe. Consulta [Servidor y entorno de ejecución](/es/reference/configuration/server/#telemetry-telemetry) para el esquema y las variables.
