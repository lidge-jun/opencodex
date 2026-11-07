---
title: Opciones del catálogo
description: Omisión opcional de modelos nativos en el catálogo generado de Codex.
---

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
