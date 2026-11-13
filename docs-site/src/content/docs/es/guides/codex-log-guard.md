---
title: "Codex Log Guard"
description: "Inspecciona y reduce de forma explícita la persistencia de registros de diagnóstico de Codex sin exponer su contenido."
---

OpenCodex puede inspeccionar la base de datos persistente de registros de diagnóstico de Codex y, si lo activas expresamente, reducir las filas que Codex guarda. La inspección es de solo lectura. Activar la protección modifica la base de datos y solo se permite cuando coincide el esquema de registros conocido y Codex está detenido.

<a id="what-inspect-reports"></a>

## Qué muestra la inspección

OpenCodex resuelve el valor efectivo de `sqlite_home` siguiendo la precedencia de Codex e inspecciona allí la base de datos canónica `logs_2.sqlite`. Nunca usa como destino modificable un archivo `logs_N.sqlite` heredado o de numeración superior.

La vista Almacenamiento informa:

- el tamaño de la base de datos principal y de sus archivos WAL y SHM;
- el total de filas y la proporción guardada con nivel `TRACE`;
- los destinos de registro con más filas, identificados por su posición en la clasificación y sin revelar sus nombres;
- el espacio de páginas libres de SQLite que podría recuperarse más adelante; y
- la compatibilidad del esquema observado con el esquema de registros de Codex conocido.

Si `sqlite_home` está fuera de `CODEX_HOME`, la base de datos de diagnóstico se muestra por separado. Sus bytes no se suman implícitamente al almacenamiento de `CODEX_HOME`.

OpenCodex no consulta ni expone `feedback_log_body` al generar estos diagnósticos. Los niveles se reducen al conjunto fijo conocido más `OTHER`, y los nombres de los destinos no se serializan.

<a id="protect-modes"></a>

## Proteger los modos

La protección está **desactivada de forma predeterminada**. Al activarla, se instala un único trigger `BEFORE INSERT`, propiedad de OpenCodex, en `logs_2.sqlite`. OpenCodex nunca reemplaza un trigger desconocido que use sus nombres reservados y solo elimina triggers cuyo SQL coincide con su propia versión.

Hay dos modos disponibles:

- **Compatibilidad** (`compat`) es el modo recomendado. Aplica las reglas de Log Guard v1 a los destinos de gran volumen que Codex ya filtra o guarda con un nivel inferior en su registro SQLite persistente. Conserva las filas `TRACE` de otros destinos.
- **Silencioso** (`quiet`) suprime todas las filas nuevas de nivel `TRACE` y conserva las de nivel `DEBUG`, `INFO`, `WARN` y `ERROR`.

La protección reduce las filas que llegan al almacenamiento SQLite persistente. **No** elimina el trabajo previo de diagnóstico de Codex: los eventos aún pueden formatearse, encolarse, agruparse en transacciones y pasar por su lógica de limpieza antes de que el trigger descarte una fila. Protect reduce las escrituras persistentes; no desactiva la generación interna de diagnósticos.

Log Guard solo filtra las filas de registro que se guardan en la base de datos SQLite local. No cambia el procesamiento de diagnóstico Codex, [transporte del adaptador](/es/reference/adapters/), las cargas útiles del proveedor, la semántica de transmisión, la autenticación, el enrutamiento, las cuotas o el estado de la cuenta.

<a id="safety-checks"></a>

### Controles de seguridad

Antes de que Proteger, Deshabilitar o Reparar modifiquen la base de datos de Codex, OpenCodex:

1. Resuelve exactamente la ruta canónica de `logs_2.sqlite`.
2. Comprueba que sea un archivo regular, no un enlace simbólico, y que el esquema coincida exactamente con el conocido.
3. Comprueba que se hayan podido enumerar los procesos y que no haya ningún proceso de Codex compatible escribiendo en la base.
4. Adquiere un bloqueo de Log Guard dedicado y compartido entre procesos.
5. Repite la comprobación de procesos de Codex después de adquirir el bloqueo.
6. Abre la base de datos para lectura y escritura **sin crearla** y adquiere `BEGIN IMMEDIATE` de SQLite sin esperar si está ocupada.
7. Modifica únicamente los triggers de Log Guard propiedad de OpenCodex y vuelve a leer el resultado antes de confirmar la transacción.
8. Guarda el modo solicitado en la configuración de OpenCodex mientras sigue manteniendo el bloqueo de Log Guard.

Si no se puede confirmar la enumeración de procesos, la base está ocupada, el esquema es desconocido o un nombre reservado pertenece a otro SQL, se rechaza la modificación. OpenCodex no cierra Codex automáticamente.

<a id="drift-and-repair"></a>

## Deriva y reparación

El modo de protección solicitado se guarda en la configuración de OpenCodex, separado de la base de datos de registros de Codex. Una migración de Codex puede reconstruir la tabla `logs`; SQLite elimina los triggers asociados a una tabla que se reemplaza.

Si el modo guardado es `compat` o `quiet` pero ya no se observa el trigger correspondiente de OpenCodex, Log Guard informa el estado **drifted**. `ocx doctor` detecta esa divergencia, pero nunca la repara automáticamente.

La reparación es explícita:

```bash
ocx storage codex-logs repair
```

OpenCodex no vuelve a crear la protección en cada inicio. Solo se reconsideraría la reparación automática en una versión posterior si hay evidencia suficiente de que es segura entre migraciones de Codex.

## CLI

Leer estado:

```bash
ocx storage codex-logs status
ocx storage codex-logs status --json
ocx doctor
```

Habilitar la directiva de compatibilidad recomendada:

```bash
ocx storage codex-logs protect
```

Elija el modo silencioso explícitamente:

```bash
ocx storage codex-logs protect --mode quiet
```

Desactivar OpenCodex protección o reparación deriva:

```bash
ocx storage codex-logs unprotect
ocx storage codex-logs repair
```

Agregue `--json` a los comandos Log Guard para obtener una salida legible por máquina. Vea el [CLI referencia](/es/reference/cli/) para la sintaxis canónica de comandos y el comportamiento JSON.

El comando existente permanece sin cambios:

```bash
ocx storage --json
```

Su respuesta lleva el mismo estado de registro Codex utilizado por la página de almacenamiento.

<a id="management-api"></a>

## API de administración

El estado está disponible en:

```text
GET /api/storage/codex-logs
```

Mutaciones explícitas:

```text
POST /api/storage/codex-logs/protect
POST /api/storage/codex-logs/unprotect
POST /api/storage/codex-logs/repair
```

El cuerpo de Protect es `{"mode":"compat"}` o `{"mode":"quiet"}`. `GET /api/storage` también incluye el informe como `codexLogs`, para actualizar el desglose de almacenamiento y los diagnósticos de Codex con una sola solicitud de instantánea.

<a id="read-only-snapshot-semantics"></a>

## Semántica de instantáneas de solo lectura

La inspección abre la base de datos en modo de solo lectura con `immutable=1` de SQLite. Así no crea ni actualiza los archivos auxiliares `-wal` o `-shm`.

Esta decisión tiene una limitación: los agregados SQL y los metadatos de triggers describen la última instantánea consolidada mediante un checkpoint. Si Codex está escribiendo, el WAL puede contener filas o páginas de esquema más recientes. Una modificación exitosa devuelve el estado del trigger verificado dentro de su transacción de escritura. Una consulta posterior de solo lectura puede mostrar temporalmente un estado anterior hasta que SQLite consolide esas páginas.

OpenCodex informa el tamaño del archivo WAL por separado y **no** etiqueta el resultado como tasa de escritura SSD, escritura NAND o consumo de desgaste de unidad / TBW.

<a id="compatibility-states"></a>

## Estados de compatibilidad

Con un esquema conocido, se admiten la inspección y la protección. Si el esquema falta, no se puede leer o pertenece a una versión futura desconocida, se pueden inspeccionar los metadatos disponibles, pero no modificar la base.

OpenCodex no presupone que un esquema desconocido sea compatible. Así puede mostrar información de una versión nueva de Codex sin tratar una estructura no revisada como segura para modificar.

<a id="reclaim-is-still-separate"></a>

## La recuperación sigue siendo independiente

Protect no ejecuta vacuum ni compacta SQLite. [**Recuperar espacio**](/es/guides/codex-log-guard-reclaim/) ofrece un proceso independiente de vacuum incremental, explícito, sin Codex en ejecución y con límites, checkpoints y comprobaciones de integridad.

Protect nunca ejecuta `VACUUM`, nunca trunca o elimina WAL de Codex directamente, y nunca realiza una recuperación de espacio programada.
