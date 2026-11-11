---
title: Catalog options
description: Optional native model omission in the generated Codex catalog.
---

## Omit disabled native models

`omitDisabledNativeModels` is an optional boolean in `config.json`, defaulting to `false`.
Enable it and run `ocx sync` to omit explicitly disabled native rows without requiring a
native-alias combo:

```json
{
  "omitDisabledNativeModels": true,
  "disabledModels": ["gpt-5.5"]
}
```

The setting applies to sync, convergence, the generated models cache, and Codex-shaped
`/v1/models?client_version=…` discovery. A bare native disable omits that model and all its
account-selector rows; an account-qualified disable omits only that selector row.
The native inheritance template is validated and captured before omission, so routed
rows keep the same input and tool metadata, including when the only template row is disabled.

Absent, false, or malformed values preserve the default hidden-row behavior.
Existing native-alias omission remains independent of this flag. This setting controls
discovery only: direct requests to disabled native ids still route normally, and unchanged
sync output keeps its existing no-op write and mtime behavior.

See [Codex App models](/guides/codex-app-models/#what-this-means-for-a-disabled-native-model)
for Desktop visibility and [provider configuration](/reference/configuration/providers/)
for `disabledModels`.
