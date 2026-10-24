---
title: "Dashboard web"
description: "Dashboard de opencodex para gestionar el proxy, proveedores, modelos, delegación, cuentas, uso y registros."
---

opencodex incluye un dashboard web local, una aplicación Vite/React en `gui/` servida por el proxy. Permite gestionar proveedores, cuentas de Codex/ChatGPT, el catálogo de modelos, sidecars, subagentes y tráfico de solicitudes.

<a id="opening-it"></a>

## Abrirlo

```bash
ocx gui
```

El comando abre `http://localhost:<port>` en el navegador, o `http://127.0.0.1:<management port>` si está habilitado el acceso de administración del hub. Si hace falta, inicia primero el proxy. Para desarrollar, puedes ejecutar el servidor de la GUI por separado contra un proxy activo; inicia cada comando en su propia terminal:

```bash
ocx start
bun run dev:gui
```

<a id="sign-in"></a>

## Iniciar sesión

Cuando el proxy escucha en la dirección local predeterminada de loopback (`localhost` / `127.0.0.1`), el dashboard no pide un token. El proxy incorpora sesiones de GUI de corta duración en la página servida y las renueva automáticamente cuando caducan o se reinicia. Solo un dashboard que escucha en un hostname fuera de loopback requiere el token de administración: `OPENCODEX_ADMIN_AUTH_TOKEN` o el archivo generado automáticamente `~/.opencodex/admin-api-token`.

Si el dashboard remoto necesita esa credencial, muestra un formulario de contraseña estándar para que el gestor de contraseñas del navegador pueda ofrecer guardarla y completarla. El dashboard conserva el token únicamente en memoria y nunca lo escribe en `localStorage` ni en `sessionStorage`. Guardarlo depende exclusivamente del navegador o del gestor de contraseñas.

<a id="finding-the-admin-token"></a>

### Encontrar el token de administración

Solo necesitas este token cuando el proxy escucha fuera de loopback. Un dashboard local no lo pide. Si uno local solicita autenticación, consulta [Cuando un panel local no puede iniciar una sesión](#when-a-local-dashboard-cannot-start-a-session).

El proxy genera el token la primera vez que se inicia. Por diseño, no lo imprime. Puedes leerlo desde su archivo:

```bash
cat ~/.opencodex/admin-api-token
```

Si `OPENCODEX_HOME` está establecido, la ruta es `$OPENCODEX_HOME/admin-api-token`. En Windows, la ubicación predeterminada es `%USERPROFILE%\.opencodex\admin-api-token`. Un token generado consta de `ocx_admin_` seguido de 43 caracteres. Si un archivo no tiene ese formato, el proxy lo rechaza en lugar de regenerarlo silenciosamente.

Para elegir el valor, establece `OPENCODEX_ADMIN_AUTH_TOKEN` antes de iniciar el proxy. La variable tiene prioridad: en ese caso no se lee ni se crea el archivo. Usa un valor diferente de la credencial de datos (`OPENCODEX_API_AUTH_TOKEN` o una clave API configurada); se rechaza la reutilización de una misma credencial en ambos planos.

Ningún comando de la CLI imprime el token. `ocx doctor` solo informa si hay una credencial, sin revelar su valor.

<a id="when-a-local-dashboard-cannot-start-a-session"></a>

### Cuando un panel local no puede iniciar una sesión

El dashboard en `localhost` obtiene su propia sesión y no debería pedir un token. Si no puede iniciar una sesión, la causa es la dirección utilizada: el proxy no reconoció la solicitud como loopback. Abre la dirección exacta que muestra el proxy al iniciar, normalmente `http://127.0.0.1:<port>`, y usa ese host y puerto en lugar de una IP de la red local o un alias.

<a id="dashboard-layout"></a>

## Diseño de panel

La barra lateral tiene ocho entradas: **Dashboard**, **Conectar**, **Codex**, **Proveedores**, **Modelos**, **Subagentes**, **Uso y registros** y **Enlace remoto**. **Conectar** muestra las pestañas **Codex**, **Claude**, **Claude Desktop**, **Grok Build** y las demás integraciones. Claude muestra directamente los ajustes de Claude Code, sin subpestañas; Claude Desktop tiene una pestaña independiente en `#claude/desktop`. Conectar no usa un selector de secciones. **Subagentes** agrupa Subagentes y Asesor (`#advisor`); **Uso y registros** agrupa Uso, Registros y depuración, y Almacenamiento; **Enlace remoto** agrupa Enlace remoto (`#remote`) y Espacio de trabajo remoto (`#remote-workspace`, si está disponible). Estos grupos usan un selector de secciones. **Codex** sustituye el nombre anterior **Codex Set**. Se conservan `#codex-set`, `#claude`, `#claude/code` y `#claude/desktop`; el marcador antiguo `#claude/settings` abre Code y `#claude/account` redirige a `#providers?provider=anthropic&tab=accounts`. Inicio (`#startup`) no aparece en la barra lateral.

La medición del tiempo hasta la primera salida de Responses incluye texto, razonamiento, argumentos de funciones transmitidos y entradas de herramientas personalizadas. Por tanto, un turno que solo llama a herramientas puede tener esa medición aunque no genere prosa. Los deltas vacíos y los avisos de inicio de herramienta no activan el temporizador. Se mide la primera salida observada por el proxy, no el comienzo del razonamiento oculto ni la velocidad exacta de generación del modelo.

La vista general usa tarjetas de estado y filas de ajustes de ancho completo. En pantallas amplias, las etiquetas comparten una columna y los controles de modelo y esfuerzo otra. En pantallas estrechas, los controles pasan debajo de sus etiquetas y conservan el orden de lectura. Las versiones largas se acortan visualmente; pasa el puntero por la etiqueta o el valor para leerlos completos.

<a id="quota-summary-bar"></a>

### Barra de resumen de cuotas

La parte superior de cada página, salvo Inicio, muestra en una línea el uso de cuota de los proveedores, por ejemplo `OpenAI 31% | Claude 54% | xAI 12% | Google 8%`. Lee los mismos informes de `GET /api/provider-quotas` que la página Proveedores, cada 60 segundos mientras la pestaña está visible, y nunca fuerza una actualización al proveedor.

- Cada indicador muestra una ventana preferida entre las informadas: primero la semanal, luego la mensual, la de cinco horas y, por último, una ventana con nombre propio del proveedor o sus créditos prepagados.
- El indicador se vuelve ámbar al 70 % de uso y rojo al 90 %.
- Pasa el puntero o enfoca el indicador con el teclado para ver todas las ventanas informadas, sus reinicios y la hora de lectura. El detalle sigue abierto al mover el puntero hacia él, incluso al cruzar la separación visual. En una pantalla táctil, el primer toque abre el detalle.
- Haz clic, o toca por segunda vez, para abrir la pestaña Cuentas de ese proveedor. El enlace **Abrir gestión de cuentas** del detalle abre la misma pestaña; se puede alcanzar con Tab y activar con Enter. Escape cierra el detalle y devuelve el foco al indicador si estaba dentro.
- La barra permanece en una línea. Si no caben los indicadores, desplázala horizontalmente o usa los botones « y » de los extremos.
- Se omiten los proveedores sin ventanas de cuota informadas. Si ninguno informa una, la barra se oculta.
- El extremo derecho muestra la hora de la última lectura del dashboard. Se vuelve ámbar si falló la lectura más reciente y se siguen mostrando los datos anteriores.

<a id="what-you-can-do"></a>

## Lo que puedes hacer

| Zona | Lo que hace |
| --- | --- |
| **Resumen del panel** | Modo multiagente, estado en línea, versión, tiempo de actividad, recuento de proveedores, total de 30 días de token, proveedores activos y modelos nativos/enrutados disponibles. |
| **Retención del razonamiento nativo** | Activa por separado el reenvío de razonamiento cifrado al cambiar de modelo nativo o de cuenta. Ambas opciones están desactivadas por defecto; la retención entre cuentas es experimental. Véase [el ámbito de configuración](/es/reference/configuration/server/#native-reasoning-retention). |
| **Delegación de subagentes** | Elija un modelo nativo o enrutado y un esfuerzo de razonamiento opcional compartido por la guía de delegación OpenCodex y el opt-in nativo predeterminado separado. Este no es un router proxy por spawn; ver más abajo. |
| **Sidecares** | Elija el modelo de búsqueda web y el esfuerzo más el modelo de descripción de la visión. Los cambios se aplican en la siguiente solicitud. |
| **Mantenimiento** | Vuelva a sincronizar el catálogo de modelos Codex, inspeccione las advertencias de omisión de configuración de proyecto-local, compruebe la versión más reciente o de vista previa y ejecute una actualización con reinicio proxy opcional. En el shell de escritorio, su entrada de actualización abre la página de actualización de la aplicación nativa en lugar de ejecutar el actualizador de paquetes. |
| **Seguridad de inicio** | Mostrar si el enrutamiento Codex inyectado sobrevive a un reinicio, con servicio separado y estado del lanzador más comandos de reparación exactos. |
| **Bandeja Windows** | Instale una bandeja de inicio de sesión por usuario para iniciar, detener, reiniciar, acceder al panel y el estado del proxy con un solo clic. La bandeja es un controlador, no un servicio de reinicio proxy. |
| **Codex autostart** | Permitir que se ejecute una shim de lanzador Codex ya instalada `ocx ensure`. Este conmutador no instala un servicio de shim o de fondo. |
| **Proveedores** | Agregar, editar, establecer el valor predeterminado (solo proveedores habilitados), habilitar/deshabilitar y eliminar proveedores; administrar grupos de cuentas OAuth y grupos de claves API donde sea compatible. La eliminación del valor predeterminado actual cambia al primer proveedor habilitado restante cuando existe; de lo contrario, se rechaza la eliminación y se mantiene el valor predeterminado actual. La configuración de proveedores puede deshabilitar la detección de modelos en vivo para puntos finales con falta, lento o sobredimensionado `/models` catálogos. Por Claude (Anthropic) OAuth Cada cuenta iniciada muestra sus propias barras de límite de velocidad de 5 horas y semanalmente (el uso es por credencial); una sonda fallida mantiene las últimas barras conocidas y las marca como no disponibles hasta la próxima actualización exitosa. **Actualizar todas las cuotas** control que obliga a un servidor a releer cada proveedor configurado; un proveedor cuya sonda ascendente falla mantiene su última fila correcta, por lo que la línea de estado informa que la verificación completada en lugar de reclamar cada valor es nueva, y la propia edad de cada fila mantiene la señal de frescura por proveedor. |
| **Añadir proveedor** | Una búsqueda por encima de las pestañas llega a los cuatro a la vez — Cuentas, Gratis, Local, Pagado. Mientras una consulta está en vivo, los resultados se agrupan por pestaña con un recuento de cada uno, y la pestaña seleccionada se mantiene en lugar de saltar. Presione ArrowDown en el cuadro de búsqueda para enfocar la primera acción de resultado disponible, omitiendo los botones desactivados; si no hay ninguna acción disponible, el enfoque permanece en el cuadro de búsqueda. Los tiempos de ejecución locales (Ollama, vLLM, LM Studio, LitelLM) tienen su propia pestaña, y una larga nota del proveedor se fija a dos líneas con el texto completo a un clic de distancia. Claude Code CLI (suscripción) se encuentra bajo Pagado con una suscripción CLI insignia, y al seleccionarlo advierte que se factura la suscripción iniciada a través de Claude `claude -p` y nunca usa una clave API (usar `anthropic-apikey` ej., para facturación de claves). |
| **Codex Autonomía** | Agregue cuentas de grupo ChatGPT/Codex, seleccione la cuenta de la siguiente sesión, actualice las cuotas de 5h / semanal / 30d, habilite o deshabilite el cambio automático de cuota, establezca su umbral 1–100% y configure la conmutación por error de transitorios. |
| **Subagentes** | Presenta hasta cinco modelos ruteados nativos o con espacio de nombres en el `spawn_agent` Anule la lista. |
| **Modelos** | Alternar GPT nativo y modelos enrutados, establecer listas de proveedores y límites de contexto, elegir v1/base/v2 y configurar el límite de hilos v2. La página distingue un catálogo guardado en el concentrador, un catálogo obtenido por este cliente y la activación en un cliente en ejecución. Una marca de tiempo fetch no prueba que incluya la última función de guardado del concentrador, y la activación en entorno de ejecución se muestra como no verificada. Los proveedores configurados permanecen visibles como grupos de modelo cero cuando la detección está desactivada o no devuelve filas. |
| **Registros** | Actualizar automáticamente las solicitudes recientes con tokens, el esfuerzo solicitado y (cuando esté disponible) el esfuerzo de salida efectivo, el modelo resuelto, el proveedor, el estado, la identificación de la solicitud, la duración y los detalles del error. La vista de detalle incluye el campo exacto del cable de razonamiento cuando el adaptador emite uno. Filtrar por ID de conversación/sesión opaca (cuando el cliente envía uno) a tokens total y costo de lista-precio estimado para el anillo de registros cargado actualmente. |
| **Uso / Depuración** | Inspeccione la cobertura y las tendencias de uso de token. La tabla Modelos de la página de Uso también divide cada modelo en tokens de entrada, tokens de salida, aciertos de caché, escrituras de caché y tasa de aciertos de caché; un guion significa que la telemetría de caché para esa métrica no está disponible. O habilite el transporte de proveedores y los diagnósticos de extracción de uso. |
| **Almacenamiento** | Desglose de disco CODEX_HOME de solo lectura (sesiones, archivos, bases de datos, archivos adjuntos). Limpieza archivada opcional: vista previa del N% más antiguo, luego cuarentena a `CODEX_HOME/.trash` (predeterminado) o eliminar permanentemente detrás de una casilla de verificación explícita. **Política de autolimpieza** es opt-in y **por defecto OFF** (`storageCleanupPolicy.enabled`); configurar umbral/objetivo/programa/modo en la página Almacenamiento, o activar **Corre ahora**. Las entradas en cuarentena se pueden restaurar desde la página Almacenamiento (JSONL + hilos). Las sesiones activas son de solo lectura. La limpieza y la restauración se rechazan mientras Codex tiene el nuevo/activo `state_*.sqlite` Cerrada. |
| **Detener** | Detenga con gracia el proxy y el servicio de fondo instalado, restaure Codex nativo y salga (`POST /api/stop`) En Windows con el programador de tareas backend, el panel de control se niega y le pide que ejecute `ocx stop` en su lugar: ese contenedor puede volver a reenviar el proxy después de que finalice la tarea, y solo una parada que se ejecute fuera de este proceso puede verificar la ventana de reinicio antes de restaurar la configuración del cliente. Nada cambia cuando se niega. También se niega para un proxy la aplicación de escritorio OpenCodex se ejecuta, que la aplicación comenzaría de nuevo: utilizar la bandeja de la aplicación **Detener proxy** o **Salir** Ahí. |

Si no se pueden incluir algunos registros de uso, la página Uso, Panel de control, espacio de trabajo del proveedor, proveedor Las vistas de catálogo y clave API muestran una advertencia incluso cuando no quedan registros legibles. Condes, fechas y Los rankings de uso solo reflejan registros legibles. **Modelos → La mayoría de las instantáneas usadas →** Rechazar para guardar una instantánea incompleta; elija otro orden o repare el historial antes de volver a intentarlo.

<a id="account-selection"></a>

### Selección de cuenta

La selección de cuenta se comparte con el enrutamiento de solicitudes. La selección de una cuenta OAuth tiene efecto en el next request incluso cuando un grupo está habilitado. Una selección saludable no es reemplazada simplemente porque otra cuenta genérica OAuth tiene más cuota no utilizada. Si la cuenta devuelve 429, failover aún puede seleccionar otra cuenta utilizable con el grupo apagado. Un compromiso automático La selección actualiza el panel de control inmediatamente; los cambios en la cuenta no esperan la actualización de la cuota temporizador. Las solicitudes que ya se envían en el flujo ascendente conservan sus credenciales originales.

<a id="filtering-request-logs"></a>

### Filtrar registros de solicitudes

Un rechazo de repetición de proxy mantiene HTTP 429 y código de error `upstream_reset_replay_refused`Pero... La causa de su solicitud y de su intento de fracaso es `transport-ambiguous`, con permiso de reenvío
`refused-ambiguous`: el flujo ascendente puede haber procesado ya el giro. Un auténtico proveedor Quedan 429 `rate-limit` con permiso de reenviar `permitted`.

Un movimiento Codex a otra cuenta después de que HTTP 402 aparece como **Cuota de cuenta agotada (402)**
en los detalles de recuperación del intento y cuenta como una recuperación de cuota en métricas exportadas.

Los filtros de registro combinan superficie, solicitudes interceptadas, proveedor, modelo exacto, estado, tiempo, velocidad y el ID de conversación sobre el anillo de solicitud cargado actualmente. Proveedor y modelo Las opciones también incluyen intentos de reserva; la coincidencia del modelo ignora el caso y los espacios circundantes pero no coincide con nombres parciales. Las opciones que desaparecen del ring se restablecen a Todos. El campo de conversación también acepta un pegado `codex://threads/<id>` El enlace profundo, la forma a Codex "copiar enlace de sesión" pone en el portapapeles — la envoltura y cualquier metadata de enlace tal como `?hostId=…` se ignoran y el id de hilo desnudo es coincidente, el mismo valor
`ocx logs filter --conversation` búsqueda desenvolver.

Las ventanas de tiempo cubren los últimos 15 minutos, horas o días y se actualizan cada 30 segundos mientras se La pestaña Registros está activa, incluso con actualización automática desactivada. Windows utiliza la marca de tiempo proxy de la respuesta de los registros y avance con el tiempo transcurrido del navegador, por lo que un reloj del navegador diferente No cambia el límite. Los proxies más antiguos sin esa marca de tiempo retienen el reloj del navegador hasta que una muestra válida esté disponible. La velocidad utiliza la salida tokens por segundo sobre el Duración total de la solicitud: por debajo de 15, 15 a menos de 50, o al menos 50. Los valores de velocidad no disponibles son Se excluye cuando un filtro de velocidad está activo. Éxito significa 2xx; errores significa 4xx o 5xx.

Registros de etiquetas cada estimación de decodificación **Ventana de generación** o **Después de la salida visible** en la lista e intenta la tabla, y utiliza **Velocidad de salida durante la generación (est.)** o
**Velocidad de salida después de la primera salida visible (est.)** en solicitar detalles. Respuestas antiguas en caché sin un método de sincronización mostrar **Tiempo desconocido** y **Tasa de salida (est.; método de temporización desconocido)**
en detalles. Una leyenda visible debajo de la tasa de detalle explica el método de sincronización; una rate no tiene título. Cuando el proxy observa ambos extremos, es salida tokens sobre la ventana de generación: desde el primer elemento o bloque de salida, razonamiento incluido, hasta el último delta de salida. Las filas más antiguas sin esa ventana usan el tiempo después de la primera vista. token hasta el final de la solicitud. Ambos son observaciones del lado proxy, no la sincronización interna token del proveedor, por lo que el valor es siempre una estimación, y una ventana de menos de un segundo no se muestra como no disponible. Ambos numeradores incluir la salida de razonamiento informada tokens, por lo que las dos bases de tiempo no son directamente comparables. Los registros históricos no se reescriben y las marcas de tiempo de generación que faltan no se inventan. El end-to-end La columna tok/s y el filtro de velocidad anteriores no se ven afectados.

Los filtros activos muestran el recuento correspondiente del total cargado. Restablecer filtros restaura todo filas y devuelve el foco del teclado al control de toda la superficie; “Sin solicitudes coincidentes” difiere de un anillo de registro vacío. Utilice las teclas de flecha o Home/End en el selector de superficie. Estos controles no consultan registros históricos más allá del anillo cargado.

El selector de idioma incluye **Portugués** (Portugués brasileño, `pt-BR`) Los idiomas del navegador portugués lo seleccionan automáticamente a menos que ya se guarde una preferencia de idioma compatible.

<a id="linking-to-a-section"></a>

### Vincular a una sección

Hay un solo diseño, por lo que no hay ningún interruptor de diseño para configurar. Las secciones del panel son direccionable en su lugar: `#dashboard` abre Vista general, y `#dashboard/providers` y
`#dashboard/models` Abre los otros dos. Recargar, marcar y Atrás todos mantienen la sección que estabas encendido. **Registros** Funciona de la misma manera con `#logs` y `#logs/debug`. Un viejo `#providers/workspace`
Marcador ahora aterriza en `#providers`.

Valores de costos en **Registros** y **Uso** son equivalentes de lista-precio de API calculados a partir de tokens notificado. Para un intervalo de uso personalizado, el servidor debe confirmar las horas de inicio y fin solicitadas. Si un proxy de ejecución anterior no admite esos límites, el panel de control y CLI rechazan su informe; Actualizar y reiniciar ese proxy antes de volver a intentarlo. Restablecer un precio de modelo manual afecta solo a modelo, conservando otras tasas ahorradas independientemente. Los **Uso** Las tablas de resumen y Modelos/Proveedores muestran el rendimiento de salida de extremo a extremo del historial de uso para el rango y los filtros seleccionados: salida sumada tokens dividida por segundos de reloj de pared sumados, no un promedio de tasas individuales. El recuento de muestras se mide por intentos (o solicitudes de filas heredadas sin intentos); se excluyen las muestras que carecen de salida finita positiva tokens o duración. Un guión significa que no hay muestra calificada o el servidor devolvió una tasa inutilizable. Esto incluye la espera de predecodificación y no es una velocidad de decodificación estimada.

Los **Uso** Las tablas de modelos y proveedores muestran la porción estimada para cada fila. Solicitudes sin un precio coincidente o uso utilizable se cuentan como excluidos junto a esa cantidad cuando el proxy Informes de precios campos de cobertura. El uso que se midió solo parcialmente (`unreported` o `unsupported`) no tiene precio, y una parte excluida excluye toda la solicitud del recuento de precios de esa fila. A que no alcanzó ningún nivel ascendente, o que se negó con un error HTTP antes de cualquier salida, gastado nada y no lo hace; una cancelación de cliente (499), o una etapa cuya respuesta comenzó o terminó sin un estado pero no informó uso, puede haber sido facturado, por lo que lo hace. Un rechazo seguido de una medida enviar correctamente contribuye a que envíe el costo al resumen, incluso cuando el estado de uso agregado es `unreported`. Una fila con solo solicitudes excluidas muestra un guion inicial con ese recuento en lugar de una estimación de cero dólares, y un valor de cero dólares mostrado es una estimación de precio confirmado. Un proxy más antiguo que informa que no hay campos de cobertura mantiene un guión desnudo sin contar, por lo que falta La cobertura permanece distinta de una fila totalmente excluida y de una estimación cero confirmada. Estos no son recibos de facturación o evidencia de un cargo real; uso de suscripción o créditos del proveedor puede aplicar en su lugar.

Las filas del modelo de proveedor pueden incluir **Uso del modelo solicitado no resuelto**: la ruta guardada envió el nombre solicitado sin cambios al proveedor predeterminado. Estos tokens pertenecen a ese proveedor de servicio, no necesariamente el proveedor nombrado en la solicitud. El panel conserva el nombre original y uso en lugar de adivinar qué modelo corrió. Para los nombres no resueltos que contienen barras, una El precio del modelo del proveedor por sí solo no es suficiente para estimar el costo; un proveedor exacto o un precio configurado Todavía se aplica. Las acciones del modelo se calculan dentro del proveedor seleccionado. Solicitudes para un desconocido reserva `policy/` nombre ahora falla antes de llegar a un proveedor de origen; se conserva el uso histórico.

El proveedor seleccionado **Descripción general** y **Uso** tabuladores muestran **Uso de la cuenta corriente** debajo de la Estadísticas de uso. **Cuentas** y **Claves API** muestre la cuota propia de cada credencial soportada, incluyendo saldos de crédito. La visión general de todo el proveedor todavía muestra la capacidad combinada cuando está disponible; no se sustituye por una lectura de cuenta corriente faltante. Búsqueda sin soporte, sin pasivo observación, carga, búsqueda fallida con valores conocidos por última vez y cero medido están separados estados. **Control de cuotas completado** significa la lectura settled—not que una observación pasiva se convirtió en nuevo o que todas las mediciones anteriores se actualizaron.

<a id="model-visibility"></a>

## Visibilidad del modelo

Los **Modelos** Los switches muestran la visibilidad final de Codex: un modelo enrutado solo está activado cuando su lista de proveedores lo incluye (o no está configurada) y no está desactivado. Activar un modelo reconcilia ambos filtros atómicamente; **Todos en** borra la lista de proveedores para que los modelos recién descubiertos también estén encendidos.

Los switches responden de inmediato para que pueda seguir cambiando modelos mientras se ejecutan los archivos guardados en segundo plano. haga clic en ordenar. La retroalimentación guardada aparece después de que la cola termina y la lista se reconcilia con la servidor. Falló guarda restaurar el estado del servidor cuando se puede leer y mostrar un error. Espere a que retroalimentación antes de salir de Modelos o cambiar de servidores: los cambios en cola no enviados se descartan a la salida.

<a id="managing-models-in-a-provider-workspace"></a>

### Administrar modelos en un espacio de trabajo de proveedor

En un proveedor **Modelos** token: **Eliminar** elimina la definición personalizada almacenada. Un subyacente El modelo nativo o el modelo descubierto en vivo pueden volver a aparecer, por lo que el recuento de modelos puede permanecer igual.
**Ocultar** solo cambia la visibilidad del catálogo: no elimina la definición ni cambia directamente política de enrutamiento. Uso **Gestionar la visibilidad en modelos** para abrir el **Modelos** página y restaurar visibilidad, incluso cuando la pestaña del proveedor no tiene filas.

**Añadir** guarda una definición personalizada; no borra una regla de selección de proveedores o ocultación existente. Por lo tanto, un modelo guardado puede permanecer oculto. Si el modelo ya se conoce, gestionar su visibilidad en **Modelos**. Todavía se guarda un guardado confirmado con una actualización de catálogo fallida: siga la actualización mensaje en lugar de añadirlo de nuevo. Si el cambio no se puede confirmar, actualice el estado del modelo antes de volver a intentarlo.

El recuento de modelos del proveedor es el número de entradas únicas no desactivadas en el modelo actual. inventario devuelto por el servidor, antes de buscar o mostrar truncamiento. No es el proveedor tamaño de lista de permisos, un recuento de descubrimiento en vivo o prueba de que se descubrió una entrada de origen. Selección Las insignias y la información de descubrimiento permanecen separadas de esa cuenta.

<a id="delegation-picker-vs-spawn-routing"></a>

## Selector de delegación vs enrutamiento de generación

El selector **Delegación de subagentes** guarda `injectionModel` y, opcionalmente, `injectionEffort`. **Guía multiagente de OpenCodex** controla de forma independiente las instrucciones de delegación que usan esos valores. En los turnos v2 elegibles, la guía indica al agente principal qué modelo y esfuerzo pasar a `spawn_agent`. Borrar el modelo también borra el esfuerzo guardado.

La opción **Usar como valores predeterminados de subagentes nativos de Codex** está desactivada de forma predeterminada. Si OpenCodex administra el enrutamiento activo, aplica la misma selección a los valores nativos de `[agents]` en la siguiente sincronización o reinicio. Respeta la configuración de proveedores externos del usuario. Solo afecta a tareas de Codex creadas después y no provoca delegación por sí misma. Los valores de `[agents]` definidos por el usuario se conservan, por lo que pueden seguir teniendo prioridad sobre los solicitados.

:::caution
Ninguno de los controles es un router de generación de modelos cruzados del lado proxy. La guía OpenCodex le pide a Codex que pase Anulaciones para `spawn_agent`; nativo `[agents]` los valores predeterminados se aplican solo cuando Codex crea una nueva tarea después de han sido sincronizados. Véase
[Interfaz de subagentes](/es/guides/sub-agent-surface/) para el comportamiento canónico v1/base/v2.
:::

<a id="remote-hub-sessions-keys-and-usage"></a>

## Sesiones, claves y uso de Remote Hub

En **Conectar → Claves API**, cada fila tiene un botón para eliminar su clave tras pedir confirmación. Al pulsar una clave, una sesión autorizada de forma independiente puede mostrar su valor completo y un botón **Copiar**.

<a id="reading-an-existing-api-key"></a>

### Lectura de una clave API existente

Para mostrar el valor completo de una clave guardada, se necesita una sesión del dashboard autorizada mediante emparejamiento explícito o una identidad de Tailscale de confianza. Una sesión local automática puede mostrar la lista enmascarada, pero no revelar valores existentes; un token de administración sin esa sesión tampoco sirve. Usa el [flujo de emparejamiento](/es/guides/remote-hub/#pairing-this-browser-with-a-hub) antes de solicitar el valor. Si se rechaza, la página explica el requisito. El formulario local solo se ofrece en un dashboard independiente del mismo origen, abierto por HTTP en la dirección literal `127.0.0.1` o `[::1]`, y el origen debe coincidir con la dirección literal de loopback configurada en el servidor. Si abriste `http://localhost:<port>` u otro alias, comprueba esa configuración y abre `http://127.0.0.1:<port>` para un servidor enlazado a `127.0.0.1`, o `http://[::1]:<port>` para uno enlazado a `::1`. Un servidor configurado con hostname `localhost` no tiene un origen local elegible para este formulario. El dashboard no puede deducir la dirección configurada a partir de un alias; por eso muestra una denegación genérica sin proponer otra URL. En ese caso usa el emparejamiento de Remote Hub o Tailscale de confianza, si está disponible. Vuelve a emparejar si la sesión caduca o se revoca. El inicio de sesión normal y la creación, rotación y eliminación de claves no cambian.

Después del emparejamiento, vuelve a pulsar la clave para solicitar su valor; emparejar por sí solo no revela ninguna clave. Los valores visibles y los avisos de copia se borran al quitar o sustituir la sesión compartida, iniciar un emparejamiento, salir de esta página, ocultar la pestaña o ventana de Desktop, o cambiar de servidor. Esto también afecta a los valores recién creados o de reemplazo: copia el valor de una sola visualización antes de salir. Si una creación o rotación termina después de cambiar de sesión o vista, su valor permanece oculto. Al regresar al servidor original, se vuelve a validar la lista de claves. Las rotaciones pendientes siguen disponibles para confirmarlas o cancelarlas expresamente.

La administración desde el dashboard está separada del tráfico de modelos directo entre cliente y hub. **Conectar → Claves API** muestra las rotaciones pendientes, revela el secreto de reemplazo una sola vez y requiere confirmación o cancelación explícita. Cerrar sesión en el navegador invalida únicamente la sesión remota actual. Con conexión se consulta el uso guardado en el hub filtrado por el `apiKeyId` del cliente; sin conexión se muestra el uso local, sin duplicarlo.

La garantía de anulación del modelo solo se aplica a la guía v2 **incorporada**. Un `injectionPrompt` personalizado la reemplaza por completo y debe incluir `{{model}}` y `{{effort}}`, y opcionalmente `{{roster}}`, para que esos valores aparezcan en la guía.

El selector ofrece modelos nativos y enrutados habilitados, además de la escalera de esfuerzo global Codex. El API valida el esfuerzo seleccionado globalmente; Codex todavía valida un esfuerzo de generación contra el objetivo Entrada de catálogo.

<a id="codex-auth-and-account-pools"></a>

## Autenticación de Codex y grupos de cuentas

La página **Codex Auth** administra la ruta nativa de ChatGPT/Codex:

El modo Pool selecciona en las cuentas Codex principales y agregadas; Direct utiliza solo el inicio de sesión de la persona que llama/principal. Las solicitudes en vuelo mantienen sus credenciales capturadas y una reautenticación 401/403 o un tiempo de reutilización 429 puede borrar la afinidad y rotar a otra cuenta Pool elegible. Esto es separado de `openai-apikey`
y otros proveedores.

:::caution[Responsabilidad sobre las políticas del proveedor]
El grupo de cuentas es una función técnica de administración de cuentas, enrutamiento y resiliencia. Esto no afirma que tener varias cuentas esté prohibido: el cumplimiento depende de la configuración de cada cuenta y del patrón de uso. OpenCodex no respalda el uso de cuentas adicionales para eludir límites de solicitudes, cuotas, límites del plan u otras restricciones del proveedor, ni compartir credenciales entre personas. Usted es responsable de cumplir los términos vigentes del proveedor para cada cuenta y forma de uso. Las restricciones, suspensiones o cancelaciones de cuentas quedan fuera del control de OpenCodex. Los mantenedores no ofrecen asesoramiento sobre políticas ni pueden resolver las medidas que aplique el proveedor. Consulte los
[Términos de uso de OpenAI](https://openai.com/policies/terms-of-use/).
:::

- La elección manual se aplica en la siguiente solicitud, incluso de un hilo ya vinculado; las solicitudes en curso conservan las credenciales que capturaron. Además, la cuenta queda fijada con una insignia **FIJADA**: ninguna prioridad superior la sustituye hasta que se agote, elijas otra o cambies el orden de selección de alguna cuenta. Pulsar de nuevo la insignia pide confirmar que se libere esa fijación. Al confirmar, los hilos vinculados conservan su cuenta y las solicitudes nuevas o no vinculadas vuelven al orden y los umbrales. Una confirmación antigua no puede liberar una fijación más reciente. Si la operación se rechaza o su resultado es incierto, revisa la vista actualizada antes de volver a confirmar.
- Cada cuenta tiene un control **Orden de selección**: primero, antes, normal, después y último. Solo se recurre a un orden inferior cuando todas las cuentas superiores están agotadas o no disponibles. El cambio afecta a la siguiente solicitud no vinculada, sin mover hilos que ya tengan cuenta. La cuenta principal de Codex participa en el mismo orden y puede reservarse como **Última**. Una prioridad personalizada de `ocx account priority` sigue siendo visible y seleccionable aunque no coincida con esos cinco valores.
- La afinidad evita cambiar de cuenta en cada solicitud. Con `pool.cacheAffinity` activado por defecto, un hilo mantiene su cuenta aunque cruce el umbral de uso, hasta que se agote o no pueda atenderlo. Solo se mueve a otra con margen de cuota real y uso estrictamente menor. `false` permite volver a evaluar el cambio al cruzar el umbral, pero mantiene esos requisitos del destino.
- Las sesiones nuevas pueden elegir la cuenta elegible de menor uso. Los planes pagados puntúan las 5h más calientes conocidas, semanal, o 30d ventana; Los planes Go/Free solo usan la ventana 30d.
- Si WHAM proporciona `limit_window_seconds`, Codex Auth clasifica como 30d una ventana principal de al menos 28 días, en lugar de suponer que es semanal. Si la respuesta no indica la duración, conserva la interpretación semanal anterior.
- **Actualizar las cuotas** vuelve a leer el uso de la cuenta inmediatamente, por lo que el enrutamiento y las tarjetas de cuenta usan lo mismo valores.
- Los registros de solicitudes Pool usan etiquetas opacas, como `p3fa91c`, nunca correos electrónicos de cuenta.
- Cada cuenta también muestra su etiqueta de registro estable, el total de tokens observado en 30 días, una estimación de coste equivalente de API y la proporción de intentos con uso medido. Los precios personalizados de `modelCosts` tienen prioridad sobre el catálogo verificado y los precios de respaldo; el uso histórico se vuelve a valorar con los precios activos al consultarlo. Es una estimación para conciliación, no una factura de ChatGPT Plus o Pro. Los registros históricos de `openai` anteriores a la atribución explícita siguen siendo ambiguos y no se asignan a la cuenta principal actual.
- **Apuntar a una cuenta específica de Codex desde el selector de modelos** Es una opción explícita. Cuando está habilitado, Las filas del selector GPT ordinarias se reemplazan por una entrada por selector de cuenta pública. La elección de uno bloquea esa conversación a la cuenta asignada: no rota, retrocede o cambiar la cuenta Pool activa. El inicio de sesión de la aplicación Codex incorporado tiene su propio selector; mapas generados normalmente utilizan `main`con un sufijo de colisión segura como `main-2` cuando sea necesario. Cuentas añadidas reciba etiquetas estables y seguras para la privacidad, y se conservan las etiquetas selectoras personalizadas existentes. Las conversaciones existentes y las selecciones de modelo guardadas continúan el enrutamiento. Desactivar la configuración Oculta las entradas generadas del selector sin eliminar cuentas, selectores ni rutas exactas. Llanura GPT Los ID de modelo continúan usando el comportamiento configurado Pool o Direct.
- Los cambios de agregar, quitar y seleccionar cuentas se guardan antes de actualizar el catálogo de modelos. Si esa actualización limitada no puede terminar, el panel de control muestra un aviso ámbar de éxito con recuperación; ejecutar `ocx sync` para reintentar. El cambio de cuenta o configuración en sí permanece guardado.

La descripción general de los proveedores resume por separado el uso del modo Pool como una capacidad ponderada solo para pantalla estimación, junto con la cuota bruta de la cuenta efectiva y la próxima recuperación de capacidad. Véase
[Capacidad del grupo](/es/guides/providers/#providers-overview-pool-capacity) por el campos visibles, significado de cobertura incompleta y límite de enrutamiento.

<a id="starring-is-yours-to-decide-not-an-agents"></a>

## Tú decides si dar una estrella

El botón de la barra lateral y la pregunta que `ocx start` muestra en una terminal interactiva usan **tu propia sesión de `gh`**. opencodex no guarda un token de GitHub para esta acción; solo registra tu respuesta.

Como esta acción modifica tu cuenta de GitHub, se rechazan las llamadas dirigidas por agentes en lugar de permitir que respondan por ti:

- `ocx start` y `ocx service install` omiten la pregunta interactiva cuando detectan un agente o entorno automático (`CLAUDECODE`, `CODEX_THREAD_ID`, `CURSOR_TRACE_ID`, `CI`, entre otros). El agente debe trasladar la pregunta una sola vez con una opción clara Sí/No. El silencio queda pendiente: no se registra como Sí ni como No y el agente no debe repetirla en respuestas o sesiones posteriores. Una versión posterior puede volver a activar el aviso de la CLI según los plazos de `AGENTS_INSTALL.md`.
- `POST /api/github/star` devuelve `403` con `code: "agent_consent_required"` cuando el proxy detecta una sesión de agente y la solicitud no acredita una sesión del navegador del panel. Tener el token de administración no constituye consentimiento: un agente local puede leer ese archivo.
- El botón del panel sigue disponible. Un clic real aporta la evidencia de sesión del mismo origen, incluso si el agente inició el proxy.
- Una respuesta negativa termina el asunto; no se insiste ni se añaden indicaciones a los mensajes del modelo para retomarlo después.

<a id="how-the-dashboard-talks-to-the-proxy"></a>

## Cómo el panel de control habla con el proxy

La GUI es un cliente ligero de la API JSON de administración del proxy. Algunos endpoints útiles son:

| Punto de conexión | Finalidad |
| --- | --- |
| `GET` / `PUT /api/settings` | Lee los configuración o actualiza el inicio automático Codex, los configuración de flujo/memoria y la visibilidad del selector de segmentación de cuentas. |
| `GET` / `POST /api/github/star` | Lea el `gh`-derivada del estado de estrella, o la estrella del repositorio. El POST es rechazado con `403` `agent_consent_required` para llamadas dirigidas por agentes sin una sesión de panel. |
| `GET /api/startup-health` | Lea los diagnósticos de enrutamiento, servicio, shim y seguridad de reinicio sin secretos. |
| `POST /api/startup-action` | Instale el servicio en segundo plano o la shim de lanzador Codex a través de acciones fijas y permitidas. |
| `GET` / `POST /api/windows-tray` | Lea o cambie la instalación de la bandeja Windows y el estado del proceso visible. POST acepta `install`, `start`, `stop`, o `uninstall`. |
| `POST /api/sync` | Reconstruye el catálogo compartido y marca la caché de modelos de Codex como obsoleta. |
| `GET /api/update/check` · `POST /api/update/run` · `GET /api/update/status` | Revisar, ejecutar y supervisar los trabajos de autoactualización. Los PID de los trabajadores persisten para que un trabajo bloqueado se recupere automáticamente; los trabajos heredados sin PID se recuperan después de diez minutos. |
| `GET` / `PUT /api/sidecar-settings` | Leer o establecer la configuración del modelo de búsqueda/visión sidecar. |
| `GET` / `PUT /api/injection-model` | Leer o establecer la selección compartida de modelo/esfuerzo de subagente y los conmutadores de orientación/nativo-predeterminado independientes. |
| `GET` / `PUT /api/v2` | Lea o establezca el modo de superficie, el indicador de características Codex y el límite de hilos v2. |
| `GET /api/providers` · `POST /api/providers` · `PATCH /api/providers?name=...` · `DELETE /api/providers?name=...` | Listar, agregar/reemplazar, habilitar/deshabilitar, establecer el valor predeterminado o eliminar proveedores. `PATCH` utiliza independiente `{ "setDefault": true }` en un proveedor habilitado; `POST` puede incluir `setDefault` al crear/reemplazar (también solo habilitado). Eliminación de la actual por defecto reasigna al primer proveedor habilitado restante cuando existe uno; de lo contrario, el API devuelve `409` con `code: "last_provider"` y mantiene el valor predeterminado actual. |
| `GET /api/models` · `PUT /api/disabled-models` | Enumera filas de modelos nativos/enrutados y actualiza el conjunto de modelos deshabilitados compartidos. |
| `GET /api/selected-models` · `PUT /api/model-visibility` | Lea las listas de proveedores y cambie atómicamente la visibilidad final de un modelo o grupo de proveedores. |
| `GET /api/key-providers` · `GET /api/oauth/providers` | Lea los catálogos de proveedores API y OAuth. |
| `GET /api/oauth/accounts?provider=...&quota=1` · `GET /api/providers/keys?name=...&quota=1` | Lea cada cuenta o cuota de clave donde sea compatible, sin cambiar la credencial activa. Añadir `refresh=1` para omitir la caché de cuota establecida; se puede compartir una lectura de la misma credencial en vuelo. Omita `quota=1` para una lista local barata con cada fila de `quotaMode`: `probe`, `passive`, o `unsupported`. Las lecturas pasivas devuelven las observaciones existentes sin una sonda de red. Ninguna lectura es lo mismo que el 0% utilizado, y las cuotas para múltiples claves no se suman. |
| `POST /api/oauth/login` · `GET /api/oauth/status` | Inicie un flujo de proveedores OAuth y realice una encuesta para su finalización. |
| `GET /api/codex-auth/accounts?refresh=1` | Listar cuentas principales y de grupo, forzar la actualización de cuotas e informar la cuenta principal `hasCredential` / terminal `needsReauth` Estado. |
| `PUT /api/codex-auth/active` · `PUT /api/codex-auth/auto-switch` · `PUT /api/codex-auth/failover` | Seleccione la cuenta para la siguiente solicitud y configure el enrutamiento del grupo. |
| `GET /api/codex-auth/active` · `PUT /api/codex-auth/accounts/priority` | Lea la cuenta efectiva (incluyendo `pinned` ¿Cuál es la cuenta `pinnedAccountId`y establecer el orden de selección de una cuenta. |
| `POST /api/codex-auth/login` · `GET /api/codex-auth/login-status` | Agregar una cuenta de grupo a través del inicio de sesión del navegador. |
| `GET /api/logs?tail=50&limit=20&offset=0&provider=...&status=5xx` | Lea los metadatos de las solicitudes recientes con filtros opcionales de cola, proveedor y estado exacto/clase. Con `limit`/`offset`, paging camina hacia atrás desde la fila más reciente (`offset=0` devuelve la última página). Forma de respuesta: `{ timeZone, generatedAt, total, logs }` donde `total` es el recuento de filas filtradas antes de la paginación. |
| `GET` / `PUT /api/subagent-models` | Leer o establecer los cinco destacados `spawn_agent` Anule los modelos. |
| `POST /api/stop` | Detenga el proxy/servicio, restaure el Codex nativo y salga. Rechazado con `respawnable_service` en el Backend del Programador de Tareas Windows, con `self_unload_service` cuando este proxy es en sí mismo el trabajo instalado de lanzamiento / sistema, y con `service_state_unknown` cuando no se puede leer el estado del Programador de tareas; nada cambia en ninguno de esos casos. Una sesión de dashboard también es rechazada, con `desktop_supervised`Mientras que la aplicación de escritorio OpenCodex ejecuta el proxy. |

:::tip
Adición **Ollama Nube** u otro proveedor de catálogo desde el panel copia su texto contra visión En el caso de que la configuración del proveedor sea guardada, [visión sidecar](/es/guides/sidecars/)
se cierra correctamente sin clasificación manual.
:::

<a id="pairing-this-browser-with-a-hub"></a>

### Emparejar este navegador con un hub

La inscripción de la máquina y la autenticación del navegador son independientes. El panel de emparejamiento nombra el concentrador y muestra un `ocx gui pair --origin` comando para el origen exacto actualmente abierto en su navegador. Ejecute ese comando en el concentrador o envíelo al operador del concentrador y solicite un código de emparejamiento único. Pegue ese código en el panel; una clave API de datos o admin token no es un código de emparejamiento.

Mientras la autenticación del navegador está pendiente, el panel de control no recomienda reiniciar un cliente conectado saludable. Completar el emparejamiento actualiza los datos del panel de control inmediatamente, incluido un error de autenticación previamente almacenado en caché. La expiración de la sesión vuelve al emparejamiento; la denegación de permiso mantiene su propia guía de configuración de acceso. Otras actualizaciones fallidas pueden mostrar los últimos datos recibidos con un aviso de datos obsoletos y una acción de reintento.

<a id="usage-chart-keyboard-and-touch-controls"></a>

### Teclado de la tabla de uso y controles táctiles

Los días del mapa de calor de uso tienen un punto de entrada de pestaña. Usa Arriba/Abajo para días adyacentes e Izquierda/Derecha para semanas adyacentes. Las barras semanales exponen los detalles del mismo día en el enfoque del teclado, el puntero o el tacto. Las etiquetas de día incluyen la fecha, el recuento de solicitudes y el recuento de token; las superposiciones de información sobre herramientas permanecen dentro de la ventana.

### Claude

**Claude** es una pestaña dentro **Conectar**, cuya tira de pestañas coloca Codex, Claude, Claude Desktop y Grok Build en ese orden. Claude no tiene subpestañas: muestra la configuración de Claude Code directamente. La página comienza con **Claude Code CLI de primera mano**, seguido de **Empezar**, **General**
(compatibilidad, instrucciones del agente y controles de contexto), **Modelo de ayudante de fondo**,
**Interceptación modelo**, **Modelos disponibles**, y finalmente **Conexión Claude**. Una pegajosa barra de Guardar muestra **Sin cambios** o **Cambios no guardados**, con **Reversión** para descartar ediciones y **Guardar** Comprometer A ellos. Ambos interruptores se aplican inmediatamente; **Guardar** Nunca los cambia. Cuando se detiene la interceptación, la página muestra por qué y ofrece **Iniciar interceptación**, que lo inicia en su lugar sin reiniciar OpenCodex. Las subpestañas de Código, Configuración y Cuenta anteriores han desaparecido; todo lo que mostraba la vista Configuración de solo lectura, excepto el número de puerto de intercepción, está en esta página.

**Escritorio Claude** es su propia pestaña Conectar en `#claude/desktop`. Contiene el selector de modo de escritorio y familias de modelos. Una fila de estado muestra si Claude Desktop ejecuta el perfil y si está guardado, con **Guardar** y **Guardar y aplicar** Al lado.

Las cuentas Claude/Anthropic se administran solo en **Proveedores > Anthropic > Cuentas**: inicio de sesión y la opción del navegador, la lista de cuentas con interruptor, pausa, eliminar y volver a autenticar, el campo de código de pegado, la configuración del grupo de cuentas y la cuota. Claude ya no tiene una subpestaña Cuenta. Controles a nivel de proveedor, como el proveedor predeterminado, la eliminación y la opción habilitada permanecer en proveedores.

Los marcadores `#claude` y `#claude/code` abrir esta página, y la anterior `#claude/settings` redirecciona a `#claude/code`; `#claude/desktop` selecciona la token Escritorio Claude separada. El viejo `#claude/account` Marcador redirige a `#providers?provider=anthropic&tab=accounts`. Legado `#integrations/claude` y `#integrations/claude/desktop` Los marcadores todavía redirigen a `#claude/code` y `#claude/desktop`, respectivamente. Las teclas de flecha se mueven entre pestañas; Home y End seleccione la primera y última pestaña.


<a id="test-one-provider-model"></a>

## Pruebe un modelo de proveedor

En **Proveedores**, **Conexión de prueba** comprueba la conectividad de descubrimiento. Utilice el separado **Terminación de la prueba** control para comprobar si un modelo seleccionado responde. Elija un modelo y acepte la confirmación de que la solicitud puede incurrir proveedor cargos. Cancelar la confirmación no envía nada. Cambiar el proveedor o modelo, o abandonando la página, cancela la prueba y descarta un resultado obsoleto.

La prueba de finalización envía `Reply exactly OK.` una vez con una tapa de salida 32-token, una fecha límite de 20 segundos y un límite de 64 KiB. Se reporta TTFT en el primer delta de texto no vacío, latencia total, el modelo informado en sentido ascendente y una coincidencia, Desajuste o comparación desconocida con el id del modelo de cable. Falta o conflicto Los metadatos ascendentes no verifican la identidad del modelo. El panel muestra la razón de aplicabilidad cuando se configura la autenticación, el adaptador o el transporte no puede ser probado. No se muestra ningún texto generado, y el diagnóstico no actualizar el estado de enrutamiento, el historial de solicitudes o el catálogo de proveedores.

El endpoint de administración autenticado es
`POST /api/providers/test-completion?name=<provider>` con exactamente
`{"model":"<model>","confirm":true}`. Las sesiones del dashboard requieren su token CSRF habitual. La entrada inválida devuelve 400, un proveedor desconocido devuelve 404 y otra prueba concurrente para el mismo proveedor devuelve 409. Diagnóstico y aplicabilidad completos resultados devuelven 200, incluyendo un error estructurado cuando falla la inferencia. Destino Se aplican las configuración de política y salida del proveedor; los redireccionamientos, reintentos y conmutación por error están deshabilitados. Para el flujo de trabajo CLI, consulte [Proveedores y cuentas](/es/reference/cli/providers-accounts/).
