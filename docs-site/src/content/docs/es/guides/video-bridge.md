---
title: "Puente de video"
description: "Genera videos con Grok Imagine Video desde un modelo distinto de OpenAI."
---

<a id="overview"></a>

## Descripción general

El puente de video permite generar videos con Grok Imagine Video de xAI desde cualquier modelo ajeno a OpenAI enrutado mediante opencodex. Al activarlo, se añade la herramienta sintética `video_gen` a la conversación. El modelo la llama como una función; opencodex intercepta la llamada, envía el trabajo a xAI, consulta su estado hasta que termina y descarga el resultado.

<a id="prerequisites"></a>

De forma predeterminada los trabajos van a xAI; `images.videoProvider` puede enviarlos a otro backend compatible.

## Requisitos previos

Estos requisitos se aplican al destino xAI predeterminado. Si defines `images.videoProvider`, consulta [Elegir el proveedor de video](#elegir-el-proveedor-de-video).

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
> Define `XAI_API_KEY` en el entorno de inicio del proxy, conserva la referencia `${XAI_API_KEY}` y selecciona explícitamente `authMode: "key"`. Exportarla en otra terminal no modifica un proxy activo: reinícialo mediante Desktop, su servicio o la terminal propietaria para que herede el valor. No pongas claves literales en commits, registros o informes compartidos.

<a id="configuration"></a>

## Configuración

Agregue `videoBridgeEnabled: true` a su configuración `images`:

```json
{
  "images": {
    "bridgeEnabled": true,
    "videoBridgeEnabled": true,
    "videoBridgeModel": "grok-imagine-video-1.5-lite",
    "videoMaxRounds": 2,
    "videoTimeoutMs": 300000
  }
}
```

| Opción | Predeterminado | Descripción |
|--------|---------|-------------|
| `videoBridgeEnabled` | `false` | Interruptor maestro. Debe estar explícitamente habilitado. |
| `videoBridgeModel` | `"grok-imagine-video-1.5-lite"` | Id. de modelo de vídeo xAI. |
| `videoMaxRounds` | `2` | Número máximo de rondas de generación de video antes de forzar la respuesta final. |
| `videoTimeoutMs` | `300000` (5 min) | Plazo máximo por video, incluidas las consultas de estado. |
| `videoProvider` | sin definir (xAI) | Proveedor opcional con clave de API que atiende `video_gen` con su propio `baseUrl` y clave. Consulta [Elegir el proveedor de video](#elegir-el-proveedor-de-video). |

<a id="how-it-works"></a>

## Elegir el proveedor de video

De forma predeterminada, el puente envía los trabajos de `video_gen` a xAI con la clave de API del proveedor `xai`. Define `images.videoProvider` para enviarlos a otro backend que implemente la misma API asíncrona (`POST {baseUrl}/videos/generations` y luego `GET {baseUrl}/videos/{id}`), como un puente multimedia autoalojado:

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
    "videoBridgeModel": "grok-imagine-video-1.5-lite"
  }
}
```

- Solo se usan como destino y credencial el `baseUrl` y la clave de API del proveedor indicado. El adaptador no importa, pero debe usar autenticación por clave de API.
- `"videoProvider": "xai"` mantiene el endpoint fijo `https://api.x.ai/v1`, sea cual sea el `baseUrl` de la fila `xai`. Los demás identificadores de proveedores integrados se rechazan; indica un proveedor personalizado.
- Un destino de loopback o de red privada necesita `allowPrivateNetwork: true` en ese proveedor, igual que el resto del tráfico de proveedores. La comprobación se hace sobre las direcciones a las que resuelve el nombre de host cuando se conecta cada solicitud de envío o de sondeo, así que un nombre de host que resuelve a una dirección local se rechaza sin ese ajuste. `http` sin cifrar solo funciona con `localhost` o con una dirección IP de loopback o privada y ese ajuste; cualquier otro destino debe usar `https`. Las solicitudes siguen los ajustes `proxy` y `noProxy` del propio proveedor. Cuando un proxy del proveedor o un proxy global transporta la solicitud, es el proxy quien resuelve el nombre de host y se conecta, así que la comprobación de direcciones anterior solo cubre la respuesta DNS local y no puede fijar el destino que elige el proxy: enruta un proveedor por un proxy solo si confías en que el DNS y la ruta de red de ese proxy mantienen inaccesibles los destinos privados. Si el DNS local no puede resolver el nombre de host mientras se aplica un proxy, la solicitud sigue pasando por ese proxy sin ninguna respuesta local que comprobar, y OpenCodex registra una advertencia. Cuando se aplica un proxy, se rechazan tanto una solicitud `http` sin cifrar como un nombre de host cuya respuesta DNS local es una dirección privada, incluso con `allowPrivateNetwork`; ese proveedor de vídeo local necesita una ruta directa. Excluye su host con el `noProxy` del proveedor (para un `proxy` del proveedor) o con `NO_PROXY` (para un proxy global).
- Una clave que OpenCodex puede reconocer como de xAI (una clave `xai-`, una clave de cualquier fila `xai` o una referencia de entorno con nombre de xAI o Grok) solo se envía a `https://api.x.ai` o `https://cli-chat-proxy.grok.com`; cualquier otro origen se rechaza. Una clave sin esas marcas no se puede reconocer, así que no pegues tu clave de xAI en la fila de otro proveedor. Una referencia de llavero al secreto de otro proveedor siempre se rechaza, una clave activa en pausa falla de forma cerrada y el `baseUrl` no puede llevar credenciales, consulta ni fragmento.
- Si el proveedor no existe, está deshabilitado, en pausa, sin clave o rechazado, cada llamada a `video_gen` devuelve ese error al modelo. No se envía nada y el puente nunca recurre a xAI.
- Con el protocolo de xAI, el video terminado solo se descarga desde una URL `data:` en base64 o una URL `https:` pública, así que un puente local debe devolver una de ellas como `video.url`. Un backend que sirve el archivo desde su propio host usa en su lugar el protocolo de OpenAI descrito abajo.

### Backends con la API de OpenAI Videos

Define `"videoApi": "openai"` en el proveedor cuando su backend implementa la forma de la API de OpenAI Videos (`POST {baseUrl}/videos`, luego `GET {baseUrl}/videos/{id}` hasta `completed` y después el MP4 desde `GET {baseUrl}/videos/{id}/content`), como hacen LiteLLM y varios adaptadores autoalojados de Gemini o AI Studio. OpenAI cerró su propia API de Videos el 24 de septiembre de 2026, así que este valor se refiere a backends de terceros, no a `api.openai.com`.

```json
{
  "providers": {
    "aistudio": {
      "adapter": "openai-chat",
      "baseUrl": "http://127.0.0.1:2048/v1",
      "apiKey": "${AISTUDIO_KEY}",
      "authMode": "key",
      "allowPrivateNetwork": true,
      "videoApi": "openai"
    }
  },
  "images": {
    "videoBridgeEnabled": true,
    "videoProvider": "aistudio",
    "videoBridgeModel": "gemini-omni-1.1-flash"
  }
}
```

- `duration` se envía como `seconds`, `resolution` y `aspect_ratio` como `size` (720p en 16:9 es `1280x720`) y una `image` de primer fotograma como `input_reference.image_url`. `last_frame`, `keyframes` y `reference_images` no tienen campo en OpenAI y se rechazan antes de cualquier solicitud.
- El envío, el sondeo y la descarga del contenido van al mismo proveedor con la misma clave, bajo las mismas reglas de direcciones, `allowPrivateNetwork`, texto sin cifrar, proxy y redirección indicadas arriba. Una redirección desde `/content` se rechaza en lugar de seguirse, y la descarga mantiene el límite de 200 MiB para video.
- Indica el modelo del backend en `videoBridgeModel`. Los modelos que OpenCodex no conoce mantienen los límites genéricos: 480p o 720p, siete relaciones de aspecto y ninguna imagen de entrada.

## Punto final público `/v1/videos`

Los clientes que hablan la API de OpenAI Videos pueden apuntar a OpenCodex. Se atienden tres rutas:

| Ruta | Uso |
|------|-----|
| `POST /v1/videos` | Crea un trabajo. JSON, o multipart con un archivo `input_reference` PNG/JPEG/WebP (se envía como URL de datos). |
| `GET /v1/videos/{id}` | Estado del trabajo. |
| `GET /v1/videos/{id}/content` | El archivo generado; `variant` puede ser `video`, `thumbnail` o `spritesheet`. |

`model` elige el backend: `"aistudio/gemini-omni-1.1-flash"` envía `gemini-omni-1.1-flash` al proveedor `aistudio`, y un modelo sin prefijo de proveedor va a `images.videoProvider`. Solo un proveedor con `"videoApi": "openai"` atiende estas rutas; cualquier otro, y todos los rechazos indicados arriba, devuelven un error y no envían nada. El `id` de cada respuesta es un identificador de OpenCodex: las consultas de estado y de contenido vuelven al proveedor que creó el trabajo, y un identificador solo funciona con la misma clave de API de OpenCodex (o la misma admisión de loopback o de entorno) que lo creó. Las demás claves reciben `404`. Los identificadores se firman con una clave guardada como `video-handle-key` en el directorio de OpenCodex, así que sobreviven a un reinicio.

Las rutas aplican las mismas comprobaciones de autenticación y origen que `/v1/images/generations`, una clave con alcance queda limitada a sus proveedores y modelos en las tres, y cada llamada se registra en `usage.jsonl`. No se atienden las rutas de listado, borrado, remezcla, edición ni extensión.

## Cómo funciona

1. opencodex detecta un modelo enrutado no OpenAI con `videoBridgeEnabled: true`
2. Una herramienta de función sintética `video_gen` se inyecta en la conversación
3. Cuando el modelo llama al `video_gen`, opencodex envía un trabajo al endpoint `/videos/generations` de xAI (o al `images.videoProvider` configurado)
4. El puente sondea el estado del trabajo cada 5-15 segundos, enviando mensajes de latido para mantener viva la transmisión
5. Cuando el video está listo, se descarga en el directorio de artefactos
6. La ruta local del archivo se devuelve al modelo como resultado de la herramienta

<a id="supported-parameters"></a>

## Parámetros soportados

La herramienta `video_gen` acepta:

| Parámetro | Tipo | Alcance | Descripción |
|-----------|------|-------|-------------|
| `prompt` | string | opcional con una imagen o fotograma | Indicación de texto |
| `duration` | entero | 1-15 | Duración del vídeo en segundos |
| `resolution` | string | `480p`, `720p`, `1080p` | Depende del modelo; máximo 720p con `last_frame`, `keyframes` o `reference_images` |
| `aspect_ratio` | string | depende del modelo | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3`, `21:9`, `5:2`; se rechaza si solo se anima una `image`, que conserva su proporción |
| `image` | string | primer fotograma | URL HTTPS, URL de datos o artefacto recordado |
| `last_frame` | string | solo 1.5 | Último fotograma |
| `keyframes` | array | 1.5, máximo 4 | `{image, timestamp_s}`; marca de tiempo estrictamente dentro del clip (8 s si se omite `duration`) |
| `reference_images` | array | 1.5: 14, clásico: 7 (≤ 10 s) | Referencias de imagen; el modelo clásico no puede combinarlas con `image` |

Los ajustes que un modelo no puede respetar se rechazan antes de cualquier llamada de pago en lugar de descartarse.

### Modelos e imágenes de entrada

| Modelo | Resolución | Entradas | por segundo (480p / 720p / 1080p) |
|-------|------------|--------|------------------|
| `grok-imagine-video-1.5` | 480p / 720p / 1080p nativo | primer/último fotograma, 4 fotogramas clave, 14 referencias (720p máximo) | $0.08 / $0.14 / $0.25 |
| `grok-imagine-video-1.5-lite` (predeterminado) | 480p / 720p / 1080p reescalado | primer fotograma | $0.02 / $0.03 / $0.14 |
| `grok-imagine-video` | 480p / 720p | primer fotograma, 7 referencias | $0.05 / $0.07 / — |

Configura `images.videoBridgeModel` como `grok-imagine-video-1.5` para fijar fotogramas o usar referencias. Los modelos conocidos admiten nueve relaciones de aspecto; los desconocidos conservan siete, 480p/720p y ninguna imagen. Se aceptan URL HTTPS y datos PNG/JPEG/WebP de hasta 10 MiB decodificados. Las imágenes descargadas por el puente pueden referenciarse mediante URL de artefacto, ruta absoluta o URL `file:` durante una hora: se usa la URL de origen recordada y nunca se lee el archivo local. Solo funciona con el destino xAI fijado, no con un `images.videoProvider` personalizado. Los resultados en línea no tienen URL de origen y la URL temporal puede caducar antes.


<a id="limitations"></a>

## Limitaciones

- **xAI de forma predeterminada**: sin `videoProvider`, la generación de video usa la API Grok Imagine Video de xAI; otro backend debe implementar la misma API asíncrona, o la API de OpenAI Videos con `videoApi: "openai"`
- **Asíncrono**: La generación de video toma 30-120 segundos
- **Coste**: la generación de video es una función de pago de xAI. Consulta las [tarifas oficiales](https://docs.x.ai/developers/pricing) antes de usarla.
- **Un video por llamada**: Cada llamada `video_gen` produce un vídeo
- **Coexiste con Image Bridge**: Ambos puentes se pueden habilitar simultáneamente
- **Prioridad de búsqueda web**: Cuando un sidecar de búsqueda web está activo durante un giro (no adaptador `runTurn`), el puente de vídeo se salta - los dos no pueden funcionar simultáneamente. Se emite un `console.warn` para que pueda detectarlo en registros.
- **Plazo compartido entre el envío y las consultas**: `videoTimeoutMs` empieza antes de enviar el trabajo. La solicitud de envío (60 s) y las consultas posteriores comparten el mismo plazo máximo.
