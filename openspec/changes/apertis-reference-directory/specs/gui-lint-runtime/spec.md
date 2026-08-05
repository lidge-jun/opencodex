## ADDED Requirements

### Requirement: GUI lint scripts load the local TypeScript ESLint plugin
The GUI package's `lint` and `lint:i18n` scripts SHALL execute ESLint through Bun's runtime bridge
so that the checked-in ESLint configuration and its local TypeScript plugin load successfully.

#### Scenario: Full GUI lint command
- **WHEN** a contributor runs the GUI `lint` script from the repository validation path
- **THEN** ESLint evaluates the configured GUI files without an unknown-TypeScript-extension error

#### Scenario: Focused GUI i18n lint command
- **WHEN** a contributor runs the GUI `lint:i18n` script
- **THEN** ESLint evaluates the configured UI paths with the same local plugin available

### Requirement: React Doctor scripts resolve their TypeScript peer explicitly
The GUI package's `doctor` and `doctor:full` scripts SHALL invoke React Doctor through npm
with the pinned TypeScript and React Doctor packages so that Bun's `npx` alias cannot omit the
TypeScript peer required by React Doctor.

#### Scenario: Changed GUI React Doctor command
- **WHEN** a contributor runs the GUI `doctor` script from the repository validation path
- **THEN** React Doctor evaluates the changed GUI scope and resolves its TypeScript peer
  successfully

#### Scenario: Full GUI React Doctor command
- **WHEN** a contributor runs the GUI `doctor:full` script
- **THEN** React Doctor evaluates the full GUI scope with the same explicit TypeScript peer
  resolution
