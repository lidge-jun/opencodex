---
title: "Requisitos de calidad de los pull requests"
description: "Preparación para revisión, responsabilidad del contribuidor, permisos y política de cierre de los PR de OpenCodex."
---

<a id="you-do-not-need-permission-to-fix-something"></a>

## No necesitas permiso para corregir un problema

Los PR no planificados que corrigen un problema que hayas encontrado son bienvenidos. Varias mejoras del proyecto llegaron así: un modelo enrutado bloqueado tras llamar herramientas, un proveedor que recibía parámetros de modelo incorrectos o imágenes que se convertían en texto dentro de los resultados de herramientas. Ninguna empezó con una conversación de planificación; exigirla habría impedido esas aportaciones.

Abrir primero una issue ayuda en trabajos grandes o de diseño, porque acordar el enfoque evita construir algo equivocado. Es una recomendación, no un requisito de admisión.

<a id="what-a-ready-pull-request-claims"></a>

## Qué afirmas al marcar un PR como listo

Marcar un PR como listo para revisión significa que el cambio está completo, se comprende y se ha probado. Abrirlo no transfiere la responsabilidad de la rama a los mantenedores.

Debes entender cada línea modificada, indicar los comandos exactos y sus resultados para respaldar las afirmaciones de validación, añadir pruebas de regresión específicas para cambios de comportamiento y estar disponible para resolver los comentarios de CI y de revisión. Los mantenedores identifican problemas; no se espera que reparen las ramas de los contribuidores, escriban las pruebas faltantes o conviertan los hallazgos automáticos en parches por ti.

Decir «probado» o «CI pasa» sin comandos ni resultados concretos no es evidencia.

<a id="automated-gates"></a>

## Comprobaciones automáticas

Antes de la revisión humana se ejecutan controles deterministas; cada mensaje de error indica qué corregir:

- **Calidad del PR (`enforce-target`).** El destino debe ser `dev` y la descripción debe explicar el cambio mediante **Summary** y **Test plan**, o contenido equivalente. Si se modifican archivos de `gui/`, o GitHub devuelve una lista incompleta para un cambio grande, la descripción debe incluir una captura de la interfaz. El control mantiene el PR en borrador y comenta hasta que exista la captura. Las listas incompletas se tratan como cambios de GUI por precaución. Un mantenedor puede eximir una modificación de `gui/` o un falso positivo añadiendo `gui-screenshot-waived`; añadir o quitar esa etiqueta vuelve a evaluar el control de inmediato. Los comentarios antiguos de mantenedores, como «no gui changes», siguen reconociéndose por compatibilidad en el siguiente evento del PR, pero el comentario por sí solo ya no activa el control privilegiado. Un contribuidor no puede concederse esa exención.
  Los PR de contribuidores sin permiso de escritura se abren en borrador y permanecen así hasta completar las cuatro casillas de preparación: validación local requerida superada con el alcance documentado, rama actualizada con `dev`, hallazgos correctos de Codex y CodeRabbit resueltos y confirmación de que el PR está listo. Al completar todas, el control lo marca como listo y notifica a los mantenedores de `MAINTAINERS.md`, salvo al autor. El estado y las acciones necesarias aparecen en un único comentario del bot que se actualiza en cada ejecución. La confirmación corresponde al commit exacto de la rama: un nuevo push devuelve el PR a borrador, restablece las casillas y la notificación y pide volver a validar ese código. Cambiar el destino a `dev` borra el aviso de rama incorrecta; el PR permanece en borrador hasta completar las casillas.
  Antes de aceptar la confirmación, el control comprueba lo verificable: la rama debe incluir el último commit de `dev` o estar como máximo 10 commits por detrás; además, deben estar resueltos los hilos de Codex y CodeRabbit creados por bots de revisión en el commit actual. Los hilos de otros autores no bloquean. La casilla local sigue la [política de alcance de pruebas](/es/contributing/#build-and-test-commands): ejecutar la suite completa de forma predeterminada o, si resulta demasiado costosa, ejecutar las regresiones específicas y documentar la excepción. Esa casilla es una declaración del autor: los contribuidores de forks no pueden iniciar la CI del repositorio y necesitan a un mantenedor. El control no puede verificar esa declaración; un nuevo push igualmente restablece todas las casillas. Los hallazgos de CodeRabbit fuera del diff que solo aparecen en el cuerpo de la revisión actual se suman al recuento pendiente mientras quede abierto un hilo del bot; resolver todos sus hilos libera esa casilla. Una afirmación refutada desmarca la casilla correspondiente y mantiene el borrador. Con la lista completa y los controles en verde, se añade `review-ready` como indicador visible.
  Editar el comentario de estado de CodeRabbit no activa el control. Un estado de commit `CodeRabbit` correcto lo activa mediante el evento `status` de la rama predeterminada de confianza. El control asocia el SHA con un único PR abierto cuya rama siga apuntando a él; después vuelve a consultar los hilos y los cuerpos de revisión antes de cambiar las casillas, las etiquetas, el comentario o el estado de borrador. Se ignoran las asociaciones ambiguas o antiguas y nunca se ejecuta código de la rama del PR con el token de escritura del control.
- **Higiene.** Los cambios de comportamiento necesitan una prueba. Añadir supresiones de lint o tipos, pruebas exclusivas u omitidas, bloques catch vacíos, cambios manuales a archivos generados o un lockfile modificado sin su manifiesto requiere una etiqueta de aprobación explícita. Un cambio de comentarios en código fuente no altera el comportamiento ni requiere una prueba.
- **CI multiplataforma.** Los PR ejecutan el subconjunto rápido de Ubuntu. Los trabajos que no son de PR se ejecutan mediante `workflow_dispatch` y en las ramas de publicación `main` y `preview`, según la lane elegida y los filtros de rutas. El trabajo completo de pruebas `platform-windows` solo se ejecuta en el horario nocturno o mediante `workflow_dispatch` con la lane predeterminada o `all`; un push a las ramas de publicación no lo activa. No se añaden ejecuciones por push a `dev` ni trabajos de plataforma macOS o Windows por PR. La comprobación agregada `ci` se crea para cada PR; la detección de rutas decide qué trabajos costosos hacen falta, también en PR hijos cuya base sea la rama de otro PR abierto.
- **Etiqueta de tipo.** La comprobación `label` deriva `bug`, `enhancement`, `documentation` o `chore` del título. Si no reconoce el prefijo (por ejemplo, `stack 3/5: …`), usa los commits. Los de la familia `chore` (`test:`, `ci:`, `refactor:`) no prevalecen sobre `fix:` o `feat:`. Si el PR mezcla tipos, se deja sin etiqueta en vez de adivinar; nunca se sobrescribe una etiqueta puesta por una persona.

CodeRabbit revisa los PR y sus hallazgos son recomendaciones. Corrige los válidos y explica por qué descartas los incorrectos. Sus hallazgos, por sí solos, no bloquean la integración.

<a id="when-a-workflow-change-takes-effect"></a>

### Cuándo entra en vigor un cambio de automatización

`enforce-target` y `label` usan la automatización de confianza de la rama predeterminada. El control del PR se ejecuta en `pull_request_target` y en los eventos `status` de CodeRabbit, cargados desde esa rama. Por tanto, el comportamiento con permiso de escritura solo cambia al promocionar la revisión del control a `main`. La CI multiplataforma se ejecuta en `pull_request` usando la referencia de merge del PR (`refs/pull/<number>/merge`), por lo que un cambio del workflow puede afectar a ese PR antes del merge, según los filtros del evento y la autorización de las ejecuciones desde forks.

<a id="sponsored-surfaces"></a>

## Áreas que necesitan el respaldo de un mantenedor

Los cambios de autenticación, credenciales, flujos de GitHub Actions, automatización de versiones e instalación de dependencias requieren que un mantenedor los respalde (`maintainer-sponsored`) antes de integrarlos. Una integración defectuosa en esas áreas es costosa y difícil de revertir; por eso tienen ese requisito específico. Las demás áreas están abiertas a contribuciones.

<a id="when-a-pull-request-is-closed"></a>

## Cuándo se cierra un PR

Un PR estancado con comentarios de revisión pendientes puede cerrarse, indicando claramente el motivo. El cierre no es un juicio sobre el contribuidor: puedes reabrirlo cuando resuelvas el motivo o sustituirlo por otro limpio. Pide una explicación si el motivo no está claro.

<a id="updating-an-older-readiness-checklist"></a>

## Actualizar una lista de preparación antigua

Si el control detecta la redacción retirada de CI local, conserva tu descripción y pide actualizar la primera casilla. Usa la redacción del aviso del bot, desmarca las cuatro casillas y guarda. Espera a que el bot reconozca la lista sin marcar, valida el commit mostrado y después vuelve a marcar las cuatro y guarda. Cambiar solo el texto dejando las casillas marcadas no cuenta como una declaración nueva. Un push o un cambio de destino invalida ese punto de control. El control sigue en rojo y el PR en borrador hasta completar la secuencia y las verificaciones habituales. Si guardas en el mismo instante que el punto de control, vuelve a editar el cuerpo y guárdalo más tarde; editar solo el título no cuenta.
