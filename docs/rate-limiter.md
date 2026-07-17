# Rate Limiter para OpenCodex

## Descripción

Módulo de limitación de tasa (rate limiting) configurable para el servidor OpenCodex. Permite controlar el número máximo de solicitudes que pueden llegar al endpoint `/v1/responses` en un período de tiempo determinado.

## Características

- **Token Bucket con distribución uniforme**: Distribuye las solicitudes uniformemente a lo largo del período de tiempo (ej: 20 solicitudes por minuto = 1 solicitud cada 3 segundos)
- **Sliding Window (modo burst)**: Permite ráfagas de solicitudes hasta alcanzar el límite
- **Configurable**: Ajusta el número máximo de solicitudes, la ventana de tiempo y el modo de distribución
- **Headers estándar**: Incluye headers `X-RateLimit-Limit`, `X-RateLimit-Remaining` y `Retry-After`

## Configuración

Para habilitar el rate limiter, agrega la siguiente configuración a tu archivo `config.json` (usualmente en `~/.opencodex/config.json`):

```json
{
  "rateLimit": {
    "enabled": true,
    "maxRequests": 20,
    "windowMs": 60000,
    "evenDistribution": true
  }
}
```

### Opciones de Configuración

| Parámetro | Tipo | Valor por defecto | Descripción |
|-----------|------|-------------------|-------------|
| `enabled` | boolean | `false` | Habilita o deshabilita el rate limiting |
| `maxRequests` | number | `20` | Número máximo de solicitudes permitidas por ventana |
| `windowMs` | number | `60000` | Duración de la ventana en milisegundos (60000 = 1 minuto) |
| `evenDistribution` | boolean | `true` | Si es `true`, distribuye las solicitudes uniformemente. Si es `false`, permite ráfagas |

## Ejemplos de Configuración

### Ejemplo 1: 20 solicitudes por minuto con distribución uniforme (recomendado)

```json
{
  "rateLimit": {
    "enabled": true,
    "maxRequests": 20,
    "windowMs": 60000,
    "evenDistribution": true
  }
}
```

Esto permite exactamente 20 solicitudes por minuto, distribuidas uniformemente (aproximadamente 1 solicitud cada 3 segundos).

### Ejemplo 2: 10 solicitudes por minuto permitiendo ráfagas

```json
{
  "rateLimit": {
    "enabled": true,
    "maxRequests": 10,
    "windowMs": 60000,
    "evenDistribution": false
  }
}
```

Esto permite hasta 10 solicitudes inmediatas (ráfaga), luego bloquea hasta que pase un minuto desde la primera solicitud.

### Ejemplo 3: 1 solicitud cada 5 segundos

```json
{
  "rateLimit": {
    "enabled": true,
    "maxRequests": 12,
    "windowMs": 60000,
    "evenDistribution": true
  }
}
```

Esto permite 12 solicitudes por minuto, con una solicitud disponible cada 5 segundos.

## Respuestas

### Cuando se excede el límite (HTTP 429)

```json
{
  "error": {
    "type": "rate_limit_error",
    "message": "Too many requests. Maximum 20 requests per 60 seconds allowed."
  }
}
```

Headers incluidos:
- `X-RateLimit-Limit`: Límite máximo de solicitudes
- `X-RateLimit-Remaining`: Solicitudes restantes en la ventana actual
- `Retry-After`: Segundos a esperar antes de reintentar

### Headers de ejemplo

```
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
X-RateLimit-Limit: 20
X-RateLimit-Remaining: 0
Retry-After: 45
```

## Uso desde CLI

Puedes configurar el rate limiter usando la API de gestión:

```bash
# Habilitar rate limiting con 20 solicitudes por minuto
curl -X PATCH http://localhost:10100/api/config \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "rateLimit": {
      "enabled": true,
      "maxRequests": 20,
      "windowMs": 60000,
      "evenDistribution": true
    }
  }'
```

## Implementación Técnica

El módulo utiliza dos algoritmos:

1. **Token Bucket** (cuando `evenDistribution: true`):
   - Los tokens se regeneran a intervalos regulares
   - Ideal para distribuir carga uniformemente
   - Previene ráfagas repentinas

2. **Sliding Window Counter** (cuando `evenDistribution: false`):
   - Cuenta las solicitudes en una ventana deslizante
   - Permite ráfagas hasta el límite
   - Más permisivo pero menos uniforme

## Archivos

- `src/lib/rate-limiter.ts`: Implementación del rate limiter
- `src/server/index.ts`: Integración con el servidor (endpoint `/v1/responses`)
- `src/types.ts`: Definición del tipo `OcxConfig.rateLimit`

## Notas

- El rate limiter solo se aplica al endpoint `POST /v1/responses`
- Los endpoints de health check (`GET /healthz`) y API de gestión (`GET /api/*`) no están limitados
- El límite es global para todo el servidor, no por IP o usuario
- Al reiniciar el servidor, el contador se resetea
