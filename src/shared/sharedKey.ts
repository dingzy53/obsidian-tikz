/**
 * Name of a diagram in the shared (synced) folder. Pure: WebCrypto only, so
 * it works on mobile, where `node:crypto` does not exist.
 *
 * The key covers the tidied source only, not the preamble or the engine
 * (unlike the local cache key in `cache.ts`). A phone must find the file even
 * when its own copy of the plugin settings is missing or stale; the desktop
 * that renders a block overwrites the shared file whenever its render changes.
 */

/** Bumped if the shared naming or the meaning of a shared file changes. */
export const SHARED_KEY_VERSION = 1;

export async function computeSharedKey(tidiedSource: string): Promise<string> {
	const bytes = new TextEncoder().encode(`tikz-shared-v${SHARED_KEY_VERSION}\u0000${tidiedSource}`);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
