---
title: "Diagnósticos de reintentos de Codex"
description: "Distingue los avisos de límites de solicitudes, la repetición automática, la recuperación del proveedor y las notificaciones de escritorio."
---

OpenCodex [Adaptador Devin](/es/reference/adapters/#devin) conserva una pista de reintento utilizable en el contrato de error Codex entiende. Esto no garantiza que Desktop muestre una fila de reconexión o que el proveedor acepte la siguiente solicitud.

<a id="who-waits"></a>

## Quien espera

Con `OPENCODEX_DEVIN_STATED_RESET_WAIT_MS` sin configurar o `0`, el adaptador Devin no mantiene una solicitud rechazada para el enfriamiento indicado. Codex recibe el fallo final y posee su política de reintentos limitada. Un valor positivo opta por la espera existente de propiedad de proxy; retrasa la entrega del fallo final y puede combinarse con reintentos de clientes. Esta asignación de compatibilidad no cambia ese ajuste ni el recuento de reintentos de Codex. Una anulación de solo proceso no necesita sobrevivir al reinicio.

`rate_limit_exceeded` plus `Please try again in Ns.` es un consejo de reintento, no un evento de cuenta atrás. Codex 's propia política de reintento, cancelación y ciclo de vida todavía se aplican. No agregues elementos sintéticos de razonamiento, herramienta, asistente o éxito para hacer visible la espera: esos elementos pueden contaminar la historia o implicar que el trabajo sucedió. No acorte el retraso del proveedor ni provoque una solicitud adicional para avanzar en el contador de reintentos del cliente.

## Triage: `exceeded retry limit, last status: 429 Too Many Requests`

El mensaje es el resumen del presupuesto de reintento del cliente, no un diagnóstico. Una negativa que el cliente no retransmita puede terminar un turno en las mismas palabras que un presupuesto totalmente agotado, así que trate el texto como una pregunta. Tres casos se ven idénticos en esta capa y se comprueban de manera diferente.

| Comprobar | Evidencias distintivas | Si el cheque es positivo |
| --- | --- | --- |
| Cerradura de la cuenta principal (política de admisión local) | La configuración del panel de control o `GET /api/settings` informa el estado de la política, como `mainAccountHardLock.state` que es `blocked`, `ready` o `off`, con `thresholds` y un `resetAt` opcional. Una solicitud de no transmisión también puede llevar un cuerpo de política principal explícito en lugar de un desnudo aguas arriba 429. | Actualizar el uso con `ocx account refresh openai`; el nuevo uso por debajo de cada umbral de bloqueo o ausencia de ventana validada libera el bloqueo. Si permanece bloqueado, espere a que se reduzca el uso o apague explícitamente `codexMainAccountHardLock` en Configuración. Builds before [#6287](https://github.com/lidge-jun/opencodex/pull/6287) podría mantener un bloque obsoleto de ventana corta a través de reinicios cuando ninguna observación nueva lo reemplazó; la semántica de liberación se describe en el [nota de cierre de #6244](https://github.com/lidge-jun/opencodex/issues/6244). |
| Ventana del plan ChatGPT | La sección de cuotas de cuenta muestra una ventana de 5 horas o semanal en o cerca de su límite, mientras que la cerradura informa `ready` o `off`. | Espere a que la ventana se restablezca, inspeccione cualquier opción de reinicio que ofrezca ChatGPT ([Reglas de restablecimiento bancario](https://help.openai.com/en/articles/20001498-how-banked-codex-resets-work), [Plan de Ventanas](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) ) o atienda la solicitud en otra cuenta con `ocx account use openai <id>`. Para el uso de crédito pagado explícitamente autorizado después del límite, vea [política de crédito de cuenta](/es/reference/cli/providers-accounts/#pool-policy-account-thresholds-and-paid-credit-intent). El defecto de redescubrimiento de la balanza crediticia en [#6845](https://github.com/lidge-jun/opencodex/issues/6845) fue arreglado por [#6886](https://github.com/lidge-jun/opencodex/pull/6886). |
| Incidente del proveedor o falla de transporte | La cuota se mantiene baja, la cerradura se mantiene liberada y `ocx doctor` informa problemas de transporte o ChatGPT de accesibilidad. | Vuelva a intentar después de que el incidente se despeja o redirija a través de un combo existente. Cambiar la política de bloqueo o umbral no es una cura para un fallo de transporte. |

Una respuesta `upstream_reset_replay_refused` generada por el proxy también usa el estado 429: se desconoce si el proveedor ejecutó la solicitud, por lo que OCX rechaza reenviarla automáticamente. Su causa en el registro es `transport-ambiguous`, no un límite de cuota del proveedor. Se aplica a rutas directas y fallos de destinos de combo en entradas HTTP y WebSocket, con independencia de `upstreamWebsocket`. Estos rechazos sintéticos no enfrían destinos ni cuentan como límites de cuentas; los 429 reales mantienen su tratamiento. Las versiones antiguas pueden registrar un rechazo WebSocket o de combo como `rate-limit` / `rate_limit_exceeded`; esa combinación no demuestra que se haya agotado la cuota. `headers-only` es una etapa de progreso, no prueba de haber recibido encabezados del proveedor. Atribuir correctamente el rechazo no diagnostica ni repara el reinicio de conexión original.

Una credencial principal bloqueada cierra la solicitud de admisión; no reserva la cuota restante de la cuenta, y un restablecimiento predicho nunca libera el bloque por sí solo. Los umbrales (por defecto `short` 90, `long` 98) son visibles en la carga útil de estado y configurables a través de `codexMainAccountHardLockThresholds`.

Un rechazo de bloqueo duro se informa como `usage_limit_reached`, por lo que Codex termina el turno y marca un objetivo activo como limitado al uso en lugar de esperar días en un reintento. El tiempo de reintento sugerido es el restablecimiento de la cuenta principal o, para una solicitud de que el grupo de cuentas enrutado a la cuenta principal, el primer momento conocido en que se recupera otra cuenta del grupo, lo que ocurra primero (nunca antes de un minuto). Reanudar el objetivo después de ese tiempo; enrutamiento a continuación, recoge una cuenta de estado fresco.

<a id="stored-account-credit-metadata-retries"></a>

## Reintentos de metadatos de crédito de cuentas guardadas

Una cuenta guardada seleccionada explícitamente puede agotar su uso incluido cuando la última observación del saldo de créditos tiene más de cinco minutos. Si tiene activado el uso de créditos y la evidencia está desactualizada, ausente o incompleta, su rechazo local 429 recomienda reintentar tras el intervalo base de metadatos de 300 segundos, o al restablecerse la cuota incluida si ocurre antes. Un enfriamiento conocido del proveedor más tardío para el ámbito de cuota seleccionado, incluidas las retenciones de toda la cuenta, conserva la prioridad: si ambos se aplican, gana el plazo posterior. No se incorporan retenciones de otros grupos de modelos. El restablecimiento original de la ventana incluida sigue asociado al rechazo interno como `resetAt`; el aviso más corto ofrece volver a consultar metadatos, no un nuevo restablecimiento de cuota.

La solicitud sigue rechazada hasta disponer de evidencia reciente de créditos utilizables. El aviso no actualiza datos, no evita el ritmo de consultas, no garantiza la recuperación, no cambia la cuenta ni activa el uso de créditos. Los vínculos Direct conservan su identidad. La desactivación explícita de créditos, un valor null antiguo en caché sin procedencia, un veto de gasto conocido o un saldo finito vacío sin derecho a créditos ilimitados conservan el aviso de restablecimiento incluido. Un resumen de créditos recién observado ausente o mal formado retira la autorización de gasto, pero permite el reintento corto de metadatos; un veto explícito sigue prevaleciendo. Los créditos ilimitados con saldo cero también necesitan evidencia reciente. Los retrasos 429 ordinarios del proveedor mantienen el máximo de 24 horas del analizador para valores Retry-After numéricos y en formato de fecha HTTP.

<a id="triage-idle-timeout-waiting-for-sse"></a>

## Diagnóstico: `idle timeout waiting for SSE`

Codex termina un stream que no ha enviado eventos durante `stream_idle_timeout_ms` —300 segundos
por defecto— y reintenta el turno. El mensaje por sí solo no explica el silencio. En el WebSocket
nativo de ChatGPT, una posible causa es una ruta que falló silenciosamente después de empezar
la respuesta: reiniciar una VPN o túnel, reconectar Wi-Fi o caducar una asignación NAT puede
interrumpirla sin que el proxy reciba FIN o RST.

En el endpoint canónico de ChatGPT Codex (`https://chatgpt.com/backend-api/codex/responses`, con
canal de metadatos), el proxy envía pings durante todo el intercambio. Después de empezar la
respuesta, si el otro extremo respondió al menos a un ping y luego no entrega ningún frame ni
pong durante dos intervalos de ping, el stream termina con un fallo reintentable. Codex se
reconecta entre 30 y 45 segundos después del último frame o pong, en vez de esperar 300 segundos.
La fila de reconexión identifica la causa:

```text
Reconnecting... 1/5 (stream disconnected before completion: Upstream stream terminated unexpectedly: codex websocket stopped answering after the response started [cause=after-response-started ...])
```

Si un ping alcanza una ruta que un túnel reiniciado restablece, la fila informa
`codex websocket closed before a Responses terminal event (close 1006)` en aproximadamente
un intervalo de ping. Un `idle timeout waiting for SSE` que sigue llegando después del plazo
completo corresponde a un extremo que respondió a los pings sin enviar eventos, uno que nunca
respondió a un ping o un intercambio sin canal de metadatos, como el WebSocket Responses de OpenAI
API, que no envía pings. En esos tres casos se conserva deliberadamente el plazo del cliente.
`ocx logs get <request-id> --json` muestra `codexWsStage` y los recuentos `pings` y `pongs` del
intento para distinguirlos. Aumentar `stream_idle_timeout_ms` solo prolonga la espera.

<a id="why-the-first-reconnect-row-can-be-absent"></a>

## Por qué la primera fila de reconexión puede estar ausente

La fuente pública Codex `rust-v0.158.0-alpha.2.1` guarda la notificación de reintento de transmisión ordinaria en [`handle_response_stream_error`](https://github.com/openai/codex/blob/rust-v0.158.0-alpha.2.1/codex-rs/core/src/responses_retry.rs):

```rust
let report_error = retry_count > 1
    || cfg!(debug_assertions)
    || !sess.services.model_client.responses_websocket_enabled();
```

En una construcción de liberación, el primer reintento en este bucle puede por lo tanto esperar sin emitir `Reconnecting...` cuando el predicado interno habilitado para WebSocket es verdadero. El retardo seleccionado no es parte de ese predicado de notificación, y el reposo está fuera del bloque `if report_error`. Una larga espera aconsejada por el servidor también puede ser silenciosa. Esta es una observación de origen específica de la versión, no prueba de que cualquier solicitud de escritorio en particular tomó esa rama. No inferir el predicado interno de un nombre de modelo, un estado HTTP o el transporte visto en un salto proxy.

Una suscripción de notificación habilitada y un renderizador capaz de dibujar la fila solo establecen que existe la ruta de recepción. No prueban que el motor emitió un evento para el giro afectado. Del mismo modo, los detalles del proveedor colapsados pueden explicar el texto de detalle faltante, pero no una fila de reconexión faltante por sí mismos.

El correspondiente app-server [`ErrorNotification`](https://github.com/openai/codex/blob/rust-v0.158.0-alpha.2.1/codex-rs/app-server-protocol/schema/typescript/v2/ErrorNotification.ts) contiene `willRetry`, `threadId` y `turnId`. Observe la emisión, la entrega al giro correspondiente y la representación por separado. Un marco proxy `response.failed` no es en sí mismo esa notificación de servidor de aplicaciones. El cambio de esta política de notificación por primera vez en el lado del motor requiere un cambio Codex; una reescritura de mensaje de error OpenCodex no puede forzar un evento a través de una rama que no lo emite.

<a id="read-only-verification"></a>

## Verificación de solo lectura

Mantenga la aplicación existente, el proxy, la configuración y la prueba sin cambios mientras recopila evidencia. Reiniciar, enviar un nuevo turno o cambiar de transporte cambia el experimento. En un seguimiento aislado, compare el mismo fallo controlado en ambos estados internos WebSocket e inspeccione los reintentos primero y posteriores; no llame a eso una prueba de renderización de escritorio real a menos que se observe la interfaz de usuario.

Para la conversación afectada y el turno activo, distinga estos resultados:

| Pregunta | Evidencia requerida |
| --- | --- |
| ¿Se ha proporcionado asesoramiento útil? | El código del fallo final, el retardo normalizado y el tiempo de finalización de la respuesta. |
| ¿Ocurrió la retransmisión automática? | Una siguiente solicitud correlacionada después de ese fallo, sin un envío manual. Mida desde el final de la respuesta de fallo hasta el siguiente inicio de la solicitud, no desde el primer inicio de la solicitud. |
| ¿Se recuperó el proveedor? | Una respuesta exitosa y continuación del trabajo afectado, no simplemente otra solicitud o un giro exitoso no relacionado. |
| ¿Se emitió y entregó una notificación de reintento? | El evento de error app-server coincidente y su indicador de reintento, no solo la configuración de suscripción. |
| ¿Era visible el aviso? | Observación del turno de escritorio afectado; las comprobaciones de protocolo o código fuente por sí solas son insuficientes. |

El asesoramiento aproximado del proveedor y la sobrecarga de programación pueden producir una pequeña diferencia de tiempo. Si la retransmisión llega a un error de cierre del socket y un intento posterior recibe un nuevo límite de velocidad, registre la retransmisión como operativa pero la recuperación del proveedor como incompleta. El nuevo retraso del rechazo es una nueva observación, no un temporizador heredado del rechazo anterior. Un giro `inProgress` por sí mismo no prueba ni la recuperación ni la representación correcta. El agotamiento, la cancelación y la recuperación de reinicio de la aplicación deben evaluarse por separado.

Publique solo el alcance de validación y las duraciones/resultados agregados. Mantenga los registros en bruto, los cuerpos de solicitud, las credenciales, los datos de la cuenta, las rutas privadas y los identificadores de hilo/conversación/solicitud/traza fuera de las relaciones públicas y los informes de diagnóstico.

<a id="regression-test-scope"></a>

## Alcance de la prueba de regresión

`tests/server/retry-delay-hardening.test.ts` comprueba que las indicaciones de espera de 120, 900, 1800, 2460 y 3600 segundos conserven sus valores al formatearse; que la indicación más larga aparezca primero si también hay una más corta; y que una desconexión intermedia sin tiempo de espera no haga que un rechazo posterior herede un retraso antiguo. Son pruebas aisladas del analizador y el formateador. No esperan una hora ni ejercitan la condición interna con la que Codex decide emitir una notificación. Tampoco verifican un reinicio de la aplicación ni demuestran la recuperación frente a un fallo real del proveedor.
