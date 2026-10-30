---
title: "Espacio de trabajo remoto"
description: "Mantén Codex, Claude Code, Pi y sus sesiones de acceso en un Hub OCX, mientras otros equipos con solo OCX aportan el espacio de trabajo y el entorno de compilación."
---

Para conectar equipos mediante SSH, consulta [Enlace remoto](/es/guides/remote-link/).

Remote Workspace permite ejecutar los agentes de programación en un Hub de OpenCodex, mientras otro equipo aporta los archivos del proyecto y los recursos para ejecutar comandos, pruebas y compilaciones. Puedes controlar la sesión desde un teléfono o un tercer equipo mediante el dashboard del Hub.

```text
Phone browser -> Computer 1 OCX Hub -> encrypted channel -> Computer 2 OCX Executor
                 Codex / Claude / Pi                       project and commands
                 logins and sessions                      no coding CLI login
```

El Ejecutor solo necesita OpenCodex. No necesita Codex, Claude Code, Pi, una sesión de ChatGPT ni una clave API de un proveedor. Abre una conexión WebSocket saliente hacia el Hub, por lo que no necesita un puerto público ni una redirección de puertos en el router.

:::caution[Base experimental]
Remote Workspace requiere activación explícita y todavía no está listo para producción. Linux ofrece herramientas de archivos y permite ejecutar comandos mediante bubblewrap cuando se cumplen las condiciones de aislamiento. Windows y macOS solo ofrecen herramientas de archivos: sus auxiliares nativos oficiales rechazan tanto las comprobaciones de aislamiento como las solicitudes de comandos. La ejecución de comandos en Windows seguirá sin admitirse hasta verificar que el componente responsable de su ciclo de vida conserva el control de la limpieza durante una cancelación. Si el Ejecutor no admite comandos, estos nunca se ejecutan en el Hub como alternativa.
:::

<a id="rpc-compatibility-and-timeouts"></a>

## Compatibilidad con RPC y tiempos de espera

Remote Workspace utiliza RPC v2 cifrado. Tanto el Hub como cada Ejecutor deben admitir v2. Las conexiones con componentes RPC v1 se rechazan de forma segura, sin recurrir a la ejecución inmediata; actualiza el Hub y los Ejecutores juntos.

Al agotarse el tiempo de espera, se solicita la cancelación al Ejecutor, pero eso no confirma que se haya cancelado. Una autorización puede estar ya en tránsito o la operación autorizada puede estar ejecutándose. El tiempo de espera predeterminado de RPC es de 65 segundos; `timeoutMs` acepta valores de 1 a 120.000 milisegundos, ambos incluidos.

<a id="set-up-the-hub"></a>

## Configurar el Hub

El equipo 1 conserva las sesiones de acceso de los agentes de programación y las sesiones de los modelos. Instala allí los agentes que quieras usar, inicia sesión en ellos y ejecuta OpenCodex como Hub:

Mantén el Hub en ejecución en primer plano en esta terminal:

```bash
ocx config set runtimeRole hub
OCX_REMOTE_WORKSPACE_ENABLED=1 ocx start
```

Mientras el Hub sigue en ejecución, abre otra terminal e inicia el dashboard:

```bash
ocx gui
```

Establece `OCX_REMOTE_WORKSPACE_ENABLED=1` en el propio proceso del Hub. Configurarlo solo al ejecutar un comando del dashboard no habilita un servicio que ya está en ejecución. Sin activación explícita, el Hub devuelve el estado deshabilitado sin crear claves del espacio de trabajo ni comprobar los entornos de ejecución de los agentes.

Usa un despliegue HTTPS con autenticación para abrir el dashboard desde un teléfono u otro equipo. Consulta [Despliegue de Remote Hub](/es/guides/remote-hub/) para conocer el patrón admitido de acceso a la interfaz de administración mediante Tailscale. No expongas un puerto local del dashboard sin autenticación.

Codex Remote Workspace utiliza los perfiles de permisos actuales de App Server. Si la configuración de Codex seleccionada en el Hub todavía establece las claves heredadas `sandbox_mode` o `sandbox_workspace_write`, el dashboard muestra Codex como no disponible en lugar de iniciarlo con un aislamiento más débil. Migra ese perfil de Codex antes de usar la función; no configures a la vez el sandbox heredado y un perfil de permisos.

<a id="inspect-the-hub-without-starting-a-session"></a>

## Inspeccionar el Hub sin iniciar una sesión

```bash
ocx remote-workspace hub --help
ocx remote-workspace hub status --json
ocx remote-workspace hub runtimes --json
ocx remote-workspace hub sessions --json
```

Estos comandos consultan la interfaz de administración del Hub seleccionado que está en ejecución. El comando existente `remote-workspace status` sigue leyendo el estado local del Ejecutor. La consulta de estado devuelve `{available:true,devices,runtimes,sessions}`; la de entornos de ejecución devuelve `{runtimes:{codex:{available,...},claude:{available,...},pi:{available,...}}}`; y la de sesiones devuelve `{sessions:[...]}`. La disponibilidad de los entornos de ejecución se representa como un objeto, no como un arreglo; consultarla puede comprobar si sus ejecutables están disponibles. Las raíces del dispositivo muestran identificadores y etiquetas, no las rutas del sistema de archivos del Ejecutor. Las sesiones incluyen eventos públicos recientes; la salida de terminal destinada a personas escapa los caracteres de control.

Un Hub disponible, aunque tenga listas vacías de dispositivos y sesiones, produce el código de salida 0. Si la función está desactivada en el Hub, el despachador externo puede devolver HTTP 200 con `available:false`, listas vacías de dispositivos y sesiones y `runtimes:{}`. En ese caso concreto, la CLI informa de que no está disponible, muestra una instrucción fija sobre el Hub y su activación, y termina con el código 1. No presenta la indisponibilidad como una consulta exitosa sin resultados. Una respuesta HTTP 409 interna que indica que el proceso no es un Hub produce el código de salida 5 y una indicación en stderr. El rol de cliente, los errores de transporte y las respuestas mal formadas también se consideran fallos.

Si no está disponible, comprueba que consultas el Hub previsto y que tiene activada la opción `OCX_REMOTE_WORKSPACE_ENABLED=1`; no cambies la configuración de forma automática para recuperarlo. Estas consultas no autorizan ni realizan emparejamientos, creación de sesiones, envío de mensajes, revocaciones ni cambios de confianza. Esas acciones pertenecen a los flujos del dashboard y de las sesiones que se describen a continuación.

<a id="pair-an-executor"></a>

## Emparejar un Ejecutor

1. Empareja el navegador con el Hub mediante el panel de emparejamiento del dashboard. Ejecuta en el Hub el comando `ocx gui pair --origin` que se muestra e introduce el código de un solo uso. Una sesión local o de Tailscale iniciada automáticamente puede consultar el estado, pero no controlar Remote Workspace.
2. Abre **Espacio de trabajo remoto** en el dashboard del Hub ya emparejado.
3. Selecciona **Crear código de emparejamiento**.
4. En el equipo 2, entra en el directorio del proyecto que quieras compartir.
5. Copia el comando generado para **Terminal Linux / macOS** o **Windows PowerShell**, según el equipo. Empareja el directorio actual y mantiene conectado `ocx remote-workspace agent` en esa terminal.

El flujo manual equivalente es:

```bash
cd /path/to/project
if read -r -s -p 'Pairing code: ' pairing_code; then
  printf '\n'
  pairing_status=0
  printf '%s\n' "$pairing_code" | ocx remote-workspace pair 'https://your-hub.example' \
    --pairing-code-stdin --root "$PWD" || pairing_status=$?
  unset pairing_code
  if [ "$pairing_status" -eq 0 ]; then ocx remote-workspace agent; fi
  unset pairing_status
else
  unset pairing_code
fi
```

En Windows PowerShell, usa el comando que muestra el dashboard. Su equivalente manual es:

```powershell
$pairingSecret = Read-Host 'Pairing code' -AsSecureString
$pairingBuffer = [IntPtr]::Zero
$pairingExitCode = 1
try {
  $pairingBuffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pairingSecret)
  $pairingCode = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pairingBuffer)
  $pairingCode | ocx remote-workspace pair 'https://your-hub.example' `
    --pairing-code-stdin --root (Get-Location).Path
  $pairingExitCode = $LASTEXITCODE
} finally {
  if ($pairingBuffer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pairingBuffer)
  }
  $pairingSecret.Dispose()
  Remove-Variable pairingCode, pairingSecret, pairingBuffer -ErrorAction SilentlyContinue
}
if ($pairingExitCode -eq 0) { ocx remote-workspace agent }
Remove-Variable pairingExitCode
```

El ejecutable actual de Bun que usa OCX se añade automáticamente al sandbox de Linux como un único archivo de solo lectura. Si el proyecto necesita herramientas instaladas por el usuario fuera de las rutas del sistema, incluye explícitamente esa cadena de herramientas en el emparejamiento, sin exponer el resto del directorio personal:

```bash
if read -r -s -p 'Pairing code: ' pairing_code; then
  printf '\n'
  pairing_status=0
  printf '%s\n' "$pairing_code" | ocx remote-workspace pair 'https://your-hub.example' \
    --pairing-code-stdin --root "$PWD" \
    --toolchain-root "$HOME/.nvm/versions/node/v24/bin" || pairing_status=$?
  unset pairing_code pairing_status
else
  unset pairing_code
fi
```

El código fuente del auxiliar nativo se incluye en el paquete para su revisión. Compilarlo no habilita la ejecución de comandos en Windows ni macOS en esta implementación. `--executor-helper` sigue siendo un selector de auxiliares revisados; que exista un binario o una ruta configurada no demuestra que se admita ejecutar comandos.

El código de un solo uso se lee de la entrada estándar, no de los argumentos de la línea de comandos. El emparejamiento crea una clave de firma local y un token de portador limitado a ese dispositivo. El Hub solo almacena el hash del token y nunca recibe la ruta real del Ejecutor. Detén el agente en primer plano con Ctrl+C; al ejecutarlo de nuevo se reconecta el mismo dispositivo.

Comprueba el registro local sin mostrar secretos:

```bash
ocx remote-workspace status
```

<a id="start-a-remote-coding-session"></a>

## Iniciar una sesión de codificación remota

En el dashboard, elige:

1. el equipo conectado;
2. una carpeta de espacio de trabajo aprobada localmente;
3. Codex, Claude Code o Pi en el Hub; y
4. un modo de acceso.

**Solo lectura** es el modo predeterminado y permite listar directorios y leer archivos. La opción de escritura aparece como **Editar archivos y ejecutar comandos** solo si el Ejecutor ha superado una comprobación del sandbox de comandos; en caso contrario, aparece como **Editar solo archivos**. El dashboard muestra dos ubicaciones distintas: el modelo y la sesión de acceso permanecen en el Hub, mientras las operaciones sobre el espacio de trabajo se ejecutan en el equipo seleccionado.

Envía mensajes desde el dashboard del Hub en el equipo 1, el equipo 3 o un teléfono. La sesión no puede cambiar de equipo o carpeta sin avisar. Si el Ejecutor se desconecta, la sesión pasa al estado **Ejecutor sin conexión** y nunca recurre al sistema de archivos del Hub como alternativa.

Al enviar un mensaje, se confirma de inmediato que ha sido aceptado; el dashboard consulta periódicamente la sesión para conocer el progreso y la finalización. Si se pierde esa confirmación, el borrador permanece visible con un aviso de estado de envío desconocido. Comprueba el progreso de la sesión antes de volver a enviarlo; el dashboard nunca reenvía un mensaje automáticamente.

Si el proceso Pi termina o falla su extensión mientras empieza un turno, la sesión informa del fallo aunque Pi todavía no haya confirmado ese turno.

**Detener** sigue disponible mientras se procesa un mensaje. Interrumpe el turno del agente de programación del Hub, cancela el comando activo del Ejecutor y evita que una respuesta tardía vuelva a abrir la sesión detenida.

<a id="work-with-sessions-side-by-side"></a>

## Trabajar con sesiones lado a lado

La lista de sesiones de la izquierda abre la sesión seleccionada en el panel activo. Arrastra una sesión al borde izquierdo, derecho, superior o inferior de otro panel para dividir el área de conversación. Puedes mostrar hasta cuatro sesiones diferentes a la vez. Si una sesión ya está visible, se mueve entre paneles en lugar de abrir otro editor de mensajes para la misma sesión.

Como alternativa accesible por teclado, usa **Dividir a la derecha** o **Dividir debajo**, junto a la sesión. Arrastra un separador para cambiar el tamaño de los paneles, o dale el foco y usa las teclas de flecha. **Inicio (Home)** y **Fin (End)** lo llevan al tamaño mínimo y máximo, respectivamente. Cada sesión conserva su propio borrador, estado de envío y acción Detener; un turno pendiente en un panel no bloquea otra sesión. **Cerrar panel** solo cambia la distribución; no detiene la sesión.

La distribución se restaura para este Hub en el mismo navegador. Solo se guardan los identificadores de sesión, las posiciones de los paneles y los tamaños de los separadores; los borradores y las respuestas del modelo no se escriben en el almacenamiento del navegador. Recargar la página borra los borradores sin enviar. En pantallas de hasta 760px de ancho, los paneles se apilan verticalmente y no muestran separadores para ajustar su tamaño; las posiciones y los tamaños guardados vuelven a aplicarse en pantallas más anchas.

Esta vista se comparte entre el dashboard del navegador y el de OpenCodex Desktop. Si usas la CLI, puedes abrirla con `ocx gui` y seleccionar **Espacio de trabajo remoto** después de configurar el Hub de la forma habitual. No modifica la interfaz de terminal de `codex` ni la distribución de las conversaciones en la aplicación oficial de escritorio ChatGPT/Codex, que es independiente.

<a id="restart-and-reconnect-behavior"></a>

## Comportamiento al reiniciar y reconectar

El Hub conserva metadatos de sesión de tamaño limitado y una pequeña instantánea de los eventos recientes. Tras reiniciar el Hub, una sesión sin terminar espera a su Ejecutor original. Cuando el dispositivo se reconecta, el siguiente mensaje reanuda el hilo original de Codex, la sesión de Claude Code o el identificador de sesión de Pi.

Claude Code crea su historial persistente al completar el primer mensaje. Si el Hub se detiene antes de que una nueva sesión de Claude complete algún mensaje, no habrá una conversación que reanudar; inicia una sesión nueva.

Un cambio en el manifiesto de capacidades no debilita una sesión existente sin avisar. Inicia una sesión nueva si el Ejecutor pierde el aislamiento de comandos o cambian sus herramientas disponibles. Revocar un equipo cierra su socket y detiene las sesiones vinculadas a él.

<a id="security-boundaries"></a>

## Límites de seguridad

- Las credenciales de los proveedores y el historial de los agentes de programación permanecen en el Hub.
- Las claves privadas, el token de portador del dispositivo y las rutas raíz reales del Ejecutor permanecen en su estado local de OCX, accesible solo por su propietario.
- Cada listener limita los intentos fallidos de emparejamiento por la identidad del extremo remoto que observa el kernel. Diez códigos fallidos en diez minutos producen un `429` genérico con `Retry-After`; el Hub conserva una cantidad limitada de hashes de esas identidades, con caducidad. Los usuarios de Tailscale Serve comparten el contador de loopback del listener de administración porque una solicitud local directa podría falsificar su encabezado de identidad.
- Cada sesión de trabajo utiliza una negociación efímera P-256 ECDH firmada con Ed25519 y mensajes AES-256-GCM ordenados.
- Un socket no se muestra como conectado hasta que ambos extremos coinciden en el manifiesto de capacidades actual.
- La reconexión puede retirar una capacidad si su sandbox local deja de estar disponible, pero nunca añade una capacidad fuera de la autorización registrada durante el emparejamiento.
- Cada solicitud queda vinculada a un único hilo del modelo, dispositivo, raíz, modo de acceso y conjunto de capacidades.
- Las rutas son relativas, se normalizan a su forma canónica y se mantienen dentro de los límites permitidos. Se rechazan los intentos de salir de la raíz mediante enlaces simbólicos, uniones de directorio o referencias al directorio padre. También se rechazan los nombres de dispositivo de Windows, los flujos de datos alternativos y los alias con puntos o espacios finales.
- Las operaciones del Ejecutor se procesan en serie. Se vuelve a comprobar la identidad de los archivos abiertos y se verifican otra vez los hashes de escritura justo antes del reemplazo atómico. Sustituir una raíz aprobada exige emparejarla de nuevo; las raíces de las herramientas se revalidan antes de cada comando.
- La lectura y escritura rechazan archivos con enlaces duros. Antes de ejecutar comandos, OCX examina como máximo 250.000 entradas del espacio de trabajo y deshabilita la ejecución si alguna entrada que no sea un directorio tiene varios enlaces. Un sandbox basado en rutas no puede demostrar si otro nombre de ese inodo está fuera de la raíz aprobada.
- Los comandos de Linux se ejecutan mediante bubblewrap con un espacio de trabajo escribible, un entorno sin las variables heredadas, espacios de nombres de procesos privados, el ejecutable actual de Bun de OCX como un único archivo de solo lectura, límites de salida y tiempo de espera, y la red desactivada de forma predeterminada. Las pruebas específicas de confinamiento requieren un entorno alojado configurado expresamente; que la suite general pase no demuestra que se hayan ejecutado.
- macOS solo anuncia herramientas de archivos. Un grupo de procesos no puede contener a un descendiente después de que este llame a `setsid()`. Además, importar un perfil amplio del sistema Apple Seatbelt solo para iniciar un comando expondría permisos sobre servicios del sistema ajenos a esa tarea. Por eso, el auxiliar nativo rechaza tanto las comprobaciones de aislamiento como las solicitudes directas de comandos hasta que OCX disponga de un componente con autoridad limitada y revocable para confinar los procesos descendientes.
- Las solicitudes nativas de comandos en Windows y macOS se rechazan. Las pruebas de rechazo del auxiliar directo deben distinguirse de la evidencia de confinamiento funcional de comandos; la aceptación de comandos en Windows sigue pendiente.
- El auxiliar nativo fijado debe estar fuera de todos los espacios de trabajo aprobados que permitan escritura. OCX lo comprueba antes de anunciar que admite comandos y justo antes de cada ejecución, para impedir que el código del espacio de trabajo sustituya el binario que aplica el siguiente sandbox.
- Detener una sesión cancela el comando activo del Ejecutor y limpia el proceso del modelo en el Hub y el puente local de herramientas de loopback. En Windows se detiene todo el árbol de procesos del contenedor de npm bajo su control, sin dejar activo el proceso hijo de Node; Linux y macOS solo fuerzan la terminación de una CLI si esta ignora el plazo de cierre ordenado.

El Hub ve deliberadamente los mensajes y las respuestas del modelo porque ejecuta el agente de programación. El cifrado de extremo a extremo protege los datos de RPC del Ejecutor. El Hub emparejado es un componente de confianza que selecciona raíces aprobadas mediante WSS autenticado; puede ver su propia conversación con el modelo.

<a id="current-scope"></a>

## Alcance actual

Remote Workspace no copia ni sincroniza credenciales con otros equipos. Es independiente del enrutamiento de proveedores de Remote Hub y de cualquier futuro producto de cómputo alojado o Super Sync. Para una versión de producción todavía hacen falta un paquete firmado del auxiliar de Windows, pruebas de CI nativas sobre los binarios exactos, una revisión independiente del mantenedor y una prueba real de aceptación con tres equipos.

<a id="prompt-acceptance-api"></a>

## API de aceptación de mensajes

`POST /api/remote-workspace/sessions/:id/prompt` devuelve HTTP 202 con la instantánea de la sesión que aceptó el mensaje. Su identificador de sesión y la secuencia monotónica de eventos identifican esa instantánea; 202 no significa que el turno del modelo haya terminado. Consulta periódicamente `GET /api/remote-workspace/sessions` para obtener los eventos posteriores y saber si la sesión llegó a un estado final. La reconexión y la reanudación del entorno de ejecución siguen ocupadas mientras ese turno está activo. Si se pierde la confirmación, no se sabe si el mensaje fue aceptado; los clientes deben consultar el estado antes de decidir si lo reenvían.
