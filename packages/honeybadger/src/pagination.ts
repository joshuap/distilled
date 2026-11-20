import * as Pagination from "@distilled.cloud/core/pagination";
/**
 * Honeybadger pagination -- hand-written.
 *
 * Every Honeybadger list answers `{ data: [...], links: {...} }`. The next
 * page is a root-relative link (`/v3/...`) whose query holds the position:
 *
 * - numbered-page lists: `links.next = "/v3/projects?page=3&per_page=25"`,
 *   `null` on the last page;
 * - time-ordered lists: `links.older = "/v3/projects/1/deploys?before=<cursor>&limit=25"`
 *   (or `created_before=<unix seconds>`), `null` when nothing older exists.
 *
 * Each operation's `smithy.api#paginated` trait (in `patches/<service>/`)
 * names the link (`outputToken`, e.g. `links.next`) and the query parameter
 * that holds the position (`inputToken`, e.g. `page`). The value is copied
 * as the link's text: `created_before` has fractions (`1794971106.5638819`)
 * that the API parses exactly, and the request builder sends query values as
 * text anyway.
 *
 * A time-ordered list started from `after` (or `created_after`) alone asks
 * for what is newer than that point. Its `links.older` leads back past it, so
 * the walk follows `links.newer` (`null` once nothing newer exists) with
 * `after` instead.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

/**
 * Stream of pages: request, then send the `inputToken` value from the link
 * at `outputToken` as the next request's position, until the link is
 * missing or names a position this traversal already requested.
 */
export const paginateHoneybadger: Pagination.PaginationStrategy = (
  operation,
  input,
  pagination,
) => {
  if (!pagination.inputToken || !pagination.outputToken) {
    return Pagination.missingPaginationConfig(
      "Honeybadger pagination requires inputToken and outputToken",
    );
  }
  const newerToken = pagination.inputToken.replace(/before$/, "after");
  const forward =
    pagination.outputToken.endsWith(".older") &&
    newerToken !== pagination.inputToken &&
    input[newerToken] !== undefined &&
    input[pagination.inputToken] === undefined;
  const inputToken = forward ? newerToken : pagination.inputToken;
  const outputToken = forward
    ? pagination.outputToken.replace(/older$/, "newer")
    : pagination.outputToken;
  return Stream.suspend(() => {
    const requested = new Set<string>();
    return Stream.paginate(input, (request) => {
      const position = request[inputToken];
      if (typeof position === "string" || typeof position === "number") {
        requested.add(String(position));
      }
      return Effect.map(operation(request), (page) => {
        const next = Option.fromNullishOr(Pagination.getPath(page, outputToken)).pipe(
          Option.filter((link): link is string => typeof link === "string"),
          Option.flatMap((link) =>
            Option.fromNullishOr(URL.parse(link, "http://_")?.searchParams.get(inputToken)),
          ),
          Option.filter((value) => value !== "" && !requested.has(value)),
          Option.map((value) => ({ ...request, [inputToken]: value })),
        );
        return [[page], next] as const;
      });
    });
  });
};
