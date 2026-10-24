---
title: "Despliegue de Remote Hub"
description: "Ejecute un concentrador opencodex de un puerto en Linux, macOS o Docker con un loopback acompañante, un token de datos autoaprovisionado, ocx hub invite, una entrada de administración solo loopback, Tailscale Serve y OAuth sin cabeza."
---

Para enlaces de máquinas SSH, véase [Enlace remoto](/es/guides/remote-link/).

Un concentrador opencodex mantiene las credenciales del proveedor y el estado de uso en un host mientras los clientes autenticados usan su plano de datos de forma remota. El plano de gestión orientado al navegador es independiente: un oyente opcional vincula solo `127.0.0.1`, sirve el tablero de instrumentos y `/api/*`, y está destinado a sentarse detrás de Tailscale Serve u otro frontend HTTPS propiedad del operador.

El plano de datos es **Un puerto**. Las máquinas remotas marcan `hostname:port` con su propia clave por cliente; los propios procesos del concentrador marcan `127.0.0.1:<the same port>` sin credenciales, a través del loopback compañero de escucha. Comience desde [La receta abajo](#linux-systemd-or-macos-launchd), luego entregue a una segunda máquina un comando listo para usar con [`ocx hub invite`](#inviting-another-machine).

La entrada de gestión nunca sirve `/v1/*`, `/healthz` o `/readyz`. Cuando se habilita explícitamente, el espacio de trabajo remoto admite solo su agente WebSocket autenticado por portador emparejado y su intercambio de emparejamiento único; véase [Espacio de trabajo remoto](/es/guides/remote-workspace/). No publique su puerto directamente, no agregue una regla de firewall en la nube para él y no use Tailscale Funnel. Funnel es una superficie de Internet pública y está fuera de este modelo de despliegue.

Con la entrada de administración habilitada, el comando del panel local abre `http://127.0.0.1:<management port>` para que la dirección coincida con el oyente solo IPv4 sin resolver `localhost`.

Las configuraciones del cliente exportadas o aplicadas a través de ese panel de control siguen apuntando al oyente de inferencia, no al puerto de administración. Los clientes locales usan el puerto complementario de bucle de retorno configurado (o el puerto del oyente público real cuando el compañero no tiene un puerto explícito).

<a id="trust-and-consent-boundaries"></a>

## Límites de confianza y consentimiento

- El proveedor y las credenciales OAuth permanecen en el concentrador. Nunca los copie en un cliente, capa de imagen, definición de servicio, paquete de soporte, captura de pantalla o línea de comandos.
- El token de admisión de datos se entrega a través del archivo `service-api-token` o `OCX_API_TOKEN_FILE`. No es una credencial de gestión.
- El `allowedModels` de un cliente configurado debe incluir tanto el ejecutor como cualquier modelo de Asesor facturado por separado utilizado por el Anthropic Messages nativo administrado. Se aceptan los ID de modelo desnudo y los `provider/model` nombres configurados del concentrador. Un destino de Asesor no permitido o sin nombre devuelve HTTP 403 antes del envío del proveedor; las claves solo de proveedor y sin restricciones conservan su alcance existente.
- GitHub Copilot Auto vuelve a comprobar el modelo concreto seleccionado durante la negociación y la renovación. Un modelo fuera del alcance permitido del cliente finaliza la solicitud con `model_not_allowed_for_key` (HTTP 403 antes de la transmisión, o un error de terminal en un flujo ya iniciado). La rotación de credenciales o un objetivo alternativo no pueden anular ese rechazo.
- Un token de administrador de administración en bruto puede realizar una administración ordinaria, pero no puede acuñar una sesión de navegador ni autorizar acciones con consentimiento, como protagonizar el repositorio. Esas acciones requieren un `gui-session` emitido por el servidor, un origen de navegador coincidente y un token CSRF.
- `Tailscale-User-Login` se confía solo en la entrada de administración por separado. Se ignora el mismo encabezado en el oyente público. `remoteGui.allowedTailscaleUsers` controla la emisión de la sesión; no crea un nuevo principal de propósito general.

<a id="roles-and-direct-data-flow"></a>

## Roles y flujo directo de datos

`standalone` mantiene los datos y la administración en una sola máquina. Un `hub` posee las credenciales del proveedor, el catálogo y los registros de uso. Un `client` almacena solo sus metadatos de conexión y una clave de datos por cliente. Codex y Claude el tráfico va directamente desde el cliente al centro de escucha de datos; no se tuneliza a través del tablero de instrumentos o el relé de gestión de loopback.

Conéctese con exactamente una fuente de autoridad transitoria. La autoridad se lee desde stdin y nunca se escribe en config o en el archivo token:

```bash
ocx connect https://hub-name.tailnet-name.ts.net --pairing-code-stdin
ocx connect status
ocx sync
```

Los diagnósticos de preparación legibles por humanos muestran caracteres de control en valores de catálogo como escapes hexadecimales visibles, tanto cuando se conecta por primera vez como cuando `ocx sync` rechaza un catálogo de concentrador actualizado. El estado estructurado JSON conserva el valor de diagnóstico original.

No tienes que armar esa línea a mano. `ocx hub invite`, se ejecuta en el concentrador, acuña el código e imprime el comando exacto, incluidos ambos orígenes, para la máquina que se está uniendo. Véase [Invitar a otra máquina](#inviting-another-machine).

El concentrador emite automáticamente una clave por cliente. El cliente lo escribe en el archivo `service-api-token` existente solo para el propietario, nunca en `config.json`. Mientras está conectado, el uso proviene del almacén de uso del concentrador filtrado al establo `apiKeyId` de ese cliente. Después de la desconexión, el uso proviene de la tienda local. OpenCodex no refleja el uso entre las dos tiendas. `ocx service uninstall` elimina el servicio local pero conserva una clave existente cuando el cliente está conectado, sus metadatos de conexión no son válidos o no coinciden, o un marcador de conexión pendiente coincide con la clave actual. Un marcador válido para una clave anterior no retiene una clave de servicio no relacionada. Si un marcador no es seguro, está mal formado o es ilegible, no se puede verificar la limpieza del token; el comando advierte en lugar de afirmar que se mantuvo la clave. Utilice `ocx disconnect` para eliminar la clave local y el estado de un cliente conectado.

Si un cliente guardó una URL de concentrador remota `http://` antes de la regla de transporte seguro, sus operaciones de concentrador ahora devuelven `insecure_http_refused`. Ejecute el `ocx disconnect` localmente, luego vuelva a conectar al Hub con el `https://` (o use el bucle de retroceso HTTP cuando ambos lados estén en la misma máquina).

Rotar un cliente conectado con una nueva autoridad transitoria:

```bash
ocx connect rotate --pairing-code-stdin
# or, only over HTTPS:
ocx connect rotate --admin-token-stdin
```

La rotación mantiene las claves de datos antiguas y nuevas válidas durante un máximo de diez minutos bajo el mismo `apiKeyId`. El cliente realiza una copia de seguridad del token antiguo como `service-api-token.prev`, instala atómicamente y sondea la nueva clave, luego confirma. Si una respuesta de confirmación es incierta, vuelva a ejecutar el comando rotar con autoridad transitoria; la recuperación prueba ambos archivos antes de confirmar o restaurar. Nunca elimine ninguno de los archivos cuando se informe de recuperación de que ambos candidatos fueron rechazados.

`ocx disconnect` es local y funciona mientras el concentrador está fuera de línea. Restaura el estado del cliente local y no revoca la clave de concentrador. Después de desconectar, revoque esa clave de **Conecte las llaves → API** en el concentrador. `ocx connect revoke --admin-token-stdin` solo está disponible mientras está conectado y utiliza el persistente `apiKeyId`; no acepta la anulación de id. La sesión de cierre de sesión/caducidad del navegador está separada de la rotación, revocación y desconexión de la clave de datos.

<a id="what-a-connected-client-shows"></a>

### Lo que muestra un cliente conectado

`ocx connect` y `ocx connect status` comprueban la disponibilidad del catálogo contra el primer entorno de ejecución local válido de Codex en orden de selección. Los candidatos preferidos fallidos pueden retroceder, pero las alternativas de menor prioridad no se prueban después de que se selecciona un entorno de ejecución válido. Esta comprobación deja la selección de entorno de ejecución guardada sin cambios. General `ocx status` todavía descubre alternativas para el diagnóstico en entorno de ejecución.

Un cliente no almacena credenciales de proveedor y ningún catálogo propio, por lo que su tienda de configuración y credenciales locales están vacías por diseño, y leerlas como la verdad produce una respuesta segura y errónea sobre lo que el concentrador puede servir. En un cliente conectado `ocx status` por lo tanto conduce con `State from hub <origin>` y fuentes las líneas de OAuth - inicios de sesión, proveedores y modelos delegables desde el concentrador sobre el plano de datos, etiquetando las líneas que realmente describen esta máquina `(local)`: el proxy, el servicio, el binario Codex y la shim, y los puertos locales. `ocx status --json` lleva la misma respuesta que `runtimeRole` más un bloque `remoteHub` cuyo `stateSource` es `hub`, `cache` o `unavailable`, nunca el propio estado del cliente. Un concentrador más antiguo que no sirve `/v1/hub-state` informa `unavailable` con una instrucción para actualizar el concentrador en lugar de volver silenciosamente al estado de inicio de sesión local, y `ocx config show` en un cliente imprime una nota `_remoteHub` que indica las credenciales y la disponibilidad del modelo en vivo en el concentrador. La lectura de concentrador utiliza solo la clave de datos por cliente; ningún token de administrador y ningún secreto de proveedor llegan a un cliente.

`ocx status` realiza una solicitud de estado de concentrador en vivo solo cuando la conexión guardada aún coincide con la instantánea de estado y el archivo de token de datos coincide con esa conexión. Si falla la comprobación, se salta la solicitud y muestra el estado del concentrador en caché coincidente, o `unavailable` si no existe caché coincidente.

<a id="linux-systemd-or-macos-launchd"></a>

## Lanzamiento de Linux systemd o macOS

Vincule el oyente de datos a la dirección de Tailscale del concentrador, habilite el compañero de bucle de retorno para que los propios procesos del concentrador lleguen a ese mismo puerto sin una credencial y publique la administración por separado. Los valores siguientes son ejemplos:

:::danger[Usa un servidor dedicado para un solo usuario]
El compañero de loopback no está autenticado: cada proceso y usuario del sistema operativo en esta máquina puede usar el credenciales del proveedor del concentrador y la cuota de cuenta, y puede agotar la capacidad de giro compartida que clientes remotos autenticados dependen de. No lo habilite en un host compartido o multi-tenant. Si el host es compartido, deja el `unauthenticatedLoopbackListener` configuración deshabilitada y no ejecute el local del concentrador integraciones.

Vinculación a `127.0.0.1` significa que el kernel rechaza conexiones remotas, pero no detiene un navegador: una página que visita puede hacer que su navegador se conecte a `127.0.0.1`. Por lo tanto, el oyente misma `Host` y `Origin` como un enlace de bucle de retorno ordinario.
:::

```bash
ocx config set runtimeRole hub
ocx config set hostname 100.64.0.10
ocx config set corsAllowOrigins '["http://localhost:10100"]'

# A fresh standalone config has no `hub` or `remoteGui` object, and `ocx config set` does not
# create a missing parent: a nested set fails with `config parent path not found: hub`. Setting
# `runtimeRole` does not create it either. Create each object first, then set its fields.
ocx config set hub '{}'
ocx config set remoteGui '{}'
ocx config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
ocx config set hub.dataPublicOrigin '"https://hub-name.tailnet-name.ts.net:8443"'
ocx config set hub.managementIngress '{"enabled":true,"port":10101}'
ocx config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'

# One port. Remote machines dial 100.64.0.10:10100 with their own key; the hub's own local
# processes dial 127.0.0.1:10100 with no credential, on that same port.
ocx config set unauthenticatedLoopbackListener '{"enabled":true}'

# No token to export: install provisions the hub's own data-plane token. See below.
ocx service install
ocx service status
ocx status                # the "Hub:" block summarizes every line above
```

En una configuración genuinamente vacía, puede establecer cada objeto en una llamada en su lugar:

```bash
ocx config set hub '{"managementPublicOrigin":"https://hub-name.tailnet-name.ts.net","dataPublicOrigin":"https://hub-name.tailnet-name.ts.net:8443","managementIngress":{"enabled":true,"port":10101}}'
ocx config set remoteGui '{"allowedTailscaleUsers":["operator@example.com"]}'
```

Utilice esa forma solo cuando el objeto no existe todavía. Un conjunto de objetos enteros **sustituye** el objeto en lugar de fusionarse en él, por lo que ejecutar la línea de arriba contra una configuración que ya tenía `hub.managementIngress` silenciosamente deja caer la entrada. Cuando esté adaptando una configuración existente, establezca un campo a la vez: el padre ya está allí, por lo que la forma anidada funciona y no toca nada más.

Dos detalles que deciden si se acepta una línea. El valor se analiza primero como JSON y vuelve a la cadena sin procesar, por lo que una URL se escribe como `'"https://…"'`: objetos, matrices, booleanos y números deben ser válidos JSON. Y `hub` y `remoteGui` son estrictos, por lo que una clave mal escrita se rechaza en el momento de la escritura como `schema_invalid: hub.<field>` en lugar de convertirse en una configuración que nunca tiene efecto. `managementPublicOrigin` y `dataPublicOrigin` deben ser cada uno un origen desnudo sin ruta, consulta o fragmento.

<a id="the-data-plane-token-provisions-itself"></a>

### Aprovisionamiento automático del token de datos

No hace falta ejecutar `export OPENCODEX_API_AUTH_TOKEN=…` antes de `ocx service install`. Cuando el servicio escucha fuera de loopback, el instalador resuelve el token de admisión de datos con esta precedencia y lo guarda en `service-api-token`, accesible solo por su propietario y con modo `0600`:

1. **`OPENCODEX_API_AUTH_TOKEN`**, si está exportado en la terminal que ejecuta la instalación. Así se conserva el valor elegido por el operador.
2. **El archivo existente `service-api-token`.** Reutilizarlo hace que `ocx service install`, `ocx service repair` y los reinicios sean idempotentes: generar otro valor invalidaría las claves por cliente ya intercambiadas con el anterior. El archivo se vuelve a comprobar antes de reutilizarlo; no se confía en él sin validarlo. Véase la comprobación de colisiones con el token de administración más abajo.
3. **Un token nuevo de 32 bytes aleatorios codificados en hexadecimal.** Esta opción elimina la necesidad de crear el token manualmente.

El comando imprime la **ruta**, nunca el valor. Tanto el plist de launchd como la unidad de usuario de systemd leen ese archivo protegido al iniciar el proceso; ninguno contiene el token literal. No pegues su valor en `ocx config show`, en la salida de la unidad o del plist, en capturas ni en paquetes de soporte. `ocx start` en primer plano también lee ese archivo: puede escuchar fuera de loopback sin que exportes el token.

Se rechaza cualquier token de datos que **coincida con el de administración**, tanto en la variable como en el archivo. El mensaje indica cómo corregir cada origen. Si la colisión está en `OPENCODEX_API_AUTH_TOKEN`, ejecuta `unset OPENCODEX_API_AUTH_TOKEN` y vuelve a iniciar. Si está en el archivo reutilizado `service-api-token`, elimina ese archivo y después ejecuta `ocx service repair`; quitar una variable no corrige el archivo. Ambas comprobaciones se ejecutan antes de omitir los requisitos de admisión por tratarse de loopback, de modo que también protegen una instalación local. El wrapper de arranque exporta el archivo como `OPENCODEX_API_AUTH_TOKEN` independientemente del hostname; una colisión impediría iniciar la API de administración.

Los dos planos usan credenciales diferentes. El token de datos admite llamadas a `/v1/*` y no permite administrar el proxy. Como el servicio aprovisiona su propio token, no hace falta exportar ninguno de los dos. Una vez que existe el archivo, `ocx service repair` no vuelve a exigir la variable de entorno.

`ocx status` muestra el estado del token sin revelar su valor: `present (file)`, `unsafe (file)` si los permisos no son exclusivos del propietario, `admin-collision (file)` si coincide con el token de administración, o `missing`. En caso de colisión también explica la consecuencia y la corrección. Este estado describe siempre el **archivo**, porque el wrapper sobrescribe el entorno antes de ejecutar el proceso. Una línea aparte indica si la terminal tiene `OPENCODEX_API_AUTH_TOKEN` establecido, que es el valor que usaría un `ocx start` en primer plano desde esa terminal.

<a id="one-port-and-the-ported-alternative"></a>

### Un puerto, y la alternativa porteada

`unauthenticatedLoopbackListener: {"enabled": true}` con **no** `port` es la forma *compañero*: un segundo zócalo en `127.0.0.1:<proxy port>` - el mismo número de puerto que el oyente público utiliza en la dirección tailnet. Esa es la dirección que ya escribe cada integración local, por lo que no se debe enseñar nada en el concentrador a un nuevo puerto, y un puerto mantiene toda la superficie de datos remota.

El formulario complementario se acepta solo cuando `hostname` es una dirección específica no loopback, no comodín. En `127.0.0.1`, `localhost`, `0.0.0.0` o `::` el oyente público ya tiene esa dirección de bucle, por lo que opencodex rechaza el par en el momento de la escritura y nuevamente en el inicio, nombrando la colisión, en lugar de dejar que el segundo enlace falle. En esos enlaces no necesitas al oyente en absoluto: un enlace de bucle de retorno ya admite llamadas locales.

La forma más antigua *ported* todavía funciona y es la alternativa cuando desea que las dos superficies en puertos separados:

```bash
ocx config set unauthenticatedLoopbackListener '{"enabled":true,"port":10104}'
```

La forma portada es la misma superficie no autenticada: la advertencia de host dedicado anterior también se aplica a este comando.

Con un conjunto `port`, las integraciones locales siguen al oyente y escriben `http://127.0.0.1:10104` en su lugar. El puerto debe diferir del puerto proxy y nunca está asignado al sistema operativo: un puerto efímero cambiaría en los reinicios mientras que los servidores de aplicaciones que ya se ejecutan conservarían el anterior `base_url`.

**Reinicie el proxy después de cambiar este campo.** Los sockets se unen una vez al iniciarse y los archivos de cliente local se escriben a partir del valor resuelto, de modo que un concentrador en ejecución mantiene su respuesta antigua. En un concentrador portado que es la diferencia entre `ocx claude` llegar al oyente y obtener un `404` de él. En un servicio de fondo el verbo es `ocx service restart`, que siempre se reinicia - ver [macOS operaciones de servicio](#macos-service-operations). `ocx restart` es un verbo diferente: rebota el proceso proxy que usted mismo comenzó, no el servicio que supervisa el gerente.

<a id="the-hubs-own-local-clients"></a>

### Los propios clientes locales del hub

Un concentrador solía ser la única máquina que no podía usarse a sí misma: `ocx claude`, Claude Desktop, Cursor, la inyección `system-env` y el asistente de visión enrutado, todos marcan `http://127.0.0.1:<port>`, que no existe cuando el oyente está vinculado a una dirección de red Tailscale. Con el oyente de loopback habilitado, trabajan en el concentrador:

```bash
ocx sync          # the hub now writes its own Codex/Grok blocks
ocx claude        # Claude Code wired to the hub's own loopback address
```

El oyente solo lleva cables de inferencia: `POST /v1/responses` y su actualización WebSocket, `POST /v1/responses/compact`, `POST /v1/messages`, `POST /v1/chat/completions`, `POST /v1/alpha/search`, `GET /v1/models` y la superficie de voz en tiempo real. `POST /v1/messages/count_tokens` se admite deliberadamente **no**, por lo que Claude Code vuelve a la estimación de token local: una pérdida cosmética, no un lanzamiento roto. `/api/*`, `/healthz`, `/readyz` y el tablero de instrumentos todos devuelven `404` allí: lecturas de administración local como la llamada de descubrimiento de `ocx claude` van a la superficie de administración autenticada con una credencial de administración, nunca a un socket no autenticado. Es por eso que la entrada de la gerencia y este oyente siguen siendo dos cosas diferentes.

Con el oyente **apagado**, un concentrador deliberadamente no reescribe sus propias configuraciones de cliente, y cada salto nombra la puerta que lo detuvo:

```text
This machine is a hub; it does not rewrite its own Codex/Grok/Claude configs unless
unauthenticatedLoopbackListener is enabled.
```

Esa frase significa la puerta del concentrador, no su conmutador `clientIntegrations`. `ocx ensure` deja un bloque gestionado existente Grok en su lugar cuando está cerrado en lugar de despojarlo, y `ocx restore back` informa de la puerta en lugar de culpar a un escritor competidor.

<a id="acceptance-on-the-data-plane"></a>

### Aceptación en el plano de datos

Demostrar vivacidad y disposición en el oyente de datos públicos:

```bash
curl --fail --silent http://100.64.0.10:10100/healthz
curl --fail --silent http://100.64.0.10:10100/readyz
```

Un `200` de `/healthz` solo demuestra que el proceso está vivo. La aceptación de implementación también requiere `/readyz`, una autenticación `GET /v1/catalog` y una respuesta real enrutada.

<a id="tailscale-serve"></a>

## Escala de cola Servir

Primero prueba que el socket de administración es solo loopback, luego publícalo a través de Serve:

```bash
ss -ltnp | grep 10101        # Linux: expected 127.0.0.1:10101 only
lsof -nP -iTCP:10101 -sTCP:LISTEN  # macOS: expected 127.0.0.1 only

tailscale serve --bg --https=443 http://127.0.0.1:10101
tailscale serve status
```

Establecer `hub.managementPublicOrigin` al origen exacto HTTPS mostrado por Serve. Agregue el inicio de sesión de Tailscale exacto del operador a `remoteGui.allowedTailscaleUsers`; una lista vacía significa que ninguna identidad remota puede acuñar una sesión. Verifique ambas direcciones:

```bash
# Negative: the loopback-only port must not be reachable through the node's tailnet address.
curl --fail --connect-timeout 3 http://100.64.0.10:10101/ && echo "unexpected exposure"

# Positive: the HTTPS dashboard loads through Serve from an allowed tailnet user.
curl --fail --silent --show-error https://hub-name.tailnet-name.ts.net/ >/dev/null
```

La prueba de navegador positiva debe usar una sesión Tailscale con inicio de sesión real; un `curl` desnudo puede no llevar los encabezados de identidad necesarios para la emisión automática de la sesión. El emparejamiento sigue siendo la alternativa cuando el frontend HTTPS no puede proporcionar una identidad de Tailscale confiable.

<a id="giving-the-data-listener-tls"></a>

### Dar al oyente de datos TLS

El mapa Serve de arriba publica solo la entrada **gestión**. Ese ingreso nunca sirve `/v1/*`, `/healthz` o `/readyz`, por lo que por sí solo no le da a un cliente remoto un plano de datos utilizable. opencodex también termina no TLS de su propio: el oyente es llano HTTP y HTTPS es siempre un frontend poseído por el operador.

Servir puede ser ese frontend para el plano de datos también, en un segundo puerto HTTPS. En macOS necesita un salto extra, porque Tailscale Servir proxies solo a `127.0.0.1` - no puede apuntar al oyente que enlaza a la propia dirección tailnet del nodo, y la compilación de App Store del cliente macOS rechaza un destino remoto por completo. Ejecutar un reenviador de bucle en el concentrador y apuntar Servir en eso:

```bash
# Any loopback TCP forwarder works; socat is one. Pick a port the hub is not already using:
# with the loopback companion enabled, 127.0.0.1:10100 belongs to opencodex itself.
socat TCP-LISTEN:10110,bind=127.0.0.1,fork,reuseaddr TCP:100.64.0.10:10100 &

tailscale serve --bg --https=8443 http://127.0.0.1:10110
tailscale serve status   # expect both mappings: 443 -> 10101, 8443 -> 10110
```

**No apuntes Servir al oyente acompañante del loopback.** Es un socket real en `127.0.0.1:10100`, por lo que se crearía la asignación y luego fallaría de la misma manera que describe la trampa a continuación: el compañero ejecuta la política de admisión de loopback, que requiere un encabezado de loopback `Host`, y sirve hacia adelante `Host: hub-name.tailnet-name.ts.net`. El compañero existe para los procesos *on* el concentrador, que envían un loopback `Host` propio. El promotor lleva el oyente tailnet, cuya admisión de credenciales y manejo `Host` es lo que necesita un frontend TLS.

Servir acepta un conjunto limitado de puertos HTTPS; confirmar que el mapeo fue creado con `tailscale serve status` en lugar de asumir que el puerto estaba permitido.

Dar al promotor la misma vida útil que el hub. Un trabajo de shell en segundo plano muere en el reinicio mientras que el El servicio vuelve a aparecer, lo que deja un concentrador que se ejecuta e inalcanzable sobre TLS; ejecútelo desde lanzamiento o systemd junto `ocx service install`.

Luego conéctese con los dos orígenes establecidos por separado. El URL posicional es el origen **datos** - es donde `/readyz` y `/v1/catalog` son buscados - y `--management-url` es el origen del tablero de instrumentos utilizado para el emparejamiento y la emisión de claves. No tienen que compartir un puerto:

```bash
# This is exactly the line `ocx hub invite` prints, with the code filled in.
echo '<pairing-code>' | ocx connect https://hub-name.tailnet-name.ts.net:8443 \
  --management-url https://hub-name.tailnet-name.ts.net \
  --pairing-code-stdin
```

Registre esos dos orígenes en el centro como `hub.dataPublicOrigin` y `hub.managementPublicOrigin`, y `ocx hub invite` los imprimirá para usted en lugar de pedirle que los recuerde.

Cuando se omite `--management-url`, se toma de la respuesta `/readyz`, que informa `hub.managementPublicOrigin`. Establecerlo explícitamente es más claro cuando los dos orígenes difieren.

**No corte esto vinculando el receptor de datos a `127.0.0.1`.** Un enlace de loopback es cómo opencodex reconoce una implementación puramente local: deja de requerir una credencial de datos y comienza a requerir que el encabezado `Host` de la solicitud también sea loopback. Un frontend TLS avanza `Host: hub-name.tailnet-name.ts.net`, por lo que `/v1/catalog` responde `403 origin_rejected` - mientras que `/readyz`, que no ejecuta esa comprobación, todavía devuelve `200`. El despliegue se ve saludable y no puede servir a un modelo. Nada en la ruta de solicitud lee `X-Forwarded-Host`, por lo que el frontend no puede repararlo. Mantenga al oyente en la dirección de la red Tailscale, donde se mantiene la admisión de credenciales y no se aplica el cheque `Host`.

Esa trampa es sobre el **enlace**, y sigue siendo cierto. Obtener un conector `127.0.0.1` en un concentrador para los propios procesos del concentrador es un problema diferente, y [`unauthenticatedLoopbackListener`](#one-port-and-the-ported-alternative) es la respuesta sancionada: el enlace público permanece en la dirección de la red Tailscale con la admisión activada, y un segundo conector sirve a las personas que llaman locales. No es un objetivo TLS, por la razón dada anteriormente.

La vinculación `0.0.0.0` también funciona y elimina la necesidad de un promotor, ya que el oyente es entonces accesible en loopback también. Publica el puerto de datos en cada interfaz, por lo que lo prefiere solo dondel host no tiene otra red que le importe, y tenga en cuenta que la forma complementaria de `unauthenticatedLoopbackListener` se rechaza en un enlace comodín, porque el oyente público ya tiene `127.0.0.1:<port>` allí.

Vuelva a ejecutar las comprobaciones de aceptación contra el origen de datos HTTPS una vez que Serve esté activo: `/readyz`, un `GET /v1/catalog` autenticado y una respuesta enrutada real.

<a id="operator-owned-tsnet-certificate-proxy"></a>

### Proxy de certificado ts.net propiedad del operador

Si opera su propio proxy TLS, obtenga un certificado solo para el FQDN completo de ts.net:

```bash
tailscale cert hub-name.tailnet-name.ts.net
```

Proteja la clave privada, renuévela a través del mecanismo compatible de Tailscale y provide solo a `127.0.0.1:10101`. Un proxy genérico TLS no proporciona una identidad fiable de Tailscale. No fabrique encabezados `Tailscale-User-*`; use el flujo de emparejamiento de un solo uso vinculado al origen.

<a id="inviting-another-machine"></a>

## Invitar a otra máquina

Ejecute esto en el concentrador en lugar de escribir una línea `ocx connect` a mano:

```bash
ocx hub invite
```

Acuña un código de emparejamiento de un solo uso y de corta duración e imprime el comando para ejecutarse en la otra máquina:

```text
# Run on the other machine:
echo '<code>' | ocx connect https://hub-name.tailnet-name.ts.net:8443 --management-url https://hub-name.tailnet-name.ts.net --pairing-code-stdin
```

El origen de los datos proviene de `--data-url`, luego `hub.dataPublicOrigin`, luego la dirección de enlace. Ese último recurso solo funciona cuando el enlace **es** una dirección que otra máquina puede marcar: en un enlace de loopback o comodín se resolvería con `http://localhost:<port>`, que le dice a la otra máquina que se marque a sí misma y gasta el código de un solo uso por nada, por lo que `invite` se niega e imprime la línea `ocx config set hub.dataPublicOrigin` (más el formulario `--data-url` por invitación). Un `--data-url` o `hub.dataPublicOrigin` explícito nunca se cuestiona en segundo lugar: un origen de datos de bucle de retorno es legítimo sobre un túnel SSH.

El origen de gestión es `hub.managementPublicOrigin`, y en `invite` el indicador `--management-url` es un **confirmación, no una anulación**: la concesión está vinculada al origen configurado y el intercambio se compara con él, por lo que se rechaza un valor que difiere con ambos orígenes nombrados en lugar de imprimir un código que el concentrador rechazaría.

Cada invitación exitosa también imprime el **origen del navegador vinculado** en stderr. Una concesión está vinculada a un origen, y un remoto `ocx connect` presenta `Origin: http://localhost:<its own configured port>`, por lo que si el origen vinculado no es el predeterminado `http://localhost:10100`, la otra máquina ya tiene que estar funcionando en ese puerto antes de que ejecute la línea, de lo contrario el concentrador rechaza el intercambio y el código se gasta. La nota dice qué puerto, y ofrece admitir el origen predeterminado en su lugar.

`invite` rechaza *antes* acuñando cualquier cosa cuando la configuración no puede funcionar: un `runtimeRole` que no es `hub`, un `hub.managementPublicOrigin` faltante, un origen de gestión sin bucle de retorno de texto plano, un `--data-url` mal formado, un origen de datos que sería el propio bucle de retorno de esta máquina, o ningún proxy certificado en ejecución. Una condición previa merece su propio párrafo.

**`corsAllowOrigins` tiene que nombrar el origen del navegador local de la máquina de unión.** `ocx connect` envía `Origin: http://localhost:<its own proxy port>` cuando intercambia la concesión, y las concesiones están vinculadas al origen, por lo que solo el propio `hub.managementPublicOrigin` o una entrada de bucle de `corsAllowOrigins` pueden coincidir. Sin ninguno presente, `invite` sale no cero, no acuña nada y nombra el comando exacto:

```bash
ocx config set corsAllowOrigins '["http://localhost:10100"]'
```

Utilice el puerto en el que escucha el proxy de la máquina **afiliarse**; `10100` es el valor predeterminado. El bloque de configuración anterior ya lo establece. Un conjunto de matrices completas reemplaza la matriz, por lo que cuando el concentrador ya tiene entradas, ejecuta la línea `invite` impresiones, lleva las existentes más el nuevo origen. `ocx config get
corsAllowOrigins` muestra lo que hay ahora.

`ocx hub invite --json` emite `{ code, expiresAt, dataUrl, managementUrl, command }` con `expiresAt` como ISO 8601. El código es un secreto: de un solo uso, cinco minutos de vida útil, tasa limitada en el concentrador, y no debe ser persistente, registrado o pegado en un problema. `--clients codex,claude` elige qué cliente configura el comando impreso apuntará al concentrador.

`invite` es una conveniencia sobre el flujo de emparejamiento existente, no un segundo mecanismo. Conduce la misma ruta local certificada que usa `ocx gui pair`, por lo que no necesita un token de administración y no tiene que exportarse a su shell. Todo en [Roles y flujo directo de datos](#roles-and-direct-data-flow) sobre rotación, revocación y desconexión se aplica sin cambios a una máquina que se unió de esta manera.

<a id="macos-service-operations"></a>

## Operaciones de servicio macOS

`ocx service install` y `ocx service repair` se pueden volver a ejecutar en un hub activo. La reparación genera primero el plist y lo compara con el guardado. Si ambos son idénticos, el archivo de token no ha cambiado y `launchctl print` confirma que el job está cargado desde ese plist, se restablecen los permisos `0600`, se actualiza el estado de instalación y se muestra `service is already loaded from the current plist; nothing to do.`. En ese caso no se modifica launchd. Las versiones anteriores descargaban incondicionalmente un job sano, convirtiendo un comando de diagnóstico en una interrupción del servicio.

**`ocx service restart` siempre solicita un reinicio.** Ya no es un alias de `repair`. Ejecuta la misma actualización y, si no hubo que recargar nada porque el job está sano y sin cambios, lo reinicia con `launchctl kickstart -k`. Después vuelve a consultar `launchctl print` para confirmar que el job sigue cargado y muestra:

```bash
ocx service restart
# ℹ️  service restarted (launchctl kickstart -k gui/501/com.opencodex.proxy).
```

Usa ese comando después de cambiar `unauthenticatedLoopbackListener`, `hostname` o `port`. El reinicio con kickstart no descarga previamente el job, por lo que evita la ventana sin registro que provocaba la reparación incondicional antigua.

`ocx service`, sin subcomando, sigue eligiendo `repair`, no `restart`: actualiza la instalación de forma idempotente y no solicita reiniciar un hub sano. Usa `ocx service repair` para corregir un job cargado desde un plist anterior o que ya no está cargado. Si está sano, no lo reiniciará.

También siguen funcionando `launchctl kickstart -k gui/$(id -u)/com.opencodex.proxy` y la secuencia `ocx service stop` seguida de `ocx service start`. El mensaje de error ofrece el primero como alternativa, pero la vía recomendada es `ocx service restart`.

En Linux y Windows no existía esta diferencia: `ocx service restart` usa respectivamente `systemctl --user restart` y la detención seguida del inicio de la tarea programada, según lo solicitado.

`ocx service status` distingue cuatro launchd estados, y el último es el que la gente malinterpretó:

| Resumen | Descripción |
| --- | --- |
| `installed and loaded` | Un dominio responde y ejecuta el comando definido en el plist actual. Estado normal. |
| `installed and loaded from an OLDER plist` | El job se ejecuta con una definición anterior. `ocx service repair` la actualiza. |
| `installed, not loaded` | Todos los dominios respondieron que el job está ausente. La reparación vuelve a registrarlo. |
| `installed; launchd state could not be verified` | No se pudo consultar `launchctl`, por ejemplo por falta de acceso al dominio `gui/<uid>`. Esto **no demuestra** que el hub esté caído: no se recomienda reparar por ese motivo ni se marca como muerto un proxy que sigue activo. |

Antes, una consulta que no se podía ejecutar se presentaba como «no cargado». Eso podía llevar a reparar un servicio sano y hacer que el actualizador iniciara otro proxy en el puerto que ya utilizaba el servicio.

<a id="headless-oauth"></a>

## Sin cabeza OAuth

Deshabilitar el inicio del navegador en el concentrador:

```bash
ocx config set oauthOpenBrowser false
```

1. Desde el panel de control remoto autenticado o el cliente de administración, inicie `POST /api/oauth/login` para el proveedor. El concentrador devuelve la URL de autorización y las instrucciones sin abrir un navegador.
2. Abra la URL en la máquina del operador y autorice allí.
3. Si la devolución de llamada no puede llegar al concentrador, pegue la URL o el código de redirección final en el panel de control/ CLI. Envía `POST /api/oauth/login/code` con `{provider,input}`.
4. Sondear el punto final de estado existente hasta que se complete y, a continuación, realizar una solicitud de modelo enrutado.

Nunca ponga el código OAuth en argv de shell, registros, texto de emisión, capturas de pantalla o evidencia de implementación. La ruta de código manual mantiene sus comprobaciones de entrada existentes de proveedor desconocido, flujo no activo, código no válido y 4096 bytes.

## Docker Compose

opencodex no publica una imagen de contenedor oficial. El repositorio mantiene un código fuente-construido [`Dockerfile`](https://github.com/lidge-jun/opencodex/blob/main/Dockerfile), [`compose.yaml`](https://github.com/lidge-jun/opencodex/blob/main/compose.yaml), y un estrecho `.dockerignore`. La compilación fija el índice de imagen multiplataforma Bun 1.4.4 por compendio, ejecuta el proxy como el usuario no raíz `bun`, mantiene el sistema de archivos raíz de solo lectura, elimina las capacidades Linux y publica solo el oyente de datos en el `127.0.0.1:10100` del host de forma predeterminada. El proceso en primer plano utiliza `OCX_SERVICE=1`, por lo que detener o recrear el contenedor conserva el estado Codex enrutado en lugar de restaurar una configuración de escritorio nativa. Docker proporciona supervisión; no hay ningún administrador de servicios del sistema operativo instalado en la imagen. Use Compose para reiniciar/recrear el contenedor; esto no extiende el soporte a todas las rutas de reinicio del panel.

La imagen siembra una configuración `hub` de primera ejecución que une el oyente de contenedor a `0.0.0.0`. Antes del primer inicio normal, transmita un token de plano de datos recién generado al ayudante de arranque. El ayudante acepta como máximo una línea de 4096 bytes, nunca imprime el token, se niega a reemplazar un token existente y lo persiste como el propietario canónico `service-api-token` en el volumen `ocx-state`.

El despliegue persiste dos hogares separados: `ocx-state` en `/home/bun/.opencodex` para la configuración OpenCodex, las credenciales del proveedor y el uso, y `codex-state` en `/home/bun/.codex` para el estado Codex y `opencodex-catalog.json`. La imagen y Compose establecen explícitamente `CODEX_HOME=/home/bun/.codex`, por lo que esta ruta del catálogo sigue siendo escribible con `read_only: true` y sobrevive a la recreación de contenedores. La imagen crea ambos directorios para el usuario no raíz `bun` con el modo `0700`; la propiedad del volumen existente y los permisos no se migran automáticamente.

No combine `CODEX_HOME` y `OPENCODEX_HOME`: ambos productos utilizan un nombre de archivo `auth.json` con diferentes formatos. Este cambio de empaque agrega persistencia, no un generador de catálogo. Materialice o importe un catálogo válido en `/home/bun/.codex/opencodex-catalog.json` antes de la verificación de aceptación del catálogo a continuación; sin uno, `catalog_not_found` sigue siendo la respuesta esperada.

La actualización conserva el volumen `ocx-state` existente y agrega `codex-state`; no se migran archivos automáticamente. Si una solución anterior colocó un catálogo directamente debajo de `/home/bun/.opencodex`, respalde y copie deliberadamente solo el catálogo a la nueva casa Codex, preservando el acceso solo para el propietario. No copie el `auth.json` de ninguno de los productos sobre el otro. Las implementaciones con un `CODEX_HOME` personalizado deben conservar su entorno explícito y la asignación de volumen grabable hasta que se complete la migración. Al anular `CODEX_HOME`, monte ese directorio exacto y persista el catálogo predeterminado en `${CODEX_HOME}/opencodex-catalog.json`. Si `model_catalog_json` selecciona explícitamente otro archivo, esa ruta de acceso resuelta también debe persistir.

Mantenga estable el nombre del proyecto de redacción durante las actualizaciones para que se reutilicen los mismos volúmenes con nombre. Los montajes con propiedad externa existente, montajes de solo lectura y montajes con `volume-nocopy` no se reparan mediante la configuración del directorio de la imagen. Persistir catálogo seleccionado por separado o SQLite rutas por separado; un almacén de credenciales del sistema operativo no está respaldado por estos dos volúmenes.

Cuando se ejecute sin Compose, proporcione explícitamente ambos montajes con nombre. Solo las declaraciones Dockerfile `VOLUME` crean volúmenes anónimos que un `docker run` posterior no reutiliza automáticamente. Estas opciones de montaje utilizan nombres de ejemplo independientes; para reutilizar los datos de Compose, sustituya los nombres de volumen predefinidos para el proyecto:

```sh
--mount type=volume,src=ocx-state,dst=/home/bun/.opencodex \
--mount type=volume,src=codex-state,dst=/home/bun/.codex
```

El host necesita Git y Docker Compose para un clon local, o solo Docker Compose para un contexto Git remoto. Bun y no se requiere una etapa de preparación manual. La etapa de manifiesto de solo compilación deriva el inventario canónico de la instantánea Git seleccionada, escribe el `src/generated/compatibility-version.json` sin seguimiento y verifica cada SHA-256 registrado contra el contexto de compilación de solo lectura antes de que las instrucciones de origen `COPY` puedan desreferenciar un enlace simbólico. Los archivos de entorno de ejecución copiados se verifican nuevamente dentro de la imagen. Los metadatos de Git se admiten solo para ese montaje de enlace; no `COPY` coloca `.git` en una capa de imagen, y el ejecutable de Git permanece confinado a la etapa de manifiesto.

"Git metadata" aquí significa dos archivos. El inventario canónico proviene de `git ls-files`, que lee el índice y nunca abre un objeto o una referencia, por lo que el contexto de compilación admite solo `.git/index` y `.git/HEAD`, aproximadamente 1 MB, en lugar del almacén de objetos completo del repositorio. La etapa de manifiesto los copia en un directorio Git de cero que posee y suministra los directorios vacíos `objects/` y `refs/` que requiere la verificación del repositorio de Git. Un contexto sin un manifiesto ni un índice Git falla la compilación con un mensaje que nombra ambas entradas compatibles; nunca vuelve a un marcador de posición.

Un manifiesto generado por el host existente sigue siendo compatible: la compilación lo verifica y lo usa en lugar de reemplazarlo silenciosamente. Los archivos que faltan o no coinciden, los archivos de origen adicionales ausentes del manifiesto y los enlaces simbólicos (incluidos los directorios principales) fallan la compilación. El inventario requiere `package.json`, `bun.lock` y `scripts/model-metadata.source.json`; el propio manifiesto generado es el único archivo fuente exento del inventario. No lo cometas ni lo edites a mano.

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
```

Para un contexto Git remoto, establezca el argumento integrado BuildKit que conserva los metadatos de Git. Por ejemplo, reemplace el bloque de compilación del servicio con:

```yaml
services:
  hub:
    pull_policy: build
    build:
      context: https://github.com/lidge-jun/opencodex.git#main
      dockerfile: Dockerfile
      target: runtime
      args:
        BUILDKIT_CONTEXT_KEEP_GIT_DIR: "1"
```

Establezca un puerto host alternativo sin cambiar el oyente `10100` fijo del contenedor:

```bash
OPENCODEX_PORT=10190 docker compose up -d
```

El acceso remoto es una opción explícita. Configure `OPENCODEX_BIND_ADDRESS` en la LAN o la IP de Tailscale del host, o use `0.0.0.0` para publicar en las interfaces de host **todos**:

```bash
OPENCODEX_BIND_ADDRESS=0.0.0.0 docker compose up -d
```

Utilice un firewall y un frontend TLS /tailnet autenticado antes de exponer el puerto. La anulación de enlace cambia solo la publicación del host; el oyente del contenedor sigue siendo `0.0.0.0:10100`. Mantenga la misma anulación de enlace en invocaciones de composición posteriores que recrean el concentrador. Para actualizar una implementación existente, ejecute `docker compose build` y vuelva a crear el concentrador con `docker compose up -d`; no repita la inicialización de token de una sola vez.

Configure los proveedores con el panel de control a través de un frontend de administración propiedad del operador o con comandos CLI de un solo disparo que comparten el volumen de estado. Los siguientes comandos muestran la configuración de Remote Hub existente; reemplace el origen y la identidad del ejemplo antes de habilitarlos:

```bash
docker compose run --rm hub bun run src/cli/index.ts config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
docker compose run --rm hub bun run src/cli/index.ts config set hub.managementIngress '{"enabled":true,"port":10101}'
docker compose run --rm hub bun run src/cli/index.ts config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'
docker compose restart hub
```

Estos conjuntos anidados funcionan porque la imagen siembra una configuración `hub` de primera ejecución, por lo que el objeto ya existe. En una nueva instalación independiente no lo hace, y las mismas líneas fallan hasta que se crea - ver [Linux systemd o macOS launchd](#linux-systemd-or-macos-launchd) arriba.

El oyente del contenedor se une a `0.0.0.0`, por lo que ya es accesible en la propia dirección de bucle del contenedor y la forma complementaria de `unauthenticatedLoopbackListener` no se aplica allí, se rechaza en un enlace comodín. El token bootstrap a continuación es el contenedor equivalente al propio paso de aprovisionamiento del servicio, y también se ejecuta una vez.

No ponga un token en `ARG`, `ENV`, `COPY`, Compose YAML, historial de imágenes o argumentos de comando. No monte el socket Docker, la casa del host o Codex casa, agente SSH o proveedores de archivos clave. Una entrada de administración vinculada a `127.0.0.1:10101` dentro del contenedor solo se puede alcanzar mediante un frontend TLS /tailnet en el mismo espacio de nombres de red; nunca publique `10101` como acceso directo.

Después de que el recipiente esté sano, ejecute una prueba de promoción de preparación por separado:

```bash
docker compose exec hub bun -e \
  "const r=await fetch('http://127.0.0.1:10100/readyz');console.log(r.status,await r.text());if(!r.ok)process.exit(1)"

docker compose exec hub bun -e \
  "const t=(await Bun.file('/home/bun/.opencodex/service-api-token').text()).trim();const r=await fetch('http://127.0.0.1:10100/v1/catalog',{headers:{'x-opencodex-api-key':t}});console.log(r.status);if(!r.ok)process.exit(1)"
```

A continuación, envíe una respuesta enrutada autenticada real con un modelo configurado. Si el secreto está ausente o es ilegible, no debe aceptarse como listo un concentrador de no retorno de bucle. Nunca trates a la vida sola como prueba.

`docker compose down` elimina el contenedor y la red, pero conserva ambos volúmenes con nombre. Tratar `docker compose down --volumes` como destructivo: elimina la configuración, OAuth credenciales, historial de uso, el token de plano de datos, y persistió Codex estado juntos.

CI multiplataforma construye la imagen de origen y comprueba el inicio, la admisión de tokens de plano de datos y la recreación de contenedores utilizando un proyecto de Compose aislado con credenciales desechables. Verifica que tanto los volúmenes con nombre como un catálogo sintético sobrevivan al reemplazo. Esta comprobación no valida una cuenta de proveedor real, devolución de llamada OAuth, migración de montaje personalizada o cada arquitectura de CPU; realice la comprobación de respuesta enrutada autenticada anterior para su implementación.

<a id="rollback"></a>

## Reversión

Inspeccione las asignaciones de servicio existentes antes de cambiarlas. `tailscale serve reset` elimina todas las asignaciones en el nodo; use un comando de eliminación compatible más estrecho cuando existan asignaciones no relacionadas.

```bash
tailscale serve status
tailscale serve reset
ocx config set hub.managementIngress '{"enabled":false}'
ocx service restart
```

Para una reversión de contenedor, conserve tanto los volúmenes de estado con nombre como sus asignaciones. Una imagen anterior todavía puede usar `CODEX_HOME=/home/bun/.codex` cuando ese directorio permanece montado; no vuelva a un archivo de composición anterior que elimine el montaje Codex. No fusione las casas ni vuelva a ejecutar el token bootstrap. Para una reversión del servicio, detenga el servicio de la sucursal y repare la versión anterior contra el mismo `OPENCODEX_HOME`. Deshabilitar la entrada de administración o Servir no requiere cambiar el oyente de datos.

<a id="troubleshooting"></a>

## Solución de problemas

- **Hub abajo:** `ocx connect status` todavía muestra la conexión guardada. `ocx disconnect` puede restaurar el estado local sin conexión; no puede revocar la clave remota.
- **Catálogo Stale:** `ocx sync` mantiene un último catálogo válido solo para fallos transitorios del concentrador. Las fallas de autenticación, esquema, tamaño y protocolo son errores difíciles y nunca vuelven a los proveedores locales.
- **Token giratorio o recuperación `.prev`:** vuelve a ejecutar `ocx connect rotate` con un código de emparejamiento o token de administración. No edite ni elimine ninguno de los candidatos de token antes de que finalice la sonda de recuperación.
- **Desajuste de protocolo:** actualizar el lado más antiguo nombrado por el mensaje `hub-too-new` o `hub-too-old`. La negociación falla antes de que el token, el catálogo, el diario o el estado del cliente escriban.
- **Código de emparejamiento perdido o quemado:** ejecutar `ocx hub invite` de nuevo. Las concesiones son de un solo uso y los fallos repetidos son de velocidad limitada sin revelar si existe un código.
- **`ocx hub invite` dice `No loopback browser origin is admitted for pairing`:** el concentrador no admite el origen del navegador de bucle de retroceso, por lo que una concesión vinculada al origen nunca podría igualar. Nada fue acuñado. Ejecute la línea `ocx config set corsAllowOrigins` las impresiones de error, con el puerto proxy de la máquina de unión. Véase [Invitar a otra máquina](#inviting-another-machine).
- **`ocx hub invite` dice que el origen de los datos anunciados sería el propio bucle de retorno de esta máquina:** el bind es solo loopback o un comodín y `hub.dataPublicOrigin` está desactivado, por lo que no hay dirección para anunciar y nada adivina una red Tailscale o LAN. Nada fue acuñado. Establecer `hub.dataPublicOrigin`, o pase `--data-url` para esta invitación solamente.
- **Se rechaza el intercambio de la máquina de unión y se gasta el código:** la subvención estaba vinculada a un origen que la máquina no presenta. Vuelva a leer la línea `Bound browser origin:` de la invitación: nombra el puerto en el que debe ejecutarse la otra máquina u ofrece la admisión `http://localhost:10100` en el concentrador.
- **`ocx hub invite` rechaza un `--management-url`:** en un concentrador ese indicador confirma `hub.managementPublicOrigin` en lugar de anularlo, porque la concesión está vinculada al valor configurado. Cambie la configuración o suelte la bandera.
- **`ocx claude` en el concentrador se inicia de forma nativa Codex / Claude, o el concentrador se niega a escribir sus propias configuraciones de cliente:** `unauthenticatedLoopbackListener` está apagado. El mensaje de omisión nombra la puerta. Habilite el oyente y reinicie el proxy (`ocx service restart` en una instalación de servicio).
- **`ocx claude` en el concentrador obtiene `404` del oyente:** el proxy sigue siendo el proceso que comenzó antes de que existieran los cables del oyente, o antes de que el puerto cambiara. Reinicie con `ocx service restart` - ver [macOS operaciones de servicio](#macos-service-operations).
- **`ocx service repair` impreso `nothing to do` y el proceso no rebotó (macOS):** esperados. Una reparación de un trabajo saludable es deliberadamente una opción prohibida. Cuando desee un nuevo proceso, ejecute `ocx service restart`, que inicia el trabajo cargado en su lugar y reporta `service restarted (launchctl kickstart -k …)`. Solo si eso falla es `launchctl kickstart -k gui/$(id -u)/com.opencodex.proxy` el retroceso manual - el mensaje de falla lo nombra.
- **`ocx service install` rechaza `OPENCODEX_API_AUTH_TOKEN`:** ese valor es un token de administrador de administración. `unset OPENCODEX_API_AUTH_TOKEN` y reejecutar; el servicio proporciona su propio token de plano de datos. Véase [El propio token del plano de datos](#the-data-plane-token-provisions-itself).
- **El buje se bloquea en el arranque y `ocx status` muestra `admin-collision (file)`:** el archivo `service-api-token` contiene el token de gestión, por lo que el concentrador cerca su gestión API cerrada. Elimine el archivo y ejecute `ocx service repair` para proporcionar un token de plano de datos. Desactivar la variable de entorno no ayuda aquí - el archivo es la fuente.
- El emparejamiento de **Plain HTTP se negó:** sobre HTTP no loopback se rechaza completamente, y no hay ninguna bandera que opte por salirse de él. Ponga el origen de la administración detrás de HTTPS o pare sobre loopback. Los tokens de administrador nunca se envían por encima de HTTP.
- **`403 origin_rejected` de `/v1/catalog` mientras que `/readyz` devuelve `200`:** el oyente de datos está obligado a retroceder detrás de un frontend TLS. Véase [Dar al oyente de datos TLS](#giving-the-data-listener-tls).
- **Finalizó la sesión remota:** Iniciar sesión o emparejar de nuevo. El cierre de sesión y la expiración invalidan solo la sesión del navegador, no una clave de datos del cliente.
- **Revocación excepcional después de la desconexión:** usa la página **Conecte las llaves → API** del panel de control central. Es el único camino de revocación posterior a la desconexión.

<a id="usage-from-a-connected-client"></a>

### Uso desde un cliente conectado

`ocx usage` lee el concentrador conectado con la clave de datos registrada de este cliente. La salida humana identifica la fuente del concentrador y el alcance de la clave del cliente; `--json` devuelve los mismos datos de alcance. Los filtros de rango, superficie, proveedor / modelo y los límites personalizados `--since` / `--until` permanecen disponibles. Los desgloses de cuentas y los registros de otros clientes no se comparten. Un concentrador antiguo o no disponible produce un error explícito en lugar de sustituir el uso local; actualice el concentrador si no admite esta lectura.

El punto final del plano de datos de solo lectura es `GET /v1/usage`, usando `x-opencodex-api-key` con una clave de cliente configurada. En todo el entorno y las claves de administración son rechazadas. Acepta `range`, `surface`, `provider`, `model`, `since` y `until`; se rechazan las opciones desconocidas / repetidas y los identificadores de clave seleccionados por el llamante. Las filas sobredimensionadas omitidas retienen la advertencia explícita de historial incompleto.

Las credenciales de uso del cliente se envían solo por HTTPS o loopback HTTP. Tanto la solicitud como la respuesta deshabilitan el almacenamiento en caché.

<a id="pairing-this-browser-with-a-hub"></a>

### Emparejar este navegador con un hub

La inscripción de la máquina y la autenticación del navegador son independientes. El panel de emparejamiento nombra el concentrador y muestra un comando `ocx gui pair --origin` para el origen exacto abierto actualmente en su navegador. Ejecute ese comando en el concentrador o envíelo al operador del concentrador y solicite un código de emparejamiento único. Pegue ese código en el panel; una clave de datos API o un token de administración no es un código de emparejamiento.

Mientras la autenticación del navegador está pendiente, el panel de control no recomienda reiniciar un cliente conectado saludable. Completar el emparejamiento actualiza los datos del panel de control de inmediato, incluido un error de autenticación previamente almacenado en caché. La expiración de la sesión vuelve al emparejamiento; la denegación de permiso mantiene su propia guía de configuración de acceso. Otras actualizaciones fallidas pueden mostrar los últimos datos recibidos con un aviso de datos obsoletos y una acción de reintento.

Si se ha intercambiado el código pero la validación de Remote Link no está disponible temporalmente, mantenga la página abierta y use **Reintentar validación**. Esto comprueba la sesión pendiente del navegador sin gastar otro código de emparejamiento. Las respuestas a los desafíos de Cloudflare también mantienen la sesión pendiente para reintentar. Emparejar solicitudes de intercambio y validación cada vez después de 10 segundos, incluida la lectura del cuerpo de la respuesta, para que el formulario vuelva a ser utilizable. Un tiempo de espera de validación mantiene la sesión instalada pendiente para **Reintentar validación**; una respuesta de intercambio que llega después de su tiempo de espera no puede instalar credenciales. Si el concentrador rechaza definitivamente la sesión con HTTP 401 o 403, el panel de control restaura la sesión del navegador anterior solo mientras el traspaso aún posee el estado de sesión actual y no se ha reemplazado por un inicio de sesión, cierre de sesión o cambio de destino más reciente; solicite al operador del concentrador un código nuevo para este origen del navegador. Un intercambio de emparejamiento captura la revisión actual de la sesión y el objetivo antes de enviar el código; las respuestas retrasadas no pueden reemplazar una sesión después de que cambie la revisión. El arranque automático de descubrimiento y la recuperación de fondo siguen la misma regla, incluyendo cambiar los objetivos de ida y vuelta; ninguno anula el cierre de sesión. El cierre de sesión pendiente y completado suprime la recuperación automática hasta que cambie un nuevo inicio de sesión explícito o un nuevo objetivo. Un tiempo de espera de recuperación informa de una sesión no disponible solo si su solicitud sigue siendo actual, no cancelada y sin credenciales; los resultados de arranque tardío se descartan.

Si un oyente auxiliar no puede enlazar, los nombres de inicio `unauthenticatedLoopbackListener` o `hub.managementIngress` y la dirección real. Corregir ese oyente o liberar su dirección; cambiar solo el puerto proxy público no repara un puerto auxiliar fijo. Los bloques de escucha mal formados editados a mano advierten y permanecen desactivados mientras se conservan las configuraciones no relacionadas.

<a id="return-a-hub-to-standalone"></a>

## Devolver un concentrador a autónomo

Ejecuta `ocx hub disable [--json]` en el concentrador para eliminar `hub`, `unauthenticatedLoopbackListener`, `runtimeRole` y `hostname` juntos en una escritura validada. La configuración del proveedor, el puerto y las claves API guardadas se conservan. Se rechaza una configuración de cliente o independiente sin cambios.

Las claves no llevan un origen de inscripción verificado y los nombres son editables. Para revocar las claves de cliente, primero inspeccione los ID con `ocx access key list --json` y, a continuación, seleccione explícitamente cada ID:

```sh
ocx hub disable --revoke-clients --client-key <client-key-id> --json
```

Repita `--client-key` para varios clientes. Con las claves guardadas presentes, `--revoke-clients` sin ID seleccionados se niega antes de cambiar la configuración. Las identificaciones desconocidas también se niegan. Solo se eliminan las teclas seleccionadas y sus rotaciones pendientes; la salida contiene metadatos seguros en lugar de secretos. El comando imprime el paso de reinicio para el supervisor detectado; no reinicia el proxy. Revisión `tailscale serve status` y otros frontends externos para asignaciones a puertos hub antiguos. La configuración y revocación persistentes se aplican al proxy en ejecución después del reinicio; Los registros de enlace remoto y los túneles permanecen sin cambios.
