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

      let commonCommits: string[];
      try {
        commonCommits = await git.findCommonCommits(fetchRequest.haves, limits.maxHaves);
      } catch (error) {
        const message = error instanceof PackLimitError ? error.message : (error as Error).message;
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
          const excludeOids: string[] = [];
          const deepenNot = fetchRequest.shallowOptions?.deepenNot ?? [];
          for (const entry of deepenNot) {
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
          });

          // include-tag: also send annotated tags pointing at packed commits.
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
          return buildFetchErrorResponse(`pack-objects failed: ${(error as Error).message}`, 500);
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

    return new Response('Unsupported command', { status: 400 });
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
