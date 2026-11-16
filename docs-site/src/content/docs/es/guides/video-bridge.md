---
title: "Puente de video"
description: "Genera videos con Grok Imagine Video desde un modelo distinto de OpenAI."
---

<a id="overview"></a>

## Descripción general

El puente de video permite generar videos con Grok Imagine Video de xAI desde cualquier modelo ajeno a OpenAI enrutado mediante opencodex. Al activarlo, se añade la herramienta sintética `video_gen` a la conversación. El modelo la llama como una función; opencodex intercepta la llamada, envía el trabajo a xAI (o al proveedor indicado por images.videoProvider), consulta su estado hasta que termina y descarga el resultado.

<a id="prerequisites"></a>

## Requisitos previos

- Un proveedor `xai` con una **clave API**: `ocx login xai` por sí solo no basta; el puente requiere autenticación con clave, salvo que `images.videoProvider` indique otro proveedor con autenticación por clave, que proporciona tanto el destino como la credencial.
- Un modelo de otro proveedor, como Anthropic Claude o Google Gemini.
- opencodex configurado para enrutar mediante ese proveedor.

> **⚠ Se requiere una clave del proveedor:** Sin definir `videoProvider`, el puente solo se activa cuando `xai` utiliza autenticación con clave API. Añada esta referencia a su configuración:
>
> ```json
> {
>   "providers": {
>     "xai": { "adapter": "openai-chat", "apiKey": "${XAI_API_KEY}", "authMode": "key" }
>   }
> }
> ```
>
> Define `XAI_API_KEY` en el entorno de inicio del proxy, conserva la referencia `${XAI_API_KEY}` y selecciona explícitamente `authMode: "key"`. Exportarla en otra terminal no modifica un proxy activo: reinícialo mediante Desktop, su servicio o la terminal propietaria para que herede el valor. No pongas claves literales en commits, registros o informes compartidos.

> **⚠ Elegibilidad del proveedor:** Una clave por sí sola no basta: el proveedor indicado debe ser elegible (configurado, autenticación por clave, `baseUrl` http(s) absoluta) y no ser un id de registro reservado como `xai`. Si no es elegible, el puente permanece desactivado y no recurre a xAI. Las reglas completas están en [Proveedor de vídeo personalizado](#custom-video-provider).

<a id="configuration"></a>

## Configuración

Agregue `videoBridgeEnabled: true` a su configuración `images`:

```json
{
  "images": {
    "bridgeEnabled": true,
    "videoBridgeEnabled": true,
    "videoBridgeModel": "grok-imagine-video",
    "videoMaxRounds": 2,
    "videoTimeoutMs": 300000
  }
}
```

| Opción | Predeterminado | Descripción |
|--------|---------|-------------|
| `videoBridgeEnabled` | `false` | Interruptor maestro. Debe estar explícitamente habilitado. |
| `videoBridgeModel` | `"grok-imagine-video"` | Id. de modelo de vídeo xAI. |
| `videoMaxRounds` | `2` | Número máximo de rondas de generación de video antes de forzar la respuesta final. |
| `videoTimeoutMs` | `300000` (5 min) | Plazo máximo por video, incluidas las consultas de estado. |
| `videoProvider` | *(sin definir)* | Destino personalizado del puente de vídeo (#8175). Nombra un proveedor configurado; solo se usan su propio `baseUrl` y su clave API. |

<a id="custom-video-provider"></a>

### Proveedor de vídeo personalizado

Por defecto, el puente de vídeo se comunica con el endpoint fijado de xAI. Defina `images.videoProvider` con el nombre de un proveedor configurado para enrutar el envío y las consultas de `video_gen` a otro destino, por ejemplo un puente autoalojado o cualquier proveedor que exponga una API de vídeo asíncrona compatible con xAI (mismo contrato: `POST {baseUrl}/videos/generations`, consulta `GET {baseUrl}/videos/{id}`):

```json
{
  "providers": {
    "my-video-bridge": {
      "adapter": "openai-chat",
      "baseUrl": "http://127.0.0.1:8790/v1",
      "apiKey": "${VIDEO_BRIDGE_KEY}",
      "authMode": "key",
      "allowPrivateNetwork": true
    }
  },
  "images": {
    "videoBridgeEnabled": true,
    "videoProvider": "my-video-bridge",
    "videoBridgeModel": "grok-imagine-video"
  }
}
```

El `baseUrl` y la clave API del proveedor indicado son el único destino y la única credencial utilizados: se falla de forma cerrada, nunca se recurre a xAI y ninguna clave de xAI se envía a otro host. El puente permanece **silenciosamente desarmado** en cada uno de estos casos:

- el proveedor indicado no existe, está deshabilitado o no tiene una clave API utilizable
- el proveedor indicado usa OAuth o autenticación forward: la clave bearer estática que envía el cliente de vídeo hace que esos modos se rechacen en lugar de degradarse
- el `baseUrl` del proveedor indicado no es una URL http(s) absoluta
- `videoProvider` está presente pero no es un nombre de proveedor (`42`, `true`, `null`) o nombra el id de registro reservado `xai`: una entrada integrada del registro nunca se adopta como destino del puente, así que la anulación de `baseUrl` de una entrada `xai` jamás puede llevar la clave de xAI a otro host

Un `videoProvider` vacío (`""` o solo espacios) se trata como no definido y conserva el valor fijado de xAI por defecto. `allowPrivateNetwork: true` es necesario para destinos de bucle local o privados, exactamente igual que para el `baseUrl` de cualquier proveedor.

> **La entrega sigue requiriendo una URL accesible.** El envío y las consultas pueden tener éxito contra un destino personalizado, pero el vídeo terminado solo se descarga en el directorio de artefactos cuando `video.url` es una URL HTTPS pública o una URL `data:` en línea. Un puente cuyo `video.url` apunta a `http://127.0.0.1/...` (o a cualquier dirección no pública) generará el vídeo y luego fallará en el paso de descarga: devuelva una URL alojada o una carga `data:` codificada en base64 (`data:video/mp4;base64,…`)

<a id="how-it-works"></a>

## Cómo funciona

1. opencodex detecta un modelo enrutado no OpenAI con `videoBridgeEnabled: true`
2. Una herramienta de función sintética `video_gen` se inyecta en la conversación
3. Cuando el modelo llama al `video_gen`, opencodex envía un trabajo al endpoint `/videos/generations`: en xAI por defecto, o en el proveedor indicado por `images.videoProvider`
4. El puente sondea el estado del trabajo cada 5-15 segundos, enviando mensajes de latido para mantener viva la transmisión
5. Cuando el video está listo, se descarga en el directorio de artefactos (la descarga requiere que `video.url` sea una URL HTTPS pública o una URL `data:` en base64)
6. La ruta local del archivo se devuelve al modelo como resultado de la herramienta

<a id="supported-parameters"></a>

## Parámetros soportados

La herramienta `video_gen` acepta:

| Parámetro | Tipo | Alcance | Descripción |
|-----------|------|-------|-------------|
| `prompt` | cadena | requerido | Indicación detallada de generación de vídeo |
| `duration` | entero | 1-15 | Duración del vídeo en segundos |
| `resolution` | cadena | `"480p"`, `"720p"` | Resolución de vídeo |
| `aspect_ratio` | cadena | 7 relaciones | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3` |

<a id="limitations"></a>

## Limitaciones

- **xAI solamente**: La generación de video está disponible por defecto mediante la API Grok Imagine Video de xAI; un proveedor personalizado puede indicarse mediante `images.videoProvider` (#8175)
- **Asíncrono**: La generación de video toma 30-120 segundos
- **Coste**: la generación de video es una función de pago de xAI. Consulta las [tarifas oficiales](https://docs.x.ai/developers/pricing) antes de usarla.
- **Un video por llamada**: Cada llamada `video_gen` produce un vídeo
- **Coexiste con Image Bridge**: Ambos puentes se pueden habilitar simultáneamente
- **Prioridad de búsqueda web**: Cuando un sidecar de búsqueda web está activo durante un giro (no adaptador `runTurn`), el puente de vídeo se salta - los dos no pueden funcionar simultáneamente. Se emite un `console.warn` para que pueda detectarlo en registros.
- **Plazo compartido entre el envío y las consultas**: `videoTimeoutMs` empieza antes de enviar el trabajo. La solicitud de envío (60 s) y las consultas posteriores comparten el mismo plazo máximo.
