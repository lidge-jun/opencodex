---
title: Clientes compatibles con Ollama
description: Conecta las herramientas que usan la API de Ollama a opencodex para utilizar tus modelos de proveedores configurados.
---

opencodex implementa una parte de la API HTTP de Ollama. Así, una herramienta que solo sabe comunicarse con Ollama puede usar los modelos que ya configuraste en opencodex. Las solicitudes se traducen a la ruta de Chat Completions y se envían al proveedor seleccionado. opencodex no descarga, almacena ni ejecuta modelos en tu equipo.

## Conectar un cliente

Usa la dirección del proxy como host de Ollama. En una instalación local predeterminada:

```bash
export OLLAMA_HOST=http://127.0.0.1:10100
curl "$OLLAMA_HOST/api/tags"
```

Si el proxy exige una clave API, por ejemplo al escuchar en `0.0.0.0`, envíala igual que para `/v1/chat/completions`, como `Authorization: Bearer <opencodex key>`. Una clave limitada a determinados modelos solo puede ver y usar los que tenga permitidos. Estos endpoints están disponibles únicamente en el listener principal; el listener auxiliar de loopback sin autenticación, Remote Link y la entrada de administración del Hub no los exponen.

## Endpoints

| Endpoint | Comportamiento |
| --- | --- |
| `GET /api/version` | Versión de opencodex. |
| `GET /api/tags` | Modelos de proveedores configurados, con nombres `provider/model`. |
| `POST /api/show` | `{ "model": "provider/model" }` devuelve solo información conocida, sin tamaño de archivo, digest, plantilla ni licencia. |
| `POST /api/chat` | Chat con mensajes `system`, `user`, `assistant` y `tool`. |
| `POST /api/generate` | Un prompt, con `system` opcional. |

Las demás rutas `/api/*` siguen formando parte de la API de administración de opencodex.

## Campos de solicitud admitidos

- `model`: un nombre de `/api/tags`.
- `stream`: `true` de forma predeterminada, con JSON delimitado por saltos de línea. Usa `false` para obtener una sola respuesta JSON.
- `images`: PNG, JPEG, GIF o WebP en base64, en los mensajes de usuario de chat o en la solicitud de generate.
- `tools`, solo en chat: herramientas de función. Devuelve el mensaje del asistente sin modificar, incluido el `id` de cada llamada. Un resultado `tool` se empareja por `tool_call_id` o, si no está disponible, por `tool_name`.
- `options`: `temperature`, `top_p`, `num_predict` y `stop`.
- `format`: únicamente `"json"`.

Cada solicitud `/api/chat` admite como máximo **1.024 llamadas a herramientas en total** entre todos los mensajes del asistente, incluidas las que ya tienen resultado. Superarlo devuelve HTTP 400 antes de contactar al proveedor. Reduce el historial y conserva cada resultado junto a su llamada correspondiente.

Cualquier otro campo se rechaza con HTTP 400 en vez de ignorarse. Esto incluye `think`, `keep_alive`, `suffix`, `raw`, `template`, `context`, las demás `options`, un `format` con esquema JSON y las URL de imágenes. No se ofrecen los endpoints de gestión de modelos ni de embeddings de Ollama.

No se pueden seleccionar combos, políticas de enrutamiento, alias `--fast` o de esfuerzo, ni proveedores que reenvíen las credenciales propias de quien hace la solicitud. Esas solicitudes fallan antes de enviar nada al proveedor.

## Respuestas

Una respuesta finalizada incluye `done: true` y `done_reason` con el valor `stop`, `tool_calls` o `length`. Los campos `prompt_eval_count` y `eval_count` aparecen cuando el proveedor informa del uso; no se incluyen campos de duración. Un flujo envía exactamente una línea `done: true`, después de que la respuesta del proveedor haya terminado por completo.

Los errores usan el formato de Ollama `{ "error": "message" }` y conservan el estado HTTP, incluido `Retry-After` ante límites de tasa o rechazos por ocupación. Una respuesta detenida por un filtro de contenido o por un motivo desconocido se devuelve como error, nunca como una finalización normal. Si un flujo falla después de iniciarse, termina con un objeto `error` y no añade una línea `done: true`.

Las solicitudes aparecen en el registro del dashboard como el resto del tráfico, y el encabezado de respuesta `x-opencodex-request-id` identifica la fila correspondiente.
