---
title: "Registro de gastos rechazado en una carpeta sincronizada"
description: "Por qué puede rechazarse el registro de gastos dentro de iCloud Drive u otra carpeta sincronizada y cómo recuperar un almacenamiento seguro."
---

Los rechazos de almacenamiento del registro de gastos devuelven HTTP 503 con el tipo `server_error` y el código `spend_ledger_storage_unavailable`. Es un problema de almacenamiento local: no afecta al estado de salud del proveedor ni de la cuenta. Los registros de solicitudes lo clasifican como `local-refusal`. Si la respuesta ya está en streaming, su evento de error final lleva el mismo código. Otras solicitudes de la misma sesión pueden funcionar si la condición del archivo es temporal.

Las versiones anteriores devolvían HTTP 502 con el prefijo engañoso "Provider unreachable". Las versiones actuales identifican el archivo y la comprobación que impidió abrirlo, por ejemplo:

```text
Spend-ledger storage could not be opened safely (journal: extra-hard-link).
```

<a id="what-the-check-is"></a>

## Qué se comprueba

opencodex guarda un registro de gastos en su directorio de estado (`~/.opencodex` de forma predeterminada, o `OPENCODEX_HOME`): el diario `spend-ledger.jsonl` y el archivo de sal `spend-ledger.salt`. Antes de escribir, comprueba que cada archivo sea regular, pertenezca al usuario, no sea un enlace simbólico y tenga exactamente una entrada de directorio. Un segundo enlace duro permitiría leer o modificar los mismos bytes desde otro nombre del volumen. Ante cualquier enlace inesperado, opencodex rechaza la escritura. La comprobación es estricta de forma deliberada.

| Condición en el mensaje | Descripción |
| --- | --- |
| `extra-hard-link` | Otra entrada de directorio apunta al mismo archivo. |
| `symbolic-link` | El archivo del registro de gastos es un enlace simbólico. |
| `not-regular-file` | La ruta del registro de gastos contiene algo que no es un archivo regular. |
| `foreign-owner` | El archivo pertenece a un usuario diferente. |
| `invalid-salt` | El archivo de sal existe pero su contenido no es una sal válida. |

El tipo de archivo que indica el mensaje es `journal`, `journal-compaction` (el archivo temporal que se escribe al compactar el diario) o `salt`.

<a id="why-a-synced-folder-triggers-it"></a>

## ¿Por qué una carpeta sincronizada lo desencadena?

Los servicios de sincronización de macOS, incluido iCloud Drive con la opción de sincronizar Escritorio y Documentos y los clientes de File Provider como OneDrive, Dropbox y Google Drive, pueden crear brevemente un segundo enlace mientras preparan o suben un cambio. Si el directorio de estado está dentro de una carpeta sincronizada, el diario puede tener dos enlaces durante un instante tras una escritura normal. Una solicitud que coincida con ese instante se rechaza; la siguiente puede funcionar. Cuando termina la sincronización, el archivo vuelve a tener un solo enlace, por lo que una inspección posterior puede no detectar ningún problema.

Al iniciarse, opencodex advierte si el directorio de estado se resuelve dentro de iCloud Drive (`~/Library/Mobile Documents`), de una carpeta File Provider (`~/Library/CloudStorage`), de Escritorio o Documentos cuando parece estar activa su sincronización con iCloud, o de Escritorio o Documentos cuando parece usarse Google Drive para escritorio. Para detectar este último caso busca `~/Library/CloudStorage/GoogleDrive-*` o `~/Library/Application Support/Google/DriveFS`. No consulta qué carpetas se han seleccionado en Google Drive: su mera presencia puede generar el aviso aunque Documentos no esté seleccionado. El aviso es orientativo. La detección se basa en la estructura de carpetas y puede tanto advertir sin que exista el problema como no detectarlo cuando sí existe.

<a id="fix"></a>

## Solución

Mantén el directorio de estado fuera de las carpetas sincronizadas. El directorio predeterminado `~/.opencodex` no está sincronizado.

1. Detén opencodex.
2. Mueve o copia el directorio de estado a una ubicación sin sincronización, por ejemplo `~/.opencodex-trial`.
3. Establece `OPENCODEX_HOME` en esa ubicación, o elimina esa variable para usar la predeterminada, y vuelve a iniciar opencodex.

No borres el diario, no relajes sus permisos ni elimines la comprobación para ocultar el error. El diario contiene los gastos registrados; la comprobación impide escribir a través de un enlace inesperado.

Si el mensaje indica una condición distinta de `extra-hard-link`, o el directorio de estado no está en una carpeta sincronizada, abre una issue con el mensaje completo de rechazo. El mensaje no contiene rutas, cuentas ni contenido de las solicitudes.