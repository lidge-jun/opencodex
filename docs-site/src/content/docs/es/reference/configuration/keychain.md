---
title: Almacenar claves en el llavero del sistema operativo
description: Guarda claves API de proveedores y credenciales de Vertex en el Llavero de macOS, el Administrador de credenciales de Windows o Secret Service de Linux.
---

Para Vertex, la entrada específica del grupo de claves API (`POST /api/providers/keys`) acepta credenciales GCP completas en formato JSON de tipo `service_account` o `authorized_user` después de crear el proveedor. El formulario de creación o edición y `ocx provider add --api-key` rechazan ese JSON antes de guardar: crea el proveedor sin clave y añade después el JSON mediante su grupo de claves. Pega el contenido JSON, no una ruta de archivo de Windows, Unix o relativa.

Puedes pegar varios objetos JSON separados por comas o espacios: se guardan como entradas independientes del grupo y la primera queda activa. La configuración contiene únicamente referencias `gcp-sa:<account>`, nunca el JSON de las credenciales. Si mezclas JSON y claves literales, se rechaza toda la entrada; añade las claves literales por separado. Los fallos de almacenamiento conservan la configuración y devuelven un error fijo sin mostrar las credenciales. Un marcador con cuenta vacía es inválido y no recurre a las credenciales del equipo.

Pega un objeto de credenciales o una secuencia de objetos, sin una matriz exterior ni una cadena entre comillas. Se rechaza el texto mal formado. Si una credencial seleccionada se elimina o deja de poder leerse, Vertex rechaza la solicitud aunque tenga en caché un token de acceso obtenido con ella.

Al eliminar una clave o un proveedor, o sustituirlo con `ocx provider add --force`, sus credenciales GCP sin referencias se eliminan después de guardar la configuración. Las que otro proveedor todavía utilice se conservan. Si falla la limpieza del almacén del sistema operativo, se solicita una inspección manual mediante una advertencia; no se revierte la eliminación ya guardada en la configuración.

Las operaciones habituales de almacenamiento y restauración en el llavero conservan los marcadores GCP y su JSON en el almacén del sistema operativo. No se permite restaurar ese JSON mediante un alias `keychain:`. La limpieza conserva las cuentas que sigan referenciadas por cualquiera de los dos formatos de marcador. Tampoco se permite usar como clave API un alias `keychain:` que contenga JSON de GCP: para autenticar Vertex, selecciona su referencia `gcp-sa:`.

Las claves API literales deben ser texto simple del token. La resolución y restauración de claves literales rechazan objetos, matrices y cadenas JSON entre comillas, incluidos los envoltorios con texto de credenciales escapado. La escritura de credenciales y la persistencia de sus marcadores comparten el bloqueo de la transacción de limpieza: una eliminación simultánea no puede borrar el JSON entre la lectura de comprobación y la confirmación del marcador.

De forma predeterminada, `apiKey` y `apiKeyPool` se guardan en `config.json` con modo 0600 y escrituras atómicas. Para mantener las claves fuera de ese archivo, pásalas al almacén de credenciales del sistema operativo:

```bash
ocx provider keychain deepseek status    # store: file | env | keychain, and whether the keychain answers
ocx provider keychain deepseek store     # move active key + pool into the OS keychain
ocx provider keychain deepseek restore   # bring the plaintext back and delete the keychain items
```

Estas operaciones también están disponibles mediante `GET`/`POST /api/providers/keychain`. Después de `store`, `config.json` contiene `"apiKey": "keychain:deepseek"` y las entradas del grupo usan `keychain:deepseek/<id>`. El secreto se guarda bajo el servicio `opencodex.provider-api-key.v1` en el Llavero de macOS, el Administrador de credenciales de Windows o Secret Service de Linux. Las copias de seguridad de `config.json` contienen solo referencias. La rotación y la conmutación por error siguen funcionando: las entradas se comparan por referencia y una rotación nunca vuelve a escribir la clave en texto sin cifrar.

Antes de modificar la configuración, `store` escribe y vuelve a leer cada entrada. Si el llavero no está disponible o la lectura no coincide, devuelve 503 y conserva el archivo. Durante una solicitud, una referencia que no se puede leer no aporta ninguna credencial y produce una advertencia por clave; no se recurre a una copia en texto sin cifrar.

No actives esta opción si el proxy se ejecuta como servicio sin sesión interactiva (systemd, launchd o Task Scheduler) o en un contenedor sin un llavero desbloqueado: las solicitudes se rechazarían al no poder leer las claves. En ese caso, usa una referencia `${ENV_VAR}` y proporciona la variable en el entorno del servicio. `store` deja intactas las referencias a variables de entorno.
