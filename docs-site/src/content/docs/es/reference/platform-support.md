---
title: "Compatibilidad por plataforma"
description: "Qué puede hacer OpenCodex en macOS, Windows y Linux, y por qué algunas funciones dependen de la plataforma."
---

OpenCodex funciona en macOS, Windows y Linux. La mayor parte se comporta igual en las tres plataformas; algunas funciones dependen de mecanismos del sistema operativo. Esta página explica cuáles y por qué.

<a id="everywhere"></a>

## En todas las plataformas

| Función | Notas |
| --- | --- |
| Proxy, enrutamiento y adaptadores de proveedores | El entorno de ejecución principal es independiente de la plataforma. |
| Servicio en segundo plano | Tres mecanismos nativos: launchd en macOS, Programador de tareas **o** WinSW en Windows y una unidad de usuario de systemd en Linux. |
| Inicio de sesión en el navegador | Se abre mediante el mecanismo del sistema operativo. |
| Detección de clientes | Las instalaciones de Cursor, Claude Desktop, Kiro y Codex se localizan según la plataforma. |

<a id="provider-keys-in-the-os-credential-store"></a>

### Claves de proveedores en el almacén de credenciales del sistema

Se admite en las tres plataformas **cuando hay un servicio de credenciales del sistema desbloqueado y disponible**: Llavero en macOS, Administrador de credenciales en Windows y libsecret en Linux. Un llavero bloqueado o una sesión sin interfaz gráfica pueden carecer de ese servicio; en ese caso el almacén no está disponible y OpenCodex lo indica, sin cambiar de método silenciosamente. Consulta [Proveedores](/es/reference/configuration/providers/) para conocer las reglas de almacenamiento.

<a id="macos-only"></a>

## Solo en macOS

<a id="claude-code-auto-connect"></a>

### Conexión automática de Claude Code

La inyección de `ANTHROPIC_BASE_URL` y de los controles de Claude Code en tu sesión se hace mediante el dominio de usuario de launchd, que no tiene un equivalente único en las demás plataformas.

En Linux, los tres mecanismos posibles alcanzan grupos distintos de procesos: `systemctl --user set-environment` solo llega a las unidades creadas por systemd; `~/.profile`, a los intérpretes de comandos de inicio de sesión; y `~/.bashrc`, a los intérpretes interactivos que no son de inicio de sesión. No existe un único punto que cubra toda la sesión del usuario.

En Windows, el equivalente es `HKCU\Environment`, que persiste entre reinicios. Esto trasladaría un token bearer desde un ámbito que se vacía al reiniciar a una sección del registro que lo conserva. Cambiaría cuánto tiempo permanece la credencial en disco y quién puede leerla; esa decisión requiere revisión de seguridad, no una simple adaptación entre plataformas.

El resto de lo que necesita Claude Code funciona en todas las plataformas. Puedes establecer las mismas variables manualmente o ejecutar `ocx claude`, que las pasa directamente al proceso hijo.

<a id="import-versus-paste"></a>

## Importar o pegar una clave

<a id="meta-muse-code"></a>

### Meta Muse Code

En macOS, el inicio de sesión normal intenta primero importar la clave API guardada por `muse login`. Si no hay una disponible, o si se usa otra plataforma, OpenCodex inicia la aprobación mediante dispositivo sin abrir Muse CLI. Añadir una cuenta o volver a autenticarla omite la importación. Si el inicio mediante dispositivo falla sin haberse cancelado, puede ofrecerse una clave manual cuando el cliente admita introducirla. Las claves pegadas se someten a la misma validación de formato y de la API de modelos que las importadas. Ambas vías de adquisición mediante la API de administración requieren una sesión del panel; consulta la [guía de proveedores](/es/guides/providers/).

El aviso del Llavero de macOS aparece en el equipo que ejecuta el proxy, que puede ser distinto del equipo del navegador. OpenCodex permite hasta 120 segundos para aprobarlo. Cancelar el inicio en el panel detiene la lectura pendiente. La ausencia de entradas, el acceso denegado, la interacción no disponible con el Llavero, el tiempo agotado, las credenciales mal formadas y los fallos de validación de la API de modelos tienen mensajes de recuperación distintos. Si se bloquea la importación, el panel ofrece pegar una clave API existente de Muse Code; no inicia automáticamente otra autorización de dispositivo. Para iniciar sesión desde el navegador, elige **Añadir cuenta** en un proveedor ya configurado. OpenCodex no cambia los controles de acceso del Llavero.

Si el inicio sigue fallando, informa el error exacto de Muse (incluido el estado HTTP), la versión de OpenCodex, `muse --version`, si el panel y el proxy están en equipos distintos y cuánto tiempo estuvo visible el aviso. En las herramientas de desarrollador del navegador → Red, copia solo el campo `error` de `/api/oauth/login` o `/api/oauth/status?provider=meta-muse`. No compartas archivos HAR, encabezados de solicitudes, archivos de autenticación, salidas del Llavero, datos de la cuenta ni el resto de la respuesta de estado. Estos diagnósticos permiten distinguir fallos de importación local y de validación de Meta sin volcar credenciales.

En las solicitudes Responses a Meta se admite omitir la selección de herramientas o usar `auto`. Un `none` explícito envía `tools: []` y elimina los elementos `additional_tools` de la entrada. Las selecciones forzadas, por nombre y `allowed_tools` devuelven HTTP 400 antes de llegar a Meta, porque Muse solo acepta `auto`. Los demás destinos Responses conservan su comportamiento de selección de herramientas.

<a id="windows-notes"></a>

## Notas de Windows

La actualización npm del lanzador Node requiere Windows 10 o posterior con atributos de creación
de procesos Job List. Si no se dispone de supervisión atómica, informa `EINSTALLJOIN` y no inicia npm.
Actualiza Windows antes de reintentarlo.

El servicio de Windows puede usar el Programador de tareas o un servicio nativo de WinSW; ambos métodos son excluyentes. `ocx service repair` rechaza la reparación si encuentra estado de los dos, para evitar que dos proxies terminen compitiendo por el mismo puerto.

En una instalación de Windows que no esté en inglés, la salida de consola usa la página de códigos del sistema en lugar de UTF-8. OpenCodex la decodifica según esa página para resolver correctamente nombres de cuenta con caracteres no ASCII.

<a id="when-something-is-unavailable"></a>

## Cuando una función no está disponible

OpenCodex indica la causa real en lugar de desactivar un control silenciosamente. Si una función no está disponible en tu plataforma, el error o el panel explica qué mecanismo falta y cuál es la alternativa admitida. Si no lo hace, conviene informar el problema.
