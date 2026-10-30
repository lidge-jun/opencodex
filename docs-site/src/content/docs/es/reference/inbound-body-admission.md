---
title: "Admisión de cuerpos de solicitudes entrantes"
description: "Cómo los límites elevados del cuerpo afectan a la concurrencia HTTP, los reintentos y la contabilización de memoria."
---

La [referencia de configuración de proveedores](/es/reference/configuration/providers/) describe `maxInboundBodyBytes`, el tamaño máximo decodificado de un cuerpo JSON entrante. Su valor predeterminado sigue siendo 256 MiB y el intervalo configurable va de 1 MiB a 512 MiB. Reinicia el proxy después de cambiarlo para que el servidor HTTP y los lectores apliquen el mismo límite.

Conservar el presupuesto compartido predeterminado de 512 MiB no elimina los compromisos de espera y duración de las respuestas descritos más abajo.

<a id="choose-the-shared-budget-explicitly"></a>

## Elegir explícitamente el presupuesto compartido

`maxConcurrentInboundBodyBytes` es una opción de nivel superior de `config.json`, en bytes. Su valor predeterminado es **512 MiB (`536870912`)**, igual al presupuesto anterior. Omitirla, usar `0` o un valor inválido conserva ese valor. Los enteros positivos válidos se limitan al intervalo **512 MiB–2 GiB (`536870912`–`2147483648`)** al utilizarlos. Reinicia el proxy después de cambiarla. Todos los listeners de un proceso comparten el presupuesto; es independiente de `appOwnedMemoryBudgetMb`.

Para elegir un límite de 512 MiB por solicitud y activar explícitamente un presupuesto compartido de 2 GiB, incorpora estos campos al nivel superior de `config.json` y reinicia:

```json
{
  "maxInboundBodyBytes": 536870912,
  "maxConcurrentInboundBodyBytes": 2147483648
}
```

Esta decisión del operador aumenta el pico potencial de memoria. El proxy no detecta automáticamente la RAM disponible ni elige un presupuesto en función de ella.

<a id="raising-the-limit-changes-concurrency"></a>

## Aumentar el límite cambia la concurrencia

Cuando el límite efectivo supera 256 MiB, cada solicitud HTTP cubierta debe reservar toda su capacidad por solicitud **antes de leer el cuerpo**. Las reservas comparten el presupuesto del proceso `maxConcurrentInboundBodyBytes`, cuyo valor predeterminado sigue siendo **512 MiB**.

Antes de terminar el análisis JSON acotado, un `Content-Length` pequeño o un cuerpo comprimido pequeño no reduce la reserva: ninguno demuestra el tamaño del JSON decodificado o normalizado.

Tras un análisis JSON acotado correcto, la reserva se reduce al mayor tamaño observado entre bytes de transporte, bytes decodificados y la medición existente de JSON normalizado cuando el traductor aporta un presupuesto para ella. La reserva solo disminuye, hasta la capacidad original; una medición normalizada mayor nunca la aumenta. La cantidad de bytes de entrada no sustituye al tamaño normalizado potencialmente mayor; se mantienen las comprobaciones de UTF-8 y JSON vuelto a serializar.

Con **512 MiB compartidos** y **512 MiB por solicitud**, solo **una carga sin analizar** puede reservar toda su capacidad. Aunque el análisis reduzca la reserva a **un byte**, queda menos de 512 MiB, por lo que la siguiente solicitud debe esperar. El valor predeterminado **no** resuelve el problema original de concurrencia con 512 MiB por solicitud.

Establecer explícitamente `maxConcurrentInboundBodyBytes` en `2147483648` elige **2 GiB** y admite hasta **cuatro cargas completas de 512 MiB** antes del análisis y las reducciones medidas. Después del análisis no es un límite fijo de cuatro solicitudes: por ejemplo, **ocho solicitudes pequeñas pueden transmitir simultáneamente** si sus reservas reducidas dejan espacio para nuevas admisiones, dentro del presupuesto y los demás límites.

La reserva reducida se mantiene durante el trabajo asíncrono y la espera del proveedor hasta el fin del flujo, un error o la cancelación completada. Analizar el cuerpo no la libera. Si el cliente se desconecta, se conserva hasta que termina la cancelación del productor. Se libera exactamente una vez, incluso si compiten errores, abortos y cancelaciones.

Los destinos POST cubiertos son `/v1/responses`, `/v1/responses/compact`, `/v1/chat/completions`, `/v1/messages`, `/v1/messages/count_tokens`, `/v1/images/generations`, `/v1/images/edits` y `/v1/alpha/search`. Las imágenes, la búsqueda y el recuento de tokens conservan sus límites configurables por cuerpo. Las llamadas internas de traducción directa y de Combos no reservan una segunda capacidad HTTP. No cambian los límites de administración, audio, historial de contexto ni WebSocket.

Este control adicional solo se activa cuando `maxInboundBodyBytes` efectivo supera 256 MiB. Omitir esa opción o usar `0` conserva los 256 MiB predeterminados y deja el control inactivo. Omitir o poner a cero `maxConcurrentInboundBodyBytes` elige los 512 MiB compartidos predeterminados; no desactiva un control que ya esté activo. Se mantienen los demás límites de solicitudes y recursos.

<a id="temporary-refusal-versus-an-oversized-body"></a>

## Rechazo temporal y cuerpo demasiado grande

Si no hay capacidad completa disponible, la solicitud puede entrar en una **cola FIFO de hasta 32 solicitudes**, con un **plazo de espera de 120 segundos**. La aplicación no lee los cuerpos en cola. La capacidad liberada por una reducción medida o una liberación final admite las solicitudes en orden FIFO. Si una solicitud en espera se aborta, se retira y se cancela su cuerpo sin consumirlo.

Una cola llena o una espera vencida produce HTTP **503**, `Retry-After: 1` y `server_busy`, antes de analizar el cuerpo o enviar la solicitud al proveedor. Los cuerpos sin leer se cancelan. Los clientes Messages y de recuento de tokens reciben el formato Anthropic con `overloaded_error`; los clientes OpenAI reciben `server_error`. Las comprobaciones de autenticación y origen preceden a la admisión y la cola.

Respeta el encabezado de reintento y la espera progresiva del cliente. La espera acotada y las reservas medidas reducen rechazos evitables, pero no eliminan todos los 503. Aumentar el límite por solicitud no resuelve el agotamiento sostenido.

Un cuerpo que supere su límite por solicitud sigue recibiendo HTTP **413**. Si el tamaño declarado excede el límite, se mantiene esa respuesta en lugar del rechazo por capacidad ocupada.

<a id="what-the-budget-measures"></a>

## Qué mide el presupuesto

El presupuesto contabiliza unidades de admisión: capacidades completas antes del análisis y reservas medidas después. **No preasigna 2 GiB** ni la cantidad configurada y **no limita la memoria RSS ni el heap de objetos analizados**. La decodificación, las cadenas, los objetos, las copias y otros estados consumen memoria adicional; el uso real puede superar el presupuesto.

Elegir 2 GiB en vez de 512 MiB permite cuatro veces la reserva total. Con 512 MiB por solicitud, admite hasta cuatro cargas completas antes del análisis en lugar de una y aumenta el pico potencial de memoria. Elige según el margen de memoria del despliegue. Un límite por solicitud de 256 MiB o menos deja inactivo este control adicional, independientemente del presupuesto compartido.

Conserva el límite por solicitud predeterminado siempre que sea posible. Auméntalo deliberadamente para flujos con mucho historial, considerando el mayor pico de memoria y la espera acotada.
