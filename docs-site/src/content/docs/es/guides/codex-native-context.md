---
title: "Compatibilidad de contexto nativo"
description: "Elegibilidad, configuración de prueba autenticada y límites de la historia y retransmisión de notas de Codex."
---

OpenCodex ya transmite la historia y las notas nativas Codex. Este no es un servicio de memoria general para los proveedores enrutados, y la exposición de sus puntos finales HTTP no establece que una compilación, cuenta o modelo Codex particular pueda usarlos. Consulte [Codex integración](/es/guides/codex-integration/) para conocer los límites de propiedad, cancelación y credenciales del relé.

<a id="two-independent-requirements"></a>

## Dos requisitos independientes

Codex debe activar la extensión, y OpenCodex debe identificar al llamante. Cambiar la URL de backend no resuelve ninguno de los requisitos por sí solo.

El contrato de Codex aguas arriba inspeccionado requiere un modelo cuya entrada de catálogo nativa anuncia `supports_experimental_context`, un inicio de sesión ChatGPT elegible y un proveedor nombrado exactamente `OpenAI` con una URL base que termina en `/backend-api/codex`. Su activación automática rechaza a los proveedores que usan `env_key`, `experimental_bearer_token`, `auth` respaldado por comandos o AWS auth. El predicado de elegibilidad inspeccionado acepta ChatGPT Plus, Pro y ProLite; esta no es una afirmación de que cada cuenta en esos planes tenga puntos finales de historial de backend que funcionen.

OpenCodex requiere adicionalmente un **plano de datos API clave** activo tanto en la solicitud de modelo satisfactoria como en las solicitudes de contexto posteriores. La inyección de bucle invertido incorporada por defecto no envía esa clave, por lo que puede servir modelos mientras las llamadas de contexto fallan con `context_principal_required` (403). El formulario de tabla de proveedor remoto autenticado por sí solo tampoco es una solución de contexto nativo: su `env_key` y el nombre del proveedor no satisfacen el contrato de activación Codex anterior. Nunca quite los cheques de principal o de propiedad de la cuenta para ocultar cualquiera de los problemas.

<a id="explicit-opt-in-syntax"></a>

## Sintaxis explícita de opt-in

OpenCodex acepta ambas formas de características de raíz persistentes que Codex `FeatureToml` acepta:

```toml
[features]
context_management = true
```

El formulario de tabla equivalente también funciona y es la ortografía compatible para versiones anteriores de OpenCodex que aún no reconocían la forma booleana:

```toml
[features.context_management]
experimental_mode = true
```

Use una forma, no ambas. Los valores falsos, ausentes y mal formados permanecen fuera. El proxy lee su propia configuración de inicio Codex; un CLI -solo anulación o una opción de inclusión presente solo dentro de un perfil Codex no habilita su puerta de entorno de ejecución. Este cambio no infiere la aceptación de los metadatos del modelo.

<a id="authenticated-native-trial-profile"></a>

## Perfil de prueba nativo autenticado

Esto es un **Configuración de prueba comprobada por fuente, no una certificación de extremo a extremo de cuenta real**. Realice una copia de seguridad de la configuración Codex y mantenga un punto de control de tareas duradero antes de realizar las pruebas. Utilice un nuevo hilo desechable; no cambie la identidad del proveedor de un hilo de trabajo existente.

Suministre una clave de plano de datos activa OpenCodex existente en `OCX_CONTEXT_API_KEY` en el entorno del proceso Codex. No utilice un token de administración/admin ni almacene la clave en TOML. El entorno de un servicio no es heredado automáticamente por una aplicación de escritorio lanzada por separado. Mantenga el inicio de sesión nativo normal Codex ChatGPT disponible; el encabezado adicional no reemplaza OAuth.

Con la opción de acceso de la función raíz anterior, el proveedor de reenvío canónico ChatGPT configurado en OpenCodex y un catálogo de modelo nativo actual, fusiona este proveedor y perfil de **adicionales** en la misma configuración de Codex. Ajuste el puerto al proxy local real. Deje la raíz `model_provider` y las tablas de proveedores existentes sin cambios.

```toml
[model_providers.ocx-native-context]
name = "OpenAI"
base_url = "http://127.0.0.1:10100/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
env_http_headers = { "x-opencodex-api-key" = "OCX_CONTEXT_API_KEY" }

[profiles.ocx-native-context]
model_provider = "ocx-native-context"
model = "gpt-6-astra"
```

Inicia un nuevo hilo CLI con `codex --profile ocx-native-context`. El ejemplo utiliza HTTP / SSE para mantener la prueba inicial en la ruta de propiedad del modelo al relé; no cambia el transporte de otros perfiles ni certifica la paridad WebSocket /mid-turn-steering. Utilice el modelo solo cuando el catálogo nativo de la cuenta realmente anuncie su capacidad de contexto; nunca fuerce esa bandera a una fila Devin, Gemini u otra fila enrutada.

El ID de proveedor personalizado es intencional. El Codex ascendente generalmente no anula a los proveedores incorporados de `model_providers.openai`; agregar un encabezado adicional allí puede ser silenciosamente ineficaz. El ID personalizado conserva el proveedor normal, mientras que el nombre exacto `OpenAI` satisface el predicado de backend nativo. No agregue `env_key` a este perfil: `env_http_headers` lleva la admisión local por separado, mientras que `Authorization` continúa llevando el inicio de sesión nativo ChatGPT. OpenCodex consume la clave local; no reenvía esa clave a ChatGPT.

El opt-in raíz también afecta a otros perfiles nativos elegibles. **Durante esta prueba, no continúe con los hilos de bucle de retorno incorporados normales que carecen de la clave adicional.** Apague la función raíz y ejecute `ocx sync` antes de volver a esos hilos. Este no es un cambio de integración automático o predeterminado, y este perfil CLI no es una afirmación sobre el soporte de selección de perfiles de escritorio.

<a id="verify-before-resetting-context"></a>

## Verificar antes de restablecer el contexto

Primero obtenga una respuesta exitosa del modelo nativo en el nuevo hilo. A continuación, verifique una nota escrita, lea la misma nota y consulte el historial de ese hilo. Solo después de que esas operaciones tengan éxito, una prueba desechable debe usar `new_context` y verificar que el estado guardado se pueda recuperar. Mantenga el punto de control externo incluso cuando la prueba tenga éxito.

- **403 `context_principal_required`:** ninguna clave de plano de datos local válida alcanzó el proxy.
- **409 `context_account_unavailable`:** La propiedad está ausente o es inconsistente; no sustituya la cuenta activa actual ni vuelva a intentar escribir a ciegas.
- **404:** distinguen la respuesta de punto final deshabilitado/desconocido del proxy de un 404 ascendente. Esto último no es prueba de un defecto de enrutamiento OpenCodex o una interrupción en toda la cuenta.

Una llamada modelo o `ocx ready` exitosa no es prueba de que las notas, la historia o la restauración del estado funcionen. El enrutamiento de modelos, los cambios de cuenta, los reinicios de proxy y la disponibilidad de puntos finales ascendentes siguen siendo preocupaciones separadas. Ninguna bandera local puede conceder la elegibilidad de backend faltante, y una operación de contexto fallida no debe ser reportada como un restablecimiento exitoso. Retire las tablas de prueba y desactive la clave de prueba cuando haya terminado; deje la función deshabilitada a menos que utilice una ruta autenticada verificada.

<a id="upstream-contracts-inspected"></a>

## Contratos ascendentes inspeccionados

Estos enlaces fijan el contrato de origen utilizado para la configuración anterior, no una promesa de implementación:

- [FeatureToml booleano/formas de tabla](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/features/src/lib.rs)
- [Elegibilidad del contexto nativo](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/session/token_budget.rs)
- [Identidad del proveedor y reglas de fusión incorporadas](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/model-provider-info/src/lib.rs)
- [El historial/las notas utilizan los encabezados de solicitud y la autenticación del proveedor](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/ext/history-notes/src/backend.rs)
