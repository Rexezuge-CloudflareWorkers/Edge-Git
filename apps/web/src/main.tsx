import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

interface Repo {
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  isPrivate: boolean;
}

function useMe(): string | null {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    fetch('/user/me')
      .then((r) => (r.ok ? (r.json() as Promise<{ email?: string }>) : null))
      .then((d) => setEmail(d?.email ?? null))
      .catch(() => setEmail(null));
  }, []);
  return email;
}

function App(): React.JSX.Element {
  const email = useMe();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);

  const load = (): void => {
    fetch('/user/repos')
      .then((r) => (r.ok ? (r.json() as Promise<{ repos?: Repo[] }>) : { repos: [] }))
      .then((d) => setRepos((d as { repos?: Repo[] }).repos ?? []))
      .catch(() => undefined);
  };

  useEffect(load, [email]);

  const create = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const res = await fetch('/user/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: owner || undefined, name, isPrivate }),
    });
    if (res.ok) {
      setName('');
      load();
    } else {
      const err = (await res.json().catch(() => ({ error: 'failed' }))) as { error?: string };
      alert(err.error ?? 'Failed to create repo');
    }
  };

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 900, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>Edge-Git</h1>
      <p>Self-hosted Git on Cloudflare Workers + Durable Objects.</p>
      <p>
        Signed in as: <strong>{email ?? '…'}</strong>
      </p>
      <section>
        <h2>Clone</h2>
        <pre>
          git clone {typeof window === 'undefined' ? '' : window.location.origin}
          /{'<owner>/<repo>'}
        </pre>
        <p>
          Auth: <code>git clone https://{'<owner>'}:{'<PAT>'}@host/owner/repo</code> — use PAT as password. Public repos allow
          anonymous fetch.
        </p>
      </section>
      <section>
        <h2>New repository</h2>
        <form onSubmit={create}>
          <input placeholder="owner (default: you)" value={owner} onChange={(e) => setOwner(e.target.value)} />
          <input placeholder="repo name" value={name} onChange={(e) => setName(e.target.value)} required />
          <label>
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} /> private
          </label>
          <button type="submit">Create</button>
        </form>
      </section>
      <section>
        <h2>Repositories</h2>
        <ul>
          {repos.map((r) => (
            <li key={r.fullName}>
              <strong>{r.fullName}</strong> {r.isPrivate ? '(private)' : '(public)'} — {r.description ?? ''}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Personal access tokens</h2>
        <TokenManager />
      </section>
    </main>
  );
}

function TokenManager(): React.JSX.Element {
  const [tokens, setTokens] = useState<Array<{ tokenId: string; name: string; expiresAt: number }>>([]);
  const [name, setName] = useState('');
  const [lastCreated, setLastCreated] = useState<string | null>(null);
  const load = (): void => {
    fetch('/user/tokens')
      .then((r) => r.json() as Promise<{ tokens?: Array<{ tokenId: string; name: string; expiresAt: number }> }>)
      .then((d) => setTokens(d.tokens ?? []))
      .catch(() => undefined);
  };
  useEffect(load, []);
  const create = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const res = await fetch('/user/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = (await res.json()) as { token?: string; error?: string };
    if (res.ok) {
      setLastCreated(data.token as string);
      setName('');
      load();
    } else {
      alert(data.error ?? 'failed');
    }
  };
  return (
    <div>
      <form onSubmit={create}>
        <input placeholder="token name" value={name} onChange={(e) => setName(e.target.value)} required />
        <button type="submit">Mint PAT</button>
      </form>
      {lastCreated ? (
        <p>
          New token (copy once): <code>{lastCreated}</code>
        </p>
      ) : null}
      <ul>
        {tokens.map((t) => (
          <li key={t.tokenId}>
            {t.name} — expires {new Date(t.expiresAt * 1000).toISOString()}
            <button
              onClick={() => {
                fetch(`/user/tokens/${t.tokenId}`, { method: 'DELETE' }).then(load).catch(() => undefined);
              }}
            >
              revoke
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}
