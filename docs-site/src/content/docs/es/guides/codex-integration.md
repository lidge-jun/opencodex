---
title: "Integración con Codex"
description: "Cómo se inyecta opencodex en Codex, sincroniza el catálogo de modelos, instala shims y restaura limpiamente."
---

opencodex enruta Codex a través del proxy modificando dos elementos que Codex lee: su configuración (`$CODEX_HOME/config.toml`, por defecto `~/.codex/config.toml`) y su catálogo de modelos. Cada cambio es idempotente y reversible.

El resumen **Conectar** incluye un interruptor de Codex para esta integración nativa. Muestra el último estado deseado guardado en OpenCodex, incluso justo después de cambiarlo; la insignia indica si se observa que Codex está utilizando el proxy. Durante la limpieza ambos estados pueden diferir brevemente. Al desactivar la integración se identifica el archivo de configuración efectivo de Codex, se eliminan los elementos de enrutamiento generados por OpenCodex y el proxy sigue disponible para otros clientes. Al reactivarla se reconstruye el catálogo con los modelos disponibles en ese momento; no se restauran los archivos de Codex byte por byte.

El catálogo incluye metadatos de los programas de acceso autenticados tanto para los modelos nativos de Codex sin prefijo de cuenta como para las filas generadas del selector de cuentas. Los modelos sin prefijo utilizan la cuenta principal de Codex; los modelos con cuenta específica usan la seleccionada. Actualizar la integración renueva estas filas cuando cambian los programas de acceso de la cuenta. OpenCodex incorpora la información de disponibilidad de modelos de la cuenta principal que tiene la sesión iniciada a las filas nativas sin prefijo.

El proxy expone la ruta de inicio de sesión de Codex `openai` sin prefijo, con los modos de cuenta Pool (predeterminado) y Direct, además de `openai-apikey/<model>` para la clave API configurada. Pool incluye la cuenta principal y las añadidas; Direct utiliza únicamente la credencial de quien realiza la solicitud o la cuenta principal. Estas rutas no recurren unas a otras como alternativa. Las configuraciones v1 existentes migran al marcador 2 y conservan `config.json.pre-openai-tiers-v2.bak` para una restauración manual.

En modo Pool, una solicitud con un inicio de sesión nativo de Codex validado puede utilizar esa sesión cuando la cuenta almacenada seleccionada está en periodo de espera y no hay otra cuenta almacenada ni una sonda de recuperación aptas. Esto también se aplica a una solicitud nueva bloqueada antes del envío, con la misma validación de identidad utilizada después de un rechazo del proveedor. Se siguen aplicando los permisos del modelo y las políticas de la cuenta principal. Esta alternativa conserva el periodo de espera de la cuenta almacenada y no guarda la credencial de quien realiza la solicitud como selección de Pool. Un enlace exacto a una cuenta permanece vinculado a ella. Fijar una cuenta manualmente en Pool expresa una preferencia; no crea un enlace exacto y todavía permite esta alternativa. Utilice un modelo con cuenta específica cuando la solicitud deba permanecer en una sola cuenta. Pausar la cuenta principal nativa observada bloquea esta alternativa para la credencial coincidente, pero no identifica ni pausa otras sesiones de quien realiza la solicitud.

Al añadir o volver a autenticar una cuenta de Pool, se rechaza un duplicado de la sesión principal nativa con `Account is already configured as the native Codex main account.`. La comprobación compara el ID de cuenta de ChatGPT, el ámbito de suscripción personal o de espacio de trabajo y el correo electrónico; la ausencia de correo no demuestra que sea otra identidad. Se siguen admitiendo espacios de trabajo distintos, miembros diferentes de un mismo espacio y suscripciones personales y de espacio de trabajo independientes. Un fallo al consultar el uso no descarta el plan de suscripción incluido en el token de inicio de sesión.

Los duplicados existentes se conservan, pero no pueden seleccionarse como una segunda cuenta de Pool. La lista de cuentas expone `selectionExcludedReason: "duplicate_main"` y una `selectionExcludedAction` con instrucciones. Utilice explícitamente la cuenta principal nativa o inicie sesión en Codex nativo con otra cuenta antes de reutilizar la entrada guardada. La detección sigue la observación más reciente de la sesión nativa propia, incluso después de un nuevo inicio de sesión. La consulta pasiva de cuentas y las solicitudes con credenciales de quien llama no abren las credenciales nativas para actualizar esa observación.

<a id="config-injection"></a>

## Inyección de configuración

`ocx sync` elimina del catálogo los esfuerzos de razonamiento que no admite el entorno de ejecución de Codex seleccionado. Informa de la limitación cuando cambian la identidad de ese entorno, los esfuerzos eliminados o los modelos afectados. Las sincronizaciones sin cambios conservan la fecha del diagnóstico y no repiten el aviso. Esta adaptación de compatibilidad no requiere ejecutar `ocx doctor`. Si la limitación desaparece y luego vuelve, se informa otra vez.

OpenCodex serializa su configuración Codex. En Windows, un archivo mantenido temporalmente abierto por otro proceso obtiene un breve reintento limitado. Si el acceso permanece ocupado, vuelva a intentar la operación en breve; OpenCodex conserva la evidencia de bloqueo existente y no utiliza ese fallo de acceso para hacerse cargo de la cerradura de otro escritor.

`ocx init`, `ocx start`, y `ocx sync` Llame al inyector. En el enlace de bucle predeterminado, se mantiene Codex incorporado `openai` ID de proveedor y apunta a ese proveedor en opencodex:

```toml
# root keys, before the first table
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex (undo: ocx restore)
openai_base_url = "http://127.0.0.1:10100/v1"
# Auto-injected by opencodex (undo: ocx restore)
experimental_realtime_ws_base_url = "http://127.0.0.1:10100/v1"

# only when fastMode is set; unset adds no [features] table
[features]
fast_mode = true
```

La segunda clave es la anulación de banda lateral de voz. Codex crea una llamada de voz WebRTC a través de `openai_base_url`, pero desde el Codex 0.146 (openai/codex#35830) se une a la banda lateral de esa llamada WebSocket en `api.openai.com` directamente a menos que `experimental_realtime_ws_base_url` lo redirija. En el modo Pool, la llamada se crea bajo la cuenta opencodex selecciona, por lo que una unión directa bajo el propio inicio de sesión de la aplicación falla con `realtime websocket handshake failed` (404). La clave inyectada envía la unión de vuelta a través de opencodex (`GET /v1/live/{callId}`), donde el Pool reutiliza la cuenta que enlazó a ese par de sesión/hilo (un enlace de proceso-local). Una llamada que el propio cliente creó es la excepción: cuando ChatGPT voz manos una llamada a un Codex hilo, o Codex escritorio crea la llamada por su cuenta, la llamada pertenece a su inicio de sesión ChatGPT y sólo su banda lateral join alcanza opencodex, por lo que opencodex reenvía que se unen con la propia ChatGPT credencial de la persona que llama en lugar de una cuenta Pool. En el modo Direct ambas patas ya usan el portador actual de la persona que llama, por lo que la clave solo mantiene la unión en la ruta proxy. Está escrito solo en el formulario loopback `openai_base_url`, se elimina junto con él, y un `experimental_realtime_ws_base_url` propiedad del usuario nunca se sobrescribe.

<a id="voice-transport-and-task-handoffs"></a>

### Transporte de voz y traspasos de tareas

Codex posee el micrófono y el altavoz, negociación de medios WebRTC, subtítulos, controles de silencio y limpieza de voz al cambiar de hilo. OpenCodex retransmite la creación de llamadas y la conexión de banda lateral; el trabajo delegado por voz utiliza la ruta de enrutamiento Responses normal. La elección de un proveedor de texto no reemplaza el modelo de voz en tiempo real ni habilita la voz en un cliente que no lo admite.

Los [Cambio de ayudante WebRTC](https://github.com/openai/codex/commit/1b53f6a44eff890b5169bde8d3bd5b12b8766946) y [Integración de voz TUI](https://github.com/openai/codex/commit/b01c3986fd2e79b8a477a08d81430f52f22bc0dc) describen estas responsabilidades del cliente, incluyendo las respuestas finales de los traspasos de voz. Sus fechas de fusión no se establecen cuando el mismo comportamiento llegó a la aplicación de escritorio.

Los diagnósticos opcionales `OCX_LIVE_FRAME_LOG` escriben solo la marca de tiempo de trama, la dirección, el tipo, el recuento de bytes y una bandera de caracteres de reemplazo (`ts`, `dir`, `kind`, `bytes`, `fffd`). No almacenan texto de voz o extractos de marcos. Para tramas binarias, la decodificación UTF-8 puede producir caracteres de reemplazo, por lo que la bandera sola no identifica dónde ocurrió la corrupción. Los archivos de registro existentes no se reescriben.

<a id="fast-mode"></a>

### Modo rápido

El `fast_mode` inyectado sigue el ajuste de tres estados `fastMode`: `true` escribe `fast_mode = true`, `false` escribe `fast_mode = false`, y unset deja un `fast_mode` existente intacto sin agregar una tabla `[features]`.

El modo rápido está separado del transporte de voz. La descripción de la velocidad de nivel de servicio de un modelo compatible no garantiza un micrófono más bajo, WebRTC o latencia de voz de extremo a extremo hasta OpenCodex.

<a id="chatgpt-family-channel-and-latency"></a>

### Canal y latencia de la familia ChatGPT

Las solicitudes enrutadas a través de opencodex a través del proveedor canónico ChatGPT -login `openai` - adaptador `openai-responses`, `authMode: "forward"` y el punto final `https://chatgpt.com/backend-api/codex`, que cubren los modos Pool y Direct, usan el punto final público ChatGPT. El enrutamiento del proveedor o la selección de la cuenta no omite el canal ascendente ChatGPT. El flujo ascendente puede pasar tiempo poniendo en cola una solicitud antes de la primera salida incluso cuando el proxy local y la ruta de red están sanos.

Solo algunos giros toman el transporte websocket ChatGPT, el mismo carril `responses_websockets` Codex CLI predeterminado. Un turno es elegible cuando el entorno de ejecución Bun soporta el relé limitado, la solicitud es un `POST` a la URL canónica Responses o una ruta WebSocket configurada, y su cuerpo JSON establece `stream` a `true` en la raíz. Todo lo demás permanece en SSE sobre HTTP, y un giro elegible sigue cayendo de nuevo a él cuando la solicitud no se puede preparar, la trama `response.create` excede su límite de tamaño, o la ruta proxy no puede llevar el socket.

Para mantener el proveedor ChatGPT incorporado en HTTP / SSE, configure `providers.openai.upstreamWebsocket` a `false` en `~/.opencodex/config.json` y reinicie el proxy. Fusione este campo en el proveedor `openai` existente; conserve su modo de cuenta y otras configuraciones. Omite el campo para restaurar la selección predeterminada de aguas arriba WebSocket. Esta configuración no cambia el conmutador `websockets` orientado al cliente ni la cuenta ChatGPT utilizada para la solicitud. La dirección y la inyección nativas a mitad de giro necesitan corriente arriba WebSocket y no están disponibles mientras están apagadas.

**Metadatos de uso del razonamiento (disponibles desde la versión 2.90.0).** Para los clientes HTTP/SSE de la ruta canónica de ChatGPT, el relé WebSocket conserva el encabezado real de respuesta de conexión `x-reasoning-included` cuando Bun lo expone, también al reutilizar una conexión. Este encabezado indica a Codex que el uso informado por el servidor ya incluye el razonamiento anterior. Los metadatos recibidos antes del primer evento de Responses tienen prioridad; los posteriores permanecen en el flujo, pero no pueden modificar los encabezados ya enviados. El relé no inventa esta señal ni altera las cifras de uso. La ausencia de la señal del servidor y el ciclo de contabilización propio de Codex son problemas distintos: este cambio por sí solo no demuestra que se haya corregido la compactación anticipada. Las conexiones WebSocket del cliente ya completaron su actualización de protocolo antes de la respuesta del servidor de origen y no pueden recibir la señal retroactivamente como encabezado de esa actualización.

El control local del ritmo de solicitudes también puede retrasar una solicitud antes de enviarla. Por eso, una primera salida lenta puede tener varias causas, entre ellas la cola del proveedor de origen. `ocx doctor` clasifica la configuración, pero no mide esos tiempos: compara el transporte real, el control de ritmo, la red y las observaciones del proveedor antes de sacar conclusiones.

Lo que decide si una solicitud toma ese canal público es el destino al que se resuelve, no el nombre de la entrada del proveedor. Un proveedor que resuelve en otro lugar - `openai-apikey`, o una entrada personalizada que apunta a su propio API - llega a ese punto final directamente y no ve ChatGPT en cola. Una entrada con nombre personalizado que se resuelve en `https://chatgpt.com/backend-api/codex` con auth directo toma el mismo canal público que la fila incorporada, porque la clasificación lee el adaptador, el modo de auth y el destino en lugar del nombre de la entrada.

La pista `ocx doctor` es más estrecha que el comportamiento del punto final que describe: solo inspecciona la fila `openai` incorporada, por lo que su ausencia no le dice nada sobre dónde se resuelve cualquier otro proveedor.

`service_tier: priority` es una preferencia de solicitud. En el backend ChatGPT el `service_tier` echo no puede confirmar o denegar el nivel concedido: los giros programados como prioridad aún pueden hacer eco `default`, por lo que los registros de solicitud muestran el nivel de respuesta como una observación con confirmación `assumed`. Para el trabajo sensible a la latencia, compare los tiempos de primera salida observados entre los proveedores que realmente usa en lugar de asumir que cualquier canal en particular es más rápido.

Para un reenvío de puerta de enlace a un backend con la misma limitación de metadatos, declare explícitamente [`responseTierAuthoritative: false`](/es/reference/configuration/providers/#response-service-tier-authority) en ese proveedor. La solicitud sigue enviando prioridad y registra el eco sin procesar, mientras que la programación rápida real permanece sin confirmar. Las pasarelas no declaradas y el oficial API mantienen su interpretación existente basada en la respuesta. La actualización de OpenCodex por sí sola no agrega esta declaración a las entradas de pasarela existentes: sin ella, una solicitud de prioridad elegible seguida de un eco `default` todavía registra `response-declined`.

El proxy escucha en el puerto `10100` por defecto y sirve `POST /v1/responses`, `POST /v1/responses/compact`, `POST /v1/images/generations`, `POST /v1/images/edits`, `GET /v1/models`, `GET /healthz` y la superficie de gestión `/api/*`.

<a id="experimental-context-management-codex-0153"></a>

### Gestión de contexto experimental (Codex 0.153+)

Para una cuenta ChatGPT elegible, habilite la función experimental en el propio Codex de `config.toml` (combine esto en una tabla `[features]` existente):

```toml
[features]
context_management.experimental_mode = true
```

En la integración de loopback integrada predeterminada, el siguiente inicio `ocx sync` o proxy cambia la raíz administrada `openai_base_url` a `http://127.0.0.1:10100/backend-api/codex`. Codex comprueba esta ruta de fondo antes de habilitar sus herramientas `new_context`, historial y notas. Iniciar una nueva sesión Codex después de la sincronización. La función sigue siendo opt-in; las URL base propiedad del usuario y la inyección remota de proveedor personalizado no se reescriben. No se necesita o se añade una anulación de ventana de contexto o límite de compactación.

El prefijo backend alias las rutas de plano de datos existentes, incluyendo Responses WebSocket actualizaciones. Las rutas originales `/v1` y la anulación de banda lateral en tiempo real permanecen disponibles. El proxy también transmite los diez puntos finales POST nativos `alpha/history/v2/*` y `alpha/notes/v2/*` a través del proveedor `openai` incorporado con el adaptador `openai-responses` y el destino directo canónico ChatGPT. Direct utiliza el inicio de sesión actual de la persona que llama / principal; Pool selecciona una cuenta Codex. `openai-apikey` utiliza su clave API configurada, y los proveedores Responses personalizados o no canónicos no son candidatos para este contexto y no reciben credenciales de cuenta Codex. Estos puntos finales privados no son implementados por otros proveedores de modelos o la ruta OpenAI API -clave.

Los encabezados de llamada están restringidos a la lista de permisos de reenvío Codex compartida: `authorization`, `chatgpt-account-id` y los metadatos de protocolo OpenAI beta, originador, sesión y Codex aprobados. El relé de contexto reenvía adicionalmente `x-openai-encrypted-tool-arguments` y `x-openai-tool-output-truncation-policy`; no se reenvían encabezados de llamada arbitrarios tales como cookies. Una clave de plano de datos proxy presentada como portadora se reemplaza con la credencial Codex seleccionada (el inicio de sesión principal almacenado en Direct); las credenciales faltantes fallan antes del reenvío. Las credenciales de admisión de proxy nunca van hacia arriba. Los argumentos cifrados, los cuerpos de respuesta y los estados de error ascendentes se conservan.

Una respuesta de modelo ChatGPT exitosa registra la cuenta de servicio real de la sesión raíz en un registro de propiedad local de proceso limitado. El historial y las notas usan ese propietario registrado, incluida una cuenta seleccionada explícitamente, incluso cuando cambia la cuenta activa actual. La actualización del token de cuenta almacenada puede continuar para la misma cuenta física; se rechaza una identidad de cuenta reemplazada. Direct sesiones propiedad de la persona que llama mantienen la credencial de la persona que llama y no pueden ser tomadas por un portador proxy. Esto no migra el historial del lado del servidor entre cuentas.

La propiedad está dividida por la clave API opencodex que admitió la solicitud, por lo que dos claves nunca llegan a las sesiones de la otra incluso cuando ambas se resuelven en el mismo espacio de trabajo ChatGPT. Un identificador de espacio de trabajo nombra a una persona, por lo que el registro también vincula al usuario estable que lleva la credencial aceptada: una actualización de token ordinaria para ese mismo usuario continúa la sesión, mientras que un usuario diferente en el mismo espacio de trabajo no lo hace. Cuando la credencial aceptada no demuestra ser un usuario estable, solo continúa esa credencial exacta. Ese principal es la clave opencodex API que presenta la solicitud. Un enlace remoto ya requiere uno, por lo que la propiedad funciona allí. En el enlace de bucle de retorno predeterminado opencodex admite solicitudes sin leer una clave, y la inyección de bucle de retorno incorporada no puede llevar la cabecera `x-opencodex-api-key`, por lo que Codex no presenta ninguna clave opencodex y el historial de contexto devuelve HTTP 403. **Por lo tanto, el relé está disponible en un enlace remoto con una clave configurada, o a un cliente que envía el propio `x-opencodex-api-key`, y no a través de la integración de bucle invertido incorporada predeterminada.** Si un proxy enlazado a bucle debería poder nombrar a un llamador es una decisión de mantenimiento abierta, por lo que el comportamiento actual se niega en lugar de adivinar.

La propiedad desconocida, vencida, desalojada, conflictiva o reiniciada-perdida devuelve HTTP 409 antes de la selección de la cuenta o la E/S ascendente. El relé no adivina a partir de la cuenta activa actual. Las sesiones existentes deben guardar un punto de control u otro resumen duradero antes de habilitar la función o restablecer el contexto. Habilitarlo no rellena la historia anterior o las notas, y una nueva observación de propiedad no prueba que exista contenido backend más antiguo. Después de reiniciar, establezca la propiedad con una solicitud de modelo exitosa antes de usar herramientas de contexto; inicie una nueva sesión cuando haya conflictos de propiedad.

La afinidad del modelo existente, el tiempo de reutilización y las reglas de reintento no cambian. Las solicitudes de contexto no se vuelven a intentar automáticamente, incluidas las escrituras de notas; Las solicitudes de reenvío ChatGPT no usan la repetición 429 de la misma clave. El tráfico del historial no consume ni establece una sonda de recuperación de cuotas del modelo.

Un plazo de 35 segundos cubre toda la operación de retransmisión, comenzando antes de que se lea el cuerpo de la solicitud y cubriendo la selección de credenciales, por lo que un cliente estancado no puede mantener abierta una ranura de giro admitida. Una desconexión de cliente devuelve 499 y una fecha límite caducada devuelve 504; nada se despacha aguas arriba después de ninguna de las dos.

Para deshabilitar la función, quite la clave experimental (o configúrela en `false`), ejecute `ocx sync` e inicie una nueva sesión Codex. La base raíz administrada vuelve a `/v1`.

Mientras que la clave está ausente o `false`, el relé no existe: los diez puntos finales responden 404 para cualquier persona que llama, incluido uno que los publica directamente, y un modelo no registra ninguna propiedad del historial. opencodex decide esto leyendo la propia configuración Codex, por lo que el switch no depende de la URL inyectada ni de nada de lo que envíe un cliente, y desactivarlo entra en vigencia sin reiniciar.

<a id="hosted-image-results-in-codex-app"></a>

### Resultados de imágenes alojadas en la aplicación Codex

Cuando un proveedor Responses encaminado devuelve un `image_generation_call` alojado completado con datos de imagen base64, opencodex guarda la imagen validada en su directorio local `artifacts/` y entrega un mensaje de imagen de asistente final a un cliente Codex conectado localmente. La imagen permanece fuera de la sección de progreso plegable. Esto se aplica a la transmisión y no transmisión Responses, sin otra solicitud de generación o un cambio en el proveedor seleccionado.

Cuando un cliente reproduce estos mensajes de imagen generados como historial asistente, opencodex reemplaza sus enlaces de imagen local generados con referencias de artefactos opacos antes de reenviar ese historial. Esto protege las rutas de visualización sin cambiar el mensaje de imagen que ya se muestra en la aplicación. No elimina rutas no relacionadas suministradas por el usuario.

Esta compatibilidad de pantalla requiere la admisión de loopback y un cliente Codex reconocido. Los clientes remotos y genéricos de API conservan el formato de respuesta alojado del proveedor. Las previsualizaciones parciales y los resultados solo de URL no se representan en esta capa de compatibilidad. Los artefactos usan el límite de retención existente, así que guarda las imágenes que quieras conservar antes de que se eliminen los archivos antiguos. Una imagen no válida o una escritura local fallida produce un mensaje de error visible en lugar de un enlace de imagen roto. Los lotes de visualización rechazan identidades de imagen duplicadas, metadatos de enrutamiento sobredimensionados y salidas que exceden el límite de bytes de visualización; estos fallos devuelven HTTP 502 antes de la transmisión o un evento de terminal fallido después de que se inicia.

<a id="built-in-image-generation-image_gen"></a>

### Generación de imágenes incorporada (`image_gen`)

Codex 's herramienta incorporada `image_gen` no pasa por `/v1/responses` - la extensión de Codex-rs POSTs `{base_url}/images/generations` (o `/images/edits` cuando se adjuntan imágenes de referencia) directamente, con el mismo ChatGPT portador auth que utiliza para el chat. Debido a que el `base_url` inyectado apunta al opencodex, el proxy retransmite esas llamadas al OpenAI aguas arriba.

Esto es independiente del [Puente de imagen](/es/guides/image-bridge/), que solo se activa cuando un giro **Responses** enumera la herramienta `image_generation` alojada mientras se selecciona un modelo no OpenAI. Las llamadas independientes `/images/generations` nunca entran en ese puente.

- **Un candidato avanzado con conciencia de modo:** Pool selecciona una cuenta principal/añadida elegible y usa su credencial ChatGPT almacenada incluso cuando el cliente se autentica en opencodex con un portador de admisión proxy. Direct usa el portador ChatGPT OAuth del llamante y no puede reenviar un token de admisión proxy. El modo configurado se aplica consistentemente a la solicitud de imagen.
- **OpenAI API -proveedor clave:** se usa solo cuando ningún candidato a reenviar posee un fallo de autenticación. Una credencial Pool rota / expirada nunca se oculta detrás del uso API facturado por separado.
- **Proveedor personalizado explícito:** establece `images.provider` a la identificación de un proveedor personalizado API -key `openai-responses` cuyo punto final implementa las OpenAI Imágenes API. La selección explícita falla al cerrarse y nunca vuelve a caer en un flujo ascendente pagado diferente. Los identificadores de proveedor administrados por el registro no se aceptan aquí; omita `images.provider` para usar los niveles OpenAI incorporados.
- **xAI Imagine (Grok OAuth) relé:** cuando `images.bridgeEnabled` es `true`, se omite `images.provider`, y se configura un proveedor `xai`, `/v1/images/generations` y `/v1/images/edits` se envían a `https://api.x.ai/v1`. La credencial depende del `authMode` del proveedor: con `"oauth"` el relé reutiliza la concesión Grok CLI de `ocx login xai`; con cualquier otro modo usa la clave API del proveedor. Un inicio de sesión OAuth no arma un proveedor con llave, y viceversa. ChatGPT credenciales no se reenvían. Si falta la credencial, el proxy devuelve 400 en lugar de la facturación ChatGPT. El ajuste `images.provider` le da explícitamente `/v1/images` a ese proveedor; sus propios errores de validación se devuelven tal cual y el relé xAI nunca se intenta. El relé mapea Codex `size` / `aspect_ratio` en el cuerpo Imagine de xAI y devuelve la misma forma `{created, data:[{b64_json}]}`. Los bytes decodificados combinados y la salida codificada en base64 a través del lote (en línea `b64_json` y las URL descargadas) permanecen por debajo de 100 MiB; un lote que excedería ese límite devuelve 502. Cuando xAI devuelve una URL de imagen en lugar de bytes en línea, el proxy la obtiene sin credenciales: la URL debe ser pública HTTPS (sin redirecciones, no `file:`, sin bucles de retorno o direcciones privadas), cada descarga tiene un límite de 50 MiB y el resultado se materializa como un artefacto local que se sirve solo a través del punto final de administración autenticado. Esto es independiente del bucle de puente de imagen Responses (que permanece API solo clave).
- **Google Antigravity (CCA) fallback:** cuando no se configura ni un candidato directo OpenAI ni un proveedor con clave, `/v1/images/generations` (no `/images/edits`) vuelve al punto final Antigravity **Asistencia de código en la nube** usando el modelo `gemini-3.1-flash-image`. La reserva también se activa después de que falla la resolución de autenticación OpenAI (por ejemplo, una credencial ChatGPT caducada o faltante), no solo cuando no se configura ningún candidato OpenAI. Esto requiere `ocx login google-antigravity`; el token OAuth se envía solo al host del registro CCA anclado, nunca a una anulación de nivel de configuración `baseUrl`. La respuesta se devuelve en la misma forma `{created, data:[{b64_json}]}` que Codex espera.
- **Tampoco:** el proxy devuelve un error claro en lugar de un 404 genérico. Los proveedores enrutados (Cursor, Gemini, Kiro,...) no pueden servir el relé de la herramienta `image_generation`; si no desea que la herramienta se ofrezca en absoluto, desactívela en Codex con `codex features disable image_generation` ( `[features] image_generation = false` en `config.toml` ).

La declaración de la herramienta sigue viajando con la solicitud Responses del modelo. Para API-llave Responses proveedores, opencodex reduce la privacidad de Codex `image_gen` espacio de nombres a un nivel seguro
`image_gen__<inner-name>` alias (por ejemplo `image_gen__imagegen`) Cuando ese alias utilizable reemplaza la declaración de cliente, opencodex elimina un duplicado alojado `image_generation` declaración. Se mapea Llamada a la función explícita `image_gen` espacio de nombres antes de que Codex lo vea y codifique el llamar de nuevo cuando el historial posterior se reproduce de origen. Esto mantiene la generación de imágenes del lado del cliente llamable en upstreams compatibles con el público que reservan el espacio de nombres o rechazan los nombres de funciones punteadas. ChatGPT El modo de avance permanece intacto y mantiene su forma nativa Responses Lite.

Para una puerta de enlace personalizada compatible con OpenAI, configure un proveedor dedicado y selecciónelo solo para solicitudes de imágenes independientes:

```json
{
  "providers": {
    "custom-images": {
      "adapter": "openai-responses",
      "baseUrl": "https://gateway.example.com/v1",
      "authMode": "key",
      "apiKey": "${IMAGE_GATEWAY_API_KEY}"
    }
  },
  "images": {
    "provider": "custom-images",
    "timeoutMs": 300000
  }
}
```

El punto final personalizado debe aceptar `POST /v1/images/generations` y `/v1/images/edits` y devolver la forma de respuesta de Imágenes OpenAI esperada para Codex. La clave configurada por el proveedor reemplaza cualquier portador de llamada antes de la solicitud ascendente.

> **Nota:** Esto se refiere solo a la herramienta Codex `image_generation` (relé `/images/generations`). Gemini modelos que son capaces de producir imágenes en línea de forma nativa a través del adaptador `google` (vía `responseModalities: ["TEXT", "IMAGE"]`), independiente de este relé - ver [Adaptadores](/es/reference/adapters/#google).

Para un `hostname` sin bucle, Codex debe enviar la cabecera de autenticación API generada. Por lo tanto, el inyector utiliza un proveedor dedicado en su lugar:

```toml
# root keys
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

# appended at the end of the file
# Auto-injected by opencodex (undo: ocx restore)
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://your-host:10100/v1"
wire_api = "responses"
requires_openai_auth = true
env_key = "OPENCODEX_API_AUTH_TOKEN"
# supports_websockets = true   # only when config.websockets is true
```

Cuando OpenCodex posee enrutamiento, ambos modos escriben `$CODEX_HOME/opencodex.config.toml` como una configuración de referencia/retroceso. En loopback contiene las claves de raíz que puede combinar manualmente si se eliminó la inyección automática; en non-loopback contiene el formulario de proveedor dedicado. El modo de proveedor externo deja este perfil intacto.

:::caution
Claves de raíz como `openai_base_url`, `model_provider`, y `model_catalog_json` **debe** sentarse antes de la primero `[table]` cabecera. El inyector garantiza esa colocación, elimina su propio rancio / duplicado copia, y nunca sobrescribe una raíz propiedad del usuario `openai_base_url`; si existe, la sincronización actualiza el catálogo, pero informa que el enrutamiento no fue inyectado.
:::

<a id="shared-model-catalog"></a>

## Catálogo de modelos compartido

Codex CLI, TUI, App y SDK leen todos la misma casa Codex. opencodex resuelve ese directorio desde `CODEX_HOME`, volviendo a `~/.codex`, y gestiona:

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

En marcha macOS, opencodex comprueba la Codex Apps agrupadas CLI en `/Applications/ChatGPT.app` y luego `~/Applications/ChatGPT.app` después de selecciones explícitas, shims, PATH, instalaciones establecidas y el ejecutable bare `codex` fallback, requiere XML del paquete `Info.plist` identidad para ser `com.openai.codex`, y nunca reemplaza automáticamente una selección persistente ejecutable con un candidato de aplicación.

En WSL, si `CODEX_HOME` está desactivado y el directorio Linux `~/.codex` está ausente o no mantiene el estado Codex (`config.toml`, `auth.json`, `sessions`, `history.jsonl`), opencodex también comprueba un único inicio de escritorio Windows Codex en `/mnt/c/Users/*/.codex/config.toml`. Cuando existe exactamente un candidato, utiliza ese directorio para que el modo de servidor de aplicaciones WSL y el escritorio Windows Codex compartan los mismos archivos de configuración y autenticación. Establecer `CODEX_HOME` explícitamente para anular esta detección. Cuando Windows Codex Desktop ejecuta su aplicación-servidor dentro de WSL, envía el binario Linux Codex bajo esa casa como `bin/wsl/<hash>/codex`; opencodex lo encuentra allí cuando el PATH de servicio no tiene `codex`, después de cualquier entorno de ejecución y PATH configurados explícitamente.

Si existe la casa Codex pero Codex no ha escrito `config.toml` (por ejemplo, una nueva instalación de escritorio que nunca se ha iniciado sesión en OpenAI), opencodex crea un `config.toml` allí y continúa. Si el directorio principal en sí no existe, inicie Codex una vez para que lo cree o establezca `CODEX_HOME`.

Codex puede mantener el estado del subproceso respaldado por SQLite en un directorio separado. Las operaciones de la historia OpenCodex usan la misma precedencia que Codex: raíz `sqlite_home` en `config.toml`, luego `CODEX_SQLITE_HOME`, luego el efectivo `CODEX_HOME`. SQLite hogares resolver desde el directorio de trabajo actual. Cuando un `CODEX_SQLITE_HOME` explícito está presente durante la instalación o reparación del servicio, el lanzador durable almacena su ruta absoluta de tiempo de instalación de modo que el proxy de segundo plano continúa direccionando la misma base de datos. Si `config.toml` o su clave raíz `sqlite_home` está ausente, OpenCodex continúa en el entorno / casa. Si el archivo no se puede leer o analizar, o la clave está presente pero en blanco o no una cadena, la resolución -home SQLite se detiene en lugar de arriesgar las operaciones del historial contra una base de datos diferente.

En Windows, un shell de Orca puede establecer `CODEX_HOME` y `ORCA_CODEX_HOME` en el hogar en entorno de ejecución incluido de Orca, mientras que la aplicación ChatGPT / Codex todavía lee `%USERPROFILE%\\.codex`. `ocx status` y `ocx doctor` advierten sobre este desajuste exacto y las rutas de destino redactadas por impresión. Si se instaló un servicio en segundo plano desde ese shell de Orca, desinstálelo primero desde el shell original, luego configure `CODEX_HOME` en el inicio de la aplicación, desactive `ORCA_CODEX_HOME`, vuelva a ejecutar la sincronización / restauración e instale el servicio nuevamente.

En el modo de proveedor dedicado, `requires_openai_auth = true` mantiene Codex App / TUI superficies cerradas por cuenta alineadas con Codex nativo. opencodex también sirve `/v1/responses` sobre WebSocket. El proveedor dedicado anuncia `supports_websockets = true` solo cuando `"websockets": true`; en loopback Codex 's proveedor incorporado puede intentar WebSocket primero, y un proxy deshabilitado devuelve `426` así Codex cae de nuevo a HTTP / SSE.

El proxy admite hasta 128 conexiones Responses WebSocket orientadas al cliente. Cuando una nueva conexión encuentra las 128 ranuras ocupadas, cierra la conexión inactiva menos recientemente utilizada para hacer espacio. Las conexiones con una respuesta activa, una herramienta de cliente pendiente o resultados de aprobación, una sesión de dirección/inyección nativa o una salida almacenada en búfer están protegidas. Si no se puede liberar ninguna conexión inactiva, la nueva conexión recibe la respuesta de capacidad `503` existente. Un cliente reclamado puede volver a conectarse para solicitudes posteriores utilizando el manejo de continuación existente. Esto sucede solo bajo presión de conexión, no necesita configuración y no cambia las conexiones de voz o la reutilización de la conexión ascendente.

Si una continuación canónica hacia adelante ChatGPT hace referencia a un estado de repetición local caducado o faltante, opencodex devuelve `previous_response_not_found` antes de enviar cualquier cosa aguas arriba. El cliente Codex de WebSocket reconoce este error y puede volver a conectarse con su contexto completo retenido, incluyendo llamadas de herramientas completadas y sus resultados, dentro de su presupuesto de reintento de flujo normal. Por lo tanto, una tarea inactiva no necesita una tarea nueva únicamente porque la caché de reproducción del proxy expiró. El estado de continuación reproducido se conserva durante 24 horas y permanece limitado por su memoria, disco y límites de entrada existentes; esto no recupera el historial que el cliente ya no tiene. HTTP clientes deben manejar el error explícitamente y volver a enviar su contexto completo sin `previous_response_id`. Volver a intentar solo el mismo ID no puede recuperar el estado faltante.

El mismo rechazo se aplica cuando el estado referenciado pertenece a un ámbito de tarea cliente diferente, incluso cuando la nueva solicitud parece llevar entrada completa. El proxy no puede probar que la entrada está completa, por lo que no elimina silenciosamente `previous_response_id` ni revela si existe un estado coincidente. Vuelva a intentar con la conversación completa y omita `previous_response_id`; los ámbitos coincidentes y las continuaciones heredadas donde ambos ámbitos están ausentes o en blanco continúan reproduciéndose normalmente.

La misma señal de recuperación se aplica a cada destino enrutado, porque solo el paso a través nativo Responses puede responder a un giro cuya historia perdió este proxy: reenvía `previous_response_id` a un backend que almacenó la cadena. Cada uno de los otros cables reconstruye la conversación a partir de la propia entrada de cada solicitud, por lo que una expansión perdida allí enviaría el giro actual solo y perdería silenciosamente la conversación. Eso incluye los tres que parecen con estado: Devin vuelve a enviar toda la conversación a cada paso, la referencia de punto de control de Cursor vive en la misma tienda vencida y vuelve a la reproducción completa sin ella, y Kiro reconstruye su historial de conversaciones a partir de los turnos en que se entregó. También se aplica a los proveedores enrutados Responses configurados con `statelessResponses: true`, y a las solicitudes enrutadas donde una herramienta personalizada se redujo a una función pero un resultado delta no tiene llamada local para establecer su tipo original. La reproducción completa conserva la llamada, el resultado y el razonamiento juntos; opencodex no adivina el tipo de resultado ni lo descarta. Los proveedores estatales todavía resuelven la función nativa y las continuaciones personalizadas nativas por sí mismos. Estas comprobaciones siguen el protocolo de cable seleccionado y las declaraciones de la herramienta, no el nombre del modelo. Para una puerta de enlace que no puede resolver los ID de respuesta almacenados, habilite `statelessResponses` en ese proveedor; otros proveedores mantienen sus valores predeterminados.

<a id="client-side-compaction-opt-in"></a>

### Compactación del lado del cliente (opcional)

El enrutamiento de bucle de retorno autenticado normalmente mantiene Codex en su identidad de proveedor `openai` incorporada. Eso preserva la identidad del hilo nativo, pero también hace que Codex solicite la compactación remota nativa. Cuando un proveedor enrutado no puede devolver una burbuja de compactación nativa, OpenCodeX almacena el resumen en su propio sobre `ocx1:` / `ocx2:`. Native ChatGPT no puede verificar ese sobre si OpenCodeX se elimina más tarde de la ruta de la solicitud.

En una ruta de bucle de retorno autenticada, habilite la compactación en el lado del cliente para mantener el enrutamiento de subagentes V2 al tiempo que evita nuevos resúmenes de compactación `ocx1:` / `ocx2:`. Las rutas no loopback y API-key conservan su comportamiento de proveedor y autenticación existente:

```bash
ocx system settings --client-compaction on   # or "codexClientCompaction": true in config.json
ocx sync                                     # rewrites the active config (default: ~/.codex/config.toml); restart Desktop
```

El ajuste predeterminado es off. Para el enrutamiento de bucle de retorno autenticado, OpenCodeX selecciona su formulario de proveedor dedicado existente con `requires_openai_auth = true`. Si `codexDesktopAuthless` también está habilitado, esa configuración de compatibilidad más fuerte tiene prioridad y escribe `requires_openai_auth = false`:

```toml
model_provider = "opencodex"

[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
requires_openai_auth = true
```

Codex luego posee compactación y almacena un resumen de texto plano portátil en lugar de un nuevo sobre OpenCodeX. La solicitud de compactación sigue enrutando a través de OpenCodeX y puede consumir cuota en el proveedor seleccionado. Las solicitudes de subagentes V2 mantienen su selección de proveedores existente y la contabilidad de cuotas. La compactación del lado del cliente no cambia la entrega de texto sin formato, el paso de tareas encriptadas a través de `allowEncryptedV2AgentTasks` o el comportamiento de recuperación y recuperación configurado.

Esta preferencia solo afecta las compactaciones futuras, y no reescribe ninguna carga útil `ocx1:` / `ocx2:` existente en ninguna configuración, así que use el flujo de trabajo de recuperación de historial explícito para un subproceso que lo necesite.

Si se vuelven a etiquetar los metadatos del historial de reanudación depende de la forma que tome la inyección. Por sí solo, en un enlace de bucle de retorno autenticado, la compactación del lado del cliente no vuelve a etiquetar nada: mantiene la anulación de raíz, como se describe a continuación. Habilitado junto con `codexDesktopAuthless`, o en un enlace que no sea de bucle invertido, el formulario más fuerte gana y esos formularios se comportan exactamente como lo hacen hoy, incluido su etiquetado hacia adelante existente del historial de reanudación con originales respaldados para su restauración.

Volver de una de esas formas a Diseño B simple migra los hilos reetiquetados hacia atrás. Apagar `codexDesktopAuthless` mientras se deja la compactación del lado del cliente encendido no lo hace: eso aterriza en la forma de solo compactación, que se salta la unidad de historial, por lo que los hilos ya etiquetados `opencodex` mantienen esa etiqueta. Todavía llegan a este proxy, a través de la tabla del proveedor en lugar de la anulación de la raíz.

En la forma de solo compactación, los hilos existentes siguen funcionando porque la inyección mantiene la raíz `openai_base_url` junto a la mesa del proveedor. Los nuevos hilos predeterminados a `opencodex` y obtener compactación del lado del cliente, mientras que un hilo ya etiquetado `openai` todavía resuelve a Codex 's proveedor integrado - que la anulación retenida todavía apunta a este proxy. Sin él, ese hilo se reanudaría contra OpenAI directamente, llevando el enrutamiento configurado con él. Las formas authless y non-loopback no pueden usar la clave raíz, por lo que siguen reetiquetando.

Esa garantía cubre la anulación que administra OpenCodeX. Una raíz `openai_base_url` que escribió usted mismo nunca se reemplaza, y en ese caso el proveedor integrado mantiene el destino que eligió, por lo que un hilo etiquetado `openai` sigue su configuración en lugar de este proxy. Desactivar el ajuste y la sincronización elimina la tabla y vuelve a la anulación de diseño B simple, a menos que la admisión `codexDesktopAuthless` o no loopback aún requiera el formulario de tabla de proveedor; esos dos formularios no pueden usar la clave raíz y no se modifican.

Mientras el modo está activo, la anulación de banda lateral de voz en tiempo real (`experimental_realtime_ws_base_url`) no se inyecta - el formulario dedicado de tabla de proveedores no puede llevarlo - por lo que Codex Desktop Voice utiliza su punto final nativo en lugar del proxy.

<a id="emergency-compaction-model-opt-in"></a>

### Modelo de compactación de emergencia (opcional)

Cuando OpenCodeX traduce la compactación remota para proveedores como Google, reemplaza las imágenes de giros anteriores con notas cortas de reapertura si existe una respuesta final explícita posterior. El análisis existente y las referencias de archivo permanecen en la entrada de resumen; las imágenes después de la última respuesta final permanecen disponibles para el trabajo no resuelto. Se conservan las historias sin fase y solo comentarios. Esto afecta solo a la solicitud de compactación, no a los archivos adjuntos almacenados o a las solicitudes de modelo ordinarias. Reduce la entrada de visión repetida, pero no garantiza que un largo historial de texto se ajuste al límite de contexto del proveedor.

`compactionRecovery` deja la compactación inicial en la ruta seleccionada de la conversación. Permite un intento de emergencia solo después de un fallo de compactación previo a la salida soportado. Está separado de `compactionRouting`, que elige otro modelo antes de que comience la compactación, y de `codexClientCompaction`, que cambia la forma del proveedor de Codex.

```json
{
  "compactionRecovery": {
    "enabled": true,
    "model": "provider/emergency-model",
    "allowDevinInvalidArgument": false
  }
}
```

Utilice un modelo autorizado configurado independientemente con suficiente contexto para la entrada fallida. La habilitación de la recuperación permite al proveedor de ese modelo recibir el historial de compactación y cobrar por el intento adicional cuando se ejecuta la recuperación; las compactaciones exitosas ordinarias no incurren en ninguna llamada adicional. La opción está desactivada cuando está ausente o desactivado. La administración autenticada existente API acepta este bloque a través de `PUT /api/settings`; envíe `compactionRecovery: null` para eliminarlo. Una edición de archivo directa debe seguir el flujo de trabajo normal de configuración de stop-proxy. Esta configuración no cambia el inicio de sesión, el modelo ordinario de la conversación, el ID de proveedor de Codex o el compositor de escritorio.

La recuperación no se reproduce después de la cancelación, la salida semántica, los efectos secundarios de la herramienta, un presupuesto de envío agotado o una autenticación, admisión o rechazo de políticas. Los errores genéricos `400` no habilitan la recuperación. Devin responde a un historial de gran tamaño con una presalida opaca `invalid_argument`; cuando el tamaño estimado de la solicitud está en o cerca de la ventana de entrada del modelo, el adaptador lo informa como `context_length_exceeded` en su lugar, por lo que Codex compacta en un giro ordinario y una compactación fallida califica como un desbordamiento de contexto sin ninguna opción específica de Devin. La estimación utiliza descripciones de herramientas después de la desinfección y truncamiento de Cognition, que coinciden con la solicitud enviada aguas arriba. Una solicitud más pequeña que obtiene el mismo código permanece como `400` simple. El estuche `allowDevinInvalidArgument` por separado cubre solo los `invalid_argument` fallos restantes, y solo en una solicitud de compactación identificada. El intento de emergencia comparte el presupuesto de envío de la solicitud original y nunca comienza un segundo intento de recuperación.

La compactación encriptada nativa está fuera de esta ruta de recuperación: se conserva su error original. No hay modo de truncamiento local automático. Una respuesta aceptada no es prueba de que una larga conversación retuvo sus objetivos; verifique el siguiente turno en el modelo original antes de tratar un resumen de emergencia como una tarea recuperada.

<a id="authless-codex-desktop-opt-in"></a>

### Authless Codex Escritorio (opcional)

En **Dashboard → Visión de conjunto**, **Abrir Codex sin iniciar sesión** controla esta preferencia opt-in existente. El valor predeterminado es **apagado** cuando la configuración está ausente o es falsa; un `codexDesktopAuthless: true` explícito existente permanece habilitado. El panel de control guarda la preferencia y ejecuta una sincronización completa. Reinicie el escritorio Codex después de cambiarlo. Si falla la sincronización, la preferencia guardada permanece y el panel de control muestra el error; reintente **Sincronización** antes de reiniciar. Las funciones de escritorio controladas por cuenta pueden no estar disponibles cuando se habilitan. Las credenciales ascendentes, la elegibilidad local, la autenticación de admisión remota y la configuración de la puerta de enlace propiedad del usuario conservan sus requisitos existentes.

Codex Desktop muestra su pantalla de inicio de sesión ChatGPT cada vez que el proveedor activo requiere OpenAI auth. Si su configuración OpenCodex nunca usa credenciales ChatGPT (solo proveedores enrutados o un `chatgpt.com` bloqueado), puede optar por salir de esa puerta:

```bash
ocx system settings --desktop-authless on    # or "codexDesktopAuthless": true in config.json
ocx sync                                     # rewrites ~/.codex/config.toml; restart Desktop
```

Con el interruptor activado, un enlace de bucle retro inyecta el formulario de proveedor dedicado en lugar de la anulación raíz `openai_base_url`:

```toml
model_provider = "opencodex"

[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
requires_openai_auth = false
```

El escritorio se inicia sin un inicio de sesión y las rutas de cada turno a través del proxy. La configuración sobrevive `ocx start`, reinicio, `ocx sync` y `ocx ensure`; al apagarlo (`--desktop-authless off`) hace que la siguiente sincronización restaure la forma de bucle de retorno predeterminada y `ocx restore` la despoja como cualquier otro enrutamiento inyectado. Qué esperar mientras está encendido:

- ChatGPT -gated El cromo de escritorio (cuenta, uso, modo rápido) permanece oscuro: Codex deriva esas superficies del requisito de autenticación del proveedor.
- Los nuevos hilos se etiquetan con el proveedor `opencodex`, como en un enlace no loopback, y el historial se maneja de la misma manera.
- Las versiones de escritorio que filtran el selector de modelo contra una lista de permisos solo nativa también pueden mostrar un selector vacío o `Custom` en este modo; las solicitudes aún usan el modelo configurado. Conjunto `model = "<provider>/<id>"` en `config.toml` como se describe en [Servidores remotos de escritorio](/es/guides/codex-app-models/#desktop-remote-servers).

Esto solo cambia la puerta de inicio de sesión del escritorio. Non-loopback obliga a mantener `requires_openai_auth = true` y la credencial de admisión `env_key` independientemente del interruptor; nunca expone un oyente OpenCodex sin autenticación.

<a id="thread-identity-and-history"></a>

## Identidad e historia del hilo

El formulario de loopback predeterminado mantiene los nuevos hilos etiquetados con el proveedor nativo `openai` de Codex, por lo que el historial de reanudación normal no necesita volver a mapear. La sincronización y la restauración aplican solo un manifiesto de copia de seguridad coincidente y restauran el proveedor, la fuente y el marcador de eventos originales exactos de cada subproceso. Una fila desnuda de `opencodex` sin manifiesto se deja sin cambios; use `ocx recover-history --legacy-openai --yes` solo cuando tenga la intención explícita de forzar ese reetiquetado heredado. El comando es intencionalmente amplio: reescribe cada hilo con un mensaje de usuario actualmente etiquetado como `opencodex` a `openai`, normaliza `exec` a `cli` y establece el marcador de evento, incluido el historial legítimo de proveedores dedicados. Haga una copia de seguridad del estado y úselo solo cuando se pretenda ese alcance completo. El modo de proveedor dedicado sin loopback sigue reflejando el historial bajo el proveedor `opencodex` mientras está activo y restaura los metadatos de copia de seguridad al salir. Establecer `syncResumeHistory: false` para dejar la historia intacta.

<a id="model-catalog-sync"></a>

## Sincronización de catálogo de modelos

Codex muestra modelos de un catálogo en el disco (`$CODEX_HOME/opencodex-catalog.json` de forma predeterminada). Al inicio y en `ocx sync`, opencodex:

1. **Respalda** el catálogo prístino una vez a `~/.opencodex/catalog-backup.json` (por lo que la presentación es reversible).
2. **Muñecos** catálogos de modelos en vivo de los proveedores elegibles (en caché de 5 min; vuelve a la última buena lista, luego configuró `models[]`). La autenticación directa no tiene un punto final modelo, y Cursor utiliza su RPC `GetUsableModels` en lugar de `/models`.
3. **Combinaciones** enrutado modelos en entradas como namespaced (`provider/model`), clonado de una plantilla de catálogo nativo Codex por lo que Codex 's estricto analizador sintáctico los acepta.
4. **Filtros** `config.disabledModels` y la lista de permisos `selectedModels` no vacía de cada proveedor.
5. **Re-rangos** así que los modelos destacados ordenan primero (ver más abajo), luego escribe el catálogo fusionado de nuevo.

Las entradas del catálogo enrutado también obtienen su identidad GPT-5 reescrita al nombre del modelo ascendente real. Los controles de razonamiento provienen de metadatos de proveedor/modelo en la escalera `low | medium | high | xhigh |
max | ultra` de Codex; los valores no compatibles se asignan o se fijan antes de la solicitud ascendente.

<a id="coordinator-diagnosis-and-recovery"></a>

### Diagnóstico y recuperación del coordinador

Las escrituras de configuración/historia nativas usan un coordinador por usuario SQLite con la clave canónica `CODEX_HOME`. Si un proceso termina en la ventana de creación inicial de SQLite, puede permanecer un coordinador de cero bytes aunque no contenga ninguna fila de transición autorizada. `ocx doctor` informa la ruta exacta del coordinador y distingue los estados de cero bytes, sin versionar, sin filas, válidos, inseguros e ilegibles sin crear SQLite sidecars. La sincronización automática tolera solo un archivo de byte cero de identidad estable que se ha establecido durante al menos un segundo y cuya instantánea inmutable SQLite tiene la versión cero sin tablas; un archivo de byte cero recién creado permanece en la ruta del coordinador bloqueado.

Para un estado que el médico prueba que es un remanente de creación de cero bytes, detenga el proxy / servicio OpenCodex y ejecute:

```bash
ocx doctor --recover-zero-byte-coordinator --yes
ocx sync
```

La recuperación mueve el archivo de byte cero todavía idéntico a una ruta del mismo directorio `.zero-byte-backup-*`; no elimina la evidencia ni adopta el estado de ruta heredado. Rechaza un proxy en ejecución, bloquea la contención, vínculos simbólicos / puntos de reparación, propiedad extranjera, archivos cambiados, cada base de datos no vacía y cualquier coordinador que ya tenga una fila autorizada. El filtrado del renderizador de escritorio es una capa separada: un catálogo y un coordinador correctos no evitan por sí mismos la lista de permisos del modelo de aplicación Codex.

<a id="routed-local-tools"></a>

### Herramientas locales enrutadas

Las filas de catálogo enrutadas no nativas usan `tool_mode: "code_mode_only"`. Esto permite que Codex exponga su punto de entrada oficial `exec` y las herramientas anidadas MCP, incluido el navegador y el uso del ordenador, mientras que opencodex solo enruta la llamada de función ordinaria del modelo. La ejecución de la herramienta, los permisos y las confirmaciones permanecen locales en Codex; opencodex no implementa un segundo navegador o ejecutor de control de escritorio.

Para los proveedores de claves Responses que no aceptan la gramática de herramientas personalizadas `exec` de Codex, opencodex codifica esa declaración y su historial como una herramienta de función ascendente, luego restaura el ciclo de vida de llamadas a funciones transmitidas a `custom_tool_call` antes de que Codex lo vea. El enrutamiento directo nativo OpenAI y la herramienta personalizada `apply_patch` soportada permanecen sin cambios.

Si un modelo encaminado envía un parche completo a medida que la entrada `exec` de modo de código completa, opencodex lo convierte a la llamada anidada `tools.apply_patch` antes de que los eventos de finalización de herramienta alcancen Codex. Las llamadas personalizadas nativas y las llamadas a funciones convertidas usan la misma regla de finalización; las vistas previas de parches se mantienen mientras no se resuelve su forma ejecutable. JavaScript que simplemente contiene texto de parche y cargas útiles personalizadas nativas no relacionadas permanecen sin cambios.

Un modelo enrutado también puede enviar erróneamente un objeto de argumento de shell como `{"cmd":"git status --short"}` al modo de código `exec`. Para un catálogo de modo de código verificado, opencodex convierte un objeto de shell inequívoco en `tools.exec_command(...)` JavaScript y reenvía su salida a través de `text(...)`. Las opciones de shell se conservan y Codex sigue ejecutando y autoriza el comando. Los campos de reserva de JavaScript válidos, los objetos ambiguos y los espacios de nombres de herramientas no relacionados no se convierten. Esta reparación de compatibilidad no pasa por alto los límites de velocidad del proveedor ni cambia la directiva de reintento configurada.

La misma reparación cubre a los ayudantes de la meta. Un modelo encaminado que llama `create_goal`, `get_goal`, o `update_goal` (o una ortografía prefijada `default.` de uno) como una herramienta mientras el catálogo declara sólo el código-modo `exec` tiene la llamada convertida en la llamada coincidente `tools.<helper>(...)` dentro `exec`. Un catálogo que declara genuinamente la herramienta de objetivo desnudo la mantiene, y un catálogo que declara ni la herramienta ni `exec` todavía rechaza la llamada como no declarada.

En las conversiones enrutadas con un catálogo `exec` de código de forma libre verificado, las llamadas estructuradas enviadas directamente al `mcp__<server>__<tool>` (incluido un prefijo `default.` añadido por el proveedor) también se envuelven como llamadas de herramienta de host anidada. Esto evita un reintento causado únicamente por un modelo que omite la envoltura `exec`. Las herramientas MCP declaradas explícitamente mantienen su comportamiento normal; una función JSON ordinaria llamada `exec` no habilita esta reparación. Las herramientas desconocidas aún fallan en el host. Los registros de llamada de herramienta impresos como texto de respuesta ordinario no se ejecutan según esta regla de compatibilidad.

Para los giros enrutados Responses, una directiva explícita de implementación de herramientas también rechaza las llamadas a herramientas de cliente si el catálogo de herramientas declaradas de la solicitud no está disponible. Un catálogo declarado vacío rechaza cada llamada a la herramienta del cliente; Chat y Anthropic clientes conservan su propia responsabilidad de validación de herramientas.

A los giros en modo código encaminados también se les dicen las reglas del host para los ayudantes anidados antes de la primera llamada: `tools.apply_patch` toma una cadena que se abre y se cierra con las líneas de marcador de parche desnudas, el aislado no tiene `import`, y los comandos de ejecución larga se sondean a través de `write_stdin`. Cuando un resultado ejecutivo en modo código en la ruta nativa Responses, Kiro o Cursor todavía lleva uno de los mensajes de fallo del host, opencodex añade una pista de una línea que nombra la regla. Este cambio no reescribe el código del modelo o su texto de parche.

Las llamadas a la función Responses enrutadas ordinarias también usan el esquema de parámetros declarado original en completion: los floats integrales en campos enteros y los números integrales en campos de solo cadena son normalizado, mientras que las fracciones y las uniones numéricas permanecen sin cambios. Un explícitamente vacío completado Argumentar cadena se convierte en `{}`. Los eventos finales y el historial de continuación almacenado localmente están de acuerdo. Las ortografías de espacio de nombres punteadas inequívocas se restauran al espacio de nombres declarado y al nombre de la herramienta.

El proveedor seleccionado debe admitir llamadas de función/herramienta. Un proveedor de solo texto sin soporte de llamada de herramienta no puede usar `exec`, Browser o Computer Use. Las filas nativas OpenAI mantienen su modo de herramienta ascendente sin cambios.

Después de que `ocx sync` cambie estos metadatos, reinicie la aplicación Codex y abra una nueva tarea. Los procesos y las tareas existentes del servidor de aplicaciones pueden conservar el catálogo y el plan de herramientas que cargaron al iniciarse.

<a id="inline-visualizations-with-routed-models"></a>

### Visualizaciones en línea con modelos enrutados

El complemento Visualizar de la aplicación Codex le pide al modelo que responda con una referencia envuelta en caracteres de uso privado (U + E200... U+E201). Algunos proveedores eliminan esos caracteres antes de que el modelo los vea, cada ruta Claude que revisamos lo hace, por lo que el modelo solía responder con una línea desnuda `visualize{"path":…}` que la aplicación Codex imprimió como texto.

opencodex reescribe esas referencias en la directiva que la propia aplicación renderiza, `::codex-inline-vis{path="/absolute/path/chart.html"}`, en el texto de conversación enviado a los modelos enrutados. Cualquier modelo puede leer y repetir esa forma, por lo que la visualización se renderiza en línea. Las solicitudes de pases nativas OpenAI se reenvían sin cambios. Las respuestas que ya estaban guardadas en la forma desnuda `visualize{…}` permanecen como están; solicite la visualización nuevamente en una nueva respuesta.

<a id="custom-model-display-names"></a>

### Nombres de visualización de modelo personalizados

Un modelo personalizado puede llevar un **mostrar nombre** legible por humanos que anula la etiqueta Codex muestra en su selector de modelo, sin cambiar nada acerca de cómo se enruta el modelo. El nombre de visualización se asigna solo al campo `display_name` de la entrada del catálogo: la tira de enrutamiento (`<provider>/<model>`), el orden de colisión de alias, el proveedor y los nombres de marketing nativos OpenAI se dejan intactos.

Agregue un nombre de visualización del CLI (el proxy sincroniza el catálogo de inmediato cuando está activo):

```bash
ocx models add deepseek deepseek-v4 --display-name "DeepSeek V4" --context-window 128000
```

Para proveedores personalizados, omitir una ventana de contexto explícito permite que el catálogo use el [reglas de respaldo de ventana contextual](/es/reference/configuration/providers/#context-windows-on-custom-providers). Las estimaciones de ID de modelo se aplican solo cuando el proveedor establece `inferContextWindow: true`; establezca una ventana explícita o un límite de contexto cuando el relé admita menos que la ventana del proveedor del modelo.

Los clientes remotos Codex pueden obtener el mismo catálogo generado con una clave ordinaria **plano de datos**: la misma credencial que ya usan para `/v1/responses`, no un token de administración:

```bash
dest="${CODEX_HOME:-$HOME/.codex}/opencodex-catalog.json"
tmp="$(mktemp "${dest}.XXXXXX")"
curl -fsS -H "x-opencodex-api-key: $OPENCODEX_API_AUTH_TOKEN" \
  "https://proxy.example.com/v1/catalog" > "$tmp" \
  && mv "$tmp" "$dest"
ocx sync-cache
```

La respuesta es el documento sin procesar `opencodex-catalog.json` (sin credenciales de proveedor). Cuando está disponible, el encabezado `x-opencodex-codex-version` informa la versión en entorno de ejecución Codex en el servidor para que los clientes puedan detectar el sesgo de versión.

`GET /v1/catalog` existe para que la lectura de una lista de modelos no cueste un token de administración. Es de solo lectura (`GET` y `HEAD`), acepta `x-opencodex-api-key`, un token portador, o `x-api-key`, y sirve exactamente los mismos bytes que la ruta de gestión. Responses llevar un fuerte `ETag` - pasarlo de nuevo como `If-None-Match` para revalidar y obtener un `304` en lugar del documento completo - y `Cache-Control: private, no-cache`, ya que el cuerpo se sienta detrás de una credencial.

Una clave de plano de datos admitida aquí gana **nada** en el plano de administración: `/api/catalog` y cada otra ruta `/api/*` aún requiere el token de administración o una sesión de tablero. La ruta anterior `/api/catalog` sigue funcionando sin cambios para el panel de control y para los scripts que ya tienen un token de administración.

También puede configurarlo o editarlo a través de la administración API (`POST /api/custom-models`, `PUT /api/custom-models/<id>` con una cadena `displayName`) y el panel de control web. Un `/` es rechazado porque colisionaría con el separador de balas enrutadas.

El nombre que se muestra es **solo pantalla y estable a través de la regeneración**. Cada `ocx sync` y las re-derivas de actualización de catálogo enrutaron las entradas desde `config.json` (incluyendo `customModels`), por lo que el nombre configurado se vuelve a aplicar en lugar de volver a la pista enrutada. Un reinicio del servicio administrado también intenta esta sincronización poco después de que el proxy se une. Si la sincronización de arranque de mejor esfuerzo falla, por ejemplo durante un inicio de sesión sin conexión, el catálogo previamente persistente se conserva y el siguiente `ocx sync` exitoso vuelve a aplicar el nombre configurado. Los nombres nativos aguas arriba genuinos (p. `gpt-5.6-sol` → "GPT-5.6-Sol") provienen de la instantánea de aguas arriba anclada y nunca se reemplazan por un nombre de visualización personalizado.

<a id="external-provider-managers"></a>

### Gerentes de proveedores externos

Si `config.toml` ya selecciona un proveedor distinto de `openai` o `opencodex`, OpenCodex deja el archivo sin cambios y omite escrituras de perfil, actualización de catálogo/caché y restauración de metadatos de historial Codex tanto inmediata como de fondo. Las herramientas que administran un proveedor personalizado a menudo etiquetan las sesiones existentes con ese ID del proveedor; reemplazar el ID activo puede hacer que esas sesiones intactas desaparezcan de la vista del historial de Codex. La misma protección se aplica a un proveedor externo seleccionado por un perfil raíz heredado.

Mientras que un proveedor externo posee `config.toml`, los ajustes informan que `GET /api/settings` y `ocx system settings --json` devuelven una descripción de los switches de compresión de cliente y de escritorio, y el requisito de inicio de sesión Codex, según lo controlado por ese proveedor en lugar de mostrar el estado efectivo que produciría OpenCodex. Al cambiar cualquiera de los switches se sigue almacenando la preferencia, pero `config.toml` no se reescribe; el valor almacenado tiene efecto si cambia Codex de nuevo a un proveedor OpenCodex administra y vuelve a ejecutar `ocx start`.

Si `config.toml` existe pero no se puede leer (permisos, o una carrera de borrado de la lectura), el mismo informe retiene los valores efectivos y la respuesta de inicio de sesión como indeterminada en lugar de mostrar el estado OpenCodex computaría localmente. El registro apply mantiene esa explicación, incluso en un guardado cuya puerta de inyección ya está cerrada por una integración deshabilitada o un proxy detenido, y lo marca como reintentable, por lo que una lectura posterior de `ocx system settings --json` informa la respuesta establecida una vez que el archivo vuelve a ser legible. Con la integración Codex deshabilitada, `ocx sync` es solo para catálogo y no puede aplicarla.

Mantenga una herramienta como propietario de la configuración del proveedor Codex. Para usar OpenCodex detrás de un administrador de proveedores existente, apunte a ese proveedor en `http://127.0.0.1:10100/v1` con Responses passthrough (`wire_api = "responses"` en Codex TOML), no Chat Completions translation. Cuando el proxy API auth está habilitado, también pase `x-opencodex-api-key` de `OPENCODEX_API_AUTH_TOKEN`, que coincide con el formulario de proveedor de no retorno de bucle anterior. Para permitir que OpenCodex inyecte el enrutamiento directamente, primero conmuta Codex de nuevo a su proveedor `openai` incorporado y elimina cualquier raíz `openai_base_url` propiedad del usuario, luego vuelve a ejecutar `ocx start`.

<a id="explicit-tool_search-troubleshooting"></a>

### Explícito `tool_search` solución de problemas

Las herramientas locales enrutadas tienen dos rutas de descubrimiento distintas. En el modo de código enrutado normal, Codex puede exponer diferido MCP/herramientas de la aplicación a través del oficial `exec` herramienta `tools` global y `ALL_TOOLS`; ese camino no requiere que el modelo vea o llame `tool_search`.

Por separado, `tool_search` es una superficie de descubrimiento Codex ejecutada por el cliente. No es un indicador de características OpenCodex, y un valor ascendente `tool_choice: "auto"` no lo crea ni lo habilita. OpenCodex puede retransmitir la superficie explícita solo cuando Codex ya incluyó una declaración como esta en la solicitud Responses entrante:

```json
{
  "tools": [
    { "type": "tool_search", "description": "Load deferred tools" }
  ]
}
```

En el caso de los modelos locales/de chat enrutados, OpenCodex expone esa declaración como una función normal denominada `tool_search`. Si el modelo lo llama, OpenCodex convierte la llamada a un Responses `tool_search_call`; Codex ejecuta la búsqueda y proporciona las definiciones de herramienta resultantes en un `tool_search_output` posterior. Las definiciones cargadas de esa manera están disponibles en el siguiente turno del modelo.

Compruebe el límite de fallos antes de cambiar la configuración del proveedor:

1. **No `type: "tool_search"` en la solicitud entrante:** el cliente activo Codex/sesión no anunció la superficie explícita `tool_search`. OpenCodex no puede inventar esa declaración. Esto no significa que las herramientas normales de modo de código no estén disponibles: compruebe si el modelo enrutado puede usar `exec` y descubra primero la herramienta anidada necesaria a través de `tools` / `ALL_TOOLS`.
2. **La declaración entrante existe, pero ninguna función `tool_search` alcanza la solicitud enrutada:** captura solo el tipo de herramienta/lista de nombres redactados y abre un error OpenCodex. Nunca adjunte el portador, el identificador de cuenta, la entrada de conversación, los encabezados completos o el cuerpo completo de la solicitud.
3. **La solicitud enrutada contiene `tool_search`, pero el modelo local nunca lo llama:** el relé está funcionando. Utilice un modelo/plantilla con llamadas a funciones confiables e instrucciones que le indiquen explícitamente que busque una herramienta diferida que necesite. LM Studio `tool_choice: "auto"` permite el uso de herramientas; no obliga al modelo a llamar a esta función.
4. **Una llamada se emite repetidamente o las herramientas cargadas nunca se vuelven utilizables:** capturan los tipos de artículo `tool_search_call` / `tool_search_output` redactados y los identificadores de llamada. OpenCodex conserva ambos en la historia, por lo que el modelo debería ver la búsqueda completa en lugar de emitirla para siempre.

Vea [El analizador y el puente](/es/reference/architecture/#the-parser) para la asignación explícita de cables. No hay ninguna configuración de nivel de proveedor que pueda agregar una declaración `tool_search` faltante; el descubrimiento de modo de código ordinario sigue siendo una ruta separada.

<a id="cache-read-diagnostics"></a>

### Diagnósticos de lectura en caché

Establezca `OPENCODEX_CACHE_DEBUG=1` antes de iniciar el proxy para escribir un registro de diagnóstico por solicitud finalizada en `<config-dir>/cache-debug.jsonl`. El interruptor está desactivado de forma predeterminada; configúralo en `0` o retíralo para desactivar la captura. El archivo es propietario solamente (`0600`) en el directorio de configuración endurecido y rueda después de 200 líneas, reteniendo el 100 más nuevo.

Cada registro JSONL contiene el protocolo, el proveedor/modelo enrutado, la presencia y procedencia del contador de caché, las etiquetas de igualdad local de proceso para la cuenta, la clave de caché de solicitud y los encabezados de sesión permitidos, además de huellas dactilares ordenadas para instrucciones, herramientas y bloques de mensaje/entrada. Las secciones de prefijo retienen como máximo 128 etiquetas e identifican solo la primera sección/índice divergente. El diagnóstico nunca almacena mensajes de texto, nombres de herramientas, encabezados sin procesar, identificadores de caché/sesión/cuenta sin procesar o una etiqueta duradera derivada de ellos. Su clave HMAC aleatoria se crea al inicio del proceso, separada de otras claves de depuración, y nunca persiste; las etiquetas por lo tanto comparan valores solo dentro de un proceso proxy.

<a id="catalog-troubleshooting"></a>

### Solución de problemas de catálogo

Si falta un modelo de Codex, o el orden/visibilidad del catálogo se ve mal, compruebe en orden:

1. **`selectedModels`** en el proveedor: una lista de permisos no vacía expone solo esos identificadores a Codex; vacía u omitida expone todos los modelos descubiertos. Un id que no está en la lista de permisos nunca llega al catálogo.
2. **`disabledModels`** (nivel superior) - oculta los modelos del catálogo y `/v1/models`, y voltea las identificadores GPT nativas desnudas a `visibility: "hide"`.
3. **`liveModels: false`** - Con `liveModels: false`, un `models` vacío u omitido inicia primero el `defaultModel` configurado, seguido de `retainModels`; los identificadores duplicados se eliminan mientras se conserva la primera aparición. Una lista `models` explícita no vacía en su lugar siembra `models` seguido de `retainModels`, sin agregar implícitamente un `defaultModel` diferente. Ese valor predeterminado todavía se puede enumerar explícitamente en `models` o `retainModels`. Si ninguno de estos campos proporciona un id, la semilla estática está vacía. Este es el orden de la semilla, no una promesa del orden final del selector. `selectedModels`, `disabledModels` y la política de proveedores desactivados todavía se aplican. `authMode: "forward"` mantiene su rama separada y no usa esta semilla estática enrutada. Estas reglas no cambian el fracaso del descubrimiento en vivo.
4. **Cursor `GetUsableModels`** - el adaptador Cursor descubre modelos a través de su protobuf `GetUsableModels` RPC, no `/models`, por lo que un cambio de lado Cursor puede alterar qué id son visibles independientemente de otros proveedores.
5. **Caché y `ocx sync`** - catálogos en vivo se almacenan en caché durante unos cinco minutos (`modelCacheTtlMs`, por defecto `300000`). Ejecute `ocx sync` para forzar una nueva búsqueda y reescribir el catálogo inmediatamente.
6. **Correr Codex `app-server`** - reescribir el catálogo en el disco no es suficiente, mientras que un Codex de larga vida `app-server` (host de escritorio / CLI de fondo) mantiene la lista anterior en la memoria. `ocx sync` y `ocx sync-cache` advierten cuando se detectan esos procesos. `ocx sync --restart-codex` reinicia esos procesos y cierra completamente y reinicia la aplicación de escritorio Codex en macOS, Linux y Windows para que el selector vuelva a leer el catálogo. Para dejar la aplicación de escritorio en ejecución, pase `--restart-app-server-only` o detenga el `app-server` correspondiente procesos usted mismo.

:::caution[Otros procesos locales que escriben la configuración]
El catálogo escribe (`opencodex-catalog.json`, `config.toml`) son atómicos **interior** opencodex, que solo evita archivos a medio escribir cuando dos escritores propiedad de opencodex compiten. Eso sí. **no** Detener a otro proceso local, observador de archivos o agente de sincronización de reescribir la visibilidad del catálogo u ordenar después de opencodex ha escrito. Codex mantiene su separación `models_cache.json` y puede refrescarlo independientemente, cambiando la lista visible sin reescribir `opencodex-catalog.json`. Si los modelos se voltean inesperadamente mientras proxy está ejecutando, deteniendo o reconfigurando a los escritores competidores, luego ejecuta `ocx sync` — esto es un riesgo de escritura externa, no un defecto confirmado opencodex.
:::

<a id="proxy-connection-errors"></a>

## Errores de conexión proxy

Si Codex vuelve a intentarlo y luego falla con un error como `stream disconnected before completion: error sending request for url (http://127.0.0.1:10100/v1/responses)` - o Claude Code informa un error de conexión similar - el proxy opencodex no se está ejecutando: nada está escuchando en el puerto configurado, por lo que el cliente muestra ese error de conexión sin procesar. Reinicie el proxy:

```bash
ocx start              # foreground
ocx service install    # persistent: auto-starts on login and respawns on crash
```

`ocx status` muestra si el proxy se está ejecutando e imprime la misma pista de reinicio cuando no lo está; `ocx doctor` informa sobre la seguridad de reinicio (cobertura de servicio/atención).

<a id="upstream-overload-before-any-output"></a>

### Sobrecarga ascendente antes de cualquier salida

Cuando el backend ChatGPT declina un turno nativo agrupado de Codex con `server_is_overloaded` u otro error del servidor antes de que haya producido cualquier salida, opencodex reintenta la misma cuenta con un retroceso corto y limitado y luego mueve el turno a otra cuenta elegible de Pool. Una cuenta anclada (un modelo calificado para la cuenta) se vuelve a probar pero nunca se mueve. Una vez que cualquier salida ha alcanzado Codex el giro nunca se envía de nuevo. Si se rechaza cada intento, Codex recibe el mismo error que habría recibido sin los reintentos. Las solicitudes compactas nativas se mueven a otra cuenta Pool en un error del servidor de la misma manera.

<a id="runtime-agent-instances-codex-0164"></a>

### Instancias de agentes en ejecución (Codex 0.164+)

Codex 0.164 puede firmar cada solicitud con una aserción de agente cuando se activa `features.runtime_agent_instances`, una función desactivada de forma predeterminada. opencodex admite uno de sus dos modos:

- `mode = "dual_header"` conserva la credencial habitual `Authorization: Bearer` y añade el encabezado `x-openai-agent-assertion`. opencodex procesa la solicitud como antes. Solo reenvía la aserción cuando el turno va a ChatGPT Direct con la credencial de quien realiza la solicitud. La elimina si la solicitud usa una cuenta de Pool, una credencial principal guardada, un proveedor enrutado o un sidecar, porque la aserción pertenece a la credencial enviada por Codex.
- `mode = "assertion_only"` sustituye el token bearer por `Authorization: AgentAssertion <jwt>`. opencodex rechaza estas solicitudes con HTTP 400 y el código `agent_assertion_unsupported`. Nunca sustituye la aserción por una credencial de Pool o de proveedor, ni la reenvía o registra. Usa `dual_header` o desactiva la función cuando Codex pase por opencodex.

<a id="codex-autostart-shim"></a>

### Codex calza de inicio automático

Ejecute `ocx codex-shim install` para instalar el envoltorio de lanzador opcional. Ejecuta `ocx ensure` antes de que el Codex ordinario se inicie y luego reenvía los argumentos originales y el estado de salida. El comando también funciona con el `ocx` independiente incluido en paquetes de escritorio: tanto la sonda de instalación como el envoltorio instalado usan ese ejecutable, sin requerir una instalación separada de Bun o una comprobación de origen.

En macOS y Linux, active el envoltorio privado en su shell actual después de otra configuración de PATH. Con el inicio predeterminado OpenCodex, ejecute:

```sh
. "$HOME/.opencodex/codex-shell-env.sh"
```

Con un `OPENCODEX_HOME` personalizado, utilice el camino citado impreso por `ocx codex-shim install`. Agregue esa línea de origen después de otra configuración de PATH en su archivo de inicio de shell para activar futuros shells. OpenCodex no edita ese archivo ni cambia el shell principal. Las shims Unix heredadas en el lugar no se migran automáticamente; ejecute `ocx codex-shim install` explícitamente para migrarlas.

Utilice `ocx codex-shim status` para inspeccionarlo. En macOS y Linux, `ocx codex-shim uninstall` elimina los archivos de superposición privados y deja intacto Codex nativo. Windows mantiene en su lugar los envoltorios de script; la desinstalación restaura el lanzador guardado. Ver el [CLI Referencia del ciclo de vida](/es/reference/cli/lifecycle/#ocx-codex-shim-installstatusuninstallremove).

<a id="experimental-windows-desktop-compatibility"></a>

## Experimental compatibilidad de escritorio Windows

**Codex Set → Compatibilidad con equipos de escritorio** proporciona controles locales para una prueba de compatibilidad limitada al tiempo que conserva el inicio de sesión nativo Codex. Este es un relevo experimental, no una garantía de que cada Codex estado de compilación o cuenta agotada pueda recuperar a su compositor.

1. Inspeccione el estado, prepare el certificado cifrado y revise su huella digital antes de registrar la confianza. Windows puede solicitar confirmación. La confianza se aplica al usuario actual Windows y permite que el relé local maneje el tráfico `chatgpt.com`.
2. Comience la observación. Guarde los borradores, cierre Codex, luego use **Abierto Codex** en este panel para iniciar la aplicación empaquetada con la conexión administrada. El panel nunca cierra por la fuerza una aplicación existente.
3. Solo después de que se observe el agotamiento elegible, **Ejecutar prueba de 3 minutos** ofrece un consentimiento separado para toda la cuenta. Ajusta dos indicadores de interfaz de usuario en la cuenta de inicio de sesión, no solo en el modelo seleccionado. El uso real, los créditos, las restricciones de gasto y los límites del servidor permanecen sin cambios. Una respuesta producida por sí sola no establece que el compositor se recuperó.

Una respuesta original que muestre el uso disponible o un estado protegido finaliza el juicio inmediatamente. Los créditos disponibles o la Reserva Luna activa también dejan la respuesta sin cambios y terminan el ensayo, incluso cuando se agota el uso ordinario. Esto preserva el estado de derecho existente de la aplicación. Si el agotamiento elegible aparece de nuevo, se requiere otro ensayo explícito; el consentimiento anterior no reactiva silenciosamente la corrección.

**Volver a la observación** desarma la corrección. La corrección de la respuesta de límites límite de tres minutos, no el tiempo hasta que Codex refresque su visualización. Caduca y vuelve a la solicitud de observación de una nueva respuesta de uso; la aplicación puede conservar su pantalla anterior hasta que llegue esa respuesta. El panel muestra esta limitación antes del consentimiento de prueba y mientras espera la respuesta original; no puede confirmar la actualización de caché de la aplicación. **Detener el servicio** cierra sus conexiones y deja el certificado para su reutilización; las conexiones activas pueden interrumpirse. Para renovar o retirar la confianza, detenga el servicio y cierre primero el Codex. La renovación prepara un nuevo certificado no confiable; revise la nueva huella digital antes de registrarla. Una acción incierta no se vuelve a intentar automáticamente. Los certificados están restringidos a la autenticación del servidor TLS. Si el estado muestra `renewal-required`, detenga el servicio y cierre Codex, luego renueve el certificado anterior antes de comenzar de nuevo. La URL nativa API debe coincidir con la dirección del oyente y el puerto reales del proxy. Las direcciones IPv4 e IPv6 no son intercambiables aquí; `localhost` alias ambiguos son rechazados. Codex 's automático MCP actualización de la conexión y el formato de configuración no invalidan la observación. Los cambios de modelo, autenticación, perfil y enrutamiento aún requieren un contexto de observación fresco; el servicio no adopta silenciosamente esos cambios durante una prueba.

El servicio conserva su dirección PAC y puertos de conexión local para su reutilización después de un reinicio. Con el mismo certificado de confianza, una aplicación ya configurada puede volver a conectarse a través de su PAC en caché; reiniciar el servicio nunca reanuda una prueba de corrección. Si un puerto guardado no se puede vincular o los metadatos de conexión no son válidos, el inicio se niega en lugar de asignar otra dirección de forma silenciosa. El primer comienzo exitoso posee `codex-desktop-compatibility/connection.json` bajo la casa OpenCodex. No elimine ese archivo como una solución de reinicio de rutina: una dirección diferente requiere iniciar la aplicación con una nueva conexión administrada.

El soporte actual se limita a la versión Windows evaluada `26.924.2738.0`, inicio de sesión basado en archivos nativos. HTTP / HTTPS proxies y SOCKS5 autenticados proxies se admiten a través de la política de salida compartida; NO_PROXY puede seleccionar explícitamente una ruta directa. Las conexiones proxy fallidas no vuelven a la salida directa. El modo cliente administrado OpenCodex aún no es compatible con estos controles. Para este relé de escritorio, HTTP (S) `ALL_PROXY` también se aplica cuando `HTTPS_PROXY` no está configurado. Un `HTTPS_PROXY` no válido rechaza la operación en lugar de volver a `ALL_PROXY`. La aplicación desconocida crea una corrección de rechazos; la integración no parchea los archivos de la aplicación ni cambia al modo sin inicio de sesión. La configuración raíz nativa y su perfil seleccionado deben enrutar `openai_base_url` al oyente de datos local real de este proceso. Un proveedor, destino o anulación no admitida diferente rechaza el inicio de observación. Esta comprobación no determina el modelo seleccionado de una conversación ni prueba que las anulaciones locales de proyecto estén ausentes. Si el enrutamiento o la compilación de la aplicación instalada cambia durante una prueba, se rechaza la corrección antes de la siguiente respuesta de uso; las comprobaciones periódicas también devuelven una prueba inactiva a la observación. Las respuestas originales y otro tráfico de aplicaciones continúan retransmitiendo. El reemplazo nativo de archivos de inicio de sesión o la rotación de tokens también invalida la prueba, incluso cuando regresa la misma cuenta. Detener y comenzar la observación para vincular el inicio de sesión actual antes de otra prueba explícita; las respuestas antiguas no pueden autorizar la sesión de reemplazo. Los cambios en la configuración raíz Codex (excepto su tabla y formato de servidor MCP), la configuración del proveedor, los alias del modelo, los perfiles de enrutamiento, las rutas de reserva, la compactación o el modelo de memoria también invalidan el contexto de observación. Restaurar la configuración anterior no restablece su consentimiento: deténgase e inicie la observación, luego confirme un nuevo ensayo cuando sea elegible. Esto detecta cambios en esas rutas configuradas, no qué modelo selecciona realmente una conversación; una configuración de proveedor mixto sin cambios no es prueba de aislamiento del proveedor.

Después de la preparación del certificado y un inicio manual exitoso, habilite **Reanudar la observación cuando se inicia OpenCodex** en el mismo panel. La configuración opcional OpenCodex `"desktopCompatibility": { "startOnProxyStart": true }` se reanuda **Sólo observación** cuando se inicia el proxy del modelo. Omission o `false` desactiva este arranque automático. Reutiliza los endpoints guardados y el certificado de confianza, nunca inicia Codex ni registra confianza, y nunca reanuda una prueba de Aplicar. La observación automática espera a que termine la sincronización de la configuración de inicio. La sincronización fallada o una espera de más de dos minutos deja la observación desactivada; inspeccione su estado e inícielo manualmente después de resolver el problema de inicio. El proxy del modelo continúa siguiendo su propia política de preparación. Si faltan requisitos previos, la observación permanece desactivada y el proxy del modelo continúa ejecutándose. Guardar esta preferencia no inicia ni detiene el servicio actual. Utilice sus controles de servicio separados para cambios inmediatos. Si no se puede confirmar un guardado, actualice su estado antes de volver a intentarlo.

Un servicio en ejecución no establece que Codex esté conectado a través de él. Un inicio de aplicación normal o un actualizador de aplicación pueden omitir el argumento de conexión administrada. Guarde borradores, cierre Codex, luego use **Abierto Codex** en este panel para restaurar esa conexión. Este control nunca cierra la aplicación para usted. Después de una actualización Codex, una versión de aplicación no evaluada rechaza la corrección hasta que se revisa su compatibilidad; reinstalar el certificado no hace que se admita una compilación no evaluada.

El panel también puede informar la última comprobación de compilación completada como metadatos de diagnóstico: la versión del paquete contra la que se evaluó esta compilación, la versión del paquete observada en esa comprobación, si coinciden y cuándo terminó la comprobación. Es una observación pasada, no una lectura en vivo del paquete instalado. Después de que el servicio se detiene, la aplicación se actualiza, o una comprobación todavía se está ejecutando o se interrumpió, puede retrasar la instalación real; solo una sonda completa lo actualiza, y un resultado `verified` describe el paquete observado en esa comprobación, no lo que está instalado ahora.

En Windows, un reinicio de la aplicación completa OpenCodex explícito conserva un argumento PAC de compatibilidad de bucle invertido ya activo solo cuando el proceso OpenCodex actual posee el entorno de ejecución de compatibilidad de servicio. Se rechaza un punto final obsoleto o extraño antes de detener Codex; el reemplazo del entorno de ejecución durante el reinicio también evita el relanzamiento administrado. La aplicación se inicia a través de la activación del paquete Windows. Verifica la identidad del paquete y el argumento de enrutamiento después del inicio; argumentos de enrutamiento de la aplicación principal ilegibles o conflictivos causan un rechazo antes del reinicio. Esto no permite un modo de compatibilidad, instalar un certificado o ver y reiniciar la aplicación automáticamente. Los lanzamientos normales sin ese argumento de enrutamiento mantienen su comportamiento existente.

<a id="transport-coverage-and-recovery-evidence"></a>

### Cobertura de transporte y evidencia de recuperación

El panel de compatibilidad informa las respuestas de uso JSON / SSE verificadas por identidad y los flujos actualmente vinculados por separado de las conexiones abiertas. Estas son observaciones de retransmisión de por vida, incluidas las solicitudes realizadas por clientes de diagnóstico. No identifican el proceso nativo de envío, prueban que la aplicación actualizó su caché autorizado o prueban la recuperación del compositor. No se agrega ningún cuerpo de solicitud, token, ID de cuenta o IP de origen a este estado de diagnóstico.

[incidencia #6196](https://github.com/lidge-jun/opencodex/issues/6196) informa una compilación macOS cuyas solicitudes de puerta autorizadas se originan en el servidor de aplicaciones Rust incluido y evitan la configuración de Chromium PAC. Un PAC saludable, certificado o solicitud sintética no puede establecer la cobertura de ese transporte. Este experimento Windows no es una solución para ese bloqueador de diseño macOS.

Antes de agregar otra plataforma o transporte, documente y valide esta secuencia:

1. Identifique el proceso real y el transporte que envía cada solicitud de puerta autorizada.
2. Demostrar que una solicitud de origen de aplicación llega al relé previsto, por separado de los clientes de prueba.
3. Verifique el esquema de respuesta y la ruta de caché/actualización de la aplicación para la compilación instalada exacta.
4. En caso de agotamiento natural de la cuenta, verifique el envío del compositor original, la finalización del proveedor independiente y la preservación del inicio de sesión, el chat, los hilos existentes y las conexiones remotas.
5. Verifique el apagado, el inicio ordinario, reinicie y actualice el comportamiento; no infiera uno de otro.

La presente política solo maneja `/backend-api/wham/usage` y su punto final `/stream`. La inicialización de la conversación y otros puntos finales, incluidos sus `blocked_features` y `limits_progress`, pasan sin cambios. Su presencia no es un permiso para limpiarlos: pueden representar restricciones no relacionadas. La ruta de búsqueda de renderizador a electrón de la compilación Windows no establece la ruta de red de un sistema operativo/construcción diferente o de cada RPC de servidor de aplicaciones. El enrutamiento del servidor de aplicaciones requiere su propio diseño revisado; cambiar las URL del proveedor de modelos por sí solo no es prueba de que el tráfico de cuenta, inicio de sesión o control remoto siga la misma ruta. Estos controles no instalan ningún envoltorio automático de aplicaciones-servidor, cambio de proxy global o reescritura de inicio de sesión.

<a id="routed-models-during-codex-reserve-mode"></a>

## Modelos encaminados durante el modo de reserva Codex

Codex Pool puede proteger opcionalmente las cuentas de grupo almacenadas a un umbral de uso semanal o de 5 horas seleccionado. La cuenta de escritorio/principal mantiene su bloqueo separado del 98%. Establezca `codexPool.lowQuotaProtection` en configuración para pausar cuentas, registrar una alerta de registro y API o ambas; vea [configuración de enrutamiento](/es/reference/configuration/routing/#codex-pool-low-quota-protection). Una pausa tiene efecto para la siguiente selección inmediatamente, mientras que guardarla en el disco se aplaza. Las respuestas de cuota Pool pueden autorizar una pausa solo con el uso válido y una credencial capturada que todavía está actualizada. Una respuesta sin esa prueba puede actualizar el uso mostrado sin pausar una cuenta. Compruebe el historial de `GET /api/codex-auth/low-quota-events` autenticado de este servidor para alertas `logged` o errores de guardado. El reanudación manual permanece en vigor para el episodio de cuota actual. La alerta por defecto solo llega al log y API. Añadir `actions.desktop: true` para mostrar también una notificación macOS o Linux en la máquina que ejecuta el proxy; Windows permanece solo registro.

Cuando se agote la cuota de ChatGPT de 5 horas, Codex puede ofrecer un modelo de reserva de reserva (`gpt-reserve` / Luna Reserve). Mientras que ese estado está activo, el selector de modelos Codex puede hacer **cualquier otra entrada no seleccionable, incluidos los modelos enrutados opencodex**, a pesar de que se ejecutan en proveedores independientes y credenciales y no consumen ninguna de las cuotas agotadas.

**Este es un comportamiento del cliente Codex que el enrutamiento proxy de modelo ordinario no puede cambiar.** El estado de reserva llega desde el backend ChatGPT en la propia conexión autenticada del cliente, no a través del proxy. La aplicación de escritorio sondea `backend-api/wham/usage` y trata la reserva como activa cuando la respuesta lleva `rate_limit_upsell.banner_type = "luna_reserve"`, el `rate_limit.allowed` primario es `false`, y `additional_rate_limits[]` contiene una entrada con `limit_name = "gpt-reserve"` que todavía está permitida. Mientras eso se mantiene, la aplicación fuerza la configuración del modelo de la conversación a `gpt-reserve` y reescribe cualquier otra elección de nuevo a ella - el selector se contrae a la entrada de reserva por el cliente, y un valor `model =` en `config.toml` se anula de la misma manera. Nada de esto consulta el catálogo de modelos, por lo que ninguna representación de nuestra parte participa en la decisión. opencodex no tiene un concepto de reserva para ajustar, y la alternativa - informar mal su propia cuota a su propio cliente - sería un error peor que el que encubrió.

**Solución:** los modelos en sí permanecen completamente utilizables; solo la selección del modelo de la aplicación Codex está cerrada. Llegue a ellos desde un cliente que no consulta la instantánea de uso ChatGPT:

- Claude Code a través del proxy (`ocx claude`).
- Cualquier cliente HTTP contra el punto final local `/v1`.
- Las propias rutas de solicitud del panel de control.

El comportamiento normal del selector vuelve cuando se restablece la ventana de 5 horas.

**Lo que el proxy responde mientras ese estado se mantiene.** Una vez que la aplicación ha colapsado, el selector envía `gpt-reserve`, y sin el [opt-in de escritorio authless](#authless-codex-desktop-opt-in) opencodex no tiene derecho de reserva para enviar con él. Esa solicitud solía ser enviada como un modelo nativo ordinario y regresaba como el propio `The usage limit has been reached` del flujo ascendente, que no nombra ni la causa real ni la configuración que lo cambiaría. Ahora se rechaza localmente con un HTTP 400 que dice que `codexDesktopAuthless` está apagado y da el comando que lo enciende (`ocx system settings --desktop-authless on`). Nada se envía aguas arriba y no se gasta ninguna cuota.

El rechazo es deliberadamente estrecho. Se aplica solo a `gpt-reserve` en una solicitud admitida en bucle que alcanzaría la ruta de avance canónica ChatGPT. Un selector `gpt-reserve` que un operador ha aliaseado o enrutado a otro proveedor sigue funcionando, una solicitud admitida en un oyente que no es loopback aún se reenvía, y un proxy que se ejecuta en el rol de entorno de ejecución `client` no cambia. Habilitar el opt-in restaura el camino normal de la Reserva en lugar del rechazo.

<a id="the-subagent-picker"></a>

## El selector de subagentes

La sincronización de catálogos permite que los modelos de subagentes seleccionados estén disponibles para Codex; consulte [Codex Selector de modelos de aplicaciones](/es/guides/codex-app-models/#subagent-selection) para el pedido de selectores y [Superficie del subagente](/es/guides/sub-agent-surface/) para la delegación v1/base/v2 y el comportamiento de reserva.

<a id="codex-account-warmup"></a>

## Codex calentamiento de la cuenta

Cuando se agrega o vuelve a autenticar una cuenta ChatGPT, OpenCodex normalmente la verifica antes de guardarla con una pequeña solicitud de transmisión al backend Codex Responses. Espera `response.completed`, por defecto `gpt-5.6-luna`, y vuelve a intentar con `gpt-5.5` en HTTP 400 o HTTP 404. Los errores públicos contienen categorías de fallos fijos en lugar de cuerpos de respuesta ascendentes sin procesar.

Un HTTP 429 de un intento de calentamiento se informa como `codex_warmup_rate_limited`. Vuelva a intentar después de que se elimine la restricción temporal o se restablezca el límite de uso; iniciar sesión nuevamente no restablece estos límites. Un intento fallido de calentamiento no agrega una nueva cuenta ni reemplaza las credenciales existentes. Esto difiere del registro diferido confirmado por cuota a continuación, que puede guardar una cuenta restringida sin una solicitud de modelo. HTTP 401/403 fallos retienen la guía de autenticación.

Si la búsqueda de uso autenticado de la nueva credencial OAuth confirma una cuota agotada de 5 horas, semanal o mensual, la cuenta se guarda sin esta solicitud de modelo y muestra **Validación pendiente**. No puede servir solicitudes de agrupación, incluso después de reiniciar o actualizar token. Una vez que se recupera la cuota, **Actualizar las cuotas** finaliza la validación: una lectura de uso nueva y completa con espacio libre permite una pequeña solicitud de modelo, y solo una respuesta completa habilita la cuenta. Las lecturas fallidas o incompletas y la validación fallida preservan la restricción. Las encuestas de cuentas pasivas no activan la validación diferida. El uso desconocido durante el registro inicial conserva la puerta de calentamiento normal.

`ocx account refresh openai` y `ocx account list openai --quota --refresh` solo leen el uso. La validación del modelo gasta cuota y requiere una sesión de panel humano: abra `ocx gui` y haga clic en **Actualizar las cuotas** después de la recuperación. Para un host sin cabeza, acceda a su panel de control desde su navegador; un token de administrador solo no autoriza la validación. La validación se puede completar mientras una cuenta está en pausa sin reanudarla o seleccionarla. Los errores de autorización del modelo permanecen visibles hasta que la validación o reautenticación exitosa los borra.

En **Codex Conjunto → Multi-auth**, habilite el interruptor **Codex créditos** en el encabezado **Codex Auth** para mostrar los últimos créditos observados de cada cuenta principal y de grupo directamente debajo de Week. Está desactivado por defecto y persiste como `showCodexCredits`. El saldo es un número con formato local, con advertencia ilimitada o de exceso cuando se informa; la barra indica disponibilidad, no un porcentaje, porque no se proporciona un límite de crédito total. Ocultar los créditos solo cambia su visualización, y un nuevo inicio de sesión espera su propia observación.

Cuando una cuenta llega al 100% en una ventana de uso y aún tiene créditos, la parte superior sigue sirviéndola y obtiene el saldo. OpenCodex no deja que eso suceda de forma predeterminada: una cuenta al 100% se apaga mientras su ventana semanal o mensual (solo mensualmente en planes de 30 días) o su ventana de 5 horas está llena, y se usa nuevamente una vez que se restablece esa ventana. El orden de las otras cuentas no cambia, y cuando no hay otra cuenta disponible, la selección no encuentra nada en lugar de gastar créditos. Una solicitud para la cuenta principal se rechaza como un rechazo de bloqueo duro hasta que se restablezca. Una ventana completa de 5 horas sin un tiempo de reinicio mantiene una cuenta solo mientras esa lectura está fresca. Permitir que la cuenta principal no levante su bloqueo duro (encendido por defecto al 98%), lo que aún lo detiene primero; apague el bloqueo si la cuenta principal debe gastar créditos (un bloqueo al 100% aún lo detiene al 100%). Para permitir que las cuentas sigan funcionando desde sus créditos, active **Usar créditos** junto al interruptor **Codex créditos** en el encabezado de Autonomía Codex. El interruptor permite todas las cuentas. Para elegir cuentas una por una, abra el menú **⋯** de una tarjeta de cuenta y use **Usar créditos después del límite** allí; el interruptor de encabezado muestra una posición media cuando solo algunas cuentas están activadas. Una cuenta permitida para gastar lleva una insignia **Utiliza créditos** en su tarjeta. Comienzan nuevas cuentas. La opción se almacena en `creditCodexAccountIds` y nunca canjea créditos de reinicio; el interruptor de pantalla **Codex créditos** solo muestra saldos y nunca cambia el enrutamiento.

En el caso de una cuenta principal con acceso opcional y sin pausa y con una ventana de uso completa, el ciclo de recuperación en segundo plano renueva las observaciones de crédito gastables a partir de los tres minutos de edad, incluso cuando el panel de control está cerrado. Prepara un token válido antes de la búsqueda de uso autenticado para que el saldo se pueda observar nuevamente antes de su límite de frescura de cinco minutos. Los créditos faltantes, nulos, restringidos o retractados mantienen la cuenta elegible para búsquedas de recuperación bajo el reintento de retroceso existente. Las solicitudes siguen siendo rechazadas hasta que se observe un nuevo saldo positivo o créditos ilimitados. `has_credits` solo o recuentos de mensajes aproximados no demuestran un saldo desembolsable. Con el consentimiento, el `Retry-After` de este rechazo de evidencia crediticia es como máximo de cinco minutos, o un restablecimiento de la cuota incluida antes; sin consentimiento, aún sigue el restablecimiento de la cuota incluida. Una búsqueda fallida o incompleta no actualiza la evidencia de equilibrio anterior. El bloqueo duro de la cuenta principal separada, la cuarentena de necesidades-reauth y los retrasos de reintentos aguas arriba aún se aplican. Esta búsqueda de metadatos no envía una solicitud de validación de modelo ni establece ni borra el estado de área de necesidades de la cuenta.

La revalidación de fondo es separada y desactivada por defecto. Requiere Token Guardian, el `openai` proveedor `proactive` política de actualización, y `tokenGuardian.codexWarmupEnabled`. Se salta las cuentas a la espera de la validación de registro diferido.

<a id="after-a-chatgpt-plan-upgrade"></a>

### Después de una actualización del plan ChatGPT

Actualice la cuota de la cuenta principal en Codex Auth después de cambiar su plan ChatGPT. Cuando la respuesta de uso autenticada confirma que una ventana larga ha reemplazado la ventana de cinco horas, opencodex elimina la antigua lectura de cinco horas tanto de la admisión de solicitud como de la selección de cuenta. Una respuesta permitida con ventanas primarias y secundarias puede omitir la ventana terciaria opcional. Esta recuperación utiliza su asignación de plan incluida y no requiere habilitar **Usar créditos**. Los datos de uso parciales o no válidos retienen el bloque anterior hasta que se confirma la recuperación.

<a id="cancelling-main-account-device-reauthentication"></a>

### Cancelación de la reautenticación del dispositivo de la cuenta principal

Cuando se cancela la reautenticación del dispositivo de la cuenta principal, un fallo temporal de la red o una respuesta con un estado desconocido o no terminal, mantiene el flujo activo y la indicación de fallo de cancelación para que se pueda volver a intentar la cancelación. El sondeo de estado normalmente continúa, por lo que aún se puede detectar un inicio de sesión que se complete. Si un fallo de cancelación reintentable se superpone a una respuesta de estado GET no 2xx mientras el flujo es `pending` o `committing`, cualquier orden de respuesta conserva el reintento de cancelación en ese mismo flujo, con su último código de dispositivo proporcionado por el servidor, URL de verificación y fase. El fallo GET HTTP aún deja de ser consultado, pero la cancelación puede ser reintentada sin iniciar un segundo POST de inicio de sesión. Una respuesta del terminal `failed` libera el flujo y muestra la razón normalizada del fallo; solo `succeeded` informa del éxito del inicio de sesión. Una respuesta confirmada `cancelled` libera el flujo para que se pueda iniciar un nuevo inicio de sesión del dispositivo. Una respuesta definitiva HTTP 404 con el código `unknown_flow` también libera el ID de flujo caducado para que se pueda iniciar un nuevo inicio de sesión del dispositivo, pero no informa un inicio de sesión exitoso o una cancelación confirmada. Las respuestas POST, GET o DELETE tardías de un flujo anterior no pueden cambiar el nuevo flujo o informar el éxito de inicio de sesión para él.

<a id="why-an-account-stopped-serving-requests"></a>

### Por qué una cuenta dejó de servir solicitudes

Cuando una cuenta deja la selección de grupo, la razón viaja con la decisión en lugar de ser recalculada para su visualización, por lo que una superficie nunca puede informar una cuenta saludable mientras el enrutamiento la está abandonando. `GET /api/codex-auth/accounts` lleva `reauthReason` junto a `needsReauth` en cada cuenta: `missing_credential` para una credencial que nunca se almacenó, `refresh_failed` para una actualización de credenciales que sigue fallando y `quota_unauthorized` cuando se rechazó la búsqueda de uso.

Una actualización de la cuenta principal que no se completa todavía responde `503` con `Retry-After`, porque un reintento aún puede tener éxito. El mensaje ahora agrega que un fallo que persiste significa que la cuenta principal necesita reautenticación, en lugar de solo pedir otro intento.

<a id="optional-idle-window-steering"></a>

### Dirección de ventana inactiva opcional

`codexPool.startIdleWindows` es un booleano opcional y por defecto a `false`. Cuando se habilita, una nueva solicitud real no vinculada puede colocarse en una cuenta elegible cuya ventana de cuota corta observada es del 0% con evidencia de que su reloj de cinco horas no ha comenzado. Esta verificación se ejecuta después de la conversación y la afinidad familiar, por lo que un enlace existente sigue siendo autorizado; también gana un pin de cuenta explícito o una preferencia de cuenta manual. Se omiten los ámbitos de cuota de modelo independientes y el cursor activo compartido permanece sin cambios. Después de la opción de ventana inactiva, la selección de estrategia normal se reanuda para otras conversaciones.

La observación no debe ser mayor de cinco minutos, y la ventana corta debe ser explícitamente de 18.000 segundos. Su restablecimiento debe observarse dentro de los 60 segundos de `observation + 5h` (en lugar de un restablecimiento ya realizado o transcurrido). Una reserva local de proceso sincrónica evita selecciones duplicadas para la misma cuenta y ventana. El plazo de reserva es de al menos 5 horas más un minuto después de la selección; se requiere una nueva observación después de ese plazo antes de que la misma cuenta pueda ser dirigida nuevamente. Las reservas se borran cuando se reinicia el proceso proxy y nunca se mantienen en el disco.

Habilitarlo en su configuración existente:

```json
{
  "codexPool": { "startIdleWindows": true }
}
```

Si ninguna cuenta cumple con los criterios, se aplica el enrutamiento ordinario. Esta característica solo dirige una solicitud entrante real. No crea ninguna petición sintética ni temporizador.

<a id="keeping-a-downgraded-account-out-of-rotation"></a>

### Mantener una cuenta degradada fuera de rotación

`codexPool.excludedPlans` enumera las claves de plan que la selección automática de grupo omite, emparejadas insensiblemente a las mayúsculas y minúsculas contra el plan almacenado en cada cuenta. Está ausente por defecto, por lo que una instalación existente gira exactamente como antes.

```bash
ocx config set codexPool '{"excludedPlans":["free"]}'
```

Esta es una política de selección, no un bloqueo. Una cuenta excluida mantiene su credencial, historial de cuotas y afinidad de subprocesos, permanece visible en la superficie de la cuenta y aún se puede acceder a ella mediante una selección explícita de la cuenta, como la `work/gpt-5.5`. Lo que cambia es que la rotación automática deja de elegirlo, incluso cuando ya es la cuenta activa o ya está vinculada a un hilo, que es el estado que deja una suscripción caducada.

La cuenta principal Codex permanece exenta de la exclusión del plan; el enrutamiento solo de selección no lee su credencial nativa vallada. Si se excluyen todas las cuentas de grupo elegibles, la selección automática no devuelve ninguna cuenta. Las rutas con calificación de cuenta explícita permanecen disponibles y aún imponen pausa, autenticación y derecho de modelo. La tarjeta de cuenta y CLI muestran el plan de enrutamiento excluido por separado del estado de la credencial. No hay una configuración `minimumPlan` porque los nombres de los planes no definen un pedido total.

<a id="restoring-native-codex"></a>

## Restauración de Codex nativo

`ocx stop` detiene el proxy y cualquier servicio en segundo plano instalado, luego intenta restaurar el Codex nativo. OpenCodex elimina los artefactos de enrutamiento verificados e informa de una restauración incompleta cuando no puede recuperar archivos de configuración de forma segura.

La recuperación puede requerir una revisión manual cuando la revista no puede verificar los archivos actuales; consulte [recuperación sin hashes de inyección](#recovery-without-injection-hashes).

```bash
ocx stop       # stop the proxy + service, restore native Codex
ocx restore    # restore without stopping  (alias: ocx eject)
ocx restore back # point plain Codex at the running proxy again
```

Cuando opencodex se ejecuta como un [servicio de fondo](/es/reference/cli/lifecycle/#background-service) administrado, establece `OCX_SERVICE=1` para que un reinicio impulsado por servicio haga **no** thrash la configuración Codex - solo un `ocx stop` / `ocx service stop` explícito restaura el Codex nativo.

<a id="recovery-without-injection-hashes"></a>

### Recuperación sin hashes de inyección

La revista guarda los hashes originales `config.toml` y `opencodex.config.toml` más del estado OpenCodex inyectado. Un diario heredado o una interrupción antes de que se registraran esos hashes no pueden probar que el contenido posterior del archivo pertenezca a OpenCodex. Si cualquiera de los archivos difiere de su original guardado y carece de su propio hash de estado inyectado, la recuperación automática del diario y el error del informe de restauración nativa sin cambiar el archivo o la revista. El original guardado permanece disponible para la comparación; revíselo junto con los archivos actuales antes de elegir una acción de recuperación manual.

Los archivos que ya son iguales a sus originales guardados se aceptan sin reescribirlos. Un archivo faltante es distinto de un archivo vacío. Los hashes inyectados verificados aún permiten la restauración normal de instantáneas y las ediciones posteriores en configuraciones respaldadas por hash conservan el comportamiento de limpieza de campo propio existente.

Sync y `ocx restore back` también rechazan una configuración enrutada existente cuyo diario sin hash no coincide con la línea base previa a la inyección. Esto evita que un nuevo hash de inyección se adhiera a un original más antiguo. Una configuración genuinamente nativa se puede guardar como una nueva línea de base antes de la inyección. El comportamiento explícito de exclusión de proveedores externos no se modifica.


<a id="sub-agent-fallback-and-v2-compatibility"></a>

### Subagente de reserva y compatibilidad con V2

En **Subagentes → Configuración de delegación**, edite la cadena de reserva ordenada y su intervalo de sondeo de disponibilidad (5000-600000 ms), luego guárdela por separado de la lista destacada. Un destino configurado que ya no se anuncia permanece en la cadena hasta que lo elimine. La lista y la cadena de reserva son configuraciones separadas; este editor no hace que la lista reemplace la política de reserva.

Cuando un modelo preferido enrutado puede recibir trabajo V2 de un padre nativo ChatGPT, el panel explica la limitación de la tarea cifrada ascendente. Las tareas legibles de los padres enrutados no se ven afectadas. La guía utiliza el modo `/api/v2` y el estado nativo del pin V1; el API actual no expone la activación de recuperación o la elegibilidad específica de la solicitud, por lo que el panel informa que son desconocidos. La delegación V1/plaintext-compatible sigue siendo una alternativa. La recuperación experimental de V2, donde es elegible y explícitamente habilitada, agrega uso de cuota, latencia, dependencia de backend y posible pérdida de fidelidad; no repara el protocolo ascendente. Véanse [superficies de subagentes](/es/guides/sub-agent-surface/) y [La limitación aguas arriba](https://github.com/lidge-jun/opencodex/issues/92).

<a id="paginated-history-safety-refusal"></a>

## Historial paginado de rechazo de seguridad

Cuando un almacén de historial afectado admite registros paginados, una transición de proveedor puede devolver `history_paginated_requires_native_writer`. Esa razón ya no rechaza la configuración Codex, el perfil de referencia o el catálogo de modelos. `ocx sync` y `ocx start` todavía escriben esos archivos y establecen `model_catalog_json`, por lo que el selector de modelos Codex sigue mostrando cada modelo OpenCodex. Sólo esta razón se mantiene la conversación-historia reetiqueta hacia abajo, porque Codex asigna paginado despliegue ordinales en su propio escritor y ningún reintento cambia eso. Cualquier otro motivo de pre-vuelo de la historia - una base de datos de estado ilegible, un despliegue cuya identidad cambió, o un pre-vuelo que no pudo ejecutarse - todavía rechaza toda la transición y la devuelve, porque esos pueden tener éxito en un intento posterior. OpenCodex nunca modifica los archivos de despliegue paginados o las filas de subprocesos en este estado. Las conversaciones existentes mantienen el proveedor con el que ya están etiquetadas y no se migran; las nuevas conversaciones se enrutan normalmente a través del proxy. Cuando el reetiquetado se apaga, una tabla `[model_providers.opencodex]` que la casa ya tenía se mantiene en lugar de retirarse, incluso en la forma de anulación de raíz (loopback), por lo que las conversaciones cuyas filas están etiquetadas `opencodex` mantienen un ID de proveedor que todavía existe. Esto incluye filas heredadas en una tienda con capacidad de migración. El CLI imprime `Codex resume history: left to Codex's native writer (history_paginated_requires_native_writer)`.

Al volver al formulario de anulación de raíz, OpenCodex conserva una definición `[model_providers.opencodex]` existente antes de confirmar la configuración, incluso si el historial de pre-vuelo pasa actualmente. Esto hace que las conversaciones más antiguas de `opencodex` se puedan resolver si Codex migra el historial después de esa confirmación o mientras se inicia el trabajador en segundo plano. Las nuevas conversaciones aún usan el proveedor raíz seleccionado; la restauración explícita mantiene sus protectores de eliminación separados.

`ocx restore`, `ocx stop` y `ocx uninstall` Ya no se niegan a `history_paginated_requires_native_writer`. Toman cada clave de enrutamiento raíz OpenCodex y mantienen la `[model_providers.opencodex]` definición en el disco, por lo que las conversaciones cuyas filas todavía nombran ese proveedor siguen resolviendo mientras se `codex` Deja de apuntar al proxy. El resultado se informa como una restauración parcial que nombra las líneas retenidas, y `ocx restore --remove-codex-provider-table` También los elimina, después de lo cual esas conversaciones dejan de abrirse.

Habilitar la integración en su formulario de tabla de proveedores en una casa cuyas `openai` conversaciones etiquetadas Codex ya se han paginado solía ser rechazado por completo con `history_paginated_openai_requires_native_writer`: no se escribió nada y la integración se mantuvo inhabilitada. OpenCodex ahora completa esa transición manteniendo la raíz administrada `openai_base_url` al lado de la tabla `[model_providers.opencodex]`. Codex fusiona la anulación en su proveedor `openai` incorporado, por lo que esas conversaciones siguen llegando al proxy sin ser reetiquetadas y no se toca ningún byte de despliegue o fila de hilos. Solo un formulario de enrutamiento que requiere la cabecera de admisión `x-opencodex-api-key` todavía se niega, porque el proveedor incorporado de Codex no puede llevar esa cabecera; su mensaje nombra las dos configuraciones que lo resuelven: la ruta Codex a través del oyente de bucle de retorno para que la anulación pueda conservarse, o establece `syncResumeHistory` a `false` para aceptar que esas conversaciones se reanuden contra el propio punto final OpenAI de Codex.

<a id="remote-thread-list-provider-filters"></a>

### Filtros de proveedor de listas de hilos remotos

El enrutamiento de tabla de proveedor cambia el identificador de proveedor predeterminado para nuevas conversaciones a `opencodex`, mientras que el historial que no se puede volver a etiquetar de forma segura puede permanecer etiquetado como `openai`. Algunas versiones nativas de app-server/mobile tratan un filtro `thread/list.modelProviders` omitido como el proveedor predeterminado actual solamente, por lo que esas conversaciones existentes pueden desaparecer de esa lista remota aunque su fila de base de datos y su despliegue estén intactos. Un cliente de lista compatible puede enviar `modelProviders: []` para solicitar todos los proveedores. OpenCodex no puede reescribir ese RPC porque el cliente remoto habla directamente con el servidor de aplicaciones nativo de Codex en lugar del proxy de inferencia.

`ocx sync` y `ocx start` incluyen la advertencia cuando aplican una ruta de tabla de proveedores. Si una URL raíz propiedad del usuario envía el comando por la rama sin enrutamiento, el CLI omite la advertencia. En el modo de compresión cliente, el CLI puede retener esa URL, aplicar la tabla de proveedores `opencodex` e incluir la advertencia. El panel de control muestra una sugerencia de preferencia separada cuando cualquiera de las opciones está habilitada. Aparece una vez si ambas configuraciones están habilitadas, independientemente de la URL raíz. La sugerencia informa las preferencias habilitadas; no significa que Authless Desktop sea efectivo en la ruta actual. Authless Desktop solo se aplica al enrutamiento efectivo sin bucle de retorno y se ignora para el enrutamiento de clientes remotos o los oyentes que requieren un encabezado de admisión. La advertencia no es una migración: OpenCodex no edita etiquetas de proveedor simplemente para influir en un filtro de lista del lado del cliente. Verifique la conversación en Codex nativo y la versión de aplicación-servidor/cliente; no reescriba el historial paginado para hacer que una lista remota lo incluya.

No reescriba una implementación paginada activa o una fila de hilos para migrar esas conversaciones usted mismo. Cierre la conversación afectada antes de cualquier recuperación e informe el error exacto y las versiones sin cargar el historial privado. Una copia de seguridad o un script exitoso por sí solos no prueban que la conversación sea visible nuevamente. Compruebe la conversación restaurada en Codex después de reabrir.

<a id="experimental-native-mid-turn-steering"></a>

## Dirección a mitad de giro nativa experimental

Para un modelo compatible en la ruta canónica de reenvío ChatGPT, y un cliente que envía `response.steer`, habilite ambas opciones en `~/.opencodex/config.json` y reinicie OpenCodex antes de comenzar un nuevo turno:

```json
{
  "websockets": true,
  "codexNativeSteering": true
}
```

Fusione estas claves en la configuración existente; no reemplace la configuración de su proveedor/cuenta. Esta opción está desactivada por defecto. Reenvía la dirección a la misma conexión nativa WebSocket configurada explícitamente y a la cuenta seleccionada, preservando las respuestas sucesoras automáticas y las continuaciones pendientes de resultados de herramientas guardadas. Aceptación significa en cola, aún no aplicada.

Suministre los resultados de la herramienta requerida o las decisiones de aprobación **Una vez por padre**, en el mismo carril. Los resultados pueden llegar antes de `response.steer.pending`: el relé también coincide con las llamadas y aprobaciones anunciadas del padre completado. Un `name` en un stub de salida de función pendiente es opcional en el resultado, como en el esquema nativo. Mensajes de usuario adicionales pueden acompañar estos resultados; mensajes del sistema/desarrollador, resultados duplicados e ID de llamada no relacionados son rechazados. No vuelva a ejecutar las herramientas ni vuelva a enviar el texto de dirección aceptado. Las declaraciones de modelo, cuenta, herramienta y enrutamiento permanecen sin cambios. La configuración de generación validada puede cambiar en una continuación de resultado guardado explícita como se describe a continuación. Otros cambios requieren un giro explícitamente detenido o terminado y un nuevo envío normal. Múltiples conversaciones independientes utilizan conexiones independientes.

HTTP fallback, puertas de enlace no canónicas, rutas públicas API -key, modelos traducidos, sidecares, intentos Combo y restauración V2 de texto plano no admiten esta opción. No agrega capacidad de dirección a un modelo o un cliente que carece de ella. Las rutas no soportadas devuelven un error de protocolo en lugar de ignorar silenciosamente la entrada. La entrega desconectada o con tiempo de espera puede ser desconocida: nunca vuelva a enviar automáticamente herramientas o texto de dirección. Los controles pendientes tienen plazos de confirmación absolutos de 90 segundos por envío; las esperas de resultados de herramientas guardadas tienen un límite de 30 minutos.

La implementación tiene cobertura sintética de protocolo y regresión, no certificación Astra / cliente en vivo. Mantenga la opción desactivada para el trabajo de producción hasta que se haya verificado la ruta de su cliente/modelo. Establezca `codexNativeSteering` en `false` y reinicie para restaurar el relé de respuesta única existente; no es necesario eliminar ningún archivo de cuenta o conversación.


<a id="steering-confirmation-deadlines-and-retained-context"></a>

### Dirección de los plazos de confirmación y contexto retenido

Cada dirección enviada tiene una ventana de acuse de recibo fija de 90 segundos. Otras salidas y novillos adicionales no lo extienden. Una vez aceptada, la entrada permanece en cola mientras que la respuesta actual alcanza un límite seguro; las comprobaciones ordinarias de flujo inactivo aún se aplican. Después de que la respuesta termina, el sucesor debe comenzar dentro de los 90 segundos. Una solicitud de resultados o aprobación de la herramienta permite 30 minutos desde la primera notificación de este tipo. Los avisos repetidos no renuevan esta espera. El envío de los resultados guardados inicia una nueva ventana sucesora de 90 segundos, que incluye comprobaciones locales de ritmo/auth. Los reconocimientos que faltan siguen sujetos a sus plazos individuales anteriores.

La conexión propia no tiene un límite de vida absoluto. Hasta 128 respuestas pueden compartirlo, y cada una puede consumir legítimamente su propio reconocimiento, sucesor, espera de flujo inactivo y espera de entrada requerida, por lo que los plazos por etapa anteriores se componen en el peor de los casos del orden de decenas de horas. Durante ese tiempo, el turn tiene un socket físico y una credencial anclada que no puede rotar, porque el canal deliberadamente nunca vuelve a entrar en la selección de cuenta. Tratar una conexión de dirección habilitada como un recurso de sesión de larga duración en lugar de una solicitud limitada ordinaria.

Los marcos de dirección también comparten los límites de cuerpo y memoria configurados del proxy. Se rechaza una trama de control por encima de [`maxInboundBodyBytes`](/es/reference/inbound-body-admission/) antes de analizarla en una conexión de control establecida (una trama inicial todavía se analiza antes de que se aplique su límite basado en tipo), y se rechaza el cuerpo reconstruido enviado aguas arriba cuando excede de [`maxUpstreamBodyBytes`](/es/reference/configuration/providers/). El diario de repetición de cada conexión tiene un límite de 32 MiB y se cuenta como estado anclado contra [`appOwnedMemoryBudgetMb`](/es/reference/configuration/server/); admitir un diario degrada primero los cachés desalojables en lugar de fallar, y el agregado en los diarios en vivo tiene un límite de 128 MiB independientemente del presupuesto configurado.

Un tiempo de espera significa **La entrega es desconocida**, no es que el servidor rechazó la entrada. No vuelva a enviar una instrucción aceptada ni vuelva a ejecutar una herramienta automáticamente. Inspeccione el estado real de la tarea antes de decidir cómo reanudarla. No se realiza ningún cambio de cuenta o reserva de pago API. La salida completada ya recibida en el cable se retiene para el historial de continuación local incluso cuando el resumen del terminal lo omite. El contenido u orden del artículo en conflicto causa un fallo explícito en lugar de una pérdida de contexto silenciosa.

Para una comparación en vivo, use la misma versión, modelo y cuenta de cliente compatibles en conversaciones de prueba aisladas, una vez sin el proxy y una vez con él habilitado. Use una tarea de solo lectura, dirija mientras la salida está activa y compare la aceptación y la adherencia real a la instrucción del sucesor. Repita mientras el resultado o la aprobación de una herramienta sintética está pendiente y después de una desconexión explícita. Registrar solo tipos de eventos, tiempos relativos y resultados redactados, no credenciales o cuerpos de tareas. Pasar pruebas de transporte simulado no establece soporte en vivo para el cliente / backend; estas instrucciones no implican una prueba de humo de cuenta real.

<a id="experimental-native-function-result-injection"></a>

## Inyección experimental de resultado de función nativa

Para un cliente compatible que envía mensajes OpenAI multiagente `response.inject`, combine estas claves en la configuración OpenCodex existente y reinicie antes de un nuevo turno. No reemplace la configuración de su proveedor o cuenta:

```json
{
  "websockets": true,
  "codexNativeInjection": true
}
```

El `response.create` inicial debe incluir explícitamente `"multi_agent": { "enabled": true }`. OpenCodex no lo habilita basado en un nombre de modelo. Un proveedor público OpenAI API debe usar `adapter: "openai-responses"`, `baseUrl: "https://api.openai.com/v1"`, su autenticación de clave API normal y `upstreamWebsocket: true`. Enruta el modelo inicial a través del prefijo configurado de ese proveedor. El relé agrega el token beta `responses_multi_agent=v1` requerido solo en esa conexión pública API, preservando otros tokens beta configurados. No sustituye una credencial de suscripción, crea una cuenta API o cambia automáticamente a una API facturada por separado.

Canonical ChatGPT conexiones hacia adelante pueden optar por el mismo transporte experimentalmente, pero el contrato público API hace **no** establecer ChatGPT suscripción o Codex App / CLI apoyo. Todavía se requiere un modelo ascendente compatible y un modo de ejecución. Ver el [OpenAI Protocolo multiagente](https://developers.openai.com/api/docs/guides/responses-multi-agent).

Devuelve un resultado de la herramienta guardada después de que la llamada a la función de desarrollador correspondiente haya finalizado:

```json
{
  "type": "response.inject",
  "response_id": "resp_example",
  "input": [
    { "type": "function_call_output", "call_id": "call_example", "output": "saved result" }
  ]
}
```

Utilice los identificadores de respuesta/llamada del **La misma conexión**, no estos identificadores de ejemplo. `response.inject` acepta solo `function_call_output` con valor de cadena. Los mensajes de usuario/sistema, matrices de salida enriquecidas, resultados de herramientas alojadas y `response.steer` simultáneos no son aceptados por esa operación. La continuación de resultado guardado más amplia a continuación es una operación separada `response.create`, no una conversión oculta de inyección rechazada. Múltiples resultados de funciones guardadas pueden compartir una sola inyección. Cada llamada se puede enviar solo una vez, incluso mientras está en cola.

Los resultados de la herramienta paralela se ponen en cola y se envían un fotograma a la vez, ya que el evento de éxito identifica la respuesta en lugar de una inyección individual. El relé conserva `response.inject.created` y `response.inject.failed`. Mantiene la conexión activa después de que un terminal de respuesta mientras los resultados enviados esperan confirmación o las llamadas anunciadas esperan resultados, por lo que los resultados asíncronos tardíos no se descartan.

Cuando el servidor rechaza una inyección con `response_already_completed`, use sus salidas guardadas devueltas en **Un cliente enviado** `response.create` con el `previous_response_id` completado, modelo/configuración sin cambios y el mismo carril. Incluya cada resultado sobresaliente exactamente una vez; no incluya resultados ya aceptados. El relé mantiene esa continuación en la cuenta / socket original y conserva el ritmo normal de la solicitud. Nunca ejecuta la herramienta de nuevo o crea una solicitud de recuperación en sí. Otras fallas permanecen visibles para que el cliente las maneje.

Un acuse de recibo faltante o una entrega de medios de desconexión puede ser **Desconocido**. No vuelva a enviar un resultado automáticamente, reinicie una herramienta o cambie de cuenta para volver a intentarlo. La cola pendiente está limitada a 32 tramas y 8 MiB, con 1.024 llamadas de función anunciadas, un diario de reproducción de 32 MiB y como máximo 128 respuestas por conexión propia. Los diarios de inyección comparten el presupuesto de memoria fijado y el techo agregado de 128 MiB con los diarios de dirección; véase [límites de memoria de dirección](#steering-confirmation-deadlines-and-retained-context). El límite de cuerpo ascendente configurado se comprueba antes de que un resultado entre en la cola, incluso mientras otro resultado espera el acuse de recibo. Un rechazo `outbound_body_too_large` deja la conexión utilizable para un resultado corregido sin volver a ejecutar su herramienta. Cada inyección enviada tiene un plazo de confirmación de 90 segundos que la salida no relacionada no puede extender; una espera de resultado guardado está limitada a 30 minutos. Los límites de marco existentes y los tiempos muertos todavía se aplican.

Los proveedores traducidos, las puertas de enlace personalizadas, las rutas Combo / sidecar y el retroceso HTTP no obtienen soporte de inyección. Los intentos no soportados devuelven un error explícito en lugar de desaparecer. La opción permanece desactivada por defecto; las pruebas de transporte sintético no son una certificación de compatibilidad en vivo. Ajuste `codexNativeInjection` a `false` y reinicie para retroceder. No es necesario eliminar ningún archivo de cuenta o conversación.


<a id="rich-tool-results-and-explicit-approvals-after-response-completion"></a>

### Resultados enriquecidos de la herramienta y aprobaciones explícitas después de completar la respuesta

Con `codexNativeInjection` habilitado, un cliente-enviado `response.create` en la misma conexión de propiedad ahora puede devolver **no enviado** resultados de función/personalizados que contienen texto, imagen o partes de archivo después de `response.completed`. Suministre el `previous_response_id` de la respuesta completada, el mismo carril y el mismo modelo / configuración sin cambios. Incluya cada resultado sobresaliente o aprobación solicitada exactamente una vez; omita los resultados inyectados ya aceptados. El proxy reenvía esta continuación enviada por el llamante usando la cuenta original y el socket con las comprobaciones de envío existentes.

Los elementos de continuación admitidos son `function_call_output`, `custom_tool_call_output` y `mcp_approval_response`. La salida de la herramienta puede ser una cadena o una matriz de `input_text`, `input_image` y `input_file` partes. Las piezas de imagen requieren `detail` (`auto`, `low`, `high` o `original`); el detalle del archivo es opcional (`auto`, `low`, `high`). Utilice exactamente una fuente de imagen / archivo. Los datos de archivo en línea requieren un nombre de archivo. Se conserva la opción `prompt_cache_breakpoint: { "mode": "explicit" }`. Los campos no admitidos son rechazados, no eliminados. Las referencias no se descargan ni se vuelven a cargar por el proxy. Cada resultado tiene como máximo 1.024 partes de contenido dentro del límite de solicitud de 8 MiB existente. Una persona que llama al programa suministrado debe coincidir con la llamada anunciada; no puede hacerse pasar por otra herramienta o agente. El orden del contenido, las referencias de archivos y la ortografía original sobreviven.

Para un `mcp_approval_request` emitido por el servidor, pase su ID como `approval_request_id` y un `approve: true` o `approve: false` explícito. La denegación se envía sin cambios. El proxy no decide, por defecto, aprueba automáticamente ni ejecuta la herramienta solicitada. Se rechaza una decisión faltante o no relacionada. Las acciones alojadas `multi_agent_call` y otras herramientas de ejecución de servidor son **no** funciones de desarrollador: sus eventos, salidas y mensajes de agente cifrados se conservan, nunca se ejecutan o se inyectan antes de OpenCodex.

Esto no permite una respuesta rica / personalizada / de aprobación **inyección de respuesta media**, ni una dirección simultánea en una respuesta multiagente. Esas operaciones tienen diferentes contratos ascendentes. La inyección no admitida se rechaza antes de reservar una llamada, por lo que un resultado no enviado permanece disponible para una continuación explícita posterior. No hay conversión automática, reintento, reejecución de herramientas o cuenta / interruptor API. Un giro de dirección de agente único puede seguir un giro de agente múltiple completado como una nueva solicitud explícita utilizando enrutamiento ordinario. El soporte al cliente y el derecho de backend aún requieren verificación en vivo.


<a id="steering-continuation-settings"></a>

## Configuración de continuación de dirección

Un resultado guardado explícito `response.create` puede anular `reasoning` (esfuerzo y resumen), `text` (verbosidad y formato de salida estructurado compatible) y `stream_options`. Las rutas de suscripción rechazan una anulación `max_output_tokens` en lugar de ignorarla silenciosamente. Los pines de proveedor normales, las tapas de subagente, la asignación de esfuerzos y las exclusiones de capacidad de resumen/verbosidad aún se aplican.

Los ajustes omitidos retienen los valores efectivos actuales; el valor nulo explícito restablece ese ajuste donde el flujo ascendente acepta null. Las anulaciones reemplazan el objeto de ajuste suministrado, no los campos anidados individuales. Los valores cambiados se trasladan a continuaciones explícitas posteriores. Una anulación rechazada no reserva el resultado guardado, por lo que se puede enviar una solicitud corregida sin volver a ejecutar su herramienta. El servidor aún decide qué configuración acepta el modelo elegido. Los cambios en el modelo, cuenta, proveedor, herramientas, instrucciones o nivel de servicio requieren un turno ordinario separado.

La dirección nativa está restringida a la ruta canónica de suscripción ChatGPT. Las rutas públicas API -clave y puerta de enlace no son dirigibles; sus respuestas ordinarias se conservan y un intento de dirección recibe un error explicativo. Esto evita que las generaciones sucesoras en un socket retenido eviten la admisión normal por solicitud. La vía de inyección multiagente pública con compuerta separada API permanece disponible.

<a id="executable-direct-versus-proxy-wire-probe"></a>

### Sonda de alambre directa contra proxy ejecutable

Desde una comprobación de origen, ejecute el control positivo fuera de línea:

```sh
bun scripts/steering-smoke.ts --self-test
```

Planifique una comparación sin leer tokens ni abrir ninguna conexión:

```sh
bun scripts/steering-smoke.ts --direct wss://api.openai.com/v1/responses \
  --proxy ws://127.0.0.1:1455/v1/responses --model <supported-model> \
  --proxy-model <provider-prefix/same-model>
```

Para una comparación de suscripción, la URL directa es `wss://chatgpt.com/backend-api/codex/responses`. Seleccione el mismo modelo y cuenta reales en ambas rutas; el script no puede probar que una configuración proxy seleccionó la misma cuenta. La URL proxy debe ser un punto final Responses de bucle y no debe contener credenciales, parámetros de consulta ni un fragmento.

Solo después de revisar el plan, suministre `STEERING_DIRECT_TOKEN` y `STEERING_PROXY_TOKEN` a través de su entorno de shell y agregue **ambos** `--live` y `--allow-model-requests`. Una conexión directa ChatGPT puede necesitar adicionalmente `STEERING_DIRECT_ACCOUNT_ID`; ese encabezado nunca se copia al público API o al proxy. No ponga credenciales en argumentos de comando, registros, capturas de pantalla o relaciones públicas. El script no lee el inicio de sesión Codex guardado, actualiza tokens o cambia la configuración.

La ejecución en vivo envía cuatro solicitudes iniciales sintéticas (dos escenarios por ruta), más cualquier sucesor resultante o continuación de resultado requerido, y **puede consumir el uso del modelo**. Un escenario comprueba un sucesor automático; el otro devuelve un resultado sintético fijo solo para la función anunciada del propio script y cambia el razonamiento/verbosidad en su continuación explícita. No se ejecuta ninguna herramienta externa y no se infiere ninguna aprobación. No hay reintentos ni solicitudes de recuperación automática. Cada escenario está limitado a 120 segundos, 5.000 eventos y 2 MiB de datos recibidos.

El informe JSON contiene solo resultados, tiempos y puntos de control booleanos. Un pase requiere una aceptación en cola, un sucesor creado y el marcador sintético en su salida completada. Las confirmaciones que faltan son `unknown`; si el modelo nunca entra en la ruta de entrada requerida, el resultado es `not_exercised`. Tampoco se cuenta como pase. El proceso sale de 0 solo si pasan los cuatro escenarios en vivo, 1 en caso contrario y 2 para argumentos no válidos o credenciales faltantes. Se trata de un **diagnóstico de alambre**, no una prueba de interfaz de extremo a extremo Codex App / CLI, certificación en vivo o instrucción para habilitar la función experimental para el trabajo de producción.

<a id="streaming-line-endings"></a>

## Finales de línea de streaming

El decodificador SSE compartido acepta terminaciones de línea LF, CRLF y CR independientes, incluso cuando un delimitador abarca fragmentos de red. Esto permite a los proveedores compatibles transmitir eventos sin requerir encuadre de solo LF.


<a id="account-qualified-requests-and-credits"></a>

### Solicitudes y créditos calificados para cuentas

Elegir un modelo calificado para la cuenta no permite el gasto de crédito. Las cuentas almacenadas obedecen a **Usar créditos después del límite** durante la autenticación, cuando se preparan las credenciales y antes del envío de Responses HTTP o WebSocket después de la espera de estimulación o reintento. Una solicitud retenida informa de la política de crédito, no de un fallo de autenticación; espere a que se restablezca, elija otra cuenta o habilite explícitamente el gasto de crédito de esa cuenta.

Los ayudantes de visión de cuenta almacenada y búsqueda web también vuelven a verificar esta política antes de enviarla, incluidos los reintentos. Si el consentimiento cambia o se alcanza un límite después de la selección del ayudante, el ayudante informa el rechazo de la política sin enviar ese intento. El relé de búsqueda independiente devuelve un 429 unido por reinicio. Las credenciales Direct propiedad de la persona que llama conservan su comportamiento existente.

<a id="opt-in-a-custom-provider-to-managed-local-routing"></a>

## Optar por un proveedor personalizado para administrar el enrutamiento local

Un proveedor personalizado como `chatgpt-http` puede usar `supports_websockets = false` para mantener el transporte HTTP. OpenCodex deja a los proveedores personalizados intactos por defecto. Para delegar solo la URL de ese proveedor en OpenCodex, ejecute:

```sh
ocx codex-provider allow chatgpt-http
ocx start
```

El primer comando explica el alcance y pide confirmación, por defecto a No. Para una operación con script explícitamente aprobada, use `allow chatgpt-http --yes`. El consentimiento se aplica a este ID de proveedor en el `CODEX_HOME` seleccionado; no aprueba otros proveedores u otros hogares. Inicie y sincronice solo su `base_url` con el proxy local. Su identidad, configuración WebSocket, otros campos TOML e historial permanecen sin cambios. Mantenga el proxy en ejecución mientras usa esta ruta. Desactivar la integración Codex también impide que las actualizaciones de URL del proveedor aprobado se inicien o sincronicen; el consentimiento del proveedor guardado permanece disponible cuando lo vuelva a encender.

Este modo admite tablas de proveedores explícitas Responses con `requires_openai_auth = true` y sin credenciales o encabezados personalizados. Los objetivos no loopback, el modo de escritorio authless y la compactación del cliente requieren la integración dedicada existente.

`ocx stop` y `ocx restore` restauran las URL registradas mientras mantienen el consentimiento para un inicio posterior. Ejecute `ocx codex-provider status` para enumerar las aprobaciones, o `ocx codex-provider revoke chatgpt-http` para restaurar su URL administrada y eliminar el consentimiento. Una URL cambiada fuera de OpenCodex se conserva y requiere revocación seguida de una nueva aprobación; OpenCodex no adopta silenciosamente el reemplazo como una nueva línea de base. La asignación de URL original se conserva en metadatos de recuperación privados bajo `OPENCODEX_HOME`, por separado de la revista de configuración nativa.

La seguridad de inicio reconoce la URL administrada registrada de un proveedor aprobado como enrutamiento OpenCodex. Esto no instala protección de reinicio: un proxy iniciado manualmente todavía necesita un servicio de fondo viable para recuperarse automáticamente después de un reinicio.

<a id="native-desktop-relay-connect-validation"></a>

## Validación de relé de escritorio nativo CONNECT

El transporte CONNECT HTTP / HTTPS existente del relé de escritorio ahora rechaza las cabeceras de respuesta proxy mal formadas y los nombres de usuario básicos ambiguos HTTP que contienen dos puntos. Los pares de credenciales decodificadas están limitados a 4096 bytes UTF-8. Si el proxy seleccionado es rechazado, corrija su configuración o respuesta; el relé no cambia silenciosamente a una conexión directa.

La selección de proxy, el soporte SOCKS5h, la verificación de certificados y el ciclo de vida de la conexión no cambian. Ambas ortografías SOCKS retienen la resolución DNS de destino remoto.
