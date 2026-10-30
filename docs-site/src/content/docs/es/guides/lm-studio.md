---
title: Plantillas de chat estrictas de LM Studio
description: Configura un único mensaje de sistema al principio para los modelos Chat de LM Studio.
---

El preajuste **LM Studio (local)** activa `singleLeadingSystemMessage: true` para
el adaptador `openai-chat`. Esto reúne las instrucciones de sistema y de desarrollador
que solo contienen texto en un único mensaje de sistema al principio, separadas por
líneas en blanco. Admite identificadores de modelo personalizados, incluidos los sufijos
de cuantización y de checkpoint, sin depender del selector de compatibilidad por nombre de modelo.

Para un proveedor de LM Studio existente que hayas renombrado o personalizado, añade este
booleano explícitamente en el editor de proveedores. El valor guardado es independiente del
nombre del proveedor, el host y el puerto. Guardar en el mismo destino conserva un ajuste
omitido; un POST que cambie el destino debe volver a enviarlo. PATCH acepta un booleano o
`null` para eliminar la anulación. Eliminarla en el proveedor canónico de LM Studio restaura
el valor predeterminado del preajuste.

Configura `singleLeadingSystemMessage: false` para desactivar esta unión si la plantilla
acepta mensajes de instrucciones en orden cronológico. Los demás preajustes conservan sus
valores predeterminados. `foldDeveloperRoleToSystem` sigue controlando únicamente el rol de
desarrollador; activar la compatibilidad con un único mensaje tiene prioridad sobre esa
elección de rol y sobre la solución para instrucciones tardías basada en el nombre del modelo.

Mover instrucciones posteriores al principio cambia su alcance cronológico y puede invalidar
los prefijos de la caché de prompts. Las solicitudes traducidas conservan el orden de las
instrucciones de la representación intermedia: primero los prompts de sistema base y después
las instrucciones de desarrollador de la secuencia. El parser de Responses ya reúne los
elementos de sistema de la entrada en el prompt base, por lo que no se recupera su posición
original respecto a los elementos de desarrollador. El paso directo de Chat conserva el orden
relativo original de los mensajes de sistema y desarrollador. Ambas rutas normalizan la copia
de salida y conservan el orden de los mensajes del usuario y de los pares de herramientas.

Las partes que no sean texto en mensajes de sistema o desarrollador de Chat directo producen
un error explícito. En los documentos de desarrollador traducidos, los archivos permanecen en
un mensaje compatible con el rol de usuario en su posición original, mientras que el texto se
reúne en el mensaje de sistema inicial. Los mensajes de desarrollador con imágenes o audio
conservan su conversión existente al formato compatible con el usuario. No necesitas ejecutar
LM Studio para configurar este ajuste; la plantilla del modelo servido sigue determinando
qué otras funciones del protocolo admite.
