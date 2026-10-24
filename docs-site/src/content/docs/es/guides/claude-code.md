---
title: "Claude Code"
description: "Utilice cualquier modelo enrutado de Claude Code — opencodex sirve el Anthropic Messages API y el descubrimiento de modelos de pasarela en el mismo puerto."
---

opencodex sirve `POST /v1/messages` (más `count_tokens`) junto con `/v1/responses`, por lo que Claude Code puede usar todos los proveedores enrutados: OAuth inicios de sesión, grupos de cuentas, conmutación por error de claves y sidecars incluidos, con cero trabajo de autenticación adicional.

En las rutas de Devin (incluyendo SWE-2) alcanzadas a través de la Messages API, las llamadas de texto y herramientas esperan a que se complete el giro aguas arriba para que su firma de razonamiento tardío pueda preceder a la respuesta. Esto evita que el resultado final de Claude Code se vuelva vacío; el razonamiento y el progreso de mantenimiento aún fluyen durante la generación. La memoria intermedia comparte el límite de traducción de 32 MiB de la solicitud y la cancelación detiene al productor. Esta corrección de orden de salida no resuelve el rechazo separado de Cognition de algún texto del sistema generado. Conserva las instrucciones del sistema y las limitaciones de seguridad.

Para una ruta Anthropic en OAuth almacenada o una clave Anthropic API, Fast nativo está disponible en
`claude-opus-5-5`, `claude-opus-5`, y `claude-opus-4-8`: elige el modelo `--fast` fila (listado cuando las filas rápidas están habilitadas) o establecer `fastMode: true`. El propio Claude Code `/fast` toggle no es Traducido a petición: el `speed` El campo que envía no sobrevive a la traducción. El proxy envía la solicitud rápida de Anthropic y registra la `usage.speed`; sólo El uso rápido confirmado obtiene la estimación de costo equivalente a 2x API. Un rechazo reconocido y específico en la ruta de solicitud del adaptador principal obtiene un reenvío de velocidad estándar presupuestado, y un nuevo giro puede incurrir en que se negó viaje de ida y vuelta de nuevo. Las cuentas de suscripción Pro/Max necesitan créditos de uso; Las cuentas de equipo/empresa necesitan habilitación de organización, y las claves API necesitan aprovisionamiento acceso a la investigación-previsión. Véase
[Anthropic Configuración rápida](/es/reference/configuration/providers/#anthropic-fast-anthropic-speed)
para el modelo exacto y alcance de recuperación.

<a id="tier-defaults-for-cli-and-external-launchers"></a>

## Valores predeterminados de nivel para CLI y lanzadores externos

En la pestaña Claude Code, seleccione un valor predeterminado de Opus, Sonnet, Haiku o Fable y **Guardar**. Estos `claudeCode.tierModels` valores predeterminados se pasan a los nuevos lanzamientos `ocx claude`. No cambian el modelo principal seleccionado actualmente, el esfuerzo de razonamiento o las asignaciones familiares de escritorio.

Las aplicaciones que lanzan `claude` directamente no reciben el entorno del lanzador `ocx`. Después de guardar, seleccione **Previsualizar la configuración de Claude**, revise los cambios `ANTHROPIC_DEFAULT_*_MODEL`, luego **Aplicar a la configuración Claude**. Esto cambia la configuración del usuario Claude del host OpenCodex, no el equipo de un navegador remoto. Inicie un nuevo proceso Claude para usar los nuevos valores; la operación no detiene ni reinicia las sesiones existentes. No configura el enrutamiento o la autenticación, por lo que el llamante directo ya debe estar conectado al OpenCodex.

Los alias de enrutamiento seleccionados se emparejan con etiquetas `ANTHROPIC_DEFAULT_*_MODEL_NAME`, utilizando los mismos nombres legibles que el selector de modelos. La vista previa incluye los ID y los cambios de etiqueta; el alias sigue siendo el ID del modelo enviado. Una etiqueta existente se administra solo si coincide exactamente con el nombre generado para su alias actual. Otras etiquetas, incluyendo valores vacíos, se conservan. Una etiqueta introducida manualmente idéntica a ese nombre generado es indistinguible de una etiqueta administrada.

Solo se aplican los ID de nivel explícitamente seleccionados. Un nivel no establecido deja intacto su ID de modelo existente y su etiqueta de visualización. Reemplazar un alias con un ID de origen u otro no alias también elimina su etiqueta generada coincidente. La vista previa muestra la eliminación de etiquetas como un reemplazo vacío; las etiquetas personalizadas y las configuraciones no relacionadas permanecen intactas. Los archivos que faltan son compatibles, pero los archivos vacíos o corruptos existentes son rechazados. Los cambios desde la vista previa requieren una nueva vista previa. Aplique brevemente mueve el documento actual a un directorio privado `model-default-backups/apply-*/settings.json` bajo el directorio de configuración Claude, valida el documento capturado y luego publica exclusivamente. Nunca reemplaza el nuevo archivo de un escritor concurrente, incluso durante la reversión. Evite editar o iniciar Claude mientras aplica: otro lector puede ver el breve intervalo de archivo faltante. El sistema de archivos debe admitir movimientos del mismo volumen y enlaces duros; las operaciones no compatibles fallan sin sobrescribirlas. Después de una aplicación interrumpida o una restauración automática fallida, inspeccione esta ubicación de copia de seguridad y reconcilie las ediciones más recientes antes de restaurar. El comportamiento del sistema de archivos Windows / Linux debe verificarse por separado; una prueba local no es una prueba multiplataforma. Verifique el proveedor/modelo resuelto en los registros de solicitudes: la selección de un nivel no es prueba del modelo real servido. Esto es especialmente útil para los clasificadores externos que solicitan Sonnet.

<a id="claude-oauth-account-pool-experimental"></a>

## Claude Grupo de cuentas OAuth (experimental)

El passthrough de suscripción nativo Anthropic retiene los encabezados de respuesta ascendente `anthropic-ratelimit-*` en la transmisión, las respuestas JSON y las respuestas de error ascendente, por lo que los consumidores compatibles Claude Code statusLine pueden leer las observaciones de cuota del proveedor. Las observaciones que faltan no están llenas de valores inventados. Este relé no cambia la selección de cuenta o el comportamiento de reintento.

Puede iniciar sesión en varias cuentas Claude a través del panel Proveedores (`ocx login anthropic` / add-account). De forma predeterminada, cada solicitud utiliza solo la cuenta **activo**.

El **grupo experimental de cuentas Claude**, de activación explícita (`anthropicAccountPool.enabled`), añade afinidad de sesión y selección de cuentas según el uso. No controla la recuperación ante un 429: si hay dos o más cuentas utilizables, una solicitud limitada puede pasar a otra aunque el grupo esté desactivado. Para excluir una cuenta de esa recuperación, ponla en pausa. En las sesiones **nuevas**, `anthropicAccountPool.strategy` elige entre las cuentas elegibles. `quota`, la estrategia predeterminada, selecciona el menor uso conocido en la ventana definida por `quotaWindow` (`five-hour` por defecto, o `weekly` / `max-utilization`) al superar `autoSwitchThreshold`. `round-robin` reparte las sesiones uniformemente (`stickyLimit`, por defecto `1`); `fill-first` mantiene la cuenta activa hasta que entre en enfriamiento, necesite reautenticarse o alcance el umbral, y después pasa a la siguiente. El grupo está **desactivado de forma predeterminada** y sigue siendo experimental.

El panel de control enumera las condiciones para las que está destinado el grupo: suscripciones que posee o está autorizado a usar, el cliente genuino Claude Code y una persona que supervisa la sesión. Anthropic no ha respaldado la agrupación automatizada de cuentas, las cuentas de una organización pueden compartir una cuota (por lo que otra cuenta puede no agregar capacidad), y el cambio de cuentas no protege contra la aplicación del proveedor. OpenCodex no envía solicitudes de mantenimiento y, por defecto, no actualiza Claude tokens ni lee el uso en segundo plano: el uso se lee cuando el panel de control, la aplicación de la barra de menús o un comando `ocx` lo solicitan. Los umbrales son preferencias de selección, no límites de uso o facturación. Esta es la guía del producto, no el asesoramiento legal; consulte los términos actuales de Anthropic.

Para vincular un modelo a cuentas Claude almacenadas en particular, agregue reglas `anthropicAccountPool.routes` ordenadas mientras el grupo está habilitado. Cada regla tiene un seguro `name`, un glob completo de `match` sensible a mayúsculas, una matriz `accounts` de ID de cuenta almacenados y un `fallback` opcional (por defecto `false`). La primera regla de coincidencia limita las selecciones activas, manuales, de afinidad, estrategia y 429 de recuperación a sus cuentas. Una afinidad saludable fuera de esa regla se ignora para esta solicitud, pero se mantiene para otros modelos; la opción enrutada no la sobrescribe. Sin reserva, una ruta vacía devuelve un 401 local, o 429 con `Retry-After` cuando todas sus cuentas declaradas se están enfriando, antes de contactar con Anthropic. La respuesta del cliente no nombra la ruta; el registro proxy registra `route:#<n>`, donde `n` es la posición basada en la regla 1. `fallback: true` usa el grupo ordinario solo cuando la ruta no tiene una cuenta elegible, incluida su orden sucesora de llenar primero; si sus cuentas almacenadas se están enfriando, el 429 devuelto usa el tiempo de reutilización más temprano en ese grupo expandido, incluso si se ha eliminado una cuenta de ruta guardada. Un modelo sin igual sigue la política de agrupación existente; la desactivación de la agrupación deja las reglas guardadas inactivas y restaura el comportamiento de 429 de cuenta activa y de presencia. Una regla es una lista de permisos del operador, no una prueba del derecho del modelo.

Contrato operativo cuando está habilitado:

- Upstream **429** enfría esa cuenta, borra sus afinidades y puede rotar a otra cuenta elegible dentro de la misma solicitud (limitada). El tiempo de reutilización utiliza un `Retry-After` utilizable cuando está presente, de lo contrario el último tiempo de reinicio válido entre las ventanas Anthropic marca `rejected`, incluidas las ventanas semanales. Los plazos iniciales válidos no se acortan a un límite de tiempo fijo. Un rechazo sin un plazo utilizable vuelve a un retroceso predeterminado de 60 segundos.
- Responses reportan la utilización de 5 horas y semanal de la cuenta de servicio, y cualquiera de las dos que lleva la respuesta se registra para esa cuenta - cada ventana de forma independiente, y un rechazo cuenta, así como un éxito. La selección consciente del uso funciona desde el tráfico ordinario, sin esperar una encuesta del panel de control. Los encabezados conservan las ventanas de cuota específicas del modelo y no posponen las sondas de uso ni borran el estado no disponible de una sonda de uso fallida. Las mediciones cuyo tiempo de reinicio conocido ha pasado se descartan como desconocidas, incluidas las ventanas conservadas específicas del modelo. Los valores sin un restablecimiento conocido se conservan; los datos faltantes nunca se informan como uso cero.
- Affinity es **proceso-local** (perdido en el reinicio proxy).
- Un derecho de cuenta o rechazo de facturación **403** completo y estructurado puede rotar antes de la salida. Los casos reconocidos incluyen acceso no Claude Code, una suscripción vencida / inactiva y un saldo de crédito insuficiente Anthropic. La cuenta rechazada pierde sus afinidades y se enfría durante `Retry-After`, o diez minutos sin una fecha límite. Permiso genérico, modelo/acceso a recursos, política y errores no reconocidos permanecen en el terminal. La recuperación respeta las rutas del modelo y los límites de envío; si no es elegible ningún reemplazo, se devuelve el 403 original. Esto también funciona con la agrupación proactiva. Un 403 después de la salida del asistente nunca cambia de cuenta.
- Antes de la salida, un **401** authentication_error estructurado exacto sin código de error y el mensaje "OAuth token de acceso ha sido revocado." marca la cuenta de envío OAuth como que requiere un nuevo inicio de sesión y borra sus afinidades de sesión. Antes de la salida, una cuenta elegible en el mismo grupo puede asumir el control dentro de los límites de envío existentes. Sin reemplazo elegible, se devuelve el 401 original; la cuenta rechazada permanece excluida hasta el inicio de sesión. Otros errores 401 mantienen su comportamiento existente.
- Las fallas de credenciales de actualización de token conservan la política `needsReauth` existente. La renovación de la suscripción no requiere una reautenticación, pero la cuenta espera a que expire su tiempo de reutilización.
- Si cada cuenta elegible se está enfriando, el proxy devuelve **429** (no 401) con `Retry-After` cuando se conoce.
- Recuperación, incluyendo 429 conmutación por error, utiliza `quotaWindow` para clasificar los reemplazos elegibles sin cambiar los límites de tiempo de reutilización o conmutación por error existentes; `round-robin` ignora `quotaWindow`.
- `autoSwitchThreshold: 0` solo desactiva la conmutación basada en el uso **Proactivo**. La selección de nueva sesión y la recuperación de 429 aún consultan `quotaWindow`, por lo que la ventana es inerte solo por debajo de `round-robin`. `fill-first` evalúa su umbral de drenaje en la ventana seleccionada.

Véase [Configuración](/es/reference/configuration/providers/#anthropicaccountpool-experimental).

<a id="native-messages-with-account-pooling"></a>

### Messages nativo con agrupación de cuentas

El Messages nativo administrado muestra el esfuerzo validado de la persona que llama en Logs y `usage.jsonl`, incluyendo cada intento: un esfuerzo explícito como `xhigh` o `low`, `none` para el pensamiento desactivado o `budget:<tokens>` para un presupuesto de pensamiento habilitado. Un esfuerzo explícito tiene prioridad sobre el pensamiento alternativo. El pensamiento adaptativo sin un esfuerzo explícito permanece en blanco. Estas etiquetas describen los controles de solicitud; no confirman qué esfuerzo aplicó la corriente arriba o cambia el cuerpo del cable.

Un grupo de cuentas Anthropic habilitado prefiere Messages nativo para rutas Anthropic directas elegibles cuando ninguna de las dos banderas de despliegue nativas desactiva explícitamente esa ruta. En los proveedores → Anthropic → Account pooling → **Cómo funciona la selección de cuentas**, **Preservar solicitudes nativas Claude** almacena `anthropicAccountPool.nativeMessages` (valor predeterminado true). Apagarlo selecciona el puente heredado para las solicitudes agrupadas. Con la agrupación desactivada, la configuración de implementación nativa explícita mantiene su comportamiento.

`protocols.rollout.managedMessagesNative: false` explícito desactiva ambas rutas nativas; `managedMessagesNativeOAuth: false` desactiva OAuth nativo. Se ha cerrado la configuración actual no válida. La casilla de verificación muestra la preferencia guardada, por lo que una casilla de verificación habilitada no anula estos indicadores ni una ruta que requiera traducción de proxy. Las solicitudes nativas conservan los puntos de interrupción del historial/caché, la afinidad de la sesión, las rutas del modelo, las exclusiones de pausa/enfriamiento y la recuperación previa a la salida limitada.

Las solicitudes nativas CLI y de código de escritorio reconocidas conservan su preámbulo de facturación/identidad y los encabezados beta de características compatibles. Las solicitudes generadas mantienen la forma de identidad SDK. Las herramientas personalizadas declaradas usan nombres consistentes en referencias diferidas y adiciones/eliminaciones en línea, mientras que los argumentos, esquemas y marcadores de caché permanecen sin cambios. Se rechazan las declaraciones ambiguas. Un conmutador de cuenta puede iniciar una caché en frío; esto no transfiere cachés ni garantiza accesos de caché. Para los cambios de herramientas en línea en los mensajes del sistema, envíe la versión beta `inline-tools-2026-09-15` requerida; el constructor nativo de origen la conserva con bloques escritos independientemente del reconocimiento del cliente. Véase [Claude 's contrato de herramienta en línea](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages).

<a id="quickstart"></a>

## Inicio rápido

```bash
ocx claude
```

`ocx claude` asegura que el proxy se está ejecutando, luego inicia Claude Code con el entorno cableado:

| Variable | Valor |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:<port>` |
| `ANTHROPIC_AUTH_TOKEN` | Solo cuando el proxy requiere una clave API - de lo contrario NO está configurado, por lo que su inicio de sesión claude.ai (suscripción + conectores) se mantiene activo |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` (descubrimiento de selector nativo `/model`) |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Umbral de compactación de contexto automático (predeterminado `829800`); solo se inyecta cuando el contexto automático está habilitado |
| `ANTHROPIC_MODEL` | `claudeCode.model` (opcional) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `claudeCode.tierModels.haiku ?? claudeCode.smallFastModel` (opcional; legado) `ANTHROPIC_SMALL_FAST_MODEL` también) |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,FABLE}_MODEL` | `claudeCode.tierModels.*`; en un lanzamiento de suscripción, una ranura no establecida obtiene el `claude-opus-5-5[1m]` / `claude-sonnet-5-5[1m]` / `claude-fable-5-1[1m]` nativo, por lo que `--model opus`, `sonnet` y `fable` mantienen su contexto de 1M |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,FABLE,HAIKU}_MODEL_NAME` | La etiqueta `/model` para una ranura de nivel que OpenCodex establece en un alias encaminado, tal como `gpt-6.1-sol (native)` para `ocx-claude-native--gpt-6.1-sol`. Sin ella, Claude Code etiquetas que rema con el alias. El alias mantiene el ID de modelo seleccionado. Cuando el env del sistema está encendido, el entorno launchd y el gancho de la carcasa obtienen el mismo par de ranura y etiqueta. Una ranura o etiqueta que usted mismo establezca se deja sola |
| `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | `1` cuando `alwaysEnableEffort` está encendido (condicional) |
| `ENABLE_TOOL_SEARCH` | `claudeCode.toolSearch` cuando está establecido (condicional; apagado por defecto - ver [Los esquemas de herramientas MCP llenan el contexto](#troubleshooting) ) |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | Anulación de contexto heredado cuando se establece `maxContextTokens` (condicional) |
Las variables que tú mismo exportas siempre ganan. Los argumentos adicionales pasan por: `ocx claude -p "hello"`.

Una excepción es que aproximadamente *donde* una variable viene de, no sobre la precedencia. El paquete Bun en entorno de ejecución carga automáticamente un proyecto `.env` / `.env.local`, por lo que un `ANTHROPIC_API_KEY` extraviado en el directorio desde el que se inicia solía parecer idéntico a una exportación deliberada, y deshabilitó silenciosamente una suscripción saludable a claude.ai a favor de la facturación API. `ocx claude` ahora ignora las credenciales Anthropic que solo un dotenv de proyecto introdujo. Un valor que exportó en su shell aún gana, en cada modo auth. Para usar una clave API deliberadamente, expórtela (`export ANTHROPIC_API_KEY=...`) en lugar de dejarla en un archivo de proyecto.

<a id="native-fallback-when-claude-routing-is-off"></a>

### Repliegue nativo cuando el enrutamiento Claude está desactivado

`ocx claude` solía salir con un error cuando se deshabilitó el enrutamiento Claude. Ahora lanza el binario nativo `claude` en su lugar, por lo que el comando sigue siendo útil con el enrutamiento desactivado:

| Donde el enrutamiento está desactivado | ¿Qué sucede? |
| --- | --- |
| `claudeCode.enabled: false` en configuración | Lanzamiento nativo, con un aviso de que el enrutamiento está desactivado |
| El proxy en ejecución informa `enabled: false` desde `GET /api/claude-code` | Lanzamiento nativo; volver a habilitar la intercepción bajo demanda |
| `claudeCode.enabled` ausente o `true` | Enrutado a través del proxy, sin cambios |

Solo un `false` explícito desencadena la reserva, por lo que un proxy anterior al campo permanece enrutado. Un proxy que falta no es un disparador tampoco - con enrutamiento activado, `ocx claude` todavía inicia el proxy.

Una sesión nativa no debe heredar el estado proxy, por lo que el respaldo elimina los valores que puede **probar**
OpenCodex posee: `ANTHROPIC_BASE_URL` solo cuando apunta a la propia dirección de bucle de este proxy y puerto configurado *y* la admisión emparejada token es uno de los proxy emitidos; el
`CLAUDE_CODE_*` palancas de descubrimiento y auto-contexto; y ranuras de modelo que solo se resuelven a través del Proxy (enrutado alias y `provider/model` ID). Cualquier otra cosa es tuya y se conserva — un sin relación `http://localhost:8080` puerta de enlace y su propio `sk-ant-` Ambas credenciales sobreviven.

Si el valor predeterminado del selector `/model` guardado es un modelo solo de proxy, la sesión nativa vuelve a `claudeCode.model` cuando se puede usar de forma nativa y, de lo contrario, le advierte que pase `--model <Anthropic model>`. Un argumento explícito de `--model` siempre gana.

<a id="auth-mode"></a>

## Modo de autenticación

Claude Code necesita un token en `ANTHROPIC_AUTH_TOKEN` para hablar con una puerta de enlace, pero al establecer esa variable también deshabilita su inicio de sesión claude.ai y sus conectores. ¿Cuál de los dos desea depende de algo opencodex puede mirar hacia arriba, por lo que por defecto lo hace.

Deje **Modo de autenticación** en **Auto** (el valor predeterminado) en **Conectar → Claude** y opencodex decide en cada lanzamiento:

| Lo que encuentra | Lo que hace |
| --- | --- |
| Un inicio de sesión Claude (cuenta `~/.claude.json` OAuth, `.credentials.json`, el llavero macOS o un `ANTHROPIC_API_KEY` exportado) | Deja el token sin configurar, por lo que su suscripción y los conectores siguen funcionando |
| No Claude auth en absoluto | Inyecta un token de marcador de posición, por lo que Claude Code deja de pedirle que inicie sesión y rutas a través del proxy |
| No puede decir (llavero ilegible, archivo corrupto) | Asume la suscripción e imprime una advertencia: nunca mueve a un suscriptor de pago al proxy en una lectura fallida |

Esto se vuelve a calcular cada lanzamiento, no recordado, por lo que el inicio o salida se recoge en el siguiente `ocx claude` sin nada que reconfigurar.

Elija **Suscripción** o **Proxy** explícitamente cuando lo desee. Una opción explícita se almacena en `claudeCode.authMode` y la detección nunca la anula, incluso después de iniciar sesión o salir más tarde. Vuelve a Auto para devolver la decisión.

En macOS, la conexión automática (`claudeCode.systemEnv`) sigue la misma resolución, por lo que una llanura `claude` lanzada fuera de `ocx` se comporta de la misma manera. Ese archivo es una instantánea actualizada cuando se inicia el proxy o se guarda la configuración, mientras que `ocx claude` siempre se resuelve en vivo.

<a id="system-environment-integration-macos"></a>

## Integración del entorno del sistema (macOS)

<a id="claude-desktop-modes-gateway-default-and-first-party"></a>

## Claude Modos de escritorio: gateway (predeterminado) y first party

Claude Desktop puede usar OpenCodex en uno de dos modos mutuamente excluyentes. Elija en **Conectar → Claude Desktop → Modo de conexión** en el tablero o con `ocx claude desktop apply
--first-party|--gateway`.

> Los perfiles de biblioteca de escritorio y `_meta.json` deben ser archivos regulares de como máximo 4 MiB. OpenCodex también rechaza el perfil generado o la salida de metadatos por encima de ese límite antes de reemplazar los archivos. Realice una copia de seguridad y reduzca manualmente la configuración de gran tamaño; un rechazo de tamaño no trunca los datos existentes. Las tiendas propiedad de la conexión mantienen sus límites más estrictos existentes.

<a id="gateway-default"></a>

### Puerta de enlace (predeterminado)

Las nuevas instalaciones usan **gateway** de forma predeterminada. Su perfil de terceros, que se describe a continuación, cambia toda la aplicación a OpenCodex como su puerta de enlace de inferencia. El chat se ejecuta localmente a través de OpenCodex y las funciones solo claude.ai no están disponibles. Los indicadores heredados `--static` / `--hybrid` / `--discovery-only` también seleccionan la puerta de enlace.

Los perfiles de pasarela usan distintos alias de modelo con un prefijo `claude-fable-5-` para que Claude Desktop 2.31226 pueda ofrecer su control de esfuerzo sin tratar cada modelo enrutado como el mismo modelo activo. Estos alias no cambian el modelo ascendente ni las etiquetas y los valores predeterminados de la familia que se muestran. Los alias anteriores siguen siendo decodificables para las sesiones existentes. Vuelva a aplicar el perfil de la puerta de enlace y salga / vuelva a abrir completamente el escritorio para cargar la nueva lista. El selector estático utiliza el menú de esfuerzo alternativo de Desktop; no anuncia una escalera autorizada por proveedor, y la normalización del esfuerzo normal del proveedor seleccionado aún se aplica. Este sigue siendo un mecanismo de compatibilidad específico de la versión del cliente.

Gateway apply rechaza los archivos de configuración ilegibles o no regulares, incluidos los enlaces de metadatos colgantes, antes de crear un nuevo perfil. Si la actualización de metadatos falla, apply restaura el contenido anterior del perfil o elimina un perfil que acaba de crear, pero solo mientras el perfil aún contiene lo que se escribió; si otro programa lo cambió mientras tanto, apply mantiene esa versión y los informes "retroceder perfil omitido". Apply vuelve a comprobar el perfil antes de la copia de seguridad y el reemplazo; si detecta una edición concurrente, se niega con `desktop_profile_changed`. Revisar la edición y volver a aplicar. Si la restauración del perfil también falla después de un error de metadatos, la razón informada incluye ambos errores; reconcilia el perfil y los metadatos antes de volver a intentarlo.

<a id="first-party-opt-in"></a>

### Primera parte (opcional)

:::caution[Riesgo para la cuenta]
El modo de primera parte envía su tráfico de suscripción Claude a través de un proxy de interceptación local. Anthropic puede tratar esto como una violación de sus términos y suspender la cuenta. Gateway es el default; elija la primera parte solo si acepta ese riesgo.
:::

El escritorio en sí no está reconfigurado: permanece conectado a claude.ai, y la pestaña Chat, los conectores, las sesiones en la nube y el control remoto siguen funcionando. OpenCodex solo escribe estas variables en el bloque `env` de `~/.claude/settings.json` (honrado por `CLAUDE_CONFIG_DIR`):

```json
{
  "env": {
    "HTTPS_PROXY": "http://opencodex:<per-install token>@127.0.0.1:10200",
    "NODE_EXTRA_CA_CERTS": "<home>/.opencodex/claude-intercept/ca.pem",
    "NO_PROXY": "127.0.0.1,localhost,::1,0.0.0.0"
  }
}
```

`NO_PROXY` mantiene el tráfico de bucle, como un servidor local HTTP MCP en `127.0.0.1`, `localhost`, un nombre `*.localhost`, `::1` o `0.0.0.0`, fuera del proxy, que solo tuneliza HTTPS a hosts remotos. Un servidor en otra dirección `127.x` necesita que esa dirección se agregue a `NO_PROXY` usted mismo. Si ya ha establecido `NO_PROXY`, OpenCodex agrega solo las entradas de bucle invertido que faltan y registra su cambio en `opencodex-no-proxy.json` junto a `settings.json`. Desactivar first-party devuelve su valor original cuando OpenCodex podría registrarlo y no lo ha cambiado desde entonces; de lo contrario, se mantiene el valor actual, incluidas las entradas agregadas.

Claude Desktop first-party enruta su pestaña Código y subagentes a través de OpenCodex. El Claude Code CLI independiente tiene un interruptor de primera parte separado. Ambos clientes leen el mismo proxy `~/.claude/settings.json` y la configuración de CA: si solo un conmutador está encendido, el otro cliente aún transita el proxy local, donde termina TLS, pero sus solicitudes Messages retransmiten a Anthropic sin cambios. Otros Anthropic caminos retransmiten sin cambios y los anfitriones no relacionados siguen siendo túneles ciegos. Con el interruptor CLI encendido, el `claude` independiente también enumera los modelos enrutados en `/model`; ver [Selector de modelos en el CLI](#model-picker-in-the-cli).

:::note[Proxy del sistema en Windows: Clash, v2rayN y proxies corporativos]
Cuando la intent del selector está desactivada en el inicio de OpenCodex, su relé Windows permanece desatado. Selector de giro el modo en adelante lo inicia dentro del servicio en ejecución; OpenCodex no necesita un reinicio. Para instalaciones de selección o instalaciones pendientes sin perfil de selección aplicado, un proxy de sistema Windows se entrega a la pestaña Código como `HTTPS_PROXY`, y ese valor tiene prioridad sobre el proxy OpenCodex en `~/.claude/settings.json`. La pestaña Código entonces va alrededor de OpenCodex y los modelos enrutados fallan allí, mientras que el CLI independiente sigue funcionando. Un perfil de selector seleccionado aplicado utiliza el proxy de salida fijo de Desktop mientras está disponible, incluso cuando La falta de confianza deja al selector pendiente y `claude.ai` Retransmite a ciegas. Consejos de bypass del proxy del sistema Se aplica cuando no hay un perfil de selector disponible seleccionado. Añadir `api.anthropic.com` a la lista de bypass del sistema proxy de su cliente proxy (en Clash Verge,
`system_proxy_bypass`), a continuación, cierre completamente y vuelva a abrir Claude Desktop. `ocx doctor` informa esto bajo "Claude Proxy de escritorio de primera parte vs Windows sistema". No puede evaluar un script PAC o detección automática de proxy (WPAD, "Detectar automáticamente la configuración"), por lo que informa de ellos como desconocidos; Con cualquiera de los dos, haz que el guión regrese `DIRECT` por `api.anthropic.com` o desactivar la detección. Si el La configuración de primera parte es obsoleta, te pide que ejecutes `ocx ensure` En lugar de informar `ok`.
:::

Los subagentes en los modelos enrutados (no Claude) no usan los hilos de mensajes del lado del servidor de Claude Code, porque solo Anthropic almacena ese estado. OpenCodex rechaza una solicitud roscada para tal modelo, y Claude Code reenvía ese giro, y los giros posteriores, con la conversación completa.

El modo se mantiene como `claudeCode.desktopMode`. Las instalaciones que ya se aplicaban en cualquiera de los dos modos lo conservan, incluidas las instalaciones de origen desde antes de que persistiera el modo. Un modo explícito tiene prioridad; de lo contrario, una fila de pasarela seleccionada propia, una huella dactilar de pasarela aplicada o configuraciones propias de origen en `~/.claude/settings.json` determinan el modo existente antes del valor predeterminado de la pasarela. Una sincronización de catálogo o actualización de lista nunca escribe un perfil de puerta de enlace sobre una instalación de origen resuelta. Un CLI -only first-party env no es evidencia de que Desktop esté en modo first-party. La conmutación primero aplica el reemplazo, luego elimina la configuración del otro modo (solo los valores OpenCodex escritos: un `HTTPS_PROXY` o `NODE_EXTRA_CA_CERTS` extranjero, por ejemplo, un proxy corporativo, nunca se sobrescribe y en su lugar se rechaza la aplicación). Un reemplazo fallido conserva la conexión anterior. Si la retirada de la configuración anterior falla después de escribir el reemplazo, el comando informa de una limpieza incompleta; resuelva ese error antes de reiniciar Desktop. Una puerta de enlace comprometida mantiene su modo guardado y marcador de perfil incluso cuando falla la limpieza de la configuración de primera parte. Cierre completamente y vuelva a abrir el escritorio después de un cambio exitoso. `ocx ensure` refresca un env obsoleto de primera parte cuando la integración está ACTIVADA y lo elimina cuando está APAGADO. Establecer `claudeCode.intercept.enabled: false` para deshabilitar el proxy por completo; no se puede aplicar de primera parte. Se rechaza una solicitud de una instalación existente de origen cuando la intercepción está deshabilitada; las nuevas instalaciones aplican puerta de enlace. En un cliente conectado, el proxy se ejecuta en el concentrador, por lo que `ocx claude desktop apply` utiliza el perfil de puerta de enlace.

<a id="picker-mode-opencodex-models-in-the-first-party-code-tab-picker"></a>

### Modo de selector: modelos opencodex en el selector de pestaña de código de primera parte

El modo Selector es parte del modo first party. En macOS y Windows está activado de forma predeterminada cuando se selecciona first-party, a menos que se establezca `claudeCode.intercept.picker: false`. Cambia el selector de pestañas de código de escritorio de primera parte para que enumere los modelos disponibles de opencodex por nombre. La primera vez que está habilitado, macOS puede pedirle que confíe en una autoridad de certificación local en el llavero de inicio de sesión, y Windows puede pedirle que confíe en el almacén raíz del usuario actual. Esa autoridad está limitada a `claude.ai` y sus subdominios. OpenCodex protege su identidad de firma exportable en el almacén de credenciales del sistema operativo y reutiliza el mismo certificado y clave validados en los reinicios normales. No se almacena ninguna clave de firma de selector de texto sin formato en el directorio de configuración OpenCodex. Todavía se aplican la validación de CA restringida completa y la verificación de confianza del sistema operativo, incluida la huella digital exacta con una hoja verificada en Windows. Con la misma identidad aprobada y un almacén de credenciales disponible, reiniciar OpenCodex no agrega ni elimina la configuración de confianza del certificado macOS. El reinicio y el estado nunca instalan confianza: si la confianza falta, se revoca o se desconoce, el selector permanece pendiente. Ejecute `ocx claude desktop picker on` o `ocx claude desktop picker trust` explícitamente para otorgar confianza, incluida la confirmación Windows cuando sea necesario. El inicio también intenta eliminar una clave de firma del selector en el disco antes de verificar si la interceptación está habilitada. La limpieza es el mejor esfuerzo y no permite la interceptación ni el bloqueo del inicio.

La migración de una sola vez desde una identidad de selector anterior puede requerir el consentimiento para eliminar su confianza anterior. Si la limpieza no puede terminar, el selector permanece indisponible y el perfil aplicado utiliza un relé ciego hasta que la limpieza tenga éxito; `ocx claude desktop picker status` informa que el estado. macOS puede pedirle por separado que desbloquee el llavero o apruebe el acceso de una aplicación a las credenciales almacenadas. Estos mensajes de acceso nativos aún pueden ocurrir en el reinicio o la actualización. En Windows, `on` o `trust` explícito puede mostrar una confirmación para agregar la raíz.

El modo Selector sigue sin soporte en Linux: OpenCodex no inicia ningún trabajo de CA, tienda de credenciales o proxy de selector allí. La intercepción principal Claude sigue estando disponible con la propiedad, enlace simbólico, permiso de archivo y Windows ACL comprueba la protección de sus archivos locales de CA.

El modo Selector permite hasta 64 KiB de encabezados en las solicitudes entrantes y respuestas ordinarias HTTP, preservando las cookies de sesión del navegador. Los encabezados de respuesta ascendente más grandes devuelven 502 y registran `upstream:headers-too-large`, sin valores de cookies ni rutas de solicitud. Las conexiones actualizadas continúan retransmitiendo bytes directamente después del protocolo de enlace de solicitud.

El modo Selector utiliza HTTP/2 con Claude Desktop, por lo que las transmisiones de chat de larga duración ya no utilizan las conexiones de Desktop a claude.ai. Las versiones anteriores podían dejar el chat atascado en "Sesión de carga cronometrada" mientras el modo selector estaba activado. Si el chat deja de cargarse con el modo selector activado, apáguelo con `ocx claude desktop picker off` e informe del problema.

Mientras el modo selector está activado, Claude Desktop llega a la red a través de OpenCodex. Si OpenCodex se detiene, el Escritorio estará sin conexión hasta que lo reinicie completamente o desactive el modo de selección. Compruebe el estado con `ocx claude desktop picker status`; use `ocx claude desktop picker trust` para repetir el paso de confianza, o apáguelo con `ocx claude desktop picker off`. El tablero tiene el mismo interruptor de selección bajo **Conectar → Claude Desktop**. Después de seleccionar el perfil de selector, cierre completamente y vuelva a abrir Claude Desktop.

El modo Selector es parte del modo de primera parte, por lo que el [Riesgo de cuenta de primera parte](#first-party-opt-in) también se aplica a él. El catálogo de escritorio y CLI reescribe los límites de fila y metadatos de uso compartido: si la adición de modelos enrutados supera un límite, OpenCodex devuelve el catálogo original de Anthropic sin cambios en lugar de publicar una lista parcial.

<a id="use-opencodex-models-from-the-desktop-code-tab-first-party-bindings"></a>

### Utilice los modelos opencodex en la token Código de escritorio (enlaces de origen)

En el modo first-party, el selector de modelos de la pestaña Código pertenece a claude.ai: sus filas (Opus 5.5, Sonnet 5, Haiku 4.5 y los modelos anteriores bajo **Más modelos**) provienen de su cuenta, y ninguna configuración local puede agregar una fila opencodex. Lo que llega a OpenCodex es el identificador de modelo Anthropic del selector en cada solicitud, por lo que une una fila de selector a una ruta opencodex:

```bash
ocx claude desktop bind claude-sonnet-4-6 xai/grok-4.7
ocx claude desktop bind claude-opus-4-6 native/gpt-6.1-sol
ocx claude desktop unbind claude-opus-4-6
```

o utilice **Conectar → Claude Desktop → Fichas de código del modelo** en el panel de control. La selección de **Soneto 4.6** en la pestaña Código es servida por `xai/grok-4.7`. El selector guarda la etiqueta Anthropic, y el modelo todavía se presenta como ese modelo Claude por el indicador del sistema Claude Code, así que prefiere filas que no use de otra manera (las entradas **Más modelos** son buenas candidatas). Los enlaces surten efecto en la siguiente solicitud; El escritorio no necesita un reinicio.

- Las rutas usan el vocabulario de ruta de escritorio: `provider/model`, o `native/<slug>` para el grupo nativo OpenAI. Una ruta debe ser una de las listas del panel de control como disponible.
- Un identificador de selector con fecha (`claude-haiku-4-5-20251001`) coincide con una unión sin fecha (`claude-haiku-4-5`), y `[1m]` y las selecciones de modo rápido siguen la misma unión.
- Los enlaces se almacenan en `claudeCode.intercept.modelMap` y se aplican solo al tráfico Claude Code que llega a través del proxy de intercepción local: la pestaña Código del escritorio y el `claude` CLI independiente en modo first-party. `ocx claude` sesiones y el punto final público `/v1/messages` las ignoran; el `claudeCode.modelMap` global todavía se aplica en todas partes, y un enlace lo gana para el mismo id.
- `ocx claude desktop status --json` informa de las uniones en efecto bajo `firstParty.modelBindings`.

<a id="claude-code-cli-first-party"></a>

### Claude Code CLI de primera mano

Encienda el interruptor CLI en Conecte → Claude, o ejecute `ocx claude config set --first-party on`; use `off` para deshabilitarlo. El interruptor es inmediato y rechaza `{enabled:false, cliFirstParty:true}` antes de que se guarde cualquier campo; también puede negarse a activarse si la intercepción local no está disponible, la CA no puede prepararse, la configuración no se puede leer o una configuración proxy extranjera posee las claves. Desactivar persiste incluso cuando la intercepción no está disponible; deshabilitar el enrutamiento Claude solo deja intacta una configuración propia env. Para el tráfico de terminal totalmente nativo con solo Desktop first-party activado, configure `NO_PROXY='*'` en el shell. Esto aún conlleva el riesgo de la cuenta de primera parte indicado anteriormente. Deshabilitar el enrutamiento Claude deja intactas las configuraciones de propiedad env. Mientras el oyente vinculado sigue ejecutándose, cada solicitud Messages se retransmite sin cambios; después de que se detiene, el `claude` simple no puede conectarse hasta que OpenCodex se ejecute o Desktop/ CLI sea desactivado. Nativo `ocx claude` establece `NO_PROXY=*` solo para un propietario env sin un extranjero heredado `HTTPS_PROXY` / `https_proxy`. Con un proxy externo, conserva ese valor y advierte que la intercepción propiedad de la configuración aún se aplica; desactiva o desactiva la configuración de Desktop/ CLI first party. La interfaz de usuario distingue la incertidumbre sobre si la configuración todavía apunta a su proxy (desconocido), un proxy opencodex que contiene tokens con una CA extranjera (extranjero: arreglar HTTPS_PROXY / NODE_EXTRA_CA_CERTS) y un proxy de bucle de retorno sin token al lado de una CA extranjera (local: la propiedad no está confirmada; quite HTTPS_PROXY si no se usa). Con ajustes aplicados coincidentes y un oyente vinculado pero con el enrutamiento desactivado Claude, desactivado significa que las solicitudes de retransmisión no se modifican mientras está vinculado; apague la primera parte para eliminar los ajustes. Una URL propia sin oyente se detiene; un oyente vinculado con una CA propia pero con puerto o token no coincidente se rompe incluso cuando el enrutamiento está desactivado. Con una intención en, detenido o roto, más pantallas de interceptación no elegibles routingOff: Claude enrutamiento o la intercepción está apagado, o esta máquina es un cliente de otro concentrador opencodex; habilitar la interceptación en esta máquina o a su vez de primera parte para eliminar la configuración. Cuando se detenga la interceptación, utilice **Iniciar interceptación** o `ocx claude intercept start` para volver a intentar dentro del servicio OpenCodex en ejecución. Guardar la configuración de la primera parte también lo inicia automáticamente. Un rechazo informa de enrutamiento deshabilitado, rol de cliente, un puerto público efímero, un puerto ocupado o un fallo de inicio. Para un puerto ocupado, libérelo o configure `claudeCode.intercept.port`. El inicio actualiza un entorno proxy Claude administrado existente solo después de que el proxy de intercepción se enlaza correctamente, utilizando su puerto vinculado; un puerto ocupado deja la configuración Claude sin cambios. Si un par ya está enlazado en un puerto diferente, la respuesta nombra ambos puertos; use el puerto enlazado o restaure el valor configurado. CLI no se aplica intent sin proxy; una intención con un proxy en vivo recibe el aviso de retransmisión compartida; cualquier proxy restante sin ninguna intención es residual, a menos que desconocido, extranjero o local tenga prioridad.

- descubrimiento de puerta de enlace (`/model` → "Desde la puerta de enlace") no se utiliza, porque Claude Code solo consulta
  `GET /v1/models` en una pasarela configurada. Los modelos enrutados llegan al selector de otra manera; ver
  [Selector de modelos en el CLI](#model-picker-in-the-cli). También puede enlazar un Anthropic incorporado id del modelo a una ruta (`ocx claude desktop bind`(arriba) o usar `modelMap`.
- `ANTHROPIC_SMALL_FAST_MODEL` y `CLAUDE_CODE_SUBAGENT_MODEL` son elegidos por el CLI antes de que se envíe la solicitud. El `claude` de primera parte simple usa sus valores `settings.json`. Routed `ocx claude` también ofrece el [ajuste de fuerza subagente](#forced-claude-code-subagent-model) en la página Subagentes y a través del CLI.
- `ocx claude` y first-party coexisten: una sesión iniciada con `ocx claude` habla con `ANTHROPIC_BASE_URL` (plain HTTP en loopback), que `HTTPS_PROXY` no cubre, por lo que el proceso llega a OpenCodex directamente y el proxy simplemente no ve tráfico desde él.
- Claude Code honra a `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS` como se documenta para proxys corporativos; una versión CLI que deja de hacerlo dejaría de enrutar, no rompería el inicio de sesión.

<a id="model-picker-in-the-cli"></a>

#### Selector de modelos en el CLI

Con el interruptor de primera parte CLI encendido y el enrutamiento Claude habilitado, inicie un nuevo `claude` y abra `/model`. Sus modelos opencodex aparecen junto a los modelos Claude de su cuenta, etiquetados como " Grok 4.7 (xai)" y descritos con su ruta ( `opencodex · xai/grok-4.7` ). Escoger uno dirige esa sesión al modelo, al igual que un enlace.

- Solo las nuevas `claude` sesiones recogen la lista. Reinicie cualquier sesión que ya se estaba ejecutando cuando encendió o apagó el interruptor.
- Claude Code guarda la lista durante aproximadamente una hora. Encender o apagar el interruptor, y `ocx ensure`, borrar esa copia guardada, por lo que el siguiente lanzamiento `claude` trae uno nuevo. Si faltan los modelos enrutados (el primer lanzamiento después de que se inicie OpenCodex puede fallarlos mientras los modelos aún se están descubriendo), ejecute `ocx ensure` y reinicie `claude`.
- Las filas usan identificadores de estilo Claude (por ejemplo, `claude-opus-4-8-…`), porque el CLI solo ofrece identificadores con forma de modelos Claude. La pestaña Código de Claude Desktop no se ve afectada; sigue usando [Obligaciones de primera parte](#use-opencodex-models-from-the-desktop-code-tab-first-party-bindings).

<a id="claude-desktop-profile-gateway-mode"></a>

## Claude Perfil de escritorio (modo puerta de enlace)

El perfil de abajo está escrito solo en modo gateway. Claude Desktop utiliza un perfil separado del Claude Code. Abra **Conectar → Claude Desktop** en el tablero de instrumentos. La tarjeta **Modelos** tiene las dos opciones que la mayoría de la gente necesita: **Modelo predeterminado** aparece primero en Claude Desktop y se envía como el nivel Opus, y **Modelo de tarea rápida** responde a las solicitudes de nivel Haiku de Desktop. Elegir un modelo allí lo traslada a esa familia y lo convierte en el valor predeterminado de la familia. Para colocar cada ruta usted mismo, abra **Avanzado: asignación de niveles Claude**, donde cada ruta disponible se encuentra en una de las cuatro familias: Opus, Fábula, Soneto o Haiku. Todas las rutas comienzan en Opus con un nuevo perfil. La primera ruta Opus se convierte en el valor predeterminado general inicial, y cada familia no vacía siempre tiene un valor predeterminado de familia.

Arrastre una fila a otra familia si lo desea. El arrastre es opcional: cada fila también tiene un control de movimiento visible que funciona con un mouse, un toque o un teclado. Utilice **Hacer predeterminado** para elegir el valor predeterminado de una familia y, a continuación, seleccione **Guardar y aplicar al escritorio**. Se permiten familias vacías. Si un valor predeterminado guardado no está disponible temporalmente, se utiliza la primera ruta disponible de esa familia hasta que vuelva.

También puede administrar el mismo perfil desde la línea de comandos:

Las instrucciones de edición de perfil a continuación describen el perfil local. La aplicación remota conectada se describe por separado a continuación.

```bash
ocx claude desktop [apply]
ocx claude desktop show [--json]
ocx claude desktop status [--json]
ocx claude desktop move <route> <opus|fable|sonnet|haiku> [--default]
ocx claude desktop default <opus|fable|sonnet|haiku> <route|none>
ocx claude desktop export <path|->
ocx claude desktop import <path> [--apply]
```

`ocx claude desktop` y `apply` aplican el modo seleccionado: la primera parte escribe el env del proxy Claude Code, la pasarela escribe el perfil actual en Claude Desktop. `show` da un resumen legible; `status` informa sobre el modo efectivo, el perfil aplicado o proxy env, drift, actividad de solicitud y (solo en modo puerta de enlace) salud de la política administrada Windows. Añadir `--json` para scripts. `export -` escribe la versión JSON a la salida estándar. Import valida el archivo completo antes de guardarlo, por lo que un archivo no válido deja el perfil actual sin cambios. Agregue `--apply` para escribir un perfil importado válido en Desktop inmediatamente. Use `none` solo para una familia vacía; cada familia no vacía debe mantener una predeterminada.

En Windows, una directiva Claude administrada por máquina puede hacer que Desktop ignore el perfil local de terceros. OpenCodex informa esto como `present`; una política que no puede leer es `unknown`, que también es una advertencia en lugar de un resultado limpio. El diagnóstico informa solo de ese estado: no expone nombres o datos de valores de directiva, y nunca elimina ni pasa por alto la directiva. Resuelva la directiva con su administrador y, a continuación, cierre completamente y vuelva a abrir Claude Desktop. La aplicación de nuevo también conserva las claves de perfil que OpenCodex no posee al actualizar sus campos de puerta de enlace y modelo.

Aplicar escrituras a los datos de usuario de Electron reales `configLibrary` de Claude Desktop: `~/Library/Application
Support/Claude/configLibrary` en macOS, `%APPDATA%\Claude\configLibrary` en Windows y `${XDG_CONFIG_HOME:-~/.config}/Claude/configLibrary` en Linux. Establezca `OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR` para una anulación de biblioteca explícita o `CLAUDE_USER_DATA_DIR` para una raíz de datos de usuario de escritorio alternativa. El directorio legacy `Claude-3p` no se lee ni se elimina automáticamente.

Las rutas no Anthropic reciben alias estables como `claude-fable-5-p01q`, con un código de cuatro caracteres prefijado `p`. `claude-opus-4-8-p...` ID de perfil anteriores siguen siendo ID de compatibilidad de solo decodificación; los nuevos perfiles usan el formulario Fable. OpenCodex mantiene una ranura de fecha sintética separada internamente para que las asignaciones de perfil existentes se mantengan estables, pero no expone esa fecha como el ID de modelo de Desktop: Desktop actual construye fechas de terminal de tira al comparar modelos de sesión activa, lo que puede suprimir los cambios de modelo. Real Anthropic Claude rutas mantienen sus identificaciones reales. Las nuevas rutas son predeterminadas para la familia Opus, pero mover una ruta no cambia el proveedor o el modelo al que llama. Los indicadores de aplicación heredados `--static`, `--hybrid` y `--discovery-only` permanecen disponibles para scripts existentes.

<a id="system-environment-integration"></a>

## Integración del entorno del sistema

Cuando `claudeCode.systemEnv` se establece en `true` (por defecto: **apagado**), `ocx start` usa `launchctl setenv` para inyectar `ANTHROPIC_BASE_URL` y las variables de entorno relacionadas Claude Code en todo el sistema. Nuevas ventanas y pestañas de terminal, por lo tanto, encaminan commandos `claude` simples a través del proxy sin requerir la envoltura `ocx claude`. Los proyectiles ya abiertos no se ven afectados y deben reabrirse. El cambio de una ranura o palanca de modelo (`smallFastModel`, `tierModels`, `maxContextTokens`, auto-contexto, `autoCompactWindow`, `alwaysEnableEffort`) vuelve a aplicar la inyección de inmediato: una tecla opencodex inyectada anteriormente se actualiza, o se desactiva una vez que la configuración ya no la produce. Un valor que usted mismo establece con `launchctl setenv` antes de opencodex inyecta esa clave nunca se sobrescribe ni se elimina; una clave opencodex inyectada permanece opencodex -propiedad (refrescada, sin establecer y eliminada por `ocx stop`) incluso si cambia su valor a mano.

`ocx stop` y el proxy shutdown **Desactivar las llaves inyectadas** (no restaura los valores anteriores - solo se eliminan las claves inyectadas por opencodex). El proxy también escribe `~/.opencodex/claude-env.sh`; `ocx start` instala un gancho de fuente `.zshrc` que lo carga automáticamente solo cuando un ejecutable Claude Code CLI está presente en `PATH`. El inicio y `ocx ensure` eliminan el gancho OpenCodex cuando Claude Code está ausente o la integración del entorno del sistema está inactiva. Claude Desktop utiliza su perfil separado y no causa la instalación del gancho de la terminal.

Deshabilitar con `claudeCode.systemEnv: false` en la configuración o con el conmutador GUI. Esta función es solo macOS; en otras plataformas, use `ocx claude`.

<a id="native-claude-passthrough-subscription-pierce"></a>

## Paso nativo Claude (perforación de suscripción)

Sin ningún conjunto de anulación de autenticación, Claude Code mantiene su inicio de sesión claude.ai OAuth y lo envía al proxy. Las solicitudes de modelos genuinos `claude*` / `anthropic*` que no se reenvíen **verbatim** a `api.anthropic.com` con su credencial: betas, firmas pensantes, almacenamiento en caché rápido e identidad de facturación permanecen completamente nativas y los modelos enrutados siguen funcionando en la misma sesión a través de los alias del selector.

**Manejo del encabezado:** encabezados salto por salto más `host`, `content-length`, `accept-encoding`, `x-opencodex-api-key` y `origin` siempre se eliminan antes del reenvío. En un enlace que no sea de bucle de retorno, el paso a través nativo también requiere una credencial proxy válida en `x-opencodex-api-key`; `Authorization` y `x-api-key` entonces pertenecen sólo a Anthropic. Se elimina un secreto de admisión de proxy que se encuentra en el encabezado de cualquiera de los proveedores, mientras que se conserva una credencial de proveedor genuina en el otro encabezado. Las cabeceras de credenciales unidas por comas ambiguas no se reenvían.

El passthrough se activa cuando se cumplen todas estas condiciones: `nativePassthrough` no es `false`; el modelo comienza con `claude` o `anthropic`; el token portador o `x-api-key` comienza con `sk-ant-`; la resolución de alias/mapa de modelo devuelve el mismo modelo sin cambios; y, en un enlace sin retorno de bucle, la cabecera de admisión proxy dedicada es válida. Esto también significa que la advertencia "los conectores claude.ai están desactivados" ya no aparece con `ocx claude`.

El único cambio en el cuerpo son los identificadores de llamada a herramientas. Un `tool_use.id` o `tool_result.tool_use_id` que el Anthropic rechazaría (personajes fuera de `a-zA-Z0-9_-`, o más largo que 64), tal como un modelo encaminado acuñado antes en la sesión, se vuelve a escribir a un id conforme con su par de llamada/resultado guardado. Los identificadores conformes se envían sin cambios, y un identificador vacío se responde con un identificador local 400.

Deshabilitar con `claudeCode.nativePassthrough: false`; punto en otro lugar con `claudeCode.anthropicBaseUrl`.

<a id="claude-desktop-on-a-connected-remote-hub"></a>

## Claude Desktop en un centro remoto conectado

Cuando esta máquina está conectada a un concentrador, `ocx claude desktop apply` (o `ocx claude desktop` ) utiliza la instantánea del modelo de escritorio del concentrador. Escribe el origen del concentrador conectado y los ID de modelo emitidos por el concentrador en la configuración del escritorio local sin generar alias de reemplazo localmente. Los modos estático e híbrido copian las entradas de instantánea; el modo de solo descubrimiento usa el origen de concentrador sin incrustar la lista de modelos.

El concentrador posee el perfil de escritorio, las asignaciones familiares y los valores predeterminados. Cambie esos en el concentrador, luego aplique nuevamente en el cliente conectado y vuelva a seleccionar el modelo en Desktop. Los alias antiguos creados solo en el cliente requieren volver a aplicar/reselección; no se migran automáticamente. Local `show`, las ediciones de perfil y la importación/exportación siguen siendo vistas y operaciones locales, no gestión de perfil de concentrador. Mientras está conectado, `ocx claude desktop import <path> --apply` no es compatible y rechaza la importación antes de guardar. La importación sin `--apply` sigue siendo local.

Apply lee la instantánea utilizando la credencial de datos de la conexión existente. No necesita token de administración y no carga ningún perfil. Si el concentrador es demasiado antiguo para admitir la instantánea, la respuesta no es válida o no hay modelos de escritorio disponibles, se aplican errores sin sustituir un catálogo local o un origen de bucle de retorno. Actualizar/configurar el concentrador y volver a aplicar.

Este cambio de alias no corrige la solicitud separada de reproducción y caché de mensajes `thinking` / `redacted_thinking` en [#3719](https://github.com/lidge-jun/opencodex/issues/3719). La admisión de proxy por sí sola no permite la transferencia nativa Anthropic; las rutas traducidas Anthropic aún pueden usar el almacenamiento en caché rápido. La fidelidad de reproducción y las comparaciones de caché siguen siendo un trabajo separado.

<a id="key-rotation-recovery-and-disconnect"></a>

### Rotación, recuperación y desconexión de llaves

La rotación de claves y la recuperación actualizan la credencial almacenada en el perfil de Desktop propiedad de la conexión junto con la credencial de conexión local. No se requiere volver a aplicar el escritorio manual solo para migrar la clave. Se conservan los ID de modelo existentes, las opciones de familia/predeterminado y la selección de perfil actual del usuario; la rotación no vuelve a seleccionar el perfil administrado ni vuelve a habilitar una integración deshabilitada. CLI JSON `rotation: "committed"` significa que la nueva clave está activa. `rotation: "rolled_back"` significa que la clave anterior fue retenida o restaurada, no que una nueva clave fue comprometida o la clave anterior revocada. La recuperación incierta o incompleta se informa como tal, en lugar de como una rotación exitosa.

La primera aplicación conectada registra los ajustes y la selección administrados anteriores para la restauración. La aplicación repetida y la rotación de la tecla conservan esa línea de base original. `ocx disconnect` restaura la configuración de propiedad de la conexión al tiempo que conserva los campos agregados por el usuario actuales y los perfiles no relacionados. La selección anterior se restaura solo si el perfil administrado sigue seleccionado; una selección de usuario válida posterior permanece seleccionada. Un perfil recién creado con adiciones de usuario se conserva en modo estándar legible en lugar de eliminar esas adiciones. `--keep-catalog` mantiene el catálogo, no la credencial de conexión de escritorio.

Para un perfil administrado más antiguo sin un registro original, OpenCodex puede migrarlo cuando pertenece inequívocamente al concentrador actual y a una clave de conexión reconocida. Aplicar, rotación / recuperación o desconexión directa puede manejar este caso sin una nueva bandera o requisito previo volver a aplicar. Una advertencia explica que la desconexión utilizará el modo estándar porque no se registraron los ajustes anteriores. Esa reserva elimina solo la configuración de la puerta de enlace propiedad de la conexión, conserva los campos de usuario y una selección válida separada, y se informa como reserva estándar, no como restauración original.

Los campos gestionados en conflicto, las credenciales no reconocidas o los registros de restauración dañados se conservan y se notifican para su resolución. La limpieza interrumpida puede reanudarse para la misma conexión; no borra una conexión más nueva o reclama la finalización mientras la restauración permanece incompleta. Termine la recuperación de rotación pendiente antes de iniciar la desconexión y conserve la misma opción de catálogo al volver a intentarlo.

Cierre completamente y vuelva a abrir Claude Desktop después de aplicar, rotación / recuperación o restauración: el cambio de archivos no reemplaza una credencial que ya tiene la aplicación en ejecución. OpenCodex no mata/reinicia la aplicación automáticamente. Disconnect funciona localmente sin revocar automáticamente la clave de concentrador o borrar copias externas arbitrarias; revoque por separado en el concentrador si lo desea.

<a id="the-model-picker-from-gateway"></a>

## El selector /model ("Desde la puerta de enlace")

Claude Code 2.1.129+ descubre modelos de puerta de enlace a través de `GET /v1/models?limit=1000` y los enumera en el selector nativo `/model`. Una fila sin un `description` dice "Desde la puerta de enlace"; opencodex envía uno por cada fila Claude Code CLI (`Routed by OpenCodex to <provider>/<model>`; las filas nativas usan `Routed by OpenCodex to native <model>`, las filas rápidas agregan ` · Fast` y las filas 1M mantienen la descripción base), que Claude Code muestra 2.1.257 + en su lugar. Claude Code 2.1.278 acepta un identificador de selector que contiene `claude` o `anthropic`. Un identificador no reconocido que comienza con `claude-` se contabiliza en 200k a menos que se desactive el compacto, por lo que opencodex expone los modelos enrutados como alias estables y reversibles que contienen `claude` pero no comienzan con `claude-`:

| Superficie | Formato | Ejemplo |
| --- | --- | --- |
| Claude Code CLI | `ocx-claude-<provider>--<model>` (plano) o `ocx-claude2-…` (escapado) | `ocx-claude-native--gpt-5.6-sol` |
| Claude Desktop 3P | `claude-fable-5-p<code>` (ranura de perfil de base36 3-char) | `claude-fable-5-p01q` |

El proxy elige la familia por solicitud: `?ids=cli` o `?ids=desktop` gana; de lo contrario, el agente de usuario `claude-code/*` obtiene el formulario CLI legible y otros clientes obtienen el código de escritorio. Ambas familias decodifican para siempre: un modelo guardado en `settings.json` bajo cualquier forma sigue funcionando. Cada entrada lleva un nombre de visualización honesto como `gemini-3-pro (gemini)`, más capacidades de modelo completo (escalera de esfuerzo de razonamiento, tipos de pensamiento) en la forma oficial de ModelInfo para que el modo de puerta de enlace de terceros de Claude Desktop pueda ofrecer su selector de esfuerzo. Los modelos Real Anthropic mantienen sus identificaciones canónicas. La fecha 2026 sintética es una ranura interna, no una fecha de lanzamiento. Los alias hash heredados y los identificadores `claude-ocx-<provider>--<model>` / `claude-ocx2-<provider>--<model>` de configuraciones anteriores aún se resuelven. Una identificación heredada configurada en una ranura de modelo OpenCodex (`claudeCode.model`, `tierModels`, `smallFastModel`) se envía automáticamente a Claude Code en su ortografía actual. Un id legado guardado por el propio selector de Claude Code sigue las rutas, pero Claude Code mantiene sus 200k contabilizando ese id. Elija `ocx-claude-` para una identificación guardada de `claude-ocx-`, y `ocx-claude2-` para una identificación guardada de `claude-ocx2-` escapado, por lo que se aplican tanto la ventana de contexto de catálogo efectiva como la compacta.

Los perfiles administrados más antiguos expusieron directamente sus ranuras internas `YYYYMMDD`. El escritorio afectado crea una tira de esa fecha de terminal al comparar modelos de sesión activa, por lo que dos rutas distintas pueden parecer idénticas y no se envía ninguna solicitud de control `set_model` ([#3782](https://github.com/lidge-jun/opencodex/issues/3782)). Los perfiles actuales exponen códigos no fechados en su lugar. Después de actualizar, vuelva a aplicar el perfil de escritorio y salga completamente y vuelva a abrir el escritorio; un trabajador que ya esté en ejecución aún puede conservar su antiguo ID en forma de fecha. El proxy continúa decodificando esos identificadores antiguos para la migración, pero no puede hacer que Desktop emita un switch suprimido.

También puede intentar seleccionar el modelo predeterminado previsto en el perfil OpenCodex Claude Desktop, volver a aplicar el perfil e iniciar una nueva conversación. Este es un paso de solución de problemas, no una solución garantizada. OpenCodex no puede observar el estado del selector; enruta la identificación del modelo que lleva cada solicitud. Confirme lo que el cliente envía bajo **Logs → requestedModel**.

Modelos con una ventana de contexto larga (1M, o al menos el umbral de compactación predeterminado de 829.800 tokens; Claude modelos en una ruta Anthropic necesitan un genuino 1M) obtener una fila extra `…[1m]` selector: selección que hace Claude Code cuenta un contexto 1M completo para ese modelo (autocompactación se mantiene encendido) - el proxy tiras el marcador antes de enrutamiento. Al seleccionar uno, se mantiene en el campo Claude Code's `settings.json` `model`; las solicitudes entrantes resuelven el alias de vuelta al modelo enrutado. En versiones anteriores de Claude Code, el selector permanece nativo: establece ranuras a través de `ANTHROPIC_MODEL` o escribe cualquier id enrutado con `/model` (Claude Code pasa cadenas).

**Reglas de gramática de Alias:** proveedor no debe contener `/` o `--` o igual `native`. Los identificadores de los modelos simples (no `/` o `~` ) mantienen el prefijo v1 `ocx-claude-…`. Los identificadores de modelo que contienen `/` o `~` acuñan el prefijo v2 `ocx-claude2-…` con escapes (`/` → `~s`, `~` → `~t` ), p. ej. `openrouter/anthropic/claude-opus-4-8` → `ocx-claude2-openrouter--anthropic~sclaude-opus-4-8`. Los alias v1 decodifican literalmente (de modo que se conserva un identificador de modelo histórico que contenía las secuencias de dos caracteres `~s` / `~t`); los alias v2 expanden los escapes. Las rutas que el formulario legible no puede expresar vuelven al alias hash. Los identificadores del modelo PUEDEN contener `--` (las divisiones de resolución en el primer `--` solamente); las identificadores nativas que contienen `--` vuelven a la forma hash.

**Orden de resolución del modelo:** `[1m]` marcador despojado → alias legible decodificado → Alias de hash de escritorio decodificado → `modelMap` coincidencia exacta → coincidencia de fecha desprovista (`-20250514` eliminado) → paso.

<a id="desktop-alias-resolution"></a>

Un ID de escritorio en forma de fecha no resuelto también puede ser un modelo nativo genuino que falta en el descubrimiento. Messages y count-tokens devuelven HTTP 503 con el error `desktop_model_mapping_unavailable` fijo cuando la evidencia disponible no puede resolver ese ID; esto no establece que el modelo no es válido. Los alias de hash heredados desconocidos todavía devuelven HTTP 400. Ninguno de los casos quita la fecha o vuelve a otra ruta. Los ID conocidos, las asignaciones registradas y las coincidencias exactas `modelMap` mantienen su comportamiento existente, incluidos los ID nativos reales reconocidos. Actualizar el descubrimiento del modelo o volver a aplicar el perfil del concentrador conectado antes de volver a intentarlo; reintentar solo no garantiza la resolución.

Cada entrada lleva un nombre de pantalla como `gemini-3-pro (gemini)`, más capacidades de modelo completo (escalera de esfuerzo de razonamiento, tipos de pensamiento) en la forma oficial `ModelInfo`. Los modelos Real Anthropic mantienen sus identificaciones canónicas en ambas superficies.

<a id="context-variant-1m-marker"></a>

### Variante de contexto `[1m]` marcador

Estas comprobaciones utilizan la ventana de catálogo efectiva, que puede incluir un [Estimación del proveedor personalizado](/es/reference/configuration/providers/#context-windows-on-custom-providers). Una estimación no verifica la capacidad real del relé.

Los modelos con una ventana de contexto de catálogo efectiva de 1M, o al menos el umbral de compactación predeterminado de 829.800 tokens, obtienen una fila de selectores `…[1m]` adicional; el piso es fijo, por lo que un valor de compactación personalizado no lo baja, y los modelos Claude en una ruta Anthropic necesitan un 1M genuino. Desactivar el autocontexto limita la fila a ventanas de 1M. Seleccionarlo hace que la cuenta Claude Code sea un contexto completo de 1M. El proxy quita el sufijo `[1m]` insensible a mayúsculas y minúsculas antes de la resolución y el enrutamiento de alias.

<a id="auto-context-big-context-models-without-the-200k-ceiling"></a>

## Contexto automático (modelos de gran contexto sin techo de 200k)

Claude Code cuentas 200k tokens para cualquier modelo que no reconozca. **Contexto automático** (activado por defecto) corrige que:

1. Las ranuras env de lanzamiento obtienen el marcador `[1m]` cuando la ventana de catálogo efectiva del modelo está por encima de 200k **y** al menos el umbral autocompacto configurado. Las filas del selector Discovery y Desktop no siguen ese umbral: usan el piso fijo de 829.800 tokens (un 1M genuino para los modelos Claude en una ruta Anthropic).
2. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (valor predeterminado `829800`, rango `100000` - `1000000`) se inyecta para que la conversación se resume automáticamente en ese punto.

Tres estados de configuración:

- **ausente / `true`:** habilitado (predeterminado)
- **`false`:** desactivado - sin marcadores, sin inyección de ventana de compactación
- **set legado `maxContextTokens`:** auto-contexto está implícitamente deshabilitado

El valor de compactación es ajustable en la página Claude. **Aviso:** elevarlo más allá de la ventana real de un modelo rompe ese modelo: los errores de chat se eliminan antes de que el resumen pueda disparar.

La ventana de contexto anunciada de un modelo no garantiza que una solicitud pesada de herramientas se ajuste al límite de entrada ascendente. Un rechazo de límite de entrada clasificado alcanza Claude Code como `invalid_request_error` con `context_length_exceeded`, redactado de la manera Anthropic palabras ( `prompt is too long: …` ), por lo que Claude Code compacta la conversación y vuelve a intentar por sí solo; una respuesta sin transmisión usa HTTP 400 en lugar de una 502 reintentable. Los proveedores en el carril nativo Messages tienen la misma redacción.

La normalización de desbordamiento usa solo el primer **65.536 unidades de código UTF-16** del mensaje de error del proveedor, incluidos los mensajes que ya usan la redacción de Anthropic. Este es un límite de longitud de cadena, no un límite de bytes o tokens. El texto más allá se descarta sin un marcador de truncamiento o elipsis, por lo que los detalles de diagnóstico y los recuentos de tokens cerca del final pueden estar ausentes del error que recibe Claude Code. El prefijo añadido `prompt is too long:`, seguido de un espacio, puede hacer que el mensaje final sea más largo que esta parte retenida.

Dentro de esa parte, se mantiene la redacción Anthropic reconocida; de lo contrario, OpenCodex emite `prompt is too long: <requested> tokens > <limit> maximum` solo cuando encuentra `maximum context length is <limit> tokens` seguido de `resulted in <requested> tokens` o `you requested <requested> tokens`. Utiliza el primer límite establecido y el primer recuento de solicitudes coincidentes después de él. Si ese par falta, se invierte o se corta, prefija el texto retenido con `prompt is too long:` seguido de un espacio, sin inventar cuentas. Un límite de rendimiento que solo menciona tokens (por ejemplo, "demasiados tokens por minuto") mantiene su texto y no se trata como un desbordamiento.

Si la compactación en sí misma aún excede el límite, conserva el historial original e intenta compactar una bifurcación con menos herramientas habilitadas o esquemas MCP, si tu cliente admite ese flujo de trabajo. Un marcador `[1m]` o una configuración de contabilidad de cliente más grande no eleva el límite ascendente, y OpenCodex no elimina silenciosamente el historial o las herramientas para que encaje.

Los modelos Anthropic nativos Sub-1M nunca se marcan automáticamente. Una ventana compacta que usted mismo exporta gana para el marcado de la ranura de lanzamiento (el proxy utiliza su valor para decidir qué modelos son seguros para marcar). Las filas de descubrimiento ignoran esa exportación y mantienen el piso fijo. Los valores de configuración no válidos editados manualmente vuelven a 829.800.

<a id="context-accounting-1m-by-default-200k-opt-in"></a>

### Contabilidad de contexto (1M por defecto, 200k opt-in)

`claudeCode.contextAccounting` decide lo que opencodex escoge por defecto. Ausente (`1m`, el predeterminado), los modelos de ventana larga se ofrecen a 1M en las ranuras de env de lanzamiento, los selectores de escritorio, Desktop 3P (`prefer1m`) y subagentes generados. Configure `200k` para excluirse: nada se marca `[1m]` automáticamente, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` no se inyecta y Desktop 3P cae `prefer1m` mientras mantiene `supports1m`. Un selector que usted mismo marca como `[1m]` permanece disponible (los subagentes generados y forzados aún dejan caer un marcador que la ventana del modelo no puede llevar), y el descubrimiento aún enumera las `· 1M` filas de modelos con ventanas de catálogo de al menos 1M. `200k` gana sobre el contexto automático: una ventana compacta que exporta ya no activa el marcado automático, aunque opencodex deja su propia exportación en su lugar.

```bash
ocx claude config set --context-accounting 200k
```

<a id="effective-model-environment"></a>

### Entorno modelo eficaz

`effectiveModelEnv` calcula seis ranuras inyectadas por `ocx claude` / system env / shell file:
`ANTHROPIC_MODEL`, cuatro `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`, y legado
`ANTHROPIC_SMALL_FAST_MODEL`. El haiku efectivo es `tierModels.haiku ?? smallFastModel`, alimentado a las dos variables del haiku.

Cuando `ocx claude` se lanza en modo de suscripción, el propio inicio de sesión de Claude Code lleva una identificación desnuda de Claude como `claude-sonnet-5` directamente a Anthropic, por lo que esos id toman sus ventanas de contexto del registro del proveedor, lo que sea que otro proveedor enumere bajo la misma identificación. Una ranura Opus, Sonnet o Fable desactivada obtiene el identificador nativo Claude Code y resuelve ese alias, con el marcador `[1m]`, porque detrás de una puerta de enlace Claude Code cuenta con un identificador sin marcar en 200k. Una fila `anthropic` tapada por debajo de 1M o una entrada `claudeCode.modelMap` mantiene su identificación sin marcar, y el Haiku nunca se llena ni se marca. Cuando el lanzamiento utiliza autenticación proxy o `nativePassthrough` está desactivado, el enrutador decide, y solo cuenta la ventana de una fila enrutada. El env del sistema y el archivo de shell dejan espacios sin establecer vacíos, ya que sus valores también alcanzan lanzamientos que pasan por un concentrador.

Cuando tanto `tierModels.haiku` como `smallFastModel` están ausentes, OpenCodex deja ambas variables auxiliares sin establecer; Claude Code luego elige su modelo de ayudante nativo (actualmente Sonnet), que puede incurrir en cargos de proveedor nativo.

<a id="roster-agents-injectagents"></a>

## Agentes de lista (injectAgents)

Proxy inicio / asegurar, `ocx claude`, y el tablero de instrumentos relevante guarda sincronizar su lista de subagentes destacados (pestaña Subagentes, hasta 5 modelos) más `ocx-self` en `~/.claude/agents/ocx-*.md`.

- **`ocx-self`** pines su `/model` selector predeterminado (regresando a `claudeCode.model`); omitido cuando ninguno existe. No utiliza la herencia modelo.
- Cada cuerpo de agente contiene una directiva `<!-- ocx-route: <model> -->`: el proxy usa esto para fijar la ruta real. Por lo tanto, el argumento `model` de la herramienta Agente es inerte; pase `"haiku"` como marcador de posición.
- Frontmatter lleva el alias; el enrutamiento es impulsado por directivas.
- Solo los archivos `ocx-*.md` verificados con marcadores que contienen `generated-by: opencodex` se sobrescriben o podan; sus propios agentes nunca se tocan.
- Los archivos se sincronizan atómicamente por archivo (escribir + renombrar).
- `enabled: false` o `injectAgents: false` podan todas las definiciones de propiedad verificada.
- El éxito CLI guarda de primera parte y persiste la configuración de primera parte del escritorio también intenta la sincronización de la lista de mejor esfuerzo, incluida la configuración repetida para reparar las definiciones que faltan. La configuración y la reversión rechazadas no sincronizan los agentes. Desactivar el registro de primera persona por sí solo no deshabilita el registro del agente.
- Los cambios de GUI PUT y de lista se vuelven a sincronizar inmediatamente; cada inicio/garantía de proxy en primer plano o en segundo plano reconcilia los archivos de propiedad antes de que un lanzamiento posterior Claude Code los lea. Inicie una nueva sesión Claude después del registro para que cargue las definiciones generadas.

Despacho: `subagent_type: "ocx-gpt-5-6-sol"`. Los objetivos con capacidad de 1M transportan automáticamente `[1m]`.

<a id="bundled-skill-elision-blockedskills"></a>

## Elisión de habilidades agrupadas (blockedSkills)

Claude Code 's incluido `claude-api` habilidad inyecta? 840KB (? 136k tokens) de Anthropic documentación que auto-dispara en Claude menciones modelo. Los modelos enrutados no están entrenados en ese paquete, por lo que por defecto opencodex reemplaza el contenido de la habilidad con un stub corto en **Enrutado** solicitudes. Native Anthropic passthrough no ha sido tocado.

**Se manejan dos transportistas:**

1. **Portaherramientas de resultados:** asistente `Skill(...)` llama - el cuerpo `tool_result` emparejado se reemplaza por un stub cuando la entrada JSON de carcasa inferior contiene un nombre bloqueado.
2. **Portador de bloque de texto:** un bloque de texto de usuario ≥ 10.000 caracteres a partir de `Base directory for this skill: ` - emparejado cuando el nombre base de directorio es igual a un nombre bloqueado (insensible a mayúsculas). La línea de directorio se inspecciona solo hasta 4.096 unidades de código UTF-16; una línea más larga se envía sin cambios, incluso cuando no tiene una nueva línea de terminación.

Configurar con `claudeCode.blockedSkills` (por defecto `["claude-api"]`; `[]` deshabilita la elisión por completo). El stub mantiene intacto el emparejamiento de llamada/resultado de la herramienta.

<a id="model-map-interception"></a>

## Mapa de modelos (intercepción)

`claudeCode.modelMap` reescribe los identificadores de modelo de entrada Anthropic antes del enrutamiento:

```json
{
  "claudeCode": {
    "modelMap": {
      "claude-sonnet-4-5": "gemini/gemini-3-pro",
      "claude-haiku-4-5": "gemini/gemini-3-flash"
    }
  }
}
```

Orden de búsqueda: descubrimiento alias → id exacto → id con fecha sufijo despojado (`-20250514`) → passthrough.

Véase [Resolución de alias de escritorio](#desktop-alias-resolution) para la política de rechazo.

<a id="sidecar-matrix-web-search-and-image-understanding"></a>

## Matriz Sidecar: búsqueda web y comprensión de imágenes

Los modelos enrutados no todos tienen las mismas herramientas alojadas o soporte de imágenes. opencodex llena esos vacíos antes de que el modelo principal responda:

- El **web-buscar sidecar** ejecuta la búsqueda alojada real, luego le da al modelo enrutado la respuesta y las fuentes como resultado de la herramienta.
- El **visión sidecar** describe una imagen adjunta antes de llamar a un modelo listado en `noVisionModels`, luego reemplaza la imagen con esa descripción.

Ambos sidecars pueden usar cualquiera de los dos backend:

| Backend | Cómo funciona | Lo que se requiere |
| --- | --- | --- |
| `openai` | Un pequeño modelo GPT a través del proveedor ChatGPT `forward` | Un inicio de sesión ChatGPT y un proveedor habilitado `authMode: "forward"` |
| `anthropic` | Claude a través de Anthropic OAuth almacenado; la búsqueda web utiliza `web_search_20250305` y la visión envía la imagen a Claude para su descripción | Un proveedor `adapter: "anthropic"`, `authMode: "oauth"` habilitado cuya cuenta activa almacenada no está marcada como `needsReauth` |

Un `backend` explícito siempre gana. Cuando se omite, el sidecar **web-search** siempre selecciona `openai` (`anthropic` se ejecuta solo cuando se configura explícitamente), mientras que el sidecar **visión** selecciona `anthropic` si existe una cuenta Anthropic OAuth almacenada utilizable, de lo contrario `openai`. La selección explícita de `anthropic` sin una credencial utilizable **falla cerrado**: opencodex no toma prestadas silenciosamente credenciales ChatGPT ni cambia los backends. El backend OpenAI también se mantiene apagado sin autorización de inicio de sesión y sin un proveedor de forward.

Claude -las repeticiones enrutadas de entrada unen el inicio de sesión principal de ChatGPT a la solicitud interna, de modo que OpenAI sidecars permanecen accesibles incluso aunque el portador de entrada de Claude Code sea solo la credencial de proxy. Ese portador nunca se reenvía al proveedor principal enrutado.

```json
{
  "webSearchSidecar": {
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "maxSearchesPerTurn": 3
  },
  "visionSidecar": {
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "maxDescriptionsPerTurn": 8
  }
}
```

`maxDescriptionsPerTurn` limita las nuevas descripciones de imágenes en un turno de modelo principal. Los hits de caché y las descripciones duplicadas en vuelo no consumen el límite. Las descripciones exitosas para las imágenes `data:` se almacenan en caché por backend, modelo, detalle, bytes de imagen y contexto de solicitud, por lo que el mismo par imagen-contexto no se describe de nuevo en cada repetición. Las imágenes remotas `https:` nunca se almacenan en caché porque su contenido puede cambiar.

Vea el [referencia de configuración](/es/reference/configuration/server/#sidecars) para cada clave. Anthropic - OAuth búsqueda web y descripción de la imagen reutilizar el repositorio existente Claude Code OAuth huella dactilar precedente, pero aún debe ser probado en remojo con su cuenta y la carga de trabajo antes de que dependa de ellos para largas carreras desatendidas.

<!-- TODO(WP5 GUI): Add the sidecar settings-screen walkthrough after the GUI controls ship. -->

<a id="client-tools-on-cursor-routes"></a>

## Herramientas de cliente en rutas Cursor

Cuando Claude Code utiliza un modelo respaldado por Cursor, OpenCodex conserva nombres de herramientas de clientes reconocidos como `Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob` y `Task` en el catálogo Cursor, la guía de herramientas y las llamadas reproducidas. Esto mantiene los nombres consistentes con las instrucciones de Claude Code. Denegado Cursor -los marcos de ejecución nativos dirigen el modelo a las herramientas de cliente disponibles que giran.

Un catálogo mixto que contiene un puente Codex `exec_command` o `shell_command` usa alias de cable como `ocx_client_Read` para evitar colisiones de herramientas Cursor; las llamadas devueltas a Claude Code todavía usan sus nombres de herramientas originales. Las herramientas Namespace MCP mantienen sus identidades namespace. OpenCodex incluye estos alias en el presupuesto de bytes de transporte de Cursor, por lo que se omite una herramienta cuya definición excedería el límite para ese turno.

<a id="reasoning-effort"></a>

## Esfuerzo de razonamiento

En las solicitudes traducidas Messages → Responses, Claude Code `/effort` Configuración de mapas de la siguiente manera:

| Formato de alambre | Mapeo |
| --- | --- |
| `thinking.type: "adaptive"` + `output_config.effort` | Esfuerzo pasado directamente ( `minimal` `low` `medium` `high` `xhigh` `max` `ultra`) |
| `thinking.type: "enabled"` + `budget_tokens` | ≤ 4096 → `low`, ≤ 16384 → `medium`, por encima de → `high` |
| `thinking.type: "disabled"` | `reasoning: { effort: "none" }`; resumen omitido |

Para las solicitudes traducidas, el nivel resuelto aparece en la columna **Esfuerzo de razonamiento** del registro de solicitudes. Gestionado nativo Messages registro habilitado pensamiento presupuestos como `budget:<tokens>` cuando no reconoce `output_config.effort` está presente; este registro no cambia el cuerpo del cable.

<a id="inbound-translation-messages--responses"></a>

## Traducción entrante (Messages → Responses)

El proxy traduce cada solicitud Anthropic Messages API al formato Codex Responses API:

| Messages entrada | Responses salida |
| --- | --- |
| Nivel superior `system` | `instructions` (bloques de texto unidos con `\n\n`) |
| `messages[].role: "system"` | También doblado en `instructions` |
| Texto / imagen del usuario | `input_text` / `input_image` (base64 → URL de datos) |
| Texto del asistente | `output_text` |
| Asistente `tool_use` | `function_call` ( `input` → JSON -stringed `arguments` ) |
| Usuario `tool_result` | `function_call_output` (prefijo `is_error` → `[tool error]`) |
| `tool_reference` en un resultado de herramienta | Texto `Tool loaded: <tool_name>` en el resultado emparejado; conserva los nombres de las herramientas cargadas sin agregar declaraciones ni habilitar el aplazamiento del lado del servidor traducido |
| `thinking` / `redacted_thinking` repetición | `reasoning` artículos con `ocxr1` sobres limitados para firmas y cargas útiles redactadas |
| Herramientas de función | `{type: "function"}` (`web_search*` → `{type: "web_search"}`). En una ruta a `api.anthropic.com`, las declaraciones `web_search_*` y `web_fetch_*` escritas también se envían a Anthropic como se declara y se ejecutan en el lado del servidor, a menos que el propio sidecar de búsqueda web suministre `web_search`. Una búsqueda o búsqueda con una llamada coincidente y entrada completa vuelve al cliente como su bloque `server_tool_use` y su bloque `web_search_tool_result` o `web_fetch_tool_result`, literalmente. Los resultados huérfanos se eliminan sin sintetizar una llamada, mientras que el texto circundante se conserva. Cuando el cliente envía un par completo en su historial, la siguiente solicitud `api.anthropic.com` lo lleva en su lugar solo si el siguiente bloque identifica de forma única su turno original. Anclajes repetidos, identificadores de llamada/resultado no coincidentes o duplicados, entrada de llamada malformada o un resultado que aparece antes de que su llamada caiga en el intercambio. La entrada de llamada debe ser un objeto con una consulta de búsqueda no vacía o una cadena de URL de búsqueda; otros destinos nunca ven el intercambio |
| `tool_choice` | `auto` → `auto`, `none` → `none`, `any` → `required`, llamada función → `{type:"function",name}`, alojada WebSearch/ web_search → `{type:"web_search"}` |
| `max_tokens` | `max_output_tokens` |
| `stop_sequences` | `stop` |

El modo automático Claude Code siempre envía `stop_sequences`. Para los modelos de la lista `noStopModels` del proveedor enrutado, OpenCodex omite `stop` en los cables Chat Completions y Responses, por lo que los modelos de razonamiento xAI como el grok-4.7 y el grok-4.6 no devuelven `400 invalid-argument` y se marcan temporalmente no disponibles. Véase [`noStopModels`](/es/reference/configuration/providers/).

Replay conserva los bloques firmados no ocultos (incluido el pensamiento vacío) y los bloques redactados opacos en el adaptador Anthropic previsto. `hideThinkingSummary` permanece sin cambios: el texto firmado localmente oculto no está expuesto a Claude clientes, y la reproducción sin pérdida a través de ese límite oculto Claude no se establece. Los sobres de razonamiento combinados más antiguos no pueden recuperar el orden de bloque original una vez que se ha emitido el texto de transmisión. `claudeCode.compatibility: "enforce"` todavía rechaza la repetición del pensamiento. Esto no establece la aceptación de Anthropic en vivo ni las mejoras de caché. [#3719](https://github.com/lidge-jun/opencodex/issues/3719) permanece abierto.

**Casos de error (400):** malformado JSON; faltante/vacío `model`; faltante/vacío `messages`; papel no soportado; `tool_result` sin `tool_use_id`; `tool_use` sin id/name; nombrado `tool_choice` sin nombre.

<a id="unicode-property-patterns-in-tool-schemas"></a>

### Patrones de propiedad Unicode en esquemas de herramientas

Un esquema JSON `pattern` escrito para JavaScript puede usar escapes de propiedad Unicode como `\p{Cc}` o `\P{L}`. OpenAI -family backends validan `pattern` compilándolo con el `re` de Python, que no admite esos escapes, y un esquema que no pueden compilar se rechaza entero, por lo que un solo patrón de este tipo en una herramienta incorporada falla cada solicitud en la sesión, no solo llamadas a esa herramienta.

Para mantener funcionando los parámetros ordinarios de Artifact, las rutas de adaptador `openai-chat` y `openai-responses` omiten las restricciones escalares `pattern` que contienen escapes de propiedad Unicode en posiciones de esquema positivas ordinarias. Restricciones de hermanos, `required`, datos literales y regexes soportados permanecen. Una implementación de herramienta debe validar sus propias entradas porque este proxy no aplica una restricción omitida.

`patternProperties` emparejadores y sus esquemas de valor permanecen sin cambios. La eliminación de un emparejador puede cambiar qué claves son evaluadas por el `unevaluatedProperties` de un antepasado, por lo que la apertura local no es suficiente para demostrar una transformación segura. Los patrones bajo `not`, `oneOf`, `if`, `contains`, `$defs` y `definitions` también permanecen sin cambios: relajar esos subárboles puede cambiar la negación, la selección de ramas, el recuento de coincidencias o el significado de una referencia.

El destino valida estos esquemas conservados. Un destino compatible con ECMA puede usar el regex original; un destino que no puede compilarlo puede rechazar el esquema. OpenCodex no reemplaza silenciosamente ese contrato con uno que prohíbe argumentos previamente válidos.

Esta es la normalización en la ruta del adaptador seleccionado, no una garantía para todo el proveedor. La configuración y autenticación del proveedor no se tocan, y un proveedor en un adaptador diferente no se ve afectado.

Es una medida de compatibilidad, no una afirmación de que cada backend personalizado compatible con OpenAI rechaza estos patrones. Vale la pena saber lo que cuesta: una regla omitida no se conserva en ninguna parte y no se aplica en sentido ascendente, por lo que una implementación de herramienta debe validar sus propias entradas en lugar de confiar en el esquema para rechazar un argumento mal formado.

<a id="outbound-translation-responses--messages-sse"></a>

## Traducción saliente (Responses → Messages SSE)

| Responses evento | Messages SSE |
| --- | --- |
| `response.created` | `message_start` + `ping` |
| Latido del corazón | `ping` |
| Texto deltas | `content_block_start` → `content_block_delta` (texto) → `content_block_stop` |
| Razonamiento resumen/texto | `thinking` bloque con la firma reproducida, o un sobre de reserva limitado `ocxr1` |
| Razonamiento redactado | `redacted_thinking` bloques reproducidos desde el sobre de razonamiento |
| Marcos de llamada de función | Bloque `tool_use` con `input_json_delta` |
| Evento terminal | `message_delta` → `message_stop` |
| EOF antes del terminal | 502-estilo `api_error` |

**Detener el mapeo de la razón:** `completed` → `tool_use` (si se llama alguna herramienta) o `end_turn`; `incomplete/max_output_tokens` → `max_tokens` `incomplete/content_filter` → `refusal`.

**Taxonomía de error:** 400 `invalid_request_error`, 401 `authentication_error`, 402 `billing_error`, 403 `permission_error`, 404 `not_found_error`, 409 `conflict_error`, 413 `request_too_large`, 429 `rate_limit_error`, 504 `timeout_error`, 529 `overloaded_error`, otros 5xx `api_error`. Se conserva el `Retry-After`.

<a id="prompt-caching-and-token-usage"></a>

## Uso rápido de caché y token

**Anthropic -solicitudes de ruta:** el adaptador administra puntos de interrupción de la caché para herramientas, contenido del sistema y el penúltimo mensaje de usuario, además de `cache_control` automático de nivel superior. Los giros estables normalmente producen una tasa de éxito de caché del 99.9%.

**Enrutamiento nativo OpenAI / ChatGPT:** deriva un encabezado `prompt_cache_key` de alcance de sesión (de `metadata.user_id` cuando está presente, volviendo a un hash de contenido de sistema) y `session_id` para afinidad de caché. La clave de caché incluye esquemas de modelo y herramientas completas.

La salida **Matemáticas de token:** Anthropic resta `cached_tokens` y `cache_write_tokens` de `input_tokens`, exponiéndolos como `cache_read_input_tokens` y `cache_creation_input_tokens`. Los registros de solicitud mapean esos de vuelta al `inputTokens` inclusivo, con lecturas tanto en `cachedInputTokens` como en `cacheReadInputTokens`, escribe en `cacheCreationInputTokens`. La página Uso informa de los hits de caché y la creación de caché por separado.

**count_tokens:** modelos enrutados utilizan una aproximación (sistema serializado + mensajes + herramientas). Los modelos nativos Anthropic con una credencial `sk-ant-` pasan la solicitud al punto final real Anthropic `/v1/messages/count_tokens`.

<a id="debug-capture"></a>

## Captura de depuración

`ocx debug claude on|off|status|reset`, `OCX_CLAUDE_DEBUG=1` o `PUT /api/debug {"claude": true}` controlan la captura entrante. `GET /api/claude/inbound-debug` devuelve `{enabled, entries}` (el más nuevo primero, anillo de 20).

Cada entrada registra: `at`, `endpoint`, `model`, `resolvedModel`, `stream`, `maxTokens`, `thinkingType`, `thinkingBudgetTokens`, `outputConfigEffort`, `metadataKeys`, `hasMetadataUserId`, `hasSystem`, `anthropicBeta` en bruto y etiquetas de igualdad HMAC de ocho caracteres para el identificador de usuario / sistema. **No se almacena ningún texto de solicitud, objeto sin procesar o hash de ejecución cruzada estable.** La desactivación de la depuración Claude limpia inmediatamente el anillo.

<a id="gui-claude-page"></a>

## GUI (página Claude)

Abra **Conectar → Claude** para la configuración de una página Claude Code. La página muestra estos controles y secciones en orden:

1. Interruptor **Claude Code CLI primera parte**
2. **Empezar** con `ocx claude` y el bloque de entorno manual
3. **Generalidades** con compatibilidad, instrucciones del agente, modo rápido y controles de contexto
4. **Modelo de ayudante de fondo** selector
5. **Interceptación modelo** editor
6. **Modelos disponibles**, la vista previa en vivo de Claude Code `/model` alias de selector
7. Interruptor **Claude conexión**, también disponible en la tarjeta Claude en la vista general de Connect

La barra de guardado pegajosa muestra **Sin cambios** cuando la configuración guardada coincide con la página, o **Cambios no guardados** después de editarlos. **Revertir** descarta ediciones no guardadas; **Guardar** confirma la configuración editable. Los interruptores **Claude conexión** y **Claude Code CLI primera parte** se aplican inmediatamente. **Guardar** nunca cambia ninguno de los interruptores.

**Claude Desktop** es una pestaña separada bajo **Conectar**. Su selector **Modo de conexión** ofrece gateway (predeterminado) o first-party, con el puerto proxy en ejecución en modo first-party. Solo **Guardar y aplicar** cambia los modos; **Guardar** solo almacena los carriles de perfil de pasarela para una pasarela posterior aplicada y deja el modo actual como está.

`GET /api/claude-code` devuelve los valores predeterminados efectivos, la configuración, el registro de ventanas de contexto, el env efectivo, los identificadores de ruta disponibles, los alias y el puerto. `PUT /api/claude-code` es parcial y conserva los campos omitidos; `null` restablece los valores de contexto/lista de bloques/ventana compacta.

<a id="troubleshooting"></a>

## Solución de problemas

**Claude Code dice "Hizo 0 búsquedas"** - Las compilaciones actuales traducen los elementos completados Responses `web_search_call` en bloques emparejados Anthropic `server_tool_use` y `web_search_tool_result`, incluido `usage.server_tool_use.web_search_requests`. Actualización opencodex si una compilación anterior completó la búsqueda, pero Claude Code todavía contaba cero.

**Un sidecar no se activa** - Para `backend: "openai"`, confirme que ha iniciado sesión en ChatGPT y que tiene un proveedor `authMode: "forward"` habilitado. Para `backend: "anthropic"`, confirme que la cuenta Anthropic OAuth almacenada activa no está marcada como `needsReauth`. Una selección Anthropic explícita sin esa credencial falla intencionalmente.

**"Los conectores claude.ai están deshabilitados"** - Un `ANTHROPIC_API_KEY` o `ANTHROPIC_AUTH_TOKEN` se establece en su cáscara. `ocx claude` deliberadamente NO establece `ANTHROPIC_API_KEY`; si lo tiene exportado, elimina esa variable del entorno. `ocx claude` inyecta `ANTHROPIC_BASE_URL`, descubrimiento, auto-contexto y ranuras de modelo configuradas, pero nunca `ANTHROPIC_API_KEY`.

**Modelos que no aparecen en /modelo selector** - Verificar que `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` está configurado (automático con `ocx claude`). Ejecute `ocx claude` para actualizar la caché del modelo de puerta de enlace en `~/.claude/cache/gateway-models.json`. Compruebe `claudeCode.enabled` no es `false`.

**Entorno estanco después del cambio de puerto** - Si el puerto proxy ha cambiado, los shells antiguos pueden tener un `ANTHROPIC_BASE_URL` obsoleto. Abra una nueva terminal o vuelva a ejecutar `ocx claude`.

**techo de contexto 200k a pesar de gran modelo** - Seleccione la variante `[1m]` en el selector, o active el contexto automático (activado de forma predeterminada). Si el selector no muestra la fila `[1m]`, la ventana de contexto de catálogo efectiva del modelo puede estar por debajo del piso fijo de 829.800 tokens.

**Alto recuento de tokens de cargas de habilidad** - La habilidad `claude-api` incluida (tokens de -136k) se carga automáticamente en Claude menciones del modelo. Esto es normal para passthrough nativo; en los modelos enrutados, opencodex stubs por defecto (`blockedSkills: ["claude-api"]`).

**Los esquemas de herramientas MCP llenan el contexto en la primera curva** - Claude Code convierte MCP herramienta de aplazamiento cuando `ANTHROPIC_BASE_URL` no es un host Anthropic de primera parte. La comprobación está en el host, no en el modelo, por lo que se aplica a cada sesión `ocx claude`: con muchos conectores configurados, cada esquema de herramienta está alineado antes de escribir nada. Vuelva a habilitar el aplazamiento con:

```json
{ "claudeCode": { "toolSearch": true } }
```

Esto está desactivado por defecto porque solo vale la pena en **paso nativo Anthropic** Rutas. El aplazamiento es una optimización del lado del servidor, no una solicitud más pequeña: Claude Code todavía envía cada definición de la herramienta, y Anthropic de API es lo que mantiene los esquemas diferidos fuera del contexto del modelo y responde el `tool_search` herramienta de servidor con `tool_reference` bloques. Un traducido (enrutado) modelo nunca llega a esa maquinaria — opencodex deja caer el `tool_search` herramienta e ignora
`defer_loading` — para que el proveedor siga recibiendo todos los esquemas mientras Claude Code deja de contar y, por lo tanto, deja de compactarse. Con `claudeCode.compatibility: "enforce"` El mismo La solicitud es rechazada con 400 en su lugar. Enciéndelo cuando `ocx claude` se enruta a un Anthropic modelo; déjelo para rutas de terceros hasta que se admita el aplazamiento traducido.

Los valores aceptados siguen el propio analizador de Claude Code: `true`, `"auto"`, `"auto:N"` (N al menos 100) y `"force"`. Un valor que usted mismo exporta siempre gana sobre el inyectado.

**Subagente envía al modelo equivocado** — Lista de agentes (`ocx-*`) uso `<!-- ocx-route: ... -->`
directivas, no la herramienta del agente `model` argumento. Asegúrese de que la directiva coincida con el ruta. Pase `"haiku"` como modelo de referencia.

Establecer `claudeCode.stabilizePromptCache` a `true` en `config.json` a Claude arnés de aviso de seguimiento de las instrucciones del sistema en las rutas traducidas. Se han retirado `<total_tokens>N tokens left</total_tokens>` pies reconocidos, incluidos los pies repetidos. Los recordatorios de TaskCreate aún se mueven a un mensaje de usuario final; si solo se pelaron los pies de token, no se agrega ningún mensaje de entrada. El valor predeterminado es `false`. Habilítelo solo cuando este cambio de rol sea apropiado para sus clientes. Conserva ejemplos cercados y texto sin igual; el passthrough nativo Anthropic no cambia. La clave prompt-cache sin metadatos sigue instrucciones estabilizadas. Esto no crea una identidad de conversación ni garantiza accesos de caché ascendentes.

En cada ruta de chat traducida, los recordatorios de línea de tiempo mantienen su posición en la conversación, después de cualquier resultado de herramienta pendiente. Esto evita que un recordatorio recién agregado reescriba el indicador principal del sistema, y evita que una instrucción de conversación intermedia llegue antes de los giros que se escribió a seguir. El papel que lleva la ranura se decide por separado: un recordatorio se envía como `system` a menos que el proveedor registre `foldDeveloperRoleToSystem: false`, que establece que el flujo ascendente acepta el papel `developer` y lo reenvía en la misma posición. Un flujo arriba que no lo acepta responde `400 role 'developer' is not allowed` y el giro nunca comienza, por lo que un destino no registrado se pliega. Esto se aplica con o sin `stabilizePromptCache`, y el paso a través de Anthropic nativo no cambia. La reutilización de caché todavía requiere una identidad de sesión estable y disponibilidad de caché ascendente. Los cambios en las instrucciones o herramientas anteriores, y la compactación de la conversación, aún pueden afectar los golpes de caché; preservar el orden del recordatorio por sí solo no garantiza la reutilización.

<a id="intercept-token-recovery"></a>

### Interceptar la recuperación de token

El proxy autenticado en ejecución valida el token actual para cada nueva solicitud CONNECT. Una aplicación explícita de primera parte recrea un token faltante y actualiza la configuración de propiedad sin requerir un reinicio proxy; los túneles existentes no se revocan. Los archivos no válidos, vinculados, de gran tamaño o no token se rechazan en lugar de sobrescribirse. Inspeccione dicha entrada antes de eliminar solo el archivo de token obsoleto confirmado y vuelva a aplicar el modo de primera parte; nunca elimine su destino de enlace.

<a id="first-party-picker-context-markers"></a>

### Marcadores de contexto de selector de primera parte

El selector de pestañas de código de escritorio agrega `[1m]` a modelos enrutados cuya ventana de contexto de catálogo efectiva es de al menos un millón de tokens o al menos el umbral de compactación predeterminado de 829.800 tokens (por ejemplo, un modelo nativo GPT-6 elegido en su ventana 872k), por lo que Claude usa su contabilidad 1M en lugar del modelo personalizado más pequeño. Los modelos Claude en una ruta Anthropic todavía necesitan un genuino 1M. Las etiquetas, el orden del perfil y las rutas del proveedor se mantienen sin cambios. Las ventanas desconocidas y más cortas permanecen sin marcar. El selector no puede garantizar que un corredor de escritorio o remoto reciba el entorno de compactación correspondiente, por lo que un modelo de ventana larga que supere su ventana real obtiene un error `prompt is too long`, que Claude Code responde compactando. El escritorio 3P `supports1m` / `prefer1m` y los subagentes generados siguen la misma regla. La configuración de contexto automático emparejado para `ocx claude` no cambia. Una conversación existente mantiene su selector guardado hasta que vuelva a seleccionar el modelo en el selector actualizado.

<a id="forced-claude-code-subagent-model"></a>

### Modelo de subagente forzado Claude Code

La página Subagentes ofrece **Forzar un modelo para todos los subagentes**, una opción **desactivada de forma predeterminada**. Selecciona un identificador disponible en la lista, como `combo/tev-auto`, y después activa la opción. Primero se ofrece la lista de modelos; las entradas guardadas que ya no estén disponibles no se pueden usar como destino forzado.

`ocx agent subagents force combo/tev-auto` conjuntos `claudeCode.subagentModelForce`; `ocx agent subagents force -` lo aclara. `ocx agent status` informa de la configuración. `GET /api/subagent-models` devuelve `force`, `forceAvailable` y `forceStatus`; `PUT` acepta `{ "force": "combo/tev-auto" }` o `{ "force": null }` sin cambiar la lista. Omitir `force` lo deja sin cambios. Los objetivos inválidos o no expuestos son rechazados en la escritura; los objetivos obsoletos son reportados y omitidos en el lanzamiento.

Esto tiene efecto en el **siguiente inicio enrutado de `ocx claude`**, inyectando `CLAUDE_CODE_SUBAGENT_MODEL` como un alias proxy explícito (con `[1m]` cuando la ventana de catálogo efectiva alcanza el piso fijo de 829.800 tokens, y solo para una ventana genuina de 1 M en los modelos Anthropic Claude y selectores desnudos `claude-*`; los objetivos nativos Claude usan un alias nativo reversible) y `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. Cada variable no vacía exportada por el shell gana independientemente. Los lanzamientos nativos no inyectan ninguna variable; el `claude` simple no se ve afectado. No hay archivos de plugin o `settings.json` son modificados por esta configuración.

Claude Code **2.1.257 o más reciente** es necesario para la fuerza. Los argumentos de modelo de complemento y agentes incorporados (incluyendo Explorar/Planear) y por llamada se anulan. Las bifurcaciones y las habilidades de subagente con `model: inherit` mantienen el modelo de conversación principal. El bucle principal y los sidecars de pequeño-rápido no se ven afectados. Los archivos de la lista existentes permanecen disponibles.

El panel de control advierte sobre versiones antiguas o desconocidas de CLI, objetivos no disponibles y cualquiera de las variables ya presentes en `settings.json` → `env` (que anula env de lanzamiento). La detección es de solo lectura y local en el servidor: no puede inspeccionar otro shell de lanzamiento, otra máquina o la configuración local del proyecto. Un resultado desconocido no es prueba de apoyo a la fuerza.

Los selectores de puerta de enlace explícitos en una solicitud de agente generada tienen prioridad sobre su alternativa heredada `ocx-route`, incluso si la configuración de fuerza guardada cambia después del lanzamiento. Para las anulaciones de configuración o shell de los agentes de lista generados, use un alias de puerta de enlace explícito; los ids desnudos de Claude retienen el comportamiento de respaldo del cliente más antiguo. Los alias nativos restauran su modelo desnudo antes de las verificaciones de credenciales y mapas de modelo existentes. Los lanzamientos conectados validan los objetivos de fuerza contra un nuevo catálogo de puerta de enlace autenticado; el descubrimiento fallido omite la inyección automática de fuerza y las ventanas de contexto en caché por sí solas nunca demuestran disponibilidad.
