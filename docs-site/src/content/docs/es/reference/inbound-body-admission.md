---
title: "Admisión de cuerpos de solicitudes entrantes"
description: "Cómo los límites elevados del cuerpo afectan a la concurrencia HTTP, los reintentos y la contabilización de memoria."
---

La [referencia de configuración de proveedores](/es/reference/configuration/providers/) describe `maxInboundBodyBytes`, el tamaño máximo decodificado de un cuerpo JSON entrante. Su valor predeterminado sigue siendo 256 MiB y el intervalo configurable va de 1 MiB a 512 MiB. Reinicia el proxy después de cambiarlo para que el servidor HTTP y los lectores apliquen el mismo límite.

<a id="raising-the-limit-changes-concurrency"></a>

## Aumentar el límite cambia la concurrencia

Cuando el límite efectivo supera 256 MiB, cada solicitud HTTP cubierta reserva toda su capacidad configurada de un presupuesto de admisión de 512 MiB compartido por el proceso. Por tanto, solo puede ejecutarse una de esas solicitudes a la vez, incluso si varios servidores HTTP comparten el proceso. Los cuerpos pequeños también reservan la capacidad completa: ni un `Content-Length` pequeño ni la compresión evitan la admisión. La reserva se conserva hasta que la respuesta termina, falla o finaliza su cancelación; no se libera al terminar de analizar el JSON de entrada. Si el cliente se desconecta, se libera después de completar la cancelación del productor. Los límites superiores a 256 MiB admiten una sola solicitud cubierta a la vez, independientemente de `appOwnedMemoryBudgetMb`.

Los destinos POST cubiertos son `/v1/responses`, `/v1/responses/compact`, `/v1/chat/completions`, `/v1/messages`, `/v1/messages/count_tokens`, `/v1/images/generations`, `/v1/images/edits` y `/v1/alpha/search`. Las imágenes, la búsqueda y el recuento de tokens conservan sus límites configurables por cuerpo. Las llamadas internas de traducción directa y de Combos no reservan una segunda capacidad HTTP. No cambian los límites de administración, audio, historial de contexto ni WebSocket.

Una opción omitida o con valor cero, o un límite efectivo de 256 MiB o menos, no activa este control adicional de concurrencia. Siguen aplicándose los límites existentes de cantidad de solicitudes y otros recursos.

<a id="temporary-refusal-versus-an-oversized-body"></a>

## Rechazo temporal y cuerpo demasiado grande

Si la capacidad está temporalmente ocupada, se devuelve HTTP **503**, `Retry-After: 1` y el código `server_busy` antes de analizar el protocolo o enviar la solicitud al proveedor. Los clientes de Messages y de recuento de tokens reciben un error con formato de Anthropic y tipo `overloaded_error`; los clientes compatibles con OpenAI reciben `server_error`. Reintenta cuando termine la solicitud actual, respetando el encabezado de reintento y la espera progresiva del cliente. Aumentar aún más el límite del cuerpo no libera una capacidad ocupada.

Un cuerpo que supere su límite por solicitud sigue recibiendo el tratamiento HTTP **413** existente. Si el tamaño declarado ya excede el límite, se mantiene esa respuesta en lugar del rechazo por capacidad ocupada. Las comprobaciones de autenticación y origen se ejecutan antes de este control de concurrencia.

<a id="what-the-budget-measures"></a>

## Qué mide el presupuesto

Los 512 MiB representan la suma de capacidades admitidas por solicitud; **no garantizan que la memoria del proceso se mantenga por debajo de 512 MiB**. La decodificación, las cadenas, los objetos, las copias de solicitudes y otros estados de la aplicación consumen memoria adicional. Se conservan las mediciones existentes de UTF-8 y del JSON vuelto a serializar; no se sustituye el tamaño del JSON normalizado, que puede ser mayor, por la cantidad de bytes de entrada.

Para ejecutar solicitudes pequeñas en paralelo, conserva el límite predeterminado siempre que sea posible. Auméntalo de forma deliberada para un flujo con mucho historial, aceptando la restricción adicional de concurrencia.
