---
title: "Capas de instrucciones de Codex"
description: "Consulta qué instrucciones envía Codex, desactiva las partes innecesarias y añade tus propias capas."
---

Codex compone sus instrucciones por capas: sus instrucciones base, la documentación del proyecto, el contexto de permisos y del entorno, las habilidades instaladas y otros elementos. **Codex Set → Prompt** muestra esas capas, su costo y los controles para desactivar las que no quieras.

<a id="what-the-list-shows"></a>

## Qué muestra la lista

Cada fila indica su posición en el orden de composición, la clave de configuración que la controla —cuando existe— y el tamaño del texto que realmente se envió.

Las posiciones no son consecutivas. Los números corresponden a los índices reales de composición, y dos de ellos aparecen más abajo, en **Notificaciones de transición**. Renumerar cada grupo desde uno mostraría un orden que Codex no utiliza.

<a id="five-kinds-of-layer"></a>

### Cinco tipos de capa

| Tipo | Qué puedes hacer |
|---|---|
| Conmutable aquí | Un interruptor que escribe una clave en `config.toml`. |
| Configurada en `[features]` | Se puede cambiar desde los ajustes de funciones, no desde esta página. |
| Siempre activa | Codex no ofrece ningún control para desactivarla. |
| Se envía al cambiar | Anuncia una transición y solo aparece cuando algo cambia. |
| Capas de extensión | No se pueden enumerar porque Codex no las expone. |

Si una capa no se puede desactivar, la fila no muestra un interruptor. Mostrarlo deshabilitado sugeriría que la capacidad existe y está temporalmente indisponible.

<a id="reading-a-layer"></a>

## Leer una capa

Haz clic en su nombre para ver el texto que envía. El diálogo lo obtiene de `codex debug prompt-input`: muestra el contenido real, no una descripción.

La lectura dispone de un único presupuesto fijo de 15 segundos para quien la solicita, incluido el tiempo dedicado a leer metadatos y a esperar una consulta de diagnóstico compartida. Las lecturas síncronas de metadatos terminan antes de que se pueda comprobar si ha vencido el plazo; si el presupuesto se ha agotado, se impide iniciar una nueva consulta. Si vence el plazo, el diálogo informa de que no se pudo leer el prompt; las instrucciones base disponibles localmente se devuelven de todos modos.

A veces no hay contenido que mostrar. El diálogo explica cuál de estos casos se aplica:

- **El archivo existe, pero está vacío.** `~/.codex/AGENTS.md` tiene cero bytes y la capa no tiene contenido que enviar. El diálogo muestra la ruta.
- **No se envió en el turno consultado.** Las capas solo se vuelven a enviar cuando cambian; una muestra de un único turno puede no contener una capa sin cambios.
- **El prompt base proviene del catálogo de modelos.** Codex lo envía fuera de la lista que se puede consultar. El diálogo lo lee de la fila del modelo seleccionado o del archivo indicado por `model_instructions_file`, si está configurado. Si la fila solo publica una plantilla sin expandir, informa que no puede mostrarla: esa plantilla no es el texto que Codex envía.
- **No se pudo leer el prompt.** La consulta falló en este equipo.

La lectura usa el directorio global de Codex (`~/.codex`), no el directorio desde el que se ejecuta el dashboard.

<a id="custom-layers"></a>

## Capas personalizadas

**+ Añadir capa** agrega tus instrucciones. Las capas personalizadas forman `developer_instructions`, que se añade a las instrucciones de Codex sin reemplazarlas.

:::note
Este control no usa `model_instructions_file`. Esa clave reemplaza el prompt base; vincularla con **+** eliminaría las instrucciones de Codex al guardar la primera capa. Para reemplazar el prompt base, usa [Variantes de prompt base](#base-prompt-variants): es una elección explícita y separada de la incorporación de una capa.
:::

Las capas personalizadas tienen su propia numeración porque se unen en una sola sección, en ese orden. No se intercalan con las capas integradas.

Cambia el orden con las flechas de la fila o con `Alt` + `Up` / `Alt` + `Down` desde cualquier punto de ella. Ese es el orden en el que se compone el texto.

El panel compara el tamaño combinado de las capas habilitadas con el límite de 128 KiB de `developer_instructions` y ofrece una vista previa plegable del texto unido. Así puedes detectar que una capa superaría el límite antes de guardar.

Eliminar una capa requiere confirmación y ofrece **Deshacer** durante unos segundos. Al deshacer, la capa recupera su posición anterior.

<a id="presets"></a>

### Ajustes preestablecidos

**+ Añadir capa** ofrece cinco puntos de partida: salida concisa, plan antes de editar, explicar el razonamiento, probar primero y respuestas en coreano. Cada opción abre el editor con texto editable; al guardar, se crea una capa personalizada normal.

Los textos son propios y resumen un enfoque sin copiar las instrucciones de otra persona. Cada uno identifica su fuente.

<a id="moving-between-layers-while-editing"></a>

### Cambiar de capa durante la edición

El editor tiene controles de anterior y siguiente y un indicador de posición. Conserva las ediciones sin guardar al cambiar de capa, por lo que puedes compararlas y volver sin perder texto. Si cierras el editor con cambios en otra capa, pide confirmación antes de descartarlos. Al guardar una capa, también pide confirmación antes de descartar los cambios pendientes de otras; el botón **Guardar** de esa confirmación solo guarda la capa visible.

<a id="compatibility-warnings"></a>

### Advertencias de compatibilidad

El editor advierte sobre instrucciones que no funcionarían tal como están escritas: afirmar otra identidad, nombrar herramientas definidas en el registro, usar marcadores de plantilla que nada expande o declarar datos del entorno que Codex genera después. También detecta credenciales pegadas —una clave API en una capa se envía al modelo en texto plano en cada solicitud—, instrucciones para abandonar las anteriores y una identidad distinta de Codex declarada en coreano.

Las advertencias no bloquean el guardado. Puedes sustituir instrucciones de Codex de forma deliberada; la advertencia hace visible esa decisión.

<a id="commit-attribution"></a>

## Atribución de commits

La fila **Atribución de commits** pide al modelo añadir `Co-authored-by: Codex` a los commits que escriba y una línea `Generated with Codex.` a los pull requests que abra.

No hay un interruptor aquí ni en `[features]`: Codex obtiene esta elección de la política de atribución de tu cuenta. Desactivarla en la cuenta no elimina la capa; Codex envía la instrucción contraria, que pide omitir la atribución. En ambos casos se envía texto, por lo que la fila figura como controlada por la cuenta, no como siempre activa.

<a id="base-prompt-variants"></a>

## Variantes de prompt base

El prompt base es la única capa que no puedes desactivar: un modelo sin instrucciones base no funciona como agente. Puedes **sustituirlo** con el control de la fila **Instrucciones base**.

Abre la fila para ver el selector. Cambia de opción deslizando horizontalmente, con las teclas de flecha izquierda y derecha o con los botones de flecha. Los lectores de pantalla anuncian esos botones, por lo que no necesitas un panel táctil.

| Opción | Qué es | Editable |
|---|---|---|
| Prompt base de Codex | `model_instructions_file` no está en la configuración | nunca |
| Tu variante | Instrucciones que escribes y se guardan en `~/.codex/opencodex-prompt-base/` | sí |
| Una segunda variante | Lo mismo, con un máximo de dos variantes | sí |

La primera opción no tiene texto que editar ni botón **Guardar**; el diálogo explica el motivo. El valor predeterminado es la ausencia de la clave, no una copia guardada del prompt de Codex. Elegirlo elimina `model_instructions_file` de la configuración.

:::caution
Una variante **reemplaza** las instrucciones base de Codex; no se añade a ellas. Si escribes una variante de tres líneas, el modelo solo recibe esas tres líneas: pierde las instrucciones habituales de Codex sobre el uso de herramientas y la verificación del trabajo. Para *añadir* instrucciones conservando la base, usa una [capa personalizada](#custom-layers).
:::

El editor conserva las ediciones al cambiar de variante y pide confirmación antes de descartarlas al cerrar. Mientras escribes, comprueba el límite de 64 KiB del cuerpo de cada variante.

<a id="if-something-else-already-replaced-your-base-prompt"></a>

### Si otra herramienta ya reemplazó el prompt base

Si `model_instructions_file` apunta a un archivo que opencodex no escribió, el selector rechaza los cambios e indica la ruta. No modifica silenciosamente una elección que hiciste tú u otra herramienta.

**Importarlo como variante** permite convertir ese archivo sin borrar la clave a mano. La vista previa muestra el texto exacto que se instalará: una línea de encabezado `# ` con el título de la variante y el cuerpo del archivo, con saltos de línea y tabulaciones normalizados. Puedes editar el título antes de confirmar. El cuerpo normalizado admite como máximo 64 KiB (`bodyBytes`); el archivo completo, con encabezado, es algo mayor (`serializedBytes`). Un hash vincula la confirmación con la vista previa: si cambia el archivo o el título, se rechaza la importación. Si prefieres volver al valor predeterminado, elimina la clave manualmente.

Se aplica el mismo principio que al importar `developer_instructions`: el panel muestra lo que encuentra y tú decides.

El cambio se aplica a las sesiones nuevas, como los demás ajustes de esta página.

<a id="instructions-written-outside-opencodex"></a>

## Instrucciones escritas fuera de opencodex

Si `developer_instructions` ya existe y opencodex no lo escribió, el panel no lo sobrescribe. Ofrece importarlo como capa: primero muestra el valor existente y solo escribe después de tu confirmación.

<a id="when-something-is-out-of-sync"></a>

## Cuando los valores no coinciden

Si las capas guardadas no coinciden con `config.toml`, el panel lo indica y ofrece **Reparar**. Dos rutas de reparación reescriben texto del usuario y requieren una decisión explícita. Si una escritura quedó interrumpida y existe un diario de recuperación, se ejecuta únicamente la recuperación bajo bloqueo, usando las copias registradas en ese diario; no se guarda de nuevo la lista actual ni se inventa contenido ausente. Si los archivos actuales no coinciden con ningún estado registrado, se rechaza la recuperación y se conserva la evidencia. El panel actualizado informa de cualquier diferencia restante. Si falta un archivo de capa, la reparación hace una copia de seguridad antes de modificar nada.

<a id="when-changes-take-effect"></a>

## Cuándo se aplican los cambios

Los cambios se aplican a las sesiones nuevas. Una sesión en ejecución conserva los ajustes de instrucciones con los que comenzó.

<a id="keeping-the-skills-catalog-stable"></a>

## Mantener estable el catálogo de habilidades

El valor predeterminado del proxy es `skills.catalog_refresh: "per_session"`: reutiliza el primer catálogo `<skills_instructions>` recibido en las solicitudes posteriores de la misma conversación. Esto evita que el descubrimiento de habilidades o la edición de `SKILL.md` cambien el prefijo de caché del proveedor durante una sesión. Una solicitud con más de un bloque `<skills_instructions>` se reenvía sin cambios. Una solicitud rechazada por el proxy no establece el catálogo.

Para usar el catálogo enviado por el cliente en cada turno, configura lo siguiente en `$OPENCODEX_HOME/config.json` —normalmente `~/.opencodex/config.json`— y reinicia el proxy:

```json
{
  "skills": {
    "catalog_refresh": "per_turn"
  }
}
```

Los valores admitidos son `"per_session"` —predeterminado— y `"per_turn"`. Es un ajuste del proxy, independiente de `skills.include_instructions` de Codex. Las solicitudes sin una identidad de conversación fiable usan el catálogo que envía el cliente. Las instantáneas se mantienen en memoria y se pierden al reiniciar el proxy. Caducan tras cuatro horas de inactividad y pueden descartarse si se llena la caché limitada. Un catálogo inicial de más de 512 KiB se reenvía sin guardarlo en caché. Tras la caducidad o el descarte, el siguiente catálogo recibido se convierte en la nueva instantánea. La vista previa del dashboard sigue leyendo los archivos actuales; no muestra la instantánea retenida para una conversación.

<a id="what-this-page-reads-and-what-it-does-not"></a>

## Qué lee esta página

opencodex lee tu archivo `config.toml`. Codex calcula sus ajustes a partir de varias capas; lo mostrado aquí es el valor de tu archivo, que puede diferir del resultado final que resuelve Codex.

<a id="the-keys-this-page-writes"></a>

## Claves que escribe esta página

Estas claves pertenecen al `config.toml` de Codex, no a la configuración propia de opencodex.

| Clave | Predeterminado | Capa |
|---|---|---|
| `include_permissions_instructions` | `true` | Permisos |
| `include_collaboration_mode_instructions` | `true` | Modo de colaboración |
| `include_environment_context` | `true` | Contexto del entorno |
| `include_apps_instructions` | `true` | Apps |
| `skills.include_instructions` | `true` | Habilidades |
| `developer_instructions` | Sin configurar | Capas personalizadas, unidas en orden |
| `model_instructions_file` | Sin configurar | Prompt base cuando se selecciona una variante |

Las escrituras modifican líneas y conservan los comentarios y el formato. Las claves que opencodex no reconoce se dejan intactas.

Una clave ausente se interpreta con su valor predeterminado, no como `false`. El panel muestra el valor que contiene el archivo e indica si la clave no está configurada.

Si una fila tiene un valor explícito, ofrece **Restablecer a &lt;default&gt;**. Este control elimina la línea de la clave en vez de escribir el valor predeterminado. Solo la ausencia de la clave permite seguir un cambio futuro del valor predeterminado de Codex; escribir `key = true` fijaría el valor actual como una anulación.

El editor de valores escalares rechaza arrays, tablas en línea y cadenas multilínea antes de escribir o restablecer una clave, conservando los bytes originales. La importación informa explícitamente si no puede leer la configuración. Una vista previa de título de solo lectura mantiene el título editable; confirmar sigue requiriendo una vista previa vinculada a ese título. Los errores HTTP o de medición de red se muestran como fallos, no como si otra consulta estuviera ocupada.
