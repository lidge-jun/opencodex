---
title: "Puente Factory Droid"
description: "Conecte los modelos Factory Droid a opencodex a través de un puente local compatible con Responses."
---

Factory Droid es un entorno de ejecución del agente, no un punto final de inferencia compatible con OpenAI documentado. Si un proveedor personalizado apunta a una URL interna de Factory LLM devuelve `403 Forbidden`, cambiar solo el adaptador opencodex o agregar encabezados de proveedor no convierte esa ruta privada en una API pública admitida.

La integración de trabajo es:

```text
Text-only Responses client
  -> opencodex (http://127.0.0.1:10100/v1/responses)
  -> local Responses bridge (http://127.0.0.1:11435/v1/responses)
  -> official droid exec command
  -> Factory account and selected model
```

Esto mantiene la credencial de fábrica dentro del cliente oficial Droid. OpenCodex recibe un token de puente separado, solo local.

<a id="what-failed-and-why"></a>

## Qué falló y por qué

| Síntoma | Causa | Arreglar |
| --- | --- | --- |
| `403 Forbidden` desde una URL de fábrica LLM | La URL no es un punto final OpenAI de propósito general documentado para clientes de terceros. | Invoque la fábrica a través de los oficiales Droid CLI o SDK |
| `404` en `/models/models` | La URL base del proveedor ya terminó en `/models` | Utilice una raíz API como `baseUrl`; nunca incluya la ruta de descubrimiento |
| La búsqueda de modelos falla | El puente no expone un catálogo completo en vivo | Establecer `liveModels: false` y proporcionar una lista estática `models` |
| El proveedor de Loopback es rechazado | El acceso a la red privada se deniega de forma predeterminada | Establecer `allowPrivateNetwork: true` solo para el puente de bucle |
| `${DROID_BRIDGE_TOKEN}` no está resuelto | La variable falta en el entorno de servicio opencodex | Inyéctelo en el proceso de servicio, no solo un shell interactivo |
| `OutputTextDelta without active item` | El puente emitió un delta de texto antes de abrir un elemento de salida y una parte de contenido. | Emitir el ciclo de vida completo Responses SSE en orden |

Por lo tanto, la misma credencial de Factory puede funcionar en `droid exec`, mientras que una solicitud directa a una URL LLM indocumentada aún devuelve `403`. Estos resultados prueban diferentes productos y no deben ser tratados como contradictorios.

<a id="prerequisites"></a>

## Requisitos previos

1. Instale e inicie sesión en el [Droid CLI](https://docs.factory.ai/droid-cli/quickstart).
2. Confirme que una solicitud sin cabeza limitada funciona:

   ```bash
   droid exec --model glm-5.2 --output-format json "Reply with DROID_OK only."
   ```

3. Ejecute un puente local que invoque `droid exec` (o el oficial Droid SDK) y exponga:

   - `GET /healthz`
   - `GET /v1/models`
   - `POST /v1/responses`

Factory documenta `droid exec` como su superficie de automatización no interactiva y recomienda la salida JSON para scripts. Para una integración más duradera, Factory también documenta el stream JSON -RPC y los SDK oficiales de TypeScript y Python en el [Droid Guía ejecutiva](https://docs.factory.ai/droid-exec/overview).

<a id="bridge-contract"></a>

## Contrato de puente

Antes de aceptar entradas, el puente debe escuchar únicamente en `127.0.0.1`, exigir un token bearer aleatorio, limitar el tamaño de las solicitudes y permitir solo los identificadores de modelo de una lista explícita. El puente mínimo acepta únicamente estas formas de `input` de Responses:

- Una cadena no vacía; o
- Una matriz formada exclusivamente por elementos `message`. Cada mensaje debe usar el rol `user`, `developer`, `system` o `assistant` y contener una cadena o partes solo de texto: `input_text` para los roles de entrada y `output_text` para el historial del asistente.

Valida toda la solicitud antes de invocar Droid. Si una parte de entrada es una imagen o un archivo, `tools` contiene alguna definición de herramienta, o `input` incluye una llamada o resultado de herramienta (`function_call`, `function_call_output`, `custom_tool_call` o `custom_tool_call_output`), devuelve HTTP `400` con un `invalid_request_error` de formato Responses. Usa un código estable del puente, como `unsupported_bridge_input`, e identifica el campo rechazado. Rechaza la solicitud antes de iniciar SSE, incluso con `stream: true`; nunca descartes ni conviertas silenciosamente el contenido no compatible en texto del prompt.

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "unsupported_bridge_input",
    "param": "tools",
    "message": "The minimal Droid bridge does not accept tool definitions."
  }
}
```

Para una solicitud aceptada, el puente debe:

1. Convierta el Responses `input` aceptado en un mensaje.
2. `droid exec --model <id> --output-format json <prompt>`.
3. analizar los `result` y `session_id` finales;
4. devolver un sobre OpenAI Responses; y
5. mapear `previous_response_id` al ID de sesión Droid cuando se requiere continuación.

Para las respuestas de transmisión, emita este ciclo de vida en orden:

```text
response.created
response.output_item.added
response.content_part.added
response.output_text.delta
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
```

No exponga el puente en `0.0.0.0` y no reutilice la credencial de fábrica como el token de portador de puente.

<a id="opencodex-provider-configuration"></a>

## Configuración del proveedor OpenCodex

Cree el proveedor personalizado con el ID de proveedor explícito `droid`:

```bash
ocx provider add droid \
  --adapter openai-responses \
  --base-url http://127.0.0.1:11435/v1 \
  --default-model glm-5.2 \
  --allow-private-network
```

Esto crea la entrada de configuración `providers.droid`. En el panel de control, abra **Proveedores → droid → Editar JSON** y reemplace el valor de ese proveedor con:

```json
{
  "adapter": "openai-responses",
  "baseUrl": "http://127.0.0.1:11435/v1",
  "responsesPath": "/responses",
  "allowPrivateNetwork": true,
  "authMode": "key",
  "apiKey": "${DROID_BRIDGE_TOKEN}",
  "liveModels": false,
  "models": ["glm-5.2", "glm-5.2-fast", "kimi-k3"],
  "defaultModel": "glm-5.2"
}
```

Los ID de modelo son ejemplos. Mantenga solo los modelos que `droid exec` puede usar para la cuenta de Factory iniciada. No agregue cabeceras de inferencia específicas de Factory a este proveedor: su origen es el puente local, no un punto final de Factory HTTP.

Después de guardar un proveedor o cambiar su catálogo estático, sincronice y reinicie Codex para que las nuevas sesiones lean el catálogo actualizado:

```bash
ocx sync --restart-codex
ocx doctor
```

`--restart-codex` reinicia los servidores de aplicaciones y cierra y vuelve a lanzar completamente la aplicación de escritorio Codex, que finaliza las conversaciones en vivo. Use `--restart-app-server-only` para dejar la aplicación de escritorio en ejecución. Ejecute el reinicio solo después de terminar o guardar esas sesiones.

<a id="verify-the-complete-route"></a>

## Verificar la ruta completa

Compruebe cada límite por separado:

```bash
curl -fsS http://127.0.0.1:11435/healthz
ocx doctor
ocx access test droid/glm-5.2 --protocol responses
```

Una fila de proveedores o una entrada de selector de modelos solo prueban la visibilidad del catálogo. La integración solo funciona después de que la sonda Responses regrese a través de la ruta `droid/<model>`.

<a id="current-limitation"></a>

## Limitación actual

El puente mínimo de arriba traduce el texto y el ciclo de vida Responses SSE. Hace **no** implementa el protocolo de llamada de herramienta/función Codex bidireccional completo. Codex App y `codex exec` normalmente envían definiciones de herramientas incluso cuando un mensaje indica que no se deben llamar a las herramientas, y el Codex CLI actual no tiene ninguna bandera general que elimine esas definiciones. El puente mínimo debe rechazar esas solicitudes con el contrato `400` anterior. Las definiciones de herramientas, las llamadas de herramientas, los resultados de herramientas, los permisos, la cancelación y los eventos ricos de Droid requieren un puente con estado construido en el modo de transmisión JSON -RPC de Factory o un Droid SDK oficial. Tratar el éxito de `ocx access test` como una verificación de ruta de texto, no como una verificación de agente o ruta de herramienta de Codex.
