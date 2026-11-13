---
title: "Enlace remoto"
description: "Conecte una computadora OpenCodex Home a una computadora Child a través de SSH."
---

Un enlace de máquina conecta un ordenador **Home** OpenCodex a un ordenador **Child** a través de SSH. El Home sirve al Child a través del túnel SSH, mientras que ambos ordenadores mantienen su servicio local OpenCodex en el puerto `10100`. El panel de control transfiere la clave de enlace por hijo a través de SSH, por lo que no escribe un token.

<a id="requirements"></a>

## Necesidades

- El ordenador Home puede iniciar sesión en el Child con una clave OpenSSH.
- Para un enlace iniciado en Child, el Child puede iniciar sesión en Home con una clave OpenSSH (no se admite el inicio de sesión con contraseña).
- OpenCodex 2.66.0 o posterior está instalado en el ordenador Child, y en Home para un enlace iniciado Child.
- Ambos equipos ejecutan macOS, Linux o Windows x64. Windows requiere OpenSSH Server y Windows PowerShell; no necesita Git Bash ni curl.
- El panel de control que agrega un Child de Home se abre en el propio Home o a través de una sesión Hub emparejada. Convertir el equipo actual en un Child requiere una sesión de panel de control emparejada con el operador; una sesión de panel de control local sin credenciales no puede confirmar ese cambio de enrutamiento.

No se admite SSH con contraseña. Los enlaces pueden iniciarse desde Home o Child. En Windows, la ejecución usa PowerShell sobre la misma conexión OpenSSH con identidad fijada.

<a id="add-a-child-from-remote"></a>

## Añadir un Child de `#remote`

1. Abra el panel de control en `#remote` y activar el enlace remoto.
2. Elija **Home**, luego **Continuar**. Se abre la lista de hosts SSH.
3. Elija un host de los candidatos SSH o introduzca un alias de configuración SSH.
4. Ejecute la prueba de conexión y compare la huella dactilar del host ofrecida con la huella dactilar de la máquina que desea utilizar. Compararlo ayuda a detectar un host incorrecto o una clave de host cambiada antes de que SSH confíe en el host.
5. Confirme la huella digital y luego conecte el Child.

El panel de control no te pide que ingreses un token. Primero sondea el host y no puede aplicar el enlace hasta que confirme explícitamente la huella digital.

La hoja Add Child explica que el Child utiliza los proveedores de este Home sobre SSH y enumera los requisitos previos anteriores. Los alias de host provienen de `~/.ssh/config` en el Home que ejecuta OpenCodex, no necesariamente el ordenador que muestra el navegador. Si el descubrimiento tiene éxito sin hosts, agregue una entrada `Host` como esta, luego elija **Rescan hosts**. También puede introducir un alias existente manualmente; seleccionar o introducir un alias habilita **Conexión de prueba**. La hoja enlaza con esta guía.

El descubrimiento también sigue las directivas `Include` de nivel superior. Los paréntesis y las llaves
de los nombres incluidos siguen siendo literales al combinarse con comodines. Por ejemplo,
`Include conf.d/*(1).conf` encuentra `backup(1).conf`, y `Include conf.d/shard-{1..3}-*.conf` busca
nombres que contengan `{1..3}`. Un `Include` dentro de `Host` o `Match` es condicional y no se usa
para descubrir hosts.

```sshconfig
Host devbox
  HostName devbox.example.com
  User you
  IdentityFile ~/.ssh/id_ed25519
```

Si falla el descubrimiento, la hoja muestra **No se pudo cargar los hosts SSH**, la razón de la solicitud disponible y **Reintentar**, en lugar de reclamar que la lista de host está vacía. Un fallo en la prueba de conexión mantiene su razón específica y la pista SSH desinfectada en la hoja activa, no duplicada detrás de ella. Compruebe la razón, utilice el diagnóstico SSH en Solución de problemas a continuación cuando sea relevante, y vuelva a intentarlo. El rescanning mantiene el alias ingresado pero requiere una nueva revisión de huellas dactilares antes de conectarse.

<a id="connect-this-computer-as-a-child"></a>

## Conecte este equipo como un Child

En el equipo que debe utilizar los proveedores de Home:

1. Abra el panel de control en `#remote` y activar el enlace remoto.
2. Elija **Child**. Se abre la lista de hosts SSH.
3. Elija el host SSH del Home, ejecute la prueba de conexión, luego compare y confirme su huella digital del host.
4. Lea el aviso y elija **Conectar como Child**.

La conexión se reinicia OpenCodex en este equipo. Codex turnos que ya se están ejecutando terminan primero, y las nuevas solicitudes pueden fallar hasta por un minuto mientras se reinicia. El tablero de instrumentos se recarga por sí mismo y muestra el enlace Child. Codex sigue usando `http://127.0.0.1:<port>/v1` en este equipo, sin token y sin variable de entorno para establecer: el local OpenCodex retransmite cada solicitud al Home, que le sirve con sus propios proveedores y cuentas.

El Child espera su puerto configurado mientras el proceso anterior lo libera. Si aún falla un reinicio administrado CLI, ejecute `ocx start` en el Child y verifique `~/.opencodex/restart-handoff.log`. En la aplicación de escritorio, la aplicación inicia y supervisa el reemplazo automáticamente.

Un `ocx stop` explícito en un Child de Remote Link detiene su proxy y, si se completa la restauración compartida, restaura el enrutamiento nativo de Codex, su catálogo y los metadatos respaldados del historial de reanudación, y elimina la configuración administrada de Grok. La conexión guardada con Home se conserva; usa `ocx disconnect` para eliminarla.

Si una conexión al hub toma el control durante la parada, se conservan su enrutamiento y su configuración. Una conexión que aún se esté creando o desconectando puede impedir la restauración; deja que termine esa operación y reintenta `ocx stop`. La API de parada del dashboard devuelve HTTP 409 con `sharedTeardown: "refused"` cuando no puede confirmar quién tiene el control y mantiene el listener en ejecución. La limpieza por señal también conserva la configuración cuando no se puede confirmar ese control.

Para volver a usar Home desde Codex después de la restauración, inicia el Child con `ocx start` (o `ocx service start` si hay un servicio instalado) y ejecuta después `ocx sync --restart-codex`. Iniciar el entorno de ejecución no vuelve a aplicar el enrutamiento de Codex del Child. Sync reaplica los ajustes de Codex cuando Codex está habilitado para la conexión guardada, y la opción reinicia Codex para cargarlos; no recrea el bloque de Grok. Este es el flujo explícito de parada e inicio de un Link Child; no cambian el control del cliente de hub ni las reglas independientes de reinicio, reciclado, salida del servicio e instancias hermanas.

Si el **Child** dice emparejar esta máquina primero, abra el panel de control HTTP de loopback literal configurado de este equipo, por ejemplo, `http://127.0.0.1:<configured-port>`. El formulario de emparejamiento local aparece solo cuando falta el emparejamiento y el panel de control y el API usan el mismo origen de bucle invertido. Copie el comando `ocx gui pair --origin "http://127.0.0.1:<configured-port>"` del formulario, ejecútelo en un terminal en este equipo y pegue el código de un solo uso en el formulario. Use el origen exacto que se muestra en el formulario; una clave o token de administrador API del proveedor no es un código de emparejamiento. El emparejamiento faltante es independiente de un desajuste de puerto configurado.

En un panel de Hub abierto a través de una dirección que no sea de loopback, es posible que el navegador no tenga sesión de loopback o que tenga una sesión compartida que no pueda administrar los enlaces de la máquina. Cuando Remote Link informe de ese problema de sesión o permiso, seleccione **Conecte este panel al concentrador** en la página Enlace remoto para abrir el formulario de emparejamiento único. Ejecute el comando mostrado en el Hub e introduzca su código. La página valida el acceso de enlace remoto de la nueva sesión antes de que cierre el formulario.

El rol **Child** también requiere un entorno de ejecución independiente OpenCodex que se ejecuta en su puerto configurado, porque el Child se reinicia exactamente en ese puerto. Si el panel de control dice que OpenCodex no se está ejecutando en su puerto configurado, reinicie allí primero.

<a id="link-status"></a>

## Estado del enlace

- **Conectado** significa que el túnel SSH está listo y el Child puede usar el enlace Home.
- **Reconexión** significa que el túnel está siendo reintentado. Las solicitudes pueden devolver temporalmente `503` con `Retry-After` mientras el reintento está en curso. En un Child que se conectó desde su propio tablero de instrumentos, una solicitud primero espera hasta 15 segundos para que regrese el túnel.
- **Fallido** significa que el enlace necesita atención. Revisa la autenticación SSH, la clave de host confirmada, el reenvío y el motivo que muestra el dashboard. Quien ejecuta el túnel sigue reintentando tras una suspensión, interrupción o reinicio: Home para un Child que añadió y Child para un enlace iniciado desde su propio dashboard. Tras un timeout o error de reenvío, el Home reintenta cada minuto un Child que añadió, de modo que un portátil que estuvo suspendido se reconecta aproximadamente un minuto después de despertar; un Child que se unió desde su propio dashboard reintenta tras un minuto y duplica la espera después de cada reintento que vuelve a fallar, hasta cinco minutos. Los errores de autenticación se reintentan cada cinco minutos en ambos lados; una clave de host cambiada nunca se reintenta. Para forzar otro intento, elige **Reintentar** en el dashboard del Home o ejecuta allí `ocx link reconnect --link-id <id>`. Esto reinicia el túnel del enlace, sin reiniciar OpenCodex.

Un enlace fallido no cambia silenciosamente a un proveedor local. Si el túnel ya falló, está detenido o no está supervisado antes de iniciar el reenvío, el Child devuelve un `503` reintentable sin enviar la clave de enlace ni la solicitud. Un fallo posterior al inicio del reenvío es distinto: el Home puede haber recibido o procesado la solicitud; comprueba ese resultado incierto antes de reintentar. También mantiene la clave local cuando otro proceso posee el puerto del túnel; libre ese puerto para que el túnel SSH del Child pueda enlazarlo.

En un Child, `GET /healthz` solo indica que OpenCodex se está ejecutando. `GET /readyz` y `ocx ready` también comprueban si el enlace puede transportar una solicitud. Si no puede, la respuesta es `503` con `Retry-After: 1`, `"status": "pending"` y un objeto `link`, por ejemplo `{ "state": "unavailable", "reason": "home_unreachable" }`. Si puede, responde `200`, `"status": "ready"` y `{ "state": "available" }`. Los motivos posibles son `tunnel_connecting`, `tunnel_failed`, `tunnel_idle`, `tunnel_unavailable`, `sidecar_invalid`, `home_unreachable`, `home_unauthorized`, `link_auth_failed`, `link_credential_unavailable` y `link_unverified`. Un Child enlazado desde su propio dashboard consulta su túnel. Si el Home añadió el Child, este no tiene un túnel propio que inspeccionar: consulta al Home por el túnel con la misma comprobación sin credenciales que precede a cada solicitud reenviada, como máximo una vez cada cinco segundos. Si el Home no responde en medio segundo, informa `link_unverified`.

Para confirmar qué Home atiende a un Child, compara el encabezado `x-opencodex-served-by` de `GET /v1/models` del Child con `instanceId` de `GET /healthz` del Home. El Child retransmite el encabezado sin cambios, por lo que los valores coinciden mientras el enlace funciona. Es un identificador opaco, nunca un nombre de equipo; consulta [Identidad del Home y encabezado served-by](/es/reference/management-api/#home-identity-and-the-served-by-header).

<a id="several-routes-to-one-child"></a>

## Varias rutas a un Child

Un Child añadido desde Home puede alcanzarse por varias rutas SSH, por ejemplo un alias directo en la misma LAN o tailnet y un alias de relay accesible desde cualquier lugar. Home mantiene una lista ordenada y se conecta por la primera ruta que funciona: el tráfico usa la ruta directa si está disponible al conectar y, en caso contrario, el relay.

```text
ocx link routes --link-id <id>
ocx link routes add --link-id <id> --route <alias> [--position <n>]
ocx link routes remove --link-id <id> --route <alias>
ocx link routes order --link-id <id> --routes <alias,alias,...>
```

- **Todas las rutas llegan al mismo equipo.** El alias del enlace fija la clave: su clave de host confirmada es la única que puede presentar cualquier ruta y permanece en la lista. Antes de guardar una ruta con `ocx link routes add`, Home conecta con comprobación estricta de esa clave. Si presenta otra clave, rechaza el inicio de sesión o no responde, no se guarda (`route_unproven` con causa `hostkey`, `auth`, `forward` o `transient`). También se rechaza si el archivo privado `known_hosts` del enlace confía en otra clave para el alias (`pin_mismatch`, `trust_file_unexpected`). Al añadir un Child se comprueba el mismo archivo: una línea con comodín, lista de hosts o marcador, que OpenCodex nunca escribe, provoca `trust_file_unexpected`; elimina esa línea y vuelve a probar y confirmar el host. Las líneas hash son válidas: versiones anteriores a 2.89 las registraban cuando SSH las configuraba, y cada una cuenta para el alias correspondiente. Puede haber varias si todas tienen la clave del enlace. Confirmar otra clave para un alias ya usado por un enlace iniciado en Home se rechaza con `link_pin_conflict`; para confiar en un equipo sustituido, elimina y vuelve a añadir el enlace. Si el cambio se guarda pero los túneles activos no lo recargan, el comando devuelve `routes_stored_reload_failed`; el cambio se conserva y reiniciar OpenCodex en Home lo aplica.
- **Orden.** Una ruta nueva va antes del alias salvo que se indique `--position`, para que las rutas directas precedan al alias de relay.
- **Elección.** En cada conexión Home sondea las rutas en orden y concede 10 segundos a cada sondeo inicial. Si el sondeo tiene éxito, Home inicia un túnel candidato con hasta 30 segundos para que sshd del Child conceda el listener remoto y otros 30 segundos para comprobar que está listo. Una ruta solo funciona cuando el Child obtiene el catálogo de Home a través de ese túnel con su clave de enlace; hasta entonces aparece **Connecting**. Una ruta fallida espera unos segundos tras un error de red, un minuto tras un rechazo de reenvío, cinco tras un fallo de autenticación o diez tras una clave incorrecta; Home pasa a la siguiente. El enlace falla por clave de host solo si todas presentan una clave incorrecta.
- **Túnel obsoleto.** Si Home se detuvo sin detener el ssh del enlace, este muestra **failed** y «stale tunnel may hold the port» hasta que termine ese ssh; detenlo (su pid está en `<config dir>/link/<link id>.pid`). Si ese pid pertenece ahora a otro programa, comprueba primero que ningún ssh del enlace siga activo, elimina el archivo `.pid` y reinicia OpenCodex en Home. Si OpenCodex no puede leer el archivo `.pid`, el enlace permanece bloqueado de la misma manera, incluso tras reiniciar. Haz que el archivo vuelva a ser legible y el enlace esperará a que termine el ssh indicado; o, cuando ya no haya ningún ssh del enlace activo, elimina el archivo y el enlace arrancará en un segundo o cuando corresponda su siguiente reintento.
- **Volver a una ruta mejor.** Añadir o reordenar rutas no mueve un túnel activo; una ruta posterior se conserva mientras funcione. Home vuelve a probar desde el principio al caer el túnel o al ejecutar `ocx link reconnect --link-id <id>`, que interrumpe las solicitudes activas de ese enlace.
- **Estado.** Para un enlace con varias rutas, `ocx link status --json` muestra `route` (ruta en uso y desde cuándo), `routes` (cada ruta, cuándo puede reintentarse y último resultado) y `routeBlocked`.
- **Requisitos.** El `ssh` de Home debe ser OpenSSH o el enlace falla con `ssh_client_unsupported`. El Child necesita lo habitual para añadirlo: `curl` en macOS y Linux o Windows PowerShell en Windows. Los comandos usan la API de gestión de Home con token administrativo en loopback, como `ocx link reconnect`; no están disponibles por el socket privado de control que abre un Hub con bind no loopback para `ocx link status`.
- **Relay y privacidad.** Si la ruta directa está bloqueada, se usa el relay, que solo transporta bytes cifrados por SSH. Los nombres son alias SSH: aparecen en `ocx link status` de Home y en los comandos de rutas, nunca en diagnósticos ni registros.
- **Volver a una versión anterior.** Un Home antiguo rechaza un almacén de enlaces con rutas. Elimina las rutas adicionales con `ocx link routes remove` antes de usarlo.

<a id="what-a-child-shows-and-manages"></a>

## Lo que un Child muestra y administra

Un Child se ejecuta en los proveedores, cuentas y configuraciones del Home, por lo que el Home es donde los cambia.

- **Tablero.** El tablero de mandos del Child muestra el estado de solo lectura del Home y dice "Administrado por Home <name> a través de enlace remoto". El panel de control y los proveedores leen el Home a través del enlace, y la franja de uso en el encabezado muestra la cuota del Home. La lista de modelos no se muestra en un Child, porque al construirlo se ejecuta el descubrimiento de proveedores en el Home; Codex en el Child ya ofrece los modelos Home. Por la misma razón, los selectores de modelos de delegación y sidecar en un Child enumeran los modelos nativos y las opciones actuales del Home, no la lista completa de rutas del Home. Guardar un cambio allí se rechaza con un mensaje que nombra el Home; hacer el cambio en el tablero de Home. El navegador del Child nunca recibe una credencial Home.
- **Codex ajustes.** `ocx sync` en el Child (y conectándolo) se aplica la configuración Codex OpenCodex se gestiona en el Home: Modo rápido, el modo multiagente, el conmutador de sidecar de búsqueda web y el subagente nativo por defecto cuando el Home los sincroniza. `ocx sync` y `ocx status` listan los valores que vinieron del Home. El esfuerzo de razonamiento predeterminado y los niveles de esfuerzo que se muestran en el selector de modelos de la aplicación Codex son la configuración de la aplicación Codex en cada computadora; OpenCodex no los administra en ningún ordenador.
- **CLI.** Las órdenes que solo leen, como `ocx account list`, `ocx provider quota` y `ocx usage`, leen el Home. Muestran lo que el Home ya ha observado: una lectura de un Child nunca hace que el Home sondee a un proveedor, actualice un token o inicie un proceso, por lo que los detalles de la cuota y la cuenta son tan frescos como la propia actividad del Home los mantiene. Las lecturas que solo existen para ejecutar el descubrimiento del proveedor o una actualización forzada, como `ocx models live`, `ocx models preset show` y `ocx account list --quota`, se rechazan como cambios. Los comandos que cambian la configuración son rechazados con un mensaje que nombra el Home y el enlace y dice que no se envió ninguna solicitud. `ocx status` describe el Home y el enlace. `ocx provider list` y `ocx config get` todavía muestran la propia configuración de este ordenador, etiquetada como local e inactiva mientras el ordenador está enlazado. `ocx config set`, `ocx config unset` y `ocx config import` todavía escriben localmente, cada uno con la misma nota, y `ocx provider add`, `remove` y `set-default` son rechazados porque esos proveedores no se utilizan mientras están vinculados.

Estas lecturas necesitan una versión OpenCodex con el relé de gestión de enlace remoto tanto en el Home como en el Child. Un antiguo Home responde con un mensaje pidiéndote que lo actualices.

<a id="remove-a-child"></a>

## Eliminar un archivo Child

Seleccione **Desconectar** para el Child y confirme el alias. El Home detiene el túnel, revoca la clave de enlace de ese Child y elimina el registro de enlace guardado.

Si el Home no puede alcanzar el Child para ejecutar su comando de desconexión, elija **Eliminar aquí solamente**. Esto elimina el túnel local, la clave y el registro. A continuación, inicie sesión en el Child y ejecute:

```bash
ocx disconnect   # or ~/.cache/opencodex/bin/ocx-child detach on a lightweight Child
```

Para desconectar un enlace iniciado por Child, ejecute `ocx disconnect` en el Child. Desconecta el túnel del cliente y revoca el enlace en Home sobre SSH. Si la revocación Home falla, se imprime: `Home revoke failed; run ocx link revoke --link-id <linkId> on the home.`

Para medir el tráfico, ejecuta `ocx link status --json`. Cada enlace incluye `traffic`: bytes de cuerpos de solicitud hacia Home (`toHomeBytes`), bytes de cuerpos de respuesta (`fromHomeBytes`), número de solicitudes y solicitudes terminadas antes de tiempo (`incomplete`), desde el inicio del conteo (`since`, con `epoch` y `generation`). Compara lecturas solo si coinciden `epoch` y `generation`; si cambia cualquiera, el conteo comenzó de nuevo, y un reinicio siempre cambia `epoch`. En Child se cuentan los bytes transportados por el enlace, incluidas sus propias lecturas de Home. Una carga de cuerpo incompleta también cuenta en `incomplete`; si este es mayor que cero, `toHomeBytes` puede omitir parte de un cuerpo interrumpido y es un mínimo. Una carga en curso solo se cuenta al terminar su escritura, por lo que la lectura puede ir detrás de lo ya recibido por Home; la diferencia entre lecturas cuenta escrituras completas. Una escritura termina cuando el sistema operativo la acepta; Windows puede aceptar un cuerpo grande entero de una vez, por lo que en un Child Windows puede contabilizarse completo en cuanto se envía, aunque Home solo lea una parte. Child muestra estas cifras en el estado del dashboard, pues `ocx link status` allí solo lee archivos locales. En Home, las respuestas se cuentan al enviarse y las solicitudes por su longitud declarada (`toHomeSource: "content-length"`); las que no la declaran se cuentan en `toHomeUncounted`. Hay contadores para hasta 256 enlaces; las solicitudes sin espacio para medir se cuentan en `untrackedRequests`. No se incluyen encabezados, sobrecarga SSH ni lo añadido por un relay, y el reinicio reinicia el conteo. OpenCodex no infiere si una ruta es directa o de relay. Un enlace de una ruta usa su alias; con varias, el estado muestra la ruta en uso y desde cuándo (`route.name`, `route.since`), y su nombre indica el tipo. Cada fila de `ocx logs --json` incluye `requestBody`: tamaño recibido (`wireBytes`), `encoding` y tamaño decodificado (`decodedBytes`).

Cuando Child y Home ejecutan esta versión, Child comprime individualmente con zstd las solicitudes de modelo mayores de 1 KiB y de hasta 16 MiB que no tengan codificación propia antes de enviarlas por el enlace. Solo lo hace cuando Home anuncia por el enlace que las acepta; con un Home antiguo las envía como antes. Home rechaza solicitudes comprimidas que se expandirían más de 200 veces por encima de 8 MiB para protegerse de bombas de compresión. La conexión SSH no se comprime.

Para desactivarlo, configura `"linkRequestCompression": false` en el `config.json` de Home y reinicia Home. Deja de ofrecer compresión y sus Children envían las solicitudes sin comprimir. La compresión implica una decisión de privacidad: quien pueda insertar texto elegido junto a un secreto en una solicitud y observar el tamaño de muchas solicitudes puede adivinar el secreto según cuánto se compriman. En un enlace esto incluye al operador del relay o a cualquiera en la ruta de red: el túnel oculta el contenido, pero no el tamaño. Está activada por defecto porque el ataque requiere controlar texto de la conversación y observar el tamaño de cada solicitud, mientras que reduce en más de la mitad los bytes enviados hacia Home.

<a id="route-clients-per-device"></a>

## Enrutar clientes por dispositivo

El Home decide qué clientes se enrutan por OpenCodex. Cada Child aplica esa configuración con sus propios clientes instalados, rutas de archivos, puerto de escucha y catálogo de modelos servido. No se copia ningún archivo de configuración de cliente ni credencial del Home. Las decisiones por dispositivo tienen prioridad sobre los valores predeterminados del Home; el valor incorporado activa Codex y Claude Code y deja los demás clientes desactivados.

En el propio Home, Codex, Claude Code, Grok y Claude Desktop siguen los interruptores del Home, los mismos que cambian `ocx restore`, `ocx restore back`, `ocx claude desktop apply`, la desactivación de la API Messages, los ajustes de agente y los interruptores del dashboard. Solo un `false` explícito desactiva uno; si no está definido, está activado. Los valores predeterminados del Home y las decisiones por dispositivo nunca determinan estos cuatro clientes en el Home. Si ningún cambio de ruta decide un interruptor de Grok o Claude Desktop que está activado o sin definir, solo se hace lo que ocurre al iniciar: Grok sigue las reglas de sincronización del inicio y Claude Desktop actualiza un perfil de gateway que OpenCodex ya administra, pero nunca crea uno ni cambia el modo de Desktop. Si un perfil administrado cambió desde que OpenCodex lo escribió, se informa un conflicto en vez de actualizarlo. Una biblioteca de Desktop que OpenCodex nunca administró se deja intacta y se informa como actual, de modo que no hace fallar una sincronización completa. Ejecuta `ocx route to claude-desktop on --device home` (o `ocx route to claude-desktop on`) para crear el perfil de Desktop. Nada de esto activa Grok ni Claude Desktop en los Children.

Los Children nunca leen los interruptores del Home. Un Child usa primero su decisión por dispositivo, luego el valor predeterminado guardado del Home y, por último, el valor incorporado. El Home guarda una vez los valores predeterminados de estos cuatro clientes: Codex y Claude Code según sus interruptores en ese momento (activados salvo que estén desactivados explícitamente), y Grok y Claude Desktop desactivados. Un cambio del valor predeterminado del Home (`ocx route to <client> on|off` sin `--device`) y la inscripción de un Child siempre los guardan. Una vez que el Home tiene un enlace, también se guardan antes de que una operación exclusiva del Home pueda cambiar un interruptor: al iniciar el listener del enlace, y con `ocx restore`, `ocx restore back`, `ocx claude desktop apply`, la desactivación de la API Messages, el interruptor de Claude, los interruptores nativos y un cambio de ruta con `--device home`. Antes de un cambio de integración exclusivo del Home (un interruptor del dashboard, `ocx integration client enable|disable`, una acción de deshacer del historial de integraciones o un cambio de perfil de Aside), un Home enlazado guarda todos los valores predeterminados que heredan sus Children, incluidas las integraciones de archivos. El listener hace lo mismo al iniciarse, para que un Home actualizado desde una versión que solo guardaba esos cuatro conserve el resto antes de que algo los cambie. Un enlace a un `ocx-child` efímero no cuenta: nunca lee la configuración de rutas, así que un Home cuyos únicos enlaces son efímeros no tiene ningún Child que proteger. En un Home sin enlaces, estos comandos exclusivos del Home no guardan valores predeterminados; un Child inscrito después hereda los interruptores tal como estén al inscribirse, salvo que ya se hayan guardado mediante un cambio de valores predeterminados. Si ese Home ya usa la configuración de rutas porque antes se guardaron valores predeterminados, un cambio de integración exclusivo del Home se registra como decisión propia del Home para que `ocx sync` lo conserve; los Children nunca heredan esa decisión. Si falla el guardado al iniciar el listener (por ejemplo, porque otro proceso mantiene el bloqueo de configuración), se reintenta en segundo plano. Leer la configuración de rutas mediante `ocx route to status` o desde un Child nunca guarda nada. Después, lo que heredan los Children solo cambia al modificar los valores predeterminados del Home. Esos comandos exclusivos solo cambian el Home. Si no se puede leer el archivo guardado (`route-intent.json` en el directorio de configuración de OpenCodex), estos comandos en un Home enlazado y cualquier cambio de `ocx route to` se rechazan sin modificar nada e indican qué archivo reparar o eliminar. En un Home sin enlaces, los interruptores nativos, `ocx restore` y los cambios de integración exclusivos del Home siguen funcionando: un cambio de integración no registra nada y `ocx sync`, que tampoco puede leer el archivo, no puede deshacerlo.

Cuando `ocx route to <client> on|off --device home` decide Codex, Claude Code, Grok o Claude Desktop, guarda el interruptor de ese cliente y luego lo aplica. Si la aplicación termina en conflicto o fallo (por ejemplo, por un proveedor externo de Codex, un bloque incompleto de Grok o un perfil de Claude Desktop modificado), el comando falla e indica si guardó el interruptor: «The Home's grok switch was saved, but applying it ended in conflict» significa que cambió, y «The Home did not apply» que no cambió nada. Claude Desktop en modo first-party rechaza la operación antes de guardar.

Una vez que el Home usa la configuración de rutas (tiene un valor predeterminado o una decisión propia guardados), `ocx sync` la aplica a todos sus clientes. Cada cambio de integración exclusivo del Home queda registrado como su decisión para ese cliente y `ocx sync` lo conserva: un interruptor del dashboard, `ocx integration client enable|disable` (la misma decisión exclusiva del Home; `ocx route to <client> on|off` cambia lo que heredan los Children), una acción de deshacer del historial de integraciones y un cambio de perfil de Aside, registrado como los userId estables de Aside de todos los perfiles que el Home enruta después. Los Children enlazados conservan sus valores predeterminados. Si un perfil de Aside no tiene un userId estable en `accounts.json` de Aside, el cambio de perfil en ese Home se rechaza antes de modificar nada (`route_intent_aside_unresolved`); repara el manifiesto o decide Aside para el Home con `ocx route to aside on|off --device home`, que guarda la decisión propia `devices.home.aside`. Si el valor predeterminado del Child no estaba resuelto, los Children sin una decisión explícita para Aside no pueden sincronizar la configuración de rutas hasta que establezcas su valor con `ocx route to aside on|off` (sin `--device`). Su estado sigue siendo `unresolved`; una decisión explícita para un Child sí funciona. Un Home que ya enrutaba esos perfiles antes de usar la configuración de rutas (por ejemplo, tras actualizar con un enlace) mantiene `ocx sync` operativo: hasta que se decida Aside o se repare el manifiesto, la sincronización deja Aside exactamente como está, aplica los demás clientes e indica cómo resolverlo. `ocx route to sync` hace lo mismo, y tanto este como `ocx route to status` muestran la configuración de Aside como `unresolved` (nunca `off`) con ese aviso.

```sh
ocx route to status --device all --json
ocx route to aside on --accounts all
ocx route to aside on --device my-child --accounts stable-aside-user-id
ocx route to pi off --device my-child
ocx route to pi inherit --device my-child
ocx route to sync --device my-child
```

El JSON de estado usa `ocx.route-to/1` y distingue la configuración deseada, su origen y el último resultado aplicado. El origen es `builtin`, `default`, `device` o `local` (una exclusión local del Child); las filas del Home para Codex, Claude Code, Grok y Claude Desktop indican `native`, es decir, el interruptor propio del Home. `not_installed`, `conflict` y `failed` siguen visibles; un cambio de configuración marca cualquier resultado anterior como `stale`, incluido un conflicto o fallo, para no juzgar la nueva decisión por el resultado de la anterior. La ausencia de un comprobante no demuestra que se haya aplicado correctamente. Una aplicación interrumpida o excluida localmente retira la confirmación anterior del Home. Un comando para un cliente informa sus fallos y advierte de otros clientes sin resolver; una sincronización explícita informa cualquier fallo sin resolver y termina con código distinto de cero si se aplaza el descubrimiento de la configuración o del catálogo, aunque los clientes desactivados en caché ya estén correctos. Los conflictos requieren `--overwrite-conflict` explícito para esa aplicación. Si una aplicación falla inesperadamente después de guardar la política de rutas o el interruptor del Home, el error lo indica e incluye `desiredCommitted: true`.

Sin `--device`, un cambio desde Home modifica su valor predeterminado y aplica solo ese cliente localmente mediante el mismo controlador. Para Codex, Claude Code, Grok y Claude Desktop lo aplica escribiendo el interruptor del Home, por lo que `ocx route to codex off` desactiva Codex en Home y cambia el valor que heredan los Children. `--device home` (o `this` en Home) decide solo para Home: para esos cuatro clientes escribe únicamente su interruptor y conserva el valor predeterminado de los Children; `inherit` establece el interruptor de Home al valor actual (el incorporado hasta que se guarde otro). Para los demás clientes registra una decisión propia del Home. Un cambio de ruta para otro cliente, `ocx route to sync` y un `ocx sync` simple en Home nunca cambian sus interruptores nativos. Solo actualizan lo que ya indica cada interruptor, así que no deshacen `ocx restore`, `ocx restore back`, la desactivación de la API Messages ni un interruptor del dashboard. Los Children heredan los cambios en su siguiente ciclo de sincronización. La sincronización explícita desde Home usa la sincronización SSH existente con identidad fijada para enlaces iniciados en Home. Con `--overwrite-conflict` (en `ocx route to` o `ocx sync`), Home solo la ejecuta en un Child con OpenCodex 2.100.0 o posterior, pues uno anterior ignora la opción e informaría éxito de una sincronización simple; los demás se omiten con `child-ocx-lacks-overwrite`. Un enlace iniciado por Child mantiene una vigilancia de lectura autenticada y acotada; la sincronización de Home la despierta de inmediato e informa `pending` hasta que el Child publique un informe de aplicación. Sin una vigilancia activa, el resultado espera explícitamente al siguiente ciclo. Sobrescribir un conflicto en un enlace iniciado por Child exige que alguien allí ejecute `ocx route to sync --overwrite-conflict`; el aviso no concede permiso para tomar el control. El `ocx route to sync` local siempre aplica de inmediato.

En Aside, `--accounts all` selecciona todos los perfiles asociados a cuentas en ese dispositivo; `none` no selecciona ninguno. Una lista usa el **userId** de Aside, nunca las posiciones numéricas `u/N`, por lo que admite distintas distribuciones locales. Los ID de modelo se obtienen del catálogo del dispositivo. Los interruptores conservan la política de cuentas y nombres de modelos omitida. Los perfiles administrados que faltan en el manifiesto de cuentas de Aside siguen incompletos hasta resolver su propiedad; un cliente desactivado no administrado no necesita manifiesto de cuentas.

En un Child, `status` y `sync` funcionan localmente. Los cambios que corresponden al Home imprimen el comando exacto para ejecutar allí. Una persona en el Child puede excluirlo con `ocx route to aside off --local`; `ocx route to aside inherit --local` elimina esa exclusión. Se rechaza `on` local. La exclusión se informa como `source: local`. La configuración del Home también prevalece sobre los comandos nativos ejecutados en un Child enlazado: `ocx restore` desactiva allí el enrutamiento de Codex solo hasta que la siguiente sincronización reaplique la configuración del Home, aproximadamente un minuto después. Usa `ocx route to codex off --local` para mantener Codex desactivado en ese Child. Un Child reconcilia cada minuto; cada aplicación retira su confirmación anterior antes de cambiar nada, así que un informe de estado enviado durante la aplicación puede mostrar brevemente que no se ha aplicado hasta el siguiente informe.

Al migrar, las integraciones administradas existentes pasan a ser valores predeterminados del Home; nunca se interpreta que los bloques no administrados impliquen consentimiento. Los valores predeterminados de los interruptores nativos se guardan como se describió antes, antes de cambiar cualquier interruptor del Home. La inscripción conserva una selección explícita de `connect --clients` como decisión inicial del dispositivo; sin selección explícita, el Child hereda los valores predeterminados del Home y sus cambios posteriores. Una decisión posterior del Home para ese dispositivo, `on`, `off` o `inherit`, sustituye la selección inicial de ese cliente. Ningún informe del Child cambia la política del Home. Los interruptores nativos del dashboard y de `ocx integrations native <client> on|off` cambian el interruptor del Home y ejecutan la transición propia del cliente (incluido el cambio al modo first-party de Claude Desktop), conservando los valores predeterminados de los Children; no registran una configuración de rutas para el Home. Una decisión propia del Home para uno de estos cuatro clientes guardada por una versión anterior se ignora y se elimina en el siguiente cambio de ruta. En un Child, la CLI rechaza la operación e imprime el comando del Home para ese dispositivo. Las decisiones de dispositivos retirados se eliminan con sus enlaces. Se conserva el modo first-party de Claude Desktop. Como ya enruta por OpenCodex, una configuración activada informa `current` sin escribir nada. Una configuración desactivada informa un conflicto e indica el cambio de modo que hay que ejecutar: `ocx integrations native claude-desktop off` en Home, o `ocx claude desktop apply --gateway` en un Child seguido de `ocx route to sync`.

Un cambio del Home que decide un cliente que luego no puede aplicar falla. `ocx route to claude-desktop off` en un Home en modo first-party, con o sin `--device home`, responde 409, informa el conflicto de ese cliente e indica el cambio de modo, y la CLI termina con código distinto de cero; lo mismo ocurre si no se puede escribir el interruptor del Home. Un cambio del valor predeterminado sigue guardando el valor de los Children.

Mientras está enlazado, un Child escribe la configuración efectiva de su Home en sus propios interruptores de Codex, Claude Code, Claude Desktop y Grok; desactivar Claude Code también puede fijar el ajuste de la API Messages. Antes del primer cambio, el Child registra el valor que tenía cada interruptor por sí solo, incluidos los que nunca se habían definido. `ocx disconnect` y una inscripción fallida restauran esos valores. Si una inscripción fallida no puede restaurarlos, conserva su token de servicio e indica el registro que no pudo restaurar; corrige el problema y ejecuta `ocx disconnect`, que restaura los interruptores y elimina el token aunque el equipo no esté conectado. Un interruptor que cambiaste mientras estaba enlazado conserva tu valor. Hay un límite: si lo estableciste exactamente al último valor aplicado por Home, no se puede distinguir de la escritura del Home y se restaura. Las exclusiones locales (`--local`) son tu propia elección en ese Child y permanecen después de desconectar.

Las integraciones de archivos siguen el mismo ciclo. Al aplicar por primera vez después de enlazar, el Child registra qué integraciones de archivos ya tenía configuradas por su cuenta (no se incluyen perfiles de Aside). `ocx disconnect` conserva las que siguen configuradas, vuelve a configurar las que Home desactivó y elimina solo las que añadió el enlace. Se conserva una exclusión local o un bloque que escribiste mientras estaba enlazado. Una integración restaurada muestra primero los últimos modelos que el Child recibió del Home; el siguiente inicio independiente la actualiza desde el catálogo local. Un Child que aplicó la configuración de rutas del Home antes de ejecutar una versión que guarda este registro no lo tiene, así que `ocx disconnect` no puede saber qué integraciones de archivos tenía por su cuenta: elimina las que administra el enlace y no vuelve a configurar las que Home desactivó. Vuelve a configurarlas tras desconectar.

La desconexión elimina las claves y bloques administrados y conserva los cambios posteriores en modelos, hooks, proyectos y Computer Use. Repite `ocx disconnect` para reanudar una desconexión interrumpida, manteniendo `--keep-catalog` si lo usaste en el primer intento. Para claves administradas modificadas o registros antiguos con evidencia, `ocx disconnect --recover-config --yes` primero guarda una instantánea privada actual y luego recupera las claves individualmente. Sigue rechazando la propiedad desconocida o un perfil editado sin verificar. Conserva el directorio de respaldo indicado. Ejecuta `ocx service restart` después de desconectar para que un Child administrado por un servicio sea reemplazado por OpenCodex independiente antes de volver a enlazar.

<a id="troubleshooting"></a>

## Solución de problemas

Cuando un paso falla, el panel de control muestra la razón y, cuando SSH informó de uno, una breve pista desinfectada de su última línea de error no vacía debajo del mensaje. Los errores de shell remoto pueden aparecer allí incluso cuando el shell remoto emite texto que no es UTF-8; OpenCodex elimina los controles de terminal, las claves de enlace y las consultas de URL y limita la longitud de la pista.

- **No se pudo conectar al host SSH**: el host debe aceptar su clave SSH sin una solicitud de contraseña; `ssh -o BatchMode=yes <alias> true` debe tener éxito desde una terminal. Un ayudante `ProxyCommand` como `cloudflared` debe instalarse en `/opt/homebrew/bin`, `/usr/local/bin`, `~/.bun/bin`, `~/.local/bin` u otro directorio en el PATH OpenCodex se ejecuta con.
- **ocx no se encontró en el equipo remoto**: OpenCodex busca `ocx` en el CAMINO de una sesión SSH no interactiva primero, luego en `~/.bun/bin`, `~/.local/bin`, `/opt/homebrew/bin` y `/usr/local/bin`. Si está instalado en otro lugar, agregue ese directorio a PATH en un archivo que el shell remoto lee para sesiones no interactivas, como `~/.zshenv` para zsh.
- **OpenCodex en el equipo remoto es demasiado viejo**: ejecute `ocx update` en ese equipo. El enlace remoto necesita 2.66.0 o posterior.
- **La computadora remota no reportó una versión OpenCodex**: `ocx --version` en ese equipo imprimió otra cosa, por ejemplo, el texto de uso de una instalación Windows no compatible.

- **Las solicitudes fallan con `home_unreachable` cuando el Home no está disponible**: un Child nunca atiende solicitudes con sus proveedores locales. Si el túnel ya estaba caído antes del reenvío, devuelve un 503 reintentable y no envía nada al Home. Si el túnel se corta después de iniciar el reenvío, también devuelve `home_unreachable`, pero el Home puede haber recibido la solicitud. Un fallo de autenticación del relé devuelve `link_relay_auth_failed`: actualiza el Home y el Child o vuelve a enlazarlos. El permiso por dispositivo en la página **Remote Link** del Home, o `ocx fallback local on --device <alias>`, determina si GOAT puede usar las sesiones locales de ese dispositivo; consulta [Desactivar el fallback](/es/guides/fallback-off/).

- **Un enlace iniciado por Home sigue Fallido por un error de reenvío después de una suspensión o un cambio de red:** ejecuta `ocx link status --json` en el Home. El campo `tunnel` muestra los intentos desde la última conexión, `nextRetryAt` y el fallo más reciente. Si `lastFailure.cause` es `remote_forward_conflict`, el servidor SSH del Child aún reserva el puerto de la sesión que perdió la conexión anterior del Home. Los nuevos túneles se rechazan hasta que libere ese puerto. OpenCodex sigue reintentando y se conecta cuando queda libre; nunca detiene procesos del Child. El servidor SSH detecta la sesión muerta al comprobarla. Sin `ClientAliveInterval` en `sshd_config` del Child, puede tardar lo que el keepalive TCP del sistema: dos horas por defecto en macOS. Configurar allí `ClientAliveInterval 15` y `ClientAliveCountMax 3` permite descartarla en aproximadamente un minuto.

<a id="retryable-503-diagnostics"></a>

### Diagnósticos de respuestas 503 reintentables

Un `503` generado por el relay incluye `x-opencodex-link-request-id`, creado por el servidor. Permite correlacionar el fallo con la evidencia local del Child en `link/diagnostics.jsonl` y su copia rotada `link/diagnostics.jsonl.1`, bajo el directorio de configuración de OpenCodex. Cada archivo tiene un límite de 256 KiB y permisos privados: directorio 0700 y archivos 0600 en POSIX, ACL privadas en Windows. Los registros solo contienen categorías fijas de evento, resultado y estado, identificadores de correlación generados, tiempos, generaciones, intentos numéricos y marcas de tiempo. No incluyen secretos, cuerpos de solicitud, encabezados, URL, identificadores de cuenta ni errores sin filtrar. Cada par evento/resultado se limita a un registro por segundo y el siguiente incluye cuántos se suprimieron: la ausencia de un registro no prueba que no hubiera un fallo. Si el reloj retrocede, se inicia otra ventana de limitación conservando ese recuento, incluso con la cola llena. El escritor asíncrono admite hasta 56 registros pendientes, cuenta el exceso como suprimido y cede la ejecución durante el trabajo de ACL en Windows. Registrar es una operación de mejor esfuerzo y no cambia la admisión de solicitudes. El apagado por señal y el reciclado independiente esperan hasta un segundo para vaciar la cola; el almacenamiento bloqueado, el cierre forzado o la pérdida de energía pueden hacer que se pierdan registros.

`owner_lookup` registra comprobaciones de propiedad rechazadas; las correctas ordinarias no se registran. `owner_lookup.elapsedMs` mide solo la consulta de propietario. En `auth_timeout`, los eventos `relay_retry` y `relay_failure` informan la duración real del intento de transporte en `elapsedMs`, normalmente unos cinco segundos. `relay_recovered` con resultado `recovered` solo se emite cuando un reintento recibe una respuesta del proveedor con `upstream.ok`, HTTP 2xx; no demuestra que el cuerpo transmitido haya terminado. Por la limitación de frecuencia, la correlación por identificador es evidencia muestreada y no un seguimiento garantizado de todos los fallos.

El Home escribe el mismo tipo de archivo para los túneles que ejecuta. Cada transición de un túnel iniciado por Home genera `tunnel_transition`, con `previousState`, `state`, causa en `outcome` (`auth`, `hostkey`, `forward`, `remote_forward_conflict`, `timeout`, `network`, `unknown`, `spawn_failed` o `listener_unavailable`; `connected`, `spawned` o `stopped` si no hubo fallo), el número de `attempt` desde la última conexión, `tunnelPort` y `retryAfterMs` si se programa otro intento. También se registra cada reintento fallido de un enlace ya fallido. La misma limitación de frecuencia se comparte entre todos los enlaces.

Antes de enviar datos, OpenCodex permite un único reintento previo compartido entre el timeout de consulta de propietario y un timeout de autenticación de cinco segundos identificado expresamente. Obtiene una prueba nueva de propietario cuando corresponde y un socket físico nuevo, que autentica antes de enviar la credencial del enlace o el cuerpo. No reutiliza una aprobación anterior de propietario, ni omite controles, ni reinicia SSH u OpenCodex, ni vuelve a enviar un cuerpo ya despachado. Los límites de dos segundos para propietario y cinco para autenticación siguen aplicándose a cada intento. Otros fallos no admiten este reintento previo.

Esto puede recuperar esos timeouts transitorios y aportar diagnósticos para fallos posteriores. No demuestra la causa histórica de [#7297](https://github.com/lidge-jun/opencodex/issues/7297).

<a id="security"></a>

## Seguridad

El Child utiliza los proveedores de la computadora Home y las credenciales del proveedor a través del enlace. El Home crea una clave de enlace separada para cada Child; la eliminación del enlace revoca esa clave. En el Child, la clave permanece dentro de OpenCodex: las credenciales que Codex o Claude Code envían allí no se reenvían al Home, incluidas las formas Bearer, `api-key` de Azure, `x-api-key` compatible con Anthropic y `x-goog-api-key` de Google. Cualquier programa en el Child que alcanza `127.0.0.1:<port>` utiliza el Home sin una llave, la misma confianza local que da una instalación independiente. Las páginas web de otros sitios son rechazadas. Compare la huella digital del host antes de la confirmación para que no se acepte por error una máquina incorrecta o una clave de host modificada. Las sesiones del panel de control emitidas desde una identidad de Tailscale no pueden administrar enlaces de máquina.

<a id="capture-ssh-diagnostics"></a>

### Capturar diagnósticos SSH

La captura está desactivada por defecto y solo puede activarse localmente en el equipo cuyo túnel se inspecciona:

```bash
ocx link capture start            # 15 minutes; --minutes accepts 1 to 60
ocx link capture status
ocx link capture stop
```

En Home captura los túneles que ejecuta a sus Children; en Child, el suyo a Home. No requiere proxy activo ni token, y ningún sync, dashboard o petición remota puede activarla. `start` dentro de una ventana extiende el final y usa el mismo archivo. El siguiente intento SSH usa `LogLevel=DEBUG1` en lugar de `LogLevel=ERROR`; un túnel conectado conserva su nivel hasta reconectar. `stop` o caducar detiene la escritura y el siguiente intento vuelve a ERROR. No cambia la admisión; líneas reconocidas no alteran la causa de error, pero un banner no reconocido con Permission denied puede cambiarla y afectar la espera.

Cada registro de `link/ssh-capture/ssh-<start time>.jsonl` indica hora, túnel `home` o Child, ID aleatorio del enlace, nivel y evento fijo saneado. Hosts, direcciones, usuarios, puertos, rutas, claves, huellas, comandos proxy, entorno y mensajes remotos se sustituyen por `<host>`, `<port>` u otros marcadores. Solo se conservan nombres estándar de algoritmo y autenticación; una línea no reconocida guarda `unrecognized` y recuento, nunca el texto. Cada ventana ocupa hasta 1 MiB, terminando en `capture_truncated`. Se conservan cuatro archivos y cada uno caduca a las 72 horas de su última escritura; se depuran al arrancar, iniciar túnel, ejecutar `ocx link capture` o vencer en un proxy activo. Sin proxy, se eliminan al siguiente arranque/comando. `stop` los conserva para compartir: bórralos al terminar. Directorio 0700 y archivos 0600 en POSIX, ACL privada en Windows y sin seguir enlaces simbólicos.

<a id="cli-reference"></a>

## Referencia CLI

```text
ocx link probe <alias> [--proxy-command <cmd> --ssh-user <user> --ssh-port <port>] [--exclusive] [--json]
ocx link add <alias> [--plant] [--expect-fingerprint SHA256:…] [--proxy-command <cmd> --ssh-user <user> --ssh-port <port>] [--exclusive] [--operation-id <id>] [--require-ephemeral] [--json]
ocx link port [--json]
ocx link issue --alias <alias> --tunnel-port <port> [--json]
ocx link status [--json]
ocx link diagnostics [--limit <n>] [--since <iso-time|epoch-ms>] [--json]
ocx link revoke --link-id <id> [--operation-id <id>] [--json]
ocx link operations [--operation-id <id>] [--json]
ocx link operations resolve --operation-id <id> --yes [--json]
ocx link recover (--link-id <id> | --operation-id <id>) [--json]
ocx link recover --list [--json]
ocx link recover --forget --link-id <id> --yes [--json]
ocx link reconnect --link-id <id> [--json]
ocx link routes --link-id <id> [--json]
ocx link routes add --link-id <id> --route <alias> [--position <n>] [--json]
ocx link routes remove --link-id <id> --route <alias> [--json]
ocx link routes order --link-id <id> --routes <alias,alias,...> [--json]
ocx link check (--link-id <id> | --all) [--no-wait] [--json]
ocx link update (--link-id <id> | --all) --yes [--no-wait] [--json]
ocx link sync (--link-id <id> | --all) [--no-wait] [--json]
ocx link sync --link-id <id> (--restart-app-server-only | --restart-codex --yes) [--no-wait] [--json]
ocx link restart-codex --link-id <id> [--scope app-server|codex] --yes [--no-wait] [--json]
ocx link capture start [--minutes <1-60>] [--json]
ocx link capture stop [--json]
ocx link capture status [--json]
ocx link policy [--updates off|notify|auto-when-idle] [--catalog-fanout auto|manual] [--child-codex-restart never|app-server-when-idle] [--idle-after-minutes <1-60>] [--json]
```

Una ruta explícita y exclusiva está destinada a quienes configuran por sí mismos la ruta SSH, por ejemplo un hub que aprovisiona un equipo desechable. `ocx link add <alias> --proxy-command <command> --ssh-user <user> --ssh-port <port> --exclusive` pasa ese ProxyCommand, usuario y puerto a ssh en la línea de comandos para cada comando y túnel del enlace, de modo que una edición posterior de `~/.ssh/config` no puede cambiar la ruta del enlace; el enlace también rechaza las modificaciones de `ocx link routes`. Un enlace así no lee ninguna configuración de SSH (`-F none`): no se le aplica nada de `~/.ssh/config` ni de `/etc/ssh/ssh_config`, por lo que el Home se autentica con las claves de su propio agente SSH (`SSH_AUTH_SOCK` en el entorno del proceso de OpenCodex) o con un archivo de clave predeterminado como `~/.ssh/id_ed25519`, y no se usa un `IdentityFile` definido en la configuración de SSH. Si el equipo espera una clave que el Home no ofrece de esa forma, un enlace existente aparece como `failed` con el motivo `auth` en `ocx link status` y una nueva inscripción falla con `probe_failed`; carga la clave en el agente del Home o guárdala en un archivo predeterminado `~/.ssh/id_*`. El comando debe comenzar con una ruta absoluta y usar solo letras, dígitos y `. _ / : @ + , = -` en palabras separadas por espacios individuales; se rechazan tokens `%`, comillas y caracteres de shell. Nunca incluyas un token, contraseña o clave privada en el comando: todos los usuarios locales pueden verlo en la lista de procesos, se guarda en el archivo PID del túnel y se muestra en `ocx link status --json`. `--exclusive` por sí solo limita el enlace a su único alias sin cambiar cómo ssh llega a él.

`ocx link revoke --force` de un Child desechable (con `ocx-child` instalado) omite la limpieza remota, así que el Home conserva un registro de ese equipo hasta que `ocx link recover --link-id <id>` lo limpie cuando vuelva a responder. La recuperación espera mientras exista otro enlace con ese alias, sin distinguir mayúsculas de minúsculas (`alias_linked`): el equipo puede pertenecer ahora a ese enlace, así que resuelva cualquier operación abierta sobre él (resolverla no elimina el enlace), revóquelo y después recupere. `ocx link recover --list` muestra esos registros. Cuando el equipo ya no existe, por ejemplo una VM en la nube destruida, `ocx link recover --forget --link-id <id> --yes`, ejecutado en el Home, elimina su registro sin contactarlo; ejecútelo usted mismo, porque OpenCodex lo rechaza desde un agente de programación o un runner de CI, y mientras el enlace siga existiendo. Pueden esperar como máximo 256 registros; por encima de ese límite se rechaza la revocación forzada de un Child desechable, y su enlace y su clave siguen activos, hasta que recupere u olvide algunos registros. Un Child con un `ocx-child` anterior al del Home no puede leer el registro de propiedad que escribió uno más reciente: instale una compilación actual antes de ejecutar allí cualquier comando del ciclo de vida.

Quien aprovisiona también puede registrar una inscripción: `ocx link add <alias> --expect-fingerprint <fp> --operation-id <id>` registra los identificadores de enlace y clave que creará antes de cambiar nada; repetir el mismo comando devuelve el resultado registrado (`committed`, `failed_clean`, `residual` o `unknown`) en vez de volver a inscribir. `--require-ephemeral` rechaza un Child con cualquier instalación completa de OpenCodex antes de instalar o cambiar nada. `ocx link revoke --operation-id <id>` registra la revocación de igual manera y `ocx link operations` muestra el registro; `ocx link operations resolve --operation-id <id> --yes` deja constancia de que se limpió o aceptó una operación residual o desconocida. Una revocación registrada que llegó al Child y terminó en `unknown` (un tiempo de espera agotado, una purga sin su informe, una escritura del registro que falló) puede haberlo desconectado o purgado, así que el Home mantiene caído el túnel de ese enlace, también tras reiniciarse, hasta que se resuelva la operación: `ocx link status` muestra el enlace como `failed` con el motivo `revoke_unsettled`, y `ocx link reconnect` responde `link_suspended` (código de salida 5) sin detener nada. Resolver la revocación permite que el túnel vuelva a conectarse. Si el Home se detuvo durante la revocación, su entrada queda en `open` y resolve la rechaza con `operation_not_resolvable`: repite la revocación con el mismo `--operation-id` y el mismo indicador `--purge`, y después resuélvela si termina en `unknown`.

<a id="related-guides"></a>

## Guías relacionadas

- [Implementación remota de Hub](/es/guides/remote-hub/)
- [Espacio de trabajo remoto](/es/guides/remote-workspace/)

<a id="relay-authentication-compatibility"></a>

### Compatibilidad con autenticación de relés

Actualice tanto el Home como el Child cuando actualice a la autenticación de retransmisión vinculada a la conexión. Antes de enviar una credencial o cuerpo de enlace de una solicitud retransmitida, el Child verifica el Home en la misma conexión que utilizará para esa solicitud. Una conexión cerrada no se reemplaza silenciosamente. Un Home sin este protocolo causa un error de autenticación reintentable; actualizar el Home y Child, y volver a vincular cuando el enlace almacenado ya no se reconoce. No hay un interruptor de reserva inseguro. Una rotación de clave API pendiente y no expirada sigue siendo válida hasta que expire o la rotación se confirme o se aborte.

Eliminar los drenajes finales de enlace Home pendientes de solicitudes de retransmisión autenticadas antes de liberar su oyente. Detener el proceso aún cancela las conexiones activas. Esto no cambia qué credenciales de llamada se eliminan o qué rutas se pueden retransmitir, y no reemplaza la verificación de clave de host de SSH.


<a id="home-and-child-versions"></a>

### Versiones del Home y del Child

En el Home, `ocx link status --json` informa la versión `local` del Home, la versión de autenticación del relé y sus capacidades, y añade un bloque `peer` a cada enlace. No consulta nada por SSH: el Home aprende esos datos mediante la comprobación de autenticación que el Child envía antes de cada solicitud retransmitida. Desde 2.91.0, esa comprobación también contiene la versión y las capacidades del Child. El Home guarda lo aprendido en memoria; tras reiniciarlo, un enlace muestra `unknown` hasta que su Child retransmita otra solicitud.

| Parte del enlace | Primera versión |
|---|---|
| `relay-auth/2`, autenticación del relé vinculada a la conexión | 2.69.0 |
| `link-management-relay`, administración de solo lectura del Home desde el Child | 2.84.0 |
| `link-peer-report/1`, el Child informa su versión y sus capacidades | 2.91.0 |

`peer.compatibility` puede ser:

- `compatible`: las versiones de autenticación del relé coinciden y el Home ofrece todas las capacidades declaradas por el Child. Un Child anterior a 2.91.0 no informa su versión: `peer.version` es `null` y `peer.versionRange` indica el intervalo deducido de la autenticación del relé, por ejemplo `{ "min": "2.69.0", "below": "2.91.0" }`.
- `degraded`: el Child declara una capacidad que el Home no ofrece. Actualiza el Home.
- `incompatible`: el Child solicita una versión de autenticación que el Home no admite, por lo que sus solicitudes se rechazan. `peer.reasons` indica qué lado actualizar.
- `unknown`: el Child no ha retransmitido solicitudes desde que arrancó el Home, o declaró una versión o lista de capacidades ilegible, por lo que no se puede comprobar su compatibilidad.

La versión que declara el Child es una afirmación propia vinculada a su clave de enlace. OpenCodex solo la usa para mostrar información, nunca para autorizar solicitudes. Las instalaciones antiguas de `ocx` siguen recibiendo el documento de estado anterior: solo la CLI 2.91.0 o posterior solicita estos campos.

<a id="standalone-pairing-authorization"></a>

### Autorización de emparejamiento independiente

El comando `ocx gui pair --origin <local-origin>` existente funciona mientras OpenCodex se ejecuta como un servicio en segundo plano. Ejecútelo con la cuenta propietaria del directorio privado de OpenCodex del servicio y, a continuación, introduzca el código de un solo uso devuelto en el panel de control local. No se requiere ningún terminal de servidor, contraseña adicional, Windows Hello ni clave de hardware. El CLI y el servidor deben usar la misma versión actual y el mismo directorio de configuración; reinicie un servidor anterior después de actualizar. Las invitaciones a Hub de versión mixta también requieren actualizar el CLI y el servidor juntos. El emparejamiento rechaza un directorio de configuración o de intención que sea un enlace simbólico; use el directorio protegido real como `OPENCODEX_HOME`.

Internamente, la CLI crea un compromiso de autorización de corta duración e intenta eliminarlo tras su uso o un fallo. Leer información del entorno de ejecución por sí solo no autoriza el emparejamiento, y el verificador no se guarda en disco. Es un límite basado en el acceso de escritura al directorio privado, no una autenticación biométrica ni una prueba de presencia humana: se sigue confiando en un programa con acceso completo a los archivos de ese usuario. La autorización de invitaciones de Hub existente no cambia. Si falla una solicitud de emparejamiento, ejecuta un comando nuevo después de resolver el problema indicado. SSH Remote Link en Windows usa la vía de ejecución independiente mediante PowerShell descrita arriba.

Si un proceso se interrumpe durante el emparejamiento, vuelva a ejecutar el comando para obtener una nueva autorización. No elimine manualmente el estado de emparejamiento mientras se ejecuta el servicio o un comando de emparejamiento.

En Windows, el emparejamiento se rechaza si la carpeta de intención o el registro no es privado de la cuenta de servicio, o si su propietario y los permisos no se pueden verificar. Ambas entradas deben ser propiedad de esa cuenta; La propiedad de los administradores solo se acepta cuando los administradores son el propietario predeterminado del token de servicio y su función de administrador está habilitada. La lista de permisos debe estar protegida de la herencia y contener una entrada de permiso de control total ordinaria para la cuenta servidora. Además de eso, solo se aceptan entradas de permiso simple para SYSTEM y el grupo Administradores, porque SYSTEM y un administrador elevado ya pueden tomar posesión de cualquier archivo; un administrador no elevado no gana nada de esa entrada. Solo en la carpeta se permite la herencia hacia los elementos descendientes. Esta es la lista como Windows lo informa: las entradas duplicadas compatibles para el mismo recuento de cuentas que uno, y las entradas que no conceden nada se ignoran. El cheque deja registros rechazados en su lugar y no repara sus permisos ni cambia la propiedad. Restaurar una casa de configuración privada y, a continuación, ejecutar un nuevo comando de emparejamiento.

La comprobación cubre la carpeta de intención y el registro. No protege contra el reemplazo de carpetas anteriores, derechos de eliminación en una carpeta principal, operaciones de restauración con privilegios o acceso a través de identificadores abiertos antes de que los permisos se vuelvan privados. Una solicitud con un compromiso coincidente puede bloquear el servidor durante un subproceso de verificación limitado a cinco segundos, incluso si su carpeta falla más tarde en la verificación de permiso. La configuración de inicio de proceso y búsqueda ejecutable precede a ese tiempo de espera. CLI limpieza puede realizar una verificación más. El presupuesto de subproceso de cinco segundos deja espacio dentro del tiempo de espera de solicitud de diez segundos del comando, pero la verificación lenta aún puede rechazar el emparejamiento.

<a id="add-a-child-from-the-terminal"></a>

## Agregar un Child desde el terminal

En el Home, ejecute `ocx link probe child-a --json` para inspeccionar la huella digital SSH ofrecida, el tipo de clave y la versión OpenCodex. Verifique la huella digital a través de una fuente confiable. A continuación, ejecute `ocx link add child-a --expect-fingerprint SHA256:… --json`. El comando sondea de nuevo y rechaza un desajuste antes de almacenar la confianza o emitir una clave. Sin el indicador de huella dactilar, requiere un terminal interactivo y un `yes` explícito después de mostrar la huella dactilar. Nunca imprime la clave de enlace.

Para una instalación completa de OpenCodex, las conexiones iniciadas desde Home reinician el Child después de guardar su conexión, incluidas las instalaciones antiguas que tengan la capacidad necesaria. Ese Child debe estar sirviendo OpenCodex independiente en su puerto configurado y ofrecer soporte de reinicio vinculado; actualízalo o desconéctalo si no supera esta comprobación previa. Un Child ligero limpio y desconectado no necesita un daemon en ejecución; consulta [Children efímeros](#ephemeral-child-machines-ocx-child). Los Children POSIX necesitan curl; Windows usa una solicitud HTTP de loopback con tiempo limitado mediante .NET. En Children macOS y Linux, Home usa primero la instalación de OpenCodex que sirvió el Child más recientemente, incluida una instalación npm bajo un prefijo personalizado, aunque haya otra copia instalada más reciente. Una aplicación de escritorio o copia de PATH anterior ya no responde en su lugar. Si esa instalación falta o no puede informar su versión, las instalaciones Desktop y de sistema tienen prioridad sobre los shims genéricos de PATH; los candidatos que no funcionan se omiten. Los Children Windows x64 usan comandos PowerShell codificados sin consumir la entrada estándar que transporta la clave. La comprobación previa lee `ocx config show --json` con el límite de captura de 4 MiB del ejecutor, por lo que un Child con una configuración guardada grande todavía acepta un enlace; si la salida supera ese límite, devuelve `child_preflight_output_limit` e indica el comando cuya salida hay que reducir. Cuando falla una fase, `ocx link add` muestra la fase junto con el motivo del Child, por ejemplo una configuración guardada no válida o la última línea de error del comando fallido. El motivo se acorta y se eliminan las claves de OpenCodex y las cadenas de consulta de las URL.

<a id="windows-computers"></a>

### Equipos Windows

Un Child Windows x64 necesita OpenSSH Server, Windows PowerShell y el binario independiente `ocx.exe` o el ligero `ocx-child.exe`. Home reconoce Windows durante el sondeo, lo registra con el enlace y ejecuta todos los comandos del Child mediante PowerShell sobre la misma conexión SSH con identidad fijada, tanto si el shell predeterminado de SSH es cmd como si es PowerShell. La clave del enlace sigue viajando solo por la entrada estándar. Cerrar la conexión SSH termina el comando remoto del Child seleccionado. Si Windows PowerShell en el Child no puede cargar el asistente que contiene el ejecutable seleccionado en un Job que termina al cerrarse, por ejemplo bajo Constrained Language Mode, el comando se rechaza y no se ejecuta nada. Si Home no puede determinar la plataforma del Child, se detiene antes de emitir una clave de enlace.

Ejecuta `ocx link cleanup` en Home para inspeccionar las plataformas registradas de los Children sin modificarlas. Las versiones actuales de Home desconectan los Children Windows mediante PowerShell. Si falla una desconexión remota, resuelve el error de shell o instalación indicado y reintenta; **Eliminar aquí solamente** sigue siendo una acción explícita de recuperación que puede dejar al Child pendiente de una desconexión local.

Reiniciar espera los giros y puede tardar varios minutos. El éxito requiere que el Child reiniciado cumpla con el rol de cliente y transmita un nuevo catálogo completo a este Home. La configuración de SSH tiene una asignación limitada derivada de la latencia medida; la verificación del relé comienza después del reinicio con su propia ventana de 15 segundos. Los errores indican la fase fallida y terminan con el código de error. Si un error informa la configuración residual Child, ejecute `ocx disconnect` y `ocx restart` en ese Child antes de volver a intentarlo. Home limpieza por sí sola no restaura Child configuración. Un tiempo de espera CLI reporta un resultado incierto; inspeccione Home `ocx link status` y Child `ocx connect status` primero.

En un Child cuyo enlace inició Home, `ocx link status` informa el rol `child`, la identidad del enlace y el puerto del túnel de su conexión guardada, aunque su almacén de enlaces Home está vacío. El estado del túnel no observado localmente es `idle`. `ocx status` llama al par un enlace remoto Home. Cuando Home se ejecuta en el modo Hub, el estado lee su proyección soportada a través del relé local Child. Un Home independiente informa que no publica el estado de Hub. La identidad del túnel iniciada por un Child proviene de su sidecar válido; la evidencia ilegible no declara una dirección.


<a id="child-install-catalog-and-activity"></a>

### Instalación, catálogo y actividad del Child

El Home requiere OpenCodex 2.66.0 o posterior; el Child también si inicia el enlace o usa una instalación completa. Un host SSH vacío puede recibir `ocx-child` verificado sin Node, Bun ni OpenCodex previo. npm y Desktop no incluyen ese binario: consulta [Children efímeros](#ephemeral-child-machines-ocx-child). Confirma la huella antes de **Conectar Child** o **Instalar agente ligero y conectar**.

Home reintenta cada minuto los túneles que inició tras un timeout o error de reenvío. Un Child que inició su enlace duplica la espera de uno hasta cinco minutos. Ambos esperan cinco minutos ante errores de autenticación; nunca reintentan una huella cambiada. `client_state_changed` significa que la conexión guardada falta o identifica otro propietario o enlace; los endpoints de estado también devuelven `503`. Detén o reinicia el Child y comprueba su conexión antes de enlazarlo otra vez; este resultado no desconecta el relay.

`ocx connect status` muestra `Link tunnel:` con `up`, `down (<reason>)` o `unknown`. Las causas de este último son `runtime_not_running`, `runtime_unreadable` y `link_unverified`. `--json` lo incluye en `linkTunnel`. `Connection: connected` solo confirma el vínculo: puede coexistir con `Link tunnel: down (home_unreachable)` hasta reconectar.

Si `ocx connect status --json` informa `disconnected` pero un token sobrante impide enlazar, inspecciona el Child. Tras confirmar que debes conservar los archivos, usa `ocx disconnect --orphaned-token --yes`. Rechaza clientes conectados o pendientes, runtimes clientes activos o no verificables, Hub, bind fuera de loopback, secretos de admisión configurados o coincidentes y servicios instalados o no verificables. Revisa `ocx service status`, bind, claves y entorno; migra o quita un servicio solo si es lo deseado. Mueve token y respaldo de rotación a un directorio privado e imprime su ubicación, sin presumir que eran del enlace. Windows exige enlaces duros para conservar identidad; inspecciona un respaldo incompleto antes de reintentar. Ante `unsafe token file`, revisa `orphaned-token-*` por `.service-api-token.identity` o `.service-api-token.prev.identity`: quita un pin solo si es un enlace duro al token actual, no solo porque coincida el nombre; puede ser la única copia de un token anterior. Inspecciona los demás enlaces. Para restaurar, detén OpenCodex y devuelve los archivos solo si sus nombres originales no existen. No revoca una clave Home ni reconstruye la configuración cliente.

Con Desktop o un servicio supervisando el Child, sync puede aplicar ajustes y aplazar el reinicio. Cierra y abre Desktop o usa `ocx service restart` para hacerlos efectivos. Importar una configuración que reemplaza o elimina una conexión activa se rechaza: desconecta primero o conserva exactamente el registro.

`ocx link status --json` incorpora un bloque `child` por enlace:

- `runningVersion` es la versión declarada por el Child. `installedVersion`, `installKind` y `update` con `route`, `reason`, `observedAt` proceden de `ocx link check` y son null antes. `versionSkew` es `same`, `behind`, `ahead` o `unknown`; en `ocx-child`, siempre unknown.
- `catalog.state` es `current`, `behind` o unknown según el contenido, no las fechas. Descargar, incluido durante `ocx link add`, no demuestra aplicar.
- `activity.idle` es `true` tras diez minutos sin solicitudes retransmitidas, ajustable con `ocx link policy --idle-after-minutes`; `inFlight` cuenta las actuales. Tokens, catálogo y readiness no cuentan. Un Child antiguo sin autenticación por conexión cuenta contra todos los enlaces.
- `activeJob` identifica la operación activa, `lastOperation` la última acabada; `codex` es null por ahora.

`ocx link check --link-id <id>` o `ocx link check --all` consultan `ocx update --plan` por SSH, sin actualizar: 60 segundos por Child y tres a la vez. Antes de 2.97.0 devuelve `owner-action`, `legacy-ocx`; POSIX hace otra lectura de versión y Windows usa la declarada. npm/pnpm sin instalación servidora registrada pasan por el launcher habitual y sus registros de arranque. Los enlaces iniciados por Child y los ligeros no usan SSH en esta comprobación. `--no-wait` imprime el trabajo aceptado; en otro caso espera. Salidas: 0 todos responden, 6 no comprobable, ocupado, antiguo o desconectado, 1 fallo, 4 desconocido o Home antiguo, 5 operación ocupada o sin enlaces.

<a id="operating-children-from-the-home"></a>

### Operar Children desde Home

- `ocx link sync` usa `ocx sync --expect-link`, con Child 2.93.0 o posterior.
- `ocx link restart-codex --link-id <id> --yes` sincroniza y reinicia app-servers. `--scope codex` también cierra y abre Desktop y exige sesión gráfica. Equivale a `ocx link sync --link-id <id>` con `--restart-app-server-only` o `--restart-codex --yes`. Termina turnos y nombra un solo enlace.
- `ocx link update (--link-id <id> | --all) --yes` lleva al Child exactamente a la versión del Home mediante su propio instalador. Comprueba pertenencia y plan, aplica con plazo del reloj del Child y sincroniza después de un éxito, fallo o reversión verificados. Un resultado desconocido no se reintenta ni sincroniza: usa `ocx link check`. npm/pnpm usan Node, con lectura previa `node --version`; Bun usa Bun. Requiere 2.97.0; procesa uno a la vez y termina las solicitudes del Child al reiniciarlo.

Home no reinicia Codex mientras retransmite una solicitud del Child. `ocx sync --restart-children` o `--restart-children=codex --yes`, con `--child <linkId>` opcional, sincroniza y omite solo el reinicio ante actividad, `restart-skipped:link-active`. Si ya estaba activa al iniciar `ocx link restart-codex`, no envía nada y marca `busy`; si aparece durante sync, solo omite reinicio. Es de mejor esfuerzo: una petición que llegue entre la comprobación y el reinicio aún puede terminar. Home tampoco puede saber si Codex está en mitad de un turno que ejecuta una herramienta en lugar de una solicitud de modelo, así que deja que terminen los turnos activos de Codex en ese Child antes de reiniciar Codex o actualizar OpenCodex allí. Una actualización manual reinicia el OpenCodex de ese Child y termina cualquier turno que aún se retransmita para él; las actualizaciones automáticas esperan a que el Child esté inactivo. Antes de 2.69 la actividad sin streaming solo se ve al empezar la respuesta. Windows admite `sync`, pero rechaza `windows-restart` y `windows-apply`; `ocx-child` no admite esas operaciones. Solo una operación por enlace: borrarlo mientras trabaja devuelve `409 link_operation_in_progress`; un trabajo múltiple marca `link-operation-in-progress` en el ocupado y continúa con los demás.

Salidas: 0 todos correctos o actualizados; con `--no-wait` solo confirma aceptación. Lee el `jobId` en `GET /api/link/children/jobs/<jobId>` con token administrativo loopback; los últimos 32 duran una hora y se pierden al reiniciar Home. 6 requiere atención, incluido reinicio omitido o actualización sin sync posterior; 1 es fallo o incertidumbre; 4 enlace desconocido o Home sin comandos; 5 operación activa, único enlace iniciado desde Child, sin enlaces o ejecución en Child. Requieren Home loopback; en otro bind fallan con 1, y la página **Remote Link** del panel de control ofrece las mismas acciones para un Child iniciado por Home. No enlaces equipos ajenos: Home ejecuta comandos con tu clave SSH.

<a id="child-versions-and-actions"></a>

### Versiones y acciones del Child

En un Home, cada fila de Remote Link lleva lo último que el Home aprendió sobre ese Child, y una fila iniciada por Home también lleva sus controles. Las insignias dicen:

- la versión del Child, con `Behind Home (<home version>)`, `Same version as Home` o `Newer than Home` al lado, más `Update available: <home version>` cuando se puede aplicar una actualización. Un Child iniciado desde su propio panel de control muestra su versión sin insignia de desfase, y un Child `ocx-child` siempre dice `unknown`.
- el tipo de instalación (`Desktop app`, `GOAT`, `Source checkout`), o el token sin formato en monoespaciada cuando esta versión no lo nombra.
- `Catalog current` o `Catalog out of date`. `Codex restart needed (<n>)` y `Codex not running` solo aparecen cuando el Child informa de su estado de Codex, que añade una versión posterior; todavía ningún Child publicado lo envía, así que hoy esas dos insignias no aparecen.
- la última operación, como `Last <operation>: <state>` con su razón en monoespaciada, y la que se está ejecutando mientras un trabajo ocupa el enlace.

Cuando el Home no puede actualizar ese Child por sí mismo, la fila dice qué hacer en su lugar: use Check for Updates en OpenCodex Desktop allí, actualice a mano, mediante `mise`, o deje que GOAT lo haga. Una razón desconocida se imprime como un token en lugar de una frase supuesta.

Las cuatro acciones inician el mismo trabajo que la CLI, así que necesitan las mismas versiones en el Child:

- **Check** lee los datos de instalación del Child, como `ocx link check`.
- **Sync now** ejecuta allí el comando fijado `ocx sync --expect-link`, como `ocx link sync`.
- **Restart Codex** abre una elección de alcance. `Codex app-servers` reinicia los app-servers en segundo plano del Child para que carguen el catálogo actual; no actualiza el app-server propio de la aplicación de escritorio de Codex, así que reinicie la aplicación de escritorio para eso. `Codex desktop app` además la cierra y la vuelve a abrir, lo que termina las conversaciones abiertas allí.
- **Update** lleva el OpenCodex del Child a la versión de este Home mediante el propio actualizador del Child, como `ocx link update`. La confirmación dice que el OpenCodex del Child se reinicia y que cualquier turno que aún se retransmita para él termina, y que las actualizaciones automáticas esperan a que un Child esté inactivo.

**Check all** y **Update all** actúan sobre cada enlace elegible iniciado por Home; Update all sigue ejecutando un Child a la vez y nunca apunta a otra versión. Un trabajo en ejecución muestra una línea por Child con su estado, la versión de la que salió y a la que llegó, el resultado de su sincronización de catálogo y el de su reinicio. El panel desaparece cuando el trabajo termina y las filas se actualizan; un trabajo que el Home ya no conoce, porque se reinició, lo dice y deja el estado propio de cada fila como respuesta. Mientras un trabajo ocupa un enlace, sus acciones y Desconectar están deshabilitadas; el servidor rechaza la solicitud de todos modos.

Debajo de la lista, el panel **Child automation** muestra y edita el mismo archivo de política que `ocx link policy`: distribución del catálogo (automática por defecto), reinicio de Codex (nunca por defecto), actualizaciones (automáticas cuando está inactivo por defecto, aún no activas en esta versión) y el periodo de inactividad. Guardar escribe solo lo que cambió. Si el archivo de política está dañado, el panel dice que la distribución automática del catálogo y las actualizaciones automáticas están desactivadas, y guardar entonces escribe cada ajuste para que los modos que eligió sean los que persisten. Estos controles nunca eluden al servidor: vuelve a comprobar la política, el estado del enlace y la actividad del Child en cada trabajo.

No enlace un equipo que no posee: el Home ejecuta estos comandos allí con su clave SSH.

<a id="automatic-catalog-fan-out-and-the-child-policy"></a>

### Catálogo automático y política de Children

El envío de catálogo está activo por defecto. Auto-refresh o una comprobación cada cinco minutos detectan cambios y esperan 60 segundos para agruparlos, hasta cinco minutos desde el primero, antes de sincronizar por SSH sin reiniciar Codex salvo `childCodexRestart`. Exige enlace iniciado en Home, túnel conectado, ninguna operación y sync anterior al cambio. Descargar no basta. Con solicitudes activas solo sincroniza si los ajustes ya coinciden y el runtime reinició desde aplicarlos; si no, espera inactividad. Tras fallo espera cinco minutos y duplica hasta seis horas; un Child anterior a 2.93.0 espera otra versión. El trabajo usa `trigger: "auto"`; sin enlaces no se activa.

Un app-server conserva el catálogo hasta reiniciar. Usa `ocx link restart-codex --link-id <id> --yes`, `ocx sync --restart-children` o `ocx link policy --child-codex-restart app-server-when-idle`. Esta última opción actúa en el siguiente sync automático con el Child aún inactivo: un catálogo ya actual no provoca otro sync/reinicio.

La política está en `<configDir>/link/child-policy.json`, nunca en `config.json`:

| Ajuste | Predeterminado | Valores |
|---|---|---|
| `catalogFanout` | `auto` | `auto`, `manual` |
| `childCodexRestart` | `never` | `never`, `app-server-when-idle` |
| `updates` | `auto-when-idle` | `off`, `notify`, `auto-when-idle` |
| `idleAfterMs` | `600000` (10 minutos) | 1 a 60 minutos |

Las actualizaciones automáticas aún no están activas: `updates` se guarda ahora y `notify` o `auto-when-idle` se aplicarán cuando se publiquen. Puedes anticipar tu elección con `ocx link policy --updates notify` o `--updates off`. Este periodo también define `activity.idle`.

```text
ocx link policy                                    # read the policy
ocx link policy --catalog-fanout manual            # turn automatic catalog fan-out off
ocx link policy --child-codex-restart app-server-when-idle
ocx link policy --updates off --idle-after-minutes 20 --json
```

`GET` y `PUT /api/link/children/policy` consultan y cambian ajustes con token administrativo loopback o sesión dashboard; PUT solo envía cambios. Un archivo dañado o valor desconocido desactiva automatismos y muestra aviso. Guardar lo limpia pero deja desactivado lo no nombrado: actívalo explícitamente con `ocx link policy --catalog-fanout auto --updates auto-when-idle`. Home no lo reescribe solo.

El preflight usa primero la instalación que sirvió el Child, incluso un prefijo npm personalizado. Si falta o no da versión, prioriza Desktop y sistema sobre PATH y omite candidatos rotos. Windows usa PowerShell codificado sin consumir stdin de la clave. `ocx config show --json` admite 4 MiB; superarlos informa `child_preflight_output_limit` y qué comando reducir. Los errores indican fase y último motivo acotado, sin claves ni consultas URL.

<a id="ephemeral-child-machines-ocx-child"></a>

### Children efímeros (`ocx-child`)

Home envía por SSH `stdin` un binario SHA-256 verificado a `~/.cache/opencodex/bin/ocx-child`, o `%LOCALAPPDATA%\opencodex\bin\ocx-child.exe`. El Child no necesita Node, Bun ni red saliente. Elige **Instalar agente ligero y conectar** o `ocx link add <alias> --plant --expect-fingerprint SHA256:…`; `ocx link add <alias>` interactivo pregunta antes. POSIX exige `sha256sum`, `shasum` u `openssl`; sin ellos rechaza `hash_tool_unavailable` antes de ejecutar. Puede estar preinstalado en `~/.local/bin/ocx-child`, la caché o `PATH`. Se buscan primero todos los candidatos completos; con `$OPENCODEX_HOME/child/state.json`, se mantiene el ligero hasta separarlo.

Home nunca construye ni descarga el binario. npm/Desktop no lo traen: `plantable: false`, `plantUnavailableReason: "artifact_not_found"` hasta aportarlo. Busca targets `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `windows-x64`, en orden:

1. `OPENCODEX_CHILD_BIN_DIR`: `ocx-child-<target>`, `ocx-child-windows-x64.exe`, `<target>/ocx-child` o `ocx-child` si coincide con Home, listado en `SHA256SUMS` del mismo directorio.
2. `native-bin/` junto al código o ejecutable, con la misma regla; ningún paquete lo aporta hoy.
3. Solo en checkout, `native/ocx-child/target/release/ocx-child` para el mismo target.
4. `$OPENCODEX_HOME/cache/ocx-child/<Home version>/ocx-child-<target>` con un archivo `SHA256SUMS` al lado. Puedes copiar compilaciones ahí tú mismo; OpenCodex nunca escribe en `cache/` y `ocx uninstall` lo conserva. Tras una actualización, el Home actualizado también guarda compilaciones en su propio directorio, `$OPENCODEX_HOME/ocx-child-builds/<Home version>/`, que consulta después del tuyo, pero solo cuando su paquete lista los digests de ocx-child de la versión, y solo guarda las compilaciones cuyo SHA-256 coincide. Una instalación nueva, un reinicio de la misma versión, una vuelta a una versión anterior, un checkout del código fuente y un Home en Windows no descargan nada, y los directorios deben ser privados de tu usuario. Las versiones actuales aún no listan los digests. Define `OCX_DISABLE_CHILD_CACHE_FILL=1` para desactivar el relleno. Cada versión actualizada conserva su propio directorio; las anteriores todavía no se eliminan. OpenCodex gestiona `ocx-child-builds/`: `ocx uninstall` lo elimina junto con el resto de la configuración de OpenCodex, así que guarda tus propias compilaciones en `cache/ocx-child`.

Compila con `cargo build --release --locked --manifest-path native/ocx-child/Cargo.toml`, con compilación cruzada si procede; copia con el nombre adecuado y añade `sha256sum ocx-child-<target> >> SHA256SUMS` o `shasum -a 256`. No se aceptan enlaces ni archivos escribibles por grupo u otros.

Un Child ligero separado no necesita daemon previo. Se comprueban el puerto `10100` y `~/.codex/config.toml`: `409 child_port_busy` o `409 child_external_provider_conflict` conserva la configuración y revierte el binario recién instalado. Home envía la clave por stdin, inicia `ocx-child serve` y verifica `/v1/catalog` autenticado. El dashboard indica **Ligero**. Desconectar restaura `~/.codex` y detiene el relay sin procesos, conservando el binario para reconectar. `--purge` de `ocx link revoke` también lo elimina, mediante su ruta verificada, nunca otro de PATH. Si falta o no confirma borrado, conserva el enlace y falla; permite reintentar, desconectar sin purga o limpiar manualmente. No admite purge para una instalación completa.

Un Child `ocx-child` actualiza el catálogo del Home mediante `ocx sync` y nunca lee la configuración de rutas. `ocx route to status` lo muestra como `route intent unsupported (ephemeral-child-no-route-intent)`. Un cambio de ruta que lo nombre con `--device`, y `ocx route to sync --device` para ese Child, se rechazan con `409 route_intent_unsupported` antes de cambiar nada; `ocx route to sync --device all` lo informa como `unsupported` sin contactarlo. Inscribirlo no guarda configuración de rutas, y `ocx sync` le envía la sincronización normal del catálogo incluso con `--overwrite-conflict`.

En un Child completo, `ocx disconnect` reinicia el runtime cliente activo para servir independiente. Si falla distingue `ocx restart`, `ocx service restart` o inspección con `ocx status` y `ocx connect status` según propietario y conexión. Desktop o un servicio habilitado y activo pueden relanzarlo por SSH. Un servicio que no pueda verificarse relanzable conserva el proceso. Un simple `OCX_SERVICE=1`, incluidos `ocx claude`, `ocx codex` y `ocx opencode`, conserva el comportamiento anterior. Versiones antiguas deben reiniciar una vez con la nueva versión.

`ocx link diagnostics` consulta solo archivos locales, sin proxy ni modificaciones: `--limit <n>` admite 1–1000, por defecto 200; `--since <iso-time|epoch-ms>` y `--json` usan `ocx.link.diagnostics/1`. Informa `skipped` para líneas no reconocidas y `files` con `refused` si hay enlaces o archivos no regulares. El dashboard usa la autoridad de estado de enlaces y muestra registros propios del Child.

En un Home con bind `0.0.0.0`, el token administrativo no autoriza el listener público ni el de gestión vía Tailscale para leer enlaces. macOS/Linux ofrecen `<OPENCODEX_HOME>/run/control-<port>.sock`, socket privado que solo sirve `GET /api/link/status` con token; la CLI lo elige automáticamente. Windows y versiones anteriores conservan TCP, que devuelve `403` en este caso.

<a id="lightweight-child-cleanup"></a>

### Desconexión y recuperación del Child

En el Home, `ocx link revoke --link-id <id>` desconecta sin borrar el binario ligero. `ocx link revoke --link-id <id> --purge` solicita además su eliminación, o usa `ocx-child detach --purge` desde el propio Child. Home ejecuta la copia plantada y verificada —`ocx-child.exe` en Windows—, no otra encontrada en PATH. Si falta o no confirma el borrado, informa error y conserva el enlace para reintentar o desconectar sin purga. Se rechaza la purga de una instalación completa; los enlaces antiguos primero verifican el tipo de Child. El agente ligero usa el `CODEX_HOME` elegido para restaurar el enrutamiento y cerrar el relay.

Las operaciones que reinician Codex completo o actualizan un Child requieren `--yes`; una lectura no concede ese permiso. `ocx link policy` es local al Home: se persiste bajo la configuración de OpenCodex y no modifica el `config.toml` de Codex por sí solo. La API de políticas usa `PUT` con la autorización de administración habitual; una política de Home no puede activar la captura SSH local de otro equipo.

Un error `Child restart preflight` con `child_restart_unsupported` describe la condición y el comando que la resuelve: un Child aún vinculado requiere desconectar y reiniciar; un runtime de cliente requiere `ocx restart`; un Hub, `ocx hub disable`; un runtime antiguo requiere actualizar; un puerto distinto del configurado requiere reiniciar. Inspecciona el estado antes de repetir una operación de resultado incierto.
