---
title: "Compatibilidad de contexto nativo"
description: "Requisitos, prueba autenticada y límites del historial y las notas nativas de Codex."
---

OpenCodex ya retransmite el historial y las notas nativas de Codex. No es un servicio general de memoria para proveedores enrutados. Exponer sus endpoints HTTP tampoco demuestra que una versión, cuenta o modelo de Codex pueda usarlos. Consulta [Integración con Codex](/es/guides/codex-integration/) para conocer los límites de propiedad, cancelación y credenciales de la retransmisión.

<a id="two-independent-requirements"></a>

## Dos requisitos independientes

Codex debe activar la extensión, y OpenCodex debe identificar al llamante. Cambiar la URL de backend no resuelve ninguno de los requisitos por sí solo.

El contrato de Codex inspeccionado exige un modelo cuya entrada en el catálogo nativo anuncie `supports_experimental_context`, una sesión de ChatGPT elegible y un proveedor llamado exactamente `OpenAI` cuya URL base termine en `/backend-api/codex`. La activación automática rechaza proveedores con `env_key`, `experimental_bearer_token`, `auth` obtenido mediante comandos o autenticación AWS. El criterio inspeccionado admite ChatGPT Plus, Pro y ProLite; esto no demuestra que todas las cuentas de esos planes dispongan de endpoints de historial operativos.

OpenCodex exige además una **clave API activa del plano de datos**, tanto en la solicitud correcta al modelo como en las solicitudes posteriores de contexto. La inyección local predeterminada mediante loopback no envía esa clave: puede atender al modelo mientras las llamadas de contexto fallan con `context_principal_required` (403). Tampoco basta con configurar un proveedor remoto autenticado: su `env_key` y su nombre no cumplen el contrato de activación anterior. No elimines las comprobaciones de identidad ni de propiedad de la cuenta para ocultar estos problemas.

<a id="explicit-opt-in-syntax"></a>

## Sintaxis explícita de opt-in

OpenCodex acepta las dos formas persistidas en la raíz de la configuración que admite `FeatureToml` de Codex:

```toml
[features]
context_management = true
```

La forma de tabla equivalente también funciona y es compatible con versiones anteriores de OpenCodex que aún no reconocían la forma booleana:

```toml
[features.context_management]
experimental_mode = true
```

Usa una forma, no ambas. Los valores falsos, ausentes o mal formados mantienen la función desactivada. El proxy lee la configuración de su propio directorio de Codex: una anulación exclusiva de la CLI, o una activación presente solo dentro de un perfil de Codex, no habilita la función en el proxy. Tampoco se deduce la activación a partir de los metadatos del modelo.

<a id="authenticated-native-trial-profile"></a>

## Perfil de prueba nativo autenticado

Esta es una **configuración de prueba contrastada con el código fuente; no certifica el funcionamiento de extremo a extremo con una cuenta real**. Haz una copia de seguridad de la configuración de Codex y guarda un punto de recuperación de la tarea antes de probarla. Usa un hilo nuevo y desechable; no cambies la identidad del proveedor de un hilo de trabajo existente.

Proporciona una clave activa del plano de datos de OpenCodex mediante `OCX_CONTEXT_API_KEY` en el entorno del proceso de Codex. No uses un token de administración ni guardes la clave en TOML. Una aplicación de escritorio iniciada por separado no hereda automáticamente el entorno de un servicio. Conserva la sesión nativa de ChatGPT en Codex: el encabezado adicional no sustituye OAuth.

Con la función activada en la raíz, el proveedor canónico de reenvío a ChatGPT configurado en OpenCodex y un catálogo nativo actualizado, agrega este proveedor y este perfil **adicionales** a la misma configuración de Codex. Ajusta el puerto al proxy local real. Conserva el `model_provider` raíz y las tablas de proveedores existentes.

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

Inicia un hilo nuevo de CLI con `codex --profile ocx-native-context`. El ejemplo usa HTTP/SSE para mantener la prueba inicial en la ruta de propiedad entre el modelo y la retransmisión. No cambia el transporte de otros perfiles ni certifica la paridad de WebSocket o del control durante el turno. Usa el modelo solo si el catálogo nativo de la cuenta anuncia esa capacidad de contexto; no fuerces la opción en Devin, Gemini ni otros modelos enrutados.

El identificador personalizado del proveedor es intencional. Codex normalmente no sustituye proveedores integrados mediante `model_providers.openai`, por lo que añadir allí un encabezado puede no surtir efecto. El identificador personalizado conserva el proveedor normal; el nombre exacto `OpenAI` satisface el criterio del backend nativo. No añadas `env_key` a este perfil: `env_http_headers` lleva la admisión local por separado y `Authorization` sigue transportando la sesión nativa de ChatGPT. OpenCodex consume la clave local y no la reenvía a ChatGPT.

La activación en la raíz también afecta a otros perfiles nativos elegibles. **Durante la prueba, no continúes hilos locales habituales que no lleven la clave adicional.** Desactiva la función en la raíz y ejecuta `ocx sync` antes de volver a ellos. Esta integración no es automática ni predeterminada, y el perfil de CLI no demuestra que la aplicación de escritorio permita seleccionar ese perfil.

<a id="verify-before-resetting-context"></a>

## Verificar antes de restablecer el contexto

Primero consigue una respuesta correcta del modelo nativo en el hilo nuevo. Después escribe una nota, vuelve a leerla y consulta el historial del mismo hilo. Solo si esas operaciones funcionan, usa `new_context` en una prueba desechable y comprueba que puedas recuperar el estado guardado. Conserva el punto de recuperación externo aunque la prueba tenga éxito.

- **403 `context_principal_required`:** ninguna clave de plano de datos local válida alcanzó el proxy.
- **409 `context_account_unavailable`:** falta la propiedad de la cuenta o es inconsistente; no la sustituyas por la cuenta activa ni reintentes una escritura a ciegas.
- **404:** distingue un endpoint desactivado o desconocido del proxy de un 404 del proveedor. El segundo no demuestra un defecto de enrutamiento de OpenCodex ni una interrupción de toda la cuenta.

El éxito de una llamada al modelo o de `ocx ready` no demuestra que funcionen las notas, el historial o la restauración. El enrutamiento, los cambios de cuenta, los reinicios del proxy y la disponibilidad de endpoints del proveedor son aspectos distintos. Ninguna opción local concede una elegibilidad que el backend no ofrece, y un fallo de contexto no debe presentarse como un restablecimiento correcto. Al terminar, elimina las tablas de prueba y retira la clave de su entorno. Mantén la función desactivada salvo que uses una ruta autenticada y verificada.

<a id="upstream-contracts-inspected"></a>

## Contratos ascendentes inspeccionados

Estos enlaces identifican la versión del código fuente usada para contrastar la configuración anterior; no garantizan su disponibilidad para una cuenta concreta:

- [FeatureToml booleano/formas de tabla](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/features/src/lib.rs)
- [Elegibilidad del contexto nativo](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/session/token_budget.rs)
- [Identidad del proveedor y reglas de fusión incorporadas](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/model-provider-info/src/lib.rs)
- [El historial/las notas utilizan los encabezados de solicitud y la autenticación del proveedor](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/ext/history-notes/src/backend.rs)
