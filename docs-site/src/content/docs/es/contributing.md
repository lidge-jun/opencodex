---
title: "Cómo contribuir"
description: "Desarrolla opencodex: entorno, estructura, convenciones y pasos para añadir proveedores o adaptadores."
---

<a id="setup"></a>

## Preparar el entorno

Para desarrollar desde el código fuente necesitas la CLI `bun` en `PATH`. El paquete npm publicado incluye su propio entorno de ejecución Bun; los scripts del paquete pueden usar esa dependencia incluida.

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run setup:hooks  # retire the managed pre-push and post-merge hooks
bun run dev:proxy    # proxy API in dev mode
bun run dev:gui      # dashboard dev server (another terminal)
bun run typecheck    # bun x tsc --noEmit
bun run test        # full suite (default)
```

`bun run setup:hooks` elimina los hooks administrados y retirados `pre-push` y `post-merge` si no se han modificado; conserva los personalizados. Ya no se exige un hook de pre-push. `bun run prepush` sigue disponible como comprobación manual opcional.

`bun run dev` es un alias de `bun run dev:proxy`. El servidor de desarrollo del dashboard se inicia con `bun run dev:gui`. El dashboard empaquetado que sirve `GET /` se genera con `bun run build:gui` en `gui/dist`.

El antiguo hook `post-merge` reconstruía `gui/dist` tras cada merge. Ahora, si un merge cambia `gui/`, debes ejecutar `bun run build:gui` para actualizar el dashboard empaquetado. El servidor de desarrollo se reconstruye bajo demanda y no necesita ese paso.

<a id="build-and-test-commands"></a>

## Comandos de compilación y pruebas

El paquete raíz usa TypeScript nativo de Bun, sin una compilación separada del servidor. Usa los scripts del repositorio para que los comandos locales coincidan con CI:

```bash
bun run typecheck                 # strict TypeScript check
bun run test:changed              # import-graph tests against the resolved dev merge base
bun run test                      # full suite (default)
bun test tests/routing/router.test.ts     # focused test file
bun run build:gui                 # Vite GUI build + package preparation
bun run privacy:scan              # credential/privacy scan used by CI
bun run prepare:package           # refresh package launchers/assets
```

La suite usa Bun 1.4.3, declarado en `testRunnerBun` de `package.json`; el entorno de ejecución distribuido es 1.4.4. `scripts/test.ts` busca Bun 1.4.3 en PATH o `~/.bun/bin`, o utiliza `OCX_TEST_RUNNER_BUN`. Si falta esa versión, instálala localmente: el selector no la descarga.

Ejecuta `bun run test` por defecto. Si la suite completa resulta desproporcionadamente costosa por el tamaño de la tarea, los recursos disponibles o la actividad de otros árboles de trabajo, ejecuta al menos las regresiones que prueben el comportamiento modificado, por ejemplo `bun test tests/<domain>/<name>.test.ts`. Explica el motivo, los comandos exactos, sus resultados y la cobertura pendiente. `bun run test:changed` complementa esa cobertura, pero no detecta todas las dependencias indirectas. Depender solo de CI o saltarse las pruebas locales no constituye una exención general. Antes del merge, los checks requeridos deben pasar para el commit actual del PR.

`test:changed` usa la primera referencia de comparación disponible: `upstream/dev`, `origin/dev` o la rama local `dev`. Informa de esa referencia y del commit exacto obtenido con `git merge-base HEAD <ref>`, y pasa su SHA a Bun.

Si se agota el plazo de una ejecución de pruebas, el runner muestra stdout y stderr ya capturados y termina con código 124. Tras finalizar un proceso, permite un segundo para vaciar sus tuberías, evitando que un descendiente las mantenga abiertas indefinidamente. La captura incompleta se informa y no cuenta como éxito, aunque el hijo directo haya terminado con código 0.

Las pruebas de Bun se organizan por dominios que reflejan `src/`: `tests/server/`, `tests/providers/`, `tests/adapters/openai/`, `tests/cli/`, etc. El mapa es `scripts/test-layout/layout.json` y lo comprueba `tests/test-layout.test.ts`. Cada prueba nueva debe ir en su dominio y registrarse en el mapa; la prueba de herramientas indica qué entrada falta. `tests/helpers/` contiene fixtures compartidos y `tests/helpers/repo-root.ts` permite acceder a archivos del repositorio. `tests/e2e-style/` reúne escenarios más amplios de paridad nativa. Añade las regresiones junto a las pruebas del subsistema modificado; `bun test tests/<domain>` ejecuta un subsistema.

Este sitio vive en `docs-site/` y usa Astro + Starlight:

```bash
cd docs-site && bun install && bun dev
```

<a id="docs-publishing"></a>

## Publicación de documentación

La documentación pública se publica en GitHub Pages en <https://opencodex.me/es/>. El workflow `.github/workflows/deploy-docs.yml` se ejecuta al subir a `main` cambios en `docs-site/**` o en el propio workflow; compila `docs-site` y publica el sitio generado. Antes de subir cambios de documentación, ejecuta:

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

<a id="ci-and-releases"></a>

## CI y versiones

Los workflows de GitHub Actions mantienen separadas estas funciones:

- **CI multiplataforma** (`.github/workflows/ci.yml`) ejecuta el subconjunto rápido de Ubuntu en los PR. Los pushes a `main`/`preview` y `workflow_dispatch` ejecutan los trabajos seleccionados que no son de PR, según los filtros de rutas y la selección de lane. Los pushes a `dev` no ejecutan la suite completa. El trabajo completo de pruebas `platform-windows` solo se ejecuta en el horario nocturno o mediante `workflow_dispatch` con la lane predeterminada o `all`, no al subir a las ramas de publicación. Los trabajos de plataforma cubren instalación, tipos, pruebas, privacidad, compilación de prueba del asistente de versiones, build de GUI y `ocx help`. Una matriz independiente de npm comprueba la instalación global con el Bun incluido; su prueba de instalación en Windows es distinta de la suite completa de Windows.
- **Release** (`.github/workflows/release.yml`) es manual. Antes de una simulación o publicación exige que el commit exacto de la versión (`GITHUB_SHA`) ya tenga una ejecución exitosa de CI multiplataforma; no repite toda esa validación.
- **Stale needs-info** (`.github/workflows/stale-needs-info.yml`) se ejecuta a diario en la rama predeterminada. Advierte tras 14 días sin actividad en una issue abierta con `needs-info` y la cierra como no prevista después de otros 7 días. Una actualización elimina la advertencia. Para conservar un trabajo abierto a largo plazo, retira `needs-info`, por ejemplo al pasarlo a `roadmap`.
- **Calidad de issues** (`.github/workflows/enforce-issue-quality.yml`) valida las plantillas de issues nuevas o editadas. Aplica etiquetas de tipo (`bug`, `enhancement`, `provider-compatibility`, `documentation`) y etiquetas de **área** a partir del formulario y de indicios del título y resumen: `provider`, `account-pool`, `catalog`, `gui`, `cli`, `proxy`, `platform`, `streaming`, `tools`, `install` y `service`. Las etiquetas de tipo y proceso se mantienen separadas: puedes filtrar por `bug` + `account-pool`. Usa el desplegable de área en lugar de inventar etiquetas por proveedor. El área Documentation no añade una segunda etiqueta: el formulario ya incluye `documentation`. Los mantenedores pueden volver a aplicar áreas a las issues abiertas mediante workflow_dispatch `backfill_open_areas` cuando el workflow esté en la rama predeterminada.

Usa el asistente para preparar versiones. Primero elige la versión prevista y ejecuta `.github/workflows/dev-version-bump.yml` desde la rama predeterminada con `intended-version=<version>` y `mode=pre-move`. Revisa y fusiona en `dev` el PR generado; después promueve a `main` o `preview` y ejecuta el asistente. Si `dev` ya supera la versión prevista, el workflow devuelve `changed=false` y no necesita un PR de incremento. La publicación sigue exigiendo CI exitoso para el commit exacto de la versión.

```bash
bun run release <version>           # commits/pushes the bump; publish workflow is dry-run by default
bun run release --bump minor        # derive the next patch, minor, or major version from tags and npm channels
bun run release <version> --publish # publish after the CI-gated dry run is understood
bun run release:watch               # watch the newest Release workflow run
```

`--bump patch|minor|major` permite elegir el incremento en lugar de indicar una versión explícita. Cuando una etiqueta preview abre un núcleo de versión superior, `--bump patch` rechaza continuar la línea estable anterior; la corrección debe publicarse en el núcleo de la preview abierta.

<a id="branches"></a>

## Ramas

- `dev`: único destino de integración. Abre aquí tu PR.
- `main`: versiones, mediante promoción de `dev` controlada por los mantenedores. No es destino de PR de funcionalidades.
- `preview`: versiones preliminares.

La línea `dev2-go` y su política de mantener dos implementaciones se retiraron. Su historial está disponible en modo de solo lectura en [lidge-jun/opencodex-go-archive](https://github.com/lidge-jun/opencodex-go-archive). TypeScript nativo de Bun en `dev` es la única línea de ejecución.

Se aceptan PR que actualicen una rama mediante rebase. Indica en la descripción los commits originales que estás incorporando.

<a id="pull-requests"></a>

## Pull requests

- Usa **`dev`** como destino, tanto para funcionalidades como para correcciones; no uses **`main`**.
- Parte del commit actual de **`dev`**. El check **`enforce-target`** rechaza ramas cuya base de merge se encuentre en el extremo de **`main`** mientras estén muy por detrás de la base del PR, como ocurrió en #644.
- Completa la plantilla del repositorio: `Summary`, `Verification` y `Checklist`. Explica qué cambia y por qué y documenta el plan de pruebas y sus resultados. El check rechaza descripciones vacías, compuestas solo por marcadores o que usen `\n` literal en lugar de saltos de línea reales.
- Si cambias `gui/`, incluye una captura real de la interfaz en la descripción. `enforce-target` vuelve a comprobarla cuando se edita la descripción. Adjunta la imagen al editor; no la añadas a la rama del PR, porque el squash la incorporaría a `dev`. Para subirla por CLI se utiliza la rama `pr-assets` y un enlace fijado al SHA del commit.
- Los workflows de confianza `enforce-target` y `label` usan **`pull_request_target`**. Su lógica de control nueva solo entra en vigor al llegar a la rama predeterminada, como se documentó en #631. La CI multiplataforma usa **`pull_request`** y sus cambios se aplican desde la rama de destino del PR.

<a id="project-maintainers"></a>

## Mantenedores

Los responsables, sus funciones y la política de revisión y merge se documentan en [`MAINTAINERS.md`](https://github.com/lidge-jun/opencodex/blob/main/MAINTAINERS.md). `.github/CODEOWNERS` declara la responsabilidad de revisión de las rutas del repositorio, incluidas las sensibles para la seguridad.

Los PR de contribuyentes normalmente necesitan aprobación de un mantenedor. Un mantenedor actual con acceso `maintain` o `admin` puede integrar explícitamente un PR en `dev`, incluido uno propio, sin segunda aprobación. Debe registrar la decisión y la validación del commit exacto. Siguen vigentes CI, la revisión de seguridad y las objeciones pendientes de otros mantenedores. Esta excepción no cambia las reglas de `main`/`preview` ni permite pushes directos, force-pushes o eliminación.

<a id="conventions"></a>

## Convenciones

- **Módulos ES** (`import`/`export`), TypeScript y modo `strict`. Mantén en verde `bun x tsc --noEmit`.
- **Máximo aproximado de 500 líneas por archivo**: divide por responsabilidad, como los sidecars `web-search/` y `vision/`, con módulos pequeños tras un `index.ts`.
- **Errores asíncronos en los límites**: un sidecar no debe propagar una excepción a la ruta de la solicitud; debe degradarse mediante un marcador controlado.
- **Fuente de verdad de estructura**: los invariantes mantenidos viven en `structure/`, los flujos públicos en `docs-site/` y las notas de planificación e investigación en `devlog/`.
- **Conserva las exportaciones**: otros módulos pueden depender de ellas.

<a id="adding-a-provider-to-the-catalog"></a>

## Añadir un proveedor al catálogo

Los selectores y valores iniciales de proveedores se derivan del registro canónico (`src/providers/registry/entries-extended.ts`):

```ts
{
  id: "my-provider",
  label: "My Provider",
  baseUrl: "https://api.example.com/v1",
  adapter: "openai-chat",
  authKind: "key",
  dashboardUrl: "https://example.com/keys",
  models: ["model-a", "model-b"],
  defaultModel: "model-a",
  noVisionModels: ["model-a"],   // text-only models → vision sidecar describes images
},
```

`src/providers/derive.ts` utiliza esa entrada en `ocx init`, `ocx provider`, los preajustes del dashboard, el inicio con clave API y la configuración inicial OAuth. `enrichProviderFromCatalog()` copia metadatos y clasificaciones de capacidades a la configuración guardada. La implementación del protocolo OAuth sigue en `src/oauth/`: los metadatos del registro por sí solos no implementan un flujo OAuth.

<a id="evidence-required-for-a-canonical-preset"></a>

### Evidencia para un preajuste canónico

El registro determina a qué destino se envía la clave API del usuario. Un preajuste exige evidencia de fuentes primarias, además de código funcional. La descripción del PR que añada o promueva un proveedor debe incluir:

- **Endpoints compatibles con OpenAI documentados por el proveedor**: la referencia de chat y, con `liveModels: true`, la del descubrimiento autenticado de modelos, normalmente `GET /v1/models`. Una prueba con fixtures valida nuestro código, pero no sustituye la evidencia del contrato del proveedor.
- **Términos de servicio y entidad legal operadora**: una página legal vacía no identifica quién opera el endpoint ni cómo trata el tráfico del usuario.
- **Autorización de reventa o enrutamiento para agregadores**: una pasarela que vende acceso a Claude, GPT, Gemini u otros modelos debe demostrar su autorización. Un preajuste integrado se presenta como una ruta mantenida.
- **Responsable de mantenimiento identificado**: quién actualiza el preajuste ante cambios de URL, autenticación o catálogo, y cómo se informan las incidencias.
- **Fecha de verificación citable**: registra la fuente primaria y la fecha comprobada, como hace `lastVerified` en `src/providers/free-directory.ts`. No atribuyas una verificación que no se realizó.

Puedes proponer tu propio servicio; varios preajustes surgieron así. Declara la afiliación en la descripción para que los revisores la valoren. La afiliación no justifica un rechazo ni reduce la evidencia exigida.

Si la evidencia está incompleta, añade una referencia en `src/providers/free-directory.ts`, en lugar de promoverla al registro canónico. Las filas indican su grado de `verification` (`official`, `primary`, `unverified`) y son referencias inertes: el usuario puede configurar el servicio mediante el flujo personalizado compatible con OpenAI, sin que opencodex lo presente como proveedor mantenido o recomendado. Promueve la fila solo cuando exista toda la evidencia anterior.

<a id="adding-an-adapter"></a>

## Añadir un adaptador

Implementa `ProviderAdapter` en `src/adapters/`, siguiendo [Adaptadores](/es/reference/adapters/), registra su fábrica en `src/adapters/registry.ts` y convierte la salida a eventos internos `AdapterEvent`. `src/server/adapter-resolve.ts` elige el protocolo efectivo antes de delegar al registro. Reutiliza `image.ts` para imágenes y sigue `openai-chat.ts` para streaming y llamadas a herramientas normales. Usa `fetchResponse` solo si el adaptador controla los reintentos del transporte, o `runTurn` para un transporte bidireccional como Cursor. Añade pruebas enfocadas en `tests/` y exporta la fábrica desde `src/index.ts` si forma parte de la API pública del paquete.

<a id="adding-a-compatibility-claim"></a>

### Declarar compatibilidad

Las declaraciones de compatibilidad viven en `src/compatibility/` y son más específicas que un adaptador: identifican el proveedor, la URL base normalizada, la autenticación, los protocolos de entrada y salida y los modelos cuyo comportamiento se probó. No extiendas una declaración a otros proveedores o destinos solo porque compartan adaptador o formato.

Usa una de las disposiciones versionadas: `passthrough`, `translated`, `degraded` o `unsupported`. Cada declaración distinta de paso directo debe explicar su limitación. Si se basa en fixtures, cita los identificadores exactos de las aserciones que la prueban. Añade el vector de solicitud sin secretos en `tests/fixtures/compatibility/` y ejecútalo contra el adaptador de producción en una prueba enfocada. Una declaración `passthrough` solo puede citar aserciones `equals` cuyo valor esperado sea el valor original del cliente, en la misma ubicación y con un selector vinculado a esa capacidad en la prueba del manifiesto. Un campo eliminado, reescrito o ajeno a esa capacidad no demuestra ausencia de pérdidas. Separa aspectos relacionados si una ruta puede conservar uno y perder otro, como una herramienta personalizada y su gramática. Los manifiestos son datos pasivos: el router, el controlador Responses y el arranque del servidor no deben importar su catálogo ni activar Compatibility Lab.

<a id="verify-before-you-claim-done"></a>

## Verificar antes de dar el trabajo por terminado

Sigue la política de pruebas anterior. Ejecuta `bun run typecheck` para cambios de tipos y los checks exigidos por la superficie afectada. Informa de comandos, resultados y cobertura pendiente; afirma únicamente las validaciones completadas.
