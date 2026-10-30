---
title: "Pi"
description: "Usa modelos enrutados desde Pi: ocx export genera un proveedor personalizado para models.json conectado al proxy."
---

Pi lee sus proveedores de un archivo JSON global, por lo que opencodex no lo inicia. `ocx export` genera el bloque del proveedor `opencodex`, con la URL base, la lista de modelos y un marcador de clave local que no es secreto. Debes combinarlo con tu propia configuración.

<a id="quickstart"></a>

## Inicio rápido

Inicia el proxy y muestra la configuración:

```bash
ocx start
```

Mantén ese proceso en ejecución. En una segunda terminal, muestra la configuración:

```bash
ocx export --client pi
```

La salida comienza con el JSON e indica después la ruta de destino, la advertencia para combinar la configuración, la indicación de uso local y cuántos modelos tienen límites de contexto confirmados. Esta exportación solo admite un proxy de loopback sin autenticación; no configura el acceso remoto.

```json
{
  "providers": {
    "opencodex": {
      "baseUrl": "http://127.0.0.1:10100/v1",
      "api": "openai-completions",
      "apiKey": "opencodex-loopback",
      "compat": {
        "sendSessionAffinityHeaders": true,
        "supportsDeveloperRole": false
      },
      "models": [
        {
          "id": "anthropic/claude-opus-5",
          "name": "Claude Opus 5 (anthropic)",
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 128000
        }
      ]
    }
  }
}
```

Los proveedores generados para Pi activan `compat.sendSessionAffinityHeaders`. Conserva esta opción al combinar o editar el proveedor: Pi aporta una identidad estable de sesión y OpenCodex deriva de ella la afinidad canónica de OpenCode Go. Pi puede omitir esa identidad cuando `cacheRetention` es `none`.

También establecen `compat.supportsDeveloperRole` en `false`, para que Pi envíe su prompt de sistema como `system` en lugar de `developer`. OpenCodex reenvía los roles de Chat Completions tal como llegan; varios proveedores compatibles con OpenAI rechazan `developer` con HTTP 400, mientras que todos aceptan `system`.

Los identificadores son los selectores canónicos del proxy. Los modelos enrutados aparecen como `provider/model` (`anthropic/claude-opus-5`), y los modelos nativos de OpenAI conservan su identificador sin prefijo (`gpt-5.6-sol`). El sufijo de `name` —`(anthropic)`, `(native)` o `(routed)`— permite distinguir modelos con el mismo nombre de distintos proveedores en el selector de Pi.

<a id="where-it-goes"></a>

## Dónde se guarda

El archivo global de modelos de Pi es:

```text
~/.pi/agent/models.json
```

:::caution[Combina la configuración; no la reemplaces]
`ocx export` nunca escribe ese archivo. Combina el bloque `providers.opencodex` con el contenido existente: reemplazar todo el archivo destruye los demás proveedores configurados. `--out` sirve para una ruta temporal y no sobrescribe archivos existentes salvo que se indique `--force`:

```bash
ocx export --client pi --out ~/opencodex-pi-models.json
ocx export --client pi --json > ~/opencodex-pi-models.json   # or redirect the byte-exact JSON
```
:::

El bloque exportado es una instantánea estática. Vuelve a ejecutar `ocx export` después de añadir un proveedor o cambiar la visibilidad de modelos y combina el bloque nuevo con el anterior.

<a id="the-admission-key"></a>

## La clave de acceso

El `apiKey` exportado es el marcador no secreto `opencodex-loopback`. No se genera ni se requiere una variable `OPENCODEX_API_KEY`. El exportador solo admite un proxy local de loopback sin autenticación y rechaza servidores remotos o protegidos con token. Las credenciales de los proveedores permanecen en la configuración de opencodex, como explica [Proveedores](/es/guides/providers/); nunca pongas una clave del proveedor de origen en este bloque de Pi. Para acceso remoto, usa una integración que admita credenciales de acceso al proxy. Cambiar el marcador no habilita la exportación remota de Pi.

<a id="model-metadata"></a>

## Metadatos de modelos

`contextWindow` y `maxTokens` solo se incluyen cuando el catálogo informa una ventana de contexto confirmada. Si no hay una, se omiten ambos y Pi aplica sus valores predeterminados; `ocx export` indica cuántas entradas están en ese caso.

Los límites de salida usan el máximo conocido del modelo en el catálogo o los metadatos generados. Solo si ese límite se desconoce se usa `32000`. La salida siempre se limita a la ventana de contexto, incluso cuando los límites conocidos son inferiores a `32000`.

El campo `cost` se omite porque requiere cuatro precios y opencodex no tiene esos datos para los modelos enrutados; emitir ceros afirmaría que todos son gratuitos.

`reasoning`, que antes se omitía, ahora se deriva de los niveles de esfuerzo del catálogo. Pi guarda un booleano: una lista **no vacía** genera `"reasoning": true`; sin lista, o con una explícitamente vacía, no se anuncia razonamiento. Así Pi ofrece el control solo para modelos cuyo catálogo declara que aceptan parámetros de razonamiento (`reasoning_effort`). La exportación también genera `thinkingLevelMap`, que oculta con `null` los niveles de Pi sin un destino declarado, para que no se ofrezca ni envíe un esfuerzo ajeno a la lista. Si se declara `ultra` sin `max`, el nivel `max` de Pi se asigna a `ultra`, que sí pertenece a la lista. Si necesitas otra asignación, edita `thinkingLevelMap` según la documentación de Pi.

Trata `reasoning` como un metadato de interfaz de Pi, no como prueba de compatibilidad nativa del proveedor. Lo que el proxy envía para un valor `reasoning_effort` depende del adaptador y el modelo: puede reenviarlo, convertirlo a otro nombre del protocolo, limitarlo a los niveles configurados, emularlo u omitirlo (por ejemplo, con `noReasoningModels`). El booleano solo decide si Pi ofrece el control.

<a id="attachment-and-request-compatibility"></a>

## Compatibilidad de adjuntos y solicitudes

:::note[Comportamiento pendiente de publicación]
Los cambios de paridad de proveedores descritos aquí están en la cadena de PR de desarrollo; una versión instalada anterior puede conservar la conversión previa.
:::

OpenCodex normaliza las imágenes de usuario con formato Pi/MCP o Anthropic antes de elegir una ruta Chat nativa o traducida. Las imágenes devueltas por herramientas pasan a un mensaje de usuario traducido después de los resultados de herramientas emparejados; las imágenes normales de usuario y los resultados de texto pueden conservar la ruta nativa. Usa `tool_calls` y `role: "tool"` con `tool_call_id`: se rechaza la traducción de imágenes en resultados antiguos `function`, en lugar de descartar el resultado silenciosamente.

Un esfuerzo explícito `none` se conserva al convertir a Chat. Los límites de salida y controles de muestreo se conservan para destinos Responses genéricos con clave API; el destino canónico de ChatGPT sigue aplicando sus restricciones. Esto no hace equivalentes los controles de todos los proveedores.

El audio WAV/MP3 incluido en un mensaje de usuario o resultado de herramienta se conserva al convertir a OpenAI Chat como contenido `input_audio`. El audio de herramientas pasa a un mensaje de usuario posterior a los resultados emparejados, porque los mensajes de herramienta de Chat solo admiten texto. Un documento con sus propios bytes base64 en un mensaje de usuario también se conserva: llega a Anthropic, OpenAI Chat y Google como documento nativo, parte de archivo y datos en línea, respectivamente. Los demás casos devuelven un error explícito: audio remoto o incompatible, referencias remotas o identificadores de archivo que el proxy no pueda resolver, adjuntos en mensajes de sistema, documentos en resultados de herramientas y documentos enviados a un protocolo sin soporte para bytes. Las imágenes con solo identificador de archivo tienen la misma limitación. Convierte el adjunto a texto o usa un protocolo nativo y un modelo que lo admitan. Chat nativo y Responses sin conversión (incluido Azure) conservan su comportamiento; esto no promete compatibilidad multimedia de todos los modelos. Los límites de conversión de video dependen del adaptador.

<a id="schema-status"></a>

## Estado del esquema

:::note[Sin verificar en una instalación real]
La estructura anterior sigue la documentación pública de proveedores personalizados de Pi. **No se ha verificado** con un archivo `~/.pi/agent/models.json` real de una instalación de Pi. Si Pi rechaza el bloque exportado, el error está de nuestro lado: [abre una issue](https://github.com/lidge-jun/opencodex/issues) con el mensaje que muestra Pi.
:::

<a id="requirements"></a>

## Requisitos

Un proxy opencodex en ejecución (`ocx start`) y Pi instalado. `ocx export` lee el catálogo activo mediante la API de administración del proxy, por lo que no genera una configuración con la lista de modelos vacía.
