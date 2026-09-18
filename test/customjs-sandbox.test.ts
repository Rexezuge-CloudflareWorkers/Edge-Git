import { describe, expect, it } from 'vitest';
import { runCustomCheckScript } from '@edge-git/background/checks/CustomJsSandbox';
import type { SandboxLimits } from '@edge-git/background/checks/CustomJsSandbox';

const LIMITS: SandboxLimits = {
  cpuMs: 3000,
  memoryMb: 16,
  maxFetches: 2,
  fetchTimeoutMs: 5000,
  maxResponseBytes: 65536,
  wallMs: 15000,
  maxLogBytes: 4096,
};

const FILES = { 'README.md': '# Hello', 'src/a.ts': 'export const x = 1;\n' };

async function run(script: string, overrides: Partial<Parameters<typeof runCustomCheckScript>[0]> = {}) {
  return runCustomCheckScript({ script, files: FILES, env: {}, allowHosts: [], limits: LIMITS, ...overrides });
}

describe('CustomJsSandbox', () => {
  it('runs a passing check with files, env, and logs', async () => {
    const result = await run(
      'function main(ctx) { ctx.log("n=" + ctx.listFiles().length); return { conclusion: "success", title: "Lint Ok", summary: "env=" + ctx.env.LEVEL + " readme=" + ctx.readFile("README.md") }; }',
      {
        env: { LEVEL: 'strict' },
      },
    );
    expect(result.conclusion).toBe('success');
    expect(result.title).toBe('Lint Ok');
    expect(result.summary).toContain('env=strict');
    expect(result.summary).toContain('readme=# Hello');
    expect(result.summary).toContain('n=2');
  });

  it('maps thrown errors to failure', async () => {
    const result = await run('function main(ctx) { throw new Error("lint found 3 problems"); }');
    expect(result).toMatchObject({ conclusion: 'failure', title: 'Check Script Threw' });
    expect(result.summary).toContain('lint found 3 problems');
  });

  it('times out infinite loops via the CPU budget', async () => {
    const result = await run('function main(ctx) { let i = 0; while (true) { i++; } }', {
      limits: { ...LIMITS, cpuMs: 500 },
    });
    expect(result.conclusion).toBe('timed_out');
  });

  it('blocks fetches outside allowHosts', async () => {
    const result = await run(
      'function main(ctx) { const r = ctx.fetch("https://example.com/x"); return { conclusion: "success", summary: String(r.status) }; }',
    );
    expect(result.conclusion).toBe('failure');
    expect(result.summary).toContain('not in allowHosts');
  });

  it('blocks non-https fetches', async () => {
    const result = await run(
      'function main(ctx) { const r = ctx.fetch("http://example.com/x"); return { conclusion: "success", summary: String(r.status) }; }',
      { allowHosts: ['example.com'] },
    );
    expect(result.conclusion).toBe('failure');
    expect(result.summary).toContain('must use https');
  });

  it('rejects bad return shapes as action_required', async () => {
    expect((await run('function main(ctx) { return 42; }')).conclusion).toBe('action_required');
    expect((await run('function main(ctx) { return { conclusion: "bogus" }; }')).conclusion).toBe('action_required');
  });

  it('rejects missing mains and syntax errors as failure', async () => {
    expect((await run('const x = 1;')).conclusion).toBe('failure');
    expect((await run('function main(ctx) { {{{')).conclusion).toBe('failure');
  });

  it('rejects async mains with the sync contract message', async () => {
    const result = await run('async function main(ctx) { return { conclusion: "success" }; }');
    expect(result.conclusion).toBe('failure');
    expect(result.summary).toContain('must be synchronous');
  });

  it('supports neutral/skipped and console.log capture', async () => {
    const skipped = await run('function main(ctx) { console.log("hi", 42); return { conclusion: "skipped" }; }');
    expect(skipped.conclusion).toBe('skipped');
    expect(skipped.summary).toContain('hi 42');
    const neutral = await run('function main(ctx) { return { conclusion: "neutral" }; }');
    expect(neutral.conclusion).toBe('neutral');
  });

  it('caps output lengths', async () => {
    const result = await run(
      `function main(ctx) { return { conclusion: "success", title: "${'t'.repeat(500)}", summary: "${'s'.repeat(5000)}" }; }`,
    );
    expect(result.title).toHaveLength(200);
    expect(result.summary.length).toBeLessThanOrEqual(2000);
  });

  it('readFile returns null for unknown paths', async () => {
    const result = await run('function main(ctx) { return { conclusion: ctx.readFile("nope.md") === null ? "success" : "failure" }; }');
    expect(result.conclusion).toBe('success');
  });
});
