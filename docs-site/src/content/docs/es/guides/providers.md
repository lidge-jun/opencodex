---
title: "Proveedores"
description: "En todos los sentidos opencodex autentica y habla con un proveedor de LLM — OAuth, API clave, ChatGPT hacia adelante y local."
---

Un **proveedor** es un punto final de LLM ascendente más cómo llegar a él: un adaptador, una URL base, un modo de autenticación y una lista de modelos opcional. Los proveedores viven bajo `providers` en `~/.opencodex/config.json`.

La vista general del proveedor del panel separa los detalles de conexión, el uso de la cuenta y las notas editables. Las notas aparecen una vez, debajo de las secciones de conexión y autenticación. Los ajustes preestablecidos de patrocinador compatibles también muestran una breve introducción, una etiqueta de patrocinador y enlaces al sitio o consola del proveedor. Estos enlaces conservan los parámetros de referencia del preset. La información del patrocinador se muestra solo cuando el nombre del proveedor configurado, el adaptador y el punto final coinciden con el ajuste preestablecido; nunca cambia el enrutamiento, la selección de la cuenta o los valores predeterminados.

<a id="openai-account-modes"></a>

## Modos de cuenta OpenAI

| Id de proveedor | Uso | Regla de credenciales/cuenta |
| --- | --- | --- |
| `openai` | Codex inicio de sesión | Pool (predeterminado) selecciona las cuentas principales más las cuentas agregadas; Direct utiliza el inicio de sesión actual de la persona que llama/principal solamente. |
| `openai-apikey` | OpenAI API | Configurado API clave/grupo de claves solamente; nunca lee Codex cuentas. |

Utilice `gpt-5.6-sol` desnudo con la opción Pool / Direct en la página de proveedores, o `openai-apikey/gpt-5.6-sol` para API. Las rutas de credenciales nunca se cruzan entre sí. La ruta API publica 1,050,000 metadatos de entrada de contexto / 922,000 máximos. Sus identificadores virtuales `sol-pro`, `terra-pro` y `luna-pro` mantienen su identidad pública seleccionada, mientras que el cable utiliza el modelo base más `reasoning.mode: "pro"`.

Si el proveedor `openai` integrado no está disponible o está desactivado, el selector de cuentas del panel de control y la página Codex Auth pueden restaurarlo: las filas ausentes se crean a partir del preajuste canónico, las filas canónicas deshabilitadas se vuelven a habilitar sin reemplazar la configuración del modelo o modo guardado, y no canónicas a las filas `openai` no se les ofrece esa ruta de recuperación.

La compatibilidad con Luna Reserve es una capacidad de cuenta ChatGPT en la ruta de avance canónica OpenAI, no un derecho de clave OpenAI API. Su selector manual de almacenamiento principal requiere un modo de escritorio local efectivo y un permiso de flujo ascendente actual vinculado a credenciales; una entrada de catálogo por sí sola no autoriza una solicitud. Consulte [Luna Reserve junto a modelos enrutados](/es/reference/cli/providers-accounts/#luna-reserve-alongside-routed-models) para ver la configuración, el orden de reinicio, los requisitos de autorización y los ayudantes no compatibles.

Para añadir una cuenta con cuota agotada y finalizar su validación diferida, véase [Codex calentamiento de la cuenta](/es/guides/codex-integration/#codex-account-warmup).

<a id="providers-overview-pool-capacity"></a>

### Capacidad del grupo

Para el inicio de sesión Codex en el modo Pool, la descripción general de proveedores muestra una estimación del peso configurado de la capacidad utilizada del grupo en lugar de presentar una cuenta arbitraria como el total del proveedor. La misma fila también muestra el porcentaje de cuota en bruto de la cuenta efectiva actual, para que pueda distinguir la estimación del grupo de la cuenta que usaría una nueva solicitud.

Cuando la información de restablecimiento está disponible, la visión general muestra el siguiente tiempo de restablecimiento y la capacidad que se espera que se recupere como `+N% pool capacity`. **Cobertura incompleta** significa que una o más cuentas del grupo no podrían contribuir de manera segura a la estimación, por ejemplo, porque su plan o cuota es desconocido, su lectura es obsoleta o la cuenta está pausada o necesita reautenticación.

Una advertencia de **Cobertura de ventana parcial** significa que algunas cuentas incluidas informaron una ventana de cuota pero no otra. La descripción general mantiene esas ventanas separadas y marca cada ventana afectada incompleta en lugar de tratar la lectura faltante como uso para esa ventana.

Esta estimación es solo de visualización. No cambia la selección de cuenta, afinidad de sesión, conmutación automática, tiempos de reutilización o cualquier otra decisión de enrutamiento. Utilice el [Codex Fondo de cuenta de Auth](/es/guides/web-dashboard/#codex-auth-and-account-pools) para los controles de estado y enrutamiento de la cuenta individual.

Las configuraciones v1 enviadas migran automáticamente al marcador 2 y a una fila consciente de las opciones. La configuración original se conserva una vez en `~/.opencodex/config.json.pre-openai-tiers-v2.bak`; restaurarlo con `cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json`.

<a id="claude-opus-55-progress-updates"></a>

## Claude Opus 5.5 actualizaciones de progreso

Cuando el adaptador `anthropic` envía Claude Opus 5.5 a `api.anthropic.com` (clave OAuth o API), OpenCodex solicita Anthropic s [Modo de visualización de actualización de progreso](https://platform.claude.com/docs/en/build-with-claude/thinking#progress-updates). Las actualizaciones de progreso y los reconocimientos a mitad de giro aparecen como comentarios asistentes visibles en Codex, incluso cuando los resúmenes de pensamiento están ocultos. Los resúmenes de razonamiento se omiten en este modo porque Anthropic no puede distinguir las actualizaciones de progreso del razonamiento bajo `display: "summarized"`. Los bloques de pensamiento firmados originales se conservan para la continuación de la herramienta; ninguna firma se decodifica o se reescribe. Las actualizaciones aparecen una vez que se completa su bloque firmado. Otros modelos y puntos finales de terceros compatibles conservan su comportamiento de visualización de pensamiento existente.

<a id="anthropic-image-input"></a>

## Entrada de imagen Anthropic

Las semillas modelo Claude incorporadas anuncian la entrada de texto e imagen para `anthropic` (OAuth) y `anthropic-apikey`, consistente con [Anthropic 's visión general del modelo](https://platform.claude.com/docs/en/models/overview). Las anulaciones explícitas de la modalidad de entrada por modelo siguen siendo autorizadas; los modelos desconocidos no se asumen con capacidad de imagen. Esto se aplica a todas las integraciones donde la configuración del cliente admite metadatos de capacidad de imagen: OpenClaw exporta una matriz `input` declarada, y Kimi Code exporta `capabilities: ["image_in"]` solo para modelos con capacidad de imagen. OpenClaw omite `input` cuando no se declaran modalidades compatibles; Kimi omite `capabilities` para modelos desconocidos o de solo texto. Los clientes sin un campo de capacidad compatible mantienen su forma de configuración existente. Después de actualizar opencodex, regenerar o actualizar la configuración del cliente gestionada por opencodex para recibir los metadatos actualizados.

<a id="replayed-anthropic-thinking-signatures"></a>

## Firmas de pensamiento Anthropic reproducidas

En el punto final Responses, un flujo ascendente compatible con Anthropic puede rechazar una firma de pensamiento reproducida porque pertenece a un prefijo de conversación diferente. Cuando el error identifica explícitamente este problema de firma vinculante, opencodex puede eliminar el pensamiento firmado/redactado reproducido y volver a intentarlo una vez dentro del presupuesto de envío de la solicitud. Esto cubre HTTP 400 rechazos y errores de flujo iniciales antes de la salida o la actividad de la herramienta. La búsqueda web alojada y los puentes de imagen/vídeo comparten un límite de recuperación a través de sus iteraciones de modelo: solo se reenvía la inferencia rechazada, mientras que se conservan las llamadas de sidecar completadas y los resultados de la herramienta. Un reintento de finalización vacía comparte la asignación de su solicitud; las continuaciones ordinarias después de la salida no pueden usarla. Un reemplazo fallido se devuelve sin otro reintento de firma. Otros errores mantienen su manejo existente.

La recuperación de Sidecar se desactiva cuando la contabilidad de gastos forzada no puede establecer recibos para envíos anteriores de sidecar ordinarios. Nunca aumenta la asignación de envío de llamadas o combo.

Solo una finalización exitosa y no vacía recuerda el rechazo de esa conversación y la identidad de servicio durante cinco minutos. Solo las cargas útiles opacas rechazadas se suprimen cuando pueden ser identificadas; el pensamiento recién emitido sigue siendo reproducible. El historial de texto sin formato permanece disponible; un reintento fallido o cancelado no inhabilita la repetición de pensamiento en solicitudes posteriores.

<a id="auth-modes"></a>

## Modos de autenticación

Las configuraciones de proveedor aceptan tres valores `authMode` (`key` es el valor predeterminado). El registro incorporado también etiqueta los preajustes locales por separado; los que normalmente omiten tanto `authMode` como `apiKey`.

| `authMode` | Cómo se autentica | Utilizado por |
| --- | --- | --- |
| `key` | Envía su llave API (`Authorization: Bearer …`, o `x-api-key` / `api-key` por adaptador). La clave puede ser una referencia literal o una referencia `${ENV_VAR}`. | La mayoría de los proveedores. |
| `forward` | Relés **tus encabezados de autenticación entrantes Codex** verbatim al proveedor - sin clave almacenada. Este es el passthrough de inicio de sesión ChatGPT. | OpenAI (adaptador `openai-responses`). |
| `oauth` | Resuelve un token de acceso OAuth almacenado (actualizado automáticamente antes de la expiración) y lo usa como la clave portadora. | xAI, Anthropic, Kimi, Kiro, Google Antigravity, Cursor, Zed Hosted AI, Command Code, GitHub Copilot, Nous Portal. |

La repetición de un error 429 con la misma clave mediante [`retryOn429`](/es/reference/configuration/) solo se aplica a proveedores con clave API (`authMode: "key"`). OAuth, el reenvío de credenciales y los preajustes locales quedan excluidos: sus credenciales no deben repetirse en el mismo token y los entornos locales no tienen una clave remota que conservar. La opción debe habilitarse expresamente, salvo los valores predeterminados documentados para destinos concretos. Mistral Chat oficial usa una política de espera con seis repeticiones e intervalo alternativo de diez segundos, dentro del límite de envíos de la solicitud. Las opciones explícitas de `retryOn429`, incluido `enabled: false`, tienen prioridad. El preajuste de Mistral también reenvía por defecto las claves de caché de instrucciones que recibe; `promptCacheKey: false` lo desactiva. La afinidad de caché mejora la posibilidad de reutilizarla, pero no garantiza un acierto ni elimina los límites de tokens por unidad de tiempo.

Mistral usa un único proveedor con clave API tanto para las claves de Studio como para las de Vibe. Su [documentación de claves API](https://docs.mistral.ai/admin/identity-access/api-keys) describe los tipos de claves y los límites de los planes; el proxy no deduce el nivel de suscripción a partir de la clave. Para cada modelo, los plazos explícitos de `Retry-After` se comparten entre llamadas que usan la misma credencial y el mismo modelo. Un 429 sin plazo puede activar una espera conservadora de recuperación de 60 segundos si los contadores válidos por minuto indican capacidad agotada o si el costo medido de la consulta rechazada supera los tokens restantes, pero cabe en el límite total anunciado. Es una política local de recuperación, no una predicción exacta del restablecimiento del servidor. El tráfico correcto nunca predice el costo ni la caché de la siguiente consulta. Tras la espera se envía una sola consulta de prueba; si funciona, se restablece el tráfico normal. La evidencia ausente, malformada, sin derechos de uso, con cuota mensual agotada o por encima del límite total no inventa un restablecimiento ni compacta el historial. `requestPacing: { "enabled": false }` o `retryOn429: { "respectRetryAfter": false }` desactivan la espera compartida. Si el plazo de Mistral supera `retryOn429.maxIntervalMs`, el proxy devuelve el 429 y su indicación de espera en lugar de reintentar antes de tiempo. Las ventanas de contexto y las preferencias de compactación por modelo siguen siendo independientes.

Cuando se habilita la selección de clave de round-robin, las solicitudes en cola vuelven a verificar los tiempos de reutilización de la clave antes de enviar y adquieren capacidad de estimulación para cualquier clave de reemplazo. Esto se aplica a Chat nativo, Messages, Responses y compacto. Esperar la capacidad de la clave de reemplazo no consume el tiempo de espera del encabezado de respuesta ascendente. El ritmo por tecla y el uso de round-robin están protegidos HTTP / SSE incluso cuando se habilitan WebSockets aguas arriba; WebSocket -sólo la dirección y la inyección requieren una ruta sin esas políticas clave. Esto no cambia la clave activa guardada. Un giro ascendente establecido mantiene su credencial; los envíos posteriores se rechazan si esa clave se enfría. El rechazo de clave de pre-salida puede recuperar una clave sana dentro del límite de solicitud existente. Direct Las imágenes y las solicitudes compactas registran los tiempos de reutilización genuinos 401/429 sin reproducir ese POST pagado.

<a id="anthropic-api-key-credit-exhaustion"></a>

### Anthropic API-agotamiento de crédito clave

Anthropic API -grupos de claves con al menos dos claves intentan automáticamente una clave hermana cuando un error completo HTTP `400` o `402` indica que el saldo de crédito es demasiado bajo para acceder al Anthropic API. Esto se aplica a `invalid_request_error`, `billing_error` y `permission_error` antes de cualquier salida de texto o herramienta. Las estrategias de rotación y agrupación de claves omiten la clave fallida durante una hora, porque un saldo vacío solo se borra cuando se agregan créditos; cuando cada clave está fuera de crédito, las solicitudes aún usan la clave activa y devuelven el error original de Anthropic; elegir la clave como activa en el panel de control o reiniciar el proxy borra esa retención después de una recarga. El reemplazo envía compartir el límite de envío de la solicitud. Los errores ordinarios `400` permanecen en el terminal, y esto no permite reintentos de la misma clave ni cambiar el enrutamiento de la cuenta OAuth. Una anulación de encabezado que envía una credencial diferente no puede enfriar o rotar la clave de grupo seleccionada.

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

<a id="providers-that-accept-both-a-login-and-a-key"></a>

#### Proveedores que aceptan tanto un inicio de sesión como una clave

| Proveedor | Inicio de sesión de suscripción | API clave |
| --- | --- | --- |
| OpenAI / ChatGPT | `openai` - Codex inicio de sesión; gasta el plan ChatGPT detrás de él | `openai-apikey` - un proveedor separado; el uso aterriza en la cuenta de la plataforma OpenAI que posee la clave |
| Anthropic | `ocx login anthropic` - inicia sesión como su cuenta Claude. opencodex lee sus ventanas de uso de cinco horas y siete días; ese punto final no informa ningún nivel de suscripción | `anthropic-apikey` - facturación directa Anthropic API, no Claude suscripción |
| xAI | `ocx login xai` - la pasarela de suscripción Grok CLI. opencodex lee los créditos semanales de SuperGrok, o el grupo mensual | el mismo proveedor `xai` con `authMode: "key"`, que apunta `https://api.x.ai/v1`, por lo que el uso aterriza en esa cuenta API |
| Kimi | `ocx login kimi` - inicie sesión con su cuenta Kimi. `kimi-responses` es el mismo inicio de sesión de la cuenta Kimi enrutado a través del cable OpenAI Responses (creyendo que el contenido permanece cifrado en el lado del servidor, las llamadas a herramientas permanecen visibles; el ajuste preestablecido predeterminado de Chat mantiene el razonamiento de texto plano) | `kimi-code` - la forma de la llave API del mismo plan de código Kimi transporte |
| Command Code | `ocx login command-code` - opencodex lee ventanas de cinco horas y semanales más un saldo de crédito | `commandcode` - el mismo servicio en `/provider/v1` con una llave |
| GitHub Copilot | `ocx login github-copilot` - requiere una suscripción activa a Copilot | el mismo proveedor `github-copilot` con `authMode: "key"`. El flujo de dispositivos anterior es la ruta de acceso admitida, y cualquiera de las credenciales es una Copilot, por lo que la suscripción aún paga |
| OrcaRouter | `ocx login orcarouter-oauth` - consentimiento acuña una clave de `sk-orca-…` de larga duración, propiedad del usuario, y la solicitud lleva una clave | `orcarouter` - la misma llave pegada a mano |
| Meta Muse | `ocx login meta-muse` puede importar una clave local de código Muse CLI o iniciar el inicio de sesión del dispositivo. Meta alcances de esa credencial a su propio CLI, por lo que este es un uso no compatible: cómo se liquidan las llamadas no es observable desde el API, y debe tratar cada llamada como facturable en su cuenta | `meta-model` es la ruta admitida: cada llamada se mide por token, y una suscripción Muse Code no funciona allí. |

Cursor, Kiro, Zed Hosted AI y Nous Portal son solo de inicio de sesión y no tienen el equivalente de clave API. Google Antigravity también es solo para iniciar sesión: `ocx login google-antigravity` inicia sesión con su cuenta Google a través del cable de Cloud Code Assist, y el ajuste preestablecido `google` al lado es el AI Studio Gemini API, un producto diferente al que se llega con su propia clave, no un modo de clave para el mismo inicio de sesión. La pestaña Cuentas Antigravity muestra un nivel de membresía observado como una insignia junto a la etiqueta de la cuenta, utilizando el ID de nivel ascendente (por ejemplo, `free-tier` o `gemini-pro`). No aparece ninguna insignia cuando el plan es desconocido; no afecta el enrutamiento ni la cuota.

Gemini 4 Argon (`gemini-4-argon`) aparece en el preajuste `google` con niveles de pensamiento bajos, medios (el predeterminado) y altos. Google lo ofrece solo en el nivel pagado Gemini API, no en el nivel gratuito. El `google-antigravity`, Argon aparece con los mismos tres niveles, que se asignan a los modelos de alambre `gemini-4-argon-low`, `-medium` y `-high`. Google lo limita a las cuentas AI Ultra y Enterprise elegibles. Cloud Code Assist sirve Argon solo al cliente Antigravity CLI, por lo que OpenCodex envía solicitudes de Argon y descubrimiento de modelo con el CLI User-Agent (`antigravity/cli/1.3.4` ) y mantiene el IDE User-Agent para cualquier otro modelo.

En Vertex AI, `gemini-4-argon` recibe imágenes devueltas por herramientas, como capturas de pantalla, dentro de la respuesta de función coincidente. Esto evita el error 400 aguas arriba "Las solicitudes que terminan con un giro de modelo no son compatibles" después de una llamada de herramienta de producción de imágenes mientras se conservan las imágenes. Las imágenes de resultados duplicados o resultados sin una llamada coincidente se conservan en un mensaje separado después de las respuestas de la herramienta, con un marcador que explica que no se pudieron emparejar. No se necesita ningún cambio de configuración; este manejo es específico para Vertex Argon.

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

El proveedor de `openai` necesita **no API clave**. Direct reenvía las credenciales de su `codex login` existente; Pool resuelve una cuenta principal o agregada Codex antes de usar el mismo backend:

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
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi Modelos de codificación de Plan de Código. Predeterminado para el alias estable `kimi-for-coding` (actualmente K2.8 Preview): ventana de contexto de token 1M, pensamiento ajustable `low` / `high` / `max` (predeterminado `max`), texto + entrada de imagen. Las selecciones `kimi-k2.x` retiradas se migran al alias en la actualización. |
| `kimi-responses` | `openai-responses` | `https://api.kimi.com/coding/v1` | El mismo inicio de sesión de la cuenta Kimi (reutiliza la credencial `kimi` OAuth) sobre el cable OpenAI Responses. Misma lista de modelos y capacidades que `kimi`; pensando que el contenido permanece encriptado en el lado del servidor, las llamadas a herramientas y los resultados permanecen visibles. |
| `nous` | `openai-chat` | `https://inference-api.nousresearch.com/v1` | Nous Research pasarela de suscripción (el mismo backend que usa Hermes Agent). El inicio de sesión de concesión de dispositivo contra `portal.nousresearch.com`; el token de acceso es la inferencia por solicitud JWT. Pago mixto + catálogo de modelos `:free` (`tencent/hy3:free`, `stepfun/step-3.7-flash:free`,...) descubierto en vivo desde la cuenta iniciada. Los tokens de actualización son de un solo uso y se rotan en cada actualización. |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | Los botones de inicio de sesión y agregar cuenta del panel de control ofrecen Builder ID, Google, GitHub inicio de sesión del dispositivo o Kiro CLI. El inicio de sesión nativo del dispositivo agrega una cuenta sin cerrar sesión `kiro-cli`. La opción Kiro CLI importa o inicia una sesión CLI; su flujo de trabajo Agregar cuenta cambia temporalmente la cuenta CLI y la restaura en caso de cancelación o falla. |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | Google OAuth sobre el cable de Cloud Code Assist. Live discovery utiliza el punto final autenticado `v1internal:fetchAvailableModels` de CCA y publica los modelos de agente disponibles para la cuenta iniciada; el catálogo mantenido sigue siendo la reserva. |
| `cursor` | `cursor` | `https://api2.cursor.sh` | Inicio de sesión PKCE experimental, transporte HTTP/2 en vivo con una ruta de compatibilidad opt-in HTTP/1.1 y descubrimiento de modelo filtrado por cuenta. |
| `zed` | `zed` | `https://cloud.zed.dev` | Experimental puente Zed AI alojado. Utiliza la devolución de llamada RSA de Zed, intercambia el token de cuenta por un token de inferencia alojada de corta duración y descubre la lista en vivo de la cuenta. |
| `orcarouter-oauth` | `openai-chat` | `https://api.orcarouter.ai/v1` | El consentimiento del navegador y el intercambio de claves usan `https://www.orcarouter.ai` con S256 PKCE. La clave `sk-orca-…` API de propiedad del usuario devuelta se almacena en el almacén de credenciales existente y se reutiliza hasta que se revoca. |
| `devin` | `devin` | `https://server.codeium.com` | Experimental no oficial Cognición/Puente Devin. Login primero importa la credencial que ya tiene el Devin CLI instalado (`devin auth login` escribe un `devin-session-token` a su propio `credentials.toml`); cuando no está presente, abre el inicio de sesión del navegador Auth0 e intercambia el token pegado a través del `RegisterUser` de Cognition por una clave API de larga duración. `ocx login devin-cli` sigue siendo un alias obsoleto. Los modelos se descubren por cuenta con `GetCascadeModelConfigs`. La cuota de la cuenta viene de `GetUserStatus` bajo una solicitud de ocho segundos y la fecha límite del cuerpo: ventanas con fecha diaria y semanal, más el fondo de crédito rápido y flexible mensual para un plan de crédito facturado o una estrategia desconocida con ambas fechas de reinicio ausentes cuando un campo de saldo está presente. Los créditos usados negativos omiten la ventana mensual; los créditos válidos disponibles cero la marcan agotada. Una sonda de tiempo de espera mantiene la última cuota buena. No se muestra en el panel de control predeterminado. Los informes de chat y uso se verifican con una cuenta real en tres modelos. |
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

Para los preajustes canónicos del Plan de Codificación Kimi (inicio de sesión de cuenta `kimi` y clave `kimi-code` API), opencodex reenvía solo un establo `prompt_cache_key` suministrado por el llamante a la solicitud Chat Completions (el cable Responses acepta el mismo campo, pero opencodex no lo envía allí hoy); nunca genera uno. Kimi documenta una clave de sesión/tarea estable según sea necesario para mejorar las tasas de aciertos de la caché del Plan de código, mientras que las solicitudes sin una clave permanecen sin clave. Si un opt-in aguas arriba rechaza el campo, opencodex no lo elimina y vuelve a intentar o mutar la configuración guardada. Otros proveedores siguen negando por defecto.

Kimi La ruta nativa Responses de Code omite los mensajes del historial del asistente vacíos de contenido explícito para evitar su rechazo `assistant must not be empty`. Texto no vacío, espacios en blanco, rechazos, razonamiento y llamadas/resultados de herramientas son retenidos; el historial del cliente almacenado no es reescrito. Un mensaje vacío referenciado por un `item_reference` en la misma entrada se retiene en lugar de dejar una referencia colgante.

Kimi Codificación precios de uso para `k3`, `k3[1m]`, y `k3-256k` son **API-estimaciones de referencia** a través
`kimi`, `kimi-code`, y `kimi-responses`, usando la tasa de escritura en caché de 5 minutos predeterminada publicada. No reproducen la facturación o cuota del Plan de Código: la variante 1M de K3 consume aproximadamente el doble de la cuota de `k3-256k`. `kimi-for-coding` ahora apunta a K2.8 Preview, por lo que su antiguo precio K2.7 ya no es utilizado; su estimación permanece indisponible a menos que el operador suministre `modelCosts`. Precio desconocido Por lo tanto, las políticas de enrutamiento y los límites de costos que excluyen estimaciones desconocidas pueden excluir este alias. Véase [Configuración del modelo de Kimi](https://www.kimi.com/code/docs/en/kimi-code/models.html) y
[Precios de API](https://platform.kimi.ai/docs/pricing/chat).

Un proveedor personalizado de `openai-chat` puede optar por cuando sus documentos ascendentes sean compatibles con `prompt_cache_key`:

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

El adaptador reenvía la llave que se le da y nunca inventa una. Todavía puede recibir una clave que la persona que llama no envió: Claude Messages traducción deriva uno de `metadata.user_id`, o de un modelo / sistema / herramientas cohorte cuando el cliente no envía metadatos, porque el OpenAI backends informe `cached_tokens: 0` para cada vuelta sin clave. Por lo tanto, "reenviado, no fabricado" describe este adaptador, no toda la ruta de solicitud.

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

OAuth proveedores cuyas credenciales incluyen un ID de cuenta estable o correo electrónico pueden mantener más de un inicio de sesión. La página Proveedores muestra esas cuentas en un menú desplegable, le permite agregar otra y cambia la cuenta activa sin cerrar la sesión de las otras. Un inicio de sesión normal con una credencial sin identidad Kimi reemplaza la ranura activa, mientras que un **Añadir cuenta** explícito conserva esa ranura y activa una nueva y distinta. Kiro cuentas están clavedas por el perfil ARN. `chatgpt` siempre es de una sola ranura porque las cuentas de grupo Codex tienen un libro mayor separado. Los tokens permanecen en `~/.opencodex/auth.json`; `/api/oauth/accounts` devuelve solo metadatos enmascarados.

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

**Enfriamientos (Codex pool).** Upstream `429` / las respuestas de cuota establecen un tiempo de reutilización duro de `Retry-After`, una cuota de `reset` encabezados (cap) o un retroceso predeterminado corto. Las cuentas en un tiempo de reutilización explícito de `Retry-After` no se exploran temprano; los tiempos de reutilización derivados del restablecimiento pueden recibir un arrendamiento de sonda con ritmo para que la recuperación pueda detectarse sin inundar al proveedor. Los tiempos de reutilización de modelos nativos derivados de restablecimiento mantienen la cuota nativa compartida (incluido GPT-5.6 Terra/Luna) separada de `gpt-reserve`. Los modelos en el grupo compartido todavía se protegen unos a otros; un éxito ordinario no puede borrar un tiempo de reutilización de la Reserva. `Retry-After` explícito y los tiempos de reutilización predeterminados siempre permanecen en toda la cuenta.

**Afinidad de sesión.** Codex hilo → cuenta afinidad es proceso-local (en memoria solamente; no persistió a través de reinicios proxy). En caso de fallos de credenciales (`401` / `403`), la cuenta se pone en cuarentena para determinar la autenticidad y se borran las afinidades de esa cuenta. En `429`, la cuenta entra en tiempo de reutilización, las afinidades se borran y la selección del grupo puede girar: los hilos no se fijan a través de una respuesta de límite de velocidad.

**Volver a una cuenta recuperada.** Para reanudar el uso de la cuenta de máxima prioridad durante una tarea en curso, active `ocx config set codexAccountPriorityFailback true` y mantenga la estrategia Pool en `quota` con la conmutación automática habilitada. Por ejemplo, una tarea puede pasar de Plus a otra cuenta cuando se llena su ventana de cinco horas y luego volver a Plus después de que la actualización de la cuota confirme la recuperación. Mientras fluyen las solicitudes, los intentos de actualización en segundo plano se ejecutan como máximo una vez cada cinco minutos. La solicitud que desencadena una actualización puede seguir utilizando la cuenta anterior; la siguiente solicitud después de que se complete la actualización puede retroceder. Las solicitudes que ya se están ejecutando terminan en su cuenta capturada. Los pines de cuenta manuales y las restricciones de acceso al modelo aún se aplican. Esta función está desactivada por defecto; use `ocx config set codexAccountPriorityFailback false` para restaurar enlaces estables.

El umbral efectivo de la cuenta de origen vinculada controla esta preferencia: la anulación `0` la deshabilita, y una anulación positiva funciona incluso cuando el umbral global es `0`. Un candidato debe tener un uso conocido y no agotado por debajo de su propio umbral efectivo positivo. El candidato `0` elimina solo esa preferencia de umbral; aún se aplican la elegibilidad, el tiempo de reutilización y los bloqueos duros. Cada ventana que contribuye a su puntuación necesita una observación reciente en vivo en este proceso. Las actualizaciones solo de créditos, las ventanas retenidas y las barras de visualización hidratadas no prueban por sí mismas la recuperación.

**Metadatos del cliente Codex.** La ruta de avance ChatGPT pasa a través de la `FORWARD_HEADERS`
allowlist (autorización, `chatgpt-account-id`, originador, ID de sesión/hilo y Codex relacionados cabeceras — ver [Adaptadores](/es/reference/adapters/)) El modo Pool sobrescribe solo la autenticación y
`chatgpt-account-id` para que coincida con la credencial seleccionada. opencodex hace **no** Fabricar oficial identidad del cliente (por ejemplo, `originator`, encabezados de sesión o hilo) cuando la persona que llama no envió A ellos.

Para el diagnóstico de compatibilidad de cuenta-interruptor, habilitar la depuración del proveedor (`ocx debug provider on`) agrega una línea `[ocx:codex:affinity]` por respuesta directa canónica ChatGPT. La línea contiene presencia de encabezado, cubos de tamaño aproximado, etiquetas de igualdad HMAC locales de proceso, resúmenes seguros de campos de giro de nivel superior conocidos y un recuento de campos de giro desconocidos. Nunca incluye credenciales sin procesar, identificadores de cuenta, valores de certificación, identificadores de subproceso/sesión, metadatos de turno o cuerpos de solicitud; las etiquetas cambian intencionalmente después de cada reinicio del proxy. Use `ocx debug provider logs -f` mientras reproduce las dos solicitudes, luego ejecute `ocx debug provider off`. Esta captura es solo de observación y no elimina metadatos, reintenta una solicitud, cambia de cuentas, restablece un subproceso o afecta el enrutamiento.

**Diagnóstico y reauth.** Human `ocx status` imprime un bloque de salud OAuth (identificadores de cuenta redactados, sin tokens). `ocx doctor` agrega una sección de confiabilidad OAuth con comprobaciones de almacenamiento grabable / de un solo vuelo y filas WARN que incluyen una acción de recuperación. Cuando una cuenta de proveedor OAuth necesita reautenticación, ejecute `ocx login <provider>` (o utilice Reautenticar en el panel de control). Codex cuentas de grupo no son uno de esos proveedores, pero `ocx login codex --reauth` rutas a su cuenta de grupo de reautenticación, que el tablero Codex cuenta de grupo también realiza. Véase [`ocx status` / `ocx doctor`](/es/reference/cli/) en la referencia CLI.

<a id="kiro-request-credits"></a>

### Créditos de solicitud Kiro

En los giros habilitados para herramientas, opencodex mantiene el texto ordinario de Kiro hasta que se valide la finalización. Si Kiro termina con texto sin formato en lugar de su herramienta privada de respuesta final, todavía se ejecuta un reintento limitado y solo se muestra la respuesta final resultante. El progreso que acompaña a una llamada de herramienta real sigue siendo visible. Una respuesta final privada normal no necesita reintento de finalización.

Cuando Kiro emite la medición de crédito, los registros de solicitudes conservan el gasto reportado como `usage.providerCredits`, incluso en el libro mayor de uso persistente. Estos son Kiro créditos; los recuentos de tokens aún pueden estimarse y el valor del crédito no reemplaza las estimaciones de costos de USD. Las solicitudes de reserva de finalización agregan sus créditos reportados. Un valor ausente significa que Kiro no reportó el uso del crédito; un cero explícito significa que no reportó ningún gasto.

<a id="kiro-refresh-attention"></a>

### Kiro actualizar la atención

Si una actualización de AWS SSO devuelve `400 invalid_request` y la recuperación Kiro CLI no se realiza correctamente, el panel de control muestra que la cuenta afectada necesita volver a autenticarse una vez que expire su token de acceso. El proveedor activo informa entonces de `loggedIn: false` desde `/api/oauth/status`. Un token de acceso todavía válido permanece conectado. Puede iniciar sesión de nuevo a través del panel de control; una actualización automática exitosa posterior también borra el estado de atención. Este estado no clasifica la concesión de actualización como revocada ni desactiva futuros intentos de actualización. Los errores de red y servidor no activan este estado.

Para las cuentas de escritorio, un HTTP 401 con exactamente `Bad credentials` requiere un nuevo inicio de sesión e inmediatamente marca la generación de credenciales rechazadas como que necesita una nueva autenticación. Otros mensajes, estados y respuestas de AWS SSO no activan esta regla específica del escritorio.

<a id="kiro-credential-import"></a>

### Importación de credenciales Kiro

El panel de control ofrece inicio de sesión nativo del dispositivo Builder ID, Google y GitHub sin Kiro CLI. La opción Kiro CLI y la ruta de importación `ocx login kiro` usan el CLI: en Unix, instálelo con `curl -fsSL https://cli.kiro.dev/install | bash`; en Windows PowerShell, use `irm 'https://cli.kiro.dev/install.ps1' | iex`; luego inicie sesión con `kiro-cli login`. Sin una sesión `kiro-cli`, `ocx login kiro` vuelve a un token de acceso pegado o la variable de entorno `KIRO_ACCESS_TOKEN`.

La ruta de importación `ocx login kiro` busca en la plataforma Kiro CLI almacena y abre SQLite bases de datos de solo lectura. Dos variables de entorno hacen explícita la selección de la fila de origen y token:

- `KIROCLI_DB_PATH` selecciona una base de datos no estándar Kiro CLI SQLite. La ruta de acceso ya debe existir; durante esta ruta de acceso de importación, opencodex no crea ni modifica los archivos de base de datos, WAL o SHM.
- `KIROCLI_TOKEN_KEY` selecciona la clave de token exacta `auth_kv` cuando una base de datos contiene múltiples filas de tokens ambiguas. Una selección faltante falla el inicio de sesión en lugar de adivinar.

En Windows, la importación busca `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3`. El inicio de sesión forzado/agregar cuenta también necesita el binario local CLI: opencodex primero usa `PATH`, luego vuelve a `%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe` y `C:\Program Files\Kiro-Cli\kiro-cli.exe`. Si ninguna de las carpetas tiene `kiro-cli.exe`, se utiliza un `kiro.exe` dentro de esas mismas dos carpetas `Kiro-Cli`. opencodex nunca ejecuta un `kiro` corto o `kiro.exe` que se encuentra en `PATH` o en directorios compartidos macOS / Linux bin, por lo que instalar o vincular el CLI como `kiro-cli` allí.

Después de una importación exitosa, opencodex persiste la credencial importada a `~/.opencodex/auth.json`. Mantenga estas variables y la base de datos seleccionada privada. No adjunte archivos de base de datos o diagnósticos de inicio de sesión sin procesar a los informes de errores.

Para la opción **Kiro CLI**, **Añadir cuenta** es un flujo de trabajo de escritura separado: captura la sesión actual, inicia sesión en `kiro-cli` e importa el inicio de sesión del navegador nuevo. Si el inicio de sesión se cancela o falla, incluso mientras OpenCodex persiste la credencial, el retroceso reemplaza la base de datos Kiro CLI y elimina sus sidecars WAL, SHM y diario actuales antes de publicar la instantánea de sesión anterior.

Debido a que la reversión solo es posible a partir de una instantánea, la opción Kiro CLI **Añadir cuenta** se niega a firmar `kiro-cli` cuando un almacén de sesión está presente pero no se puede capturar (archivo ilegible, esquema no coincidente o una selección ambigua de token), cuando la importación de redireccionamiento `KIROCLI_DB_PATH` / `KIRO_CLI_DB_FILE` se lee desde el almacén CLI en vivo, o cuando una base de datos CLI primaria existente no tiene una fila de token reconocida. Repare o elimine la base de datos ilegible bajo la ruta de datos normal `kiro-cli`, desactive los selectores de importación y vuelva a intentarlo. No se afecta el inicio de sesión desde una máquina sin sesión `kiro-cli` existente. Las opciones del panel de control nativo son solo para agregar y no cerrar sesión en `kiro-cli`. Un diálogo de dispositivo muestra el código y el destino de la verificación. Solo los hosts Kiro o Builder ID reconocidos se abren como enlaces; un destino inesperado se muestra como texto copiable para su revisión. Cerrar el cuadro de diálogo envía la cancelación y deja una verificación de estado de fondo limitada para conciliar una confirmación que ya está en curso. Se vuelve a intentar una respuesta de estado estancada; agotar la fecha límite de flujo produce el resultado final neutral en lugar de reclamar el éxito. La aprobación Google y GitHub se completa cuando Kiro informa `authorized` (o el estado `approved` heredado) con tokens válidos y un ARN de perfil. La lista de cuentas marca Kiro cuentas excluidas de la selección automática con un motivo, cuando está disponible.

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

opencodex incluye 105 preajustes integrados: 84 con clave, 17 OAuth, tres locales y uno predeterminado de reenvío a ChatGPT. El selector **Añadir proveedor** abre el formulario del proveedor con clave, valida la credencial y la guarda; cada proveedor tiene su propia validación. Entre ellos:

**ClinePass** utiliza una llave Cline API con los [catálogo de suscripción oficial](https://docs.cline.bot/getting-started/clinepass) y [Chat Completions punto final](https://docs.cline.bot/api/chat-completions), operados por Cline Bot Inc. bajo [Los términos de Cline](https://cline.bot/tos). Un id encaminado tal como `cline-pass/cline-pass/kimi-k3` es intencional: el primer segmento selecciona el proveedor opencodex, mientras que `cline-pass/kimi-k3` es la identificador modelo completa enviada aguas arriba. La cuota de ClinePass es compartida por la cuenta a través de límites mensuales, semanales y de 5 horas. Una sonda activa 2026-08-13 verificó que cada modelo estático de ClinePass acepta `low`, `medium`, `high`, `xhigh` y `max` en el límite de entrada de pasarela. opencodex conserva los niveles solicitados; cualquier normalización específica del backend sigue siendo responsabilidad de ClinePass.

**Cline** es la misma clave y punto final API en la facturación de uso de pago por uso en más de 100 modelos (ID de estilo OpenRouter como `anthropic/claude-sonnet-4-6`). Los modelos promocionales gratuitos de Cline solo están disponibles en el IDE de Cline/ CLI, no a través del API; `minimax/minimax-m2.5` es el modelo documentado de experimentación libre API.

**OrcaRouter** ([patrocinador](https://github.com/lidge-jun/opencodex/blob/main/SPONSORS.md)) es una puerta de enlace compatible con OpenAI en `https://api.orcarouter.ai/v1` con identificadores de modelo separados por el nombre del proveedor (`openai/gpt-5.5`, `anthropic/claude-opus-4.8`, `deepseek/deepseek-v4-flash`,...) y un enrutador adaptativo, `orcarouter/auto`, que califica cada solicitud y selecciona el modelo. Cree una clave en el [Consola OrcaRouter](https://www.orcarouter.ai/console); el preajuste fija la fila cerca de la parte superior del selector de proveedores Agregar y la marca como patrocinador, y nada más sobre el enrutamiento o los cambios predeterminados.

**PackyCode** es un relé API para Claude Code, Codex, Gemini y más. Los objetivos preestablecidos apuntan a su punto final OpenAI -compatible con Chat Completions, `https://cf.api.fan/v1`, con el descubrimiento del modelo en vivo reducido a lo que su grupo de tokens permite (`gpt-5.5` y `gpt-5.1-codex` se siembran). Regístrese en [packyapi.com](https://www.packyapi.com) y cree un token de grupo Codex.

**Opper** es la puerta de enlace AI alojada en la UE de Opper AI (Estocolmo): una clave (creada en [plataforma.opper.ai](https://platform.opper.ai)) y un punto final compatible con OpenAI frente a más de 700 modelos de más de 30 proveedores. Los identificadores de modelos desnudos como `claude-sonnet-4-6` o `gpt-5.5` son *grupos*: Opper selecciona el proveedor y la región por solicitud, por lo que los identificadores sembrados permanecen válidos a medida que las rutas van y vienen. Un id `vendor/model` (`anthropic/claude-sonnet-4-6`, `aws/claude-sonnet-4-6-eu`) fija una ruta en su lugar. El catálogo se descubre en vivo desde `/v3/compat/models` con su clave; la lista pública, incluidas las rutas de la UE por regiones, está en [opper.ai/modelos](https://opper.ai/models). Opper también es un proveedor [modelos.dev](https://models.dev) (`opper`), que utiliza los mismos identificadores de grupo desnuda.

| Proveedor | URL base |
| --- | --- |
| **OpenAI (clave API)** | `https://api.openai.com/v1` |
| **Anthropic (clave API)** | `https://api.anthropic.com` |
| **OpenRouter** | `https://openrouter.ai/api/v1` |
| **Cline** | `https://api.cline.bot/api/v1` |
| **ClinePass** | `https://api.cline.bot/api/v1` |
| **Ollama Cloud** | `https://ollama.com/v1` |
| Google Gemini · Google Vertex AI | `https://generativelanguage.googleapis.com` · `https://aiplatform.googleapis.com` |
| Azure OpenAI | `https://{resource}.openai.azure.com/openai` |
| Umans AI · Neuralwatt | `https://api.code.umans.ai` · `https://api.neuralwatt.com/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| MiniMax · MiniMax (CN) | `https://api.minimax.io/v1` · `https://api.minimaxi.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| Cerebras | `https://api.cerebras.ai/v1` |
| Chutes | `https://llm.chutes.ai/v1` |
| DeepInfra | `https://api.deepinfra.com/v1/openai` |
| Hyperbolic | `https://api.hyperbolic.xyz/v1` |
| Nscale Serverless Inference | `https://inference.api.nscale.com/v1` |
| Vultr Serverless Inference | `https://api.vultrinference.com/v1` |
| Baseten Model APIs | `https://inference.baseten.co/v1` |
| Command Code | `https://api.commandcode.ai/provider/v1` |
| OrcaRouter | `https://api.orcarouter.ai/v1` |
| PackyCode | `https://cf.api.fan/v1` |
| Meta Model API | `https://api.meta.ai/v1` |
| Meta Muse Code (credencial CLI) | `https://api.meta.ai/v1` |
| SambaNova Cloud | `https://api.sambanova.ai/v1` |
| Nebius Token Factory | `https://api.tokenfactory.nebius.com/v1` |
| Crusoe | `https://api.inference.crusoecloud.com/v1` |
| DigitalOcean Serverless Inference | `https://inference.do-ai.run/v1` |
| Scaleway Generative APIs | `https://api.scaleway.ai/v1` |
| Featherless AI | `https://api.featherless.ai/v1` |
| Novita AI | `https://api.novita.ai/openai/v1` |
| Together | `https://api.together.xyz/v1` |
| Fireworks | `https://api.fireworks.ai/inference/v1` |
| Moonshot (Kimi API) · Kimi (coding) | `https://api.moonshot.ai/v1` · `https://api.kimi.com/coding/v1` |
| Hugging Face | `https://router.huggingface.co/v1` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` |
| Z.AI (GLM Coding) | `https://api.z.ai` — Responses en `/api/v1/responses` de forma predeterminada; Chat Completions en `/api/coding/paas/v4/chat/completions` por modelo mediante `modelAdapters` |
| Zhipu AI (BigModel) | `https://open.bigmodel.cn/api/paas/v4` |
| BigModel Coding Plan (Responses, lista estática) | `https://open.bigmodel.cn/api/v1` |
| Qwen Cloud | Plan de tokens (predeterminado): `https://token-plan.maas.qwencloudapi.com/compatible-mode/v1` · Pago por uso: `https://dashscope.aliyuncs.com/compatible-mode/v1` · o personalizado |
| Tencent Cloud Coding Plan | `https://api.lkeap.cloud.tencent.com/coding/v3` |
| SiliconFlow | `https://api.siliconflow.cn/v1` |
| Volcengine Ark · Coding Plan · Agent Plan | `https://ark.cn-beijing.volces.com/api/v3` · `https://ark.cn-beijing.volces.com/api/coding/v3` · `https://ark.cn-beijing.volces.com/api/plan/v3` |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Xiaomi MiMo (OpenAI Chat) | `https://api.xiaomimimo.com/v1` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| Opper | `https://api.opper.ai/v3/compat` |
| TokenLab | `https://api.tokenlab.sh/v1` |
| Modelflare | `https://modelflare.dev/v1` |
| OpenGateway | `https://apis.opengateway.ai/v1` |
| GitLab Duo | `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic` |
| …y otros | opencode zen, Vercel AI Gateway, Venice, NanoGPT, Synthetic, Qianfan, Alibaba, Parallel, ZenMux, LiteLLM |

**Alibaba Token Plan** ofrece los presets Personal Edition de Beijing y Team Edition internacional. Ambas regiones ofrecen los dos niveles de suscripción. Las listas de modelos de chat son estáticas porque el descubrimiento del proveedor también incluye modelos que no son de chat. Se conservan las selecciones existentes y los endpoints internacionales configurados explícitamente.

Ambos presets incluyen `deepseek-v4.1-flash-1017`, con entrada de texto e imágenes, salida de texto, contexto de 1.000.000 de tokens y razonamiento `low`, `high` y `max` (`high` por defecto). Su límite de salida de 393.216 sigue la normalización del presupuesto publicado; no es un límite medido. El Lab informa 384.000. Los esquemas estrictos son rechazados y `json_object` no está verificado para este identificador exacto, por lo que las solicitudes Chat omiten `response_format`: la salida es texto de mejor esfuerzo, sin garantía de JSON. La degradación JSON verificada del modelo sin sufijo y las asignaciones existentes a Responses no cambian. Beijing también incluye `deepseek-v4-pro-0813`, ahora publicado. La región internacional omite los retirados `deepseek-v3.2` y `deepseek-v4-flash` sin sufijo, pero conserva `deepseek-v4-flash-0731`. Los presets mantienen los hosts de sus guías oficiales: Beijing usa `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` y la región internacional `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`. El preset Qwen Cloud usa el host Token Plan independiente documentado arriba. Consulta la [ficha del modelo 1017](https://www.qianwenai.com/models/deepseek-v4.1-flash-1017), la [referencia Chat](https://docs.qwencloud.com/api-reference/chat/openai-chat) y la [guía Personal](https://help.aliyun.com/en/model-studio/token-plan-personal-overview).

**OpenGateway** es una puerta de enlace compatible con OpenAI operada por Sionic AI en
`https://apis.opengateway.ai/v1`. Su catálogo público contiene alrededor de 80 modelos activos. (como se verificó en 2026-10-02); el ajuste preestablecido actualiza automáticamente la lista de modelos en vivo desde público `GET /v1/models` y mantiene activos los modelos Chat Completions (además de la Responses-only `openai/o3-pro`, que está anclado a Responses). Servido con ión
`deepseek/deepseek-v4.1-flash-ultrafast` y `z-ai/glm-5.3-flash-ultrafast` Se enumeran primero. Crear una clave en el [Panel de OpenGateway](https://opengateway.ai/api-keys), luego corre
`ocx provider add opengateway` o seleccione **OpenGateway** en el panel. Solicitudes de chat use la clave Bearer configurada; la lista de modelos públicos no valida esa clave. En el cable Responses, OpenGateway rechaza las llamadas a herramientas personalizadas nativas reproducidas, por lo que el ajuste preestablecido reduce las herramientas personalizadas Codex, como el modo de código `exec` para que funcionen antes de enviarlas.

Los resultados de herramientas que contienen arrays se envían como texto; las imágenes se conservan después del grupo de resultados emparejados. Las partes incompatibles, incluidos rechazos y contenido opaco, se rechazan expresamente con un error de entrada del cliente antes del envío. El nivel de detalle de imagen `original` se convierte a `high`, que la pasarela admite, sin cambiar sus bytes. La ruta nativa de Responses también comprueba las respuestas vacías de solo texto antes de mostrarlas como correctas. Agotar el presupuesto de salida produce `incomplete` con `max_output_tokens`; el proxy no aumenta el presupuesto solicitado. Una respuesta vacía que admita repetición segura y conserve presupuesto puede reintentarse una vez, dentro del límite existente de envíos. `emptyCompletionRetry: false` u `OCX_EMPTY_COMPLETION_RETRY=0` lo desactivan. El texto, los rechazos, la actividad de herramientas y los eventos de streaming desconocidos impiden repetir la solicitud y conservan la transmisión original. Esta protección no cambia otros proveedores ni sus valores de reintento. Para repetir se requiere `store: false` explícito, entrada completa y solo herramientas ejecutadas por el cliente; una herramienta alojada como `web_search` impide la repetición automática aunque no se haya observado un evento de herramienta.

**TokenLab** ([patrocinador](https://github.com/lidge-jun/opencodex/blob/main/SPONSORS.md)) es un OpenAI -compatible API puerta de enlace en [tokenlab.sh](https://tokenlab.sh/r/OPENCODEX), operado por TOKENLAB AI INC. Cree un espacio de trabajo [API clave](https://tokenlab.sh/dashboard/api?tab=keys), luego ejecute `ocx provider add tokenlab` o seleccione **TokenLab** en el selector **Añadir proveedor** del panel de control. TokenLab mantiene un paso a paso [Guía de integración OpenCodex](https://tokenlab.sh/docs/en/integrations/opencodex) ([한국어](https://tokenlab.sh/docs/ko/integrations/opencodex)) que cubre la configuración y el enrutamiento por modelo. El preajuste utiliza [Chat Completions](https://tokenlab.sh/docs/en/quickstart) y descubre modelos en `GET /v1/models?category=chat`, manteniendo solo las entradas que declaran la capacidad de `tool-use`. Los modelos de imagen, video, audio, incrustación y decisión están excluidos de este preajuste de chat.

Cada modelo utiliza el formato de solicitud TokenLab declara para ello ( `tokenlab.accepted_request_formats` en `GET /v1/models/{model}` ):

| Modelos | Codex (Responses clientes) | Clientes de chat | Claude Code (Anthropic clientes) |
| --- | --- | --- | --- |
| `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`, `grok-4.7`, `deepseek-v4.1-flash`, `deepseek-v4-pro`, `kimi-k3`, `glm-5.3` | [Responses](https://tokenlab.sh/docs/en/api-reference/responses/create-response) | Chat Completions | Chat Completions |
| `claude-*` | [Messages](https://tokenlab.sh/docs/en/api-reference/messages/create-message) | Messages | Messages |
| Cualquier otro modelo, incluyendo `gemini-3.8-flash` | Chat Completions | Chat Completions | Chat Completions |

Para mantener un modelo en Chat Completions, añádalo al `modelAdapters` del proveedor, por ejemplo `"modelAdapters": { "gpt-6.1-sol": "openai-chat" }`. El enrutamiento Claude se aplica solo mientras el proveedor apunta a `https://api.tokenlab.sh/v1`. OpenCodex no envía ningún encabezado de política de entrega, por lo que la política de entrega de su clave API decide cómo TokenLab sirve cada solicitud.

El [catálogo de modelos](https://tokenlab.sh/docs/en/api-reference/models/list-models) es público sin una clave, pero se valida una clave suministrada y los resultados de alcances a sus permisos de modelo y política de entrega. Utilice una clave válida con un espacio de trabajo financiado para la inferencia. `gpt-5.6-terra` es el valor predeterminado; elija otro modelo descubierto si su clave no lo permite. Los prefijos de proveedor y modelo permanecen separados: `tokenlab/gpt-5.6-terra` envía `gpt-5.6-terra` aguas arriba. Las referencias [términos](https://tokenlab.sh/tos) y [Política de privacidad](https://tokenlab.sh/privacy-policy) de TokenLab se aplican a las solicitudes enviadas a este servicio. El preset fija la fila cerca de la parte superior del selector Añadir proveedor y la marca como patrocinador, y nada más sobre el enrutamiento o los cambios predeterminados.

**Modelflare** es un relé compatible con OpenAI en `https://modelflare.dev/v1`. Seleccione **Modelflare** en `ocx init` o el selector **Añadir proveedor** del tablero de instrumentos, o ejecute `ocx provider add modelflare`, y déle su clave directamente o como referencia `${MODELFLARE_API_KEY}` para que la clave permanezca en su entorno. El preset utiliza Chat Completions y siembra cuatro modelos que fueron verificados con chat, streaming y llamadas de herramientas: `glm-5.3-flash` (el predeterminado), `claude-sonnet-5-5`, `gpt-6.1-sol` y `deepseek-v4-flash`. Puede agregar otros modelos Modelflare compatibles con Chat como modelos personalizados. Los modelos de imagen y vídeo utilizan puntos finales de Modelflare independientes y no funcionan con este ajuste preestablecido de Chat. Una clave Modelflare ordinaria está vinculada a un grupo de enrutamiento y puede llamar solo a los modelos de ese grupo, así que use una clave inteligente para el conjunto inicial completo o pase `--default-model` con un modelo que sirva el grupo de su clave. `deepseek-v4.1-flash` se muestra aguas arriba, pero actualmente responde 503, por lo que el preajuste lo deja fuera. La latencia ascendente varía de unos pocos segundos a aproximadamente 30 segundos, con transitorios ocasionales 503.

Las tarjetas de proveedor MiniMax y MiniMax (CN) también pueden mostrar la cuota del Plan de codificación cuando la clave configurada tiene un plan activo. El panel de control lee la ventana de 5 horas del plan y, cuando está presente, la ventana semanal; estas son observaciones de visualización y no cambian el enrutamiento del modelo.

Ollama Las tarjetas de proveedores de la nube leen la cuota de `/api/balance` primero, con `/api/usage` como alternativa para implementaciones anteriores. Un informe de reserva analizado reemplaza a un fallo anterior; de lo contrario, las respuestas 4xx duras (excepto 404/408/429) borran la última cuota válida incluso si falla otro intento, mientras que los fallos transitorios la mantienen. Un cuerpo ilegible o sobredimensionado detiene los intentos adicionales. Los créditos en dólares muestran solo la asignación incluida, excluyendo los créditos comprados, por lo que una asignación agotada deja de enviarse a Ollama Cloud solo cuando no queda ningún crédito comprado.

`MiniMax-M3.1-Flash-Preview` (contexto de 1M) aparece en ambos preajustes MiniMax. MiniMax solo sirve para claves de suscripción de Token Plan y código MiniMax por ahora, por lo que una clave de pago por uso API recibe un error por ello. Pensar siempre está en marcha: el selector de esfuerzo ofrece `low` a `max` y por defecto a `max`, y no hay forma de desactivar el pensamiento. MiniMax no ha publicado un precio por token para la vista previa; el uso se extrae de su [Cuota del Plan Token](https://platform.minimax.io/docs/guides/pricing-token-plan), por lo que OpenCodex no muestra un costo estimado para él. El punto final `/models` de MiniMax aún no enumera la vista previa, por lo que OpenCodex lo mantiene en el catálogo desde el preajuste. Una instalación cuya lista de modelos MiniMax guardada sigue siendo la predeterminada anterior la recibe en el siguiente inicio; una lista que ha editado se deja tal como está; registre la vista previa a mano con `ocx models add minimax MiniMax-M3.1-Flash-Preview --context-window 1000000`.

**OpenCode Ir** rutas `gemini-4-argon-contributor` a través de su Gemini API, incluyendo streaming y continuación de resultados de herramientas. El preajuste `opencode-go` existente mantiene su URL histórica fija: las URL personalizadas guardadas, incluida `https://opencode.ai/inference/go/v1`, se enrutan a través del punto final canónico `https://opencode.ai/zen/go/v1` y heredan los valores predeterminados de Go. Gemini luego usa el punto final del modelo nativo de Go con autenticación de clave. Un proveedor personalizado con nombre diferente mantiene su URL configurada y no recibe este pin Gemini. Go selecciona protocolos por ID de modelo exacto: GPT 6 Luna, GPT 5.6 Luna, Grok 4.6/4.7 y Muse Spark Contributor usa Responses; Claude Haiku 5.5, MiniMax M2.7/M3 y Qwen3.7 Plus/3.8 Max/3.8 Uso del flash Anthropic Messages. Legacy MiniMax M2.5 y Union Alpha también retienen Messages. Los modelos sin un cable listado retienen el chat. Los nuevos pines nativos se aplican al destino Go anclado con autenticación de clave. Los modelos Responses aún aceptan una anulación explícita de `modelAdapters`. Al leer una configuración guardada anterior, OpenCodex ignora las anulaciones obsoletas de Chat/ Responses para los modelos Gemini y Qwen recién anclados, junto con sus preferencias de herramientas alojadas solo Responses válidas anteriormente. Otros proveedores, cuentas y enrutamiento permanecen disponibles. Las lecturas dejan el archivo sin cambios; una edición de configuración explícita posterior guarda los valores actualizados. Nuevas anulaciones para estos modelos nativos siguen siendo rechazadas. Gemini utiliza `low`, `medium` y `high` niveles de pensamiento; esfuerzos más altos se fijan a `high`.

OpenCode Go requiere un identificador de sesión estable para el enrutamiento. OpenCodex envía `claude-haiku-5-5`, al igual que los modelos MiniMax, sobre el alambre Anthropic Messages, que coincide con [Tabla de puntos finales de OpenCode Go](https://opencode.ai/docs/go/#endpoints). OpenCodex deriva su encabezado de sesión Go de encabezados de hilo/sesión Codex, o de un encabezado `x-opencode-session` de un cliente cuando los encabezados Codex están ausentes. Esto se aplica a las solicitudes Chat Completions directas y las solicitudes puenteadas a Responses. Incluso un valor entrante `ocx_`-prefijo se trata como entrada del cliente y se hashed en afinidad Go; el puente interno lleva el valor original, por lo que Chat nativo, Chat puenteado y Responses obtienen el mismo resultado. Los encabezados de sesión explícitos provider-config son anulaciones del operador y se envían sin cambios. Los clientes deben mantener el identificador estable dentro de una conversación y distinto en todas las conversaciones. Una solicitud sin ningún identificador de sesión no recibe una identidad de solicitud cruzada inferida; en cambio, se envía bajo una sesión asignada solo para esa solicitud, aislada de cualquier otra solicitud (consulte la referencia del proveedor sobre cómo se transmite ese valor). Para Claude Messages, los encabezados de sesión de OpenCode Go configurados siguen siendo autorizados. De lo contrario, los encabezados de sesión o hilo explícitos válidos tienen prioridad, y la identidad de conversación válida en `metadata.user_id` proporciona la reserva. Esta reserva se aplica al destino final de Go, incluidas las selecciones aleatorias combinadas y los intentos de reserva, en lugar de la ruta preliminar. Las claves compartidas de la caché del símbolo del sistema no identifican las conversaciones y la identidad específica de Go no se envía a los objetivos que no son Go. Las configuraciones del proveedor Pi generado habilitan `compat.sendSessionAffinityHeaders` para que Pi envíe su identidad por sesión al proxy. Las configuraciones de Pi administradas manualmente existentes también pueden establecer esta opción en su proveedor `opencodex`. Pi puede omitir la afinidad de sesión cuando `cacheRetention` es `none`; habilitar la retención de caché cuando se requiere una sesión ascendente estable.

**Ecos de llamadas a herramientas de MiMo.** En OpenCode Go y otras rutas de Chat Completions, se oculta un bloque `<tool_call>` cuando duplica una llamada estructurada a la misma herramienta con la misma entrada efectiva. Esto incluye envoltorios de MiMo como `<tool_call_deadbeef>` con identificadores de cierre coincidentes, incluso cuando el eco sigue a un texto normal. Los ejemplos de código siguen visibles. Si la entrada es distinta o varias llamadas pueden explicar el bloque, el marcado se conserva. Para `mimo-v2` y los identificadores MiMo V2 con puntos, como `mimo-v2.6-pro`, si la pasarela envía exactamente una llamada vacía `{}` a una herramienta freeform declarada y coloca su entrada en un bloque independiente, sin identificador o con él, opencodex recupera la entrada en la llamada y oculta el bloque. Los identificadores con guiones, como `mimo-v2-pro` y `mimo-v2-omni`, no participan en esta recuperación. El texto normal, los ejemplos entre comillas, las funciones ordinarias y las respuestas ambiguas no cambian. También se admite el inicio incorrecto `<parameter=` de MiMo al principio de ese bloque independiente.

**OpenCode Zen** (`opencode-zen`) utiliza `https://opencode.ai/zen/v1` con una clave API de [opencode.ai/auth](https://opencode.ai/auth). El tráfico de modelo libre puede alcanzar límites de velocidad de ventana corta alrededor de 15-20 solicitudes / minuto (medido por la comunidad; OpenCode no publica RPM). Cuando un límite de velocidad 429 omite `Retry-After`, opencodex agrega guía y un sintético `Retry-After`; las cabeceras válidas ascendentes tienen prioridad. Los reintentos de la misma clave siguen siendo opt-in a través de [`retryOn429`](/es/reference/configuration/).

Gemini modelos en `opencode-zen` utilice Google nativo de API automáticamente cuando el proveedor utiliza una clave API, el valor predeterminado `googleMode` (`ai-studio`), y también `https://opencode.ai/zen/v1` o `https://opencode.ai/inference/v1`. Usar los ID de modelo listados por Zen; OpenCodex los conserva, incluidos los ID de Flash sin un `-tiered` Sufijo. Los modelos Claude en estas rutas API-clave usan Anthropic Messages automáticamente, independientemente de `googleMode`. Al cargar las configuración guardadas, OpenCodex ignora las Gemini y Claude Chat/Responses anteriores elegibles que se anulan solo para los modelos nativos en la clave canónica. `opencode-zen` proveedor en estas rutas oficiales Zen. También ignora Responses-solamente elegible `image_generation` Preferencias de herramientas alojadas; los proveedores personalizados, las rutas no clave y otras preferencias permanecen sin cambios.

**`opencode-free` ha sido eliminado** porque cada modelo ahora devuelve `403 permission_denied` bajo la puerta de nivel libre aguas arriba de OpenCode ([#7255](https://github.com/lidge-jun/opencodex/issues/7255)). Cargar una configuración existente desactiva sus entradas y referencias de modelo dependientes en la memoria, advierte una vez por proceso y deja el archivo sin cambios. Si era el proveedor predeterminado, la ruta estándar OpenAI OAuth se convierte en la predeterminada. Use `opencode-go`, con la clave `opencode-zen`, u otro proveedor. [Términos de OpenCode Zen](https://opencode.ai/docs/zen/).

Se conservan las asignaciones y los valores predeterminados saludables de Claude Desktop. Las reglas cuya lista de permisos de modelo de origen se vacía están deshabilitadas, junto con la sincronización de subagentes nativa cuando se elimina su modelo de inyección. La configuración posterior guarda las referencias eliminadas fuera del archivo mientras conserva las ediciones concurrentes saludables.

La mayoría usa el `openai-chat` adaptador con una clave portadora; Preconfiguración compatibles con Anthropic, como
**Xiaomi MiMo** (`xiaomi`) utilizar el `anthropic` adaptador (`x-api-key`) Xiaomi también tiene un chat OpenAI preajustado, `xiaomi-mimo`, y un preajuste de plano token, `mimo`. Los tres por defecto a MiMo V2.6 (`mimo-v2.6-pro`, o `mimo-v2.6-flash` on `xiaomi-mimo`) Xiaomi se retira `mimo-v2.5` y `mimo-v2.5-pro` el 2026-10-21 sin redirección, así que cambie un valor predeterminado de V2.5 guardado antes de entonces; opencodex no lo reescribe por usted. El Plan de codificación Volcengine y el Plan de agente utilizan sus puntos finales nativos Responses a través de `openai-responses`. Durante las continuaciones validadas de la herramienta Ark Coding Plan, reproducir el Responses devuelto `reasoning` elemento contestado `400 InvalidParameter`, por lo que el Plan de codificación preestablecido deja caer elementos de razonamiento reproducidos antes continuación; es decir, con pérdidas, y `dropResponsesReasoningItems: false` Lo apaga. Una instalación que ya guardó el proveedor del Plan de codificación en `openai-chat` mantiene ese cable — nada reescribe una fila almacenada — para que el cambio sea una edición deliberada: set `adapter` a `openai-responses` y
`responsesPath` a `/responses`, o eliminar y volver a agregar el preset. Por modelo explícito `openai-chat`
Las anulaciones permanecen disponibles de cualquier manera. El preajuste incorporado DeepSeek también se `deepseek-v4-flash` sobre su punto final nativo Responses y mantiene la transmisión SSE habilitada. Si ese modelo termina cada elemento de salida pero omite el último Responses evento, opencodex aplica una reparación de gracia de cinco segundos modelo-alcance; mal formado o parcial Las corrientes se cierran como incompletas en lugar de ser reportadas como exitosas. El first party `deepseek-flash` modelo anuncia nativo `text` y `image` entrada, por lo que las solicitudes de imágenes se envían directamente a DeepSeek por defecto en lugar de a través del sidecar de visión. Explícito
`noVisionModels` o las declaraciones de solo texto siguen siendo autoritativas. Primera parte `deepseek-chat`,
`deepseek-reasoner`, y `deepseek-v4-flash` Sidecar por defecto. Las rutas Zen son sin cambios y no fueron probados en esta actualización.

> **Tres rutas de facturación Volcengine:** `volcengine` es el pago por uso de Ark API, `volcengine-coding-plan` consume la cuota del Plan de codificación, y `volcengine-agent-plan` consume la cuota del Plan de agente. Utilice la clave y el punto final emitidos para el mismo producto; el punto final ordinario `/api/v3` puede incurrir en cargos de pago por uso incluso cuando existe una suscripción a Plan. Los preajustes usan catálogos de modelos estáticos seleccionados porque la respuesta `/models` de Ark también incluye recursos de incrustación, imagen, video y 3D, la puerta de enlace de codificación devuelve el mismo catálogo amplio y la puerta de enlace de plan de agente no tiene ningún recurso `/models`. Pay-as-you-go predeterminado a `doubao-seed-2-1-pro-260628`; su catálogo curado también incluye modelos de texto DeepSeek y GLM actuales. El plan de codificación se establece por defecto en `ark-code-latest`, mientras que el plan de agente se establece por defecto en `deepseek-v4-flash`.

> **Restricción de uso del plan Volcengine:** Volcengine documenta la cuota de Plan de codificación y Plan de agente como válida solo dentro de las herramientas de codificación de IA compatibles, y advierte que el uso de una clave de plan para las llamadas generales API puede suspender la suscripción o prohibir la cuenta. La ruta Codex o Claude Code a opencodex es el uso documentado; señalar otra automatización en una clave de plan no lo es. La ruta `volcengine` de pago por uso no conlleva tal restricción.

**Chutes descubrimiento.** Los `chutes` preset usa el contenido compartido fijo de Chutes OpenAI-compatible LLM Se lee el público. `/v1/models` catálogo, mantiene solo filas cuya `supported_features` anunciar
`tools`, conserva los identificadores de modelos que contienen barras y los metadatos en vivo seguros, y limita el descubrimiento a 256 KiB y 128 filas brutas. Debido a que ese catálogo es público, no puede probar que una clave suministrada sea válida; chat Las solicitudes siguen utilizando la clave Bearer configurada. Los hosts Chute personalizados desplegados por el usuario y los Chutes que no son LLM Las API siguen siendo territorio de proveedor personalizado. Crea una clave desde el [Panel de chutes](https://chutes.ai/auth/start).

**DeepInfra descubrimiento.** El proveedor basado en claves `deepinfra` OpenAI Chat Completions utiliza el adaptador `openai-chat` con una clave Bearer API. Su URL de lista de modelos propiedad del registro mantiene solo las filas etiquetadas con `chat`, conserva los identificadores de modelos nativos que contienen barras y limita el descubrimiento en vivo a 512 KiB y 512 filas sin procesar. Crear claves en [Panel de DeepInfra](https://deepinfra.com/dash/api_keys).

**descubrimiento hiperbólico.** El preajuste lee `/v1/models` con la clave de portador configurada, conserva los identificadores de modelo nativos que contienen barras y limita el descubrimiento en vivo a 256 KiB y 256 filas sin procesar. Cubre solo el chat de texto y visión-idioma sin servidor; Los puntos finales separados de imagen, audio y GPU de Hyperbolic están fuera de alcance. Crear claves en [Hiperbólico](https://app.hyperbolic.ai).

**Nscale y descubrimiento de Vultr.** Ambos preajustes leen el catálogo autenticado del proveedor `/v1/models`, preservan los identificadores nativos y limitan el descubrimiento a 256 KiB y 256 filas sin procesar. El catálogo de Nscale mezcla modelos de chat, imagen e incrustación sin un campo de modalidad, por lo que el preajuste admite solo `meta-llama/Llama-3.1-8B-Instruct`, el modelo utilizado por la herramienta oficial de Nscale que llama al ejemplo API. Vultr actualmente documenta la herramienta que llama solo por `kimi-k2-instruct`, por lo que su preajuste expone solo ese modelo. Otras filas permanecen ocultas hasta que el proveedor publica evidencia equivalente de agente-herramienta. Cree un token de servicio Nscale en el [Consola Nscale](https://console.nscale.com); copie la clave de inferencia de Vultr de la descripción general de suscripción en el [Consola Vultr](https://my.vultr.com).

**Detección de Command Code.** El preajuste lee el Command Code `/provider/v1/models` Lista del host fijo Provider API, conserva los identificadores nativos del proveedor y limita el descubrimiento a 256 KiB y 256 raw filas. `ocx login command-code` admite OAuth a través del inicio de sesión en el navegador (con credenciales locales opcionales CLI Importación de `~/.commandcode/auth.json` para los usuarios existentes de Command Code CLI); el catálogo del modelo es cuenta-scoped y viene del punto final de descubrimiento autenticado después de iniciar sesión. El proveedor-API preset (`commandcode`) envía la clave de configuración activa: la mayoría de los identificadores de modelo usan Chat Completions con un Bearer encabezado, mientras `claude-*` ids use Anthropic Messages con `x-api-key`porque el Command Code les sirve sólo en `/provider/v1/messages`. Un proveedor que reutiliza el `commandcode` nombre para un diferente punto final mantiene su propio cable. El ajuste preestablecido de OAuth (`command-code`) utiliza el portador de la cuenta almacenada para descubrimiento autenticado y generación de flujos desde `/alpha/generate` como NDJSON. MiMo tool-call markup repetido por la puerta de enlace como texto se elimina cuando duplica una llamada real. En los modelos MiMo, a Completar la llamada de herramienta declarada sin contraparte nativa se restaura solo después de un acabado limpio; Los giros interrumpidos o filtrados dejan el marcado como texto. Crear claves de proveedor-API en
[Command Code Studio](https://commandcode.ai/studio/).

Para un proveedor que utiliza el adaptador nativo `command-code`, `projectContext: "on"` opta por enviar archivos de proyecto locales en los campos `/alpha/generate`, `memory`, `taste` y `skills`. Con `projectContext` sin configurar o `"off"`, no se leen ni envían archivos de proyecto (`AGENTS.md`, gusto o habilidades); la carga útil de metadatos `config` existente no cambia. Las raíces se resuelven desde el **Directorio de trabajo del proceso proxy opencodex**, no desde el espacio de trabajo remoto de una persona que llama. El cargador lee `AGENTS.md`, `.commandcode/taste/taste.md` y `SKILL.md` archivos en directorios secundarios inmediatos de `.commandcode/skills`, `.agents/skills` y `.pi/skills` bajo ese directorio de trabajo. Al habilitar la opción, se envía el contenido recopilado aguas arriba al punto final Command Code configurado. Se rechaza para otros adaptadores. Las comprobaciones de ruta asíncrona mantienen las lecturas dentro del directorio de trabajo resuelto, incluso cuando ese directorio es una raíz del sistema de archivos; solo se lee el contenido del archivo regular. Los enlaces simbólicos de directorio de habilidad que se resuelven dentro de ese directorio están permitidos; aquellos que se resuelven fuera son rechazados. Cada entrada visitada cuenta para el presupuesto de escaneo; como máximo se seleccionan 16 habilidades. Los bytes de archivo, los bytes de habilidad total y el tiempo de carga están limitados; los archivos ilegibles o faltantes producen campos vacíos. Los resultados estables se almacenan en caché durante 30 segundos; los tiempos de espera y los rechazos de admisión al sistema de archivos no se almacenan en caché, por lo que una solicitud posterior puede volver a intentarlo.

**Autenticación y descubrimiento de OrcaRouter.** Elija `ocx login orcarouter-oauth` para la autorización del navegador con un solo clic o `ocx login orcarouter` para pegar una clave API existente. El flujo PKCE inicia primero un oyente de bucle de retorno, envía un nuevo desafío S256 y se indica a `https://www.orcarouter.ai/auth`, intercambia el código de un solo uso en `https://www.orcarouter.ai/api/v1/auth/keys` y almacena la clave de propiedad del usuario devuelta en `~/.opencodex/auth.json`. El preajuste de teclas manuales continúa utilizando el almacén de claves de proveedor normal. Ambos modos se encaminan a `https://api.orcarouter.ai/v1` y descubren el catálogo público en vivo con `capability=chat`; se excluyen las filas de medios/reordenados que no son de chat, y las modalidades de entrada informadas controlan si Codex ofrece adjuntos de imagen. Debido a que el catálogo en sí es público, la configuración manual de la clave informa que la validación es desconocida en lugar de aceptar esa respuesta como prueba de que la clave funciona.

Durante el inicio de sesión del navegador OrcaRouter (`ocx login orcarouter-oauth`), un cuerpo de respuesta de intercambio de claves exitoso debe ser válido UTF-8 JSON no más grande de 64 KiB. El presupuesto de 30 segundos de la solicitud cubre tanto los encabezados de respuesta como el cuerpo completo; los cuerpos sobredimensionados o malformados son rechazados antes de guardar la clave. Estos límites se aplican solo al intercambio de claves de inicio de sesión, no a las cargas útiles de solicitud de inferencia. La validación del alcance no cambia: se permite un `scope` omitido, mientras que se rechaza un `scope` explícitamente inválido.

Para una implementación autoalojada de un origen, establezca el origen compartido antes del primer inicio de sesión de PKCE; la URL de inferencia guardada se deriva del mismo origen:

```bash
ORCAROUTER_BASE_URL=https://router.example ocx login orcarouter-oauth
```

Para una implementación auto-alojada dividida, establezca `ORCAROUTER_API_BASE_URL` y `ORCAROUTER_AUTH_BASE_URL` por separado.

El valor debe ser un origen HTTPS (o loopback HTTP para el desarrollo local) sin credenciales, consulta o fragmento. Antes del primer inicio de sesión en un punto final autoalojado privado/loopback, permita explícitamente ese destino en la fila de proveedores `~/.opencodex/config.json`. Por ejemplo, fusione esta entrada en el objeto `providers` existente para un servidor de desarrollo local:

```json
{
  "orcarouter-oauth": {
    "adapter": "openai-chat",
    "baseUrl": "http://127.0.0.1:9999/v1",
    "authMode": "oauth",
    "allowPrivateNetwork": true
  }
}
```

Luego ejecuta `ORCAROUTER_BASE_URL=http://127.0.0.1:9999 ocx login orcarouter-oauth`. El inicio de sesión conserva este consentimiento explícito; establecer la URL por sí sola nunca permite el acceso a la red privada. Sin la aceptación, la validación de destino rechaza la inferencia y el descubrimiento de modelo para ese punto final. Este requisito se refiere al punto final del proveedor; el oyente de devolución de llamada del navegador no necesita dicha aceptación. Volver a ejecutar el inicio de sesión después de un relé `401`; Las llaves OrcaRouter son duraderas y no tienen una subvención de actualización de token.

**Meta Modelo API (`meta-model`).** Muse Spark en el propio punto final compatible con OpenAI de Meta, servido por más de `/v1/responses`. Crear una clave en [la consola de desarrolladores de Meta](https://dev.meta.ai/docs/authentication) - Meta llama a esta variable `MODEL_API_KEY`, pero opencodex deriva la var env del ID del proveedor, por lo que exportarlo como **`META_MODEL_API_KEY`** (o pegarlo durante `ocx init`). La cuenta necesita un método de pago antes de atender las solicitudes, y cada llamada se mide por token. Tres modelos están sembrados, cada uno con una ventana de contexto de 1M: `meta-model/muse-spark-1.3` y `meta-model/muse-spark-1.3-contributor` con `minimal` / `low` / `medium` / `high` / `xhigh` escalera, y `meta-model/muse-wonder-1.0` (Muse Wonder, vista previa) con `minimal` a través `max`. Muse Wonder es el modo estándar solo en el Modelo API: no tiene nivel de colaborador y cuesta $ 4 por entrada de 1 millón y $ 20 por tokens de salida de 1 millón. Muse Wonder Full solo está disponible dentro de las suscripciones Muse Code, por lo que no se siembra. Discovery se queda fuera hasta que se verifica una lista autenticada, porque Meta sirve modelos de imagen y voz en el mismo host.

Dos cosas que vale la pena saber antes de elegirlo. **Una suscripción Muse Code no se aplica aquí:** Meta alcances que acreditan al Muse Code CLI y factura cualquier otra clave de pago por uso. Y el nivel Contributor es barato porque Meta entrena en sus mensajes: aproximadamente 92% de descuento en la entrada, 96% de descuento en la salida y 99% de descuento en la entrada en caché, así que mantenga el material confidencial fuera de él. Muse Spark también es accesible a través de revendedores, con una lista más estrecha: `command-code` lleva ambos niveles, mientras que `opencode-go` sirve solo `muse-spark-1.3-contributor`.

**Código Meta Muse (`meta-muse`).** Un inicio de sesión macOS simple ya prueba la clave API Almacenado por `muse login`. Sin credenciales locales, o en otra plataforma, se inicia el flujo de aprobación del dispositivo del navegador. Agregar cuenta y reautenticación omite la importación local para evitar Reutilizar la cuenta que se está reemplazando. OpenCodex nunca lanza el Muse CLI. Si el dispositivo inicia sesión falla sin cancelación, una superficie de entrada manual disponible puede aceptar una clave pegada; que la clave se enfrenta al mismo formato y validación del modelo API como una clave importada. En macOS, Aprobar el aviso de llavero en el host proxy en 120 segundos. Denegaciones de importación mostrar la razón de falla y ofrecer un campo de pegado de clave existente sin iniciar otro inicio de sesión. Agregar cuenta en un proveedor ya configurado omite la importación local. Véase
[Soporte de plataforma](/es/reference/platform-support/) para la imagen completa por plataforma.

Para iniciar cualquier inicio de sesión de Meta Muse a través de la administración, API requiere una sesión de panel. incluyendo add-account y reautenticación. Un encabezado token de administración en bruto o GUI falsificado recibe
`403 oauth_consent_required` antes de que se lea una credencial o comience una subvención. Esta puerta utiliza el principal de sesión resuelto por el servidor, no un recibo de casilla de advertencia registrado por separado. Direct `ocx login meta-muse` y otros proveedores de OAuth mantienen sus políticas de inicio de sesión existentes. Por lo tanto, la lista de proveedores de administración OAuth omite Meta Muse para los paneles raw-admin-token; abra un panel de control autenticado por sesión para usar ese flujo de inicio de sesión. Esto sólo cambia el descubrimiento, no las verificaciones de admisión en el inicio de sesión o la continuación manual.

Los tres sembrados `meta-muse` modelos (Muse Spark 1.3, su nivel de colaborador y Muse Wonder) exponer `minimal`/`low`/`medium`/`high`/`xhigh`/`max` a clientes enrutados, incluido el selector de esfuerzo de Grok. Solicitudes de uso
`User-Agent: muse-build/1.3.0 (opencodex compatibility)` Así que Meta acepta el código Muse Contrato de esfuerzo. Un proveedor explícito User-Agent anula este valor predeterminado y puede causar
`max` ser rechazado. En marcha `meta-model` Solo Muse Wonder acepta `max`sus filas de chispa y OpenCode Ir a mantener el `xhigh` techo. Publicidad `max` es el contrato del modelo y no prueba tu plan de código Muse cubre Muse Wonder.

**Lee esto antes de habilitarlo.** Meta scopes esa credencial a la Muse Code CLI, por lo que su uso aquí es una ruta *sin soporte*. Meta no autoriza la cobertura de suscripción fuera de su propio cliente, cómo se liquidan estas llamadas no es observable desde el API, y debe tratar cada llamada como facturable en su cuenta. La clave, importada o pegada, se copia en el almacén de autenticación de OpenCodex (`~/.opencodex/auth.json`, modo 0600) como cualquier otra credencial OAuth. El panel de control muestra una advertencia de Términos de servicio antes del primer inicio de sesión y antes de cualquier reautenticación: el mismo tratamiento que obtienen Anthropic y Google Antigravity.

Meta informa el uso de la ventana de suscripción dentro de las respuestas de transmisión, y OpenCodex lo lee desde allí. La fila de la cuenta muestra las últimas ventanas semanales y de 5 horas observadas con la antigedad de esa lectura: Meta no publica ningún punto final para consultarlas a pedido, por lo que un valor solo se actualiza con otro turno de transmisión a través de este proveedor, y un turno que pasa por la traducción de solicitudes en lugar de passthrough informa ninguno. Una cuenta que aún no ha servido un turno de transmisión simplemente no muestra cuota, lo cual no es un error. Se aplican límites de solicitudes por equipo, no por clave.

Para una configuración compatible, use `meta-model` anterior con su propia clave.

**Cuota Command Code.** El tablero de instrumentos y la sonda `ocx account refresh` Command Code `/alpha/billing/credits` ventanas (5 horas y semanales) en el canónico `https://api.commandcode.ai` host. El preajuste OAuth (`command-code`) utiliza el portador de cuenta almacenado; el preajuste de tecla Proveedor-API (`commandcode`) utiliza la tecla configurada activa. Una URL de base similar editada por el usuario nunca se sondea. Los créditos mensuales restantes, comprados y gratuitos se muestran como una ventana de USD cuando Command Code también informa sobre el período de gasto.

**SambaNova Cloud descubrimiento.** El preajuste lee la lista pública `/v1/models` de SambaNova Cloud desdel host API fijo, conserva los identificadores nativos del proveedor y limita el descubrimiento a 128 KiB y 128 filas sin procesar. Debido a que el catálogo no está autenticado, el flujo de inicio de sesión CLI informa que la clave no es verificable en lugar de tratar la respuesta pública como prueba. Las solicitudes de chat siguen utilizando la clave Bearer configurada y desactivan las llamadas a funciones paralelas, que SambaNova aún no admite. Los puntos finales de implementación privados de SambaStudio están fuera del alcance. Crear claves en [Nube SambaNova](https://cloud.sambanova.ai/apis).

**Descubrimiento de la fábrica de tokens Nebius.** El preajuste solicita el catálogo de modelos detallado autenticado y mantiene solo filas cuya arquitectura produce texto, excluyendo modelos de incrustación y generación de imágenes. Conserva los identificadores nativos que contienen barras, además de los metadatos de contexto y de modalidad de entrada informados, y limita el descubrimiento a 512 KiB y 512 filas sin procesar. Los hosts de implementación dedicados están fuera del alcance. Crear claves en [Fábrica de tokens Nebius](https://tokenfactory.nebius.com).

**Crusoe descubrimiento.** El preajuste basado en claves utiliza el adaptador `openai-chat` y envía su clave de portador solo al host de inferencia sin servidor fijo de Crusoe. `/v1/models` rechaza solicitudes no autenticadas con 401, por lo que una respuesta de lista exitosa cuenta como validación de clave. Discovery conserva los identificadores nativos delimitados por barras, como `zai-org/GLM-5.3` y `moonshotai/Kimi-K2.6`, exactamente como Crusoe los devuelve y tiene un límite de 256 KiB y 256 filas sin procesar. Las filas se mantienen solo cuando informan `is_public: true` y un texto o un multimodal `architecture.modality`, que excluye las implementaciones privadas de cuenta y cualquier incorporación o filas de medios. Los modelos de razonamiento devuelven su pensamiento en el campo Chat Completions `reasoning`, que lee el adaptador. Solo `openai/gpt-oss-120b` acepta una escalera `reasoning_effort` (`low`, `medium`, `high`); los otros modelos de razonamiento tratan el campo como una palanca de encendido / apagado, por lo que el preajuste declara que no hay escalera de esfuerzo en todo el proveedor y no hay llamadas de herramienta paralelas en todo el proveedor. Se aplican límites de solicitudes por proyecto y por modelo (429 cuando se excede, 503 cuando se escala una implementación compartida), y las nuevas cuentas comienzan con $ 5 de créditos gratuitos. Crea una clave en el [Consola de Crusoe Cloud](https://console.crusoecloud.com) bajo Fundición de Inteligencia, Inferencia.

**DigitalOcean descubrimiento.** El preajuste utiliza una clave de acceso de modelo contra el host de Inferencia sin servidor compartido fijo e interseca la respuesta autenticada `/v1/models` con la lista de permisos Chat Completions respaldada por documentos de DigitalOcean. Unknown, Responses -sólo, incrustación, y los identificadores de generación de medios fallan. Discovery tiene un límite de 256 KiB y 256 filas sin procesar; los hosts dedicados y específicos del agente están fuera de alcance. Cree una clave en el [Panel de Control de Seguridad](https://cloud.digitalocean.com/model-studio/manage-keys).

**Scaleway descubrimiento.** El ajuste preestablecido cruza la lista de modelos autenticados con la lista de permisos de Scaleway Chat Completions sin servidor documentada. Desconocido, solo Responses, la incrustación, la transcripción y otros identificadores de modelos de medios fallan; el descubrimiento está limitado a 128 KiB y 128 filas en bruto. Utiliza el punto final compartido del proyecto predeterminado; las URL calificadas para el proyecto y las implementaciones dedicadas requieren un proveedor personalizado. Cree una clave API en el [Consola Scaleway](https://console.scaleway.com/generative-api).

**Descubrimiento de Featherless.** El preajuste consulta el host fijo compatible con OpenAI y pide solo los primeros 100 modelos populares filtrados por el servicio para chat y el plan actual. Las reglas del registro rechazan cada fila salvo que declare disponibilidad en el plan, ausencia de restricciones de acceso de Hugging Face y `features.tool_use: true`. El descubrimiento se limita a 128 KiB y 100 filas originales; nunca se descarga ni almacena completo el catálogo de decenas de miles de modelos. Como `/v1/models` admite consultas con o sin autenticación, esa respuesta no demuestra que la clave proporcionada sea válida; las solicitudes de chat sí usan la clave Bearer configurada. Featherless reserva sus planes individuales para uso interactivo y prototipos; las aplicaciones generales necesitan un plan Scale. Crea una clave en el [panel de Featherless](https://featherless.ai/account/api-keys).

**Novita descubrimiento.** El preajuste basado en claves utiliza el adaptador `openai-chat` y envía su clave de portador solo al host compatible OpenAI de Novita. Su lista de modelos públicos se filtra a filas que informan tanto `model_type: chat` como el punto final `chat/completions`, con el descubrimiento limitado a 512 KiB y 256 filas sin procesar. Los identificadores de modelo deben conservarse exactamente como Novita los devuelve, incluidos los identificadores delimitados por barra diagonal, y no deben normalizarse ni reescribirse antes del enrutamiento. Debido a que el catálogo es público, el inicio de sesión informa la clave como no verificable en lugar de tratar una respuesta de lista exitosa como prueba. Las capacidades del modelo varían, por lo que el ajuste preestablecido no anuncia llamadas de herramientas paralelas a todo el proveedor o OpenAI `reasoning_effort`. Crear una clave en [Gerente clave de Novita](https://novita.ai/settings/key-management).

> **Alcance Baseten:** El preajuste cubre solo el [API de modelo](https://docs.baseten.co/inference/model-apis/overview) compartido de Baseten. Use un [API clave](https://docs.baseten.co/organization/api-keys) personal para uso local o una clave de equipo con acceso **API de modelo de llamada** para uso compartido/de producción. Los endpoints dedicados de Truss `predict` usan diferentes hosts y esquemas y no son enrutados por este preajuste. El descubrimiento en vivo para este preajuste se limita a una respuesta de 1 MiB y 256 filas de modelos sin procesar.

<a id="official-codebuddy-code-cli-global--cn"></a>

<a id="workbuddy-ai-subscription"></a>

### Suscripción WorkBuddy AI

`workbuddy-ai` conecta tu suscripción internacional de WorkBuddy AI como proveedor de modelos. Elige **WorkBuddy AI** en Proveedores e inicia sesión, o ejecuta:

```bash
ocx login workbuddy-ai
```

Completa el inicio de sesión en el navegador. OpenCodex consulta la autorización durante un máximo de cinco minutos, guarda los tokens y los renueva cuando hace falta. Puedes añadir cuentas mediante la lista OAuth existente; la identidad del equipo permanece asociada a su propio token. No necesitas instalar WorkBuddy Desktop ni importar archivos de credenciales.

Los modelos y capacidades proceden del catálogo de productos de tu cuenta. Después de iniciar sesión, elige un modelo `workbuddy-ai/<model-id>`; si el descubrimiento no está disponible, se ofrece `workbuddy-ai/default-model` como selector de respaldo. El streaming, las herramientas y las respuestas almacenadas usan el endpoint Chat de WorkBuddy. Las pestañas Resumen y Cuentas muestran créditos restantes, usados y totales, saldos base y de regalo y los próximos créditos no diarios que caducan, cuando esa información está disponible. Actualizar consulta el resumen de facturación de la cuenta; una lectura fallida no significa saldo cero. Los créditos son informativos: agotarlos no desactiva los modelos gratuitos.

Se utiliza un protocolo de suscripción no oficial basado en el [plugin WorkBuddy de Magpie](https://github.com/magpie-community/plugins/tree/e7f65641df820dfd715c0d2241f99f2092e4efb1/packages/workbuddy). Las restricciones del canal del cliente o de la cuenta se devuelven al solicitante. OpenCodex no reescribe instrucciones de identidad del agente para evitarlas. La disponibilidad depende de tu cuenta, región, permisos de modelo y la API vigente de WorkBuddy. Es independiente de los proveedores CodeBuddy CLI con clave API y no conecta el cliente WorkBuddy Desktop a OpenCodex.

### CodeBuddy Code CLI oficial (Global y CN)

OpenCodex proporciona soporte oficial para adaptadores para el código CodeBuddy Code CLI de Tencent Cloud a través de los presets `codebuddy` (Global) y `codebuddy-cn` (China).

```json
{
  "providers": {
    "codebuddy": {
      "adapter": "codebuddy",
      "baseUrl": "https://www.codebuddy.ai",
      "apiKey": "${CODEBUDDY_API_KEY}"
    },
    "codebuddy-cn": {
      "adapter": "codebuddy",
      "baseUrl": "https://www.codebuddy.cn",
      "apiKey": "${CODEBUDDY_CN_API_KEY}"
    }
  }
}
```

- **Prerrequisitos:** Instale el CodeBuddy CLI oficial a nivel mundial:
  ```bash
  npm install -g @tencent-ai/codebuddy-code
  ```
- **Autenticación:** Obtenga su clave oficial API desde la consola del proveedor:
  - Global: [Llaves CodeBuddy Global API](https://www.codebuddy.ai/profile/keys)
  - CN: [Llaves CodeBuddy CN API](https://copilot.tencent.com/profile/keys)
- **Aislamiento de la región:** `codebuddy` y `codebuddy-cn` utilizan puntos finales canónicos separados (`https://www.codebuddy.ai` y `https://www.codebuddy.cn`) y entornos infantiles aislados (`CODEBUDDY_INTERNET_ENVIRONMENT=public` vs `internal`). Las credenciales son estrictamente regionales y nunca se intercambian entre entornos. La anulación de la URL base canónica falla cerrada.
- **Modelo Discovery:** el proxy solicita la configuración del producto CodeBuddy (`GET {baseUrl}/v3/config`) con la clave configurada como el encabezado `X-API-Key`, y la lista en esa respuesta es la lista autorizada de modelos descubiertos: es la configuración de la cuenta propia de la clave, por lo que se demuestra que pertenece a la clave: una clave diferente o incorrecta responde al sobre anónimo sin lista en lugar de los modelos de otra cuenta. La lista autenticada es la misma lista de las impresiones CLI para `--model` (la línea "Actualmente compatible" de un inicio de sesión CLI), puede diferir del manifiesto estático incluido con el CLI, y los selectores predeterminados del proveedor (`default` para CN, `default-model` para Global) nunca aparecen en él, pero permanecen llamables: el catálogo los retiene durante el descubrimiento en vivo y en cada ruta alternativa. Al iniciar/sincronizar, el proxy vincula la lista almacenada en caché a una huella digital irreversible de la clave configurada, por lo que un conmutador de clave nunca observa una lista almacenada en caché para la clave anterior, y se degrada a la caché obsoleta de proveedor/huella digital, luego a la semilla estática en `src/providers/codebuddy-models.ts`, cuando la clave no se autentica o la solicitud falla. Los registros de fallos de detección contienen solo una categoría y un estado HTTP, sin el mensaje de la puerta de enlace o una excepción de transporte sin procesar. La solicitud de descubrimiento con credenciales no sigue a las redirecciones; una respuesta 3xx degrada la lista sin reenviar la clave a otro origen.
- **Propiedad de la herramienta y el puente de herramientas:** El CLI siempre se genera con `--tools ""` y `--strict-mcp-config`, por lo que no tiene herramientas incorporadas o configuradas por el usuario. Cuando una solicitud lleva un catálogo de herramientas Codex, el proveedor arma un puente MCP de captura solamente: el catálogo validado y la configuración MCP se escriben en un dir temp privado, el CLI se lanza con `--mcp-config` y una lista `--allowedTools` exacta, y el marco `system/init` debe informar exactamente ese servidor de puente como conectado o el giro falla cerrado. El puente anuncia las herramientas Codex y captura las llamadas propuestas, pero nunca ejecuta nada: un lote de llamadas a herramientas completado se devuelve como `function_call` elementos (nombres asignados a los nombres de cable de la solicitud, como máximo 16 llamadas por mensaje de asistente), el árbol de procesos se termina en `message_stop`, y el cliente externo Codex solo realiza aprobación, sandboxing y ejecución. Los bloques de uso de herramientas paralelos se almacenan en memoria intermedia y se devuelven como llamadas completas incluso cuando sus fragmentos se entrelazan o CodeBuddy reutiliza un índice de bloque de contenido. Un bloque que se deja abierto en el extremo de giro, un reemplazo del mismo índice antes de completar JSON argumentos, o un fragmento de argumento que no se puede atribuir a un bloque abierto falla el giro en lugar de reenviar una llamada parcial o vacía. Los resultados de la herramienta vuelven como entrada de la siguiente solicitud, y la conversación continúa. Las solicitudes sin herramientas mantienen la forma de texto y razonamiento sin formato. Si el CLI escribe una línea de control DSML `calls` no citada seguida de una línea de control `functions.*` invocada en texto o razonamiento, el OpenCodex rechaza el turno en lugar de reenviar el andamio o interpretarlo como una llamada ejecutable. DSML discutido o citado en prosa, código en línea, código cercado o ejemplos de fuente sigue siendo texto de respuesta ordinario.
- **Aplicación de elección de herramienta:** Cuando una solicitud especifica `tool_choice: "required"` o selecciona una herramienta con nombre específico, el puente espera una llamada de herramienta del modelo. Si el CLI completa el turno con texto sin formato en lugar de capturar una llamada de herramienta, el OpenCodex falla al cerrarse con un error 502 `tool_call_required` en lugar de devolver una finalización de texto no válida.
- **Estado de gobierno:** Si el enrutamiento de esta superficie de automatización del proveedor detrás de un proxy para un agente de terceros satisface los términos de uso aceptable de CodeBuddy es una pregunta abierta marcada para la revisión de seguridad del mantenedor (consulte la nota de gobierno en la entrada del registro del proveedor). Trate a este proveedor como pendiente de esa revisión, y tenga en cuenta el límite de propiedad del puente de herramientas: el CLI anidado anuncia herramientas pero nunca las ejecuta, y la aprobación, el sandboxing y la ejecución permanecen con el cliente externo Codex.
- **Derechos y facturación:** El proveedor utiliza la misma cuenta CodeBuddy/superficie de autenticación CLI documentada por el proveedor. La disponibilidad y la facturación de los créditos gratuitos, promocionales, de prueba o de suscripción siguen estando determinadas por el derecho de cuenta de CodeBuddy del usuario.

<a id="official-qoder-cli-global--cn"></a>

### Oficial Qoder CLI (Global y CN)

OpenCodex proporciona soporte de adaptador oficial para Qoder a través de los preajustes `qoder` (Global) y `qoder-cn` (China). Ambos usan un Token de Acceso Personal suministrado por el usuario y el CLI sin cabeza del proveedor; OpenCodex nunca lee sesiones de escritorio de Qoder, cookies de navegador, tokens de actualización o API de consolas privadas.

```json
{
  "providers": {
    "qoder": {
      "adapter": "qoder",
      "baseUrl": "https://qoder.com",
      "apiKey": "${QODER_PERSONAL_ACCESS_TOKEN}"
    },
    "qoder-cn": {
      "adapter": "qoder",
      "baseUrl": "https://qoder.cn",
      "apiKey": "${QODERCN_PERSONAL_ACCESS_TOKEN}"
    }
  }
}
```

- **Prerrequisitos:** Instale el CLI oficial para la región que utiliza:
  ```bash
  npm install -g @qoder-ai/qodercli        # Global: qoder / qodercli
  npm install -g @qodercn-ai/qoderclicn    # CN: qodercn / qoderclicn
  ```
- **Autenticación:** Cree una PAT en la página de integraciones de cuenta ([Mundial](https://qoder.com/account/integrations), [NC](https://qoder.cn/account/integrations)) y péguela como clave API del proveedor. La clave almacenada alcanza el CLI solo como `QODER_PERSONAL_ACCESS_TOKEN` (Global) o `QODERCN_PERSONAL_ACCESS_TOKEN` (CN) en un entorno secundario con alcance.
- **Aislamiento de la región:** Cada preajuste acepta solo su destino canónico (`https://qoder.com` o `https://qoder.cn`) y resuelve su propio ejecutable. Las credenciales, el caché del modelo, el uso y la salud son independientes; ninguna región vuelve a la otra. Un proveedor personalizado más antiguo llamado `qoder` con un destino diferente mantiene su adaptador y URL existentes.
- **Ejecutables de Windows:** Cada preset usa el ejecutable nativo de su CLI cuando está en PATH: `qoder.exe` o `qodercli.exe` para Global; `qodercn.exe` o `qoderclicn.exe` para CN. Dentro de una misma carpeta, `.exe` tiene prioridad sobre `.cmd` con el mismo nombre. Un nombre alternativo posterior, como `qoderclicn.exe`, encontrado en cualquier carpeta de PATH tiene prioridad sobre `qodercn.cmd`; sin embargo, una carpeta anterior que solo contenga `qodercn.cmd` oculta `qodercn.exe` del mismo nombre base en una carpeta posterior. Qoder recibe valores vacíos para `--tools` y `--setting-sources`, para excluir sus herramientas y ajustes locales. Un lanzador que pasa por PowerShell descarta esos argumentos vacíos. Si es el único disponible, se rechaza el turno antes de iniciar la CLI con `cli_dispatcher_drops_empty_args`. Añade a PATH la carpeta del ejecutable nativo —el instalador CN oficial usa `%USERPROFILE%\.qoder-cn\bin\qoderclicn`— y reintenta. Un lanzador que pasa los argumentos directamente, como una shim de npm, sigue funcionando.
- **Modelo Discovery:** `qoder --list-models` es la lista autorizada de derechos para el PAT actual. La caché está vinculada a una huella digital irreversible del token, por lo que cambiar de cuenta nunca reutiliza la lista de otra cuenta. Si el descubrimiento falla, el proveedor se degrada a una caché obsoleta y luego a la semilla estática documentada.
- **Uso del token:** Qoder CLI reporta cero recuentos de tokens a menos que su interruptor de uso esté activado, por lo que cada preajuste lo enciende en su entorno hijo de alcance CLI: `QODER_EXPOSE_TOKEN_USAGE=true` para Global y `QODERCN_EXPOSE_TOKEN_USAGE=true` para CN, que lee solo su propio prefijo.
- **Propiedad de la herramienta:** El CLI ejecuta un solo giro `stream-json` con `--tools ""`, `--strict-mcp-config`, deshabilitando las fuentes y la persistencia de la sesión, por lo que Codex mantiene la propiedad exclusiva de la herramienta. Las herramientas declaradas por el cliente se exponen a través de un servidor MCP aislado.
- **Entrada de imagen:** Qoder Global acepta la entrada de imágenes a través del Qoder CLI. OpenCodex reenvía las entradas de imagen compatibles que llegan al adaptador Global a la CLI sin mantener una lista de permisos de capacidad de visión por modelo allí. La compatibilidad de imágenes y cualquier preprocesamiento o enrutamiento específico del modelo son manejados por Qoder. OpenCodex no utiliza la lista de reserva de descubrimiento estático para clasificar la capacidad de visión por modelo. Qoder CN mantiene su clasificación de sidecar existente, y cualquier solicitud de imagen bruta residual que llegue al adaptador CN se rechaza como `unsupported_input_modality`. OpenCodex serializa el historial antes del turno actual, pero Qoder no persiste las sesiones, por lo que las imágenes anteriores se reproducen en turnos posteriores. En las conversaciones de imágenes observadas de varios giros, las imágenes reproducidas pueden asociarse de manera poco confiable u ordenarse efectivamente en relación con el texto histórico que acompañaron originalmente.
- **Recuperación de PAT:** Para ambos ajustes preestablecidos de Qoder, un grupo de claves de múltiples claves API puede cambiar a otra PAT en un rechazo de autenticación compatible o agotamiento de cuota a nivel de cuenta, pero solo antes del contenido de respuesta o un evento que hace que la reproducción sea insegura. La recuperación requiere una clasificación específica de Qoder y respeta los presupuestos de credenciales y envío; un mensaje de cuota o de HTTP 401/429 por sí solo no es permiso para reproducir. Las configuraciones de una sola tecla no giran. Compartir el corredor CLI no habilita esta recuperación de clave API para CodeBuddy o Claude CLI autoautenticado.
- **Contingente:** No se utiliza la cuota pública API, por lo que los totales y los tiempos de reinicio no están disponibles. Los códigos 110 (límite diario de cuenta) y 118 (agotamiento de créditos personales) informan `insufficient_quota` y permiten la consideración de la recuperación de PAT. Otros códigos de cuota soportados también reportan `insufficient_quota` pero no lo autorizan. Los códigos de error numéricos tienen prioridad: un código numérico no reconocido no vuelve a la cuota o al texto de autenticación. Sin un código numérico, solo el mensaje diario de la cuenta compatible que comienza con "Ha alcanzado su límite de uso diario para Chat", sin equipo/modelo/calificador compartido, otorga recuperación de cuota; el texto genérico de límite de crédito no lo hace. Solo los fallos de cuota elegibles para la recuperación de PAT ingresan al manejo de enfriamiento de claves. Cuando un fallo de este tipo no tiene tiempo de reinicio, la clave fallida utiliza el tiempo de reutilización predeterminado existente; las clasificaciones de cuotas no recuperables no crean un tiempo de reutilización a través de esta ruta, y no se infiere ningún reinicio del día siguiente.
- **Operadores:** Qoder Global es operado por BRIGHT ZENITH PRIVATE LIMITED bajo el [términos de servicio del producto](https://qoder.com/product-service); Qoder CN by?(?)? con Alibaba Cloud. Verifique `ocx provider test qoder` (o `qoder-cn` ) después de configurar.

<a id="claude-code-cli-subscription"></a>

### Claude Code CLI (suscripción)

OpenCodex puede gastar una suscripción de Claude a través del propio arnés de Anthropic en lugar de reproducir una identidad de Claude Code contra el Messages API. El preajuste `claude-cli` ejecuta el oficial Claude Code CLI sin cabeza (`claude -p`, `stream-json`) una vez por turno:

```json
{
  "providers": {
    "claude-cli": {
      "adapter": "claude-cli",
      "baseUrl": "https://api.anthropic.com"
    }
  }
}
```

- **Prerrequisitos:** `npm install -g @anthropic-ai/claude-code`, luego inicie sesión una vez con `claude` (o `claude setup-token` ). El CLI usa el propio inicio de sesión Claude Code de la máquina (la entrada macOS Keychain, o `~/.claude/.credentials.json` en otros lugares).
- **Ninguna credencial almacenada:** esta fila no tiene clave API, y OpenCodex nunca lee, copia o reenvía un token Claude. El CLI posee el inicio de sesión y factura la cuenta en sí. Un CLI que no está conectado falla el turno con un error de inicio de sesión que nombra el comando, en lugar de un `401` genérico. La clasificación sigue el mismo hecho: el preajuste es una fila de teclas sin llave (`keyOptional`), por lo que no necesita ninguna tecla API y no se ofrece ningún campo de clave para ello. Una tecla API guardada en esta fila por otros medios nunca se entrega al arnés - la facturación de la tecla pertenece al preajuste `anthropic-apikey`.
- **En el panel de control:** el selector de proveedor de Añadir enumera este preajuste bajo **Pagado**, con las filas API, y lo marca con una insignia **Suscripción CLI** en lugar de **Libre** - sin llave aquí significa que el CLI posee la cuenta, no que el tráfico es libre. Seleccionarlo muestra una advertencia en lugar del campo de clave: esta no es una ruta de acceso de clave API, activa el inicio de sesión CLI (`claude -p`) y las facturas de esa suscripción, y nunca se usa una clave ingresada. El espacio de trabajo de los proveedores cuenta y lo filtra como pagado y muestra **Suscripción CLI** como su modo de autenticación. Cualquier proveedor con `"adapter": "claude-cli"` es tratado de la misma manera, incluyendo una fila renombrada o escrita a mano: el panel de control lo enumera como listo sin una clave y nunca solicita una.
- **Un inicio de sesión sirve a todo el proxy:** el arnés lee el inicio de sesión Claude Code del usuario OpenCodex se ejecuta como, por lo que cada solicitud enrutada a través de esta fila, desde cualquier cliente del proxy, gasta esa cuenta Claude. No hay una cuenta por cliente, ni agrupación ni multiplexación; dar a varias personas su propio uso Claude necesita un usuario proxy por inicio de sesión.
- **Medios de entrada:** la fila publica sus modelos como texto-sólo para v1. El CLI acepta un marco de imagen en su entrada de flujo json, pero no se ha mostrado ningún giro sin cabeza para entregar esos bytes al modelo, por lo que se rechaza una imagen enviada directamente a este proveedor (`unsupported_input_modality`) en lugar de caerse silenciosamente y responder ciegamente. Con el sidecar de visión en la ruta de la solicitud, las imágenes se subtitulan en texto antes de llegar a la fila.
- **Aislamiento:** cada turno se ejecuta en un entorno hijo con alcance sin variable heredada `ANTHROPIC_*` (un `claude` ya apuntado a este proxy por lo tanto no puede volver a él), telemetría, retroalimentación y el auto-actualizador desactivado, y `--tools ""`, `--strict-mcp-config` más `--setting-sources ""`. El arnés no carga ningún servidor CLAUDE.md, skill, hook, plugin o MCP desde la máquina y no puede leer, escribir, ejecutar ni navegar. No se mantiene ninguna sesión entre turnos. El oficial CLI se encuentra en `PATH`, o en la ubicación de instalación nativa (`~/.local/bin/claude`) cuando un servicio inicia OpenCodex con un `PATH` más antiguo.
- **Indicación del sistema:** el sistema de la persona que llama y las indicaciones del desarrollador reemplazan el preajuste Claude Code (`--system-prompt-file`), por lo que el turno responde al contrato del cliente en lugar del personaje del arnés. El indicador plegado se organiza en un archivo privado por turno (modo `0600`) y se pasa por ruta, porque los argumentos de proceso son legibles en todo el mundo a través de la lista de procesos; una solicitud que no lleva ni un sistema ni un indicador de desarrollador obtiene solo las instrucciones de repetición de conversación fijas.
- **Almacenamiento en caché de conversación:** cada mensaje se reproduce como un bloque de texto estable separado, con el mensaje actual formateado de manera idéntica a su representación histórica posterior. La larga historia se corta solo en los puntos de control de mensajes completos. Los catálogos de herramientas se serializan de manera determinista. Claude Code controla los puntos de interrupción de caché, por lo que esto hace posible la reutilización de caché rápida sin garantizarlo.
- **Propiedad de la herramienta:** cuando la solicitud lleva herramientas, un catálogo aislado de solo captura MCP expone solo las herramientas seleccionadas del cliente (el mismo puente que CodeBuddy usa). El CLI captura la llamada y el turn termina allí; aprobación, sandboxing, ejecución y el resultado devuelto se queda con Codex, Pi, u otro cliente. Las herramientas integradas y todos los demás servidores MCP permanecen desactivados.
- **Límites de suscripción:** antes de cada lanzamiento OpenCodex pide el punto final de uso de Anthropic, con el propio inicio de sesión del CLI leído en la memoria, si la ventana de 5 horas, semanal o específica del modelo del plan está llena. Un plan agotado es rechazado localmente con HTTP 429 `claude_subscription_cooldown` y un `Retry-After` para el reinicio, en lugar de comenzar un CLI que fallaría. La respuesta se almacena en caché durante un minuto en `claude-usage-admission.json` bajo el OpenCodex home (solo porcentajes, tiempos de reinicio y una clave de cuenta hash). Si el cheque no puede ejecutarse, el turno continúa.
- **Destino:** la fila canónica nombra `https://api.anthropic.com` porque ahí es donde aterriza el tráfico de la suscripción. OpenCodex nunca envía esa solicitud en sí, y anular la URL base falla en cerrarse en lugar de entregar el turno a otro entorno.

> **Términos:** este preajuste gasta su suscripción Claude a través de Anthropic 's propio CLI. Si conducir ese arnés sin cabeza desde un proxy se ajusta a los términos de su plan es una pregunta entre usted y Anthropic. OpenCodex no convierte el inicio de sesión en una clave API y no reproduce la identidad CLI de HTTP.

<a id="a6api-credit-quota"></a>

### Cuota de crédito A6API

Un proveedor `openai-chat` personalizado que usa `authMode: "key"` y la URL base canónica `https://api.a6api.com` o `https://api.a6api.com/v1` recibe un medidor de crédito A6API en el panel de control y desde `ocx account refresh <provider>`. El nombre del proveedor es arbitrario; la detección utiliza el extremo canónico HTTPS. El medidor convierte las unidades de token A6API en USD utilizando el límite de crédito duro de la cuenta y muestra el porcentaje consumido más el crédito restante. El vencimiento del token no se muestra como un restablecimiento de la cuota porque el vencimiento no implica que el crédito se reponga.

```json
{
  "providers": {
    "my-a6": {
      "adapter": "openai-chat",
      "authMode": "key",
      "baseUrl": "https://api.a6api.com/v1",
      "apiKey": "${A6API_API_KEY}"
    }
  }
}
```

Las sondas de cuota envían solo la clave activa al host canónico A6API y rechazan las redirecciones. Los totales de facturación mal formados, negativos o internamente inconsistentes no producen ningún informe en lugar de una barra engañosa.

> **Restricción de uso de Tencent Cloud Coding Plan:** Tencent documenta esta suscripción solo para herramientas de codificación interactivas. La automatización general API, los backends de aplicaciones personalizados y el uso por lotes no interactivo están prohibidos y pueden hacer que se suspenda la clave del plan.

> **Rutas de facturación GLM:** `zai` es la suscripción internacional de planes de codificación de Z.AI; `zhipu-bigmodel` es el punto final nacional de pago por uso de Zhipu. Diferentes hosts, diferentes claves, diferente facturación: una clave emitida para uno no se autenticará contra el otro.

<a id="bigmodel-coding-plan-over-responses"></a>

### Plan de codificación BigModel sobre Responses

Seleccione **Zhipu AI - Plan de codificación BigModel ( Responses)** (`zhipu-bigmodel-responses`) para el punto final `openai-responses` `https://open.bigmodel.cn/api/v1`. Esto está separado de `zhipu-bigmodel-coding`, que usa Chat Completions en `/api/coding/paas/v4`.

El preajuste utiliza un **Lista estática** (`liveModels: false`) tomado del [Documentación del plan de codificación GLM](https://docs.bigmodel.cn/cn/coding-plan/tool/codex.md) publicado:

| Modelo | Tokens de contexto | Esfuerzo seleccionable ascendente | Esfuerzo predeterminado | Resúmenes de razonamiento |
| --- | ---: | --- | --- | --- |
| `glm-5.3` | 1,048,576 | `low`, `high`, `max` | `max` | Apoyado |
| `glm-5.3-flash` | 1,048,576 | `low`, `high`, `max` | `max` | Apoyado |
| `glm-5-turbo` | 204,800 | Ninguno (lista vacía) | `max` | Apoyado |

`glm-5.3` y `glm-5-turbo` declaran entrada de solo texto aguas arriba. El catálogo Codex anuncia texto e imagen para ellos porque el sidecar de visión existente opencodex puede describir imágenes para modelos solo de texto; esa ruta requiere un sidecar de visión disponible y habilitado y no reclama soporte de imagen BigModel nativo.

`glm-5.3-flash` es la excepción: declara la entrada nativa `text` y `image`, porque upstream lo documenta como un modelo multimodal nativo. Por lo tanto, lee imágenes directamente en lugar de ser enrutado a través del desvío del primer sidecar descrito.

El modelo predeterminado es `glm-5.3`; Responses El contenido de razonamiento se conserva en la repetición. La exportación Codex existente agrega su nivel de compatibilidad `ultra` a GLM-5.3 y omite el campo de esfuerzo predeterminado de Turbo porque Turbo no tiene una escalera seleccionable; los metadatos del proveedor aún registran `max` para ambos modelos. Para Turbo, las solicitudes salientes Responses omiten `reasoning.effort`, incluyendo `max` o `ultra` de la persona que llama, mientras se conservan los resúmenes de razonamiento solicitados. Esto deja la selección de esfuerzo en el valor por defecto ascendente; opencodex no inyecta un alambre seleccionable o `max`.

El `models.json` del ejemplo es un archivo de catálogo local, no una respuesta documentada de la lista de modelos HTTP, y no el conjunto de modelos que sirve el punto final: las páginas del Plan de codificación indican que cada nivel del plan alcanza GLM-5.3 y GLM-5.3-Flash, y que las llamadas GLM-5-Turbo se cambian automáticamente a Flash, por lo que este punto final ya estaba sirviendo Flash bajo el Turbo id. Este preajuste aún no realiza el descubrimiento de modelos en vivo. Un proveedor personalizado existente con el mismo nombre mantiene su destino y metadatos configurados. El inicio de sesión de clave CLI también omite la sonda indocumentada `/models` e informa la validación como desconocida; la autenticación de clave exitosa se establece mediante una solicitud de inferencia posterior.

<a id="multiple-api-keys"></a>

### Múltiples claves API

Los proveedores basados en claves también pueden mantener múltiples claves. La adición de una clave a través de la página de proveedores la almacena en `provider.apiKeyPool`, la hace activa y la refleja en `provider.apiKey` para que el enrutamiento y los adaptadores continúen leyendo el mismo campo que antes. El mismo menú desplegable puede conmutar o eliminar teclas; la gestión API es `/api/providers/keys` y devuelve solo teclas enmascaradas.

<a id="switching-accounts-from-the-terminal"></a>

### Cambio de cuentas desde la terminal

Utilice `ocx account list`, `ocx account current` y `ocx account use` para inspeccionar o cambiar los mismos grupos de teclas Codex, OAuth y API sin abrir el tablero de instrumentos. Consulte [CLI referencia](/es/reference/cli/providers-accounts/#ocx-account-subcommand) para ver los comandos, la salida JSON y el comportamiento de la sesión nueva.

<a id="subscription-tier-in-account-listings"></a>

#### Nivel de suscripción en los listados de cuentas

`ocx account list <provider> --json` y `GET /api/oauth/accounts` reportan un campo `plan` en cada cuenta OAuth, usando el mismo nombre y ubicación que el proveedor OpenAI / Codex para que un consumidor pueda leer una forma en todos los proveedores.

El campo siempre está presente. Es `null` cuando se desconoce el nivel, lo cual es deliberado: una clave **ausente** significa que el proxy es anterior a este campo, mientras que `null` significa que esta versión se veía y el proveedor no informó un nivel. Colapsar los dos permitiría a un consumidor asumir silenciosamente un nivel.

Para Anthropic cuentas (ambos grupos) el valor proviene del perfil de cuenta autenticado que OpenCodex ya lee: el nivel de límite de solicitudes de la organización, informado como etiquetas como `max_20x`, `max_5x` o `pro`. Se registra en el inicio de sesión, importación local Claude Code y actualización de token. Para Google Antigravity el valor es el nivel pagado de `loadCodeAssist` (por ejemplo `g1-pro-tier`), volviendo al nivel actual. Una lectura fallida mantiene la última etiqueta grabada; una lectura que responde sin un nivel de informes `null`. El nivel nunca se deriva de los porcentajes de cuota, ya que estos se normalizan por cuenta: un asiento máximo × 5 al 50% es indistinguible de un asiento máximo × 20 al 50%.

<a id="gpt-56-preview-paths"></a>

### GPT-5.6 rutas de vista previa

GPT-5.6 Sol / Terra / Luna se siembran en las listas de reserva del proveedor para que `ocx sync` pueda mantener los modelos visibles incluso cuando los catálogos en vivo se retrasan:

| Ruta Codex | IDs de modelos de semillas | Codex - contexto visible |
| --- | --- | --- |
| Codex inicio de sesión ( Pool o Direct) | `gpt-5.6-*` | 922,000 |
| OpenAI (clave API) | `openai-apikey/gpt-5.6-*` más `*-pro` | 922.000 (922.000 entradas máximas) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`, `openrouter/openai/gpt-5.6-terra`, `openrouter/openai/gpt-5.6-luna` | 922,000 |
| Cursor | `cursor/gpt-5.6-sol`, `cursor/gpt-5.6-terra`, `cursor/gpt-5.6-luna` | 1,000,000 |

Las entradas nativas de GPT-5.6 preservan las escalas de razonamiento aguas arriba ancladas (por ejemplo, Luna tiene `max` pero no `ultra`). Las entradas enrutadas usan sus metadatos de proveedor y mapeos de razonamiento. Las cuatro rutas permanecen abiertas aguas arriba; El descubrimiento en vivo de Cursor filtra adicionalmente su semilla estática a los modelos que puede usar la cuenta iniciada.

:::note[Pasarelas y proxies de suscripciones]
Se incluye un proveedor cuando opencodex tiene un adaptador de cable correspondiente, **no** basado en si es un producto "agente". Los identificadores de adaptador actuales son `openai-chat`, `openai-responses`, `anthropic`, `google`
(modos AI Studio, Vertex y Antigravity / Cloud Code Assist), `azure` / `azure-openai`, `kiro`, y
`cursor`. Un propietario API sin una de estas implementaciones, como Amazon Bedrock nativo, No se apoya directamente.

La configuración del proveedor selecciona el adaptador; la selección de transporte aguas arriba es independiente. El tráfico Responses elegible puede usar WSS con [Enrutamiento proxy explícito](/es/reference/proxy-formats/#json-and-sse-output). Los ajustes del proxy WebSocket no válidos o no compatibles vuelven a HTTP / SSE, que utiliza el [servidor configurado outbound fetch](/es/reference/configuration/server/). Un servidor proxy SOCKS5 de `config.proxy` o un SOCKS5 `ALL_PROXY` heredado utiliza el túnel incorporado cuando `NO_PROXY` no exime al objetivo. Las variables proxy HTTP (S) específicas del esquema conservan su manejo nativo separado; no SOCKS `ALL_PROXY` no es una ruta de extracción HTTP nativa.

**GitHub Copilot** es un proveedor de OAuth (`ocx login github-copilot`) que intercambia un inicio de sesión de flujo de dispositivos GitHub por un token Copilot API de corta duración, no una clave API pegada. **Dúo GitLab** sigue siendo una puerta de enlace clave/token de suscripción en su punto final compatible con OpenAI. **Puerta de enlace de Cloudflare AI** necesita su cuenta + identificadores de puerta de enlace rellenados en la URL.

Copilot automáticamente usa Auto cuando cada fila válida en un catálogo de cuenta no vacía informa explícitamente que la selección manual no está disponible. Los permisos faltantes o mal formados retienen rutas con nombre; el selector elimina solo filas explícitamente denegadas. La detección automática solo suministra `github-copilot/auto`, y GitHub selecciona el modelo real por solicitud. Esto no cambia los permisos de suscripción. Las listas de permisos de modelos ordinarios, el estado pendiente/deshabilitado y la política de nuevo modelo también se aplican a la visibilidad automática. Si las selecciones guardadas o la directiva ocultan Auto, seleccione o habilite la fila Auto antes de usarla. Las preferencias manuales existentes permanecen guardadas. Un modelo llamado `auto` solo no anula la evidencia de la cuenta.

Auto sigue el protocolo de sesión e intención en el público [VS Copilot Aplicación de chat](https://github.com/microsoft/vscode-copilot-chat/blob/7b70532a4cbdfa61c2b30fe4ccffda3d89336a4d/src/platform/endpoint/node/automodeService.ts). Se trata de una integración experimental de clientes, no de un contrato de terceros documentado API; GitHub puede cambiar los permisos del protocolo o de la cuenta. Auto utiliza el punto final anunciado del modelo seleccionado para cada solicitud. El enrutamiento intencional envía solo el último texto de usuario, limitado localmente a 32,768 unidades de código UTF-16; la inferencia real mantiene la entrada completa. La negociación tiene presupuestos defensivos locales de 512 entradas de catálogo / grupo / candidato, 1 MiB por respuesta exitosa y ocho segundos por llamada, incluyendo ritmo y lecturas de cuerpo. Estos son OpenCodex salvaguardas, no documentado GitHub límites; catálogos de gran tamaño, negociación lenta o un extracto de intención truncada pueden afectar la compatibilidad.

Para las selecciones con nombre, Copilot presenta un catálogo de cables mixtos: los siguientes modelos (`gpt-5.3-codex`, `gpt-5.4`,
`gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-astra`, `grok-4.5`, `grok-4.6`, `mai-code-1.1-flash`, `mai-code-1-flash-picker`) Rechazar
`/chat/completions` para el tráfico de agentes, por lo que opencodex enruta esos modelos Responses API por defecto incorporado, mientras que cualquier otro modelo Copilot permanece en el chat Finalizaciones. La precedencia es: pin de alambre duro → su explícito
[`modelAdapters`](/es/reference/configuration/providers/) entrada Registro → predeterminado → adaptador de todo el proveedor. Para optar por un modelo sin un valor predeterminado incorporado (por ejemplo
`gpt-5.4-nano`) en Responses, conjunto `"modelAdapters": { "gpt-5.4-nano": "openai-responses" }`.

Cursor se rastrea por separado como un adaptador experimental. `adapter: "cursor"` aparece en `ocx init`
y el selector Add Provider del panel como una entrada de configuración local experimental con Cursor's metadatos estáticos del catálogo de modelos de reserva. Cursor acceso token está configurado, opencodex usos Cursor's vivo HTTP/2 transporte. Conjunto `upstreamHttpVersion: "http1.1"` cuando un proxy requiere Cursor de HTTP/1.1 ruta de compatibilidad; la configuración cubre tanto la inferencia como el descubrimiento del modelo en vivo y se expone en
**Proveedores → Cursor → Configuración → Cursor transporte**. Su semilla de reserva incluye `gpt-5.6-sol` / `terra` / `luna` (1M contexto), filas regulares/rápidas para Grok 4.5, 4.6 y 4.7 (500K), y `kimi-k3` (262K); el descubrimiento en vivo decide cuál permanecer visible para la cuenta. Grok 4.6 y 4.7 exponer `low` / `medium` / `high` / `xhigh` En ambas formas, mientras que 4.5 se detiene en `high`. Las solicitudes rápidas Grok 4.5 y 4.6 envían el modelo base correspondiente con una configuración separada
`effort` y `fast=true` `requested_model` parámetros; sus aplanados
`cursor-grok-{version}-{effort}-fast` ids son solo identidades de descubrimiento y selector. Grok 4.7 aparece sin el `cursor-` Prefijo y envía `grok-4.7-{effort}-fast` directamente. Cursor sirve Kimi K3 solo como ids de alambre con sufijo de esfuerzo, así que
`cursor/kimi-k3` expone a `low` / `high` / `max` Escalera y valores predeterminados `max`, igualando el modelo documentado API por defecto. Cursor lectura/escritura/eliminación nativa impulsada por servidor/ls/grep/shell/ejecución de fetch está deshabilitado de forma predeterminada porque omite la aprobación de Codex y la ruta sandbox; establecer
`unsafeAllowNativeLocalExec: true` en el `providers.cursor` objeto en `~/.opencodex/config.json`
solo para experimentos locales de confianza (o a través de **Proveedores → Cursor → Editar JSON** en el panel). Solicitudes de shell nativo en primer plano (`shellArgs` y `shellStreamArgs`) permanecen no disponibles en Windows, macOS y Linux incluso con esta opción: opencodex los rechaza antes de comenzar un proceso hasta que tenga un propietario descendiente respaldado por el kernel. Utilice la herramienta de shell del cliente en su lugar. Sin comando se recopila la salida; los shells de fondo y los ejecutores MCP/desktop configurados por separado no cambian. Ver la [Referencia de configuración](/es/reference/configuration/providers/#cursor-provider-adapter-cursor)
Para un ejemplo completo. MCP, grabación de pantalla y uso del ordenador están disponibles como ganchos ejecutor; sin un configurado el ejecutor local, opencodex devuelve los resultados sin ejecutor escritos en lugar del bloqueo de directivas la solicitud. Cursor OAuth y el descubrimiento de modelos en vivo están habilitados para este adaptador experimental; Cursor todavía no se muestra en las listas de inicio de sesión clave.
:::

<a id="ollama-cloud"></a>

### Ollama Cloud

Ollama Cloud es un servidor (no local) Ollama. Configure en `https://ollama.com/v1` con una clave de [ollama.com/settings/keys](https://ollama.com/settings/keys). opencodex lo alcanza sobre el propio Ollama REST API ( `POST /api/chat` ) en lugar de la superficie compatible con OpenAI, y descubre la lista de modelos en vivo del proveedor, por lo que los nuevos modelos Ollama Cloud aparecen sin un cambio de configuración. opencodex clasifica su línea de nubes por capacidad de visión, por lo que el [visión sidecar](/es/guides/sidecars/) solo se activa para modelos de solo texto. Los modelos solo de texto (p. `glm-5.2`, `deepseek-v4-flash`, `gpt-oss`, `qwen3-coder`, `minimax-m2.x`, `nemotron-3-*` ) se enumeran en `noVisionModels`; modelos nativos de la visión (por ejemplo. `kimi-k2.6`, `minimax-m3`, `gemma4`, `qwen3.5`, `gemini-3-flash-preview`). El emparejamiento es tolerante a las etiquetas `:size` de Ollama, por lo que `gpt-oss` cubre `gpt-oss:120b` y `gpt-oss:20b`.

Ollama actualmente documenta salidas estructuradas como no compatibles en Ollama Cloud. Para canónica `ollama-cloud`, opencodex por lo tanto rechaza las solicitudes de salida estructuradas (`text.format`) con un error claro en lugar de devolver silenciosamente prosa sin restricciones; local y costumbre `ollama-native` puntos finales mantener Ollama 's nativo `format` comportamiento.

<a id="4-local-providers"></a>

## 4. Proveedores locales

Punto opencodex en un servidor compatible local OpenAI - por lo general con una llave en blanco:

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

Codex le pide a un segundo modelo que revise las solicitudes de aprobación, y toma ese revisor de `auto_review_model_override` en la fila de catálogo del modelo de turno actual. La raíz `auto_review_model` en `$CODEX_HOME/config.toml` es el retroceso de Codex. El panel de control global **Anulación de revisión automática** en la configuración del modelo aplica un revisor a todas las filas del catálogo que no tienen un revisor con alcance de proveedor. Almacena `autoReviewOverride` en `~/.opencodex/config.json`; la configuración debe estar habilitada y nombrar un modelo. Una configuración habilitada sin modelo permanece sin aplicar y deja el retroceso Codex en efecto. Una actualización de catálogo es un estado separado: después de guardarlo puede permanecer pendiente, y la página Modelos lo informa para que pueda volver a intentarlo con `ocx sync`. Desde el CLI, lea la configuración con `ocx models auto-review status` o cámbiela con `ocx models auto-review set <model|-> [--enabled <on|off>]`; use `-` para borrar el modelo. La salida CLI recomienda `ocx sync` cuando se puede volver a intentar una actualización. Si falla una actualización, la configuración permanece guardada y el comando sale 1. Resolver el fallo antes de la sincronización. Para dar a un proveedor enrutado su propio revisor, generalmente más barato, configure el selector en esa fila de proveedores en `~/.opencodex/config.json`:

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

**Créditos de Abliteration.** Un proveedor de cualquier nombre cuyo `baseUrl` sea `https://api.abliteration.ai` o `https://api.abliteration.ai/v1` consulta `GET https://api.abliteration.ai/v1/credits` con la clave activa como token bearer, sin seguir redirecciones. El saldo restante en USD es `total_credits` menos `total_usage`; la barra muestra el gasto consumido. Una cuenta sin créditos no muestra barra. Una clave rechazada elimina la fila; `503 credit_balance_unavailable`, 408 y 429 conservan la última lectura.

**Cuota de OpenCode Go.** El preajuste canónico `opencode-go` lee `GET https://opencode.ai/zen/go/v1/usage` con la clave configurada como token de portador y no sigue redirecciones. Los valores de la respuesta rodando, semanal y mensual `percent` ya están consumidos: rodando mapas a la barra de 5 horas, mientras que semanal y mensualmente mantienen sus barras coincidentes. OpenCodex no reconstruye los límites de dólares de los registros de uso local, y a un proveedor que usa un `baseUrl` no canónico nunca se le envía la clave para esta sonda.

**Cuota del plan de codificación Z.AI GLM.** Los preajustes `zai`, `glm`, `glm-cn` y `zhipu-bigmodel-coding` leen `GET /api/monitor/usage/quota/limit` y no siguen redireccionamientos. La sonda corre contra la región que el proveedor señala en: `api.z.ai` (desnudo o `/api/coding/paas/v4`) o `open.bigmodel.cn` (desnudo, `/api/coding/paas/v4` o el punto final OpenAI Responses `/api/v1`).

La autenticación difiere según la región: `api.z.ai` toma la clave como Bearer token, mientras
`open.bigmodel.cn` espera la clave directamente en `Authorization` Sin prefijos y rechaza un encabezado Bearer. La respuesta es `limits` Rellene las filas de la barra de utilización:
`TOKENS_LIMIT` / `CREDIT_LIMIT` filas con `unit` 3 / `number` 5 Llene la barra de 5 horas y
`unit` 6 / `number` 1 El bar semanal.

`TIME_LIMIT` filas son **no** cuota de modelo y se ignoran. Son la asignación de llamada mensual compartida MCP para Web Search, Web Reader y Zread, por lo que tratarlos como una ventana de modelo permitiría que un presupuesto de búsqueda web gastado se lea como capacidad de modelo agotada en la clasificación de la cuenta consciente de cuotas. Por lo tanto, un plan que reporta solo `TIME_LIMIT` filas no muestra barras de cuotas en lugar de una fabricada, y las ventanas del plan no informan que permanezca ausente en lugar de mostrarse como 0%.

Nunca se envía la clave para esta sonda a un proveedor que utilice un `baseUrl` no canónico.

<a id="diagnosing-an-antigravity-quota-refresh"></a>

### Diagnosticar una actualización de cuota Antigravity

La vista de cuota de cuenta y `ocx account list google-antigravity --quota --refresh` distinguen entre denegación de acceso, limitación de velocidad, destinos bloqueados o redirecciones, DNS/conexión/tiempos de espera y datos de cuota inutilizables. Las últimas barras conocidas permanecen visibles con su tiempo de observación cuando falla una actualización. La reautenticación retira los diagnósticos de la credencial anterior; una actualización exitosa borra el fallo.

Un resultado denegado por acceso no prueba por sí mismo un inicio de sesión vencido o un plan no elegible. Un destino bloqueado es una decisión de política de red, no una prueba de un defecto de IP falsa. Los destinos de la cuota Canonical Google retienen las restricciones de verificación y redirección/dirección privada de TLS. El comportamiento de TUN autenticado debe comprobarse en el entorno afectado; los accesorios de transporte inyectados solos no establecen ese resultado de campo.

<a id="large-inline-images-on-chat-providers"></a>

## Grandes imágenes en línea en proveedores de chat

Las solicitudes de chat compatibles con la traducción OpenAI reducen las imágenes en línea cuando sus datos base64 combinados superan los 3,5 MiB. Las imágenes más antiguas pierden detalle primero. Este es un presupuesto de imagen de mejor esfuerzo, por lo que el texto grande, los esquemas o las imágenes que no se pueden procesar aún pueden exceder un límite de solicitud ascendente. Las URL de imágenes remotas no se descargan y las imágenes que no se pueden reducir permanecen adjuntas. El passthrough de Native Chat mantiene sus bytes de imagen originales.
