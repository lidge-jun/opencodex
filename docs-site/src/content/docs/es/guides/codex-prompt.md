---
title: "Capas de instrucciones de Codex"
description: "Lea lo que Codex realmente envía, apague las piezas que no necesita y agregue sus propias instrucciones como capas."
---

Codex ensambla su solicitud a partir de capas: sus propias instrucciones básicas, los documentos de su proyecto, el contexto de permisos y entorno, las habilidades que ha instalado y más. **Codex Set → Prompt** muestra esa pila, le dice lo que cuesta cada capa y le permite desactivar las piezas que no desea.

<a id="what-the-list-shows"></a>

## Lo que muestra la lista

Cada fila lleva su posición en el orden de montaje, la clave de configuración que la gobierna cuando hay una y el tamaño de lo que realmente envió.

Las posiciones tienen lagunas. Eso es deliberado: los números son los índices reales de la asamblea, y dos de ellos se enumeran más abajo en **Notificaciones de transición**. Renumerar cada grupo de uno mostraría que no se usa una orden Codex.

<a id="five-kinds-of-layer"></a>

### Cinco tipos de capa

| Tipo | Lo que puedes hacer |
|---|---|
| Conmutable aquí | Un verdadero interruptor. Escribe una clave en `config.toml`. |
| Configurado bajo `[features]` | Real, pero cambiado de la configuración de características en lugar de esta página. |
| Siempre encendido | No hay interruptor de apagado en cualquier lugar en Codex. |
| Se activa cuando cambia | Anuncia una transición, por lo que solo aparece cuando algo cambia. |
| Capas de extensión | No se puede enumerar. Codex no los expone. |

Una capa sin interruptor de apagado no muestra ningún interruptor en lugar de uno deshabilitado. Un control en gris sugeriría que la capacidad existe y no está disponible temporalmente, lo cual no es el caso.

<a id="reading-a-layer"></a>

## Leer una capa

Haga clic en un nombre de capa para ver el texto que envía. El cuadro de diálogo lo lee desde `codex debug prompt-input`, por lo que es lo real en lugar de una descripción.

A veces no hay nada que mostrar, y el diálogo dice qué razón se aplica:

- **El archivo está vacío.** Su `~/.codex/AGENTS.md` es cero bytes, por lo que la capa no tiene nada que enviar. El diálogo nombra la ruta.
- **No envió nada en el turno que leímos.** Las capas solo se vuelven a enviar cuando cambian, por lo que una capa sin cambios está ausente de una sola muestra.
- **El indicador base proviene de su catálogo de modelos.** Codex lo envía fuera de la lista legible, por lo que el cuadro de diálogo lo lee desde la fila de catálogo del modelo seleccionado, o desde el archivo nombrado por `model_instructions_file` cuando ha establecido uno. Una fila que publica solo una plantilla no expandida se informa como no se muestra, porque ese texto no es lo que envía Codex.
- **El mensaje no se pudo leer.** La sonda falló en esta máquina.

La lectura se toma de su casa global Codex (`~/.codex`), no del directorio en el que se está ejecutando el panel de control.

<a id="custom-layers"></a>

## Capas personalizadas

**+ Añadir capa** añade sus propias instrucciones. Las capas personalizadas componen `developer_instructions`, que es aditivo: Codex mantiene sus propias instrucciones y las tuyas se agregan a ellas.

:::note
Esto es deliberadamente no `model_instructions_file`. Esa clave REPLACES la base más rápido que añadir a ella, por lo que el cableado **+** eliminaría el propio Codex instrucciones la primera vez que guardó una capa. Si la sustitución del indicador base es lo que quieres, eso es lo que [Variantes de prompt base](#base-prompt-variants) es por — una decisión separada, con nombre en lugar de un efecto secundario de agregar una capa.
:::

Las capas personalizadas se numeran entre sí porque se unen en una sección en ese orden: no se entrelazan con las capas incorporadas.

Reordene con las flechas en la fila, o con `Alt` + `Up` / `Alt` + `Down` desde cualquier lugar de la fila. El orden es el orden de composición.

El panel muestra el tamaño combinado de las capas habilitadas frente al límite de 128 KiB para `developer_instructions`, y una vista previa plegable del texto unido: una capa que empujaría la sección sobre el límite es visible antes de guardar, no después.

Eliminar una capa pide primero, luego ofrece **Deshacer** por unos segundos. La capa vuelve a su posición anterior, por lo que una lista sensible al orden sobrevive al desliz.

<a id="presets"></a>

### Preconfiguración

**+ Añadir capa** ofrece cinco puntos de partida: salida concisa, plan antes de editar, explicar el razonamiento, probar primero y respuestas coreanas. Cada uno abre el editor ordinario precargado y totalmente editable: un preajuste es un punto de partida y lo que guarda es una capa personalizada ordinaria.

Los preajustes son nuestro propio texto, escrito para destilar un enfoque en lugar de copiar el mensaje de alguien. Cada uno nombra su fuente.

<a id="moving-between-layers-while-editing"></a>

### Moverse entre capas mientras se edita

El editor tiene controles previos/siguientes y un indicador de posición. Las ediciones no guardadas se mantienen mientras se mueve, por lo que puede comparar dos capas a mitad de edición y volver sin perder lo que escribió. El cierre con ediciones en otra capa pregunta antes de descartarlas. Guardar una capa también pregunta antes de descartar ediciones aparcadas en otras capas; el botón **Guardar** de la confirmación guarda solo la capa mostrada.

<a id="compatibility-warnings"></a>

### Advertencias de compatibilidad

El editor advierte cuando una capa dice algo que no funcionará como está escrito: reclama una identidad diferente, nombra una herramienta que el registro define, usa marcadores de posición de plantilla, nada se expande o indica hechos del entorno que Codex genera más tarde. También señala las credenciales pegadas (una clave API en una capa se envía al modelo en texto plano en cada solicitud), fraseo que le dice al modelo que deje sus instrucciones anteriores, y una identidad no Codex reclamada en coreano.

Estas son advertencias y nunca bloquean un salvamento. Si quieres anular Codex, puedes; la advertencia solo lo convierte en una decisión en lugar de un accidente.

<a id="commit-attribution"></a>

## Comprometer la atribución

La fila **Comprometer la atribución** le dice al modelo que agregue un remolque `Co-authored-by: Codex` para confirmar que escribe, y una línea `Generated with Codex.` para extraer las solicitudes que abre.

No hay ningún cambio para ello aquí, y ninguno bajo `[features]` tampoco: Codex lo resuelve de la política de atribución de su cuenta. Apagarlo en el nivel de cuenta no elimina la capa: Codex envía la instrucción **opuesto** en su lugar, diciéndole al modelo que no agregue el remolque. De cualquier manera, se envía algo, por lo que la fila se enumera como establecida por su cuenta en lugar de como siempre.

<a id="base-prompt-variants"></a>

## Variantes de prompt base

El indicador base es la única capa que no se puede desactivar, porque un modelo sin indicador base no es un agente de trabajo. Sin embargo, puede **sustituto** y el interruptor en la fila **Instrucciones de base** es lo que hace eso.

Abra la fila para ver el selector. Muévase entre las opciones deslizando hacia los lados, con las teclas de flecha izquierda y derecha, o con los botones de flecha: los botones también son lo que anuncia un lector de pantalla, por lo que la página permanece operable sin un panel táctil.

| Opción | Qué es | Editable |
|---|---|---|
| Codex 's propio indicador de base | `model_instructions_file` está ausente de su configuración | nunca |
| Su variante | un aviso que escriba, almacenado en `~/.codex/opencodex-prompt-base/` | sí |
| Una segunda variante | Lo mismo, hasta dos | sí |

La primera opción no tiene nada que editar y no tiene botón **Guardar**, y el diálogo dice por qué en lugar de mostrar controles en gris. El valor predeterminado no es una copia del mensaje de Codex que almacenamos, es el **ausencia** de la clave. Así que no hay texto que cambiar y ninguno que eliminar, y elegirlo simplemente elimina `model_instructions_file` de su configuración de nuevo.

:::caution
Una variante **sustituye** Instrucciones base de Codex en lugar de añadir a ellos. A La variante de tres líneas le da un modelo con tres líneas de instrucciones: ninguna herramienta disciplina, sin hábitos de verificación, nada de lo que Codex normalmente trae. Si quieres a *añadir* Guía, utiliza un [capa personalizada](#custom-layers) en su lugar, — son aditivos.
:::

El editor de variantes tiene las mismas barandas que el editor de capas personalizadas: las ediciones no guardadas se mantienen mientras se mueve entre las opciones, se cierra con preguntas de ediciones antes de descartarlas, y el cuerpo se cuenta contra el límite de 64 KiB por variante mientras escribe.

<a id="if-something-else-already-replaced-your-base-prompt"></a>

### Si algo más ya ha reemplazado a su prompt base

Si `model_instructions_file` puntos en un archivo opencodex no se escribieron, el selector se niega a actuar y dice dónde los puntos clave. No reorientará silenciosamente una clave tú u otro conjunto de herramientas.

Sin embargo, no tienes que aclararlo a mano. **Importarlo como variante** convierte el archivo: la vista previa muestra el texto *exacto* que se instalará: una línea de encabezado `# ` que contiene el título variante, luego el cuerpo del archivo con terminaciones de línea y pestañas normalizadas, y puede editar el título antes de confirmar. El cuerpo puede usar como máximo 64 KiB después de la normalización (`bodyBytes` en la vista previa); el archivo completo en disco, encabezado incluido, es un poco más grande (`serializedBytes`). La confirmación está vinculada al texto previsualizado por un hash, por lo que si el archivo, o el título elegido, cambió entremedio, la importación se niega en lugar de instalar el texto que nunca vio. Despeje la clave usted mismo si prefiere comenzar desde el valor predeterminado.

Este es el mismo principio que la importación `developer_instructions`: el panel informa lo que encuentra y usted decide.

El cambio se aplica a las sesiones recién iniciadas, como cualquier otro cambio en esta página.

<a id="instructions-written-outside-opencodex"></a>

## Instrucciones escritas fuera de opencodex

Si ya existe `developer_instructions` y opencodex no lo escribió, el panel no lo sobrescribirá. En su lugar, ofrece importar el texto como una capa: primero se ve el valor existente y no se escribe nada hasta que se confirma.

<a id="when-something-is-out-of-sync"></a>

## Cuando algo está fuera de sincronización

Si las capas guardadas y el valor en `config.toml` no están de acuerdo, el panel lo dice y ofrece **Reparar** en lugar de fijarlo en silencio. Dos de las rutas de reparación reescriben el texto que escribiste, por lo que permanecen deliberadas. Una escritura interrumpida ("presentación de diario") ejecuta una operación bloqueada de recuperación solamente usando las imágenes de archivo grabadas del diario; no vuelve a guardar la lista de capas actual ni inventa el contenido que falta. Si los archivos en vivo no coinciden con ninguno de los estados registrados, la recuperación se niega y conserva la evidencia. El panel actualizado informa de cualquier deriva restante. Cuando falta un archivo de capa, la reparación escribe una copia de seguridad antes de que toque algo.

<a id="when-changes-take-effect"></a>

## Cuando los cambios surtan efecto

Los cambios se aplican a las sesiones recién iniciadas. Una sesión que ya se está ejecutando mantiene la configuración del mensaje con la que comenzó.

<a id="keeping-the-skills-catalog-stable"></a>

## Mantener el catálogo de habilidades estable

El proxy por defecto es `skills.catalog_refresh: "per_session"`: el primer catálogo `<skills_instructions>` recibido para una conversación se reutiliza en solicitudes posteriores en esa conversación. Esto evita que el descubrimiento de habilidades y las ediciones `SKILL.md` cambien esa parte del prefijo de caché de prompt ascendente a mitad de la sesión. Una solicitud que transporta más de un bloque `<skills_instructions>` se pasa sin cambios, y una solicitud que el proxy rechaza no establece el catálogo.

Para utilizar el catálogo suministrado por el cliente en cada turno, establezca esto en opencodex's
`$OPENCODEX_HOME/config.json` (normalmente `~/.opencodex/config.json`), luego reinicia El proxy:

```json
{
  "skills": {
    "catalog_refresh": "per_turn"
  }
}
```

Los valores admitidos son `"per_session"` (predeterminado) y `"per_turn"`. Esta es una configuración de proxy, separada de Codex `skills.include_instructions` alternar. Las solicitudes sin una identidad de conversación confiable utilizan el catálogo suministrado por el cliente. Las instantáneas se guardan en la memoria y no sobreviven a un reinicio proxy. Caducan después de cuatro horas de inactividad y pueden ser desalojados cuando se llena el caché limitado. Un bloque de catálogo inicial de más de 512 KiB se reenvía sin almacenamiento en caché. Después de la expiración o el desalojo, el siguiente catálogo recibido se convierte en la nueva instantánea. La vista previa del panel de control sigue leyendo los archivos actuales; no muestra la instantánea retenida para una conversación en curso.

<a id="what-this-page-reads-and-what-it-does-not"></a>

## Lo que esta página lee y lo que no

opencodex lee un archivo de configuración - su `config.toml`. Codex resuelve su configuración desde varias capas, por lo que un valor aquí es lo que dice SU archivo, no necesariamente lo que finalmente calcula Codex.

<a id="the-keys-this-page-writes"></a>

## Las claves que escribe esta página

Estos viven en su Codex `config.toml`, no en la configuración propia de opencodex.

| Clave | Predeterminado | Capa |
|---|---|---|
| `include_permissions_instructions` | `true` | Permisos |
| `include_collaboration_mode_instructions` | `true` | Modo de colaboración |
| `include_environment_context` | `true` | Contexto ambiental |
| `include_apps_instructions` | `true` | Apps |
| `skills.include_instructions` | `true` | Habilidades |
| `developer_instructions` | Sin configurar | Sus capas personalizadas, unidas en orden |
| `model_instructions_file` | Sin configurar | Prompt base, cuando se selecciona una variante |

Las escrituras son ediciones de línea: sus comentarios y formato sobreviven, y una clave opencodex no reconoce se deja sola en lugar de eliminarse.

Una clave ausente se lee como su valor predeterminado en lugar de como `false`. El panel muestra el valor que realmente tiene su archivo y dice cuando no se ha establecido una clave.

Una fila que lleva un valor explícito también ofrece **Restablecimiento a <default>**, que elimina la línea clave en lugar de escribir el valor predeterminado. Ese es el único estado que sigue al valor predeterminado si Codex lo cambia más tarde: escribir `key = true` congelaría el valor predeterminado de hoy como una anulación.

Este editor escalar rechaza arrays, tablas en línea y cadenas multilínea antes de escribir o restablecer una clave, preservando los bytes originales. Una importación informa explícitamente de una configuración ilegible. Las vistas previas de título de solo lectura mantienen el campo de título editable; la confirmación aún requiere una vista previa vinculada a ese título. HTTP o fallas de medición de red se muestran como fallas en lugar de como otra sonda que está ocupada.
