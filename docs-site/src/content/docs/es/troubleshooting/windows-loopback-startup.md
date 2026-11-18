---
title: Inicio y tiempos de espera en bucle local en Windows
description: Cómo comprueba OpenCodex quién controla el puerto cuando se agota el tiempo de conexión a un puerto de bucle local libre en Windows.
---

En algunos equipos con Windows, una conexión a un puerto local libre, como
`127.0.0.1:10100`, puede agotar el tiempo de espera. Las versiones anteriores
de OpenCodex pueden rechazar el inicio con «Proxy ownership is unverified» o
«Shared-client owner could not be verified». El servicio del Programador de
tareas puede entonces volver a iniciarse y cerrarse repetidamente.

Si se agota el plazo para establecer la conexión durante el inicio, OpenCodex
puede abrir brevemente un socket exclusivo en la misma dirección y puerto.
También comprueba si hay sockets a la escucha en todas las direcciones de esa
familia, pues pueden coincidir con un socket de bucle local en Windows. El inicio
solo continúa si las comprobaciones de titularidad lo permiten. Un puerto
ocupado, una comprobación inconclusa o indicios de que otro proceso controla el
puerto aún pueden impedir el inicio.

Usa `ocx service status` y `ocx status` para comprobar el servicio registrado y
el proxy. Si persiste el conflicto, comprueba qué proceso controla el puerto
indicado y vuelve a intentarlo cuando se haya detenido o recuperado. Conserva
el registro del PID y el diario de recuperación para la próxima comprobación.
