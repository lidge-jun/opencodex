---
title: Pausa automática de cuentas
description: Pausa automática opcional de cuentas tras rechazos permanentes exactos.
---

## Pausa automática de cuentas permanentemente rechazadas

`providers.<provider>.accountAutoPause` es opcional y está desactivado de forma predeterminada. Se aplica a las cuentas OAuth de ese proveedor, a las cuentas de grupo de Codex (incluida la cuenta principal en modo de grupo) y a las entradas de grupo de claves API configuradas. Por ejemplo:

```sh
ocx config set providers.anthropic.accountAutoPause.enabled true
ocx config set providers.anthropic.accountAutoPause.consecutiveFailures 2
```

`consecutiveFailures` es un entero de 1 a 100; omitirlo usa 2. Solo cuentan rechazos HTTP 401/403 exactos y propios de la cuenta: una organización que prohíbe OAuth, una suscripción inactiva o vencida, acceso denegado a API/Claude Code, una cuenta deshabilitada por Google por infringir sus condiciones de servicio, o el cambio a un plan gratuito sin créditos. Un error de permisos del modelo, un token de acceso vencido, una ventana de cuota, un 429, un 5xx, una respuesta mal formada o un fallo de red nunca pausan una cuenta.

El contador es de proceso local, serializado por cuenta, y se restablece en una respuesta HTTP exitosa, reanudación explícita o un nuevo inicio de sesión. La actualización del token por sí sola no restablece la racha de una cuenta OAuth. Los errores transitorios dejan el contador sin cambios. Reiniciar el proxy borra los contadores; pausas completadas, sus códigos de razón fija y marcas de tiempo persisten. Los procesos proxy independientes mantienen contadores independientes. Cambiar, deshabilitar o volver a habilitar la política, deshabilitar el proveedor o cambiar su punto final descarta observaciones de rechazo en vuelo, por lo que un rechazo de una solicitud enviada bajo la política anterior nunca puede pausar una cuenta después. Un rechazo cuenta solo para la credencial que realmente llegó a la parte superior: cuando un plugin local reescribe la credencial o el destino de un envío, ese envío nunca cuenta para una pausa. Para Codex cuentas de pool esto incluye el espacio de trabajo (`chatgpt-account-id`) para el que se envió la solicitud.

En el umbral, OpenCodex excluye la cuenta utilizando su mecanismo de pausa existente e intenta un hermano elegible para la solicitud actual dentro del presupuesto de reintento/envío existente. Los selectores de cuenta Codex fijados y los archivos cargados vinculados a la cuenta conservan sus restricciones. Una pausa nunca cancela el trabajo ya enviado ni cambia las credenciales. Emite una línea de registro genérica sin identificadores de cuenta o texto de error ascendente.

`ocx account list <provider>` muestra la razón de pausa. La insignia Paused del panel expone la razón y el tiempo. Utilice `ocx account resume <provider> <account-id-or-alias>` para aclarar la razón y permitir la selección de nuevo. En una fila de API teclas, al hacer clic en Reanudar también se activa la clave. Esta política nunca reanuda una cuenta automáticamente; un inicio de sesión explícito limpia la pausa que registró, y [`resume --if-healthy`](/es/reference/cli/providers-accounts/#resume-if-healthy) reanuda tras una comprobación de salud.
