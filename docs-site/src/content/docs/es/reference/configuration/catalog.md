---
title: Opciones del catálogo
description: Omisión opcional de modelos nativos en el catálogo generado de Codex.
---

<a id="reloading-model-metadata"></a>

## Recargar los metadatos de los modelos

Codex carga un catálogo local de modelos al iniciar. Después de que OpenCodex cambie ese
catálogo, ejecuta `ocx sync --restart-codex` para actualizar los clientes existentes.
Publicar un archivo de catálogo nuevo no actualiza un cliente que ya está en ejecución.

Un cliente Codex con metadatos de modelo ausentes o desactualizados puede enviar por
anticipado todas las definiciones de herramientas MCP en lugar de usar el descubrimiento
diferido de herramientas, lo que hace mucho más grande cada prompt. Cuando una solicitud de
Codex declara 64 o más definiciones de herramientas MCP anticipadas, OpenCodex registra una
advertencia con el recuento y el umbral, y después reenvía la solicitud sin cambios. La
advertencia no contiene nombres de herramientas ni contenido de la solicitud. Reinicia Codex
para recargar el catálogo: `ocx system codex-restart --yes` lo reinicia a petición (interrumpe
los turnos en ejecución), mientras que `ocx sync --restart-codex` reinicia solo después de
escribir un catálogo o una configuración modificados.

La advertencia se muestra una vez por sesión. Una solicitud sin identidad de sesión no tiene
sesión por la que advertir una sola vez, así que se advierte una vez por solicitud: un
reintento o un traspaso por compactación de la misma solicitud permanece silencioso, y la
siguiente solicitud anónima vuelve a advertir. La lista de sesiones es acotada, por lo que
una instalación con más de 1024 sesiones concurrentes puede ver una advertencia repetida de
la sesión desalojada tras el mayor tiempo de inactividad.

El recuento abarca las herramientas de nivel superior, las declaraciones `additional_tools`
de Responses Lite que el cliente envió con esta solicitud, y las herramientas MCP
representadas en la descripción `exec` de Code Mode. Codex reenvía el catálogo de la ventana
al inicio de cada solicitud, así que las declaraciones enviadas por el cliente en un turno
reanudado también cuentan, incluido un turno que reenvía toda su ventana almacenada bajo
`previous_response_id`; solo se excluye el historial que el propio proxy restauró desde el
estado de `previous_response_id`. La compactación, incluidos los desencadenantes de
compactación de la API Responses, cuenta solo el catálogo de herramientas de nivel superior.
La comprobación reconoce las identidades canónicas de cliente Codex o los metadatos de turno
de Codex; una subcadena `codex` incidental en el nombre de otro cliente no la activa. Las
herramientas diferidas explícitamente, el texto de la conversación y otros clientes de API no
se cuentan.

Los modelos enrutados anuncian el descubrimiento diferido. En Code Mode, descubre las
herramientas disponibles mediante `ALL_TOOLS` y llámalas mediante `tools`; no se requiere una
función `tool_search` separada. Los modelos que usan la interfaz de herramientas directa
pueden exponer `tool_search`.

<a id="omit-disabled-native-models"></a>

## Omitir modelos nativos deshabilitados

`omitDisabledNativeModels` es un booleano opcional de `config.json`, desactivado
de forma predeterminada (`false`). Actívalo y ejecuta `ocx sync` para omitir las filas
nativas deshabilitadas explícitamente sin necesitar un combo con alias nativo:

```json
{
  "omitDisabledNativeModels": true,
  "disabledModels": ["gpt-5.5"]
}
```

El ajuste se aplica a la sincronización, la convergencia, la caché de modelos generada y
el descubrimiento con formato de Codex mediante `/v1/models?client_version=…`. Deshabilitar
un identificador nativo sin calificar omite ese modelo y todas sus filas de selección de
cuenta; deshabilitar uno calificado por cuenta omite solo esa fila de selección.
La plantilla nativa de herencia se valida y se captura antes de la omisión, por lo que las
filas enrutadas conservan los mismos metadatos de entrada y herramientas, incluso si la
única fila que servía de plantilla está deshabilitada.

Un valor ausente, falso o no válido conserva el comportamiento predeterminado, sin esta
omisión adicional. La omisión existente mediante alias nativo es independiente de este ajuste.
El ajuste solo controla el descubrimiento: las solicitudes directas a identificadores nativos
deshabilitados siguen enrutándose con normalidad. Si la sincronización no cambia la salida,
conserva su comportamiento de no escribir y de mantener la fecha de modificación.

Consulta [Modelos de Codex App](/es/guides/codex-app-models/#what-this-means-for-a-disabled-native-model)
para la visibilidad en Desktop y [Configuración del proveedor](/es/reference/configuration/providers/)
para `disabledModels`.
