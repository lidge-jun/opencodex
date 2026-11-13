---
title: "Plugins locales"
description: "Cargue su propio código en el proxy al inicio para reescribir los envíos del proveedor, por ejemplo, para poner un proxy de compresión local frente a los proveedores."
---

Un plugin local es un archivo JavaScript que `ocx start` carga antes de que el proxy empiece a atender solicitudes. Puede inspeccionar cada envío al proveedor justo antes de que salga del proceso, redirigirlo o añadir encabezados. Esto permite colocar un sidecar local, como un proxy de compresión o una grabadora, delante del proveedor sin modificar opencodex.

Los plugins son locales para una instalación. opencodex no los descarga, actualiza ni firma.

<a id="where-plugins-live"></a>

## Donde viven los plugins

Ponga los archivos del plugin en `plugins/` dentro del hogar opencodex (`~/.opencodex/plugins/` o `$OPENCODEX_HOME/plugins/` cuando esa variable esté establecida):

```text
~/.opencodex/plugins/
  my-sidecar.ts
```

- Los archivos que terminan en `.ts`, `.js` o `.mjs` se cargan en orden de nombre.
- Los nombres que comienzan con `.` o `_`, y `*.d.ts`, se ignoran: cambie el nombre de un complemento a `_my-sidecar.ts` para apagarlo.
- El directorio es opcional. Sin ella no hay nada cargado.
- Un plugin se ejecuta dentro del proxy con sus credenciales, por lo que opencodex rechaza un archivo plugin o un directorio `plugins/` que es propiedad de otro usuario o escribible por grupo u otros, y rechaza enlaces simbólicos. Cada directorio por encima de `plugins/`, hasta `/`, también debe ser propiedad de usted o root y no escribirse por grupo u otros, a menos que sea pegajoso como `/tmp`. Arreglar permisos con `chmod go-w ~/.opencodex/plugins ~/.opencodex/plugins/*`; en sistemas cuya máscara predeterminada es `002`, compruebe los directorios padre también. En macOS, una concesión ACL a otro usuario o grupo que permita escribir, eliminar, cambiar permisos o añadir/eliminar entradas de la ruta impide la carga, incluso si el modo es `0600`; inspeccionar la ruta en sí con `/bin/ls -lebd -- <path>`. Solo lectura, denegación, solo herencia y concesiones solo al propietario de la ruta o al usuario en ejecución no bloquean la carga. Los nombres de visualización ACL como `root` o `0` no se tratan como prueba UID numérica. En Linux, se comprueban las ACL extendidas cuando `getfacl` está instalado. Sin ella, solo se verifican los bits de propietario y modo.
- En Windows, la carga automática del complemento está desactivada hasta que esté disponible una verificación de confianza ACL.

Reinicie el proxy después de agregar, cambiar o eliminar un plugin (`ocx service restart`, o detener e iniciar `ocx start` ). Cada plugin cargado imprime una línea `Plugin loaded: <name>` al inicio; un plugin omitido imprime una categoría de razón limitada. El texto de excepción del complemento RAW nunca se imprime automáticamente.

Para empezar una vez sin plugins, establece `OCX_PLUGINS=0`.

<a id="writing-a-plugin"></a>

## Escribir un plugin

El módulo debe exportar por defecto un objeto con una propiedad opcional `name` de tipo cadena y una función `setup`, que recibe el contexto. Un `setup` asíncrono dispone de cinco segundos para terminar. Los plugins se ejecutan en el mismo hilo que el proxy: si `setup` bloquea de forma síncrona, no se puede interrumpir y retrasa el inicio hasta que termine. Agotar el plazo tampoco detiene sus servidores o temporizadores ya iniciados. Inicia los recursos de larga duración únicamente después del trabajo que pueda fallar:

```ts
interface UpstreamTarget {
  url: string;            // absolute upstream URL; assign a new one to redirect
  headers: Headers;       // outbound headers, including credentials — never log them
  readonly transport: "http" | "websocket";
}

export default {
  name: "my-sidecar",
  setup(ctx: {
    log(message: string): void;
    registerUpstreamRewriter(rewrite: (target: UpstreamTarget) => void): void;
    onShutdown(teardown: () => void): void;
  }) {
    ctx.registerUpstreamRewriter(target => {
      const upstream = new URL(target.url);
      if (!upstream.pathname.endsWith("/chat/completions")) return;
      target.url = `http://127.0.0.1:9000${upstream.pathname}${upstream.search}`;
      target.headers.set("x-original-origin", upstream.origin);
    });
  },
};
```

El contexto también incluye `name`, `configDir` (el directorio de configuración de opencodex) y `pluginDir`.

Los plugins no pueden importar módulos opencodex - en el binario empaquetado no están en disco. Declare las interfaces pequeñas que necesita localmente, como anteriormente.

<a id="how-rewrites-behave"></a>

## Cómo se comportan las reescrituras

- El rewriter se ejecuta de forma síncrona en cada envío HTTP al proveedor y en la conexión WebSocket de Codex, después de que opencodex haya elegido el transporte. Debe ser rápido: realiza las comprobaciones de red en segundo plano y consulta un resultado en caché desde el rewriter.
- Un envío redirigido a una dirección de loopback (`127.0.0.1`, `::1`, `localhost`) se conecta directamente tanto por HTTP como por WebSocket de Codex, sin usar los proxies del proveedor ni `HTTP_PROXY`: un proxy en otra máquina no puede acceder al loopback local. Los demás destinos siguen la configuración habitual de salida, incluido `NO_PROXY`, evaluada con la URL reescrita en ambos transportes.
- El rewriter de WebSocket de Codex se ejecuta en cada turno, antes de reutilizar un socket inactivo del pool. Solo se reutiliza si coinciden el destino y los encabezados reescritos, excepto `x-codex-turn-state` y `x-codex-turn-metadata`. Estos dos encabezados viajan dentro de cada trama de solicitud y pueden variar entre turnos en un mismo socket; se descartan las modificaciones que el rewriter haga a esos dos encabezados. Si un plugin empieza o deja de redirigir, el cambio se aplica en el siguiente turno.
- La reescritura ocurre después de elegir el proveedor, la cuenta y la ruta; no cambia el enrutamiento, la selección de cuentas, los reintentos ni los registros de solicitudes.
- El envío llega al host elegido, que recibe la solicitud tal como la recibiría el proveedor, incluidas las credenciales.
- Si un rewriter lanza una excepción, opencodex revierte únicamente sus cambios en ese envío y lo deshabilita durante el resto del proceso. Los cambios de los rewriters anteriores se conservan; si era el único, la solicitud queda sin modificar. Si `setup` lanza una excepción o agota su plazo, se omite el plugin, se eliminan sus registros de handlers y se ignoran sus intentos posteriores de registro. Los demás plugins y el proxy se inician normalmente.
- Si el directorio de plugins existe pero no se puede leer, por ejemplo por sus permisos, se informa al iniciar en lugar de tratarlo como vacío.