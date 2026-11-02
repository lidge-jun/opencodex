---
title: "Inspección de respuestas y respuestas grandes"
description: "Cómo se relacionan la retención limitada de diagnósticos, la inspección en streaming y la entrega de respuestas."
---

OpenCodex mantiene los diagnósticos de respuesta limitados sin hacer que el límite de registro sea un límite en los bytes entregados a su cliente. Otros límites de proveedor, solicitud y transporte siguen aplicándose de forma independiente.

<a id="json-and-ordinary-error-responses"></a>

## JSON y respuestas de error ordinarias

La inspección JSON retiene como máximo 32 MiB de bytes fuente. Si el cuerpo excede esa asignación, el registro deja caer su copia retenida y continúa reenviando la respuesta original. No analiza un prefijo truncado como uso autorizado o metadatos del modelo. El uso ya suministrado por otra ruta de confianza se conserva; el uso faltante no se reemplaza con un cero inventado. Los diagnósticos de error ordinarios no JSON retienen solo los primeros 8 KiB y pasan a través de la lógica de redacción existente.

El cliente recibe trozos a medida que los lee en lugar de esperar una inspección de diagnóstico de todo el cuerpo. Un fallo de lectura se registra como 502 y la cancelación como 499 en el historial de solicitudes; estos resultados de diagnóstico no reescriben las cabeceras HTTP que ya se han enviado. El registro se finaliza una vez.

<a id="streaming-responses"></a>

## Respuestas de streaming

La inspección nativa SSE se detiene cuando se adelanta demasiado al consumo del cliente. La asignación es de 32 MiB más la sobrecarga de código fuente / nativo-prefetch, no un límite total de tamaño de respuesta o un límite en toda la memoria del proceso. Aún se inspecciona una respuesta más larga a través de su evento de finalización real, incluido el uso del terminal y el estado de continuación.

Después de que el cliente se desconecta, el drenaje limitado existente aún puede observar una finalización tardía de hasta 15 segundos o 32 MiB de inspección adicional. Un cierre forzado es diferente: descarta candidatos no completados en lugar de registrarlos como una respuesta completa. La selección de transporte existente y los límites de memoria WebSocket no cambian. No se requiere ninguna configuración nueva.
