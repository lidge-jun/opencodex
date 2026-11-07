---
title: "Mensajería de Codex"
description: "Envía mensajes correlacionados a sesiones de Codex cargadas localmente o mediante pares SSH registrados expresamente."
---

`ocx message sessions` y `ocx message send` son funciones opcionales para sesiones existentes de Codex. No inician un proxy ni un app-server, no reanudan hilos ni instalan skills. Admiten sockets Unix en Linux y macOS; la mensajería local en Windows falla explícitamente. El daemon de Codex existente debe admitir el método experimental `thread/queue/add`. No requieren fijar una versión de la CLI ni seleccionar `CODEX_CLI_PATH`.

El [servidor MCP de colas](#mcp-queue-host) descrito a continuación es independiente: puede dirigirse a UUID de hilos almacenados sin un socket de control. No cambia la restricción de sesiones cargadas de los comandos anteriores.

<a id="mcp-queue-host"></a>

## Servidor MCP de colas

Ejecuta `ocx message mcp` solo cuando quieras que un cliente MCP, como Claude Code o Claude Desktop, descubra hilos almacenados de Codex y les envíe texto a la cola. Este servidor se comunica mediante stdio, no abre ningún listener de red ni se registra automáticamente en clientes. Configura el cliente MCP con una CLI de Codex explícita y un directorio personal existente:

```json
{
  "mcpServers": {
    "opencodex-queue": {
      "command": "ocx",
      "args": [
        "message", "mcp",
        "--codex", "/absolute/path/to/codex",
        "--codex-home", "/absolute/path/to/.codex"
      ]
    }
  }
}
```

Sustituye ambas rutas por las rutas locales reales y usa una ruta absoluta para `ocx` si el cliente no hereda PATH. Esta primera versión admite macOS y Linux; Windows se rechaza explícitamente.

- `codex_threads` enumera como máximo 50 hilos almacenados y no archivados. Para obtener otra página, pasa `nextCursor` como `cursor`. Devuelve identificadores y nombres, sin historial, vista previa ni directorios de trabajo. `liveStateVerified: false` significa que no demuestra que el hilo esté abierto en la aplicación ni listo para procesar un mensaje.
- `codex_queue_message` acepta un UUID exacto `threadId` y un `message`. Envía solo mensajes autorizados por el usuario. El texto junto con la etiqueta fija de par tiene un límite de 16 KiB; se rechazan el texto vacío y NUL. No se adivinan nombres ni se cambia el modelo. Tampoco se conceden permisos ni se generan respuestas automáticas.

Cada llamada a una herramienta inicia por stdio un app-server de corta duración de la CLI de Codex seleccionada explícitamente. Usa `thread/list` o el mismo método experimental `thread/queue/add` que `codex queue`, sin incluir el texto en los argumentos del proceso. No solicita iniciar un daemon, iniciar sesión, reanudar un hilo, empezar un turno ni redirigir un turno activo. El inicio normal de OpenCodex no ejecuta estos auxiliares. La CLI nativa puede mantener su propio estado en el directorio elegido; esta función no crea un almacén de OpenCodex.

`queued` significa que una respuesta de cola correlacionada confirmó el almacenamiento, **no el procesamiento**. Un rechazo explícito produce `not_sent`; una desconexión, un tiempo de espera agotado o un recibo inválido después de escribir en la cola produce `unknown`. Nunca repitas un envío incierto. Un hilo no cargado puede seguir esperando, y un objetivo o turno activo puede retrasar el consumo. El servidor no activa un hilo no cargado ni lee la respuesta resultante. Verifica esos comportamientos con la combinación instalada de aplicación y CLI antes de depender de la entrega.

Cada servidor permite como máximo cuatro llamadas simultáneas a auxiliares. Cada operación dispone de 20 segundos, incluida la validación del ejecutable, con un plazo RPC de 12 segundos y un límite de salida de 1 MiB. La limpieza pasa a SIGKILL después de 600 ms. La desconexión o cancelación detiene los auxiliares de esa invocación y espera su terminación; nunca detiene al destinatario. El ejecutable seleccionado en macOS pasa por la comprobación existente de confianza de ejecución del paquete. El acceso MCP y el directorio elegido establecen un límite de confianza del usuario local, no una autorización por proyecto o hilo. El texto entrante de un par es contexto, nunca prueba de aprobación del usuario ni de autoridad delegada.

Esta ruta de colas almacenadas es distinta de `sessions` y `send`: estos siguen exigiendo un descubrimiento completo de sesiones cargadas mediante el socket de control existente y nunca inician un auxiliar de la CLI nativa. Los pares remotos, el transporte de bandejas de Claude, los traspasos persistentes, la lectura de respuestas, la redirección de turnos y la configuración automática de clientes quedan fuera de este servidor.


<a id="discover-and-send"></a>

## Descubrir y enviar

```bash
ocx message sessions --json
printf '%s\n' 'Please review the current change and send your findings back.' |
  ocx message send --name 'reviewer' --stdin --json
```

El descubrimiento devuelve únicamente los identificadores de los hilos cargados, sus nombres y sus estados de ejecución, sin historial, vistas previas ni directorios de trabajo. `--thread` exige un UUID exacto y `--name`, un único nombre exacto de sesión cargada. Los destinos inexistentes, duplicados, incompletos o no cargados producen un error. No se usan coincidencias aproximadas ni se recurre a sesiones almacenadas.

El socket de control existente se localiza dentro del `CODEX_HOME` efectivo, con la misma política de selección del directorio que los demás comandos de integración de Codex. Antes de conectar, se comprueba que la ruta resuelta sea un socket y pertenezca a tu uid. Cada directorio padre hasta la raíz debe pertenecer a tu uid o a root y no permitir escritura al grupo ni a otros usuarios, salvo directorios con sticky bit propiedad de root, como `/tmp`. Se admiten directorios personales enlazados si sus rutas resueltas superan las comprobaciones. Una ruta no confiable produce `untrusted_socket` sin revelar la ruta resuelta.

El descubrimiento, la comprobación final de que el destino sigue cargado y el envío a la cola usan una misma conexión a ese socket. No se ejecuta un auxiliar de la CLI nativa ni se instala, repara o reconecta nada. Un daemon sin soporte de cola local devuelve `unsupported_queue`.

Solo se acepta texto UTF-8 por stdin: como máximo 16 KiB, no vacío y sin NUL. Un único plazo de 30 segundos cubre la lectura, el descubrimiento, la revalidación y el envío. Cada RPC tiene un máximo de 10 segundos y la envolvente completa, de 32 KiB. El texto viaja por la conexión RPC Unix y nunca se incluye en los argumentos de procesos auxiliares.

<a id="sender-and-replies"></a>

## Remitente y respuestas

El wrapper genera un UUID para el mensaje y adjunta el identificador y el nombre del remitente a partir de un `CODEX_THREAD_ID` cargado y los metadatos del daemon. Este contexto **no autentica la autoridad del par** y nunca constituye aprobación del usuario ni permite elevar privilegios. Si el remitente declarado es inválido o no está cargado, la operación falla. Si falta el contexto, queda como desconocido y no se inventa una ruta de respuesta. Los mensajes de pares se encolan como texto, no como aprobaciones de permisos ni cambios de configuración. El entorno del agente receptor aplica sus permisos; las instrucciones de la envolvente no establecen una barrera técnica de autorización ni garantizan el comportamiento del modelo.

El tipo predeterminado es `request`. Contesta usando el `replyCommand` generado en el sobre, o correlaciona explícitamente una respuesta:

```bash
printf '%s\n' 'Review findings: ...' |
  ocx message send --thread <sender-thread-uuid> --kind response \
    --in-reply-to <request-message-uuid> --stdin --json
```

`response` requiere `--in-reply-to`; los demás tipos lo rechazan. Usa `--kind notification` para informar sin pedir respuesta. Las respuestas y notificaciones no solicitan acuses de recibo. La respuesta final normal de un agente no se envía a su par; nunca deben inventarse rutas que falten. No se modifican los prompts globales ni se crean bucles de confirmación.

<a id="receipts-and-exit-codes"></a>

## Recibos y códigos de salida

`--json` emite un recibo versionado (`ocx-message/1`) que contiene el mensaje UUID, tipo, correlación de respuesta, metadatos de remitente/objetivo y estado de envío. Nunca incluye el texto del cuerpo o la salida del demonio en bruto. Fallos de entrada/configuración antes de que exista un recibo, use `ocx-message-error/1` con `not_sent`; los fallos de detección usan el mismo esquema de error sin un estado de envío. El uso no válido sale 64 en stderr antes de E/S.

| Situación | Salir | Descripción |
| --- | --- | --- |
| `not_sent` | 1 | Validación/descubrimiento/revalidación falló, no se escribió ningún marco de cola o el demonio lo rechazó explícitamente. |
| `queued` | 0 | Una respuesta de demonio correlacionada reconoció la presentación, **no procesamiento** por el destinatario. |
| `unknown` | 3 | El mensaje puede haberse enviado a la cola, pero se perdió el acuse de recibo, estaba malformado, no correspondía a la solicitud o se canceló la operación. **No vuelvas a enviar el mensaje.** |

El UUID de mensaje de aplicación es también el `clientUserMessageId` de la petición de cola. El ID de envío del daemon está separado; ninguno de los dos demuestra el procesamiento del destinatario. La cola no es la dirección y puede esperar a que un giro ocupado para terminar. OpenCodex no realiza ninguna repetición automática, sondeo de seguimiento, persistencia o monitoreo de entrega. La comprobación final del objetivo cargado y la presentación de la cola no son atómicas: si el objetivo se descarga después, un rechazo explícito es `not_sent` con `queue_rejected`; una respuesta perdida o inválida es `unknown`. OpenCodex no lo reanuda ni vuelve a intentarlo.

<a id="explicit-remote-peers"></a>

## Pares remotos explícitos

La mensajería remota es independiente de Remote Link y del inicio normal del proxy. No redirige proveedores, no comparte sus credenciales ni inicia un daemon nativo. Ambos nodos necesitan una CLI OpenCodex compatible y un daemon existente que admita colas. Linux cuenta con pruebas aisladas de interoperabilidad. macOS requiere una validación propia. El transporte remoto en Windows no está soportado.

En cada nodo, habilite explícitamente la mensajería. En el nodo receptor, mantenga el propietario en primer plano en ejecución:

```bash
ocx message enable --port 39176 --json
ocx message serve --json
```

En el nodo de inicio, use su destino/alias OpenSSH existente. Verifique la huella digital ofrecida contra una fuente confiable antes de confirmarla:

```bash
ocx message hosts probe --ssh worker --json
ocx message hosts add worker --ssh worker --fingerprint 'SHA256:<confirmed-key>' --json
ocx message hosts list --json
ocx message serve --host worker --json
```

Los registros de sondeo privados mantienen su formato prefijado por alias incluso cuando su configuración SSH normal habilita `HashKnownHosts`; su archivo known_hosts normal no cambia. Cada intento de inscripción utiliza su propio archivo de rascado de clave fija calificado para la transacción, eliminado después de que su ayudante SSH se resuelva, incluidos los fallos, sin depender del bloqueo del propietario de otra mutación. Si la limpieza no se puede confirmar, el comando informa de un resultado de almacenamiento desconocido, no de éxito. El diario de recuperación está separado.

`hosts add worker` autoriza mensajes salientes desde este nodo iniciador hacia el `worker` registrado; **no concede acceso entrante arbitrario a las sesiones locales del iniciador**. El intercambio de control SSH autoriza esa dirección de salida en el receptor mediante tu sesión SSH existente. El recibo de inscripción y `hosts list` muestran la política de entrada local de cada nodo. En el iniciador, la política predeterminada es `responses-only`: el par solo puede ver y responder a las sesiones locales originales que esperan una respuesta correlacionada a una solicitud enviada por este nodo. La respuesta debe coincidir con el UUID de solicitud, la inscripción y el destino local original; no puede dirigirse a otra sesión ni convertirse en una solicitud o notificación no solicitada.

Para conceder un acceso más amplio en cualquiera de los nodos, ejecute explícitamente en ese nodo:

```bash
ocx message hosts allow-inbound <peer-alias-or-machine-uuid> --json
# Withdraw the broad grant without removing enrollment:
ocx message hosts deny-inbound <peer-alias-or-machine-uuid> --json
```

`allow-inbound` concede expresamente el acceso más amplio: permite los tres tipos de mensaje en **cualquier sesión local cargada de Codex** y expone a ese par los metadatos de su directorio. No es un permiso limitado a respuestas. Los cambios de consentimiento se aplican a las conexiones existentes antes de posteriores lecturas o envíos. Los registros antiguos sin una política local de entrada usan `responses-only` de forma predeterminada. Cada proceso propietario en primer plano admite como máximo 256 solicitudes de respuesta pendientes; las rutas caducan a las 24 horas o al retirar o reiniciar el proceso propietario. Si no hay contexto del remitente, no hay ruta de respuesta. Una respuesta encolada o incierta consume su ruta; un rechazo nativo confirmado no. Si la ruta se pierde o caduca, el operador y el remitente deben reconciliar el estado de forma explícita, sin repetición automática.

Cada `serve` es propiedad de primer plano: manténgalo en funcionamiento y use un terminal separado para la mensajería. A lo sumo se pueden suministrar cuatro selecciones de `--host` distintas. Nada instala un servicio o inicia un propietario automáticamente. SSH utiliza claves de host ancladas confirmadas y sus claves/agente configurados; las solicitudes de contraseña están deshabilitadas. La envoltura posee rutas de retorno y de avance solo de bucle, por lo que el nodo receptor puede enviar respuestas correlacionadas sin un inicio de sesión SSH al iniciador, sujeto a la política anterior.

```bash
ocx message status --json
ocx message sessions --host worker --json
printf '%s\n' 'Please review and reply using the supplied route.' |
  ocx message send --host worker --name reviewer --stdin --json
```

`--host` selecciona un alias inscrito exacto o UUID de máquina. Los comandos de respuesta incluyen el UUID de máquina de origen validado y el UUID de subproceso; la identidad de origen se resuelve en el demonio de origen, no se adivina desde un directorio remoto. Sin el contexto del remitente, no hay un comando de respuesta inventado. Los comandos locales sin `--host` conservan su ruta sin estado/sin SSH/sin oyente. El receptor valida la envolvente canónica completa contra el UUID de máquina y mensaje nativo autenticado, incluyendo el host/comando de respuesta y la guía de pares estándar. Un par no puede etiquetar el envoltorio como otro equipo u omitir su advertencia de no mensaje de usuario. Los nombres de sesión y los identificadores de subproceso siguen siendo reclamos descriptivos de esa máquina, no autenticación por sesión.

Las capacidades direccionales emitidas por el receptor se guardan en el estado privado de mensajería bajo `OPENCODEX_HOME` o el directorio de configuración predeterminado de OpenCodex. Nunca aparecen en la salida habitual de comandos, argumentos auxiliares, URL ni sobres de mensajes. Las pruebas mutuas autentican la conexión WebSocket real antes de aceptar tramas nativas o el cuerpo del mensaje. Una comprobación de salud por separado no demuestra la identidad del par. Este es un protocolo de pasarela de OpenCodex: `codex queue --remote` por sí solo no implementa su autenticación. La pasarela usa el mismo contrato nativo experimental `thread/queue/add` y no modifica `--ws-auth` de Codex, su configuración ni sus listeners nativos con token bearer. Solo expone metadatos de hilos cargados y colas de texto, no el control general del app-server.

El estado distingue la configuración habilitada, un propietario en ejecución y rutas iniciadas/alquiladas. Los arrendamientos de devolución caducan después de 25 segundos sin actualizar; no son recibos de entrega o procesamiento. La pérdida de una ruta o el cambio de configuración del propietario requiere un reinicio explícito del propietario. La recuperación del transporte nunca reenvía un mensaje incierto.

```bash
ocx message hosts remove worker --json
ocx message disable --json
```

La eliminación revoca la admisión local primero; una limpieza remota no confirmada termina con código de salida 3 y también requiere la eliminación de ese par. Cada eliminación saliente utiliza un archivo temporal independiente para la clave fijada; un fallo en la preparación de ese archivo aún informa la eliminación local y la limpieza remota no confirmada. La limpieza de ese archivo temporal se intenta tanto si la operación tiene éxito como si falla. La guía de limpieza generada utiliza `hosts remove <machine-uuid> --transaction <enrollment-uuid> --json`; el guardia de transacciones rechaza un recibo antiguo en lugar de eliminar una inscripción más reciente. La eliminación ordinaria sin este protector opcional sigue eliminando el par seleccionado actualmente. Deshabilitar retira la generación actual del propietario; el despacho rechaza el nuevo trabajo inmediatamente, y el propietario en primer plano nota una configuración cambiada dentro de su intervalo de mantenimiento de diez segundos. El remitente vuelve a verificar la autoridad local inmediatamente antes del envío; la revocación tras el envío no puede retirar un mensaje en tránsito o un trabajo nativo ya aceptado. Una respuesta de inscripción perdida retiene una transacción privada: repita exactamente el mismo comando add para reconciliar, en lugar de inscribirse con otro nombre dentro de la misma generación habilitada. Deshabilitar/rehabilitar o cambios de puerto invalidan esa generación de recuperación. Las transacciones completadas o revocadas no pueden restaurar un par eliminado ni borrar el registro de recuperación de otra inscripción. Si el diario local guardado contiene JSON mal formado, registros con una estructura inválida o valores de campo inválidos, `hosts add`, `hosts list`, `status` y `hosts abandon` se rechazan con `invalid_enrollment_journal`. Sus bytes se conservan para la recuperación explícita del operador; OpenCodex no lo repara, reemplaza o elimina automáticamente. `hosts add` no envía ninguna solicitud de control de inscripción en este caso, aunque puede ejecutarse su sonda de clave de anfitrión preliminar. El almacenamiento inseguro o un bloqueo de mutación ocupado conserva su clasificación de error separada. Si un diario válido ya no se puede conciliar, inspeccione `ocx message hosts list --json` o `ocx message status --json` para `pendingEnrollment` (alias, UUID de transacción y si su generación es obsoleta), luego abandone explícitamente ese diario local exacto:

```bash
ocx message hosts abandon --transaction <pending-transaction-uuid> --json
```

Abandonar la transacción también funciona cuando la función está desactivada. Conserva los pares existentes, no reintenta la inscripción y termina con código 3 porque la limpieza remota no está confirmada. Si queda una inscripción huérfana, sigue las instrucciones de limpieza en el nodo remoto. Los diarios obsoletos no se borran silenciosamente. Un receptor lleno devuelve `peer_capacity` sin inscribir al par: libera un espacio y repite la misma transacción o abandónala explícitamente. Las respuestas de control perdidas o mal formadas mantienen el resultado incierto. Se aceptan directorios de configuración existentes, confiables y con permisos 0755 sin ejecutar chmod; el subdirectorio de mensajería sigue siendo privado. Un reinicio inmediato del proceso propietario puede reemplazar una concesión de retorno obsoleta cuando el nuevo endpoint se autentica y el anterior deja de hacerlo dentro de una comprobación de un segundo. Un endpoint anterior que todavía se autentica conserva su concesión hasta que venza; una falta temporal de acceso puede permitir el relevo, pero no la repetición. La pérdida inesperada del túnel retira visiblemente al propietario en primer plano; eliminar un par de forma deliberada deja funcionando las rutas no relacionadas. Los bloqueos de modificación que quedan tras un fallo impiden continuar y requieren recuperación del operador; el envoltorio nunca supone que un bloqueo antiguo fue abandonado. La publicación del estado y del diario de recuperación sincroniza el archivo y su directorio antes del trabajo remoto dependiente; eliminar el diario también sincroniza el directorio. `remote_storage_unknown` (salida 3) significa que no se pudo confirmar la persistencia del cambio de almacenamiento ante un fallo. En macOS, un rechazo de ACL o un fallo del sondeo después de reemplazar el archivo también produce este código: el estado nuevo ya es visible, pero su privacidad mediante ACL y su persistencia ante un fallo siguen sin confirmarse. Inspecciona el estado y los permisos antes de realizar una recuperación explícita; no reintentes ni reviertas automáticamente. Un diario que se puede leer de forma segura, pero contiene JSON o un esquema mal formado, no impide eliminar pares y se conserva para la recuperación del operador. El almacenamiento inseguro o la imposibilidad de invalidar un diario coincidente siguen impidiendo la eliminación.

El propietario en primer plano comparte límites finitos de conexiones, solicitudes, procesos auxiliares y memoria entre todos los pares, y rechaza la sobrecarga sin una cola ilimitada. Los pares inscritos juntos pueden mantener doce conexiones autenticadas; otras cuatro quedan reservadas para el control, las comprobaciones salientes y la renovación del propietario. Se permiten como máximo ocho procesos de túnel y dos auxiliares transitorios de control o inspección: diez en total. La preparación de todo el lote de pares elegido tiene un límite de 30 segundos. Si SSH informa de que se perdió un puerto de reenvío seleccionado, se cierra el par administrado y se eligen puertos nuevos, con un máximo de tres intentos dentro del mismo plazo. Deben completarse la confirmación del reenvío SSH, las comprobaciones de loopback y la preparación autenticada del par. Otros fallos de preparación detienen el proceso de inmediato; las rutas publicadas no se reconectan automáticamente.

Antes de confirmar el inicio se renueva por última vez la autorización temporal. Los lotes de renovación final y periódica tienen plazos de cinco segundos, incluidos en el plazo de preparación cuando corresponda; el mantenimiento periódico se ejecuta cada diez segundos. Cancelar detiene solo los procesos y listeners SSH administrados: conserva los daemons de Codex, los hilos y los proxies ajenos. La limpieza también espera las rutas de túnel retiradas. La terminación de los procesos hijos directos y el EOF natural de sus tuberías deben confirmarse dentro de tres segundos; si no, la limpieza sigue incompleta y se mantiene la reserva de recursos del auxiliar. Cancelar tuberías retenidas no demuestra que sus descendientes hayan terminado. No se rastrean descendientes separados o que cierren las tuberías heredadas.

La captura de stdout del auxiliar se limita a 64 KiB; stderr se descarta sin mostrarlo ni guardarlo. Si se supera el límite, el auxiliar se detiene y se drena la salida descartada hasta su EOF natural. Una limpieza completa informa del error de salida original; una incompleta mantiene `cleanup_incomplete` y la reserva de recursos del auxiliar. Los procesos con el mismo uid pueden leer el estado privado de inscripción: la autenticación de la máquina no establece una identidad infalsificable para cada agente. El tráfico nativo que evite esta pasarela queda fuera de su control.

Malla, controles de panel/caché, aislamiento, mensajería Claude, habilidades administradas y notificaciones inactivas permanecen fuera de esta contribución.
