---
title: "Espacio de trabajo remoto"
description: "Mantenga Codex, Claude Code, Pi y sus inicios de sesión en un concentrador OCX mientras que los equipos solo OCX proporcionan el espacio de trabajo y el entorno de compilación."
---

Para enlaces de máquinas SSH, véase [Enlace remoto](/es/guides/remote-link/).

Remote Workspace permite que un OpenCodex Hub ejecute sus agentes de codificación, mientras que otro equipo suministra los archivos del proyecto, comandos, pruebas y compilación. Un teléfono o un tercer ordenador pueden controlar la sesión a través del panel de control de Hub.

```text
Phone browser -> Computer 1 OCX Hub -> encrypted channel -> Computer 2 OCX Executor
                 Codex / Claude / Pi                       project and commands
                 logins and sessions                      no coding CLI login
```

El ejecutor solo necesita OpenCodex. No necesita Codex, Claude Code, Pi, un inicio de sesión ChatGPT o una clave API del proveedor. Abre un WebSocket saliente al concentrador, por lo que el ejecutor no necesita ningún puerto público o router.

:::caution[Base experimental]
Remote Workspace requiere activación explícita y todavía no es un despliegue de producción. Linux ofrece herramientas de archivos y ejecución condicional de comandos mediante bubblewrap. Windows y macOS solo ofrecen herramientas de archivos: sus auxiliares nativos oficiales rechazan tanto las pruebas como las solicitudes de comandos. Los comandos de Windows seguirán sin admitirse hasta contar con un responsable verificado del ciclo de vida que conserve la autoridad de limpieza incluso durante la cancelación. Los comandos no admitidos se rechazan y nunca se ejecutan como alternativa en el Hub.
:::

<a id="rpc-compatibility-and-timeouts"></a>

## Compatibilidad con RPC y tiempos de espera

El espacio de trabajo remoto utiliza RPC v2 encriptado. El Hub y cada Ejecutor deben soportar v2; Los pares de RPC v1 fallan en lugar de volver a la ejecución inmediata, así que actualice el concentrador y los ejecutores juntos.

Un tiempo de espera solicita la cancelación del ejecutor, pero no lo confirma. Una subvención puede estar ya en tránsito, o su funcionamiento puede estar ya en ejecución. El tiempo de espera predeterminado de RPC es de 65 segundos, y `timeoutMs` acepta valores inclusivos de 1 a 120,000 milisegundos.

<a id="set-up-the-hub"></a>

## Configurar el Hub

El ordenador 1 posee cada inicio de sesión de agente de codificación y cada sesión de modelo. Instale e inicie sesión en los agentes que desee usar allí, luego ejecute OpenCodex como un Hub:

```bash
ocx config set runtimeRole hub
OCX_REMOTE_WORKSPACE_ENABLED=1 ocx start
ocx gui
```

Configure `OCX_REMOTE_WORKSPACE_ENABLED=1` en el proceso Hub en sí; configurarlo solo para un comando de panel de control no habilita un servicio ya en ejecución. Un Hub sin opt-in explícito devuelve el estado deshabilitado sin crear claves de espacio de trabajo ni sondear los tiempos de ejecución del agente de codificación.

Utilice una implementación HTTPS autenticada cuando abra el panel de control desde un teléfono u otro equipo. Véase [Implementación remota de Hub](/es/guides/remote-hub/) para el patrón de integración de gestión y Tailscale admitidos. No publique un puerto de panel local no autenticado.

Codex Remote Workspace utiliza los perfiles de permisos actuales de App Server. Si la configuración seleccionada del Hub Codex todavía establece el legado `sandbox_mode` o `sandbox_workspace_write`, el panel de control informa que Codex no está disponible en lugar de comenzar con un límite más débil. Migre ese perfil Codex antes de usar la función; no configure tanto el sandbox heredado como un perfil de permisos.

<a id="inspect-the-hub-without-starting-a-session"></a>

## Inspeccione el Hub sin iniciar una sesión

```bash
ocx remote-workspace hub --help
ocx remote-workspace hub status --json
ocx remote-workspace hub runtimes --json
ocx remote-workspace hub sessions --json
```

Estos utilizan el concentrador de gestión en ejecución seleccionado. El `remote-workspace status` existente sigue leyendo el estado del Ejecutor local. Devuelve el estado `{available:true,devices,runtimes,sessions}`; devuelve el entorno de ejecución `{runtimes:{codex:{available,...},claude:{available,...},pi:{available,...}}}`; devuelve las sesiones `{sessions:[...]}`. La disponibilidad en entorno de ejecución es un objeto, no una matriz, y su comprobación puede probar la disponibilidad ejecutable. Las raíces del dispositivo exponen los ID y las etiquetas, no las rutas del sistema de archivos del Ejecutor. Las sesiones incluyen eventos públicos recientes; la salida del terminal humano escapa a los caracteres de control.

Un concentrador disponible con el dispositivo/sesión vacío muestra las salidas 0. Cuando la activación de Hub está desactivada, el despachador externo puede devolver HTTP 200 con `available:false`, dispositivos y sesiones vacíos y `runtimes:{}`. El CLI emite esa estrecha observación no disponible con una instrucción de activación / concentrador fija y sale 1. No presenta indisponible como éxito vacío. Un no Hub interno HTTP 409 devuelve la salida 5 con guía stderr; el rol de cliente, el transporte y las respuestas mal formadas también siguen fallando.

Compruebe el Hub previsto y su activación `OCX_REMOTE_WORKSPACE_ENABLED=1` cuando no esté disponible; no cambie silenciosamente la configuración como recuperación. Estas observaciones no autorizan ni realizan emparejamientos, creación de sesiones, solicitudes, revocación o cambios de confianza. Esos siguen siendo los flujos de trabajo separados del panel de control / sesión a continuación.

<a id="pair-an-executor"></a>

## Emparejar a un ejecutor

1. Empareje el navegador con el Hub a través del panel de control. Ejecute el comando `ocx gui pair --origin` mostrado en el concentrador e introduzca su código de una sola vez; una sesión local o de Tailscale automáticamente iniciada puede ver el estado pero no puede controlar el espacio de trabajo remoto.
2. Abra **Espacio de trabajo remoto** en ese panel de Hub emparejado.
3. Seleccione **Crear código de emparejamiento**.
4. En el equipo 2, cambie al directorio del proyecto que desea exponer.
5. Copie el comando **Terminal Linux / macOS** o **Windows PowerShell** generado para ese equipo. Empareja el directorio actual y mantiene conectado `ocx remote-workspace agent` en ese terminal.

El flujo manual equivalente es:

```bash
cd /path/to/project
printf '%s\n' 'ONE-TIME-CODE' | ocx remote-workspace pair 'https://your-hub.example' \
  --pairing-code-stdin --root "$PWD"
ocx remote-workspace agent
```

En Windows PowerShell, utilice el comando que se muestra en el panel de control. La forma manual equivalente es:

```powershell
$pairingCode = 'ONE-TIME-CODE'
$pairingCode | ocx remote-workspace pair 'https://your-hub.example' `
  --pairing-code-stdin --root (Get-Location).Path
if ($LASTEXITCODE -eq 0) { ocx remote-workspace agent }
```

El ejecutable OCX Bun actual se agrega automáticamente como un archivo de solo lectura al sandbox Linux. Si el proyecto necesita una cadena de herramientas instalada por el usuario fuera de las rutas del sistema, empareje explícitamente sin exponer el resto del directorio principal:

```bash
printf '%s\n' 'ONE-TIME-CODE' | ocx remote-workspace pair 'https://your-hub.example' \
  --pairing-code-stdin --root "$PWD" \
  --toolchain-root "$HOME/.nvm/versions/node/v24/bin"
```

La fuente de ayuda nativa está empaquetada para su revisión. Construirlo no habilita los comandos Windows o macOS en este transporte. `--executor-helper` sigue siendo un selector de ayuda revisada; la existencia binaria o una ruta configurada no prueban el soporte de comandos.

El código de una sola vez se lee de la entrada estándar, no de los argumentos de la línea de comandos. El emparejamiento crea una clave de firma de dispositivo local y un portador con alcance de dispositivo. El Hub almacena solo su hash y nunca recibe la ruta real del Ejecutor. Detener el agente en primer plano con Ctrl+C; ejecutarlo nuevamente vuelve a conectar el mismo dispositivo.

Compruebe la inscripción local sin imprimir secretos:

```bash
ocx remote-workspace status
```

<a id="start-a-remote-coding-session"></a>

## Iniciar una sesión de codificación remota

En el panel de control, elija:

1. el ordenador en línea;
2. una carpeta de espacio de trabajo aprobada localmente;
3. Codex, Claude Code, o Pi desde el Hub; y
4. un modo de acceso.

**Solo lectura** es el valor predeterminado y expone la lista de directorios y la lectura de archivos. La opción de escritura se muestra como **Editar archivos y ejecutar comandos** solo cuando el Ejecutor pasó una sonda de caja de arena de comandos; de lo contrario, se muestra como **Editar solo archivos**. El panel de control muestra dos ubicaciones separadas, por lo que está claro que el modelo y el inicio de sesión permanecen en el concentrador mientras se ejecutan las operaciones del espacio de trabajo en el equipo seleccionado.

Envía mensajes desde el panel de Hub en el ordenador 1, el ordenador 3 o un teléfono. La sesión no puede cambiar a otro equipo o carpeta en silencio. Si el Ejecutor se desconecta, la sesión entra en **Ejecutor offline** y nunca vuelve al sistema de archivos del Hub.

La presentación inmediata reconoce la aceptación de inmediato; el panel de control sondea la sesión para el progreso y la finalización. Si se pierde el acuse de recibo, el borrador permanece visible con un aviso de envío desconocido. Compruebe el progreso de la sesión antes de volver a enviarla; el panel de control nunca vuelve a intentar un mensaje automáticamente.

**Detener** permanece disponible mientras se ejecuta un mensaje. Interrumpe el giro del agente de codificación Hub, cancela un comando activo del Ejecutor y evita que una respuesta tardía vuelva a abrir la sesión detenida.

<a id="work-with-sessions-side-by-side"></a>

## Trabajar con sesiones lado a lado

La lista de sesiones de la izquierda abre una sesión en el panel enfocado. Arrastre una sesión hacia la izquierda, derecha, arriba o abajo de otro panel para dividir el área de conversación. Puedes mostrar hasta cuatro sesiones diferentes a la vez. Una sesión ya visible se mueve entre paneles en lugar de abrir un compositor duplicado.

Utilice **Dividir a la derecha** o **Dividir a continuación** junto a una sesión para la alternativa accesible por teclado. Arrastre un divisor para cambiar el tamaño de los paneles, o enfoque el divisor y use sus teclas de flecha. **Home** y **Fin** establecen el divisor en su tamaño mínimo y máximo. Cada sesión mantiene su propio borrador, estado de envío y acción Detener, por lo que un turno pendiente en un panel no bloquea una sesión diferente. **Cerrar panel** cambia el diseño solamente; no detiene la sesión.

El diseño del panel se restaura para este Hub en el mismo navegador. Solo se guardan los identificadores de sesión y las posiciones del panel y los tamaños de los divisores; el texto borrador y la salida del modelo no se escriben en el almacenamiento del navegador. Recargar la página borra los borradores no enviados. En pantallas de hasta 760px de ancho, los paneles se apilan verticalmente sin redimensionar los divisores; las posiciones divididas y los tamaños guardados regresan cuando la pantalla es más ancha.

Esta vista es compartida por el panel del navegador y el panel de escritorio OpenCodex. Los usuarios de CLI pueden abrir el panel de control con `ocx gui` y seleccionar **Espacio de trabajo remoto** después de su configuración normal de Hub. No cambia la interfaz del terminal de `codex` o el diseño de la conversación dentro de la aplicación de escritorio oficial separada ChatGPT / Codex.

<a id="restart-and-reconnect-behavior"></a>

## Reiniciar y reconectar el comportamiento

El concentrador mantiene los metadatos de sesión limitados y una pequeña instantánea de evento reciente. Después de un reinicio de Hub, una sesión inacabada espera a su Ejecutor original. Una vez que el dispositivo se vuelve a conectar, el siguiente mensaje reanuda el hilo original Codex, la sesión Claude Code o el identificador de sesión Pi.

Claude Code crea su historia duradera en el primer aviso completado. Si el Hub se detiene antes de que una nueva sesión Claude haya completado algún mensaje, no hay conversación que reanudar; inicie una nueva sesión en su lugar.

Un manifiesto de capacidad cambiado no debilita silenciosamente una sesión existente. Inicie una nueva sesión si el Ejecutor pierde la contención de comandos o si sus herramientas disponibles cambian. Revocar una computadora cierra su socket y detiene las sesiones vinculadas a él.

<a id="security-boundaries"></a>

## Límites de seguridad

- Las credenciales del proveedor y el historial de agentes de codificación permanecen en el concentrador.
- Las claves privadas del ejecutor, el portador del dispositivo y las rutas raíz reales permanecen en su estado OCX solo de propietario.
- Los errores de código de emparejamiento están limitados por par observado por kernel en cada oyente. Diez códigos fallidos en diez minutos devuelven un `429` genérico con `Retry-After`; el Hub conserva solo hashes limitados y expirados de esas identidades de origen. Los usuarios de Tailscale Serve comparten el bucket de loopback del oyente de administración porque un llamador local directo podría falsificar su encabezado de identidad.
- Cada sesión de trabajo utiliza un protocolo de enlace efímero P-256 ECDH firmado por Ed25519, y pide mensajes AES-256-GCM.
- Un socket no se muestra como en línea hasta que ambas partes estén de acuerdo en su manifiesto de capacidad actual.
- La reconexión puede eliminar una capacidad cuando su sandbox local no está disponible, pero nunca agrega una capacidad fuera de la concesión registrada en el emparejamiento.
- Cada solicitud está vinculada a un hilo de modelo, dispositivo, raíz, modo de acceso y conjunto de capacidades.
- Las rutas son relativas, canónicas, limitadas y rechazadas en enlace simbólico, unión o escape de directorio padre. Windows nombres de dispositivos, flujos de datos alternativos y alias de espacio/punto final son denegados.
- Las operaciones del ejecutor se serializan, las identidades de archivo abiertas se vuelven a verificar y los hashes de escritura se vuelven a verificar inmediatamente antes del reemplazo atómico. Reemplazar una raíz aprobada requiere emparejarla de nuevo, y las raíces de la cadena de herramientas se revalidan antes de cada comando.
- Las lecturas/escrituras de archivos rechazan los archivos vinculados. Antes de la ejecución de comandos, OCX escanea un máximo de 250.000 entradas de espacio de trabajo y desactiva la ruta de acceso de los comandos si alguna entrada que no sea de directorio tiene varios enlaces; los sandboxes de ruta no pueden probar si el otro nombre de ese inodo está fuera de la raíz aprobada.
- Los comandos Linux se ejecutan a través de bubblewrap con un espacio de trabajo grabable, un entorno despejado, espacios de nombres de procesos privados, el ejecutable actual de OCX Bun como un solo archivo de solo lectura, salida y tiempo de espera limitados y red desactivada de forma predeterminada. Las pruebas de confinamiento dedicadas requieren un entorno alojado configurado explícitamente; un conjunto genérico verde no prueba que se ejecutaron.
- macOS solo anuncia herramientas de archivo. Un grupo de procesos no puede contener un descendiente después de que llame al `setsid()`, e importar un amplio perfil del sistema de cinturón de seguridad de Apple simplemente para iniciar un comando expondría una autoridad de servicio de host no relacionada. Por lo tanto, el ayudante nativo rechaza tanto sus solicitudes de sonda como de comando directo hasta que OCX tenga un propietario de contención descendiente estrecho y revocable.
- Las solicitudes nativas de comandos en Windows y macOS se rechazan. Las pruebas de rechazo del auxiliar directo deben distinguirse de la evidencia de confinamiento funcional de comandos; la aceptación de comandos en Windows sigue pendiente.
- El ayudante nativo anclado debe estar fuera de cada espacio de trabajo escribible aprobado. OCX comprueba esto tanto antes de la compatibilidad con comandos publicitarios como inmediatamente antes de cada comando, por lo que el código del espacio de trabajo no puede reemplazar al binario que hace cumplir su siguiente sandbox.
- Detener una sesión cancela un comando activo de Ejecutor y limpia el proceso del modelo Hub y el puente de herramientas de bucle invertido. Windows detiene el árbol de proceso de npm en lugar de dejar atrás a su hijo Node; Linux y macOS fuerza de parada un CLI sólo si se ignora la ventana de parada elegante.

El Hub ve intencionadamente mensajes y salidas del modelo porque ejecuta el agente de codificación. El cifrado de extremo a extremo protege las cargas útiles de Executor RPC. Se confía en el concentrador emparejado para seleccionar raíces aprobadas sobre WSS autenticado; no es ciego a su propia conversación de modelo.

<a id="current-scope"></a>

## Alcance actual

Remote Workspace no copia ni sincroniza credenciales con otros equipos. Está separado del enrutamiento del proveedor de Remote Hub y de cualquier futuro cómputo alojado o producto Super Sync. Una versión de producción aún requiere un paquete de ayuda firmado Windows, una prueba nativa de CI en los binarios exactos, una revisión independiente del mantenedor y una verdadera ejecución de aceptación de tres computadoras.

<a id="prompt-acceptance-api"></a>

## Rápida aceptación API

`POST /api/remote-workspace/sessions/:id/prompt` devuelve HTTP 202 con la instantánea de sesión aceptada. Su ID de sesión y la secuencia de eventos monotónicos identifican la instantánea de aceptación; 202 no significa que el modelo se haya completado. Encuesta `GET /api/remote-workspace/sessions` para eventos posteriores y estado de la terminal. Reconectar y reanudar el entorno de ejecución permanecen ocupados mientras ese turno está activo. Un acuse de recibo perdido deja la aceptación desconocida, por lo que los clientes deben encuestar antes de elegir si enviar nuevamente.
