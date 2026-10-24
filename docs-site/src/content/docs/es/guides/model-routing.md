---
title: "Enrutamiento de modelos"
description: "Cómo decide opencodex qué proveedor sirve un ID de modelo determinado."
---

Cuando Codex solicita un modelo, `router.ts` lo resuelve exactamente a un proveedor configurado. Las reglas se comprueban **por orden**; el primer partido gana.

Para OpenAI, se considera una identificación `<selector>/gpt-*` configurada a través de `codexAccountNamespaces` a exactamente una cuenta Codex almacenada antes de combo o espacios de nombres de proveedor. Bare `gpt-*` ids selecciona el proveedor canónico `openai` en su lugar. Su `codexAccountMode` elige Pool (por defecto, cuentas principales más agregadas) o Direct (portadora actual de llamadas / principal) sin cambiar el ID del modelo. `openai-apikey/<model>` explícitamente selecciona API -clave de transporte. Estas rutas de credenciales no se cruzan entre sí.

<a id="precedence"></a>

Antes de estas reglas, un `policy/<id>` explícito o un alias de perfil de enrutamiento configurado evalúa la política y enruta a su candidato concreto. Un selector de política reservado desconocido se rechaza sin continuar por las rutas de proveedores ni por la predeterminada.

## Precedencia

1. **Selector de cuenta Exact Codex** - si el id es `<selector>/<native-openai-model>` y el selector está configurado en `codexAccountNamespaces`, la solicitud usa solo la cuenta almacenada asignada y envía el modelo nativo desnudo aguas arriba. Si el destino exacto no está disponible, la solicitud se rechaza sin recurrir a Pool, Direct ni al enrutamiento del proveedor.

   ```text
   side/gpt-5.6-sol → provider "openai", model "gpt-5.6-sol", account selector "side"
   ```

2. **Identificación combinada o alias** - mientras se configura al menos un combo, un alias canónico `combo/<id>` o combo configurado selecciona su objetivo concreto antes de que se comprueben los espacios de nombres del proveedor. Sin combos configurados, un proveedor físico heredado llamado literalmente `combo` sigue siendo un espacio de nombres de proveedor normal. Véase [Combos](/es/guides/combos/) para la selección de destino y el comportamiento de conmutación por error.

3. **`provider/model` explícito** - si el id contiene `/` y la parte anterior es el nombre de un proveedor configurado, ese proveedor se utiliza y el id se quita a la parte después de la barra.

   ```text
   anthropic/claude-opus-5     →  provider "anthropic",   model "claude-opus-5"
   ollama-cloud/glm-5.2        →  provider "ollama-cloud", model "glm-5.2"
   openrouter/openai/gpt-5.6-sol → provider "openrouter",  model "openai/gpt-5.6-sol"
   ```

   Esta es la forma explícita del proveedor de rutas, y el selector de modelos de Codex utiliza para los modelos enrutados. Si el mismo id público es un alias combinado configurado, gana la regla 2. Si el proveedor nombrado está deshabilitado, esta forma explícita lanza en lugar de enrutamiento.

4. **Desnudo nativo OpenAI - familia id** - un id tal como `gpt-*`, `o1-*`, `o3-*`, o `o4-*` utiliza el canónico habilitado `openai` proveedor y su configurado Pool o Direct modo de cuenta.

5. **`defaultModel` de un proveedor** - si el `defaultModel` de cualquier proveedor es igual al id, ese proveedor se usa (id pasó sin cambios).

6. **Patrones de prefijo incorporado** - el id se compara con prefijos de familia de modelos conocidos, y luego se enruta a un proveedor configurado con ese nombre (o prefijo de nombre):

   | Prefijos | Proveedor |
   | --- | --- |
   | `claude-`, `claude-sonnet-`, `claude-opus-`, `claude-haiku-` | `anthropic` |
   | `llama-`, `mixtral-`, `gemma-` | `groq` |

   Este emparejador se basa en el nombre y, a diferencia de las exploraciones `defaultModel` / `models[]`, actualmente no filtra un proveedor coincidente cuya bandera `disabled` es verdadera.

7. **`models[]` de un proveedor** - si no se ganó ninguna regla de prefijo y un proveedor activo muestra el id en su `models[]`, se usa ese proveedor. La regla 4 ya envía una identificación desnuda `gpt-*` al proveedor canónico habilitado `openai` antes de que la reclamación `models[]` de otro proveedor pueda coincidir.

8. **Proveedor predeterminado** - si nada coincide, el id se envía a `config.defaultProvider` sin cambios. (Si no hay ningún proveedor predeterminado configurado, o está deshabilitado, el enrutamiento se lanza.)

<a id="api-keys-and-environment-variables"></a>

## API claves y variables de entorno

Cualquiera que sea la ruta elegida, el `apiKey` del proveedor se resuelve a través de `resolveEnvValue()`: un valor de `${OPENAI_API_KEY}` o `$OPENAI_API_KEY` se expande desde el entorno en el momento de la solicitud, por lo que los secretos nunca necesitan vivir en `config.json`.

<a id="catalog-visibility-and-context-caps"></a>

## Visibilidad del catálogo y tapas de contexto

El enrutamiento y la visibilidad del catálogo son controles separados:

- `disabledModels` esconde identificadores de rutas de nombres del catálogo Codex y `/v1/models`; una identificador GPT nativa desnuda se mantiene en el catálogo con `visibility: "hide"`. El **no** rechaza una solicitud directa para ese modelo.
- El `selectedModels` no vacío de un proveedor es otra lista de permisos de catálogo. El descubrimiento en vivo y el enrutamiento directo aún funcionan; solo se reducen el catálogo y las emisiones de `/v1/models`.
- Conjunto de instalaciones frescas `modelDiscovery.newModelPolicy` a `"off"`. Después de que el primer live fetch exitoso establece una línea de base, las llegadas posteriores se agregan a `disabledModels` y llevan una insignia de tablero **NUEVO** hasta que se habilita o se reconoce. Las instalaciones existentes permanecen en `"on"` hasta que se opta. La política se aplica antes de publicar modelos recién descubiertos a través de `/v1/models`, el panel de control, las exportaciones de configuración del cliente o una sincronización de catálogo Codex (incluido el inicio del servicio). Habilitar una llegada manualmente la mantiene habilitada en actualizaciones y exportaciones posteriores. Si la configuración del proveedor en ejecución difiere del disco, las listas de modelos siguen aplicando la directiva mediante una proyección temporal; dejan intacta la configuración en ejecución y las opciones guardadas. Utilice `ocx models new-policy off` a nivel mundial, agregue `--provider <name>` para una anulación e inspeccione `ocx models new-arrivals [--json]`. Los resultados fallidos/degradados nunca cambian la línea base. Los proveedores con un `selectedModels` no vacío (incluido el modo preestablecido) ya están curados, por lo que esta política es deliberadamente inerte para ellos.
- `provider.disabled: true` elimina ese proveedor del descubrimiento de catálogo. Las solicitudes explícitas `provider/model` fallan y las exploraciones `defaultModel` / `models[]` las omiten.
- Las filas de catálogo enrutadas se clonan a partir de la plantilla nativa Codex, por lo que los indicadores de entrega solo nativos se eliminan durante la normalización: `supports_websockets`, `supports_reasoning_summaries` y `supports_experimental_context`. Un proveedor enrutado nunca hereda el contrato de contexto experimental; heredando el Codex compacto después de casi cada paso en hilos enrutados largos.
- `providerContextCaps` se aplica por proveedor Codex -caps contexto visible. `contextCapValue` es el tablero predeterminado (350,000 por defecto), pero no hace nada por sí mismo hasta que un proveedor está presente en `providerContextCaps`. Cambiar el valor del panel de control actualiza cada límite habilitado solo cuando se activa "aplicar a cada proveedor enrutado"; de lo contrario, cada proveedor mantiene su propio límite. Las ventanas ordinarias conocidas solo se pueden bajar; los modelos nativos que admiten una ventana más larga pueden expandirse hasta su propio techo soportado. Las tapas nunca cambian el límite real del modelo ascendente. Apagar una tapa conserva su selección en `providerContextCapValues`, incluso después de la recarga; encenderla restaura esa selección. Una selección recordada nunca aplica un límite mientras está deshabilitada. El envío de `{ "setAll": true }` sin `value` habilita a todos los proveedores configurados al valor global actual y reemplaza sus selecciones recordadas.
- Un modelo GitHub Copilot que admite el nivel de contexto largo ascendente puede optar por `providers.github-copilot.modelContextTiers.<model> = "long_context"` o `ocx provider edit github-copilot --model-context-tier <model>=long_context`. El nivel envía `contextTier: "long_context"` en el Chat del Copiloto y Responses solicitudes. Se eleva la ventana anunciada sólo cuando ese modelo exacto tiene una ventana conocida por modelo en `modelContextWindows` (por ejemplo, `1000000`); un modelo desconocido mantiene su ventana en vivo. Gana una ventana explícita por modelo, luego se aplica el límite de proveedor existente. Las ventanas guardadas y las selecciones de nivel sobreviven al inicio y al reinicie OAuth. OAuth presets llenan los valores predeterminados por modelo que faltan mientras mantiene sus entradas configuradas, incluso en xAI. El nivel `"default"` conserva metadatos de contexto en vivo normales. El control del panel se planifica por separado.

```json
{
  "contextCapValue": 350000,
  "providerContextCaps": {
    "anthropic": 350000,
    "cursor": 350000
  }
}
```

<a id="tips"></a>

## Propinas

- **Dirigir una cuenta Codex explícitamente** con `<selector>/<native-openai-model>` (regla 1). Esa ruta es exacta y falla cerrada; nunca cambia silenciosamente a otra cuenta.
- **Sea explícito para los modelos enrutados.** Prefiera `provider/model` (regla 3) cuando esa identificación pública exacta no es un alias combinado. Nombra directamente al proveedor y coincide con lo que Codex muestra en su selector después de una sincronización de catálogo.
- **Semilla `models[]` o `defaultModel`** en un proveedor tan corto ids (reglas 5/7) resolver sin el prefijo `provider/`.
- **Los patrones de prefijo son una conveniencia**, no es una garantía: solo se resuelven si un proveedor con ese nombre (p. ej. `anthropic` o `groq`) está configurado realmente.

Consulte [Configuración](/es/reference/configuration/) para los campos de proveedor que leen estas reglas.


<a id="structured-output-on-cursor-routes"></a>

## Salida estructurada en rutas Cursor

Cursor rutas traducen Responses `text.format` (`json_object` o `json_schema`) en instrucciones explícitas de respuesta final en el contexto del sistema y solicitud activa, incluyendo continuación de resultados de herramientas. Esta es una reserva rápida: Cursor no proporciona una decodificación JSON restringida nativa en este transporte, y los modelos aún pueden devolver una respuesta no válida. El adaptador no convierte la prosa en una decisión de aprobación. Las personas que llaman deben validar el JSON devuelto y usar una ruta con capacidad de salida estructurada cuando se requiere una aplicación estricta. Las solicitudes de texto ordinarias y las llamadas de herramientas intermedias mantienen su comportamiento existente.
