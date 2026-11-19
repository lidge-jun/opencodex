---
title: Microsoft 365 Copilot
description: Inicia sesión en Microsoft 365 Copilot y consulta los modelos de chat disponibles en tu cuenta desde OpenCodex.
---

Microsoft 365 Copilot es un proveedor nativo experimental, independiente de GitHub Copilot. Se conecta directamente al servicio privado ChatHub de Microsoft mediante WebSocket. Requiere una cuenta profesional o educativa con acceso a Microsoft 365 Copilot Chat. Microsoft controla la compatibilidad de las cuentas, la disponibilidad y las cuotas. Las cuentas personales quedan fuera del alcance del proveedor.

El propietario del repositorio concedió una excepción a la política de proveedores canónicos para este preajuste. La segunda revisión de seguridad independiente del equipo de mantenimiento aprobó la revisión `359a57431b` el 28 de octubre de 2026. El PR registra el estado de CI para cada revisión. Los endpoints privados de esta guía describen el comportamiento observado.

## Inicio de sesión

En Proveedores, añade **Microsoft 365 Copilot** y selecciona la opción de inicio de sesión. También puedes ejecutar este comando:

```sh
ocx login m365-copilot
```

OpenCodex abre una ventana aislada en Chrome, Chromium o Edge en el equipo donde se ejecuta el proxy. La ventana usa un canal privado con el navegador. Si solo tienes Firefox, instala Chrome, Chromium o Edge para iniciar sesión. Completa el inicio de sesión y la autenticación multifactor de Microsoft en esa ventana y mantenla abierta mientras se carga el selector de modelos. Si abres la URL en otro navegador, OpenCodex pierde acceso a la redirección. OpenCodex captura localmente el código y la sesión web de Copilot asociada a la cuenta, cierra la ventana temporal y guarda las credenciales en el almacén protegido de OAuth. El proxy gestiona la ventana. Puedes cerrar o recargar el panel y continuar el inicio de sesión. Para detener el intento desde la pestaña que lo inició, pulsa **Cancelar**. Si lo iniciaste con `ocx account login m365-copilot`, usa el identificador devuelto con `ocx account cancel m365-copilot --flow <flow-id>`.

Si pulsas **Cancelar** mientras se inicia la sesión, puedes volver a intentarlo de inmediato. El panel envía el nuevo intento cuando termina la cancelación del anterior o falla su inicio.

La ventana usa un perfil temporal. El registro M365 Chat Client de Microsoft rechaza con `AADSTS50011` la redirección habitual de OpenCodex a localhost, por lo que el proxy captura la redirección del cliente nativo. Los tokens de acceso y renovación guardados permiten renovar el acceso en segundo plano. El inicio de sesión interactivo requiere un escritorio local y un navegador compatible instalado. El proveedor carece de un modo sin interfaz que muestre un código.

## Modelos y solicitudes

OpenCodex vuelve a comprobar la credencial seleccionada antes de abrir ChatHub y antes de enviar la prueba de conexión. Un turno o una prueba en espera no puede enviar credenciales que se hayan sustituido durante la espera.

ChatHub admite proxies HTTP(S) y reglas de exclusión del proveedor, incluidas las heredadas de la configuración global. Un proxy SOCKS o un ejecutor de solicitudes personalizado produce un error de configuración antes de abrir el WebSocket. OpenCodex rechaza los ejecutores sin una ruta de socket explícita también antes de preparar o subir imágenes. Usa un proxy HTTP(S), una conexión directa o una regla de exclusión aplicable si tu política de red lo permite.

El proveedor lee las opciones disponibles directamente del selector de chat de la cuenta, incluidos los submenús de Claude y GPT. El interruptor de modelos en vivo habilita la actualización mediante la caché compartida de cinco minutos. Las opciones nuevas se rigen por la política de OpenCodex para modelos nuevos y por tus selecciones guardadas. El selector predeterminado es `Magic` (Auto). En la lista se muestra el prefijo `M365 Copilot ` seguido del nombre de Microsoft. La solicitud usa el identificador de selector de Microsoft. Las opciones que han agotado su cuota pueden seguir visibles si vuelven a estar disponibles al renovarse la cuota.

Si ya habías instalado el proveedor, vuelve a iniciar sesión para capturar la sesión web y habilitar los modelos en vivo. Las solicitudes admiten alias anteriores y la lista de modelos muestra los identificadores nativos de Microsoft. La lectura del catálogo requiere una sesión web de Copilot válida, independiente del token de acceso al chat. Si caduca la sesión web, OpenCodex conserva la última lista obtenida correctamente y solicita un nuevo inicio de sesión para actualizarla. Los metadatos del selector carecen de tamaños de ventanas de contexto.

Incluye el identificador del proveedor al seleccionar un modelo:

```text
m365-copilot/Magic
m365-copilot/Claude_Sonnet
m365-copilot/Gpt_61_Sol_Reasoning
```

Las interfaces de OpenCodex admiten texto en streaming y herramientas ejecutadas por el cliente. El modelo emite la llamada a la herramienta en un bloque delimitado, OpenCodex la convierte al formato del cliente y el cliente la ejecuta con sus propios permisos. OpenCodex reutiliza una conversación solo si coinciden la cuenta de Microsoft, el modelo, la identidad autenticada del solicitante en OpenCodex, la conversación del cliente y el conjunto de herramientas. Si falta la identidad autenticada o la de la conversación, inicia una conversación de ChatHub con el historial de la solicitud. Los chats temporales conservan el contexto de la conversación activa sin añadir una entrada persistente al historial de Copilot.

Cada turno de ChatHub incluye la herramienta integrada de Microsoft `BingWebSearch` en la solicitud, incluso con las herramientas del cliente desactivadas. El modelo puede hacer búsquedas web según las reglas del servicio de Microsoft.

En un combo con conmutación habilitada, si Copilot rechaza la solicitud por cuota antes de que se confirme la salida, OpenCodex pasa al siguiente destino disponible. Los fragmentos de razonamiento vacíos se ignoran. El proxy puede retener brevemente una salida de solo razonamiento durante la comprobación previa. Una vez que el flujo se confirma por razonamiento, texto o una llamada a una herramienta, un rechazo posterior termina el turno en ese modelo.

El proveedor acepta texto e imágenes, incluidas capturas de pantalla devueltas por herramientas del cliente. El selector de Microsoft carece de indicadores de compatibilidad con imágenes por modelo. OpenCodex declara entrada de texto e imagen para todos los modelos descubiertos mediante el protocolo de adjuntos de Copilot. Admite PNG, JPEG, GIF y WebP, con un límite de cuatro imágenes nuevas por turno y 5 MiB por imagen. OpenCodex sube las imágenes a Microsoft y detiene la solicitud si falla una carga. Descarga las imágenes de URL HTTPS públicas sin credenciales ni redirecciones y rechaza destinos locales y privados. Reutiliza las imágenes ya adjuntas a la conversación activa. Si reconstruye la conversación, solo vuelve a adjuntar las cuatro imágenes más recientes del historial.

Se trata de una integración experimental de OpenCodex con un protocolo privado de Microsoft que puede cambiar. Funciona sin agentes de Copilot Studio, extensiones, proxies externos para Copilot ni una consola de administración. La generación de imágenes queda fuera del alcance. El 27 de octubre de 2026 se comprobó la lectura de imágenes con Claude_Sonnet y Gpt_61_Sol_Reasoning.

## Identidad y fuentes

Microsoft identifica el cliente OAuth `c0ab8ce9-e9a0-42e7-b064-33d422df41f1` como **M365 Chat Client** en su [diccionario de documentación de Entra](https://github.com/MicrosoftDocs/entra-docs/blob/main/.docutune/dictionaries/known-guids.json). Es un identificador público de Microsoft. El proceso local de OpenCodex recibe los tokens autorizados. La identidad del cliente OAuth por sí sola no permite evaluar la seguridad de software de terceros.

El código de protocolo y de formato de llamadas a herramientas se adaptó de [cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy/tree/65905e881d6597040966aff9b087aa9a908b358a), con su aviso MIT. Microsoft opera el servicio. El acceso se rige por el acuerdo de tu organización con Microsoft y los [términos del producto Microsoft 365](https://www.microsoft.com/licensing/terms/productoffering/Microsoft365/all). El 26 de octubre de 2026 se verificaron el inicio de sesión real en Firefox, la captura de la redirección en Chrome y Firefox, la transmisión de texto y la devolución de un resultado de herramienta con `claude-sonnet`.

## Evidencia y estado de admisión

Las fuentes primarias se consultaron el **28 de octubre de 2026**. Describen el servicio de Microsoft y su API pública. El uso del protocolo privado del conector queda fuera de esa documentación.

| Requisito | Evidencia y alcance |
| --- | --- |
| Endpoint de chat documentado | La [descripción de la API de chat de Microsoft](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/api/ai-services/chat/overview) y la [referencia de conversaciones](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/api/ai-services/chat/copilotroot-post-conversations) documentan `POST https://graph.microsoft.com/beta/copilot/conversations`. El conector usa el endpoint privado `wss://substrate.office.com/m365Copilot/Chathub/{account}`. |
| Descubrimiento autenticado de modelos | El conector solicita `GET https://copilot.cloud.microsoft/chat/` con cookies ligadas a la cuenta y lee `modelSelectorMetadata` de los datos de arranque del selector principal. La comprobación en vivo se hizo el 27 de octubre de 2026. OpenCodex ofrece `/v1/models` localmente. El esquema de arranque queda fuera de la referencia pública de Microsoft. |
| Operador y términos | Los [términos de uso de las API de Copilot](https://learn.microsoft.com/en-us/legal/m365-copilot-apis/terms-of-use) identifican a **Microsoft Corporation** y enumeran las API cubiertas. También se aplican al servicio los [términos del producto](https://www.microsoft.com/licensing/terms/productoffering/Microsoft365/all) y el acuerdo de tu organización con Microsoft. |
| Modelos y autorización de enrutamiento | Las páginas de Microsoft sobre [privacidad](https://learn.microsoft.com/en-us/copilot/microsoft-365/microsoft-365-copilot-privacy), [Anthropic](https://learn.microsoft.com/en-us/copilot/microsoft-365/connect-to-ai-subprocessor) y [OpenAI](https://learn.microsoft.com/en-us/copilot/microsoft-365/openai-subprocessor) describen el suministro de modelos y los controles de la organización. OpenCodex se conecta directamente a Microsoft. El protocolo privado y la reutilización del cliente OAuth quedan fuera de esas referencias. |
| Identidad de autenticación | El [diccionario de Entra](https://github.com/MicrosoftDocs/entra-docs/blob/main/.docutune/dictionaries/known-guids.json) identifica el cliente M365 Chat Client. La API de chat de Graph usa permisos delegados distintos y requiere una licencia adicional de Copilot. Este conector usa los permisos del cliente M365 Chat Client. |
| Contacto de mantenimiento | El autor del PR, **@x3M3x**, es el contacto de mantenimiento propuesto. Informa de los fallos con el formulario de compatibilidad de proveedor o API del repositorio. Incluye el identificador del conector, la versión de OpenCodex, el navegador y el error sin datos sensibles. La propuesta sigue pendiente de aceptación. |

La excepción del propietario del repositorio permite considerar el preajuste según las reglas internas del proyecto. La autorización del protocolo privado corresponde a Microsoft. Las pruebas citadas verificaron el funcionamiento observado.
