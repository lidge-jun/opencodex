---
title: StepCode CLI (suscripción)
description: Envíe solicitudes de Codex a través de StepCode CLI con una suscripción Step Plan.
---

OpenCodex puede usar una suscripción Step Plan mediante StepCode sin llamar directamente a
`api.stepfun.com/step_plan`. El preajuste `step-cli` ejecuta la CLI oficial de StepCode
(`step --sdk-stdio`) y le declara las herramientas de cada solicitud para que el cliente pueda
aprobarlas y ejecutarlas:

```json
{
  "providers": {
    "step-cli": {
      "adapter": "step-cli",
      "baseUrl": "https://api.stepfun.com/step_plan"
    }
  }
}
```

- **Requisitos.** Instale StepCode CLI en `~/.stepcode/bin/step` e inicie sesión con `step login`.
  La CLI obtiene su credencial de `auth.json`.
- **Credenciales.** OpenCodex no lee, copia ni reenvía el token de Step. Este preajuste tiene el
  campo `keyOptional`, al igual que `claude-cli`. Para facturación directa por API, use `stepfun`.
- **Una cuenta para el proxy.** Todas las solicitudes enviadas por esta ruta consumen la cuota de
  la cuenta Step Plan del usuario que ejecuta OpenCodex. El plan mide el consumo por solicitud y
  aplica límites de cinco horas y semanales. Codex comparte la cuota con las sesiones de `step`.
- **Herramientas.** Las herramientas se declaran a través del SDK de StepCode. El adaptador recibe
  sus llamadas por stdio y el cliente se encarga de aprobarlas y ejecutarlas. OpenCodex no monta un
  servidor MCP para esta ruta ni guarda los resultados de herramientas por su cuenta.
- **Un proceso por conversación.** StepCode conserva el contexto dentro de su proceso. OpenCodex
  asocia ese proceso a la identidad autenticada, el proveedor y el hilo. Si la solicitud carece de
  credenciales, se abre un proceso por solicitud y las llamadas a herramientas no se pueden
  continuar entre solicitudes. Mantenga el catálogo de herramientas al devolver un resultado
  pendiente. Si el proceso termina, OpenCodex informa del error. Los resultados ya entregados no
  se pueden reproducir por esta ruta.
- **Apagado ordenado.** El proxy espera a que terminen los procesos de StepCode dentro de su plazo
  de apagado e informa de un error si no puede confirmarlo. En macOS y Linux, esto puede ocurrir si
  el líder del grupo de procesos sale antes de que termine el grupo. Algunos procesos descendientes
  pueden seguir ejecutándose. En POSIX, la limpieza solo envía señales al grupo mientras el líder
  original se observa con vida. Bun 1.4.4 puede recoger el estado de salida del hijo antes de que
  JavaScript reciba el evento de salida. En Linux, el hilo de espera nativo se usa como alternativa
  cuando no está disponible la supervisión mediante pidfd. Una señal enviada al grupo entre la
  recogida y la notificación de salida podría alcanzar un PGID reutilizado. Bun no expone a
  JavaScript un `pidfd` ni otro identificador que acredite la pertenencia del proceso a nivel de
  llamada al sistema. Para eliminar ese intervalo hace falta un supervisor nativo o un cambio en
  Bun. El responsable del proyecto aceptó este riesgo residual el 2026-11-19.
  En Windows, StepCode comprueba que el proceso lanzador original sigue en ejecución antes de
  iniciar `taskkill /T /F`. La utilidad busca el PID numérico después de iniciarse. Si el lanzador
  termina y Windows reutiliza su PID entre la comprobación y esa búsqueda, la señal podría
  alcanzar un árbol de procesos ajeno. Para cerrar ese intervalo hay que establecer la pertenencia
  del proceso desde el arranque, por ejemplo con un objeto de trabajo que finalice los procesos al
  cerrarse, y usar su identificador de objeto para terminarlos. El responsable del proyecto aceptó
  este riesgo residual el 2026-11-19 junto con el riesgo de POSIX relativo al orden de recogida y
  notificación de salida. Si el lanzador ya ha salido o la limpieza sigue sin confirmarse después
  de que la utilidad haya podido ejecutarse, OpenCodex pone la sesión en cuarentena, registra una
  advertencia fija e informa de que la limpieza quedó incompleta.
- **Capacidad de conversaciones.** Cada proxy admite ocho sesiones de StepCode por directorio de OpenCodex.
  Si las ocho plazas están ocupadas, las conversaciones existentes pueden continuar. Una nueva
  recibe el error `step_cli_pool_full` y puede reintentarse cuando se libere una plaza.
  Las sesiones inactivas siguen contando hasta que termina su cierre tras diez minutos de inactividad.
- **Límites de sesión.** Si una herramienta tarda más de dos minutos en devolver un resultado,
  el turno informa del error `step_cli_tool_result_too_late`. El protocolo no permite reemplazar
  el mensaje de sistema de la sesión. OpenCodex antepone las instrucciones del cliente al turno.
- **Catálogo de herramientas.** El límite es de **128 herramientas / 2 MiB**, igual que en
  `qoder`, `codebuddy` y `claude-cli`. Codex incorpora todas las herramientas MCP a su catálogo.
  En Codex 0.162.0 se midieron 1749 herramientas y 2,5 MB. Si supera el límite, el error indica
  ambos valores. Desactive o restrinja los servidores MCP de este proveedor.
- **Imágenes.** Los modelos se anuncian como compatibles con texto. Aunque `step-5-preview` y
  `step-3.7-flash` pueden aceptar imágenes en el servicio, esta ruta las rechaza con
  `unsupported_input_modality`. Si hay un servicio de visión auxiliar, convierte las imágenes en
  descripciones de texto antes de reenviarlas.
- **Verificación.** Ejecute `ocx provider test step-cli`.

> **Condiciones.** Este preajuste usa su suscripción Step Plan mediante la CLI oficial. La
> documentación del plan describe los endpoints para herramientas de programación de terceros.
> StepCode publica `--sdk-stdio` para clientes externos con licencia MIT. Consulte con 阶跃星辰
> si las condiciones de su plan permiten usar esa interfaz a través de un proxy.
