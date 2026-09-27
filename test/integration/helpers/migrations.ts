/**
 * Minimal SQL statement splitter for SQLite migration files.
 *
 * Handles: single/double/backtick quoted strings (incl. `''` escapes),
 * `--` line comments, `/* ... *\/` block comments. Semicolons inside strings
 * or comments do not split. Skips comment-only statements.
 *
 * Trigger-aware: `CREATE TRIGGER ... BEGIN ...; ... END;` bodies contain
 * semicolons that must not split. The splitter tracks the outermost
 * BEGIN/END depth after a CREATE TRIGGER header and only splits on the
 * terminating semicolon after the final END.
 */

declare const __INTEGRATION_MIGRATION_SQL__: string;
declare const __INTEGRATION_MIGRATION_FILES__: ReadonlyArray<{ name: string; sql: string }>;

export interface MigrationFile {
  name: string;
  sql: string;
}

/** Migration files in apply order. */
function migrationFiles(): MigrationFile[] {
  const files = typeof __INTEGRATION_MIGRATION_FILES__ === 'undefined' ? null : __INTEGRATION_MIGRATION_FILES__;
  if (files && files.length > 0) return [...files];
  // Fallback for harnesses that only inject the flattened string.
  return [{ name: 'all.sql', sql: __INTEGRATION_MIGRATION_SQL__ }];
}

/** Names of the embedded migration files, in apply order. */
export function migrationFileNames(): string[] {
  return migrationFiles().map((f) => f.name);
}


function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  let stringChar = '';
  let inLineComment = false;
  let inBlockComment = false;
  // CREATE TRIGGER body tracking (see header comment). Keywords are scanned
  // outside strings/comments only, matched as whole words case-insensitively.
  let inTrigger = false;
  let triggerDepth = 0;
  let word = '';
  const recentKeywords: string[] = [];
  const flushWord = (): void => {
    if (word.length === 0) return;
    const upper = word.toUpperCase();
    word = '';
    recentKeywords.push(upper);
    if (recentKeywords.length > 6) recentKeywords.shift();
    // `CREATE [TEMP|TEMPORARY] TRIGGER` opens a body; a table merely named
    // "trigger" (`CREATE TABLE trigger`) must not. The word before TRIGGER
    // disambiguates.
    if (upper === 'TRIGGER' && ['CREATE', 'TEMP', 'TEMPORARY'].includes(recentKeywords[recentKeywords.length - 2] ?? '')) {
      inTrigger = true;
      triggerDepth = 0;
    } else if (inTrigger && upper === 'BEGIN') {
      triggerDepth += 1;
    } else if (inTrigger && upper === 'END') {
      triggerDepth -= 1;
      if (triggerDepth <= 0) {
        inTrigger = false;
        triggerDepth = 0;
      }
    }
  };
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1] ?? '';

    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') {
        current += next;
        i += 2;
        inBlockComment = false;
        continue;
      }
      i++;
      continue;
    }
    if (inString) {
      current += ch;
      if (ch === stringChar) {
        // SQL escapes a quote by doubling it ('it''s'); do not end the string.
        if (sql[i + 1] === stringChar) {
          current += sql[i + 1];
          i += 2;
          continue;
        }
        if (sql[i - 1] !== '\\') inString = false;
      }
      i++;
      continue;
    }
    // Buffer word characters for CREATE TRIGGER / BEGIN / END tracking.
    // Any other character ends the current word.
    if (/[\w$]/.test(ch)) {
      word += ch;
      current += ch;
      i++;
      continue;
    }
    flushWord();
    if (ch === '-' && next === '-') {
      inLineComment = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = true;
      stringChar = ch;
      current += ch;
      i++;
      continue;
    }
    if (ch === ';') {
      // Semicolons inside a trigger body do not terminate the statement.
      if (inTrigger) {
        current += ch;
        i++;
        continue;
      }
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  const trimmed = current.trim();
  if (trimmed.length > 0) statements.push(trimmed);
  return statements;
}

function executableStatements(sql: string): string[] {
  return splitSql(sql).filter((stmt) => {
    if (stmt.length === 0) return false;
    // Skip pure-comment statements (no executable SQL).
    const withoutComments = stmt
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();
    return withoutComments.length > 0;
  });
}

/** Strip leading `--` / block comments, which the splitter folds into the statement. */
function stripLeadingComments(stmt: string): string {
  let out = stmt;
  for (;;) {
    const next = out.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*/, '');
    if (next === out) return out.trim();
    out = next;
  }
}

/** `PRAGMA` statements that scope a connection/transaction rather than the schema. */
function isConnectionPragma(stmt: string): boolean {
  return /^pragma\s+(?!foreign_key_check|table_|index_|quick_check|integrity_check)\w/i.test(stripLeadingComments(stmt));
}

/**
 * Apply one migration file.
 *
 * D1 scopes PRAGMAs to the current transaction, and it does not guarantee that
 * a `db.batch()` behaves as one transaction for them. Migration 0028 depends on
 * `PRAGMA foreign_keys = off` holding for every statement that follows — that
 * pragma is what stops its table rebuilds from cascading rows away through
 * `ON DELETE CASCADE` — so for any file that opens with a connection PRAGMA we
 * re-issue that PRAGMA before each statement rather than betting on batch
 * semantics. Files without one (0021–0027) take the single-batch fast path.
 */
async function applyMigrationFile(db: D1Database, file: MigrationFile): Promise<void> {
  const statements = executableStatements(file.sql);
  if (statements.length === 0) return;
  const pragmas = statements.filter((stmt) => isConnectionPragma(stmt));
  if (pragmas.length === 0) {
    await db.batch(statements.map((sql) => db.prepare(sql)));
    return;
  }
  const pragmaIndex = new Map(pragmas.map((p) => [p, statements.indexOf(p)]));
  for (let i = 0; i < statements.length; i += 1) {
    const statement = statements[i] as string;
    const preamble = pragmas.filter((p) => (pragmaIndex.get(p) as number) < i);
    try {
      await db.batch([...preamble, statement].map((sql) => db.prepare(sql)));
    } catch (error) {
      // Name the statement: a batch only reports the file's single failure,
      // and 0028's guard exists precisely to fail loudly here.
      throw new Error(
        `${file.name}: statement ${i + 1}/${statements.length} failed: ${stripLeadingComments(statement).slice(0, 200)}\n${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

/**
 * Apply a range of migrations, defaulting to every file.
 *
 * `from`/`to` are file names (`0027_drop_plaintext_secrets.sql`). A range is
 * what the identity-upgrade test needs: re-applying 0021 after 0024 has
 * already dropped `user_access_tokens.scopes` would make 0023's backfill
 * reference a column that no longer exists.
 */
export async function applyMigrations(db: D1Database, range?: { from?: string; to?: string }): Promise<void> {
  const files = migrationFiles();
  const indexOf = (name: string | undefined, fallback: number): number => {
    if (!name) return fallback;
    const found = files.findIndex((f) => f.name === name);
    if (found === -1) {
      throw new Error(`Unknown migration file: ${name}. Available: ${files.map((f) => f.name).join(', ')}`);
    }
    return found;
  };
  const start = indexOf(range?.from, 0);
  const end = indexOf(range?.to, files.length - 1);
  for (const file of files.slice(start, end + 1)) {
    await applyMigrationFile(db, file);
  }
}

export { splitSql };
