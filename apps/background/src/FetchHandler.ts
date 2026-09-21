import type { GitService } from '@edge-git/git-service';
import { PackLimitError } from '@edge-git/git-service';
import {
  buildFetchErrorResponse,
  buildFetchResponse,
  buildLsRefsResponse,
  parseCommand,
  parseFetchRequest,
  shouldSendPackfileForFetch,
  validateFetchRequestCounts,
  validateFetchRequestOids,
  validateFilterSpec,
} from '@edge-git/git-protocol';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { createLogger } from '@edge-git/backend-runtime/logger';

const logger = createLogger('FetchHandler');

interface FetchLimits {
  maxWants: number;
  maxHaves: number;
  maxObjects: number;
  maxPackBytes: number;
  maxFetchBodyBytes: number;
}

interface FetchHandlerDeps {
  git: GitService;
  env: Env;
  getFullName: () => string | undefined;
}

// Handles `git-upload-pack` (fetch/clone): ls-refs plus v2 fetch negotiation
// and packfile generation.
class FetchHandler {
  constructor(private readonly deps: FetchHandlerDeps) {}

  public async uploadPack(data: Uint8Array, limits: FetchLimits): Promise<Response> {
    const { git, env, getFullName } = this.deps;
    git.ensureFreshCache(ConfigurationManager.repo.getCacheTtlSeconds(env));
    if (data.byteLength > limits.maxFetchBodyBytes) {
      const message = `fetch request too large: ${data.byteLength} > ${limits.maxFetchBodyBytes} bytes`;
      logger.error(`(upload-pack-fetch) Rejected ${getFullName() ?? 'unknown repo'}: ${message}`);
      return buildFetchErrorResponse(message, 413);
    }
    const { command, args } = parseCommand(data);

    // Bound ls-refs/feature args before any git I/O — parseCommand itself is
    // unbounded, so cap the arg count and per-arg length here (1MB body cap
    // alone still allows tens of thousands of tiny args).
    if (args.length > 64) {
      const message = `too many ls-refs arguments: ${args.length} > 64`;
      logger.error(`(upload-pack-fetch) Rejected ${getFullName() ?? 'unknown repo'}: ${message}`);
      return buildFetchErrorResponse(message, 400);
    }
    for (const arg of args) {
      if (arg.length > 1024) {
        const message = 'ls-refs argument too long';
        logger.error(`(upload-pack-fetch) Rejected ${getFullName() ?? 'unknown repo'}: ${message}`);
        return buildFetchErrorResponse(message, 400);
      }
    }

    if (command === 'ls-refs') {
      const { refs, symbolicHead } = await git.listRefs();

      return buildLsRefsResponse(refs, args, symbolicHead, async (oid: string) => git.readObjectForLsRefs(oid));
    }

    if (command === 'fetch') {
      const fetchRequest = parseFetchRequest(data, args);

      if (fetchRequest.wants.length === 0) {
        return buildFetchResponse({
          commonCommits: [],
          packfileData: null,
          noProgress: true,
          done: fetchRequest.done,
        });
      }

      const countError = validateFetchRequestCounts(fetchRequest, {
        maxWants: limits.maxWants,
        maxHaves: limits.maxHaves,
      });
      if (countError) {
        logger.error(`(upload-pack-fetch) Rejected ${getFullName() ?? 'unknown repo'}: ${countError}`);
        return buildFetchErrorResponse(countError, 400);
      }

      const oidError = validateFetchRequestOids(fetchRequest);
      if (oidError) {
        logger.error(`(upload-pack-fetch) Rejected ${getFullName() ?? 'unknown repo'}: ${oidError}`);
        return buildFetchErrorResponse(oidError, 400);
      }

      const filterError = validateFilterSpec(fetchRequest.filterSpec);
      if (filterError) {
        logger.error(`(upload-pack-fetch) Rejected ${getFullName() ?? 'unknown repo'}: ${filterError}`);
        return buildFetchErrorResponse(filterError, 400);
      }

      let commonCommits: string[];
      try {
        commonCommits = await git.findCommonCommits(fetchRequest.haves, limits.maxHaves);
      } catch (error) {
        // Never echo git-internal paths/oids to anonymous fetchers: only
        // PackLimitError carries a safe message, everything else is masked.
        const message = error instanceof PackLimitError ? error.message : 'failed to negotiate fetch';
        logger.error(`(upload-pack-fetch) Rejected ${getFullName() ?? 'unknown repo'}: ${message}`);
        return buildFetchErrorResponse(message, 400);
      }

      // wait-for-done: never send ready/packfile until the client says done.
      // Otherwise (classic stateless negotiation) send ACK+ready+packfile in the
      // same response as soon as a common base exists (or for clones).
      const shouldSendPackfile = shouldSendPackfileForFetch(fetchRequest, commonCommits);

      let packfileData: Uint8Array | undefined | null = null;
      let shallow: string[] = [];
      const unshallow: string[] = [];

      if (shouldSendPackfile) {
        try {
          // deepen-not entries may be ref names; resolve to oids for exclusion.
          // Count is already bounded by `validateFetchRequestCounts` above;
          // validate each entry shape here so a flood of entries cannot fan
          // out into unbounded `resolveRef` git I/O.
          const excludeOids: string[] = [];
          const deepenNot = fetchRequest.shallowOptions?.deepenNot ?? [];
          const OID_OR_REF_RE = /^(?:[0-9a-f]{40}|refs\/[\w./-]{1,250})$/i;
          for (const entry of deepenNot) {
            if (entry.length > 255 || !OID_OR_REF_RE.test(entry)) {
              return buildFetchErrorResponse(`invalid deepen-not entry: ${entry.slice(0, 64)}`, 400);
            }
            const resolved = await git.resolveRef(entry);
            excludeOids.push(resolved ?? entry);
          }

          const rawDepth = fetchRequest.shallowOptions?.deepen;
          const depth = rawDepth !== undefined && Number.isFinite(rawDepth) && rawDepth > 0 ? Math.trunc(rawDepth) : undefined;
          const since = fetchRequest.shallowOptions?.deepenSince;
          const { oids, shallow: boundary } = await git.collectObjectsForPack(fetchRequest.wants, fetchRequest.haves, {
            depth,
            since,
            exclude: excludeOids,
            filter: fetchRequest.filterSpec,
            maxObjects: limits.maxObjects,
            deepenRelative: fetchRequest.shallowOptions?.deepenRelative,
            relativeTo: fetchRequest.shallowOptions?.shallow,
          });

          // include-tag: also send annotated tags pointing at packed commits.
          // Pre-check before the tag walk so a tag bomb cannot burn CPU
          // before the limit is enforced.
          if (oids.length > limits.maxObjects) {
            throw new PackLimitError(`too many objects: limit is ${limits.maxObjects}`);
          }
          let oidsToPack = oids;
          if (fetchRequest.capabilities.includeTag) {
            oidsToPack = await this.expandWithTags(oidsToPack);
          }
          if (oidsToPack.length > limits.maxObjects) {
            throw new PackLimitError(`too many objects: limit is ${limits.maxObjects}`);
          }

          logger.info(`(upload-pack-fetch) Packing ${oidsToPack.length} objects for wants: ${fetchRequest.wants.join(', ')}`);

          const packed = await git.packObjects(oidsToPack);
          if (packed && packed.byteLength > 0) {
            if (packed.byteLength > limits.maxPackBytes) {
              throw new PackLimitError(`pack too large: ${packed.byteLength} > ${limits.maxPackBytes} bytes`);
            }
            packfileData = packed;
          }
          if (depth !== undefined || since !== undefined) {
            shallow = boundary;
            // Client-sent shallow lines now fulfilled are unshallowed.
            const clientShallow = fetchRequest.shallowOptions?.shallow ?? [];
            for (const s of clientShallow) {
              if (!shallow.includes(s)) unshallow.push(s);
            }
          }
        } catch (error) {
          logger.error('(upload-pack-fetch) Failed to pack objects: ', error);
          if (error instanceof PackLimitError) {
            return buildFetchErrorResponse(error.message, 413);
          }
          return buildFetchErrorResponse('pack-objects failed: internal error', 500);
        }
      }

      return buildFetchResponse({
        commonCommits,
        packfileData,
        noProgress: fetchRequest.capabilities.noProgress,
        done: fetchRequest.done,
        shallow,
        unshallow,
      });
    }

    return buildFetchErrorResponse(`unsupported command: ${command || '(empty)'}`, 400);
  }

  private async expandWithTags(oids: string[]): Promise<string[]> {
    const { git } = this.deps;
    try {
      const tags = await git.listTags();
      const packed = new Set(oids);
      const extra: string[] = [];
      for (const tag of tags) {
        if (packed.has(tag.oid)) continue;
        const target = await git.peelTag(tag.oid);
        if (target && packed.has(target)) {
          extra.push(tag.oid);
          packed.add(tag.oid);
        }
      }
      return extra.length > 0 ? [...oids, ...extra] : oids;
    } catch {
      return oids;
    }
  }
}

export { FetchHandler };
export type { FetchLimits, FetchHandlerDeps };
