---
title: "Alternativa ante límites de uso de Composer"
description: "Envía texto bajo demanda a la cola de un hilo existente de Codex sin cambiar la autenticación ni el enrutamiento de OpenCodex Desktop; las cuotas del servidor siguen aplicándose."
---

Un bloqueo por uso del **cuadro de mensajes (Composer)** de Desktop puede impedir nuevas entradas aunque la ruta de OpenCodex configurada para el hilo todavía tenga capacidad. En una instalación compatible, `codex queue` usa la cola nativa del app-server de Codex sin pasar por ese cuadro. No parchea la aplicación, intercepta TLS, instala certificados ni cambia la autenticación.

Esto **no es una solución para cada estado de límite de uso**. No restablece la cuota agotada ni desbloquea el selector de modelos. Un hilo que ya usa `gpt-reserve` mantiene ese modelo; el texto en cola no lo cambia a otro proveedor. La autorización del lado del servidor, las cuotas de proveedores, las aprobaciones y la configuración de ejecución del subproceso aún se aplican.

<a id="identify-the-blocked-layer"></a>

## Identificar la capa bloqueada

Un compositor deshabilitado antes del envío es diferente de un rechazo real del proveedor después del envío. Una etiqueta de modelo personalizada no demuestra ser un proveedor independiente ni la capacidad disponible. Utilice este recurso solo para un subproceso seleccionado deliberadamente con una ruta que de otro modo se podría usar; compruebe las aprobaciones pendientes, los giros activos y la conectividad aplicación-servidor por separado.

El bloqueo de la cuenta principal sigue siendo autorizado. Es un guardia de admisión previo al agotamiento, no una forma de restaurar una cuenta ya agotada. Este ayudante no deshabilita esa protección ni cambia el proveedor que usa un subproceso. No cambie las respuestas de cuota ni desactive la guardia para ejecutar una solicitud de cuenta nativa en cola.

<a id="opencodex-integration-and-ownership"></a>

## Integración y propiedad de OpenCodex

Mantener la configuración existente [Codex integración](/es/guides/codex-integration) y [modelo de enrutamiento](/es/guides/model-routing). El camino es:

```text
helper -> native Codex queue -> the selected thread's app-server
       -> the thread's configured provider -> OpenCodex, when already routed there
```

Los ayudantes no implementan otro router de proveedor. Envían solo el destino y el texto, no el modelo, la cuenta, el nivel de servicio, la aprobación, el sandbox o las anulaciones de la URL base. Un proveedor `openai` incorporado enrutado a OpenCodex y un proveedor personalizado `opencodex` mantienen su configuración existente. Pool / Direct selección, cuentas vinculantes, credenciales de proveedor y verificaciones de admisión siguen siendo propiedad de OpenCodex y el demonio de servicio. La aceptación de colas por sí sola no prueba que se haya llamado a un proveedor.

Utilice el **mismo `CODEX_HOME` y compatible CLI /app-server** como la instalación de escritorio. `CODEX_HOME` por defecto es `~/.codex`; otra casa puede descubrir otro daemon y almacenamiento de hilos. `OPENCODEX_HOME` es el hogar del proxy, no un sustituto de `CODEX_HOME`. Los ayudantes dejan ambas variables y los archivos de configuración de ambas aplicaciones sin cambios. En PowerShell, los hijos nativos heredan la ubicación del sistema de archivos del shell, incluso cuando `CODEX_HOME` es relativo.

El proxy ya debe estar ejecutándose y el subproceso de destino ya debe usar la ruta prevista. El ayudante no inicia/sincroniza/reconfigura OpenCodex, vuelve a habilitar una integración deshabilitada o reemplaza silenciosamente una ruta OpenAI directa. No se requiere alternar `codexDesktopAuthless`. Una URL de proveedor remota OpenCodex no es lo mismo que un servidor de aplicaciones remoto Codex: estos ayudantes utilizan el descubrimiento de demonios locales, no el enrutamiento automático a una conversación en otro equipo.

Estos son **Ayudantes de repositorio bajo demanda**, no un comando `ocx queue` instalado o un control de tablero. La lista de permisos de archivos del paquete npm no incluye `scripts/`; use una comprobación de repositorio coincidente o el comando nativo `codex queue`. Este recurso restringido evita agregar un segundo monitor de transporte, escucha persistente, caché de estado de cuenta o límite de uso a OpenCodex.

<a id="onoff-and-normal-usage-behavior"></a>

## Activación/desactivación y comportamiento normal

Hay **sin interruptor de activación/desactivación persistente**: la ejecución del ayudante es la opción de una presentación. Simplemente instalar/actualizar OpenCodex o mantener los scripts en disco no los ejecuta.

| Situación | Lo que hace este fallback |
| --- | --- |
| No invocado, tanto si hay contingente disponible como si se ha agotado | Nada: ningún proceso, temporizador, sondeo, oyente de fondo o solicitud originada por el ayudante. |
| Invocado normalmente mientras el uso está disponible | Hace colas para un mensaje ordinario. No se salta solo porque el compositor de escritorio está trabajando. El uso/facturación normal del proveedor se puede aplicar cuando se envía. |
| Invocado mientras solo el compositor está bloqueado | Intenta el mismo envío de cola nativa. La ruta configurada debe estar autorizada y disponible. |
| El proveedor real no tiene capacidad ni autorización | No pasa por alto esa restricción ni cambia de proveedor/cuenta; la ejecución en sentido ascendente aún puede fallar después de la aceptación de la cola. |
| `-DryRun` / `--dry-run` | Selecciona un destino y comprueba la ayuda del CLI, pero nunca envía texto ni comprueba la cuota de la cuenta, el estado del demonio o la disponibilidad del proveedor. |
| El bloqueo por uso se levanta más tarde | Vuelve a usar el cuadro de mensajes normal. No hay ajustes específicos de los scripts auxiliares que debas revertir. |

Para dejar de usar la reserva, deja de invocarla. Ejecute **no** `ocx restore` o deshabilite la integración Codex solo para desactivar este ayudante; eso también cambia el enrutamiento OpenCodex normal. Si ha programado el comando de forma independiente, desactive esa programación externa. Los elementos de cola ya aceptados pertenecen a Codex y aún pueden ejecutarse: eliminar el script, salir de su proceso o recuperar la cuota no los cancela. Inspeccione/elimine elementos no deseados a través de los controles de cola normales en la misma conversación. No envíe el mismo mensaje tanto en el ayudante como en el compositor.

<a id="check-compatibility-before-sending"></a>

## Compruebe la compatibilidad antes de enviar

Prefiera el CLI empaquetado en la aplicación; un `codex` instalado por separado en PATH puede ser más antiguo. Compruebe `codex queue --help` para `--thread` y `--message`. Los ayudantes prueban esta capacidad CLI, pero solo una solicitud real puede verificar el soporte `thread/queue/add` del demonio. Si Codex informa un método de cola no compatible, guarde el trabajo en curso antes de actualizar/reiniciar la instalación correspondiente. Los ayudantes nunca reinician un demonio o reintentan con otro servidor. No agregue `--no-daemon` a un comando de cola. Las actualizaciones de la aplicación CLI pueden cambiar la compatibilidad.

Primero abra la conversación prevista y confirme su proyecto, modelo y proveedor. Prefiera su **UUID explícito**; el nativo CLI también acepta un nombre de sesión exacto:

```powershell
codex queue --thread 'my-project-review' --message 'continue with the next step'
```

Desde una comprobación del repositorio, el ayudante Windows puede descubrir el paquete nativo `codex.exe`:

```powershell
.\scripts\codex-queue.ps1 -Thread 'my-project-review' -Message 'continue with the next step'
```

En macOS / Linux, utilice Bash (incluyendo macOS 's Bash 3.2):

```bash
bash scripts/codex-queue.sh --thread 'my-project-review' --message 'continue with the next step'
```

Fijar un binario de confianza coincidente con `-CodexExe 'C:\path\to\codex.exe'`, `--codex '/path/to/codex'` o `CODEX_EXE`. Una selección explícita no válida falla en lugar de seleccionar silenciosamente otro ejecutable. En Windows use un `.exe` nativo, no un npm `.cmd` o una shim PowerShell, para mantener el mensaje citando `cmd.exe`. Los paquetes de aplicaciones compatibles con colas y los diseños independientes se prueban antes de PATH. El descubrimiento automático de PATH ignora entradas vacías y relativas en lugar de sondear un CLI del proyecto actual implícitamente. Un binario local de confianza todavía se puede seleccionar explícitamente con `--codex './codex'` o `-CodexExe '.\codex.exe'`. Las raíces de instalación configuradas y las entradas absolutas de PATH aún deben ser confiables para el operador; este ayudante no verifica las firmas binarias. Discovery no prueba una versión de la aplicación que coincida.

<a id="private-diagnostics-and-optional-latest-thread-discovery"></a>

### Diagnósticos privados y descubrimiento opcional de última generación

Una ejecución seca oculta rutas ejecutables, UUID de subprocesos/nombres y el cuerpo del mensaje de forma predeterminada:

```powershell
.\scripts\codex-queue.ps1 -Thread 'my-project-review' -DryRun
```

Informa de la capacidad CLI y la selección de destino solamente, no la validación exitosa del lado del servidor. Para las tiendas basadas en despliegue heredado, `-Latest` / `--latest` opta explícitamente por un **última heurística de archivo**. Para ver esa selección, utilice un terminal privado no redireccionado:

```powershell
.\scripts\codex-queue.ps1 -Latest -DryRun -ShowTarget
```

```bash
bash scripts/codex-queue.sh --latest --dry-run --show-target
```

`-ShowTarget` / `--show-target` requiere una ejecución en seco y una salida de terminal local. Revela la ruta seleccionada y UUID/nombre solo por esta solicitud explícita, escapa a los caracteres de control y rechaza la salida redirigida, como la captura de CI. No lo use en terminales grabados/compartidos ni publique la salida públicamente. Nunca imprime el mensaje. La salida nativa ordinaria Codex durante una presentación real se pasa a través y puede contener identificadores; revíselo antes de compartir registros.

El último descubrimiento busca `CODEX_HOME/sessions` por tiempo de modificación, con el orden del nombre del archivo como desempate. Es **No es la conversación de escritorio actual** y puede seleccionar otro proyecto o un subagente. Verifique la vista previa local y, a continuación, envíe con el UUID explícito elegido. Latest también puede enviar cuando se proporciona un mensaje, pero sigue siendo una suscripción deliberada a esta heurística.

Los nombres de archivo `rollout-*.jsonl` reconocidos contienen un UUID de subproceso, a veces seguido de `_<rollout-uuid>`; el ayudante usa el primer UUID. Los nombres mal formados se omiten. Las tiendas que faltan o son ilegibles fallan sin seleccionarlas de otra casa. Los almacenes solo migrados/paginados y las conversaciones solo remotas pueden no tener un despliegue local coincidente; use un UUID/nombre explícito.

Mantenga todo el mensaje en un solo argumento. Bash acepta `--message '- start with this'` o `-- '- start with this'`; PowerShell acepta `-Message '- start with this'`. El historial de shell y los listados de procesos locales pueden exponer el texto de la línea de comandos, así que no incluya credenciales en las solicitudes.

<a id="queued-is-not-the-same-as-executed"></a>

## En cola no significa ejecutado

`Queued message ... for thread ...` confirma la **aceptación en la cola**, no la ejecución del modelo ni su finalización. Un hilo ocupado puede estar esperando a que termine su turno actual o se resuelva una aprobación. Según la implementación, un hilo guardado que no está cargado puede conservar el mensaje hasta que otro cliente lo reanude.

Comprueba la cola y la actividad en la **misma conversación**. Si el hilo no está cargado, ábrelo en la aplicación o usa `codex resume <thread-id>` sin volver a añadir el mensaje. Revisa las aprobaciones pendientes y el estado de la cola. Cada invocación puede crear otro elemento; si el fallo es ambiguo, inspecciona el estado antes de reintentar. Los scripts auxiliares conservan el código de salida de la CLI y nunca reenvían automáticamente.

El CLI nativo tiene `--remote` opciones explícitas (véase `codex queue --help`), a diferencia de asumir que la conexión de control remoto del escritorio se reutiliza. Mantener la configuración de autenticación sin cambios no repara errores de autenticación/red no relacionados ni garantiza la continuidad del control remoto.

<a id="starting-or-resuming-work-without-the-composer"></a>

## Iniciar o reanudar el trabajo sin el compositor

`codex exec '<prompt>'` inicia una tarea no interactiva, **no** un mensaje en el subproceso de escritorio abierto. Compruebe su directorio de trabajo, proveedor, permisos y configuración. `codex resume <thread-id>` reanuda una sesión explícita. `codex resume --last` normalmente se filtra por directorio de trabajo actual; `--all` deshabilita ese filtro, mientras que otros filtros de elegibilidad aún pueden aplicarse. Una selección global no es necesariamente la sesión del sistema de archivos visible o más reciente. Prefiere una identificación explícita para el trabajo de escritorio en curso.

<a id="scope-and-verification"></a>

## Alcance y verificación

Esta alternativa deja solos los derechos de la cuenta y los archivos de la aplicación. No es una reparación consciente del proveedor del compositor / selector de modelos, una función automática de recuperación de cuotas o la limpieza de los cambios de proxy / certificado no relacionados de experimentos anteriores.

La sonda original Windows (escritorio `26.917.9434.0`) reportó aceptación de cola para un hilo en vivo y un error esperado para un hilo inexistente. Eso no es una inferencia general de extremo a extremo, hilo descargado, control remoto o garantía multiplataforma. La fuente aguas arriba se comprobó en `7dae8c53d97e61cd774e4d6bcca5243c29ca615c`:

- [Opciones de cola CLI](https://github.com/openai/codex/blob/7dae8c53d97e61cd774e4d6bcca5243c29ca615c/codex-rs/cli/src/queue_cmd.rs) y [presentación de app-server](https://github.com/openai/codex/blob/7dae8c53d97e61cd774e4d6bcca5243c29ca615c/codex-rs/tui/src/session_queue_commands.rs).
- [Envío de cola de hilo cargado](https://github.com/openai/codex/blob/7dae8c53d97e61cd774e4d6bcca5243c29ca615c/codex-rs/ext/queue/src/service.rs) y [Opciones de selección de reanudación](https://github.com/openai/codex/blob/7dae8c53d97e61cd774e4d6bcca5243c29ca615c/codex-rs/cli/src/main.rs).

Ejecute regresiones de envoltura sin conexión con `node --test scripts/codex-queue.test.mjs` (Node 20+). Utilizan CLIs nativos falsos y hogares temporales, nunca cuentas reales o solicitudes de modelos. El flujo de trabajo **Codex ayudantes de cola** ejecuta estas pruebas en Windows PowerShell 5.1 y PowerShell 7, macOS Bash y Linux Bash; falla un shell requerido faltante en lugar de omitirlo silenciosamente. Los accesorios de configuración-preservación cubren la configuración del proveedor incorporado/personalizado y ambos valores del estado de uso, no el enrutamiento OpenCodex en vivo. Valide el despacho de escritorio real, el éxito del proveedor y la continuidad del control remoto por separado en las instalaciones compatibles.
