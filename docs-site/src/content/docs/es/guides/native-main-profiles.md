---
title: "Perfiles del inicio de sesión nativo principal"
description: "Administre los perfiles guardados del inicio de sesión nativo de Codex por separado del enrutamiento Pool de OpenCodex."
---

<a id="native-login-is-not-pool-selection"></a>

## El inicio de sesión nativo es independiente de la selección Pool

En Multi-auth, dentro de los ajustes de Codex, abra
**Administrar el inicio de sesión principal** en el panel independiente
**Inicio de sesión nativo principal**, situado debajo de la tarjeta de la cuenta
principal. El mismo panel aparece junto a esa tarjeta en el espacio de cuentas
de Proveedores. Administra el inicio de sesión real de Codex, no la cuenta que
atenderá la siguiente solicitud Pool. No añade una pestaña de Integraciones ni
reemplaza los controles existentes de Pool.

El **CODEX_HOME efectivo** mostrado pertenece al servidor de OpenCodex.
Si usa un panel remoto, puede estar en un equipo distinto del navegador.
**Perfil activo registrado** identifica al propietario registrado en el almacén
de perfiles cifrados. El servidor verifica el inicio de sesión real antes de
cambiarlo: un inicio de sesión modificado fuera de OpenCodex puede provocar
un error de propiedad en lugar de sobrescribirse silenciosamente.

<a id="save-and-switch"></a>

## Guardar y cambiar

Use **Guardar el inicio de sesión actual como perfil** para registrar el inicio
de sesión de la aplicación. Si el inicio de sesión activo ya está registrado,
esta acción actualiza su nombre y no añade otra cuenta. Cambiar de perfil
requiere el almacén de credenciales en archivos compatible y un almacén de
claves del sistema operativo disponible. Los códigos de diagnóstico explican
por qué no están disponibles los controles. No eluda errores del almacén de
claves o de propiedad copiando credenciales de Pool al archivo de inicio
de sesión nativo. El panel permanece desactivado mientras la tarjeta principal
está realizando su operación de reautenticación nativa mediante dispositivo.

Seleccione **Cambiar** junto a un perfil guardado que esté inactivo.
Revise su nombre y el **CODEX_HOME** mostrado; cierre Codex nativo en el equipo
servidor que usa ese **CODEX_HOME**. Marque la casilla bajo los pasos para
confirmar que Codex está cerrado y, después, confirme el cambio.
No se envía ninguna modificación de credenciales antes de la confirmación.
Justo antes de enviar la operación, el panel vuelve a leer el directorio actual,
el propietario activo y el estado de recuperación. Si cambiaron, revise el
nuevo estado y vuelva a confirmar. El backend sigue siendo la autoridad para
los bloqueos, las comprobaciones de procesos, el drenaje de solicitudes
en curso, la activación y la reversión.

La confirmación muestra tres pasos: cerrar Codex en el equipo servidor para
el **CODEX_HOME** indicado; marcar la casilla que confirma que está cerrado
y confirmar el cambio; esperar el resultado y el perfil activo actualizado
antes de seguir las instrucciones para volver a abrir Codex.
Mantenga Codex cerrado hasta comprobar el resultado. Las instrucciones de
reapertura esperan a que terminen la lectura de verificación y la actualización
de cuentas. Si falla la actualización, se le pide actualizar antes de continuar.

Si `CODEX_BUSY` bloquea el cambio, cierre Codex en el servidor para el
**CODEX_HOME** indicado, seleccione **Actualizar estado** y revise el perfil
activo. Seleccione **Cambiar** de nuevo y marque la casilla que confirma que
Codex está cerrado antes de confirmar. Actualizar solo lee el estado:
no reintenta el cambio.

Un error de comprobación de procesos pide verificar que Codex esté cerrado
e inspeccionar los diagnósticos del servidor. Los errores por solicitudes
activas u operaciones ocupadas piden esperar a que termine el trabajo existente.
Un error de almacenamiento indica que el servidor no puede acceder de forma
segura al directorio de inicio de sesión o al almacén de perfiles; revise los
diagnósticos antes de otro cambio. Los demás errores permitidos identifican
problemas de perfil, almacén de claves, almacenamiento o recuperación,
sin mostrar mensajes sin filtrar del servidor.

Una respuesta perdida deja el resultado sin confirmar, incluso si el perfil
activo actualizado ha cambiado. La ausencia de respuesta no significa que
se haya restaurado el inicio de sesión original. Nada se reintenta
automáticamente. Para reintentar un cambio, seleccione de nuevo la acción
y confirme que Codex está cerrado.

Los resultados se muestran como **Último resultado confirmado**.
Una actualización manual borra el error visible, pero no confirma una
transacción anterior cuya respuesta se perdió. Puede seguir apareciendo
un requisito de reinicio de un cambio confirmado previamente.

Después de un éxito, compruebe el perfil activo actualizado y vuelva a abrir
Codex nativo en el servidor con el **CODEX_HOME** indicado. Siga cualquier
requisito de reinicio mostrado. El panel vuelve a leer el estado de los perfiles
y actualiza el controlador de cuentas existente. No llama a las operaciones
de selección o configuración de Pool ni modifica claves de proveedores, tareas
o historial. El backend sigue conciliando la identidad nativa `__main__`
igual que en el flujo de la CLI.

<a id="recovery-and-previous-profiles"></a>

## Recuperación y perfiles anteriores

Son operaciones diferentes:

- **Recuperar el cambio interrumpido** concilia una transacción del backend
  que quedó incompleta. **Restaurar la transacción pendiente** solicita
  revertir esa transacción. Ambas requieren marcar la casilla que confirma
  que Codex está cerrado antes de confirmar el cambio. Estos controles siguen
  disponibles si no se puede leer una lista de perfiles dañada, pero los
  diagnósticos indican que hay una recuperación pendiente.
- **Volver al perfil mostrado anteriormente**, después de un cambio correcto,
  selecciona el perfil mostrado antes del cambio mediante el flujo normal
  con confirmación. Este acceso directo solo se conserva en la memoria de
  la página, vinculado al directorio y al propietario activo esperado.
  Desaparece al recargar la página o al cambiar el proxy o el propietario.
  La API no devuelve el origen de la transacción: no es un historial de
  deshacer verificado por el servidor. Otro operador pudo cambiar el inicio
  de sesión entre la lectura previa y su cambio. Después de recargar,
  seleccione directamente el perfil guardado que desee.

Un error de red no demuestra que una escritura haya fallado o se haya revertido.
Después de enviar una modificación, incluso si se pierde la respuesta, el panel
vuelve a leer el estado del servidor y nunca reintenta automáticamente.
Si falla la actualización, un cambio correcto no se presenta como deshecho.
Actualice e inspeccione los diagnósticos antes de otra operación.
El comando `ocx account main doctor` ofrece diagnósticos del servidor.

<a id="scope-of-this-phase"></a>

## Alcance de esta fase

El panel enumera, registra, cambia y recupera perfiles existentes mediante
`/api/native-main-profiles`. No inicia procesos de inicio de sesión ni expone
tokens de escritura para la preparación. Añadir otro inicio de sesión nativo
sigue siendo parte del flujo de CLI `ocx account main add`; el registro desde
el navegador queda para un seguimiento separado de la incidencia #3417.
La reautenticación mediante dispositivo de la cuenta principal actual es
otro flujo y no se reemplaza con este panel.

Los datos de los perfiles no se escriben en el almacenamiento del navegador.
El cliente solo expone campos públicos, muestra códigos de error permitidos
en lugar de mensajes sin filtrar del servidor y utiliza el mecanismo
autenticado de solicitudes existente en la aplicación.
Se mantienen las comprobaciones del backend para la autenticación de
administración, las sesiones GUI/CSRF y la admisión de rutas.
