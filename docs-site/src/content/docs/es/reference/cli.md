---
title: "Referencia de CLI"
description: "Despacho de comandos, códigos de salida y enlaces a cada familia de comandos ocx."
---

La CLI de opencodex es `ocx`. El primer nombre determina qué comando se ejecuta. Los alias documentados `setup`/`init`, `restore`/`eject` y `models`/`model` realizan la misma operación. Los comandos desconocidos y las sintaxis no válidas producen errores.

Ejecuta `ocx`, `ocx help`, `ocx --help` o `ocx -h` para ver el mismo índice compacto, agrupado en primeros pasos, tareas comunes, exploración y ayuda adicional. Usa `ocx help --all` o `ocx --help --all` para la referencia completa, incluidas las variantes omitidas del índice. Para un comando registrado en la tabla de ayuda, usa `ocx help <command>`, `ocx <command> --help` o `ocx <command> -h`; también se admite `ocx <command> help`. La ayuda y la versión son de solo lectura: no inician, detienen, instalan, desinstalan ni reescriben el estado de Codex u opencodex.

<a id="nested-help"></a>

## Ayuda anidada

La ayuda de una familia, como `ocx help models`, conserva su sintaxis y sus detalles y enumera los subcomandos declarados con sus resúmenes. La lista describe los subcomandos registrados y no garantiza una cobertura exhaustiva de los disponibles durante la ejecución. La ayuda de un alias conserva su sintaxis y sus detalles y enlaza con la familia canónica: `ocx help model` conduce a `ocx help models`. La ayuda de modelos también enlaza el tema específico `models context`, aparte de las capacidades declaradas.

La ayuda acepta rutas con varios nombres de comando:

```bash
ocx help models context
ocx models context --help
ocx model context --help
ocx help account list
ocx help account main
```

Las tres primeras formas muestran el mismo tema de límites de contexto, incluido el alias `model`:

```text
ocx models context <status|value <tokens> [--set-all]|provider <name> on [--value <tokens>]|provider <name> off|all <on|off>> [--json]
```

`ocx models context status --json` lee los ajustes actuales. `value <tokens>` fija el valor predeterminado para las futuras activaciones; `--set-all` también lo aplica a todos los proveedores enrutados. `provider <name> on` habilita el límite de un proveedor y permite indicar `--value <tokens>`; `off` lo desactiva. `all on|off` cambia todos los proveedores enrutados a la vez.

Los temas de capacidades declaradas, como `account list`, muestran su resumen, opciones conocidas y detalles, con un enlace a la ayuda superior. Esos metadatos no cubren todos los argumentos ni subcomandos disponibles, por lo que un tema puede mostrar `Command: ocx ...` sin prometer una gramática `Usage:` completa. Un prefijo como `account main` enumera sus subcomandos declarados e indica que la cobertura es incompleta. Un tema explícito no declarado (`ocx help <path>`) termina con código 1 y escribe en stderr un mensaje breve de ayuda no disponible junto con una referencia a la familia conocida o a la ayuda completa. stdout queda vacío y no se imprime toda la ayuda. La falta de detalles no determina si el comando existe. Añadir `--help` o `-h` conserva el comportamiento anterior: si faltan metadatos detallados, se muestra correctamente la ayuda superior conocida sin ejecutar el comando.

El despachador inicial de la CLI Bun reconoce `help` sin opciones solo en la raíz o inmediatamente después del comando raíz. Usa `--help` o `-h` en rutas anidadas. Los valores posteriores, como `help` en `ocx alias set demo help`, siguen siendo argumentos del comando. Un `--` exacto termina la búsqueda inicial de opciones de ayuda; por eso `ocx claude -- --help` conserva los argumentos para enviarlos al comando.
`ocx alias set demo help` Siguen siendo argumentos de comando. Un exacto `--` termina la ayuda de la cabeza que explora, así que `ocx claude -- --help` conserva los argumentos para el despacho de comandos.

<a id="recovering-from-command-typos"></a>

## Recuperación de errores tipográficos de comando

Los comandos raíz desconocidos y las rutas explícitas de ayuda no resueltas terminan con código 1, muestran un diagnóstico breve y orientación en stderr y dejan stdout vacío. Para errores tipográficos cercanos pueden sugerir nombres de comandos visibles o subcomandos documentados de la familia actual. Son sugerencias informativas: la CLI nunca las ejecuta ni reintenta el comando.

| Entrada | Orientación |
| --- | --- |
| `ocx modles` o `ocx help modles` | Sugiere `ocx help models`. |
| `ocx help account lisst` | Sugiere `ocx help account list` dentro de la familia de cuentas. |
| `ocx help qzxv` | Ofrece `ocx help --all` sin adivinar un comando. |
| `ocx help models qzxv` | Indica que la ayuda detallada no está disponible y remite a la familia de comandos de modelos conocida. |

La CLI Bun rechaza una raíz desconocida antes de restaurar automáticamente el shim o ejecutar otras comprobaciones previas. Los comandos reconocidos conservan sus comprobaciones. Los comandos ocultos y el ejecutor interno siguen siendo destinos válidos, pero no aparecen en el descubrimiento ni en las sugerencias. Se conservan la ayuda alternativa al añadir una opción, las capacidades JSON y los errores específicos de proveedor.

<a id="command-families"></a>

## Familias de comandos

### `ocx message`

`ocx message sessions [--json]` descubre las sesiones locales de Codex cargadas y devuelve sus identificadores, nombres y estados de ejecución. `--thread` exige un UUID exacto; `--name`, un único nombre exacto. Los destinos inexistentes, duplicados, incompletos o no cargados producen un error. `ocx message send (--thread <uuid> | --name <exact-name>) --stdin [--json]` envía un mensaje de par correlacionado sin iniciar un daemon ni reanudar un hilo. Sin `--host`, estas operaciones son locales. Consulta [Mensajería de Codex](/es/reference/cli/messaging/) para conocer el contexto del remitente, los tipos, el entorno probado y los recibos `not_sent` / `queued` / `unknown`. El [transporte remoto mediante SSH](/es/reference/cli/messaging/#explicit-remote-peers) requiere un host registrado y `--host`; no inicia automáticamente el receptor ni reenvía mensajes de forma automática.

### `ocx provider`

`ocx provider`, `ocx help provider`, `ocx provider help`, `ocx provider --help` y `ocx provider -h` muestran la misma ayuda: sintaxis, ejemplos, orientación sobre proveedores predefinidos o personalizados y enlaces a los temas declarados. La ayuda correcta se imprime en stdout y termina con código 0. Ejecutar solo `ocx provider` conserva las comprobaciones previas normales; las formas explícitas de ayuda inicial terminan antes de ellas. Una acción desconocida escribe el diagnóstico y la ayuda en stderr, deja stdout vacío y termina con código 1.

### `ocx alias`

`ocx alias list [--json]` muestra alias de usuario efectivos e integrados. Utilice `ocx alias set <provider>[/<native-model-id>] <alias>` y `ocx alias rm <provider>[/<native-model-id>]` para editarlos. Los identificadores de modelo nativos pueden contener barras adicionales porque el selector se divide solo en la primera barra. Habilite los valores predeterminados enviados con `ocx alias defaults on|off [--provider <name>]`.

### `ocx remote-workspace`

`ocx remote-workspace pair <hub-url> --pairing-code-stdin --root <absolute-path>` inscribe el equipo local como un Ejecutor solo OCX. Repita `--root` para aprobar más carpetas y utilizar `--name` para anular el nombre de host. Repita `--toolchain-root <absolute-directory>` para exponer un directorio de Node, Rust, Go u otra cadena de herramientas instalado por el usuario de solo lectura dentro del entorno de pruebas del comando. En las compilaciones internas de prueba para macOS y Windows, `bun run build:remote-workspace-helper` compila el helper de Rust que el comando de emparejamiento descubre automáticamente; `--executor-helper <absolute-file>` selecciona otra compilación revisada explícitamente y fija su resumen en el estado de Ejecutor local. `ocx remote-workspace agent` mantiene la conexión cifrada saliente; `ocx remote-workspace status [--json]` informa sobre el Hub, el dispositivo, las raíces y las capacidades anunciadas sin imprimir su portador o clave privada. Véase [Espacio de trabajo remoto](/es/guides/remote-workspace/).

Familias de comandos adicionales:

| Familia | Sintaxis y referencia |
| --- | --- |
| `ocx chatgpt` | `ocx chatgpt <launch\|restore\|status>`: shim experimental del app-server de macOS, desactivado de forma predeterminada. Consulta [ChatGPT Desktop](/es/guides/chatgpt-desktop/). |
| `ocx hub` | `ocx hub invite [--json] [--data-url <origin>] [--management-url <origin>] [--clients codex,claude]`: crea un código secreto de emparejamiento de un solo uso en un Hub activo. Consulta [Remote Hub](/es/guides/remote-hub/). La invitación exige autorización explícita y su código no debe aparecer en la transcripción de un agente. |
| `ocx inspect` | `ocx inspect <subcommand>`: lee la configuración efectiva, el catálogo, las trazas de enrutamiento, la cadencia, el inventario de claves, el prompt de Codex, la configuración de clientes, el estado de estrella o la bandeja de Windows. Ejecuta `ocx help inspect` para acceder a los temas. |
| `ocx mcode` | `ocx mcode [mcode args...]`: inicia MiniMax Code después de habilitar su integración mediante archivos administrados. Consulta [Clientes MiniMax](/es/guides/minimax/). |
| `ocx mmx` | `ocx mmx text <chat\|repl> [mmx args...]`: inicia los comandos de texto de MiniMax CLI mediante el proxy. Para las demás funciones, usa `mmx` directamente. Consulta [Clientes MiniMax](/es/guides/minimax/). |
| `ocx zcode` | `ocx zcode [status\|enable\|disable\|history\|restore] [--json]`: administra la integración de ZCode. Consulta [Almacenes de ZCode](/es/guides/integrations/#zcode-314-and-later). |

- [Ciclo de vida](/es/reference/cli/lifecycle/) - Configuración, proxy y ciclo de vida del servicio, estado, diagnóstico, sincronización del catálogo, el panel de control y actualizaciones.
- [Proveedores, cuentas y modelos](/es/reference/cli/providers-accounts/) - configuración de proveedores, autenticación, grupos de credenciales, cuota, modelos personalizados, visibilidad, modelos seleccionados y límites de contexto.
- [Agentes, enrutamiento e integraciones](/es/reference/cli/agents/) - controles multiagente, combos, observabilidad, claves de admisión, rutas de protocolo, integraciones de clientes, configuración en entorno de ejecución, configuración validada e inspección de actualización de solo lectura Codex CLI.

<a id="headless-behavior"></a>

## Uso sin interfaz gráfica

Los comandos de administración se comunican con la API del proxy activo mediante el puerto registrado y las comprobaciones de identidad, sin mantener una segunda ruta de configuración. Si el proxy está detenido o no es accesible, devuelven HTTP 503 y la CLI termina con un código distinto de cero. Los comandos documentados expresamente como operaciones sin conexión pueden validar y editar el archivo de configuración sin un proxy activo.

`ocx system codex-cli-update check` no necesita proxy en vivo y no hace ninguna solicitud de registro de paquetes. Inspecciona los metadatos de procedencia limitada para el candidato de instalación configurado, incluida su ubicación ejecutable redactada y la evidencia de propiedad. El contexto del lanzador publicado de confianza autentica esa instantánea candidata, no una ejecución exitosa de Codex. En POSIX, `selectionAttested` puede ser `true` cuando el solucionador en entorno de ejecución selecciona el mismo candidato de entorno canónico sin ejecutarlo. Un manifiesto de paquete global vinculado npm puede establecer `managed: true` cuando prueba la propiedad y, si se informa de una versión candidata, esa versión coincide con el manifiesto; los candidatos persistentes permanecen sin certificar. El informe JSON expone `candidateAvailable`, `candidateVersion`, `candidateSource` y `selectionAttested`. Inspeccionar el candidato configurado requiere un contexto confiable del lanzador publicado; un arranque directo desde Bun o el código fuente carece de esa prueba, ignora el estado ambiental y persistido y puede informar `candidate_unavailable` en POSIX o `windows_inspection_deferred` en Windows. Windows x64 también admite un `codex.cmd` npm estándar con ruta absoluta capturada por la prueba, una pareja Node/npm vinculada a identificadores abiertos —local al prefijo si existe, o la pareja capturada en PATH anclada a la arquitectura del lanzador— y un binario de plataforma verificado dentro del prefijo. Usa identificadores abiertos que rechazan puntos de reanálisis; otras estructuras Windows siguen aplazadas o no administradas. Un resultado Windows `managed` solo clasifica la instalación observada: Node/npm sirve para leer metadatos del actualizador, sin afirmar qué intérprete resolverá una ejecución posterior de `codex.cmd`. La inspección y la planificación siguen siendo de solo lectura; la aplicabilidad y la aplicación confirmada se deciden por separado. El comando no instala ni repara software, ejecuta Codex o npm, controla procesos ni escribe configuración o caché.

`ocx system codex-cli-update plan --json` agrega una decisión de actualización de solo lectura para una instalación POSIX npm-global atestada. Resuelve `latest` mediante el registro oficial npm, valida la versión exacta y la integridad SHA-512 y rechaza sesiones activas u observación incompleta de procesos. Las consultas usan configuración, caché y registros npm temporales aislados con limpieza de mejor esfuerzo. No instala software ni envía señales. La aplicación Windows x64 exige un prefijo npm acotado con autoridad privada de escritura verificada y conserva paquetes y shims ajenos; las estructuras no admitidas devuelven `applicable: false` y `refusal: windows_apply_disabled`. La selección solo por PATH y los wrappers de inicio automático de OpenCodex siguen aplazados. La planificación Windows también exige autoridad de escritura confiable sobre todo el árbol npm y los directorios de búsqueda de módulos. La aplicación bloquea cambios de selección e inicios de sesiones propias hasta que el instalador termine y se verifique el resultado; una vida de proceso desconocida mantiene el bloqueo. El Node seleccionado debe admitir hooks de módulos síncronos; npm no puede cargar dependencias fuera de su árbol verificado. Consulta los [detalles de planificación](/es/reference/cli/agents/#read-only-codex-cli-update-plan).

Para un plan npm-global revisado y aplicable, `ocx system codex-cli-update apply --plan-id <id> --yes` realiza la actualización exacta y devuelve un trabajo persistente. `ocx system codex-cli-update status <job-id> --json` consulta su resultado. Usa un `--request-id` estable si se pierde una respuesta. Consulta [la confirmación y los estados del trabajo](/es/reference/cli/agents/#confirmed-codex-cli-apply-and-job-status).

Para la observación de la instalación de Windows x64, véase [El comando `attest`](/es/reference/cli/agents/#explicit-installation-observation-on-windows-x64). Sin rutas explícitas, observa el candidato seleccionado identificado a partir de la instantánea del lanzador de prueba; no otorga autoridad de actualización ni certifica la selección en entorno de ejecución.

Cuando no hay ambigüedad, se muestra la lista o el estado de forma predeterminada. Usa `--json` solo en los subcomandos que lo admiten. `ocx observe logs --follow --jsonl` muestra filas actualizadas; `ocx logs --follow --events`, instantáneas e incorporaciones versionadas de la ventana observada. Ninguna modalidad garantiza un historial sin pérdidas: consulta los [límites de cursores, reinicios y datos incompletos](/es/reference/cli/agents/#follow-request-windows-or-injection-sequences). Las [comprobaciones de modelos y audio con una clave seleccionada](/es/reference/cli/agents/#explicit-key-model-and-audio-checks) requieren operaciones con el proveedor autorizadas por el operador y la entrega privada de datos por stdin. Sus informes son observaciones, no certificados del alcance de la clave. El tema, el idioma, la navegación y otros estados puramente visuales del navegador no tienen equivalente CLI; configurar Cloudflare Tunnel queda fuera de estos comandos.

Para consultar información como en el dashboard, usa [la selección acotada de registros, la búsqueda de modelos en uso y los totales guardados de companion](/es/reference/cli/agents/#filter-a-bounded-log-snapshot). `logs filter` distingue la ventana examinada de las coincidencias devueltas; `usage --search` cambia las filas de modelos sin recalcular los totales del informe; `companion usage` conserva la disponibilidad de cada rango y los ajustes alternativos. La [consulta de cuota del grupo de claves API](/es/reference/cli/providers-accounts/#accounts-and-key-pools) con `account list --quota` es explícita y puede contactar a los proveedores.

<a id="liveness-probe-ceiling-override"></a>

## Ajustar el tiempo máximo de la sonda de actividad

`ocx health`, `ocx status`, `ocx account *`, `ocx login codex` y `ocx ready` localizan el proxy activo mediante una sonda breve: 750 ms por intento de forma predeterminada y 1500 ms con reintentos para decidir la parada o el inicio. Si una capa de seguridad, como un filtro de contenido o una extensión de red de tipo EDR, añade un coste fijo a cada conexión de loopback, esos plazos pueden vencer antes de que responda un proxy saludable. Los comandos lo muestran entonces como detenido aunque `curl http://127.0.0.1:10100/healthz` funcione.

Establece `OCX_PROBE_TIMEOUT_MS` para ampliar esos plazos, por ejemplo `OCX_PROBE_TIMEOUT_MS=5000 ocx status`. Se admiten milisegundos enteros de 1 a 30000. La opción solo aumenta los límites: conserva los mínimos de 750 ms y 1500 ms, de modo que `1000` amplía únicamente la sonda predeterminada. Los valores ausentes, vacíos, fraccionarios, negativos, cero o superiores al máximo se ignoran y se usan los plazos originales.

En Windows, el proxy también eleva su propio proceso a la prioridad ABOVE_NORMAL cuando se inicia, lo que reduce los retrasos de programación en un host saturado por otro trabajo de prioridad NORMAL (exploraciones de antivirus, codificadores, emuladores) sin garantizar que la sonda permanezca bajo estos techos a carga extrema. El impulso se aplica solo al proceso proxy (el trabajo que genera aún se ejecuta en NORMAL) y un proxy con CPU pesada puede retrasar las aplicaciones con prioridad NORMAL. El cambio es de mejor esfuerzo; establece `OCX_DISABLE_PRIORITY_BOOST=1` en el entorno del proxy para dejar la prioridad sin cambios.

<a id="exit-codes-and-confirmation"></a>

## Códigos de salida y confirmación

Los comandos exitosos terminan con código 0. Los argumentos no válidos, los comandos o recursos desconocidos, las operaciones de API fallidas y la falta de servicios necesarios producen un código distinto de cero. `ocx health` sale específicamente 0 solo cuando el proxy está sano y 1 cuando no se encuentra ningún proxy sano; los argumentos inválidos salen 2, por lo que se puede usar como una sonda de servicio. Los scripts deben probar el código de salida en lugar de raspar la salida legible por humanos.

Muchos comandos de administración comparten estas correspondencias; otras familias de la CLI conservan sus propios códigos:

| Código | Causa |
|---|---|
| 0 | éxito |
| 2 | rechazo de uso local en los controladores de gestión; también no compatible con `doctor --json` |
| 64 | argumentos inválidos a `capabilities`, `ready` o `resolve`, antes de su descubrimiento / solicitud de trabajo |
| 4 | HTTP 404 - la cuenta, el proveedor, la clave o la ruta con nombre no existe |
| 5 | HTTP 409: conflicto, por un bloqueo ocupado o porque cambió el estado durante la operación |
| 1 | todo lo demás, incluyendo fallos de transporte y otros errores HTTP |

El código 0 significa que no se informó de ningún error. Las operaciones de vista previa, como `ocx storage cleanup` sin `--yes`, también terminan con 0 sin modificar nada. Un ajuste guardado puede incluir un resultado de aplicación omitido o incompleto: lee el recibo y las advertencias de stderr.

Las operaciones de eliminación destructiva, importación, consumo de crédito y actualización que anuncian la confirmación requieren `--yes` en uso no interactivo. La bandera es un opt-in explícito; omitirla no debe confirmar silenciosamente la acción.

`ocx storage cleanup` sin `--yes` solo muestra una vista previa: imprime lo que liberaría, no cambia nada y termina con código 0. Estas operaciones no ofrecen confirmación interactiva. Una pregunta que un agente puede responder automáticamente no establece un límite de consentimiento; la opción explícita es el requisito para aplicar la operación.

<a id="driving-the-cli-from-an-agent"></a>

## Usar la CLI desde un agente

Descubra progresivamente, sin iniciar un proxy:

```bash
ocx help
ocx help models
ocx help models preset show
```

Lee el capítulo correspondiente en `skills/ocx/references/01_management_surface.md` o en las páginas públicas de familias de comandos anteriores. `ocx help --all` permite acceder a la referencia completa. El inventario amplio para lectura por máquinas es opcional:

```bash
ocx capabilities --json
ocx capabilities --mutating-only --json
ocx capabilities --route '/api/providers/{provider}/model-costs' --json
```

La búsqueda de ruta coincide con la plantilla declarada literal, no con los ID de proveedor concretos ni con un método HTTP. Un error sale 4 y no prueba que un comando runtime esté ausente. Las declaraciones incluyen comandos locales, así como comandos de gestión; solo estos últimos necesitan un objetivo en vivo. Antes de las operaciones en vivo, ejecute `ocx ready --json` y `ocx status --json`, inspeccione el objetivo y `versionSkew.relation`, y resuelva el desajuste de versión. `unknown` no confirma las compilaciones coincidentes. La ayuda sin conexión, la configuración local y la inspección local del laboratorio no requieren el inicio.

`ocx status --json` incluye `cliCommand`: intent de escritorio configurado, el ejecutable esperado, candidatos de PATH observados, `pathFirst`, `desktopFirstOnPath`, códigos de emisión y `shellResolution: "unobserved"`. El informe de estado humano imprime una línea de selección de comandos. `ocx doctor` añade una sección de "selección de comandos ocx": los registros no válidos, inseguros (`record-unsafe`) o habilitados pendientes y los objetivos de escritorio faltantes/inutilizables fallan la comprobación, mientras que los registros deshabilitados pendientes de limpieza, los conflictos de orden de PATH y los escaneos incompletos advierten. `OCX_NO_DESKTOP_HANDOFF=1` suprime el traspaso de paquete-lanzador para una invocación; deja la configuración de la shim de escritorio y de PATH en su lugar. Estas observaciones de solo lectura no ejecutan candidatos, resuelven alias/funciones de parent-shell ni identifican al propietario del entorno de ejecución del proxy. En Windows, el traspaso de paquete-lanzador está desactivado; el pedido del usuario `Path` selecciona el escritorio `ocx.exe`. El estado y el médico aún leen el registro y reportan al primer candidato a PATH. Se informa de un posible candidato de directorio actual cmd por separado del orden PATH.

`ocx status --json` también incluye `install`: cómo se instaló este `ocx`, según el mismo detector que usa `ocx update`. `install.method` es `bun`, `npm`, `pnpm`, `mise`, `source`, `standalone` (el binario compilado de escritorio) o `unknown` si la detección falló. `install.evidence.basis` indica qué evidencia decidió el resultado (`package-layout`, `mise-backend-record`, `standalone-binary` o `unavailable`); una instalación mise añade el alias de la herramienta y el backend de mise, y un fallo añade un código `error`. No se añade ninguna ruta.

Los indicadores de salida son por comando. `doctor` rechaza `--json` con la salida 2; [`v2` (referencia de la familia)](/es/reference/cli/agents/) soporta `--json` para objetivos locales y `--live`. Incluso para los comandos de gestión con capacidad JSON, los fallos API normalmente usan prosa stderr con líneas opcionales `reason:` y `hint:`, no una envolvente de error JSON. Mantén separados el estado stdout, stderr y exit.

La cobertura se determina por flujos de trabajo concretos, no por prefijos compartidos de rutas. Los ajustes de modelos, la visibilidad, los controles de cuentas y la lectura de perfiles de enrutamiento no implican que se puedan editar los nombres visibles de modelos descubiertos o escribir perfiles de enrutamiento. El consentimiento que exige una sesión y la presentación del navegador tienen límites independientes. Crear una clave de acceso o iniciar su rotación devuelve credenciales en texto plano: los agentes deben dejar esos pasos a una persona en una terminal fuera de la sesión y recibir solo identificadores no secretos y confirmaciones. Nunca pidas credenciales en el chat ni eludas una acción limitada a la sesión mediante otro cliente API.

<a id="recent-behavior-changes"></a>

## Cambios de comportamiento recientes

Estas son correcciones a comandos que previamente informaron mal sus propios resultados:

- `doctor` y `sync-cache` ahora terminan con un código distinto de cero si fallan. Antes imprimían el fallo y terminaban con 0, por lo que los scripts no podían distinguirlo de un éxito.
- Los errores de `account` convierten HTTP 404 en el código de salida 4 y HTTP 409 en el código 5. Los demás fallos siguen usando el código 1.
- `ocx restore back --json` ahora respeta su opción de salida, que antes aceptaba pero ignoraba. Esto no convierte `--json` en una opción global.
- `ocx logs --model` ahora filtra los resultados. Antes aceptaba la opción pero la ignoraba y mostraba todas las filas.
- `ocx storage` incorpora los subcomandos `cleanup`, `trash` y `policy`. Ejecutar solo `ocx storage` sigue mostrando el informe de almacenamiento, como cuando era un alias de `ocx observe storage`.

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

## Archivos JSON de configuración en Windows

`ocx config validate <file>` y `ocx config import <file> --yes` aceptan JSON UTF-8 con o sin marca de orden de bytes (BOM) inicial, también desde stdin (`-`). Esto permite usar las exportaciones UTF-8 de Windows PowerShell y otros editores. La entrada UTF-16 se rechaza.

<a id="default-alias-listing"></a>

## Listado de alias predeterminado

`ocx alias --json` es equivalente a `ocx alias list --json`. La bandera de salida puede preceder o seguir una acción de alias explícita.

<a id="local-config-output-and-validation"></a>

## Salida y validación de configuración local

`ocx config validate [path|-] [--json]` sale de 1 cuando falla la validación. El modo JSON emite una carga útil `{ok:false,error}`; el modo humano nombra el fallo de validación.

Cuando la configuración guardada no es válida o ilegible, `ocx config`, `ocx config show` y `ocx config get` advierten en stderr que los valores predeterminados se muestran para configuraciones inválidas y salen no cero. Stdout conserva su formato existente. Ejecute `ocx config validate` para inspeccionar el error, o `ocx config show --source` para los diagnósticos de configuración y fuente. La inspección explícita `--source` sale de 0 cuando informa con éxito una reserva y aún emite la advertencia.

`ocx config export <file> --json` escribe la configuración raw en el archivo y emite solo `{ok:true,path}` en stdout. Exportar a `-` siempre emite el documento de configuración en bruto, incluidas las credenciales; manténgalo fuera de las transcripciones del agente.

`ocx provider add` valida toda la configuración candidata antes de guardarla localmente. Un fallo de validación deja intacto el archivo guardado. Los proveedores deliberadamente locales requieren `--allow-private-network`, salvo que su entrada del registro ya permita destinos privados. Esa opción no permite acceder a los endpoints de metadatos bloqueados.

`ocx health` solo acepta una bandera opcional `--json`. Los argumentos desconocidos o los indicadores repetidos devuelven la salida 2 antes de sondear. Los errores de uso de Alias también devuelven la salida 2 con un error legible; las acciones desconocidas nombran `ocx help alias`.

<a id="log-model-selectors"></a>

### Selectores de modelo de registro

`ocx logs --model` admite un ID de modelo sin prefijo o la etiqueta completa `provider/model` que muestran las filas legibles por humanos, incluso si el ID contiene barras. Los intentos de failover se comparan como destinos completos. El filtro se aplica antes de `--limit`, y `--follow` usa el mismo filtro del servidor. Si no hay coincidencias, la salida humana lo indica; `--json` y `--jsonl` conservan sus formatos para máquinas.

`ocx hub disable [--revoke-clients --client-key <id> ...] [--json]` devuelve un concentrador a autónomo en una escritura de configuración validada. La revocación de la clave del cliente requiere identificadores explícitos porque los nombres de clave no prueban el origen. Véase [Devolver un concentrador a autónomo](/es/guides/remote-hub/#return-a-hub-to-standalone).
