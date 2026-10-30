---
title: "Ciclo de vida de la CLI"
description: "Comandos de instalación, inicio, parada, servicio, diagnóstico, sincronización y actualización."
---

Estos comandos instalan, ejecutan, inspeccionan, reparan y actualizan el proxy local opencodex y su integración Codex.

<a id="discover-before-starting-services"></a>

## Descubre antes de comenzar los servicios

`ocx help`, `ocx help <family>` y `ocx help <family> <leaf>` están fuera de línea. Utilice `ocx help --all` cuando la raíz compacta es insuficiente. La ayuda, la validación de configuración local y la inspección local de laboratorio no requieren iniciar un proxy.

Antes de un flujo de trabajo de administración en vivo, ejecute `ocx ready --json` y `ocx status --json`. La preparación distingue `pending`, `failed` y `unreachable`; solo `ready: true` confirma la preparación. Compruebe el objetivo y `versionSkew.relation`: `unknown` no es prueba de versiones coincidentes. Un desajuste de versión requiere resolver la instalación prevista, no intentar repetidamente una bandera más nueva contra un servidor más antiguo.

Las convenciones de salida y salida son específicas de los comandos. `ready` y `resolve` rechazan argumentos inválidos con 64, mientras que `doctor --json` no está soportado y sale de 2. Una solicitud de guardado local o de reinicio aceptado satisfactoriamente no prueba convergencia; lea el recibo del comando y vuelva a verificar el estado después de la operación solicitada.

Cuando el descubrimiento de destino en vivo no encuentra proxy, comandos de directiva/catálogo, uso de alcance de clave e informe de sincronización de perfil de Aside: "Proxy no se está ejecutando. Inicie el proxy deseado con: ocx start. No se envió ninguna solicitud." Una solicitud de administración que se envió puede tener un resultado de escritura incierto; leer de nuevo desde el objetivo previsto antes de volver a intentar. Los rechazos de integración de cliente heredados agregan una guía de recuperación fija basada en la razón del rechazo (nunca el propio texto del escritor); los avisos de respaldo y recuperación residual permanecen disponibles.

`ocx system update run --yes` imprime el ID de trabajo aceptado y el estado del trabajo observado. Síguelo con `ocx system update status <job-id>`; la aceptación no establece una instalación o reinicio exitosos. `--json` conserva la respuesta completa del servidor.

<a id="setup"></a>

## Configuración

### `ocx init` · `ocx setup`

Asistente de configuración interactiva (`setup` es un alias de `init`). Indica un proveedor (preestablecido o personalizado), una clave API (literal o `${ENV}`), un modelo predeterminado y un puerto proxy; guarda `~/.opencodex/config.json`; opcionalmente inyecta el proxy en `$CODEX_HOME/config.toml` (predeterminado `~/.codex/config.toml`); y opcionalmente instala la shim de inicio automático Codex.

<a id="proxy-lifecycle"></a>

## Ciclo de vida del proxy

### `ocx start [--port <port>] [--socks5 [host:port] | --socks5-off]`

Inicie el servidor proxy (puerto preferido `10100`). Escribe el estado PID / runtime-port y se niega a iniciar una segunda instancia en vivo. Cuando el puerto preferido está ocupado, `start` pregunta al titular quién es y se detiene en cualquier sentido: se niega rotundamente cuando un opencodex responde allí, e informa a un titular no identificado de lo contrario. Nunca mueve al oyente a otro puerto por sí mismo, porque eso dejaría el primer proxy en funcionamiento y volvería a apuntar al Codex en el segundo. Todavía se rechaza un `--port` explícito diferente cuando el proxy en vivo comparte este `OPENCODEX_HOME`, porque tanto la contabilidad de gastos solo observada como forzada escriben el mismo diario. Use un `OPENCODEX_HOME` separado para un hermano independiente; `port: 0` solo pide al sistema operativo el puerto de esa instancia y no separa su estado. Al inicio, sincroniza los modelos de cada proveedor en el catálogo de Codex. Al apagarlo, restaura el Codex nativo, a menos que se haya lanzado como un servicio administrado (`OCX_SERVICE=1`). Un hermano iniciado junto a un proxy en ejecución no hace ninguna de las dos cosas: sirve solicitudes directas solo en su propio puerto, y Codex, Grok y Claude permanecen apuntando al proxy que ya se estaba ejecutando. Con un `OPENCODEX_HOME` separado, el inicio comprueba el registro de entorno de ejecución del hogar predeterminado y administra Grok y Codex destinos de bucle de retorno para un propietario de opencodex en vivo antes de la sincronización. Una casa personalizada sin propietario en vivo todavía se sincroniza normalmente; `ocx sync` y `ocx grok apply` explícitos permanecen disponibles. Detener a ese hermano con `ocx stop` o una señal también deja su configuración sola. Mientras se ejecuta, el proxy también mantiene Codex apuntado a sí mismo: cuando el enrutamiento opencodex en `~/.codex/config.toml` nombra otro puerto local donde no opencodex ha respondido durante aproximadamente 20 segundos (una instancia que lo volvió a apuntar y luego murió, por ejemplo), el proxy vuelve a apuntar Codex en su propio puerto e imprime una advertencia. Codex hilos abiertos mientras tanto, mantenga la dirección muerta hasta que los vuelva a abrir.

`--socks5` (por defecto `127.0.0.1:10808`) guarda `config.proxy` como una URL de SOCKS5 y las rutas de salida HTTP (S) a través de un túnel real SOCKS5. `--socks5-off` borra solo ese proxy SOCKS5 guardado; no elimina un proxy HTTP. El valor sobrevive `ocx update` porque vive en config, no en el paquete instalado. Se puede incluir un nombre de usuario y una contraseña proxy en la URL, pero los registros de inicio los redactan.

```bash
ocx start
ocx start --port 8080
ocx start --port 10100 --socks5
ocx start --socks5-off
```

### `ocx stop [--json]`

Detiene el proxy en ejecución por su PID, elimina el archivo PID y restaura Codex nativo cuando el entorno es independiente. Si hay un servicio administrado, `ocx stop` lo detiene primero para impedir que vuelva a iniciar el proxy.

En un cliente conectado a un Hub, la parada conserva el enrutamiento de Codex, su catálogo y la
configuración de Grok, incluso si se detiene correctamente mediante la API. Esos ajustes pertenecen
a la conexión; `ocx start` vuelve a servirlos sin reinyección. Usa `ocx disconnect` para devolver Codex
a su propia cuenta. Si un cliente conectado ya muestra enrutamiento nativo, `ocx status` indica
`ocx sync --restart-codex` para recuperarlo.

Una parada explícita en un Child de Remote Link restaura el enrutamiento y el catálogo nativos de
Codex y los metadatos respaldados del historial de reanudación, y elimina la configuración administrada
de Grok cuando la restauración compartida termina correctamente. La conexión guardada con Home
se conserva; `ocx disconnect` la elimina. Para volver a usar Home desde Codex, inicia el Child con
`ocx start` (o `ocx service start` si hay un servicio instalado) y después ejecuta
`ocx sync --restart-codex`. Iniciar por sí solo no vuelve a aplicar el enrutamiento;
sync no recrea el bloque de Grok. Si no se puede confirmar la titularidad de la conexión antes de
detener el servicio, la API de parada devuelve HTTP 409 con `sharedTeardown: "refused"` y mantiene
en ejecución el proxy y el gestor del servicio. Deja que termine cualquier conexión o desconexión
pendiente y vuelve a intentarlo.

Antes de modificar el servicio, la parada de un cliente conectado verifica el listener frente al
registro local protegido del entorno de ejecución. Tanto los listeners de rol cliente como los proxies
ordinarios deben demostrar esa identidad; un proxy ordinario debe además declarar, mediante una
lectura autenticada, que conserva los ajustes al detenerse mediante API, señal y servicio.
Los entornos antiguos o no verificados se rechazan antes de actuar. Actualiza o reinicia ese entorno
mediante su supervisor y reinténtalo. Usa `ocx disconnect` solo si quieres liberar las integraciones
de la conexión. Si el cliente ya está detenido, otra parada verifica que el gestor del servicio esté
inactivo y que no haya listeners en los endpoints locales conocidos antes de devolver el resultado
habitual de proceso ausente.

Mientras OpenCodex Desktop esté abierto, `ocx stop` no mantiene detenido el proxy: la aplicación lo trata como una salida inesperada y lo inicia de nuevo, en segundos si lo había iniciado ella o en aproximadamente un minuto si solo se había conectado a él. Usa **Stop proxy** en su bandeja, para un proxy iniciado por la aplicación, o **Quit** para mantenerlo detenido. Por esa misma razón, el botón **Stop** del dashboard rechaza la acción con `desktop_supervised` sin cambios cuando el proxy pertenece a la aplicación. En otros entornos, ejecuta `POST /api/stop`, salvo con el Programador de tareas de Windows: allí un contenedor puede reiniciar el proxy después de terminar la tarea. El dashboard responde `respawnable_service`, no cambia nada y pide ejecutar `ocx stop` desde fuera del proxy para verificar que no reaparezca antes de restaurar los ajustes del cliente.

El panel de control también se niega cuando el proxy está ejecutando *como* el servicio launchd o systemd instalado. Detener ese administrador desde el interior del proxy terminaría el proceso antes de que se restaure el Codex nativo, dejando la configuración del cliente apuntando a un proxy que se ha ido, por lo que el panel de control devuelve `self_unload_service`, no cambia nada y le pide que ejecute `ocx stop`, lo que detiene el servicio desde el exterior y completa la restauración.

Una salida proxy sola no confirma que la restauración compartida Codex / Grok tuvo éxito. Si la respuesta de parada informa de un fallo, es ilegible o no confirma el modo de desmontaje asignado, el CLI mantiene la restauración con el padre de parada después de las comprobaciones de propiedad y reaparición existentes. No entra en el repliegue forzado para un proceso que ya se ha observado que ha salido. Un aplazamiento respaldado por recibos aún deja la restauración final y la limpieza de recibos con el padre; el fracaso en restaurar la configuración del cliente compartido mantiene la parada fallida y su recibo pendiente.

`ocx stop --json` ejecuta la misma parada y escribe un resumen versionado (`schema: "ocx-stop/1"`) en stdout; los mensajes de progreso van a stderr. El resumen indica el resultado (`stopped`, `not-running`, `history-incomplete`, `history-deferred` o `failed`), la clasificación del servicio y del proxy, si el entorno de ejecución está detenido y un mensaje estable de una línea. Los códigos son iguales con y sin `--json`: 0 si termina correctamente, 1 si falla, 79 si solo quedó incompleta la limpieza del historial de Codex y 80 si el desmontaje compartido se aplazó y sigue pendiente. El código 81 indica que una actualización del dashboard con reinicio transfirió el enrutamiento y catálogo de Codex al futuro proxy en vez de restaurar Codex nativo. Con 81 el proxy está detenido; el reiniciado libera el desmontaje conservado después de su primera sincronización. Si no llega a iniciarse, el siguiente `ocx stop` restaura Codex nativo.

Para una adquisición aprobada por el escritorio, `ocx stop --json` también acepta el conjunto completo de `--expect-*` valores suministrados por `ocx resolve --json`. En Windows, esta parada vigilada puede detener una tarea del Programador de tareas solo cuando su definición registrada, el estado de ejecución y el antepasado de la envoltura demuestren que posee el proxy aprobado. Un servicio WinSW debe probar su ruta binaria instalada y la ascendencia PID del servicio. Después de detener cualquiera de los administradores, el CLI señala el proxy aprobado por separado y verifica que la tarea ya no se esté ejecutando, que no sobreviva ningún envoltorio y que se detenga WinSW. Un proceso `wscript.exe`, `cscript.exe` o `cmd.exe` con una línea de comandos ilegible en la cadena de supervisión del proxy aprobado (o sobrevivir bajo el administrador detenido) deja desconocida la propiedad del envoltorio, por lo que el stop vigilado no puede informar el éxito. La evidencia faltante o ilegible bloquea la parada vigilada.

### `ocx restart`

Cuando este CLI es más nuevo que un proxy POSIX independiente certificado, el reinicio puede detener la instalación anterior y ejecutar esta. Esta actualización vigilada requiere un hogar físico no reclamado, un proxy separado cuyo padre es PID 1, supervisión de servicio positivamente inactiva y una versión conocida CLI. Un registro de servicio launchd instalado pero descargado o systemd inactivo solo es elegible cuando no conlleva ningún reclamo de propiedad. Ambos dominios launchd deben estar ausentes; systemd debe informar inactivo con MainPID cero. La evidencia de un gerente ilegible o incierto se niega. El comando congela todos los registros de servicio y la definición de la plataforma y los verifica a través de stop, lanzamiento y publicación secundaria. Cualquier reescritura, reemplazo, cambio de permiso o creación / eliminación de registros se niega; reintente después de inspeccionar `ocx status`. El stop usa la misma conexión que probó la identidad del viejo proxy. El comando se inicia una sola vez después del apagado confirmado, luego requiere el PID hijo exacto, el punto final, la prueba de identidad nueva y la versión coincidente. La versión que falta, la parada incierta, el tiempo de espera o un reemplazo inesperado informa de un fallo sin otra parada o inicio. Si el entorno de ejecución este CLI se lanzaría sigue siendo el pequeño marcador de posición, una instalación npm en el lugar deja antes de su postinstalación, el reinicio se niega antes de detener cualquier cosa; después de una parada confirmada, espera el entorno de ejecución dentro de la misma fecha límite y no lanza nada si no llega. Windows, en primer plano, supervisado por el escritorio, servicio activo, cliente conectado y tiempos de ejecución hermanos no utilizan esta ruta de actualización; utilizar sus controles de ciclo de vida de posesión. Un proxy más nuevo o una versión incomparable aún rechaza una degradación in situ. Utilice el `ocx` de la instalación más reciente para reiniciar; inspeccione `which -a ocx` y `ocx status` para identificarlo. Los rechazos de elegibilidad nombran la razón y la siguiente acción: use el `ocx service restart` de la instalación propietaria para un servicio, el terminal propietario para un proxy en primer plano o la aplicación de servicio / escritorio propietario en Windows. La ascendencia desconocida o un objetivo cambiado requiere `ocx status` antes de cualquier reinicio.

En un entorno cliente conectado (Remote Link Child o cliente Hub), `ocx restart` pide al propio entorno iniciar su reemplazo en el mismo puerto. Si el reemplazo no responde dentro del plazo, se detiene y el entorno anterior vuelve a ocupar el puerto y sigue atendiendo; el comando informa que el reinicio no se completó. Un entorno cliente administrado por un servicio o la aplicación Desktop rechaza la solicitud y sigue funcionando ("Restart not performed; the running client runtime was kept"); reinícialo con `ocx service restart` o desde la aplicación. Consulta [Paridad de aplicación de Remote Link](#remote-link-apply-parity).

Si los archivos de paquete o el entorno de ejecución del Bun permanecen incompletos después de que el instalador haya salido o haya fallado, ejecute `ocx status`, detenga cualquier proxy que se ejecute a través de su propietario (`ocx stop`, o su servicio o aplicación de escritorio), luego vuelva a instalar con el mismo administrador de paquetes y vuelva a iniciarlo. Véase [Fallo de actualización](/es/troubleshooting/update-failed).

Cuando un proxy se está ejecutando, pida que PID y puerto certificados exactos se reinicien en su lugar, espere a que su normal, y verificar un entorno de ejecución diferente PID en el mismo puerto. Enrutamiento y servicio gestionados La supervisión permanece instalada en todas partes; una petición incierta se observa más bien que se repite como un problema. Parada/Inicio por separado. Si no se está ejecutando ningún proxy, el comando vuelve a la posición normal. `ensure` Inicio. Si un reinicio aceptado pierde su reemplazo, el comando intenta un inicio de recuperación limitado incluso cuando el inicio automático Codex está deshabilitado, e informa de un error si no se inicia ningún proxy. Cuando el proxy inicia su propio reemplazo (ningún servicio en segundo plano lo supervisa) después del drenaje terminado normalmente, un reemplazo que sale antes de que responda se inicia de nuevo hasta dos veces. ¿Qué Las impresiones de reemplazo van a `~/.opencodex/restart-handoff.log`, que se mantiene cerca de 256 KiB: a El reinicio lo vacía una vez que alcanza ese tamaño, y el reemplazo en ejecución lo verifica una vez por minuto. Un proxy que la aplicación de escritorio OpenCodex inició no inicia su propio reemplazo: sale y la aplicación inicia el nuevo proxy en el mismo puerto. Si no se puede certificar un oyente en vivo a un PID en entorno de ejecución (incluido un proxy de actualización previa), se produce un error de reinicio Cerrado sin un `ensure` o detener/iniciar el retroceso. Después de confirmar la propiedad, el uso `ocx stop` entonces
`ocx start` para un proxy independiente. Para un proxy administrado por servicio, use `ocx stop` seguido por
`ocx service start` Se restablece la supervisión. Una invocación vuelve a observar las razas de descubrimiento transitorias. Un inicio fallido se vuelve a intentar solo cuando el intento anterior nunca lanzó un niño o se sabe que el niño lanzado ha salido. Si un inicio aún puede estar en ejecución, reinicie los informes del error original sin iniciar un segundo proxy, incluso cuando una investigación de salud no encuentra nada. Cuando un reinicio aceptado nunca publica un reemplazo, el comando vuelve a observar una vez antes de renunciar a — un proxy que se estrelló a mitad de reinicio lee ausente y se inicia fresco, mientras que un reemplazo que aterrizó justo después de la espera de reemplazo acortada todavía demuestra el éxito dentro del plazo general de observación. Fuera de la ruta de actualización CLI más reciente, un destino en vivo es nunca se detuvo para hacer espacio, por lo que un proceso de escucha rancio no puede ser reemplazado por un segundo Para el puerto. Cada intento fallido de inicio es seguido por un ritmo y una fuerte re-observación antes de la siguiente intento: un niño que acaba de ser lanzado puede seguir siendo vinculante, y los pasos posteriores a la salud puede haber lanzado en un proxy que ya sirve. Una lectura en vivo significa no se genera un segundo comienzo: un rechazo limpio luego da fe del éxito, mientras que un tiro se propaga como un fallo de inicio porque el trabajo posterior a la salud falló en un proceso de servicio. Durante la recuperación de un accidente después de un reinicio en vivo aceptado, el éxito requiere una entorno de ejecución PID en el puerto original: si el PID original se vuelve a leer en vivo, el reinicio falla como un reemplazo perdido en lugar de informar el éxito. Pruebas de ausencia y lanzamiento-salida confirmadas juntas permiten otro intento de inicio. Mientras que el PID anterior todavía está activo, o una sonda es incierta, la La ventana de confirmación mantiene la votación para un reemplazo dentro de la reserva en lugar de Fracasó de inmediato. Un segundo proxy nunca se genera junto a uno vivo. La espera de reemplazo termina lo suficientemente temprano como para que la ventana de confirmación aún se ajuste dentro del plazo de observación general.

La recuperación del puerto después de la parada o actualización respeta una comprobación de proceso OCX fallido incluso cuando el PID se registró antes del apagado. Un soporte en vivo rechazado se deja en funcionamiento y evita la limpieza de la fila TCP. Si no se verifica, la espera de recuperación limitada puede caducar con el puerto todavía ocupado. Compruebe el titular del puerto actual y vuelva a intentar el reinicio después de que se resuelva el conflicto.

### `ocx ensure`

Asegúrese de que se está ejecutando un proxy en segundo plano y, a continuación, sincronice su catálogo de modelos en vivo. Si `codexAutoStart` es `false`, se imprime que el inicio automático está deshabilitado y no hace nada.

Con una configuración de cliente conectado validada, `ensure` tiene éxito sin iniciar un proxy de proveedor local después de conciliar el diario del cliente. Esto no prueba ni certifica la disponibilidad del concentrador remoto. El estado del cliente no válido o no coincidente sigue fallando.

### `ocx restore [back]` · `ocx eject [back]`

Restaurar nativo Codex **sin** detener el proxy - tiras de las líneas de configuración inyectadas y entradas de catálogo enrutado para llanura `codex` funciona de forma nativa de nuevo. `eject` es un alias de `restore`.

La salida del catálogo restaurado excluye los modelos nativos retirados, incluidos los `gpt-5.3-codex-spark`, ya sean almacenados como ID desnudos o filas calificadas para cuentas de confianza. Esto se aplica con o sin una copia de seguridad del catálogo; se conservan la copia de seguridad original y la configuración histórica seleccionada por el usuario.

La restauración informa de un fallo en lugar de reemplazar los archivos de configuración modificados cuando un diario guardado carece de los hashes de inyección correspondientes. Los archivos actuales y el diario permanecen disponibles para su revisión; ver [recuperación sin hashes de inyección](/es/guides/codex-integration/#recovery-without-injection-hashes).

Pase `back` para volver a señalar el plano `codex` en un proxy que ya se esté ejecutando sin cambiar el ciclo de vida del proxy:

```bash
ocx restore back
ocx eject back
```

### `ocx recover-history --legacy-openai --yes`

Recuperación explícita para versiones de desarrollo anteriores que volvieron a mapear el historial de la aplicación Codex antes de que existiera el soporte de copia de seguridad reversible. Cierre primero Codex si su base de datos de historial está bloqueada.

Este es un reetiquetado amplio y destructivo: cada hilo de mensaje de usuario etiquetado actualmente `opencodex` se cambia a `openai`, `exec` se normaliza a `cli` y se establece el marcador de evento. Eso incluye la historia legítima de proveedores dedicados. Realice una copia de seguridad del estado y ejecútelo solo cuando se pretenda ese alcance completo.

### `ocx recover-history --ocx-compaction <thread-id> --yes`

Repare un hilo que se compactó a través de un proveedor enrutado antes de reanudarlo a través del Codex nativo. El comando lee el subproceso exacto seleccionado por UUID, guarda una copia de seguridad privada de byte por byte y, a continuación, convierte solo el estado de compactación `ocx1:` / `ocx2:` propiedad de OpenCodeX en un resumen sencillo que el Codex nativo puede reproducir. El contenido cifrado nativo y otros hilos se dejan sin cambios. Cierre el subproceso seleccionado antes de ejecutar el comando; un cambio de implementación concurrente hace que la recuperación se detenga sin reemplazar el archivo.

### `ocx uninstall` · `ocx remove`

Detenga el servicio y el proxy, elimine el servicio y la compensación Codex, restaure el Codex nativo y, a continuación, elimine la configuración local opencodex solo si todos los pasos de restauración tuvieron éxito. `remove` es un alias de `uninstall`. La limpieza de configuración requiere metadatos de propiedad creados por una instalación nueva; los directorios heredados o compartidos se dejan en su lugar.

Ambos comandos no aceptan argumentos. Las banderas no soportadas (incluyendo `--dry-run` y `--yes`) salen con el estado de uso 2 antes del prevuelo o desmontaje; no se realizan cambios. Para obtener ayuda, ejecute `ocx help uninstall` o `ocx help remove`.

<a id="status-and-health"></a>

## Situación y salud

### `ocx status [--json]`

Estado y `ocx doctor` comparan esta versión CLI 's con el proxy en ejecución. Si el CLI es más nuevo, reinicie el proxy utilizando la instalación actual prevista; para un servicio en segundo plano, ejecute `ocx service restart`. En macOS, un sesgo de versión deja la definición de servicio byte-idéntica, por lo que `ocx service repair` no recargaría nada y mantendría el antiguo proceso en servicio. Si el proxy es más nuevo, actualice el CLI o resuelva `PATH` a la instalación prevista. Estos diagnósticos no reparan el servicio ni cambian si se permiten solicitudes.

Las cadenas de versión idénticas y los marcadores de posición `unknown` / `0.0.0` suprimen la advertencia, al igual que una versión proxy ausente. El doctor no reporta marcadores de posición como un partido confirmado. Las diferentes cadenas aún producen una advertencia neutral cuando no pueden analizarse estrictamente como SemVer o difieren solo en los metadatos de compilación; ninguno de los lados se llama más antiguo. Las versiones no se recortan y no se normaliza un `v` principal. JSON expone el mismo consejo en `versionSkew`, cuyos campos permanecen `cliVersion`, `proxyVersion`, `skewed` y `warning`.

En un Remote Link Child y su Home, `--json` también informa `appliedCodexSettingsDigest`, `lastApplyAt` y `runtimeStartedAt`; consulta [Paridad de aplicación de Remote Link](#remote-link-apply-parity).

Imprima un resumen de diagnóstico de solo lectura: PID proxy, accesibilidad `/healthz`, URL del panel de control, ruta de configuración, proveedor predeterminado, configuración de inicio automático Codex, estado del servicio, estado de compensación y la casa Codex efectiva redactada. Solo la firma de inicio de ejecución Windows explícita y de alta confianza de Orca agrega una advertencia procesable de desajuste de App-home; nunca cambia `CODEX_HOME` automáticamente. También advierte cuando el Codex enrutamiento opencodex escribió nombres de un puerto local que el proxy en ejecución no sirve. `ocx sync` lo repara inmediatamente, y un proxy de propietario en ejecución también puede volver a apuntarlo por su cuenta una vez que nada responde en ese puerto. El estado de un hermano no lo informa, porque su enrutamiento nombra el proxy al lado del cual se ejecuta.

Cuando un proxy en vivo ya ha pasado la verificación de identidad / vitalidad, `ocx status` prefiere el informe de salud de inicio certificado de ese proceso para reiniciar la seguridad y la viabilidad del servicio. Esto evita falsos negativos de una prueba de administrador de servicio local de shell que carece del entorno de administrador del servicio en ejecución. El informe en vivo se valida por esquema; si no está disponible o está mal formado, el estado vuelve al servicio local y a los diagnósticos de shim. `ocx doctor` utiliza la misma regla de live-first para su sección **Seguridad de reinicio Codex**, por lo que los dos comandos deben acordar la protección de reinicio. Si está diagnosticando una discrepancia, compare el veredicto de inicio en vivo reportado con los detalles del servicio local en lugar de tratar la sonda de shell como más autorizada.

La lectura en vivo permite que la sonda de servicio limitada termine: hasta 6,5 segundos en macOS / Linux y 16,5 segundos en Windows cuando la caché de diagnóstico está fría o caducada. Cached lee el regreso rápidamente. Un tiempo de espera todavía vuelve a los diagnósticos locales; un `/healthz` saludable solo no establece protección de reinicio.

El diagnóstico `clients=pending-restart(...)` enumera Codex CLI clientes que son anteriores a la inyección de enrutamiento. En macOS, los renderizadores de electrones, la utilidad y los ayudantes de crashpad bajo el marco Codex.app están excluidos de esa lista de clientes, incluidos los ayudantes cuyas rutas ejecutables contienen espacios.

La salida humana también incluye un bloque **OAuth salud** después del resumen de inicios de sesión OAuth: `OAuth health:
ok` cuando cada cuenta conocida está sana, o `OAuth health: warning` con una línea redactada por cuenta no saludable (proveedor, ID de cuenta enmascarada, estado tal como reautenticación requerida, tasa o cuota limitada o conflicto de actualización) más una sugerencia opcional `Action:`. Los identificadores de la cuenta se redactan; los tokens y los correos electrónicos nunca se imprimen. El contrato `--json` no incluye actualmente este bloque de salud.

```bash
ocx status
ocx status --json
```

Forma de ejemplo abreviada:

```json
{
  "schemaVersion": 1,
  "proxy": {
    "running": false,
    "pid": null,
    "health": {
      "ok": false,
      "url": "http://127.0.0.1:10100/healthz",
      "message": "unreachable"
    }
  },
  "dashboard": {
    "url": "http://localhost:10100/"
  },
  "paths": {
    "config": "/Users/example/.opencodex/config.json",
    "pid": "/Users/example/.opencodex/ocx.pid",
    "runtime": "/path/to/bun"
  },
  "runtime": {
    "source": "bundled"
  },
  "codexHome": {
    "effectiveCodexHome": "C:\\Users\\[USER]\\.codex",
    "appCodexHome": "C:\\Users\\[USER]\\.codex",
    "mismatch": false,
    "warning": null,
    "action": null
  },
  "codexAutostart": true,
  "defaultProvider": "openai",
  "service": {
    "summary": "not installed (logs: /Users/example/.opencodex/service.log)"
  },
  "codexShim": {
    "summary": "Codex autostart shim: not installed"
  }
}
```

El objeto real también incluye `listen` (puerto, nombre de host, entorno de ejecución/fuente de configuración), carga de configuración diagnósticos y diagnósticos de complementos Codex incluidos. El esquema JSON es solo aditivo: versiones futuras puede agregar campos, pero los campos existentes deben permanecer estables. Excluye intencionadamente las claves API, OAuth tokens, encabezados de autorización, contenido de solicitud, correos electrónicos e identidades de cuenta.

### `ocx health [--json]`

Verifique la identidad del proxy en vivo. Informes de producción humana PID/puerto; `--json` emite `{ok, pid, port}`. El comando sale 0 solo cuando está sano y 1 de lo contrario, lo que lo hace adecuado para sondas de servicio.

### `ocx system health [--json]`

```bash
ocx health --json
ocx system health --json
```

La salud de la raíz es la sonda de vitalidad. La salud del sistema es una observación de gestión separada: `{status:"ok",service:"opencodex",version,uptime,pid,spendLedger}`, con tiempo de actividad en segundos. `system status` sigue siendo su configuración / inicio / memoria agregada. Una observación válida de la salud del sistema sale 0 incluso si el libro mayor de gastos se degrada. La propiedad de lectura mantenida / no mantenida, inicializada, configurada, degradada, persistFailures y corruptRecords; el estado ok no certifica que todos los subsistemas estén sanos. Las lecturas fallidas/malformadas permanecen distintas de cero con datos sanos seguros, no fabricados.

Para diagnósticos limitados, [solicitud/inyección seguir](/es/reference/cli/agents/#follow-request-windows-or-injection-sequences) se detiene en caso de error o cambio de objetivo detectado en lugar de volver a conectarse automáticamente. SIGINT sale por 130 y SIGTERM 143. Los eventos de registro con versiones reconstruyen las ventanas observadas, no el tráfico perdido entre sondeos; la secuencia de inyección no puede excluir las brechas de reinicio / desalojo.

### `ocx ready [--json] [--wait [--timeout <seconds>]]`

Comprueba si el proxy está listo después de la sincronización mediante el endpoint no autenticado `GET /readyz`. Devuelve `200` cuando está listo, o `503` con `Retry-After: 1` para `pending` y el estado terminal `failed`. Su identidad HTTP depurada es `{service, version, uptime, pid, port, status}`, junto con los campos del protocolo del hub remoto `{protocol, minimumClientProtocol, managementUrl, features}`. `protocol` identifica el protocolo del hub y `minimumClientProtocol` el cliente más antiguo aceptado, para rechazar un emparejamiento incompatible antes de enviar otros datos. `managementUrl` indica el origen del plano de administración: `hub.managementPublicOrigin` cuando `runtimeRole` es `hub`; en los demás casos, el origen por el que llegó la solicitud. Se rechazan las solicitudes sin un origen HTTP(S) en lugar de adivinar uno.

`features` enumera las capacidades que ofrece esta compilación para que otro nodo pueda comprobarlas sin comparar versiones: `relay-auth/<n>` identifica la versión de autenticación del relé Remote Link; `link-management-relay`, su relé de administración de solo lectura; `link-peer-report/<n>`, el informe de versión y compatibilidad de cada Child que el Home muestra en `ocx link status`; `quota-pool/1`, la consulta de administración `GET /api/quota-pool`; y `served-by-header`, el encabezado de respuesta `x-opencodex-served-by`. Las capacidades no disponibles se omiten. La lista contiene únicamente nombres fijos, nunca datos de cuentas o configuración.

Los proxies antiguos sin `/readyz` se consideran `unreachable` y no se aceptan como listos; `/healthz` comprueba por separado si el proceso responde. El comando realiza una comprobación por defecto. `--wait` repite la consulta hasta que el proxy esté listo o se agote el plazo, pero termina inmediatamente al observar `failed`. El plazo predeterminado es de 45 segundos; `--timeout <seconds>` requiere `--wait` y acepta enteros de 1–300. La salida `--json` de la CLI contiene menos campos que la respuesta HTTP: `{ready, status, pid, port}`, donde `status` es `ready`, `pending`, `failed` o `unreachable`. Los códigos de salida son 0 si está listo; 1 si no está listo, sigue pendiente, falla, se agota el plazo o no es accesible; y 64 si los argumentos no son válidos.

En un Child de Remote Link, la disponibilidad también incluye el enlace. Si no puede transportar solicitudes, `/readyz` devuelve `503` con `status: "pending"` y `link: {state: "unavailable", reason}`; `ocx ready --wait` sigue esperando a que se recupere. Un enlace operativo añade `link: {state: "available"}` a la respuesta `200`. En un Child, `/healthz` sigue indicando únicamente que el proceso responde. Los motivos se enumeran en [Remote Link](/es/guides/remote-link/#link-status).

### `ocx resolve [--json]`

Resolver los hechos de entorno de ejecución que un shell necesita sin volver a implementarlos: la configuración de inicio, el puerto efectivo y el veredicto de vivacidad verificado de identidad. `--json` emite un documento versionado (`schema: "ocx-resolve/1"`) con `cliVersion`, `configHome`, `port` (`effective`, `configured` y `source`), y `liveness` (`status`, `pid`, `port`, `source`, más `version`, `role` y `hostname` cuando el proxy en vivo los informa). Cuando un proxy está activo, el documento también lleva `versionSkew` - la misma superficie de comparación `ocx status` y `ocx doctor` - con `cliVersion`, `proxyVersion`, `skewed`, `relation` de `match`, `cli-newer`, `proxy-newer`, `incomparable` o `unknown`, y el `warning` orientado al operador. Los shells leen `relation` en lugar de reformular la advertencia; el escritorio usa `proxy-newer` para evitar que una toma de control disminuya el oyente. Liveness tiene tres respuestas: `live`, `absent-proven` (cada punto final registrado y configurado rechazó o respondió definitivamente no opencodex), y desconocido - una sonda de temporización o un oyente que retiene `/healthz` salidas 1 en lugar de leer como ausente, por lo que solo `absent-proven` puede autorizar el inicio de un nuevo entorno de ejecución. El puerto es el puerto del oyente en vivo cuando un proxy responde, de lo contrario, el puerto configurado (por defecto 10100). La salida 0 lleva un veredicto digno de confianza; la salida 1 significa que el CLI no se pudo resolver, incluido un `config.json` inválido, que nunca se repara aquí, y la persona que llama debe negarse a adivinar; cualquier argumento desconocido sale 64. Discovery utiliza el mismo presupuesto de sondeo seguro para la propiedad que `ocx start`, porque una respuesta falsa de "no escuchar nada" es cómo suceden los proxies duplicados. El verbo es de solo lectura y omite la función de restauración automática previa.

### `ocx doctor`

El informe predeterminado incluye el estado del coordinador de escritura nativa y la ruta exacta utilizando la inspección de solo lectura inmutable SQLite. Los estados de cero bytes, vacío-sin versionar y sin filas se muestran por separado del estado del catálogo/servidor de aplicaciones, por lo que una actualización de catálogo exitosa no se confunde con una inyección de configuración Codex exitosa.

La comprobación de historial pendiente lee un WAL-mode `state_5.sqlite` con puntos de control incluso cuando Codex está cerrado y sus archivos `-wal` / `-shm` están ausentes. Los sidecares que faltan por sí solos no indican un fallo de integridad de la historia. Los manifiestos de copia de seguridad y los objetivos de restauración aún se someten a validación de integridad.

Después de detener el servicio/proxy OpenCodex, conserve y mueva explícitamente un coordinador no autorizado probado, luego vuelva a intentar la sincronización:

```bash
ocx doctor --recover-zero-byte-coordinator --yes
ocx sync
```

La recuperación solo acepta un remanente probado de cero bytes. Rechaza todas las bases de datos no vacías, válidas, desconocidas, cambiadas, inseguras u ocupadas y crea un archivo del mismo directorio `.zero-byte-backup-*` en lugar de eliminar nada.

Ejecute diagnósticos de conectividad y entorno de solo lectura: rutas de estado y tipo de sistema de archivos, instalaciones duales WSL, entorno/configuración proxy, accesibilidad ChatGPT, advertencias de plugin y configuración de proyecto Codex y migración de historial pendiente. La sección de orientación de la aplicación Codex también detecta la estrecha falta de coincidencia del entorno de ejecución de Windows Orca y explica la migración del servicio cuando corresponde. Las rutas mostradas por este diagnóstico redactan el nombre de usuario del sistema operativo. El médico imprime pistas de reparación, pero no las aplica.

Los diagnósticos de Project-config ignoran los ejemplos de proveedores dentro de cadenas multilínea TOML, incluyendo `developer_instructions`. La configuración real del proveedor y del perfil después del delimitador de cierre sigue estando marcada, incluso cuando una cita escapada precede inmediatamente a ese delimitador.

La sección **OAuth fiabilidad** informa si el almacenamiento de credenciales es escribible, si se pueden crear archivos de actualización de un solo vuelo/bloqueo bajo `OPENCODEX_HOME`, OAuth o Codex cuentas de grupo no saludables (ids redactados) con una recuperación `Action:`, y un OK estático de que la ruta de reenvío Codex no fabrica metadatos de cliente oficial. El médico nunca muta las credenciales ni aplica reparaciones.

<a id="catalog-sync"></a>

## Sincronización de catálogo

<a id="read-saved-state-separately-from-synchronization"></a>

### Leer el estado guardado por separado de la sincronización

El modelo, el proveedor, la configuración y los recibos v2 tienen diferentes contratos de finalización. Los cambios de modelo personalizado local se sincronizan de manera oportunista: ningún proxy significa un guardado exitoso, `needsSync:true`, `sync.status:"not-attempted"` y salida 0. Un proveedor local explícito `--sync` sin un proxy en su lugar devuelve un valor distinto de cero después de guardar.

Las escrituras de configuración usan `catalogRefreshPending`, mientras que las escrituras de catálogos en vivo usan una disposición completa de `catalogRefresh`. El modo local v2/keep-native y el modificado on/off siguen intentando su sincronización establecida incluso cuando no se descubrió ningún puerto. JSON informa sobre el estado real cambiado y las pruebas de sincronización; la sincronización no verificada/no verificada no es cero. Los hilos, las sugerencias y la activación/desactivación sin cambios no introducen un nuevo intento de sincronización.

Inspeccione el mismo objetivo con `ocx v2 status --json` o `ocx v2 status --live --json` y utilice `ocx system settings --json` para la lectura de la configuración. Un resultado guardado pero pendiente o desconocido no prueba retroceso y no es permiso para reproducir una escritura. Consulte [v2 resultados](/es/reference/cli/agents/#explicit-v2-target-and-outcome) y [política de cuenta](/es/reference/cli/providers-accounts/#pool-policy-account-thresholds-and-paid-credit-intent) para conocer los límites de gasto, alcance y destino. Una lectura de estado de reset-grant puede contactar con el estado de upstream pero nunca consume o reanuda una subvención.

### `ocx sync [--restart-codex] [--restart-app-server-only]`

Un reinicio solicitado explícitamente también se ejecuta después de un cambio realizado con éxito de `config.toml`, incluso si los bytes de catálogo y caché no cambian. Una escritura de solo configuración sin opción, de rechazo, previa o de retroceso no la activa. Sin un indicador de reinicio, la sincronización nunca se reinicia automáticamente Codex.

En un Remote Link Child, `ocx sync` también aplica la configuración de Codex del Home y reinicia el entorno cliente si este arrancó antes de esa aplicación; consulta [Paridad de aplicación de Remote Link](#remote-link-apply-parity).

Obtenga la lista de modelos en vivo de cada proveedor configurado y vuelva a inyectar el catálogo combinado en Codex. Ejecutarlo después de agregar un proveedor o para actualizar los modelos disponibles.

Antes de la detección de proveedores o el reemplazo de catálogo/caché, `ocx sync` valida que se puede inyectar la configuración administrada Codex. Si esa validación rechaza la configuración, el comando sale de no cero, imprime la razón concreta en stderr y deja el catálogo y la caché existentes sin cambios. `ocx restore back` usa el mismo prevuelo sin escritura antes de volver a habilitar el enrutamiento.

Si los procesos de larga vida Codex `app-server` todavía se están ejecutando, `ocx sync` advierte que pueden seguir sirviendo la lista de modelos en memoria anterior a pesar de que `opencodex-catalog.json` / `models_cache.json` se actualizaron. Pase `--restart-codex` para reiniciar los procesos `codex … app-server` y `codex-code-mode-host` que coinciden con **y** y reinicie completamente la aplicación de escritorio Codex, en macOS, Linux y Windows, por lo que el selector de modelos vuelve a leer el catálogo. Las conversaciones en vivo terminan. La coincidencia amplia `pkill -f codex` se evita intencionadamente.

`--restart-desktop-app` es un alias obsoleto de `--restart-codex`. Todavía funciona, imprime un aviso de censura, y no es Windows -solo.

`--restart-app-server-only` restaura el comportamiento más antiguo y más estrecho: `SIGTERM` solo a los procesos de host de modo de código y de servidor de aplicaciones correspondientes propiedad del usuario actual, con la aplicación de escritorio en ejecución. Los giros activos aún pueden interrumpirse. Si se combina con `--restart-codex` o `--restart-desktop-app`, el alcance estrecho gana, porque perder conversaciones en vivo es irrecuperable y un selector obsoleto no lo es.

Cuando el comando se ejecuta desde dentro de la aplicación Codex, el reinicio se transfiere a un ayudante separado y esta sesión finaliza con la aplicación.

<a id="sync-only-from-the-expected-home-expect-link-and-expect-hub-key"></a>

#### Sincronizar solo desde el Home esperado: `--expect-link` y `--expect-hub-key`

```bash
ocx sync --expect-link <linkId> [--restart-codex]
ocx sync --expect-hub-key <apiKeyId> [--restart-codex]
```

Un script que lee `ocx connect status --json` y luego ejecuta `ocx sync` no puede saber si, entre
ambos comandos, el equipo se desconectó o se vinculó a otro Home. Un `ocx sync` sin más opciones
sincronizaría entonces los proveedores locales o el catálogo del otro Home. Pasar la identidad leída
evita esa situación. `--expect-link` recibe el `link.linkId` de un Remote Link Child, y
`--expect-hub-key` recibe el `apiKeyId` de un cliente de Hub. La comprobación se ejecuta bajo el mismo
bloqueo que elige la ruta de sincronización, y todas las escrituras posteriores quedan vinculadas
a la conexión que la superó.

Si la identidad coincide, el comando realiza exactamente la sincronización conectada descrita arriba.
En otro caso no cambia nada —ni siquiera la reparación automática de la shim de Codex que otros
comandos ejecutan primero—, nunca sincroniza los proveedores locales, termina con código **5** y
escribe en stderr una línea legible seguida de una línea JSON, que es la última:

```json
{"phase":"child_link_mismatch","reason":"other_link"}
```

`phase` es `child_link_mismatch` para `--expect-link` y `hub_client_mismatch` para `--expect-hub-key`.

| `reason` | Estado del equipo |
| --- | --- |
| `disconnected` | No está conectado a ningún Home ni Hub |
| `invalid_state` | No se puede leer la configuración del cliente o un marcador de conexión |
| `disconnect_pending` | Se inició una desconexión que aún no termina |
| `pending_operation` | Hay una rotación de clave, conexión u otra sincronización en curso, incluida una operación que mantiene los bloqueos que esta comprobación necesita |
| `hub_client` | Se usó `--expect-link` en un cliente de Hub |
| `link_client` | Se usó `--expect-hub-key` en un Remote Link Child |
| `other_link` / `other_key` | Está conectado, pero mediante otro enlace o con otra clave |

Un valor ausente o mal formado, una opción repetida o las dos opciones juntas terminan con código 2
antes de leer ningún estado. Si la conexión cambia después de la comprobación, mientras se obtiene
el catálogo, la operación falla como una sincronización conectada normal: código 1 y ninguna escritura.
Las versiones que no admiten estas opciones las ignoran; comprueba antes `ocx --version`.

### `ocx sync-cache [--restart-codex] [--restart-app-server-only]`

Invalide la caché local del selector de modelos de Codex para que se reconstruya a partir del catálogo activo de opencodex. Se aplican las mismas advertencias obsoletas `app-server` y los indicadores de reinicio opcionales que `ocx sync`.

Si la caché derivada ya tiene bytes idénticos, el comando se ejecuta correctamente sin reescribirlo ni reiniciar Codex. Con `--json`, esto se informa como `ok: true`, `wrote: false`, `skipped: true` y `skippedReason: "unchanged"`; un catálogo no válido o una escritura en caché fallida sigue saliendo no cero.

<a id="catalog-write-diagnostics"></a>

### Diagnósticos de escritura de catálogo

Catalog write auditing records diagnostics en `opencodex-catalog-audit.jsonl` bajo `CODEX_HOME`. Un catálogo o caché sin cambios no produce ningún evento; un error de auditoría no falla la publicación del catálogo.

En Windows, **como máximo se registra el evento de creación de nuevo archivo exitoso**. El archivo se crea vacío y endurecido antes de que se escriban los datos de diagnóstico. Todos los eventos posteriores omiten el archivo existente, tanto en el mismo proceso como después de reiniciar. Un fallo de endurecimiento puede dejar un archivo vacío, que eventos posteriores también omiten. Los archivos existentes y sus ACL no se cambian para la auditoría, incluso cuando otra casa OpenCodex posee el catálogo. Este es un retroceso de la privacidad, no un flujo de auditoría Windows completo; el comportamiento NTFS nativo para esta ruta de auditoría aún no se ha validado.

La auditoría POSIX continúa agregando y conservando registros limitados. La limitación Windows no deshabilita la protección del catálogo o la curación del propietario. Los archivos de auditoría en un `CODEX_HOME` separado permanecen como residuos de limpieza porque el manifiesto de desinstalación de configuración no puede reclamar rutas fuera de su propia raíz.

### `ocx catalog pull <https-url> [--auth-env <NAME>] [--json] [--restart-codex] [--restart-app-server-only]`

Instale un catálogo completo servido por el punto final `/v1/catalog` de otra instancia OpenCodex y, a continuación, sincronice `models_cache.json`. A diferencia de `ocx sync`, este comando no descubre proveedores configurados ni inyecta la configuración Codex. A diferencia de `ocx sync-cache`, reemplaza el catálogo activo antes de reconstruir la caché. Funciona incluso cuando el estado deseado de la integración local Codex está desactivado.

La URL debe ser HTTPS; se acepta loopback HTTP para pruebas locales. Las credenciales de URL incrustadas, consultas, fragmentos, redirecciones, respuestas de gran tamaño, JSON malformadas, identificadores duplicadas o inseguras y desconocidas `input_modalities` se rechazan antes de cualquier escritura local.

Las solicitudes de Loopback HTTP son rechazadas antes de que se adjunten las cabeceras de autenticación o se envíe cualquier solicitud cuando se aplica `HTTP_PROXY` o `http_proxy` sin una derivación `NO_PROXY` o `no_proxy` coincidente. `ALL_PROXY` / `all_proxy` y la configuración limitada a `HTTPS_PROXY` / `https_proxy` no activan esta restricción HTTP; La adquisición del catálogo HTTPS permanece permitida. El mensaje de denegación no incluye ni la dirección proxy ni el testigo de autenticación. `http_proxy` y `no_proxy` tienen prioridad sobre `HTTP_PROXY` y `NO_PROXY`, respectivamente. Para reglas de omisión compatibles con Bun, use nombres de host, entradas coincidentes `host:port`, direcciones IPv6 entre corchetes como `[::1]` o `*`; no use URL, rutas o prefijos `*.`.

La autenticación es opcional y solo se lee mediante referencia de entorno variable:

```bash
export OPENCODEX_CATALOG_AUTH_TOKEN='...'
ocx catalog pull https://proxy.example.com/v1/catalog \
  --auth-env OPENCODEX_CATALOG_AUTH_TOKEN
```

El valor se envía como un token de portador, pero nunca se acepta como un valor de argv. Las redirecciones son rechazadas, por lo que la autorización no puede cruzar orígenes. Las escrituras de catálogo y caché utilizan el bloqueo de catálogo Codex compartido y el escritor atómico. Una recuperación, validación, adquisición de bloqueos, escritura de catálogo o reconstrucción de caché fallida conserva los últimos archivos buenos conocidos. Si los bytes del catálogo son idénticos, la operación no cambia nada: conserva los mtimes y no modifica los procesos. `--restart-codex`, `--restart-app-server-only` y el alias `--restart-desktop-app` en desuso significan lo mismo aquí que en `ocx sync` y `ocx sync-cache`, y se aplican solo después de una escritura real.

La URL debe nombrar `/v1/catalog` en la raíz del host. Este comando no admite un proxy inverso que sirva el punto final bajo un prefijo de ruta.

El comando descarga el catálogo completo y compara bytes localmente en lugar de emitir un `ETag` /
`If-None-Match` Solicitud condicional. Los bytes idénticos se tratan como un no-op completo, por lo que Codex casa cuyo catálogo es correcto, pero cuya `models_cache.json` falta o es rancio no reparado por este comando; usar `ocx sync-cache` Por eso.

`--json` emite un sobre estable en stdout. `schemaVersion`, `ok`, `status`, `catalogWritten`, `cacheSynced` y `codexRestarted` están siempre presentes. `codexRestarted` todavía significa solo servidores de aplicaciones. `desktopAppRestarted` está presente solo cuando se solicitó un reinicio del escritorio, y es `true` solo cuando se inició el relanzamiento; un traspaso no es un éxito. `status` es `updated`, `unchanged`, o `failed`. Un tirón exitoso agrega `modelCount`; un fallo agrega `code`, que es el campo en el que se ramifica un script:

| `code` | Descripción | Salir |
| --- | --- | --- |
| `usage` | Los argumentos no eran una invocación `catalog pull` válida. | 2 |
| `auth_env_missing` | `--auth-env` nombró una variable que no está establecida | 1 |
| `url_invalid`, `insecure_http_refused` | La URL fue rechazada antes de cualquier solicitud | 1 |
| `request_failed`, `redirect_refused`, `http_error` | La solicitud no produjo una respuesta utilizable | 1 |
| `body_too_large`, `body_invalid`, `catalog_invalid` | La respuesta fue rechazada antes de cualquier escritura local. | 1 |
| `write_failed`, `lock_database`, `unsafe_path` | La escritura coordinada no se completó; los archivos no han cambiado | 1 |
| `lock_busy` | Otro escritor tiene el bloqueo de catálogo Codex | 3 |
| `restart_incomplete` | El catálogo y la caché aterrizaron, pero un Codex app-server sobrevivió `--restart-codex` o `--restart-app-server-only` | 1 |

`restart_incomplete` es el único fallo que reporta escrituras reales: `catalogWritten` y `cacheSynced` permanecen verdaderas y `ok` es falsa, porque un servidor de aplicaciones sobreviviente todavía sirve el catálogo anterior de memoria.

<a id="background-service"></a>

## Servicio en segundo plano

Un servicio administrado puede iniciar una instalación más nueva que anteriormente servía a la misma casa OpenCodex, incluso cuando su definición de servicio aún apunta a una instalación más antigua. Si ese hijo más nuevo sale antes de vincularse, con cualquier código de salida, el servicio original se inicia en su lugar y aplica sus propias comprobaciones antes de servir. Los inicios de primer plano y los proxies lanzados por el cliente mantienen su ejecutable seleccionado. En Windows, esto se aplica al Programador de tareas y a los servicios nativos WinSW recién instalados o reparados. Una definición nativa de WinSW creada antes de este comportamiento necesita `ocx service repair` para actualizar su XML antes de que pueda pasar a una instalación más reciente.

### `ocx service [install|repair|restart|start|stop|status|uninstall|remove]`

En Windows Task Scheduler, el envoltorio de servicio reinicia el proxy después de cinco segundos, incluso cuando una herramienta externa lo termina con el código de salida 0. Si otro proxy opencodex ya posee el puerto, el contenedor sale deliberadamente. Utilice `ocx stop` o `ocx service stop` para detener el servicio y su bucle de reinicio. Después de actualizar una instalación existente, ejecute `ocx service repair` para actualizar el envoltorio generado.

Ejecute opencodex como un servicio en segundo plano administrado por inicio de sesión (macOS **launchd**, Linux **Unidad de usuario systemd**, Windows **Programador de tareas**) que se inicia automáticamente al iniciar sesión y se reinicia automáticamente al bloquearse. El servicio ejecuta el conjunto `OCX_SERVICE=1` para que un reinicio no cambie la configuración Codex.

Windows Las instalaciones del Programador de tareas usan la prioridad de proceso normal (`Priority=4`). La prioridad de fondo más antigua (`7`, también el planificador predeterminado cuando se omite) puede retrasar las respuestas de estado del proxy en la contención de la CPU, haciendo que la bandeja informe Desconectado incluso mientras el proceso está activo. Después de actualizar, ejecute `ocx service repair` para migrar esa prioridad registrada y reinicie el servicio. Esta migración puede solicitar la aprobación de UAC; una prioridad ya establecida a normal o alta no desencadena la sustitución.

El envoltorio Windows admite fechas de configuración regional que contienen paréntesis, incluidos los formatos de fecha coreano y japonés. Después de actualizar, ejecute `ocx service repair` para reemplazar un envoltorio generado más antiguo que sale antes de lanzar Bun en esas configuraciones regionales.

El envoltorio Windows verifica su entorno de ejecución Bun horneado y su entrada CLI antes de cada intento de inicio. Si una actualización de paquete interrumpida elimina cualquiera de los archivos, registra un mensaje `installation is incomplete` y se detiene en lugar de volver a intentar el mismo ejecutable que falta cada cinco segundos. Vuelva a instalar opencodex y, a continuación, ejecute `ocx service repair` para actualizar la tarea con las rutas de paquetes restauradas.

Las definiciones de servicio omiten los directorios multishell version-manager locales de sus `PATH` guardados. Esto incluye el servicio nativo Windows instalado con `ocx service install --native`; ejecute `ocx service repair` para regenerar una definición de WinSW anterior con un `PATH` duradero.

En Linux, la unidad systemd invoca el primer ejecutable normal `ocx` archivo encontrado en `PATH` en tiempo de instalación en lugar de las rutas Bun y CLI dentro del árbol de paquetes instalado. Administradores de versiones como el **mise** y **asdf** instalar en un directorio versionado y eliminar el antiguo en la actualización; su shim estable mantiene la unidad resolviendo. Fuente checkouts sin un `ocx` lanzador mantener el forma directa Bun + CLI. Un confiable `OPENCODEX_BUN_PATH` seleccionado antes de Bun se inicia se conserva a través de la shim; las rutas de paquetes locales Bun se redescubren después de las actualizaciones.

En macOS, launchd en su lugar utiliza el paquete local Bun y CLI rutas seleccionadas durante la instalación o reparación. Esto evita que una shim PATH mutable reciba el token de servicio API y el entorno proxy configurado en un reinicio posterior. Después de actualizar una instalación del administrador de versiones, ejecute `ocx service repair` para actualizar esas rutas antes de reiniciar el servicio. Lanzado reinicia el proxy después de un fallo o un traspaso de reinicio fallido, pero lo deja detenido cuando el servicio sale deliberadamente de forma limpia porque la aplicación de escritorio es propietaria del entorno de ejecución. Ejecute `ocx service repair` una vez para aplicar este comportamiento a un servicio instalado por una versión anterior.

Las definiciones instaladas antes de este cambio todavía llevan las antiguas rutas versionadas y no pueden migrar por sí mismas: una vez que se elimina el ejecutable antiguo, no se ejecuta ningún código opencodex para solucionarlo. Ejecutar `ocx service repair` una vez después de la actualización. Linux el servicio comienza entonces sigue el lanzador; macOS repair escribe las nuevas rutas de paquetes en la definición launchd. Un proxy ya en ejecución no se sustituye por una actualización externa: cuando el CLI instalado es más nuevo que el proxy en ejecución, ejecute `ocx service restart` para que sirva la nueva compilación. En macOS, `repair` no es suficiente allí: la definición no cambió, y una reparación que no cambia nada no recarga nada. Si el proxy es más nuevo en su lugar, compruebe la instalación CLI y `PATH` como se describe en [`ocx status`](#ocx-status---json).

| Subcomando | Medidas adoptadas |
| --- | --- |
| Ninguno | Instale e inicie cuando esté ausente; de lo contrario, `repair` el servicio existente. Se reutiliza una definición saludable del planificador Windows; una definición obsoleta puede volver a registrarse y requerir elevación. |
| `install` | Crear e iniciar el servicio. Lo registra, que en Windows necesita elevación. |
| `repair` | Actualizar un servicio instalado en su lugar. En macOS, el administrador se recarga solo cuando algo cambia, por lo que un trabajo saludable y sin cambios sigue funcionando y la reparación no es una interrupción. En Linux y Windows, el servicio se reinicia; se reutiliza una definición de planificador de Windows saludable, mientras que una definición obsoleta puede volver a registrarse y requerir elevación. |
| `restart` | La misma actualización y un reinicio garantizado en todas las plataformas. En el macOS se inicia un trabajo sin cambios y ya cargado. No es un alias de `repair`. |
| `start` | Iniciar un servicio instalado. |
| `stop` | Detener el servicio y restaurar nativo Codex. |
| `status` | Informar los diagnósticos del servicio y del proxy, y las rutas de registros. `--json` muestra el documento pasivo descrito a continuación. |
| `uninstall` | Retire el servicio y restaurar nativo Codex. |
| `remove` | Alias de `uninstall`. |

En `ocx service`, un Windows ejecuta la ruta de instalación solo después de que se demuestre que está ausente el Programador de tareas y WinSW. Si cualquiera de las consultas de estado no es concluyente, se niega a registrar nada y le pide que ejecute `ocx service status`; use `ocx service install` explícito solo después de confirmar la ausencia.

`ocx service status --json` muestra un documento pasivo para scripts y otros clientes, como el inventario de dispositivos de GOAT. Realiza las mismas lecturas que el informe de texto y nunca instala, inicia, detiene ni repara nada; cualquier otro verbo `service` rechaza `--json`. Campos: `schemaVersion` (1), `platform`, `supported`, `backend` (`launchd`, `systemd`, `schtasks`, `winsw` o `none` si no hay ningún registro), `label` (nombre del trabajo, unidad, tarea o servicio WinSW), `installed`, `enabled`, `running` (veredicto del administrador de servicios), `viable`, `stale`, `conflict`, `serving` (`probed`, `ok`, `port`; solo se sondea cuando hay un registro), `summary`, `logPath`, `ownershipLease` y `desktopLogin`. Una plataforma no admitida o un contenedor Docker también recibe el documento, con `supported: false`.

<a id="runtime-ownership"></a>

### Propiedad en entorno de ejecución

La aplicación de escritorio OpenCodex puede tomar el proxy de fondo de una instalación CLI. Cuando lo hace, registra el traspaso en el estado de instalación del servicio compartido, y ese registro es lo que hace que la adquisición sobreviva a un reinicio. Su registro de servicio es **mantenido, nunca eliminado** - el registro lo reemplaza en lugar de reemplazarlo.

Un archivo de estado sin registro de propiedad significa que la instalación CLI es propietaria del entorno de ejecución, que es en lo que se realiza cada instalación antes de que se encuentre esta función. Nada cambia para ti hasta que una aplicación se hace cargo.

Los hijos de servicio supervisados también verifican al propietario registrado antes del inicio y una vez más mientras mantienen el contrato de arrendamiento de propiedad de inicio, antes de elegir un puerto o publicar un PID. Si la aplicación de escritorio reclama el entorno de ejecución durante el inicio, el hijo de servicio se desactiva incluso si el proxy de escritorio aún no ha comenzado a escuchar. Un registro de propiedad ilegible tiene el mismo comportamiento de stand-down.

Home rutas dentro de un registro de estado se comparan con la casa actual por el directorio físico que resuelven, no solo su ortografía. Un cruce o enlace simbólico registrado bajo una instalación anterior todavía nombra la misma casa y sigue funcionando después de la mudanza; un alias que ya no se resuelve solo se trata como una casa diferente cuando su ortografía registrada también difiere de la actual, por lo que un montaje obsoleto aún produce la negativa del propietario extranjero en lugar de reclamar silenciosamente el entorno de ejecución.

Mientras que algo más que este CLI posee el entorno de ejecución, los subcomandos que **activar** su registro se niegan en su lugar:

| Subcomando | Comportamiento bajo un propietario extranjero |
| --- | --- |
| `repair`, `restart` | Rechazar antes de cambiar nada. El registro no se vuelve a habilitar, reescribe o reinicia. |
| `start` | Se niega por la misma razón, por lo que un inicio automático de bandeja no puede poner un segundo proxy al lado de la aplicación. |
| `stop`, `uninstall` | Sin cambios. Se desactivan, por lo que nunca están cerradas. |
| `install` | Devuelve el tiempo de ejecución. Limpia el registro de propiedad después de que el registro tenga éxito, e informa de quién fue. |

`ocx update` se comporta de la misma manera: ni detiene el proxy en ejecución ni actualiza el servicio mientras la aplicación posee el entorno de ejecución, porque el servidor en ejecución es el propio binario incluido de la aplicación y la actualización volvería a habilitar el lanzador que reemplazó la adquisición. La aplicación actualiza su propio entorno de ejecución.

La denegación nombra la instalación propietaria y la generación de consentimiento, por ejemplo:

```text
Background service repair stopped: the desktop app owns the runtime (install <id>, consent generation 2).
The service registration was left exactly as it is — not re-enabled, not rewritten and not restarted.
Quit the desktop app and run 'ocx service install' to hand the runtime back to this CLI.
```

Un registro que no se puede leer o no analiza produce el mismo rechazo con una primera línea diferente, porque una reclamación ilegible no es lo mismo que ninguna reclamación - tratándolo como "nadie es dueño de esto" es como un error de permisos reactivaría silenciosamente su servicio.

**La recuperación en todos los casos es `ocx service install`.** Es deliberadamente el único verbo que nunca está cerrado, por lo que eliminar la aplicación sin devolver el entorno de ejecución, o un archivo de estado dañado, aún le deja una forma de recuperar el servicio:

```bash
ocx service install
```

```bash
ocx service
ocx service install
ocx service repair
ocx service restart
ocx service status
ocx service uninstall
```

`install`, `start` y `repair` confirman que un proxy realmente responde en el puerto instalado antes de informar el éxito en las tres plataformas. Esperan hasta 20 segundos y luego imprimen el puerto de servicio:

```
✅ opencodex service installed and serving on port 10100.
```

Si nada responde, advierten y **Salida no cero**:

```
⚠️  Service installed, but no proxy answered on port 10100 within 20s.
   The manager registered the job; that is not the same as serving.
   Log:       ~/.opencodex/service.log
   Meanwhile: ocx start   (serves in the foreground)
```

Una salida distinta de cero significa aquí *Registrados pero sin servicio*, no *no instalado*. El gerente de servicio aceptó el trabajo; el proxy detrás de él nunca conectó el puerto. Lea el registro nombrado en el mensaje y use `ocx start` para servir en primer plano.

`ocx service status` informa los mismos tres estados en lugar de la salida del administrador en bruto:

```
✅ installed and loaded (launchd; logs: …)
   Serving on port 10100.
```

```
⚠️  installed and loaded (launchd; logs: …)
   Registered, but no proxy is answering on port 10100.
   launchd is running an OLDER plist than the one on disk.
   Fix:    launchctl bootout gui/$(id -u)/com.opencodex.proxy && ocx service repair
   Log:    ~/.opencodex/service.log
   Repair: ocx service repair
   Meanwhile: ocx start           (serves in the foreground)
```

Ya no imprime la línea sin procesar `launchctl list` / `systemctl status`, que informaba de un trabajo registrado de manera idéntica si estaba sirviendo, vinculado a nada o ejecutando una definición anterior. La línea `Diagnostics:` todavía lleva la trayectoria logarítmica y cualquier hallazgo de trayectoria anticuada.

En Windows, el backend del programador mantiene su propia salida de estado más rica, que ya informó el registro del Programador de tareas por separado de la accesibilidad del proxy.

<a id="service-logs"></a>

### Registros de servicio

El proxy administrado escribe stdout y stderr a `~/.opencodex/service.log` (o `$OPENCODEX_HOME/service.log` con un hogar personalizado). Cuando se establece `OCX_SERVICE`, `ocx start` prefija cada línea de registro de consola, incluidos los diagnósticos multilínea, con una marca de tiempo UTC ISO-8601 como `2026-10-14T03:04:05.678Z`. La salida en primer plano y otros comandos CLI mantienen su formato existente.

El servicio comprueba el tamaño del registro en el inicio y una vez por minuto. Por encima de 20 MiB copia los 20 MiB más nuevos en `service.log.1`, mueve el archivo anterior a `service.log.2` y trunca el archivo activo en su lugar para que los identificadores de apéndice abierto del administrador de servicios sigan siendo utilizables. El archivo activo puede superar el umbral entre comprobaciones; cada archivo está limitado a 20 MiB. Las fallas de rotación no detienen el servicio. Copy-truncate puede perder líneas escritas durante la copia, y un archivo puede comenzar a mitad de camino a través de una línea. Los mensajes de envoltura Windows existentes mantienen su formato de envoltura.

En macOS esto también cubre un fallo más sutil: `launchctl load` informa de un fallo en stderr mientras sale 0, por lo que una carga que no se usó para dejar launchd ejecutando una versión **anterior** de la definición de servicio mientras el comando imprimió una marca de verificación. `install` ahora falla ruidosamente en ese caso y nombra el comando `launchctl bootout` que limpia el trabajo obsoleto.

En Windows, `ocx service status` informa el registro del Programador de tareas por separado de la accesibilidad del proxy OpenCodex verificado por identidad. No imprime la tabla localizada `schtasks`, por lo que el resumen sigue siendo legible en Windows páginas de código. La recuperación de copia de seguridad transaccional registra un mensaje de éxito fijo en lugar del nombre del directorio de copia de seguridad; los nombres de copia de seguridad que contienen metacaracteres de shell no se convierten en comandos en ese mensaje de registro.

En Windows, desinstalar una tarea `opencodex-proxy` registrada con elevación puede requerir un
terminal elevado. Si se deniega su eliminación, o termina con código 1 y la tarea sigue presente,
OpenCodex informa de que se requiere elevación y conserva los archivos del servicio.
Abre PowerShell o Terminal con **Ejecutar como administrador** y ejecuta:

```powershell
schtasks /delete /tn opencodex-proxy /f
```

Después, vuelve a ejecutar `ocx service uninstall` desde la cuenta original para terminar la limpieza
y comprueba `ocx service status`. Los comandos de inicio o parada con acceso denegado indican el
comando `schtasks` elevado correspondiente. Los fallos del Programador usan diagnósticos y códigos
de salida estables en lugar de reproducir el stderr localizado del hijo, que puede usar otra página
de códigos de Windows. Si la tarea está ausente o no puede leerse después de una eliminación fallida,
el código 1 por sí solo no confirma una denegación de acceso; el texto de acceso denegado reconocido
en la eliminación sigue clasificándose como tal.

En Windows, la creación de la entrada del Programador de tareas requiere elevación. El texto denegado de acceso localizado reconocido mantiene la ruta de guía existente. Si ese texto es ilegible, el recurso alternativo requiere la forma de comando propia `/create /tn opencodex-proxy /xml <non-empty-path> /f`, estado 1, y un token no elevado confirmado; la acción de seguridad de inicio del panel de control puede solicitar UAC automáticamente. Si esa reserva no puede determinar el estado del token, retiene el error del programador original. Las tareas y operaciones en el extranjero nunca pueden emitir el marcador de elevación automática. Aprobar el indicador UAC del panel de control o volver a ejecutar `ocx service install` en una ventana de PowerShell elevada.

Para una instalación nueva en la que la tarea del planificador OpenCodex se confirma ausente, la aprobación de UAC ahora ocurre antes de que el instalador detenga cualquier proxy existente. Su XML de registro único se organiza en un directorio privado endurecido por ACL fuera de la raíz de configuración OpenCodex, y la tarea se registra sin ejecutarse. Solo después de que el registro tenga éxito, OpenCodex elimina ese XML, requiere metadatos de propiedad para una raíz de configuración genuinamente nueva, detiene el antiguo oyente, elimina y vuelve a verificar de manera limitada cualquier registro nativo de WinSW, publica los activos de servicio e inicia la tarea programada. La cancelación o denegación de UAC, o no reclamar una nueva raíz de forma segura, por lo tanto, deja el proxy de trabajo y su enrutamiento Codex en su lugar. Los registros de planificador existentes o conflictivos continúan fallando en lugar de ser eliminados como un retroceso inseguro del mejor esfuerzo.

Si los informes de inicio `another process owns the runtime mutation lease` o `ocx service status` muestran `Runtime mutation lease busy`, el contrato de arrendamiento bloquea el inicio o los cambios de servicio incluso si el proxy no se está ejecutando. El mensaje incluye la ruta de bloqueo, el PID registrado, la vida actual, el nombre ejecutable cuando esté disponible y la edad de arrendamiento. La identidad del proceso no está verificada: el PID puede haber sido reutilizado, por lo que la vitalidad y el nombre ejecutable describen el proceso que ocupa ese PID ahora. Espere a que la operación termine y vuelva a intentarlo; no elimine el bloqueo ni detenga un proceso basado solo en este PID. Un intento de mutación posterior puede reclamar un arrendamiento obsoleto una vez que su edad supera los 30 segundos y el PID registrado ya no está vivo; el estado solo lo inspecciona.

En Windows, este diagnóstico compartido del Nodo/Bun no lanza un ejecutable para buscar el nombre de la imagen; el PID, la vivacidad, la edad de arrendamiento y la guía de recuperación registrados permanecen disponibles.

### `ocx codex-shim <install|status|uninstall|remove>`

En macOS y Linux, instale un envoltorio de inicio automático privado en `<OPENCODEX_HOME>/bin/codex` y un `<OPENCODEX_HOME>/codex-shell-env.sh` fuente, utilizando la casa OpenCodex resuelta. El lanzador nativo se queda donde brew, npm o fnm lo instaló; las actualizaciones del administrador de paquetes y las reversiones de versiones continúan funcionando sin volver a envolver ese lanzador. En Windows, los lanzadores basados en scripts todavía están envueltos en su lugar. Real `codex.exe` objetivos se dejan intactos. Si se rechaza la instalación o el contenedor no se puede ejecutar, el comando sale de no cero y el panel de control informa de la razón del fallo. Un envoltorio Unix ejecutable cuenta como una instalación exitosa incluso antes de la activación en el shell actual; una shim saludable ya instalada también cuenta como éxito. Para Windows instalaciones que exponen solo `codex.exe`, use `ocx service install` para autoarranque.

En macOS /APFS, un reinicio puede cambiar los números de dispositivo del sistema de archivos. Después de ese cambio, un entorno de envoltura y shell privado permanece intacto, por lo que el estado, la reparación y la desinstalación continúan funcionando. OpenCodex todavía comprueba sus inodos registrados, rutas, propietario, permisos y enlace de contenido/lanzador; se conservan los archivos reemplazados o no validados.

Después de brew/fnm y otra configuración PATH, ejecute el comando de activación impreso por install. Con la casa por defecto, es:

```sh
. "$HOME/.opencodex/codex-shell-env.sh"
```

Para un hogar personalizado, use la ruta impresa y cotizada. El abastecimiento es idempotente: elimina entradas duplicadas de contenedores privados y pone ese directorio primero en PATH. Para activar futuros proyectiles, agregue esa línea de origen después de configurar su PATH de administrador de paquetes usted mismo; OpenCodex nunca edita archivos de inicio de shell. La instalación no puede cambiar su shell padre. `ocx status`, `ocx codex-shim status`, `ocx doctor` y `ocx connect` informan de una envoltura ejecutable pero no seleccionada como **No activo**, con el commando de activación. Los alias/funciones de Shell y los lanzadores de escritorio o servicios configurados por separado aún necesitan su propia configuración.

Para fnm-managed Codex, la instalación resuelve el directorio multishell temporal a la instalación duradera del Nodo mientras se conserva el nombre de archivo del lanzador. Si ese directorio no se puede resolver, la instalación se niega en lugar de envolver una ruta temporal. Cuando se selecciona Codex, `ocx connect` también informa de la preparación de la shim. Esta comprobación de preparación omite entradas PATH de archivo especial y, en macOS y Linux, archivos sin permiso de ejecución, incluidos los objetivos de enlace simbólico. Preserva el orden de los lanzadores ejecutables regulares, incluidos los enlaces simbólicos npm y fnm. Windows mantiene su búsqueda PATHEXT. Si un envoltorio PATH diferente oculta una shim ejecutable, corrige el orden PATH; reinstalar la misma shim no cambia qué comando encuentra primero tu shell. Si la shim rastreada se puede ejecutar pero no se encuentra ningún comando `codex`, connect lo informa como inactivo e imprime el comando de activación. Una inspección PATH fallida informa la activación como no verificada en lugar de afirmar que no existe ningún comando. Estas advertencias no cambian el estado de salida del comando connect.

Antes de que se realice una instalación o reparación, OpenCodex ejecuta el lanzador guardado con `--version` mientras se omite el inicio del servicio. Rechaza el cambio y retrocede cuando el lanzador resuelve `codex` de nuevo a la shim, sale distinto de cero, excede los cinco segundos, deja a los descendientes corriendo o no puede validarse y limpiarse de forma segura. Por lo tanto, `codex-shim install` no es incondicional. Si se rechaza, reinstale Codex para que la entrada PATH sea un ejecutable concreto o un lanzador y reintente; use `ocx service install` en su lugar cuando un lanzador de administrador de comandos dinámico no pueda cumplir con estas comprobaciones. Los rechazos de limpieza incluyen un sufijo de diagnóstico limitado que identifica la fase de sonda, un código o señal de error nativo reconocido, y el estado de salida cuando se conoce. No incluye rutas de lanzamiento ni salida de raw child, y no relaja las comprobaciones de validación o reversión. Una shim Unix más antigua instalada en su lugar es migrada solo por una `ocx codex-shim install` explícita. La migración restaura el lanzador nativo registrado sin reemplazar un lanzador más nuevo ya presente, luego instala el envoltorio privado. Si la instalación privada falla después de la restauración nativa, el lanzador nativo permanece restaurado y la operación se puede volver a intentar. Lanzadores nativos faltantes o inutilizables requieren reparación del gestor de paquetes; OpenCodex no adivina otra instalación ni vuelve a envolver la ruta del administrador. La migración también se niega cuando el `codex-shim.json` registrado no es un archivo regular de su propiedad o es grabable en grupo o en todo el mundo. Las versiones anteriores escribieron ese archivo con el proceso umask, por lo que un umask de `002` lo dejó en el modo `0664`. El rechazo nombra el archivo y el `chmod 600` que aclara solo el rechazo escrito en grupo o en todo el mundo. Se mantienen Symlink y las denegaciones de propietarios extranjeros; OpenCodex no cambia los permisos en sí.

La instalación del lanzador por sí sola no prueba que las solicitudes Codex usarán OpenCodex. Después de una instalación ejecutable, el comando comprueba el enrutamiento Codex actual e informa una advertencia en lugar de un resultado verde cuando el enrutamiento es externo, de propiedad del usuario o no verificable. También advierte cuando existen variables proxy salientes solo en el proceso actual, mientras que `config.proxy` no está configurado o no se ha resuelto, porque los lanzadores Codex y los servicios en segundo plano pueden no heredar ese entorno. Estas comprobaciones son de solo lectura y nunca imprimen valores de proxy; resuelva el traspaso informado y ejecute `ocx doctor` antes de confiar en el inicio automático.

En Unix, la reparación automática actualiza solo el envoltorio privado y nunca reescribe el gestor de paquetes Lanzadores o migra una shim más antigua en el lugar. En Windows, si se ha completado una actualización externa de Codex sobrescribe una shim instalada, el siguiente ordinario `ocx` El comando respalda el nuevo lanzador estable y restablece la shim antes del envío. El efecto cero
`ocx system codex-cli-update check` de inspección e invocaciones malformadas en su reserva
`ocx system codex-cli-update` El espacio de nombres nunca realiza esa reparación. `ocx status`, `ocx doctor`, y
`ocx codex-shim status` también omita la reparación automática de la shim e informe el estado observado. Un lanzador que todavía está cambiando se deja intacto y se vuelve a intentar más tarde. Fallas de reparación advierten sin fallar el pedido comando; fallback manual: `ocx codex-shim install`. Establecer `codexShimAutoRestore` a `false`, o establecer
`OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0` para una opción de exclusión a nivel de proceso.

El contenedor Unix conserva su ruta nativa de lanzador registrada. Los cambios del gestor de paquetes detrás de esa entrada duradera se siguen automáticamente; eliminar esa entrada requiere reparación del gestor de paquetes. Los lanzadores de administradores de comandos dinámicos todavía tienen que pasar la validación anterior. Windows reparación en el lugar necesita el original guardado al lado de la shim; si un gestor de versiones destruye todo el árbol y copia de seguridad, OpenCodex informa de la condición y se detiene en lugar de inventar un original de reemplazo.

Si el lanzador del gestor de versiones no puede pasar la validación, rutee la configuración Codex en lugar del lanzador: `ocx start` escribe `openai_base_url` y `ocx service install` proporciona autoarranque. Ejecute `ocx status` para confirmar - informa el enrutamiento activo, y advierte cuando un proxy en ejecución no es el Codex se apunta.

| Subcomando | Medidas adoptadas |
| --- | --- |
| `install` | Instalar la cuña (o reparar si es rancio). |
| `uninstall` | Retire los artefactos privados de Unix, dejando intacto el nativo Codex; el Windows, restaure el lanzador original. |
| `remove` | Alias de `uninstall`. |
| `status` | Informe el estado de la cuña y si el envoltorio privado está activo en PATH. |

```bash
ocx codex-shim install
ocx codex-shim status
ocx codex-shim uninstall
```

Después de desinstalar Unix, elimine la línea de origen del archivo de inicio de shell y reinicie el shell o elimine la entrada de bin privado de su PATH. La desinstalación elimina el envoltorio, el archivo de entorno de shell y el estado propios; deja intacto el lanzador del administrador de paquetes. Se libera una shim Unix más antigua en el lugar utilizando sus datos de restauración registrados.

:::note[Entorno del token en Windows]
Windows CMD y las shims PowerShell recientemente generadas restauran el número de la persona que llama `OPENCODEX_API_AUTH_TOKEN` Después de la ejecución. Codex y sus procesos secundarios aún pueden heredar el token.

Después de actualizar OpenCodex, vuelva a crear una shim Windows existente con `ocx codex-shim uninstall` seguido por `ocx codex-shim install` para obtener este comportamiento. Una actualización ordinaria no reescribe una shim Windows saludable.
:::

:::tip[Servicio y shim]
Uso `ocx service` para un proxy de fondo siempre activo (recomendado). Uso `ocx codex-shim` por arranque ligero bajo demanda sin un demonio — el proxy se inicia solo cuando `codex` es lanzado.
:::

<a id="token-injection-into-codex"></a>

#### Inyección de token en Codex

En una unión sin retorno de bucle, el proveedor inyectado lleva `env_key = "OPENCODEX_API_AUTH_TOKEN"`. Esa línea indica a Codex qué variable leer; no la crea. Codex se niega a iniciar una solicitud cuando falta la variable (`Missing environment variable: OPENCODEX_API_AUTH_TOKEN`), y el proxy nunca se alcanza. El valor vive en `$OPENCODEX_HOME/service-api-token`; el proceso de lanzamiento debe suministrarlo en el entorno de Codex.

Utilice la shim mantenida instalada por `ocx codex-shim install`. Cuando el contexto de lanzamiento resuelve esta shim, lee el archivo de token creado por OpenCodex y suministra la variable a Codex. Los lanzamientos de escritorio, cron y servicio deben usar una ruta PATH o un trazado de lanzamiento que seleccione la shim; la instalación no configura esos entornos automáticamente. Los propios procesos hijo de Codex aún pueden heredar el token.

No exporte este token portador desde un archivo de inicio de shell ni lo copie en `config.toml`. El archivo `service-api-token` contiene el token sin procesar, no las asignaciones `NAME=value`, por lo que no se puede usar directamente como un systemd `EnvironmentFile=`.

Un `EnvironmentFile=` o `OCX_API_TOKEN_FILE` en `opencodex-proxy.service` configura el proceso proxy solamente y nunca fluye a un `codex exec` lanzado independientemente.

Las actualizaciones de Unix package-manager dejan el envoltorio privado intacto. Un envoltorio ejecutable que es **No activo** no inyecta el token: fuente del archivo de activación impreso en el shell de inicio. En Windows o con una shim en el lugar más antigua, una actualización Codex que reemplaza el lanzador elimina la shim; en Windows el siguiente comando ordinario `ocx` lo restaura (ver arriba), pero un `codex exec` que corre antes falla. `ocx doctor` informa de este estado exacto bajo "Codex env_key listo para el lanzamiento" (env_key configurado, variable unset, calza faltante o insalubre, archivo de token presente) con reparación o guía de activación, y nunca imprime el token. La lectura del archivo token no forma parte del contrato `env_key` inyectado; el proceso de lanzamiento debe suministrar esa variable.

### `ocx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]`

Instale y controle el icono de la bandeja de estado Windows. Se inicia en el inicio de sesión Windows y proporciona controles proxy con un solo clic. `start` y `stop` controlan el icono solamente; use su menú para controlar el proxy. `--no-start` se aplica a `install` e instala la bandeja sin lanzarla inmediatamente. En desuso: la aplicación de escritorio OpenCodex proporciona la bandeja en Windows, macOS y Linux; `ocx tray` permanece para las instalaciones sin la aplicación de escritorio. Cuando se conoce una versión de paquete más reciente, la bandeja agrega un punto azul a su icono en línea, advertencia o sin conexión y muestra **Actualización disponible**. La bandeja comprueba su insignia local almacenada en caché aproximadamente una vez por minuto; los resultados obsoletos o no disponibles eliminan el punto. El elemento de menú abre el panel de control, donde puede iniciar la actualización del paquete. No se instala automáticamente.

<a id="dashboard"></a>

## Panel

### `ocx gui`

Abra el [panel web](/es/guides/web-dashboard/) en `http://127.0.0.1:<port>` - o en `http://127.0.0.1:<management port>` cuando la entrada de administración de concentradores esté habilitada - inicie automáticamente el proxy si no se está ejecutando.

<a id="updating"></a>

## Actualización

`ocx update` actualiza OpenCodex en sí; no actualiza el Codex CLI. Utilice el [comandos de inspección del sistema](/es/reference/cli/agents/) para inspeccionar el candidato Codex CLI configurado con inspección de procedencia limitada de solo lectura. `ocx system codex-cli-update check` no consulta un registro de paquetes ni instala una actualización.

### `ocx update [--tag latest|preview]`

Las instalaciones independientes compiladas, incluido el paquete de escritorio MSI Windows, se actualizan a través de **Buscar actualizaciones...** en OpenCodex Desktop, o reinstalando el binario independiente desde [GitHub Lanzamientos](https://github.com/lidge-jun/opencodex/releases). `ocx system update check` reporta `installer: "standalone"`, `canUpdate: false` y `reason: "standalone_install"` con esa guía. `ocx update` sale sin éxito con la misma pista; no ejecuta una actualización de gestor de paquetes para el ejecutable compilado. Una comprobación de fuente genuina todavía reporta `installer: "source"` y `reason: "source_checkout"`.

Cuando OpenCodex se instala a través de mise, este comando sale sin éxito antes de detener el proxy o cambiar los archivos del paquete y muestra `mise upgrade <tool>`, utilizando el alias local mise verificado. Las comprobaciones de actualización permanecen disponibles e informan la instalación como administrada externamente. Un registro de propiedad de mise ilegible o inconsistente provoca el rechazo de la operación sin intentar adivinar el nombre de la herramienta, y `--tag preview` nunca cambia la selección configurada de mise.

En Linux, un servicio en segundo plano cuyo lanzador registrado es el lanzador de paquetes de mise (`<tool>/latest/node_modules/.bin/ocx`, no es una mise shim) sigue `mise upgrade` por sí mismo: dentro de unos diez segundos de la nueva versión se establece, drena las solicitudes activas y se reinicia en ella, y se recupera de la misma manera si mise poda más tarde la versión que estaba ejecutando. En macOS, para un servicio instalado a través de una shim de mise, y para un proxy en primer plano, reinicie el servidor después de actualizar (en macOS, `ocx service repair` primero).

Auto-actualización opencodex de npm. Las instalaciones estables usan `@latest`; las instalaciones de vista previa permanecen en `@preview` a menos que pase `--tag latest|preview`. Detecta una comprobación de origen y le dice que `git pull && bun install` en su lugar, y es una opción prohibida si ya está en la versión más reciente para esa etiqueta. Antes de detener cualquier cosa, las instalaciones npm ejecutan una propiedad de caché Unix limitada y una verificación de acceso. Los enlaces simbólicos anidados se verifican con `lstat` pero no se siguen; Windows omite explícitamente esta comprobación de solo Unix. Un error se aborta mientras la bandeja y el proxy siguen ejecutándose. Un proxy en ejecución se detiene antes de reemplazar los archivos; un servicio instalado se reconstruye y se inicia automáticamente, mientras que una instalación en primer plano imprime `ocx start` como el siguiente paso. Los registros de actualización del panel de control redactan las rutas de perfil/caché y los valores UID/GID antes de que persistan. Cuando la dirección IP literal de un oyente detenido deja caer el dial de vitalidad en lugar de rechazarlo (por ejemplo, en una red Tailscale), el actualizador intenta brevemente vincular esa misma dirección y puerto. Un enlace exitoso confirma la ausencia en ese instante; un enlace fallido o una sonda de nombre de host no concluyente aún impide la actualización.

En Windows, las instalaciones predeterminadas de Scoop `nodejs` y `nodejs-lts` `npm` se pueden usar desde el directorio de inicio del usuario cuando su unión `current` permanece dentro del directorio de la aplicación Node; también se admite el directorio `bin` persistente predeterminado. Ejecutando dentro de esa instalación (incluyendo su directorio de versiones resueltas o persistentes `bin`), las entradas de directorio de versiones `npm`, `NO_JUNCTION` de project-local y las raíces Scoop personalizadas debajo de la casa permanecen excluidas.

Si el paso de instalación falla, la versión anterior permanece instalada y su servicio se reinicia; la salida del terminal nombra el siguiente paso, y [Fallo de actualización en Windows](/es/troubleshooting/update-failed/) cubre terminar la actualización y las carpetas que un intento fallido puede dejar atrás.

```bash
ocx update
ocx update --tag preview
```

Las nuevas versiones estarán disponibles cuando el [Liberar el flujo de trabajo](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml) las publique en npm.

<a id="save-cleanup-thresholds-without-starting-a-cleanup"></a>

## Ahorre umbrales de limpieza sin iniciar una limpieza

```bash
ocx storage policy show --json
ocx storage policy set --archived-bytes-over 1073741824 --reduce-to-bytes 536870912 --json
ocx storage policy show --json
```

El setter escribe anidado `trigger.archivedBytesOver` y un objetivo. Los valores de bytes son enteros no negativos seguros. Alternativamente, elija `--remove-oldest-percent 10` o `--percent 10` heredado; los dos indicadores de porcentaje y reducir a son mutuamente excluyentes. CLI porcentajes son enteros con el servidor-compatible con el rango 1-100. Omitido `--enabled` deja el valor almacenado sin cambios; los valores explícitos son `true` y `false`. El conjunto no se ejecuta en la limpieza, pero un programa ya habilitado permanece vigente. No agregue habilitar o ejecutar una política inmediata a menos que esté previsto.

El recibo de nuevo campo es `{ok:true,policy,job:{status}}`, con el disparador observado, el objetivo, el modo, la programación y los hechos opcionales de última/siguiente ejecución. `job.status` describe un estado inactivo/de funcionamiento existente, no una limpieza iniciada por este commando. Lee de nuevo sobre un resultado desconocido en lugar de reproducir la escritura.

<a id="remote-link-apply-parity"></a>

## Paridad de aplicación de Remote Link

Un Remote Link Child aplica la configuración de Codex administrada por su Home al enlazarse (`ocx link add` en el Home) y en cada `ocx sync`. Tres datos permiten comprobar que el Child realmente usa la configuración aplicada sin leer los archivos de configuración de ninguno de los equipos.

`ocx status --json`, en cualquier dispositivo, incluye:

| Campo | Significado |
| --- | --- |
| `appliedCodexSettingsDigest` | SHA-256 hexadecimal en minúsculas de la configuración aplicada (descrita abajo). En un Child, los valores de la última aplicación registrada. En un Home o una instalación independiente, el documento que sirve actualmente a sus Children, calculado con su configuración actual. Es `null` en un cliente Hub, un Child sin aplicación registrada, o uno cuya aplicación de cambios está en curso o falló (primero se retira el resumen anterior para no informar valores que Codex ya no tiene). |
| `lastApplyAt` | Solo en un Child: milisegundos desde epoch de la última aplicación correcta que cambió los ajustes. Reaplicar los mismos valores conserva la fecha; un `ocx sync` sin cambios nunca fuerza un reinicio. Es `null` en los demás casos. |
| `runtimeStartedAt` | Solo en un Child: milisegundos desde epoch en que arrancó el entorno cliente en ejecución. Es `null` cuando no responde ningún entorno cliente. |

El resumen se calcula sobre este JSON compacto en UTF-8, con las claves exactamente en este orden, sin espacios y con los valores realmente aplicados:

```json
{"version":1,"settings":{"fastMode":true,"multiAgentMode":"v1","webSearchSidecarEnabled":false,"subagentDefaults":null}}
```

`subagentDefaults` es `null` si no se configura; en caso contrario, es `{"model":…,"reasoningEffort":…}` en ese orden. El ejemplo anterior produce `57c751eff89844f93db71a6ee4acdac03afbc29fec52734ade80a40193e826cd`. El resumen no contiene los valores de los ajustes, y el nombre y la versión del Home no forman parte de él: un Home y un Child que aplicaron los mismos valores informan el mismo resumen.

En el Home, cada fila de `ocx link status --json` incluye lo último que declaró el Child: `lastApplyAt`, `runtimeStartedAt`, `appliedCodexSettingsDigest` (con los significados anteriores) y `reportedAt` (milisegundos desde epoch según el reloj del Home). El Child informa poco después del arranque y luego una vez por minuto. El Home solo conserva los informes en memoria: tras reiniciarse, los campos son `null` hasta el siguiente informe. Un Child cuyo entorno arrancó antes de `lastApplyAt` ejecuta un entorno anterior a su última aplicación de ajustes.

<a id="remote-link-child-attestations"></a>

## Atestaciones del Child de Remote Link

Un equipo que envía trabajo a través de un Child de Remote Link puede comprobar dos datos más en
`ocx status --json` del Child. Ambos campos se omiten, nunca son `null`, si no pueden demostrarse.

| Campo | Significado |
| --- | --- |
| `localCredentials` | `{count, generation}`. `count` es el número de credenciales de proveedor que esta instalación guarda en este equipo: cuentas OAuth, entradas de claves API de proveedor (incluidas las deshabilitadas y las referencias al llavero o al entorno), registros del pool de cuentas de Codex, el `auth.json` nativo de Codex y los perfiles nativos inactivos de Codex. No cuentan las claves de enlace, los tokens de administración ni las claves API entrantes, ni tampoco las cuentas que sirve un Home. `generation` es opaco y cambia cada vez que se añade, sustituye o elimina una credencial guardada, aunque el recuento final sea el mismo. Solo se informa mientras haya un entorno de ejecución de OpenCodex activo en este equipo y todos los almacenes puedan leerse por completo. Si la configuración nativa de Codex tiene `cli_auth_credentials_store` con un valor distinto de `file`, se omite. |
| `link.connectionGeneration` | En un Child: es opaco y cambia cada vez que el túnel a su Home se conecta (incluida una reconexión que conserva el mismo enlace) y cada vez que se reinicia cualquiera de los dos entornos de ejecución. Solo se informa cuando el entorno del Child está listo. Para un enlace iniciado desde Home, el Child lo obtiene de la respuesta firmada del Home, por lo que un Home con una versión anterior lo omite. |

Un Child que informa `localCredentials.count` 0, con `localCredentials.generation` y
`link.connectionGeneration` sin cambios durante una solicitud, no tuvo credenciales locales de
proveedor durante ella ni observó ninguna reconexión del túnel.

Para los enlaces añadidos por Home, cada fila incluye además `tunnel`: `attempt`, cantidad de intentos SSH desde la última conexión; `nextRetryAt`, hora ISO del próximo intento o `null` si hay uno activo o no hay ninguno programado; `lastTransition` (`{from, to, at, cause}`) y `lastFailure` (`{cause, at}`). Las causas posibles son `auth`, `hostkey`, `forward`, `remote_forward_conflict`, `timeout`, `network`, `unknown`, `spawn_failed` y `listener_unavailable`. Home guarda estos datos en memoria, por lo que empiezan vacíos tras reiniciarse. `GET /api/link/status` solo incluye el campo con `?diagnostics=1`, porque las versiones antiguas de `ocx link status` rechazan campos desconocidos.

Después de aplicar los ajustes del Home en el Child, `ocx sync` reinicia el entorno cliente si arrancó antes de `lastApplyAt`, mediante el mismo mecanismo de `ocx restart`. No modifica un entorno que ya arrancó después de la aplicación ni inicia uno si no hay ninguno en ejecución. Un reinicio fallido termina con código distinto de cero y deja funcionando el entorno anterior; vuelve a ejecutar `ocx sync` o `ocx restart` para reintentarlo. Dos aplicaciones en un Child nunca se intercalan: un segundo `ocx sync` mientras se aplica otro falla de inmediato y no cambia nada.

<a id="forced-link-revoke-and-remote-recovery"></a>

## Revocación de enlace forzado y recuperación remota

Solo cuando se pretenda explícitamente omitir la limpieza remota, use el ID de enlace seleccionado real (el `lnk_0123456789abcdef` a continuación es ficticio):

```bash
ocx link revoke --link-id lnk_0123456789abcdef --force --yes --json
```

`--force` requiere `--yes`; `--yes` solo no es válido. La revocación ordinaria no cambia. Un éxito forzado regresa `{linkId,remoteCleanup:"skipped",recovery}`. En su lugar, idempotente link-not-found reporta `remoteCleanup:"unverified"`. Ambos pueden salir de 0; estos hechos derivan de la intención CLI, no de un informe de limpieza del servidor. Ninguno de los dos medios de desconexión remota se intentó o confirmó. Siga la instrucción de recuperación, `ocx disconnect` en el cliente remoto, cuando esa acción esté autorizada.

<a id="observe-remote-workspace-from-the-hub"></a>

## Observar el espacio de trabajo remoto desde el Hub

```bash
ocx remote-workspace hub status --json
ocx remote-workspace hub runtimes --json
ocx remote-workspace hub sessions --json
```

Estas lecturas de gestión fija están separadas del ejecutor-local `ocx remote-workspace status`. La disponibilidad en entorno de ejecución es un objeto clave; un concentrador disponible sin dispositivos/sesiones es un éxito vacío. La observación del Hub desactivado puede llegar como HTTP 200 con `available:false` pero sale 1; no es un éxito vacío. El interior HTTP 409 sale por 5. Nunca registra dispositivos, crea sesiones ni envía mensajes. Véase [Observación y recuperación del Hub](/es/guides/remote-workspace/#inspect-the-hub-without-starting-a-session).

<a id="remote-hub-client-lifecycle"></a>

## Ciclo de vida del cliente de Remote Hub

Use `ocx connect <url> --pairing-code-stdin`, `ocx connect status`, `ocx sync` y `ocx connect rotate --pairing-code-stdin`. La descarga inicial del catálogo falla después de cinco segundos sin bytes entrantes, pero las transferencias activas pueden durar más; use `--catalog-timeout <seconds>` (1-120) para anular esa ventana de inactividad. `ocx disconnect` restaura el estado local sin conexión y no revoca la clave de concentrador. Mientras está conectado solamente, `ocx connect revoke --admin-token-stdin` revoca el `apiKeyId` persistente; después de desconectar, use la página **Conecte las llaves → API** del concentrador. Los secretos son solo Stdin y nunca pertenecen a Argv.

<a id="setup-port-validation"></a>

## Validación del puerto de configuración

`ocx init` acepta TCP puertos 1-65535 como números enteros decimales. Presione Enter para usar 10100. La entrada no válida como `0`, `10100oops` o `1.5` nunca se reemplaza o trunca silenciosamente; la configuración la informa y vuelve a solicitar el puerto.

<a id="login-registration-diagnostics"></a>

## Iniciar sesión registro diagnósticos

En Linux, `ocx service install` controles `loginctl show-user <current-user> -p Linger` antes de imprimir el consejo de arranque. La demora habilitada se informa como ya habilitada. La persona desactivada se queda con el `loginctl enable-linger $USER` hint; los diagnósticos faltantes o ilegibles indican la incertidumbre y no fallan la instalación.

En macOS, `ocx service status` distingue un elemento de inicio de sesión de escritorio cargado de un registro válido habilitado en espera del siguiente inicio de sesión. `ocx status` acredita a este último en seguridad de reinicio cuando la misma aplicación de escritorio supervisa actualmente el proxy. Una etiqueta o comando de lista incorrecto, una entrada deshabilitada, una sonda de carga no verificada o una identidad de proceso cambiada aún no pueden obtener protección.

<a id="custom-codex-provider-consent"></a>

## Consentimiento personalizado del proveedor Codex

`ocx codex-provider status` enumera los ID de proveedor aprobados para el hogar seleccionado Codex. `ocx codex-provider allow <id>` pregunta antes de permitir la administración de solo URL en inicio/sincronización; `--yes` es el consentimiento explícito no interactivo para ese proveedor nombrado. `ocx codex-provider revoke <id>` restaura una URL administrada sin cambios y revoca el permiso. Estos comandos son locales y no requieren un proxy en ejecución. Ver [enrutamiento de proveedor personalizado](/es/guides/codex-integration/#opt-in-a-custom-provider-to-managed-local-routing) para elegibilidad, comportamiento de restauración y preservación del transporte.
