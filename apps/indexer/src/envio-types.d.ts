// Pulls envio's generated Global augmentation into the repo-root typecheck.
// The root tsconfig only includes apps/<name>/src and test, so without this
// reference the `indexer` export from "envio" would type as the
// "codegen required" fallback. The real generated config types live in
// ../.envio/types.d.ts (committed, see ../.envio/.gitignore); regenerate with
// `pnpm --filter @mida/indexer codegen` after changing config.yaml or
// schema.graphql.
/// <reference path="../envio-env.d.ts" />
