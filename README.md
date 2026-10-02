# bundle-sdk

The profession-bundle contract for OmniCore, and the engines that must behave identically
wherever a bundle is read: in a bundle repo's CI, in bundle-service before an install, and in
the capability services at run time.

| Module | What it is | Used by |
|---|---|---|
| `contract/v1/manifest.schema.json` | JSON Schema for a resolved manifest | lint |
| `src/load.js` | Reads a bundle repo (`bundle.yaml` + the files it names) into one JSON manifest | lint, bundle-service |
| `src/lint.js` / `bin/bundle-lint.js` | Every check that can run without installing: shape, cross-references, field schemas, templates, conditions, a dry run of the deadline rules, and the version bump | bundle repos' CI, bundle-service |
| `src/conditions.js` | The JSONLogic-subset condition language (`var`, `==`, `in`, `and`, `engaged`, `filled`, …) | obligation, document and vault services |
| `src/schedules.js` | Periods (financial years) and due dates, as calendar dates — never local-time `Date`s | obligation-service, lint |
| `src/templates.js` | Handlebars, locked down: escaped output only, a fixed helper list, visible `[placeholders]` for missing values | document-service, lint |
| `src/permissions.js` | The platform's own permission codes (mirrors migrations 001 and 014) | lint |

## Linting a bundle

```bash
npx bundle-lint path/to/bundle                      # errors exit 1
npx bundle-lint . --previous ../previous-release    # also checks the semver bump
npx bundle-lint . --json
```

A bundle is data, never code. See `test/fixtures/valid-bundle` for a small bundle that uses
every section, and the plan's Part 2 for the full contract.

## Developing

```bash
npm test        # node --test
npm run lint
npm run coverage
```
