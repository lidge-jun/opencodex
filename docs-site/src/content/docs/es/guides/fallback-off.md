---
title: "Desactivar el fallback"
description: Desactiva el fallback de modelos o proveedores por alcance y consulta qué ocurre cuando un Remote Link Child no puede acceder a su Home.
---

OpenCodex puede atender una solicitud con otro modelo o proveedor si falla el elegido: un [combo](/es/guides/combos/) pasa al siguiente destino, un [perfil de enrutamiento](/es/guides/routing-profile-editor/) prueba el siguiente candidato, un subagente recorre su cadena de modelos alternativos y el bloqueo estricto de la cuenta principal puede usar su modelo alternativo configurado. Todos estos mecanismos están habilitados por defecto.

Desactiva un tipo de fallback cuando prefieras recibir un error claro en lugar de una respuesta de un destino que no elegiste.

<a id="what-counts-as-a-fallback"></a>

## Qué se considera fallback

Un fallback es un salto a un **modelo diferente** o un **proveedor diferente**:

| Tipo | Ejemplo | Ajuste |
|---|---|---|
| Fallback de modelo | Falla `anthropic/claude-opus` y respondería `anthropic/claude-sonnet` | `model` |
| Fallback de proveedor | Falla `anthropic/claude-opus` y respondería `openai/gpt-6-sol` | `provider` |

La rotación entre cuentas o claves API de **un mismo pool de proveedor** para el mismo modelo no es fallback. Permite absorber el límite de tasa de una cuenta y sigue funcionando con cualquier ajuste de esta página. Tampoco se consideran fallback los reintentos al mismo destino ni los cambios de transporte que conservan ese destino.

<a id="turn-fallback-off"></a>

## Desactivar el fallback

```bash
ocx fallback off                               # model and provider fallback, everywhere
ocx fallback off --kind provider               # only cross-provider hops
ocx fallback off --route combo/coding          # one combo, routing profile or model selector
ocx fallback off --provider anthropic          # hops that leave one provider
ocx fallback on --route combo/coding           # an exception under a global off
ocx fallback clear --route combo/coding        # remove an override
ocx fallback status                            # current settings and the last fallback
```

Los mismos ajustes aparecen en el dashboard: la tarjeta **Fallback**, al final de **Dashboard**, contiene los ajustes globales, las excepciones y el último fallback ejecutado o rechazado.

<a id="precedence"></a>

### Prioridad

1. Un **dispositivo** configurado en off siempre rechaza el fallback (consulta los [ajustes por dispositivo](#per-device-settings)). Este alcance solo puede denegarlo: activarlo no permite un salto que otro alcance rechaza.
2. En los demás casos, tiene prioridad el ajuste más específico: **ruta**, después **proveedor** y finalmente **global**.
3. Si no hay ningún ajuste, el fallback está permitido, que es el comportamiento actual.

Los ajustes se guardan en `config.json`, bajo `fallback`:

```json
{
  "fallback": {
    "provider": false,
    "routes": { "combo/coding": { "provider": true } },
    "providers": { "anthropic": { "model": false } },
    "devices": { "lnk_0123456789abcdef": { "localFallback": false, "model": false } }
  }
}
```

Un valor final mal formado se ignora, de modo que la resolución de políticas usa el siguiente alcance aplicable y los diagnósticos de `ocx config` lo identifican. En cambio, una escritura de la configuración completa que contenga ese valor se rechaza.

<a id="the-error-you-get"></a>

## El error recibido

Un fallback rechazado devuelve el **estado del fallo que lo provocó**: un 429 rechazado sigue siendo 429, conserva `Retry-After` y devuelve este cuerpo:

```json
{
  "error": {
    "type": "fallback_refused",
    "code": "fallback_refused",
    "message": "combo/coding: anthropic/claude-opus failed (rate_limited). Provider fallback to openai/gpt-6-sol is off for route combo/coding, so OpenCodex did not send the request there. To allow it: ocx fallback on --kind provider --route combo/coding",
    "fallback": { "kind": "provider", "scope": "route", "scopeKey": "combo/coding",
                  "from": "anthropic/claude-opus", "to": "openai/gpt-6-sol", "trigger": "rate_limited" }
  }
}
```

La respuesta también incluye `x-opencodex-fallback: refused`. Si ya se sabe que el primer destino no está disponible, el rechazo ocurre antes de enviar nada y nunca se contacta al destino alternativo. El estado depende del motivo por el que se omitió el primer destino:

- Primer destino de un combo en enfriamiento o sin cuota: 429.
- Primer destino de un combo deshabilitado o no apto para la solicitud: 503.
- Cuenta principal bloqueada: 429.
- Modelo de subagente no disponible: 503.

Después de un fallo real del proveedor, el rechazo conserva el estado de ese fallo.

<a id="remote-link-children-and-hub-clients"></a>

## Remote Link Children y clientes Hub

Un Remote Link Child y un cliente Hub nunca atienden solicitudes con sus proveedores locales. Cuando el Home no está disponible, el Child devuelve un `503` reintentable (el relé del dashboard de un cliente Hub devuelve `502`) con:

```json
{ "error": "link tunnel unavailable", "code": "home_unreachable", "message": "The Home is unreachable, and OpenCodex did not serve this request from this device's local providers. …" }
```

No se envía nada a un proveedor local y la clave de enlace y el cuerpo de la solicitud nunca salen del dispositivo.

<a id="per-device-settings"></a>

### Ajustes por dispositivo

En el Home, cada dispositivo enlazado tiene dos ajustes en **Remote Link** o mediante la CLI:

```bash
ocx fallback local on --device mac-studio      # permission for local fallback while the Home is down
ocx fallback off --device mac-studio           # refuse model and provider fallback for this device's requests
```

`--device` acepta un alias o identificador de enlace de `ocx link status`, o el identificador de una clave de datos del Hub.

**Fallback local** es un permiso que consulta GOAT: al activarlo, GOAT puede trasladar el trabajo del dispositivo a sus propias sesiones mientras el Home no esté disponible. OpenCodex sigue devolviendo `home_unreachable` y nunca atiende al dispositivo localmente. Está desactivado hasta que lo actives.

<a id="status"></a>

## Estado

`ocx status --json` incluye un objeto `fallback` (en un Child, se consulta el del Home mediante el enlace). `GET /api/fallback` devuelve el mismo documento `ocx.fallback/1`: ajustes globales efectivos, excepciones, permiso de fallback local de cada dispositivo y los últimos 20 fallbacks ejecutados o rechazados, con fecha, ruta, origen, destino, motivo y alcance que tomó la decisión. La lista se guarda en memoria y se vacía al reiniciar el proxy. Nunca contiene cuerpos de solicitudes, claves ni identidades de cuentas.

Un Home compatible anuncia `fallback-policy/1` en `features` de `GET /readyz`.
