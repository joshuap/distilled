#!/usr/bin/env -S node --conditions=bun
/**
 * convert — turn the Honeybadger v3 OpenAPI document into Smithy 2.0 JSON
 * models, one per tag.
 *
 * Input:  specs/spec-mirror-honeybadger/specs/openapi.json  (spec submodule —
 *         https://docs.honeybadger.io/api/v3/openapi.json)
 *         patches/<service>/*.json  (RFC-6902 patches to the Smithy models)
 * Output: .generated-specs/<service>.json
 *
 * SERVICES. Every operation in the document carries exactly one tag, and the
 * document lists its tags at the top level (`Projects`, `Faults`,
 * `Uptime sites`, …). Each tag becomes one service, read straight off the
 * document so a tag Honeybadger adds becomes a service without an edit here.
 * The service name is the tag, lowercased, with every run of other
 * characters turned into `_` (`Uptime sites` → `uptime_sites`). An operation
 * with no tag, more than one tag, or a tag the top-level list does not
 * declare fails the conversion rather than being dropped.
 *
 * `scripts/generate.ts` compiles the models into src/services.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { runOpenApiConvert } from "@distilled.cloud/dev/codegen/openapi-cli";
import { resolveSpecPath } from "@distilled.cloud/dev/codegen/spec-path";

const root = path.resolve(import.meta.dirname, "..");
const SPEC_PATH = "specs/spec-mirror-honeybadger/specs/openapi.json";

const METHODS = ["get", "put", "post", "patch", "delete", "head", "options", "trace"] as const;

const toName = (tag: string): string =>
  tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const toPascal = (name: string): string =>
  name
    .split("_")
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");

const specFile = resolveSpecPath(root, SPEC_PATH);
if (!fs.existsSync(specFile)) {
  throw new Error(`${specFile} not found — run \`pnpm specs:local honeybadger\` (or specs:fetch)`);
}
const document = JSON.parse(fs.readFileSync(specFile, "utf8"));

const tags: string[] = (document.tags ?? []).map((t: { name: string }) => t.name);
if (tags.length === 0) {
  throw new Error(`${SPEC_PATH}: no top-level tags — cannot split the API into services`);
}
const serviceOfTag = new Map(tags.map((tag) => [tag, toName(tag)]));
if (new Set(serviceOfTag.values()).size !== tags.length) {
  throw new Error(`${SPEC_PATH}: two tags map to the same service name`);
}

const selectService =
  (service: string) =>
  (spec: any): void => {
    for (const [route, item] of Object.entries<any>(spec.paths ?? {})) {
      for (const method of METHODS) {
        const op = item?.[method];
        if (op === undefined) continue;
        const opTags: unknown = op.tags;
        if (!Array.isArray(opTags) || opTags.length !== 1 || !serviceOfTag.has(opTags[0])) {
          throw new Error(
            `${method.toUpperCase()} ${route}: needs exactly one tag from the top-level list`,
          );
        }
        if (serviceOfTag.get(opTags[0]) !== service) delete item[method];
      }
      if (!METHODS.some((m) => item?.[m] !== undefined)) delete spec.paths[route];
    }
  };

await runOpenApiConvert({
  root,
  specs: [...serviceOfTag.values()].map((name) => ({
    name,
    specPath: SPEC_PATH,
    preprocess: selectService(name),
    options: {
      namespace: `com.honeybadger.${name}`,
      serviceName: `Honeybadger${toPascal(name)}`,
    },
  })),
  patchesDir: "patches",
  options: {
    namespace: "com.honeybadger",
    serviceName: "Honeybadger",
    skipDeprecated: true,
    // Merging faults answers 202 and nothing else; without it in the list
    // that operation would have no success schema.
    successStatuses: ["200", "201", "202", "204"],
  },
});
