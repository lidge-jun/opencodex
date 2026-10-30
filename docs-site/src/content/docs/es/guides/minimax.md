---
title: "Clientes MiniMax"
description: "Enruta MiniMax Code y los comandos de texto de MiniMax CLI mediante OpenCodex sin exponer sus credenciales."
---

MiniMax publica dos productos de línea de comandos diferentes. OpenCodex integra cada uno en el límite del protocolo que realmente expone:

- **MiniMax Code** (`mcode`) es un agente de codificación con proveedores personalizados Anthropic Messages.
- **MiniMax CLI** (`mmx`) es una CLI de plataforma multimodal. Solo su recurso `text` utiliza la API compatible con Anthropic que OpenCodex puede enrutar.

<a id="minimax-code"></a>

## MiniMax Code

En la página Modelos de OpenCodex, las dos regiones del plan de programación de MiniMax anuncian la entrada de imágenes para `MiniMax-M3` y `MiniMax-M3.1-Flash`. El interruptor **Imagen / multimodal** de un Combo solo está disponible cuando todos los modelos seleccionados admiten la entrada de imágenes. Este interruptor controla las imágenes adjuntas; no habilita la carga de vídeos.

Primero instala MiniMax Code e inicia sesión siguiendo las instrucciones de MiniMax. Después, inicia OpenCodex y conecta la integración reversible mediante archivos:

```bash
ocx start
ocx integration client enable --client mcode
ocx mcode
```

![Integración de MiniMax Code con datos de ejemplo aislados](/screenshots/minimax-code-integration.png)

La integración incorpora un bloque a `~/.minimax/config.yaml`:

```yaml
custom_provider:
  opencodex:
    name: OpenCodex
    kind: custom
    enabled: true
    api: anthropic-messages
    options:
      apiKey: opencodex-loopback
      baseURL: http://127.0.0.1:10100
      authMode: api-key
    models:
      anthropic/claude-opus-5:
        limit:
          context: 1000000
```

La lista de modelos generada, las ventanas de contexto y las escalas de esfuerzo de razonamiento proceden del catálogo de OpenCodex en ejecución. Las ventanas de contexto pueden incluir [estimaciones para proveedores personalizados](/es/reference/configuration/providers/#context-windows-on-custom-providers); si el catálogo no incluye una ventana o una escala de esfuerzo, se omite el campo correspondiente. MCode conserva en la sesión el esfuerzo seleccionado, por lo que OpenCodex exporta `effortOptions` sin sobrescribir esa selección. El bloque no escribe una clave real, no sustituye `defaultModel` ni cambia tu inicio de sesión en MiniMax. En MCode, elige un modelo bajo `custom_provider:opencodex/...`.

`ocx mcode` verifica que este proveedor apunta al proxy en ejecución antes de iniciar el cliente. Tras habilitarlo una vez, `ocx sync` actualiza el bloque que administra cuando cambia el puerto o las capacidades del catálogo. La sincronización automática nunca crea un bloque que no esté bajo su control, nunca vuelve a crear uno que hayas eliminado ni sobrescribe un archivo que haya cambiado después de que OpenCodex lo escribiera; utiliza el comando de habilitación cuando quieras volver a conectarlo de forma intencional. Puedes deshabilitarlo o restaurarlo mediante el mismo sistema de integración auditado:

```bash
ocx integration client disable --client mcode
ocx integration client history --client mcode
ocx integration client restore --op <opId> [--confirm-drift]
```

Se respetan `MINIMAX_DATA_DIR` y la variable antigua `MAVIS_DATA_DIR`. Se rechazan las rutas relativas en estas variables porque OpenCodex y MCode pueden iniciarse en directorios de trabajo diferentes.

## MiniMax CLI (`mmx`)

Instala la CLI oficial por separado:

```bash
npm install -g mmx-cli
mmx --version
```

Enruta un comando de texto a través de OpenCodex utilizando el envoltorio y un identificador de modelo de OpenCodex:

```bash
ocx mmx text chat \
  --model anthropic/claude-opus-5 \
  --message "Explain this function"

ocx mmx --output json text chat \
  --model openai/gpt-5.6-sol \
  --message "Return a JSON summary"
```

MMX tiene fijada en su código la ruta `/anthropic/v1/messages` bajo la URL base de su API. El envoltorio inicia un puente temporal en loopback que dura lo mismo que el proceso hijo. Solo acepta solicitudes POST a esa ruta de Messages y a `/anthropic/v1/messages/count_tokens`, y las dirige al plano de datos existente de OpenCodex, en `/v1/messages` y `/v1/messages/count_tokens`, conservando los cuerpos de las solicitudes y los datos de consulta. Se mantienen la traducción canónica de solicitudes de OpenCodex, la contabilidad de uso y la autenticación configurada para el proveedor de destino; los proveedores reciben `x-api-key` o autenticación de tipo bearer según su configuración. El streaming conserva los eventos de mensajes y contenido de Anthropic. Antes de reenviar una solicitud, el puente elimina las cabeceras entrantes de credenciales de admisión y fija el marcador de posición público `opencodex-loopback`. No actúa como proxy para otros recursos arbitrarios de Anthropic y nunca se expone fuera de loopback.

El envoltorio también crea un directorio temporal `MMX_CONFIG_DIR` que contiene únicamente ese marcador de posición y lo elimina después de que termine `mmx`. Nunca carga ni copia tu archivo `~/.mmx/config.json`, tus tokens OAuth ni tu clave API de MiniMax.

Los siguientes límites son intencionales:

- Solo `text chat` y `text repl` se enrutan a través de OpenCodex.
- El envoltorio rechaza `--api-key`, `--base-url` y `--region` para que las credenciales o los selectores de destino proporcionados por quien lo invoca no entren en conflicto con el puente aislado.
- El envoltorio solo funciona en loopback porque MMX no puede enviar la cabecera de admisión específica de OpenCodex, `x-opencodex-api-key`, cuando el proxy escucha en una dirección remota.
- Ejecuta `mmx` directamente para `image`, `video`, `speech`, `music`, `vision`, `search`, `quota`, `auth`, `config`, `file` y `update`; esos comandos utilizan API específicas de MiniMax que OpenCodex no emula.

`mmx` utiliza `MiniMax-M3` como modelo de texto predeterminado. Pasa `--model <provider/model>` cuando quieras una ruta concreta de OpenCodex; de lo contrario, las reglas habituales de enrutamiento de modelos de OpenCodex decidirán si el identificador predeterminado está disponible.
