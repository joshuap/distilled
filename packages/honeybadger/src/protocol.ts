import type * as API from "@distilled.cloud/core/api";
import type { API_ERRORS, ConfigError, InvalidInput } from "@distilled.cloud/core/errors";
import {
  makeRestProtocol,
  type RestErrorEnvelope,
  unknownErrorProps,
} from "@distilled.cloud/core/protocol-rest";
import type { SdkError } from "@distilled.cloud/core/sdk-error";
/**
 * HoneybadgerProtocol -- hand-written.
 *
 * Honeybadger speaks bearer-authenticated JSON REST, so the whole protocol is
 * one `makeRestProtocol` call from `core/protocol-rest`:
 *
 *   request:  credentials -> `Authorization: Bearer <token>` + base URL
 *             (default https://app.honeybadger.io/v3), resolved from the
 *             calling fiber on every request
 *
 *   response: 2xx JSON is the payload (sensitive members delivered as
 *             `Redacted`). Failures are enveloped:
 *             `{ "error": { "code", "message", "details" }, "meta": {...} }`.
 *             They map to the operation's typed error classes by status,
 *             then the shared HTTP-status classes, then
 *             {@link UnknownHoneybadgerError}, which carries `error.code` and
 *             `error.details`.
 */
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Credentials, type Config } from "./credentials.ts";
import { UnknownHoneybadgerError, HoneybadgerParseError } from "./errors.ts";

/**
 * Error channel shared by every generated Honeybadger operation. Generated
 * service files annotate operations with `API.OperationMethod<I, O,
 * HoneybadgerOpError, HoneybadgerOpContext>` explicitly so the compiler never infers
 * these back out of the schema generics.
 */
export type HoneybadgerOpError =
  | InstanceType<(typeof API_ERRORS)[number]>
  | UnknownHoneybadgerError
  | ConfigError
  | HttpClientError.HttpClientError
  | HoneybadgerParseError
  | InvalidInput
  | SdkError;

/** Context (requirements) shared by every generated Honeybadger operation. */
export type HoneybadgerOpContext = Credentials | HttpClient.HttpClient;

const errorObject = (body: unknown): Record<string, unknown> | undefined => {
  if (body === null || typeof body !== "object") return undefined;
  const err = (body as Record<string, unknown>).error;
  if (err === null || typeof err !== "object") return undefined;
  return err as Record<string, unknown>;
};

/**
 * Honeybadger failure bodies nest under `error`. A response without that
 * envelope (a proxy 502, an HTML error page) falls through to the protocol's
 * `HTTP <status>` default.
 */
const errorEnvelope = (body: unknown): RestErrorEnvelope | undefined => {
  const e = errorObject(body);
  if (e === undefined) return undefined;
  return {
    code: typeof e.code === "string" ? e.code : undefined,
    message: typeof e.message === "string" ? e.message : undefined,
  };
};

const errorDetails = (body: unknown): unknown => errorObject(body)?.details ?? undefined;

export const HoneybadgerProtocol: Layer.Layer<API.Protocol> =
  /*@__PURE__*/ makeRestProtocol<Config>({
    // The Credentials service holds an effect -- resolving it here (per
    // request, on the calling fiber) picks up context-provided credentials.
    credentials: /*@__PURE__*/ Effect.flatMap(Credentials, (resolve) => resolve),
    baseUrl: (creds) => creds.apiBaseUrl,
    headers: (creds) => ({
      Authorization: `Bearer ${Redacted.value(creds.token)}`,
      Accept: "application/json",
    }),
    errorEnvelope,
    unknownError: (info) =>
      new UnknownHoneybadgerError({ ...unknownErrorProps(info), details: errorDetails(info.body) }),
    parseError: ({ body, cause }) => new HoneybadgerParseError({ body, cause }),
  });
