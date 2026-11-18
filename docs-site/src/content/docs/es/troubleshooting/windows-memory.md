---
title: "Crecimiento de memoria en Windows"
description: "Por qué puede crecer la memoria de Bun en Windows, cómo inspeccionarla y qué mecanismos de mitigación ofrece opencodex."
---

Algunos usuarios de Windows observan que el proceso `bun` de opencodex alcanza muchos
gigabytes de RSS durante sesiones largas de transmisión, como se informó en la incidencia
[#314](https://github.com/lidge-jun/opencodex/issues/314). Esta página explica las causas
conocidas, las mitigaciones disponibles y sus límites.

<a id="root-cause-upstream-bun-runtime-issues"></a>

## Causa raíz: problemas del entorno de ejecución de Bun

Las versiones anteriores de OpenCodex incluían Bun **1.3.14**. La tabla siguiente recoge
la investigación del 23 de julio de 2026: es evidencia histórica, no el estado actual de
las incidencias de Bun. El paquete actual incluye Bun **1.4.4** y el control de
compatibilidad reconoce Bun estable 1.4.0 o posterior como portador de la corrección de
cancelación async-pull. Esto no demuestra que se hayan resuelto todas las causas del
crecimiento de memoria en Windows.

| Incidencia de Bun | Estado (comprobado el 2026-07-23) |
|---|---|
| [#28035](https://github.com/oven-sh/bun/issues/28035) — la contrapresión de recepción de `fetch()` no está vinculada al consumo de JavaScript | Corregida mediante [PR #29831](https://github.com/oven-sh/bun/pull/29831); **no se ha verificado qué versión incluye la corrección**; se supone que Bun 1.3.14, incluido en el paquete de entonces, no la contiene |
| [#32111](https://github.com/oven-sh/bun/issues/32111) — fallo cuando un cliente cancela un flujo async-pull | La corrección [PR #32120](https://github.com/oven-sh/bun/pull/32120) se integró el 2026-06-21; no se presupone que esté incluida en Bun 1.3.14. Este fallo **no es específico de Windows**: también se reprodujo en macOS y Linux |
| [PR #31654](https://github.com/oven-sh/bun/pull/31654) — fuga de handles de sockets en `node:net` | Todavía **abierto** en Bun |

En entornos antiguos, Windows usaba la ruta conservadora basada en tee para evitar el
fallo de cancelación async-pull. Un cliente lento podía dejar datos en memoria nativa
que JavaScript no podía limitar. Con el entorno estable actual, Windows selecciona el
relé acotado en `auto` cuando no hace falta reescribir la respuesta para el cliente.
Un `legacy-tee` explícito conserva la ruta anterior. En macOS, `auto` sigue usando tee
y el relé requiere activación explícita. Compruebe el entorno seleccionado y la decisión
efectiva de transmisión antes de diagnosticar el crecimiento de memoria.

<a id="what-opencodex-does-today"></a>

## Lo que opencodex hace hoy

La mitigación acotada y las herramientas de observación ayudan a diagnosticar la
retención, pero no demuestran que todos los casos de crecimiento de memoria estén
corregidos:

- **Supervisión de memoria**: el proxy muestrea su propia memoria cada minuto y emite
  una advertencia con frecuencia limitada cuando la memoria observada supera 4 GiB.
  La memoria observada es el mayor valor entre RSS, `external` y `arrayBuffers`,
  sin sumarlos. En Windows, los contadores del conjunto de trabajo y RSS pueden mostrar
  menos memoria de la que realmente está comprometida para retención externa.
- **`ocx doctor`**: la sección «Memoria / entorno de ejecución» muestra la versión de
  Bun del proceso del *servicio*, RSS, los contadores external/ArrayBuffers, el contexto
  del heap de JavaScript y la decisión del modo de transmisión. En entornos antiguos
  de Bun 1.3.14, `heapUsed` y `jscHeap` por sí solos no permiten identificar una fuga.
  Compare la memoria observada con `responseState` y con muestras repetidas antes de
  atribuir una fuga a la aplicación.
- **`GET /api/system/memory`**: ofrece los mismos datos mediante la API de gestión
  autenticada para paneles o scripts. Junto a los contadores RSS/heap/external, devuelve
  un bloque escalar `responseState` para el almacén de continuaciones
  `previous_response_id` que el proxy mantiene en memoria. Incluye el número de
  entradas, el total y el máximo de bytes serializados y la antigüedad de la entrada
  más antigua.

  Si `responseState.totalBytes` aumenta junto con la memoria observada, eso apunta
  a la retención de conversaciones: cadenas largas `store:false` que se expanden de
  nuevo en cada turno. Si `responseState` permanece estable mientras aumenta la
  memoria observada, la causa probablemente está fuera de ese almacén. Los valores
  son únicamente escalares, sin cuerpos de solicitud, tokens, rutas ni identificadores
  de cuenta. La lectura no tiene efectos secundarios: nunca elimina entradas.

  El estado de las escrituras de desbordamiento en disco se informa por separado
  dentro de ese bloque. `spillWriteStatus` comienza como `initial`, pasa a
  `degraded` tras una publicación fallida y vuelve a `healthy` después de la
  siguiente publicación correcta. `spillWriteConsecutiveFailures`, la hora del
  último fallo y la del último éxito muestran si los fallos se acumulan o si el mismo
  proceso se está recuperando. El último fallo se representa mediante una clase fija
  que protege la privacidad, como `EACCES`, `ENOSPC`, `ETIMEDOUT` o
  `EACLRETRYEXHAUSTED`. Nunca se devuelven mensajes de error sin filtrar ni rutas
  del sistema de archivos.

  `spillLastWriteFailureOrigin` añade un origen fijo o null:
  `retry_returned_timeout` significa que el segundo intento de escritura de
  desbordamiento existente devolvió un tiempo de espera agotado;
  `timeout_memo_refusal` significa que el auxiliar de ACL rechazó la operación
  debido al estado de tiempo de espera que tenía memorizado. Otros fallos usan null.
  Los contadores acumulativos `spillAclRetryReturnedTimeouts` y
  `spillAclTimeoutMemoRefusals` cuentan publicaciones que terminaron en fallo,
  no comandos ACL individuales ni primeros intentos que fallaron transitoriamente.

  Cuando una nueva continuación no cabe dentro del límite de desbordamiento de
  1 GiB, el proxy elimina primero las continuaciones almacenadas más antiguas para
  liberar espacio, siempre que eso permita alojarla. Si aun así no cabe, la rechaza.
  El contador acumulativo `spillHeadroomEvictions` cuenta las continuaciones
  eliminadas para liberar espacio; `spillCapacityRefusals` cuenta las rechazadas
  porque no se pudo hacer espacio dentro del límite. Cada rechazo también es una
  publicación fallida de clase `ECAPACITY`. Si `spillCapacityRefusals` aumenta
  mientras la memoria se mantiene en valores normales, el conjunto de continuaciones
  persistentes está lleno de espacio que el proxy no puede recuperar, como
  publicaciones en curso o archivos que quedaron tras una eliminación fallida.

  Un éxito reinicia la racha de fallos, pero conserva los campos del último fallo
  y los contadores acumulativos. Un fallo posterior no relacionado establece el
  último origen en null. Estos valores pertenecen a cada proceso: compare
  instantáneas del mismo proceso. Ninguno de los orígenes identifica un comando
  del sistema operativo. El presupuesto de tiempo del intento puede agotarse antes
  de iniciar un comando, y una inspección opcional de cumplimiento puede ejecutarse
  antes del rechazo basado en el estado memorizado. Que una operación tenga éxito
  en otro proceso no demuestra que se haya recuperado el estado memorizado del
  proceso en ejecución. Estas observaciones no añaden reintentos, no borran estados
  memorizados, no debilitan las ACL requeridas ni reinician automáticamente el servicio.

  Estos diagnósticos permanecen en el endpoint de gestión autenticado y están
  deliberadamente ausentes de `/healthz`, que sigue siendo una señal de actividad.
  La tarjeta **Observabilidad de la memoria** del panel muestra los campos de
  memoria y tamaño de las continuaciones. Su acción **Drenar y reiniciar** requiere
  confirmación: muestra el número de turnos activos, espera hasta 60 s a que terminen
  y después cancela los que sigan activos. Reutiliza la respuesta de drenaje
  HTTP 503 JSON `server_restarting` y `Retry-After: 5`.

  El proxy en ejecución controla la autorización de reinicio y coordina el drenaje
  antes de salir. Si corresponde, el gestor de servicios instalado inicia el proceso
  de reemplazo. La acción solo informa de éxito cuando un proceso diferente, cuya
  identidad se ha verificado, responde correctamente en el mismo puerto, sin
  desmontar la inyección de Codex. Este reciclaje es más largo y proporciona más
  información que el drenaje breve de `POST /api/stop`.

  Para obtener una instantánea completa de la respuesta autenticada mediante un
  script, ejecute `ocx observe memory --json`. La CLI devuelve los mismos campos
  de estado de las respuestas.
- **Una ruta de transmisión alternativa con control de compatibilidad**: un relé
  con un solo lector limita el almacenamiento en búfer. En Windows, `auto`
  selecciona esta ruta cuando el entorno compatible y la forma de la respuesta lo
  permiten; `legacy-tee` conserva explícitamente la ruta tee. En macOS, `auto`
  mantiene tee y `eager-relay` requiere activación explícita. Compruebe la decisión
  efectiva del entorno de ejecución seleccionado.

Las lecturas de metadatos del catálogo usan el último catálogo incluido que se confirmó
para el entorno de ejecución seleccionado. Las selecciones nuevas o modificadas se
actualizan mediante sondeos asíncronos de versión y modelos, de modo que esos sondeos
no bloquean el bucle de eventos del proxy. Las actualizaciones compartidas tienen un
plazo de 45 segundos. Si falla una actualización iniciada por una solicitud, se
conservan las filas coincidentes y se espera 60 segundos antes de reintentar.
La cancelación de una solicitud libera la contabilidad del traductor, incluso cuando
no se ha leído el cuerpo de la respuesta. Estas mejoras de actividad no demuestran
que se haya resuelto la retención de flujos nativos en Windows
([#6671](https://github.com/lidge-jun/opencodex/issues/6671)).

La mejora real de RSS con estos cambios **sigue pendiente de verificación por parte de
usuarios de Windows**. No afirmamos que la fuga esté corregida.

El reinicio automático al superar un umbral **no está implementado**, por decisión
del proyecto. Si el proceso falla, los gestores de servicios (Task Scheduler/WinSW,
launchd o systemd) ya lo reinician.

<a id="your-options"></a>

## Sus opciones

1. **Compruebe el entorno y la ruta de transmisión efectivos.** El paquete actual
   incluye Bun 1.4.4 y el control de compatibilidad acepta versiones estables desde
   1.4.0. En Windows, `auto` ya puede seleccionar el relé acotado cuando corresponde;
   no es necesario esperar otra actualización para habilitarlo. Una selección
   explícita de `legacy-tee` conserva tee. Esto no demuestra que estén resueltas
   todas las causas del crecimiento de memoria.

2. **Ejecute un entorno de ejecución Bun en el que confíe con `OPENCODEX_BUN_PATH`.**
   Configure la variable antes de iniciar `ocx` desde ese shell y, después,
   ejecute `ocx service repair` para guardar el entorno seleccionado en la definición
   del servicio. Un archivo `.env` del proyecto que se cargue después no modifica
   esa selección. Cambiar la variable de entorno por sí solo tampoco actualiza un
   servicio que ya está instalado.

3. **Seleccione el relé acotado con `streamMode: "eager-relay"`.** Puede editar
   `config.json` para añadir `"streamMode": "eager-relay"` o enviar
   `PUT /api/settings` con `{"streamMode":"eager-relay"}`. El cambio por API se
   aplica a turnos nuevos sin reiniciar. El aviso de fallo de Bun 1.3.14 es
   histórico: esa versión usaba la forma de transmisión afectada por #32111 y
   podía fallar en cualquier sistema operativo, interrumpiendo las solicitudes
   activas aunque el servicio se reiniciara. `"legacy-tee"` fuerza la ruta tee
   anterior. En Windows, `"auto"` usa el control de compatibilidad del entorno
   y las condiciones de la respuesta; en macOS, `"auto"` conserva tee y
   `"eager-relay"` es la activación explícita.

Si prueba alguna de estas opciones con una carga real en Windows, comparta las
secciones de memoria de `ocx doctor` de antes y después en
[#314](https://github.com/lidge-jun/opencodex/issues/314). Esa es la verificación
que esta mitigación todavía necesita.

<a id="windows-selected-runtime-write-refusal"></a>

## Rechazo de escritura del entorno seleccionado en Windows

La instalación y reparación del servicio de Windows, así como la instalación y
actualización del shim de Codex, comprueban si el ejecutable seleccionado puede crear
y eliminar un directorio dentro de la raíz de configuración de OpenCodex. Es una
comprobación de la política de escritura, no una corrección del problema de memoria.
Si falla, la operación se rechaza antes de detener el servicio, descargar archivos,
preparar la instalación o escribir tokens o lanzadores.

La reparación automática del shim se pospone y muestra instrucciones, mientras el
inicio continúa. Los shims que funcionan correctamente o están desactivados no realizan
la comprobación. No se busca otro entorno de ejecución. En una primera instalación
con el Programador de tareas, la tarea se registra y se asume la propiedad de la raíz
de configuración antes de la comprobación. Si se rechaza la operación, ese registro
nuevo se revierte y la raíz de configuración queda bajo la propiedad adquirida para
un nuevo intento.

> El entorno de ejecución Bun seleccionado no pudo crear y eliminar un directorio
> dentro del directorio de configuración de OpenCodex. La política de aplicaciones
> de Windows puede impedir la escritura desde la ubicación de este ejecutable.
> Configure OPENCODEX_BUN_PATH con un ejecutable Bun de confianza permitido por su
> política antes de iniciar ocx, o reinstale opencodex con
> npm install -g @bitkyc08/opencodex y vuelva a intentarlo. No se seleccionó otro
> entorno de ejecución.
