---
title: "Google Vertex AI"
description: Cómo un proveedor de Vertex AI descubre sus modelos, qué credencial usa el descubrimiento y cómo los modelos Gemini 4 reciben imágenes de herramientas.
---

Esta página describe el comportamiento propio del proveedor Google Vertex AI (`google-vertex`, o
cualquier proveedor de Google con `googleMode: "vertex"`). La configuración y las credenciales se
explican en [Proveedores](/es/guides/providers/).

## Descubrimiento de modelos

Un proveedor de Vertex AI con modelos en vivo lista los modelos de editor de Google y recorre todas
las páginas del listado. Muestra los modelos de chat Gemini y Gemma y omite los modelos de
embeddings, voz, Live API, Imagen y Veo, así como los modelos Gemini que generan imágenes, como
`gemini-3.1-flash-image`, cuyas fichas de modelo indican que no admiten llamadas a funciones.

El descubrimiento usa la credencial del propio proveedor: una cuenta de servicio `gcp-sa:`, una
clave o, si no hay ninguna configurada, `GOOGLE_CLOUD_API_KEY` y después las credenciales
predeterminadas de la aplicación (ADC). Si no se puede leer una clave configurada como `keychain:`
o `$VARIABLE`, el descubrimiento se detiene en lugar de probar otra credencial, igual que las
solicitudes se niegan a empezar. Cuando el listado no se puede leer completo, OpenCodex conserva los
modelos anteriores o configurados en lugar de publicar solo una parte.

Los niveles de razonamiento siguen el preajuste: Gemini 4 Hydrogen ofrece low, medium, high (el
predeterminado) y xhigh; Gemini 4 Carbon y Argon ofrecen low, medium y high. Un modelo al que el
preajuste no asigna niveles, como `gemini-3-pro`, no muestra ninguno, porque sus solicitudes no
llevan nivel de razonamiento.

## Imágenes de herramientas en Gemini 4

En Vertex AI, `gemini-4-argon`, `gemini-4-carbon` y `gemini-4-hydrogen` reciben las imágenes
que devuelven las herramientas, como capturas de pantalla, dentro de la respuesta de función
correspondiente. En Argon esto evita el error 400 del servicio "Requests ending with a model turn
are not supported" tras una llamada a herramienta que produce imágenes; Carbon y Hydrogen usan la
misma forma documentada de respuesta de función, aunque ese error no se reprodujo en ellos. Las
imágenes de resultados duplicados o sin llamada correspondiente se conservan en un mensaje aparte
después de las respuestas de herramientas, con una marca que explica que no se pudieron emparejar.
No hace falta cambiar la configuración; este tratamiento es específico de estos modelos Gemini 4 en
Vertex.
