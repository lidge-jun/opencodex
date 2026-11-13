---
title: "Uso del disco por archivos temporales"
description: "Qué son los archivos responses-state.json.ocx.*.tmp, por qué podrían acumularse y cómo recuperarlos."
---

Algunos usuarios encontraron muchos gigabytes de archivos nombrados como `responses-state.json.ocx.<pid>.<seq>.tmp` en su hogar opencodex (`~/.opencodex` por defecto), creciendo después de cada reinicio.

<a id="what-these-files-are"></a>

## Qué son estos archivos

opencodex mantiene una caché de continuación para que las cadenas `previous_response_id` sobrevivan a un reinicio proxy. Escribe esa instantánea atómicamente: el contenido va primero a un archivo temporal y luego reemplaza el archivo real en un solo paso. Eso es lo que impide que una caída a mitad de la escritura deje una instantánea a mitad de la escritura.

El archivo temporal se elimina normalmente en cuanto termina el reemplazo. Si el proceso termina entre ambos pasos, ese archivo permanece en el disco.

Cada archivo puede ser de hasta 24 MB porque la instantánea se reescribe entera, no anexada. Por lo tanto, unos pocos cientos de archivos abandonados se suman rápidamente.

**Son caché, no un estado duradero.** Eliminarlos no cuesta nada, excepto que las cadenas de conversación en vuelo pueden volver a enviar el contexto una vez. No hay configuración, credenciales o historial vivo en estos archivos.

<a id="why-they-could-accumulate"></a>

## Por qué se pueden acumular

Una limpieza ya existía, pero se ejecutó en un solo momento: cuando un proxy cargó la caché de continuación por primera vez, lo que sucede *antes* ese proceso escribe cualquier cosa. Dos consecuencias siguieron.

Al reiniciarse tras un fallo, el proxy ejecutaba la limpieza demasiado pronto para detectar el archivo temporal de su predecesor: hay un período de gracia de 15 minutos para no tocar archivos que aún se están escribiendo. Después no volvía a comprobarlos durante el resto de su ejecución. Así, cada reinicio podía dejar otro archivo.

Peor aún, la limpieza omitió cualquier archivo cuyo ID de proceso de posesión todavía estaba vivo. Después de un reinicio, el sistema operativo vuelve a emitir rutinariamente los mismos ID de proceso, por lo que un archivo antiguo podría confundirse permanentemente con uno que pertenece a un proceso en ejecución. Es por eso que el crecimiento rastreó reinicios.

<a id="what-opencodex-does-now"></a>

## Lo que opencodex hace ahora

La limpieza se repite en el temporizador de fondo normal del proxy en lugar de ejecutarse una vez en el inicio, por lo que un proxy en ejecución reclama archivos abandonados por sí solo. También ignora la verificación de ID de proceso para los archivos más antiguos que el arranque actual, ya que ningún proceso en ejecución puede poseerlos.

Las reglas de seguridad no cambian: un archivo menor de 15 minutos nunca se elimina, y el proxy nunca elimina un archivo que está escribiendo.

<a id="how-often-the-snapshot-is-written"></a>

## Con qué frecuencia se escribe la instantánea

Las escrituras se agrupan tras un período sin cambios. La espera se calcula a partir del tamaño de la **última instantánea realmente escrita**: con un archivo pequeño, la siguiente escritura se programa unos dos segundos después del cambio; cerca del límite de 24 MB, la espera aumenta hasta un máximo de treinta segundos. Si la caché acaba de crecer, todavía usa una vez la espera corta: el intervalo más largo se aplica desde la escritura siguiente. Solo se omite un guardado cuando este proceso ya escribió los mismos bytes en el mismo archivo, el contenido de disco sigue coincidiendo y, fuera de Windows, los permisos siguen siendo exclusivos del propietario. Un proceso nuevo reescribe una vez incluso una instantánea idéntica. Si otro proceso cambia el contenido o los permisos, se vuelve a escribir mediante la ruta que asegura los permisos.

Cada cadencia de fondo ordinaria realiza como máximo una reescritura atómica completa. Si la memoria caché de continuación cambia mientras esa escritura está en progreso, opencodex programa un seguimiento de la cadencia retardada normal en lugar de volver a escribir la instantánea completa de inmediato. El apagado elegante mantiene su comportamiento de reintento limitado después de que las solicitudes en vuelo se hayan agotado para que la instantánea final pueda ponerse al día antes de que salga el proceso.

En conjunto, estas reglas mantienen aproximadamente constante la frecuencia de escritura al crecer la caché, en lugar de volver a serializar y reemplazar todo el archivo cada dos segundos.

Un apagado elegante se descarga inmediatamente en lugar de esperar el temporizador, por lo que la espera más larga amplía principalmente la ventana en la que una muerte dura pierde las entradas de continuación más recientes, que son caché, como se mencionó anteriormente. Esa descarga sigue siendo una escritura de disco y puede fallar como cualquier otra, por lo que un apagado en un volumen completo o de solo lectura puede perder las mismas entradas.

<a id="reclaiming-files-that-already-accumulated"></a>

## Recuperar archivos que ya se han acumulado

Si el proxy se ejecuta, esto sucede automáticamente en uno o dos minutos.

Si el proxy **no se inicia**, que es cuando la acumulación puede crecer más rápido, comprueba y recupera el espacio desde la línea de comandos:

```bash
ocx doctor
```

La sección "Response-state temp files" informa cuántos archivos son recuperables y cuánto espacio ocupan. Solo informa; no cambia nada.

Para eliminarlos realmente:

```bash
ocx doctor --reclaim-response-temps
```

Ambos comandos funcionan sin un proxy en ejecución. Los archivos actualmente bloqueados por otro proceso se informan en lugar de forzarse. Se vuelven a intentar en la siguiente recuperación: automáticamente mientras se ejecuta el proxy, de lo contrario, la próxima vez que ejecute este comando.

Si un backlog muy grande excede una pasada, el comando dice cuántos archivos quedan para que pueda ejecutarlo de nuevo.

Esta limpieza solo cubre los archivos temporales de las instantáneas del estado de respuestas. Los archivos temporales de otros componentes, aunque tengan nombres similares, no se modifican.

<a id="spill-files-responses-state-spill"></a>

## Archivo de derrames (`responses-state-spill/`)

Un directorio hermano, `~/.opencodex/responses-state-spill/`, mantiene continuaciones de conversación derramadas. Cuando la memoria caché de continuación en memoria supera su presupuesto residente, opencodex mueve las cargas útiles más antiguas a estos archivos y mantiene solo un pequeño stub en `responses-state.json`. Esto es lo que mantiene la instantánea pequeña sin dejar caer largas cadenas `previous_response_id`.

El almacén está limitado, por lo que este directorio no puede crecer sin límite mientras se ejecuta el proxy:

- como máximo **1 GiB** de carga útil derramada,
- como máximo **1000** respuestas almacenadas,
- Cada entrada expira **24 horas** después de que se almacenó.

Cuando se golpea un límite, las entradas más antiguas son desalojadas y sus archivos de derrame se eliminan con ellas.

**Reiniciar conserva cada archivo de derrame que la instantánea todavía hace referencia.** Un reinicio recarga los stubs y vuelve a poseer los archivos detrás de ellos, por lo que no se pierde nada al reiniciar. Un archivo se convierte en basura solo cuando ya no se hace referencia (desplome de las sobras y limpiezas fallidas) y opencodex las recupera después de un período de gracia de 15 minutos.

**No borre los archivos de derrame manualmente.** Los archivos a los que todavía se hace referencia son parte de una cadena de continuación en vivo, y la recuperación ya maneja los no referenciados. `ocx doctor` reporta la división sin tocar nada: una sección de "Response-state spill files" muestra el total de archivos y bytes en el disco, cuánto todavía es propiedad de la tienda o la instantánea persistente, y cuánto se asienta como candidatos huérfanos recuperables. Las mismas cuentas están en la gestión API en `/api/system/memory` bajo `responseSpill`.
