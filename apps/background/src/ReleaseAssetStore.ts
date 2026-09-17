import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import type { IsoGitFs } from '@edge-git/git-service';

type PromiseFsClient = ReturnType<IsoGitFs['getPromiseFsClient']>;

// Release asset bytes live in the DO filesystem outside `/repo` (so git
// history is untouched), inside the 5GB dofs device. D1 holds metadata only.
// Methods return discriminated unions (never throw except for oversized
// payloads) so they survive DO RPC boundaries.
class ReleaseAssetStore {
  constructor(
    private readonly fs: PromiseFsClient,
    private readonly env: Env,
  ) {}

  private isSafeAssetId(value: string): boolean {
    return /^[\w-]{1,128}$/iu.test(value);
  }

  private assetPath(releaseId: string, assetId: string): string | null {
    if (!this.isSafeAssetId(releaseId) || !this.isSafeAssetId(assetId)) return null;
    return `/release-assets/${releaseId}/${assetId}`;
  }

  public async store(args: { releaseId: string; assetId: string; bytes: Uint8Array }): Promise<unknown> {
    const path = this.assetPath(args.releaseId, args.assetId);
    if (!path) return { ok: false, error: 'invalid release or asset id', status: 400 };
    const maxBytes = ConfigurationManager.releases.getMaxAssetBytes(this.env);
    const bytes = args.bytes ?? new Uint8Array(0);
    if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
      return { ok: false, error: `asset size must be 1-${maxBytes} bytes`, status: 413 };
    }
    try {
      await this.fs.promises.mkdir(`/release-assets/${args.releaseId}`, { recursive: true });
      await this.fs.promises.writeFile(path, bytes);
      return { ok: true, size: bytes.byteLength };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'failed to store asset', status: 500 };
    }
  }

  public async load(args: { releaseId: string; assetId: string }): Promise<Uint8Array | null> {
    const path = this.assetPath(args.releaseId, args.assetId);
    if (!path) return null;
    try {
      const data = await this.fs.promises.readFile(path);
      if (typeof data === 'string') return new TextEncoder().encode(data);
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } catch {
      return null;
    }
  }

  public async remove(args: { releaseId: string; assetId: string }): Promise<{ deleted: boolean }> {
    const path = this.assetPath(args.releaseId, args.assetId);
    if (!path) return { deleted: false };
    try {
      await this.fs.promises.unlink(path);
      return { deleted: true };
    } catch {
      return { deleted: false };
    }
  }

  public async removeAll(args: { releaseId: string }): Promise<{ deleted: number }> {
    if (!this.isSafeAssetId(args.releaseId)) return { deleted: 0 };
    try {
      const names = await this.fs.promises.readdir(`/release-assets/${args.releaseId}`);
      let deleted = 0;
      for (const name of names) {
        try {
          await this.fs.promises.unlink(`/release-assets/${args.releaseId}/${name}`);
          deleted += 1;
        } catch {
          // best-effort per file
        }
      }
      await this.fs.promises.rmdir(`/release-assets/${args.releaseId}`).catch(() => undefined);
      return { deleted };
    } catch {
      return { deleted: 0 };
    }
  }
}

export { ReleaseAssetStore };
