---
title: "Registro de gastos rechazado en una carpeta sincronizada"
description: "¿Por qué las solicitudes pueden fallar con \"El almacenamiento de Spend-ledger no se pudo abrir de forma segura\" cuando el directorio de estado opencodex está dentro de iCloud Drive u otra carpeta sincronizada, y cómo solucionarlo."
---

Los rechazos de almacenamiento de registro de gastos devuelven HTTP 503 con el tipo de error `server_error` y el código `spend_ledger_storage_unavailable`. Este es un problema de almacenamiento local; no cuenta contra el proveedor o el estado de la cuenta. Los registros de solicitudes lo atribuyen como `local-refusal`. Una respuesta de flujo continuo ya lleva el mismo código en su evento de error de terminal. Otras solicitudes en la misma sesión pueden tener éxito si la condición del archivo es temporal.

Las versiones anteriores informaron HTTP 502 con un prefijo engañoso "Provider inalcanzable". Las compilaciones actuales dicen qué archivo y qué verificación lo rechazó, por ejemplo:

```text
Spend-ledger storage could not be opened safely (journal: extra-hard-link).
```

<a id="what-the-check-is"></a>

## Cuál es el cheque

opencodex guarda un registro de gastos en su directorio de estado (`~/.opencodex` de forma predeterminada, o `OPENCODEX_HOME`): el diario `spend-ledger.jsonl` y el archivo de sal `spend-ledger.salt`. Antes de escribir, comprueba que cada archivo sea regular, pertenezca al usuario, no sea un enlace simbólico y tenga exactamente una entrada de directorio. Un segundo enlace duro permitiría leer o modificar los mismos bytes desde otro nombre del volumen. Ante cualquier enlace inesperado, opencodex rechaza la escritura. La comprobación es estricta de forma deliberada.

| Condición en el mensaje | Descripción |
| --- | --- |
| `extra-hard-link` | Otra entrada de directorio apunta en el mismo archivo. |
| `symbolic-link` | El archivo del libro mayor es un enlace simbólico. |
| `not-regular-file` | Algo más que un archivo regular se encuentra en la ruta del libro mayor. |
| `foreign-owner` | El archivo pertenece a un usuario diferente. |
| `invalid-salt` | El archivo de sal existe pero su contenido no es una sal válida. |

El papel en el mensaje es `journal`, `journal-compaction` (el archivo temporal escrito mientras el diario se compacta) o `salt`.

<a id="why-a-synced-folder-triggers-it"></a>

## ¿Por qué una carpeta sincronizada lo desencadena?

Servicios de sincronización macOS, incluida la unidad iCloud con "Carpetas de escritorio y documentos" activadas y Los clientes de proveedores de archivos, como OneDrive, Dropbox y Google Drive, pueden mantener brevemente un segundo enlace a un archivo mientras se escenifica o se carga un cambio. Si el directorio de estado está dentro de una carpeta de este tipo, el diario puede tener dos enlaces por un momento después de una escritura ordinaria. Una petición que aterriza en Ese momento es rechazado, y el siguiente puede tener éxito. Una vez que la sincronización se establece, el archivo vuelve a un enlace, por lo que inspeccionarlo después no muestra nada malo.

En el inicio, opencodex advierte cuando el directorio de estado se resuelve dentro de iCloud Drive (`~/Library/Mobile Documents`), una carpeta de proveedor de archivos (`~/Library/CloudStorage`), escritorio o documentos mientras la sincronización de iCloud Desktop & Documents parece estar activada, o escritorio o documentos mientras Google Drive para escritorio parece estar en uso. La pista de accionamiento Google es la presencia de `~/Library/CloudStorage/GoogleDrive-*` o `~/Library/Application Support/Google/DriveFS`. No lee qué carpetas se le dijo a la aplicación que sincronice, por lo que Drive que se está instalando puede advertir incluso cuando no se selecciona Documentos. La advertencia es de asesoramiento. La detección lee el diseño de la carpeta y puede estar equivocada en cualquier dirección.

<a id="fix"></a>

## Arreglar

Mantenga el directorio de estado fuera de las carpetas sincronizadas. El `~/.opencodex` predeterminado no está sincronizado.

1. Parada opencodex.
2. Mueva o copie el directorio de estado a una ubicación no sincronizada, por ejemplo, `~/.opencodex-trial`.
3. Establezca `OPENCODEX_HOME` en esa ubicación o desconfigúrelo para usar el valor predeterminado e inicie opencodex nuevamente.

No borre el diario, relaje sus permisos o quite la verificación para que el error desaparezca. El diario contiene su gasto registrado, y el cheque es lo que evita que se escriba a través de un enlace inesperado.

Si el mensaje nombra una condición que no sea `extra-hard-link`, o el directorio de estado no está en una carpeta sincronizada, abra un problema con el mensaje de rechazo completo. No contiene ninguna ruta, cuenta o solicitud de contenido.
