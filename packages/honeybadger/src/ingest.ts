/**
 * Honeybadger ingest API -- hand-written.
 *
 * Deploys and source maps are not part of the v3 API, so the OpenAPI
 * description has no operations for them. They go to the region's ingest
 * host (`https://api.honeybadger.io` or `https://eu-api.honeybadger.io`) and
 * authenticate with a project API key (an ingestion key), not the v3 token:
 *
 * - `POST /v1/deploys`: https://docs.honeybadger.io/api/reporting-deployments/
 * - `POST /v1/source_maps`: https://docs.honeybadger.io/api/reporting-source-maps/
 *
 * The host is the call's `ingest_url`, else `ingestUrl` from
 * {@link Credentials} when that service is provided, else the US host. The
 * calls need no v3 token and work without `Credentials`; when `Credentials`
 * is provided it must resolve (`CredentialsFromEnv` needs
 * `HONEYBADGER_API_TOKEN`), unless the call passes `ingest_url`.
 *
 * A failure maps by HTTP status onto the shared classes (`BadRequest`,
 * `Unauthorized`, `TooManyRequests`, `ServiceUnavailable`, ...) with the
 * response's error text as `message` and the response on `body` and
 * `headers`; any other status below 500 is an {@link UnknownHoneybadgerError}.
 * The API key is replaced with `[REDACTED]` wherever the response repeats it.
 */
import { HTTP_STATUS_MAP, InternalServerError, InvalidInput } from "@distilled.cloud/core/errors";
import { responseErrorFields } from "@distilled.cloud/core/protocol-http";
import { parseRetryAfterForStatus } from "@distilled.cloud/core/retry-after";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { Credentials, DEFAULT_INGEST_URL, ingestUrlFor } from "./credentials.ts";
import { UnknownHoneybadgerError } from "./errors.ts";

/** Honeybadger refuses a source map file larger than this (80 MB). */
export const MAX_SOURCE_MAP_FILE_BYTES = 80 * 1024 * 1024;

/** A file to upload: its bytes, its text, or a `Blob`. */
export type IngestFile = Uint8Array | string | Blob;

export interface CreateDeployInput {
  /** The project's API key (an ingestion key). */
  readonly api_key: string | Redacted.Redacted<string>;
  /** The environment name, such as `production`. */
  readonly environment?: string;
  /** The VCS revision being deployed: a commit hash or a tag. */
  readonly revision?: string;
  /** The HTTPS base URL of the VCS repository. */
  readonly repository?: string;
  /** Who is deploying. */
  readonly local_username?: string;
  /** The ingest root to send to, such as `https://eu-api.honeybadger.io`. */
  readonly ingest_url?: string;
}

export interface UploadSourceMapInput {
  /** The project's API key (an ingestion key). */
  readonly api_key: string | Redacted.Redacted<string>;
  /**
   * The absolute URL the minified file is served from. `*` is a wildcard;
   * the query string is ignored.
   */
  readonly minified_url: string;
  readonly minified_file: IngestFile;
  readonly source_map: IngestFile;
  /** The revision the map applies to. Honeybadger defaults it to `master`. */
  readonly revision?: string;
  /**
   * Original source files, keyed by the URL each is served from. A key may
   * not repeat one of the named fields (`api_key`, `source_map`, ...).
   */
  readonly additional_files?: Readonly<Record<string, IngestFile>>;
  /** The ingest root to send to, such as `https://eu-api.honeybadger.io`. */
  readonly ingest_url?: string;
}

const ingestRoot = Effect.fn(function* (ingestUrl: string | undefined) {
  if (ingestUrl) return ingestUrl;
  const resolve = yield* Effect.serviceOption(Credentials);
  if (Option.isNone(resolve)) return DEFAULT_INGEST_URL;
  const config = yield* resolve.value;
  return config.ingestUrl || ingestUrlFor(config.apiBaseUrl);
});

type StatusError = InstanceType<(typeof HTTP_STATUS_MAP)[keyof typeof HTTP_STATUS_MAP]>;
type StatusMap = Readonly<
  Partial<
    Record<
      number,
      new (args: {
        readonly message: string;
        readonly retryAfter: Duration.Duration | undefined;
        readonly [field: string]: unknown;
      }) => StatusError
    >
  >
>;

/** Ingest failures answer `{"error": "<text>"}`; anything else keeps its raw text. */
const errorMessage = (body: unknown, text: string): string | undefined => {
  if (typeof body === "object" && body !== null) {
    const value = (body as Record<string, unknown>).error;
    if (typeof value === "string" && value !== "") return value;
  }
  return text.trim() === "" ? undefined : text.trim();
};

const send = Effect.fn(function* (
  path: string,
  apiKey: string,
  ingestUrl: string | undefined,
  build: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest,
) {
  const root = yield* ingestRoot(ingestUrl);
  const client = yield* HttpClient.HttpClient;
  const request = build(
    HttpClientRequest.post(root.replace(/\/+$/, "") + path).pipe(HttpClientRequest.acceptJson),
  );
  const response = yield* client.execute(request);
  if (response.status >= 200 && response.status < 300) return;

  // The status already says the call failed; an unreadable error body only
  // costs the message, which falls back to naming the status.
  const raw = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
  // Real keys are long; a short one would match ordinary words.
  const text = apiKey.length >= 8 ? raw.split(apiKey).join("[REDACTED]") : raw;
  const body: unknown = Option.getOrElse(
    Option.liftThrowable((raw: string): unknown => JSON.parse(raw))(text),
    () => text,
  );
  const status = response.status;
  const message = errorMessage(body, text) ?? `Honeybadger answered ${status} to POST ${path}`;
  const headers = response.headers as Record<string, string | undefined>;
  const StatusError = (HTTP_STATUS_MAP as StatusMap)[status];
  if (StatusError) {
    return yield* Effect.fail(
      new StatusError({
        message,
        ...responseErrorFields(undefined, { body, headers }),
        retryAfter: parseRetryAfterForStatus(status, headers),
      }),
    );
  }
  if (status >= 500) {
    return yield* Effect.fail(
      new InternalServerError({
        message,
        ...responseErrorFields(undefined, { body, headers }),
        retryAfter: parseRetryAfterForStatus(status, headers),
      }),
    );
  }
  return yield* Effect.fail(new UnknownHoneybadgerError({ status, message, body }));
});

/**
 * The key's text. A key must be printable ASCII without spaces, so it is a
 * valid header value and a failed send can't quote it back.
 */
const apiKeyValue = Effect.fn(function* (key: string | Redacted.Redacted<string>) {
  const value = yield* Effect.try({
    try: () => (Redacted.isRedacted(key) ? Redacted.value(key) : key),
    catch: () => new InvalidInput({ member: "api_key", message: "api_key could not be read" }),
  });
  if (!/^[!-~]+$/.test(value)) {
    return yield* new InvalidInput({
      member: "api_key",
      message: "api_key must be printable ASCII with no spaces",
    });
  }
  return value;
});

/**
 * Record a deploy: `POST /v1/deploys` with a JSON body and the project API
 * key in the `X-API-Key` header.
 */
export const createDeploy = Effect.fn(function* (input: CreateDeployInput) {
  const apiKey = yield* apiKeyValue(input.api_key);
  return yield* send("/v1/deploys", apiKey, input.ingest_url, (request) =>
    request.pipe(
      HttpClientRequest.setHeader("X-API-Key", apiKey),
      HttpClientRequest.bodyJsonUnsafe({
        deploy: Object.fromEntries(
          Object.entries({
            environment: input.environment,
            revision: input.revision,
            repository: input.repository,
            local_username: input.local_username,
          }).filter(([, value]) => value !== undefined),
        ),
      }),
    ),
  );
});

const blobOf = (file: IngestFile): Blob =>
  file instanceof Blob ? file : new Blob([typeof file === "string" ? file : new Uint8Array(file)]);

const NAMED_FIELDS = ["api_key", "revision", "minified_url", "minified_file", "source_map"];

const fileName = (url: string): string => {
  const path = URL.parse(url)?.pathname ?? url;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name === "" ? "minified.js" : name;
};

/**
 * Upload a minified file and its source map: `POST /v1/source_maps` as
 * multipart form data, with the project API key as the `api_key` field.
 * Fails with `InvalidInput`, before sending anything, when the minified file
 * or source map is empty, or a file is over {@link MAX_SOURCE_MAP_FILE_BYTES}
 * or can't be read.
 */
export const uploadSourceMap = Effect.fn(function* (input: UploadSourceMapInput) {
  const apiKey = yield* apiKeyValue(input.api_key);
  const reserved = Object.keys(input.additional_files ?? {}).find((url) =>
    NAMED_FIELDS.includes(url),
  );
  if (reserved !== undefined) {
    return yield* new InvalidInput({
      member: "additional_files",
      message: `additional_files can't use the field name ${reserved}`,
    });
  }
  const entries: Array<readonly [string, IngestFile]> = [
    ["minified_file", input.minified_file],
    ["source_map", input.source_map],
    ...Object.entries(input.additional_files ?? {}),
  ];
  const files: Array<readonly [string, Blob]> = [];
  for (const [field, file] of entries) {
    const blob = yield* Effect.try({
      try: () => blobOf(file),
      catch: () => new InvalidInput({ member: field, message: `${field} could not be read` }),
    });
    files.push([field, blob]);
  }
  // Honeybadger answers 201 to an empty file, leaving a map that resolves nothing.
  const empty = files.find(
    ([field, blob]) => (field === "minified_file" || field === "source_map") && blob.size === 0,
  );
  if (empty) {
    return yield* new InvalidInput({ member: empty[0], message: `${empty[0]} is empty` });
  }
  const tooLarge = files.find(([, blob]) => blob.size > MAX_SOURCE_MAP_FILE_BYTES);
  if (tooLarge) {
    return yield* new InvalidInput({
      member: tooLarge[0],
      message: `${tooLarge[0]} is ${tooLarge[1].size} bytes; Honeybadger takes at most 80 MB per file`,
    });
  }
  const name = fileName(input.minified_url);
  const form = new FormData();
  form.append("api_key", apiKey);
  if (input.revision !== undefined) form.append("revision", input.revision);
  form.append("minified_url", input.minified_url);
  for (const [field, blob] of files) {
    const filename =
      field === "minified_file" ? name : field === "source_map" ? `${name}.map` : fileName(field);
    form.append(field, blob, filename);
  }
  return yield* send("/v1/source_maps", apiKey, input.ingest_url, (request) =>
    HttpClientRequest.bodyFormData(request, form),
  );
});
