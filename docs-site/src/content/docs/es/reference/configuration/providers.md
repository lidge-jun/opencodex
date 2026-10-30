---
title: "Configuración del proveedor"
description: "Entradas de proveedores, autenticación, puntos finales, catálogos de modelos, cuotas, límites de contexto y opciones específicas del proveedor."
---

<!-- Created: 2026-10-16; Updated: 2026-10-18; Version: 1.1 (Vertex endpoint note) -->

Un proveedor le dice a opencodex dónde vive un modelo, qué adaptador de cable habla y cómo se autentican las solicitudes.

<a id="deepseek-tokens-versus-image-bytes"></a>

## DeepSeek: tokens y bytes de imágenes

DeepSeek documenta un [Límite de solicitud de cuerpo de 48 MiB](https://api-docs.deepseek.com/guides/files_api/) separado. Una sesión de captura de pantalla puede alcanzar ese límite antes de que se llene su contexto de token; aumentar `model_auto_compact_token_limit` no puede evitarlo.

Las subidas están **desactivadas de forma predeterminada**. Configure `modelCapabilities: { "deepseek-flash": { deepseekImageFiles: true } }` en su proveedor si acepta imágenes persistentes por separado en los servidores de DeepSeek durante una hora. PATCH `null` en la entrada del eje o modelo borra la opción de inclusión.

Para los modelos opcionales en las URL Responses de origen, los cuerpos de más de 40 MiB reemplazan las imágenes en línea más antiguas con [Archivos API referencias](https://api-docs.deepseek.com/guides/files_api/), con el objetivo de 32 MiB. Los bytes de imagen, el historial y el uso de tokens permanecen sin cambios. Los archivos solicitan una hora de vencimiento; las cargas parciales exitosas permanecen hasta el vencimiento incluso si la generación falla. La caché de referencia limitada está aislada de credenciales y dura un máximo de 50 minutos (menos si el proveedor informa una expiración anterior). Un reintento puede reutilizar cargas exitosas; otra credencial carga su propia copia.

Las pasarelas de terceros y Chat Completions conservan su comportamiento. Un `detail: low` explícito mantiene la imagen en línea, porque las referencias de archivo lo ignoran. Si falla, la operación se detiene sin descartar imágenes ni reintentar la generación. La reparación tiene un plazo de subida de 60 segundos, un límite de entrada de 128 MiB y un máximo de dos preparaciones simultáneas; siguen aplicándose el ritmo y la concurrencia del proveedor. El texto demasiado grande y las imágenes que no puedan convertirse aún necesitan compactación. Esta reparación del transporte no amplía la ventana de contexto del modelo.

Solo se suben imágenes de mensajes `user` y `developer`, y las imágenes de resultados de herramientas. DeepSeek rechaza las imágenes en otros roles, por lo que nunca se almacenan.

## GPT-6.1 Terra

[GPT-6.1 Terra](https://openai.com/index/introducing-gpt-6-1-terra/) se publicó el 26 de octubre de 2026 como sucesor de GPT-5.6 Terra. `gpt-6.1-terra` está disponible junto a `gpt-5.6-terra`; no cambian el modelo predeterminado ni la lista de subagentes. GitHub Copilot usa Responses; OpenRouter enumera `openai/gpt-6.1-terra` con 1,050,000 de contexto y $1.00 de entrada / $5.00 de salida por millón de tokens.

En Codex nativo: contexto predeterminado de 500,000 y máximo de contexto largo de 872,000; esfuerzo predeterminado `low` y niveles `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. El `ultra` nativo se envía como `max`. La fila nativa solo ofrece Fast.

En la [API de OpenAI](https://developers.openai.com/api/docs/models/gpt-6.1-terra): contexto de 1,050,000 y salida máxima de 128,000; entrada de texto e imágenes y salida de texto; conocimiento hasta 2026-06-01. Los esfuerzos son `none`, `low`, `medium` (predeterminado), `high`, `xhigh` y `max`. Los endpoints son `v1/responses` y `v1/chat/completions`; las llamadas a herramientas requieren Responses.

Por millón de tokens: $1.00 de entrada, $0.05 de entrada en caché, $1.25 de escritura de caché durante 30 minutos y $5.00 de salida. Con más de 272,000 tokens de entrada, toda la solicitud usa el doble para entrada y caché y 1,5 veces para salida: $2.00 / $0.10 / $2.50 / $7.50, respectivamente. El modo Fast cuesta el doble.

<a id="context-windows-on-custom-providers"></a>

## Ventanas de contexto en proveedores personalizados

Cuando un proveedor personalizado omite la ventana de contexto de un modelo, OpenCodex puede inferirla a partir de los metadatos del modelo agrupados. Esto está desactivado de forma predeterminada: establezca `inferContextWindow: true` en el proveedor para activarlo. Sin ella, un modelo sin ventana utiliza el límite de Contexto habilitado como su ventana, luego la reserva de compatibilidad de 128k. Con él, el orden es: límites descubiertos / configurados (las ganancias más pequeñas), metadatos de Azure, metadatos de ID de modelo, límite de contexto habilitado como la ventana, luego 128k. Un límite de contexto activado sigue limitando el resultado. Los proveedores incorporados mantienen su comportamiento existente e ignoran la bandera.

`GET /api/providers` incluye `inferContextWindow` solo cuando está configurado, conservando tanto `true` como `false`. Para cambiarlo, `PATCH /api/providers?name=<provider>` acepta `true`, `false` o `null` para borrar la configuración y restaurar el comportamiento desactivado de forma predeterminada; otros tipos devuelven `400`. Omitirlo mantiene la configuración actual. Un `POST /api/providers` del mismo nombre también mantiene una configuración omitida, incluyendo `false` y cualquier cambio realizado mientras se validaba el guardado. Un booleano enviado gana, incluyendo `false`, incluso si el valor almacenado es `true`.

```json
{ "providers": { "my-relay": { "adapter": "anthropic", "baseUrl": "https://relay.example/v1", "inferContextWindow": true } } }
```

Las tablas API de proveedor original tienen prioridad sobre las tablas de agregador. Se prefieren los IDs exactos; las variantes de caso y punto/hipno se aceptan solo cuando no son ambiguas. IDs desconocidos, `~` alias flotantes y coincidencias conflictivas no se adivinan. OpenAI API ventanas no describen Codex límites de suscripción. Una ventana inferida afecta el presupuesto de compactación de Codex y otros catálogos de clientes conectados, incluida la selección de contexto largo de Claude, pero se registra por separado de la capacidad de enrutamiento afirmada.

Un ID de modelo coincidente hace que **no** verifique la capacidad real de su relé. Si sirve menos que la ventana del proveedor, configure `modelContextWindows` o **Cap. de contexto** del proveedor antes de usar sesiones largas. OpenCodex no habilita una tapa automáticamente ni prueba el modelo. Las solicitudes más pequeñas exitosas no prueban que la ventana inferida completa funcione. Las ventanas configuradas existentes permanecen bajo control.

<a id="initial-model-selection"></a>

## Selección inicial del modelo

Nuevas conexiones no OAuth esperan una lista de modelos confiable antes de exponer los modelos. Si esa lista contiene al menos 20 filas de token Modelos distintas, todos los modificadores de modelo se inician en OFF; el proveedor en sí permanece activo. OAuth y ChatGPT -las conexiones de inicio de sesión mantienen sus valores predeterminados, según el modo de autenticación efectivo.

Esto se ejecuta solo para un nuevo registro de proveedor. Las selecciones existentes sobreviven a las actualizaciones, el re-login y el reemplazo de claves. Después de la inicialización, habilite los modelos que necesita en Modelos o con el CLI a continuación; la política de llegada de modelos nuevos por separado no cambia. Reemplace `<model-id>` con un ID de la lista.

```sh
ocx models live --provider openrouter
ocx models enable '<model-id>'
ocx models disable '<model-id>'
ocx models provider openrouter on
```

Después del registro de la GUI o del inicio de sesión del OAuth, el cuadro de diálogo de confirmación le permite abrir la página Modelos. CLI registro y acceso imprimir comandos de gestión de modelos; JSON incluye los siguientes pasos estructurados. `--no-wait` informes pendientes de inicio de sesión, no de finalización. Inicie el proxy con `ocx start` antes de usar comandos de modelo en vivo.

<a id="zai-coding-plan-quota-endpoints"></a>

## Z.ai Coding Plan puntos finales de cuota

La sonda de cuota Z.ai reconoce la base de codificación internacional Chat `https://api.z.ai/api/coding/paas/v4`, la documentada [Claude Code Anthropic base](https://docs.z.ai/devpack/tool/claude) `https://api.z.ai/api/anthropic` y la documentada [Codex Responses base](https://docs.z.ai/devpack/tool/codex) `https://api.z.ai/api/v1`. Los tres leen la cuota del monitor internacional con autenticación de portador; esto no cambia la URL de inferencia ni implica un consumo de cuota diferente entre adaptadores. La selección del monitor BigModel CN existente permanece separada. Las URL de solicitud completas como `/api/v1/responses` no son URL de base del proveedor.

<a id="provider-related-top-level-fields"></a>

## Campos de nivel superior relacionados con el proveedor

| Campo | Tipo | Predeterminado | Descripción |
| --- | --- | --- | --- |
| `providers` | `Record<string, OcxProviderConfig>` | — | Mapa del nombre del proveedor a la configuración del proveedor. |
| `openaiProviderTierVersion?` | `2` | establecido por la migración | Marca la proyección OpenAI con una sola opción como completa. |
| `disabledModels?` | `string[]` | — | Modelos ocultos del catálogo de Codex y `/v1/models`, pero no bloqueados de llamadas proxy directas. Un identificador encaminado se elimina de los listados. Un identificador nativo calificado para la cuenta oculta solo esa fila selectora; un identificador GPT nativo desnudo oculta la fila desnuda y cada fila de selector de cuenta para ese modelo. La página Modelos del panel de control expone solo filas nativas enrutadas y desnudas; use este campo de configuración directamente para ocultar una fila calificada por el selector. Configura [`omitDisabledNativeModels`](/es/reference/configuration/catalog/) como `true` para omitir las filas nativas deshabilitadas; está desactivado de forma predeterminada. |
| `providerContextCaps?` | `Record<string, number>` | `{}` | Límites de contexto de proveedor activo. Las ventanas ordinarias se bajan; los modelos nativos con una ventana larga compatible pueden expandirse solo hasta su propio techo compatible. |
| `providerContextCapValues?` | `Record<string, number>` | `{}` | Límites del último proveedor seleccionado, retenidos mientras están desactivados. Estos valores no activan un límite. Un valor habilitado tiene prioridad sobre un valor recordado. |
| `contextCapValue?` | `number` | `350000` | Por defecto se utiliza en la primera habilitación. Una habilitación posterior restaura el valor del proveedor seleccionado. Actualizar el valor global solo con los límites de cambios habilitados para `setAll: true`; `setAll: true` sin un valor habilita a todos los proveedores configurados al valor global actual. |
| `codexAccounts?` | `CodexAccount[]` | `[]` | ChatGPT / Codex metadatos de cuenta de grupo administrados por Codex Auth. Los secretos viven por separado en `codex-accounts.json`. |
| `pausedCodexAccountIds?` | `string[]` | `[]` | Cuentas excluidas de la selección Pool hasta que se reanude, incluida la cuenta principal `__main__` cuando se detiene. La pausa manual y el reinicio también actualizan las entradas principales y de grupo existentes para la misma cuenta y espacio de trabajo. |
| `codexUseRemainingQuotaAccountIds?` | `string[]` | `[]` | Las cuentas optaron por usar su cuota incluida restante. Desactiva el cambio de uso proactivo para las cuentas enumeradas; para `__main__`, los umbrales efectivos de bloqueo duro corto / largo se convierten en 100%. Los umbrales originales permanecen almacenados y se aplican de nuevo después de deshabilitarlos. Todavía se aplican la pausa, la autenticación, la elegibilidad, el tiempo de reutilización y el permiso de crédito pagado. Gestionado por `ocx account use-remaining openai <id-or-main> on`; esta preferencia persistente no selecciona la cuenta. |
| `creditCodexAccountIds?` | `string[]` | `[]` | Cuentas permitidas para seguir sirviendo desde ChatGPT créditos después de un límite de uso, incluida la cuenta principal `__main__`. Upstream no rechaza una cuenta que tiene créditos al 100%; sirve a la solicitud y extrae el saldo. El gasto es opt-in: una cuenta que no aparece aquí se salta por selección, mientras que una de sus ventanas de uso (semanal o mensual, solo mensualmente en planes de 30 días o la ventana de 5 horas) lee el 100% con su restablecimiento aún por delante, y regresa una vez que ese restablecimiento pasa. Una lectura semanal o mensual sin un tiempo de reinicio no mantiene la cuenta; una lectura de 5 horas al 100% sin un reinicio lo mantiene solo mientras esa lectura aún está fresca. Cuando no hay otra cuenta disponible, la selección automática no encuentra ninguna en lugar de gastar créditos. Un `__main__` no listado también es rechazado, como un rechazo de bloqueo, cuando una solicitud lo nombra o lleva su credencial. El listado `__main__` no levanta el bloqueo de la cuenta principal (por defecto al 98%), lo que aún detiene el inicio de sesión principal primero; apague el bloqueo para dejar que la cuenta principal gaste créditos (un bloqueo al 100% aún lo detiene al 100%). Las cuentas nuevas comienzan a no estar listadas. Gestionado por el interruptor **Usar créditos** en el encabezado Codex Auth y el interruptor **Usar créditos después del límite** en el menú **⋯** de cada tarjeta de cuenta. |
| `codexQuotaAutoRefresh?` | `Record<string, object>` | `{}` | Por- Codex -login-cuenta opt-in para la activación automática de la ventana `fiveHour` y `weekly` en el modo Pool; El modo Direct no ejecuta este trabajador. En Providers/ Codex Auth **Configuración avanzada**, un control habilita o desactiva ambas ventanas compatibles en todas las cuentas principales y agregadas actuales. Las cuentas nuevas no se aceptan automáticamente. Habilitar salta ventanas ausentes de los datos WHAM en vivo; deshabilitar también borra las ventanas obsoletas habilitadas. La interfaz de usuario reutiliza `/api/settings` granular escribe, reconcilia fallos parciales y reintenta la intención original de activación/desactivación sin reemplazar configuraciones no relacionadas o marcadores de reinicio completados. El API todavía rechaza habilitar una ventana no disponible con HTTP 409. En un tiempo de reinicio informado, opencodex envía un mensaje Codex mínimo no almacenado usando la cuota de esa cuenta y persiste la marca de tiempo activada. Esto no se aplica a los proveedores de claves API. |
| `codexAccountNamespaces?` | `Record<string, string>` | — | Mapa opcional de un selector de modelo público arbitrario a un destino de cuenta Codex almacenado. Cuando se habilitan las filas de selector calificadas para la cuenta, cada selector cuyo objetivo está presente agrega `<selector>/<native-openai-model>` filas separadas al selector Codex; cada fila usa solo esa cuenta. Con cualquier selector activo, las filas nativas desnudas están ocultas en el selector, pero sus ids permanecen enrutables y listados por `/v1/models` sin procesar a menos que estén explícitamente deshabilitados. |
| `codexAccountPickerEnabled?` | `boolean` | cuando el mapa está vacío | Controla si las asignaciones `codexAccountNamespaces` elegibles generan filas de selector Codex calificadas para la cuenta. `true` permite que aparezcan las filas asignadas. Si se omite con un mapa no vacío, se trata como habilitado para la compatibilidad con versiones anteriores; si el mapa está vacío, está desactivado. `false` oculta las filas generadas y restaura las filas del selector nativo desnudo sin eliminar asignaciones ni deshabilitar el enrutamiento exacto `<selector>/<native-openai-model>`. |
| `activeCodexAccountId?` | `string` | — | La cuenta Pool seleccionada manualmente para la siguiente solicitud. La selección borra la afinidad del hilo; las solicitudes en vuelo mantienen las credenciales capturadas. |
| `codexAccountPriorities?` | `Record<string, number>` | — | Orden de selección por cuenta para el grupo Codex: número de identificación de cuenta → de `-100` a `100`, **más alto se utiliza antes**, medios ausentes `0`. Este es un límite de pedido, no uno de elegibilidad: la selección reduce las cuentas ya elegibles al nivel más alto que aún tiene margen de cuota, y `accountPoolStrategy` luego elige dentro de ese nivel. Un nivel se salta solo cuando cada miembro está en o por encima de su propio umbral de uso efectivo distinto de cero (anulación de cuenta o valor predeterminado global), enfriamiento, evitación suave, pausa o necesita reautenticación: la cuota desconocida nunca agota un nivel. Ordenar nunca hace que una cuenta no elegible sea seleccionable y, por defecto, nunca vuelve a unir un hilo que ya tiene una cuenta. La cuenta principal `__main__` participa en igualdad de condiciones, que es la forma en que el inicio de sesión del escritorio Codex se puede configurar para agotar en último lugar. Sin entradas, el grupo se comporta exactamente como antes. Un mapa mal formado se ignora con una advertencia de consola (ordenación desactivada, sin reparación de configuración). Administrado por `ocx account priority` y la página Codex Auth. |
| `activeCodexAccountPinned?` | `string` | — | ID de cuenta que el operador seleccionó por última vez a mano. Mientras está establecido, un nivel `codexAccountPriorities` más alto no puede evitarlo hasta que el pin se libere por drenaje, exclusión, eliminación o una conmutación por error / promoción explícita. El movimiento ordinario de round-robin dentro del nivel con tapa no lo libera. Escribir cualquier entrada `codexAccountPriorities` también libera el pin, por lo que un pin hecho antes de que existiera una orden no puede superar a un conjunto después. `GET /api/codex-auth/active` informa tanto si la cuenta efectiva está anclada ( `pinned` ) como si la cuenta que lleva el techo ( `pinnedAccountId` ). |
| `codexPreserveSignedInAccount?` | `boolean` | `false` | Prefiera otras identidades elegibles Codex Pool antes de las entradas nativas principales y ordinarias que coincidan con su espacio de trabajo seleccionado y el correo electrónico del miembro. Las prioridades personalizadas existentes se conservan dentro de cada grupo. Permanecen fijaciones y pines manuales saludables; las rutas exactas de la cuenta y el modo Direct no cambian. El retroceso puede consumir la cuota de inicio de sesión bajo todos los guardias existentes. Use [cuenta preserve-signed-in](/es/reference/cli/providers-accounts/#ocx-account-preserve-signed-in-openai-onoffstatus---apply-to-bound---json) para el estado o una transición explícita de enlace de siguiente solicitud. |
| `codexAccountPriorityFailback?` | `boolean` | `false` | Opt-in retorno de Codex Pool tareas en curso a una cuenta de mayor prioridad utilizable bajo la estrategia `quota`. Las solicitudes activan una actualización de cuota de fondo como máximo una vez cada cinco minutos, incluidos los intentos de actualización fallidos. Cuando las observaciones recientes de la cuota muestran margen, la siguiente solicitud puede volver a vincularse incluso si su cuenta corriente está por debajo del umbral. Esta preferencia explícita puede descartar una caché de solicitud caliente; no cambia la afinidad de caché predeterminada. Ninguna solicitud significa que no hay votación. Los pines manuales, el acceso al modelo, los tiempos de reutilización, las pausas y las exclusiones de reautenticación aún se aplican; las solicitudes en vuelo mantienen su cuenta capturada. Requiere que el umbral efectivo de la cuenta de origen actual sea positivo (una anulación de 0 lo deshabilita; una anulación positiva funciona con 0 global); las rutas exactas de la cuenta y el modo Direct no cambian. |
| `autoSwitchThreshold?` | `number` | `80` | Umbral de uso para la colocación de trabajo nuevo/no vinculado. `quota` puede volver a evaluar las tareas no vinculadas en su próxima solicitud una vez que el uso cruce este umbral. Las tareas vinculadas mantienen su cuenta más allá del umbral por defecto (`pool.cacheAffinity`); se van solo cuando esa cuenta está agotada o no puede servir, y luego solo para una cuenta con un margen de cuotas genuino y un uso estrictamente menor. Configurar `pool.cacheAffinity: false` para volver a evaluar las tareas vinculadas en este umbral, aún solo en dicho destino. `fill-first` lo usa solo como el punto de drenaje para la asignación no vinculada; la selección normal `round-robin` no lo usa. La puntuación utiliza la ventana de cuota más caliente conocida de 5h, semanal o 30d. `0` deshabilita únicamente la conmutación proactiva basada en el uso, no la asignación no vinculada o la recuperación de fallas. |
| `codexAccountAutoSwitchThresholds?` | `Record<string, number>` | — | Anulaciones por cuenta para `autoSwitchThreshold`: id de cuenta → entero de `0` a `100`. Una entrada ausente hereda el valor global; `0` desactiva la conmutación basada en el uso solo cuando esa cuenta es la fuente. `quota` utiliza el umbral efectivo de la cuenta de origen actual para la reevaluación de tareas limitadas y la conmutación sin límites. El margen de nivel de primer drenaje y de orden de selección se evalúa contra el propio umbral efectivo de cada cuenta; los pines de la cuenta principal y el retroceso del subagente también usan el umbral efectivo de la cuenta relevante. Soporta la cuenta principal `__main__`. Un mapa mal formado se ignora con una advertencia. Administrado por cada tarjeta de cuenta en la página Codex Auth; deshabilitar una anulación elimina su entrada. Al habilitar la anulación, se copia el umbral global actual en un valor de cuenta fijo. La anulación, incluyendo `0`, tiene prioridad sobre los cambios globales posteriores. Deshabilitar envía `threshold: null`, elimina la entrada y restaura la herencia del umbral global actual y los cambios globales futuros. |
| `accountPoolStrategy?` | `"quota" \| "round-robin" \| "fill-first" \| "reset-first"` | `"quota"` | Estrategia de asignación para solicitudes nuevas/no enlazadas Codex. Una solicitud no está vinculada cuando no tiene afinidad en vivo (identificador de subproceso principal, ámbito de cuota); una tarea existente visible puede liberarse después de reiniciar el proxy o restablecer la afinidad. `quota` elige la cuenta elegible de menor uso cuando no existe una cuenta activa, mantiene una cuenta activa elegible por debajo de `autoSwitchThreshold` y después del umbral puede mover una solicitud no vinculada. Las tareas vinculadas siguen `pool.cacheAffinity` (activadas de forma predeterminada): permanecen hasta que la cuenta se agota (uso conocido al 100%) o de lo contrario no puede servir, y luego pueden volver a unirse solo a una cuenta con un margen de cuota genuino y un uso estrictamente menor. Configurar el indicador `false` para volver a unir proactivamente una tarea vinculada en el umbral, todavía solo en tal destino. `round-robin` distribuye las solicitudes no vinculadas de manera uniforme; `fill-first` sigue asignando solicitudes no vinculadas a la cuenta activa hasta el tiempo de reutilización, la falta de disponibilidad o el umbral de drenaje configurado. `reset-first`: Prefiera el restablecimiento semanal o de 5 horas en el futuro más cercano entre las cuentas por debajo del umbral de uso. Las tareas vinculadas siguen la política de afinidad configurada. Las cuotas modelo independientes utilizan la ordenación de cuotas. Los restablecimientos mensuales no determinan este orden. |
| `pool.cacheAffinity?` | `boolean` | `true` | Ordenación de afinidad de caché para hilos vinculados Codex, independientemente de `pool.kernel`. Omitir la clave o la configuración `true` mantiene una tarea vinculada en su cuenta hasta que esa cuenta realmente no pueda servir. Solo un `false` explícito restaura la reasignación basada en umbral de tareas vinculadas. Un enlace en vivo supera el margen de la cuota: `quota` no mueve el hilo simplemente porque el uso cruzó `autoSwitchThreshold`. El hilo todavía se va si esa cuenta no puede servir - pausado, inutilizable o genuinamente agotado (uso conocido al 100%) - y luego solo a una cuenta con margen de cuota genuino y uso estrictamente más bajo. En cualquier configuración, una cuenta con uso desconocido nunca se elige como destino para una tarea vinculada, por lo que cuando cada cuenta se encuentra por encima del umbral, la tarea se mantiene. La afinidad es un reordenamiento, no un pin. |
| `pool.credentialGroups?` | `Array<{ id: string; credentials: string[]; note?: string }>` | `[]` | Aceptado y validado, pero aún no consumido por el enrutamiento: declarar que un grupo no cambia ninguna decisión de enrutamiento hasta que una capa consumidora aterriza. Dominios de cuota declarados por el operador: grupos de credenciales que comparten demostrablemente un límite de uso ascendente. Los miembros de un grupo cuentan una vez para la capacidad disponible, y un rechazo de cuota dentro de un grupo no se responde rotando a otro miembro: el límite es el mismo, por lo que el movimiento pagaría un prefijo frío por cero nueva capacidad. Los grupos declarados solo hablan de cuota; compartir un límite no dice nada sobre la compatibilidad de la caché de solicitud, que se clasifica por separado. Cada miembro está calificado por el proveedor como `"<provider>:<credential-id>"`, porque una identificación de credencial significa algo solo dentro de su proveedor; el segmento de proveedor acepta los alias habituales (`chatgpt:` y `codex:` significan ambos OpenAI). Los identificadores de grupo deben ser únicos, `credentials` no debe estar vacío, y una credencial puede aparecer en un máximo de un grupo: una declaración ambigua se rechaza al escribir y se elimina con una advertencia sobre la carga en lugar de resolverla el grupo que aparece primero, ya que eso combinaría dos dominios de cuota no relacionados. Una lista mal formada cuesta solo la agrupación: `pool.kernel` y `pool.cacheAffinity` se conservan. Ausente o vacío significa que no se declara agrupación, por lo que una instalación no configurada se comporta exactamente como antes. |
| `accountPoolStickyLimit?` | `number` | `1` | Las asignaciones de tareas nuevas/no vinculadas se conservan en una selección de round-robin antes de avanzar; el contador avanza cuando una tarea está vinculada, no después de un éxito ascendente. Alcance 1-100. |
| `upstreamFailoverThreshold?` | `number` | `3` | Fallos transitorios consecutivos tras los cuales las sesiones nuevas cambian a otra cuenta. Configura `0` para desactivarlo. En las solicitudes Responses normales y las de compactación nativa, los fallos de conectividad DNS/TCP confirmados antes de establecer la conexión se registran por host del proveedor. No afectan al estado ni a la espera de las cuentas, la afinidad de hilo o sesión, la cuenta activa ni el enrutamiento del Pool, y no cuentan para este umbral. |
| `codexFailureWindow?` | `boolean` | `true` | Proporción de fallos transitorios en una ventana móvil de 60 segundos para hilos nuevos de Codex, junto con el contador de fallos consecutivos. Con al menos 20 muestras, una proporción del 25% o más marca la cuenta como degradada; esa marca se borra cuando la proporción permanece en el 10% o menos durante 30 segundos. Las cuentas degradadas solo se omiten para hilos nuevos: los que ya tienen una cuenta asignada la conservan. Configura `false` para decidir únicamente mediante el contador de fallos consecutivos. |
| `codexPinnedTransientPolicy?` | `"hold" \| "detour-new-threads"` | `"hold"` | Mientras una cuenta anclada manualmente está en la ventana de falla, `hold` sigue enviándole nuevos hilos y registra una advertencia degradada. `detour-new-threads` coloca solo nuevos hilos en otra cuenta. Un giro en vuelo nunca se mueve, y un giro que ya se ha enviado nunca se resiente. |
| `codexWsReuseAcrossTurns?` | `boolean` | `false` | Opt-in Codex WebSocket reutilización a través de turnos de una cuenta y el hilo. Cuando está activado, se espera un socket ocupado como máximo 750 ms antes de otro dial, se mantienen hasta dos sockets cuando cambia el modelo o el nivel de servicio, y las cabeceras de estado de giro permanecen en cada mensaje en lugar del apretón de manos. Los cambios de autorización, cuenta, proxy o dial-URL aún retiran el socket anterior. |
| `upstreamHostCircuitThreshold?` | `number` | `0` | Umbral de entrada para fallos probados de DNS/ TCP previos a la conexión en envíos Responses directos nativos OpenAI y compactos. `0` lo deshabilita; `1` - `20` abre un tiempo de reutilización de origen del proveedor de 30 segundos después de muchas solicitudes lógicas de terminal. Mientras están abiertas, las solicitudes reciben `503` con `Retry-After` antes de la selección de la cuenta o el envío ascendente; después del tiempo de reutilización, se admite una solicitud a medio abrir. Los tiempos de espera y las respuestas HTTP nunca cuentan, y cualquier respuesta HTTP cierra el circuito. Se aplica solo al enrutamiento Codex Pool sin cuenta fija; es inerte para `codexAccountMode: "direct"` y selectores calificados para cuentas. |
| `maxUpstreamBodyBytes?` | `number` | `0` | Techo opt-in, en bytes, en un cuerpo serializado nativo Responses **passthrough**. `0` u omitido lo desactiva - no se infiere límite para ningún destino. Cuando se establece, un cuerpo construido por encima del techo se rechaza localmente antes del envío: los giros de transmisión reciben un terminal `response.failed` / `context_length_exceeded` para que el cliente compacta en lugar de reenviar, y los giros que no son de transmisión reciben un `413` que nombra el tamaño, el número de elementos `input_image` incrustados y aproximadamente cuántos megabytes de datos de imagen representan. Revisado en cada punto de construcción y reconstrucción, incluyendo OAuth -refresh replay y retry de cuenta alternativa. Las rutas de adaptador traducidas no están cubiertas. No hay ningún defecto deliberadamente: el único techo medido aquí pertenece al transporte WebSocket, que ya se reduce a HTTP para giros de gran tamaño, por lo que un defecto rechazaría las solicitudes que actualmente tienen éxito. Establezcalo cuando su puerta de enlace tenga un límite de tamaño de solicitud conocido y prefiera ver un error local procesable que un fallo de flujo ascendente opaco. |
| `maxInboundBodyBytes?` | `number` | `0` | Techo opt-in, en bytes, en un cuerpo de solicitud de plano de datos **entrantes** descomprimido - el espejo de `maxUpstreamBodyBytes` arriba. `0` u omitido mantiene el valor predeterminado de 256 MiB incorporado. Levántelo cuando una sesión de contexto grande ya no pueda compactar: Codex reproduce todo el historial en el modelo de compactación, por lo que en la ventana opt-in del token 922k, la solicitud de compactación es la que cruza el límite, y la sesión está atascada en la única operación que la habría reducido. Sujeto a 1 MiB-512 MiB. El techo no es negociable: el lector materializa el cuerpo varias veces (bytes de cable, bytes decodificados, la cadena decodificada y el gráfico de objeto analizado), por lo que la memoria máxima es un múltiplo de lo que se admite, y un valor ilimitado sería una palanca de agotamiento de memoria. Se aplica a `/v1/responses`, `/v1/responses/compact`, `/v1/chat/completions`, y `/v1/messages`. También cubre las rutas de imágenes, búsqueda y recuento de tokens indicadas en [admisión de cuerpos entrantes](/es/reference/inbound-body-admission/). El tamaño de aceptación del oyente se fija cuando el proxy se une, por lo que un cambio tiene efecto al reiniciar. Se rechaza localmente un cuerpo por encima del límite con HTTP 413 y `code: "inbound_body_too_large"`, que es deliberadamente distinto del `context_length_exceeded` 413 que produce una denegación de tamaño del proveedor. Un límite efectivo superior a 256 MiB activa además el control compartido `maxConcurrentInboundBodyBytes`; aumentar solo el límite por solicitud no aumenta ese presupuesto. |
| `maxConcurrentInboundBodyBytes?` | `number` | `536870912` (512 MiB) | Presupuesto compartido opcional de nivel superior en bytes, activo solo si `maxInboundBodyBytes` efectivo supera 256 MiB. Omitirlo, usar `0` o un valor inválido conserva los 512 MiB predeterminados. Los enteros positivos válidos se limitan a 512 MiB–2 GiB (`536870912`–`2147483648`) al consumirse. Requiere reinicio; todos los listeners del proceso comparten el presupuesto. Contabiliza admisión: no preasigna memoria, limita RSS ni dimensiona automáticamente la RAM. Los 2 GiB requieren una decisión explícita. Consulta [admisión de cuerpos entrantes](/es/reference/inbound-body-admission/) para el ejemplo, la cola, la duración de las respuestas y por qué el valor predeterminado solo admite una carga completa de 512 MiB antes del análisis. |
| `upstreamRequestCompression?` | `"off" \| "gzip" \| "zstd"` | `"off"` | Compresión opt-in de cuerpos de solicitud nativos ChatGPT Responses HTTP. Codex vuelve a enviar toda la conversación en cada turno, y cuando ese turno supera HTTP OpenCodex, de lo contrario la envía a `chatgpt.com` sin comprimir; en una salida medida o de larga distancia, ese es el costo dominante. Cuando se fijan, los cuerpos de cuerda de 1 KiB a 16 MiB enviados a `https://chatgpt.com/backend-api/codex/responses` y `/compact` se comprimen en el envío final y se etiquetan con `Content-Encoding`. WebSocket gira, cada otro destino, los cuerpos que ya declaran un `Content-Encoding`, y los cuerpos fuera de esa ventana de tamaño se envían sin cambios, y un fallo de códec cae de nuevo al envío sin comprimir. `zstd` es la codificación Codex CLI que se utiliza con este backend y es la opción más rápida para giros pesados de imagen; `gzip` (nivel 1) también está disponible. En una medición local, la historia de código pesado se redujo alrededor de 2-4 ×, mientras que las imágenes incrustadas apenas se reducen. La compresión se ejecuta de forma sincronizada en el bucle de eventos del proxy, por lo que cada envío elegible retrasa brevemente otras solicitudes en vuelo, del orden de 2-3 ms por MiB para texto en una CPU portátil reciente, más para datos incompresibles con `gzip`. Los límites de bytes tales como `maxUpstreamBodyBytes` todavía miden el cuerpo no comprimido. Configúrelo con `ocx config set upstreamRequestCompression zstd` (se rechaza un valor desconocido) o editando `config.json`, donde se ignora un valor desconocido, y luego reinicie el proxy para aplicar. |
| `modelCacheTtlMs?` | `number` | `300000` | Ventana de frescura para la caché por proveedor `/models`. |
| `cacheRetention?` | `"none" \| "short" \| "long"` | Anthropic: `"long"`; otros Anthropic -puntos finales compatibles: `"short"` | Política de caché rápida Anthropic: inhabilitado, 5 minutos efímero o 1 hora extendido. Cuando no se establece, las solicitudes a `api.anthropic.com` (clave API o los grupos de cuentas OAuth) usan el TTL de 1 hora, porque los giros angélicos a menudo se pausan más de cinco minutos y una escritura de 1 hora (2 entradas base en lugar de 1.25x) se paga a sí misma en la primera reutilización; Anthropic -compatible puertas de enlace y los puntos finales de proveedores mantienen el TTL de 5 minutos porque su soporte de 1 hora no está documentado. En el paso `/v1/messages` nativo, los puntos de interrupción del llamante sin un `ttl` obtienen `"1h"` a menos que la solicitud fije cualquier punto de interrupción a `"5m"`, en cuyo caso se reenvía sin cambios. En una ruta `/v1/messages` traducida, los puntos de interrupción de llamadas que todos piden `ttl: "1h"` significan `"long"` y cualquier `"5m"` explícito significa `"short"`. Un valor explícito siempre gana. Cambiar el TTL hace que cada conversación abierta escriba su caché una vez más, ya que las entradas de 5 minutos y 1 hora están separadas. Estimaciones de costos de escrituras de precios reportadas como 1 hora a la tasa de 1 hora. |
| `tokenGuardian?` | `OcxTokenGuardianConfig` | Desactivado | Política de actualización proactiva opcional OAuth y Codex -cuenta de calentamiento. |

Las cuentas de grupo con una ventana de uso incluida completa refrescan su evidencia de crédito a través del barrido de antecedentes existente a partir de los tres minutos de edad. Los encabezados de respuesta ordinarios no actualizan los saldos de crédito. Una lectura de metadatos fallida nunca extiende la vida útil de la evidencia de gasto de cinco minutos.


A través de estas estrategias, el umbral efectivo de cada cuenta es su entrada `codexAccountAutoSwitchThresholds` cuando está presente, de lo contrario global `autoSwitchThreshold`. Una anulación cero desactiva solo el cambio de uso proactivo; la vinculación de inicio, el bloqueo duro, el tiempo de reutilización, las comprobaciones de derechos y la recuperación de fallas siguen vigentes.

Establecer el umbral de conmutación de una cuenta en `0` no desactiva el bloqueo de la cuenta principal, la protección de inicio, los tiempos de reutilización o las verificaciones de elegibilidad del modelo. En el modo Pool, una credencial de llamada anclada que coincide con la cuenta principal observada no puede omitir el tiempo de reutilización aplicable de esa cuenta: se usa una alternativa elegible de Pool o se rechaza la solicitud. Las credenciales de llamadas no relacionadas no heredan el tiempo de reutilización de la cuenta principal; el comportamiento explícito de Direct no cambia.

Los nombres de selector son etiquetas públicas elegidas por el usuario; opencodex no les asigna semántica de rol de cuenta. `codexAccountNamespaces` teclas son 1-64 caracteres, comenzando y terminando con una letra o número ASCII, con letras, números, `.`, `_` o `-` en el interior. Se rechazan los nombres de objetos JavaScript reservados. Cada valor es un identificador válido de cuenta de grupo (nunca interno `__main__`) o `"@main"` para la cuenta de escritorio Codex. Las colisiones de proveedor y reservadas `openai` / `combo` / `policy` se comprueban de forma insensible a mayúsculas; un alias combinado o de perfil de enrutamiento espaciado por nombres no puede reutilizar un selector como su prefijo de espacio de nombres, y los identificadores de grupo configurados o los objetivos del selector tampoco pueden reutilizar un selector. Mantenga los ID de cuenta y los correos electrónicos en privado; el selector es el nombre público. Véase [Configuración de enrutamiento](/es/reference/configuration/routing/) para el comportamiento de selección exacta y la precedencia.

El control del panel de control Codex Auth posee mapas que tienen un campo explícito `codexAccountPickerEnabled`. Habilitar un mapa administrado vacío crea selectores seguros para la privacidad; las adiciones posteriores de la cuenta extienden ese mapa incluso mientras las filas del selector están ocultas, sin cambiar el nombre de los selectores existentes. Un mapa escrito a mano que omite la bandera permanece manual y nunca se expande automáticamente. Eliminar una cuenta mantiene su asignación para que las rutas exactas fallen mientras falta; agregar la misma identificación de cuenta restaura nuevamente el selector público existente en lugar de asignar uno nuevo.

<a id="reserved-openai-providers"></a>

## Proveedores reservados de OpenAI

`openai` y `openai-apikey` son identificadores reservados fijos. `openai.codexAccountMode` es `"pool"` por defecto y selecciona entre las cuentas principales más añadidas; `"direct"` utiliza solo el inicio de sesión actual de la persona que llama/principal. API utiliza solo su llave o grupo de llaves API configurado. Utilice un modelo desnudo o `openai-apikey/<model>`; no hay respaldo de credenciales de ruta cruzada. API GPT-5.6 filas llevan 1,050,000 metadatos de entrada de contexto / 922,000 máximos, y las id virtuales Pro reescriben al modelo de cable base con `reasoning.mode: "pro"`.

`openaiProviderTierVersion: 2` marca la proyección actual de un solo proveedor. Antes de migrar una configuración v1 enviada, opencodex crea `config.json.pre-openai-tiers-v2.bak` sin reemplazar una copia de seguridad diferente y reescribe los identificadores seleccionados conocidos de namespace a identificadores desnudos.

<a id="gpt-6-astra-sol-luna-and-astra-minor"></a>

### GPT-6 Astra, Sol y Luna

`gpt-6-astra` utiliza la ruta de inicio de sesión Codex; `openai-apikey/gpt-6-astra` utiliza su clave API. La disponibilidad todavía depende de la cuenta ascendente. Astra nativo mantiene los Codex valores predeterminados enviados: 272,000 contexto, `low` razonamiento y la escalera `low` / `medium` / `high` / `xhigh` / `max` / `ultra`. Su descripción rápida del catálogo es **2x velocidad**; que no es el multiplicador de facturación.

Establecer `providerContextCaps.openai` a `922000` para optar por el grupo nativo en contexto largo; Astra se detiene en su propio techo **872,000**. Los modelos `providers.openai.modelContextWindows` y `modelAutoCompactTokenLimits` pueden reducir su ventana y su presupuesto de compactación suave. Por ejemplo, `modelAutoCompactTokenLimits: { "gpt-6-astra": 700000 }` reduce el valor predeterminado de la ventana larga de 784.800. Un límite de proveedor explícito más pequeño o límite de destino aún gana, incluidos los combos de alias nativos.

Sin un límite rígido configurado, el catálogo nativo mantiene el `max_context_window` anunciado separado del `context_window` predeterminado (para Astra, 872,000 frente a 272,000). La compactación sigue utilizando la ventana por defecto efectiva. Para dar un modelo 500.000 tokens y los otros 300.000, establece `providers.openai.contextWindow` a `300000` y `providers.openai.modelContextWindows` a `{ "gpt-6.1-sol": 500000 }`. El valor por modelo anula la ventana del proveedor; `providerContextCaps.openai`, cuando está habilitado, sigue siendo un techo para cada modelo nativo y debe ser al menos `500000` para este ejemplo. La capacidad de cada modelo limita el resultado.

La fila API tiene 1.050.000 contextos, 922.000 entradas máximas, 128.000 salidas máximas, entradas de texto/imagen y API esfuerzos de razonamiento a través de `max`. El control Ultra sintético enrutado de OpenCodex conserva su mapeo de esfuerzo de cable existente; no es un esfuerzo adicional de API. No hay alias Astra `-pro`. Utilice la configuración `fastMode` existente, o Codex `service_tier = "fast"` con `[features].fast_mode = true`; API `fast` y `priority` se aceptan ortografía rápida.

[GPT-6 Sol y Luna](https://openai.com/index/introducing-gpt-6-sol-and-luna/) (anunciado el 22 de septiembre de 2026) son Codex nativos de inicio de sesión: `gpt-6-sol` y `gpt-6-luna`, mostrados como **GPT-6-Sol** y **GPT-6-Luna**. Al igual que Astra, se enumeran en cada instalación y no están cerradas en una lista de cuentas; si su cuenta no puede usarlas todavía, la solicitud aún se apaga y ve el error ascendente. Sus metadatos provienen de la lista Codex `/models`, que sirve a estas dos filas solo a `client_version` **0.155.0 o más tarde**; opencodex envía una copia de esas filas, por lo que aparecen incluso cuando su catálogo Codex instalado es anterior a ellas.

| Modelo | Contexto predeterminado | Techo opt-in | Esfuerzo predeterminado | Razonamiento escalera |
| --- | ---: | ---: | --- | --- |
| `gpt-6-sol` | 272,000 | 872,000 | `medium` | `low` hasta `ultra` |
| `gpt-6-luna` | 272,000 | 872,000 | `medium` | `low` a `max` (n.o `ultra`) |

[GPT-6.1 Sol](https://openai.com/index/introducing-gpt-6-1-sol/) (anunciado el 29 de septiembre de 2026) es la actualización a GPT-6 Sol; Astra y Luna no obtuvieron un lanzamiento de 6.1. Está catalogado como `gpt-6.1-sol` (**GPT-6.1-Sol**), sin conexión como Sol, y su fila proviene del catálogo Codex, donde necesita `client_version` **0.153.0 o más tarde** y es el Codex predeterminado. GPT-6 Sol se queda en la lista.

| Modelo | Contexto predeterminado | Techo opt-in | Esfuerzo predeterminado | Razonamiento escalera |
| --- | ---: | ---: | --- | --- |
| `gpt-6.1-sol` | 500,000 | 872,000 | `low` | `low` hasta `ultra` |

OpenAI elevó el contexto predeterminado de GPT-6.1 Sol en Codex y Work de 272,000 a 500,000 tokens el 11 de octubre de 2026, por lo que la fila nativa ahora se establece en 500,000 y se compacta en 450,000. El catálogo Codex incluido todavía lee 272,000, por lo que opencodex establece el nuevo valor predeterminado. Una ventana configurada o tapa del proveedor todavía lo baja, y el opt-in de ventana larga todavía se detiene en 872,000: OpenAI describe el máximo del modelo como 1M sin decir cómo se mapea en los límites de ventana y entrada de Codex, por lo que opencodex no anuncia más que el techo que puede verificar.

Las mismas palancas `providerContextCaps.openai`, `modelContextWindows` y `modelAutoCompactTokenLimits` se aplican como para Astra. En el OpenAI API (`openai-apikey`), `gpt-6.1-sol` tiene 1.050.000 contextos, 922.000 entradas máximas, 128.000 salidas máximas y esfuerzos `low` a `max`, con un precio de $2 entradas, $0.10 entradas en caché y $10 salidas por 1 millón de tokens (provoca más de 272K billetes a la tasa de contexto largo). GitHub Copilot, OpenRouter, Vercel AI Gateway, Kilo y OpenCode Zen también lo enumeran.

Cuando OpenAI envía un modelo GPT que esta versión aún no conoce, agréguelo a través de config en lugar de esperar una actualización, de la misma manera que un nuevo id Claude pasa a `providers.anthropic.models`:

```json
{
  "providers": {
    "openai": {
      "adapter": "openai-responses",
      "authMode": "forward",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "models": ["gpt-6-nova"]
    }
  }
}
```

Cada una de las `gpt-*` id listadas allí en el proveedor de inicio de sesión Codex aparece como un modelo nativo (aquí **GPT-6-Nova**) con la escalera de razonamiento, el esfuerzo predeterminado y las modalidades de Sol GPT-6.1, un contexto predeterminado de 272,000 tokens y un techo de aceptación de 872,000 tokens. Elevar o estrechar con `modelContextWindows`, por ejemplo `"modelContextWindows": { "gpt-6-nova": 872000 }`. Nunca está cerrado por cuenta: si su cuenta no puede usar el modelo, la solicitud aún se apaga y verá el error de subida. Los identificadores que ya están incorporados se ignoran, y al eliminar un id de la lista se elimina el modelo. Un combo `nativeAlias` no puede apuntar a un identificador configurado.

`gpt-6-astra-minor` (**GPT-6-Astra-Minor**) es una variante inédita de Astra. Está cerrado por cuenta: permanece oculto y las solicitudes se rechazan localmente, hasta que una lista autenticada de Codex para su cuenta lo enumera. Cuando aparece utiliza el contexto, la escalera y las modalidades de Astra.

Consultado el 5 de septiembre de 2026:

| Astra API (USD por millón de tokens) | Entrada | Entrada en caché | Escribir caché | Productos |
| --- | ---: | ---: | ---: | ---: |
| Estándar, hasta 272k de entrada | 10 | 1 | 12.5 | 50 |
| Estándar, por encima de la entrada 272k | 20 | 2 | 25 | 75 |
| Rápido, hasta 272k de entrada | 20 | 2 | 25 | 100 |
| Rápido, por encima de la entrada 272k | 40 | 4 | 50 | 150 |

El [Tabla de precios API](https://developers.openai.com/api/docs/pricing) revaloriza el **Toda la solicitud** por encima de 272k, contando los tokens en caché hacia el umbral. Las tasas de contexto rápido y largo se combinan; esto también se aplica a las filas GPT-5.6 API publicadas y sus selecciones virtuales Pro.

Todas las estimaciones en dólares incorporadas usan **API -precios de referencia**, incluidas las rutas Codex -login. Por lo tanto, Astra y GPT-5.6 usan las mismas tasas de base/caché de API, multiplicador de **2x Rápido** y bandas de contexto largo publicadas en `openai` y `openai-apikey`. Los dos selectores Daybreak Blue siguen la referencia Sol API. Estas son estimaciones de comparación, no facturas o predicciones de saldo crediticio. Las anulaciones explícitas de precios de proveedor/modelo siguen teniendo prioridad.

<a id="provider-namespace-aliases"></a>

## Alias de espacio de nombres de proveedor

Los proveedores pueden exponer una abreviatura incorporada, como `agy` para `google-antigravity`. Un nombre de proveedor configurado o alias explícito afirma que taquigrafía case-insensible; la taquigrafía incorporada de un proveedor diferente se suprime entonces en ambos nombres de catálogo y enrutamiento de alias. Por ejemplo, la configuración de un proveedor llamado `agy` mantiene los modelos de Google bajo `google-antigravity/<model>`, mientras que `agy/<model>` selecciona el proveedor configurado. Los nombres de proveedores canónicos todavía requieren una coincidencia de casos exacta, y los prefijos no reconocidos conservan el respaldo de enrutamiento de modelo existente.

<a id="provider-entries-ocxproviderconfig"></a>

## Entradas de proveedores (`OcxProviderConfig`)

| Campo | Tipo | Descripción |
| --- | --- | --- |
| `adapter` | `string` | Uno de `openai-chat`, `openai-responses`, `anthropic`, `claude-cli`, `google`, `kiro`, `cursor`, `ollama-native`, `azure-openai` (o alias `azure`), `codebuddy`, `qoder`. |
| `baseUrl` | `string` | URL de base ascendente API. La mayoría de los puntos finales fijos incorporados ignoran una falta de coincidencia; los ajustes preestablecidos de clave seguros contra colisiones conservan un destino personalizado con el mismo nombre más antiguo. |
| `proxy?` | `string \| null` | Ruta de salida por proveedor. Omita que herede la decisión de proxy global; use `"direct"` o `null` para forzar la salida directa; o proporcione una URL proxy absoluta `http://`, `https://`, `socks5://` o `socks5h://`. Se rechaza una cadena vacía. |
| `noProxy?` | `string \| string[]` | Destinos a los que este proveedor llega directamente, utilizando la sintaxis de patrón de host `NO_PROXY`. Una coincidencia pasa por alto tanto el propio proxy de este proveedor como un proxy global heredado. |
| `requestPacing?` | `{ enabled, requestsPerMinute?, minIntervalMs?, maxConcurrentRequests?, models?, keySelection?, keys? }` | Indicadores opcionales de inicio de solicitud de salida del lado del cliente, separados del uso ascendente, la facturación y los indicadores de límite de solicitudes. RPM se convierte en un intervalo uniforme; `minIntervalMs` puede imponer un intervalo más largo. `maxConcurrentRequests` es un límite de enteros positivo en las solicitudes en vuelo. Una regla de proveedor o modelo puede usar el límite de concurrencia solo; los límites de proveedor se aplican a todos los modelos, mientras que las entradas `models` usan ID de modelo ascendente exactos (por ejemplo, `nvidia/llama-3.1-nemotron-ultra-253b-v1`) y solo pueden agregar retardo o concurrencia estrecha. Los esperas de cola no consumen el tiempo de espera del encabezado de respuesta ascendente. HTTP y el adaptador explícito `fetchResponse` / `runTurn` despachos están cubiertos. Un giro canónico Responses WebSocket con límite de concurrencia usa HTTP / SSE para que su arrendamiento pueda liberarse cuando el cuerpo de respuesta se complete, se equivoque o se cancele. Para los adaptadores `runTurn`, incluyendo Cursor, el cap cuenta los giros activos en lugar de los envíos físicos: RunSSE y BidiAppend pueden superponerse en un giro, mientras que otro turno espera. Seguimiento envía todavía obedecer intervalos de inicio. |
| `requestPacing.keySelection?` | `"active"`, `"round-robin"` | Selección normal de la tecla de petición. El valor predeterminado `active` conserva la clave guardada y la rotación de fallas existente; `round-robin` distribuye las selecciones locales de solicitud a través de referencias de grupo de claves API elegibles sin cambiar la clave activa guardada. Equilibra las asignaciones, no los tokens o el costo. |
| `requestPacing.keys?` | `{ requestsPerMinute?, minIntervalMs?, maxConcurrentRequests? }` | RPM uniformes por referencia clave, intervalo de inicio mínimo y límites de concurrencia, compartidos entre modelos. Estos componen con el proveedor y el modelo exacto de los límites superiores. Las referencias duplicadas comparten un cubo; las referencias separadas en un proyecto ascendente no implican una cuota independiente. El TPM y las cuotas diarias no se aplican. |
| `upstreamHttpVersion?` | `"auto" \| "http1.1" \| "h1" \| "http2" \| "h2"` | Fije la versión HTTP utilizada para las solicitudes ascendentes a este proveedor. El valor predeterminado es `auto`, lo que permite que Bun negocie. Un pin explícito requiere un objetivo HTTPS y falla localmente cuando no puede ser honrado. Establecer `http1.1` cuando la transmisión HTTP/2 SSE de un proveedor se detiene en lugar de entregar eventos: el síntoma es una solicitud de transmisión de larga duración que no produce nada y, finalmente, expira. Para Cursor, `http1.1` / `h1` selecciona su transporte de compatibilidad `RunSSE` + `BidiAppend` para inferencia y también descubrimiento de modelos en vivo de pines. La gerencia `POST` / `PATCH` acepta `null` para volver a `auto`. |
| `tlsProfile?` | `"antigravity-browser"` | **Usar bajo su propio riesgo.** Opt-in navegador-como TLS apretón de manos (a través de la dependencia opcional `wreq-js`) para el canónico `google-antigravity` OAuth proveedor. Cambia solo cómo se ve la conexión en el cable; no es un cliente oficial Google, y no cambia lo que permiten los términos de Google. Google aún puede detectar, limitar la tarifa, suspender o prohibir la cuenta con la que inició sesión, y solo usted conlleva ese riesgo. Está desactivado por defecto y solo se acepta con el adaptador Google, el modo Cloud Code Assist y los hosts canónicos HTTPS Antigravity de Google. Redirigir manual de estancia. La propia ruta `proxy` / `noProxy` del proveedor es transportada por el transporte TLS; una ruta que no puede mantener falla la solicitud en lugar de salir por otra ruta, que incluye cualquier ruta directa mientras se establece `HTTP_PROXY`, `HTTPS_PROXY` o `ALL_PROXY`. `GET /api/providers` reporta el estado del perfil como `pending`, `active` o `failed`. Omitir el campo mantiene el transporte normal Bun y nunca carga la dependencia. |
| `responsesPath?` | `string` | Ruta de recurso relativa para solicitudes de clave-auth `openai-responses`. Debe comenzar con `/` y no contener esquema, consulta o fragmento. |
| `chatCompletionsPath?` | `string` | Ruta de recurso relativa para `openai-chat` solicitudes, el espejo de `responsesPath` y sujeto a las mismas reglas de forma. Se necesita cuando uno de aguas arriba sirve Chat Completions y Responses bajo diferentes prefijos: una anulación de cable por modelo cambia el adaptador y deja solo `baseUrl`, por lo que sin esto, se enviaría una solicitud de chat opcional a la base Responses. Z.AI es el ejemplo enviado. |
| `allowEncryptedV2AgentTasks?` | `boolean` | Deshabilitado por defecto. Confíe en un proveedor de claves directas `openai-responses` para consumir o retransmitir tareas subagente cifradas opacas V2 sin cambios. Las rutas elegibles omiten `agentTaskRecovery`; todas las demás rutas mantienen la recuperación existente o el comportamiento cerrado por error. OpenCodex no descifra, traduce ni recupera las tareas enviadas a través de esta opción. |
| `projectResponsesLiteHostedSearchHistory?` | `boolean` | Por defecto. Configure el `true` booleano real para optar por este proveedor en la proyección con pérdida del historial de búsquedas alojadas no referenciadas para turnos ordinarios y solicitudes nativas de v2 `compaction_trigger` para que sea exacto canónico ChatGPT Codex `/responses` con intención explícita Responses Lite. Omission o `false` retiene la historia estructural; las cadenas y los números no son válidos. No permite Lite, cambiar el transporte, o afectar v1 `/responses/compact` nativo, público OpenAI API / otros destinos, o la proyección de compactación portátil / enrutado existente. Véase [Historial de búsquedas alojadas Lite](/es/reference/proxy-formats/#codex-native-ordinary-lite-hosted-search-history). |
| `upstreamWebsocket?` | `boolean` | Transporte Responses WebSocket para `openai-responses` solicitudes (falso por defecto). Se honra solo para el flujo ascendente de origen `https://api.openai.com/v1`; los puntos finales de proveedor personalizado siempre usan un límite HTTP / SSE porque Bun no puede imponer un límite de mensaje de entrada WebSocket antes de asignar el mensaje completo. Para el proveedor canónico ChatGPT `openai`, omitiendo que mantiene el WebSocket ascendente en giros elegibles, un `false` explícito envía giros de transmisión sobre HTTP / SSE, y la administración del proveedor rechaza `true`; con `false`, la dirección e inyección nativas a mitad de giro no están disponibles. El campo es independiente de la configuración `websockets` orientada al cliente y no cambia ni el punto final ni la credencial. La llanura HTTP permanece en SSE; las rutas no Responses y las solicitudes `openai-chat` permanecen en HTTP. |
| `supportsServiceTier?` | `boolean` | Repliegue de capacidad rápida canónica tri-estatal. `true` publica Fast en el catálogo, satisface los requisitos de enrutamiento de nivel de servicio, contribuye con una huella dactilar compatible y permite el modo rápido inyectar el valor de cable canónico del proveedor en un adaptador final compatible. `false` arranca el campo y nunca se inyecta, y las declaraciones exactas del modelo no pueden volver a abrirlo. Ausente deja al proveedor sin clasificar: el modo rápido no inyecta ni normaliza un valor canónico de la persona que llama, y los valores de la persona que llama obedecen el permiso de reenvío del cable final (`chatServiceTier` en Chat; passthrough en Responses). El registro clasifica canónico OpenAI (`true`), DeepSeek y Arca Volcengine (`false`); lo puso explícitamente sólo para puertas de enlace personalizadas que realmente soporten niveles. |
| `responseTierAuthoritative?` | `boolean` | Si el nivel de respuesta puede confirmar o denegar Fast. Establezca explícitamente `false` para rutas con metadatos de respuesta no autoritativa; la omisión conserva el comportamiento existente. Esto no habilita Fast o cambia los parámetros de salida. Véase [Autoridad de nivel de servicio de respuesta](#response-service-tier-authority). |
| `fastEnabled?` | `boolean` | Cambio de operador para el carril rápido del proveedor. `false` se apaga rápidamente (sin conmutación rápida, sin fila `--fast`, sin campo de cable rápido) y anula `supportsServiceTier`. `true` habilita un carril de las marcas de registro opt-in. Ausente mantiene el valor predeterminado del registro: desactivado para `anthropic` y `anthropic-apikey`, cuyo modo rápido gasta créditos de uso a un precio 2x, y sin cambios para todos los demás proveedores. La página Modelos del panel de control muestra una fila de Off/On para proveedores de suscripción voluntaria. |
| `modelSupportsServiceTier?` | `Record<string, boolean>` | Capacidad exacta del modelo ascendente anula. El Exact `true` habilita el canonical Fast para ese modelo; el Exact `false` reduce los valores predeterminados del proveedor. Un nivel de proveedor explícito `supportsServiceTier: false` permanece cerrado por error y no se puede reabrir. Exact `true` no autoriza el reenvío de llamadas extranjeras en Chat. Los modelos no declarados vuelven a caer en el comportamiento de todo el proveedor. Administración `PATCH /api/providers` fusiona entradas y acepta `null` para borrar una. |
| `chatServiceTier?` | `boolean` | Chat-wire en todo el proveedor opt-in para el reenvío de llamadas `service_tier` valores. En una ruta clasificada gobierna valores extranjeros como `flex`, no canónica propiedad de proxy Fast después de la validación de la capacidad; en una ruta no clasificada gobierna cada valor de llamada porque no se ha validado ninguna capacidad Fast. La capacidad del modelo exacto no autoriza el reenvío extranjero. Responses rutas conservan su comportamiento de reenvío de llamadas basado en la capacidad. |
| `promptCacheKey?` | `boolean` | Opción de todo el proveedor `openai-chat` para reenviar `prompt_cache_key`. El adaptador reenvía la clave recibida sin inventarla, aunque no siempre procede del cliente: la conversión de Claude Messages obtiene una a partir de `metadata.user_id` o de un grupo de modelo, sistema y herramientas cuando no hay metadatos. Está desactivada por defecto salvo que lo indique el preajuste. Mistral la habilita según su [contrato de caché de instrucciones](https://docs.mistral.ai/studio/conversations/advanced/prompt-caching); un `false` explícito la desactiva. Habilítala solo si el proveedor documenta compatibilidad, porque una pasarela estricta puede rechazar ese campo con HTTP 400. |
| `preserveResponsesReasoningContent?` | `boolean` | Por defecto para los proveedores personalizados. En **Proveedores → Configuración**, habilite **Replay razonamiento de texto plano** para un punto final personalizado Responses solo si acepta este historial. Esto envía un razonamiento previo de texto sin formato a ese punto final y puede aumentar el uso de tokens. Mantenga el contenido de razonamiento de texto plano en los elementos de razonamiento Responses reproducidos en lugar de borrarlo, incluida la entrada compacta nativa personalizada v1 (blanking es la regla del backend ChatGPT). Habilitar para aguas arriba cuyo contrato acepta la repetición de razonamiento, como DeepSeek o un Kimi autoalojado en vLLM. Los sobres `ocxr1` con proxy siempre se eliminan. Un proveedor `openai-responses` configurado manualmente sin él registra una advertencia por host la primera vez que se elimina el razonamiento de texto sin formato. `preserveReasoningContentModels` no afecta a este cable. |
| `preserveResponsesInputItemIds?` | `boolean` | Por defecto. Preservar `input[].id` válido cuando `store: false` para relés de lanzador de confianza explícita que requieren identidad de turno. Responses proveedores ordinarios siguen eliminando las identificaciones; xAI La reparación del ID de llamada personalizada permanece activa. |
| `preserveResponsesMessageMetadata?` | `boolean` | Por defecto. Preservar `internal_chat_message_metadata_passthrough` privado en elementos de entrada para relés de lanzador de confianza explícita, incluidas las solicitudes compactas nativas personalizadas v1. Esto reenvía metadatos privados de turno/sesión a ese destino; no habilite las puertas de enlace ordinarias. |
| `dropResponsesReasoningItems?` | `boolean` | Elimine por completo los elementos Responses `reasoning` reproducidos de la entrada de continuación, incluidas las solicitudes compactas nativas v1 personalizadas, en lugar de reenviarlos con contenido en blanco. Esto es con pérdida: resúmenes, identificadores de ítems y `encrypted_content` van con ellos, por lo que no queda ningún ítem de razonamiento del turno anterior en la entrada reenviada. No elimina `previous_response_id`, por lo que un curso arriba que mantiene su propio estado de giro aún puede alcanzarlo. Habilitar solo para un upstream que rechaza la repetición de razonamiento directamente: el preajuste integrado Volcengine Ark Coding Plan lo establece porque las continuaciones de la herramienta validadas respondieron `400 InvalidParameter` de lo contrario. Establezca a `false` en ese proveedor para reenviar los elementos de razonamiento nuevamente. |
| `disabled?` | `boolean` | Mantenga el proveedor en el disco, pero excluya el enrutamiento y los listados de modelos/catálogos. |
| `apiKey?` | `string` | API clave, una referencia `${ENV_VAR}` / `$ENV_VAR`, o una referencia `keychain:<provider>` escrita por `ocx provider keychain <name> store`. Las referencias se resuelven en el momento de la solicitud. Véase [Almacenar claves en el llavero del sistema operativo](/es/reference/configuration/keychain/). |
| `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Anthropic estilo de encabezado de clave. Predeterminados a `x-api-key` nativos; válido solo para proveedores de llave-auth `anthropic`. |
| `apiKeyPool?` | `ApiKeyPoolEntry[]` | Grupo de varias claves. `apiKey` refleja la entrada activa; cada elemento tiene `id`, `key`, `label` opcional y `addedAt` numérico opcional. |
| `apiKeyPoolStrategy?` | `"round-robin" \| "fill-first" \| "quota"` | Cómo se elige una llave caliente **antes** el primer intento cuando la llave comprometida ya se está enfriando. Omitido mantiene la rotación reactiva solamente: el grupo se mueve después de un 429 o 401 y no antes. `round-robin` toma la siguiente clave en el grupo, `fill-first` mantiene la primera elegible, y `quota` prefiere la clave con el mayor margen restante, cayendo a `fill-first` para un proveedor cuya cuota por clave es desconocida. Una clave comprometida saludable nunca se anula, por lo que se mantiene una selección manual de la clave. |
| `defaultModel?` | `string` | Modelo utilizado cuando se selecciona este proveedor sin un modelo explícito. |
| `models?` | `string[]` | Lista de modelos de semillas/retroceso. Con `liveModels: false`, una lista `models` no vacía es seguida por `retainModels`; una lista `models` vacía u omitida en su lugar siembra `defaultModel` (si está configurada), luego `retainModels`, eliminando los ID duplicados en el orden primero visto. |
| `liveModels?` | `boolean` | Busca el catálogo en vivo en start/sync (por defecto `true` ). Los proveedores personalizados usan `${baseUrl}/models`; los complementos pueden usar una URL y un filtro de registro. |
| `selectedModels?` | `string[]` | Catálogo allowlist después del descubrimiento. No vacía expone solo esos ids; vacía u omitida expone todos los modelos descubiertos. |
| `retainModels?` | `string[]` | Los identificadores se mantienen en el catálogo incluso cuando el descubrimiento en vivo los omite. No necesitan repetirse en `models`. Vacío u omitido mantiene el comportamiento de hoy. |
| `modelDisplayNames?` | `Record<string, string>` | Etiquetas persistentes de presentación, indexadas por el ID exacto que usa el proveedor. Tienen prioridad sobre los metadatos del catálogo y sobreviven a las actualizaciones de descubrimiento y edición. No cambian la autenticación, el adaptador, la facturación, la construcción de solicitudes, el selector enrutado `provider/model` ni el ID enviado de un modelo ya conocido. Hay una excepción de enrutamiento: si un selector directo `provider/model` no coincide con ningún ID, alias o ID de `retainModels` conocido (por ejemplo, mientras el catálogo en vivo aún no se ha cargado), una clave cuyo formato codificado coincida se envía como ID nativo. Las claves distinguen mayúsculas y minúsculas; los ID desconocidos se conservan para aplicarles su etiqueta si vuelven a aparecer. Se admiten como máximo 2.000 entradas, igual que el límite de descubrimiento. |
| `contextWindow?` | `number` | Valor de contexto alternativo para todo el proveedor si faltan metadatos; si existen, actúa como un tope que conserva los valores menores del proveedor. Los valores del registro no pueden superar un límite configurado inferior; las entradas explícitas de `modelContextWindows` tienen prioridad. La página Modelos lo muestra separado de `providerContextCaps`. |
| `modelContextWindows?` | `Record<string, number>` | Por-modelo contexto fallbacks/caps. Estos anulan `contextWindow`: una ventana desconocida utiliza el valor configurado, mientras que los metadatos en vivo más pequeños siguen siendo autorizados. |
| `inferContextWindow?` | `boolean` | Solo proveedores personalizados, por defecto desactivado. `true` llena una ventana faltante de metadatos de ID de modelo agrupados ([detalles](#context-windows-on-custom-providers)); el valor es una estimación, no una capacidad de retransmisión verificada. |
| `modelContextTiers?` | `Record<string, "default" \| "long_context">` | Por modelo de nivel ascendente para `github-copilot`. `long_context` envía `contextTier: "long_context"`. Los metadatos del catálogo crecen solo con un valor exacto por modelo `modelContextWindows` que documenta la ventana compatible; ese valor gana antes de la limitación del proveedor. Un modelo desconocido mantiene su ventana observada. Las solicitudes passthrough no configuradas retienen un campo `contextTier` suministrado por el llamante en cualquier proveedor. |
| `modelInputModalities?` | `Record<string, string[]>` | Sugerencias de entrada por modelo, como `["text"]` o `["text", "image"]`. |
| `modelMaxInputTokens?` | `Record<string, number>` | Límites de entrada máximos positivos por modelo utilizados para las sugerencias de autocompactación del catálogo. |
| `modelAutoCompactTokenLimits?` | `Record<string, number>` | Presupuestos de autocompactación suaves positivos por modelo. Los valores solo pueden reducir la envolvente efectiva del 90% de contexto/entrada máxima y se omiten cuando no se resuelve ninguna ventana de contexto. Para el canónico `openai`, las claves deben ser IDs de modelo nativos compatibles exactos sin prefijos de proveedor o selector de cuenta. El proveedor PATCH combina entradas; establece una clave en `null` para eliminarlo o todo el campo en `null` para borrar el mapa. Estas `null` lápidas son sólo de pátch. |
| `minMaxOutputTokens?` | `number` | Piso entero positivo opcional para presupuestos `max_output_tokens` positivos explícitos en rutas `azure-openai` / `azure` Responses. Desactivar conserva la tapa de la persona que llama. Configurarlo autoriza el aumento de un límite más pequeño, lo que puede aumentar el uso de salida. Los presupuestos de solicitudes omitidas o no válidas no se modifican. |
| `defaultMaxOutputTokens?` | `number` | En todo el proveedor `openai-chat` reserva cuando el cliente omite `max_output_tokens`. |
| `modelMaxOutputTokens?` | `Record<string, number>` | Presupuestos de respaldo positivos por modelo `openai-chat`; las coincidencias exactas / patrón superan al predeterminado del proveedor. |
| `modelCosts?` | `Record<string, ProviderCostOverlay>` | Precios de visualización por modelo (USD por tokens de 1 millón), tecleados por el ID de modelo ascendente exacto de ese proveedor, no un identificador de proveedor o una etiqueta `provider/model` enrutada, p. `{ "deepseek-v4-flash": { "input": 0.14, "output": 0.28, "cacheRead": 0.0028, "cacheWrite": 0 } }`. Cualquier ID de modelo es una clave válida: los proveedores personalizados pueden apuntar a cualquier punto final compatible con OpenAI a través del adaptador `openai-chat`, y los ID de proveedores locales o internos funcionan incluso cuando están ausentes de los catálogos incorporados. Los precios configurados por el usuario ganan sobre los catálogos incorporados en los registros `~$` y las estimaciones de uso; las entradas históricas se revaloran desde la superposición actual, por lo que editar un precio puede pasar de los totales. La orden de reserva es el usuario `modelCosts` → corrección oficial exacta → catálogo → precio esperado superposición → vendedor nivel de modelo de reserva, y una entrada de usuario explícita de todo cero significa una estimación de cero conocido; borrar esa entrada de modelo para restaurar la fijación automática de precios. Los metadatos de catálogo de todo cero todavía fallan. Cada tasa debe ser un número finito no negativo como máximo 1.000.000 (USD por 1M tokens); las filas fuera de rango son rechazadas por el límite de administración y se eliminan en la carga. Estimación del tiempo de visualización solamente: las superposiciones nunca afectan el enrutamiento, la selección de cuentas, las cuotas o la facturación. |
| `headers?` | `Record<string, string>` | Cabeceras adicionales para el proveedor. Se rechazan las de autorización, cookies y claves API, los saltos de línea y los nombres inválidos. Las solicitudes que usan el transporte de salida del proveedor, como descubrimiento de modelos, pruebas de conexión y diagnósticos como la consulta show de Ollama, envían `User-Agent: opencodex` salvo que el operador o el preajuste establezcan otro User-Agent. Un relé experimental puede negociar la entrega anticipada de herramientas completadas mediante `x-opencodex-tool-completion: block-stop-v1`. El entorno que lo integra debe aportar un registro autenticado y persistente de las llamadas que pertenecen a cada turno; el relé debe confirmar la misma cabecera en su respuesta e implementar marcadores exactos de finalización vinculados a cada llamada. Déjala sin configurar en otros proveedores. La entrega anticipada solo se aplica a llamadas estructuradas que cumplan los requisitos; los errores o cancelaciones posteriores no pueden retirar una llamada ya entregada. |
| `forwardClientHeaders?` | `string[]` | `openai-responses` only: opte por copiar encabezados de metadatos de clientes entrantes en solicitudes de inferencia cuando el proveedor aún no ha establecido ese encabezado. Credenciales y nombres de propiedad del transporte, tales como `Authorization`, cookies, encabezados de claves API, `Content-Type`, `Content-Length`, `Host`, y `x-oai-attestation` son rechazados y también filtrados en entorno de ejecución. Los nombres de encabezado son insensibles a mayúsculas y minúsculas y no pueden repetirse. `headers` sigue siendo autoritativo; el llamador existente `User-Agent` La reserva todavía se aplica cuando ninguna superficie pone uno. Nombres soportados: `originator`, `x-client-request-id`, `x-codex-app-version`, `user-agent`Todos los demás nombres son rechazados. |
| `supportsNativeCompactionTrigger?` | `boolean` | Solo `openai-responses`: declara soporte para elementos de entrada nativos v2 `compaction_trigger`. Predeterminados para puertas de enlace no canónicas; preserva la compactación nativa en lugar de solicitar un resumen de texto portátil. Independiente de las capacidades de reproducción de v1 y blob. |
| `supportsNativeCompactEndpoint?` | `boolean` | `openai-responses` solamente: declara soporte para v1 nativo `POST /responses/compact`. Predeterminados desactivados para puertas de enlace personalizadas. Las rutas clave/local/directas usan el URL Responses del proveedor más `/compact` y su autenticación de transporte normal; OAuth mantiene la compactación enrutada y su ciclo de vida de credenciales existente. No habilita los disparadores v2 ni otorga la identidad oficial OpenAI. |
| `decodesNativeCompactionBlobs?` | `boolean` | Declare que este destino puede reproducir blobs de compactación nativos, no `ocx1:`. Independientemente de cualquier capacidad de generación; un desajuste de proveedor de servicio conocido todavía degrada el texto cifrado extraño. Habilite solo después de probar el compacto y una vuelta posterior en el mismo backend. |
| `openRouterRouting?` | `OpenRouterProviderRouting` | Predeterminado OpenRouter `order`, `only` y `allowFallbacks` preferencias; válido sólo para canónica OpenRouter con `openai-chat`. |
| `modelOpenRouterRouting?` | `Record<string, OpenRouterProviderRouting>` | El identificador de modelo exacto reemplaza la preferencia OpenRouter de todo el proveedor. |
| `vercelGatewayRouting?` | `VercelGatewayRouting` | Preferencias predeterminadas de Vercel AI Gateway `order`, `only` y `sort` (`"cost"` + `"ttft"` + `"tps"`); válidas solo para la puerta de enlace canónica de Vercel AI con `openai-chat`. |
| `modelVercelGatewayRouting?` | `Record<string, VercelGatewayRouting>` | El ID de modelo exacto reemplaza la preferencia de Vercel AI Gateway para todo el proveedor. |
| `authMode?` | `"key" \| "forward" \| "oauth" \| "local"` | Modo de autenticación (por defecto `key` ). OAuth /las credenciales de suscripción se almacenan fuera de `config.json`; `local` se limita a los proveedores cuya entrada en el registro lo permita. |
| `codexAccountMode?` | `"pool" \| "direct"` | Canonical `openai` solamente; valores predeterminados a Pool. Direct evita el estado del grupo. |
| `refreshPolicy?` | `"proactive" \| "lazy-only" \| "disabled"` | Anule la política de Token Guardian de este proveedor OAuth. |
| `reasoningEfforts?` | `string[]` | Etiquetas de razonamiento Codex para todo el proveedor para anunciar y enviar. Para los proveedores de adaptadores `google`, una escalera configurada también afirma la capacidad `thinkingLevel`: las solicitudes directas y de no imagen de Vertex envían el esfuerzo seleccionado como `generationConfig.thinkingConfig.thinkingLevel`, mientras que Cloud Code Assist utiliza su ruta específica de envolvente. |
| `modelReasoningEfforts?` | `Record<string, string[]>` | Etiquetas por modelo. Una lista vacía oculta el control del esfuerzo. Al igual que con `reasoningEfforts`, cada una configurada `google` -adaptador de la escalera afirma `thinkingLevel` capacidad; directa y Vertex solicitudes de no imagen utilizan el plano Gemini ruta, mientras Cloud Code Assist envía bajo su petición envolvente. Un adaptador que envía su propia tabla por modelo (actualmente `command-code`) permite que esa tabla gane en el cable para los modelos que conoce, así que ajuste `modelReasoningEffortsAuthoritative` también para ampliar dicha fila. |
| `modelReasoningEffortsAuthoritative?` | `boolean` | Trate el `modelReasoningEfforts` de este proveedor como autorizado en el cable, no solo en el catálogo. Sin él, un adaptador que envía su propia tabla de esfuerzo por modelo (actualmente `command-code`) anuncia su escalera ensanchada en el selector y luego quita el peldaño adicional al salir. Es opt-in porque los ajustes preestablecidos se siembran con la tabla enviada, por lo que una fila almacenada por sí sola no puede probar que la escribió en lugar de una versión anterior. Con él establecido, un peldaño que el flujo ascendente rechaza se devuelve como ese error en lugar de volver a intentarlo en silencio sin el esfuerzo, lo pediste, por lo que ves la respuesta. |
| `modelSuppressSyntheticMax?` | `Record<string, boolean>` | Interruptor por modelo solo para catálogo. `true` evita que OpenCodex agregue un peldaño `max` sintético faltante mientras retiene un `max` declarado por el proveedor y continúa agregando `ultra` a las escaleras con capacidad de razonamiento. Una fila conservada que ya contiene `max` lo mantiene hasta que el descubrimiento saludable reconstruye esa fila, porque el catálogo no persiste si un `max` más antiguo era sintético. Si un valor predeterminado configurado nombra un `max` suprimido que falta, el catálogo vuelve al peldaño real más alto debajo de él. Codex utiliza la misma membresía de escalera para el selector y la validación explícita del esfuerzo `spawn_agent`, por lo que una creación explícita de subagente con `max` puede fallar en el lado del cliente antes de la sujeción proxy; `ultra` sigue siendo el camino de arnés soportado. |
| `modelSupportsReasoningSummaries?` | `Record<string, boolean>` | Establezca un modelo en `false` para detener los resúmenes de publicidad y los campos de entrega de resumen de tira. |
| `modelReasoningSummaryDelivery?` | `Record<string, "sequential" \| "sequential_cutoff" \| "concurrent" \| "concurrent_cutoff">` | Enum de entrega por modelo Responses; reescribe un campo de entrega existente. |
| `modelAdapters?` | `Record<string, string>` | Cambia por modelo entre `openai-chat` y `openai-responses` en pasarelas que admiten ambos protocolos. Las entradas explícitas prevalecen sobre el registro. OpenCode Go selecciona Responses para `gpt-5.6-luna` y mantiene el protocolo documentado de los demás modelos. DeepSeek puede usar Responses nativo para `deepseek-v4-flash`. Alibaba Token Plan (Pekín) fija `qwen3.8-flash`, `qwen3.7-plus` y `glm-5.3` a su API Responses nativa solo para solicitudes entrantes de Responses, verificada en esa pasarela incluida la reproducción de razonamiento en texto plano; Chat y Anthropic mantienen Chat, y el resto de la familia puede activarse aquí. GitHub Copilot usa exclusivamente Responses de forma predeterminada para `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-astra`, `grok-4.5`, `grok-4.6`, `mai-code-1.1-flash` y `mai-code-1-flash-picker`, porque rechazan `/chat/completions` para tráfico de agentes. Los modelos sin predeterminado incorporado, como `gpt-5.4-nano`, pueden activarse aquí. Los proveedores fijados a un solo protocolo y el reenvío canónico a ChatGPT rechazan las anulaciones. |
| xAI Chat Completions (tablero / CLI) | interruptor | Grok 4.5/4.6 OAuth Responses solicita predeterminado Responses. Las anulaciones de chat existentes se migran una vez en la actualización; las opciones de chat posteriores se conservan. Encender para seleccionar Chat para ambos modelos, apagar para seleccionar Responses. CLI: `ocx provider edit xai --xai-chat on` o `--xai-chat off` (correr proxy requerido). Mixto significa que solo un modelo utiliza actualmente Chat. Otras anulaciones y políticas de nivel permanecen sin cambios. API -key y Chat/ Anthropic traducido no se modifican. Grok 4.7 se establece por defecto en Responses en OAuth a través de su cable de registro predeterminado y puede usar Chat a través de una anulación explícita de `modelAdapters["grok-4.7"] = "openai-chat"`. |
| `xaiResponsesXSearch?` | `boolean` | Deshabilitado por defecto. En un xAI Responses destino, añade el proveedor alojado `x_search` declaración solo cuando una vida `web_search` La herramienta sobrevive a la normalización de la solicitud final. Las declaraciones existentes no están duplicadas, llamante `tool_choice`/`allowed_tools` Los selectores nunca se amplían, y esto está separado del sidecar de la búsqueda web. `search.xSearch` opciones. |
| `modelPreferHostedTools?` | `Record<string,string[]>` | Opción de modelo exacto para puertas de enlace Responses no directas que reservan un espacio de nombres de herramienta alojada. Actualmente solo acepta `["image_generation"]`; un modelo coincidente debe usar el `openai-responses` cable y soporte de esa herramienta alojada. Elimina el cliente en colisión `image_gen` declaraciones y reescribe sus selectores para preservar la elección de la herramienta de llamadas. Para OpenAI virtual API `-pro` modelos, el ID público seleccionado se empareja primero y el ID de modelo de cable base resuelto es un respaldo. `modelAdapters` primero resuelve el ID público, luego el ID base; la segunda resolución determina el cable final. Otros modelos conservan el comportamiento normal de alias. |
| `annotateEmptyToolOutputs?` | `boolean` | Reemplace un resultado de herramienta presente pero vacío con un marcador corto antes de que llegue al modelo, de modo que un resultado en blanco no se lea como faltante. Se aplica a cadenas en blanco y matrices de partes de solo texto; nunca se tocan imágenes, archivos y partes cifradas. Predetermina a `true` para DeepSeek desde el registro integrado y no se establece de otro modo. Establecer `false` para excluir a un proveedor - un `false` explícito se conserva en ediciones posteriores que omiten el campo. `PATCH /api/providers?name=<provider>` acepta `true`, `false` o `null` para borrar la anulación y volver al comportamiento predeterminado del registro. |
| `promoteAdditionalTools?` | `boolean` | Controla si los elementos `additional_tools` de Codex Desktop se convierten en declaraciones `tools` de nivel superior y se retira su envoltorio de `input`. Se activa automáticamente para OpenCode Go y xAI (`api.x.ai` y `cli-chat-proxy.grok.com`), salvo con `authMode: "forward"`, donde requiere `true` explícito. Otros gateways estrictos de terceros compatibles con OpenAI que devuelvan HTTP 422 por tipos de elemento desconocidos en `input` pueden activarlo aquí. `PATCH /api/providers?name=<provider>` acepta un booleano o `null` para borrar la opción. |
| `unsupportedHostedTools?` | `string[]` | La herramienta alojada declara que este destino Responses rechaza, por lo que se eliminan de `tools`, desde el cliente-cargado `additional_tools`, y desde `tool_choice` En lugar de ser reenviado y rechazado de origen. Utilícelo para una puerta de enlace compatible con OpenAI con un conjunto de capacidades más estrecho — que acepte solicitudes simples Responses y `function` herramientas, pero devuelve HTTP 400 para alojado `web_search` — para que un mensaje de solo texto no falle por una capacidad que nunca necesitó. Acepta solo nombres de tipo de herramienta alojados (`web_search`, `web_search_preview`, `file_search`, `computer_use_preview`, `computer_use`, `code_interpreter`, `image_generation`, `image_gen`, `mcp`, `tool_search`, `local_shell`, `x_search`); un nombre no reconocido es rechazado en lugar de silenciosamente ignorado. Las variantes de ortografía de una capacidad se aliased, así que `["web_search"]` También niega `web_search_preview`. Un proveedor no puede negar una herramienta alojada aquí y preferirla en `modelPreferHostedTools`. Xiaomi MiMo Responses destinos (`xiaomimimo.com` y sus subdominios, incluyendo `api.xiaomimimo.com` y `token-plan-cn.xiaomimimo.com`) automáticamente tira `web_search` y `web_search_preview` conservando las herramientas de función; no se necesita ninguna declaración para estos hosts. Esto es independiente de `supportsResponsesCustomTools`; establece ambos para una puerta de enlace que también rechaza las herramientas personalizadas nativas. `PATCH /api/providers?name=<provider>` Acepta una matriz o `null` No lo puedo evitar. |
| `reasoningEffortMap?` | `Record<string, string>` | Alias de cable de todo el proveedor para etiquetas de razonamiento. Asignar una etiqueta a `"__omit__"` para eliminar el campo de razonamiento de la solicitud aguas arriba por completo: `reasoning_effort` en un cable compatible con OpenAI, y el campo nativo `think` de Ollama en el adaptador nativo Ollama (#2356). |
| `modelReasoningEffortMap?` | `Record<string, Record<string, string>>` | Alias de cable por modelo para etiquetas de razonamiento. Asignar una etiqueta a `"__omit__"` para eliminar por completo el campo de razonamiento de la solicitud ascendente. |
| `reasoningWireFormat?` | `"gateway-object"` | Para pasarelas compatibles con OpenAI que aceptan `reasoning: { enabled, effort }` en lugar de `reasoning_effort`. En destinos Responses personalizados también autoriza explícitamente la extensión OCX `reasoning.enabled`; los demás destinos Responses eliminan ese campo interno. Declarar que el modelo puede razonar no activa este formato. ClinePass lo configura automáticamente. Si se conserva el destino al guardar el proveedor, se conserva el ajuste; consulta [Qué conserva un guardado](#what-a-provider-save-keeps). `PATCH` acepta `"gateway-object"` o `null` para borrarlo. |
| `noReasoningModels?` | `string[]` | Modelos que rechazan los parámetros de razonamiento/pensamiento. |
| `noTemperatureModels?` | `string[]` | Modelos que rechazan el `temperature` especificado por la persona que llama. |
| `noTopPModels?` | `string[]` | Modelos que rechazan el `top_p` especificado por la persona que llama. |
| `noStopModels?` | `string[]` | Modelos que rechazan el `stop` especificado por la persona que llama. El adaptador `openai-chat`, el paso de Chat y el paso de Responses omiten el campo para esos identificadores. El preajuste incorporado `xai` enumera sus modelos de razonamiento (`grok-4.7`, `grok-4.6`, `grok-4.5`, `grok-4.3`, `grok-4.20-multi-agent-0309`, `grok-4.20-0309-reasoning`, `grok-build-0.1`), que xAI lo rechaza; `grok-4.20-0309-non-reasoning`, `grok-composer-2.5-fast` mantener llamante `stop`. |
| `noPenaltyModels?` | `string[]` | Modelos que rechazan penalizaciones de presencia/frecuencia. El preajuste `xai` incorporado enumera sus modelos de razonamiento (`grok-4.7`, `grok-4.6`, `grok-4.5`, `grok-4.3`, `grok-4.20-multi-agent-0309`, `grok-4.20-0309-reasoning`, `grok-build-0.1`), que xAI documentos como rechazarlos; los identificadores no razonadores mantienen las sanciones de la persona que llama. |
| `noStructuredOutputModels?` | `string[]` | ID de modelo exactos cuyo punto final `openai-chat` rechaza `response_format`. Solo una coincidencia exacta del modelo solicitado omite el campo; la traducción de salida estructurada permanece habilitada para cada otro modelo `openai-chat`. |
| `noJsonSchemaModels?` | `string[]` | ID de modelo exactos cuyo punto final `openai-chat` rechaza un `json_schema` `response_format` pero aún acepta `json_object`. Tal solicitud se degrada a `json_object` en lugar de ser descartada, por lo que una persona que llama por JSON todavía obtiene JSON. `noStructuredOutputModels` gana cuando un modelo está en ambas listas. Los presets `opencode go` y `opencode zen` envían esto para sus rutas DeepSeek. |
| `foldDeveloperRoleToSystem?` | `boolean` | Indica si un destino `openai-chat` admite el rol `developer`. Si se omite `foldDeveloperRoleToSystem`, se envía `system`; con `true`, se envía `system`; con `false`, se envía `developer`. Omitirlo significa que todavía no se ha registrado el comportamiento del destino; `true` indica que rechaza el rol y `false` que lo acepta. Salvo que se active la [compatibilidad con un único mensaje de sistema inicial](/es/guides/lm-studio/) mediante `singleLeadingSystemMessage`, el mensaje conserva su posición y solo cambia el rol. Un destino incompatible responde `400 role 'developer' is not allowed` antes de comenzar el turno, por lo que la opción no registrada usa el rol de sistema. Guardar en el mismo destino conserva el ajuste omitido; consulta [Lo que conserva un guardado de proveedor](#what-a-provider-save-keeps). `PATCH` acepta un booleano o `null` para borrarlo. |
| `omitReasoningEffortWithToolsModels?` | `string[]` | ID de modelo exactos `openai-chat` que aceptan un campo de esfuerzo de razonamiento en un turno ordinario pero lo rechazan una vez que las herramientas de función están presentes. El modelo mantiene su escalera de esfuerzo anunciada; OpenCodex omite el campo de cable solo para solicitudes de soporte de herramientas y se aplica el valor predeterminado ascendente. Más estrecho que `noReasoningModels`, que quita el razonamiento de cada solicitud y le cuesta al modelo su selector por completo. Un proveedor de guardar que mantiene el destino lo mantiene; ver [Lo que un proveedor guarda](#what-a-provider-save-keeps). |
| `parallelToolCalls?` | `boolean` | Alternar las llamadas de herramientas paralelas. OpenAI Chat está activado por defecto; los adaptadores que no son de chat solo se anuncian en `true` explícito. |
| `terminalContinuationGuard?` | `boolean` | Opte por un proveedor `openai-chat` a una re-pregunta interna limitada cuando un giro accionable anuncia el trabajo, luego se detiene limpiamente sin una llamada de herramienta. Por defecto a `false`; explícito `false` se comporta como omisión. Se excluyen los intentos combinados y los giros de compactación enrutados, y los adaptadores que no son `openai-chat` ignoran esta opción. |
| `responsesItemIdRepair?` | `{ message?: string[]; reasoning?: string[]; repairMissingTerminalIds?: boolean; repairInvalidIds?: boolean }` | Deshabilitado por defecto aguas abajo SSE reparación para ids de marcador de posición exacto, ids de terminal faltantes, y (con `repairInvalidIds` ) mensaje / ids de razonamiento faltantes el prefijo canónico `msg_` / `rs_`. Los identificadores de llamada de función nunca se reescriben. El DeepSeek incorporado habilita los dos últimos por defecto. |
| `responsesSnapshotRepair?` | `boolean` | Deshabilitado por defecto de cara al cliente de reparación para escasa Responses instantáneas del ciclo de vida en SSE y JSON. Rellena el estado canónico faltante, la salida y los metadatos de la herramienta, mientras que la inspección en bruto y la persistencia permanecen sin cambios. |
| `messagePhaseInference?` | `boolean` | Desactivado por defecto. En streams Responses de paso directo, infiere las fases de mensaje ausentes al completarlo: otro evento de protocolo posterior determina `commentary`; un evento terminal o `[DONE]`, `final_answer`. Conserva las fases explícitas commentary/final_answer; infiere valores nulos o desconocidos igual que los ausentes. Los keepalives no determinan la fase. Las instantáneas completed/incomplete reutilizan la decisión por elemento si no tienen fase. El texto se sigue transmitiendo mientras la finalización del mensaje espera su clasificación. El estado retenido usa el presupuesto de traducción de la solicitud. También se aplica al JSON reconstruido desde SSE del proveedor; el JSON ordinario del proveedor no cambia. |
| `webSearchBridge?` | `{ enabled?: boolean; backend?: "ollama" \| "openai" \| "anthropic" \| "xai" \| "gemini" \| "exa"; maxSearches?: number; timeoutMs?: number; endpoint?: string }` | Key-auth `openai-responses` solo proveedores de pases. Desactivado por defecto. Codex siempre declara la herramienta `web_search` alojada, y el paso a través la retransmite en el supuesto de que el destino la ejecute. Una puerta de enlace que no ejecuta respuestas de búsqueda alojadas con un `function_call` llamado `web_search` que no se ejecuta, y el guardia de herramientas no declaradas termina el turno. Con `enabled: true` y un `backend` OpenCodex explícito intercepta esa llamada, ejecuta la búsqueda en sí misma, devuelve el resultado al mismo flujo ascendente y muestra Codex una celda `web_search_call` alojada. Nunca armado para `authMode: "forward"` (ChatGPT ya busca) o para un proveedor que ejecuta la búsqueda alojada aguas arriba. `backend` es necesario; no hay un valor predeterminado implícito y una credencial faltante para el backend nombrado deja el puente desarmado en lugar de caer a través de otra búsqueda pagada. `ollama` reutiliza la tecla API de este proveedor en `POST <origin>/api/web_search`, por lo que el origen debe ser `https://ollama.com` a menos que el operador nombre `endpoint` explícitamente. `openai` / `anthropic` / `xai` / `gemini` / `exa` reutilizar el ejecutor sidecar coincidente y que propia credencial del ejecutor (`webSearchSidecar.exaApiKey` para Exa). El modelo de búsqueda viene de `webSearchSidecar.model` solo cuando `webSearchSidecar.backend` resuelve el mismo nombre de este puente; de lo contrario, el puente ejecuta el propio valor predeterminado de ese backend, porque un modelo elegido para un proveedor es rechazado por otro. Un unset `webSearchSidecar.backend` resuelve a `openai`, así que un modelo unset-backend alcanza un puente `openai` y ningún otro. No hay anulación del modelo de puente por proveedor. Streaming de giros solamente. Un turno que mezcla `web_search` con otra llamada de herramienta de cliente aún falla en cerrar en lugar de dejar caer la llamada del cliente. No se ejecuta texto auxiliar como prosa XML-like `<web_search>`. Valores predeterminados: `maxSearches: 3` (1..10), `timeoutMs: 60000` (1000..600000). |
| `retryOn429?` | `{ enabled?: boolean; attempts?: number; intervalMs?: number; maxIntervalMs?: number; respectRetryAfter?: boolean }` | Solo proveedores con clave API (`authMode: "key"`). Reintenta el mismo destino ante un 429. Ausente significa desactivado, salvo OpenCode Go y Command Code oficiales con clave, y Mistral `openai-chat` oficial: usan seis repeticiones, intervalo de diez segundos y límite de espera de 60 segundos. El objeto habilita la opción salvo `enabled: false`, que también desactiva esos valores especiales. Ante un 429, espera `Retry-After` o el intervalo fijo y repite la misma solicitud con la misma clave antes de cambiarla, en el bucle principal de texto, paso directo de Responses, puentes de imágenes y video, sidecar de búsqueda y continuaciones finales. Solo admite HTTP 429 antes del streaming; los transportes `runTurn` personalizados quedan fuera. `attempts` cuenta las repeticiones tras el primer 429: envíos totales = `attempts` + 1. Es un presupuesto compartido por toda la solicitud. Agotarlo detiene esas repeticiones; se aplica después el cambio de clave o el error final según los destinos disponibles. El paso directo autenticado con clave no cambia de destino y devuelve el 429. Para Mistral Chat oficial, un plazo explícito superior al permitido detiene la repetición con esa clave, aunque otra del grupo todavía puede servir, y devuelve el `Retry-After` original. Otros proveedores mantienen la espera acotada. Mistral comparte plazos por credencial y modelo salvo `requestPacing.enabled: false` o `retryOn429.respectRetryAfter: false`. Un 429 con presión válida sobre el presupuesto por minuto y sin plazo activa una espera conservadora de 60 segundos y después una sola consulta de prueba; si funciona, vuelve el tráfico normal. El tráfico correcto no predice el costo de la consulta siguiente. La política usa los límites anunciados, excluye cuotas mensuales conocidas como agotadas, no afirma una hora exacta de restablecimiento y nunca inicia compactación. Codex no reintenta por sí mismo los 429. Valores predeterminados: `enabled: true`, `attempts: 3`, `intervalMs: 5000`, `maxIntervalMs: 60000` (cada espera se limita a `maxIntervalMs`, acotado a 600000), `respectRetryAfter: true`. |
| `transientRetryOn5xx?` | `{ enabled?: boolean; attempts?: number }` | Key-auth `openai-chat` y `openai-responses` proveedores solamente. `authMode: "forward"` proveedores (el grupo de cuentas ChatGPT) nunca leyó esta opción y mantiene la escalera predeterminada. Reintento de reintento para estados ascendentes transitorios previos a la corriente (500, 502, 503, 504, 520, 521, 522): medios ausentes desactivados, la presencia del objeto lo habilita a menos que `enabled: false`. Cubre la solicitud inicial Responses, el carril de paso Responses y cada una de sus patas de recuperación (reproducción OAuth-401, reproducción 429 del mismo objetivo, reconstrucción validada), la continuación de terminal-guardia y `/v1/chat/completions` nativo. `attempts` es el número TOTAL de envíos ascendentes permitidos para una solicitud, incluida la primera (1..10, por defecto 3): es un presupuesto compartido con la recuperación de reinicio de conexión, por lo que `3` significa que como máximo tres solicitudes reales llegan al proveedor. En el carril de paso Responses, el valor configurado se cruza adicionalmente con la asignación de envío de toda la solicitud, por lo que un valor por debajo de esa asignación estrecha la escalera exactamente mientras que un valor por encima de ella no eleva el límite. Cada objetivo Combo incluye su primer envío prepagado en el total configurado de ese objetivo; `attempts: 1` envía una vez, sin reembolsar la reserva o ampliar el límite combo compartido. Una negativa o cancelación local antes del envío libera una reserva no enviada. Las Esperas usan un retroceso exponencial fijo de 400 ms limitado a 5 s y honor `Retry-After`. Separado de `retryOn429`, que maneja la limitación de velocidad; los fallos de mid-stream nunca se reproducen. |
| `retryOnReset?` | `{ enabled?: boolean; replacements?: number }` | Nativo `openai-responses` proveedores, incluyendo `authMode: "forward"`, además de genérico traducido Responses despacho antes de cabeceras ascendentes. Reemplazo opt-in de un envío que falló mientras la persona que llamó no había observado nada: ausencia de medios desactivados, presencia de objetos lo habilita a menos que `enabled: false`. Cubre ambas etapas ambiguas: una conexión que murió antes de cualquier encabezado de respuesta y un cuerpo SSE que murió después del encabezado mientras solo llevaba eventos de control. Un ChatGPT canónico corriente arriba WebSocket que se cerró o se equivocó después de su marco de creación a la izquierda, antes de cualquier evento Responses, se cubre de la misma manera, y su reemplazo se envía sobre HTTP. Solo se reemplaza una solicitud autónoma: `store: false`, `input`, `previous_response_id`, `conversation` o `stream_id`, y solo herramientas ejecutadas por el cliente. `replacements` es el número de envíos de reemplazo UNA solicitud lógica puede hacer a través de cada pierna y cada niño combinado (1...2, por defecto 1) - no un recuento de reintentos por pierna y no un presupuesto de envío, por lo que un reemplazo todavía tiene que caber dentro de la asignación de envío que la pierna ya tenía. Una solicitud que ya ha emitido una salida o una llamada a una herramienta nunca se reemplaza, cualquiera que sea el valor establecido. La inferencia de reemplazo aún puede facturarse si el origen ya había comenzado el primero, por lo que está desactivado por defecto. El despacho traducido genérico admite el reemplazo de reinicio previo a la cabecera para los envíos iniciales y reconstruidos bajo el mismo presupuesto de subvención y envío. Los transportes propiedad del adaptador y los fallos del flujo traducido después de excluir los encabezados ascendentes. |
| `autoToolChoiceOnlyModels?` | `string[]` | Los modelos cuyo `tool_choice` acepta solo `auto` o `none`; las opciones forzadas se degradan. |
| `preserveReasoningContentModels?` | `string[]` | Modelos que necesitan el `reasoning_content` previo del asistente en el historial. Las solicitudes Chat traducidas a `api.mistral.ai` reconstruyen en su lugar los bloques nativos de pensamiento antes del texto del asistente. El pensamiento recibido se reproduce por defecto para todas las familias alojadas; una lista explícita, incluida `[]`, sustituye esa selección. No se inventan pensamientos de relleno ni firmas. El passthrough Chat nativo no cambia. Si al guardar se conserva el destino, también se conserva la lista, incluida `[]`; consulta [Qué conserva un guardado](#what-a-provider-save-keeps). `PATCH /api/providers?name=<provider>` acepta un arreglo o `null` para borrarla. |
| `inlineThinkTagModels?` | `string[]` | Recuperación opt-in para `openai-chat` gateways sin un analizador de razonamiento del lado del servidor. Un bloque principal `<think>` / `<thinking>` / `<reasoning>` (opcionalmente después del espacio en blanco) activa la división en respuestas transmitidas y almacenadas en memoria intermedia. Toda la respuesta se conserva en blanco. Las etiquetas posteriores son delimitadoras en cualquier lugar, incluyendo el intercalado de la misma línea y las vallas de código; este modo no interpreta Markdown. El texto ordinario o una cerca de código antes de la primera etiqueta mantiene toda la respuesta intacta. Fuera de forma predeterminada; prefiere el razonamiento ascendente estructurado o `reasoningSplitModels` donde sea compatible. |
| `reasoningDetailsModels?` | `string[]` | Los modelos cuyo punto final devuelve el pensamiento como una matriz `reasoning_details` estructurada (serie M MiniMax con `reasoning_split` ); los deltas de flujo son instantáneas acumulativas que se diffed por prefijo y se conservan las repeticiones de razonamiento como una matriz `reasoning_details` en lugar de una cadena `reasoning_content`. |
| `requiresReasoningPlaceholderModels?` | `string[]` | Modelos cuyo flujo ascendente rechaza una continuación tool_call que falta `reasoning_content` (modo de pensamiento DeepSeek); se inyecta un marcador de posición mínimo cuando la caché de reproducción falla. Por defecto a `preserveReasoningContentModels`; ajuste `[]` para optar por no participar. Un proveedor de guardar que mantiene el destino mantiene la lista almacenada, incluyendo `[]`; ver [Lo que un proveedor guarda](#what-a-provider-save-keeps). `PATCH /api/providers?name=<provider>` acepta una matriz o `null` para borrarla. |
| `showThinkingSummary?` | `boolean` | Mostrar resúmenes de autoría de proveedor cuando un cliente Responses omite `reasoning.summary`. El cable explícito `"none"` gana; un cliente que serializa su preferencia como omisión no puede distinguirse. Razonamiento crudo sigue siendo contenido y nunca es reetiquetado como un resumen. El valor predeterminado preestablecido de `google-antigravity` es `true`; el `false` explícito deshabilita ese valor predeterminado. Las solicitudes de CCA, Vertex y Gemini directas elegibles también optan por `generationConfig.thinkingConfig.includeThoughts` cuando la pantalla está habilitada; las solicitudes de imagen, Claude, gpt-oss y Vertex sin escaleras no lo hacen. Esto no cambia la configuración del cliente o los valores predeterminados de resumen del catálogo global. |
| `hideRawReasoning?` | `boolean` | Mantenga la cadena de pensamiento sin procesar de un proveedor enrutado fuera del canal de contenido orientado al cliente (openai-chat `reasoning_content`, etiquetas kiro, `response.reasoning_text.*`) mientras los resúmenes de autor del proveedor aún se transmiten en el canal de resumen. El valor explícito del protocolo `reasoning.summary: "none"` sigue ocultando ambos. Esto controla lo que muestra un cliente; no guarda el texto del cliente. Una ruta de puente Responses todavía lo envía dentro del sobre de repetición `ocxr1` en el elemento de razonamiento `encrypted_content`, que es base64 JSON en lugar de cifrado, por lo que el cliente puede hacer eco de nuevo en el siguiente turno. Los codificadores directos de Chat y Messages no tienen envolvente en su cable, por lo que esos clientes no reciben copia y la reproducción proviene de la caché de reproducción de razonamiento del lado del servidor. `preserveReasoningContentModels` repetición y DeepSeek - estilo continuaciones no se ven afectados de ninguna manera. Desactivado de forma predeterminada; una ruta de paso nativa transmite los propios fotogramas del flujo ascendente e ignora esta opción. Guardar el mismo nombre de proveedor mantiene un valor omitido incluso después de un movimiento de destino; `PATCH` acepta un booleano o `null` para borrarlo. |
| `thinkingToggleModels?` | `string[]` | Chatea modelos usando `thinking.enabled` en lugar de una escalera de esfuerzo. |
| `thinkingBudgetModels?` | `string[]` | Modelos de chat usando el número entero `thinking_budget`; el esfuerzo mapea a una fracción de presupuesto. |
| `noVisionModels?` | `string[]` | Los modelos solo de texto enviados a través del sidecar de visión toleran una etiqueta Ollama `:size`. |
| `escapeBuiltinToolNames?` | `boolean` | Escápese de los nombres de herramientas incorporados para las puertas de enlace compatibles con Anthropic y restaure las llamadas devueltas. |
| `anthropicEofTolerance?` | `boolean` | Deje que una puerta de enlace compatible con Anthropic complete un flujo que termina antes de `message_stop`, solo cuando se recibió texto visible o una entrada completa de la herramienta JSON-objeto. Desactivado por defecto. |
| `googleMode?` | `"ai-studio" \| "vertex" \| "cloud-code-assist"` | Google transporte/modo auth. Por defecto `ai-studio`. |
| `googleToolSchemaPolicy?` | `"compatible" \| "reject-lossy"` | Google solamente. Omitted/ `compatible` conserva el esquema de herramienta compatible y la reparación no directa existente de 400. `reject-lossy` rechaza la pérdida inicial del esquema o una comparación limitada indeterminada antes del envío y retiene una reparación de Vertex o Cloud Code Assist que abriría restricciones. Direct AI Studio nunca realiza esa reparación. |
| `directGeminiWireRenames?` | `boolean` | Google solamente. Se aplica en el modo AI Studio, incluidas las URL personalizadas compatibles con Google. Omitida o `true` mantiene el nombre del cable `-tiered` para Gemini Flash ids ( `gemini-3.7-flash` -? `gemini-3.7-flash-tiered` ); `false` envía los identificadores desnudos solicitados al cable sin cambios. Las rutas Vertex y OpenCode Zen con clave canónica conservan el ID del modelo solicitado independientemente de esta configuración; El enrutamiento de Cloud Code Assist no cambia. Establecer `false` cuando el configurado aguas arriba todavía sirve a los ID desnudos. |
| `project?` | `string` | Identificador de proyecto de Vertex o Antigravity Cloud Code Assist. Las claves API de Vertex usan ese proyecto cuando está configurado; si se omite, usan el modo express aunque exista `GOOGLE_CLOUD_PROJECT`. ADC recurre a `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT`. Con `"auto"`, cada clave API de Vertex resuelve su propio proyecto: los resultados correctos se guardan en caché por clave y los fallidos se vuelven a consultar en otra solicitud. Así, un grupo de claves puede abarcar varios proyectos. ADC rechaza `"auto"`. |
| — | — | Sondas de cuota de la cuenta Antigravity (`retrieveUserQuota` y `retrieveUserQuotaSummary`) siempre vaya al host de código en la nube de Google a través del transporte saliente anclado, independientemente de si está configurado `baseUrl`; el portador de la cuenta nunca se envía a un punto final configurado por el operador y una redirección aborta la sonda. Solo la lista de modelos sigue honrando `baseUrl`. |
| — | — | El resumen de cuota Antigravity se solicita con el User-Agent de Antigravity CLI, la única familia para la que Google incluye el grupo de cuota Gemini 4 Argon. Si devuelve 403 para una cuenta OAuth válida, OpenCodex reintenta una vez con el User-Agent heredado `antigravity/1.0` y el mismo token y proyecto. No reintenta un 401. La inferencia no Argon y el fallback de cuota de la lista de modelos conservan el User-Agent IDE. |
| — | — | Antigravity cuota muestra Gemini 4 Argón como ventanas separadas `Argon` / `Argon (Weekly)` junto a Gem y Cla. Solo se muestran: la clasificación de la cuenta, el agotamiento de la cuota, el restablecimiento de las notificaciones de pedido y restablecimiento siguen utilizando las ventanas Gemini y Claude, y las solicitudes de argón aún se evalúan según la ventana Gemini. |
| — | — | Actualizar el descubrimiento Antigravity combina los modelos habilitados de las cuentas utilizables y conserva el inventario de cada cuenta seis horas. Con failover activo, un CCA 404 prueba otra cuenta solo si el error original completo ocupa como máximo 4 KiB y contiene un ResourceInfo de modelo cuyo resourceName coincide exactamente con `models/<sent-model>`. Los errores solo de mensaje, otros recursos y los cuerpos demasiado grandes, incompletos o fallidos conservan el estado HTTP original sin denegar modelos ni rotar cuentas. Una denegación confirmada dura hasta 24 horas, hasta un descubrimiento positivo iniciado después de la solicitud o hasta sustituir las credenciales; un descubrimiento anterior no puede borrarla ni reemplazar un inventario positivo más reciente. El agotamiento nombra el modelo y distingue cuentas no disponibles de fallos de credenciales, admisión o presupuesto de envíos. No se infiere ninguna categoría de pago o prueba. |
| `location?` | `string` | Ubicación de Vertex. API -puntos finales de proyecto clave predeterminados a `global` e ignoran `GOOGLE_CLOUD_LOCATION`; ADC requiere este campo o el `GOOGLE_CLOUD_LOCATION` fallback. Gemini 4 Soportes de argón `global`, `us` y `eu`. |
| `mcpServers?` | `Record<string, CursorMcpServerConfig>` | Cursor solamente: servidores stdio o Streamable HTTP MCP. |
| `desktopExecutor?` | `DesktopExecutorConfig` | Cursor solamente: comandos externos de uso del ordenador y de pantalla de registro. |
| `unsafeAllowNativeLocalExec?` | `boolean` | Cursor legacy booleano, equivalente a `nativeLocalExec: "on"` solo cuando el campo más nuevo no está establecido. |
| `nativeLocalExec?` | `"off" \| "codex-sandbox" \| "on"` | Cursor directiva de ejecución local. `off` es el valor predeterminado; `codex-sandbox` actualmente falla cerrado como `off`. |

Los valores predeterminados de esfuerzo por modelo enviados de Command Code incluyen mediciones API en vivo. DeepSeek v4/v4.1 Flash (incluyendo v4 Flash Visión), GLM-5.3 y GLM-5.3-Flash, Qwen3.8-Flash, y soporte para Gemini-3.7-Flash `low`, `medium`, `high`, `xhigh`, y `max`. Las escaleras permanecen modelo específico: `poolside/laguna-s-2.1-free` Solo ofertas `medium`, mientras que Gemini-3.8-Flash y oferta MiMo-v2.5-Pro `low`, `medium`, y `high`. Para anular un Command Code anclado fila, conjunto `modelReasoningEffortsAuthoritative: true` Junto con este modelo
`modelReasoningEfforts` lista.

El registro y el reemplazo del proveedor (`POST /api/providers`) validan `responsesPath` y `chatCompletionsPath` antes de cambiar la configuración activa o el estado del disco. `PATCH /api/providers?name=<provider>` fusiona el cuerpo de la solicitud con el proveedor almacenado; actualiza los campos de contacto más allá de `disabled` - excepto `requestPacing` -solo actualizaciones - valida las rutas del proveedor fusionado de la misma manera antes de guardar, y una ruta retenida no válida devuelve `400` con la configuración sin cambios. Las mismas reglas de ruta se aplican cuando se carga un archivo de configuración.

Por ejemplo, esto aplica un límite de concurrencia para todo el proveedor y un límite más estricto a un modelo exacto, sin configurar un intervalo:

```json
{
  "requestPacing": {
    "enabled": true,
    "maxConcurrentRequests": 8,
    "models": {
      "nvidia/llama-3.1-nemotron-ultra-253b-v1": {
        "maxConcurrentRequests": 2
      }
    }
  }
}
```

El intervalo de simultaneidad permanece ocupado hasta que finaliza la solicitud ascendente, incluyendo los bytes de respuesta transmitidos finales. Las solicitudes por encima de los límites aplicables del proveedor y del modelo esperan en la cola de estimulación; cuando se libera un intervalo, se admite la siguiente solicitud elegible. La espera de cola no consume el tiempo de espera del encabezado de respuesta ascendente.

Para múltiples entradas de grupo de claves API, opte por la distribución de solicitudes normales por separado de la selección de fallos existente `apiKeyPoolStrategy`:

```json
{
  "requestPacing": {
    "enabled": true,
    "keySelection": "round-robin",
    "maxConcurrentRequests": 10,
    "keys": { "requestsPerMinute": 15, "maxConcurrentRequests": 1 }
  }
}
```

Esto admite como máximo diez solicitudes activas en todo el proveedor y una por referencia de credencial, con inicios en cada referencia con al menos cuatro segundos de diferencia. Estos son límites superiores locales, no una promesa de capacidad ascendente. Una configuración de RPM para todo el proveedor, cuando está presente, sigue siendo un límite agregado y no se multiplica con el recuento de claves. Los límites clave abarcan modelos; las reglas del modelo siguen siendo restricciones adicionales. Los proyectos que comparten cuota necesitan un límite agregado apropiado. El TPM y las cuotas diarias no se rastrean aquí.

Round-robin selecciona claves por solicitud sin guardar una nueva clave activa. Se omiten los tiempos de reutilización 401/429 conocidos; cuando ninguno sigue siendo elegible, las nuevas solicitudes reciben un 429 reintentable en lugar de enviarse repetidamente. El trabajo ya puesto en cola normalmente retiene su clave seleccionada y puede esperar detrás de esa clave incluso cuando otra está inactiva. Si esa selección se enfría o no es válida, la solicitud vuelve a seleccionar una clave elegible y vuelve a adquirir la admisión de estimulación; la cola limitada expira en lugar de esperar para siempre. La selección y el diagnóstico son locales de proceso, se restablecen al reiniciar y no igualan el uso o la facturación de tokens equilibrados. Comienza a contar las admisiones de ritmo, incluido el trabajo cancelado antes del envío. OAuth y las credenciales reenviadas mantienen su selección existente. El panel de control muestra los identificadores de teclas, los inicios, el trabajo en vuelo, el trabajo en cola y los tiempos de reutilización conocidos, nunca los valores de las claves secretas. Estos límites cubren el ejecutor de estimulación de inferencia, no la búsqueda directa del relé de imágenes independiente.

<a id="azure-openai-model-metadata-discovery"></a>

### Azure OpenAI descubrimiento de metadatos del modelo

Para una URL base cuyo nombre de host termina en `.openai.azure.com`, el descubrimiento llena el soporte de entrada de imagen/texto faltante y los límites de contexto/salida incluso cuando el proveedor tiene un nombre personalizado. Los indicadores de inferencia y chat de Azure `/models` por sí solos no describen el soporte de imágenes o los límites de token. opencodex los complementa con el público [catálogo models.dev](https://models.dev), utilizando sus filas de Azure antes de los metadatos de Azure y otros paquetes de proveedores. La búsqueda de ID de modelo es exacta o insensible a mayúsculas y minúsculas; un modelo recién publicado no requiere una nueva versión opencodex.

La instantánea de metadatos públicos se actualiza durante el descubrimiento como máximo una vez cada 24 horas, con un plazo de dos segundos y un límite de cuerpo de 16 MiB. Se almacena en `azure-model-metadata-cache.json` bajo el directorio de configuración opencodex. No se envían credenciales de Azure al catálogo público. El descubrimiento sin conexión mantiene los metadatos obsoletos en caché o vuelve a las sugerencias agrupadas; las solicitudes de generación no obtienen esta instantánea.

Las declaraciones de insumos explícitos y las modalidades notificadas siguen teniendo prioridad, incluido el `vision: false` notificado. Todavía se aplica la cobertura de sidecar de visión existente. Los límites informados/configurados siguen siendo válidos y los límites del proveedor aún los restringen. Los metadatos describen el soporte del modelo, no una capacidad de implementación particular. Los alias de implementación arbitraria, como `my-production-model`, no se pueden asignar desde los indicadores de inferencia de Azure; configure `modelInputModalities` y `modelContextWindows` para esa identificación exacta cuando sea necesario. Los identificadores desconocidos no se adivinan.

<a id="what-a-provider-save-keeps"></a>

### Lo que un proveedor guarda

`POST /api/providers` con el nombre de un proveedor existente sustituye su fila por la construida a partir de la solicitud. Como el formulario del dashboard no puede enviar todos los campos, el guardado conserva algunos valores almacenados que la solicitud omita. Once describen el comportamiento del proveedor: `preserveReasoningContentModels`, `preserveResponsesReasoningContent`, `requiresReasoningPlaceholderModels`, `foldDeveloperRoleToSystem`, `singleLeadingSystemMessage`, `reasoningWireFormat`, `omitReasoningEffortWithToolsModels`, `promoteAdditionalTools`, `retryOn429`, `transientRetryOn5xx` y `retryOnReset`.

| Guardado | Los once ajustes | `apiKeyPool` almacenado |
| --- | --- | --- |
| Mismo destino, campo omitido | Valor almacenado mantenido, incluyendo un `[]` o `false` explícito | Conservado |
| Nuevo destino, campo omitido | No se mantiene; pueden aplicarse los valores predeterminados del registro para el nuevo destino | No se conserva |
| Campo enviado en la solicitud | El valor de la solicitud | El valor de la solicitud |

El destino se determina por el adaptador, la URL base (esquema y host sin distinguir mayúsculas ni barras finales) y el modo de autenticación, cuando la solicitud lo incluye. Cambiar de destino descarta esos ajustes porque describen el proveedor anterior, y también el grupo de claves porque se emitieron para él. El guardado no fusiona el resto de la fila antigua con la nueva.

`hideRawReasoning` es una directiva de visualización del operador, por lo que guardar el mismo nombre de proveedor mantiene su valor almacenado cada vez que la solicitud lo omite, incluso después de un movimiento de destino. Gana un valor enviado en la solicitud, incluyendo `false`.

La configuración opcional `inferContextWindow` también sobrevive a los guardados con el mismo nombre que lo omiten, incluidos los movimientos de destino. Su comportamiento de lectura, actualización y claridad se describe en [Ventanas de contexto en proveedores personalizados](#context-windows-on-custom-providers).

`PATCH /api/providers?name=<provider>` cambia solo los campos que incluye y conserva los demás, aunque cambie el destino. Admite esos ajustes; `null` elimina uno. También admite un booleano `hideRawReasoning` o `null` para borrarlo. En las dos listas de razonamiento, un array vacío se guarda como una exclusión explícita.

Con `webSearchBridge` habilitado, una continuación de búsqueda permanece vinculada a la selección de clave API que sirvió la primera solicitud. Cambiar la clave seleccionada, su valor de referencia o resuelto, modo de autenticación o URL base durante la búsqueda o el ritmo del proveedor finaliza el turno con un error de puente antes de enviar otra solicitud del proveedor. El cambio y la vuelta también terminan esa continuación. Inicie un nuevo turno para utilizar la nueva selección. La selección cambia antes de que el primer proveedor envíe la retención de reselección normal.

Un resultado de búsqueda puenteado se muestra de nuevo al proveedor en el siguiente turno de la conversación solo para la misma persona que llama, conversación, proveedor, modelo y clave seleccionada. La persona que llama se identifica por la clave API opencodex que presenta, por lo que un cliente que no envía la clave opencodex API no obtiene dicha repetición: sus celdas de búsqueda anteriores llegan al proveedor sin cambios, como lo hacen para un proveedor sin el puente.

Una lista explícita `inlineThinkTagModels` reemplaza los valores predeterminados del registro coincidentes; `[]` desactiva la recuperación.

Las solicitudes Responses traducidas con un esfuerzo de razonamiento activo validado preservan el razonamiento en bruto cuando se omite `reasoning.summary`. `"none"` explícito lo mantiene oculto para su reproducción; la omisión sin un esfuerzo activo también permanece oculta. Un combo inyectado por defecto agrega `summary: "auto"` solo cuando el llamante no ha elegido un modo de resumen. Razonamiento en bruto nunca se vuelve a etiquetar como un resumen de autor proveedor, y Codex todavía controla su pantalla con `show_raw_agent_reasoning`.

El modelo personalizado `reasoningEfforts` normalmente anula los metadatos del proveedor descubiertos. La excepción limitada es una fila personalizada explícita cuyo identificador de modelo ha fijado capacidades nativas Codex, incluyendo Astra o Daybreak en una puerta de enlace arbitraria: su lista anunciada se cruza con las capacidades nativas fijadas de ese modelo. La identidad nativa completa aún requiere el destino canónico `openai` Codex-forward. Una lista vacía explícita permanece vacía sin ningún valor predeterminado; una lista incompatible no vacía vuelve al valor predeterminado nativo como una sola opción. Los valores predeterminados deben pertenecer a la lista final. Esto cambia la proyección del catálogo, no la configuración almacenada. Véase [ejemplos de catálogo nativos personalizados](/es/guides/codex-app-models/).

<a id="per-provider-egress"></a>

### Salida por proveedor

Establecer `proxy` en un proveedor cuando ese flujo ascendente necesita una salida diferente del proxy de todo el proceso:

- Omita `proxy` para heredar el proxy global y la decisión `NO_PROXY`.
- Configurar `proxy` a `"direct"` o `null` para forzar a este proveedor a conectarse directamente, incluso cuando se establece un proxy global.
- Establezca `proxy` en una URL absoluta `http://` o `https://` para usar ese proxy HTTP para este proveedor.
- Configure `proxy` a una URL absoluta `socks5://` o `socks5h://` para usar ese proxy SOCKS5 para este proveedor.

Una cadena vacía o de solo espacio en blanco se rechaza a propósito. Un campo borrado no debe cambiar silenciosamente de "heredar el proxy global" a "forzar directo"; eliminar el campo para heredar, o escribir `"direct"` para elegir la salida directa explícitamente.

`noProxy` acepta una cadena separada por comas o una matriz de cadenas en la sintaxis `NO_PROXY`. Se evalúa para cada solicitud. Un destino coincidente va directo si el proveedor usaría su propio `proxy` o heredaría un proxy global.

<a id="what-the-route-covers"></a>

#### Lo que cubre la ruta

La ruta se aplica a inferencias enrutadas, pruebas de descubrimiento y conexión de proveedores y sondas de cuota de clave API. Algunos transportes no pueden llevarlo, y OpenCodex lo dice en lugar de pretender lo contrario:

- **OAuth intercambio de tokens y actualización** seguir utilizando el proxy de todo el proceso. Estos alcanzan puntos finales de proveedores fijos desde código que no contiene configuración de proveedor, por lo que un proveedor anclado a su propio proxy o a `"direct"` aún actualiza sus credenciales por la ruta global. Las sondas de cuota respaldadas por OAuth y las sondas de validación de clave API se comportan de la misma manera.
- **El Responses WebSocket carril rápido** selecciona su proxy cuando marca y no puede llevar una ruta por proveedor, por lo que un proveedor que declara que uno sirve esos convierte más de HTTP / SSE y registra un aviso único.
- **Cursor 's por defecto HTTP/2 transporte**, el **Proveedores de subprocesos CodeBuddy y Qoder** (su entorno hijo omite las variables proxy) y el remitente anclado **Compatibility Lab** no lo aplican.
- Los endpoints que no enrutan un modelo (generación y edición de imágenes, transcripción de audio, llamadas en tiempo real y en vivo, y `/v1/alpha/search` no calificado) no tienen ruta de proveedor para aplicar.

Un proveedor configurado con un ejecutor `fetch` personalizado es rechazado en lugar de ser enviado silenciosamente por la propia ruta del ejecutor.

Este ejemplo mantiene un proxy global para el tráfico ordinario, envía un proveedor a través de un proxy regional HTTP, y fija otro proveedor a una conexión directa:

```json
{
  "proxy": "http://global-proxy.example:8080",
  "providers": {
    "regional-gateway": {
      "adapter": "openai-chat",
      "baseUrl": "https://regional-api.example/v1",
      "proxy": "http://regional-proxy.example:3128"
    },
    "direct-gateway": {
      "adapter": "openai-chat",
      "baseUrl": "https://direct-api.example/v1",
      "proxy": "direct"
    }
  }
}
```

<a id="operator-pinned-reasoning-effort"></a>

### Esfuerzo de razonamiento fijado por el operador

Configure `pinnedReasoningEffort` en un proveedor existente para anular las opciones de esfuerzo entrantes, o use `modelPinnedReasoningEfforts` para ID de modelo ascendente individuales. Los pines de proveedor por modelo ganan sobre el pin de todo el proveedor; el mapa de la raíz `modelPinnedEfforts` es el respaldo. Estos son ajustes del operador, no los valores predeterminados del registro del proveedor. No cambian el descubrimiento del modelo o la escala de esfuerzo anunciada.

```json
{
  "pinnedReasoningEffort": "high",
  "modelPinnedReasoningEfforts": {
    "example-model": "max"
  }
}
```

Combina estos campos en la fila de proveedores existente. Los valores aceptados son `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` y `ultra`. **`none` elimina el campo de esfuerzo explícito**; utiliza el comportamiento predeterminado del proveedor y no garantiza que el razonamiento esté deshabilitado. Las tapas de esfuerzo aplicables aún se ejecutan después del pin, y la asignación/normalización de cables del proveedor puede reducir u omitir un valor no compatible. `ultra` se normaliza antes de que alcance un cable aguas arriba. Las solicitudes de mantenimiento de compactación están exentas de pines.

`PATCH /api/providers?name=<provider>` acepta estos campos. Omita un campo para conservarlo; use `null` para borrar un escalar o todo el mapa. Una entrada de mapa establecida en `null` o `""` elimina esa entrada mientras conserva otras entradas. Las escrituras mal formadas son rechazadas antes de guardarlas. Un pin opcional mal formado en un archivo editado a mano se ignora bajo carga sin descartar el resto de la configuración.

<a id="auto-review-approval-model-selection"></a>

### Selección del modelo de revisión automática (aprobación)

Codex lee `auto_review_model_override` de la fila del catálogo del modelo actual de turno para elegir el modelo que revisa las solicitudes de aprobación. La configuración de la raíz `auto_review_model` en `$CODEX_HOME/config.toml` suministra el respaldo de Codex. El panel de control global **Anulación de revisión automática** en Configuración de modelo almacena `autoReviewOverride` en `~/.opencodex/config.json` y tiene prioridad sobre ese recurso; los campos de alcance de proveedor a continuación aún ganan en sus propias filas. La configuración global debe estar habilitada y nombrar un modelo. Una configuración habilitada sin modelo permanece sin aplicar y deja el retroceso Codex en efecto. Una actualización de catálogo es un estado separado: después de guardarlo puede permanecer pendiente, y la página Modelos lo informa para que pueda volver a intentarlo con `ocx sync`. Los usuarios de CLI pueden leer la configuración con `ocx models auto-review status` o cambiarla con `ocx models auto-review set <model|-> [--enabled <on|off>]`; use `-` para borrar el modelo. La salida CLI recomienda `ocx sync` cuando se puede volver a intentar una actualización. Si falla una actualización, la configuración permanece guardada y el comando sale 1. Resolver el fallo antes de la sincronización. El [guía del proveedor](/es/guides/providers/#approval-reviewer-per-provider) tiene el flujo de trabajo del operador y un ejemplo trabajado.

Cuando se incluyen OpenAI filas nativas y el catálogo final tiene una fila nativa desnuda ordinaria que no sea Reserve (recuento de filas ocultas), OpenCodex mantiene la fila oculta `codex-auto-review` para que Codex pueda seleccionar su revisor de aprobación preferido cuando no se configura la anulación. Queda fuera de los selectores de modelos, las opciones de subagentes, las listas de escritorio y las listas públicas `/v1/models`. El proveedor y el revisor raíz anulan su precedencia y no estampan esta fila interna. Los catálogos sin una fila nativa desnuda ordinaria, incluidos los catálogos solo de reserva, la omiten y conservan el respaldo de Codex al modelo de tarea. El revisor recibe la misma proyección de modo multiagente que las filas nativas ordinarias.

`autoReviewModel` es el objetivo del revisor de todo el proveedor. Un valor puede ser un id de modelo desnudo de ese mismo proveedor (la fila de catálogo está normalizada a la identificador `provider/model`) o una identificador de catálogo pública completa como `opencode-go/deepseek-v4-flash`. Un valor desnudo se resuelve primero contra las filas de ese proveedor y luego contra una fila de catálogo desnuda, que es como se nombra un modelo nativo como `gpt-5.6-terra`, y un valor desnudo que aterriza fuera del proveedor imprime una nota que nombra la fila que realmente suministra al revisor; un valor que no coincide con ninguno no se resuelve. `autoReviewModelOverrides` claves son exactamente ids de modelo ascendente de ese proveedor, o el alias publicado del proveedor para uno ( `modelAliases` ); o bien nombres ortográficos de la misma fila enrutada, cuya slug lleva el id ascendente. Una entrada gana sobre el valor de todo el proveedor para su modelo. Un sello de proveedor gana sobre el selector de raíz en sus propias filas enrutadas, y el selector de raíz sigue siendo la reserva para las filas nativas y las filas enrutadas sin un sello de proveedor. La eliminación de un selector de proveedor solo borra los sellos de ese proveedor; la eliminación del selector raíz nunca borra los sellos de proveedor. Los ID de modelo que contienen una barra pueden escribirse sin procesar o en su forma de catálogo codificada; ambas ortografías se resuelven en la misma fila enrutada. Las llaves del modelo conservan el caso. Los selectores se resuelven contra el catálogo final en cada sincronización, independientemente uno del otro, y cada uno falla cerrado por sí solo: un `autoReviewModel` no resuelto emite un diagnóstico y no estampa filas de todo el proveedor, una entrada `autoReviewModelOverrides` no resuelta emite un diagnóstico y no estampa una anulación por modelo, por lo que un objetivo válido de todo el proveedor sigue siendo su reserva. Se sigue aplicando cualquier selector que se resuelva. Las filas sin sello de proveedor mantienen el selector raíz o el comportamiento normal de revisión automática ascendente cuando no está establecido. El proveedor canónico `openai` no acepta estos campos.

La eliminación del selector de raíz borra los sellos de raíz de cada fila, incluidas las filas nativas estampadas por versiones anteriores al marcador de procedencia de OpenCodex. Esa limpieza reconoce un sello heredado por su forma, un valor en todo el catálogo que también lleva una fila enrutada, por lo que un valor genuino por fila que coincida con esa forma se borra con él, y un catálogo que desde entonces ha divergido de esa forma necesita una sincronización manual. Los sellos de proveedores nunca son tocados por la eliminación de raíces.

`PATCH /api/providers?name=<provider>` acepta ambos campos. Use `null` para borrar el escalar o todo el mapa; use una entrada de mapa de `null` o `""` para eliminar ese modelo mientras conserva otras entradas. El proveedor no relacionado guarda los valores previamente configurados.

Estos campos están disponibles en `config.json`, la administración de proveedores API y el editor de proveedores JSON sin procesar del panel de control. Los controles de formulario dedicados no están presentes. Los sellos raíz nativos registran el valor anterior y lo restauran al eliminarlo cuando el valor sellado no se ha cambiado externamente.

<a id="discovered-model-display-names"></a>

### Nombres de modelo descubiertos

Utilice `modelDisplayNames` cuando un proveedor devuelve identificadores compatibles con la máquina, pero el selector de modelos Codex necesita etiquetas más cortas. El mapa pertenece a un proveedor, por lo que el mismo identificador de modelo puede tener una etiqueta diferente bajo otro proveedor. Agregue el campo a la fila de proveedores existente en `config.json` y mantenga todas las demás configuraciones de proveedores. El ejemplo incluye los campos requeridos para el contexto:

```json
{
  "providers": {
    "xai": {
      "adapter": "openai-chat",
      "baseUrl": "https://api.x.ai/v1",
      "modelDisplayNames": {
        "grok-4.6": "Grok 4.6"
      }
    }
  }
}
```

Las filas GPT nativas desnudas compatibles en el catálogo local Codex también aceptan etiquetas exactas en `providers.openai.modelDisplayNames`, por ejemplo `"gpt-6-astra": "GPT 6 Astra"`. Tanto la sincronización de inicio como la convergencia de catálogo local vuelven a aplicar estas etiquetas. La eliminación de una etiqueta restaura el nombre nativo original solo cuando el nombre de visualización de la fila aún coincide con la anulación aplicada. Se conserva un nombre de visualización externo más reciente sujeto a la normalización de metadatos nativos existentes; por ejemplo, Astra (`gpt-6-astra`) aún reemplaza un nombre no anclado con su nombre nativo anclado. La superposición de etiquetas deja sin cambios los ID de modelo, los metadatos (incluidas las capacidades), los alias combinados enrutados y las filas calificadas para la cuenta. Esta anulación del catálogo local no reetiqueta los listados de modelos HTTP ni las filas virtuales `*-pro`.

El orden efectivo de la etiqueta es el operador `modelDisplayNames`, luego los metadatos del catálogo del proveedor, luego el retroceso normal `provider/model`. El selector encaminado permanece `xai/grok-4.6`, mientras que el modelo de cable aguas arriba permanece `grok-4.6`. Las etiquetas solo se muestran. No cambian la autenticación, el comportamiento del adaptador, el enrutamiento, la facturación o la construcción de solicitudes ascendentes. La eliminación de una entrada de mapa restablece solo su etiqueta. Para los modelos OpenAI API incorporados, use `providers.openai-apikey.modelDisplayNames`; la etiqueta sobrevive a las actualizaciones del catálogo. Un cliente de administración puede establecer o restablecer una etiqueta con `PUT /api/providers/:provider/model-display-names` y un cuerpo de `{ "modelId": "grok-4.6", "displayName": "Grok 4.6" }`; enviar `displayName: null` para restablecerla. El proveedor `PATCH` no edita este mapa. Utilice este punto final dedicado `PUT` para cambiar o eliminar etiquetas.

El tablero de instrumentos expone la misma configuración duradera en **Modelos**. Expanda el proveedor, encuentre un modelo descubierto y elija **Nombre**. El cuadro de diálogo mantiene visible el selector exacto `provider/model` mientras guarda una etiqueta amigable. Elija **Restablecer nombre** para volver a los metadatos del proveedor o al menú desplegable del selector normal. **Nombre** cambia solo la presentación; el lápiz de alias separado cambia el alias de enrutamiento corto y no es un editor de nombres de visualización. Las filas nativas OpenAI y de modelo personalizado mantienen sus controles existentes.

Si el cambio se guarda pero falla la actualización, el cuadro de diálogo refleja la anulación guardada y mantiene **Reintentar** disponible. Volver a intentar repite la convergencia de catálogo cuando el servidor informó de que falló, o recarga la lista cuando solo falló la solicitud de lista. La recuperación de restablecimiento mantiene la operación de restablecimiento; no restaura el nombre antiguo. Las solicitudes tienen una fecha límite de 60 segundos que cubre la redacción y la actualización de su lista de seguimiento. Un tiempo de espera no deshace una escritura: use **Reintentar** para verificar el nombre actual antes de realizar otro cambio.

El selector `/model` de Claude Code (`GET /v1/models` en formato Anthropic) muestra una fila enrutada con etiqueta exacta como `<label> (<provider>)`, por ejemplo `Sonnet 5.5 (anthropic2)` y `Sonnet 5.5 (anthropic2) · 1M`. Sin etiqueta conserva `<model id> (<provider>)`. Cuando `fastMode` global reescribe una fila Cursor a su id rápido con estilo legible, conserva el id listado en lugar de la etiqueta configurada. Los alias y metadatos del catálogo no cambian esa etiqueta; los ids y las filas nativas no cambian.

<a id="codex-catalog-and-root-configtoml-settings"></a>

## Codex catálogo y raíz `config.toml` configuración

Estos ajustes pertenecen a la raíz de `$CODEX_HOME/config.toml`, junto con `approvals_reviewer`; no son campos de proveedor.

| Campo | Tipo | Descripción |
| --- | --- | --- |
| `auto_review_model` | `string` | Selector de catálogo público en forma `provider/model`, por ejemplo `opencode-go/deepseek-v4-flash`. Después de cada fusión de catálogo, OpenCodex lo resuelve contra el catálogo final y marca el valor recortado como `auto_review_model_override` en las entradas de catálogo. Se elimina el espacio en blanco límite; los componentes delimitados por barras del selector no cambian de otro modo. Si el valor está ausente o en blanco, las anulaciones enrutadas existentes se borran y se conserva la selección normal de auto-revisión ascendente. Si es sintácticamente inválido o está ausente del catálogo final (incluso después de la eliminación del proveedor / modelo), OpenCodex falla cerrado solo para la anulación: borra la anulación muerta, conserva el comportamiento normal de flujo ascendente y emite un diagnóstico. Volver a agregar el proveedor/modelo en una sincronización posterior permite que el selector configurado se selle nuevamente. |

La configuración se evalúa después del descubrimiento del proveedor, el filtrado del modelo, la proyección nativa/de la fila de cuentas y la prioridad de combinación, por lo que solo un selector presente en el catálogo producido por esa sincronización puede convertirse en una anulación. Los valores ascendentes nativos se conservan cuando la configuración se borra o no se resuelve. El campo de catálogo persistente es leído por Codex para el modelo del turno actual, por lo que se copia un selector configurado válido a cada entrada aplicable. Los selectores con alcance de proveedor (arriba) se aplican antes de esta reserva raíz y ganan en filas enrutadas.

<a id="response-service-tier-authority"></a>

### Autoridad de nivel de servicio de respuesta

Establecer `providers.<name>.responseTierAuthoritative` a `false` en `config.json` cuando la respuesta de ese proveedor `service_tier` no puede establecer si se concedió Fast. Esta es una declaración del operador sobre toda la ruta del proveedor, independiente de `supportsServiceTier` y `fastWire`. No permite Fast ni cambia el `service_tier` saliente.

Por ejemplo, agregue este campo a un proveedor de puerta de enlace existente cuyo backend Codex tiene metadatos de respuesta no autoritativa:

```json
{ "responseTierAuthoritative": false }
```

**El soporte de Gateway es opt-in.** La actualización de OpenCodex por sí sola no añade esta declaración a los proveedores existentes. Sin ella, una solicitud de prioridad elegible seguida de `service_tier: "default"` conserva la interpretación heredada de `response-declined`. Configure `false` solo cuando se sabe que los metadatos de respuesta de la ruta no son autorizados.

Para una solicitud elegible serializada como `priority`, tanto un eco `default` como un eco `priority` permanecen como observaciones. Los troncos conservan `responseServiceTier` y registran `tierOutcome.responseTierAuthoritative: false`, `fastOutcome: "applied"` y `confirmation: "assumed"`, sin `response-declined`. Aquí **aplicado significa que el parámetro de solicitud fue enviado** y **supuesto significa que el efecto rápido real no está confirmado**. La descripción del modelo muestra la solicitud y la respuesta sin procesar por separado con esa confirmación. Ni esta configuración ni estos registros prueban una aceleración o un nivel facturado.

Las estimaciones de costos usan el recurso existente solicitado en lugar de tratar el eco crudo como un nivel de precio confirmado; las reglas de precios que requieren confirmación de respuesta no pueden usar ese eco. Los registros históricos sin una bandera de autoridad conservan su interpretación anterior.

El campo solo acepta booleanos. La Omisión y el `true` explícitos retienen la confirmación basada en la respuesta para otros destinos, incluso el API oficial y puertas de enlace no declaradas. Canonical `https://chatgpt.com/backend-api/codex` con `authMode: "forward"` permanece automáticamente no autorizado, incluso si `true` está configurado. Los nombres de puerta de enlace y las URL nunca se infieren. Si una puerta de enlace mezcla contratos de respuesta, utilice entradas de proveedor separadas para esas rutas y aplique la declaración solo a la entrada relevante.

<a id="fastwire-b1-capability-migration"></a>

### FastWire B1 migración de capacidad

La capacidad rápida y el reenvío arbitrario del nivel de llamada de Chat son independientes después de FastWire B1. El [definiciones de campo proveedor](#provider-entries-ocxproviderconfig) anterior sigue siendo el contrato autorizado; las configuraciones existentes ven estos deltas de migración:

1. Un proveedor/modelo de chat declarado compatible con Fast ya no necesita `chatServiceTier: true` para canónica Fast. La publicación, la elegibilidad de enrutamiento y la inyección aún requieren una política elegible y un mapeo FastWire compatible en el adaptador final. En las rutas clasificadas, `fastMode: false` todavía elimina el ayuno canónico. Establecer `supportsServiceTier: false` o un modelo exacto `false` cuando la ruta no es Fast-capable.
2. En una ruta clasificada elegible, la ortografía de la persona que llama `fast` y `FAST` se normaliza a través de `fastWire.canonicalToWire.priority`; la persona que llama `priority` permanece canónica. Configure una asignación verificada a `fast` solo cuando ese es el valor canónico del flujo ascendente. Las rutas no clasificadas conservan su comportamiento de reenvío existente.
3. El modelo exacto `true` ya no autoriza los niveles de Chat extranjeros, como `flex` o los valores específicos del proveedor. Aquellos que todavía requieren `chatServiceTier: true`; de lo contrario se eliminan y se registran como niveles de llamada caídos.

La capacidad explícita `false` y Responses de reenvío de llamadas retienen sus contratos existentes.

<a id="anthropic-fast-anthropic-speed"></a>

### Anthropic rápido (`anthropic-speed`)

Las entradas `anthropic` (almacenadas en Claude OAuth) y `anthropic-apikey` anuncian Fast solo para `claude-opus-5-5`, `claude-opus-5` y `claude-opus-4-8`. Otros modelos Claude no están clasificados; las entradas no tienen un valor predeterminado rápido para todo el proveedor.

Anthropic Fast está **desactivado de forma predeterminada** porque gasta créditos de uso (suscripción) o acceso en modo rápido (API) a un precio 2x. Enciéndalo por proveedor con la fila Off/On en la página Modelos del panel de control, o configure `providers.anthropic.fastEnabled: true` (o el mismo campo en `anthropic-apikey`). Mientras está desactivado, esos modelos no publican ningún cambio rápido o fila `--fast` y el proxy nunca envía `speed`, incluso con un `fastMode: true` global. Claude Code passthrough nativo aún reenvía un campo `speed` que el llamante se envía a sí mismo (por ejemplo Claude Code `/fast`), porque esa solicitud nunca alcanza la política Fast del proxy. Cursor Fast y otros proveedores no se ven afectados.

Cuando está habilitado, un `--fast` o un selector rápido elegible envía `speed: "fast"` y agrega `fast-mode-2026-02-01` al encabezado `anthropic-beta` existente. El proxy conserva OAuth valores beta y envía un encabezado deduplicado. `fastMode: false` desactiva esta inyección.

El eco `usage.speed` de Anthropic determina el resultado: `fast` confirma Fast, `standard` registra una degradación y un eco faltante no está confirmado. Solo el uso rápido confirmado recibe la estimación de precio de lista 2x (Opus 5.5 $ 8 de entrada / $ 40 de salida; Opus 5 y 4.8 $ 10 de entrada / $ 50 de salida por millón de tokens). Si se rechaza el primer envío rápido porque se requieren créditos de uso, una organización desactiva Fast, el modelo rechaza `speed` o el grupo rápido está vacío, el envío del adaptador principal puede hacer un reenvío de velocidad estándar presupuestado. Los límites de velocidad genéricos y los errores de capacidad mantienen su manejo habitual. Las compilaciones posteriores de esa solicitud permanecen a la velocidad estándar; un nuevo giro puede encontrar el rechazo nuevamente.

Suscripción Fast en Pro/Max necesita créditos de uso; Las organizaciones de equipos/empresas también necesitan habilitación de administrador. La primera parte API Fast es una vista previa de investigación que requiere acceso. Consulte [Anthropic Modo rápido](https://platform.claude.com/docs/en/build-with-claude/fast-mode) y [Claude Code Modo rápido](https://code.claude.com/docs/en/fast-mode) para conocer los términos de acceso y facturación.

<a id="cursor-fast-cursor-variant"></a>

### Cursor rápido (`cursor-variant`)

Cursor no tiene campo `service_tier`. Su producto rápido es un diferente **variante modelo** - `claude-opus-5-thinking-high-fast`, un parámetro de solicitud `{id:"fast",value:"true"}` para Grok 4.5/4.6, o un identificador de cable `grok-4.7-{effort}-fast` aplanado para Grok 4.7, por lo que la entrada Cursor declara `fastWire.kind: "cursor-variant"` y el generador de solicitudes resuelve la variante en lugar de establecer un campo de solicitud.

Solo las bases que realmente declaran una variante rápida anuncian Fast: `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`, `claude-opus-5-5`, `grok-4.5`, `grok-4.6`, `grok-4.7`. Cada otra fila Cursor publica `supportsServiceTier: false`, por lo que Codex no muestra ninguna palanca en lugar de una muerta.

Una base cuya fila de paraguas dirige las actualizaciones de pensamiento a su variante **pensamiento-rápido**, no al hermano rápido simple: ese hermano es un producto diferente con una escalera de esfuerzo más corta, y para `claude-opus-5` su familia regular está en cuarentena aguas arriba.

`fastMode` se comporta de manera diferente por superficie, ya que solo Codex tiene una palanca rápida propia:

| Superficie | `fastMode: true` |
|---|---|
| Codex | filas permanecen filas de paraguas; la palanca Fast de la aplicación selecciona la variante |
| Claude Code ( `?ids=cli` ) | enumera la identidad rápida, p. ej. `ocx-claude-cursor--claude-opus-5-thinking-fast` |
| OpenAI `/v1/models` | listas `cursor/claude-opus-5-thinking-fast` |
| Claude Desktop (3P) | inalterado - sus alias están hashizados desde el nombre del modelo |
| Tablero `/api/models` | ID de fila sin cambios; son las teclas de activación/desactivación |

Las solicitudes se promocionan de cualquier manera: con `fastMode: true`, elegir el ID de paraguas aún se resuelve en la variante rápida, por lo que un cliente cuya configuración guardada sea anterior al conmutador no necesita redescubrir. Cada ID de variante heredada mantiene el enrutamiento sin cambios.

<a id="xai-priority-processing"></a>

### Procesamiento prioritario de xAI

El preajuste integrado `xai` admite Fast en sus dos transportes, con alcances distintos.
El modo de clave API usa `https://api.x.ai/v1`. Las rutas resueltas como `openai-chat`
envían `service_tier: "priority"` mediante Chat Completions; los valores predeterminados
y las anulaciones de cada modelo pueden seleccionar `openai-responses` en su lugar.
`ocx login xai` guarda credenciales OAuth para la pasarela de suscripción de Grok
(`https://cli-chat-proxy.grok.com/v1`), que se actualizan automáticamente.

En esa pasarela, Fast se clasifica por modelo según las comprobaciones del 2026-09-13
y el 2026-09-23. grok-4.7, grok-4.6, grok-4.5, grok-4.3,
grok-4.20-0309-reasoning, grok-4.20-0309-non-reasoning, grok-build-0.1 y
grok-composer-2.5-fast aceptan `service_tier: "priority"` mediante Grok OAuth y lo
devuelven en la respuesta. Por ello, sus filas anuncian Fast, aceptan selectores
`--fast` y reenvían el nivel enviado por el cliente en cualquiera de los transportes.
grok-4.20-multi-agent-0309 queda excluido: cuando recibe `priority`, la pasarela
responde `service_tier: "default"`; el modelo permanece sin clasificar y no se reenvía
el nivel solicitado por el cliente. Los modelos que no figuran en la lista permanecen
sin clasificar en ambos transportes.

En la pasarela OAuth, Fast funciona de otra manera para Grok 4.7. La pasarela también
ofrece `grok-4.7-build-fast`, el mismo modelo sobre hardware de servicio más rápido:
las mediciones indicaron aproximadamente 1.6 × la velocidad de `grok-4.7`.
El procesamiento prioritario de `grok-4.7` no resultó más rápido y consumió
aproximadamente 6 × el uso de suscripción por token de salida. La lista Modelos muestra
por ello una única fila de Grok 4.7. Elegir su fila Fast (`xai/grok-4.7--fast`),
enviar `service_tier: "priority"` o activar el modo Fast envía la solicitud como
`grok-4.7-build-fast`, sin nivel de servicio. Los registros conservan `grok-4.7`
como modelo y guardan `grok-4.7-build-fast` como modelo del protocolo. El modo de
clave API sigue igual: build-fast no está en la API pública de xAI y Grok 4.7 Fast
sigue significando procesamiento prioritario en esa ruta. Una selección explícita
`xai/grok-4.7-build-fast` procedente de una configuración anterior sigue funcionando.

Si el proveedor no tiene un `fastWire` explícito, una clave API de opencodex
restringida por `allowedModels` debe permitir `xai/grok-4.7-build-fast` o su
identificador sin prefijo para usar OAuth Fast. Permitir solo `xai/grok-4.7` no
autoriza esta variante Fast. Una clave que permite únicamente el modelo del protocolo
Fast puede usarlo; las solicitudes normales o con Fast desactivado siguen requiriendo
`xai/grok-4.7`. Con un `fastWire` explícito, permita el modelo que realmente se
envía. Por ejemplo, un transporte `service-tier` conserva `xai/grok-4.7` y requiere
permiso para ese modelo. Las restricciones por proveedor siguen vigentes.
Estas reglas se aplican a Responses, Chat Completions, Messages y las solicitudes de
compactación enrutadas.

xAI cobra Priority Processing a 2 × el precio estándar de los tokens de entrada,
salida, caché y razonamiento; los descuentos de caché se aplican antes del
multiplicador. Las estimaciones solo incluyen ese recargo cuando la respuesta de xAI
confirma `service_tier: "priority"`. Si el nivel falta, no se puede interpretar o
la respuesta devuelve `default`, se conserva el precio estándar.

Para `grok-4.6` y `grok-4.7`, la tarifa estándar por 1M de tokens es $2.00 de
entrada, $0.50 de entrada en caché y $6.00 de salida. Un prompt de al menos
200.000 tokens cambia la tarifa de toda la solicitud a $4.00 / $1.00 / $12.00.
xAI no ha publicado cómo se combina esa banda de contexto largo con Priority
Processing. Cuando una respuesta de contexto largo confirma `priority`, el panel
muestra el costo publicado de contexto largo con un marcador `≥` y una explicación
de que se trata de un límite inferior; no inventa un multiplicador combinado.

<a id="openrouter-fast"></a>

### OpenRouter Rápido

El preajuste canónico `https://openrouter.ai/api/v1` anuncia Fast solo para estas exactas OpenAI -backed identificadores modelo:

- `openai/gpt-5.6-sol`
- `openai/gpt-5.6-terra`
- `openai/gpt-6.1-terra`
- `openai/gpt-5.6-luna`

`anthropic/claude-sonnet-5` y OpenRouter modelos no declarados permanecen sin clasificar. Un valor predeterminado de nivel de proveedor `supportsServiceTier` está intencionalmente ausente, y un conjunto de usuarios `supportsServiceTier: false` aún desactiva las declaraciones de modelo exacto. Las declaraciones del registro se aplican solo mientras el proveedor aún se dirige a la URL base canónica OpenRouter; no se supone que un destino personalizado del mismo nombre comparta el contrato de OpenRouter.

Envíos rápidos `service_tier: "priority"`. No añade ni reescribe `provider.only`, `provider.order` o `provider.allow_fallbacks`. OpenRouter documenta los puntos finales prioritarios como la primera opción de enrutamiento, seguido de un elegante retorno a otros puntos finales cuando la capacidad de prioridad no está disponible. La facturación sigue el punto final realmente utilizado, y la respuesta informa el nivel superior real `service_tier`. Por lo tanto, fijar los puntos finales de nivel y deshabilitar las opciones alternativas reduciría la disponibilidad sin mejorar la seguridad de la facturación.

Los registros de solicitud usan ese eco de respuesta como autoridad. `priority` confirma Rápido según se aplica; `default` registra una degradación y utiliza la estimación del precio estándar; un campo faltante deja el intento asumido en lugar de adivinar una degradación. El multiplicador de prioridad de OpenRouter varía según el flujo ascendente y no se incluye aquí. Cuando se confirma la prioridad pero no se conoce un precio de prioridad exacto, el panel de control mantiene la estimación del precio estándar como un límite inferior documentado y la prefija con `≥`; los intentos degradados no tienen un marcador de límite inferior.

Los proveedores de claves API pueden tener una clave literal o una referencia de entorno. OAuth proveedores utilizan el almacén de credenciales poblado por `ocx login`; el comportamiento de lanzamiento de Claude Code respaldado por suscripción se configura en [`claudeCode.authMode`](/es/reference/configuration/server/#claude-code-claudecode).

OrcaRouter expone ambos formularios explícitamente: `orcarouter` es el proveedor de claves API manual y `orcarouter-oauth` ejecuta el consentimiento del navegador con S256 PKCE, luego almacena la clave API duradera devuelta como una credencial de cuenta. El público por defecto divide intencionalmente la autenticación (`https://www.orcarouter.ai`) de la inferencia (`https://api.orcarouter.ai/v1`). Establecer `ORCAROUTER_BASE_URL` antes del inicio de sesión de la primera cuenta para una implementación autohospedada de un origen, o usar `ORCAROUTER_AUTH_BASE_URL` y `ORCAROUTER_API_BASE_URL` para orígenes separados. Para un punto final autoalojado privado/loopback, **antes del primer inicio de sesión**, cree o actualice `providers["orcarouter-oauth"]` con `adapter: "openai-chat"`, el previsto `baseUrl`, `authMode: "oauth"` y un `allowPrivateNetwork: true` explícito. El inicio de sesión conserva esa configuración del operador y nunca la otorga una anulación de URL. Sin ella, la validación de destino rechaza el punto final local para la inferencia y el descubrimiento de modelos. El oyente de devolución de llamada del navegador OAuth en sí no requiere esta opción de proveedor. Ver el [Ejemplo de configuración de OrcaRouter](/es/guides/providers/).

<a id="provider-diagnostic-outbound-safety"></a>

## Seguridad de salida de diagnóstico del proveedor

Las pruebas de conexión del panel de control y el descubrimiento de modelos en vivo utilizan un transporte limitado solo GET. Sin un proxy de salida, opencodex resuelve el nombre de host una vez y se conecta solo a esa dirección validada. HTTPS conserva la verificación original de host, SNI y certificado; la configuración del proveedor no puede deshabilitar las verificaciones de certificados.

Las descargas de respuestas directas se pausan cuando el procesamiento local aún no está listo
para recibir más datos, también en respuestas gzip y deflate. Esa pausa no cuenta como inactividad
del proveedor; el plazo total de la solicitud y la cancelación siguen vigentes.

Estas operaciones utilizan el [transporte de salida configurado en el servidor](/es/reference/configuration/server/). Un servidor proxy SOCKS5 — establecido con
`config.proxy` o heredado de un SOCKS5 `ALL_PROXY` — utiliza el túnel incorporado de OpenCodex cuando
`NO_PROXY` No exime al objetivo. Esquema específico `HTTP_PROXY` y
`HTTPS_PROXY` conservar el manejo nativo de HTTP(S) de Bun, mientras que un manejo no SOCKS `ALL_PROXY` No es un nativo Ruta HTTP fetch. URL y las comprobaciones de direcciones literales aún se ejecutan, pero un proxy seleccionado elige el final ruta, respuesta DNS y par, por lo que opencodex no puede fijar o verificar ese par. Este es un explícito Limitación de seguridad.

Los destinos privados/locales requieren `allowPrivateNetwork: true` y, cuando un proxy saliente está activo, una entrada `NO_PROXY` coincidente. Loopback se agrega automáticamente; lista cada host LAN explícitamente porque las entradas CIDR no se interpretan. El emparejador admite hosts exactos, sufijos de dominio, puertos opcionales, IPv6 entre corchetes y `*`; por ejemplo, enumere `192.168.1.50` explícitamente. Los metadatos y los destinos locales de enlace permanecen bloqueados. Las solicitudes de diagnóstico rechazan las redirecciones e informan sobre un destino con credenciales eliminadas. La revisión ordinaria de la redirección de solicitudes del proveedor permanece separada de esta guardia de diagnóstico.

Dos falsos IP DNS existen adaptaciones para los usuarios de Clash / Surge / Mihomo, y ambos se aplican a DNS
*respuestas* solo — una dirección literal en el URL sigue siendo rechazada. La gama de referencia IANA
`198.18.0.0/15` (y su ortografía IPv4-mapped IPv6) se acepta siempre que un proxy saliente aplique al anfitrión. El rango de IPv6 fake-IP predeterminado de Mihomo `fdfe:dcba:9876::/48` es aceptado en un estricto puerta: la variable proxy que coincide con el esquema URL (`HTTPS_PROXY` por
`https:`, `HTTP_PROXY` por `http:`o un SOCKS5 `ALL_PROXY` debe ser establecido (un non-SOCKS `ALL_PROXY` hace no contar), el anfitrión no debe coincidir `NO_PROXY`, y el La solicitud se vincula a ese proxy explícitamente. Cualquier otro ULA, un prefijo adyacente o una respuesta de IP falsa mezclada con una respuesta privada real todavía requiere `allowPrivateNetwork: true`. Tiempo de ahorro del proveedor La validación nunca aplica la acomodación IPv6.

<a id="codex-account-pool"></a>

## Grupo de cuentas Codex

Utilice **Codex Auth** en el panel de control para agregar cuentas de grupo y actualizar cuotas. `config.json` almacena metadatos no secretos; los tokens de acceso y actualización usan el almacén de credenciales reforzado. El enrutamiento Pool separa la asignación nueva/no vinculada, la conmutación proactiva basada en el uso y la recuperación de fallas. Una tarea ligada normalmente mantiene la afinidad. Por defecto (`pool.cacheAffinity`) `quota` no lo vuelve a vincular simplemente porque se cruza el umbral de uso; ese rebind espera hasta que la cuenta vinculada se agote o no pueda servir, y luego solo en una cuenta con margen de cuota genuino y uso estrictamente más bajo. Establecer `pool.cacheAffinity: false` para restaurar la reasignación umbral de las tareas vinculadas, todavía sólo en tal destino. La pausa, el tiempo de reutilización, la reautenticación y los rechazos de cuotas aún liberan un enlace en vivo de inmediato. Una racha de fracaso transitorio sirve la solicitud de otra cuenta mientras se mantiene el enlace, y la tarea vuelve una vez que la cuenta sirve de nuevo; después de 10 minutos, el enlace se libera normalmente. Una solicitud no enlazada no tiene vinculación de cuenta activa; esto puede incluir una tarea visible existente después de reiniciar proxy o reinicio de afinidad. Una respuesta previa al flujo 429 o 402, o una respuesta 5xx cuyo cuerpo limitado informa explícitamente del agotamiento de la cuota, vuelve a intentar una vez en una cuenta alternativa elegible en la misma solicitud, incluso cuando la conmutación proactiva basada en el uso está desactivada. La política transitoria ordinaria 5xx se ejecuta en primer lugar, por lo que una respuesta de cuota incluida puede generar hasta tres envíos en la cuenta agotada antes de la rotación del grupo. Los cambios en la cuenta preservan y reproducen el contexto de la conversación, pero no se garantiza la reutilización del prompt-cache del lado del proveedor en todas las cuentas y es posible que la caché deba calentarse nuevamente.

En un **401/403**, el inicio de sesión de la aplicación borra la afinidad de proceso local de esa cuenta y requiere una reautenticación. En un **429**, opencodex honra a `Retry-After`, inicia el enfriamiento de la cuenta, borra la afinidad y puede rotar la solicitud a otra cuenta elegible de Pool. Estas transiciones de falla permanecen activas con `autoSwitchThreshold: 0`; esa configuración deshabilita solo la conmutación proactiva basada en el uso.

La pausa de una cuenta conserva sus metadatos de cuota, pero la excluye de la conmutación, conmutación por error, sondas de recuperación y activación manual. También aclara las afinidades de hilo de esa cuenta. Las solicitudes en vuelo mantienen las credenciales capturadas; los giros posteriores se redirigen. Si todas las cuentas están en pausa, el enrutamiento Pool falla en lugar de elegir una silenciosamente. **Pausa agotada** actualiza las cuentas elegibles con credenciales disponibles y pausa solo las cuentas recién confirmadas al 100%; las actualizaciones desconocidas o fallidas permanecen sin cambios.

| Estrategia | Comportamiento |
| --- | --- |
| `quota` (por defecto) | Si no existe una cuenta activa, elija la cuenta elegible de menor uso en ventanas de 5 horas, semanales y de 30 días. De lo contrario, mantenga una cuenta activa elegible por debajo de `autoSwitchThreshold`; después de que cruce el umbral, una solicitud no vinculada puede pasar a una cuenta elegible de menor uso. Las tareas vinculadas mantienen la afinidad de caché de forma predeterminada y permanecen hasta que la cuenta se agote (uso conocido al 100%) o no pueda servir (pausa, inutilizable); un movimiento requiere espacio libre de cuota genuino y un uso estrictamente menor en el destino, por lo que la tarea se mantiene cuando cada cuenta supera el umbral o la única cuenta más fresca tiene un uso desconocido. Establecer `pool.cacheAffinity: false` para permitir que la siguiente solicitud de una tarea vinculada se mueva en el umbral, todavía solo a tal destino. `0` deshabilita esta reevaluación basada en el uso, no la recuperación de fallas. |
| `round-robin` | Asignar uniformemente solicitudes no vinculadas a través de cuentas elegibles. La rotación es contra e ignora los umbrales de uso, pero el filtro de nivel de prioridad compartido aún evalúa el margen de cada cuenta utilizando su umbral efectivo (anulación de cuenta o valor predeterminado global). `accountPoolStickyLimit` (1-100) cuenta las asignaciones en una selección, sin respuestas ascendentes exitosas. |
| `fill-first` | Asignar solicitudes no vinculadas a la cuenta activa hasta el tiempo de reutilización, la reautenticación o el umbral de drenaje efectivo de esa cuenta (anulación de cuenta o valor predeterminado global); el uso desconocido no obliga a cambiar. Las tareas atadas saludables mantienen la afinidad. |

La rotación no protege contra la aplicación del proveedor; el uso de múltiples cuentas puede violar los términos del proveedor.

### `anthropicAccountPool` (experimental)

Esta opción agrupa varias cuentas OAuth Anthropic ya almacenadas en `auth.json`. Está desactivado por defecto y experimental, y Anthropic no ha respaldado la agrupación automatizada de cuentas. Las cuentas de la misma organización pueden compartir cuotas, y el cambio de cuentas no protege contra las restricciones del proveedor. Vea el [Claude Code guía](/es/guides/claude-code/#claude-oauth-account-pool-experimental) para las condiciones de suscripción y cliente para las que está destinado el grupo.

| Clave | Tipo | Predeterminado | Descripción |
| --- | --- | --- | --- |
| `anthropicAccountPool.enabled?` | `boolean` | `false` | Habilitar la afinidad de sesión pegajosa y la selección de nueva sesión con clasificación de cuota. **429 failover no está cerrado aquí**: se activa cada vez que se almacenan dos o más cuentas utilizables, exactamente como cualquier otro proveedor multicredencial, y no se puede desactivar. |
| `anthropicAccountPool.nativeMessages?` | `boolean` | `true` | Prefiera Claude Messages nativo para rutas directas elegibles Anthropic cuando la agrupación esté habilitada. Todavía se aplican las opciones de exclusión de implementación nativa explícita. `false` selecciona el puente heredado para las solicitudes agrupadas; pool-off conserva el comportamiento de despliegue explícito. |
| `anthropicAccountPool.autoSwitchThreshold?` | `number` | `80` | Para nuevas sesiones, cuando la cuenta activa alcanza este umbral, elija el uso de caché más bajo conocido en la ventana configurada; la cuenta elegida no tiene que estar en o por encima del umbral. `0` deshabilita la conmutación basada en el uso de **Proactivo** solamente - nueva sesión de selección y recuperación de enrutamiento después de un elegible 429 todavía consultar `quotaWindow`. |
| `anthropicAccountPool.strategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | Nueva estrategia del período de sesiones; `quota` clasifica las cuentas por la ventana establecida por `quotaWindow`, y `fill-first` evalúa su umbral de drenaje en esa misma ventana. |
| `anthropicAccountPool.quotaWindow?` | `"five-hour" \| "weekly" \| "max-utilization"` | `"five-hour"` | La barra de utilización reportada por el proveedor en caché utilizada para la selección de la cuenta consciente del uso. `five-hour` mantiene el comportamiento original. `weekly` anota la barra semanal y salta cuentas cuya barra de 5 horas se agota mientras que otra cuenta elegible permanece, pero vuelve a los candidatos agotados cuando ninguno lo hace. `max-utilization` obtiene la barra más alta conocida, por lo que puede usar 5 horas de uso antes de que esté disponible el uso semanal; si no se conoce ninguno, la cuenta sigue un orden de uso desconocido. El uso conocido se clasifica antes del uso desconocido bajo las ventanas opt-in `weekly` y `max-utilization` solamente; un `five-hour` omitido o explícito conserva el orden heredado. Si se desconoce cada cuenta elegible, la selección aún devuelve una en orden elegible. Después del tie-break documentado de menos de 5 horas, los empates exactos conservan el orden elegible. Una sesión saludable ligada a afinidad no se reequilibra proactivamente. Para la asignación de nueva sesión y la recuperación de enrutamiento después de un reemplazo elegible de 429, `quota` clasifica a los candidatos elegibles directamente con esta ventana; `fill-first` avanza en orden estable utilizando el umbral de esta ventana y las reglas de agotamiento; `round-robin` lo ignora. El tiempo de reutilización, los límites de conmutación por error y la elegibilidad de reautenticación siguen siendo estados locales separados. Las barras semanales por cuenta provienen de sondas de uso o encabezados de respuesta observados. |
| `anthropicAccountPool.stickyLimit?` | `number` | `1` | Nueva sesión exitosa se une retenido en una selección round-robin. Alcance 1-100. |
| `anthropicAccountPool.routes?` | `{name, match, accounts, fallback?}[]` | — | Rutas de modelos ordenadas para el grupo Anthropic OAuth habilitado. `match` es un glob de ID de modelo completo y sensible a las mayúsculas de los casos (`*` y `?`); gana el primer partido. `accounts` contiene ID de cuenta almacenados, no alias. Las cuentas elegibles están limitadas a la ruta para la selección inicial y 429 reintentos. Sin reserva, una ruta vacía devuelve un 401 o 429 local con `Retry-After` de alcance de ruta si todas sus cuentas declaradas se están enfriando. Con `fallback: true`, un grupo ordinario de enfriamiento completo devuelve 429 con su primer tiempo de reutilización utilizable, incluso si se eliminó una cuenta de ruta guardada; la respuesta del cliente nunca nombra la ruta; el registro proxy usa `route:#<n>` para la posición basada en la regla 1. `fallback: true` se amplía solo cuando ninguna cuenta enrutada es elegible; primero rellene y luego use el orden de grupo ordinario. Ninguna regla coincidente mantiene la selección normal; la desactivación del grupo hace que las rutas guardadas estén inactivas. Las reglas no válidas no validan las escrituras y evitan el envío encaminado hasta que se corrigen. `null` despeja las rutas a través de los ajustes API. |

Anthropic OAuth ayudantes de visión y búsqueda web coinciden con estas rutas utilizando el modelo de cada ayudante, independientemente del modelo de solicitud principal. Cada ayudante se autentica con su cuenta enrutada, que puede diferir de la cuenta globalmente activa. Si una ruta helper estricta no tiene una cuenta elegible, el helper falla localmente antes de cualquier solicitud del proveedor; no usa silenciosamente una cuenta fuera de la ruta. Cuando la solicitud principal funciona pero falla la descripción de la imagen o la búsqueda web, compruebe el modelo configurado del ayudante y las cuentas elegibles para la ruta de ese modelo.

Los 429 de cuota compartida (ventanas compartidas rechazadas de 5h/7d) enfrían la cuenta de servicio y pueden recuperarse en un hermano elegible. Retry-After gana, de lo contrario se usa el último reinicio válido rechazado, con un valor predeterminado de 60 segundos cuando no se puede usar una fecha límite. Un acelerador de velocidad transitoria pausa solo la admisión de esa cuenta, conserva la afinidad y permite un reintento corto de la misma cuenta más como máximo un desvío de hermanos por solicitud. Un 429 sin encabezado permite como máximo un breve reintento en la misma cuenta, deja la salud de la cuenta intacta y no agrega reintento sintético. Estos reintentos comparten el presupuesto de envío físico y se detienen en la cancelación o en la salida transmitida comprometida. El comportamiento predeterminado de una sola cuenta no cambia. La evidencia semanal y familiar compartida del modelo solicitado determina su admisión en el grupo. Un rechazo solo de Fable mantiene a Sonnet elegible en la misma cuenta. La evidencia pasiva de Fable envejece después de treinta minutos o su reinicio conocido y se revalida con una solicitud de entrega a la vez. Los umbrales de uso siguen siendo preferencias blandas con una alternativa totalmente drenada; estos controles no son límites de uso o facturación difíciles. Las sondas de uso activo preservan las ventanas de familia ausentes a menos que la respuesta enumere los límites de manera autorizada. La afinidad es proceso-local y tamaño-limitado. Los fallos de credenciales de actualización de token conservan la política de autenticación existente. 403s de pre-salida de autorización de cuenta clara afinidad y enfriar la cuenta para `Retry-After`, o diez minutos por defecto, antes de intentar un reemplazo elegible. Los 403 genéricos o de nivel de solicitud siguen siendo terminales; véase [Claude recuperación de la cuenta](/es/guides/claude-code/). Si todas las cuentas elegibles se están enfriando, los clientes reciben 429 con `Retry-After` cuando se conocen, no un error de autenticación.

Cuando cada cuenta que la solicitud puede usar se mantiene en la cuota gastada (una ventana compartida de 5 horas o semanal, o la ventana semanal de la familia de modelos solicitada), ese 429 es un límite de uso en lugar de un límite de tasa: el cuerpo Responses lleva `error.type` y `error.code` `usage_limit_reached` y, cuando se conoce el reinicio aguas arriba de cada cuenta retenida, `resets_at` (época segundos del primer reinicio). Codex se detiene en esta respuesta y muestra cuándo volver a intentarlo en lugar de volver a intentarlo hasta "límite de reintento superado". El rechazo de la última cuenta de la cuota gastada obtiene la misma respuesta una vez que no queda ningún reemplazo. Si alguna cuenta retenida solo está limitada temporalmente por tasa de solicitudes, requiere revalidar una familia de modelos o se rechaza por falta de permisos de uso, la respuesta permanece en el `rate_limit_exceeded` reintentable. Los objetivos combinados mantienen la forma de límite de velocidad para que el combo pueda moverse a su siguiente objetivo. Nativo `/v1/messages` mantiene Anthropic 's `rate_limit_error` tipo; sus nombres de mensaje el límite de uso.

Un tiempo de reutilización de cuota se levanta temprano una vez que una nueva lectura de uso (la página de proveedores del panel de control, o `ocx account list anthropic --quota --refresh`) muestra cada ventana que el rechazo rechazó por debajo del 100%, ya sea que el tiempo de reutilización provenga de `Retry-After` o de un reinicio de ventana. Esto cubre una actualización del plan o una ventana que se reabrió antes. Una lectura tomada antes del rechazo nunca lo levanta, y los tiempos de reutilización de los derechos 403 esperan su fecha límite.

Anthropic respuestas también informan de la utilización de 5 horas y semanal de la cuenta de servicio, y cualquiera de las dos que lleva una respuesta dada se registra contra esa cuenta, cada ventana de forma independiente, tanto sobre los rechazos como sobre los éxitos. Por lo tanto, la selección consciente del uso funciona desde las cuentas que realmente usa, sin esperar a que la página de proveedores del panel de control las interrogue. Estas lecturas actualizan la fila existente en lugar de reemplazarla, por lo que las barras semanales con alcance de modelo solo se conservan los informes de punto final de uso hasta que pase su tiempo de reinicio conocido. Las mediciones caducadas se vuelven desconocidas, incluyendo las ventanas estándar retenidas omitidas por encabezados posteriores. Un encabezado de solo reinicio no puede extender una medición de utilización anterior. Los valores sin restablecimiento conocido conservan su comportamiento existente; las mediciones faltantes nunca se reemplazan con uso cero.

Las observaciones de cabecera no posponen las sondas de uso ni borran el estado no disponible de una sonda fallida. Después del reinicio, las observaciones Anthropic en caché permanecen disponibles mientras la siguiente cuota lee las sondas nuevamente, porque las observaciones guardadas no incluyen el reloj de la sonda.

:::caution[Experimental]
Deje esto deshabilitado a menos que entienda el riesgo de la política de cuenta Anthropic. Prefiero manual
`ocx account use anthropic <id>` Cambiar cuando no está seguro.
:::

<a id="anthropic--pool-2-anthropic2"></a>

### Anthropic · Pool`anthropic2`)

`anthropic2` (" Anthropic + Pool 2") es un segundo proveedor incorporado Anthropic OAuth con su propio fondo de cuentas. Ejecuta la misma implementación Anthropic que `anthropic`: el mismo flujo de inicio de sesión, formato de cable, puente nativo Messages y Responses y metadatos del modelo. Solo las cuentas y el grupo a su alrededor están separadas. Elija un grupo con el prefijo del modelo: `anthropic/claude-sonnet-5` usa el grupo principal y `anthropic2/claude-sonnet-5` usa Pool 2.

Pool 2 permanece inactivo hasta que lo agregue. Inicie sesión con `ocx login anthropic2` o agregue **Anthropic · Pool 2** en la página de proveedores del panel de control. Un primer inicio de sesión exitoso crea `providers.anthropic2` con el marcador `"anthropicOAuthInstance": "anthropic2"`. Pool 2 nunca se convierte en el proveedor predeterminado: los nombres de modelo `claude-*`, el modelo predeterminado y el reenvío de llamadas Claude Code siguen resolviendo `anthropic`. Una entrada `anthropic2` sin marcar que creó anteriormente mantiene su significado personalizado; el inicio de sesión rechaza la colisión del nombre y no reescribe ni la entrada ni sus credenciales.

Pool 2 lee la configuración de su grupo desde su propia entrada de proveedor. Las claves, los valores predeterminados y el comportamiento coinciden con el nivel superior [`anthropicAccountPool`](#anthropicaccountpool-experimental), y nada se hereda del grupo principal. `providers.anthropic.anthropicAccountPool`, o el campo en cualquier otro proveedor, es rechazado.

```json
{
  "anthropicAccountPool": { "enabled": true, "strategy": "quota" },
  "providers": {
    "anthropic2": {
      "adapter": "anthropic",
      "authMode": "oauth",
      "baseUrl": "https://api.anthropic.com",
      "anthropicOAuthInstance": "anthropic2",
      "anthropicAccountPool": { "enabled": true, "strategy": "round-robin" }
    }
  }
}
```

Los dos grupos están aislados dentro de opencodex:

- **Credenciales:** Pool 2 cuentas se almacenan bajo su propia clave `anthropic2` en el almacén de credenciales protegidas. Se rechaza un inicio de sesión cuyo token o cuenta verificada Anthropic ya está almacenada en el otro grupo.
- **Pool configuración y estado de ejecución:** selección, afinidad de sesión, tiempos de reutilización, pausas, rutas de modelo y umbrales por cuenta pertenecen a un grupo. La ruta `fallback: true` se ensancha solo dentro de el mismo grupo.
- **Cuota y uso:** sondas de uso, cachés de cuota y atribución de uso se registran por grupo, por lo que un ID de cuenta que existe en ambos grupos todavía tiene dos registros separados.
- **Restablecer subvenciones:** Pool 2 mantiene su propio diario (`anthropic2-reset-grant-ledger.json`) junto al diario sin cambios del grupo primario.
- **Recuperación:** a directo `anthropic2/<model>` La petición nunca vuelve al grupo principal, y un El límite de solicitudes o el rechazo de Pool 2 nunca enfría una cuenta de grupo principal. Un combo explícito que nombra a ambos pools mantiene los objetivos declarados.

Esta separación es un límite de enrutamiento dentro de opencodex. No cambia la forma en que Anthropic trata sus cuentas o el [riesgo de política de cuenta](#anthropicaccountpool-experimental) descrito anteriormente.

Pool 2 cuentas se agregan solo a través del navegador OAuth. A diferencia de `anthropic`, Pool 2 nunca importa, adopta o escribe un token Claude Code CLI; esta diferencia es intencional. Pool 2 comienza vacío, y una Pool 2 solicitud sin Pool 2 cuenta utilizable falla con un error de autenticación en lugar de tomar prestado un grupo primario o Claude Code credencial.

Los comandos de cuenta y las API de administración toman el grupo por su nombre: `ocx account pool anthropic2 …`, `ocx account auto-switch anthropic2 …`, `ocx account routes anthropic2 …` y `ocx account anthropic-reset-grants --provider anthropic2`. La configuración del grupo y los puntos finales de concesión de reinicio aceptan `provider: "anthropic2"`; omitiéndolo mantiene el grupo principal.

<a id="helper-pool-selection-anthropicinstance"></a>

#### Selección de grupos de ayuda (`anthropicInstance`)

Los ayudantes de búsqueda y visión web aceptan un `anthropicInstance` opcional, en la configuración global `webSearchSidecar` y `visionSidecar` y en el Claude Code anula `claudeCode.webSearchSidecar` y `claudeCode.visionSidecar`. El panel de control lo muestra como un **Pool** seleccionar cuando el helper backend es Anthropic.

| Valor | Comportamiento |
| --- | --- |
| unset (por defecto) | Siga el grupo de la solicitud actual: una solicitud `anthropic2/<model>` utiliza Pool 2 y una solicitud `anthropic/<model>` utiliza el grupo principal. Una solicitud de otro proveedor mantiene el descubrimiento de ayudante existente, que nunca selecciona Pool 2. |
| `"anthropic"` | Utilice siempre el grupo principal. |
| `"anthropic2"` | Utilice siempre Pool 2. |

El campo solo se aplica cuando el backend del ayudante se resuelve a Anthropic. Establecerlo con otro backend es un error de validación; porque la búsqueda web por defecto es OpenAI, también establece `"backend": "anthropic"`. También se rechaza un modelo de ayudante calificado con el otro grupo, como `anthropic/claude-sonnet-5` con `"anthropicInstance": "anthropic2"`. Si el grupo elegido no tiene una cuenta utilizable, el ayudante falla antes de enviar nada; no cambia al otro grupo. La solicitud principal continúa sin ese ayudante. Una elección no establecida se guarda como ausente, nunca como `"anthropic"`.

```json
{
  "webSearchSidecar": { "backend": "anthropic", "anthropicInstance": "anthropic2" }
}
```

:::caution[Volver a una versión anterior]
Las versiones sin Pool 2 no entienden la `anthropic2` entrada. Antes de instalar un viejo versión, detener el proxy, copia de seguridad `config.json` y `auth.json`, y eliminar
`providers.anthropic2` Desde `config.json`. Las credenciales de grupo primario nunca se mueven ni reescriben Pool 2. No se admite una degradación in situ con un Pool 2 activo.
:::

### `oauthAccountFailover`

Rota a otra cuenta registrada del mismo proveedor cuando uno está limitado por tarifa, para OAuth proveedores que no tienen un grupo propio: xAI, Cursor, Kimi, GitHub Copilot, Google Antigravity y Nous.

**Entrar en una segunda cuenta es lo que enciende esto, y nada lo apaga.** Rotación activa para cualquiera de esos proveedores que posean 2 o más cuentas que no estén marcadas para Reautenticación — la misma regla `apiKeyPool` ya se aplica a un grupo de claves 2+. Un proveedor con una cuenta almacenada se comporta exactamente como antes.

La rotación aquí se ejecuta solo *después* aguas arriba ya ha rechazado la solicitud, por lo que la única opción que un interruptor de desactivación podría ofrecer es entre volver a intentar en una segunda cuenta que inició sesión deliberadamente y devolver un 429 mientras esa cuenta permanece inactiva. El rechazo de la rotación se expresa al no almacenar una segunda cuenta.

| Clave | Tipo | Predeterminado | Descripción |
| --- | --- | --- | --- |
| `oauthAccountFailover.enabled?` | `boolean` | presencia-conducido | Anulación global solo para el **Preferencia de cuenta pre-envío**. `false` impide que una solicitud saludable se dirija hacia la cuenta con más espacio libre conocido. No desactiva la rotación ante errores 429. |
| `providers.<name>.oauthAccountFailover.enabled?` | `boolean` | hereda | Anulación por proveedor para la misma preferencia; supera la configuración global en cualquier dirección. `false` declina la preferencia por este proveedor incluso cuando la configuración global es `true`, y `true` opta por este proveedor incluso cuando la configuración global es `false`. La rotación reactiva 429 no se ve afectada de ninguna manera. |
| `providers.<name>.oauthAccountFailover.sessionAffinity?` | `"conversation" \| "none"` | `"none"` | Conversación opt-in para grupos genéricos OAuth. Requiere `enabled: true` proactivo (proveedor o valor global heredado). Las sesiones existentes mantienen su cuenta por delante de la estrategia de la nueva sesión hasta que no esté disponible. |
| `providers.<name>.oauthAccountFailover.strategy?` | `"quota" \| "round-robin" \| "fill-first" \| "reset-first" \| "least-loaded"` (solo Kiro) | — | Kiro 's `least-loaded` elige la cuenta elegible con la menor cantidad de solicitudes en vuelo, utilizando el orden de las cuentas para resolver los empates. Requiere `pool.kernel` y preferencia proactiva; otras estrategias conservan sus reglas existentes. `reset-first` también requiere `pool.kernel`: entre las cuentas elegibles que no se agotan, el primer intento (mientras que la preferencia proactiva está activada) y una rotación de 429 prefieren la cuenta cuya cuota se restablece más pronto (la ventana semanal cuando se informa, de lo contrario la ventana de 5 horas), con mayor margen disponible para resolver los empates. Las cuentas agotadas son las últimas. Sin evidencia de cuotas, o cuando un proveedor pasivo tiene evidencia solo para algunas cuentas, vuelve al orden de margen. El grupo Anthropic no lo acepta. |
| `providers.kiro.oauthAccountFailover.maxConcurrentPerAccount?` | número entero 1-100 | ilimitado | Una cola por cuenta de proceso local mantiene una ranura hasta la finalización o cancelación de la respuesta. Una cuenta seleccionada completa espera como máximo 250 ms, luego devuelve 503 `account_capacity` con `Retry-After: 1`. El límite no mueve la solicitud a otra cuenta. |
| `providers.<name>.oauthAccountFailover.autoSwitchThreshold?` | `number` | `80` | 0-100 por ciento de uso en el que `fill-first` avanza fuera de la cuenta activa (#695). Juego con `ocx account auto-switch <provider> threshold <n>`. Leer solo por debajo de `pool.kernel` con `strategy: "fill-first"`; una cuenta sin uso medido cuenta como debajo del umbral. |
| `providers.<name>.oauthAccountFailover.stickyLimit?` | `number` | `1` | Los despachos exitosos se conservaron en una selección de `round-robin`, 1-100 (#695). Leer solo bajo `pool.kernel` con `strategy: "round-robin"`. |

Para rechazar la dirección proactiva de la cuenta para un proveedor cuyos términos preferiría no probar, mientras se recupera de un límite de solicitudes:

```json
{
  "providers": {
    "cursor": {
      "oauthAccountFailover": { "enabled": false }
    }
  }
}
```

Esa configuración sobrevive al inicio de sesión, la adición de una cuenta y la reautenticación.

Los proveedores genéricos OAuth (Google Antigravity, xAI, Cursor, Kimi, GitHub Copilot, Nous y cualquier otro proveedor OAuth fuera de los grupos Codex y Anthropic) también aceptan `strategy` y `autoSwitchThreshold` en la misma clave, a través de `GET` / `PUT /api/oauth/accounts/pool?provider=<name>` y los verbos `ocx account strategy` / `ocx account auto-switch` / `ocx account sticky`. La respuesta transporta `"inert"` para esos tres campos solamente - `true` mientras están almacenados pero no consumidos, `false` una vez que `pool.kernel` está encendido y realmente seleccionan una cuenta - `enabled` está activa y gobierna la preferencia de pre-despacho. `quotaWindow` no forma parte del contrato genérico. Codex ( `/api/codex-auth` ) y Anthropic ( `anthropicAccountPool` ) mantienen sus propios contratos sin cambios.

Establecer `providers.<name>.oauthAccountFailover.sessionAffinity` a `"conversation"` junto con `enabled: true` para mantener una conversación en su cuenta admitida. La identidad de sesión usa el marcador de subproceso cliente, encabezados de sesión, encabezado de subproceso, luego `prompt_cache_key`; se excluye una cohorte de caché de escritorio compartida. Los enlaces son aislados por el proveedor, el hogar de configuración y el principal de llamada autenticado. Las llamadas locales no autenticadas comparten el alcance local. Sin marcador de sesión significa que no hay unión.

Las nuevas sesiones utilizan la estrategia existente (`pool.kernel` todavía puertas round-robin/fill-first). Las sesiones existentes permanecen ancladas incluso cuando otra cuenta tiene más cuota. Una pausa, un requisito de reautenticación, un tiempo de reutilización familiar o una lista de modelos incompatibles liberan la vinculación; la recuperación de fallas limitada existente vincula el reemplazo admitido. El límite de concurrencia de Kiro aún espera o se niega en lugar de mover una conversación vinculada saludable simplemente para equilibrar la carga.

En este modo, las opciones automáticas, incluidas las solicitudes sin claves y las conmutación por error, permanecen locales: la cuenta seleccionada del panel de control sigue siendo la selección del operador. El historial de solicitudes sigue atribuyendo la cuenta de servicio. La selección manual, la reselección de la misma cuenta y los cambios en la revisión de la lista/política invalidan los vínculos del proveedor, incluidas las escrituras de otro proceso. Una actualización ordinaria mantiene la misma cuenta. Fill-first conserva su cuenta actual en la memoria sin cambiar la selección guardada. Los enlaces expiran después de 24 horas sin admisión, están limitados a 2.000 entradas en todo el proceso (incluidos los cursores de relleno primero) y se pierden al reiniciar. Establezca `sessionAffinity: "none"` o deshabilite la preferencia proactiva para liberarlos. Codex y Anthropic mantienen sus propios contratos de afinidad.

El grupo Codex y el grupo Anthropic están excluidas y mantienen su propia rotación; permitiendo que esto cambie tampoco. Un proveedor con una sola cuenta almacenada es un estricto no-op, y no se registra ningún tiempo de reutilización para ello.

Antes del envío, genérico OAuth instantáneas de la lista elegible. En un 429 la cuenta fallida se enfría usando `Retry-After` cuando está presente (limitada a 15 minutos) o un retroceso predeterminado, y la solicitud se reproduce en la siguiente cuenta seleccionada de la lista en vivo. El techo de rotación estable es `max(3, min(eligibleCount, 6) - 1)` por solicitud; la selección en vivo aún filtra los tiempos de reutilización, y nunca se selecciona una cuenta marcada para la reautenticación. Los tiempos de reutilización son locales, por lo que un reinicio los olvida.

Cuando al menos dos cuentas son elegibles, la asignación de envío por defecto de propiedad de ingreso cubre hasta tres envíos por cuenta elegible, contando como máximo seis cuentas, por lo que una solicitud no hace más de 18 envíos, sin embargo, muchas cuentas están inscritas. Una sola cuenta elegible mantiene la asignación básica existente de tres y la asignación total de cuatro. Los techos de llamadas explícitas y los ámbitos combinados mantienen sus límites existentes.

Rotation lleva la instantánea de credenciales **lleno** de la cuenta alternativa, no solo su portador, por lo que un proveedor que empareja metadatos de enrutamiento con su identificador de proyecto Cloud Code Assist de Antigravity, por ejemplo, no puede terminar enviando el token de una cuenta con los metadatos de otra cuenta.

Para la inferencia primaria Antigravity a través del despacho principal del adaptador Google, un 401 primero actualiza y reproduce la misma cuenta. Si esa repetición sigue siendo 401, o la actualización falla con un rechazo de credenciales de terminal que requiere una reautenticación, la solicitud puede cambiar una vez a un hermano en vivo elegible. Esa solicitud hermana mantiene los reintentos transitorios ordinarios del adaptador, y cada envío físico cuenta con el presupuesto de envío existente de la solicitud. Un fallo de actualización transitoria mantiene el error de autenticación desinfectado. Se omiten las cuentas de pausa, de reautenticación requerida y de enfriamiento; la credencial fallida obtiene un tiempo de reutilización en proceso de 60 segundos solo mientras su generación es actual. El mismo despacho principal también puede conmutar una vez en un 403 cuando la normalización de errores delimitados de Google encuentra una razón estructurada completa de `VALIDATION_REQUIRED`. Las rutas 401 y 403 comparten un intento hermano por solicitud; una ruta 403 no relacionada o incompleta mantiene su error original. Un hermano rechazado, la cancelación o el presupuesto de envío agotado no causan otro envío ascendente. El bucle de búsqueda web basado en fetch también gira una vez en esta razón estructurada 403, utilizando el token OAuth del hermano y el proyecto Cloud Code Assist. Solo acepta sobres de error Google completos y delimitados con `error.details[].reason === "VALIDATION_REQUIRED"`; la redacción de verificación por sí sola no autoriza la rotación, y esta ruta no persiste como una marca de reautenticación. Cada envío físico, incluyendo un reintento 429, consume el mismo presupuesto de solicitud exactamente una vez. Un grupo deshabilitado, cancelación, presupuesto agotado o hermano no disponible conserva el fallo. Si falla la construcción o el envío de la solicitud entre hermanos, el 403 con límite original sigue siendo el error; una repetición rechazada antes del envío físico devuelve su asignación de envío no utilizada. Las continuaciones, el paso a través de Responses nativo, los sidecars de imagen y la salida ya enviados al cliente no usan esta rotación.

El alcance actual son las rutas de solicitud Responses ordinarias. Cursor informa de los límites de velocidad como eventos del adaptador en lugar de un estado HTTP, y el punto final de la imagen independiente Antigravity tiene su propia ruta de solicitud; ninguno de los dos gira todavía.

:::caution[Experimental]
Rotar entre cuentas de suscripción gasta la cuota de una segunda cuenta y puede violar algunas términos de los proveedores. Si eso no es una compensación que desea, establezca `enabled: false` globalmente o para el proveedor en cuestión.
:::

<a id="managed-record-shapes"></a>

### Formas de registro administradas

`apiKeys[]` entradas contienen `id`, `name`, generado `key`, y cadenas ISO `createdAt`. Opcional `allowMeteredComboTargets: true` permite explícitamente los objetivos marcados `metered: true`; el consentimiento omitido o falso los niega. El token de entorno nunca califica. Las personas que llaman solo en bucle local pueden usar per-combo `allowMeteredTargets: true`; las personas que llaman con clave configurada y vinculada aún necesitan consentimiento de clave. Véase [Consentimiento de fallback medido](/es/guides/combos/#metered-fallback-consent). `codexAccounts[]` entradas requieren `id`, `email`, y `isMain`, con opcional `plan`, `chatgptAccountId`, y la privacidad de seguridad `logLabel`. Estos registros normalmente se administran en el panel de control.

### `tokenGuardian` (`OcxTokenGuardianConfig`)

| Campo | Tipo | Predeterminado | Descripción |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | Interruptor proactivo-actualizado global. |
| `tickSeconds?` | `number` | `21600` | Intervalo de barrido (6 horas, mínimo 60 segundos). |
| `jitterSeconds?` | `number` | `300` | Retraso aleatorio antes de un barrido. |
| `concurrency?` | `number` | `3` | Máximas actualizaciones simultáneas. |
| `leadSeconds?` | `number` | `900` | Tiempo de espera de actualización adicional más allá de una marca. |
| `failureBackoffBaseSeconds?` | `number` | `300` | Retroceso transitorio inicial. |
| `failureBackoffMaxSeconds?` | `number` | `3600` | Techo de retroceso y retraso de falla permanente. |
| `codexWarmupEnabled?` | `boolean` | `false` | Opte por la validación sintética de la cuenta de grupo Codex. |
| `codexWarmupMaxAgeSeconds?` | `number` | `691200` | Revalida una cuenta después de 8 días. |
| `codexWarmupModel?` | `string` | `gpt-5.6-luna` | Modelo nativo utilizado para el calentamiento opcional. |

<a id="fixed-provider-endpoints"></a>

## Endpoints de proveedores fijos

El enrutamiento resuelve un extremo del proveedor antes del adaptador. Para la mayoría de las funciones integradas, el punto final del registro gana sobre el `baseUrl` configurado. Cuatro tipos de entrada mantienen la URL configurada:

- proveedores habilitados para anulación: `ollama`, `vllm`, `lm-studio`, `litellm`, `qwen-cloud` y `alibaba-token-plan-intl`;
- plantillas de registro rellenadas por el usuario, tales como `azure-openai` y `cloudflare-ai-gateway`;
- Promocionado fijo API -preajustes de clave que preservan un destino personalizado del mismo nombre más antiguo; y
- proveedores ausentes del registro.

Los adaptadores pueden ajustar la URL resuelta después. Kiro, por ejemplo, sigue la región API de la credencial importada para el canónico `runtime.{region}.kiro.dev`. Véase [Adaptadores](/es/reference/adapters/).

Cuando el encaminamiento descarta `baseUrl`, opencodex registra el punto final del registro y solo el origen configurado; una ruta configurada puede contener una credencial. Elimine la URL no utilizada o elija la entrada del proveedor que coincida con la región deseada. `alibaba-token-plan` está anclado a Beijing, mientras que `alibaba-token-plan-intl` cubre puntos finales internacionales.

Para una puerta de enlace `openai-responses` rota, la reparación pertenece al objeto del proveedor:

```json
{
  "providers": {
    "custom-gateway": {
      "adapter": "openai-responses",
      "baseUrl": "https://gateway.example/v1",
      "apiKey": "${GATEWAY_KEY}",
      "responsesItemIdRepair": {
        "reasoning": ["rs_0"],
        "message": ["msg_0"],
        "repairMissingTerminalIds": true
      }
    }
  }
}
```

Las listas de marcadores son coincidencias exactas. Deje el campo sin configurar para los proveedores Responses normales / estatales para que el paso permanezca idéntico byte por byte.

<a id="cursor-provider-adapter-cursor"></a>

## Proveedor de Cursor (`adapter: "cursor"`)

El puente Cursor es experimental. Después de `ocx login cursor`, agregue o edite `providers.cursor`.

Si un proxy no puede Cursor's por defecto HTTP/2 corriente, conjunto `upstreamHttpVersion` a `"http1.1"`
o su `"h1"` alias. Esto cambia la inferencia a Cursor `RunSSE` + `BidiAppend` compatibilidad transporte y usos HTTP/1.1 para `GetUsableModels` descubrimiento también. El valor requiere un HTTPS `baseUrl`. Déjalo Desactivar o usar `"auto"` para el comportamiento HTTP/2 existente. En el panel de control elija
**Proveedores → Cursor → Configuración → Cursor transporte**.

Cursor La escalera de optimización del router se expone como identificadores separados Codex porque el selector no puede procesar los parámetros del modelo específico Cursor:

| Modelo Codex | Modo router Cursor |
| --- | --- |
| `cursor/auto` | Equipo/cuenta predeterminada |
| `cursor/auto-cost` | Coste |
| `cursor/auto-balance` | Saldo |
| `cursor/auto-intelligence` | Inteligencia |

Las variantes explícitas envían el modelo `default` de Cursor con su parámetro `optimization`, preservando la selección en cada solicitud. Permanecen disponibles cuando el descubrimiento en vivo omite `default`.

<a id="vision"></a>

### Visión

Native Cursor visión utiliza `SelectedImage` (JPEG soft-cap + `blobIdWithData`) para los modelos que pueden ver imágenes de forma nativa - Claude, Gemini, GPT, Kimi, y Grok entre ellos - utilizando `data:` imágenes de giro activo solamente. Las imágenes de giro anterior se reproducen como `[image attached]` marcadores de texto; las imágenes remotas o no decodificables se convierten en marcadores de omisión. Auto, la familia Composer y GLM (`glm-5.2`, `glm-5.3`) permanecen en la lista curada `noVisionModels` y usan el sidecar de descripción de la visión.

Cursor herramientas locales dirigidas por servidor están deshabilitadas de forma predeterminada. Codex continúa utilizando sus propias herramientas como `apply_patch` y `exec_command` con su propia aprobación y política de sandbox:

- `"off"` (por defecto) rechaza Cursor - nativa `read`, `write`, `delete`, `ls`, `grep`, `shell` y `fetch` ejecución.
- `"on"` opta por la ejecución local de confianza y omite la semántica Codex aprobation/sandbox, excepto la ejecución de shell nativa en primer plano, que permanece no disponible.
- `"codex-sandbox"` se mantiene para la compatibilidad, pero falla cerrado como `"off"`; petición prosa no es digno de confianza atestation sandbox.

```json
{
  "providers": {
    "cursor": {
      "adapter": "cursor",
      "baseUrl": "https://api2.cursor.sh",
      "authMode": "oauth",
      "defaultModel": "auto",
      "nativeLocalExec": "off"
    }
  }
}
```

Establezca `nativeLocalExec` en `providers.cursor`, no en el nivel superior. En el panel de control use **Proveedores → Cursor → Editar JSON**, guarde y reinicie. `unsafeAllowNativeLocalExec: true` es igual a `nativeLocalExec: "on"` solo cuando `nativeLocalExec` no está activado. MCP, la grabación de pantalla y el uso del ordenador se controlan por separado por `mcpServers` y `desktopExecutor`.

Con la ejecución nativa habilitada, `glob` filtra los nombres en búsquedas de directorio con `grep`:
`*.ts` coincide a cualquier profundidad y `src/**/*.ts` se interpreta respecto al directorio elegido;
`./` es opcional. Usa `/` como separador en todas las plataformas. Se admiten clases de caracteres
y alternativas entre llaves; Bun 1.4.4 también admite extglobs como `**/!(*.test).ts` y rangos como
`part-{1..3}.ts`. Los filtros no cambian el directorio elegido ni habilitan la ejecución nativa.

Las solicitudes `shellArgs` y `shellStreamArgs` anteriores al primer plano son rechazadas antes de la creación del proceso en Windows, macOS y Linux, incluso con `nativeLocalExec: "on"`. Requieren un propietario descendiente respaldado por el kernel que esta implementación no proporciona; use la herramienta de shell del cliente en su lugar. El formulario de transmisión continua todavía devuelve el inicio, la salida abortada, un fallo escrito y el cierre de la transmisión para que el giro Cursor pueda terminar. No recoge ningún stdout/stderr y no tiene asignación activa de bytes de salida. Esta restricción no cambia la ejecución del shell de fondo ni las otras opciones de ejecución explícitas.

Cada `mcpServers.<name>` acepta `command` (stdio) o `url` (Streamable HTTP). Stdio también acepta `args`, `env` y `cwd`. HTTP acepta `headers`. Ambos soportan `enabled` (valor predeterminado true) y `toolPrefix`. `desktopExecutor` acepta `computerUseCommand`, `recordScreenCommand`, `cwd`, `env` y `timeoutMs` (por defecto `30000`). Las órdenes pasan por `sh -c`, leen una solicitud JSON de stdin y deben escribir un resultado JSON en stdout.

:::caution[Seguridad]
El enlace de bucle de retorno predeterminado admite cualquier proceso local sin autorización, incluidos otros usuarios en un host multiusuario. Deje de lado al ejecutivo local a menos que se confíe en cada persona que llama al plano de datos y usted deliberadamente aceptar sin pasar por la aprobación Codex y la semántica de sandbox.
:::

<a id="zed-provider-adapter-zed"></a>

## Proveedor Zed (`adapter: "zed"`)

El puente Zed Hosted AI es experimental y solo para inicio de sesión. Ejecute `ocx login zed` antes de usarlo; el inicio de sesión almacena la identidad de la cuenta Zed con su token de acceso de aplicación nativa en la tienda normal OAuth.

```json
{
  "providers": {
    "zed": {
      "adapter": "zed",
      "baseUrl": "https://cloud.zed.dev",
      "authMode": "oauth",
      "defaultModel": "auto"
    }
  }
}
```

El puente obtiene un token de inferencia alojada de corta duración y envía `POST /completions`. La lista `/models` en vivo se utiliza solo para metadatos de selector específicos de la cuenta: los identificadores de modelo arbitrarios permanecen reenviables, con la familia de backend inferida a partir del campo de proveedor en vivo o el nombre del modelo.

:::caution[No oficial: úsalo bajo tu responsabilidad]
Zed no proporciona ni respalda esta integración, y puede estar fuera de los términos de servicio de Zed. Zed puede limitar o suspender una cuenta que la utiliza. El proveedor nunca está habilitado de forma predeterminada.
:::

<a id="openrouter-provider-routing"></a>

## Enrutamiento del proveedor OpenRouter

OpenRouter puede servir a un modelo a través de varios proveedores de inferencias. `openRouterRouting` mantiene las solicitudes de los proveedores preferidos; `modelOpenRouterRouting` lo reemplaza por ID de modelo exacto. Esto es útil para la afinidad de caché rápida porque el soporte de caché, la retención, las tasas de éxito y los precios varían según el proveedor de inferencias.

Los nombres de los proveedores son OpenRouter identificadores. `allowFallbacks: false` falla cerrado; `true` permite a otro proveedor elegible después de la lista ordenada. `only` es siempre una lista de permisos.

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "openRouterRouting": {
        "order": ["deepseek"],
        "allowFallbacks": false
      },
      "modelOpenRouterRouting": {
        "anthropic/claude-sonnet-5": {
          "only": ["anthropic"],
          "allowFallbacks": false
        }
      }
    }
  }
}
```

<a id="vercel-ai-gateway-provider-routing"></a>

## Enrutamiento del proveedor de Vercel AI Gateway

Vercel AI Gateway puede enrutar un modelo a través de múltiples proveedores de inferencia subyacentes. `vercelGatewayRouting` configura las preferencias de todo el proveedor; `modelVercelGatewayRouting` lo reemplaza por ID de modelo exacto. Dejando ambos unset hace que `resolveVercelGatewayRouting()` devuelva `undefined`, por lo que los creadores de solicitudes de chat omiten el campo `provider` y Vercel AI Gateway conserva su comportamiento de enrutamiento dinámico predeterminado.

- `order`: Vercel AI Gateway upstream proveedor identificadores en orden de prioridad.
- `only`: lista de permisos explícita que restringe los proveedores de upstream de Vercel AI Gateway elegibles.
- `sort`: clasifica automáticamente a los proveedores elegibles por `"cost"` (el costo más bajo), `"ttft"` (el tiempo hasta el primer token) o `"tps"` (tokens por segundo).

```json
{
  "providers": {
    "vercel-ai-gateway": {
      "adapter": "openai-chat",
      "baseUrl": "https://ai-gateway.vercel.sh/v1",
      "apiKey": "${VERCEL_AI_GATEWAY_KEY}",
      "vercelGatewayRouting": {
        "sort": "ttft"
      },
      "modelVercelGatewayRouting": {
        "zai/glm-5.2": {
          "only": ["novita", "deepinfra"],
          "order": ["novita", "deepinfra"]
        }
      }
    }
  }
}
```

Las claves de modelo son selectores de modelo públicos Vercel sin el prefijo de proveedor externo OpenCodex. Al seleccionar `vercel-ai-gateway/zai-glm-5.2` se restaura el `zai/glm-5.2` nativo antes de aplicar la regla del modelo. La misma asignación se aplica a un selector nativo `vercel/<model-id>`: use el selector codificado `vercel-ai-gateway/vercel-<model-id>` en OpenCodex y mantenga `vercel/<model-id>` como la clave del modelo.

<a id="storing-keys-in-the-os-keychain"></a>

## Almacenar claves en el llavero del sistema operativo

Las claves API y las referencias a credenciales se pueden guardar en el almacén del sistema operativo (Llavero de macOS, Administrador de credenciales de Windows o Secret Service de Linux) en lugar de `config.json`. Consulta [Almacenar claves en el llavero del sistema operativo](/es/reference/configuration/keychain/) para conocer los comandos de migración, las reglas de almacenamiento y las limitaciones de servicios sin sesión interactiva.

<a id="static-model-allowlists"></a>

## Listas de modelos estáticos

El preajuste `zhipu-bigmodel-responses` incluye inicialmente `glm-5.3`, `glm-5.3-flash` y `glm-5-turbo` con `liveModels: false` para `https://open.bigmodel.cn/api/v1`. Su lista estática y el contexto por modelo, el esfuerzo y los metadatos de resumen provienen del [Guía BigModel Responses](/es/guides/providers/#bigmodel-coding-plan-over-responses). El ejemplo oficial local `models.json` no establece un vivo `/models` API.

Con `liveModels: false`, un `models` vacío u omitido inicia primero el `defaultModel` configurado, seguido por `retainModels`; se eliminan los ID duplicados mientras se conserva la primera aparición. Una lista explícita no vacía de `models` en cambio siembra `models` seguido de `retainModels`, sin agregar implícitamente un `defaultModel` diferente. Ese valor predeterminado todavía se puede enumerar explícitamente en `models` o `retainModels`. Si ninguno de estos campos proporciona un id, la semilla estática está vacía. Este es el orden de la semilla, no una promesa del orden final del selector. `selectedModels`, `disabledModels` y la política de proveedores desactivados todavía se aplican. `authMode: "forward"` mantiene su rama separada y no usa esta semilla estática enrutada. Estas reglas no cambian el fracaso del descubrimiento en vivo.

Live discovery rechaza más de 4 MiB o 2.000 filas de modelos sin procesar antes del almacenamiento en caché; los ajustes preestablecidos incorporados pueden usar límites inferiores y filtrar a filas elegibles para chat. Si el resultado es demasiado grande o está mal formado, se recurre al catálogo anterior o configurado. Un resultado válido sin modelos elegibles sigue siendo autoritativo: no se sustituye ni se trunca silenciosamente.

Utilice `selectedModels` cuando el descubrimiento aún debería ejecutarse, pero solo los id seleccionados deberían aparecer en Codex y `/v1/models`. El panel de control conserva la lista completa descubierta para cambios posteriores en la lista de permisos.

Use `retainModels` para el problema opuesto: un proveedor cuyo punto final `/models` omite un id que todavía es llamable (una implementación privada, un id de vista previa, una puerta de enlace compatible con OpenAI con un listado parcial). Los ids listados se mantienen en el catálogo enrutado con el mismo contexto y sugerencias de esfuerzo que `models`, y también sobreviven `liveModels: false`. `selectedModels` todavía reduce lo que es visible, por lo que un id debe estar en ambas listas cuando una lista de permisos está activa. Retener un id no hace que el upstream lo acepte; un id incorrecto falla en el momento de la solicitud con el error upstream. Desde el CLI: `ocx provider edit <name> --retain-models gemini-3.7-flash,other-id` (`-` borra).

Previsualizar las entradas de respaldo de GPT-5.6 usan el mismo mecanismo. OpenAI API -base de semillas preestablecida clave y Pro ids con contexto `1050000` y entrada máxima `922000`; OpenRouter semillas `openai/gpt-5.6-sol`, `openai/gpt-5.6-terra` y `openai/gpt-5.6-luna` con el contexto `1050000`. Nativo Pool / Direct ventanas siguen el [política de proveedores OpenAI](#reserved-openai-providers). El catálogo sincronizado anuncia `max` mientras mantiene `xhigh` distinto.

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "liveModels": false,
      "models": ["deepseek/deepseek-v4-flash", "qwen/qwen3-coder-plus"]
    }
  }
}
```

<a id="complete-example"></a>

## Ejemplo completo

```json
{
  "port": 10100,
  "defaultProvider": "openai",
  "providers": {
    "openai": {
      "adapter": "openai-responses",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "authMode": "forward"
    },
    "anthropic": {
      "adapter": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "authMode": "oauth",
      "defaultModel": "claude-sonnet-4-6"
    },
    "ollama-cloud": {
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "${OLLAMA_API_KEY}",
      "defaultModel": "glm-5.2",
      "noVisionModels": ["glm-5.2", "glm-5.3", "gpt-oss", "qwen3-coder", "deepseek-v4-flash"]
    }
  },
  "subagentModels": ["anthropic/claude-opus-5", "ollama-cloud/glm-5.2"],
  "disabledModels": [],
  "websockets": false,
  "webSearchSidecar": {
    "maxSearchesPerTurn": 3,
    "routedModelStallTimeoutMs": 200000,
    "timeoutMs": 60000
  },
  "visionSidecar": { "enabled": true }
}
```

<a id="opencode-go-responses-compatibility"></a>

## Compatibilidad con OpenCode Go Responses

En solicitudes no reenviadas cuyo punto final resuelto es `https://opencode.ai/zen/go/v1/responses`, OpenCodex se mueve Codex `additional_tools` Declaraciones de entrada al nivel superior `tools` herramienta y espacio de nombres normalización. Las herramientas alojadas compatibles se conservan hasta el filtrado específico del modelo; malformado envolturas permanecen sin cambios. Esto no descarta el texto cifrado o el contenido de agente-mensaje desconocido. La verificación utiliza el URL final, por lo que las URL base y la división incluyen puntos finales. `baseUrl`/`responsesPath`
Las configuración reciben el mismo comportamiento. Un camino personalizado resolver en otro lugar no lo hace.

El canónico `opencode-go` predeterminados preestablecidos a `statelessResponses: true`: las solicitudes utilizan el historial explícito con `store: false`, sin `previous_response_id`, `conversation`, `background`, `metadata`, o `prompt` referencias almacenadas. Esto evita el rechazo de Go del texto cifrado de razonamiento combinado con `previous_response_id`. El razonamiento de registros de caché de continuación en la misma representación devuelto al cliente, incluyendo la reescritura de contenido a resumen visible, por lo que hacer eco del historial completo con `previous_response_id` no duplica ese historial. Las solicitudes de resumen oculto y las manchas de razonamiento opacas conservan su representación existente. Los hits de caché también pueden proporcionar un historial anterior para las continuaciones delta; después de un error de caché, el proxy devuelve `previous_response_not_found` antes del envío ascendente para que el cliente pueda volver a enviar la conversación completa sin `previous_response_id`. Los resultados huérfanos y los resultados perdidos de la herramienta no pueden reconstruir el historial perdido o probar si la ejecución de una herramienta faltante tuvo éxito.

Se conserva un `statelessResponses: false` explícito. Las configuraciones preestablecidas canónicas existentes reciben el valor predeterminado solo cuando el ajuste está ausente; las entradas renombradas personalizadas mantienen su valor configurado y no adquieren este valor predeterminado por coincidencia de destino. Las rutas del modelo de chat mantienen su protocolo existente. La bandera sin estado no fuerza la transmisión de Responses en JSON.

<a id="opencode-go-session-affinity"></a>

## Afinidad de sesión OpenCode Go

Cada solicitud opencodex rutas a un destino OpenCode Go lleva un encabezado `x-opencode-session`. El flujo ascendente comenzó a rechazar solicitudes sin él en 2026-09-06, por lo que la cabecera no es una optimización.

El valor depende de lo que la solicitud ya sabe sobre sí misma:

- Un `x-opencode-session` configurado por el operador en el proveedor se conserva exactamente como está escrito.
- Una solicitud que lleva la identidad de la conversación - cabeceras de hilo Codex, un Claude `metadata.user_id`, un `session_id`, o un `x-opencode-session` entrante - se hashed en un valor estable por conversación, por lo que cada turno de una conversación llega a ir bajo la misma sesión.
- Una solicitud sin ninguna identidad, como una sonda de disponibilidad de modelo o una primera solicitud antes de que exista ningún metadato de conversación, recibe un valor asignado una vez para esa solicitud. Está aislado de otras solicitudes en lugar de compartido, y sobrevive a los lugares opencodex reconstruye la solicitud: la traducción a la forma interna Responses, compactación, niños combinados y el reintento de recuperación de políticas que entrega el turno al próximo candidato.

Los destinos Non-Go no se ven afectados: opencodex nunca obtiene o agrega el encabezado de sesión para ellos. Todavía se envía un encabezado que un operador configuró en un proveedor de este tipo, porque opencodex deja esa configuración sola.

<a id="opencode-go-reasoning-efforts"></a>

## Esfuerzos de razonamiento OpenCode Go

Las filas de catálogo Go conservan sus esfuerzos de razonamiento configurados exactamente, incluso durante la sincronización del catálogo. OpenCodex no anexa opciones sintéticas `max` o `ultra` a estas filas. Use `modelReasoningEfforts` y `modelDefaultReasoningEfforts` para los valores ascendentes aceptados de cada modelo. Teclee estos mapas por proveedor por ID de modelo ascendente, no por la identificador de catálogo `opencode-go/<model-id>` enrutada. Por ejemplo, una lista `["high", "max"]` configurada sigue siendo exactamente esas dos opciones; una lista `["high", "xhigh"]` configurada no gana `max`. Vea el [Lista de modelos de OpenCode](https://opencode.ai/docs/go/#models) para la lista actual. Un subconjunto configurado puede excluir los niveles inferiores. Otros proveedores mantienen su comportamiento existente.

Para un selector nativo-primero, incluya los identificadores nativos en `modelPickerOrder` seguidos de los identificadores enrutados. Esto ordena el selector completo mientras se conserva el cálculo de orientación de prioridad natural separado de OpenCodex. Native Codex anuncia cinco prioridad de selector de seguimiento y puede cambiar; la elegibilidad de anulación de nombre exacto no se limita a ese anuncio. Las órdenes de solo ruta mantienen su comportamiento anterior. Ver el [Ordenar nota de migración](/es/guides/model-ordering/#migration-note-native-ids-in-existing-orders). `modelDisplayNames` en un proveedor controla las etiquetas legibles sin cambiar los identificadores de cable.

<a id="routed-agent-messages"></a>

## Mensajes de agentes enrutados

Con el [`openai-responses` adaptador](/es/reference/adapters/#openai-responses), Codex
`agent_message` Los elementos que contienen matrices no vacías de partes de texto plano admitidas se convierten en mensajes de usuario cuando `authMode` no es `"forward"`
(Por ejemplo, `"key"`) Proveedores que utilizan `authMode: "forward"` mantener estos elementos sin cambios.
`agent_message` es privado al backend ChatGPT Codex, y los destinos enrutados reportado hasta el momento responder a toda la solicitud con
`422 unknown item type "agent_message"`; Codex reproduce el historial de subagentes en cada giro posterior, por lo que el hilo sigue fallando hasta que se convierte el elemento. El autor y el destinatario siguen siendo metadatos de texto explícito, y se conservan las partes del contenido. Para HTTPS `api.x.ai` y `cli-chat-proxy.grok.com` en el puerto estándar, no hacia adelante El despacho Responses también acepta un resultado hijo de cadena no en blanco y lo convierte en uno
`input_text` parte. La cadena original, incluyendo el espacio en blanco y las líneas nuevas, se conserva. Otros destinos mantienen sin cambios los mensajes de agente con valor de cadena. Vacío o Las cadenas de solo espacio en blanco permanecen sin cambios, al igual que las formas incompletas y mezcladas cifradas/desconocidas. El contenido encriptado y desconocido no está normalizado; las tareas encriptadas nativas aún requieren el opt-in separado [recuperación de tareas](/es/reference/configuration/agents/#encrypted-v2-task-recovery).

Con la recuperación de tareas habilitada, los elementos `NEW_TASK`, `MESSAGE`, `FOLLOWUP_TASK` y `FINAL_ANSWER` reutilizan una asignación en caché solo después de validar el llamador y coincidir con el alcance del subproceso principal. La restauración de reproducción no realiza una nueva solicitud de recuperación ni extiende la caducidad de la caché. El texto cifrado caducado o no visto no se reemplaza. Los nuevos elementos cifrados `NEW_TASK`, `MESSAGE`, `FOLLOWUP_TASK` y `FINAL_ANSWER` utilizan la misma ruta de recuperación opt-in, incluida la entrega `send_message` de padres nativos. El tipo de mensaje, el remitente, el destinatario, el alcance principal y las credenciales del llamante siguen siendo parte de la validación o la identidad de caché. Un `FINAL_ANSWER` sin una línea `Task name` no tiene ninguna dirección de cabecera para verificar, pero su destinatario todavía explora la caché.

Cuando una solicitud contiene varios mensajes de agente, la restauración de reproducción en caché comprueba cada mensaje de forma independiente. La caché separa el tipo de mensaje, el remitente, el destinatario y el texto cifrado dentro del alcance admitido de la persona que llama/cuenta y del padre. La recuperación reciente solo maneja el mensaje de cola actual (ignorando los metadatos posteriores `compaction_trigger` o `additional_tools`). No recupera por lotes mensajes históricos no vistos; esos permanecen sin cambios. Un error de caché o vencimiento no extiende el contrato de recuperación del historial.

El remitente y el destinatario en la ruta Responses son contexto para el modelo de recepción, no un nuevo protocolo de enrutamiento legible por máquina. El enrutamiento de herramientas continúa utilizando los contratos de colaboración existentes.

<a id="per-model-capability-declarations"></a>

### Declaraciones de capacidad por modelo

`modelCapabilities` almacena declaraciones explícitas con la clave exacta del ID del modelo ascendente. Los ID preservan el caso y no deben contener espacios en blanco circundantes. Cada entrada puede contener `inputModalities` (`text`, `image`, `audio`, `video`), `contextTier` (`default`, `long_context`), `video.processing` (`static`, `agentic`) y `deepseekImageFiles` (`boolean`; véase [DeepSeek image bytes](#deepseek-tokens-versus-image-bytes)). Estas son declaraciones del operador, no prueba de apoyo del proveedor. Los campos de nivel de contexto y vídeo actualmente graban solo la intención y no activan el comportamiento ascendente ni aumentan las ventanas de catálogo.

El editor y proveedor de proveedores en bruto API exponen este mapa. POST/PUT reemplaza un mapa suministrado explícitamente y rechaza entradas nulas. PATCH combina ejes individuales; null borra un valor de procesamiento de mapa, modelo, eje o vídeo, mientras que `{}` no cambia. El proveedor omitido sobrescribe el mapa existente. Los archivos mal formados editados a mano retienen ejes independientes válidos y tratan las modalidades de entrada explícitas mal formadas como solo texto, con un diagnóstico.

Un `modelCapabilities.<id>.inputModalities` explícito ahora tiene prioridad sobre las sugerencias de modalidad heredadas para ese modelo enrutado exacto. Una declaración de solo texto utiliza el sidecar de visión existente para reemplazar las imágenes con descripciones; si no hay un sidecar disponible, la solicitud recibe un marcador de omisión explícito antes del envío. Las solicitudes de imagen de chat nativo se desvían a través de esta ruta. El catálogo aún puede anunciar el soporte de archivos adjuntos de imagen porque el proxy proporciona el paso de descripción. Las declaraciones de nivel contextual y de procesamiento de video permanecen inertes hasta que se soporte su transporte.

Una declaración de modalidad de entrada en un **fila de modelo personalizado** - las casillas de verificación de modalidades de entrada en la pestaña Modelos, o `inputModalities` en `customModels[]` - también tiene prioridad sobre las sugerencias de visión heredadas del proveedor (`noVisionModels`, `modelInputModalities`) para ese proveedor exacto y la identificación del modelo. Declare `text, image` en una fila personalizada y las imágenes lleguen a ese modelo incluso cuando la fila del proveedor lo enumere como solo texto; declare solo `text` y se enruta a través del sidecar de visión. Esta es la misma prioridad que el catálogo ya aplicado, por lo que la fila anunciada y la solicitud ahora están de acuerdo. `modelCapabilities` se mantiene por encima de él, porque es el eje de capacidad dedicado por modelo, incluida la escritura realizada por `ocx provider edit <provider> --model <id> --text-only`. Una fila personalizada que deja las modalidades en blanco hereda la fila del proveedor en lugar de reclamar solo texto. Cada consumidor que responde "puede este modelo tomar una imagen" aplica una regla a la declaración: la imagen está ausente de la lista. Por lo tanto, una fila que declara solo `audio` o `video` cuenta como incapaz de imagen, en lugar de ser tratada como un modelo de texto por un predicado y un objetivo de imagen por el otro.

<a id="prompt-length-pricing"></a>

### Precios puntuales

En **Modelos → Precio**, mantenga cuatro tarifas base y elija un modo de longitud rápida:

- **Automático** mantiene las reglas de contexto de catálogo. También es el comportamiento de las anulaciones de cuatro tasas existentes sin una política.
- **Tarifa fija** utiliza las tasas base en cada longitud de solicitud, deshabilitando los ajustes de contexto del catálogo.
- **Umbral personalizado** selecciona cuatro velocidades alternativas absolutas usando `>` o `≥` y un umbral de testigo. La directiva personalizada reemplaza la regla de contexto de catálogo en ambos lados del umbral.

Todos los tokens de solicitud cuentan, incluidas las lecturas y escrituras de caché, antes de la resta de entrada facturable. La salida no cuenta hacia el umbral. Una vez cruzadas, las tarifas alternativas se aplican a toda la solicitud, incluida la salida, no solo a los tokens en exceso. Las tarifas personalizadas son tarifas de velocidad estándar: se aplica una prima Fast / Priority aplicable una vez que se seleccionan las tarifas y sigue la relación del catálogo entre la prioridad y los precios de contexto largo para ese modelo. Una solicitud de prioridad confirmada muestra la estimación personalizada como un límite inferior solo cuando el catálogo declara que esa relación es `lower-bound`, al igual que para xAI Grok, que no publica ninguna tasa combinada. Un modelo sin regla de contexto de catálogo aplica cualquier multiplicador de prioridad una vez. Estos ajustes controlan las estimaciones; no cambian la facturación del proveedor. **Restablecer a automático** elimina la anulación completa y restaura los precios y las reglas del catálogo. Guardar o editar las actualizaciones de configuración en tiempo real estimaciones y totales históricos.

Por ejemplo, una anulación de Haiku 5.5 con tasas alternativas estrictamente superiores a 100.000 tokens de solicitud:

```json
{
  "modelCosts": {
    "claude-haiku-5-5": {
      "input": 0.10,
      "output": 0.50,
      "cacheRead": 0.01,
      "cacheWrite": 0.125,
      "promptLengthPricing": {
        "mode": "custom",
        "thresholdTokens": 100000,
        "comparison": "gt",
        "rates": { "input": 0.50, "output": 2.50, "cacheRead": 0.05, "cacheWrite": 0.625 }
      }
    }
  }
}
```

Este es un ejemplo de precios definidos por el usuario, no una lista oficial de precios de Haiku. Se admite cualquier umbral entero seguro positivo, incluido el `272000`; use el `"gte"` para una comparación inclusiva. Se requieren las cuatro tasas alternativas y siguen los límites de la tasa base, incluido cero. La otra política es `{ "mode": "flat" }`. Omitir `promptLengthPricing` para retener las reglas de contexto automáticas con sus precios base; se acepta un `{ "mode": "automatic" }` explícito y significa lo mismo, y se guarda desde el panel de control o API almacenarlo como un campo ausente.

Las anulaciones de precio de modelo Legacy `openai-multi` retienen políticas de longitud de prompt válidas cuando el inicio las migra a `openai`, incluidas las anulaciones tecleadas en `openai-multi/<model>`.

<a id="renamed-api-key-presets"></a>

### Renombrado API-key presets

Un proveedor guardado bajo otro nombre, como `CommandCode`, hereda metadatos faltantes de esfuerzo de razonamiento cuando su adaptador y el punto final fijo API coinciden con un ajuste preestablecido del registro. Sus listas explícitas por modelo, incluyendo `[]`, siguen siendo autorizadas. Una lista omitida en todo el proveedor hereda el valor predeterminado preestablecido; una lista explícita permanece sin cambios. Esto no coincide con OAuth, los puntos finales no relacionados, o plantillas / preajustes de punto final personalizado.

<a id="azure-model-validation-output-budgets"></a>

### Azure presupuestos de salida de validación de modelos

Algunas implementaciones de Azure Responses rechazan el pequeño presupuesto de validación de cambio de modelo de Claude Code. Si su implementación informa que `max_output_tokens` está por debajo de su mínimo, configure `minMaxOutputTokens` en ese proveedor de Azure al mínimo que requiera su punto final (por ejemplo, `16` para un punto final que informa de ese mínimo). Esto es opt-in: aumenta cada presupuesto entero positivo más pequeño en ese proveedor, no solo las solicitudes de validación. Se conservan presupuestos más grandes, y otros adaptadores no aplican esta configuración en este cambio. La admisión de gastos se reserva el presupuesto efectivo antes del envío, incluido el envío prepagado de cada objetivo Combo. Por lo tanto, un techo de gasto configurado puede rechazar una solicitud cuya asignación de producción elevada excedería ese techo.

```json
{
  "providers": {
    "azure": {
      "adapter": "azure-openai",
      "baseUrl": "https://YOUR_RESOURCE.openai.azure.com/openai/v1",
      "apiKey": "${AZURE_OPENAI_API_KEY}",
      "minMaxOutputTokens": 16
    }
  }
}
```

<a id="native-chat-thinking-replay"></a>

### Chat nativo pensando repetición

Estas listas de razonamiento de chat también se aplican a la continuación de llamada de herramienta nativa `/v1/chat/completions`. El proxy conserva el `reasoning_content` suministrado y restaura el razonamiento omitido de las respuestas JSON o SSE aguas arriba usando identificadores de llamada de herramienta. La repetición de razonamiento original requiere un encabezado estable `thread-id`, `session_id` o `session-id` en cada solicitud y el mismo proveedor, punto final, modelo y credencial. La caché es local y limitada; un reinicio, caducidad, desalojo o falta de encabezado de conversación utiliza el marcador de posición mínimo configurado en su lugar. Un marcador de posición no puede reconstruir el razonamiento perdido. Los clientes deben conservar el `reasoning_content` ascendente en su historial de asistentes para reanudar las conversaciones de manera confiable.

Cuando `preserveReasoningContentModels` no está configurado, DeepSeek Flash / Pro nombres de modelos se reconocen en todas las versiones, incluyendo `deepseek-v4.1-flash`, identificadores de namespaced y sufijos de puerta de enlace. Las listas explícitas siguen siendo autoritativas: `preserveReasoningContentModels: []` desactiva la reparación automática, mientras que `requiresReasoningPlaceholderModels: []` desactiva los marcadores de posición y aún permite el razonamiento original en caché. Otras familias modelo requieren la declaración de conservación. Las solicitudes DeepSeek habilitadas para herramientas también requieren razonar sobre respuestas de asistentes anteriores sin llamadas de herramientas. El marcador de posición configurado llena estas omisiones; no se puede recuperar ningún razonamiento original de la caché de llamadas a herramientas para esos giros. Preservar su razonamiento suministrado para la plena fidelidad.

<a id="auto-pause-permanently-refused-accounts"></a>

## Pausa automática de cuentas permanentemente rechazadas

`providers.<provider>.accountAutoPause` es opt-in y por defecto se desactiva. Se aplica a las OAuth cuentas de ese proveedor, Codex cuentas de grupo (incluida la cuenta principal en modo de grupo) y las entradas de grupo de claves configuradas API. Por ejemplo:

```sh
ocx config set providers.anthropic.accountAutoPause.enabled true
ocx config set providers.anthropic.accountAutoPause.consecutiveFailures 2
```

`consecutiveFailures` es un entero de 1 a 100; omitirlo usa 2. Solo cuentan rechazos HTTP 401/403 exactos y propios de la cuenta: una organización que prohíbe OAuth, una suscripción inactiva o vencida, acceso denegado a API/Claude Code, una cuenta deshabilitada por Google por infringir sus condiciones de servicio, o el cambio a un plan gratuito sin créditos. Un error de permisos del modelo, un token de acceso vencido, una ventana de cuota, un 429, un 5xx, una respuesta mal formada o un fallo de red nunca pausan una cuenta.

El contador es de proceso local, serializado por cuenta, y se restablece en una respuesta HTTP exitosa, reanudación explícita o un nuevo inicio de sesión. La actualización del token por sí sola no restablece la racha de una cuenta OAuth. Los errores transitorios dejan el contador sin cambios. Reiniciar el proxy borra los contadores; pausas completadas, sus códigos de razón fija y marcas de tiempo persisten. Los procesos proxy independientes mantienen contadores independientes. Cambiar, deshabilitar o volver a habilitar la política, deshabilitar el proveedor o cambiar su punto final descarta observaciones de rechazo en vuelo, por lo que un rechazo de una solicitud enviada bajo la política anterior nunca puede pausar una cuenta después. Un rechazo cuenta solo para la credencial que realmente llegó a la parte superior: cuando un plugin local reescribe la credencial o el destino de un envío, ese envío nunca cuenta para una pausa. Para Codex cuentas de pool esto incluye el espacio de trabajo (`chatgpt-account-id`) para el que se envió la solicitud.

En el umbral, OpenCodex excluye la cuenta utilizando su mecanismo de pausa existente e intenta un hermano elegible para la solicitud actual dentro del presupuesto de reintento/envío existente. Corregidos los selectores de cuenta Codex y los archivos cargados vinculados a la cuenta conservan sus restricciones. Una pausa nunca cancela el trabajo ya enviado ni cambia las credenciales. Emite una línea de registro genérica sin identificadores de cuenta o texto de error ascendente.

`ocx account list <provider>` muestra la razón de pausa. La insignia Paused del panel expone la razón y el tiempo. Utilice `ocx account resume <provider> <account-id-or-alias>` para aclarar la razón y permitir la selección de nuevo. En una fila de API teclas, al hacer clic en Reanudar también se activa la clave. Esta política nunca reanuda una cuenta automáticamente.
