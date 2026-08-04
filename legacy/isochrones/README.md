# Legacy reachability / isochrone source

`source/` is an exact snapshot of `archive/pre-redo-main-2026-08-04`. It contains
the former Next.js reachability app, ArcGIS/Google integration, D1/Cloudflare
pieces, Sites/OpenAI hosting configuration, migrations, worker, tests, and its
own lockfile.

It is reference material only:

- do not run package installation from the repository root against this folder;
- do not import it from the active app;
- exclude `legacy/**` from TypeScript, lint, test, and build discovery;
- do not update its dependencies or hosting configuration;
- port a small, reviewed concept into the active architecture if an isochrone
  feature is deliberately revived later.

The archive tag and external pre-redo Git bundle preserve the complete history;
this copy exists only to make relevant implementation ideas easy to inspect.
