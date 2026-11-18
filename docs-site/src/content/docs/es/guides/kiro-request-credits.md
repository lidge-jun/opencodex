---
title: Créditos por solicitud de Kiro
description: Validación y rechazos de Kiro, registro de créditos en opencodex y estimación de su costo en USD.
---

Cuando el turno admite herramientas, opencodex retiene el texto de Kiro hasta validar la
respuesta. Si Kiro termina con texto sin formato sin invocar su herramienta privada de respuesta
final, opencodex hace un solo reintento y muestra únicamente la respuesta final resultante.
El progreso que acompaña a una llamada a una herramienta sigue siendo visible. Si Kiro invoca
su herramienta de respuesta final, el turno termina sin reintento.

Si el filtro de seguridad de Kiro detiene un turno (`CONTENT_FILTERED`, por ejemplo, el
clasificador `BIO` de Claude), la solicitud termina con un rechazo que los clientes no
reintentan. Los clientes de Claude reciben `stop_reason: "refusal"` y Codex recibe una respuesta
fallida con la categoría y la explicación de Kiro. Si el filtro detiene el reintento, el progreso
retenido del primer intento y el texto parcial del reintento se muestran como comentarios antes
del rechazo. No se muestra una respuesta final.

Cuando Kiro informa de un consumo de créditos, opencodex lo conserva como `usage.providerCredits`
en los registros de solicitudes y en el historial de uso persistente. Los recuentos de tokens
pueden seguir siendo estimados. Si hay un reintento de finalización, los créditos se suman cuando
todos los intentos tienen una lectura. Las API de registros e historial omiten el dato si no hay
una lectura válida y completa. Un cero explícito indica que Kiro informó de un consumo de cero.

## Precio de los créditos en USD

Para estimar el costo de una solicitud a partir de los créditos cobrados por Kiro, configura
`providers.kiro.creditPriceUsd` con el precio en USD de un crédito de tu plan.

```json
{ "providers": { "kiro": { "creditPriceUsd": 0.02 } } }
```

La opción es voluntaria y carece de valor predeterminado porque el precio depende del plan.
Como referencia, [kiro.dev/pricing](https://kiro.dev/pricing/) muestra 1.000 créditos por 20 USD
en el plan Pro (0,02 USD por crédito) y 0,04 USD por crédito adicional. Usa el precio de tu plan.

Con un precio configurado, se aplican estas reglas.

- Una fila con lectura válida se estima con `providerCredits x creditPriceUsd`. Los tokens
  estimados siguen registrados y el costo refleja los créditos cobrados por Kiro.
- Si faltan los créditos y no hay salida, el costo queda como no disponible. Una lectura explícita
  de cero sí se traduce en costo cero.
- Si hay salida y Kiro no informó de créditos, se conserva la estimación por tokens.
- Las filas con un sufijo de cuenta, como `kiro-<account>`, usan el precio del proveedor.
  Una configuración con nombre exacto tiene prioridad. Un proveedor configurado como
  `kiro-team` sin precio propio no hereda el de `kiro`.
- El precio por crédito solo se aplica cuando se resuelve un precio por token para el modelo.
  `kiro-auto`, el modelo predeterminado de Kiro, y cualquier otro modelo sin precio por token
  siguen apareciendo entre las solicitudes sin precio.
- Si omites la opción, se mantiene la estimación por tokens.

Para las filas cobradas por créditos, el panel de detalles del registro muestra el costo estimado,
el total y la fórmula `<credits> credits × <price> per credit` en el idioma del dashboard. Los
cuatro componentes por tokens se omiten para evitar mostrar `$0.0000` en cada uno junto a un
total distinto de cero. Cuando un Combo mezcla intentos cobrados por créditos
y por tokens, o incluye dos precios por crédito, el panel muestra un total combinado y los
desgloses por intento. La API de administración expone la base del cálculo en el campo opcional
`billing` de la estimación.

El cargo por créditos es exacto para el precio configurado. Si un intento cobrado por tokens tiene
un costo mínimo porque no se pudo resolver la tarifa Priority, el Combo mixto conserva el símbolo
`≥`, ya que `credits × price + ≥token` también marca un mínimo para el costo real. El total es
exacto si todos los intentos se cobraron por créditos o si los intentos por tokens resolvieron
su tarifa.

### Límites y valores no representables

`creditPriceUsd` debe estar **entre 0 y 1.000.000**. La API de administración rechaza valores
fuera del intervalo. Si editas el archivo de configuración, al cargarlo opencodex descarta el
valor inválido, emite un aviso con el nombre del proveedor y conserva el resto de la entrada.
Cambiar un precio vuelve a estimar las filas existentes en la siguiente actualización.

Un intento puede informar de hasta 1.000.000.000 de créditos y cada categoría de tokens de una
fila admite hasta 1.000.000.000.000 de tokens. Estos límites están muy por encima del consumo
real. Limitar ambos factores evita que productos como `1e308 x 1e308` den `Infinity`, que
`JSON.stringify` serializa como `null`.

Cuando una fila se cobra por créditos y no es posible calcular un costo representable, la
estimación se marca como no disponible con el motivo `credit_cost_unrepresentable`. Esto incluye
una lectura incompleta, no finita o fuera del intervalo, y un producto que excede la capacidad
numérica. Para las filas cobradas por tokens, un recuento fuera de rango se clasifica como
`invalid_usage` incluso cuando existe un precio.

El precio solo interviene en la estimación local. La facturación del proveedor, la selección de
cuenta y las cuotas siguen las reglas del proveedor.
