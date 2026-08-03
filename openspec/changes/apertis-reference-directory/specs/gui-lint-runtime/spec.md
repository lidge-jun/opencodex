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
