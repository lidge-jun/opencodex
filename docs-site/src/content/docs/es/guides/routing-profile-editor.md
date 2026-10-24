---
title: "Editor de perfiles de enrutamiento"
description: "Cree, edite, valide, ejecute en seco y elimine perfiles de directivas de enrutamiento del panel de control de OpenCodex."
---

La pestaña **Modelos → Routing** en el panel de control OpenCodex puede administrar `config.routingProfiles` sin editar `config.json` a mano.

<a id="create-a-profile"></a>

## Crear un perfil

1. Abra **Enrutamiento** en el panel de control.
2. Seleccione **Crear perfil**.
3. Introduzca un `id`. El modelo canónico id es `policy/<id>`.
4. Agregue uno o más candidatos explícitos de proveedor/modelo.
5. Configure los requisitos opcionales, las ponderaciones de puntuación, los límites de costo (`onUnknownCost`, `maxEstimatedCostUsd`) y el comportamiento de evidencia desconocida.
6. Guardar el perfil.

Los ID de perfil son inmutables después de la creación. Para usar un id diferente, cree un nuevo perfil y elimine el antiguo después de actualizar las llamadas.

<a id="validation-and-persistence"></a>

## Validación y persistencia

El panel de control envía el mismo objeto de perfil utilizado por `config.routingProfiles` a la administración API. El servidor valida el candidato completo antes de escribirlo:

- ids y alias deben seguir las reglas de nombres y colisiones de perfiles de enrutamiento;
- todos los proveedores candidatos deben existir y estar habilitados;
- Los candidatos duplicados son rechazados.
- Los límites y requisitos numéricos deben permanecer dentro de sus rangos admitidos; y
- al menos un peso de optimización debe ser positivo.

Un guardado exitoso mantiene el perfil a través del escritor de configuración normal, reconcilia el estado en vivo y actualiza el catálogo de modelos. Los errores de validación dejan la configuración anterior sin cambios y se muestran en el editor.

Cuando se configura `limits.maxEstimatedCostUsd`, `limits.onUnknownCost` se establece por defecto en `"allow"`: una estimación de costo desconocida no obtiene una exclusión específica de la tapa, y el sello `cost.capOutcome: "unknown-allowed"` de trazas de ruta de ejecución en seco / en vivo para que los operadores puedan decir que la tapa no fue probada. Establecer `"exclude"` cuando el techo debe fallar cerrado (`cost-limit-unknown`, con `cost.capOutcome: "unknown-excluded"`). La configuración de `onUnknownCost` solo es inerte y no emite un resultado de tapa. Esto es independiente de `unknownEvidence.cost`, que aún puede excluir o penalizar precios desconocidos independientemente del resultado del límite.

<a id="dry-run-a-saved-profile"></a>

## Ejecutar en seco un perfil guardado

Las capacidades candidatas usan la configuración efectiva del proveedor después de que se aplican las anulaciones del registro. Por lo tanto, los requisitos locales (`localOnly` y `remoteAllowed`) utilizan la dirección de flujo ascendente efectiva. Si esa dirección no se puede clasificar, la configuración `unknownEvidence.capability` del perfil decide la elegibilidad. Una configuración de proveedor no válida que no se puede resolver siempre se excluye con `route-unavailable`, incluso cuando se permiten capacidades desconocidas. Los proveedores desaparecidos o desactivados también se excluyen con `route-unavailable` antes de anotar.

Seleccione un perfil guardado y use **Evaluación en seco** para agregar evidencia de solicitud, como el tamaño de la ventana de contexto, el uso de herramientas, la entrada de imágenes o la salida estructurada. Dry-run evalúa la elegibilidad y la puntuación, pero nunca envía una solicitud de modelo ascendente.

Las ediciones no guardadas no son usadas por dry-run. Guarde primero el perfil para que la revisión y la evaluación mostradas se refieran a la misma configuración.

<a id="management-api"></a>

## API de administración

El editor utiliza estos puntos finales:

- `GET /api/routing-profiles` lista perfiles normalizados y revisiones.
- `PUT /api/routing-profiles` crea o actualiza un perfil. Envíe `mode: "create"` o `mode: "update"`; el modo create se niega a sobrescribir un id existente.
- `DELETE /api/routing-profiles?id=<id>` elimina un perfil.
- `POST /api/routing-profiles/dry-run` evalúa un perfil guardado sin enviar aguas arriba.

Ejemplo de guardar carga útil:

```json
{
  "id": "fast",
  "mode": "create",
  "profile": {
    "alias": "ocx/fast",
    "candidates": [
      { "provider": "anthropic", "model": "claude-sonnet-5" },
      { "provider": "openai", "model": "gpt-5.6" }
    ],
    "require": { "tools": true, "minContextWindow": 128000 },
    "optimize": { "latency": 0.55, "health": 0.25, "cost": 0.1, "quota": 0.1 },
    "limits": { "maxEstimatedCostUsd": 0.5, "onUnknownCost": "allow" },
    "unknownEvidence": {
      "capability": "exclude",
      "health": "penalize",
      "quota": "penalize",
      "cost": "penalize"
    }
  }
}
```
