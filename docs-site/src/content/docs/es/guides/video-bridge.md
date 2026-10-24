---
title: "Puente de video"
description: "Generar vídeos con Grok Imagine Video a través de un modelo que no sea OpenAI."
---

<a id="overview"></a>

## Descripción general

El puente de video permite generar videos con Grok Imagine Video de xAI desde cualquier modelo ajeno a OpenAI enrutado mediante opencodex. Al activarlo, se añade la herramienta sintética `video_gen` a la conversación. El modelo la llama como una función; opencodex intercepta la llamada, envía el trabajo a xAI, consulta su estado hasta que termina y descarga el resultado.

<a id="prerequisites"></a>

## Requisitos previos

- Un proveedor `xai` con una **clave API**: `ocx login xai` por sí solo no basta; el puente requiere autenticación con clave.
- Un modelo de otro proveedor, como Anthropic Claude o Google Gemini.
- opencodex configurado para enrutar mediante ese proveedor.

> **⚠ Se requiere una clave del proveedor:** El puente solo se activa cuando `xai` utiliza autenticación con clave API. Añada esta referencia a su configuración:
>
> ```json
> {
>   "providers": {
>     "xai": { "adapter": "openai-chat", "apiKey": "${XAI_API_KEY}", "authMode": "key" }
>   }
> }
> ```
>
> Si configuró el proveedor con `ocx login xai` (OAuth), permanece en `authMode: "oauth"` y el puente no se activa. Para usarlo, establezca `XAI_API_KEY` en el entorno, conserve la referencia `${XAI_API_KEY}` del ejemplo y configure explícitamente `authMode: "key"`. Mantenga las claves literales fuera de commits, registros e informes compartidos.

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

<a id="how-it-works"></a>

## Cómo funciona

1. opencodex detecta un modelo enrutado no OpenAI con `videoBridgeEnabled: true`
2. Una herramienta de función sintética `video_gen` se inyecta en la conversación
3. Cuando el modelo llama al `video_gen`, opencodex envía un trabajo al endpoint `/videos/generations` de xAI
4. El puente sondea el estado del trabajo cada 5-15 segundos, enviando mensajes de latido para mantener viva la transmisión
5. Cuando el video está listo, se descarga en el directorio de artefactos
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

- **xAI solamente**: La generación de video solo está disponible mediante la API Grok Imagine Video de xAI
- **Asíncrono**: La generación de video toma 30-120 segundos
- **Coste**: la generación de video es una función de pago de xAI. Consulta las [tarifas oficiales](https://docs.x.ai/developers/pricing) antes de usarla.
- **Un video por llamada**: Cada llamada `video_gen` produce un vídeo
- **Coexiste con Image Bridge**: Ambos puentes se pueden habilitar simultáneamente
- **Prioridad de búsqueda web**: Cuando un sidecar de búsqueda web está activo durante un giro (no adaptador `runTurn`), el puente de vídeo se salta - los dos no pueden funcionar simultáneamente. Se emite un `console.warn` para que pueda detectarlo en registros.
- **Plazo compartido entre el envío y las consultas**: `videoTimeoutMs` empieza antes de enviar el trabajo. La solicitud de envío (60 s) y las consultas posteriores comparten el mismo plazo máximo.
