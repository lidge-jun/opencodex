---
title: "Fallo de actualización en Windows"
description: "En qué estado se encuentra una instalación de OpenCodex después de que la actualización ocx falle durante el paso de instalación de npm, cómo finalizar la actualización de forma segura y qué carpetas sobrantes puede eliminar."
---

Esta página es para una actualización del panel de control o `ocx update` que se detiene parcialmente, con mayor frecuencia en Windows, con un resultado como este (informado como el problema [#5624](https://github.com/lidge-jun/opencodex/issues/5624)):

```text
update command failed (1)
exit 1 · code: ENOTDIR · syscall: mkdir
```

y, después, una carpeta junto al paquete que no se puede eliminar porque `bunx.exe` está en uso (`EPERM`).

<a id="what-state-you-are-in"></a>

## En qué estado estás

El actualizador detiene el proxy que le corresponde, instala y verifica la versión nueva en un directorio de preparación y solo entonces la sustituye. Si falla la instalación, no se produce el intercambio: la versión anterior sigue instalada y puede ejecutarse. Antes de terminar, el actualizador intenta recuperar el servicio o proxy previo si llegó a detenerlo y conserva la autoridad para hacerlo. Si no puede verificar la recuperación, indica que requiere revisión manual; no inicia un segundo proxy de otro propietario. No hace falta reinstalar solo para volver a disponer de la versión anterior.

Compruebe esto con:

```bash
ocx --version
ocx status
```

El trabajo del panel de control solo registra el estado de salida, ya que la propia salida del instalador puede contener rutas locales. La ejecución de `ocx update` en un terminal muestra el paso que falló y el siguiente paso a tomar.

<a id="finish-the-update"></a>

## Finalizar la actualización

1. Cierre cualquier cosa que aún pueda ejecutar archivos OpenCodex: la aplicación Codex, los terminales que iniciaron `ocx` o `bunx` y la bandeja OpenCodex. Un `bun.exe` o `bunx.exe` en ejecución mantiene sus archivos bloqueados en Windows.
2. Vuelva a ejecutar `ocx update` desde una terminal.
3. Si falla de la misma manera, ejecute `ocx status` y deje que termine cualquier recuperación en progreso. Si el actualizador reinició el proxy, deténgalo a través de su propietario (`ocx stop`, su servicio o la aplicación de escritorio) y confirme que se ha detenido. Vuelva a instalar con el mismo administrador de paquetes que posee la instalación; para una instalación npm administrada por el servicio OpenCodex:

   ```bash
   ocx stop
   npm install -g --allow-scripts=bun @bitkyc08/opencodex@latest
   ocx service restart
   ```

   Reinicie a través del servicio propietario o la aplicación de escritorio después de que se complete la instalación; use `ocx start` cuando no se administre. Reemplace `latest` con `preview` si sigue el canal de vista previa.

<a id="leftover-folders"></a>

## Carpetas sobrantes

Se sientan al lado del paquete en la carpeta global de npm, generalmente `%APPDATA%\npm\node_modules\@bitkyc08\` en Windows.

| Carpeta | Creado por | Qué hacer |
|---|---|---|
| `.opencodex-<random>` | npm en sí, mientras que la sustitución del paquete durante un `npm install -g` directo | Elimínelo una vez que no se ejecute el proceso OpenCodex |
| `.ocx-staging-<timestamp>` | la instalación del actualizador OpenCodex | Se informa de una etapa marcada de más de media hora, pero se deja en su lugar; elimínelo a mano una vez que no se ejecute ningún proceso OpenCodex. Una etapa sin un marcador `.ocx-update-owner.json` tiene un origen no verificado: una actualización interrumpida puede dejarla, pero también puede hacerlo cualquier otra cosa que elija el prefijo, así que confirme que pertenece a OpenCodex antes de eliminarlo |
| `.ocx-backup-<timestamp>` | copia del actualizador de la versión anterior | Déjalo; se elimina automáticamente después de que la nueva versión comience saludable y se restaura si no lo hace. |

Ninguna carpeta sobrante bloquea por su nombre la siguiente actualización: cada intento usa un directorio de preparación nuevo. Sin embargo, sus archivos siguen ocupando espacio y pueden hacer que una copia posterior falle con `ENOSPC`. El actualizador conserva esos directorios en los intentos posteriores e informa los que tengan más de media hora y un marcador de propiedad verificable. Elimina uno solo después de confirmar que pertenece a OpenCodex y que ningún proceso lo está usando.

Si una carpeta no se elimina, un proceso sigue ejecutándose desde ella. Al cerrar la sesión o reiniciar Windows, se libera el bloqueo.

<a id="if-the-update-reports-an-unsupervised-proxy"></a>

## Si la actualización informa de un proxy UNSUPERVISED

Cuando el servicio en segundo plano no se puede actualizar después de una actualización, el actualizador primero pide a launchd (macOS) o al administrador de usuarios systemd (Linux) que reinicie el servicio que ya tiene. Si eso no trae de vuelta un proxy propiedad del servicio, el actualizador inicia el proxy directamente para que no se quede sin uno, imprime una advertencia de que el proxy se está ejecutando sin supervisión y sale con un estado distinto de cero. Ese proxy funciona, pero nada lo reinicia después de un bloqueo, y un inicio de servicio posterior puede competir con él por el puerto. Ejecute `ocx service repair` para devolverlo al servicio de fondo, luego marque `ocx status`.

Las actualizaciones iniciadas desde el panel siguen el mismo orden. Si solo el inicio directo devuelve el proxy, el panel de control informa que la actualización falló con el mismo mensaje UNSUPERVISED aunque la nueva versión esté instalada y respondiendo; ejecute la misma reparación para borrarla.

<a id="if-the-proxy-answers-503-after-a-manual-install"></a>

## Si el proxy responde 503 después de una instalación manual

La instalación sobre un proxy en ejecución hace que responda `503` con `package_tree_changed` hasta que se reinicie. Las versiones después de 2.64.0 pueden reiniciarse después de unos segundos una vez que el árbol de paquetes y su entorno de ejecución Bun se hayan completado. Una instalación posterior incompleta o fallida de Bun impide esa recuperación. `ocx restart` o `ocx service restart` pueden encontrar un proxy en ese estado, pero reiniciar aún requiere un entorno de ejecución completo y un árbol de paquetes. Con 2.64.0 y anteriores, el proxy permanece en ese estado, y `ocx restart` puede informar que no se está ejecutando ningún proxy mientras el antiguo aún mantiene el puerto; use `ocx service restart` o finalice el proceso cuya respuesta `pid` muestra la respuesta `/healthz` y luego ejecute `ocx start`.

Si el instalador ha salido o ha fallado, inspeccione su error y ejecute `ocx status`. Deje que cualquier recuperación en curso termine, detenga cualquier proxy en ejecución a través de su propietario (`ocx stop`, su servicio o la aplicación de escritorio) y confirme que se ha detenido. Vuelva a instalar con el mismo administrador de paquetes, permitiendo que se complete la postinstalación de Bun, luego comience de nuevo a través del servicio propietario o la aplicación de escritorio (`ocx start` cuando no se administre).

<a id="if-the-update-stops-at-the-npm-cache-check"></a>

## Si la actualización se detiene en la comprobación de caché npm

`ENOTDIR` en `mkdir` significa que npm intentó crear una carpeta donde un componente de ruta era un archivo, o un enlace cuyo destino ya no existe. Una causa confirmada ([#6288](https://github.com/lidge-jun/opencodex/issues/6288)) es una unión `%LOCALAPPDATA%\npm-cache` que apuntaba a otra unidad después de que la carpeta de destino se hubiera eliminado o la unidad se hubiera eliminado.

El actualizador comprueba la carpeta de caché de npm antes de detener el proxy, y la instalación de estadificación npm utiliza la misma carpeta que `npm config get cache` informa. Si no se puede usar la carpeta de caché, la actualización se detiene con `cache_root_dangling_link` o `cache_root_not_directory` y deja el proxy en ejecución:

- `cache_root_dangling_link`: la carpeta de caché es un enlace o unión cuyo objetivo falta. Vuelva a crear la carpeta de destino o elimine el enlace para que npm pueda crear una carpeta normal.
- `cache_root_not_directory`: la carpeta de caché, o una carpeta encima de ella, es un archivo o se encuentra en una unidad que no está disponible. Mueva el archivo a un lado, o el punto npm en otra caché con `npm config set cache <folder>`.

Luego ejecuta `ocx update` de nuevo. Si `ENOTDIR` persiste después de que pase la comprobación, abra un problema con la salida completa del terminal de `ocx update` y la salida de `npm config get prefix` y `npm config get cache`.

<a id="desktop-app-update-stalls-or-fails-on-installing-update"></a>

## La actualización de la aplicación de escritorio se estanca o falla en "Instalar actualización"…"

En la aplicación de escritorio OpenCodex, **Instalar actualización** descarga el instalador desde GitHub Releases antes de reemplazar la aplicación y reiniciarla. Una descarga o instalación fallida con una versión conocida muestra una sugerencia de descarga manual y un enlace a la página de lanzamiento de esa versión.

Si `Installing update…` se detiene o se agota el tiempo, GitHub descargas de la versión pueden ser lentos o bloqueados por su red. Utilice el enlace de liberación en el error, o encuentre la misma versión en el [Página de lanzamientos OpenCodex](https://github.com/lidge-jun/opencodex/releases), y descargue el instalador para su sistema operativo y arquitectura. Las versiones de vista previa tienen sus propias páginas de lanzamiento; elija la versión que ofrece la aplicación.

Antes de ejecutar el instalador, detenga el proxy a través de su propietario y confirme que se ha detenido:

1. Salga de la aplicación de escritorio OpenCodex de su menú de bandeja para detener un proxy propiedad de la aplicación.
2. Si un servicio posee el proxy, deténgalo a través de los controles del servicio (`ocx stop` para un servicio administrado OpenCodex). Para un proxy de terminal no administrado, deténgalo en ese terminal.
3. En Windows, use este listado de procesos para ayudar a identificar cualquier entorno de ejecución restante:

   ```powershell
   Get-Process -Name ocx, opencodex-desktop, bun, bunx -ErrorAction SilentlyContinue
   ```

   El listado no establece qué aplicación posee un proceso. Identifique el entorno de ejecución OpenCodex y deténgalo a través de su aplicación o servicio propietario; un proceso `bun` puede pertenecer a otra aplicación. Espere a que la aplicación propietaria y el proxy salgan antes de instalar.

Ejecute el instalador descargado y, a continuación, vuelva a abrir la aplicación de escritorio o reinicie el servicio propietario.
