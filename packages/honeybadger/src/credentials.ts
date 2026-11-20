/**
 * Honeybadger credentials -- hand-written.
 *
 * The `Credentials` service resolves `{ token, apiBaseUrl, ingestUrl }` per request; the
 * protocol layer formats the `Authorization: Bearer <token>` header from it.
 * The token is a Honeybadger API token. A project's ingestion key does not
 * authenticate to this API.
 *
 * Honeybadger runs a US and an EU region, each with its own API host. The API
 * version is a path segment, so it belongs to the base URL: the generated
 * operations carry version-less routes (`/projects`,
 * `/projects/{project_id}/faults`).
 *
 * Deploys and source maps go to a separate ingest host (`src/ingest.ts`),
 * authenticated with a project API key instead of the token. Each region has
 * one (docs.honeybadger.io/resources/data-residency): `api.honeybadger.io`
 * in the US, `eu-api.honeybadger.io` in the EU.
 */
import * as EffectConfig from "@distilled.cloud/core/config";
import { ConfigError } from "@distilled.cloud/core/errors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

/** Honeybadger's US API root, the default. */
export const DEFAULT_API_BASE_URL = "https://app.honeybadger.io/v3";

export const EU_API_BASE_URL = "https://eu-app.honeybadger.io/v3";

/** Honeybadger's US ingest root, for deploys and source maps. */
export const DEFAULT_INGEST_URL = "https://api.honeybadger.io";

export const EU_INGEST_URL = "https://eu-api.honeybadger.io";

/** The ingest root in the same region as `apiBaseUrl`: EU for `eu-app.honeybadger.io`, otherwise US. */
export const ingestUrlFor = (apiBaseUrl: string): string =>
  URL.parse(apiBaseUrl)?.hostname === "eu-app.honeybadger.io" ? EU_INGEST_URL : DEFAULT_INGEST_URL;

export interface Config {
  readonly token: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
  readonly ingestUrl: string;
}

export class Credentials
  extends /*@__PURE__*/ Context.Service<Credentials, Effect.Effect<Config, ConfigError>>()(
    "HoneybadgerCredentials",
  ) {}

const envConfig = /*@__PURE__*/ EffectConfig.all({
  token: /*@__PURE__*/ EffectConfig.Redacted("HONEYBADGER_API_TOKEN"),
  apiBaseUrl: /*@__PURE__*/ EffectConfig.String("HONEYBADGER_API_URL").pipe(
    /*@__PURE__*/ EffectConfig.withDefault(DEFAULT_API_BASE_URL),
  ),
  ingestUrl: /*@__PURE__*/ EffectConfig.option(EffectConfig.String("HONEYBADGER_INGEST_URL")).pipe(
    /*@__PURE__*/ Effect.map(Option.filter((url) => url !== "")),
  ),
});

/**
 * Reads `HONEYBADGER_API_TOKEN` (required), `HONEYBADGER_API_URL` (default
 * US) and `HONEYBADGER_INGEST_URL` (default: the ingest root in the API URL's
 * region).
 */
export const CredentialsFromEnv: Layer.Layer<Credentials> = /*@__PURE__*/ Layer.succeed(
  Credentials,
  /*@__PURE__*/ envConfig.pipe(
    /*@__PURE__*/ Effect.map((c) => ({
      ...c,
      ingestUrl: Option.getOrElse(c.ingestUrl, () => ingestUrlFor(c.apiBaseUrl)),
    })),
    /*@__PURE__*/ Effect.mapError(
      () =>
        new ConfigError({
          message: "HONEYBADGER_API_TOKEN environment variable is required",
        }),
    ),
  ),
);

/**
 * Layer from a redacted API token, an optional base URL (default US) and an
 * optional ingest URL (default: the ingest root in the base URL's region).
 */
export const credentials = (config: {
  readonly token: Redacted.Redacted<string>;
  readonly apiBaseUrl?: string;
  readonly ingestUrl?: string;
}): Layer.Layer<Credentials> => {
  const apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  return Layer.succeed(
    Credentials,
    Effect.succeed({
      token: config.token,
      apiBaseUrl,
      ingestUrl: config.ingestUrl ?? ingestUrlFor(apiBaseUrl),
    }),
  );
};
