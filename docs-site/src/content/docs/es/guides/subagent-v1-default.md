---
title: "Por qué v1 es la interfaz de subagentes predeterminada"
description: "Qué impide la limitación de tareas cifradas de v2, por qué OpenCodex utiliza v1 y qué opciones existen si prefiere v2."
---

OpenCodex se instala con la interfaz de subagentes en **v1**. Las páginas Panel, Modelos y Subagentes solicitan confirmación antes de cambiar a **base** o **v2** y enlazan esta explicación. La CLI no solicita esa confirmación.

El motivo es concreto: de forma predeterminada, en v2 un modelo enrutado no puede leer la tarea cifrada que recibe de un modelo nativo de ChatGPT. Esto afecta al caso habitual de un agente GPT que crea un subagente Grok, Claude o GLM. Las excepciones explícitas son `keepNativeChatGptOnV1`, que conserva los modelos nativos de ChatGPT en v1 mientras los enrutados usan v2; un destino autorizado que pueda procesar la tarea cifrada mediante `allowEncryptedV2AgentTasks: true`; o la recuperación experimental `agentTaskRecovery`, descritas más abajo.

<a id="what-you-see-when-it-happens"></a>

## Qué ocurre cuando falla

La creación del subagente se rechaza para evitar que reciba una tarea vacía sin advertencia:

```json
{
  "error": {
    "code": "unreadable_encrypted_agent_task",
    "message": "Routed V2 worker task is encrypted for the native ChatGPT backend and cannot be read by the selected provider. Use plaintext V2 agent-message delivery or select a native ChatGPT model."
  }
}
```

La respuesta es HTTP 400 y nunca devuelve el texto cifrado. El rechazo es deliberado: reenviar una carga ilegible entregaría al subagente instrucciones vacías y podría producir una respuesta incorrecta presentada con seguridad.

<a id="why-it-happens"></a>

## Por qué ocurre

![Comparación de la delegación: en v1, ChatGPT envía una tarea sin cifrar mediante OpenCodex y el subagente enrutado puede leerla. En v2 envía encrypted_content del backend de ChatGPT; OpenCodex no puede descifrarlo y la solicitud falla con unreadable_encrypted_agent_task al cruzar el límite entre proveedores.](../../../../assets/subagent-v2-encrypted-task.svg)

En v1, el agente principal emite la tarea del subagente como texto sin cifrar. OpenCodex la lee y la enruta; el subagente recibe instrucciones que puede ejecutar.

En v2, el agente principal emite la tarea como `encrypted_content`, generado por el backend de ChatGPT. La clave permanece en ese backend; OpenCodex nunca la tuvo. El proxy no puede descifrar ni reescribir el contenido: es texto cifrado real. Es una limitación estructural y ningún ajuste del proxy puede eliminarla.

La comparación de estas tres combinaciones muestra dónde aparece el límite:

| Combinación | v1 | v2 |
| --- | --- | --- |
| Agente ChatGPT a subagente enrutado | funciona | **falla de forma predeterminada**; excepciones: `keepNativeChatGptOnV1` conserva el agente nativo en v1, un destino autorizado usa `allowEncryptedV2AgentTasks: true` o la recuperación experimental `agentTaskRecovery` recupera la tarea |
| Agente enrutado a subagente enrutado | funciona | funciona |
| Agente ChatGPT a subagente ChatGPT | funciona | funciona: el backend puede descifrar lo que generó |

El backend puede leer su propio texto cifrado. El problema aparece al cruzar hacia otro proveedor.

<a id="is-it-fixed-upstream"></a>

## ¿Está resuelto en Codex?

Todavía falta la parte necesaria para este caso. Codex integró [openai/codex#35845](https://github.com/openai/codex/pull/35845), que permite recibir mensajes de colaboración sin cifrar. Ese cambio afecta al receptor: procesa texto que ya fue generado sin cifrar, pero no hace que un agente de OpenAI lo emita de esa forma.

La parte de envío sigue descrita en [#36376](https://github.com/openai/codex/issues/36376), reproducida con las versiones CLI 0.146 a 0.151 en Windows, macOS y Linux, y en [#37197](https://github.com/openai/codex/issues/37197), que solicita una política de entrega para el emisor. No hay un compromiso de implementación ni una fecha estimada del mantenedor.

OpenCodex registró esta consecuencia en [#92](https://github.com/lidge-jun/opencodex/issues/92), cerrada como no planificada: este repositorio no puede resolver el cifrado del emisor. La issue remite al trabajo en Codex.

<a id="what-the-three-modes-do-now"></a>

## Qué hace cada modo

| Modo | Interfaz | Cuándo elegirlo |
| --- | --- | --- |
| **v1** (predeterminado) | Todos los modelos anuncian las herramientas clásicas de creación con espacio de nombres. Cada creación puede indicar otro modelo directamente. | Si delega entre proveedores. Es el valor incluido en la instalación. |
| **base** | Respeta la asignación de Codex por modelo: Sol y Terra usan v2, Luna usa v1 y los modelos sin asignación siguen la opción de Codex. | Si desea la interfaz prevista por Codex y delega dentro de un mismo proveedor. |
| **v2** | Todos los modelos anuncian las herramientas concurrentes sin espacio de nombres. | Si desea las sesiones concurrentes nuevas y ambos agentes están del mismo lado del límite entre proveedores. |

base aparece en segundo lugar porque asigna v2 a Sol y Terra, modelos utilizados habitualmente como agentes principales. Para delegar de ChatGPT a un modelo enrutado, base tiene la misma limitación que v2.

<a id="if-you-already-chose-base-or-v2"></a>

## Si ya eligió base o v2

La actualización no sobrescribe una elección existente. El panel muestra el aviso una vez y espera una respuesta.

- **Continuar** conserva el modo actual y deja de preguntar.
- **Cambiar a v1** aplica v1 y deja de preguntar.

Ambas respuestas quedan registradas. Cerrar el aviso sin responder lo deja pendiente para la siguiente apertura del panel.

El modo se aplica a las sesiones **nuevas** de Codex. Inicie otra sesión después del cambio. Si un proceso de la aplicación que lleva tiempo abierto todavía muestra la interfaz anterior, ejecute `ocx sync` y reinicie esa aplicación.

<a id="if-you-want-v2-anyway"></a>

## Si prefiere utilizar v2

Hay cuatro opciones, en el orden recomendado:

1. **Mantener ChatGPT en v1.** Dentro de v2, `keepNativeChatGptOnV1` conserva Sol y Terra en v1 para que puedan crear subagentes Grok o Claude; los agentes principales enrutados utilizan v2.
2. **Delegar dentro del mismo proveedor.** Un agente enrutado que crea otro subagente enrutado utiliza texto sin cifrar en v2 y funciona normalmente.
3. **Confiar en un relay directo de Responses con clave API.** Un proveedor marcado explícitamente con `allowEncryptedV2AgentTasks: true` recibe la carga opaca en lugar de HTTP 400. Utilícelo únicamente con un destino que sepa que puede procesarla.
4. **Activar `agentTaskRecovery`.** Es experimental y está desactivado de forma predeterminada. Recupera los elementos cifrados ilegibles `NEW_TASK`, `MESSAGE`, `FOLLOWUP_TASK` y `FINAL_ANSWER` mediante el backend de ChatGPT, con consumo de cuota, latencia y dependencia de un comportamiento no documentado. La recuperación de Combo sigue limitada a los turnos de subagentes creados; los fragmentos de tokens divididos no son compatibles.

Consulte [Interfaz de subagentes](/es/guides/sub-agent-surface/) para conocer su funcionamiento y [Configuración de agentes](/es/reference/configuration/agents/) para los ajustes.

<a id="when-this-page-goes-away"></a>

## Cuándo dejará de ser necesaria esta página

Cuando Codex permita que un agente nativo de ChatGPT emita sin cifrar la tarea de un subagente enrutado, desaparecerá el motivo de este valor predeterminado. Entonces podrá volver a base, dejar de mostrar la confirmación y conservar esta página como registro histórico.

<a id="changing-the-mode"></a>

## Cambiar el modo

Panel, Modelos y Subagentes comparten el selector v1/base/v2 y solicitan confirmación antes de pasar a base o v2. Desde la CLI:

```bash
ocx v2 status
ocx v2 mode v1
```

La CLI no solicita confirmación. Modifica la misma configuración; elija el modo teniendo en cuenta estas limitaciones.

<a id="concurrent-child-limit"></a>

## Límite de subagentes simultáneos

En **Modelos → Ajustes del modelo**, el control de subagentes establece el máximo de agentes secundarios simultáneos, sin contar al principal. Está disponible en v1, base y v2, incluido el modo híbrido con la opción global de v2 desactivada. El modo de interfaz y este límite se eligen por separado.

Aumentar el límite permite más subagentes; no los crea automáticamente ni garantiza mayor velocidad. Inicie una sesión nueva de Codex después de cambiarlo. Si un proceso de la aplicación que lleva tiempo abierto sigue usando el límite anterior, reinícielo.
