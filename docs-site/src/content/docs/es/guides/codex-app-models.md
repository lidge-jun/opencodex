---
title: "Selector de modelos de Codex App"
description: "Cómo aparecen los modelos enrutados de opencodex en Codex App, Codex CLI y Codex TUI mediante el catálogo compartido de Codex."
---

opencodex no parchea la aplicación Codex. Escribe la misma configuración Codex y el catálogo de modelos que Codex CLI / TUI. El servidor de aplicaciones lee ese estado compartido, pero algunas versiones de escritorio Codex aplican una segunda lista de permisos de modelo remoto en el renderizador y aún pueden eliminar las filas enrutadas del selector.

Las entradas de OpenAI usan dos rutas de credenciales: la sesión nativa de Codex y el transporte con clave API `openai-apikey/<model>`. Cambiar `codexAccountMode` entre Pool y Direct no cambia por sí solo los identificadores del selector. Cuando `codexAccountPickerEnabled` y `codexAccountNamespaces` habilitan selectores por cuenta, opencodex añade filas `<selector>/<native-openai-model>` para los selectores elegibles cuyas cuentas asignadas aún existen, y oculta las filas nativas sin calificar del selector de Codex. Las etiquetas son nombres públicos elegidos por el usuario; no implican un rol de cuenta. Una fila calificada utiliza únicamente su cuenta asignada, no cambia la cuenta activa de Pool y rechaza la solicitud si esa cuenta no está disponible, en lugar de sustituirla por otra. Si el catálogo de Codex contiene un identificador de la familia OpenAI visible para una cuenta y respaldado por la API que aún no está en el conjunto estático de opencodex, se conserva exactamente en una fila calificada para los selectores elegibles de la cuenta principal. No se copia a cuentas ajenas ni se añade a las listas sin calificar o con clave API. La fila debe tener los campos de una entrada real del catálogo, lo que excluye entradas mal formadas; esto no demuestra que proceda del proveedor, porque la caché es un archivo propiedad del usuario. Véase [Selectores exactos de cuenta de Codex](/es/reference/configuration/routing/#exact-codex-account-selectors).

`gpt-daybreak-blue-latest` está cerrada por cuenta. opencodex comprueba cada cuenta autenticada de ChatGPT propia lista de modelos Codex antes de anunciarla o enrutarla. En el modo Pool, la fila desnuda solo existe cuando al menos una cuenta Pool elegible informa la identificador. En el modo Direct, la fila desnuda sigue la cuenta utilizada por el catálogo local, y cada solicitud también comprueba la credencial de llamada reenviada (o la credencial principal almacenada cuando se sustituye una portadora de admisión OpenCodex). A
`<selector>/gpt-daybreak-blue-latest` fila solo existe cuando la cuenta asignada de ese selector lo informa. El enrutamiento Pool excluye las cuentas sin derecho. Si no se puede confirmar ninguna lista, la fila cerrada falla en lugar de gastar una prompt en un 400 ascendente.

`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` y `gpt-6-astra` son deliberadamente **no** cerrada de esa manera: que se enumeran en cada instalación, lo que diga la lista de derechos. opencodex pregunta aguas arriba bajo una versión de cliente lo suficientemente nueva como para devolverlos, pero no puede hacer que aparezca una respuesta: una cuenta no confirmada, una búsqueda de tiempo de espera o un fragmento que no se ha puesto al día haría desaparecer el modelo del selector sin explicación. Enumerarlos significa que se envía la solicitud y en su lugar se ve el estado ascendente real. Una cuenta que no tiene uno de estos modelos obtendrá un rechazo ascendente en el momento de la solicitud en lugar de una fila ausente, y en una cuenta múltiple Pool la solicitud ya no se dirige primero a la cuenta que posee el modelo. `disabledModels` es la palanca para ocultar cualquiera de ellos.

Una entrada separada y explícita `customModels` puede exponer el mismo identificador de cable que `openai/gpt-daybreak-blue-latest` a través del proveedor de reenvío de inicio de sesión canónico Codex:

```json
{
  "customModels": [
    {
      "id": "daybreak-codex-forward",
      "provider": "openai",
      "modelId": "gpt-daybreak-blue-latest"
    }
  ]
}
```

Solo ese proveedor exacto, el punto final y la identificación del modelo reciben la instantánea de capacidad de Sol fijada: 922.000 contexto, 829.800 compactación automática, la escalera de razonamiento nativa y los metadatos de la herramienta nativa Codex. La solicitud todavía envía `gpt-daybreak-blue-latest`; opencodex no lo reescribe a Sol ni otorga derecho a la cuenta. La fila `openai-apikey/daybreak-blue-latest` API facturada por separado es una ruta diferente y sus límites de 1.050.000 / 922.000 nunca se copian en la fila de inicio de sesión Codex.

Para las filas personalizadas de Astra y Daybreak en ese destino canónico `openai` Codex-forward, las capacidades explícitas `reasoningEfforts` están limitadas por las capacidades del modelo Codex ancladas. Un `["none", "minimal", "low"]` personalizado se convierte en `["low"]` en el catálogo; una lista no vacía sin valores compatibles también vuelve al valor predeterminado nativo como una sola opción. Un `[]` explícito permanece vacío y no tiene anuncios predeterminados. Un valor predeterminado declarado se retiene solo si pertenece a la lista resultante; de lo contrario, se usa el valor predeterminado nativo cuando está presente, luego la primera opción sobreviviente. La configuración personalizada almacenada no cambia y las sincronizaciones repetidas no vuelven a agregar `max` a una lista personalizada estrecha.

El mismo vínculo de catálogo se aplica cuando el identificador de modelo personalizado ha fijado metadatos de capacidad nativa, incluida una puerta de enlace arbitraria como `YYLJ/gpt-6-astra`. Desktop valida el ID del modelo, por lo que `none` y `minimal` se eliminan de esa fila del catálogo. La identidad nativa completa todavía requiere la identidad exacta del proveedor, el destino y el modelo respaldado por capacidades; una puerta de enlace no hereda Responses Lite, multiagente o ventanas nativas de su nombre. La elección nativa Astra `ultra` de Codex se conserva: es un modo de delegación de cliente convertido en un esfuerzo de cable soportado, distinto del [Lista de esfuerzo del modelo API](https://developers.openai.com/api/docs/models/gpt-6-astra). La normalización de catálogos no reescribe los ajustes de subprocesos existentes. Las pinzas de esfuerzo nativas de tiempo de solicitud permanecen solo canónicas.

Cuando el mapa `codexAccountNamespaces` está vacío, las filas de selector calificadas para la cuenta están desactivadas. Si se omite `codexAccountPickerEnabled` con un mapa no vacío, se tratan como habilitados para la compatibilidad con versiones anteriores. Establezca el valor en `false` para ocultar filas calificadas generadas y restaurar filas nativas desnudas en el selector sin eliminar asignaciones ni deshabilitar el enrutamiento exacto `<selector>/<native-openai-model>`.

Las entradas API GPT-5.6 y Daybreak usan 1.050.000 entradas de contexto / 922.000 entradas máximas, y los identificadores del selector `*-pro` se resuelven en el modelo de cable base con `reasoning.mode: "pro"` mientras que los registros, el uso y el estado del selector mantienen el identificador virtual. El catálogo API se fija a exactamente diez ids: `gpt-5.5`, `gpt-5.6`, Sol/Terra/Luna, sus tres ids virtuales Pro, `daybreak-red-latest`, y `daybreak-blue-latest`; no hay alias `gpt-5.6-pro` genérico. Las solicitudes compactas mantienen el nivel seleccionado pero envían el modelo base sin un objeto de razonamiento.

Seleccione la ruta de credenciales representada por el identificador de selector. Cambiar Pool / Direct en la página de Proveedores; `<selector>` a continuación es una etiqueta pública elegida por el usuario mapeada a través de `codexAccountNamespaces`:

```text
gpt-5.6-sol                         # bare Codex-login route via Pool or Direct
<selector>/gpt-5.6-sol              # stored Codex account mapped by that selector
openai-apikey/gpt-5.6-sol           # API key
openai/gpt-daybreak-blue-latest     # explicit Codex-forward custom row (922,000)
<selector>/gpt-daybreak-blue-latest # account-qualified native id, only when that account reports it
openai-apikey/daybreak-blue-latest  # separate API-key route (1,050,000 / 922,000)
```

Instalación y configuración nuevas sin modo guardado predeterminado a Pool. Las configuraciones actuales usan el marcador 2 y retienen la fuente v1 enviada en `~/.opencodex/config.json.pre-openai-tiers-v2.bak`; restaurarla con:

```sh
cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json
```

Las configuraciones anteriores de tres proveedores v1 migran automáticamente a la fila de una sola opción.

<a id="desktop-remote-allowlist-limitation"></a>

## Limitación de lista remota de escritorio

Si `codex debug models` y app-server `model/list` contienen un modelo enrutado pero Desktop no lo muestra, compruebe el [incidencia de Codex #19694](https://github.com/openai/codex/issues/19694) anterior. Con la directiva remota `use_hidden_models` activa, Desktop puede mantener solo los id en su lista nativa `available_models` y también puede mostrar filas nativas cuya visibilidad de catálogo es `hide`. Las actualizaciones de catálogo y los reinicios proxy solos no pueden cambiar esa directiva de renderizador.

Para un modelo enrutado equivalente, opencodex ofrece un modo de combo con alias nativo que exige activación explícita y está desactivado de forma predeterminada. Publica una identificador desnuda listada con una etiqueta de visualización personalizada honesta y rutas que exactas identificador a través del combo configurado antes del enrutamiento canónico OpenAI. También omite las filas nativas desnudas deshabilitadas del catálogo efectivo mientras existen alias de compatibilidad, por lo que Desktop no puede resucitarlas ignorando `visibility`. Consulte [Codex Compatibilidad con la lista nativa de equipos de escritorio](/es/guides/combos/#codex-desktop-native-allowlist-compatibility) para el comando, la semántica de la clave de inhabilitación y las restricciones de seguridad.

<a id="what-this-means-for-a-disabled-native-model"></a>

### Lo que esto significa para un modelo nativo desactivado

De forma predeterminada, sin un alias nativo configurado, deshabilitar un identificador GPT nativo sin calificar no lo elimina del catálogo. La fila se queda con `visibility: "hide"`, que `/v1/models` y el tablero de instrumentos honran, dejan de enumerar el modelo, mientras que Desktop, bajo la política anterior, puede seguir mostrándolo. Por lo tanto, el modelo aún se puede elegir en Desktop después de deshabilitarlo, y las superficies no están de acuerdo sobre si existe.

La selección no se rechaza por estar deshabilitado. `disabledModels` controla la visibilidad del catálogo, no la admisión, por lo que la solicitud se enruta según las reglas ordinarias como si el modelo estuviera habilitado: el turno se ejecuta en el modelo que deshabilitó o falla en cualquier ruta que se resuelva. De cualquier manera, el resultado no es el que implica la palanca.

La fila se conserva deliberadamente porque contiene los metadatos reales del proveedor: al habilitar de nuevo el modelo se restauran esos datos. Para omitir filas nativas deshabilitadas sin un alias nativo, configura `"omitDisabledNativeModels": true` en `config.json` y ejecuta `ocx sync`. La opción está desactivada de forma predeterminada. La sincronización, la caché generada y el descubrimiento HTTP con formato de Codex omiten esas filas, pero conservan una plantilla nativa de herencia validada por separado. Así, las filas enrutadas mantienen sus metadatos de entrada y herramientas, incluso cuando la única fila que servía de plantilla está deshabilitada. Las solicitudes directas a un identificador nativo deshabilitado siguen enrutándose con normalidad. Un combo `nativeAlias` conserva su comportamiento de omisión independientemente de este ajuste.

Si el archivo `config.toml` de Codex fija un `model` raíz que este proxy no expone, incluido un modelo deshabilitado, cada nueva sesión comienza con un modelo que opencodex no sirve. `ocx doctor` informa que bajo **Codex exposición del modelo por defecto**, como una advertencia en lugar de un fallo, y dice cuando no pudo determinar el conjunto expuesto en absoluto.

<a id="integration-path"></a>

## Ruta de integración

`ocx init`, `ocx start`, y `ocx sync` cablear la configuración y el catálogo compartidos de Codex en el proxy; ver
[Integración con Codex](/es/guides/codex-integration/) para inyección de configuración, sincronización de catálogo, shims, WebSocket fallback, y restaurar la mecánica.

<a id="native-quota-fallback-limitation"></a>

## Limitación de reserva de cuota nativa

Cuando la aplicación Codex agota su cuota nativa de cinco horas, puede cambiar a un modelo de reserva y en gris las otras filas en su selector. Informado en [#2813](https://github.com/lidge-jun/opencodex/issues/2813), esa puerta también oculta opencodex filas enrutadas, a pesar de que utilizan credenciales de proveedor no relacionadas y no consumen ninguna de la cuota ChatGPT.

Esta puerta es aplicada por el cliente antes de que una solicitud llegue al proxy, por lo que opencodex no puede levantarla. Las filas enrutadas se escriben con `visibility: "list"`, el filtrado de catálogo consulta solo `disabledModels` y el `selectedModels` de cada proveedor, y ningún valor de cuota participa en la visibilidad enrutada.

La selección de un modelo enrutado explícitamente no pasa por el selector. Fije el modelo en `config.toml`:

```toml
model = "anthropic/claude-sonnet-5"
```

o enviarlo directamente:

```bash
ocx access test anthropic/claude-sonnet-5 --protocol responses
```

Ambos caminos encaminan correctamente **Una vez que la solicitud llega al proxy** - esa parte está cubierta por pruebas. La aplicación de escritorio Codex, sin embargo, no envía el modelo configurado mientras el modo de reserva está activo: decide la reserva de su propia encuesta `wham/usage` (`luna_reserve` más un límite adicional permitido `gpt-reserve`) y fuerza la configuración del modelo a `gpt-reserve` antes de que la solicitud se vaya, por lo que la ruta `config.toml` se anula en la aplicación. Utilice `ocx access test`, Claude Code a través del proxy (`ocx claude`), o cualquier cliente `/v1` directo hasta que se restablezca la ventana. Véase [Modelos encaminados durante el modo de reserva Codex](/es/guides/codex-integration/#routed-models-during-codex-reserve-mode).

<a id="why-routed-models-show-up"></a>

## Por qué aparecen los modelos enrutados

El selector de modelos de Codex espera entradas de catálogo en forma de Codex. opencodex construye entradas enrutadas clonando una plantilla de modelo nativa Codex y reemplazando la identidad del modelo enrutado:

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

El clon mantiene campos de análisis estrictos, como niveles de razonamiento, tipo de shell, banderas de soporte API e instrucciones base. opencodex luego elimina las capacidades solo nativas que la ruta no puede cumplir, incluidos los metadatos de nivel de servicio OpenAI.

<a id="current-stable-model-coverage"></a>

## Cobertura actual del modelo estable

El conjunto de reserva nativo incluye `gpt-5.5` y GPT-5.6 Sol / Terra / Luna. Para la familia GPT-5.5, opencodex conserva las entradas en vivo más ricas del catálogo Codex instalado y solo sintetiza una entrada faltante. La instantánea de flujo ascendente agrupada se usa solo para GPT-5.6, donde proporciona la identidad real por modelo y los metadatos en lugar de una aproximación de plantilla anterior.

| Ruta | Identificadores de selección y metadatos de catálogo |
| --- | --- |
| Inicio de sesión de Codex (filas por cuenta desactivadas) | Identificadores nativos sin prefijo como `gpt-5.6-sol`, `gpt-5.6-terra` y `gpt-5.6-luna`; `codexAccountMode` selecciona Pool o Direct. Las filas GPT-5.6 tienen una ventana de catálogo de 922.000 tokens. `gpt-6.1-terra` tiene 500,000 de forma predeterminada y 872,000 en contexto largo. |
| Codex inicio de sesión (filas calificadas por cuenta habilitadas con selectores elegibles) | Una fila `<selector>/<native-openai-model>` por selector elegible y modelo nativo compatible; cada fila usa solo su cuenta asignada, y las filas nativas desnudas están ocultas para el selector. Se conservan los metadatos nativos y las ventanas de contexto. |
| Codex inicio de sesión (explícita fila de Daybreak forward) | `openai/gpt-daybreak-blue-latest` solo cuando la fila exacta `customModels` está configurada en el proveedor canónico `openai`. Mantiene el identificador de cable Daybreak y utiliza la instantánea de capacidad Sol fijada (922.000 contexto; 829.800 compactación automática). |
| OpenAI (clave API) | Los modelos con espacio de nombres incluyen `gpt-5.5`, `gpt-5.6`, Sol/Terra/Luna, los identificadores virtuales `*-pro` y los alias Daybreak (1.050.000 de contexto y 922.000 de entrada máxima). `openai-apikey/gpt-6.1-terra` añade 1,050,000 de contexto y 128,000 de salida máxima. |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`, `openrouter/openai/gpt-5.6-terra`, `openrouter/openai/gpt-5.6-luna` (922.000) |
| OpenRouter | `openrouter/openai/gpt-6.1-terra` (1,050,000) |
| Cursor | La reserva estática incluye `cursor/gpt-5.6-sol`, `cursor/gpt-5.6-terra` y `cursor/gpt-5.6-luna` (1.000.000), más filas regulares/rápidas para Grok 4.5, 4.6 y 4.7 (500.000); 4.6 y 4.7 agregan `xhigh`, y el descubrimiento de cuenta real decide qué filas permanecen visibles. |
| xAI | El descubrimiento en vivo es autoritario. El catálogo alternativo incluye `xai/grok-4.6` y `xai/grok-4.7` y por defecto a `xai/grok-4.5`; los tres tienen ventanas de 500.000 tokens. Grok 4.6 y 4.7 exponen `low` / `medium` / `high` / `xhigh` (por defecto aguas arriba: `high` ), mientras que Grok 4.5 se detiene en `high`. |

Las entradas GPT-5.6 fijadas preservan la escalera aguas arriba exacta. Sol y Terra exponen `low` a través de `ultra`; Luna se detiene en `max`. Sol tiene el valor predeterminado de `low`, mientras que Terra y Luna tienen el valor predeterminado de `medium`. La explícita fila Codex Daybreak Blue hereda la escalera y el valor predeterminado de Sol sin cambiar su identidad de cable. `ultra` es una opción orientada al cliente para un razonamiento máximo más delegación proactiva y llega al backend como `max`. Una entrada de selector solo significa que el catálogo está listo: la cuenta conectada o la clave API aún deben tener derecho a usar ese modelo.

<a id="native-and-routed-model-toggles"></a>

## Conmutadores de modelo nativo y enrutado

La página Modelos del panel de control expone `disabledModels` alterna para ids nativos desnudos y `provider/model` ids enrutados. Los identificadores `<selector>/<native-openai-model>` calificados para la cuenta también son compatibles con `disabledModels`, pero el panel de control no enumera ni cambia esas filas de selector exactas; agréguelas a la configuración manualmente:

- Los identificadores de ruta son namespaced (`provider/model` ). Deshabilitar uno lo excluye del catálogo sincronizado y `/v1/models`.
- Los identificadores nativos calificados para la cuenta usan `<selector>/<native-openai-model>`. Agregar uno a `disabledModels` oculta solo esa fila del selector.
- Los identificadores nativos de GPT no llevan prefijo. Deshabilitar uno conserva su entrada del catálogo con `visibility: "hide"` para poder volver a habilitarla después; oculta del descubrimiento tanto la fila sin prefijo como cada copia que especifica un selector para ese modelo.
- Si hay al menos un combo con alias nativo, las filas nativas sin prefijo deshabilitadas se omiten del catálogo en lugar de conservarse ocultas, porque las versiones de Desktop afectadas ignoran esa marca de ocultación. La página Modelos también omite una fila nativa sin prefijo cuando un alias nativo ocupa su identificador; por eso esa fila no muestra un interruptor nativo. Solo las filas no sustituidas por un alias conservan su interruptor. Al volver a habilitar una de esas filas, la sincronización restaura sus metadatos nativos originales o actuales.
- Las filas nativas no sombreadas provienen del conjunto estático admitido, por lo que un modelo no sombreado desactivado permanece visible en el panel y se puede volver a activar.

El pase de visibilidad se ejecuta después de las actualizaciones de instantáneas, y la administración API actualiza el catálogo y fuerza la caché del modelo de Codex después de un cambio.

<a id="multi-agent-surface-mode"></a>

## Modo de superficie multiagente

El control Models-page v1/base/v2 cambia qué superficie de colaboración Codex usa cada entrada del selector; vea [Superficie del subagente](/es/guides/sub-agent-surface/) para el modo canónico, la delegación, la herencia, la reserva y el comportamiento de la tarea cifrada.

<a id="reasoning-top-tiers"></a>

## Razonamiento de los niveles superiores

La visibilidad del nivel de razonamiento es independiente del modo de superficie v1/base/v2. Las entradas con capacidad de razonamiento generadas anuncian `max` para que los sobresueldos directos de esfuerzo de subagente validen; las entradas enrutadas generadas actuales y las entradas GPT nativas más antiguas también anuncian `ultra`. Se conservan escaleras GPT-5.6 aguas arriba exactas, por lo que Luna tiene `max` pero no `ultra`.

En el cable, los adaptadores enrutados mapean o sujetan niveles no compatibles. Para los modelos nativos más antiguos cuya escalera real se detiene en `xhigh`, `nativeEffortClamp` asigna una selección directa de `max` o `ultra` a `xhigh` (por ejemplo, GPT-5.5). Sol, Terra y Luna tienen un verdadero `max` peldaño.

El backend de ChatGPT acepta niveles desde `none` hasta `max`, así que una solicitud nativa nunca reenvía `ultra` literalmente. Los modelos nativos con un nivel real `max` reciben `max`, incluidos Astra, GPT-6.1 Sol y GPT-6.1 Terra aunque anuncien `ultra`; los antiguos, como GPT-5.5, reciben `xhigh` como se explicó arriba. Esto se aplica tanto a `/v1/responses` como a `/v1/chat/completions`. Esa normalización nativa no afecta a los identificadores enrutados: un paso directo OpenAI Chat enrutado puede copiar `reasoning_effort: "ultra"` al proveedor sin cambios, mientras que el adaptador traducido ordinario convierte `ultra` en `max`.

La publicidad del catálogo de los dos niveles superiores es incondicional: `ocx sync` ya no elimina `max` o `ultra` cuando el binario Codex instalado es demasiado viejo para ofrecerlos: las versiones Codex sin esos peldaños están fuera de soporte, y ocultarlos de los clientes actuales cuesta más de lo que compra. Otros peldaños todavía se intersectan con la escalera de entorno de ejecución observada, y un diagnóstico de pinza registrado por un binario anterior deja de aplicarse una vez que el binario en esa ruta informa una versión diferente (el caso de actualización en el lugar), por lo que `ocx status` y `ocx doctor` dejan de advertir sobre una pinza que el entorno de ejecución actualizado ya no necesita. La visibilidad del catálogo no es un derecho: la publicidad `max` / `ultra` no garantiza que la cuenta ascendente o el proveedor acepte el nivel, y para los modelos nativos más antiguos cuya escalera real se detenga en `xhigh`, la limitación aplicada al protocolo descrita antes aún mapea la selección en el momento de la solicitud.

<a id="fast-tier-rules"></a>

## Reglas de nivel rápido

Codex almacena el modo rápido como:

```toml
service_tier = "fast"

[features]
fast_mode = true
```

Pero el catálogo de modelos y el identificador de nivel de solicitud en entorno de ejecución usan `priority`. opencodex preserva esa división. Los modelos de transferencia nativos OpenAI mantienen un soporte rápido; los proveedores enrutados tienen acceso a la capacidad: `service_tier` se elimina solo cuando el proveedor declara `supportsServiceTier: false` (el registro clasifica los canónicos OpenAI como `true`, DeepSeek y Volcengine Ark como `false`), mientras que las puertas de enlace personalizadas no clasificadas mantienen intactos los valores suministrados por el llamante y nunca reciben una inyección. Una puerta de enlace personalizada puede optar a nivel mundial con `supportsServiceTier: true`, o por poco con `modelSupportsServiceTier: { "verified-model": true }`; un `false` exacto reduce un predeterminado de proveedor de `true`, mientras que el nivel de proveedor `false` permanece cerrado por error. La misma decisión final del adaptador/modelo controla tanto los metadatos del catálogo como la inyección en entorno de ejecución, por lo que la opción rápida nunca se anuncia donde no se puede cumplir. Un destino `openai-chat` puede autorizar todos los modelos elegibles con `chatServiceTier: true`, o autorizar solo modelos exactos con `modelSupportsServiceTier`; Responses rutas no necesitan esa autorización de cable de chat adicional.

<a id="selecting-flex-in-codex"></a>

### Seleccionar Flex en Codex

Para un proveedor y modelo enrutados cuya compatibilidad con `service_tier: "flex"` esté
verificada, declara Flex junto con la configuración existente de Fast. Combina estos campos
con la entrada **existente** de `providers.nanogpt`; no reemplaces su URL ni sus credenciales:

```json
{
  "modelSupportsServiceTier": { "openai/gpt-6-luna": true },
  "fastWire": {
    "kind": "service-tier",
    "canonicalToWire": { "priority": "priority", "flex": "flex" },
    "foreignCallerTiers": "verbatim"
  }
}
```

En una ruta `openai-responses` apta, la fila Luna anuncia Standard, Fast y Flex en el selector
de velocidad de Codex. Para `openai-chat`, añade `chatServiceTier: true` **solo si** el endpoint
Chat Completions acepta niveles de servicio indicados por el cliente. La asignación `fastWire`
se aplica a **todo el proveedor**: otros modelos aptos para niveles de servicio dentro de la misma
entrada `providers.nanogpt` también pueden anunciar Flex cuando se publican como filas enrutadas
ordinarias, aunque no aparezcan en `modelSupportsServiceTier`. Ese mapa no es una lista que excluya
a los demás modelos aptos. Las filas de espacios de nombres de Combos y de alias nativos **no**
publican Flex. Verifica la compatibilidad de **cada** modelo enrutado ordinario apto; si solo Luna
admite Flex, usa una entrada de proveedor separada sin otros modelos aptos para Fast.
La compatibilidad con Fast no implica compatibilidad con Flex.

Mantén el modo Fast global de OpenCodex en **Auto** (`fastMode` sin configurar): forzar Fast o
Default reemplaza la elección Flex del cliente. Después de `ocx sync`, actualiza la lista de
modelos de Codex. Selecciona **Flex** en el selector de velocidad o usa
`/model <routed-id> --speed=flex` en Codex CLI. Es un nivel seleccionable, no un valor predeterminado
forzado por modelo: cambiar de modelo no activa Flex automáticamente. Se reenvía como
`service_tier: "flex"` y el proveedor puede rechazarlo. La disponibilidad, el costo y la latencia
dependen del proveedor; ni el menú ni una solicitud prueban por sí solos qué nivel se facturó.

<a id="selecting-ultra-fast-in-codex-desktop"></a>

### Selección ultra rápida en el escritorio Codex

Para un proveedor que admita `service_tier: "ultrafast"`, declare esa asignación de cables una vez. opencodex publica entonces **Ultra rápido** en el menú de velocidad nativo Codex del modelo enrutado; no hay necesidad de editar `opencodex-catalog.json` después de cada sincronización. Por ejemplo, fusione estos campos en un proveedor API configurado para GPT-6.1 Sol:

```json
{
  "models": ["gpt-6.1-sol"],
  "modelSupportsServiceTier": { "gpt-6.1-sol": true },
  "fastWire": {
    "kind": "service-tier",
    "canonicalToWire": { "priority": "priority", "ultrafast": "ultrafast" },
    "foreignCallerTiers": "verbatim"
  }
}
```

La asignación se aplica a todos los modelos Fast-elegibles en ese proveedor. Utilice una entrada de proveedor independiente si solo algunos de sus modelos son compatibles con Ultra Fast. Mantenga el modo rápido de opencodex en **Auto** (omit `fastMode` ) para que la selección de velocidad de la aplicación llegue al proveedor; forzó a Fast a enviar `priority`, y forzó a Default a dejar caer el nivel. Actualizar el catálogo de modelos, reiniciar el escritorio Codex si todavía tiene la lista anterior, seleccione el modelo enrutado y luego elija **Ultra rápido** en su menú de velocidad. El estándar sigue siendo el valor predeterminado.

Solo un cable `service-tier` elegible con una asignación explícita de `ultrafast → ultrafast` agrega esta opción a las filas enrutadas; el soporte Fast ordinario o un nombre similar a GPT es insuficiente. Esa asignación enrutada no se aplica a filas nativas/de cuenta o alias combinados. La eliminación de la asignación o la desactivación del soporte de nivel de servicio de ese modelo elimina la opción enrutada generada tanto del catálogo como de la caché en la siguiente sincronización exitosa. La declaración activa también controla la opción Ultra Fast cuando Codex carga su lista de modelos sobre HTTP.

Para filas enrutadas, `ultraFastTier` conserva los niveles Ultra Fast suministrados de forma independiente desde la misma fila persistente exacta; los niveles enrutados generados no se tratan como proporcionados por el operador. Para las filas `gpt-6-astra` / `gpt-6.1-sol` nativas desnudas y sus clones vinculados a la cuenta de confianza, habilitar `ultraFastTier` también genera una opción Ultrafast que falta sin cambiar el nivel predeterminado nativo. Al deshabilitarlo, solo se retiran los metadatos de nivel nativo rastreados según se generan; se conservan los descriptores de nivel nativo suministrados o editados de forma independiente.

[OpenAI 's API guía](https://developers.openai.com/api/docs/guides/ultrafast-mode) documentos Ultrafast para GPT-6 Astra, GPT-6.1 Sol y GPT-6.1 Terra. API acceso y [Codex plan/acceso al espacio de trabajo](https://learn.chatgpt.com/docs/agent-configuration/speed) están separados. La elección del menú no otorga acceso al proveedor ni garantiza la velocidad medida; Ultra Fast aumenta el uso / costo, y los requisitos de características propias de Codex aún se aplican.

<a id="subagent-selection"></a>

## Selección de subagentes

Codex ordena las entradas del catálogo visibles en el selector por `priority` ascendente y anuncia las cinco primeras como alternativas de modelo para `spawn_agent`. La página Subagentes del dashboard permite seleccionar y guardar hasta cinco identificadores nativos sin prefijo o identificadores `provider/model` enrutados. Un `subagentModels` configurado manualmente también acepta identificadores `<selector>/<native-openai-model>` que especifican una cuenta. El dashboard conserva esos identificadores exactos al guardar la lista, incluso si sus modelos ya no están disponibles en el catálogo actual. opencodex asigna prioridades bajas de catálogo en el orden seleccionado; cuando están habilitadas las filas del selector por cuenta, las selecciones nativas sin prefijo se expanden a grupos por selector. Los demás modelos siguen siendo invocables mediante su identificador exacto.

La lista de modelos destacados está separada de la selección **Delegación de subagentes** del Dashboard. Controla que anula Codex ofrece primero; no selecciona un modelo o desencadenar delegación por sí mismo.

<a id="desktop-remote-servers"></a>

## Servidores remotos de escritorio

Codex El modo de servidor remoto del escritorio filtra el selector contra el propio cliente
`available_models` allowlist (activo cuando el control remoto `use_hidden_models` El ajuste está activado). Encaminado Las entradas del catálogo todavía se cargan y sirven - `model/list` devuelve y el CLI incluido lee - pero el renderizador de escritorio deja caer cualquier cosa que no esté en esa lista de permisos solo nativa antes renderizado. opencodex no tiene ningún gancho en esa lista; el error de flujo ascendente se rastrea en
[openai/codex#19694](https://github.com/openai/codex/issues/19694).

Until Desktop expone un control para la lista de permisos:

- Fije el modelo directamente en `~/.codex/config.toml` en la máquina remota, por ejemplo `model = "input/grok-4.5"`. El selector puede mostrar `Custom`, pero las solicitudes aún usan el modelo enrutado configurado.
- Utilice Codex CLI o TUI en lugar del selector de escritorio; no aplican la lista de permisos y la lista de modelos enrutados normalmente.

<a id="refreshing-model-state"></a>

## Estado del modelo refrescante

Si el selector sigue mostrando entradas obsoletas, actualice el catálogo y reinicie la superficie de destino Codex:

```bash
ocx sync
```

opencodex reescribe `models_cache.json` con un envoltorio de caché deliberadamente obsoleto cada vez que cambia la visibilidad del catálogo, la prioridad o los metadatos, por lo que la próxima actualización del modelo Codex lee el nuevo catálogo.

Después de escribir un catálogo o modelo de caché, OpenCodex invalida su observación de aplicación-servidor en caché para que la siguiente solicitud verifique la frescura del proceso nuevamente. Una sincronización de configuración también invalida la observación cuando el contenido del catálogo no cambia. Esta actualización no reinicia los procesos Codex.
