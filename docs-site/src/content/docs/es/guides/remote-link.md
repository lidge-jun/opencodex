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

La hoja Add Child explica que el Child utiliza este Home 's proveedores sobre SSH y enumera los requisitos previos anteriores. Los alias de host provienen de `~/.ssh/config` en el Home que ejecuta OpenCodex, no necesariamente el ordenador que muestra el navegador. Si el descubrimiento tiene éxito sin hosts, agregue una entrada `Host` como esta, luego elija **Rescan hosts**. También puede introducir un alias existente manualmente; seleccionar o introducir un alias habilita **Conexión de prueba**. La hoja enlaza con esta guía.

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
- **Fallido** significa que el enlace necesita atención. Revisa la autenticación SSH, la clave de host confirmada, el reenvío y el motivo que muestra el dashboard. Quien ejecuta el túnel sigue reintentando tras una suspensión, interrupción o reinicio: Home para un Child que añadió y Child para un enlace iniciado desde su propio dashboard. Tras un timeout o error de reenvío, espera un minuto y duplica la espera después de cada nuevo fallo, hasta cinco minutos. Los errores de autenticación se reintentan cada cinco minutos; una clave de host cambiada nunca se reintenta. Para forzar otro intento, elige **Reintentar** en el dashboard del Home o ejecuta allí `ocx link reconnect --link-id <id>`. Esto reinicia el túnel del enlace, sin reiniciar OpenCodex.

Un enlace fallido no cambia silenciosamente a un proveedor local. El Child devuelve un `503` reintentable sin reenviar la clave de enlace o solicitud cuando su túnel falla, se detiene o no se supervisa. También mantiene la clave local cuando otro proceso posee el puerto del túnel; libre ese puerto para que el túnel SSH del Child pueda enlazarlo.

En un Child, `GET /healthz` solo indica que OpenCodex se está ejecutando. `GET /readyz` y `ocx ready` también comprueban si el enlace puede transportar una solicitud. Si no puede, la respuesta es `503` con `Retry-After: 1`, `"status": "pending"` y un objeto `link`, por ejemplo `{ "state": "unavailable", "reason": "home_unreachable" }`. Si puede, responde `200`, `"status": "ready"` y `{ "state": "available" }`. Los motivos posibles son `tunnel_connecting`, `tunnel_failed`, `tunnel_idle`, `tunnel_unavailable`, `sidecar_invalid`, `home_unreachable`, `home_unauthorized`, `link_auth_failed`, `link_credential_unavailable` y `link_unverified`. Un Child enlazado desde su propio dashboard consulta su túnel. Si el Home añadió el Child, este no tiene un túnel propio que inspeccionar: consulta al Home por el túnel con la misma comprobación sin credenciales que precede a cada solicitud reenviada, como máximo una vez cada cinco segundos. Si el Home no responde en medio segundo, informa `link_unverified`.

Para confirmar qué Home atiende a un Child, compara el encabezado `x-opencodex-served-by` de `GET /v1/models` del Child con `instanceId` de `GET /healthz` del Home. El Child retransmite el encabezado sin cambios, por lo que los valores coinciden mientras el enlace funciona. Es un identificador opaco, nunca un nombre de equipo; consulta [Identidad del Home y encabezado served-by](/es/reference/management-api/#home-identity-and-the-served-by-header).

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
ocx disconnect
```

Para desconectar un enlace iniciado por Child, ejecute `ocx disconnect` en el Child. Desconecta el túnel del cliente y revoca el enlace en Home sobre SSH. Si la revocación Home falla, se imprime: `Home revoke failed; run ocx link revoke --link-id <linkId> on the home.`

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

El Child utiliza los proveedores de la computadora Home y las credenciales del proveedor a través del enlace. El Home crea una clave de enlace separada para cada Child; la eliminación del enlace revoca esa clave. En el Child, la clave permanece dentro de OpenCodex: las credenciales que Codex o Claude Code envían allí no se reenvían al Home, incluidos Bearer, Azure `api-key`, Anthropic -compatible `x-api-key` y Google `x-goog-api-key`. Cualquier programa en el Child que alcanza `127.0.0.1:<port>` utiliza el Home sin una llave, la misma confianza local que da una instalación independiente. Las páginas web de otros sitios son rechazadas. Compare la huella digital del host antes de la confirmación para que no se acepte por error una máquina incorrecta o una clave de host modificada. Las sesiones del panel de control emitidas desde una identidad de Tailscale no pueden administrar enlaces de máquina.

<a id="cli-reference"></a>

## Referencia CLI

```text
ocx link probe <alias> [--json]
ocx link add <alias> [--expect-fingerprint SHA256:…] [--json]
ocx link port [--json]
ocx link issue --alias <alias> --tunnel-port <port> [--json]
ocx link status [--json]
ocx link revoke --link-id <id> [--json]
ocx link reconnect --link-id <id> [--json]
```

<a id="related-guides"></a>

## Guías relacionadas

- [Implementación remota de Hub](/es/guides/remote-hub/)
- [Espacio de trabajo remoto](/es/guides/remote-workspace/)

<a id="relay-authentication-compatibility"></a>

### Compatibilidad con autenticación de relés

Actualice tanto el Home como el Child cuando actualice a la autenticación de retransmisión vinculada a la conexión. Antes de enviar una credencial o cuerpo de enlace de una solicitud retransmitida, el Child verifica el Home en la misma conexión que utilizará para esa solicitud. Una conexión cerrada no se reemplaza silenciosamente. Un Home sin este protocolo causa un error de autenticación reintentable; actualizar el Home y Child, y volver a vincular cuando el enlace almacenado ya no se reconoce. No hay un interruptor de reserva inseguro. Una rotación pendiente pendiente de API sigue siendo válida hasta que expire o la rotación se confirme o se aborte.

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

El comando `ocx gui pair --origin <local-origin>` existente funciona mientras que OpenCodex se ejecuta como un servicio en segundo plano. Ejecutarlo bajo la cuenta que posee la casa privada OpenCodex del servicio, a continuación, introduzca el código de un solo uso devuelto en el panel de control local. No se requiere ningún terminal de servidor, contraseña adicional, Windows Hello o clave de hardware. El CLI y el servidor deben usar la misma versión actual y configuración doméstica; reinicie un servidor anterior después de la actualización. Las invitaciones a Hub de versión mixta también requieren actualizar el CLI y el servidor juntos. El emparejamiento rechaza un directorio de inicio o intent de configuración sincronizada; use el directorio protegido real como `OPENCODEX_HOME`.

Internamente, la CLI crea un compromiso de autorización de corta duración e intenta eliminarlo tras su uso o un fallo. Leer información del entorno de ejecución por sí solo no autoriza el emparejamiento, y el verificador no se guarda en disco. Es un límite basado en el acceso de escritura al directorio privado, no una autenticación biométrica ni una prueba de presencia humana: se sigue confiando en un programa con acceso completo a los archivos de ese usuario. La autorización de invitaciones de Hub existente no cambia. Si falla una solicitud de emparejamiento, ejecuta un comando nuevo después de resolver el problema indicado. SSH Remote Link en Windows usa la vía de ejecución independiente mediante PowerShell descrita arriba.

Si un proceso se interrumpe durante el emparejamiento, vuelva a ejecutar el comando para obtener una nueva autorización. No elimine manualmente el estado de emparejamiento mientras se ejecuta el servicio o un comando de emparejamiento.

En Windows, el emparejamiento se rechaza si la carpeta de intención o el registro no es privado de la cuenta de servicio, o si su propietario y los permisos no se pueden verificar. Ambas entradas deben ser propiedad de esa cuenta; La propiedad de los administradores solo se acepta cuando los administradores son el propietario predeterminado del token de servicio y su función de administrador está habilitada. La lista de permisos debe estar protegida de la herencia y contener una entrada de permiso de control total ordinaria para la cuenta servidora. Además de eso, solo se aceptan entradas de permiso simple para SYSTEM y el grupo Administradores, porque SYSTEM y un administrador elevado ya pueden tomar posesión de cualquier archivo; un administrador no elevado no gana nada de esa entrada. Solo en la carpeta se permite la herencia hacia los elementos descendientes. Esta es la lista como Windows lo informa: las entradas duplicadas compatibles para el mismo recuento de cuentas que uno, y las entradas que no conceden nada se ignoran. El cheque deja registros rechazados en su lugar y no repara sus permisos ni cambia la propiedad. Restaurar una casa de configuración privada y, a continuación, ejecutar un nuevo comando de emparejamiento.

La comprobación cubre la carpeta de intención y el registro. No protege contra el reemplazo de carpetas anteriores, derechos de eliminación en una carpeta principal, operaciones de restauración con privilegios o acceso a través de identificadores abiertos antes de que los permisos se vuelvan privados. Una solicitud con un compromiso coincidente puede bloquear el servidor durante un subproceso de verificación limitado a cinco segundos, incluso si su carpeta falla más tarde en la verificación de permiso. La configuración de inicio de proceso y búsqueda ejecutable precede a ese tiempo de espera. CLI limpieza puede realizar una verificación más. El presupuesto de subproceso de cinco segundos deja espacio dentro del tiempo de espera de solicitud de diez segundos del comando, pero la verificación lenta aún puede rechazar el emparejamiento.

<a id="add-a-child-from-the-terminal"></a>

## Agregar un Child desde el terminal

En el Home, ejecute `ocx link probe child-a --json` para inspeccionar la huella digital SSH ofrecida, el tipo de clave y la versión OpenCodex. Verifique la huella digital a través de una fuente confiable. A continuación, ejecute `ocx link add child-a --expect-fingerprint SHA256:… --json`. El comando sondea de nuevo y rechaza un desajuste antes de almacenar la confianza o emitir una clave. Sin el indicador de huella dactilar, requiere un terminal interactivo y un `yes` explícito después de mostrar la huella dactilar. Nunca imprime la clave de enlace.

Las conexiones iniciadas desde Home reinician el Child después de guardar su conexión, incluidas las instalaciones antiguas del Child que tengan la capacidad necesaria. El Child debe estar sirviendo OpenCodex independiente en su puerto configurado y ofrecer soporte de reinicio vinculado. Los Children POSIX necesitan curl; Windows usa una solicitud HTTP de loopback con tiempo limitado mediante .NET. Actualiza o desconecta un Child que no supere esta comprobación previa. Las instalaciones de escritorio y de sistema de OpenCodex tienen prioridad sobre los shims genéricos de PATH; los candidatos que no funcionan se omiten. Los Children Windows x64 usan comandos PowerShell codificados sin consumir la entrada estándar que transporta la clave.

<a id="windows-computers"></a>

### Equipos Windows

Un Child Windows x64 necesita OpenSSH Server, Windows PowerShell y el binario independiente `ocx.exe`. Home reconoce Windows durante el sondeo, lo registra con el enlace y ejecuta todos los comandos del Child mediante PowerShell sobre la misma conexión SSH con identidad fijada, tanto si el shell predeterminado de SSH es cmd como si es PowerShell. La clave del enlace sigue viajando solo por la entrada estándar. Cerrar la conexión SSH termina el comando remoto `ocx`. Si Windows PowerShell en el Child no puede cargar el asistente que vincula `ocx.exe` a la conexión, por ejemplo bajo Constrained Language Mode, el comando se rechaza y no se ejecuta nada. Si Home no puede determinar la plataforma del Child, se detiene antes de emitir una clave de enlace.

Ejecuta `ocx link cleanup` en Home para inspeccionar las plataformas registradas de los Children sin modificarlas. Las versiones actuales de Home desconectan los Children Windows mediante PowerShell. Si falla una desconexión remota, resuelve el error de shell o instalación indicado y reintenta; **Eliminar aquí solamente** sigue siendo una acción explícita de recuperación que puede dejar al Child pendiente de una desconexión local.

Reiniciar espera los giros y puede tardar varios minutos. El éxito requiere que el Child reiniciado cumpla con el rol de cliente y transmita un nuevo catálogo completo a este Home. La configuración de SSH tiene una asignación limitada derivada de la latencia medida; la verificación del relé comienza después del reinicio con su propia ventana de 15 segundos. Los errores nombran la fase fallida. Si un error informa la configuración residual Child, ejecute `ocx disconnect` y `ocx restart` en ese Child antes de volver a intentarlo. Home limpieza por sí sola no restaura Child configuración. Un tiempo de espera CLI reporta un resultado incierto; inspeccione Home `ocx link status` y Child `ocx connect status` primero.

En un Child Home -iniciado, `ocx link status` informa el rol `child`, la identidad del enlace y el puerto del túnel de su conexión guardada, aunque su almacén de enlaces Home está vacío. El estado del túnel no observado localmente es `idle`. `ocx status` llama al par un enlace remoto Home. Cuando Home se ejecuta en el modo Hub, el estado lee su proyección soportada a través del relé local Child. Un Home independiente informa que no publica el estado de Hub. Child -la identidad del túnel iniciada proviene de su vagón lateral válido; la evidencia ilegible no reclama una dirección.
