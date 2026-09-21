// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card, CardHeader, CardTitle } from '../apps/web/src/components/ui/Card';

// First jsdom component test (Slice 4): proves the root suite can mount SPA
// primitives. The web app stays out of V8 coverage (`vitest.config.mts`
// only includes api/background/packages), so these are correctness tests,
// not gate drivers.
describe('slice4: Card primitive', () => {
  it('renders children with title', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Team Settings</CardTitle>
        </CardHeader>
        <p>Manage organization teams.</p>
      </Card>,
    );
    expect(screen.getByText('Team Settings')).toBeTruthy();
    expect(screen.getByText('Manage organization teams.')).toBeTruthy();
  });

  it('merges custom class names', () => {
    const { container } = render(<Card className="extra-class">Body</Card>);
    expect(container.querySelector('.extra-class')).toBeTruthy();
    expect(screen.getByText('Body')).toBeTruthy();
  });
});
