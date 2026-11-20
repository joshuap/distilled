# @distilled.cloud/honeybadger

Effect-native [Honeybadger](https://www.honeybadger.io) SDK, generated from
Honeybadger's v3 OpenAPI description,
[`https://docs.honeybadger.io/api/v3/openapi.json`](https://docs.honeybadger.io/api/v3/openapi.json).
It covers the Honeybadger API at `app.honeybadger.io/v3` (and
`eu-app.honeybadger.io/v3`): faults and notices, uptime, check-ins, Insights,
dashboards, alarms, deploys, status pages and incidents, integrations, and the
account, team and project settings.

Each tag of the spec is its own module: `@distilled.cloud/honeybadger/projects`,
`…/faults`, `…/notices`, `…/uptime_sites`, `…/check_ins`, `…/insights`,
`…/dashboards`, `…/alarms`, `…/deploys`, and the rest. The package root exports
the shared runtime: credentials, the protocol, errors and retry.

## Installation

```bash
npm install @distilled.cloud/honeybadger effect
```

## Quick start

```ts
import { Effect, Layer } from "effect";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Honeybadger from "@distilled.cloud/honeybadger";
import * as Projects from "@distilled.cloud/honeybadger/projects";

const program = Effect.gen(function* () {
  // Every project the token can reach, page by page.
  const projects = yield* Projects.listProjects
    .items({ per_page: 25 })
    .pipe(Stream.runCollect);

  const first = projects[0];
  if (first === undefined) return { projects: 0 };

  // One project in full.
  const { data: project } = yield* Projects.getProject({ project_id: first.id });

  return {
    projects: projects.length,
    name: project.name,
    active: project.active,
  };
});

const HoneybadgerLive = Layer.mergeAll(
  FetchHttpClient.layer,
  Honeybadger.CredentialsFromEnv,
  Honeybadger.HoneybadgerProtocol,
);

program.pipe(Effect.provide(HoneybadgerLive), Effect.runPromise).then(console.log);
```

## Auth

`CredentialsFromEnv` reads:

- `HONEYBADGER_API_TOKEN` (required): an API token, sent as
  `Authorization: Bearer`. A token is personal (`hbu_…`) or belongs to the
  account (`hba_…`); an OAuth access token works too. See
  [Authentication](https://docs.honeybadger.io/api/v3/authentication/) for how
  to create one.
- `HONEYBADGER_API_URL` (optional): defaults to `https://app.honeybadger.io/v3`.
  Accounts in the EU region use `https://eu-app.honeybadger.io/v3`
  (`Honeybadger.EU_API_BASE_URL`).
- `HONEYBADGER_INGEST_URL` (optional): the ingest host for deploys and source
  maps. It defaults to the host in the API URL's region.

To pass credentials explicitly, use
`Honeybadger.credentials({ token, apiBaseUrl, ingestUrl })`, where `token` is a
`Redacted.Redacted<string>` (`Redacted.make(...)` from `effect/Redacted`), and
`apiBaseUrl` and `ingestUrl` are optional.

The token decides which account and projects a request reaches, and its scopes
decide what it can do. Each scope is checked on its own: `faults:write` doesn't
include `faults:read`. The quick start needs `projects:read`. A request whose
token lacks the scope fails with 403 `insufficient_scope`. An account token
can't hold `account:write`, and managing account and team members takes a
personal token.

Only the Bearer header is accepted: HTTP basic auth and the `auth_token` query
parameter are refused, and v2 personal auth tokens don't work with v3.

## Pagination

Paged lists have `.pages(input)` and `.items(input)` streams as well as the
plain call. The stream follows Honeybadger's `links`: `next` on numbered lists
(`page`, `per_page`), `older` on time-ordered ones such as notices and deploys.
It stops when the link is `null`. A time-ordered list started from `after` (or
`created_after`) alone walks forward through `newer` instead, so it returns
only what is newer than that point.

## Deploys and source maps

Recording a deploy and uploading source maps use Honeybadger's ingest API,
which the v3 description doesn't cover. `@distilled.cloud/honeybadger/Ingest`
has hand-written calls for both. They authenticate with the project's API key
(an ingestion key), not the v3 token.

```ts
import * as Ingest from "@distilled.cloud/honeybadger/Ingest";

Ingest.createDeploy({ api_key, environment: "production", revision: "4f1d738" });

Ingest.uploadSourceMap({
  api_key,
  revision: "4f1d738",
  minified_url: "https://example.com/assets/app.min.js",
  minified_file: minifiedBytes,
  source_map: sourceMapBytes,
});
```

Each call goes to the call's `ingest_url`, or else to the credentials'
`ingestUrl`. `CredentialsFromEnv` sets `ingestUrl` from `HONEYBADGER_INGEST_URL`, or
else from the region of `HONEYBADGER_API_URL`: `https://api.honeybadger.io` (US)
or `https://eu-api.honeybadger.io` (EU). Without credentials, it's the US
host. With `Credentials` provided, it must resolve: `CredentialsFromEnv` needs
`HONEYBADGER_API_TOKEN` unless the call passes `ingest_url`.

Failures map by status onto the classes described under Errors, with the
response on `body`; a wrong key is `Forbidden` with the message
`Invalid API key`. An empty minified file or source map, or a file over 80 MB,
fails with `InvalidInput` before anything is sent.

## Responses

Responses keep Honeybadger's wire shape: a resource arrives as `{ data, meta }`,
a list as `{ data: [...], links, meta }`. Member names stay snake_case, as in
Honeybadger's API reference.

An ingestion key's `key` comes back as a `Redacted` value; read it with
`Redacted.value`. Inputs take a plain string or a `Redacted`.

## Errors

A failure maps by HTTP status onto `BadRequest`, `Unauthorized`, `Forbidden`,
`NotFound`, `Conflict`, `UnprocessableEntity`, `TooManyRequests` or a 5xx class.
Honeybadger's `error.message` becomes `message`, and the whole envelope is on
`body`. Several codes share a status, so branch on `body.error.code`: a 403 can
be `insufficient_scope`, `feature_unavailable`, `limit_reached` or another
code, and `body.error.details` names the missing scope or the invalid fields.

```ts
Projects.getProject({ project_id }).pipe(
  Effect.catchTag("Forbidden", (e) =>
    (e.body as any)?.error?.code === "insufficient_scope"
      ? Effect.succeed(undefined)
      : Effect.fail(e),
  ),
);
```

A 429 carries `retryAfter` from the `Retry-After` header. A 408 is a
`GatewayTimeout` and a 423 a `Locked`, though Honeybadger documents neither.
Any other status below 500 is an `UnknownHoneybadgerError` with Honeybadger's
`error.code` as `code` and `error.details` as `details`. With `ResponseValidation.strict`, a response that
does not match the schema is a `HoneybadgerParseError`.
