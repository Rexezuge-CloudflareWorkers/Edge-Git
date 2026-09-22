import * as git from 'isomorphic-git';
import type { IsoGitFs } from './IsoGitFs';

type PromiseFsClient = ReturnType<IsoGitFs['getPromiseFsClient']>;

type TextFile = { isBinary: boolean; content: string | null };

type FileStateChange = {
  type: 'add' | 'modify' | 'remove';
  path: string;
  old: TextFile | null;
  new: TextFile | null;
};

const logger = {
  warn: (...args: unknown[]): void => console.warn('[WARN] [GitService]', ...args),
};

/**
 * Two-tree differ extracted from `HistoryService` (SRP, following the
 * `TreeReader` precedent). Owns the `git.walk` two-tree comparison plus
 * text decoding; `HistoryService.getFileStateChanges` delegates here for
 * backward compatibility. Binary detection is injected so the differ stays
 * decoupled from `TreeReader`.
 */
class TreeDiffer {
  constructor(
    private readonly fs: PromiseFsClient,
    private readonly gitdir: string,
    private readonly detectBinary: (content: Uint8Array) => boolean,
  ) {}

  async diffTrees(oldCommit: string | undefined, newCommit: string | undefined): Promise<FileStateChange[]> {
    type File = { isBinary: false; content: string } | { isBinary: true; content: null };

    type Change = {
      type: 'add' | 'modify' | 'remove';
      path: string;
      old: File | null;
      new: File | null;
    };

    const detectBinary = this.detectBinary;
    const data = await git.walk({
      fs: this.fs,
      gitdir: this.gitdir,
      trees: [git.TREE({ ref: oldCommit }), git.TREE({ ref: newCommit })],
      map: async (filepath, [A, B]): Promise<Change | undefined> => {
        if (filepath === '.') {
          return;
        }

        const Atype = A ? await A.type() : null;
        const Btype = B ? await B.type() : null;

        if (Atype === 'tree' || Btype === 'tree') {
          return;
        }

        const Aoid = A ? await A.oid() : null;
        const Boid = B ? await B.oid() : null;

        if (Aoid === null && Boid === null) {
          logger.warn(`(get-file-state-changes): Both A and B are null for path ${filepath}`);
          return;
        }
        const type: 'equal' | 'modify' | 'add' | 'remove' =
          Aoid === null ? 'add' : Boid === null ? 'remove' : Aoid === Boid ? 'equal' : 'modify';

        if (type === 'equal') {
          return;
        }

        const oldContent = await A?.content();
        const newContent = await B?.content();

        const isOldBinary = oldContent && detectBinary(oldContent);
        const isNewBinary = newContent && detectBinary(newContent);

        let oldFile: File | null = null;

        if (isOldBinary) {
          oldFile = { isBinary: true, content: null };
        } else if (oldContent) {
          oldFile = {
            isBinary: false,
            content: new TextDecoder().decode(oldContent),
          };
        }

        let newFile: File | null = null;

        if (isNewBinary) {
          newFile = { isBinary: true, content: null };
        } else if (newContent) {
          newFile = {
            isBinary: false,
            content: new TextDecoder().decode(newContent),
          };
        }

        return {
          type,
          path: filepath,
          old: oldFile,
          new: newFile,
        };
      },
    });
    return data as Change[];
  }
}

export { TreeDiffer };
export type { FileStateChange, TextFile };
