import type { AppConfiguration } from '@edge-git/backend-runtime/config';

export interface SandboxLimits {
  cpuMs: number;
  memoryMb: number;
  maxFetches: number;
  fetchTimeoutMs: number;
  maxResponseBytes: number;
  wallMs: number;
  maxLogBytes: number;
}

export interface SandboxInput {
  script: string;
  files: Record<string, string>;
  env: Record<string, string>;
  allowHosts: string[];
  limits: SandboxLimits;
}

const MAX_OUTPUT_TITLE = 200;
const MAX_OUTPUT_SUMMARY = 2000;
const MAX_FETCH_BODY_BYTES = 65_536;
const MAX_FETCH_HEADERS = 20;

// Resolve sandbox resource caps from injected config (single source).
function resolveSandboxLimits(config: AppConfiguration, overrides: Partial<SandboxLimits> = {}): SandboxLimits {
  return {
    cpuMs: overrides.cpuMs ?? config.getCheckCustomJsMaxCpuMs(),
    memoryMb: overrides.memoryMb ?? config.getCheckCustomJsMemoryMb(),
    maxFetches: overrides.maxFetches ?? config.getCheckCustomJsMaxFetches(),
    fetchTimeoutMs: overrides.fetchTimeoutMs ?? 5000,
    maxResponseBytes: overrides.maxResponseBytes ?? MAX_FETCH_BODY_BYTES,
    wallMs: overrides.wallMs ?? config.getCheckTimeoutSeconds() * 1000,
    maxLogBytes: overrides.maxLogBytes ?? 8192,
  };
}

export { MAX_OUTPUT_TITLE, MAX_OUTPUT_SUMMARY, MAX_FETCH_BODY_BYTES, MAX_FETCH_HEADERS, resolveSandboxLimits };
