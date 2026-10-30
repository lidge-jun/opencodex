---
title: "OpenCode"
description: "Usa modelos enrutados desde OpenCode: opencodex inyecta el proveedor durante el lanzamiento y conserva tus archivos de configuración."
---

OpenCode combina varias capas de configuración JSON para leer sus proveedores. No ofrece una variable equivalente a `ANTHROPIC_BASE_URL`. `ocx opencode` resuelve esa integración: comprueba que el proxy esté en ejecución, construye un bloque de proveedor a partir del catálogo visible y lo inyecta mediante la configuración en línea de OpenCode (`OPENCODE_CONFIG_CONTENT`).

<a id="quickstart"></a>

## Inicio rápido

```bash
ocx opencode
```

El comando comprueba que el proxy esté en ejecución y abre OpenCode con los bloques generados `provider.opencodex` y `providers.opencodex`, solo para ese proceso. El primero usa la estructura heredada de V1 y el segundo la estructura nativa de V2. Ambos incluyen las variantes de esfuerzo de razonamiento en el formato de su cliente. Los argumentos adicionales se transmiten al cliente: `ocx opencode run "hello"`.

Los modelos enrutados aparecen en el selector bajo el proveedor `opencodex`:

```text
opencodex/kiro/glm-5
opencodex/gpt-5.6-sol      # native slugs stay unprefixed
```

<a id="reasoning-effort"></a>

## Esfuerzo de razonamiento

OpenCode ofrece el esfuerzo de razonamiento mediante *variantes* del modelo. opencodex genera una variante por cada esfuerzo declarado, incluido `none` cuando el modelo admite explícitamente desactivar el razonamiento. La selección llega al proxy como esfuerzo de razonamiento, además de mostrarse en el selector. Las asignaciones de esfuerzo al proveedor de origen que existan en opencodex siguen aplicándose.

Se generan dos bloques de proveedor:

| Bloque | Cliente que lo lee | Formato de variantes |
|---|---|---|
| `provider.opencodex` | OpenCode V1 (`npm` + `options`) | Mapa de opciones heredado |
| `providers.opencodex` | OpenCode V2 (`package` + `settings`) | Array de configuración nativo |

V2 usa su array nativo de variantes en lugar del mapa heredado. Ambos bloques identifican los mismos proveedores y modelos y se combinan en una sola entrada; ningún modelo aparece duplicado. V2 siempre escribe el array de variantes, vacío cuando no se declara ninguna, para impedir que el cliente invente opciones de esfuerzo bajo, medio y alto. En el bloque heredado, los modelos conocidos de razonamiento fijo desactivan por el mismo motivo todos los niveles generados automáticamente; esas entradas desactivadas no son esfuerzos seleccionables.

Si se conoce el esfuerzo predeterminado del modelo, se exporta; elegir una variante sustituye ese valor en el cliente. Si el catálogo no declara un predeterminado, no se inventa ninguno. El lanzador regenera estos ajustes en cada inicio. Después de cambiar el predeterminado en opencodex, actualiza la integración administrada o vuelve a exportar la instantánea manual.

<a id="images-and-attachments"></a>

## Imágenes y archivos adjuntos

OpenCode decide si un modelo admite imágenes a partir de su entrada de catálogo. No puede consultar models.dev sobre `opencodex`, porque ese proveedor no está registrado allí. Por eso, los bloques generados incluyen las capacidades por modelo que el proxy informa en `GET /api/models`. Por ejemplo, el bloque heredado contiene `attachment` y `modalities`:

```json
"gpt-5.6-luna": {
  "name": "gpt-5.6-luna (native)",
  "limit": { "context": 272000, "output": 128000 },
  "attachment": true,
  "modalities": { "input": ["text", "image"], "output": ["text"] }
}
```

V2 recibe los campos nativos `capabilities.input` y `capabilities.output`. Cuando se conoce la compatibilidad con herramientas, también recibe `capabilities.tools`. Los clientes heredados leen los campos del ejemplo anterior. Si el catálogo anuncia entrada de imágenes para un modelo cubierto por el sidecar de visión, OpenCode permite enviar el adjunto para que el sidecar lo describa antes de la solicitud al proveedor de origen.

V2 exige un booleano `tools` cuando existe el objeto nativo de capacidades. Si se desconoce la compatibilidad con herramientas, se omite ese objeto. Las modalidades de entrada conocidas siguen llegando a V2 mediante la migración del bloque heredado. Así se evita inventar capacidades o generar una configuración de proveedor inválida.

Cuando una capacidad es desconocida, se conservan las suposiciones predeterminadas de OpenCode; esas suposiciones no prueban lo que admite el proveedor. Los metadatos que declaran explícitamente un modelo de solo texto impiden enviarle imágenes desde el cliente.

Los modelos personalizados heredan los metadatos conocidos del catálogo, salvo que se guarde una anulación explícita. Una entrada personalizada que declara solo texto se mantiene así. Las capacidades desconocidas se omiten y una lista explícitamente vacía de esfuerzos no afirma que el modelo sea incapaz de razonar.

<a id="your-own-config-is-never-modified"></a>

## Tus archivos de configuración se conservan

El lanzador no copia ni reescribe `~/.config/opencode/opencode.json`, los archivos de proyecto `opencode.json` / `opencode.jsonc` ni ninguna otra capa de configuración en disco. Puede leer la configuración global o del proyecto para detectar una definición del proveedor en `provider.opencodex` o `providers.opencodex`. Tus proveedores, agentes, atajos de teclado, entradas MCP y referencias relativas `{file:…}` siguen resolviéndose desde sus archivos originales.

Solo para ese inicio, opencodex añade los dos bloques generados, `provider.opencodex` y `providers.opencodex`, mediante la configuración en línea de OpenCode. Esta capa se combina después de las capas global, personalizada y del proyecto, y sustituye únicamente las claves en conflicto para el proceso hijo.

| Capa | Comportamiento con `ocx opencode` |
| --- | --- |
| Configuración global, personalizada o del proyecto | Permanece en disco tal como la escribiste |
| Configuración en línea (`OPENCODE_CONFIG_CONTENT`) | Recibe los bloques generados `provider.opencodex` y `providers.opencodex`, combinados con la configuración en línea heredada |
| Rutas relativas `{file:…}` | Se resuelven respecto del archivo de configuración que las definió |

Si la configuración global o del proyecto ya define `provider.opencodex` o `providers.opencodex`, el lanzador muestra una nota informativa: la capa de `ocx opencode` tiene prioridad durante ese inicio.

<a id="putting-the-block-into-your-own-config"></a>

## Añadir el bloque a tu configuración

`ocx opencode` inyecta el proveedor solo para un inicio. Ejecutar `opencode` directamente no configura el proxy. Para usar los modelos enrutados desde ese comando o desde una extensión del editor que no pase por el lanzador, `ocx export` muestra los mismos bloques para que los combines con tu configuración:

```bash
ocx export --client opencode
```

El proxy debe estar en ejecución. El comando muestra la configuración, el destino canónico (`~/.config/opencode/opencode.json`, o bajo `XDG_CONFIG_HOME` si está definido), la advertencia para combinarla y la línea de exportación de la variable de entorno. Nunca modifica ese archivo: añadir los bloques a tu configuración es una acción explícita tuya.

:::caution[Combina la configuración; no la reemplaces]
Combina ambos bloques, `provider.opencodex` y `providers.opencodex`, con el contenido existente. Reemplazar el archivo completo elimina tus otros proveedores, agentes, atajos y entradas MCP. Por ese motivo, `ocx export --out` rechaza sobrescribir un archivo existente. Dirige `--out` a una ruta temporal y copia los bloques:

```bash
ocx export --client opencode --out ~/opencodex-opencode.json
```
:::

El bloque añadido manualmente es una instantánea estática: no sigue los cambios del catálogo como el bloque del lanzador. Vuelve a ejecutar `ocx export` después de añadir un proveedor o cambiar la visibilidad o los metadatos de un modelo. También puedes [activar la integración administrada](/es/guides/integrations/): `ocx sync` actualiza los bloques que ya administra, conservando los editados o eliminados manualmente.

Después de combinar los bloques, exporta la clave de acceso antes de abrir OpenCode si el listener de inferencia exige autenticación. Un listener vinculado únicamente a loopback no la requiere:

```bash
export OPENCODEX_OPENCODE_API_KEY=<your key>
```

<a id="the-admission-key-is-not-written-to-disk"></a>

## La clave de acceso no se escribe en disco

Cuando el proxy requiere una clave API, la configuración en línea usa la referencia `{env:…}` de OpenCode en lugar del secreto. Los listeners vinculados a loopback la usan como `apiKey`; los demás la envían solo mediante `x-opencodex-api-key`, manteniendo separadas la autenticación del proxy y la cabecera `Authorization` del proveedor de origen.

Ejemplo de loopback:

```json
"options": {
  "baseURL": "http://127.0.0.1:10100/v1",
  "apiKey": "{env:OPENCODEX_OPENCODE_API_KEY}"
}
```

Ejemplo fuera de loopback:

Este ejemplo se configura manualmente en el cliente remoto. Prepara primero un frontend TLS y usa su URL HTTPS; OpenCodex no termina TLS ni descubre esa URL para `ocx opencode`. HTTP sin cifrar en la LAN expone la credencial durante el transporte. Como alternativa, conserva el proxy en loopback y usa un túnel SSH local. Consulta [TLS para el listener de datos](/es/guides/remote-hub/#giving-the-data-listener-tls).

```json
"options": {
  "baseURL": "https://proxy.example.com/v1",
  "headers": {
    "x-opencodex-api-key": "{env:OPENCODEX_OPENCODE_API_KEY}"
  }
}
```

El valor real solo se transmite mediante el entorno del proceso hijo. `OPENCODEX_API_AUTH_TOKEN` tiene prioridad, seguido del archivo protegido de token del servicio y de una clave API configurada. Un listener vinculado fuera de loopback exige una credencial aceptada.

Un listener vinculado a loopback (`127.0.0.1`, el valor predeterminado) no exige una clave del plano de datos, aunque haya claves de cliente configuradas. Para ese listener puedes dejar sin establecer la variable de la referencia `{env:…}`. La URL local por sí sola no basta: un listener público vinculado a `0.0.0.0` sigue exigiendo una clave aceptada aunque se acceda por `127.0.0.1`. Exporta la clave cuando `hostname` esté configurado fuera de loopback; consulta [Acceso remoto](/es/reference/configuration/server/#remote-access). Esta clave pertenece a opencodex y es distinta de las claves de los [proveedores de origen](/es/guides/providers/).

<a id="reverting"></a>

## Revertir

El lanzador no escribe ningún archivo de configuración generado en `~/.opencodex`. Ejecuta `opencode` directamente para que lea tu configuración como antes.

<a id="model-limits"></a>

## Límites de modelos

`limit.context` solo se escribe cuando el catálogo informa una ventana de contexto confirmada. Si no la conoce, se omite todo el bloque `limit` y OpenCode conserva sus valores predeterminados.

El límite de salida usa el máximo conocido del modelo en el catálogo o los metadatos generados. Solo si se desconoce se usa `32000`. Siempre se limita a la ventana de contexto, incluso cuando el máximo conocido es inferior a `32000`.

Los límites de entrada conocidos también se incluyen y se limitan al contexto; los desconocidos se omiten. La exportación de la CLI y del dashboard, la actualización administrada y el lanzador comparten los mismos metadatos efectivos.

El bloque del proveedor `opencodex` se regenera en cada inicio, por lo que los ajustes manuales por modelo dentro de ese bloque no se conservan. Guarda tus entradas personalizadas bajo una clave de proveedor propia.

<a id="slow-local-models-prefill-timeouts"></a>

## Modelos locales lentos: tiempos de espera durante el prefill

opencode espera un tiempo limitado hasta recibir el primer encabezado de respuesta del proveedor (cinco minutos por defecto en la V2 actual) y aplica otro límite más largo entre fragmentos del streaming. Detrás del proveedor `opencodex`, un modelo local (LM Studio, vLLM, Ollama o cualquier endpoint alojado por ti) puede superar ese tiempo durante el *prefill* de un prompt grande: el procesamiento del prompt antes de emitir el primer token. En un turno sin streaming, el proxy no envía nada a opencode hasta que termina el proveedor de origen, por lo que vence primero la espera de encabezados de opencode y el turno falla con `Timed out waiting for response headers`, aunque el modelo siga trabajando.

El proveedor `opencodex` generado reúne todos los proveedores enrutados en un solo bloque y los tiempos de espera de opencode se aplican al proveedor completo. Para ampliar o desactivar la espera de todo el proveedor, usa `opencodeClientExport` en la configuración de opencodex. Se omite por defecto, de modo que opencode conserva sus esperas nativas de encabezados y fragmentos salvo que actives esta opción:

```json
{
  "opencodeClientExport": {
    "headerTimeoutMs": false,
    "chunkTimeoutMs": 1800000
  }
}
```

| Campo | Ajuste de opencode | Significado |
| --- | --- | --- |
| `headerTimeoutMs` | `settings.headerTimeout` | Espera hasta el primer encabezado de respuesta del proxy. Un número de milisegundos, o `false` para desactivarla. |
| `chunkTimeoutMs` | `settings.chunkTimeout` | Espera entre fragmentos de respuesta del streaming. Un número de milisegundos, o `false` para desactivarla. |
| `timeoutMs` | `settings.timeout` | Límite para la solicitud completa. Un número de milisegundos, o `false`. opencode no aplica un valor predeterminado. |

Cada valor se emite sin cambios tanto en el bloque `provider.opencodex` (`options`) como en `providers.opencodex` (`settings`). Desactivar `headerTimeout` elimina la protección de opencode frente a un proxy bloqueado para todos los modelos enrutados a través de él; por eso conviene usar un valor explícito amplio (por ejemplo, `1800000` para treinta minutos), salvo que quieras expresamente quitar el límite. Un valor mal formado se descarta y opencode conserva su valor nativo predeterminado, en lugar de fallar al cargar.

<a id="requirements"></a>

## Requisitos

OpenCode debe estar instalado y disponible en `PATH`:

```bash
npm install -g opencode-ai
```

El lanzador lee el catálogo con el token de administración local obtenido del entorno o del directorio del proxy en ejecución. Se conecta directamente a un listener de administración de loopback y rechaza redirecciones. Un hub vinculado solo a una dirección no local necesita activar `hub.managementIngress`. El token de administración no se pasa al proceso hijo de OpenCode: la inferencia sigue usando su clave de datos independiente. Si falta el token de administración local, el lanzador informa del problema; no vuelve a intentarlo con una clave de datos.
