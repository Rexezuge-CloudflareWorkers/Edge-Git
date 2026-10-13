/**
 * The dependency-injection container — the kit's (`@rexezuge/runtime`).
 *
 * Byte-identical to this repo's former copy across all nine full-framework
 * consumer repos, because the last divergence in it was fixed in all of them at
 * once: minimal factory + singleton scopes, branded tokens for inference, and
 * nothing else. A DI container that grows features grows coupling with it.
 */
export { Container } from '@rexezuge/runtime';
export type { Factory, Token } from '@rexezuge/runtime';