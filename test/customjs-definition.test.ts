import { describe, expect, it } from 'vitest';
import {
  CHECKS_FILE_PATH,
  decodeBlobToText,
  loadCheckDefinition,
  loadCheckScript,
  parseCheckDefinitionFile,
} from '@edge-git/background/checks/CheckDefinition';

function blobOf(text: string): { contentBase64: string; isBinary: boolean } {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return { contentBase64: btoa(binary), isBinary: false };
}

function stubWithFiles(files: Record<string, string>): {
  getBlob(args: { filepath: string }): Promise<{ contentBase64: string; isBinary: boolean } | null>;
} {
  return {
    getBlob: ({ filepath }: { filepath: string }) => {
      const text = files[filepath];
      return Promise.resolve(text === undefined ? null : blobOf(text));
    },
  };
}

describe('parseCheckDefinitionFile', () => {
  it('parses a minimal valid file', () => {
    const checks = parseCheckDefinitionFile(JSON.stringify({ checks: [{ context: 'lint', script: '.edgegit/checks/lint.js' }] }));
    expect(checks).toEqual([{ context: 'lint', scriptPath: '.edgegit/checks/lint.js', env: {}, allowHosts: [] }]);
  });

  it('parses env and allowHosts', () => {
    const checks = parseCheckDefinitionFile(
      JSON.stringify({
        checks: [{ context: 'e2e', script: '.edgegit/checks/e2e.js', env: { LEVEL: 'strict' }, allowHosts: ['Example.COM'] }],
      }),
    );
    expect(checks[0]?.env).toEqual({ LEVEL: 'strict' });
    expect(checks[0]?.allowHosts).toEqual(['example.com']);
  });

  it('rejects invalid JSON and shapes', () => {
    expect(() => parseCheckDefinitionFile('nope')).toThrow(`${CHECKS_FILE_PATH} is not valid JSON`);
    expect(() => parseCheckDefinitionFile('[]')).toThrow('"checks" array');
    expect(() => parseCheckDefinitionFile('{}')).toThrow('"checks" array');
    expect(() => parseCheckDefinitionFile(JSON.stringify({ checks: 'x' }))).toThrow('"checks" array');
  });

  it('rejects bad contexts, scripts, and duplicates', () => {
    expect(() => parseCheckDefinitionFile(JSON.stringify({ checks: [{ context: '', script: '.edgegit/checks/a.js' }] }))).toThrow(
      'context',
    );
    expect(() =>
      parseCheckDefinitionFile(JSON.stringify({ checks: [{ context: 'secret-scan', script: '.edgegit/checks/a.js' }] })),
    ).toThrow('reserved built-in');
    expect(() => parseCheckDefinitionFile(JSON.stringify({ checks: [{ context: 'lint', script: 'checks/lint.js' }] }))).toThrow(
      '.edgegit/checks/',
    );
    expect(() => parseCheckDefinitionFile(JSON.stringify({ checks: [{ context: 'lint', script: '.edgegit/checks/../evil.js' }] }))).toThrow(
      '.edgegit/checks/',
    );
    expect(() =>
      parseCheckDefinitionFile(
        JSON.stringify({
          checks: [
            { context: 'lint', script: '.edgegit/checks/a.js' },
            { context: 'Lint', script: '.edgegit/checks/b.js' },
          ],
        }),
      ),
    ).toThrow('duplicate context');
  });

  it('rejects bad env and allowHosts', () => {
    expect(() =>
      parseCheckDefinitionFile(
        JSON.stringify({ checks: [{ context: 'lint', script: '.edgegit/checks/a.js', env: { 'has space': 'x' } }] }),
      ),
    ).toThrow('env key');
    expect(() =>
      parseCheckDefinitionFile(
        JSON.stringify({ checks: [{ context: 'lint', script: '.edgegit/checks/a.js', allowHosts: ['localhost'] }] }),
      ),
    ).toThrow('loopback, private, or reserved');
    expect(() =>
      parseCheckDefinitionFile(JSON.stringify({ checks: [{ context: 'lint', script: '.edgegit/checks/a.js', allowHosts: ['10.0.0.1'] }] })),
    ).toThrow('loopback, private, or reserved');
    expect(() =>
      parseCheckDefinitionFile(
        JSON.stringify({ checks: [{ context: 'lint', script: '.edgegit/checks/a.js', allowHosts: ['not a host!'] }] }),
      ),
    ).toThrow('not a valid hostname');
  });

  it('caps the check count', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ context: `c${i}`, script: '.edgegit/checks/a.js' }));
    expect(() => parseCheckDefinitionFile(JSON.stringify({ checks: many }))).toThrow('at most 20');
  });
});

describe('loadCheckDefinition', () => {
  it('returns absent when the file is missing', async () => {
    const loaded = await loadCheckDefinition(stubWithFiles({}), 'a'.repeat(40));
    expect(loaded).toEqual({ state: 'absent' });
  });

  it('returns ok for a valid file', async () => {
    const loaded = await loadCheckDefinition(
      stubWithFiles({ [CHECKS_FILE_PATH]: JSON.stringify({ checks: [{ context: 'lint', script: '.edgegit/checks/lint.js' }] }) }),
      'a'.repeat(40),
    );
    expect(loaded.state).toBe('ok');
  });

  it('returns error for a broken file', async () => {
    const loaded = await loadCheckDefinition(stubWithFiles({ [CHECKS_FILE_PATH]: 'nope' }), 'a'.repeat(40));
    expect(loaded.state).toBe('error');
  });
});

describe('loadCheckScript', () => {
  it('loads text scripts and rejects missing ones', async () => {
    const stub = stubWithFiles({ '.edgegit/checks/lint.js': 'function main() {}' });
    expect(await loadCheckScript(stub, 'a'.repeat(40), '.edgegit/checks/lint.js', 65536)).toBe('function main() {}');
    expect(await loadCheckScript(stub, 'a'.repeat(40), '.edgegit/checks/nope.js', 65536)).toBeNull();
  });

  it('rejects oversized scripts', async () => {
    const stub = stubWithFiles({ '.edgegit/checks/big.js': 'x'.repeat(100) });
    expect(await loadCheckScript(stub, 'a'.repeat(40), '.edgegit/checks/big.js', 10)).toBeNull();
  });
});

describe('decodeBlobToText', () => {
  it('decodes text and rejects binary/oversize', () => {
    expect(decodeBlobToText(blobOf('hi'), 100)).toBe('hi');
    expect(decodeBlobToText(null, 100)).toBeNull();
    expect(decodeBlobToText({ contentBase64: blobOf('hi').contentBase64, isBinary: true }, 100)).toBeNull();
    expect(decodeBlobToText(blobOf('x'.repeat(200)), 100)).toBeNull();
  });
});
