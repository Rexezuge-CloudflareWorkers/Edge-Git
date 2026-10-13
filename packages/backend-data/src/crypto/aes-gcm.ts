import { decryptSecret, encryptSecret, KEY_BYTES } from '@rexezuge/d1';
import type { EncryptedEnvelope } from '@rexezuge/d1';

/**
 * AES-GCM-256 at the storage boundary.
 *
 * The primitive is the kit's (`@rexezuge/d1`'s `encryptSecret`/`decryptSecret`):
 * WebCrypto key import, a random IV per call and a typed `AesGcmKeyError` on a
 * wrong key or tampered ciphertext. What stays here is the two things the
 * schema and the key-issuance path need and the kit deliberately does not ship.
 *
 * ## Why this is an adapter rather than a re-export
 *
 * - **The column is named `encrypted`, not `ciphertext`.** `repo_webhooks`,
 *   `mirrors` and `repo_imports` store the pair in `encrypted_*` columns and
 *   migration 0027 dropped the plaintext ones, so the envelope has to land
 *   under the name the rows already carry. Renaming a column across every DAO
 *   and a squashed baseline is a migration, not an adoption.
 * - **`generateAESGCMKey` is key issuance, not encryption.** The kit exports
 *   `KEY_BYTES` (32) for a key that already exists; minting one is the
 *   operator-facing `scripts/` path and belongs next to it.
 */

/**
A base64 AES-GCM-256 key, for a Secrets Store binding.
*/
export async function generateAESGCMKey(): Promise<string> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: KEY_BYTES * 8 }, true, ['encrypt', 'decrypt']);
  const exported = await crypto.subtle.exportKey('raw', key);
  const bytes = new Uint8Array(exported);
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary);
}

export async function encryptData(data: string, keyBase64: string): Promise<{ encrypted: string; iv: string }> {
  const { ciphertext, iv } = await encryptSecret(data, keyBase64);
  return { encrypted: ciphertext, iv };
}

export async function decryptData(encryptedBase64: string, ivBase64: string, keyBase64: string): Promise<string> {
  return decryptSecret({ ciphertext: encryptedBase64, iv: ivBase64 } satisfies EncryptedEnvelope, keyBase64);
}

export async function decryptDataOptional(
  encryptedBase64: string | undefined | null,
  ivBase64: string | undefined | null,
  keyBase64: string | undefined,
): Promise<string | undefined> {
  if (encryptedBase64 && ivBase64 && keyBase64) {
    return decryptSecret({ ciphertext: encryptedBase64, iv: ivBase64 } satisfies EncryptedEnvelope, keyBase64);
  }
  return undefined;
}