# Architecture

The current architecture direction is PWA-first.

For the detailed product design, read:

- `docs/pwa-product-design.md`

For the technical architecture, read:

- `docs/pwa-architecture.md`

The short version:

```text
iPhone Home Screen PWA ----\
                            -> Sync API -> Database
Windows installed PWA ------/

Both devices run apps/web.
Shared task rules live in packages/core.
```

This project has only two app surfaces: `apps/web` for the installable PWA and
`apps/api` for sync.
