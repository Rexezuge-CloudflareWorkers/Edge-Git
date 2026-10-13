/**
 * Git-side identity: the canonical `owner/name` repository identifier.
 *
 * The email half of this file moved to the kit. `isValidEmailFormat` is defined
 * once in `@rexezuge/shared` (on `Identity.ts`, the wider group's home) and
 * re-exported by `EmailUtil`, which is also the single home of `normalizeEmail`
 * — the one trim+lowercase rule the docs call out as load-bearing, because two
 * copies that disagreed made `" Alice@Example.com "` one account to one layer
 * and a different account to another. Edge-Git's `EmailAddress` value class was
 * sugar over exactly that rule, so call sites now use `normalizeEmail` directly.
 *
 * `RepoFullName` and the Durable-Object key helpers stay here: an `owner/name`
 * git identifier, its `.git`-stripping and the DO routing key are git business
 * logic, the same class of concern as `GitOids`/`BranchValidation`.
 */

/**
 * Canonical `owner/name` repository identifier.
 * Consolidates `normalizeOwner/normalizeRepo(strip .git)` + `OWNER_RE/REPO_RE`
 * validation spread across `RepoService` and route handlers.
 */
const OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
const REPO_PATTERN = /^[\w.-]{1,100}$/i;

class RepoFullName {
  private constructor(
    public readonly owner: string,
    public readonly name: string,
  ) {}

  public static normalizeOwner(owner: string): string {
    return owner.trim();
  }

  public static normalizeRepo(name: string): string {
    const trimmed = name.trim();
    return trimmed.toLowerCase().endsWith('.git') ? trimmed.slice(0, -4) : trimmed;
  }

  public static parse(owner: string, name: string): RepoFullName {
    const normalizedOwner = this.normalizeOwner(owner);
    const normalizedName = this.normalizeRepo(name);
    if (!OWNER_PATTERN.test(normalizedOwner) || !REPO_PATTERN.test(normalizedName)) {
      throw new Error('Invalid owner or repository name');
    }
    if (
      normalizedName === '.' ||
      normalizedName === '..' ||
      normalizedName.startsWith('.') ||
      normalizedName.startsWith('-') ||
      normalizedName.endsWith('.lock') ||
      normalizedName.includes('..') ||
      normalizedName.includes('//')
    ) {
      throw new Error('Invalid owner or repository name');
    }
    return new this(normalizedOwner, normalizedName);
  }

  public static tryParse(owner: string, name: string): RepoFullName | null {
    try {
      return this.parse(owner, name);
    } catch {
      return null;
    }
  }

  public toString(): string {
    return `${this.owner}/${this.name}`;
  }

  public ownerCi(): string {
    return this.owner.toLowerCase();
  }

  /**
   * Canonical Durable Object routing key for `REPO.getByName()`.
   *
   * BREAKING: DO names are now case-insensitive (`Foo/Bar` and `foo/bar`
   * resolve to the same isolate). D1 already matches via `owner_ci/name_ci`;
   * the old case-sensitive `getByName(fullName)` forked two DOs for the same
   * repo. Callers must route via `toDoKey()` / `repoDoKey()` and persist the
   * display-case `toString()` only inside the DO.
   */
  public toDoKey(): string {
    return `${this.owner.toLowerCase()}/${this.name.toLowerCase()}`;
  }

  public toStringWithCase(): string {
    return this.toString();
  }
}

export { RepoFullName, OWNER_PATTERN, REPO_PATTERN };

/**
 * Canonical `REPO.getByName()` key for an `owner/name` pair without throwing.
 * Falls back to trimmed `owner.toLowerCase()/name(.git-stripped).toLowerCase()`
 * when validation fails so routing never throws on malformed input — callers
 * validate separately via `RepoFullName.tryParse`.
 */
function repoDoKey(owner: string, name: string): string {
  const parsed = RepoFullName.tryParse(owner, name);
  if (parsed) return parsed.toDoKey();
  const fallbackOwner = owner.trim().toLowerCase();
  const trimmed = name.trim();
  const stripped = trimmed.toLowerCase().endsWith('.git') ? trimmed.slice(0, -4) : trimmed;
  return `${fallbackOwner}/${stripped.toLowerCase()}`;
}

/**
 * Canonical `REPO.getByName()` key for an already-joined `owner/name` string.
 */
function repoDoKeyForFullName(fullName: string): string {
  const slash = fullName.indexOf('/');
  if (slash === -1) return fullName.trim().toLowerCase();
  return repoDoKey(fullName.slice(0, slash), fullName.slice(slash + 1));
}

export { repoDoKey, repoDoKeyForFullName };
