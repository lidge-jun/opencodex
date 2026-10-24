---
title: "Configuración de enrutamiento"
description: "Selección de proveedor predeterminado, orden de resolución del modelo, alias combinados, ordenación de objetivos y valores predeterminados de esfuerzo."
---

El enrutamiento convierte el ID de modelo enviado por un cliente en un proveedor concreto y un modelo ascendente.

<a id="top-level-routing-fields"></a>

## Campos de enrutamiento de nivel superior

| Campo | Tipo | Predeterminado | Descripción |
| --- | --- | --- | --- |
| `defaultProvider` | `string` | `"openai"` | El proveedor final se usa cuando no coincide ninguna regla de modelo anterior. Debe nombrar un proveedor configurado habilitado. |
| `combos?` | `Record<string, OcxComboConfig>` | `{}` | Modelos virtuales `combo/<id>` construidos a partir de objetivos de proveedor/modelo ordenados. |
| `routingProfiles?` | `Record<string, OcxRoutingProfileConfig>` | `{}` | Modelos virtuales `policy/<id>` que seleccionan entre una lista de permisos de candidatos explícitos utilizando requisitos de capacidad dura y puntuación determinista. |

<a id="model-alias-discovery"></a>

### Alias de modelo descubrimiento

Establecer `preferModelAliasIds: true` para publicar alias de modelo incorporados configurados o habilitados como el `id` en `GET /v1/models`. El valor predeterminado es `false`. Las filas promocionadas conservan su ID calificado anterior en `native_id` y mantienen `alias_of`; ambos ID permanecen enrutables. Los modelos sin alias mantienen sus ID existentes. Si un alias corto es ambiguo a través de proveedores o es sombreado por otra ruta, la fila mantiene su ID calificado de modo que la selección todavía alcanza el modelo previsto. El ID calificado también se mantiene cuando un alias corto incorporado produciría un selector Fast sintético no analizable. El catálogo de modelos de Codex no ha cambiado.

<a id="codex-pool-low-quota-protection"></a>

### Codex Pool Protección de baja cuota

`codexPool.lowQuotaProtection` se aplica solo a las cuentas Codex Pool almacenadas. La cuenta de escritorio/principal mantiene su bloqueo separado del 98%. La forma opcional es:

```json
{"codexPool":{"lowQuotaProtection":{"enabled":true,"threshold":80,"actions":{"pause":true,"notify":true,"desktop":true},"windows":{"short":true,"weekly":true}}}}
```

Ausencia o `enabled: false` lo deshabilita. `threshold` es un porcentaje inclusivo finito de 1 a 100. Una directiva habilitada necesita al menos una acción verdadera y una ventana verdadera. Una ventana seleccionada de 5 horas o semanal se activa en `usage >= threshold`; cualquier ventana seleccionada es suficiente. Solo las observaciones nuevas aceptadas califican: no hay sondeos adicionales, y las observaciones de uso fuera de rango de créditos, caché, caducadas, mensuales, solo de ventana personalizada y sin procesar se ignoran para esta política. Las barras de visualización todavía pueden sujetar porcentajes aguas arriba no válidos. La política es independiente del cambio proactivo de cuenta.

Con `pause`, la cuenta se excluye en memoria de la selección Pool antes de la siguiente solicitud. El servidor agrupa el guardado de configuración tras observar el turno y reintenta los fallos de guardado durante un plazo limitado. El cierre normal espera brevemente a los guardados pendientes. Un guardado cuyo plazo venció pero ya estaba ejecutándose permanece `pending` hasta que termine; uno en cola se cancela. Los fallos son visibles en el historial de eventos. Si el proxy se reinicia antes de guardar correctamente, puede perderse la pausa. Las solicitudes en curso conservan la cuenta que ya capturaron. La reanudación manual evita volver a pausar la cuenta por todas sus ventanas actualmente altas hasta que una lectura por debajo del umbral o un nuevo restablecimiento rearme una ventana. Un restablecimiento nunca reanuda una cuenta automáticamente.

Con `notify`, el servidor escribe una línea de registro local con ventana y porcentaje, pero sin id de cuenta y registra un evento limitado. Autenticado `GET /api/codex-auth/low-quota-events` expone sólo los eventos de ese servidor, incluyendo ID de cuenta, ventana, porcentaje de uso, tiempo de restablecimiento conocido, marca de tiempo y estado. El estado predeterminado es `logged`: la alerta solo alcanzó el historial de registros y eventos. Cada cuenta/ventana se registra una vez por episodio local del servidor.

Opcional `actions.desktop: true` (requiere `notify: true`) también entrega cada aviso al notificador del sistema operativo de la máquina que ejecuta el proxy: `/usr/bin/osascript` en macOS, o `notify-send` de `/usr/bin`, `/usr/local/bin` o `/bin` en Linux. La notificación nombra la cuenta solo por su etiqueta de registro seudónimo (por ejemplo, `p1a2b3c`), nunca por su correo electrónico, alias o id, e incluye la ventana, el uso, el umbral y el tiempo de reinicio conocido. Windows y hosts sin un notificador compatible mantienen la alerta `logged`. `delivered` significa que el notificador del sistema operativo aceptó la notificación; no puede ver si la configuración de notificación del sistema la oculta. Un notificador de fallo o de tiempo de espera se registra como `failed`; una observación elegible al menos cinco minutos más tarde puede volver a intentarlo, sin repetir la línea de registro. La activación o desactivación de `desktop` se aplica a la siguiente observación sin reiniciar. Un aviso que aún está en vuelo se cancela al apagarse, y cuando la siguiente observación de la cuota detecta que su episodio terminó (restaurar límite, recuperación, eliminación de cuenta o cambio de política); hasta entonces, el notificador está limitado por un tiempo de espera de cinco segundos.

<a id="model-resolution-order"></a>

## Orden de resolución del modelo

opencodex resuelve el modelo solicitado en este orden:

1. Un `policy/<id>` o alias de perfil configurado ejecuta el evaluador de políticas y enruta al candidato elegido. Un selector reservado `policy/<id>` desconocido se rechaza antes de evaluar las reglas posteriores.
2. Un espacio de nombres `<account-selector>/<native-openai-model>` configurado usa exactamente la cuenta de Codex asignada. Si el modelo nativo o el destino exacto no son válidos o no están disponibles, la solicitud se rechaza sin recurrir a Pool, Direct ni a otro proveedor.
3. Un `combo/<id>` canónico o un alias de Combo configurado. Los identificadores canónicos tienen prioridad frente a los alias.
4. Un espacio de nombres `<provider>/<model>` explícito cuyo prefijo sea un proveedor configurado.
5. Un identificador nativo de OpenAI sin prefijo, como `gpt-*`, `o1-*`, `o3-*` u `o4-*`, mediante el proveedor canónico `openai` activado.
6. Una coincidencia exacta con el `defaultModel` de un proveedor.
7. Un prefijo conocido de familia de modelos.
8. Un modelo exacto de la lista `models` de un proveedor.
9. `defaultProvider`, conservando el identificador solicitado.

Se excluyen los proveedores desactivados. Una solicitud con el espacio de nombres explícito de un proveedor deshabilitado se rechaza en lugar de continuar con las reglas siguientes. Las entradas de proveedor se comprueban en su orden de inserción JSON cuando una regla puede coincidir con varios proveedores; usa espacios de nombres explícitos si un modelo sin prefijo podría ser ambiguo.

<a id="blocked-model-redirects"></a>

### Redireccionamientos de modelo bloqueado

`blockedModelRedirects` es un nivel superior opcional `Record<string, string>` de reemplazos de ID de modelo resueltos exactos, no configurado por defecto. Las claves desnudas aún coinciden con el proveedor, la cuenta y la resolución de alias del modelo nativo **después**. Un objetivo sin un proveedor configurado explícito y diferente mantiene ese proveedor y cuenta seleccionados y reemplaza solo el ID de modelo ascendente, una vez. Esto preserva las asignaciones existentes de valores desnudos y de barra diagonal, incluidas las asignaciones en las solicitudes calificadas por el proveedor.

Un destino que nombra explícitamente un **proveedor configurado diferente** (por ejemplo, `google-antigravity/gemini-3.8-flash-high`) en su lugar se enruta a través de ese proveedor. Una clave exacta `<source-provider>/<resolved-model>` con tal objetivo tiene prioridad sobre una clave desnuda; otras claves calificadas no tienen ningún efecto. Las redirecciones entre proveedores pueden encadenarse a través de alias resueltos, con un límite de cinco bordes compartido y detección de ciclo. Un selector de cuenta anclado nunca sale de su cuenta: un destino que apunta a otro proveedor se rechaza, tanto si su clave no tiene prefijo como si está calificada para la cuenta. El destino utiliza sus propias credenciales y cuota, y nunca hereda campos de cuenta de origen; se elimina un encabezado `Authorization` del llamante dirigido a la ruta de origen, como para las rutas combinadas y de directiva. Un destino deshabilitado, un destino directo o un destino clave/OAuth sin credenciales almacenadas utilizables mantiene el comportamiento heredado de la ruta de origen. Bajo una política de enrutamiento, cada objetivo de redirección debe ser un candidato elegible declarado, incluso cuando mantiene el mismo proveedor. El conjunto de proveedores/modelos elegibles de la evaluación inicial permanece fijo a través de la recuperación de subagentes. Los reintentos usan candidatos concretos, por lo que un alias combinado no puede reemplazar el destino de un candidato. Diferentes candidatos que resuelven un destino ya intentado no vuelven a enviar el turno allí. Un modelo virtual elegible mantiene su mapeo normal de modelo de cable sin agregar esa identificación de cable a los candidatos permitidos del perfil. Si se salta un reemplazo local, la reserva retiene el último fallo aguas arriba. Los mapas de redirección mal formados se ignoran con una advertencia bajo carga y se rechazan en las escrituras de configuración. Las rutas redirigidas registran `blocked-model-redirect`; omitiendo la configuración deja el enrutamiento sin cambios.

```json
{
  "blockedModelRedirects": { "gpt-5.6-terra": "gpt-5.6-luna" }
}
```

<a id="exact-codex-account-selectors"></a>

## Selectores de cuenta Codex exactos

`codexAccountNamespaces` mapea un selector público tal como `side` a una cuenta Codex almacenada. Una solicitud para `side/gpt-5.6-sol` usa solo esa cuenta, incluso cuando el proveedor canónico `openai` está en modo Direct, y envía el identificador de modelo `gpt-5.6-sol` desnudo aguas arriba. Solo los identificadores familiares OpenAI nativos desnudos son válidos después del selector. Los identificadores de cuentas descubiertas observados en el catálogo de modelos actual de Codex también se pueden conservar exactamente cuando aún no forman parte del conjunto estático de opencodex; la observación debe llevar la forma de campo de una fila de catálogo real, permanece calificada para su selector de cuenta coincidente y nunca se promociona a la lista de modelos desnudos global. Esa comprobación de forma filtra filas mal formadas y mínimas: no es un control de confianza, porque la caché de modelos es un archivo propiedad del usuario y una fila completa escrita a mano es indistinguible de una observación ascendente. Nada nuevo se convierte en enrutable: un identificador `gpt-*` desnudo bajo un selector de cuenta es aceptado por el enrutador independientemente del catálogo.

La selección exacta evita la estrategia de asignación Pool y la afinidad de hilo ordinaria. Si la cuenta asignada falta, está pausada, se está enfriando, no se puede usar o requiere una nueva autenticación, la solicitud se rechaza sin recurrir a otra cuenta y no cambia la cuenta activa de Pool. Cuando se configura al menos un selector elegible, Codex catálogos ocultan filas de selector nativo desnudas y listan una fila `<selector>/<native-openai-model>` separada para cada selector. Los identificadores nativos desnudos retienen el enrutamiento normal Pool / Direct y permanecen en el descubrimiento de `/v1/models` sin procesar a menos que se deshabiliten explícitamente. Los selectores cuya cuenta almacenada asignada no se muestra no se anuncian. La validación del selector, las reglas de colisión y la guía de privacidad están documentadas en [Configuración del proveedor](/es/reference/configuration/providers/).

La página Codex Auth expone este comportamiento de selector como un opt-in. Deshabilitarlo oculta las filas del selector calificado generadas y restaura las filas ordinarias de GPT, pero no elimina las asignaciones ni cambia el enrutamiento exacto `<selector>/<model>`. Por lo tanto, volver a habilitar restaura las mismas etiquetas públicas. Las mutaciones de cuenta y configuración persisten antes de una actualización de catálogo limitada; una advertencia `ocx sync` solo significa que el catálogo de selector aún necesita convergencia, no que se haya perdido el cambio de enrutamiento.

## Combos (`config.combos`)

Cada tecla combinada es una identificación que coincide con `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Siempre es direccionable directamente como `combo/<id>` y también puede exponer un `alias`. Los alias deben ser únicos, no pueden ocupar el espacio de nombres `combo/` y no pueden usar familias nativas desnudas reservadas como `gpt-*`, `o1-*`, `o3-*`, `o4-*` o `codex-*` a menos que `nativeAlias: true` permita explícitamente el contrato de compatibilidad con el escritorio.

| Clave | Tipo | Predeterminado | Descripción |
| --- | --- | --- | --- |
| `targets` | `{ provider: string; model: string; weight?: number; lastResort?: boolean; metered?: boolean }[]` | requerido | Rutas concretas ordenadas. `weight` es 1-10000 y por defecto `1`. `lastResort` marca un objetivo de emergencia solamente; ver `cooldownWaitPolicy`. `metered: true` requiere el consentimiento de la clave o el consentimiento combinado de solo loopback; ver [consentimiento](/es/guides/combos/#metered-fallback-consent). |
| `allowMeteredTargets?` | `boolean` | `false` | Consentimiento del operador para llamadas locales en un proxy de solo loopback. Un oyente que no es de bucle de retorno deshabilita esta bandera; las personas que llaman con clave configurada y vinculada todavía necesitan el consentimiento de clave. |
| `strategy?` | `"failover" \| "round-robin" \| "random" \| "least-used" \| "reset-window" \| "jev"` | `"failover"` | Estrategia de selección. El orden objetivo es la prioridad de conmutación por error; los pesos forman sorteos redondos y aleatorios; el menos utilizado sigue los éxitos registrados; la ventana de reinicio sigue el reinicio de cuota más rápido; JEV toma una decisión limitada para el objetivo inicial elegible y el esfuerzo, luego usa la reserva ordenada ordinaria. |
| `stickyLimit?` | `number` | `1` | Solicitudes exitosas retenidas en un lote round-robin. Alcance 1-100. Solo se aplica a round-robin. |
| `cooldownMs?` | `number` | sin configurar → 5 s para límites de frecuencia 429 con códigos `1302`/`1305`; 10 min para una ventana de uso agotada o fallos de credenciales/facturación de todo el proveedor; 60 s en los demás casos | Rango 1-600000. Cuando se establece, se aplica siempre que no exista una señal de reinicio de flujo ascendente `Retry-After` o Codex utilizable, incluida la tasa de solicitud 429s; cuando no se establece, utiliza la reposición de flujo ascendente. Las señales ascendentes tienen prioridad. Un `Retry-After` aguas arriba explícito está limitado a las 24 horas; los tiempos de reutilización derivados, configurados y de reserva están limitados a los 10 minutos. |
| `waitForCooldownMs?` | `number` | `0` | Esperar al máximo el objetivo de enfriamiento elegible más temprano en cada intento de selección. Rango 0-600000; un aborto cancela la espera. Un combo de un solo objetivo con una espera distinta de cero mantiene la solicitud hasta este techo y vuelve a intentar el mismo objetivo en lugar de fallar inmediatamente; si no se envió ningún objetivo, la espera termina en `combo_unavailable`, de lo contrario se devuelve el último fallo ascendente. |
| `cooldownWaitPolicy?` | `"before-last-resort"` | Sin configurar | Aplaza los destinos marcados como `lastResort`: con cualquier estrategia, solo se usan si no hay un destino normal disponible. `waitForCooldownMs` permite esperar a que termine el enfriamiento de un destino normal. Con su valor predeterminado `0` no se espera y se usa el último recurso en cuanto no haya un destino normal disponible. Este aplazamiento y la espera ordinaria comparten un único presupuesto `waitForCooldownMs` por intento de selección. Solo la cadena indicada activa esta política; sin ella, `lastResort` no tiene efecto. |
| `defaultEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra" \| null` | Sin configurar | `defaultEffort` llena un `reasoning.effort` ausente en el modo de reserva, o anula el esfuerzo del llamante válido en el modo de fuerza explícita cuando el combo tiene un valor por defecto no nulo y el objetivo seleccionado tiene una escalera conocida, no vacía. Si el destino admite el valor configurado, se retiene; de lo contrario, se usa el peldaño soportado más alto en o por debajo de él, o el peldaño soportado más bajo cuando ninguno es más bajo. Las escaleras desconocidas o vacías omiten el valor predeterminado. |
| `defaultEffortMode?` | `"fallback" \| "force"` | `"fallback"` | Preserva la precedencia del llamante por defecto. La fuerza explícita requiere un valor predeterminado válido, respeta la capacidad de destino y puede aumentar el costo y la latencia. `reasoningEffortMode` sigue siendo independiente. |
| `reasoningEffortMode?` | `"strict" \| "adaptive"` | `"strict"` | `"strict"` corta todas las escaleras objetivo conocidas, incluidas las vacías; `"adaptive"` excluye las escaleras vacías. Las escaleras desconocidas son comodines de catálogo en ambos modos. Al momento, las escaleras vacías explícitas eliminan los controles de esfuerzo/pensamiento en ambos modos; las escaleras desconocidas lo hacen solo en adaptativo. Se conserva el `reasoning.summary`. Los objetivos no vacíos conocidos conservan su resolución de esfuerzo, y la selección/orden del objetivo no cambia. |
| `imageInput?` | `"auto" \| "disabled"` | `"auto"` | `"auto"` publica imágenes solo cuando cada objetivo admite imágenes; `"disabled"` fuerza el texto solo (cae la imagen de las modalidades publicadas y rechaza las solicitudes que llevan imágenes antes del envío). |
| `alias?` | `string` | — | id modelo público opcional en lugar de la identificador selector canónica. |
| `nativeAlias?` | `boolean` | `false` | Deje que un id nativo desnudo actualmente soportado tenga prioridad solo para ese id no calificado. Los identificadores de Bare `gpt-5.6-*` usan las credenciales Codex Pool / Direct. Las rutas calificadas para la cuenta siguen siendo distintas. Las rutas calificadas por el proveedor como `openai-apikey/gpt-5.6-*` usan su ruta API -key configurada y nunca pasan al alias nativo. |
| `displayName?` | `string` | — | Etiqueta de catálogo solo para mostrar, requerida y no vacía para un alias nativo. |
| `decisionProvider?` | `string` | `"jev"` | `strategy: "jev"` solamente. `"jev"` (lo mismo que omitirlo y almacenarlo como omisión) es el servicio de decisión TypeSafe, válido sin una fila de proveedor; cualquier otro valor debe nombrar un proveedor configurado con `adapter: "jev-decision"` y una decisión completa HTTPS `baseUrl` (cualquier ruta) o un punto final local HTTP `/systemone`. Userinfo, cadenas de consulta y fragmentos son rechazados. |
| `decisionModel?` | `string` | Sin configurar | `strategy: "jev"` solamente, mutuamente excluyentes con `decisionProvider`. Una ruta ordinaria opencodex (por ejemplo `ollama/qwen3:4b`) pidió elegir una opción ofrecida como JSON. Se ejecuta con las credenciales almacenadas del proveedor seleccionado, nunca con las de la persona que llama, y no puede resolver este combo, ningún combo JEV o una fila `jev-decision`. |
| `decisionTimeoutMs?` | `number` | `4000` | Solo `strategy: "jev"`. Plazo de la decisión antes de usar la alternativa fail-open al primer destino elegible, 1000-120000 ms. |
| `decisionQuotaSignals?` | `boolean` | `false` | Sólo JEV. Explícito `true` envía evidencia de cuota de asesoramiento cargada al backend seleccionado; nunca cambia la elegibilidad dura o la selección de cuenta. |
| `decisionQuotaTiers?` | `{ moderate?: number; limited?: number; nearlyExhausted?: number }` | `{ limited: 70, nearlyExhausted: 90 }` | Sólo JEV. Las anulaciones parciales se combinan con valores predeterminados; los valores finitos de 0-100 deben ser estrictamente ascendentes. `moderate` está ausente a menos que sea explícito. No permite señales por sí mismo. |
| `sessionPin?` | `{ ttlMs: number }` | Desactivado | Solo JEV. Mantiene una sesión explícita del cliente en el destino elegido mientras siga activa; `ttlMs` es el plazo de inactividad, de 60000 a 86400000. `null` borra el ajuste. Véase [Fijación de sesión para JEV](/es/guides/combos/#session-pin-for-jev). |

La configuración de cuotas, la privacidad y la semántica de grupos desconocidos se describen en [Señales de cupos de asesoramiento para JEV](/es/guides/combos/#advisory-quota-signals-for-jev). La configuración omitida sobrevive a las actualizaciones/cambio de nombre de JEV API; `null` borra, `false` desactiva las señales sin borrar niveles, y cambiar a otra estrategia elimina ambas configuraciones.

```json
{
  "defaultProvider": "openai",
  "combos": {
    "coding": {
      "targets": [
        { "provider": "anthropic", "model": "claude-sonnet-5" },
        { "provider": "openrouter", "model": "qwen/qwen3-coder-plus" }
      ],
      "strategy": "failover",
      "defaultEffort": "high",
      "alias": "coding-primary"
    }
  }
}
```

Para ver el comportamiento de la estrategia, los fallos reintentables, los tiempos de reutilización, los límites de tareas cifrados v2 y los comandos de administración, consulte [Combos](/es/guides/combos/).

La estrategia `jev` es opcional. Solo el método TypeSafe, utilizado cuando no se establece `decisionProvider` ni `decisionModel`, requiere la credencial canónica del proveedor `jev`. Ese proveedor es un servicio de decisión, no publica un modelo directamente enrutable y no puede ser un objetivo combinado. JEV solo ve miembros elegibles actualmente de `targets`; las decisiones faltantes, fallidas o inválidas usan el primer miembro elegible, mientras que la cancelación de la persona que llama sigue siendo terminal. La adición del proveedor o Combo nunca cambia `defaultProvider` ni oculta las filas del modelo directo. Véase [Método de decisión](/es/guides/combos/#decision-method) para los tres métodos, configuración, límites de privacidad y el contrato de una decisión por llamada. API -Los ámbitos clave de proveedor/modelo también se aplican a los destinos de decisión TypeSafe y autoalojados, antes de que se lean sus credenciales o el estado de la solicitud. Si la clave niega el destino de decisión opcional, no se envía ninguna solicitud de decisión; la inferencia elegible ordinaria tiene que satisfacer el alcance de esa clave.

<a id="self-hosted-decision-model-eg-ollama-tev1"></a>

### Modelo de decisión autoalojado (e.g. Ollama tev1)

`decisionProvider` puede apuntar un JEV Combo en un modelo de decisión compatible con Jev-API autoalojado como Ollama 's `tev1` (Ollama 0.35 +, `POST /v1/systemone`, no API clave):

```json
{
  "providers": {
    "ollama-tev1": {
      "adapter": "jev-decision",
      "baseUrl": "http://127.0.0.1:11434/v1/systemone",
      "allowPrivateNetwork": true,
      "defaultModel": "tev1:4b",
      "liveModels": false
    }
  },
  "combos": {
    "jev-local": {
      "strategy": "jev",
      "decisionProvider": "ollama-tev1",
      "decisionTimeoutMs": 60000,
      "targets": [
        { "provider": "openai", "model": "gpt-5.6-sol" },
        { "provider": "openai", "model": "gpt-5.6-luna" }
      ]
    }
  }
}
```

El `baseUrl` de la fila es el endpoint de decisión completo. Los endpoints locales
con HTTP sin cifrar deben terminar en `/systemone`; los endpoints HTTPS pueden usar
su ruta configurada, por ejemplo `/v1/decisions`. El modelo procede de
`defaultModel` o, en su defecto, de `models[0]`. Una fila sin ninguno de los dos
aplica la alternativa fail-open sin enviar una solicitud de decisión.
Loopback requiere un `allowPrivateNetwork: true` explícito en la propia fila.
El protocolo `http:` sin cifrar solo se acepta para `localhost` o una dirección
literal de loopback, RFC 1918 o ULA alcanzada sin proxy.

Solo se envía el `apiKey` de esa fila, o ninguna clave si no está configurada.
Se rechaza una clave que haga referencia a las variables de entorno de TypeSafe
o a la entrada de llavero de otro proveedor; las credenciales de TypeSafe nunca
se envían a este destino. Las opciones se transmiten como cadenas de descripción,
como requiere Ollama. `tev1` se entrenó con 2–24 opciones: mantenga el producto
de destinos por niveles de esfuerzo en 24 o menos. Si hay menos de 2 o más de
26 opciones, se aplica la alternativa fail-open sin hacer la solicitud.
Su contexto efectivo es de unos 2k tokens, y OpenCodex limita el texto de la tarea
a 500 caracteres.

Mantenga el modelo residente (`OLLAMA_KEEP_ALIVE=-1`) y aumente
`decisionTimeoutMs` para servicios lentos; consulte
[Servidor compatible con System One](/es/guides/combos/#system-one-compatible-server).
En el panel, elija **Servidor compatible con System One** en **Método de decisión**
del combo JEV, en **Modelos → Combos**. Seleccione la fila y configure
**Tiempo de espera de decisión (ms)**.

<a id="routing-policy-profiles-configroutingprofiles"></a>

## Perfiles de las políticas de enrutamiento (`config.routingProfiles`)

Los perfiles de política de enrutamiento son la capa de selección de Inteligencia de Enrutador: un `policy/<id>` solicitado explícitamente (o alias configurado) selecciona entre una lista de permisos candidata fija utilizando requisitos de capacidad dura y puntuación explicable y determinista. Una solicitud explícita `policy/<id>` (o un alias configurado) ejecuta el evaluador y encamina al candidato seleccionado. Los identificadores de modelo existentes son **nunca** enrutados a través de un perfil implícitamente: el espacio de nombres `policy/` y los alias de perfil son los únicos puntos de entrada, y ambos se validan contra el orden de resolución del modelo anterior.

Cada llave es un id que empareja `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, siempre direccionable como `policy/<id>`, con un `alias` opcional. Los alias deben ser únicos y no pueden colisionar con proveedores configurados, el espacio de nombres de enrutamiento `<provider>/<model>`, combos, espacios de nombres de cuentas de códices, el espacio de nombres `policy/` o familias nativas desnudas reservadas (`gpt-*`, `o1-*`, `o3-*`, `o4-*`, `codex-*`).

| Clave | Tipo | Predeterminado | Descripción |
| --- | --- | --- | --- |
| `candidates` | `{ provider: string; model: string }[]` | requerido | Lista explícita de permisos de `provider/model` refs. No hay expansión implícita. |
| `alias?` | `string` | — | ID modelo público opcional en lugar de `policy/<id>`. |
| `require?` | objeto | `{}` | Requisitos de capacidad dura evaluados antes de la puntuación (ver más abajo). |
| `optimize?` | objeto | latencia 0,55, salud 0,25, costo 0,10, cuota 0,10 | Pesos de puntuación, normalizados determinísticamente. `health`, `quota` y `cost` tienen dimensiones de puntuación; la cuota de prioridad configurada es `1 - health - quota - cost` (por defecto 0,55), y `latency` se pliega en esa cuota de prioridad en lugar de anotar independientemente. |
| `limits?` | objeto | — | Límites difíciles. `maxEstimatedCostUsd` excluye a un candidato cuando se conoce su costo estimado y por encima del límite. Cuando se establece ese límite, `onUnknownCost` ( `"allow"` por defecto, o `"exclude"` ) controla estimaciones desconocidas: allow evita una exclusión específica del límite y registra `cost.capOutcome: "unknown-allowed"`; exclude emite `cost-limit-unknown` y `capOutcome: "unknown-excluded"`. `onUnknownCost` solo (sin tapa) es inerte. Separado de `unknownEvidence.cost`, que aún puede excluir o penalizar precios desconocidos a través de `unknown-price` / puntuación. |
| `unknownEvidence?` | objeto | capacidad `exclude`, salud / cuota / costo `penalize` | Cómo se trata la evidencia desconocida por dimensión: `allow`, `penalize` o `exclude`. Desconocido nunca se convierte en cero. |

`require` soporta: `minContextWindow` (entero positivo), `minQuotaHeadroom` (0...1 fracción), y los booleanos `tools`, `imageInput`, `structuredOutput`, `localOnly`, `remoteAllowed`,
`encryptedCodexTasks`; más `reasoningEffort` y `serviceTier` cuerdas.

Para `unknownEvidence.capability`, `penalize` se comporta actualmente como `allow`: la puntuación solo tiene un componente de prioridad configurada hasta que se envía una dimensión de puntuación de capacidad (planificada con RI-06 +), por lo que `penalize` aún no puede cambiar el candidato seleccionado.

La evidencia de solicitud se evalúa contra las capacidades del candidato junto con el bloque `require` de perfil; un candidato debe satisfacer a ambos para ser elegible. En la ruta de solicitud en vivo, el proxy obtiene herramientas y evidencia de entrada de imagen del cuerpo de la solicitud; el tamaño de la ventana de contexto y las dimensiones de evidencia restantes permanecen desconocidas en el momento del enrutamiento. Utilice la prueba en seco API / CLI para inspeccionar toda la superficie de evidencia en busca de perfiles sensibles al contexto.

El CLI en seco acepta banderas de solicitud de pruebas, pero aún no puede proporcionar evidencia de capacidad candidata; la evidencia candidata se proporciona a través del API (`POST /api/routing-profiles/dry-run`).

```json
{
  "routingProfiles": {
    "fast": {
      "alias": "ocx/fast",
      "candidates": [
        { "provider": "anthropic", "model": "claude-sonnet-5" },
        { "provider": "openai", "model": "gpt-5.6-sol" }
      ],
      "require": { "tools": true, "minContextWindow": 128000 },
      "optimize": { "latency": 0.55, "health": 0.25, "cost": 0.10, "quota": 0.10 },
      "limits": { "maxEstimatedCostUsd": 0.50, "onUnknownCost": "allow" },
      "unknownEvidence": {
        "capability": "exclude",
        "health": "penalize",
        "quota": "penalize",
        "cost": "penalize"
      }
    }
  }
}
```

CLI: `ocx route policy list [--json]`, `ocx route policy show <id> [--json]`, y `ocx route policy dry-run <id> [--model-context <tokens>] [--tools] [--image] [--structured-output] [--json]`. Dry-run evalúa a los candidatos sin enviar ninguna solicitud previa.

La evidencia de cuotas (`optimize.quota`, `require.minQuotaHeadroom`, `unknownEvidence.quota`) proviene de cachés de cuotas Codex y Anthropic con clave de cuenta. Un candidato en entorno de ejecución recibe la cuota en caché solo cuando la evidencia ya identifica la cuenta. Los candidatos canónicos no vinculados `openai` y Anthropic siguen siendo desconocidos durante la evaluación de la política porque la selección Pool, la identidad del llamante Direct, la rotación del proveedor y la afinidad del hilo se resuelven después de que la política elija un proveedor / modelo; una cuenta activa en el proceso no se usa como sustituto. La evidencia de cuotas nunca cambia la selección de cuentas, la afinidad de sesiones, los tiempos de reutilización o el comportamiento de cambio, solo alimenta la puntuación de las políticas. Para ver el comportamiento de acuerdo con la cuota en una ejecución en seco de API, las referencias de cuenta de suministro en la evidencia candidata enviadas a `POST /api/routing-profiles/dry-run`: `candidates[].codexAccountId` (grupo de Codex, proveedor `openai`) o `candidates[].accountRef` (Anthropic) obtienen la cuota de cuenta en caché coincidente; se repite un objeto `candidates[].quota` explícito como se indica. El CLI dry-run no puede suministrar estos campos de cuenta por candidato.

<a id="combos-vs-policy-profiles"></a>

### Combos vs perfiles de políticas

- Un **combo** es un enrutamiento de destino explícito con una estrategia seleccionable (conmutación por error ordenada, equilibrio ponderado o aleatorio suave, menos utilizado, ventana de reinicio o una decisión de primera selección de JEV limitada): la estrategia configurada decide y los fallos reintentables avanzan a través de la lista.
- Un **perfil político** es una selección basada en la evidencia entre los candidatos configurados: los requisitos de capacidad dura se filtran primero, luego la puntuación determinista clasifica a los sobrevivientes.

Ambos son espacios de nombres virtuales con alias y validación de colisión; difieren en *cómo* se elige un candidato. La puntuación de perfil combina el componente de prioridad configurada con las dimensiones de puntuación de salud (RI-06), cuota (RI-07) y coste (RI-08) donde hay evidencia; el peso de `latency` se pliega en la cuota de prioridad en lugar de anotar independientemente. El costo también se aplica a través del límite de `limits.maxEstimatedCostUsd`: se excluye a un candidato cuyo costo estimado sea conocido y exceda el límite (`cost-limit`). Cuando se configura un límite y se desconoce la estimación, el valor predeterminado `limits.onUnknownCost: "allow"` registra `cost.capOutcome: "unknown-allowed"` en el trazado de decisión de ruta sin una exclusión de límite; se establece `onUnknownCost: "exclude"` para un techo cerrado por error (`cost-limit-unknown`). El resultado del límite no es la elegibilidad general: `unknownEvidence.cost: "exclude"` aún puede agregar `unknown-price` y marcar al candidato no elegible. Los rastros de decisión de ruta por solicitud se registran cuando se ejecuta un perfil de directiva.

<a id="catalog-eligibility"></a>

### Elegibilidad del catálogo

Un combo permanece directamente enrutable incluso cuando no se puede enumerar. `ocx sync`, `/v1/models`, y el selector Codex lo lista solo cuando cada destino expone capacidades que pueden ser intersectadas:

- un `contextWindow` positivo, a partir de metadatos activos, sugerencias de registro, proveedor `modelContextWindows` / `contextWindow`, un `maxInputTokens` positivo conocido en la fila de miembros, o - cuando el proveedor es conocido y habilitado pero cada fuente aún omite una ventana - una reserva conservadora de 128,000 tokens (fijada por `providerContextCaps` cuando se establece); y
- una intersección `inputModalities` no vacía, tratando un valor de miembro omitido como `["text"]`.

Un destino en un proveedor deshabilitado (incluso con una fila de descubrimiento completa), en un proveedor desconocido sin fila de descubrimiento, o en objetivos con modalidades disjuntas, elimina el combo del catálogo. La sincronización emite una advertencia de resumen y el tablero de instrumentos lo marca como **Necesita atención**. Agrega metadatos de contexto, alinea modalidades o modelos de destino con capacidades compatibles detectables.

<a id="request-history-and-routing-analytics"></a>

## Historial de solicitudes y análisis de enrutamiento

- `GET /api/request-history` - historia completa paginada por cursor del índice derivado (`routing-history.sqlite`), con filtros (`provider`, `model`, `requestedModel`, `status`, `conversationId`, `surface`, `inboundProtocol`, `apiKeyId`, `profileId`, `fallback`, `from`, `to`) y paginación opaca `cursor`. `GET /api/request-history/:requestId` devuelve una fila canónica.
- `GET /api/request-history/:requestId/route-decision` - la explicación de por qué esta ruta: traza (candidatos, exclusiones, componentes de puntuación, perfil + revisión), secuencia de intentos de ejecución y resultado final.
- `GET /api/routing-analytics` - tasas de éxito/fracaso/cancelado/retroceso, duración p50/p95/p99 y TTFT, tasa de flujo incompleto, fallos de activación de tiempo de reutilización, costo por solicitud exitosa, cobertura, confianza y un indicador de truncamiento explícito.
- `GET /api/routing-profiles`, `POST /api/routing-profiles/dry-run` - inspección de perfil y evaluación de funcionamiento en seco (sin despacho previo).

El historial devuelto y las cargas útiles de decisión de ruta exponen solo metadatos de solicitud enmascarados (por ejemplo, etiquetas opacas `apiKeyId`). No incluyen credenciales, cuerpos rápidos en bruto o secretos de proveedores.

CLI: `ocx logs history`, `ocx logs get <request-id>`, `ocx logs explain <request-id>`, `ocx logs rebuild-index`, `ocx logs index-status`, `ocx route policy list | show | dry-run | evaluate`.

<a id="migration"></a>

## Migración

`routingProfiles` es opcional y aditivo: los archivos de configuración existentes se cargan sin cambios. Antiguo `usage.jsonl` filas sin `routeDecision` análisis sin cambios. El índice histórico es desechable - la supresión de `routing-history.sqlite` desencadena una reconstrucción automática a partir de `usage.jsonl` en la siguiente consulta; `ocx logs
rebuild-index` fuerzas uno. Una vez que `usage.jsonl` alcanza 1 MiB, una reconstrucción se ejecuta en un hilo de trabajo, por lo que el proxy sigue sirviendo solicitudes mientras se ejecuta. Hasta que termine, las consultas de historial lo esperan y los perfiles de enrutamiento tratan la salud histórica como evidencia desconocida (se aplica la política `unknownEvidence.health` del perfil). Nada en este sistema auto-sintoniza pesos, presupuestos o conjuntos de candidatos.
