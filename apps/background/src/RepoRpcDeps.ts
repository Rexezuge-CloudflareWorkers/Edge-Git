import type { GitService } from '@edge-git/git-service';
import type { IsoGitFs } from '@edge-git/git-service';
import type { AppConfiguration } from '@edge-git/backend-runtime/config';
import type { ReadModelService } from './ReadModelService';
import type { ReleaseAssetStore } from './ReleaseAssetStore';

type IsoGitFsClient = ReturnType<IsoGitFs['getPromiseFsClient']>;

interface RepoRpcDeps {
  git: GitService;
  readModel: ReadModelService;
  prepare: () => Promise<void>;
  config: AppConfiguration;
  isoGitFs?: IsoGitFsClient;
  releaseAssets?: ReleaseAssetStore;
  getLimits?: () => { maxObjects: number; maxPackBytes: number; maxRefs?: number };
}

export type { RepoRpcDeps, IsoGitFsClient };
