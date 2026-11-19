---
title: "Proveedores"
description: "Autenticación y comunicación con proveedores de LLM: OAuth, claves API, reenvío de ChatGPT y modelos locales."
---

Un **proveedor** es un punto final de LLM ascendente más cómo llegar a él: un adaptador, una URL base, un modo de autenticación y una lista de modelos opcional. Los proveedores viven bajo `providers` en `~/.opencodex/config.json`.

La vista general del proveedor del panel separa los detalles de conexión, el uso de la cuenta y las notas editables. Las notas aparecen una vez, debajo de las secciones de conexión y autenticación. Los ajustes preestablecidos de patrocinador compatibles también muestran una breve introducción, una etiqueta de patrocinador y enlaces al sitio o consola del proveedor. Estos enlaces conservan los parámetros de referencia del preset. La información del patrocinador se muestra solo cuando el nombre del proveedor configurado, el adaptador y el punto final coinciden con el ajuste preestablecido; nunca cambia el enrutamiento, la selección de la cuenta o los valores predeterminados.

<a id="openai-account-modes"></a>

## Modos de cuenta OpenAI

| Id de proveedor | Uso | Regla de credenciales/cuenta |
| --- | --- | --- |
| `openai` | Codex inicio de sesión | Pool (predeterminado) selecciona las cuentas principales más las cuentas agregadas; Direct utiliza el inicio de sesión actual de la persona que llama/principal solamente. |
| `openai-apikey` | OpenAI API | Solo clave API o grupo de claves configurado; nunca lee cuentas Codex. |

Utilice `gpt-5.6-sol` desnudo con la opción Pool / Direct en la página de proveedores, o `openai-apikey/gpt-5.6-sol` para API. Las rutas de credenciales nunca se cruzan entre sí. La ruta API publica 1,050,000 metadatos de entrada de contexto / 922,000 máximos. Sus identificadores virtuales `sol-pro`, `terra-pro` y `luna-pro` mantienen su identidad pública seleccionada, mientras que el cable utiliza el modelo base más `reasoning.mode: "pro"`.

Si el proveedor `openai` integrado no está disponible o está desactivado, el selector de cuentas del panel de control y la página Codex Auth pueden restaurarlo: las filas ausentes se crean a partir del preajuste canónico, las filas canónicas deshabilitadas se vuelven a habilitar sin reemplazar la configuración del modelo o modo guardado, y no canónicas a las filas `openai` no se les ofrece esa ruta de recuperación.

La compatibilidad con Luna Reserve es una capacidad de cuenta ChatGPT en la ruta de avance canónica OpenAI, no un derecho de clave OpenAI API. Su selector manual de almacenamiento principal requiere el ajuste `codexReserveEnabled` en un proxy loopback que no es cliente y un permiso de flujo ascendente actual vinculado a credenciales; una entrada de catálogo por sí sola no autoriza una solicitud. Consulte [Luna Reserve junto a modelos enrutados](/es/reference/cli/providers-accounts/#luna-reserve-alongside-routed-models) para ver la configuración, el orden de reinicio, los requisitos de autorización y los ayudantes no compatibles.

Para añadir una cuenta con cuota agotada y finalizar su validación diferida, véase [Codex calentamiento de la cuenta](/es/guides/codex-integration/#codex-account-warmup).

<a id="providers-overview-pool-capacity"></a>

### Capacidad del grupo

Para el inicio de sesión Codex en el modo Pool, la descripción general de proveedores muestra una estimación del peso configurado de la capacidad utilizada del grupo en lugar de presentar una cuenta arbitraria como el total del proveedor. La misma fila también muestra el porcentaje de cuota en bruto de la cuenta efectiva actual, para que pueda distinguir la estimación del grupo de la cuenta que usaría una nueva solicitud.

Cuando la información de restablecimiento está disponible, la visión general muestra el siguiente tiempo de restablecimiento y la capacidad que se espera que se recupere como `+N% pool capacity`. **Cobertura incompleta** significa que una o más cuentas del grupo no podrían contribuir de manera segura a la estimación, por ejemplo, porque su plan o cuota es desconocido, su lectura es obsoleta o la cuenta está pausada o necesita reautenticación.

Las cuentas Business Premium identificadas como `self_serve_business_prolite` cuentan como cinco unidades Standard en esta estimación. Ese peso solo sirve para mostrar capacidad: no selecciona cuentas ni crea una ventana de cinco horas si el proveedor solo informa uso semanal. La calibración sigue los [límites oficiales de Business](https://help.openai.com/en/articles/12003714-chatgpt-business-models-and-limits), comprobados el 20 de octubre de 2026. Los planes desconocidos mantienen el peso base y se informa su cantidad.

Una advertencia de **Cobertura de ventana parcial** significa que algunas cuentas incluidas informaron una ventana de cuota pero no otra. La descripción general mantiene esas ventanas separadas y marca cada ventana afectada incompleta en lugar de tratar la lectura faltante como uso para esa ventana.

Esta estimación es solo de visualización. No cambia la selección de cuenta, afinidad de sesión, conmutación automática, tiempos de reutilización o cualquier otra decisión de enrutamiento. Utilice el [Codex Fondo de cuenta de Auth](/es/guides/web-dashboard/#codex-auth-and-account-pools) para los controles de estado y enrutamiento de la cuenta individual.

Las configuraciones v1 enviadas migran automáticamente al marcador 2 y a una fila consciente de las opciones. La configuración original se conserva una vez en `~/.opencodex/config.json.pre-openai-tiers-v2.bak`; restaurarlo con `cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json`.

<a id="claude-opus-55-progress-updates"></a>

## Actualizaciones de progreso de Claude Opus 5.5

Cuando el adaptador `anthropic` envía Claude Opus 5.5 a `api.anthropic.com`, mediante OAuth o clave API, OpenCodex usa de forma predeterminada el [modo de actualizaciones de progreso](https://platform.claude.com/docs/en/build-with-claude/thinking#progress-updates) de Anthropic. Las actualizaciones y los avisos intermedios aparecen como comentarios visibles del asistente en Codex, incluso si los resúmenes de pensamiento están ocultos. En este modo se omiten los resúmenes de razonamiento porque Anthropic no puede distinguir las actualizaciones del razonamiento con `display: "summarized"`. Los bloques de pensamiento firmados originales se conservan para continuar con las herramientas; no se decodifican ni reescriben sus firmas. Las actualizaciones aparecen cuando termina su bloque firmado. Los demás modelos y los endpoints compatibles de terceros conservan su comportamiento actual.

Para pedir pensamiento resumido, envía explícitamente `reasoning.summary: "concise"` o `"detailed"`. OpenCodex envía entonces `thinking: {type: "adaptive", display: "summarized"}` sin la beta de actualizaciones y devuelve el pensamiento como razonamiento, en lugar de comentarios de progreso. En ese modo, las actualizaciones de Anthropic pueden quedar integradas en el resumen de razonamiento. También funciona si se omite el esfuerzo de razonamiento o vale `"none"`; no cambia el esfuerzo solicitado. Omitir `reasoning.summary` o enviar `"auto"` (predeterminado de Codex) o `"none"` conserva el modo de actualizaciones. La ocultación local del resumen sigue controlando la visibilidad del razonamiento y no oculta los comentarios de progreso en ese modo.

<a id="anthropic-image-input"></a>

## Entrada de imagen Anthropic

Las semillas modelo Claude incorporadas anuncian la entrada de texto e imagen para `anthropic` (OAuth) y `anthropic-apikey`, consistente con [la visión general de los modelos de Anthropic](https://platform.claude.com/docs/en/models/overview). Las anulaciones explícitas de la modalidad de entrada por modelo siguen siendo autorizadas; los modelos desconocidos no se asumen con capacidad de imagen. Esto se aplica a todas las integraciones donde la configuración del cliente admite metadatos de capacidad de imagen: OpenClaw exporta una matriz `input` declarada, y Kimi Code exporta `capabilities: ["image_in"]` solo para modelos con entrada de imagen y añade `"thinking"` si el modelo declara una escala de esfuerzo. Kimi Code también recibe esa escala como `support_efforts`, limitada a `low`, `medium`, `high`, `xhigh` y `max`, en ese orden, y el valor declarado de `default_effort` si pertenece a la escala. OpenClaw omite `input` cuando no se declaran modalidades compatibles; Kimi omite `capabilities` para los modelos que no declaran entrada de imagen ni escala de esfuerzo. Los clientes sin un campo de capacidad compatible mantienen su forma de configuración existente. Después de actualizar opencodex, regenerar o actualizar la configuración del cliente gestionada por opencodex para recibir los metadatos actualizados.

<a id="replayed-anthropic-thinking-signatures"></a>

## Firmas de pensamiento Anthropic reproducidas

En el punto final Responses, un flujo ascendente compatible con Anthropic puede rechazar una firma de pensamiento reproducida porque pertenece a un prefijo de conversación diferente. Cuando el error identifica explícitamente este problema de firma vinculante, opencodex puede eliminar el pensamiento firmado/redactado reproducido y volver a intentarlo una vez dentro del presupuesto de envío de la solicitud. Esto cubre HTTP 400 rechazos y errores de flujo iniciales antes de la salida o la actividad de la herramienta. La búsqueda web alojada y los puentes de imagen/vídeo comparten un límite de recuperación a través de sus iteraciones de modelo: solo se reenvía la inferencia rechazada, mientras que se conservan las llamadas de sidecar completadas y los resultados de la herramienta. Un reintento de finalización vacía comparte la asignación de su solicitud; las continuaciones ordinarias después de la salida no pueden usarla. Un reemplazo fallido se devuelve sin otro reintento de firma. Otros errores mantienen su manejo existente.

La recuperación de Sidecar se desactiva cuando la contabilidad de gastos forzada no puede establecer recibos para envíos anteriores de sidecar ordinarios. Nunca aumenta la asignación de envío de llamadas o combo.

Solo una finalización exitosa y no vacía recuerda el rechazo de esa conversación y la identidad de servicio durante cinco minutos. Solo las cargas útiles opacas rechazadas se suprimen cuando pueden ser identificadas; el pensamiento recién emitido sigue siendo reproducible. El historial de texto sin formato permanece disponible; un reintento fallido o cancelado no inhabilita la repetición de pensamiento en solicitudes posteriores.

<a id="xai-responses-includes"></a>

## Inclusiones de xAI Responses

En las solicitudes Responses de xAI, OpenCodex elimina de `include` la entrada no admitida `output.encrypted_content`, también en el [endpoint regional de EE. UU.](https://docs.x.ai/developers/advanced-api-usage/regions). Conserva las demás entradas; si no queda ninguna, omite el campo. Los demás proveedores no se ven afectados.

<a id="auth-modes"></a>

## Modos de autenticación

Las configuraciones de proveedor aceptan tres valores `authMode` (`key` es el valor predeterminado). El registro incorporado también etiqueta los preajustes locales por separado; los que normalmente omiten tanto `authMode` como `apiKey`.

| `authMode` | Cómo se autentica | Utilizado por |
| --- | --- | --- |
| `key` | Envía su llave API (`Authorization: Bearer …`, o `x-api-key` / `api-key` por adaptador). La clave puede ser una referencia literal o una referencia `${ENV_VAR}`. | La mayoría de los proveedores. |
| `forward` | Relés **tus encabezados de autenticación entrantes Codex** verbatim al proveedor - sin clave almacenada. Este es el passthrough de inicio de sesión ChatGPT. | OpenAI (adaptador `openai-responses`). |
| `oauth` | Resuelve un token de acceso OAuth almacenado (actualizado automáticamente antes de la expiración) y lo usa como la clave portadora. | xAI, Anthropic, Kimi, Kiro, Google Antigravity, Cursor, Zed Hosted AI, Command Code, GitHub Copilot, Nous Portal. |

La repetición de un error 429 con la misma clave mediante [`retryOn429`](/es/reference/configuration/) solo se aplica a proveedores con clave API (`authMode: "key"`). OAuth, el reenvío de credenciales y los preajustes locales quedan excluidos: sus credenciales no deben repetirse en el mismo token y los entornos locales no tienen una clave remota que conservar. La opción debe habilitarse expresamente, salvo los valores predeterminados documentados para destinos concretos. Mistral Chat oficial usa una política de espera con seis repeticiones e intervalo alternativo de diez segundos, dentro del límite de envíos de la solicitud. Las opciones explícitas de `retryOn429`, incluido `enabled: false`, tienen prioridad. El preajuste de Mistral también reenvía por defecto las claves de caché de instrucciones que recibe; `promptCacheKey: false` lo desactiva. La afinidad de caché mejora la posibilidad de reutilizarla, pero no garantiza un acierto ni elimina los límites de tokens por unidad de tiempo.

Mistral usa un único proveedor con clave API para las claves de Studio y Vibe. La [documentación de claves API de Mistral](https://docs.mistral.ai/admin/identity-access/api-keys) describe los tipos de claves y límites de los planes; el proxy no deduce el nivel de suscripción de la clave. En `https://api.mistral.ai/v1`, el panel lee los presupuestos de API y Vibe desde `/v1/billing/budget` y el plan desde `/v1/billing/subscription`, usando la credencial y salida de inferencia. Las ventanas medidas muestran uso, total y nombre de plan reconocido. Los presupuestos solo se muestran: no ordenan claves, enrutan ni pausan tráfico, ni entran en el grupo de cuotas. Los presupuestos ausentes, malformados o no positivos, las monedas malformadas, los porcentajes fuera de rango y los nombres de plan desconocidos se consideran desconocidos o se omiten. Las últimas lecturas válidas aún recientes sobreviven a 402, 408, 429, 5xx y fallos de transporte, pero 401, 403 y otros rechazos de cliente no reintentables las suprimen.

Para cada modelo, los plazos explícitos ascendentes de `Retry-After` se comparten entre llamadas con la misma credencial y modelo; la [referencia de `retryOn429`](/es/reference/configuration/providers/) explica la espera de recuperación tras un 429 sin plazo, su única prueba y cómo desactivarla con `requestPacing` y `respectRetryAfter`. Las ventanas de contexto y preferencias de compactación por modelo siguen siendo independientes.

La cabecera del proveedor también muestra los límites de solicitudes y tokens observados pasivamente para OpenAI, Anthropic, xAI, Groq y Mistral, por clave y modelo observados; la [guía del panel](/es/guides/web-dashboard/) explica estas lecturas que solo se muestran y nunca consultan el llavero del sistema ni afectan al enrutamiento.

Cuando la selección de claves por round-robin está habilitada, las solicitudes en cola vuelven a comprobar los enfriamientos de claves antes de enviarse y adquieren capacidad de ritmo para cualquier clave de reemplazo. Esto se aplica a Chat nativo, Messages, Responses y compacto. Esperar la capacidad de una clave de reemplazo no consume el tiempo de espera del encabezado de respuesta aguas arriba. El control del ritmo por clave y la selección round-robin usan HTTP/SSE protegido incluso cuando los WebSockets aguas arriba están habilitados; la dirección y la inyección exclusivas por WebSocket requieren una ruta sin esas políticas de claves. Esto no cambia la clave activa guardada. Un turno aguas arriba ya establecido conserva su credencial; los envíos posteriores se rechazan si esa clave entra en enfriamiento. Un rechazo de clave antes de la salida puede recuperar una clave sana dentro del límite de solicitud existente. Las solicitudes de Direct Images y de compactación registran los enfriamientos reales 401/429 sin reproducir ese POST de pago.

<a id="anthropic-api-key-credit-exhaustion"></a>

### Agotamiento de crédito de las claves API de Anthropic

Los grupos de claves de la API de Anthropic con al menos dos claves intentan automáticamente una clave hermana cuando un error HTTP `400` o `402` completo indica que el saldo de crédito es demasiado bajo para acceder a la API de Anthropic. Esto se aplica a `invalid_request_error`, `billing_error` y `permission_error` antes de cualquier salida de texto o de herramienta. Las estrategias de rotación y de grupo omiten la clave fallida durante una hora, porque un saldo vacío solo se repone cuando se añaden créditos; cuando todas las claves están sin crédito, las solicitudes siguen usando la clave activa y devuelven el error original de Anthropic; elegir la clave como activa en el panel o reiniciar el proxy borra esa retención tras una recarga. El reemplazo comparte el límite de envío de la solicitud. Los errores `400` ordinarios son fallos terminales, y esto no habilita reintentos de la misma clave ni cambia el enrutamiento de la cuenta OAuth. Una anulación de encabezado que envía una credencial distinta no puede enfriar ni rotar la clave de grupo seleccionada.

<a id="which-account-a-request-spends"></a>

### Que cuenta gasta una solicitud

La pregunta que la gente hace antes de conectar una cuenta es si opencodex se basará en la suscripción que el inicio de sesión ya paga, o facturará una cuenta separada API. La respuesta sigue el nivel de marketing anterior `authMode` en lugar del nivel de marketing del proveedor.

- `forward` - el inicio de sesión ChatGPT. La solicitud lleva su credencial Codex, por lo que gasta el plan ChatGPT detrás de ese inicio de sesión e informa las ventanas de cuota Codex de ese plan. Qué ventanas existen depende del plan: no todos los planes tienen una ventana de cinco horas. Nunca se lee una clave API.
- `oauth` - un inicio de sesión de suscripción. La solicitud lleva un token de acceso almacenado, por lo que gasta cualquier cuenta que haya iniciado sesión como, y opencodex informa cualquier ventana de uso que el proveedor expone.
- `key` - la solicitud lleva la clave que usted proporcionó, por lo que el uso aterriza en la cuenta que posee esa clave, en los propios términos de esa clave. Eso es uso medido para una cuenta de pago por uso API, pero una asignación de plan cuando la clave *es* una suscripción: Z.AI GLM Coding Plan, Kimi Code, el plan de codificación BigModel, Command Code y CodeBuddy todos venden uno de esa manera.

Una solicitud utiliza exactamente uno de estos, y el opencodex no se devuelve de uno a otro. Cuando no se puede resolver una credencial OAuth, la solicitud falla con un error de autenticación en lugar de alcanzar una clave almacenada, y la conmutación por error de grupo de claves que responde a un 429 o un 401 se rechaza completamente para OAuth y los proveedores de reenvío.

Dos excepciones vale la pena conocerlas porque puedes golpearlas:

- `xai` y `github-copilot` aceptan `authMode: "key"` en el mismo ID de proveedor, y si ese proveedor ya tenía una clave almacenada, ejecutar `ocx login` puede dejarlo en modo clave en lugar de cambiarlo a la suscripción. Lo que eso cambia es: una clave `xai` reorienta al proveedor a `https://api.x.ai/v1`, por lo que una cuenta diferente paga, mientras que una clave `github-copilot` sigue siendo una credencial de Copiloto contra `api.githubcopilot.com`, por lo que la suscripción de Copiloto paga de cualquier manera.
- `orcarouter-oauth` es un flujo de consentimiento que acuña una clave de usuario `sk-orca-…` API. Una vez que lo ha hecho, la solicitud lleva una clave, por lo que sigue la regla `key` anterior.

Los esfuerzos Mistral aceptados se declaran por modelo en `modelReasoningEfforts`; exportaciones como `ocx export --client opencode` solo ofrecen esos valores. El catálogo Codex añade `ultra` y `max` si falta, y los limita al mayor admitido:

| Modelo | Esfuerzos |
|---|---|
| `zai-glm-5-3`, `zai-glm-5-3-flash` | `low`, `high`, `max` |
| `mistral-large-4`, `mistral-large-4-0` | `low`, `medium`, `high` |
| `deepseek-v4-1-flash-1017` | `low`, `high`, `xhigh`, `max` |

GLM y Large 4 siguen la [guía de razonamiento Mistral](https://docs.mistral.ai/capabilities/reasoning). La fila DeepSeek se midió con HTTP 200 en noviembre de 2026, pues Mistral no documenta esos valores; puede cambiar. Una fila propia reemplaza la del registro. En Chat nativo con razonamiento, `ultra` pasa a `max` o al máximo declarado inferior, `high` en Large 4, salvo que la escala admita ultra. `reasoningEffortMap` se aplica al valor final y `__omit__` omite el campo. Con pensamiento y esfuerzo independientes, el esfuerzo también selecciona el interruptor; las rutas antiguas conservan su discriminador. `noReasoningModels` elimina `reasoning_effort`. Otros valores se conservan salvo fijación o límite que los reescriba.

<a id="providers-that-accept-both-a-login-and-a-key"></a>

#### Proveedores que aceptan tanto un inicio de sesión como una clave

| Proveedor | Inicio de sesión de suscripción | Clave API |
| --- | --- | --- |
| OpenAI / ChatGPT | `openai` - Codex inicio de sesión; gasta el plan ChatGPT detrás de él | `openai-apikey` - un proveedor separado; el uso aterriza en la cuenta de la plataforma OpenAI que posee la clave |
| Anthropic | `ocx login anthropic` - inicia sesión como su cuenta Claude. opencodex lee sus ventanas de uso de cinco horas y siete días; ese punto final no informa ningún nivel de suscripción | `anthropic-apikey` - facturación directa Anthropic API, no Claude suscripción |
| xAI | `ocx login xai` - la pasarela de suscripción Grok CLI. opencodex lee los créditos semanales de SuperGrok, o el grupo mensual | el mismo proveedor `xai` con `authMode: "key"`, que apunta `https://api.x.ai/v1`, por lo que el uso aterriza en esa cuenta API |
| Kimi | `ocx login kimi` — inicie sesión con su cuenta Kimi. `kimi-responses` es el mismo inicio de sesión de la cuenta Kimi enrutado por el cable de OpenAI Responses (el contenido de razonamiento permanece cifrado en el servidor, mientras que las llamadas a herramientas siguen visibles; el preajuste predeterminado de Chat mantiene el razonamiento en texto plano) | `kimi-code` — la forma de clave API del mismo transporte del plan Kimi Code |
| Command Code | `ocx login command-code` — opencodex lee ventanas de cinco horas y semanales más un saldo de crédito | `commandcode` — el mismo servicio en `/provider/v1` con una clave |
| GitHub Copilot | `ocx login github-copilot` - requiere una suscripción activa a Copilot | el mismo proveedor `github-copilot` con `authMode: "key"`. El flujo de dispositivos anterior es la ruta de acceso admitida, y cualquiera de las credenciales es una Copilot, por lo que la suscripción aún paga |
| OrcaRouter | `ocx login orcarouter-oauth` — el consentimiento acuña una clave `sk-orca-…` de larga duración, propiedad del usuario, y la solicitud pasa a llevar una clave | `orcarouter` — la misma clave pegada a mano |
| Meta Muse | `ocx login meta-muse` puede importar una clave local del CLI de Muse Code o iniciar el inicio de sesión por dispositivo. Meta limita esa credencial a su propio CLI, por lo que este es un uso no compatible: cómo se liquidan las llamadas no es observable desde la API, y debe tratar cada llamada como facturable en su cuenta | `meta-model` es la ruta admitida: cada llamada se mide por token, y una suscripción a Muse Code no funciona allí |

Cuando el catálogo de suscripción de Grok publica ventanas de contexto seleccionables, opencodex usa el nivel más amplio: `[256000, 500000]` expone 500k para Grok 4.5–4.7, incluida la ruta Fast de 4.7. La ventana configurada del modelo y el límite de contexto habilitado pueden reducir ese valor. Si tu plan ofrece menos, configura ese límite: el catálogo no verifica el derecho de acceso de la cuenta.

Cursor, Kiro, Zed Hosted AI y Nous Portal son solo de inicio de sesión y no tienen el equivalente de clave API. Google Antigravity también es solo para iniciar sesión: `ocx login google-antigravity` inicia sesión con su cuenta Google a través del cable de Cloud Code Assist, y el ajuste preestablecido `google` al lado es el AI Studio Gemini API, un producto diferente al que se llega con su propia clave, no un modo de clave para el mismo inicio de sesión.

:::danger[Google puede desactivar Gemini y Antigravity en la cuenta Google]
El inicio de sesión de Antigravity está pensado para la propia aplicación Antigravity de Google. Usuarios de herramientas de terceros han informado de que el acceso a Gemini y Antigravity de sus cuentas Google se desactivó con "This service has been disabled in this account for violation of Terms of Service." La suspensión abarca el acceso a Gemini Code Assist y Antigravity de esa cuenta, y recuperarlo depende del proceso de apelación de Google. Inicie sesión solo con una cuenta Google independiente que pueda permitirse perder, nunca con una cuenta principal, personal, escolar o de trabajo; una clave API de Gemini es la opción más segura. OpenCodex pide una confirmación explícita antes de cada inicio de sesión, reautenticación o importación de Antigravity: una casilla en el panel, una respuesta `y` o `--accept-antigravity-risk` en la CLI.
:::

Si el inicio de sesión de Antigravity no descubre un proyecto de Cloud Code Assist, el fallo incluye un resumen saneado de `loadCodeAssist` y de la última respuesta `onboardUser`: estado HTTP, categoría de respuesta, presencia de finalización o error y tipos de los campos de proyecto conocidos. Distingue un rechazo HTTP, JSON inutilizable, una raíz no válida, una incorporación sin terminar y una finalización con error o sin proyecto. Omite valores del proveedor, nombres arbitrarios de claves e identificadores de cuentas o proyectos. El inicio de sesión sigue requiriendo un proyecto descubierto; no se guarda ninguna cuenta si el descubrimiento falla.

La pestaña Cuentas Antigravity muestra un nivel de membresía observado como una insignia junto a la etiqueta de la cuenta, utilizando el ID de nivel ascendente (por ejemplo, `free-tier` o `gemini-pro`). No aparece ninguna insignia cuando el plan es desconocido; no afecta el enrutamiento ni la cuota.

Gemini 4 Argon (`gemini-4-argon`) aparece en el preajuste `google` con niveles de pensamiento bajos, medios (el predeterminado) y altos. Google lo ofrece solo en el nivel pagado Gemini API, no en el nivel gratuito. El `google-antigravity`, Argon aparece con los mismos tres niveles, que se asignan a los modelos del protocolo `gemini-4-argon-low`, `-medium` y `-high`. Google lo limita a las cuentas AI Ultra y Enterprise elegibles. Cloud Code Assist sirve Argon solo al cliente Antigravity CLI, por lo que OpenCodex envía todas las solicitudes de modelos Gemini 4 y el descubrimiento de modelos con el CLI User-Agent (`antigravity/cli/1.3.4` ) y mantiene el IDE User-Agent para cualquier otro modelo. Gemini 4 Hydrogen (low, medium, high por defecto y xhigh) aparece en `google-antigravity` solo cuando la lista de modelos de tu cuenta lo incluye, y cada nivel se asigna a su modelo del protocolo `gemini-4-hydrogen-*`; solicitar `max` o `ultra` también selecciona xhigh.

En Vertex AI, `gemini-4-argon`, `gemini-4-carbon` y `gemini-4-hydrogen` reciben las imágenes devueltas por herramientas, como capturas de pantalla, dentro de la respuesta de función correspondiente. El descubrimiento de modelos de Vertex AI, sus reglas de credenciales y este tratamiento se describen en [Google Vertex AI](/es/guides/google-vertex/).

Para Gemini en Antigravity, incluyendo Argon, los resúmenes de pensamiento marcados por el proveedor se mantienen separados de la respuesta: Responses usa elementos de resumen de razonamiento, Chat Completions usa `reasoning_content` y Messages usa `thinking` bloques. Los clientes deciden cómo mostrar esos campos. Un cliente Responses puede solicitar `reasoning.summary: "none"` para suprimir resúmenes; esto no desactiva el razonamiento interno del modelo. Una firma de pensamiento es metadatos de continuación y puede acompañar al texto ordinario, por lo que su presencia por sí sola no oculta ese texto. OpenCodex conserva texto de respuesta sin marcar incluso cuando su redacción suena como planificación o análisis.

Los modelos Gemini, Argon en particular, a veces se saltan el pensar en un turno de llamada de herramientas y escriben su planificación en el texto de progreso visible, por ejemplo, una línea de progreso seguida de "Leamos google.ts a continuación". Una vez que el texto se envía de vuelta como historia, el modelo tiende a repetir el patrón en cada turno posterior. Para evitar que se extienda, OpenCodex envía Gemini solo la primera oración del texto que llegó antes de una llamada de herramienta en giros anteriores. Las respuestas finales se devuelven por completo y lo que muestra su cliente no se cambia.

La lista integrada de `google-antigravity` incluye Gemini 3.8 Flash (`gemini-3.8-flash`), Gemini 4 Argon (`gemini-4-argon`), Claude Opus 5.5 (`claude-opus-5-5`) y Claude Sonnet 5.5 (`claude-sonnet-5-5`), con esfuerzo bajo, medio y alto. La lista que ves procede del descubrimiento de tu cuenta: Google habilita modelos por cuenta. Algunas ofrecen Claude Sonnet 4.6 y Claude Opus 4.6 (Thinking); otras, solo Claude Opus y Sonnet 5.5 en planes Pro o Ultra de facturación directa y sin prueba; Gemini 4 Argon requiere Ultra o Enterprise. Ambas generaciones de Claude se pueden mapear: 4.6 recibe un nivel de pensamiento; 5.5, una variante de modelo `-low`, `-medium` o `-high`.

Las solicitudes de Antigravity solo se envían a cuentas que puedan atender el modelo solicitado. OpenCodex conserva en memoria durante seis horas la lista obtenida del descubrimiento de cada cuenta. Prefiere una cuenta que incluya el modelo. Si una cuenta no tiene una lista vigente —porque aún no se consultó, caducó o se perdió al reiniciar— todavía puede usarse, ya que no hay evidencia de que carezca del modelo. Una cuenta cuya lista vigente lo omita nunca recibe la solicitud, tampoco durante la recuperación ante errores 429 o de autenticación. Si la cuenta seleccionada lo omite y `oauthAccountFailover.enabled` está activado, se intenta otra cuenta que no esté en pausa ni requiera reautenticación. En caso contrario, OpenCodex rechaza localmente la solicitud con HTTP 403 `permission_denied` sin enviar nada al proveedor:

- `The selected Google Antigravity account does not list the model "<model>" in its model discovery. Select an account that lists it, or enable oauthAccountFailover so OpenCodex can choose one.` Otra cuenta utilizable podría atender el modelo, pero la conmutación está desactivada.
- `The selected Google Antigravity account does not list the model "<model>" in its model discovery, and no account that may serve it could be used for this request. Retry the request.` La conmutación eligió otra cuenta, pero no se pudo usar para esta solicitud.
- `No usable Google Antigravity account lists the model "<model>" in its model discovery. Choose a model your accounts list, or add an account that has access to it.` Todas las cuentas utilizables omiten el modelo en sus listas vigentes.

Una selección guardada de un modelo que ya no aparezca en la lista sigue las mismas reglas.

Para comprobar qué modo está utilizando realmente un proveedor, ábralo en la página Proveedores: la fila **Autenticación** del bloque **Conexión** lee `OAuth`, `API key`, `ChatGPT passthrough`, `Local` o `No key needed`. Es una configuración a nivel de proveedor, por lo que las filas de la cuenta debajo de ella no la repiten.

<a id="1-chatgpt-login-forward--passthrough"></a>

## 1. Inicio de sesión ChatGPT (adelante / paso)

El proveedor `openai` **no necesita clave API**. Direct reenvía las credenciales de su `codex login` existente; Pool resuelve una cuenta Codex principal o añadida antes de usar el mismo backend:

```json
{
  "openai": {
    "adapter": "openai-responses",
    "baseUrl": "https://chatgpt.com/backend-api/codex",
    "authMode": "forward"
  }
}
```

Solo se reenvía un conjunto curado de encabezados (`FORWARD_HEADERS`: autorización, ChatGPT cuenta id, OpenAI beta/originador/sesión - ver [Adaptadores](/es/reference/adapters/)). Este camino es también el que alimenta el [web-search y sidecars de visión](/es/guides/sidecars/).

El catálogo ChatGPT passthrough también se superpone en las identificadores GPT-5.6 Sol / Terra / Luna (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` ) para las cuentas que pueden usarlas.

<a id="2-account-login-oauth"></a>

## 2. Inicio de sesión de la cuenta (OAuth)

Para cuentas profesionales o educativas de Microsoft, consulta la [configuración de Microsoft 365 Copilot](/es/guides/m365-copilot/).

Los ajustes preestablecidos del proveedor pueden usar el inicio de sesión de la cuenta, incluido el GitHub Copilot, a través de un puente experimental no oficial de flujo de dispositivos. opencodex almacena sus credenciales en `~/.opencodex/auth.json`; los tokens actualizables se actualizan automáticamente, mientras que las claves duraderas se reutilizan hasta que el proveedor las revoca. `ocx login codex` también es aceptado, pero no es uno de estos proveedores: se dirige al grupo de cuentas Codex, el mismo flujo que `ocx account login codex`, que mantiene su propio libro de cuentas y necesita un proxy en ejecución. `chatgpt` y `openai` son alias de esa ruta.

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx login nous         # Nous Portal (device grant; free + paid models)
ocx login kiro         # import kiro-cli credentials (or token fallback)
ocx login google-antigravity
ocx login cursor       # standalone Cursor PKCE login
ocx login zed          # Zed native-app callback login (experimental)
ocx login command-code # Command Code browser OAuth (or import ~/.commandcode/auth.json)
ocx login orcarouter-oauth # OrcaRouter browser consent + PKCE
ocx login devin       # Cognition/Devin: import Devin CLI credential, else Auth0 browser sign-in
ocx login dsh-account # DeepSeek Harness Desktop (import ~/.dsh/.credentials.yaml grant)
ocx login github-copilot  # GitHub device flow → Copilot token (Copilot account)
ocx login codex        # Codex account pool (aliases: chatgpt, openai; needs a running proxy)
ocx logout <provider>
```

| Proveedor | Adaptador | URL base | Notas |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://cli-chat-proxy.grok.com/v1` | OAuth utiliza la pasarela de suscripción separada Grok CLI. La anulación de la clave API utiliza `https://api.x.ai/v1` y puede inyectar Procesamiento Prioritario. En vivo primero Grok catálogo; `grok-4.5` es el valor predeterminado. |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude modelos; lista de modelos en vivo desde `/v1/models`. |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Modelos de programación de Kimi Code Plan. Usa por defecto el alias estable `kimi-for-coding` (actualmente K2.8 Preview): contexto de 1M tokens, entrada de texto e imágenes y razonamiento `low`/`high`/`max` (`max` por defecto). También incluye `k3.1-pro` y `k3.1-pro-highspeed` (K3.1 Pro), con contexto de 1M tokens y razonamiento obligatorio en los mismos niveles (`max` por defecto). Las selecciones retiradas `kimi-k2.x` migran al alias al actualizar. |
| `kimi-responses` | `openai-responses` | `https://api.kimi.com/coding/v1` | El mismo inicio de sesión de la cuenta Kimi (reutiliza la credencial `kimi` OAuth) sobre el cable OpenAI Responses. Misma lista de modelos y capacidades que `kimi`; pensando que el contenido permanece encriptado en el lado del servidor, las llamadas a herramientas y los resultados permanecen visibles. Agréguelo desde el selector **Add provider** del panel (**Kimi (Responses)**) o con `ocx provider add kimi-responses --live`. No tiene inicio de sesión propio: agregarlo con la sesión de Kimi ya iniciada no pide un segundo inicio de sesión, e iniciar sesión desde su entrada del selector crea solo esta fila, sin tocar la fila `kimi`. Cerrar la sesión desde cualquiera de las dos filas (`ocx logout kimi` o `ocx logout kimi-responses`, en local o con `--live`, o con **Logout** en cualquiera de las filas del panel) quita la cuenta de Kimi activa para ambas filas y lo indica; si hay otra cuenta de Kimi guardada, pasa a ser la activa para ambas filas; ninguna fila la usa mientras esté en pausa, y si necesita volver a iniciar sesión, vuelve a iniciar sesión con ella. Eliminar una fila desde el panel (o con `--live`) conserva el inicio de sesión mientras la otra lo siga usando, y eliminar la última lo elimina; un `ocx provider remove` local deja los inicios de sesión guardados, como con otros proveedores. |
| `nous` | `openai-chat` | `https://inference-api.nousresearch.com/v1` | Nous Research pasarela de suscripción (el mismo backend que usa Hermes Agent). El inicio de sesión de concesión de dispositivo contra `portal.nousresearch.com`; el token de acceso es la inferencia por solicitud JWT. Pago mixto + catálogo de modelos `:free` (`tencent/hy3:free`, `stepfun/step-3.7-flash:free`,...) descubierto en vivo desde la cuenta iniciada. Los tokens de actualización son de un solo uso y se rotan en cada actualización. |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | Los botones de inicio de sesión y añadir cuenta del dashboard ofrecen AWS IAM Identity Center, Builder ID, Google, inicio de sesión de dispositivo con GitHub o Kiro CLI. El inicio de sesión nativo añade una cuenta sin cerrar la sesión de `kiro-cli`. La opción Kiro CLI importa o inicia una sesión de esa CLI; al añadir una cuenta, cambia temporalmente su selección y la restaura si se cancela o falla. |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | Google OAuth sobre el cable de Cloud Code Assist. Live discovery utiliza el punto final autenticado `v1internal:fetchAvailableModels` de CCA y publica los modelos de agente disponibles para la cuenta iniciada; el catálogo mantenido sigue siendo la reserva. |
| `cursor` | `cursor` | `https://api2.cursor.sh` | Inicio de sesión PKCE experimental, transporte HTTP/2 en vivo con una ruta de compatibilidad opt-in HTTP/1.1 y descubrimiento de modelo filtrado por cuenta. |
| `zed` | `zed` | `https://cloud.zed.dev` | Experimental puente Zed AI alojado. Utiliza la devolución de llamada RSA de Zed, intercambia el token de cuenta por un token de inferencia alojada de corta duración y descubre la lista en vivo de la cuenta. |
| `orcarouter-oauth` | `openai-chat` | `https://api.orcarouter.ai/v1` | El consentimiento del navegador y el intercambio de claves usan `https://www.orcarouter.ai` con S256 PKCE. La clave `sk-orca-…` API de propiedad del usuario devuelta se almacena en el almacén de credenciales existente y se reutiliza hasta que se revoca. |
| `devin` | `devin` | `https://server.codeium.com` | Puente experimental no oficial de Cognition/Devin. El inicio de sesión importa primero la credencial que ya tiene el CLI de Devin instalado (`devin auth login` escribe un `devin-session-token` en su propio `credentials.toml`); cuando no hay ninguna, abre el inicio de sesión de Auth0 en el navegador e intercambia el token pegado mediante `RegisterUser` de Cognition por una clave API de larga duración. `ocx login devin-cli` sigue existiendo como alias obsoleto. Los modelos se descubren por cuenta con `GetCascadeModelConfigs`. La cuota de la cuenta proviene de `GetUserStatus` con un plazo único de ocho segundos para la solicitud y el cuerpo: ventanas diarias y semanales con fecha, más el fondo mensual de créditos Prompt y Flex para un plan facturado por crédito o una estrategia desconocida con ambas fechas de reinicio ausentes cuando hay un campo de saldo. Los créditos usados negativos omiten la ventana mensual; unos créditos disponibles válidos de cero la marcan como agotada. Una sonda que agota el tiempo conserva la última cuota buena. No aparece en el preajuste del panel por defecto. Los informes de chat y uso están verificados con una cuenta real en tres modelos. |
| `dsh-account` | `dsh-account` | `https://api.deepseek.com/anthropic` | Proveedor experimental de cuentas de importación primero que reutiliza una cuenta de escritorio DeepSeek Harness (DSH) instalada y registrada. Lee las credenciales estrictamente de solo lectura desde `~/.dsh/.credentials.yaml` después de la importación explícita. Independiente de la facturación de claves DeepSeek API. |
| `github-copilot` | `openai-chat` | `https://api.githubcopilot.com` | Experimental. GitHub flujo de dispositivos + intercambio `copilot_internal` (cliente VS Code OAuth). Requiere una suscripción activa de Copiloto; no un tercero oficial API. |

Google Antigravity agrupa las variantes completas `low` / `medium` / `high` de un modelo en una entrada con un selector de esfuerzo. Esto incluye Claude Opus y Sonnet 5.5 y futuras versiones descubiertas durante la actualización automática. Los conjuntos parciales permanecen separados. Las opciones existentes activadas/deshabilitadas se incluyen en la entrada agrupada; los modelos genuinamente nuevos aún siguen su política de Nuevo modelo. Los ID de sufijo guardados continúan solicitando su nivel original. El enrutamiento de esfuerzo agrupado sobrevive a un reinicio proxy cuando el descubrimiento del modelo no está disponible temporalmente. Una sesión Codex en ejecución puede necesitar volver a cargar su lista de modelos después de actualizar el catálogo. Grupos de uso conocidos como Claude Sonnet y Opus 5.5 bajo su modelo base, incluyendo registros históricos de nivel. Sus costos mostrados se derivan de Anthropic estimaciones de referencia, no Antigravity cargos de suscripción.

Google Antigravity Las sondas de cuotas de cuenta y proveedor utilizan Google puntos finales de contabilidad fijos, incluidos los modelos alternativos. Soportan DNS de IP falsa transparente para esos destinos al tiempo que retienen la verificación TLS, el rechazo de redireccionamiento y las verificaciones de direcciones privadas. Un URL base de proveedor personalizado cambia las solicitudes de modelo, no los destinos de cuota; `NO_PROXY` continúa seleccionando la política de ruta directa.

<a id="google-tool-schema-loss-diagnostics"></a>

### Google diagnósticos de pérdida de herramientas-esquema

Las declaraciones de herramientas Google se compilan con la clase de punto final seleccionada. Cuando el debug del proveedor está activado - `ocx debug provider on`, el conmutador Logs del panel de control, o `OCX_DEBUG=1` - pérdida de esquema durante la conversión de compatibilidad en la ruta de directiva omitida o `compatible` emite un registro `[ocx:google:google-tool-schema-loss]` (cola con `ocx debug provider logs -f` ) que lleva solo la versión del informe, clase de punto final, un indicador `lossy`, un recuento de incertidumbre limitado, categorías de pérdida fija con recuentos limitados y un indicador de truncamiento. Los nombres de herramientas y propiedades, rutas, valores y texto de esquema nunca se incluyen. Con una política omitida o `compatible`, este diagnóstico observa la conversión existente sin rechazarla. Bajo `reject-lossy`, una compilación inicialmente con pérdidas o indeterminada por comparación se rechaza antes del envío; no se emite un registro de pérdidas separado para la solicitud rechazada. Bajo `reject-lossy`, una reparación de Vertex o Cloud Code Assist que borraría las restricciones emite un registro `google-tool-schema-repair` sin contenido similar y devuelve el original 400 sin un envío modificado; con una política omitida o `compatible`, la solicitud reparada se reproduce como antes. Direct AI Studio nunca realiza esta reparación. Los esquemas de salida nativos están fuera de ambas rutas de política. Ver el [referencia de comando debug](/es/reference/cli/agents/).


Después de un fallo de actualización de terminal Nous, ejecute `ocx login nous` para volver a autenticar.

### Zed Hosted AI (experimental)

:::caution[No oficial: úsalo bajo tu responsabilidad]
Zed no proporciona ni respalda este puente. Reutiliza el modelo alojado de tu cuenta de Zed derecho fuera del editor de Zed, que puede estar fuera de los términos de servicio de Zed. Zed puede calificar Limitar, restringir o suspender la cuenta. Revise los términos actuales de Zed antes de iniciar sesión; el proveedor se queda fuera hasta que lo agregues y ejecutes `ocx login zed` y el dashboard pregunta Usted debe reconocer este riesgo antes de que comience el inicio de sesión.
:::

Ejecute `ocx login zed` y complete el inicio de sesión de la aplicación nativa de Zed en el navegador. OpenCodex inicia una devolución de llamada de bucle, le da a Zed una clave pública RSA y mantiene la clave privada local coincidente mientras la devolución de llamada devuelve la identidad de la cuenta y el token de acceso cifrado. El identificador de cuenta y el token almacenados se emparejan en cada solicitud; OpenCodex intercambia esa credencial por el token LLM de corta duración de Zed antes de llamar al `https://cloud.zed.dev/completions`.

La lista de modelos en vivo de Zed es de metadatos de visualización con alcance de cuenta. El id del modelo seleccionado se reenvía como se proporciona, y el puente infiere la familia de backend alojado desde la fila en vivo o el nombre del modelo; el descubrimiento del modelo no es una lista de permisos. El token de acceso de Zed no tiene punto final de actualización, por lo que cuando Zed lo revoque, ejecute `ocx login zed` nuevamente.

Para los modelos OpenAI alojados en Zed, OpenCodex traduce `developer` instrucciones a `system` mensajes y elimina OpenAI campos privados y herramientas integradas no compatibles como `web_search`. La función y las herramientas personalizadas permanecen disponibles a través del delegado; una opción de herramienta sin herramientas compatibles se convierte en `none`.

Las declaraciones de herramientas del turno actual incluidas en la entrada `additional_tools` de Codex se incorporan al catálogo de herramientas compatibles. Las llamadas a funciones y la entrada de herramientas personalizadas se retransmiten en orden, incluidas las llamadas intercaladas, para que un turno con herramientas pueda continuar después de su texto introductorio. Las llamadas incompletas conservan solo los argumentos recibidos y siguen incompletas; cancelar libera los datos almacenados en búfer. Una entrada completa de herramienta personalizada que entre en conflicto, incluidos los deltas posteriores, hace fallar el turno con llamadas incompletas. Los argumentos de función admiten diferencias de espacios en blanco JSON fuera de cadenas, escapes de cadena decodificados e instantáneas parciales compatibles, conservando los bytes entregados. Los literales numéricos deben coincidir exactamente (`1` y `1.0` entran en conflicto); también deben coincidir el orden de las claves de objeto y los miembros duplicados. Estos conflictos conservadores hacen fallar el turno. El anidamiento JSON se limita a 65.536 contenedores; una entrada más profunda falla con un mensaje claro sobre ese límite. Los fragmentos tardíos se validan de forma incremental. Si falla el proveedor de origen, el texto y el razonamiento recibidos permanecen visibles y el uso conserva únicamente los contadores numéricos. La retransmisión está cubierta por fixtures de streaming sintéticos; la compatibilidad con streaming alojado real sigue sin verificarse.

Para los presets canónicos de Kimi Coding Plan (inicio de sesión de cuenta `kimi` y clave API `kimi-code`), opencodex solo reenvía a Chat Completions un `prompt_cache_key` estable proporcionado por el cliente; nunca genera uno. El protocolo Responses acepta el mismo campo, pero actualmente opencodex no lo envía por esa ruta. Kimi exige una clave estable de sesión o tarea para mejorar los aciertos de caché de Code Plan; las solicitudes sin clave permanecen sin ella. Si un proveedor que habilitó esta opción rechaza el campo, opencodex no lo elimina para reintentar ni modifica la configuración guardada. Para los demás proveedores, la opción sigue desactivada por defecto.

Kimi La ruta nativa Responses de Code omite los mensajes del historial del asistente vacíos de contenido explícito para evitar su rechazo `assistant must not be empty`. Texto no vacío, espacios en blanco, rechazos, razonamiento y llamadas/resultados de herramientas son retenidos; el historial del cliente almacenado no es reescrito. Un mensaje vacío referenciado por un `item_reference` en la misma entrada se retiene en lugar de dejar una referencia colgante.

Los precios de uso de Kimi Coding para `k3`, `k3[1m]`, `k3-256k`, `k3.1-pro` y `k3.1-pro-highspeed` son **estimaciones de referencia de la API** para `kimi`, `kimi-code` y `kimi-responses`, con la tarifa publicada de escritura en caché de cinco minutos. El preset de API `moonshot` aplica precios a los mismos modelos como `kimi-k3`, `kimi-k3.1-pro` y `kimi-k3.1-pro-highspeed`. Las estimaciones no reproducen la facturación ni la cuota de Code Plan: la variante de 1M de K3 consume aproximadamente el doble de cuota que `k3-256k`, y K3.1 Pro Highspeed aproximadamente el doble que `k3.1-pro`. El alias `kimi-for-coding` apunta ahora a K2.8 Preview y ya no usa el precio de K2.7; su estimación no está disponible salvo que el operador configure `modelCosts`. Por eso, las políticas y los límites que excluyen precios desconocidos pueden excluir ese alias. Consulta la [configuración de modelos de Kimi](https://www.kimi.com/code/docs/en/kimi-code/models.html) y los [precios de API](https://platform.kimi.ai/docs/pricing/chat).

El preajuste `moonshot` (Kimi API) incluye `kimi-k3.1-pro` y `kimi-k3.1-pro-highspeed` junto a `kimi-k3` y los identificadores K2 aún admitidos. K3.1 tiene contexto de 1M de tokens, entrada de texto e imágenes y razonamiento obligatorio. El selector ofrece `low` / `high` / `max` (`max` de forma predeterminada); los esfuerzos Codex `medium` se envían como `high`, y `xhigh` como `max`. Un `none` explícito omite `reasoning_effort` para utilizar el valor predeterminado del proveedor. No se envían parámetros fijos de muestreo, como `temperature`, `top_p` o penalizaciones.

Al iniciar, una lista guardada de modelos `moonshot` que aún coincida con la lista integrada anterior recibe ambos identificadores si apunta al endpoint internacional o de China. Esta actualización no añade modelos a listas editadas ni a una URL personalizada; la migración de identificadores retirados se aplica por separado. El preajuste usa ahora `kimi-k3.1-pro`, recomendado por el proveedor. `kimi-k2.5`, retirado el 2026-08-31, desaparece de los modelos iniciales de la API. Las selecciones guardadas en los endpoints oficiales internacional o chino migran a `kimi-k3.1-pro`, actualizando los metadatos integrados antiguos de contexto y razonamiento y conservando las anulaciones explícitas. Los destinos personalizados mantienen sus selecciones. `kimi-k2.6` y `kimi-k2.7-code`, incluido highspeed, siguen disponibles para usuarios existentes. Moonshot cierra la serie K2 a cuentas nuevas el 2026-10-31 y prevé retirarla a finales de diciembre de 2026; consulta la [lista de modelos de Kimi API](https://platform.kimi.ai/docs/models.md), comprobada el 2026-10-28.

Un proveedor personalizado de `openai-chat` puede habilitar esta opción cuando su proveedor documente compatibilidad con `prompt_cache_key`:

```json
{
  "providers": {
    "example-compatible-provider": {
      "adapter": "openai-chat",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "${EXAMPLE_API_KEY}",
      "promptCacheKey": true
    }
  }
}
```

El adaptador reenvía la clave que recibe y nunca inventa una. Aun así puede recibir una clave que el llamante no envió: la traducción de Claude Messages deriva una de `metadata.user_id`, o de una cohorte de modelo/sistema/herramientas cuando el cliente no envía metadatos, porque los backends de OpenAI informan `cached_tokens: 0` en todos los turnos sin clave. Así, "reenviado, no fabricado" describe a este adaptador, no a toda la ruta de la solicitud.

Preservar el resto de la configuración del proveedor al agregar la opción, a continuación, volver a cargar o reiniciar opencodex. Para validar el almacenamiento en caché, compare la solicitud inicial en frío con solicitudes posteriores que lleven la misma clave estable. Deje la opción omitida o configúrela a `false` para secuencias ascendentes incompatibles, y deshabilite o elimine si una puerta de enlace estricta devuelve un error de campo desconocido de HTTP 400.

También puede comenzar OAuth desde el [panel web](/es/guides/web-dashboard/).

<a id="logging-in-from-another-browser-profile-or-another-machine"></a>

### Iniciar sesión desde otro perfil de navegador u otra máquina

Cuando se inicia un inicio de sesión, el proxy abre la URL de autorización en la máquina **Su propio**, utilizando el navegador predeterminado del sistema operativo y, por lo tanto, el perfil predeterminado. Ese es el comportamiento correcto para un escritorio local y el incorrecto en dos casos comunes: necesita un perfil de navegador diferente (una identidad de trabajo, una segunda cuenta) o el panel de control está abierto contra un proxy que se ejecuta en otro lugar.

Cada superficie de inicio de sesión muestra la URL de autorización con un botón de copia, el código del dispositivo cuando el proveedor emite uno y las instrucciones actuales. Los flujos de devolución de llamada del navegador también muestran un campo para pegar la URL de redirección o el código de autorización. Durante la aprobación del dispositivo, ese campo está oculto: introduzca el código mostrado en la página de verificación del proveedor. Si el proveedor cambia a la entrada manual, el panel de control reemplaza el código antiguo y las instrucciones en su próxima encuesta de estado.

Si el proxy intenta abrir un navegador y no puede, el inicio de sesión lo dice por encima de la URL y continúa: abra la página de inicio de sesión desde el enlace o cópiela. Un inicio de sesión del dispositivo nunca abre un navegador por sí mismo; **Copiar código & abrir** copia el código y abre la página de verificación con un solo clic, y el panel de control sigue esperando mientras el código del proveedor siga siendo válido. En la aplicación de escritorio, estos enlaces se abren en su navegador predeterminado.

Para evitar que el proxy abra un navegador, marque **No abra un navegador en la máquina proxy** junto al botón de inicio de sesión o configúrelo permanentemente:

```json
{ "oauthOpenBrowser": false }
```

Ausente y `true` abiertos, por lo que nada cambia para una instalación existente; solo una disminución explícita de `false`. `POST /api/oauth/login` y `POST /api/codex-auth/login` también aceptan un booleano por solicitud `openBrowser` que anula la configuración almacenada para ese inicio de sesión.

Dos casos se comportan de manera diferente, y vale la pena saber en cuál se encuentra:

- **Un perfil de navegador diferente en la misma máquina** funciona solo con el enlace copiado. El bucle de retorno de llamada en `127.0.0.1` todavía completa el flujo.
- **Un flujo de devolución de llamada del navegador en una máquina diferente** también necesita el retroceso de pegado, porque el URI de redirección sigue siendo `http://127.0.0.1:<port>/callback` en el host del proxy. Termina el inicio de sesión allí, luego pega la URL de redirección (o solo el código) nuevamente en el tablero o `ocx account code`.

Los proveedores de código de dispositivo nunca abren un navegador desde el proxy en ningún caso: muestran un código y una URL de verificación para abrir donde sea que haya iniciado sesión.

<a id="headless-claude-login-code-display-mode"></a>

### Inicio de sesión Claude sin cabeza (modo de visualización de código)

Para Anthropic hay un camino más limpio que pegar una redirección muerta: el inicio de sesión **code-display**. Anthropic redirige a su propia página y muestra una cadena `code#state` en lugar de llamar al proxy, por lo que nada necesita llegar a `127.0.0.1` en el host del proxy.

```bash
ocx login anthropic --headless
```

A lo largo de la gestión API, comience con `POST /api/oauth/login` y `{"provider":"anthropic","mode":"code"}`; la respuesta lleva un `flowId` y un `expiresAt` (10 minutos). Envíe la cadena pegada al `POST /api/oauth/login/code` con ese `flowId`. La respuesta es el resultado del intercambio de tokens, `{"ok":true,"account":…}` o `{"ok":false,"error":…}`, por lo que una persona que llama alojada con un solo cuadro de pegado sabe si el inicio de sesión realmente funcionó. Una pasta con el estado incorrecto, o sin código, se rechaza antes de cualquier solicitud de token y deja el flujo abierto para otro intento; una pasta que llega al intercambio de tokens usa el flujo hacia arriba, así que inicie un nuevo inicio de sesión si ese intercambio falla.

Solo `anthropic` y `anthropic2` admiten este modo; otros proveedores responden `code_mode_unsupported`. Varios inicios de sesión de código pueden estar en vuelo a la vez, cada uno anclado a su `flowId`, pero todos escriben la misma tienda de cuentas: la más reciente se convierte en la cuenta activa Claude. Esto está destinado a un operador en un host sin cabeza, no para aislar usuarios no relacionados en una instancia compartida.

<a id="multiple-oauth-accounts"></a>

### Múltiples cuentas OAuth

OAuth proveedores cuyas credenciales incluyen un ID de cuenta estable o correo electrónico pueden mantener más de un inicio de sesión. La página Proveedores muestra esas cuentas en un menú desplegable, le permite agregar otra y cambia la cuenta activa sin cerrar la sesión de las otras. Un inicio de sesión normal con una credencial sin identidad Kimi reemplaza la ranura activa, mientras que un **Añadir cuenta** explícito conserva esa ranura y activa una nueva y distinta. Las cuentas de Kiro se identifican mediante el ARN del perfil y, cuando está disponible, el correo electrónico del usuario conectado. Distintos usuarios de un perfil de organización pueden conservar credenciales separadas. `chatgpt` siempre es de una sola ranura porque las cuentas de grupo Codex tienen un libro mayor separado. Los tokens permanecen en `~/.opencodex/auth.json`; `/api/oauth/accounts` devuelve solo metadatos enmascarados.

<a id="cockpit-tools-antigravity-import"></a>

### Importación de Antigravity desde Cockpit Tools

En v1, OpenCodex solo importa archivos JSON de **Antigravity exportados desde Cockpit Tools**, para el proveedor `google-antigravity`. En el dashboard, selecciona el archivo local desde la pestaña Cuentas de ese proveedor. El dashboard no muestra el contenido del archivo ni las credenciales; solo informa cuántas cuentas se importaron, se actualizaron, fallaron o no son compatibles. En v1 se rechazan las exportaciones de otros proveedores de Cockpit Tools.

El CLI solo acepta la exportación desde un archivo o entrada estándar, nunca lo pegue en un argumento de comando:

```bash
ocx account import google-antigravity --format cockpit-tools --file <path> [--json]
cat accounts.json | ocx account import google-antigravity --format cockpit-tools --stdin [--json]
```

En línea JSON y argumentos posicionales adicionales son rechazados. Mantenga los archivos exportados privados y elimínelos o guárdelos de forma segura después de importarlos.

Cada registro puede incluir `project_id` para una cuenta cuyo proyecto de Cloud Code Assist no se descubra automáticamente. Debe ser un identificador de proyecto de Google Cloud de 6 a 30 letras minúsculas, dígitos o guiones. OpenCodex solo lo usa si el descubrimiento no encuentra un proyecto y una consulta de cuota con el token de esa misma cuenta lo valida; de lo contrario, el registro falla con `missing_project` y no se guarda nada. El proyecto descubierto siempre tiene prioridad.

<a id="oauth-reliability"></a>

### OAuth fiabilidad

opencodex coordina la actualización de tokens y el enrutamiento de grupo Codex para que las solicitudes concurrentes no aceleren el almacén de credenciales. Esto es trabajo de confiabilidad y diagnóstico: **no** garantiza protección contra la aplicación del proveedor, los límites de solicitudes o las acciones de la cuenta.

**Refrescar la coordinación.** Antes de una llamada enrutada, un token de acceso vencido se actualiza una vez cada `(provider, account)`:

1. En proceso de un solo vuelo - llamantes concurrentes comparten una promesa de actualización.
2. Bloqueo de archivos por cuenta: los escritores de procesos cruzados se serializan en la misma cuenta.
3. Generación CAS: persiste solo cuando la generación de credenciales almacenada aún coincide; un escritor más nuevo gana y un resultado de actualización más antiguo no puede sobrescribirlo.

Los fallos de actualización de terminal marcan la cuenta como que necesita una nueva autenticación en lugar de volver a intentarlo para siempre.

Para la credencial principal nativa Codex en `CODEX_HOME/auth.json`, cancelar una solicitud detiene una actualización en espera antes de que comience el intercambio de tokens. Un intercambio que ya comenzó termina dentro de su propio tiempo de espera de 30 segundos y guarda el acceso exitoso y actualiza los tokens antes de informar la cancelación de la solicitud. Esto conserva el token de actualización rotado para solicitudes posteriores; un reemplazo de credenciales externo concurrente aún tiene prioridad.

**Enfriamientos (Codex pool).** Una respuesta ascendente `429` o de cuota establece un enfriamiento duro a partir de `Retry-After`, de las cabeceras `reset` de cuota (con límite) o de un breve retroceso predeterminado. Las cuentas en un enfriamiento explícito por `Retry-After` no se sondean antes de tiempo; los enfriamientos derivados de un restablecimiento pueden recibir un arrendamiento de sonda con cadencia para detectar la recuperación sin inundar al proveedor. Los enfriamientos de modelos nativos derivados de un restablecimiento mantienen la cuota nativa compartida (incluidos GPT-5.6 Terra/Luna) separada de `gpt-reserve`. Los modelos del grupo compartido siguen protegiéndose unos a otros; un éxito ordinario no puede borrar un enfriamiento de la Reserva. Un `Retry-After` explícito y los enfriamientos predeterminados siempre abarcan toda la cuenta.

**Afinidad de sesión.** La afinidad entre hilo de Codex y cuenta es local al proceso (solo en memoria; no persiste entre reinicios del proxy). Ante fallos de credenciales (`401` / `403`), la cuenta se pone en cuarentena para volver a autenticarse y se borran las afinidades de esa cuenta. En `429`, la cuenta entra en enfriamiento, las afinidades se borran y la selección del grupo puede rotar: los hilos no quedan fijados a través de una respuesta de límite de velocidad.

**Volver a una cuenta recuperada.** Para reanudar el uso de la cuenta de máxima prioridad durante una tarea en curso, active `ocx config set codexAccountPriorityFailback true` y mantenga la estrategia Pool en `quota` con la conmutación automática habilitada. Por ejemplo, una tarea puede pasar de Plus a otra cuenta cuando se llena su ventana de cinco horas y luego volver a Plus después de que la actualización de la cuota confirme la recuperación. Mientras fluyen las solicitudes, los intentos de actualización en segundo plano se ejecutan como máximo una vez cada cinco minutos. La solicitud que desencadena una actualización puede seguir utilizando la cuenta anterior; la siguiente solicitud después de que se complete la actualización puede retroceder. Las solicitudes que ya se están ejecutando terminan en su cuenta capturada. Los pines de cuenta manuales y las restricciones de acceso al modelo aún se aplican. Esta función está desactivada por defecto; use `ocx config set codexAccountPriorityFailback false` para restaurar enlaces estables.

El umbral efectivo de la cuenta de origen vinculada controla esta preferencia: la anulación `0` la deshabilita, y una anulación positiva funciona incluso cuando el umbral global es `0`. Un candidato debe tener un uso conocido y no agotado por debajo de su propio umbral efectivo positivo. El candidato `0` elimina solo esa preferencia de umbral; aún se aplican la elegibilidad, el tiempo de reutilización y los bloqueos duros. Cada ventana que contribuye a su puntuación necesita una observación reciente en vivo en este proceso. Las actualizaciones solo de créditos, las ventanas retenidas y las barras de visualización hidratadas no prueban por sí mismas la recuperación.

**Metadatos del cliente Codex.** La ruta de reenvío de ChatGPT transmite los encabezados permitidos por `FORWARD_HEADERS`: autorización, `chatgpt-account-id`, originador, identificadores de sesión e hilo y los demás encabezados de Codex admitidos; consulta [Adaptadores](/es/reference/adapters/). El modo Pool solo sustituye la autenticación y `chatgpt-account-id` por los de la credencial elegida. OpenCodex **no inventa** la identidad oficial del cliente, como `originator` o los encabezados de sesión e hilo, si el cliente no los envió.

Para el diagnóstico de compatibilidad de cuenta-interruptor, habilitar la depuración del proveedor (`ocx debug provider on`) agrega una línea `[ocx:codex:affinity]` por respuesta directa canónica ChatGPT. La línea contiene presencia de encabezado, cubos de tamaño aproximado, etiquetas de igualdad HMAC locales de proceso, resúmenes seguros de campos de giro de nivel superior conocidos y un recuento de campos de giro desconocidos. Nunca incluye credenciales sin procesar, identificadores de cuenta, valores de certificación, identificadores de subproceso/sesión, metadatos de turno o cuerpos de solicitud; las etiquetas cambian intencionalmente después de cada reinicio del proxy. Use `ocx debug provider logs -f` mientras reproduce las dos solicitudes, luego ejecute `ocx debug provider off`. Esta captura es solo de observación y no elimina metadatos, reintenta una solicitud, cambia de cuentas, restablece un subproceso o afecta el enrutamiento.

**Diagnóstico y reauth.** Human `ocx status` imprime un bloque de salud OAuth (identificadores de cuenta redactados, sin tokens). `ocx doctor` agrega una sección de confiabilidad OAuth con comprobaciones de almacenamiento grabable / de un solo vuelo y filas WARN que incluyen una acción de recuperación. Cuando una cuenta de proveedor OAuth necesita reautenticación, ejecute `ocx login <provider>` (o utilice Reautenticar en el panel de control). Codex cuentas de grupo no son uno de esos proveedores, pero `ocx login codex --reauth` rutas a su cuenta de grupo de reautenticación, que el tablero Codex cuenta de grupo también realiza. Véase [`ocx status` / `ocx doctor`](/es/reference/cli/) en la referencia CLI.

<a id="kiro-request-credits"></a>

### Créditos por solicitud de Kiro

La guía [Créditos por solicitud de Kiro](/es/guides/kiro-request-credits/) describe la validación de respuestas, los rechazos del filtro de seguridad, el registro de créditos y su valoración en USD.

<a id="kiro-refresh-attention"></a>

### Kiro actualizar la atención

Si una actualización de AWS SSO devuelve `400 invalid_request` y la recuperación Kiro CLI no se realiza correctamente, el panel de control muestra que la cuenta afectada necesita volver a autenticarse una vez que expire su token de acceso. El proveedor activo informa entonces de `loggedIn: false` desde `/api/oauth/status`. Un token de acceso todavía válido permanece conectado. Puede iniciar sesión de nuevo a través del panel de control; una actualización automática exitosa posterior también borra el estado de atención. Este estado no clasifica la concesión de actualización como revocada ni desactiva futuros intentos de actualización. Los errores de red y servidor no activan este estado.

Para las cuentas de escritorio, un HTTP 401 con exactamente `Bad credentials` requiere un nuevo inicio de sesión e inmediatamente marca la generación de credenciales rechazadas como que necesita una nueva autenticación. Otros mensajes, estados y respuestas de AWS SSO no activan esta regla específica del escritorio.

<a id="kiro-credential-import"></a>

### Importación de credenciales Kiro

El dashboard ofrece inicio de sesión nativo con AWS IAM Identity Center, Builder ID, Google y GitHub sin Kiro CLI.

Para una cuenta de organización, elige **AWS IAM Identity Center** e introduce la URL del portal de acceso de AWS (por ejemplo, `https://example.awsapps.com/start`) y la región donde tu organización lo configuró. Abre el enlace de verificación en tu propio navegador, introduce el código mostrado y autoriza la cuenta. El hub completa la autorización sin una sesión SSH ni una devolución del navegador hacia él. Si AWS enumera varios perfiles de Kiro, elige cuál guardar; si hay uno solo, se guarda automáticamente. La región SSO y la región de API del perfil se conservan por separado. El descubrimiento comprueba las regiones de servicio de AWS US East y Frankfurt. Antes de guardar, obtiene de AWS el correo del usuario para ese perfil; así, usuarios que comparten un perfil de organización mantienen credenciales distintas. Cancelar o agotar el plazo antes de escribir las credenciales no guarda ninguna cuenta. El inicio de sesión nativo añade una cuenta y conserva la selección existente. La opción Kiro CLI y la ruta de importación `ocx login kiro` usan el CLI: en Unix, instálelo con `curl -fsSL https://cli.kiro.dev/install | bash`; en Windows PowerShell, use `irm 'https://cli.kiro.dev/install.ps1' | iex`; luego inicie sesión con `kiro-cli login`. Sin una sesión `kiro-cli`, `ocx login kiro` vuelve a un token de acceso pegado o la variable de entorno `KIRO_ACCESS_TOKEN`.

La ruta de importación `ocx login kiro` busca en la plataforma Kiro CLI almacena y abre SQLite bases de datos de solo lectura. Dos variables de entorno hacen explícita la selección de la fila de origen y token:

- `KIROCLI_DB_PATH` selecciona una base de datos no estándar Kiro CLI SQLite. La ruta de acceso ya debe existir; durante esta ruta de acceso de importación, opencodex no crea ni modifica los archivos de base de datos, WAL o SHM.
- `KIROCLI_TOKEN_KEY` selecciona la clave de token exacta `auth_kv` cuando una base de datos contiene múltiples filas de tokens ambiguas. Una selección faltante falla el inicio de sesión en lugar de adivinar.

En Windows, la importación busca `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3`. El inicio de sesión forzado/agregar cuenta también necesita el binario local CLI: opencodex primero usa `PATH`, luego vuelve a `%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe` y `C:\Program Files\Kiro-Cli\kiro-cli.exe`. Si ninguna de las carpetas tiene `kiro-cli.exe`, se utiliza un `kiro.exe` dentro de esas mismas dos carpetas `Kiro-Cli`. opencodex nunca ejecuta un `kiro` corto o `kiro.exe` que se encuentra en `PATH` o en directorios compartidos macOS / Linux bin, por lo que instalar o vincular el CLI como `kiro-cli` allí.

Después de una importación exitosa, opencodex persiste la credencial importada a `~/.opencodex/auth.json`. Mantenga estas variables y la base de datos seleccionada privada. No adjunte archivos de base de datos o diagnósticos de inicio de sesión sin procesar a los informes de errores.

Para la opción **Kiro CLI**, **Añadir cuenta** es un flujo de trabajo de escritura separado: captura la sesión actual, inicia sesión en `kiro-cli` e importa el inicio de sesión del navegador nuevo. Si el inicio de sesión se cancela o falla, incluso mientras OpenCodex persiste la credencial, el retroceso reemplaza la base de datos Kiro CLI y elimina sus sidecars WAL, SHM y diario actuales antes de publicar la instantánea de sesión anterior.

Debido a que la reversión solo es posible a partir de una instantánea, la opción Kiro CLI **Añadir cuenta** se niega a firmar `kiro-cli` cuando un almacén de sesión está presente pero no se puede capturar (archivo ilegible, esquema no coincidente o una selección ambigua de token), cuando la importación de redireccionamiento `KIROCLI_DB_PATH` / `KIRO_CLI_DB_FILE` se lee desde el almacén CLI en vivo, o cuando una base de datos CLI primaria existente no tiene una fila de token reconocida. Repare o elimine la base de datos ilegible bajo la ruta de datos normal `kiro-cli`, desactive los selectores de importación y vuelva a intentarlo. No se afecta el inicio de sesión desde una máquina sin sesión `kiro-cli` existente. Las opciones del panel de control nativo son solo para agregar y no cerrar sesión en `kiro-cli`. Un diálogo de dispositivo muestra el código y el destino de la verificación. Solo los hosts reconocidos de Kiro o de SSO de dispositivo regional de AWS se abren como enlaces, así como el portal de acceso `<id>.awsapps.com/start` de tu organización en un inicio de sesión con AWS IAM Identity Center; un destino inesperado se muestra como texto copiable para su revisión. Cerrar el cuadro de diálogo envía la cancelación y deja una verificación de estado de fondo limitada para conciliar una confirmación que ya está en curso. Se vuelve a intentar una respuesta de estado estancada; agotar la fecha límite de flujo produce el resultado final neutral en lugar de reclamar el éxito. La aprobación Google y GitHub se completa cuando Kiro informa `authorized` (o el estado `approved` heredado) con tokens válidos y un ARN de perfil. La lista de cuentas marca Kiro cuentas excluidas de la selección automática con un motivo, cuando está disponible.

<a id="deepseek-api"></a>

### DeepSeek API

El proveedor de clave API `deepseek` incluye `deepseek-flash`, su alias `deepseek-v4-flash`
y `deepseek-v4-pro`. DeepSeek [retiró el plan de eliminación de Pro](https://api-docs.deepseek.com/updates/)
y sigue ofreciéndolo. OpenCodex conserva Pro con contexto de 1.048.576 tokens, entrada solo de texto
y esfuerzos `low`/`high`/`max`. Las solicitudes Responses usan su endpoint nativo; las de Chat
Completions conservan ese protocolo. Flash sigue siendo el modelo predeterminado. La disponibilidad
en proveedores de terceros es independiente.

Al actualizar, el inicio añade Pro a una lista guardada solo si coincide exactamente con la lista
integrada anterior de DeepSeek y mantiene el endpoint y adaptador oficiales. Las listas modificadas,
incluidas las vacías, no cambian. Esta reparación no requiere detección de modelos en vivo.

<a id="deepseek-account-dsh"></a>

### DeepSeek Cuenta (DSH)

`dsh-account` es un proveedor experimental de cuentas de importación diseñado para reutilizar las credenciales de cuenta autenticadas de una aplicación de escritorio DeepSeek Harness (DSH) instalada.

- **Independiente de DeepSeek API Llave:** `dsh-account` se ejecuta en la cuenta DeepSeek iniciada con DeepSeek Harness, mientras que el proveedor `deepseek` factura contra su saldo de claves API de plataforma. Los dos dominios y rutas de credenciales están estrictamente separados y nunca se cruzan.
- **Importación explícita solamente:** opencodex lee `~/.dsh/.credentials.yaml` (o `$DSH_HOME/.credentials.yaml`) solo cuando ejecuta `ocx login dsh-account` o selecciona **Iniciar sesión** en la fila DeepSeek Account (DSH) del selector **Añadir proveedor** del tablero de instrumentos. Nunca copia, importa o usa el token por sí mismo.
- **Tienda de credenciales DSH de solo lectura:** OpenCodeX trata a `~/.dsh/.credentials.yaml` como estrictamente de solo lectura. OpenCodeX nunca escribe, modifica, elimina o altera los permisos de los archivos pertenecientes a DeepSeek Harness.
- **Copia de credenciales aislada & cierre de sesión:** Al importar, OpenCodeX valida el token contra el punto final de identidad autorizado de DeepSeek (`/auth-api/v0/users/current`) y guarda su propia copia en el almacén de autenticación de OpenCodeX. Cerrar la sesión o eliminar la cuenta en OpenCodeX solo elimina la copia local de OpenCodeX; nunca activa el cierre de sesión remota ascendente y no cerrará la sesión en DeepSeek Harness Desktop.
- **Sin rotación de token de fondo y reimportación 401:** Las concesiones de sesión DSH no cuentan con un punto final de actualización de fondo automático. Si el flujo ascendente devuelve HTTP 401 (`ACCOUNT_TOKEN_INVALID`), OpenCodeX marca la cuenta `needsReauth` y detiene el enrutamiento. Para restaurar el acceso, el usuario debe volver a importar explícitamente a través de `ocx login dsh-account`.
- **Descargo de responsabilidad de terceros:** OpenCodeX no hace ninguna reclamación de respaldo oficial o autorización por DeepSeek para clientes de terceros que reutilizan subvenciones de sesión.

<a id="3-api-key-catalog"></a>

## 3. Catálogo de proveedores con clave API

Los preajustes integrados con clave API, sus URL base y las notas específicas de cada proveedor
están en la página [Catálogo de proveedores con clave API](/es/guides/api-key-catalog/). Sus secciones:

- [Suscripción WorkBuddy AI](/es/guides/api-key-catalog/#workbuddy-ai-subscription)
- [CodeBuddy Code CLI oficial (Global y CN)](/es/guides/api-key-catalog/#official-codebuddy-code-cli-global--cn)
- [Oficial Qoder CLI (Global y CN)](/es/guides/api-key-catalog/#official-qoder-cli-global--cn)
- [Claude Code CLI (suscripción)](/es/guides/api-key-catalog/#claude-code-cli-subscription)
- [Antigravity CLI (ACP, local)](/es/guides/api-key-catalog/#antigravity-cli-acp-local)
- [Cuota de crédito A6API](/es/guides/api-key-catalog/#a6api-credit-quota)
- [Plan de codificación BigModel sobre Responses](/es/guides/api-key-catalog/#bigmodel-coding-plan-over-responses)
- [Múltiples claves API](/es/guides/api-key-catalog/#multiple-api-keys)
- [Cambio de cuentas desde la terminal](/es/guides/api-key-catalog/#switching-accounts-from-the-terminal)
  - [Nivel de suscripción en los listados de cuentas](/es/guides/api-key-catalog/#subscription-tier-in-account-listings)
- [GPT-5.6 rutas de vista previa](/es/guides/api-key-catalog/#gpt-56-preview-paths)
- [Ollama Cloud](/es/guides/api-key-catalog/#ollama-cloud)

<a id="4-local-providers"></a>

## 4. Proveedores locales

Apunte opencodex a un servidor local compatible con OpenAI, normalmente con una clave en blanco:

| Proveedor | URL base |
| --- | --- |
| Ollama (local) | `http://localhost:11434/v1` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |

<a id="any-openai-compatible-endpoint"></a>

## Cualquier punto final compatible con OpenAI

Si un proveedor habla Chat Completions, el adaptador `openai-chat` lo maneja: elija **Personalizado** en el tablero de instrumentos o `custom` en `ocx init` e ingrese la URL base. Ver el [Referencia de configuración](/es/reference/configuration/) para cada campo de proveedor (`headers`, `noReasoningModels`, `noVisionModels`, `models`,...).

<a id="approval-reviewer-per-provider"></a>

## Revisor de aprobación por proveedor

Codex pide a un segundo modelo que revise las solicitudes de aprobación, y toma ese revisor de `auto_review_model_override` en la fila de catálogo del modelo del turno actual. La raíz `auto_review_model` en `$CODEX_HOME/config.toml` es el respaldo de Codex. La opción global **Anulación de revisión automática** del panel, en la configuración de modelos, aplica un revisor a todas las filas de catálogo que no tengan un revisor con alcance de proveedor. Guarda `autoReviewOverride` en `~/.opencodex/config.json`; el ajuste debe estar habilitado y nombrar un modelo. Un ajuste habilitado sin modelo no se aplica y deja en vigor el respaldo de Codex. La actualización del catálogo es un estado aparte: tras guardar puede quedar pendiente, y la página Modelos lo informa para que pueda reintentarla con `ocx sync`. Desde la CLI, lea el ajuste con `ocx models auto-review status` o cámbielo con `ocx models auto-review set <model|-> [--enabled <on|off>]`; use `-` para borrar el modelo. La salida de la CLI recomienda `ocx sync` cuando se puede reintentar una actualización. Si una actualización falla, el ajuste sigue guardado y el comando sale con 1. Resuelva el fallo antes de sincronizar. Para dar a un proveedor enrutado su propio revisor, normalmente más barato, configure el selector en esa fila de proveedor en `~/.opencodex/config.json`:

```json
{
  "providers": {
    "blsc": {
      "autoReviewModel": "opencode-go/deepseek-v4-flash",
      "autoReviewModelOverrides": { "kimi-k3": "gpt-5.6-terra" }
    }
  }
}
```

`autoReviewModel` cubre todas las filas enrutadas del proveedor. `autoReviewModelOverrides` apunta a un único id de modelo ascendente y gana sobre él. Un valor es un id de modelo desnudo de ese mismo proveedor o un slug de catálogo público como `opencode-go/deepseek-v4-flash`, y un sello de proveedor gana sobre el selector de raíz en sus propias filas mientras que el selector de raíz mantiene la reserva en otro lugar.

Un valor desnudo se resuelve contra las propias filas del proveedor primero y luego contra una fila de catálogo desnuda, que es cómo se nombra un modelo nativo como `gpt-5.6-terra`; un valor que no coincide con ninguno se deja sin resolver, y un valor desnudo que aterriza fuera del proveedor imprime una nota que nombra la fila que suministra el revisor. Dar la identificador completa evita la pregunta por completo cuando el revisor es el modelo enrutado de otro proveedor.

Los selectores se resuelven contra el catálogo final en la siguiente sincronización, cada uno por su cuenta, y cada uno falla cerrado por sí mismo: un `autoReviewModel` no resuelto imprime un diagnóstico y no estampa filas de todo el proveedor, una entrada `autoReviewModelOverrides` no resuelta imprime un diagnóstico y no estampa una anulación por modelo, dejando un objetivo válido de todo el proveedor como reserva. Lo que sea que resuelva se sigue aplicando. Las filas sin un sello de proveedor mantienen el selector raíz o el comportamiento ascendente cuando no se establece. La eliminación del selector raíz deja solos los sellos del proveedor y la eliminación de un selector de proveedor solo borra los sellos de ese proveedor.

Los campos de proveedor están disponibles a través de la configuración, `PATCH /api/providers?name=<provider>`, y el editor de proveedor raw JSON del panel de control; los controles de formulario de proveedor dedicado no están presentes. La anulación global está disponible en la configuración del modelo. El proveedor canónico `openai` rechaza los campos de revisor del proveedor. Las reglas de campo por campo viven en el [referencia de configuración del proveedor](/es/reference/configuration/providers/#auto-review-approval-model-selection).

<a id="rate-limits-in-the-providers-overview"></a>

## Límites de solicitudes en la descripción general de los proveedores

La sección **Límites de solicitudes** de la descripción general de proveedores muestra las barras de utilización en vivo actualizadas desde el punto final de uso/facturación de cada proveedor cuando existe uno. Las barras muestran la cantidad de una ventana (5 horas, semanal, mensual o específica del proveedor) que ya se consume.

Proveedores con una consulta activa: OpenAI/Codex, Anthropic, xAI, Cursor, Kimi, Google Antigravity, OpenCode Go, OpenRouter, DeepSeek, ClinePass, Z.AI, MiniMax, Moonshot, Venice, Synthetic, DeepInfra, Neuralwatt, Command Code y proveedores personalizados basados en a6api o Abliteration.

**Uso mensual de Anthropic.** Las cuentas con facturación por uso, como las de Enterprise,
pueden mostrar una barra mensual cuando Anthropic indica que el uso adicional está activado
y no informa de ventanas del plan. La barra se muestra sin fecha de restablecimiento y desaparece
cuando Anthropic informa de ventanas del plan o confirma que el uso adicional está desactivado.
Si la respuesta no contiene ninguna ventana de cuota utilizable, la consulta de la cuenta sigue
indicando que la lectura no está disponible, incluso si al actualizar la cuota del proveedor se
recibe la misma respuesta.

**Cuota de Kimi Coding Plan.** Los proveedores con inicio de sesión de cuenta o clave API que usan el endpoint canónico `https://api.kimi.com/coding/v1` consultan `/usages`. Los planes que informan `usages.limit_month_total` (o `monthTotal`) muestran una barra de uso mensual; si el total no está disponible, se utiliza `limit_month_code` (o `monthCode`). La fracción `used_ratio` / `usedRatio` debe estar en `[0, 1]` antes de convertirse en porcentaje consumido; los valores inválidos se ignoran. Un contenedor `usages` vacío o inutilizable no oculta datos mensuales válidos de otro sobre compatible. Se conserva cualquier hora de restablecimiento informada. Las ventanas existentes de cinco horas, semanales y de créditos totales de suscripción siguen siendo independientes; una ventana mensual ausente no se muestra como 0%.

**Créditos de Abliteration.** Un proveedor de cualquier nombre cuyo `baseUrl` sea `https://api.abliteration.ai` o `https://api.abliteration.ai/v1` consulta `GET https://api.abliteration.ai/v1/credits` con la clave activa como token bearer, sin seguir redirecciones. El saldo restante en USD es `total_credits` menos `total_usage`; la barra muestra el gasto consumido. Una cuenta sin créditos no muestra barra. Una clave rechazada elimina la fila; `503 credit_balance_unavailable`, 408 y 429 conservan la última lectura.

**Cuota de OpenCode Go.** El preajuste canónico `opencode-go` lee `GET https://opencode.ai/zen/go/v1/usage` con la clave configurada como token de portador y no sigue redirecciones. Los valores `percent` móvil, semanal y mensual de la respuesta ya representan utilización consumida: el móvil se asigna a la barra de 5 horas, mientras que el semanal y el mensual conservan sus barras correspondientes. OpenCodex no reconstruye los límites de dólares de los registros de uso local, y a un proveedor que usa un `baseUrl` no canónico nunca se le envía la clave para esta sonda.

**Cuota del plan de codificación Z.AI GLM.** Los preajustes `zai`, `glm`, `glm-cn` y `zhipu-bigmodel-coding` leen `GET /api/monitor/usage/quota/limit` y no siguen redireccionamientos. La sonda corre contra la región que el proveedor señala en: `api.z.ai` (desnudo o `/api/coding/paas/v4`) o `open.bigmodel.cn` (desnudo, `/api/coding/paas/v4` o el punto final OpenAI Responses `/api/v1`).

La autenticación difiere según la región: `api.z.ai` toma la clave como token Bearer, mientras
`open.bigmodel.cn` espera la clave directamente en `Authorization`, sin prefijo de esquema, y rechaza un encabezado Bearer. Las filas `limits` de la respuesta rellenan las barras de utilización:
las filas `TOKENS_LIMIT` / `CREDIT_LIMIT` con `unit` 3 / `number` 5 rellenan la barra de 5 horas y
las de `unit` 6 / `number` 1 la barra semanal.

Las filas `TIME_LIMIT` **no** son cuota de modelo y se ignoran. Son la asignación mensual compartida de llamadas MCP para Web Search, Web Reader y Zread, así que tratarlas como una ventana de modelo haría que un presupuesto de búsqueda web ya gastado se leyera como capacidad de modelo agotada en la clasificación de cuentas consciente de cuotas. Por eso, un plan que solo informa filas `TIME_LIMIT` no muestra barras de cuota en lugar de una inventada, y las ventanas que el plan no informa permanecen ausentes en vez de mostrarse como 0%.

Nunca se envía la clave para esta sonda a un proveedor que utilice un `baseUrl` no canónico.

<a id="diagnosing-an-antigravity-quota-refresh"></a>

### Diagnosticar una actualización de cuota Antigravity

La vista de cuota de cuenta y `ocx account list google-antigravity --quota --refresh` distinguen entre denegación de acceso, limitación de velocidad, destinos bloqueados o redirecciones, DNS/conexión/tiempos de espera y datos de cuota inutilizables. Las últimas barras conocidas permanecen visibles con su tiempo de observación cuando falla una actualización. La reautenticación retira los diagnósticos de la credencial anterior; una actualización exitosa borra el fallo.

Un resultado denegado por acceso no prueba por sí mismo un inicio de sesión vencido o un plan no elegible. Un destino bloqueado es una decisión de política de red, no una prueba de un defecto de IP falsa. Los destinos de la cuota Canonical Google retienen las restricciones de verificación y redirección/dirección privada de TLS. El comportamiento de TUN autenticado debe comprobarse en el entorno afectado; los accesorios de transporte inyectados solos no establecen ese resultado de campo.

<a id="large-inline-images-on-chat-providers"></a>

## Grandes imágenes en línea en proveedores de chat

Las solicitudes de chat compatibles con la traducción OpenAI reducen las imágenes en línea cuando sus datos base64 combinados superan los 3,5 MiB. Las imágenes más antiguas pierden detalle primero. Este es un presupuesto de imagen de mejor esfuerzo, por lo que el texto grande, los esquemas o las imágenes que no se pueden procesar aún pueden exceder un límite de solicitud ascendente. Las URL de imágenes remotas no se descargan y las imágenes que no se pueden reducir permanecen adjuntas. El passthrough de Native Chat mantiene sus bytes de imagen originales.


### Cambios del catálogo y cuotas

Mientras un inicio de sesión esté en curso, **Cuentas** ofrece **Cancelar** al aparecer instrucciones. Las plazas Business Premium `self_serve_business_prolite` pesan cinco unidades Standard en la estimación, según los límites Business oficiales citados en la sección de capacidad, verificados el 20 de octubre de 2026. No cambia selección de cuentas ni crea ventanas que no informe el proveedor. Un grupo OAuth Anthropic activado con dos o más cuentas ofrece estimación equivalente, con igual peso por cuenta; usa últimas lecturas sin consultas extra y señala cobertura incompleta por pausa, reautenticación o datos obsoletos. Con el grupo desactivado o una sola cuenta muestra su lectura individual.

Las configuraciones v1 migran al marcador 2 y una fila compatible con opciones. Se guarda una sola copia `~/.opencodex/config.json.pre-openai-tiers-v2.bak`; `cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json` la restaura.

Ante errores de versión OAuth, consulta [Claude OAuth](/es/guides/claude-code/#claude-oauth-client-version-errors).

Mistral en `https://api.mistral.ai/v1` consulta `/v1/billing/budget` y `/v1/billing/subscription` con la credencial y salida de inferencia para mostrar presupuestos API/Vibe y plan reconocido. Es solo visual: no ordena, enruta ni pausa claves ni entra en Pool. Presupuestos ausentes, mal formados o no positivos, monedas inválidas o porcentajes fuera de rango son desconocidos; no se inventa nivel a partir de una clave ni se muestran planes desconocidos. Conserva lecturas válidas recientes ante 402, 408, 429, 5xx o error de transporte, pero no tras 401, 403 u otros rechazos no reintentables.

Para modelos Claude alcanzados por el adaptador Chat traducido, OpenCodex aplana `oneOf`, `anyOf` y `allOf` de la raíz del esquema a un objeto. Se determina por el ID real enviado al proveedor cuyo último segmento empieza por `claude-`, sin distinguir mayúsculas, no por todos los modelos de una pasarela. Conserva los required de raíz, combina los de ramas allOf y no promueve los de ramas oneOf/anyOf. Sigue hasta 64 referencias locales de ramas por esquema; si son externas, cíclicas, no resolubles, exceden el límite o apuntan a composiciones, conserva la composición y el proveedor puede rechazarla. Las composiciones anidadas en línea también se conservan si contienen propiedades o referencias sin leer, o exceden 256 entradas inspeccionadas; las que solo anidan restricciones siguen aplanándose. El guard no recorre esquemas de propiedades ni valores literales y preserva referencias anidadas. La conversión pierde restricciones de ramas y las propiedades posteriores prevalecen: las herramientas deben validar argumentos. Se mantienen las reglas de compatibilidad Zen y Azure.

En Kimi con claves API, `https://api.kimi.ai/coding/v1` consulta /usages en ese mismo origen regional; el endpoint canónico `https://api.kimi.com/coding/v1` conserva su consulta /usages. El inicio de sesión de cuenta sigue en `api.kimi.com`.
