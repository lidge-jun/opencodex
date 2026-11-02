---
title: Tiempos de espera al proteger permisos de archivos en Windows
description: Cómo se recuperan las escrituras atómicas después de un bloqueo temporal de icacls.
---

En Windows, opencodex usa `icacls` para proteger los archivos temporales antes de
escribir configuraciones, credenciales o datos de caché. Si no consigue aplicar
los permisos requeridos, la escritura falla y el destino anterior se conserva.

Un tiempo de espera temporal de `icacls` no exige reiniciar el proxy. Una escritura
atómica posterior al mismo destino puede realizar un intento de recuperación. Si
también agota el plazo, se rechazan las escrituras posteriores a ese destino hasta
que hayan pasado cinco minutos desde el inicio del intento de recuperación. La
siguiente escritura podrá volver a intentar aplicar los permisos. La recuperación
ocurre cuando se solicita una escritura; no hay un temporizador que la ejecute.

Si un proceso anterior de `icacls` sigue activo después de que venza el plazo de
quien lo inició y aún no se ha recogido su terminación, se rechazan las escrituras
al mismo destino, incluso después de los cinco minutos. Esos rechazos se devuelven
pronto y conservan el siguiente intento de recuperación. Las escrituras simultáneas
sin problemas pueden continuar, incluso mientras otra aplica permisos a su archivo
temporal o espera para renombrarlo.

Cada intento de recuperación debe completar la protección de permisos antes de
publicar el archivo. Los errores de permiso denegado siguen siendo fallos y no
activan un reintento automático. Limpiar una escritura fallida no consume el intento
de recuperación de la siguiente. Cada destino mantiene su propio seguimiento de
tiempos de espera.
