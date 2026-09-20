type CustomConclusion = 'success' | 'failure' | 'neutral' | 'skipped';

interface SandboxResult {
  conclusion: CustomConclusion | 'timed_out' | 'action_required';
  title: string;
  summary: string;
}

export type { CustomConclusion, SandboxResult };
