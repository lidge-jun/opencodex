---
title: "Puente de imágenes"
description: "Enruta las llamadas a la herramienta alojada image_generation hacia xAI Grok Imagine al usar un proveedor distinto de OpenAI."
---

<a id="overview"></a>

## Descripción general

Cuando se enruta Codex a través de un modelo no OpenAI (Claude, Gemini, Grok, etc.), el `image_generation` **herramienta alojada** normalmente no funciona - se requiere OpenAI 's entorno de ejecución del lado del servidor. El puente de imágenes detecta estas llamadas y las redirige de forma transparente a xAI Grok Imagine, por lo que el modelo con el que estás chateando aún puede generar imágenes.

<a id="prerequisites"></a>

## Requisitos previos

- **Activa el puente** con `images.bridgeEnabled: true`. Está desactivado de forma predeterminada para evitar cargos inesperados de xAI; consulta [Configuración](#configuration).
- Añade un proveedor `xai` con una **clave API**. El puente Responses usa el destino de imágenes de xAI del registro (`https://api.x.ai/v1`) e ignora cualquier cambio de `baseUrl` para esas llamadas. OAuth o `ocx login xai` por sí solos **no activan este bucle sidecar**. La misma opción `bridgeEnabled` sí activa el relé independiente de `/v1/images`, que permite al cliente integrado `image_gen` usar Imagine con la autorización de Grok CLI. Consulta [Generación de imágenes integrada](/es/guides/codex-integration/#built-in-image-generation-image_gen). Si falta esa autorización o una clave API de xAI, `/v1/images` devuelve un error y no recurre a ChatGPT.

  El relé solo administra esa ruta si no se ha configurado un proveedor de imágenes: requiere `images.bridgeEnabled` en `true` y que se omita `images.provider`. Si estableces `images.provider` explícitamente, `/v1/images` usa ese proveedor y devuelve sus errores de validación sin volver a intentar mediante xAI.

  ```json
  {
    "providers": {
      "xai": { "adapter": "openai-chat", "apiKey": "xai-…", "authMode": "key" }
    }
  }
  ```

- Un modelo no OpenAI seleccionado como su proveedor activo. (Cuando el proveedor activo es OpenAI, la herramienta alojada nativa se usa directamente y el puente se pasa por alto.)

<a id="configuration"></a>

## Configuración

Las opciones de puente de imagen viven bajo `images` en `~/.opencodex/config.json`. Bridging es **opt-in** - debe configurar `bridgeEnabled: true` para habilitar la generación de imágenes pagada xAI Grok:

```json
{
  "images": {
    "bridgeEnabled": true,
    "bridgeModel": "grok-imagine-image-quality",
    "maxRounds": 3,
    "timeoutMs": 60000
  }
}
```

| Opción | Predeterminado | Descripción |
| --- | --- | --- |
| `bridgeEnabled` | `false` | Interruptor maestro. Establecer `true` para permitir el puente. Desactivado por defecto para evitar cargos inesperados de xAI. |
| `bridgeModel` | `grok-imagine-image-quality` | El identificador de modelo de imagen xAI para enviar mensajes. |
| `maxRounds` | `3` | Iteraciones máximas de bucle de generación de imágenes por turno. Fijado a un número entero y fijado a `[0, 10]`; los valores no finitos vuelven a `3`. |
| `timeoutMs` | `60000` | Fecha límite xAI por llamada en milisegundos. Los valores positivos finitos se minimizan y pasan a la solicitud xAI. |
| `artifactsKeepCount` | `200` | Número máximo de archivos retenidos bajo `artifacts/`. Cuando se excede, los archivos más antiguos se eliminan después de cada llamada completada. Establezca en `0` o un valor negativo para deshabilitar la poda. |

<a id="artifact-retention"></a>

## Retención de artefactos

Las imágenes generadas se escriben en `~/.opencodex/artifacts/`. Para evitar el crecimiento ilimitado del disco en sesiones de larga duración, el directorio se poda automáticamente después de cada llamada de imagen completada (una vez que el lote completo para esa llamada está en el disco): los archivos más antiguos (por tiempo de modificación) se eliminan cuando el recuento excede el máximo configurado (por defecto 200, configurable a través de `images.artifactsKeepCount`). Solo las rutas que sobreviven a la poda se devuelven al modelo.

<a id="how-it-works"></a>

## Cómo funciona

El puente de imágenes intercepta únicamente turnos **Responses** que incluyan la herramienta alojada `image_generation` en `tools` de `/v1/responses` al usar un modelo **de otro proveedor que no sea OpenAI**. La herramienta integrada `image_gen` de Codex sigue otra ruta: envía un POST directamente a `/v1/images/generations` o `/images/edits` y usa un relay integrado independiente, descrito en [Integración con Codex](/es/guides/codex-integration/#built-in-image-generation-image_gen).

1. OpenCodex detecta `image_generation` en `tools` durante el preprocesamiento de la solicitud Responses.
2. Sustituye la herramienta alojada por una **función sintética** que el modelo enrutado puede invocar, en lugar de una herramienta alojada que no puede ejecutar.
3. Cuando el modelo la invoca, OpenCodex intercepta la llamada y envía el prompt a la API de generación de imágenes de xAI.
4. Guarda las imágenes en `~/.opencodex/artifacts/` y devuelve al modelo la **ruta local del archivo** como resultado de la herramienta.
5. El modelo continúa la conversación con la información de la imagen generada y su ubicación.

Desde la perspectiva del modelo, nada cambió: llamó a una herramienta y obtuvo un resultado. Desde la perspectiva del usuario, la generación de imágenes funciona con cualquier proveedor enrutado en lugar de fallar silenciosamente.

<a id="limitations"></a>

## Limitaciones

- **Solo xAI Grok Imagine es compatible.** DALL-E y otros proveedores de imágenes se pueden agregar más tarde.
- **La búsqueda web tiene prioridad** cuando la solicitud es apta para el bucle de búsqueda web. Si se solicitan búsqueda y generación de imágenes en el mismo turno apto, se ejecuta la búsqueda y se omite la generación de imágenes. Esto incluye adaptadores `runTurn` aptos, como Cursor, mediante `runTurnWebSearchLoop`. El puente de imágenes solo puede atender esos turnos con ambas herramientas si la búsqueda web no resulta elegible.
- **Se aplican costos de xAI.** La generación de imágenes a través de xAI requiere una suscripción activa a xAI o créditos API.
- **Sólo streaming.** El puente funciona interceptando el flujo de respuesta SSE; las solicitudes con `stream: false` se rechazan con un error 400.
