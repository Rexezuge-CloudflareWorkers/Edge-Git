import { GitBranch, Lock, Zap } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ZERO_TRUST_AUTHENTICATION_PATH } from '../lib/constants';

function signIn() {
  globalThis.location.assign(ZERO_TRUST_AUTHENTICATION_PATH);
}

export function LandingView() {
  return (
    <div className="max-w-7xl mx-auto px-6 py-16">
      <div className="text-center max-w-2xl mx-auto animate-fade-in-up">
        <h1 className="text-4xl font-semibold tracking-tight text-[var(--color-text-primary)]">
          Self-Hosted Git on <span className="text-[var(--color-accent)]">Cloudflare Workers</span>
        </h1>
        <p className="mt-4 text-[var(--color-text-secondary)]">
          Repositories backed by Durable Objects, served over Git Smart HTTP. Public repos allow anonymous fetch; private repos stay
          protected.
        </p>
        <div className="mt-8">
          <Button variant="primary" size="lg" onClick={signIn}>
            Sign In with Cloudflare Access
          </Button>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-4 mt-12 animate-stagger-1">
        <Card>
          <GitBranch className="h-5 w-5 text-[var(--color-accent)] mb-3" />
          <h2 className="font-semibold text-[var(--color-text-primary)] mb-1">Git Smart HTTP</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">Clone, fetch, and push with any Git client.</p>
        </Card>
        <Card>
          <Zap className="h-5 w-5 text-[var(--color-accent)] mb-3" />
          <h2 className="font-semibold text-[var(--color-text-primary)] mb-1">Edge Storage</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">One Durable Object per repository, SQLite-backed.</p>
        </Card>
        <Card>
          <Lock className="h-5 w-5 text-[var(--color-accent)] mb-3" />
          <h2 className="font-semibold text-[var(--color-text-primary)] mb-1">Access Control</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">Personal access tokens for Git; Cloudflare Access for the web UI.</p>
        </Card>
      </div>
    </div>
  );
}
