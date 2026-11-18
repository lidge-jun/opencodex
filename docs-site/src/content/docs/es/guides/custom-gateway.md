---
title: Verificar una puerta de enlace remota personalizada
description: Comprueba una puerta de enlace de Chat Completions desde el descubrimiento hasta una respuesta acotada.
---

Antes de registrar una puerta de enlace, pide a su operador la URL base autorizada de Chat Completions, la clave API y los identificadores de modelos admitidos. Por ejemplo, `https://api.example.com/v1` es un marcador de posición, no un endpoint funcional. Inicia el proxy si aún no está ejecutándose y selecciona **Personalizado** en el dashboard, usa el nombre `my-gateway`, selecciona `openai-chat` e introduce la URL y la clave autorizadas en el formulario. Guarda sin poner la clave en comandos o ejemplos compartidos. Que se guarde el proveedor no demuestra que funcionen el descubrimiento ni la inferencia.

En un Child de [Remote Link](/es/guides/remote-link/), los proveedores proceden del Home: el dashboard del Child rechaza sus modificaciones y sus solicitudes usan los proveedores del Home. Registra y verifica allí la puerta de enlace.

Comprueba cada etapa por separado, usando el puerto local configurado si difiere del predeterminado:

```sh
curl -fsS http://127.0.0.1:10100/healthz
ocx ready
ocx provider test my-gateway
ocx models live --provider my-gateway --json
```

La salud y la disponibilidad describen el proxy; no demuestran que el proveedor pueda generar texto. La prueba del proveedor sin `--model` comprueba el descubrimiento, no la inferencia. `applicable: false` puede indicar que un catálogo estático carece de endpoint de descubrimiento; no equivale a una inferencia correcta. Una lista pública de modelos tampoco tiene por qué validar la clave. Si el descubrimiento falla o no aparece ningún modelo, comprueba la URL, las credenciales, el acceso al proveedor y la configuración antes de seleccionar uno.

Una puerta de enlace puede generar respuestas sin un endpoint de lista de modelos. Si su operador facilita un ID original admitido, configura `liveModels: false` y `models: ["vendor/model"]` en el proveedor existente, conservando sus demás campos y sustituyendo el ID del ejemplo por el recibido. Consulta los [catálogos estáticos](/es/reference/configuration/providers/#static-model-allowlists).

Antes de editar directamente `config.json`, guarda tu trabajo y espera a que terminen las solicitudes activas: detener el proxy puede interrumpirlas. Deténlo mediante su propietario: cierra OpenCodex Desktop desde la bandeja, ejecuta `ocx service stop` si está instalado como servicio o `ocx stop` si no tiene supervisor. Confirma que está detenido, edita y guarda sin ejecutar otros procesos que escriban configuración. Inícialo mediante el mismo propietario: abre Desktop, ejecuta `ocx service start` o el comando original `ocx start` con sus opciones, incluido `--port` si se indicó. Si lo inicias en primer plano, déjalo en esa terminal y ejecuta `ocx sync` y las comprobaciones restantes desde otra. Después vuelve a inspeccionar el catálogo en vivo. También puedes probar directamente el ID original con el comando de respuesta con confirmación de coste que aparece más abajo; esa prueba no necesita una fila del catálogo.

En el catálogo en vivo, inspecciona los campos reales `id`, `namespaced`, `disabled` e `initialSelectionPending`. La selección inicial puede dejar modelos desactivados o pendientes; consulta la [selección inicial de modelos](/es/reference/configuration/providers/#initial-model-selection). Resuélvela antes de activar una fila. Para los comandos de visibilidad, combina el nombre del proveedor con el **`id` original** de la fila, conservando las barras de ese identificador:

```sh
ocx models enable 'my-gateway/<raw-upstream-id>'
```

Por ejemplo, el `id` original `vendor/model` requiere el selector `my-gateway/vendor/model`. El identificador `namespaced` visible para el cliente puede ser `my-gateway/vendor-model`; sustituir uno por otro puede dejar desactivada la entrada original. Activar un modelo no desactiva los demás. Si solo debe ser visible ese modelo de esta puerta de enlace, desactiva las demás filas activadas usando su `id` original en el mismo formato y vuelve a inspeccionar la lista:

```sh
ocx models disable 'my-gateway/<other-raw-upstream-id>'
ocx models live --provider my-gateway --json
```

Comprueba que la fila deseada tenga `disabled: false` y las otras exclusiones previstas estén desactivadas. Un ID nativo sin calificador puede seleccionar otra ruta. Usa valores exactos, no nombres visibles o sufijos de razonamiento adivinados: un sufijo puede ser otro ID del proveedor, mientras que el esfuerzo es una opción aparte. Consulta los detalles en la [referencia de CLI](/es/reference/cli/providers-accounts/).

Cuando sea necesario, ejecuta `ocx sync` para actualizar el catálogo del cliente y confirma que el modelo aparezca en el selector de Codex. Un cliente activo puede conservar una lista anterior en memoria. Guarda el trabajo y, si sigue desactualizado, cierra y abre Codex por completo. Como alternativa, con aprobación explícita, usa [`ocx system codex-restart --yes`](/es/reference/cli/agents/): puede interrumpir la sesión y descartar borradores, selecciones o solicitudes de aprobación sin guardar. Fuera de la edición directa de configuración anterior, reiniciar el cliente o el proxy no es el paso de recuperación predeterminado.

Para verificar una respuesta real en una configuración remota con autenticación por clave admitida, pasa el **`id` original del proveedor** que figure en la fila o te dé el operador, sin añadir el prefijo del proveedor:

```sh
ocx provider test my-gateway --model '<raw-upstream-id>'
```

Esto envía una solicitud acotada, consume cuota y puede generar cargos. Acepta la pregunta, cuyo valor predeterminado es No, solo después de aprobar el coste; en modo no interactivo o JSON se exige `--yes`. Un resultado `applicable: false` no envía una solicitud de generación y no es una prueba superada, aunque el comando termine con cero. Antes de dar por válida una respuesta correcta, comprueba que el modelo transmitido sea el ID original previsto; un alias puede resolver a otro. En JSON aparece como `wireModel`. Una respuesta de texto correcta no demuestra las llamadas a herramientas, la salida estructurada, la continuación ni la identidad real del modelo; la identidad informada por el proveedor es un metadato. Para problemas de compatibilidad posteriores, reproduce por separado el protocolo afectado con datos saneados.
