/**
 * Honeybadger-specific error types.
 *
 * Re-exports the common HTTP errors from core and adds the Honeybadger fallback
 * errors. Note the generated service modules additionally define their own
 * per-status matcher classes (BadRequest/NotFound/...) for the statuses each
 * operation declares -- those share `_tag`s with the core classes here, so
 * `catchTag` works against either.
 */
export {
  BadGateway,
  BadRequest,
  Conflict,
  ConfigError,
  Forbidden,
  GatewayTimeout,
  InternalServerError,
  Locked,
  NotFound,
  ServiceUnavailable,
  TooManyRequests,
  Unauthorized,
  UnprocessableEntity,
  HTTP_STATUS_MAP,
  DEFAULT_ERRORS,
  API_ERRORS,
} from "@distilled.cloud/core/errors";
export type { DefaultErrors } from "@distilled.cloud/core/errors";

import * as Category from "@distilled.cloud/core/category";
import { UnknownErrorFields } from "@distilled.cloud/core/errors";
import * as Schema from "@distilled.cloud/core/schema-lite-typed";

/**
 * Unknown Honeybadger error -- returned only when nothing else matches: not
 * the operation's own errors, not a shared HTTP-status class (400, 401, 403,
 * 404, 409, 422, 429, ...), and not a 5xx. Every `error.code` Honeybadger
 * documents comes with one of those statuses, so those failures arrive as
 * the matching class with the whole envelope on `body`. This class is for
 * an undocumented status such as 405 or 410; `code` and `details` copy the
 * envelope's `error.code` and `error.details` when it has them.
 */
export class UnknownHoneybadgerError
  extends /*@__PURE__*/ Schema.TaggedError<UnknownHoneybadgerError>()("UnknownHoneybadgerError", {
    ...UnknownErrorFields,
    details: /*@__PURE__*/ Schema.optional(Schema.Unknown),
  }) {}

/** Schema parse error wrapper. */
export class HoneybadgerParseError
  extends /*@__PURE__*/ Schema.TaggedError<HoneybadgerParseError>()("HoneybadgerParseError", {
    body: Schema.Unknown,
    cause: Schema.Unknown,
  }).pipe(Category.withParseError) {}
