---
title: "Codex Mensajería"
description: "Cola de mensajes correlacionados con sesiones Codex cargadas localmente o a través de pares SSH explícitos."
---

`ocx message` es una superficie opt-in para Codex sesiones existentes. No inicia ningún proxy o servidor de aplicaciones, no reanuda ningún hilo ni instala ninguna habilidad. Linux / macOS Sockets Unix son compatibles; Windows falla explícitamente. El demonio Codex existente debe soportar el experimento `thread/queue/add`. No se requiere un pin de versión CLI o selección `CODEX_CLI_PATH`.

<a id="discover-and-send"></a>

## Descubrir y enviar

```bash
ocx message sessions --json
printf '%s\n' 'Please review the current change and send your findings back.' |
  ocx message send --name 'reviewer' --stdin --json
```

Discovery devuelve solo ID de subproceso cargados, nombres y estados en entorno de ejecución, no historial, Vista previa o directorios de trabajo. Utilice una UUID exacta (`--thread`) o una única exacta nombre (`--name`) Los destinos faltantes, duplicados, incompletos o descargados fallan; no hay coincidencia difusa o retroceso a las sesiones almacenadas.

El socket de control existente se resuelve bajo `CODEX_HOME` efectivo, usando la misma política de inicio que otros comandos de integración Codex. Antes de conectar, el socket resuelto debe ser propiedad de su uid y ser un socket. Cada padre real a través de root debe ser propiedad de su uid o root y no debe ser escribible en grupo u otro, excepto los directorios sticky propiedad de root como `/tmp`. Se permiten casas conectadas cuando pasan sus caminos resueltos. Las rutas no confiables fallan con `untrusted_socket` y sin detalles de ruta resuelta.

Discovery, la comprobación final de destino cargado y la cola usan una conexión a ese socket. No se produce ningún ayudante nativo CLI, instalación, reparación o reconexión. Un demonio sin soporte de cola local devuelve `unsupported_queue`.

Solo se acepta UTF-8 stdin, como máximo 16 KiB de texto no vacío sin NUL. Una fecha límite de 30 segundos cubre la entrada, el descubrimiento, la revalidación y la presentación. Cada RPC tiene un límite de 10 segundos. El sobre completo está limitado a 32 KiB. El texto del mensaje se envía a través de la conexión RPC de Unix y nunca se coloca en los argumentos de proceso generados.

<a id="sender-and-replies"></a>

## Remitente y respuestas

La envoltura genera un UUID de mensaje y adjunta el ID/nombre del remitente a partir de metadatos `CODEX_THREAD_ID` y daemon cargados. Este contexto **no constituye una autoridad de pares autenticada** y nunca otorga aprobación o escalamiento al usuario. Un remitente reclamado no válido/descargado falla; el contexto ausente permanece desconocido, sin adivinar una ruta de respuesta. Los mensajes de pares se ponen en cola como texto, no como aprobaciones de permisos o anulaciones de configuración. El arnés del agente receptor hace cumplir sus permisos; la guía del sobre no es un límite de autorización técnica o una garantía del comportamiento del modelo.

El tipo predeterminado es `request`. Contesta usando el `replyCommand` generado en el sobre, o correlaciona explícitamente una respuesta:

```bash
printf '%s\n' 'Review findings: ...' |
  ocx message send --thread <sender-thread-uuid> --kind response \
    --in-reply-to <request-message-uuid> --stdin --json
```

`response` requiere `--in-reply-to`; otros tipos lo rechazan. Utilice `--kind notification` para un FYI. Responses y las notificaciones no solicitan reconocimientos. Una respuesta final normal del agente no se envía de vuelta a su compañero; las rutas faltantes no deben adivinarse. No se introducen cambios globales de solicitud ni bucles de acuse de recibo.

<a id="receipts-and-exit-codes"></a>

## Recepción y códigos de salida

`--json` emite un recibo versionado (`ocx-message/1`) que contiene el mensaje UUID, tipo, correlación de respuesta, metadatos de remitente/objetivo y estado de envío. Nunca incluye el texto del cuerpo o la salida del demonio en bruto. Fallos de entrada/configuración antes de que exista un recibo, use `ocx-message-error/1` con `not_sent`; los fallos de detección usan el mismo esquema de error sin un estado de envío. El uso no válido sale 64 en stderr antes de E/S.

| Situación | Salir | Descripción |
| --- | --- | --- |
| `not_sent` | 1 | Validación/descubrimiento/revalidación falló, no se escribió ningún marco de cola o el demonio lo rechazó explícitamente. |
| `queued` | 0 | Una respuesta de demonio correlacionada reconoció la presentación, **no procesamiento** por el destinatario. |
| `unknown` | 3 | El mensaje puede haberse enviado a la cola, pero se perdió el acuse de recibo, estaba malformado, no correspondía a la solicitud o se canceló la operación. **No vuelvas a enviar el mensaje.** |

El UUID de mensaje de aplicación es también el `clientUserMessageId` de la petición de cola. El ID de envío del daemon está separado; ninguno de los dos demuestra el procesamiento del destinatario. La cola no es la dirección y puede esperar a que un giro ocupado para terminar. OpenCodex no realiza ninguna repetición automática, sondeo de seguimiento, persistencia o monitoreo de entrega. La comprobación final del objetivo cargado y la presentación de la cola no son atómicas: si el objetivo se descarga después, un rechazo explícito es `not_sent` con `queue_rejected`; una respuesta perdida o inválida es `unknown`. OpenCodex no lo reanuda ni vuelve a intentarlo.

<a id="explicit-remote-peers"></a>

## Pares remotos explícitos

La mensajería remota es independiente del enlace remoto y el inicio proxy normal. No redirige proveedores, comparte credenciales de proveedores o inicia un demonio nativo. Ambos nodos necesitan un OpenCodex CLI compatible y un demonio con capacidad de cola existente. Linux tiene pruebas aisladas de interoperabilidad; macOS requiere su propia calificación. Windows el transporte remoto no es compatible.

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

`hosts add worker` autoriza mensajes salientes a `worker`, **mensajes no arbitrarios en este nodo de inicio**. El intercambio de control SSH autoriza esa dirección de salida en el nodo receptor usando su inicio de sesión SSH existente. El recibo de inscripción y `hosts list` muestran la política de entrada local de cada nodo. En el nodo iniciador, el valor predeterminado es `responses-only`: el par puede ver y responder solo a las sesiones de remitente local originales que esperan una respuesta correlacionada a una solicitud enviada por este nodo. Una respuesta debe coincidir con el UUID de solicitud, la inscripción y el destino local original; no puede dirigirse a otra sesión ni convertirse en una solicitud/notificación no solicitada.

Para conceder un acceso más amplio en cualquiera de los nodos, ejecute explícitamente en ese nodo:

```bash
ocx message hosts allow-inbound <peer-alias-or-machine-uuid> --json
# Withdraw the broad grant without removing enrollment:
ocx message hosts deny-inbound <peer-alias-or-machine-uuid> --json
```

`allow-inbound` permite los tres tipos de mensajes en **cualquier sesión local cargada Codex** y expone sus metadatos de directorio a ese par. No es una subvención de solo respuestas. Los cambios de consentimiento se aplican a las conexiones existentes antes de lecturas/envíos posteriores. Los registros más antiguos sin una política de entrada local tienen por defecto `responses-only`, no un acceso amplio. Las rutas de respuesta están limitadas a 256 solicitudes pendientes por propietario en primer plano y caducan después de 24 horas o el retiro / reinicio del propietario. Ningún contexto de remitente significa ninguna ruta de respuesta. Una respuesta en cola o incierta consume su ruta; un rechazo nativo definido no lo hace. Una ruta caducada/perdida requiere una reconciliación explícita entre el operador y el remitente, nunca una repetición automática.

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

La eliminación revoca la admisión local primero; una limpieza remota no confirmada sale de 3 y también requiere la eliminación de ese par. Cada eliminación saliente utiliza un archivo independiente de scratch de clave fija; un fallo en la preparación de ese archivo aún informa la eliminación local y la limpieza remota no confirmada. La limpieza de rasguños se intenta tanto en el éxito como en el fracaso. La guía de limpieza generada utiliza `hosts remove <machine-uuid> --transaction <enrollment-uuid> --json`; el guardia de transacciones rechaza un recibo antiguo en lugar de eliminar una inscripción más reciente. La eliminación ordinaria sin este protector opcional sigue eliminando el par seleccionado actualmente. Deshabilitar retira la generación actual del propietario; el despacho rechaza el nuevo trabajo inmediatamente, y el propietario en primer plano nota una configuración cambiada dentro de su intervalo de mantenimiento de diez segundos. El remitente vuelve a verificar la autoridad local inmediatamente antes del envío; la revocación tras el envío no puede recordar un mensaje en vuelo o un trabajo nativo ya aceptado. Una respuesta de inscripción perdida retiene una transacción privada: repita exactamente el mismo comando add para reconciliar, en lugar de inscribirse con otro nombre dentro de la misma generación habilitada. Deshabilitar/rehabilitar o cambios de puerto invalidan esa generación de recuperación. Las transacciones completadas o revocadas no pueden restaurar un par eliminado ni borrar el registro de recuperación de otra inscripción. Si el diario local guardado ha malformado JSON, las formas de registro o los valores de campo, `hosts add`, `hosts list`, `status` y `hosts abandon` se desechan con `invalid_enrollment_journal`. Sus bytes se conservan para la recuperación explícita del operador; OpenCodex no lo repara, reemplaza o elimina automáticamente. `hosts add` no envía ninguna solicitud de control de inscripción en este caso, aunque puede ejecutarse su sonda de clave de anfitrión preliminar. El almacenamiento inseguro o un bloqueo de mutación ocupado conserva su clasificación de error separada. Si un diario válido ya no se puede conciliar, inspeccione `ocx message hosts list --json` o `ocx message status --json` para `pendingEnrollment` (alias, UUID de transacción y si su generación es obsoleta), luego abandone explícitamente ese diario local exacto:

```bash
ocx message hosts abandon --transaction <pending-transaction-uuid> --json
```

Abandonar la transacción también funciona cuando la función está desactivada. Conserva los pares existentes, no reintenta la inscripción y termina con código 3 porque la limpieza remota no está confirmada. Si queda una inscripción huérfana, sigue las instrucciones de limpieza en el nodo remoto. Los diarios obsoletos no se borran silenciosamente. Un receptor lleno devuelve `peer_capacity` sin inscribir al par: libera un espacio y repite la misma transacción o abandónala explícitamente. Las respuestas de control perdidas o mal formadas mantienen el resultado incierto. Se aceptan directorios de configuración existentes, confiables y con permisos 0755 sin ejecutar chmod; el subdirectorio de mensajería sigue siendo privado. Un reinicio inmediato del proceso propietario puede reemplazar una concesión de retorno obsoleta cuando el nuevo endpoint se autentica y el anterior deja de hacerlo dentro de una comprobación de un segundo. Un endpoint anterior que todavía se autentica conserva su concesión hasta que venza; una falta temporal de acceso puede permitir el relevo, pero no la repetición. La pérdida inesperada del túnel retira visiblemente al propietario en primer plano; eliminar un par de forma deliberada deja funcionando las rutas no relacionadas. Los bloqueos de modificación que quedan tras un fallo impiden continuar y requieren recuperación del operador; el envoltorio nunca supone que un bloqueo antiguo fue abandonado. La publicación del estado y del diario de recuperación sincroniza el archivo y su directorio antes del trabajo remoto dependiente; eliminar el diario también sincroniza el directorio. `remote_storage_unknown` (salida 3) significa que no se pudo confirmar la persistencia del cambio de almacenamiento ante un fallo. En macOS, un rechazo de ACL o un fallo del sondeo después de reemplazar el archivo también produce este código: el estado nuevo ya es visible, pero su privacidad mediante ACL y su persistencia ante un fallo siguen sin confirmarse. Inspecciona el estado y los permisos antes de realizar una recuperación explícita; no reintentes ni reviertas automáticamente. Un diario que se puede leer de forma segura, pero contiene JSON o un esquema mal formado, no impide eliminar pares y se conserva para la recuperación del operador. El almacenamiento inseguro o la imposibilidad de invalidar un diario coincidente siguen impidiendo la eliminación.

El propietario en primer plano comparte límites finitos de conexión/solicitud/ayudante/memoria intermedia entre todos los pares y rechaza la sobrecarga sin una cola ilimitada: los pares inscritos juntos pueden contener doce conexiones autenticadas, cuatro más permanecen reservadas para el propio control del propietario, sondas salientes y renovación, y como máximo ocho hijos de túnel y dos ayudantes de control/inspección transitorios, diez en total. La configuración está limitada por 30 segundos en todo el lote de pares seleccionado. Una renovación final del contrato de arrendamiento precede al éxito del inicio; los lotes de renovación final y periódica tienen plazos de cinco segundos, dentro de la fecha límite de configuración cuando corresponda, y el mantenimiento periódico se ejecuta cada diez segundos. La cancelación deja solo a los ayudantes / oyentes de SSH; deja solos a los demonios, hilos y proxies no relacionados con Codex. La limpieza también se une a las rutas de túnel retiradas. Direct - la salida del niño y la tubería natural EOF deben establecerse dentro del techo de limpieza de tres segundos; de lo contrario, la limpieza está incompleta y la reserva de ayudante permanece cargada. La cancelación de las tuberías retenidas no prueba que los descendientes hayan salido. Los descendientes separados o descendientes que cierran pipas heredadas no son rastreados. La captura de Stdout Helper está limitada a 64 KiB; stderr se descarta sin ser impreso o almacenado. Después del desbordamiento de captura, el ayudante se detiene y la salida descartada se drena a EOF natural. La limpieza exitosa informa el error de salida original; la limpieza genuinamente incompleta sigue siendo `cleanup_incomplete` y mantiene su reserva de ayudante cargada. Los procesos del mismo uid pueden leer el estado de inscripción privada; la autenticación de máquina no establece una identidad por agente no falsificable. El tráfico nativo que pasa por alto esta puerta de enlace no está controlado por ella.

Malla, controles de panel/caché, aislamiento, mensajería Claude, habilidades administradas y notificaciones inactivas permanecen fuera de esta contribución.
