---
title: "Orden de modelos"
description: "Cómo determina opencodex el orden del modelo en el selector Codex y el modelo spawn_agent anula."
---

El selector de modelos Codex no conserva el orden de las declaraciones del proveedor o las matrices de modelos en la configuración opencodex. Su orden final proviene de las prioridades del catálogo, con un orden alfabético determinista para los modelos enrutados que comparten la misma prioridad.

<a id="the-rule-codex-applies"></a>

## La regla Codex se aplica

Codex 's models-manager ordena las entradas de catálogo visible por `priority` en orden ascendente. Descarta el orden de la matriz de catálogo, por lo que mover una entrada anterior en una matriz JSON generada no la mueve anterior en el selector. La implementación registra esta restricción directamente en `src/codex/catalog/sync.ts`.

Por lo tanto, opencodex controla la ubicación de las funciones asignando prioridades más bajas, no confiando en la posición de la matriz. A menos que se indique lo contrario, las prioridades fijas y el ejemplo trabajado a continuación describen un catálogo sin selectores de cuenta Codex elegibles. Con `N` selectores elegibles, las prioridades presentadas usan `N` como un paso: una elección nativa desnuda en el rango configurado `i` se expande a filas de selectores en las prioridades `i * N + j`, donde `j` es la posición basada en cero del selector; una elección encaminada usa `i * N`; y una elección calificada por selector exacta usa `i * N + j` para su selector. Las filas enrutadas no seleccionadas se mueven fuera de esos grupos selectores. Codex todavía anuncia sólo las primeras cinco filas visibles.

Sin el pedido completo del seleccionador, las prioridades relevantes de no selector son:

| Entrada de catálogo | Prioridad | Fuente |
| --- | ---: | --- |
| `subagentModels[i]` | `i` (`0` a través de `4`) | El mapa de rango destacado en `src/codex/catalog/sync.ts` |
| Otros modelos ruteados | `5` | Creación de la entrada encaminada en `src/codex/catalog/sync.ts` |
| Modelos ruteados no destacados listados en `modelPickerOrder` | `1000 + i` | Rango de selector de solo visualización en `src/codex/catalog/sync.ts` |
| Por defecto, las identificadores GPT nativas | `9` | Creación de entradas nativas en `src/codex/catalog/sync.ts` |
| Modelos nativos no seleccionados mientras existe una lista destacada | Al menos `featured.length + 100` | Catálogo nativo fusionar en `src/codex/catalog/sync.ts` |

La gestión API limita `subagentModels` a cinco entradas con `slice(0, 5)` en `src/server/management/agent-settings-routes.ts`. Esto coincide con la superficie Codex `spawn_agent`, que anuncia solo los primeros cinco modelos anulados. Los modelos fuera de esos cinco todavía pueden permanecer visibles en el selector principal y llamarse por su id exacto.

<a id="how-ties-are-ordered"></a>

## Cómo se ordenan los lazos

Todos los modelos ruteados ordinarios tienen prioridad `5`, por lo que necesitan un desempate. Antes de que se construyan las entradas del catálogo, `gatherRoutedModels()` ordena la lista de modelos enrutados por nombre del proveedor y luego por la identificación del modelo, ambos alfabéticamente (`src/codex/catalog/provider-fetch.ts`).

Esto significa que ninguno de estos detalles de configuración cambia el orden final:

- el orden de las claves de declaración en el objeto `providers`;
- el orden de los id en la matriz `models` de un proveedor.

`orderForSubagents()` luego usa una ordenación estable para mover las selecciones destacadas configuradas al frente en el mismo orden que `subagentModels`. Los modelos no destacados mantienen el orden relativo alfabético proveedor/identificador establecido anteriormente (`src/codex/catalog/sync.ts`). El rango destacado también se convierte en prioridades `0` a `4` cuando se construyen las entradas, por lo que el orden de prioridad de Codex conserva esa secuencia principal.

<a id="visibility-is-separate-from-ordering"></a>

## La visibilidad está separada del orden

`selectedModels` y `disabledModels` deciden qué modelos enrutados están expuestos; no están ordenando controles. `filterCatalogVisibleModels()` convierte ambas selecciones en `Set` búsquedas y filtra la lista recopilada sin usar las matrices como rangos (`src/codex/catalog/provider-fetch.ts`).

Como resultado, reordenar `selectedModels` o `disabledModels` no tiene ningún efecto sobre la posición del selector. Solo puede cambiar si se incluye un modelo.

<a id="effective-picker-pattern"></a>

## Patrón de selector efectivo

Sin selectores de cuenta elegibles y una lista de características no vacía, el pedido resultante es:

1. Modelos en el orden exacto configurado `subagentModels`, con prioridades `0` a `4`.
2. Todos los modelos enrutados restantes, ordenados alfabéticamente por proveedor y luego por ID de modelo, con prioridad `5`.
3. Modelos nativos no seleccionados, empujados por debajo del bloque destacado durante la fusión del catálogo.

Sin `subagentModels`, los modelos enrutados permanecen en la prioridad `5`, las entradas GPT nativas usan su prioridad normal (normalmente `9` para las entradas construidas por opencodex), y el grupo enrutado permanece alfabético como proveedor/identificador.

<a id="example"></a>

## Ejemplo

Supongamos que `subagentModels` contiene estos cinco id en este orden exacto:

```toml
subagentModels = [
  "gpt-5.5",
  "opencode-go/glm-5.2",
  "anthropic/claude-opus-4-6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]
```

El selector comienza de la siguiente manera:

| Posición del selector | Modelo | Prioridad | Por qué aparece allí |
| ---: | --- | ---: | --- |
| 1 | `gpt-5.5` | `0` | Primera selección `subagentModels` |
| 2 | `opencode-go/glm-5.2` | `1` | Segunda selección, a pesar de que su proveedor clasifica después de `anthropic` |
| 3 | `anthropic/claude-opus-4-6` | `2` | Tercera selección |
| 4 | `gpt-5.6-sol` | `3` | Cuarta selección |
| 5 | `gpt-5.6-terra` | `4` | Quinta selección |
| 6 | `anthropic/claude-fable-5` | `5` | Primer id enrutado restante en orden alfabético proveedor/id |
| 7 en adelante | Los modelos enrutados restantes | `5` | Proveedor alfabéticamente, luego modelar id alfabéticamente |
| Después de modelos enrutados | Los modelos nativos | `featured.length + 100` o superior | Los nativos no seleccionados se mueven por debajo del bloque destacado |

Las primeras cinco entradas son las anulaciones anunciadas a `spawn_agent`; el resto continúa en el orden normal del selector. Con los selectores de cuenta, el límite de cinco entradas se aplica después de que las opciones nativas desnudas se hayan expandido a grupos calificados por el selector.

<a id="changing-the-order"></a>

## Cambiar el orden

Utilice `subagentModels` para elegir y ordenar los modelos líderes que Codex también anuncia a `spawn_agent`. La página **Subagentes** del panel de control puede reordenar los ID nativos y enrutados. Utilice `ocx agent subagents set` o edite la configuración opencodex para las opciones exactas `<selector>/<native-openai-model>`; el panel de control conserva esas identificaciones una vez guardadas, incluidas las opciones actualmente no disponibles. Utilice como máximo cinco ID configurados. Con los selectores de cuenta, una opción nativa puede expandirse a múltiples filas de catálogo calificadas por el selector, por lo que las opciones configuradas y las filas anunciadas no son necesariamente individuales.

Si ninguna cuenta configurada admite un modelo nativo con apertura de cuenta, la solicitud falla como una opción de modelo no válida. Si las cuentas de soporte existen pero están temporalmente agotadas o no están disponibles, falla como un límite de tasa reintentable. Estos estados nunca se informan como una clave API no válida; elija otro modelo disponible o espere a que se vuelva a abrir la ventana de cuota de la cuenta capaz.

Utilice `modelPickerOrder` para ordenar solo en pantalla las filas enrutadas `<provider>/<model>` más allá del bloque destacado:

```json
{
  "modelPickerOrder": [
    "tyler/deepseek-v4-flash",
    "jd-chat/kimi-k3",
    "jd-chat/glm-5.2"
  ]
}
```

Las filas enrutadas aparecen en el orden configurado. Una fila enrutada omitida de la matriz mantiene su prioridad normal, por lo que permanece por delante de la banda de visualización `modelPickerOrder`; enumere cada fila enrutada cuya posición relativa desea controlar. Una fila también presente en `subagentModels` mantiene su prioridad destacada. Con una lista solo encaminada, las filas nativas mantienen sus posiciones normales.

Para pedir el selector completo, incluya un identificador nativo desnudo:

```json
{
  "modelPickerOrder": ["gpt-5.6-sol", "opencode-go/glm-5.3"]
}
```

Las filas listadas aparecen primero en orden de array, seguidas de las filas no listadas en orden de prioridad natural. La coincidencia utiliza ID de catálogo exactos: `gpt-5.6-sol` y `openai/gpt-5.6-sol` son filas separadas. También se aceptan ortografías crudas y codificadas del mismo id enrutado, teniendo prioridad las coincidencias exactas. Las entradas vacías son ignoradas. Las filas calificadas para la cuenta necesitan su id calificado para el selector en la lista.

<a id="migration-note-native-ids-in-existing-orders"></a>

### Nota de migración: ID nativos en pedidos existentes

Anteriormente, los identificadores nativos en `modelPickerOrder` fueron ignorados. Una lista existente que contiene un id nativo desnudo ahora activa el pedido de un selector completo, incluidas las filas destacadas. Retire los id nativos desnudos para mantener el comportamiento anterior solo enrutado. Las listas sin configurar, vacías y solo enrutadas conservan su comportamiento; El cálculo de los candidatos a orientación de prioridad natural de OpenCodex no ha cambiado.

`modelPickerOrder` conserva el cálculo de prioridad natural de OpenCodex de hasta cinco candidatos preferidos para la orientación de subagentes. Cada fila movida conserva su prioridad natural por separado de su `priority` nativo; el cambio de orden del selector por sí solo no debe cambiar ese cálculo de OpenCodex. No restringe la elegibilidad para una anulación de modelo de nombre exacto: la lista nativa anunciada no es una lista de permisos, y aún se aplican las restricciones de autenticación, modelo/esfuerzo y backend existentes.

Native Codex utiliza Native `priority` para seleccionar los primeros cinco modelos elegibles visibles para el selector anunciados por `spawn_agent` en V1 y en V2 cuando se exponen las anulaciones del modelo. Por lo tanto, los cinco anunciados pueden cambiar con la orden del seleccionador, incluso cuando los candidatos preferidos de OpenCodex permanecen sin cambios. V1 no recibe inyección de cartucho preferido OpenCodex. V2 también puede recibir orientación de prioridad natural de OpenCodex cuando el estado del catálogo del cliente lo permita; esa orientación no reordena la lista anunciada de la herramienta nativa.

`disabledModels` y los `selectedModels` de cada proveedor siguen siendo campos de visibilidad, no controles de pedido. No hay configuración separada de `modelOrder`, `providerOrder` o mapa de prioridad.

<a id="dashboard-picker-presets"></a>

## Configuración preestablecidos del selector de panel

En marcha **Modelos**, elige **Predeterminado**, **A–Z por modelo**, **Grupo por proveedor**, o **Instantánea más utilizada**Entonces, **Aplicar orden**. Esto guarda los identificadores de ruta actualmente visibles y `modelPickerOrderMode` (`alphabetical`, `provider`, o `most-used`) La mayoría de las lecturas usadas retienen el uso una vez cuando se aplican; las recargas restauran la instantánea sin recuperar el uso nuevamente. Los modelos nuevos o eliminados no lo vuelven a calcular automáticamente. Un pedido guardado manualmente, incluyendo un pedido completo/nativo, permanece intacto hasta que aplique explícitamente un reemplazo. El valor predeterminado borra ambos campos de selección, incluso cuando no hay modelos enrutados disponibles.

Los controles usan `GET/PUT /api/subagent-models`: `chosen` y `available` retienen las opciones guardadas de la lista, incluidos los modelos desactivados o desaparecidos; `pickerAvailable` contiene solo identificadores de catálogo enrutados elegibles. La página Modelos envía `pickerOrder` y `pickerOrderMode`, nunca `models`. La lista solo guarda la configuración del selector de conservación. Las actualizaciones combinadas no válidas y la persistencia fallida dejan intacto el estado anterior del selector/roster.

Los ajustes preestablecidos de solo ruta mantienen las bandas de prioridad existentes destacadas/nativas. Afectan al catálogo Codex y a los grupos dirigidos del descubrimiento Claude; El prefijo nativo de Claude y la propiedad explícita de perfil/alias de escritorio permanecen sin cambios. Se conservan los rangos de guía OpenCodex y los ajustes de reserva configurados, pero los cinco anuncios de Codex nativos y el valor predeterminado recomendado pueden cambiar con la prioridad de visualización. Guardar no reinicia clientes; puede que una actualización de catálogo permanezca pendiente, y los clientes que tengan un catálogo antiguo pueden necesitar volver a abrir.


<a id="custom-routed-order"></a>

### Orden enrutada personalizada

Elija **Orden de encargo** en Modelos para cargar una nueva instantánea enrutada. Arrastre una fila móvil antes de otra fila, o utilice sus botones Arriba/Abajo, luego **Guardar borrador**. Las filas enrutadas destacadas permanecen en la parte delantera en su rango configurado y no pueden moverse. No se muestran las filas nativas; esto no es una vista previa del selector nativo completo. Las filas guardadas supervivientes mantienen su orden relativo y los nuevos candidatos siguen la lista de candidatos actual. Cada guardado envía la lista completa, sin cambiar la lista destacada.

Una orden que contiene ids nativos desnudos permanece protegida hasta que aplique explícitamente un preset o Predeterminado enrutado. Seleccionar una opción diferente por sí sola no la reemplaza. Desconocido destacados bloques de estado de edición. Antes de guardar, el editor comprueba una nueva instantánea; los cambios preservan el borrador y bloquean el ahorro hasta que **Recargar y descartar borrador** cargue la configuración actual. Solicitar que los fallos retengan el borrador. Los archivos guardados aceptados aún pueden tener una actualización de catálogo pendiente; vuelva a cargar antes de volver a editar.

El editor también requiere una identidad de modelo inequívoca para cada candidato enrutado. Si el catálogo de modelos está incompleto, actualice la página Modelos antes de editar; la recarga de la configuración del selector por sí sola no puede restaurar las identidades de catálogo que faltan. Las opciones destacadas se combinan exactamente sin recortar; las opciones duplicadas usan su última posición configurada, y los id canónicos tienen prioridad sobre los id sin procesar.
