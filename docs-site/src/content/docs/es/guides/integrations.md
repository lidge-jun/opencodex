---
title: "Integraciones"
description: "Conectar opencodex a OpenCode, Pi, Gentle Shell, OMP, Hermes, OpenClaw, Kimi Code, gjc, DeepSeek Harness, MiniMax Code, ZCode, Prime Agent, Aside, Raycast, omo, Qoder, Cline CLI, Kilo, Command Code, Factory Droid y T3 Code desde el panel — un interruptor por cliente, con una copia de seguridad tomada antes de cada escritura."
---

La página **Conectar** escribe el bloque de proveedor de opencodex en el archivo de configuración del cliente y permite retirarlo. Cada cliente de la tabla tiene su propio interruptor:

| Cliente | Archivo de configuración | Formato | Cuando el cambio entra en vigor | Credenciales |
|---|---|---|---|---|
| OpenCode | `~/.config/opencode/opencode.json` | JSON | Próximo lanzamiento directo | `OPENCODEX_OPENCODE_API_KEY` |
| Pi | `~/.pi/agent/models.json` | JSON | Nuevas sesiones | marcador de posición loopback |
| Gentle Shell | `~/.gentle-shell/agent/models.json` (hogar seleccionado persistente) | JSON | después de reiniciar Gentle Shell | marcador de posición loopback |
| OMP | `~/.omp/agent/models.yml` | YAML | después de reiniciar OMP | `opencodex-loopback` marcador de posición |
| Hermes | `~/.hermes/config.yaml` | YAML | Nuevas sesiones | `OPENCODEX_HERMES_API_KEY` |
| OpenClaw | `~/.openclaw/openclaw.json` | JSON5 | inmediatamente, en una puerta de enlace en ejecución | `OPENCODEX_OPENCLAW_API_KEY` |
| Kimi Code | `~/.kimi-code/config.toml` | TOML | en el reinicio, o `/reload` | marcador de posición loopback |
| gjc | `~/.gjc/agent/models.yml` | YAML | nuevas sesiones, o cuando abres `/model` |marcador de posición de bucle de retroceso no secreto |
| DeepSeek Harness (DSH) | `$DSH_HOME/profiles/desktop/cordis.patch.yml` (por defecto `~/.dsh/profiles/desktop/cordis.patch.yml` ); `$DSH_HOME/settings.yaml` hasta que DSH Desktop cree ese perfil | YAML | recarga caliente | marcador de posición portador de bucle de retorno no secreto |
| MiniMax Code | `~/.minimax/config.yaml` | YAML | nuevas sesiones, o después de abrir el selector de modelos | marcador de posición loopback |
| Prime Agent | `~/.prime/agent/models.json` | JSON | Nuevas sesiones | marcador de posición loopback |
| ZCode | `~/.zcode/v2/provider_config.json` (schemaVersion 1); retroceso legado: `~/.zcode/v2/config.json` | JSON | al reiniciar | marcador de posición loopback |
| Aside | `~/.aside/u/<account>/models.json` | JSON | después de cerrar Aside por completo y volver a abrirlo | marcador de posición loopback |
| Raycast | `~/.config/raycast/ai/providers.yaml` | YAML | inmediatamente en guardar - Raycast mira el archivo | ninguno - solo loopback |
| omo (Pi / senpi) | `~/.omo/agent/models.json` | JSON | Nuevas sesiones | marcador de posición loopback |
| Qoder | `settings.json` en `$QODER_CONFIG_DIR`, por defecto `~/.qoder` | JSON | Nuevas sesiones | marcador de posición loopback |
| Qoder CN | `settings.json` en `$QODERCN_CONFIG_DIR`, por defecto `~/.qoder-cn` | JSON | Nuevas sesiones | marcador de posición loopback |
| WorkBuddy (CN) | `~/.workbuddy/models.json` | JSON | Recarga automática o nuevas sesiones | marcador de posición loopback |
| WorkBuddy AI | `~/.workbuddy-ai/models.json` | JSON | Recarga automática o nuevas sesiones | marcador de posición loopback |
| Cline CLI | `~/.cline/data/settings/providers.json` y hermano `models.json` | JSON pareja | después de detener y reiniciar Cline | marcador de posición loopback |
| Kilo | primero existente `kilo.jsonc`, `kilo.json`, `opencode.jsonc`, `opencode.json`, o `config.json` bajo `~/.config/kilo` | JSONC | Nuevas sesiones | `OPENCODEX_KILO_API_KEY` |
| Command Code | `~/.commandcode/providers.json` (en Windows con el inicio predeterminado: usar `HOME ?? USERPROFILE` solo si no está en blanco y Windows-absoluto, de lo contrario `homedir()`; se conserva una vivienda suministrada por separado; adjuntar `.commandcode\providers.json`) | JSON | Lanzamiento del Command Code | Ninguno - Loopback sin llave ( `apiKey: false` ) |
| Factory Droid | `~/.factory/settings.json` ( `%USERPROFILE%\.factory\settings.json` en Windows) | JSON | inmediatamente a través de la observación de archivos | ninguno - sin llave |
| T3 Code | `$T3CODE_HOME/userdata/settings.json` (por defecto `~/.t3/userdata/settings.json`) | JSON | inmediatamente — T3 Code observa el archivo | marcador loopback no secreto |

<a id="gentle-shell"></a>

## Gentle Shell

Elija **Conectar → Gentle Shell**, o utilice los mismos comandos de integración administrada:

```bash
ocx export --client gentle-shell --json
ocx integration client enable --client gentle-shell
ocx integration client disable --client gentle-shell
```

Gentle Shell tiene un destino separado y un historial de reversión de Pi. Solo se gestionan `providers.opencodex`; otros proveedores y preferencias permanecen intactos. Los cambios de catálogo actualizan un bloque ya conectado, sin cambios. Un bloque copiado manualmente existente es un conflicto, no un permiso para sobrescribirlo: inspeccione la vista previa y use la confirmación explícita de sobreescritura solo si tiene la intención de reemplazarla.

El `home` guardado en `~/.gentle-shell/config.json` selecciona el destino. Gana una ruta personalizada guardada; el modo aislado/por defecto usa `GENTLE_SHELL_HOME` o `~/.gentle-shell/agent`. `GENTLE_SHELL_CONFIG` selecciona una configuración de lanzador alternativa. Estas variables de entorno deben establecerse en el **Proceso OpenCodex**, no solo en un shell posterior. Los selectores deben ser rutas absolutas; las rutas literales `~` y relativas se niegan. Las banderas `gentle-shell --home` únicas no pueden ser descubiertas por un proxy de fondo.

El modo de enlace o un aliasing de inicio Pi se niega con un remedio de integración Pi; use **Conectar → Pi** para ese archivo compartido en su lugar. OpenCodex no cambia las preferencias del lanzador. Se rechaza una configuración de lanzador ilegible/insegura; la configuración malformada JSON vuelve a ser aislada, coincidiendo con el lanzador. Si mueves una casa conectada, desactívala usando sus selectores originales antes de volver a conectar la nueva. Reinicie Gentle Shell después de una actualización de catálogo. Esta integración conserva la política de exportación de Pi solo loopback y no almacena ninguna clave API real.

"omo" nombra tres productos que comparten la carpeta `~/.omo`. La pestaña **omo** administra el omo basado en Pi (el motor senpi) a través de `~/.omo/agent/models.json`, como en la tabla anterior. El omo basado en Codex (LazyCodex) tiene su propia sección en la misma pestaña, mostrada solo cuando se detecta LazyCodex, descrita en [omo ( Codex / LazyCodex) modelos de rol](#omo-codex--lazycodex-role-models). OpenCode-based omo (oh-my-opencode) mantiene su propia configuración bajo OpenCode; opencodex no lo lee ni lo escribe.

El bloque administrado de omo basado en Pi usa Chat (`api: "openai-completions"`) de forma predeterminada. Chat descarta el razonamiento del paso anterior entre llamadas a herramientas, algo que se nota en los bucles largos de omo. Para que la habilitación y cada actualización escriban el protocolo Responses, añade esta clave al archivo de configuración de opencodex; no está disponible en el dashboard:

```json
{ "omoClientExport": { "api": "openai-responses" } }
```

Reinicia el proxy para cargar el archivo editado (`ocx service restart` si usa un servicio, o `ocx stop` y después `ocx start`). A continuación, actualiza la integración desde **Conectar → omo** en el dashboard. Actualizar por sí solo utiliza la configuración del proxy en ejecución; no vuelve a leer el archivo.

Este ajuste solo afecta a omo. Pi, Gentle Shell y los demás clientes con formato de Pi conservan `openai-completions`. Para volver a Chat, elimina la clave, reinicia el proxy del mismo modo y actualiza **Conectar → omo**. Se ignoran los valores desconocidos. opencodex sigue administrando únicamente `providers.opencodex` en `~/.omo/agent/models.json`; los demás proveedores de ese archivo se conservan.

<a id="qoder-cn-and-workbuddy-editions"></a>

### Qoder CN y ediciones de WorkBuddy

En **Conectar**, habilita **Qoder CN**, **WorkBuddy (CN)** o **WorkBuddy AI** y elige un modelo
OpenCodex en el selector de modelos personalizados del cliente. El proxy debe seguir en ejecución.
La primera habilitación guarda una instantánea. Deshabilitar solo retira lo generado por OpenCodex;
Deshacer restaura la instantánea. Los modelos y ajustes ajenos se conservan. Estas conexiones son
independientes de Qoder Global y de las demás ediciones.

También puedes usar la CLI; cambia `workbuddy` por `workbuddy-ai` o `qoder-cn` para las otras ediciones:

```bash
ocx integration client enable --client workbuddy
ocx export --client workbuddy --json
ocx integration client disable --client workbuddy
```

Qoder CN respeta `QODERCN_CONFIG_DIR`. Las dos ediciones de WorkBuddy usan su variable nativa
`WORKBUDDY_CONFIG_DIR` y, después, `CODEBUDDY_CONFIG_DIR`. Sin esas variables, se usan los directorios
regionales de la tabla. Las rutas deben ser absolutas, `~`, o empezar por `~/` o `~\`. Se admiten
el array antiguo de WorkBuddy y su objeto con una lista `models`. Si una restricción
`availableModels` excluye los modelos OpenCodex, retírala en WorkBuddy antes de habilitar la conexión.
Los ajustes del proyecto pueden tener prioridad sobre los del usuario.

Se requiere un listener loopback sin autenticación; no se copian credenciales del proveedor a estos
clientes. WorkBuddy recibe la URL completa de Chat Completions y las capacidades del catálogo
OpenCodex. Reinicia el cliente o abre una sesión nueva si el selector no se ha actualizado.
Las pruebas de configuración y ciclo de vida no demuestran compatibilidad completa con cada modelo
del proveedor ni con cada versión del cliente.

Doubao Desktop y Devin no tienen actualmente un contrato verificado para configurar proveedores
arbitrarios en esta integración. No ofrecen un interruptor de habilitación; añadir un JSON local
por sí solo no haría que sus selectores lo utilizaran.

Qoder IDE / qodercli admite la exportación y la configuración administrada a través del panel de control y CLI:

```bash
ocx export --client qoder --json
ocx integration client enable --client qoder
ocx integration client disable --client qoder
```

Qoder usa `settings.json` en `QODER_CONFIG_DIR` si esa variable está configurada, o `~/.qoder/settings.json` en caso contrario; rechaza una ruta relativa en `QODER_CONFIG_DIR`. Al habilitar la integración, solo combina `providers.opencodex`, conservando los demás proveedores, modelos personalizados y ajustes. Los modelos se publican una sola vez en el catálogo del proveedor: duplicarlos en `modelConfigs.customModels` hace que Qoder rechace al proveedor. Al actualizar una integración administrada antigua, OpenCodex elimina sus duplicados registrados; las filas editadas por el usuario siguen siendo conflictos. Desactivar elimina las entradas registradas de OpenCodex; restaurar usa las instantáneas existentes. El modelo predeterminado es el primero de la exportación ordenada.

Si `modelConfigs.customModels` ya contiene una fila `opencodex` para un modelo exportado que OpenCodex no escribió, habilitar, actualizar, sobrescribir y desactivar informan un conflicto y dejan el archivo intacto. Elimina o cambia el nombre de esa fila en Qoder y reinténtalo. Las filas de otros proveedores o de modelos ajenos a la exportación no cambian. Los modelos usan su `contextWindow` de catálogo, o 128000 tokens de entrada si no se conoce. Reinicia Qoder tras actualizar una integración existente para recargar su registro de proveedores.

La clave API generada es un marcador no secreto. La integración solo admite acceso mediante loopback y rechaza un enlace autenticado fuera de loopback. Si hay un listener local dedicado sin autenticación, la exportación apunta a él. `ocx sync` y los cambios de catálogo actualizan una integración ya habilitada. Los identificadores que contienen `,` o `]`, como `kimi/k3[1m]`, se exportan igual que los demás.

<a id="t3-code"></a>

## T3 Code

[T3 Code](https://github.com/pingdotgg/t3code) utiliza las CLI de Codex y Claude Code que ya están
instaladas en el equipo. Sus hilos de Codex pasan por opencodex una vez habilitada la
[integración de Codex](/es/guides/codex-integration/), porque T3 Code obtiene la lista de modelos
mediante `codex app-server`, que lee `$CODEX_HOME/config.toml` como cualquier cliente de Codex.
Los modelos enrutados aparecen entonces bajo Codex sin activar ningún interruptor de T3 Code,
siempre que T3 Code ejecute Codex con el mismo directorio que administra opencodex (`CODEX_HOME`,
por defecto `~/.codex`). Una instancia de Codex de T3 Code que use otro directorio no verá ese catálogo.

El interruptor **T3 Code** añade la integración con Claude. Requiere la API Messages, utilizada
en cada turno de Claude: si Messages está desactivada en la página API, se rechazan la habilitación
y la actualización, pero sigue siendo posible deshabilitar la integración.

```bash
ocx export --client t3code --json
ocx integration client enable --client t3code
ocx integration client disable --client t3code
```

Habilitar escribe una instancia de proveedor, `providerInstances.opencodex`, en los ajustes del
servidor de T3 Code y conserva las demás instancias y opciones. Es una instancia de Claude llamada
**opencodex** que ejecuta tu propio binario `claude` con `ANTHROPIC_BASE_URL` apuntando al proxy,
el marcador no secreto `opencodex-proxy` como `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`
explícitamente vacía y `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` para que un bloque env de
`settings.json` en la configuración de Claude no pueda cambiar el destino. Cada modelo enrutado
es un modelo personalizado cuya clave es su selector de opencodex (`provider/model`), que T3 Code
envía literalmente. Aparece bajo **opencodex** en el selector de modelos de T3 Code. T3 Code recarga
el archivo por sí mismo, sin reiniciar; los cambios del catálogo y `ocx sync` actualizan la instancia.

T3 Code guarda sus datos en `T3CODE_HOME` si está definida y, en caso contrario, en `~/.t3`.
Si cambias esa ubicación, configura la misma variable en el proceso de opencodex; se rechazan los
valores relativos. En Windows, usa una ruta completa con unidad (`C:\shared\t3`) o una ruta UNC
(`\\server\share\t3`); se rechazan las rutas sin unidad, como `\shared\t3` o `/shared/t3`.
`~` se expande con respecto al directorio personal efectivo. El marcador no es una credencial:
la integración requiere acceso loopback y rechaza un enlace autenticado fuera de loopback,
salvo que esté habilitado el listener loopback sin autenticación.

Trata la instancia como una configuración administrada por opencodex. Marcar una variable como
**Sensitive** en T3 Code, añadirle un modelo personalizado o desactivarla reescribe el bloque.
El interruptor muestra entonces un conflicto en lugar de sobrescribir la edición; **Reemplazar**
restaura el bloque generado. Para usar otros ajustes, añade tu propia instancia de Claude en T3 Code.

Los catálogos generados incluyen solo modelos habilitados de cada selección de proveedor. Esto se aplica tanto a las descargas como a las integraciones administradas, incluidas Pi y Aside. La lista de modelos de administración aún muestra la lista completa para que pueda habilitar modelos adicionales.

`ocx uninstall` deshabilita las integraciones registradas, incluyendo todos los perfiles de propiedad de Aside, antes de eliminar el estado de recuperación de OpenCodex. La propiedad ilegible, el registro de perfil faltante o una edición en conflicto detiene esa eliminación. La limpieza es secuencial: las inhabilitaciones anteriores no se deshacen cuando una posterior falla. Si la compensación también falla, un archivo cliente puede dejarse en un estado intermedio. Inspeccione los archivos del cliente reportados y las instantáneas de recuperación retenidas antes de volver a intentar; el estado retenido no significa que todos los clientes se restauraron o se dejaron sin cambios.

Para los preajustes incorporados de Gajae, mantenga la opción de enrutamiento en `~/.gjc/agent/config.yml`:

```yaml
modelProfile:
  proxyProvider: opencodex
  proxyMode: always
```

Mantenga su `modelProfile.default` elegido para aplicarlo cuando se inicie la llanura `gjc`. La integración administrada posee solo `providers.opencodex` en `models.yml`; actualizar o deshabilitar ese proveedor no reescribe su opción preestablecida. Actualizar la integración después de cambiar la selección del modelo exportado.

Los modelos GJC con una escalera de razonamiento-esfuerzo compatible exportan `reasoning: true`, `thinking.levels` y `compat.supportsReasoningEffort`, por lo que GJC puede ofrecer una opción de esfuerzo. Los modelos nativos Codex reciben su escalera estándar incluso cuando el catálogo la omite. Los modelos sin una escalera conocida omiten estos campos; `none` y `ultra` no se ofrecen porque `none` no envía ningún esfuerzo y `ultra` se pliega a `max` en el cable. Actualice la integración para actualizar estas opciones de modelo.

La integración administrada de OpenCode controla dos bloques: `provider.opencodex` (OpenCode V1) y `providers.opencodex` (OpenCode V2). Ambos incluyen los mismos esfuerzos de razonamiento y valores predeterminados declarados por modelo. El bloque heredado usa un mapa de variantes y las opciones del modelo; V2 usa la configuración del modelo y un array nativo de variantes. Los dos se escriben y mantienen sincronizados, identifican los mismos proveedores y modelos, y OpenCode V2 los combina en una sola entrada. Aplicar, Actualizar, Desactivar y Restaurar actúan sobre ambos bloques. Los demás proveedores, agentes, atajos de teclado y entradas MCP se conservan.

Ambos fragmentos se construyen a partir de los metadatos del modelo canónico efectivo, al igual que la exportación de Kilo y el lanzador `ocx opencode`. Una anulación explícita personalizada siempre gana, y una escalera que se vacía permanece vacía; una escalera de razonamiento o predeterminada nunca se inventa para un modelo que no declara ninguno. Un límite de contexto autorizado se lleva con un presupuesto de salida al lado: un valor de salida conocido - explícito o de metadatos de catálogo - gana, de lo contrario el esquema requerido 32000 reserva sujeta al contexto, y sin un contexto autorizado se omite todo el bloque de límite. Las capacidades, escalas de esfuerzo, valores predeterminados y un límite de entrada opcional aparecen solo cuando se conocen; el objeto de capacidades nativas del bloque V2 requiere un valor de herramientas conocido, por lo que cuando se desconoce el soporte de la herramienta se omite por completo en lugar de escribirse parcialmente, y la modalidad heredada permanece. Tampoco añade un esfuerzo seleccionable. Las variantes seleccionables anulan el valor predeterminado por modelo: `none` incluido, que se ofrece solo cuando la escalera declarada del propio modelo lo contiene. Sea lo que sea que el cliente seleccione, la política de razonamiento ascendente del proxy aún rige la solicitud que la abandona.

El soporte de DSH administrado tiene un piso de compatibilidad de **DSH 0.1.0-rc.6**. DSH 0.1.7+ lee las rutas del proveedor desde `[id=llm-pi-ai].config.providers.opencodex` en el parche de perfil de escritorio, `$DSH_HOME/profiles/desktop/cordis.patch.yml`, que recarga DSH en caliente. OpenCodex escribe esa fila cuando existe el perfil de escritorio y su parche. Si existe `$DSH_HOME/profiles/desktop/package.json` pero falta `cordis.patch.yml`, Aplicar se niega: cree `cordis.patch.yml` que contiene `[]` (el parche vacío que DSH escribe para un nuevo perfil), luego habilite la integración nuevamente. Solo cuando no hay perfil de Escritorio, OpenCodex usa `llm-pi-ai.providers.opencodex` en `$DSH_HOME/settings.yaml`. OpenCodex solo posee ese fragmento de proveedor: Aplicarlo y Actualizarlo, Desactivarlo lo elimina y Restaurar devuelve una instantánea grabada. Estas operaciones no cambian el modelo predeterminado del usuario o el proveedor nativo `deepseek-official`. La integración DSH administrada es actualmente solo loopback y nunca escribe una credencial real.

MiniMax Code sigue `MINIMAX_DATA_DIR`, luego `MAVIS_DATA_DIR`, antes de caer de nuevo a `~/.minimax`. Su bloque administrado posee solo `custom_provider.opencodex`. No cambia `defaultModel`, la fuente de credenciales MiniMax seleccionada o el inicio de sesión MiniMax del usuario. Elija una entrada `custom_provider:opencodex/<provider/model>` en MCode después de conectarla. La actualización de la integración también actualiza las ventanas de contexto autorizadas por modelo y las opciones de esfuerzo de razonamiento; se omiten las capacidades desconocidas y se conserva el esfuerzo actual de MCode.

Prime Agent sigue a `PRIME_AGENT_CODING_AGENT_DIR` antes de caer de nuevo a `~/.prime/agent`; un valor relativo es rechazado por lo que el proxy y el agente no pueden estar en desacuerdo sobre qué archivo se quiere decir. Su bloque administrado posee solo `providers.opencodex`, por lo que otros proveedores y cualquier `modelOverrides` que haya establecido permanecen intactos. Prime Agent lee `models.json` cuando se inicia una sesión, así que inicie una nueva sesión después de conectarla.

Aside mantiene un catálogo de modelos separado para cada perfil registrado, incluidos los perfiles locales. OpenCodex enumera todos los perfiles registrados, incluidos los perfiles locales, y puede sincronizarlos o controlar un perfil a la vez. Cambiar una integración nunca cambia la cuenta activa de Aside. Una conexión anterior de Aside habilita todos los perfiles de forma predeterminada; las exclusiones individuales sobreviven a las sincronizaciones posteriores.

Una advertencia específica de Aside: la aplicación en ejecución reescribe el propio `models.json`, por lo que se cierra y vuelve a abrir completamente Aside después de aplicar, de la misma manera que Claude Desktop necesita un reinicio. El bloque de Aside es solo loopback y nunca lleva una credencial real.

La integración administrada de Raycast soporta **macOS y Windows**. Custom Providers es una característica **Raycast Pro**: en un plan gratuito, el archivo todavía está escrito, pero `ocx integration client status --client raycast` y la página **Conectar** informan una advertencia, porque Raycast no lo leerá. En macOS o Windows, abra Raycast → Ajustes → AI → **Revelar proveedores Config** una vez que exista la carpeta `ai`. En estas plataformas compatibles, opencodex utiliza esa carpeta como su señal de instalación e informa que el cliente no está instalado hasta que existe. Linux no es compatible, incluso si la carpeta existe.

El campo de estado `aiDirPresent` informa solo si existe `~/.config/raycast/ai`, independientemente de si la aplicación Raycast está instalada o si la plataforma es compatible. No prueba que Raycast esté instalado o sea utilizable. El CLI imprime `plan` en una línea separada y agrega la instrucción de configuración macOS / Windows cuando `aiDirPresent` es falso; `--json` preserva el estado en bruto, incluyendo el bloque anidado `raycast`. Raycast lee `~/.config/raycast/ai/providers.yaml` en macOS y Windows por igual y no honra `XDG_CONFIG_HOME`, por lo que ese camino no es reubicable.

El bloque administrado es un elemento, `id: opencodex`, en la secuencia `providers` del archivo: `name: OpenCodex`, `base_url: http://<host>:<port>/v1`, y cada modelo enrutado con su `abilities`: el exportador establece `tools` y `system_message` a `true` como una convención cliente-exportación, `vision` sigue las modalidades de entrada del catálogo, `reasoning_effort` se establece cuando el modelo tiene una escalera de esfuerzo y `temperature` se apaga para los modelos de razonamiento. Otros proveedores en el archivo se conservan, y deshabilitar elimina solo el elemento OpenCodex. Raycast recoge el cambio tan pronto como se guarda el archivo, no se necesita reiniciar; los modelos aparecen en el selector de modelos de Raycast agrupado bajo **OpenCodex**. Raycast apoya `api_keys` opcional, pero OpenCodex intencionadamente los omite y rechaza objetivos nonloopback o autenticados por la admisión; esta integración no puede suministrar el encabezado de admisión requerido de OpenCodex.

La preferencia privada macOS es solo una sugerencia Pro de asesoramiento; Windows nunca lo lee e informa que el plan es desconocido. La detección de planes no autoriza ni bloquea una escritura. Los metadatos de exportación no tienen un indicador autorizado de soporte de herramientas, por lo que `tools: true` no prueba que todos los modelos enrutados soporten herramientas. Las banderas de visión y esfuerzo siguen los metadatos del catálogo; desactivar la temperatura para una escalera de esfuerzo es un comportamiento de exportación conservador. Se conservan los valores de los proveedores; No se garantiza que el formato YAML y los comentarios sobrevivan. El formato está documentado en [manual.raycast.com/ai/proveedores personalizados](https://manual.raycast.com/ai/custom-providers).

Las exportaciones y descargas del panel de Raycast CLI utilizan la política de destino y admisión del servidor en ejecución, incluido un oyente de bucle de retorno no autenticado configurado. `ocx ensure` no actualiza Raycast desde su instantánea de configuración guardada: eso puede diferir del servidor en ejecución. El inicio del servidor y la sincronización explícita siguen siendo las rutas de actualización del catálogo.


Cursor tiene una pestaña, pero no es uno de estos interruptores. Regular Cursor llama a los puntos finales personalizados desde su propio backend, por lo que un proxy de loopback es inalcanzable sin un túnel público, y la construcción de inferencia privada separada de Cursor se configura dentro de Cursor. La pestaña **Cursor** es de solo lectura: detecta qué compilación está instalada, muestra la URL base y la clave API para pegar en Cursor e informa la última solicitud Cursor realizada al proxy. Véase [Cursor Inferencia privada](/es/guides/cursor-private-inference/).

Los caminos honran el propio entorno de cada cliente anulan donde tiene uno. Para OMP, `OMP_PROFILE` gana sobre `PI_PROFILE` por presencia, incluso cuando está explícitamente vacío. Un perfil con nombre utiliza `PI_CONFIG_DIR` como un nombre de directorio en relación con el hogar del usuario e ignora `PI_CODING_AGENT_DIR`; sin un perfil con nombre, `PI_CODING_AGENT_DIR` gana. OMP soporta cabeceras a nivel de proveedor, pero esta integración inicial es deliberadamente solo bucle; cableado remoto `x-opencodex-api-key` es diferido. Los caminos `HERMES_HOME`, `KIMI_CODE_HOME` y `XDG_CONFIG_HOME` reubicados se siguen de manera similar en lugar de adivinarse. La tabla muestra el valor predeterminado de cada cliente.

Para los modelos nativos OpenAI, el bloque OMP generado selecciona su nivel de modelo Responses API, preservando la entrada de imágenes y los controles de esfuerzo de razonamiento. Los modelos enrutados conservan el dialecto Chat Completions del proveedor para que sus adaptadores existentes sigan siendo compatibles.

OpenClaw tiene varios, y hacen diferentes trabajos. `OPENCLAW_CONFIG_PATH` selecciona el archivo; `OPENCLAW_STATE_DIR`, `OPENCLAW_PROFILE` y `OPENCLAW_HOME` seleccionan el directorio de estado, que es también lo que la detección observa, por lo que un perfil o una casa reubicada aún se lee como instalado, mientras que una anulación de ruta de configuración mueve solo el archivo. Si todavía está en el diseño anterior `.clawdbot`, también se encuentra: el directorio moderno gana cuando existe y el heredado se usa cuando es el único allí.

En Windows, las opciones que requieren rutas absolutas deben incluir una letra de unidad
(`C:\Users\me\client`) o un recurso UNC (`\\server\share\client`). Se rechazan las rutas
que parten de la raíz sin unidad, como `\Users\me\client` o `/client/config`, porque dependen
de la unidad actual. Un selector que admita `~` lo expande respecto al directorio personal efectivo;
Gentle Shell no expande `~`.

Estos deben ser **Caminos absolutos** o comenzar con `~`. Se rechaza uno relativo en lugar de resolverlo, porque significaría cualquier directorio en el que se inicie cada proceso, y esa ruta se almacena con la copia de seguridad, por lo que tiene que nombrar el mismo archivo mañana que hoy.

opencodex lee esto desde su propio entorno. Si su puerta de enlace se ejecuta con un perfil o una casa reubicada, inicie opencodex con el mismo conjunto de variables, o seguirá correctamente una instalación diferente.

<a id="the-other-five-surfaces-are-not-switches"></a>

## Las otras cinco superficies no son interruptores

**API Llaves** administra las credenciales propias de opencodex y no es un cliente en absoluto. **Codex CLI** es cableado por el propio servicio proxy - a partir de opencodex se aplica, deteniéndolo restaura el enrutamiento nativo - por lo que no hay nada que cambiar por archivo. **Claude** mantiene su propio indicador de habilitación y el flujo Guardar/Aplicar del Escritorio, y **Grok Build** mantiene su valla de modelo select-then-apply. Esas semánticas son anteriores a esta característica y no cambian. **Cursor** no escribe nada en absoluto: su pestaña muestra la detección, los valores de la puerta de enlace y la última solicitud vista, y el resto ocurre dentro de Cursor Private Inference.

<a id="rollback"></a>

## Reversión

Cada escritura exitosa toma una instantánea de su archivo *primero*, por lo que el estado que tenía siempre es recuperable:

- **Deshacer** aparece en la operación más reciente cuando su archivo aún coincide con lo que escribimos.
- **Restaurar este punto...** aparece en operaciones anteriores, o cuando el archivo cambió después de esa operación. Restaurar a través de tal cambio pide una segunda vez antes de reemplazar sus ediciones más recientes, y también las respalda, para que la propia restauración también se pueda deshacer.
- Se mantienen 10 copias de seguridad por cliente. Más allá de eso, los archivos de instantáneas más antiguos se eliminan y sus filas de historia leen **La copia de seguridad expiró**.

Desactivar elimina únicamente las entradas que opencodex registró como propias. Si el archivo se ha modificado después, el resultado depende de si esas entradas siguen intactas y del formato del archivo. En las configuraciones JSON estricto (OpenCode y Pi), una edición **junto a** nuestro bloque, como añadir un servidor MCP o un proveedor propio, se muestra como **Actualización necesaria**: al actualizar, se conservan esas entradas, aunque puede normalizarse el formato. La excepción son los valores que JSON no puede reescribir con exactitud: un número no finito como `1e999`, uno que se redondearía al reescribirlo (un entero muy grande o un número tan pequeño que se convertiría en cero), `-0`, una clave repetida en un objeto o un anidamiento de más de 1000 niveles. En esos casos, el interruptor se bloquea para evitar cambios o pérdidas silenciosas.
**OMP, DSH y Hermes** también conservan las ediciones ajenas al bloque: sus escritores modifican únicamente los rangos de proveedor que administran, byte a byte, sin reescribir el resto del archivo. En los demás formatos que admiten comentarios (OpenClaw, Kimi Code, gjc, MiniMax Code y Raycast: JSON5 o TOML reescritos como documentos completos, o YAML genérico sin preservación del original), o si se han editado las propias entradas administradas, el interruptor se bloquea y la desactivación se rechaza. El bloque administrado permanece en el archivo; opencodex no intenta adivinar qué cambios pertenecen al usuario.

Esa cerradura ya no es un callejón sin salida. Un cliente en conflicto muestra **Sustituir** al lado de su interruptor, tanto en la tarjeta de visión general como en la propia página del cliente. Reemplaza lo que contiene nuestra configuración con el bloque opencodex que escribiría, y pregunta primero: el diálogo nombra el archivo, dice lo que se pierde y señala la instantánea que permite deshacer el reemplazo. El switch en sí permanece bloqueado, porque el switch no puede saber qué ediciones pretende mantener, solo usted puede decirlo. Nada más está relajado: un archivo que no podemos analizar, o uno cuya estructura no podemos razonar, todavía se niega.

<a id="hermes-session-affinity"></a>

## Afinidad de sesión Hermes

El bloque generado `providers.opencodex` incluye `session_affinity_header: session-id` para todos los modelos. Conserva ese valor salvo que quieras únicamente correlacionar registros. Si cambias `session_affinity_header` a `x-hermes-conversation-id`, Hermes envía ese encabezado en lugar de `session-id`. OpenCodex usa `x-hermes-conversation-id` solo como alternativa para correlacionar registros de solicitudes, no como identidad para enrutamiento nativo ni para terminar turnos. Por tanto, el cambio elimina la afinidad de sesión nativa y la asignación de carril, aunque permite correlacionar los bucles del agente en los registros. El ajuste nombra un encabezado; Hermes aporta el identificador dinámico de la conversación. OpenCodex no escribe un identificador estático compartido ni cambia `api_mode` para activar la afinidad.

Utilice una versión de Hermes compatible con [Opciones de solicitud por proveedor](https://hermes-agent.nousresearch.com/docs/user-guide/configuring-models#per-provider-request-options). Las versiones anteriores pueden ignorar o descartar la opción; una configuración válida por sí sola no prueba que Hermes envíe el encabezado. El aislamiento de la conversación, el linaje de compactación y las solicitudes auxiliares / infantiles siguen la semántica de afinidad de Hermes. Esta configuración no garantiza una tasa de éxito de caché particular.

Para una integración administrada existente, abra **Conectar → Hermes**, revise **Aplicar** y confirme la actualización. Hasta entonces, muestra **Actualización necesaria** y la actualización implícita del catálogo lo deja sin cambios, incluida su lista de modelos. Leer la página no actualiza la configuración. Después de aplicar, la actualización normal del catálogo se reanuda y conserva la configuración; **Sustituir** también lo incluye.

Si ya agregó exactamente `session_affinity_header: session-id` dentro del bloque administrado, Apply puede adoptarlo cuando todas las demás configuraciones administradas aún coincidan con el registro de propiedad. Esta es la estrecha excepción a la regla de conflicto anterior: otras ediciones, un nombre de encabezado diferente o un bloque sin un registro de propiedad coincidente aún requieren resolución de conflictos. La configuración y los comentarios YAML no relacionados permanecen intactos, y el flujo de trabajo de instantánea y restauración existente se aplica a la actualización.

<a id="hermes-profiles"></a>

## Perfiles de Hermes

Hermes mantiene un directorio propio para cada perfil de bot. El perfil predeterminado utiliza
`~/.hermes/config.yaml` (`%LOCALAPPDATA%\hermes\config.yaml` en Windows, o `$HERMES_HOME/config.yaml`),
y cada perfil creado con `hermes profile create <name>` utiliza
`<Hermes home>/profiles/<name>/config.yaml`. Consulta la
[guía de perfiles de Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/profiles).

Cuando existen perfiles con nombre, **Conectar → Hermes** muestra cada uno con su estado. Selecciona
un perfil para aplicar, desactivar, reemplazar o restaurar OpenCodex solo en ese perfil. Cada uno
conserva sus propias copias de seguridad e historial de restauración; los demás no cambian. Cada perfil
conserva su `model.default` y los otros proveedores: OpenCodex solo añade `providers.opencodex`.
Si no hay perfiles con nombre, la página funciona como antes y modifica el perfil predeterminado.

Los cambios de catálogo y `ocx sync` solo actualizan automáticamente el perfil predeterminado resuelto desde el entorno del proxy en ejecución, incluido `HERMES_HOME`. Los perfiles con nombre conservan su catálogo anterior. Tras cambiar la selección de modelos, abre **Conectar → Hermes**, selecciona cada perfil que muestre **Actualización necesaria**, revisa los cambios y confirma **Aplicar**. La CLI no ofrece un selector de perfiles con nombre.

Si el catálogo no cambió, editar comentarios o ajustes fuera de `providers.opencodex` mantiene el estado **Actualizado** y no modifica ni el archivo ni la referencia de propiedad guardada. Si hay un catálogo pendiente, la actualización automática rechaza cualquier archivo Hermes editado desde el último Aplicar, incluidas esas ediciones ajenas al bloque. Cuando aparezca **Actualización necesaria**, revisa y aplica el catálogo pendiente para reanudar las actualizaciones automáticas. Aplicar un catálogo sin cambios no hace nada ni acepta una nueva referencia del archivo.

La API de administración selecciona un perfil mediante `profile=<name>` en `/api/client-integrations/hermes`
y mediante `client=hermes&profile=<name>` en los endpoints de vista previa, historial y restauración;
`GET /api/client-integrations/hermes/profiles` enumera los perfiles. Un directorio dentro de `profiles/`
solo cuenta si Hermes lo mostraría: debe tener un nombre válido, un archivo de identidad de Hermes como
`config.yaml` o `SOUL.md` y ningún marcador de eliminación. No se ofrecen perfiles alcanzados mediante
enlaces simbólicos o junctions. Si posteriormente `HERMES_HOME` apunta a otro directorio de Hermes,
OpenCodex rechaza un perfil con el mismo nombre allí hasta que desconectes el original, para conservar
el seguimiento de todos los archivos que modificó.

<a id="preview-and-confirm-changes"></a>

## Vista previa y confirmación de cambios

En el panel, Aplicar, Reemplazar, Deshabilitar y Restaurar comienzan con una vista previa. El cuadro de diálogo muestra exactamente qué configuración administrada cambiará, incluidas las rutas de cambio limitadas y si cada cambio agrega, actualiza o elimina un valor. Revisa ese plan antes de confirmarlo.

Cuando un plan informa que no hay cambios, significa que el documento del cliente administrado ya tiene el estado solicitado. Para un perfil de Aside seleccionado, la confirmación puede guardar la preferencia de sincronización de ese perfil aunque el documento administrado no cambie.

Si el archivo cambia después de revisarlo, la escritura se rechaza como obsoleta. El cuadro de diálogo reemplaza el plan anterior por el actualizado y le pide que confirme nuevamente; nunca vuelve a intentar la escritura automáticamente. Si una vista previa no está disponible temporalmente, vuelva a cargar la página normalmente e inicie la acción de nuevo.

Aside utiliza la misma vista previa y flujo de confirmación para un perfil seleccionado a la vez. **Sincronizar todos los perfiles** sigue siendo una acción masiva separada y no está vinculada a una vista previa combinada.

<a id="what-to-expect-honestly"></a>

## Qué esperar, honestamente

Si una ruta administrada generada no puede representarse de forma segura, ese cliente muestra un estado inseguro y la vista previa rechaza la operación. Los intentos de aplicar, sobrescribir o desactivar devuelven HTTP 409 sin cambiar la configuración. Los demás clientes siguen disponibles.

**Los archivos de configuración administrados están limitados a 4 MiB (4,194,304 bytes UTF-8).** El lector de integración compartida rechaza los archivos más grandes como inseguros para leer, y el escritor rechaza una configuración combinada que excede el mismo límite con `write_failed`, dejando la configuración original sin cambios. El marcador de recuperación de Cline también tiene este límite; incluye el contenido de antes y después de ambos archivos más metadatos, por lo que Cline puede alcanzar el límite incluso cuando cada archivo individual es menor de 4 MiB.

Realice una copia de seguridad de la configuración del cliente usted mismo, luego elimine las entradas innecesarias o reduzca la lista de modelos exportados antes de volver a intentar. **Sustituir** no pasa el límite. Si la configuración debe permanecer más grande, adminístrela manualmente en lugar de usar el interruptor Conectar.

**El formato generalmente no se conserva.** La aplicación analiza una configuración y la vuelve a escribir, por lo que JSON, JSON5 y TOML pueden reformatearse y los comentarios en JSON5 o TOML se pierden. OMP, DSH y Hermes son las excepciones: OMP y Hermes parche sólo `providers.opencodex`. DSH corrige solo `[id=llm-pi-ai].config.providers.opencodex` en el parche de perfil de escritorio, o `llm-pi-ai.providers.opencodex` en `settings.yaml` cuando no hay perfil de escritorio. Sus redactores de YAML conservan comentarios de proveedores no relacionados y formatean byte por byte. Si ese rango de fuente exacto no se puede identificar de manera segura, la operación se niega. Para otros clientes, utilice Restaurar cuando necesite los bytes de archivo anteriores: la instantánea es una copia literal.

**Si un valor no puede ser reescrito fielmente, el interruptor se niega.** El viaje de ida y vuelta cubre los tipos de valor que estos formatos usan en la práctica, y donde no lo hace - un archivo TOML usando `inf` o `nan`, por ejemplo, que el analizador sintáctico disponible para nosotros no puede leer con precisión - aplicando paradas y lo dice en lugar de escribir un valor cambiado y llamarlo éxito. Verá el archivo con nombre y nada en el disco se habrá movido. La edición de ese archivo a mano todavía funciona; es solo nuestra reescritura automática la que disminuye.

Las fechas y horas TOML también rechazan las reescrituras administradas: el paso de combinación convertiría estos valores escritos en cadenas cotizadas. Esto incluye valores dentro de matrices y tablas en línea. Las cadenas de fecha citadas siguen siendo compatibles; una fecha no citada debe conservarse editando la configuración manualmente.

**Pi, Kimi Code, gjc, MiniMax Code, Prime Agent, Aside, Raycast, omo y la integración DSH administrada solo funcionan contra un enlace de bucle.** Los primeros cuatro no tienen campo de configuración para el encabezado `x-opencodex-api-key` que requiere un enlace sin bucle. DSH tiene un mapa de cabeceras genérico, pero rc.6 no documenta esa cabecera de admisión dedicada como un contrato de integración compatible, por lo que el escritor administrado falla en lugar de adivinar. El bloque de proveedor de Prime Agent acepta encabezados, pero el cableado remoto de credenciales se aplaza desde su integración inicial. Dales acceso de loopback a través de un túnel SSH o un reenviador local que agregue el encabezado.

**La integración OMP generada también es deliberadamente solo bucle.** OMP admite encabezados a nivel de proveedor, pero esta integración inicial no emite cableado remoto de credenciales `x-opencodex-api-key`. La configuración remota manual de OMP está fuera de la integración administrada por ahora.

**Kimi El código no puede contener una referencia de entorno,** por lo que su configuración lleva un marcador de posición `opencodex-loopback` en lugar de una clave. Nunca se escribe una credencial real en ninguna configuración de cliente.

**Para `ocx opencode`, el proveedor del lanzador bloquea la victoria.** Ese lanzador inyecta `provider.opencodex` y `providers.opencodex` a través de `OPENCODE_CONFIG_CONTENT`, que supera a las mismas entradas en el disco - el resto de su configuración de código abierto todavía se aplica como de costumbre. Esos bloques se construyen a partir de los mismos metadatos de modelos canónicos efectivos que las exportaciones, por lo que el lanzador y la integración administrada describen los mismos modelos, límites y opciones de razonamiento. El interruptor aquí es lo que importa cuando se inicia `opencode` directamente.

<a id="from-the-terminal"></a>

## Desde la terminal

Las mismas operaciones están disponibles sin rumbo:

```bash
ocx integration client status
ocx integration client enable --client hermes
ocx integration client disable --client hermes
ocx integration client history --client hermes
ocx integration client restore --op <opId> [--confirm-drift]
```

<a id="opt-in-alias-model-names"></a>

### Nombres de modelo con alias opcionales

Hermes y Command Code aceptan `--model-names alias|routed`. El valor predeterminado es
`routed`, independientemente de `preferModelAliasIds`. Por ejemplo:

```bash
ocx export --client hermes --model-names alias --json
ocx integration client preview --client hermes --operation apply --model-names alias --json
ocx integration client enable --client hermes --model-names alias
ocx integration client enable --client commandcode --model-names alias
```

La exportación es una vista previa: usa un catálogo actual ya cargado y no escribe configuración
del cliente ni estado de integración. Si ese catálogo no está disponible, cárgalo por separado
y vuelve a intentarlo. `--out` escribe explícitamente un archivo de exportación; no conecta el cliente.

La conexión guarda el modo. Omitir la opción al aplicar después, también desde el panel, lo conserva;
`--model-names routed` lo restablece explícitamente. Un alias cualificado como `AC/AC-model-x`
sustituye a `acme/vendor-model-x` solo si el enrutador demuestra que ambos llegan al mismo proveedor
y modelo. Si faltan alias, son inseguros o hay colisiones, se usa la clave enrutada.
Los combos conservan sus claves actuales.

Tras cambiar el nombre de un alias o eliminarlo, ejecuta `ocx sync` o aplica explícitamente la conexión:
la siguiente actualización administrada que termine correctamente sustituirá la clave anterior por
el alias recién validado o por la clave enrutada. Editar alias no actualiza los archivos del cliente
de forma atómica. La actualización sigue siendo idempotente y rechaza ediciones ajenas. Si un alias
cambia mientras Aplicar o la actualización esperan, se rechaza la escritura; reintenta con el catálogo
actual. Cada perfil con nombre de Hermes guarda su propio modo; la actualización automática del
catálogo solo cubre el perfil predeterminado, por lo que los perfiles con nombre requieren Aplicar
explícitamente. Los demás exportadores conservan los nombres enrutados.

<a id="preview-and-bind-a-terminal-write"></a>

### Previsualizar y enlazar una escritura de terminal

Los comandos directos existentes siguen siendo compatibles. Para vincular una escritura a una observación revisada, inspeccione el estado y guarde primero una vista previa:

```bash
ocx integration client preview --help
ocx integration client status --client hermes --json
ocx integration client preview --client hermes --operation apply --json > hermes-preview.json
```

Revisa `state`, `foreignEdit`, los cambios estructurales de `changes`, `canApply` y `willChange`. Una vista previa válida que rechaza aplicar el plan, o que no propone cambios, termina con código 0: la inspección tuvo éxito y no se aplicó nada. El plan no contiene valores secretos ni el diff completo de los archivos. Usa la evidencia pasiva del catálogo ya disponible y nunca actualiza los proveedores de forma oculta. Si el catálogo no está disponible, resuelve ese problema por separado antes de solicitar otra vista previa.

Solo después de revisar un plan aplicable y elegir la escritura:

```bash
PLAN_FINGERPRINT="$(jq -er 'select(.canApply == true) | .fingerprint' hermes-preview.json)"
ocx integration client enable --client hermes --plan-fingerprint "$PLAN_FINGERPRINT" --json
ocx integration client status --client hermes --json
```

La huella sirve para comprobar la concurrencia; no concede autorización. La confirmación acepta `pN:` seguido de 32 dígitos hexadecimales en minúscula. Un plan rechazado con `pN:unbound` no se puede confirmar. Repite exactamente el cliente, la acción, el perfil y las opciones de la vista previa. La operación `overwrite` corresponde a habilitar con `--overwrite-conflict`; `disable`, a deshabilitar. Si la observación quedó obsoleta, la confirmación sale con código 5, explica en stderr cómo obtener una nueva vista previa y deja stdout vacío. Nunca adopta automáticamente una huella de reemplazo ni reintenta. Los demás errores usan los códigos 2 para uso incorrecto, 4 para recurso no encontrado y 1 para errores de ejecución o datos mal formados, con un mensaje seguro en stderr en lugar de un objeto de error JSON.

<a id="inspect-restoration-drift-before-replacing-it"></a>

### Inspeccione la deriva de restauración antes de reemplazarla

Utilice una historia real opId; `op-example` abajo es ficticio:

```bash
ocx integration client history --client aside --profile 1 --json
ocx integration client restore --op op-example --client aside --profile 1 --preview --json
```

Si se rechaza la deriva, inspeccione las ediciones. Al reemplazarlos se pretende explícitamente, vista previa con `--confirm-drift`, revisar, a continuación, vincular esa misma intención:

```bash
ocx integration client restore --op op-example --client aside --profile 1 --preview --confirm-drift --json > restore-preview.json
```

Después de la revisión:

```bash
RESTORE_FINGERPRINT="$(jq -er 'select(.canApply == true) | .fingerprint' restore-preview.json)"
ocx integration client restore --op op-example --client aside --profile 1 --confirm-drift --plan-fingerprint "$RESTORE_FINGERPRINT" --json
ocx integration client status --client aside --profile 1 --json
```

Aparte de vista previa / escrituras vinculadas requieren un perfil, no un objetivo agregado. La restauración genérica omite el cliente/perfil; el servidor deriva el cliente no auxiliar de opId. El plan devuelto no contiene opId o todas las entradas de comandos originales, así que mantenga ese contexto. `--preview` no puede combinarse con `--plan-fingerprint`.

<a id="retire-an-old-recovery-record"></a>

### Retirar un registro de recuperación antiguo

Esto retira permanentemente el registro y la copia de seguridad; no restaura ni deshabilita la integración. Después de inspeccionar el historial y elegir perder ese punto de recuperación:

```bash
ocx integration client history remove --op op-example --client aside --profile 1 --yes --json
ocx integration client history --client aside --profile 1 --json
```

Utilice el opId seleccionado. Ningún selector se dirige a la revista global; `--client aside`
direcciones agregar el historial de Aside y opcional `--profile` Lo acorta. Otro cliente Los selectores son rechazados para su eliminación. La última fila está protegida. Un recibo con
`snapshotRemoved:false` se ha comprometido la jubilación con limpieza incompleta y salida 1; no es reversión y no debe desencadenar la eliminación repetida. `journal remove` Es un alias.

`--overwrite-conflict` es la forma terminal de **Sustituir**:

```bash
ocx integration client enable --client zcode --overwrite-conflict
```

Como `--confirm-drift`, nunca se asume - sin él un conflicto todavía se rechaza. Se aplica solo a `enable`; forzar un *desactivar* sobre un conflicto eliminaría un bloque que nunca escribimos, por lo que la combinación es rechazada.

Para MiniMax Code, conecte el proveedor una vez y ejecute a través del envoltorio verificado:

```bash
ocx integration client enable --client mcode
ocx mcode
```

Una vez conectados, `ocx sync` y `POST /api/sync` actualizan los catálogos administrados de MCode, Pi, Aside, Raycast, omo, OpenCode, Kilo y Hermes con la selección de modelos, ventanas de contexto y niveles de razonamiento actuales. Los cambios de catálogo en segundo plano también actualizan el perfil predeterminado de Hermes conectado sin intervención; si el archivo está editado y hay un catálogo pendiente, la actualización se rechaza y se informa. Una integración nunca conectada o desactivada permanece intacta. Los perfiles con nombre requieren [Aplicar explícitamente](#hermes-profiles). Al iniciarse, el proxy actualiza un catálogo Raycast bajo su control. Los cambios de visibilidad, proveedor o preajuste también actualizan los catálogos conectados de Pi, Aside, Raycast, omo, OpenCode, Kilo y Hermes.

Los bloques ausentes, modificados fuera de OpenCodex o inseguros no se alteran, ni tampoco los bloques administrados que hayas eliminado manualmente. Un perfil Aside habilitado tiene una excepción: si existe su directorio de cuenta y nunca tuvo un bloque administrado, la sincronización puede crear el primero si la ranura está vacía. Una conexión Aside previa habilita este comportamiento de forma predeterminada para todos los perfiles registrados. No se crean directorios de cuenta ausentes ni se sustituyen bloques manuales. Una actualización rechazada o superpuesta se informa por cliente. Inicia una sesión nueva de Pi, OpenCode o Kilo, o cierra Aside por completo y vuelve a abrirlo para que cargue el archivo actualizado. La actualización de Aside requiere un [proxy en ejecución compatible](#aside-profile-controls).

Si Models informa **"Selección de modelo guardada"** junto con una advertencia de actualización del cliente, la selección ya está guardada; no se pudieron actualizar uno o más archivos de cliente. La advertencia nombra al cliente afectado y al perfil de Aside, cuando corresponda, y explica el rechazo. Abra **Conectar** para inspeccionar ese cliente o perfil antes de comenzar una nueva sesión. Resuelva el problema reportado, luego vuelva a intentar `ocx sync`; una operación de superposición debe terminar primero. Si la advertencia incluye una ruta de respaldo o dice que la recuperación no terminó, inspeccione ese estado de recuperación antes de volver a intentarlo. Una selección exitosa guardar solo no confirma la recuperación de archivo de cliente.

La plataforma separada MiniMax CLI (`mmx`) no es una integración de archivos. Sus comandos de texto usan el punto final compatible con MiniMax de Anthropic, por lo que OpenCodex proporciona un lanzador aislado de credenciales y solo loopback:

```bash
ocx mmx text chat --model anthropic/claude-opus-5 --message "Hello"
ocx mmx text repl --model openai/gpt-5.6-sol
```

Sólo `mmx text chat` y `mmx text repl` están representados. Ejecute los comandos `mmx` para MiniMax -native image, video, speech, music, visión, search, quota, auth, config, file y update. El contenedor utiliza una configuración temporal que contiene solo un marcador de posición de bucle de retroceso no secreto; nunca carga sus credenciales `~/.mmx` OAuth o API -clave, y rechaza las anulaciones `--api-key`, `--base-url` y `--region`. Consulte [MiniMax clientes](/es/guides/minimax/) para conocer el flujo de trabajo y los límites completos.

`--confirm-drift` nunca se asume. Si el archivo cambió después de la operación que está restaurando, el comando se niega y le dice, porque reemplazar sus ediciones más recientes es su decisión de hacer.

Los detalles del cliente se verificaron con el formato de configuración de cada proyecto; consulte las notas de investigación en `devlog/_fin/260802_client_toggle_api/002_client_toggle_matrix.md` para ver qué se verificó y cuándo.

<a id="aside-profile-controls"></a>

## Aside controles de perfil

Aparte de los controles de perfil y la actualización de Aside realizada por `ocx sync` requieren un proxy ocx en ejecución que admita las API de perfil de Aside. La actualización del CLI por sí sola no actualiza un proxy que ya se esté ejecutando. Si el proxy no está disponible o es demasiado antiguo, la operación Aside no puede completarse; el CLI nunca vuelve a escribir los archivos de perfil Aside localmente.

Actualice la instalación ocx utilizada por el proxy y luego reinicie el proxy (o inícielo si se detiene). Reintentar `ocx sync` o el comando de perfil. Después de que los archivos de perfil se actualicen correctamente, salga completamente y vuelva a abrir Aside para que cargue los nuevos catálogos.

```bash
ocx integration client status --client aside --json
ocx integration client enable --client aside
ocx integration client disable --client aside --profile 1
ocx integration client history --client aside --profile 1
ocx integration client restore --client aside --profile 1 --op <opId>
```

El número de perfil es el ID de cuenta mostrado por el comando status. Omitir `--profile` en una palanca de Aside aplica el estado deseado a cada perfil registrado. Un cambio de perfil deja a los hermanos sin cambios. La configuración de sincronización deseada se guarda antes de que cambie el archivo; se informa del estado real y de cualquier rechazo para cada perfil. Un resultado parcial de una operación sobre varios perfiles no significa que todos se hayan actualizado: la CLI termina con un código distinto de cero. Deshacer restaura la intención de sincronización del perfil seleccionado, así como su archivo, por lo que una sincronización posterior no invierte silenciosamente Deshacer.

El [perfil API](/es/reference/management-api/#aside-profile-controls) devuelve HTTP 200 para una operación a granel exitosa y HTTP 207 con `ok: false` si cualquier perfil se niega. Inspeccione cada entrada en `results`: los perfiles exitosos no se revierten cuando otro falla. La configuración deseada permanece guardada, así que vuelve a intentarlo después de abordar el perfil afectado en lugar de asumir que todo el cambio falló. Si se produce un error al guardar esas configuraciones, no se cambiarán los archivos de perfil.

Para una actualización específica de los perfiles de Aside elegibles, en lugar de una amplia sincronización de catálogo:

```bash
ocx integration client sync --client aside --json
ocx integration client status --client aside --json
```

Esto utiliza el propietario certificado existente de Aside y no tiene un selector de perfil o reserva local. `{results:[]}` sale de 0 y significa que no hay perfiles elegibles, no escrituras aplicadas. Cualquier fila fallida devuelve la salida 1 mientras los perfiles exitosos permanecen actualizados. Preservar el rechazo por perfil, residual y por separado etiquetaron la información de copia de seguridad redactada; inspeccionar el perfil afectado antes de volver a intentar. Esta actualización es independiente del flujo de trabajo de previsualización/mutación vinculado de cada perfil.

Sincronizar actualiza solo los perfiles cuya preferencia de sincronización está activada, por lo que un resultado vacío no es un error. Si `ocx integration client status --client aside` muestra un perfil como `off (stale)`, el estado imprime los comandos para volver a conectarlo: revise `ocx integration client preview --client aside
--operation apply --profile N` y ejecute `ocx integration client enable --client aside --profile N` solo si la vista previa permite el cambio y usted lo acepta. Nada se vuelve a habilitar automáticamente. Un bloque `asideProfileSync` mal formado en `config.json` desactiva cada perfil y registra una advertencia cuando se carga la configuración.

Cada perfil tiene una propiedad e historia separadas. Se rechazan las ediciones de usuarios existentes, las rutas inseguras y los catálogos vinculados; los controles explícitos existentes de sobreescritura y confirmación de deriva permanecen disponibles. Sal completamente de Aside y vuelve a abrirlo para que cargue los archivos de modelos actualizados.


<a id="zcode-314-and-later"></a>

## ZCode 3.14 y posteriores

De forma predeterminada, ZCode 3.14 almacena sus proveedores personalizados en `~/.zcode/v2/provider_config.json` y deja `~/.zcode/v2/config.json` accesible solo a través de una importación de una sola vez que se ejecuta cuando falta el nuevo archivo. ZCode crea el nuevo archivo la primera vez que se ejecuta, por lo que en cualquier instalación que se haya lanzado, la importación ya está gastada y una escritura a `config.json` no alcanza nada.

ZCode puede reubicar su raíz de datos con un `dataBaseDir` absoluto en `~/.zcode/v2/setting.json`. Este archivo bootstrap siempre se queda bajo la casa predeterminada; el almacén del proveedor se mueve a `<dataBaseDir>/.zcode/v2/provider_config.json`. `ZCODE_DATA_DIR` tiene prioridad y nombra directamente la raíz `.zcode`, mientras que `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` tiene prioridad para el archivo del proveedor. `ZCODE_DATA_BASE_DIR` es un selector nativo separado y no es un alias para `ZCODE_DATA_DIR`.

Los ajustes de arranque ilegibles, mal formados o relativos dejan la raíz activa desconocida. El arranque debe ser un archivo regular de como máximo 4 MiB; los enlaces simbólicos y los archivos especiales se rechazan durante el descubrimiento de la ruta de integración y exportación. Repare el archivo bootstrap o proporcione un `ZCODE_DATA_DIR` explícito para seleccionar la raíz de datos deseada. Aplique, sobrescriba y actualice la basura con un mensaje de reparación en lugar de reclamar una escritura heredada exitosa. Un archivo de proveedor explícito existente todavía puede establecer el almacén activo. La propiedad registrada en la configuración o tienda predeterminada original mantiene su trayectoria, huellas dactilares e historial de deshacer; deshabilitar elimina ese bloque original antes de que una habilitación posterior pueda usar la tienda reubicada. Un viejo deshacer también se niega, mientras que otro camino es dueño de la integración. Si un selector explícito anterior ya no identifica el archivo propio, restaure ese selector antes de deshabilitarlo; opencodex retiene el registro y se niega a abandonar el bloque.

opencodex escribe `provider_config.json` directamente donde puede. Al habilitar la integración se agrega la regla del proveedor `opencodex` a ese archivo, una actualización del catálogo lo actualiza y la desactivación elimina exactamente lo que opencodex puso allí. Todas las demás reglas en el archivo se dejan solas, incluida una regla que otro proveedor mantiene para un ID de modelo que también aparece en la nuestra. Una regla que lleva el id `opencodex` que opencodex no escribió es un conflicto más bien que algo para asumir; resolverlo en ZCode o usar el sobrescribir explícito.

Un almacén de proveedor ilegible o que no es de archivos también se niega a escribir; no se trata como un almacén ausente que permite la importación heredada.

Otras dos situaciones aún se niegan en lugar de escribir. Un bloque opencodex aplicado antes de que ZCode moviera su tienda mantiene la integración en `config.json`: desactívelo allí primero, luego habilitelo nuevamente para escribir la nueva tienda. Y un `provider_config.json` cuyo `schemaVersion` no es uno opencodex ha observado se informa en lugar de fusionarse, porque ese archivo contiene todos los proveedores que ZCode tiene y afirmar una forma en él cambiaría una opción silenciosa por una pérdida silenciosa. El estado nombra el archivo que ZCode lee cuando la integración no lo está escribiendo.

En ese segundo caso, agregue el proveedor en la configuración de ZCode: URL base `http://127.0.0.1:10100/v1` (ajuste el puerto a su enlace), cualquier clave no vacía y los ID de modelo de `ocx export --client zcode`. La eliminación de `provider_config.json` para volver a activar la importación de ZCode no es compatible: descarta todos los proveedores que ZCode mantiene allí.

## Cline CLI

Esta integración se dirige al almacén de proveedores CLI /shared SDK de Cline, cuyo esquema nativo tiene `version: 1`. La extensión `globalState` /secret no se migra ni se detecta como esta integración. Ejecute Cline una vez para inicializar su directorio de configuración.

**Detenga Cline antes de habilitar, sincronizar, deshabilitar o restaurar la integración.** OpenCodex escribe `providers.opencodex` tanto en `providers.json` como en el hermano `models.json`. El primer archivo contiene la conexión OpenAI Responses con un marcador de posición de bucle de retroceso no secreto; el segundo contiene el catálogo de modelos enrutados filtrados, incluyendo el contexto disponible y los metadatos de imagen. Las entradas de proveedor existentes y la selección de proveedor predeterminada permanecen sin cambios.

```bash
ocx integration client list --json
ocx integration client enable --client cline
ocx integration client history --client cline
ocx integration client restore --op <operation-id>
```

Después de habilitar, reinicie Cline y seleccione OpenCodex, o inicie con `cline --provider opencodex --model <provider/model>`. Los cambios de catálogo externos se leen cuando Cline se reinicia. Cline se excluye de la actualización de catálogo desatendida; después de cambiar la selección del modelo enrutado, detenga Cline y ejecute `ocx sync` o habilite la integración nuevamente para actualizarla. Un modelo seleccionado se conserva mientras sigue siendo encaminado y borrado si se elimina del catálogo exportado.

`CLINE_PROVIDER_SETTINGS_PATH` anula el archivo principal. De lo contrario, `CLINE_DATA_DIR` selecciona el directorio de datos, luego `CLINE_DIR` selecciona la raíz, luego se usa `~/.cline`. El archivo de modelo es siempre `models.json` junto al archivo de proveedor seleccionado. Las anulaciones deben ser absolutas o comenzar con `~`. El comando Mirror-local Cline `--config` traza con `CLINE_PROVIDER_SETTINGS_PATH` cuando se inicia OpenCodex. Se rechaza una ruta primaria llamada `models.json` porque los archivos deben ser distintos.

Cada reemplazo de archivos es atómico, pero ninguna operación del sistema de archivos reemplaza a ambos simultáneamente. Una operación de diario captura ambos archivos originales; un error de escritura o contabilidad compensa ambos. Una operación interrumpida conserva un registro de recuperación privado. Informes de estado de recuperación incompleta como inseguro, y la siguiente mutación explícita se recupera sólo si ni el archivo ni su propiedad tiene una edición no relacionada. Si la recuperación se niega, preservar los archivos y la ruta de recuperación reportada por la operación; resolver el conflicto antes de volver a intentar.

Deshacer restaura **ambas cadenas de bytes originales**, incluyendo un archivo que originalmente no existía. Las ediciones después de la operación requieren el `--confirm-drift` explícito existente; primero se realiza una copia de seguridad del par editado. Una entrada OpenCodex ocupada requiere la opción `--overwrite-conflict` existente. Deshabilitar elimina las dos entradas administradas; no restaura una entrada externa anterior. Usa Deshacer para eso. La retención y caducidad de instantáneas siguen las mismas reglas que otras integraciones.

La descarga `cline-config-bundle.json` contiene dos miembros nativos del documento: `settings` para `providers.json`, y `catalog` para `models.json`. No es en sí mismo un archivo de configuración de Cline. Prefiera el comando de integración para una combinación y una reversión con journal. El cableado de admisión remota no es compatible con esta integración generada; requiere acceso de bucle de retorno no autenticado.

<a id="github-copilot-app"></a>

## GitHub Copilot App

La aplicación de escritorio GitHub Copilot puede usar opencodex como proveedor de modelos compatible con OpenAI. Esta es una configuración manual del cliente sin interruptor en **Conectar**, y es independiente del proveedor de `github-copilot` aguas arriba, que utiliza una suscripción Copilot como backend para opencodex.

1. Inicie opencodex y confirme que responde:

   ```bash
   curl http://127.0.0.1:10100/healthz
   curl http://127.0.0.1:10100/v1/models
   ```

2. En la aplicación Copilot, abre **Configuración → Proveedores de modelos → Añadir proveedor** e ingresa:

   | Campo | Valor |
   |---|---|
   | Nombre | cualquier etiqueta, por ejemplo `OpenCodex` |
   | URL base | `http://127.0.0.1:10100/v1` (ajustar el puerto a su enlace) |
   | API clave | Dejar en blanco en loopback |

3. Sincronice modelos desde el punto final, o agregue uno por su id `provider/model`, y selecciónelo.

La aplicación utiliza `GET /v1/models` para el descubrimiento y `POST /v1/chat/completions` para los giros. Esos turnos pasan por el modelo de enrutamiento normal de opencodex, por lo que las credenciales del proveedor, las cuentas OAuth y los combos se aplican como lo hacen para cualquier otro cliente. Los campos de solicitud aceptados se enumeran en el [Referencia de formatos proxy](/es/reference/proxy-formats/).

Si la aplicación informa que no hay modelos, compruebe que la URL base termina en `/v1` en lugar de `/v1/chat/completions` y que `/v1/models` devuelve una matriz `data` no vacía. Cuando opencodex escucha en una dirección que no es de bucle, ponga una clave de admisión de datos (el token descrito en [acceso remoto](/es/reference/configuration/server/#remote-access), o una clave `ocx_…` generada en el panel de control) en el campo de clave API de la aplicación. La aplicación lo envía como `Authorization: Bearer`, que `/v1/chat/completions` acepta como admisión proxy y nunca reenvía aguas arriba; ver el [matriz de autenticación](/es/reference/proxy-formats/#authentication-matrix).

<a id="omo-codex--lazycodex-role-models"></a>

## modelos de rol omo (Codex / LazyCodex)

Cuando LazyCodex está instalado, la pestaña omo muestra una sección **omo (Codex / LazyCodex)** debajo de los controles omo basados en Pi, enumerando cada función de agente Codex que se encuentra en `$CODEX_HOME/agents/*.toml`, con el modelo al que está anclado cada uno. Codex ejecuta un rol en ese pin sin importar qué modelo pida el padre, así que aquí es donde se decide realmente el modelo de un rol. LazyCodex cuenta como instalado cuando el plugin `omo@sisyphuslabs` Codex está habilitado en `$CODEX_HOME/config.toml` y una copia instalada bajo `$CODEX_HOME/plugins/cache/sisyphuslabs/omo/` contiene su manifiesto de plugin o `lazycodex-install.json`. Una carpeta `~/.omo` por sí sola no cuenta, porque el omo basado en Pi también lo crea. Sin LazyCodex, la sección está oculta y la línea de comandos informa que no está instalada. Elija un modelo y un esfuerzo de razonamiento en una fila y presione Guardar. Una fila cuyo rol no tiene un modelo fijado puede guardar solo el esfuerzo de razonamiento; el rol sigue heredando su modelo:

- opencodex actualiza solo las claves raíz `model = "..."` y `model_reasoning_effort = "..."` del archivo de ese rol. Las clavijas que faltan se insertan cerca de la parte superior. La elección de **Heredar el esfuerzo**, disponible en cada fila, envía `"effort": null` para borrar el pin de esfuerzo, eliminando su línea y el comentario final. Las instrucciones del papel, otros comentarios y otras claves se dejan exactamente como estaban.
- El modelo está escrito a `[codex].agents.<role>.model` en `~/.omo/omo.jsonc`, que LazyCodex 5.1.1 y posteriores leen, y un esfuerzo cambiado LazyCodex soporta va a `[codex].agents.<role>.reasoning` en la misma entrada. Si ese archivo no existe, no se crea. Si contiene comentarios, se deja sin tocar, porque guardarlos los eliminaría; la pestaña lo dice y puede establecer el valor allí a mano. Los symlinks y archivos no regulares son rechazados; en macOS y Linux, una FIFO es rechazada sin esperar a un escritor. Un espejo omitido no deshace el archivo de rol guardado.

Si el archivo de rol guardado tiene éxito pero la escritura omo.jsonc falla, el botón de la fila se convierte en **Reintentar omo.jsonc**, que reenvía la misma opción de esfuerzo, incluyendo un borrado **Heredar el esfuerzo** (`null`). Hasta que ese reintento tenga éxito, una solicitud posterior de Guardar o Asignación automática para el rol que deja el esfuerzo solo lleva consigo la elección pendiente; un esfuerzo explícitamente elegido toma su lugar.

Nada sucede hasta que presiona Guardar; la sincronización o el reinicio de opencodex nunca cambia un archivo de rol. Las nuevas Codex sesiones recogen el cambio. Los mismos controles existen en la línea de comandos:

```bash
ocx agent roles
ocx agent roles set explorer xai/grok-4.5
```

`ocx agent roles set <role> <model> --effort <level>` también establece el esfuerzo de razonamiento del rol: inserta o reemplaza el valor `model_reasoning_effort` del archivo de rol y escribe `[codex].agents.<role>.reasoning` en omo.jsonc cuando LazyCodex tiene ese nivel (`ultra` permanece solo en el archivo de rol y se elimina un `reasoning` anterior). En `PUT /api/codex-agent-roles/{role}`, omitiendo `effort` mantiene el pin, un nivel lo establece, y `null` elimina la línea `model_reasoning_effort` del archivo de rol, su comentario final y el omo.jsonc `reasoning`. A Guardar que cambia solo el modelo deja ambos valores de esfuerzo como estaban. Omitir `model` deja el pin `model` del archivo de rol y el omo.jsonc `model` exactamente como estaban, por lo que un rol sin un pin sigue heredando su modelo mientras su esfuerzo cambia o se borra; el tablero de instrumentos envía esta solicitud de solo esfuerzo para tal fila. Cuando omo.jsonc puede ser escrito, un rol sin una entrada obtiene uno que contenga solo `reasoning` si el esfuerzo guardado es compatible con LazyCodex (`none` se escribe como `off`); para tal rol, despejar el esfuerzo o guardar `ultra` no agrega entrada. Se rechaza un modelo `null` con 400 `invalid_model`, porque un guardado nunca elimina un pin de modelo, y se rechaza una solicitud con ni `model` ni `effort` con 400 `empty_update` antes de que se lea el archivo de rol u omo.jsonc. `ocx agent roles set` siempre toma un modelo. Solo se puede eliminar un valor de cadena de una línea existente; se rechaza un valor multilínea o no de cadena con 409 `unsupported_model_value`, dejando ambos archivos sin cambios. El borrado elimina solo la anulación propia del rol: Codex resuelve el esfuerzo como lo hace para cualquier rol sin uno (un valor de generación explícito, el valor predeterminado `[agents]` o la sesión principal), no un modelo predeterminado fijo.

<a id="auto-assign"></a>

### Asignación automática

Auto-assign es parte de omo (Codex / LazyCodex): se encuentra por encima de la tabla de roles en esa sección y existe solo mientras se detecta LazyCodex. Sin él, el tablero de instrumentos no muestra ninguno, el API responde 409 `lazycodex_not_detected` y `ocx agent roles suggest` es rechazado.

La asignación automática propone un modelo para cada rol a la vez. OpenCodex consulta al modelo predeterminado de Codex (la raíz `model` en su `config.toml`): según la descripción y el inicio de las instrucciones de cada rol, ¿qué nivel de capacidad (fast, standard o frontier), esfuerzo de razonamiento (glance, measured, thorough o exhaustive) y dominio de tarea (coding, agentic, reasoning, writing, knowledge o general) necesita? Ese modelo no elige otro modelo: OpenCodex selecciona después el más económico del selector que alcance el nivel necesario:

- Los modelos incluidos en `codexRoleTiers` de la configuración (`{ "fast": [...], "standard": [...], "frontier": [...] }`) reciben ese nivel.
- Si al menos dos de los demás modelos tienen una puntuación publicada para el dominio del rol, se clasifican por sus valores distintos, sin exigir precio. Puntuaciones iguales comparten nivel y se excluyen los modelos sin puntuación. Las puntuaciones proceden de [Artificial Analysis](https://artificialanalysis.ai) si proporcionas tu propia clave API (véase abajo). El bloque `capability` de la respuesta identifica la fuente utilizada.
- Los otros modelos con precio conocido se ordenan por precio y se reparten entre los tres niveles. Si solo hay uno o dos, el más caro es frontier y el otro, si existe, standard.
- Cuando se recurre a la clasificación por precio, no se proponen modelos sin precio ni nivel configurado. Inclúyelos en la configuración si quieres utilizarlos.

Para usar Artificial Analysis, crea una clave API gratuita en [artificialanalysis.ai](https://artificialanalysis.ai/api-reference) y configúrala como valor literal, referencia `${ENV}` o referencia del llavero:

```json
{
  "codexRoleCapability": {
    "artificialAnalysis": { "apiKey": "${ARTIFICIAL_ANALYSIS_API_KEY}" }
  }
}
```

OpenCodex consulta los datos una vez al día, dentro del límite diario del plan gratuito. Sus condiciones permiten usarlos para decisiones propias y prohíben redistribuirlos, por lo que las puntuaciones permanecen internas: la respuesta devuelve el nivel asignado y la atribución, sin las puntuaciones. Si falta la clave o falla la consulta, se usan los niveles configurados y los precios; `capability.error` explica el motivo y los campos de atribución de la fuente son null. La opción retirada `huggingFace` se ignora.

Artificial Analysis rechaza redirecciones HTTP y limita cada respuesta a 16 MiB y cada solicitud a 30 segundos. Las credenciales se envían únicamente a su endpoint API fijo.

Cada propuesta muestra el modelo, el nivel, el esfuerzo de razonamiento, una razón de una línea y lo que lo movería hacia arriba o hacia abajo. Un papel que el modelo no podría dimensionar claramente se muestra como no dimensionado, con la razón, y no se puede aplicar. No se escribe nada hasta que presione Aplicar en una fila o Aplicar todo. La aplicación utiliza el mismo guardar como picking a mano. Cada rol de tamaño cuyo modelo elegido tiene una escalera de esfuerzo no vacía recibe una propuesta de esfuerzo, y Aplicar o `--apply` inserta o reemplaza su valor `model_reasoning_effort`. El esfuerzo se coloca en los propios niveles del modelo elegido: su más bajo, su predeterminado, uno por encima del predeterminado o su más alto. Una escalera vacía no da ninguna propuesta de esfuerzo (`proposedEffort: null`); Aplicar omite `effort` y deja cualquier pin de esfuerzo existente como estaba. Una propuesta nula nunca borra un alfiler.

```bash
ocx agent roles suggest
ocx agent roles suggest --model xai/grok-4.5 --apply
```

Debajo de la tabla, **Historial de cambios** muestra los cambios más recientes escritos al guardar,
aplicar una asignación automática o ejecutar `ocx agent roles set`, del más nuevo al más antiguo,
en lotes completos y hasta un máximo de 50. Así, una operación Aplicar todo aparece con todos los
roles que escribió o no aparece: se muestran el modelo y el esfuerzo de cada rol antes y después.
Cada Aplicar todo cuenta como una entrada. **Restaurar** recupera los valores anteriores mediante
el mismo guardado, de modo que la restauración también queda registrada. Guardar nunca elimina
un modelo fijado: un rol que antes no tenía uno conserva su modelo actual y solo recupera el esfuerzo.
El historial se guarda en `integrations/codex-agent-roles.jsonl`, dentro del directorio de configuración
de opencodex, con un límite de 256 KiB y 1000 filas; se eliminan los lotes completos más antiguos.
La compactación busca reducirlo a 128 KiB y conserva una restauración junto con su lote de origen
completo si ambos caben en los dos límites, descartando otros lotes anteriores para hacer espacio.
El historial puede caducar con escrituras posteriores. Antes de añadir entradas, el escritor captura
el historial acotado para que una restauración no expulse su propio origen al alcanzar el límite.
El centro de restauración de la tarjeta omo descrito antes solo sigue `~/.omo/agent/models.json`.
Cada cambio registra el directorio de Codex donde se hizo; solo se muestran y restauran los cambios
del directorio actual. Al cambiar `CODEX_HOME`, la lista empieza vacía y se rechaza restaurar desde
el historial de otro directorio. Si no se puede leer el archivo, la sección lo indica en lugar de
mostrar la lista, y la tabla de roles sigue funcionando.

## Kilo

Kilo CLI, VS Code y JetBrains comparten una configuración global. Esta integración escribe `provider.opencodex` en el primer archivo existente entre `kilo.jsonc`, `kilo.json`, `opencode.jsonc`, `opencode.json` y `config.json` en `~/.config/kilo` (`XDG_CONFIG_HOME` reubica ese directorio). Si no existe, el destino es `kilo.jsonc`. Las configuraciones del proyecto nunca se escriben. Kilo fusiona todos estos archivos globales. Si otro candidato también define `provider.opencodex`, el estado nombra todos los archivos competidores y Aplicar y Reemplazar rechazo; elimine `provider.opencodex` de esos archivos antes de habilitar la integración. Un candidato ilegible o inseguro también bloquea la escritura. Deshabilitar aún puede eliminar un bloque perteneciente al archivo grabado mientras otro candidato entra en conflicto o no se puede analizar; el otro candidato se deja intacto.

OpenCodex lee estos archivos candidatos como JSONC. Un comentario de línea `//` termina con CR,
LF o CRLF, por lo que los ajustes posteriores al comentario se conservan con cualquiera de esos finales de línea.

El fragmento de propiedad es solo `provider.opencodex` (forma OpenCode V1: `npm`, `options`, `models`). El esquema publicado de Kilo no tiene la clave OpenCode V2 `providers`, por lo que el bloque no se emite; Kilo recibe las opciones de razonamiento por modelo como un mapa variante dentro de su bloque de proveedor, construido a partir de los mismos metadatos canónicos efectivos que la exportación de OpenCode. `$schema`, `model`, `enabled_providers`, MCP, y otras claves permanecen propiedad del usuario. Seleccione `opencodex/<provider/model>` en Kilo después de aplicar.

Loopback utiliza `{env:OPENCODEX_KILO_API_KEY}` como `options.apiKey`. Un enlace sin bucle retro mueve la admisión a `options.headers["x-opencodex-api-key"]` y nunca serializa una clave real. Apply reescribe todo el archivo global como bastante JSON, por lo que los comentarios y las comas posteriores en otras claves no se conservan. Kilo está en el catálogo de salida implícita: `ocx
sync`, `POST /api/sync`, y visibilidad, proveedor, o cambios preestablecidos actualizar un bloque de Kilo propiedad bajo las mismas reglas de propiedad segura como cualquier otro cliente, y una nueva sesión de Kilo carga el archivo actualizado.

Al leer estos archivos candidatos, OpenCodex acepta una coma final tras un elemento de un array
o una propiedad de un objeto. Escribe los arrays y objetos vacíos como `[]` o `{}`;
`[,]` y `{,}` se rechazan por estar mal formados.

```bash
ocx integration client enable --client kilo
ocx export --client kilo --out ./kilo.jsonc
```

<a id="command-code"></a>

## Command Code

Command Code mantiene sus proveedores personalizados en `~/.commandcode/providers.json`. Esta integración escribe `provider.opencodex` en ese archivo y es solo loopback.

**La raíz que escribe.** El Command Code resuelve su mapa de proveedor como
`document.provider ?? document.providers`, así que la raíz singular gana siempre que existe. Por lo tanto, la integración lee primero el archivo de destino y escribe en el raíz que el archivo ya utiliza: un documento que ya lleva una `providers` mapa mantiene y sus otros proveedores se mantienen legibles. Un archivo fresco obtiene el singular `provider`
raíz. Ambas raíces se declaran como rutas administradas, por lo que Deshabilitar elimina el bloque de Cualquiera que sea el texto en el que fue escrito.

**La forma de credencial.** El proveedor está escrito con `apiKey: false`, la forma documentada para un punto final que no necesita clave. Command Code rechaza una cadena sin procesar, y esta integración no lee, hace referencia ni exporta ningún archivo de token de servicio.

**Resolución Home.** No hay ninguna `COMMANDCODE_HOME` Anular aquí. El publicado El cliente resuelve `HOME ?? USERPROFILE` y luego añade `/.commandcode/providers.json`; no consulta esa variable. Una anulación de esta integración honrada, pero la cliente ignorado haría Aplicar éxito del informe en una ruta Command Code nunca se abre, por lo que El camino es siempre `~/.commandcode/providers.json`. En Windows con el hogar predeterminado, la integración utiliza `HOME ?? USERPROFILE`
solo cuando el valor seleccionado no está en blanco y Windows-absolute; de lo contrario, usa
`homedir()`. Se conserva una casa suministrada por separado. A `HOME` establecido por Git para Por lo tanto, Windows o MSYS2 solo se respetan cuando pasan esas comprobaciones.

Pegue la clave usted mismo si luego mueve el proveedor fuera del bucle de retroceso: Command Code almacena las claves en `~/.commandcode/auth.json` (a través de `/connect`), no en `providers.json`.

```bash
ocx integration client enable --client commandcode
ocx export --client commandcode --out ./providers.json
```

`ocx commandcode restore --op <opId>` acepta solo Command Code operaciones, incluyendo `--preview` y `--plan-fingerprint` solicitudes. Rechaza las anulaciones de cliente/perfil. El proxy en ejecución debe admitir la restauración con alcance de cliente; los proxies más antiguos devuelven un error sin volver al extremo de restauración genérico. Utilice `ocx integration client restore` para la revista genérica y los comandos de perfil explícitos de Aside anteriores para las operaciones de Aside.

## Factory Droid

Ejecute Droid una vez para crear `~/.factory`, luego habilite explícitamente esta integración con `ocx integration client enable --client droid`. OpenCodex agrega solo `customModels` entradas documentadas a su `settings.json` personal, utilizando un punto final Chat Completions local sin llave. Elija una fila de Droid 's `/model` selector. Deshabilitar elimina las filas administradas; Deshacer restaura el archivo guardado exacto. Otros ajustes y modelos personalizados siguen siendo suyos. Si Droid normaliza una fila `customModels` agregando `id` o `index`, OpenCodex ignora esos dos campos de cliente al verificar la propiedad, por lo que los valores predeterminados de razonamiento guardados permanecen disponibles.

Abra **Conectar → Factory Droid** (`/#integrations/droid`) para establecer un razonamiento predeterminado para cada modelo conectado. Elija entre los esfuerzos compatibles del modelo, revise los cambios y luego confirme. **Sin valores predeterminados** borra la configuración de borrador de ese modelo; use **Guardar / revisar cambios** y confirme para aplicar la eliminación. Los modelos sin una lista de esfuerzo declarada muestran que no hay ningún valor predeterminado disponible.

El CLI admite los mismos valores predeterminados en Droid apply/overwrite. Por ejemplo, reemplace el modelo ficticio de abajo con un ID conectado exacto y esfuerzo soportado:

```bash
ocx integration client preview --client droid --operation apply --reasoning-default example/model-a=high --json > droid-preview.json
```

Después de revisar el plan aplicable y elegir la escritura:

```bash
DROID_FINGERPRINT="$(jq -er 'select(.canApply == true) | .fingerprint' droid-preview.json)"
ocx integration client enable --client droid --reasoning-default example/model-a=high --plan-fingerprint "$DROID_FINGERPRINT" --json
ocx integration client status --client droid --json
```

Repita `--reasoning-default MODEL=EFFORT` para enviar el mapa de reemplazo completo. El último signo igual separa el modelo y el esfuerzo; se conservan los identificadores de caso y exactos. Las claves de modelo duplicadas se rechazan. Las banderas omitidas preservan los valores predeterminados; `--clear-reasoning-defaults` explícitamente envía un mapa vacío. Para borrar, previsualizar con ese indicador y repetirlo en el comando de habilitación de coincidencia. Borrar y las entradas no se pueden combinar. Estos indicadores son Droid -only y no se aplican para deshabilitar/restaurar. Repita el mismo mapa en la vista previa y confirmación; el servidor valida los esfuerzos específicos del modelo y rechaza la vinculación obsoleta en lugar de aceptar silenciosamente un mapa cambiado.

Para una clara intención completa, previsualizar esa acción separada:

```bash
ocx integration client preview --client droid --operation apply --clear-reasoning-defaults --json > droid-clear-preview.json
```

Después de revisarlo y elegirlo:

```bash
DROID_CLEAR_FINGERPRINT="$(jq -er 'select(.canApply == true) | .fingerprint' droid-clear-preview.json)"
ocx integration client enable --client droid --clear-reasoning-defaults --plan-fingerprint "$DROID_CLEAR_FINGERPRINT" --json
```

El valor predeterminado se aplica solo cuando Droid omite un esfuerzo de su solicitud. Un esfuerzo explícito de solicitud tiene prioridad sobre este valor predeterminado; los pines y tapas existentes de OpenCodex aún se aplican. Droid puede continuar visualizando **Dinámico** incluso cuando OpenCodex aplica el valor predeterminado configurado. Las solicitudes sin el encabezado predeterminado Droid no se ven afectadas; el encabezado es una preferencia de solicitud, no una prueba de identidad del cliente. Para combos y políticas de enrutamiento, cada destino concreto comprueba la preferencia en contra de su propia lista de esfuerzo, por lo que un primer objetivo incompatible no lo elimina de una reserva compatible.

Un valor predeterminado guardado que el modelo enrutado ya no admite se ignora para las solicitudes. Si la lista de esfuerzo declarada del modelo conectado ya no incluye el valor guardado, se omite de los valores predeterminados del panel y se elimina de la fila administrada al actualizar. La revisión sin edición permite que OpenCodex conserve los valores predeterminados compatibles restantes.

Actualizar conserva los valores predeterminados mientras el selector exacto `provider/model` permanece conectado y declara el esfuerzo guardado. Renombrar un proveedor, modelo o alias combinado reemplaza esa fila administrada y borra su valor predeterminado; elija un valor predeterminado para la fila renombrada nuevamente. Deshabilitar elimina los valores predeterminados con las filas del modelo administrado y Deshacer restaura las filas guardadas y sus valores predeterminados juntos.

Los modelos cuyos ID o nombres de visualización contienen `,` o `]` se omiten porque el selector administrado no puede abordarlos de forma segura; la configuración de exportación y administrada muestra las mismas filas. Se rechaza un catálogo no vacío sin modelos direccionables.

Droid también lee el legado `config.json` y el local `settings.local.json`. Resolver filas heredadas que usan el punto final OpenCodex, un ID de modelo generado o un nombre de visualización `OpenCodex:` y cualquier anulación local `customModels`, antes de habilitar; OpenCodex rechaza esos ajustes ambiguos. También rechaza un objetivo inseguro o una fila editada desde que se aplica. La integración es solo loopback y nunca copia las credenciales del proveedor. La fábrica documenta el [Esquema BYOK](https://docs.factory.ai/model-independence/byok) y [configuración personal](https://docs.factory.ai/droid-cli/settings).
