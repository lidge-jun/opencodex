---
title: "Clientes MiniMax"
description: "Enrutar código MiniMax y comandos de texto MiniMax CLI a través de OpenCodex sin exponer las credenciales MiniMax."
---

MiniMax publica dos productos de línea de comandos diferentes. OpenCodex integra cada uno en el límite del protocolo que realmente expone:

- **MiniMax Code** (`mcode`) es un agente de codificación con proveedores personalizados Anthropic Messages.
- **MiniMax CLI** (`mmx`) es una plataforma multimodal CLI. Solo su recurso `text` habla del Anthropic -compatible API que OpenCodex puede encaminar.

<a id="minimax-code"></a>

## MiniMax Code

En la página de Modelos OpenCodex, ambas regiones del Plan de Codificación MiniMax anuncian la entrada de imagen para `MiniMax-M3` y `MiniMax-M3.1-Flash-Preview`. El conmutador **Imagen / multimodal** de Combo solo está disponible cuando cada modelo seleccionado admite la entrada de imágenes. El interruptor controla los archivos adjuntos de la imagen; no permite la carga de vídeos.

Instale e inicie sesión en MiniMax Code utilizando primero las instrucciones de MiniMax. Luego inicie OpenCodex y conecte la integración de archivos reversibles:

```bash
ocx start
ocx integration client enable --client mcode
ocx mcode
```

![Integración de MiniMax Code con datos de ejemplo aislados](/screenshots/minimax-code-integration.png)

La integración fusiona un bloque en `~/.minimax/config.yaml`:

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

La lista de modelos generados, las ventanas de contexto y las escaleras de esfuerzo de razonamiento provienen del catálogo OpenCodex en ejecución. Las ventanas de contexto pueden incluir [Estimaciones de proveedores personalizados](/es/reference/configuration/providers/#context-windows-on-custom-providers); si el catálogo no tiene ventana o escala de esfuerzo, se omite el campo correspondiente. MCode mantiene el esfuerzo seleccionado actualmente en la sesión, por lo que OpenCodex exporta `effortOptions` sin sobrescribir esa selección. El bloque no escribe una clave real, no reemplaza `defaultModel` y no cambia su inicio de sesión MiniMax. En MCode, elija un modelo bajo `custom_provider:opencodex/...`.

`ocx mcode` verifica que este proveedor apunta al proxy que se está ejecutando actualmente antes de lanzar el cliente. Después de la habilitación de una sola vez, `ocx sync` actualiza el bloque propietario cuando cambian las capacidades del puerto o catálogo. La sincronización automática nunca crea un bloque sin dueño, recrea uno que eliminó o sobrescribe un archivo que cambió después de que lo escribió OpenCodex; use el comando enable cuando desee volver a conectarse intencionalmente. Deshabilitar o restaurar a través del mismo sistema de integración auditado:

```bash
ocx integration client disable --client mcode
ocx integration client history --client mcode
ocx integration client restore --op <opId> [--confirm-drift]
```

`MINIMAX_DATA_DIR` y el legado `MAVIS_DATA_DIR` son honrados. Se rechazan las anulaciones relativas porque OpenCodex y MCode pueden iniciarse en diferentes directorios de trabajo.

## MiniMax CLI (`mmx`)

Instale el CLI oficial por separado:

```bash
npm install -g mmx-cli
mmx --version
```

Enrutar un comando de texto a través de OpenCodex mediante el wrapper y un identificador de modelo OpenCodex:

```bash
ocx mmx text chat \
  --model anthropic/claude-opus-5 \
  --message "Explain this function"

ocx mmx --output json text chat \
  --model openai/gpt-5.6-sol \
  --message "Return a JSON summary"
```

Códigos duros MMX `/anthropic/v1/messages` debajo de su base API URL. El envoltorio comienza a puente temporal de loopback durante toda la vida del proceso hijo. Solo acepta POST solicitudes a esa ruta Messages y `/anthropic/v1/messages/count_tokens`, cartografiarlos a OpenCodex existente `/v1/messages` y `/v1/messages/count_tokens` Plano de datos mientras preservar los cuerpos de solicitud y los datos de consulta. Canonical OpenCodex solicitud de traducción, la contabilidad de uso y la autenticación configurada del proveedor descendente permanecen en efecto; Los proveedores reciben `x-api-key` o transporte de portador según su configuración. La transmisión conserva los eventos de mensajes y contenido Anthropic. Antes de salir, el puente elimina los encabezados de credenciales de admisión entrantes y fija el público
`opencodex-loopback` marcador de posición. Los recursos arbitrarios de Anthropic no se representan, y El puente nunca se expone más allá del bucle.

La envoltura también crea un `MMX_CONFIG_DIR` temporal que contiene solo ese marcador de posición, luego lo elimina después de las salidas `mmx`. Sus tokens `~/.mmx/config.json`, OAuth y MiniMax API nunca se cargan ni copian.

Los siguientes límites son intencionales:

- Sólo `text chat` y `text repl` se encaminan a través de OpenCodex.
- `--api-key`, `--base-url` y `--region` son rechazadas por la envoltura para que las credenciales de llamada o los selectores de destino no puedan entrar en conflicto con el puente aislado.
- La envoltura es solo bucle porque MMX no puede enviar el encabezado de admisión dedicado `x-opencodex-api-key` de OpenCodex para un enlace remoto.
- Ejecutar el plan `mmx` para `image`, `video`, `speech`, `music`, `vision`, `search`, `quota`, `auth`, `config`, `file` y `update`; los llaman MiniMax - APIs específicas que OpenCodex no emula.

`mmx` por defecto su modelo de texto a `MiniMax-M3`. Pase `--model <provider/model>` cuando desee una ruta específica de OpenCodex; de lo contrario, las reglas de enrutamiento del modelo OpenCodex normales decidirán si el id predeterminado está disponible.
