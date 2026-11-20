#!/usr/bin/env -S node --conditions=bun
import { runGeneratorCli } from "@distilled.cloud/dev/codegen/cli";
/**
 * generate — turn the Smithy JSON models in .generated-specs into the Honeybadger
 * Effect SDK.
 *
 * Input:  the Smithy models scripts/convert.ts writes, one per tag
 * Output: src/services/<service>.ts  +  src/services/index.ts
 *
 * The smithy→SDK compiler and CLI pipeline live in
 * `@distilled.cloud/dev/codegen`; this script is Honeybadger's provider spec.
 * Honeybadger keeps the wire's member names on the TS surface, so no member
 * renaming or wire dictionaries appear here.
 */
import type { SdkSpec } from "@distilled.cloud/dev/codegen/generator";

const NULLABLE_TRAIT = "com.distilled.openapi#nullable";
const ERROR_MATCHERS_TRAIT = "com.distilled.openapi#errorMatchers";
const RAW_RESPONSE_TRAIT = "com.distilled.openapi#rawResponse";
const SENSITIVE_TRAIT = "smithy.api#sensitive";

/** Honeybadger's provider spec for the shared smithy→SDK compiler. */
const honeybadgerSpec: SdkSpec = {
  nullableTrait: NULLABLE_TRAIT,
  errorMatchersTrait: ERROR_MATCHERS_TRAIT,

  extraBindings: [
    {
      // Sole member of a synthesized wrapper for bare array/scalar response
      // bodies; as the response's only member, the response IS the payload.
      trait: RAW_RESPONSE_TRAIT,
      binding: "rawResponse",
      pipe: "T.RawResponse()",
      rootPipe: "T.RawResponseRoot()",
    },
  ],

  // Sensitive strings (tokens, passwords, API keys): the schema member
  // carries T.SensitiveValue; the REST protocol delivers Redacted values
  // and accepts string | Redacted on input.
  memberTraitPipes: {
    [SENSITIVE_TRAIT]: "T.SensitiveValue",
  },
  memberTsType: (m) =>
    SENSITIVE_TRAIT in m.traits
      ? `string | Redacted.Redacted<string>${m.nullable ? " | null" : ""}`
      : undefined,

  // Unions surface as TS type unions over an opaque schema — the REST
  // protocol passes union content through verbatim (wire names ARE the TS
  // names for Honeybadger), so no runtime case discrimination is needed.
  union: ({ name, caseTargets, tsRef }) => [
    `export type ${name} = ${caseTargets.map(tsRef).join(" | ") || "unknown"};`,
    `export const ${name} = S.Unknown as any as S.Schema<${name}>;\n`,
  ],

  // Lists follow their response's `links`: `links.next` on numbered-page
  // lists, `links.older` on time-ordered ones. The traits come from
  // patches/<service>/pagination.json (`outputToken` names the link,
  // `inputToken` the query parameter that holds the position);
  // src/pagination.ts's `paginateHoneybadger` copies that parameter from the
  // link into the next request.
  paginationProfiles: {
    links: {
      strategy: "paginateHoneybadger",
      requires: () => ["inputToken", "outputToken"],
      itemsFallback: "data",
    },
  },

  operationDecl: {
    contextType: "HoneybadgerOpContext",
    commonErrorType: "HoneybadgerOpError",
    commonErrorClasses: ["UnknownHoneybadgerError"],
    protocol: "HoneybadgerProtocol",
    retry: "Retry.Retry",
  },

  sourceNote: ".generated-specs (specs/spec-mirror-honeybadger)",

  // Sensitive member types reference Redacted; pull the import in when used.
  postProcess: (code) =>
    code.includes("Redacted.Redacted<")
      ? code.replace(
          `import * as S from "@distilled.cloud/core/schema-lite";\n`,
          `import * as S from "@distilled.cloud/core/schema-lite";\nimport * as Redacted from "effect/Redacted";\n`,
        )
      : code,
};

runGeneratorCli({
  description: "Generate the Honeybadger Effect SDK from the Smithy models",
  convert: () => import("./convert.ts"),
  root: `${import.meta.dirname}/..`,
  // Smithy-model patches are applied in convert (finalizeConvert).
  patchesDir: false,
  spec: () => honeybadgerSpec,
});
