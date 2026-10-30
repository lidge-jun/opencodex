---
title: "Referencia de CLI"
description: "Despacho de comandos, códigos de salida y enlaces a cada familia de comandos ocx."
---

La CLI de opencodex es `ocx`. El primer nombre determina qué comando se ejecuta. Los alias documentados `setup`/`init`, `restore`/`eject` y `models`/`model` realizan la misma operación. Los comandos desconocidos y las sintaxis no válidas producen errores.

Ejecute `ocx`, `ocx help`, `ocx --help` o `ocx -h` para obtener el mismo índice de comandos compacto, agrupados en Inicio aquí, Tareas comunes, Explorar y Más ayuda. Utilice `ocx help --all` o `ocx --help --all` para la referencia completa de nivel superior, incluidas las variantes de comandos detalladas omitidas del índice compacto. Ejecutar `ocx help <command>`, `ocx <command> --help` o `ocx <command> -h` para un comando registrado en la tabla de ayuda; `ocx <command> help` también sigue siendo apoyado. Los comandos de ayuda y versión son de solo lectura: no inician, detienen, instalan, desinstalan o reescriben el estado Codex o opencodex.

<a id="nested-help"></a>

## Ayuda anidada

La ayuda de una familia, como `ocx help models`, conserva su sintaxis y detalles y enumera los subcomandos declarados con sus resúmenes. Estas listas describen los subcomandos registrados; no garantizan que incluyan todas las variantes disponibles en ejecución. La ayuda de Alias conserva el propio uso y detalles del alias y apunta a su familia canónica: `ocx help model` conduce a `ocx help models`. Los modelos también ayudan a vincular el tema curado `models context` por separado de las capacidades declaradas.

Ayuda acepta una ruta con más de una palabra de comando:

```bash
ocx help models context
ocx models context --help
ocx model context --help
ocx help account list
ocx help account main
```

Las tres primeras formas muestran el mismo tema de contexto-cap, incluyendo el alias `model`:

```text
ocx models context <status|value <tokens> [--set-all]|provider <name> on [--value <tokens>]|provider <name> off|all <on|off>> [--json]
```

`ocx models context status --json` lee la configuración actual. `value <tokens>` establece el valor predeterminado para los cambios futuros; agregar `--set-all` lo aplica a todos los proveedores enrutados. `provider <name> on` permite una tapa de proveedor, opcionalmente con `--value <tokens>`; `off` lo deshabilita. `all on|off` cambia todos los proveedores enrutados juntos.

Temas de capacidad declarados tales como `account list` mostrar su resumen, banderas conocidas y detalles, con un puntero a la ayuda de los padres. Estos metadatos no cubren todos los operandos o tiempos de ejecución. subcomando, por lo que un tema puede mostrar `Command: ocx ...` Sin pretender una completa `Usage:` Gramática. Un prefijo como `account main` enumera a sus hijos declarados y marca esa cobertura como incompleta. Un tema explícito no declarado (`ocx help <path>`) sale 1 con una ayuda detallada concisa no disponible mensaje y un puntero padre conocido o de referencia completa en el error estándar. Salida estándar vacío, y no se imprime ningún banner de ayuda completo. Falta detalle no establece si el comando runtime es válido. Anexado `--help`/`-h` preserva el comportamiento de ayuda de comandos existente: cuando los metadatos detallados no están disponibles, Muestra la ayuda de padre conocida con éxito, sin ejecutar el comando.

En el cabezal Bun CLI, desnudo `help` se reconoce solo en la raíz o inmediatamente después de la raíz comando. Uso `--help` o `-h` para caminos anidados. Valores posteriores como el `help` en
`ocx alias set demo help` Siguen siendo argumentos de comando. Un exacto `--` termina la ayuda de la cabeza que explora, así que `ocx claude -- --help` conserva los argumentos para el despacho de comandos.

<a id="recovering-from-command-typos"></a>

## Recuperación de errores tipográficos de comando

Comandos raíz desconocidos y rutas de ayuda explícitas no resueltas salen de 1 con una breve guía de diagnóstico y navegación sobre el error estándar, dejando la salida estándar vacía. Los errores tipográficos cercanos pueden recibir sugerencias conservadoras extraídas de los nombres de comandos visibles y de los hijos documentados de la familia de ayuda actual. Las sugerencias son solo de orientación: el CLI nunca las ejecuta ni vuelve a intentar el comando.

| Entrada | Orientación |
| --- | --- |
| `ocx modles` o `ocx help modles` | Sugiere `ocx help models`. |
| `ocx help account lisst` | Sugiere `ocx help account list` dentro de la familia de cuentas. |
| `ocx help qzxv` | Ofrece `ocx help --all` sin adivinar un comando. |
| `ocx help models qzxv` | Indica que la ayuda detallada no está disponible y remite a la familia de comandos de modelos conocida. |

El Bun CLI rechaza una raíz desconocida antes de la auto-restauración de la shim u otro comando previo al vuelo. Los comandos reconocidos conservan su prevuelo existente; los comandos ocultos y el corredor interno siguen siendo objetivos de despacho válidos, pero están excluidos del descubrimiento y las sugerencias. La opción alternativa de ayuda con bandera añadida, la capacidad JSON y el manejo de errores específicos del proveedor conservan su comportamiento existente.

<a id="command-families"></a>

## Familias de mando

### `ocx message`

`ocx message sessions [--json]` descubre Codex sesiones locales cargadas. `ocx message send (--thread <uuid> | --name <exact-name>) --stdin [--json]` envía un mensaje de igual correlacionado, sin iniciar un demonio o reanudar un hilo. Sin `--host`, estas operaciones son locales. Consulta [Mensajería de Codex](/es/reference/cli/messaging/) para el contexto del remitente, los tipos, el entorno de ejecución probado y los recibos `not_sent` / `queued` / `unknown`. El [transporte remoto mediante SSH](/es/reference/cli/messaging/#explicit-remote-peers) requiere un host registrado y la opción `--host`; no inicia automáticamente el receptor ni reenvía mensajes de forma automática.

### `ocx provider`

`ocx provider`, `ocx help provider`, `ocx provider help`, `ocx provider --help` y `ocx provider -h` muestran la misma ayuda del proveedor, con sintaxis de comandos, ejemplos, orientación preestablecida / personalizada y punteros de temas declarados. La ayuda se imprime correctamente en la salida estándar y sale en 0. Bare `ocx provider` todavía sigue el prevuelo de comando ordinario; las formas explícitas de ayuda para la cabeza salen antes de ese prevuelo. Una acción de proveedor desconocido imprime su diagnóstico y ayuda del proveedor al error estándar, deja la salida estándar vacía y sale 1.

### `ocx alias`

`ocx alias list [--json]` muestra alias de usuario efectivos e integrados. Utilice `ocx alias set <provider>[/<native-model-id>] <alias>` y `ocx alias rm <provider>[/<native-model-id>]` para editarlos. Los identificadores de modelo nativos pueden contener barras adicionales porque el selector se divide solo en la primera barra. Habilite los valores predeterminados enviados con `ocx alias defaults on|off [--provider <name>]`.

### `ocx remote-workspace`

`ocx remote-workspace pair <hub-url> --pairing-code-stdin --root <absolute-path>` inscribe el equipo local como un Ejecutor solo OCX. Repita `--root` para aprobar más carpetas y utilizar `--name` para anular el nombre de host. Repita `--toolchain-root <absolute-directory>` para exponer un directorio de Node, Rust, Go u otra cadena de herramientas instalado por el usuario de solo lectura dentro del entorno de pruebas del comando. En las compilaciones internas de prueba para macOS y Windows, `bun run build:remote-workspace-helper` compila el helper de Rust que el comando de emparejamiento descubre automáticamente; `--executor-helper <absolute-file>` selecciona otra compilación revisada explícitamente y fija su resumen en el estado de Ejecutor local. `ocx remote-workspace agent` mantiene la conexión cifrada saliente; `ocx remote-workspace status [--json]` informa sobre el Hub, el dispositivo, las raíces y las capacidades anunciadas sin imprimir su portador o clave privada. Véase [Espacio de trabajo remoto](/es/guides/remote-workspace/).

Familias de comandos adicionales:

| Familia | Sintaxis y referencia |
| --- | --- |
| `ocx chatgpt` | `ocx chatgpt <launch\|restore\|status>` - macOS aplicación-servidor de calza experimental, desactivado de forma predeterminada. Véase [ChatGPT Escritorio](/es/guides/chatgpt-desktop/). |
| `ocx hub` | `ocx hub invite [--json] [--data-url <origin>] [--management-url <origin>] [--clients codex,claude]`: crea un código de emparejamiento secreto de un solo uso en un concentrador en ejecución. Consulte [Hub remoto](/es/guides/remote-hub/); invite requiere autorización explícita y su código no debe ingresar una transcripción del agente. |
| `ocx inspect` | `ocx inspect <subcommand>` - lea la configuración efectiva, el catálogo, el análisis de enrutamiento, el ritmo, el inventario del proveedor de claves, el indicador Codex, la configuración del cliente, el estado de estrella o el estado de la bandeja Windows. Ejecutar `ocx help inspect` para los enlaces del tema. |
| `ocx mcode` | `ocx mcode [mcode args...]` - inicie el código MiniMax después de que su integración de archivos administrados esté habilitada. Véase [MiniMax clientes](/es/guides/minimax/). |
| `ocx mmx` | `ocx mmx text <chat\|repl> [mmx args...]` - Lanzamiento MiniMax CLI texto a través del proxy; uso llano `mmx` para otras superficies. Véase [MiniMax clientes](/es/guides/minimax/). |
| `ocx zcode` | `ocx zcode [status\|enable\|disable\|history\|restore] [--json]` - Comandos de integración ZCode administrados. Véase [Tiendas ZCode](/es/guides/integrations/#zcode-314-and-later). |

- [Ciclo de vida](/es/reference/cli/lifecycle/) - Configuración, proxy y ciclo de vida del servicio, estado, diagnóstico, sincronización del catálogo, el panel de control y actualizaciones.
- [Proveedores, cuentas y modelos](/es/reference/cli/providers-accounts/) - configuración de proveedores, autenticación, grupos de credenciales, cuota, modelos personalizados, visibilidad, modelos seleccionados y límites de contexto.
- [Agentes, enrutamiento e integraciones](/es/reference/cli/agents/) - controles multiagente, combos, observabilidad, claves de admisión, rutas de protocolo, integraciones de clientes, configuración en entorno de ejecución, configuración validada e inspección de actualización de solo lectura Codex CLI.

<a id="headless-behavior"></a>

## Comportamiento sin cabeza

Los comandos de administración se comunican con la API del proxy activo mediante el puerto registrado y las comprobaciones de identidad, sin mantener una segunda ruta de configuración. Si el proxy está detenido o no es accesible, devuelven HTTP 503 y la CLI termina con un código distinto de cero. Los comandos documentados expresamente como operaciones sin conexión pueden validar y editar el archivo de configuración sin un proxy activo.

`ocx system codex-cli-update check` no necesita proxy en vivo y no hace ninguna solicitud de registro de paquetes. Inspecciona los metadatos de procedencia limitada para el candidato de instalación configurado, incluida su ubicación ejecutable redactada y la evidencia de propiedad. El contexto del lanzador publicado de confianza autentica esa instantánea candidata, no una ejecución exitosa de Codex. En POSIX, `selectionAttested` puede ser `true` cuando el solucionador en entorno de ejecución selecciona el mismo candidato de entorno canónico sin ejecutarlo. Un manifiesto de paquete global vinculado npm puede establecer `managed: true` cuando prueba la propiedad y, si se informa de una versión candidata, esa versión coincide con el manifiesto; los candidatos persistentes permanecen sin certificar. El informe JSON expone `candidateAvailable`, `candidateVersion`, `candidateSource` y `selectionAttested`. Inspeccionar el candidato configurado requiere un contexto confiable del lanzador publicado; un arranque directo desde Bun o el código fuente carece de esa prueba, ignora el estado ambiental y persistido y puede informar `candidate_unavailable` en POSIX o `windows_inspection_deferred` en Windows. Windows x64 también admite un `codex.cmd` npm estándar con ruta absoluta capturada por la prueba, una pareja Node/npm vinculada a identificadores abiertos —local al prefijo si existe, o la pareja capturada en PATH anclada a la arquitectura del lanzador— y un binario de plataforma verificado dentro del prefijo. Usa identificadores abiertos que rechazan puntos de reanálisis; otras estructuras Windows siguen aplazadas o no administradas. Un resultado Windows `managed` solo clasifica la instalación observada: Node/npm sirve para leer metadatos del actualizador, sin afirmar qué intérprete resolverá una ejecución posterior de `codex.cmd`. La inspección y la planificación siguen siendo de solo lectura; la aplicabilidad y la aplicación confirmada se deciden por separado. El comando no instala ni repara software, ejecuta Codex o npm, controla procesos ni escribe configuración o caché.

`ocx system codex-cli-update plan --json` agrega una decisión de actualización de solo lectura para una instalación POSIX npm-global atestada. Resuelve `latest` mediante el registro oficial npm, valida la versión exacta y la integridad SHA-512 y rechaza sesiones activas u observación incompleta de procesos. Las consultas usan configuración, caché y registros npm temporales aislados con limpieza de mejor esfuerzo. No instala software ni envía señales. La aplicación Windows x64 exige un prefijo npm acotado con autoridad privada de escritura verificada y conserva paquetes y shims ajenos; las estructuras no admitidas devuelven `applicable: false` y `refusal: windows_apply_disabled`. La selección solo por PATH y los wrappers de inicio automático de OpenCodex siguen aplazados. La planificación Windows también exige autoridad de escritura confiable sobre todo el árbol npm y los directorios de búsqueda de módulos. La aplicación bloquea cambios de selección e inicios de sesiones propias hasta que el instalador termine y se verifique el resultado; una vida de proceso desconocida mantiene el bloqueo. El Node seleccionado debe admitir hooks de módulos síncronos; npm no puede cargar dependencias fuera de su árbol verificado. Consulta los [detalles de planificación](/es/reference/cli/agents/#read-only-codex-cli-update-plan).

Para un plan npm-global revisado y aplicable, `ocx system codex-cli-update apply --plan-id <id> --yes` realiza la actualización exacta y devuelve un trabajo persistente. `ocx system codex-cli-update status <job-id> --json` consulta su resultado. Usa un `--request-id` estable si se pierde una respuesta. Consulta [la confirmación y los estados del trabajo](/es/reference/cli/agents/#confirmed-codex-cli-apply-and-job-status).

Para la observación de la instalación de Windows x64, véase [El comando `attest`](/es/reference/cli/agents/#explicit-installation-observation-on-windows-x64). Sin rutas explícitas, observa el candidato seleccionado identificado a partir de la instantánea del lanzador de prueba; no otorga autoridad de actualización ni certifica la selección en entorno de ejecución.

La lista o el estado es el valor predeterminado cuando no es ambiguo. Use `--json` solo en hojas que lo admitan, y `ocx observe logs --follow --jsonl` para la salida de fila modificada, o `ocx logs --follow --events` para instantáneas/agregados de ventana observada versionados. Tampoco es historia sin pérdida; [seguimiento, la línea de tiempo y el uso de key-scoped](/es/reference/cli/agents/#follow-request-windows-or-injection-sequences): Límites de cursor/reseteo/datos incompletos. [Modelo de clave seleccionada/comprobaciones de audio](/es/reference/cli/agents/#explicit-key-model-and-audio-checks) requieren el trabajo autorizado por el operador y la transferencia privada de datos; sus informes son observaciones, no certificados de alcance de clave. El tema, el idioma, la navegación y otros estados del navegador puramente visuales no tienen el equivalente CLI; La configuración de Cloudflare Tunnel está fuera de este conjunto de comandos.

Para las tareas de lectura de estilo tablero, use [selección de registro limitado, búsqueda de modelo de uso y totales de compañeros guardados](/es/reference/cli/agents/#filter-a-bounded-log-snapshot). `logs filter` distingue la ventana escaneada de las coincidencias devueltas; `usage --search` cambia las filas del modelo sin recalcular los totales del informe; `companion usage` conserva la disponibilidad y la configuración de cada rango. [API - cuota de key pool](/es/reference/cli/providers-accounts/#accounts-and-key-pools) es una lectura explícita `account list --quota` y puede contactar a los proveedores.

<a id="liveness-probe-ceiling-override"></a>

## Sonda Liveness techo override

`ocx health`, `ocx status`, `ocx account *`, `ocx login codex` y `ocx ready` encuentran el proxy de ejecución a través de una sonda de vida corta: 750 ms por intento por defecto y 1500 ms con reintentos para detener y comenzar las decisiones. En los hosts donde una capa de seguridad (un filtro de contenido o una extensión de red de estilo EDR) agrega un costo fijo a cada conexión de bucle de retorno, esos límites pueden expirar antes de que un proxy saludable responda, por lo que estos comandos informan que el proxy está inactivo mientras `curl http://127.0.0.1:10100/healthz` tiene éxito.

Establecer `OCX_PROBE_TIMEOUT_MS` para elevar los techos en tales hosts, por ejemplo `OCX_PROBE_TIMEOUT_MS=5000 ocx status`. El valor es milisegundos enteros de 1 a 30000. La anulación solo aumenta: los presupuestos predeterminados de 750 ms y 1500 ms de parada / inicio mantienen sus pisos, por lo que `1000` solo alarga la sonda predeterminada. Los valores indefinidos, vacíos, fraccionarios, negativos, cero o mayores se ignoran y se aplican los límites máximos enviados.

En Windows, el proxy también eleva su propio proceso a la prioridad ABOVE_NORMAL cuando se inicia, lo que reduce los retrasos de programación en un host saturado por otro trabajo de prioridad NORMAL (exploraciones de antivirus, codificadores, emuladores) sin garantizar que la sonda permanezca bajo estos techos a carga extrema. El impulso se aplica solo al proceso proxy (el trabajo que genera aún se ejecuta en NORMAL) y un proxy con CPU pesada puede retrasar las aplicaciones con prioridad NORMAL. El cambio es de mejor esfuerzo; establece `OCX_DISABLE_PRIORITY_BOOST=1` en el entorno del proxy para dejar la prioridad sin cambios.

<a id="exit-codes-and-confirmation"></a>

## Códigos de salida y confirmación

Los comandos exitosos terminan con código 0. Los argumentos no válidos, los comandos o recursos desconocidos, las operaciones de API fallidas y la falta de servicios necesarios producen un código distinto de cero. `ocx health` sale específicamente 0 solo cuando el proxy está sano y 1 cuando no se encuentra ningún proxy sano; los argumentos inválidos salen 2, por lo que se puede usar como una sonda de servicio. Los scripts deben probar el código de salida en lugar de raspar la salida legible por humanos.

Muchos comandos de gestión comparten estas asignaciones; otras CLI familias conservan sus propios contratos de salida:

| Código | Causa |
|---|---|
| 0 | éxito |
| 2 | rechazo de uso local en los controladores de gestión; también no compatible con `doctor --json` |
| 64 | argumentos inválidos a `capabilities`, `ready` o `resolve`, antes de su descubrimiento / solicitud de trabajo |
| 4 | HTTP 404 - la cuenta, el proveedor, la clave o la ruta con nombre no existe |
| 5 | HTTP 409 - conflicto; se mantiene una cerradura o se cambia el estado debajo |
| 1 | todo lo demás, incluyendo fallos de transporte y otros errores HTTP |

Salida 0 significa que no se informó ningún error. Los verbos de vista previa (por ejemplo `ocx storage cleanup` sin `--yes`) también salen 0 sin mutar. Una configuración guardada todavía puede llevar un resultado de aplicación omitido o incompleto; lea las advertencias de recibo y stderr.

Las operaciones de eliminación destructiva, importación, consumo de crédito y actualización que anuncian la confirmación requieren `--yes` en uso no interactivo. La bandera es un opt-in explícito; omitirla no debe confirmar silenciosamente la acción.

`ocx storage cleanup` sin `--yes` solo muestra una vista previa: imprime lo que liberaría, no cambia nada y termina con código 0. Estas operaciones no ofrecen confirmación interactiva. Una pregunta que un agente puede responder automáticamente no establece un límite de consentimiento; la opción explícita es el requisito para aplicar la operación.

<a id="driving-the-cli-from-an-agent"></a>

## Conducir el CLI desde un agente

Descubra progresivamente, sin iniciar un proxy:

```bash
ocx help
ocx help models
ocx help models preset show
```

Lea el capítulo correspondiente en el `skills/ocx/references/01_management_surface.md` del repositorio o en una de las páginas de la familia de comandos públicas anteriores. Full `ocx help --all` es un escape a la referencia de nivel superior. Un amplio inventario de máquinas es opcional:

```bash
ocx capabilities --json
ocx capabilities --mutating-only --json
ocx capabilities --route '/api/providers/{provider}/model-costs' --json
```

La búsqueda de ruta coincide con la plantilla declarada literal, no con los ID de proveedor concretos ni con un método HTTP. Un error sale 4 y no prueba que un comando runtime esté ausente. Las declaraciones incluyen comandos locales, así como comandos de gestión; solo estos últimos necesitan un objetivo en vivo. Antes de las operaciones en vivo, ejecute `ocx ready --json` y `ocx status --json`, inspeccione el objetivo y `versionSkew.relation`, y resuelva el desajuste de versión. `unknown` no confirma las compilaciones coincidentes. La ayuda sin conexión, la configuración local y la inspección local del laboratorio no requieren el inicio.

`ocx status --json` incluye `cliCommand`: intent de escritorio configurado, el ejecutable esperado, candidatos de PATH observados, `pathFirst`, `desktopFirstOnPath`, códigos de emisión y `shellResolution: "unobserved"`. El informe de estado humano imprime una línea de selección de comandos. `ocx doctor` añade una sección de "selección de comandos ocx": los registros no válidos, inseguros (`record-unsafe`) o habilitados pendientes y los objetivos de escritorio faltantes/inutilizables fallan la comprobación, mientras que los registros deshabilitados pendientes de limpieza, los conflictos de orden de PATH y los escaneos incompletos advierten. `OCX_NO_DESKTOP_HANDOFF=1` suprime el traspaso de paquete-lanzador para una invocación; deja la configuración de la shim de escritorio y de PATH en su lugar. Estas observaciones de solo lectura no ejecutan candidatos, resuelven alias/funciones de parent-shell ni identifican al propietario del entorno de ejecución del proxy. En Windows, el traspaso de paquete-lanzador está desactivado; el pedido del usuario `Path` selecciona el escritorio `ocx.exe`. El estado y el médico aún leen el registro y reportan al primer candidato a PATH. Se informa de un posible candidato de directorio actual cmd por separado del orden PATH.

`ocx status --json` también incluye `install`: cómo se instaló este `ocx`, según el mismo detector que usa `ocx update`. `install.method` es `bun`, `npm`, `pnpm`, `mise`, `source`, `standalone` (el binario compilado de escritorio) o `unknown` si la detección falló. `install.evidence.basis` indica qué evidencia decidió el resultado (`package-layout`, `mise-backend-record`, `standalone-binary` o `unavailable`); una instalación mise añade el alias de la herramienta y el backend de mise, y un fallo añade un código `error`. No se añade ninguna ruta.

Los indicadores de salida son por comando. `doctor` rechaza `--json` con la salida 2; [`v2` (referencia de la familia)](/es/reference/cli/agents/) soporta `--json` para objetivos locales y `--live`. Incluso para los comandos de gestión con capacidad JSON, los fallos API normalmente usan prosa stderr con líneas opcionales `reason:` y `hint:`, no una envolvente de error JSON. Mantén separados el estado stdout, stderr y exit.

La cobertura se mide por flujos de trabajo con nombre, no por prefijos de rutas compartidas. Los ajustes preestablecidos de modelo existentes, la visibilidad, los controles de cuenta y las lecturas de perfil de enrutamiento no implican soporte para ediciones de nombre de pantalla de modelo descubierto o escrituras de perfil de enrutamiento. Las acciones de consentimiento de solo sesión y la presentación del navegador siguen siendo límites separados. Creación de clave de acceso y credenciales de texto plano de retorno de inicio de rotación: los agentes deben entregar esos pasos a un terminal operado por humanos fuera de la sesión y aceptar solo ID y confirmación no secretas. Nunca pida credenciales en el chat ni omita una acción de solo sesión con otro cliente API.

<a id="recent-behavior-changes"></a>

## Cambios de comportamiento recientes

Estas son correcciones a comandos que previamente informaron mal sus propios resultados:

- `doctor` y `sync-cache` ahora salen no cero en caso de fallo. Previamente imprimieron un fracaso y salieron 0, por lo que un guión no podía distinguir el éxito del fracaso.
- Los errores del cliente de `account` Mapa HTTP 404 a la salida 4 y HTTP 409 a la salida 5, en lugar de contraerse Todo en 1.
- `ocx restore back --json` ahora honra su bandera de salida, que previamente aceptó e ignoró. Esto no hace que `--json` sea una opción global para cada comando.
- `ocx logs --model` ahora en realidad filtros. Se aceptó y se ignoró silenciosamente, por lo que la salida parecía filtrada mientras mostraba cada fila.
- `ocx storage` ganó `cleanup`, `trash` y `policy` subcomandos. Un `ocx storage` desnudo todavía imprime el informe de almacenamiento, como lo hizo cuando era un alias de `ocx observe storage`.

<a id="version-and-internal-dispatch-targets"></a>

## Objetivos de versión y despacho interno

`ocx --version`, `ocx -v`, y `ocx version` imprimen una línea de versión amigable para el script y salen.

Dos destinos de envío se omiten intencionalmente de la ayuda normal: `__refresh-version [preview]` actualiza la caché de actualización-notificación en un proceso separado, y `__gui-update-worker <job-id> [latest|preview] [restart]` ejecuta un trabajo de actualización del panel de control. Son detalles de implementación, no comandos estables orientados al usuario. El panel registra el PID del trabajador, recupera un trabajo activo cuyo trabajador murió, trata los registros activos sin PID más antiguos como obsoletos después de diez minutos y protege a un trabajador vivo de actualizaciones simultáneas.

<a id="capability-argument-validation"></a>

## Validación del argumento de capacidad

`ocx capabilities` rechaza argumentos desconocidos, banderas repetidas y valores en blanco de `--route` con salida 64. Una ruta válida sin capacidad declarada sale 4.

<a id="integer-option-values"></a>

## Valores de opción enteros

Las opciones enteras como `--limit` requieren números enteros decimales dentro de los límites de seguridad de JavaScript. Se aceptan separadores de dígitos tales como `1_000` y `1,000`. Los valores vacíos, hexadecimales, notación de exponente y fracciones son rechazados antes de que se envíe una solicitud.

<a id="windows-json-configuration-files"></a>

## Windows JSON archivos de configuración

`ocx config validate <file>` y `ocx config import <file> --yes` aceptan UTF-8 JSON con o sin una lista de materiales líder, incluyendo stdin (`-`). Esto soporta exportaciones UTF-8 desde Windows PowerShell y editores. No se acepta la entrada UTF-16.

<a id="default-alias-listing"></a>

## Listado de alias predeterminado

`ocx alias --json` es equivalente a `ocx alias list --json`. La bandera de salida puede preceder o seguir una acción de alias explícita.

<a id="local-config-output-and-validation"></a>

## Salida y validación de configuración local

`ocx config validate [path|-] [--json]` sale de 1 cuando falla la validación. El modo JSON emite una carga útil `{ok:false,error}`; el modo humano nombra el fallo de validación.

Cuando la configuración guardada no es válida o ilegible, `ocx config`, `ocx config show` y `ocx config get` advierten en stderr que los valores predeterminados se muestran para configuraciones inválidas y salen no cero. Stdout conserva su formato existente. Ejecute `ocx config validate` para inspeccionar el error, o `ocx config show --source` para los diagnósticos de configuración y fuente. La inspección explícita `--source` sale de 0 cuando informa con éxito una reserva y aún emite la advertencia.

`ocx config export <file> --json` escribe la configuración raw en el archivo y emite solo `{ok:true,path}` en stdout. Exportar a `-` siempre emite el documento de configuración en bruto, incluidas las credenciales; manténgalo fuera de las transcripciones del agente.

Local `ocx provider add` valida la configuración completa del candidato antes de guardar. Un error de validación deja el archivo guardado sin cambios. intencionalmente proveedores locales requieren `--allow-private-network` a menos que su entrada de registro ya permita destinos privados. El indicador no permite los puntos finales de metadatos bloqueados.

`ocx health` solo acepta una bandera opcional `--json`. Los argumentos desconocidos o los indicadores repetidos devuelven la salida 2 antes de sondear. Los errores de uso de Alias también devuelven la salida 2 con un error legible; las acciones desconocidas nombran `ocx help alias`.

<a id="log-model-selectors"></a>

### Selectores de modelo de registro

`ocx logs --model` acepta un ID de modelo desnudo o la etiqueta completa `provider/model` impresa en filas humanas, incluidos los modelos cuyos ID desnudos contienen barras. Los intentos de conmutación por error se comparan como destinos completos. El filtrado se produce antes de `--limit`, y `--follow` utiliza el mismo filtro de servidor. Un resultado humano filtrado vacío dice que no hay entrada de registro coincidente; `--json` y `--jsonl` mantienen su salida legible por máquina.

`ocx hub disable [--revoke-clients --client-key <id> ...] [--json]` devuelve un concentrador a autónomo en una escritura de configuración validada. La revocación de la clave del cliente requiere identificadores explícitos porque los nombres de clave no prueban el origen. Véase [Devolver un concentrador a autónomo](/es/guides/remote-hub/#return-a-hub-to-standalone).
