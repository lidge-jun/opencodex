---
title: "Inferencia privada de Cursor"
description: "Utilice los modelos con enrutamiento opencodex dentro de la compilación de agente local de Cursor, en macOS, Windows o Linux, sin un túnel público."
---

El Cursor regular no puede hablar con un proxy en su propia máquina. Cuando establece "Override OpenAI URL base", el backend de Cursor crea el mensaje y llama a esa URL desde los servidores de Cursor, que rechazan el loopback, la LAN y las direcciones privadas. Es por eso que cada receta de la comunidad para Cursor + modelos locales termina con ngrok, Cloudflare Tunnel o un VPS.

Cursor también envía una segunda compilación de escritorio, **Cursor Inferencia privada**, cuyo bucle de agente se ejecuta localmente y llama a una puerta de enlace compatible con OpenAI que configura. Señalado en opencodex, utiliza sus modelos enrutados sin túnel, sin parches de aplicaciones y sin TLS. Esta página cubre esa construcción.

<a id="before-you-start"></a>

## Antes de empezar

Lea esta sección primero; es la parte que la gente extraña.

- **opencodex no distribuye esta compilación.** Cursor tampoco lo documenta. No está vinculado desde cursor.com, puede cambiar sin previo aviso y puede dejar de estar disponible. Si aún no lo tiene, esta guía no se aplica; use el puente de la comunidad [`ocx-cursor`](https://www.npmjs.com/package/ocx-cursor) con un punto final público HTTPS en su lugar.
- **El inicio de sesión Cursor todavía es necesario.** El muro de inicio de sesión viene antes del diálogo de puerta de enlace.
- **Los modelos propios de Cursor no están disponibles.** En el modo local, el selector solo muestra lo que devuelve la puerta de enlace. Finalización de la pestaña, catálogo de Cursor (Compositor, Auto) y Cloud Agents están apagados. Todavía puede llegar a los modelos Cursor -proveedor a través de las rutas opencodex propias de `cursor/*` si ha configurado ese proveedor.
- **Cada vuelta lleva Cursor 's sistema local**, aproximadamente 23k tokens en el segundo y posteriores turnos. Presupuesto para cuando elijas un modelo.
- **Comparte la identidad con Cursor regular.** Mismo identificador de paquete, mismo `~/.cursor`, mismo `Application Support/Cursor` ( macOS), `%APPDATA%\Cursor` ( Windows) o `~/.config/Cursor` ( Linux). Inicie con `--user-data-dir <dir>` para mantener los dos separados, y deje "Importar datos de la instalación Cursor existente" sin marcar en la primera ejecución a menos que desee copiar la configuración.

<a id="identify-the-installed-build"></a>

## Identificar la construcción instalada

Ambas versiones se denominan " Cursor " en el Dock y comparten una identificación de paquete, así que verifique `product.json`:

| Plataforma | product.json |
|---|---|
| macOS | `/Applications/Cursor Private Inference.app/Contents/Resources/app/product.json` |
| Windows | `%LOCALAPPDATA%\\Programs\\cursor-private-inference\\resources\\app\\product.json` |
| Linux | `<install root>/resources/app/product.json` (primero debe extraerse una AppImage). El tablero de instrumentos busca raíces de instalación `cursor*` bajo `/opt`, `/usr/share` y `~/.local/share`. |

`nameLong` es `"Cursor Private Inference"` para el agente local y `"Cursor"` para el regular; `version` es la construcción (3.18.25 en el momento de la escritura). La tarjeta Integrations.Cursor del panel de control ejecuta la misma verificación y enumera lo que encontró. El modo local se activa dentro del paquete de banco de trabajo, no en `product.json`, por lo que no hay bandera para voltear: si `nameLong` dice Cursor regular, esa instalación no puede llegar a una puerta de enlace de bucle.

El bucle de agente que habla con la puerta de enlace vive en un archivo bajo la misma raíz de instalación, `extensions/cursor-agent-exec/dist/main.js`. opencodex lo lee (solo lectura, limitado) para aprender la tabla de esfuerzo de razonamiento de Cursor; véase "Modelos y esfuerzo de razonamiento".

<a id="configure-the-gateway"></a>

## Configurar la puerta de enlace

opencodex necesita estar en funcionamiento (`ocx service status`). Entonces cualquiera de estas obras; ambos terminan en el mismo lugar.

**En la aplicación.** Configuración → Modelos → Pasarela → Configurar la puerta de enlace:

| Campo | Valor |
|---|---|
| URL base | `http://127.0.0.1:10100/v1` (incluya `/v1`; se acepta el bucle de `http://`) |
| Clave API | una clave de OpenCodex aceptada por el servicio cuando está habilitada la admisión con clave API: puede ser `OPENCODEX_API_AUTH_TOKEN` o una clave de cliente configurada; use `opencodex-loopback` solo cuando la configuración permita ese marcador de posición |

Haga clic en **Actualizar lista de modelos**. El selector se llena con opencodex `/v1/models`; encienda las filas que desee.

**Con variables de entorno.** La aplicación lee esto al principio:

```text
CURSOR_LOCAL_AGENT_BASE_URL=http://127.0.0.1:10100/v1
CURSOR_LOCAL_AGENT_API_KEY=opencodex-loopback
CURSOR_LOCAL_AGENT_HEADERS=            # optional, newline-separated "Header-Name: value" lines
```

`CURSOR_LOCAL_AGENT_HEADERS` rechaza `User-Agent` y `{...}` marcadores de posición no resueltos; `{gitOrgRepo}` y `{gitBranch}` se expanden.

Precedencia, el más alto primero: credenciales por modelo → la puerta de enlace guardada en Configuración → `CURSOR_LOCAL_AGENT_*` → `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` (alternativa por compatibilidad). El entorno no anula una puerta de enlace guardada; límpiela primero en Configuración si tiene la intención de cambiar a través del entorno.

Cursor Private Inference es una aplicación GUI, por lo que un perfil de shell interactivo no es suficiente por sí solo; la variable tiene que estar en el entorno de lo que sea que lance la aplicación.

| OS | Dónde colocarlo |
|---|---|
| macOS | `launchctl setenv CURSOR_LOCAL_AGENT_BASE_URL http://127.0.0.1:10100/v1` para la sesión de inicio de sesión actual, o un LaunchAgent con `EnvironmentVariables` para que sea persistente. Iniciar la aplicación desde un terminal también funciona. |
| Windows | `setx CURSOR_LOCAL_AGENT_BASE_URL http://127.0.0.1:10100/v1` (alcance del usuario; afecta a nuevos procesos) o Propiedades del sistema → Variables de entorno. Reinicie la aplicación después. |
| Linux | `~/.profile` o `~/.pam_environment` para una sesión de administrador de pantalla, o `systemctl --user set-environment CURSOR_LOCAL_AGENT_BASE_URL=http://127.0.0.1:10100/v1` cuando el escritorio se ejecuta bajo una sesión de usuario systemd. La AppImage lanzada desde un terminal hereda el entorno de ese shell. |

La construcción existe para macOS (arm64, x64, universal), Windows (x64, arm64) y Linux (x64, arm64). La configuración es idéntica en todos ellos.

<a id="from-the-dashboard"></a>

## Desde el panel de control

El panel de control opencodex tiene una pestaña **Cursor** en Integraciones (`/#integrations/cursor`). Es de solo lectura hacia Cursor: nunca escribe la base de datos de configuración de Cursor, la entrada de llavero o el paquete de aplicaciones, por lo que no hay ningún interruptor para cambiar. Lo que hace es entregarte los valores y mostrarte si los tomaron.

- **Construcción instalada.** Si Cursor Inferencia privada (con su trayectoria y versión) y regular Cursor (sencillamente trayectoria) están presentes. Si solo se encuentra el Cursor normal, la pestaña lo dice, enlaza aquí y ofrece un botón **Busque el instalador de Inferencia privada**. Al presionarlo, se le pregunta al canal de actualización propio de Cursor qué instalador de modo local anuncia para esta plataforma y CPU (el canal `cursor-local` en `api2.cursor.sh`) y muestra esa versión con un enlace al instalador `downloads.cursor.com/local-mode/`. Nada se solicita hasta que pulse el botón: abrir la pestaña y su actualización periódica nunca contacto canal de Cursor. opencodex solo muestra el enlace: nunca descarga, lanza o instala nada. La respuesta se almacena en caché durante 30 minutos (5 después de un fallo). Cuando no se puede alcanzar el canal, las respuestas con algo inutilizable, o Cursor no se envía ninguna construcción para este equipo (solo x64 y arm64 en Windows, macOS y Linux tienen uno), la pestaña dice que el instalador no se pudo resolver; los valores de puerta de enlace a continuación permanecen válidos de cualquier manera. Regular Cursor sí mismo todavía rutas endpoints personalizados a través de Cursor 's servidores, por lo que no puede llegar a un proxy loopback.
- **Valores de entrada.** La URL base en el propio puerto de escucha del proxy (de su registro en entorno de ejecución, por lo que un panel de control con el proxy inverso aún muestra el puerto Cursor en esta máquina), con un botón Copiar. La fila de claves API depende de la vinculación: cuando no necesita credenciales, la fila es `opencodex-loopback` con Copiar; cuando está activada la autenticación API o cualquier tecla opencodex API está configurada, la fila le indica que use una de sus propias claves y enlaces a la pestaña Claves API. Cualquier tecla configurada funciona, no solo `OPENCODEX_API_AUTH_TOKEN`.
- **Conexión.** La última solicitud `/v1/models` cuyo User-Agent es exactamente `Cursor/<version>` (el entorno de ejecución del agente local del encabezado Cursor envía), con el tiempo y la versión. Se lee "nunca visto" hasta que Cursor llama al proxy; presionar **Actualizar lista de modelos** en Cursor es lo que lo hace girar. La tarjeta se actualiza cada 15 segundos mientras la pestaña está abierta.
- **Lo que mostrará el Cursor.** Una tabla Modelo / Razonamiento / Contexto para los modelos opencodex anuncia (se aplican modelos desactivados y listas de proveedores, al igual que la lista sin procesar), siguiendo las reglas en la siguiente sección. Es una predicción: Cursor escoge la escalera de Razonamiento de su propia tabla.

<a id="models-and-reasoning-effort"></a>

## Modelos y esfuerzo de razonamiento

El selector es opencodex lista cruda `/v1/models`. Dos cosas deciden si una fila modelo obtiene un control **Razonamiento**:

1. opencodex debe anunciar capacidades en la fila (`api_types` más un objeto `capabilities`). Lo hace, a partir de v2.41. Los proxies más antiguos muestran los modelos pero no controlan el esfuerzo.
2. El ID del modelo, después de despojar todo hasta el último `/` y cualquier sufijo `@…`, debe coincidir con la tabla de esfuerzo propio de Cursor. Esa tabla está compilada en la aplicación (`extensions/cursor-agent-exec/dist/main.js`); opencodex lo lee desde la instalación detectada, por lo que la predicción del panel sigue a una actualización Cursor, y la tarjeta dice qué compilación leyó o "espejo estático" cuando no se encontró nada. Cursor decide la escalera, no opencodex, y no `/v1/models` campo puede añadir un modelo a esa tabla. La matriz a continuación es la instantánea 3.18.25 que lleva el espejo estático:

| ID del modelo (después del último `/`) | Escalera Cursor espectáculos | Campo del protocolo |
|---|---|---|
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | Bajo, Medio, Alto, Extra Alto | `reasoning.effort` |
| `gpt-5`, `gpt-5.x` | Bajo, Medio, Alto, Extra Alto | `reasoning.effort` |
| `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4.7`, `claude-opus-4.8` | Bajo, medio, alto, extra alto, máximo | `output_config.effort` |
| `claude-opus-4.6`, `claude-opus-4.5`, `claude-sonnet-4.6` | Bajo, medio, alto, máximo | `output_config.effort` |
| `grok-4.3`, `grok-4.5`, `grok-4.6`, `grok-build-latest` | Mínimo, bajo, medio, alto, extra alto | `reasoning_effort` |
| `gemini-*` (necesita `supports_reasoning` ) | Mínimo, Bajo, Medio, Alto | `reasoning_effort` |
| Cualquier otra cosa, incluyendo `claude-fable-5-1`, `kimi-k3` | sin control | — |

Así que `anthropic/claude-opus-5` trabajos, y opencodex de `max`/`ultra` Los niveles para GPT-5.6 no son accesible desde este selector.

<a id="models-with-no-control"></a>

### Modelos sin control

`anthropic/claude-fable-5-1`, `cursor/kimi-k3`, y cualquier otra cosa fuera de la tabla no obtiene ningún control de Razonamiento, y Cursor registra una línea por tal identificación cuando la puerta de enlace anuncia `supports_reasoning`: "Proveedor local anuncia soporte de razonamiento para un modelo sin familia de esfuerzo de Bottlerocket codificada". Dos formas de elegir un esfuerzo:

- **Esfuerzo filas** (`cursorEffortRows: true` en la configuración opencodex, default off): la pasarela publica una entrada de selector por esfuerzo para modelos sin tabla, como `anthropic/claude-fable-5-1--high` o `cursor/kimi-k3--max`, y encamina cada uno al modelo base con ese esfuerzo aplicado. Los modelos Cursor ya no obtienen filas adicionales, y un identificador de modelo conocido exacto siempre gana sobre el sufijo `--<effort>`. Pulsa Actualizar lista de modelos después de activarla. La tarjeta del panel de control cuenta las filas que publicó por modelo. Elegir una fila es una opción explícita, por lo que su esfuerzo también gana una directiva `ocx-effort` en la solicitud.
- **Un valor predeterminado fijo** (`modelDefaultReasoningEfforts` en el proveedor): se aplica cuando Cursor no envía ningún esfuerzo.

<a id="max-is-two-different-things"></a>

### "Max" es dos cosas diferentes

Regular Cursor muestra un **Max** alternar junto a algunos modelos. Ese es el modo Max, una ventana de contexto más grande, no un nivel de razonamiento. En la construcción de agente local aparece la misma idea que una entrada **Contexto** en el menú del modelo, y opencodex la ilumina para la familia nativa GPT-5.6: **272K** (predeterminado) o **922K** (el opt-in 1M, marcado como que cuesta más). El valor que eliges es el que convierte el contexto. Los modelos enrutados muestran una sola ventana y ninguna entrada de contexto; un límite de contexto del proveedor por debajo de 922K también elimina la entrada para las filas nativas.

Razonamiento-esfuerzo **Max** (opencodex `max` / `ultra`) es el otro significado, y que uno no es alcanzable: Cursor toma la escalera de esfuerzo de su propia mesa en lugar de la puerta de enlace, y la entrada GPT-5.6 se detiene en Extra High.

Debido a que opencodex anuncia `responses` en `api_types`, este agente de envío de compilación se convierte en `/v1/responses` con `reasoning.effort`, no en `/v1/chat/completions`.

Esta elección de protocolo tiene un efecto secundario en las filas Claude: Cursor solo envía su esfuerzo de razonamiento mediante `output_config.effort` en Anthropic Messages. Por tanto, con una URL base `/v1`, la fila Claude seleccionada usa el esfuerzo predeterminado de su proveedor aunque muestre un control de esfuerzo. Con una URL base que termina en `/messages`, ocurre lo contrario: se envía el esfuerzo de Claude y se descarta el de la familia OpenAI. Una sola entrada del gateway no puede servir a ambas familias; las filas de esfuerzo descritas arriba evitan esta limitación porque opencodex aplica el esfuerzo directamente.

<a id="verify"></a>

## Verificar

`ocx observe logs` muestra los giros como `inboundProtocol: responses` con `admissionKind: loopback`.

| Síntoma | Comprobar |
|---|---|
| 401 desde la puerta de enlace | la credencial no coincide con un token de datos o una clave de cliente aceptados; use una clave autorizada. El marcador de posición solo sirve en loopback cuando la configuración admite solicitudes sin autenticación de datos |
| El selector está vacío | opencodex no se está ejecutando, o falta la URL base `/v1`; presione Actualizar lista de modelos después de la fijación |
| modelos enumerados pero sin control de razonamiento | opencodex más antiguo que v2.41, o el id no está en la tabla de Cursor (el panel lo marca - ); encienda `cursorEffortRows` o configure un proveedor predeterminado |
| No se recoge un cambio de esquema | Cursor cachés `/models` por cadena de URL base sin caducidad; La lista de modelos de actualización la vuelve a leer, de lo contrario, reinicia la aplicación o guarda temporalmente una ortografía diferente de la URL (`localhost` vs `127.0.0.1`) |
| 23k-token primera vuelta | esperado; esto es el aviso del sistema local de Cursor |
