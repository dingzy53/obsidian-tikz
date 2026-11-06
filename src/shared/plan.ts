/**
 * What a sync of the shared folder has to do. Pure.
 *
 * Only files named exactly `<64 hex>.svg` are ever considered ours, so a prune
 * can never delete anything else a user keeps in the folder.
 */

const SHARED_FILE = /^([0-9a-f]{64})\.svg$/;

export function isSharedFileName(name: string): boolean {
	return SHARED_FILE.test(name);
}

export function sharedFileName(key: string): string {
	return `${key}.svg`;
}

/** The key of a shared file name, or null if the file is not ours. */
export function keyOfSharedFile(name: string): string | null {
	return SHARED_FILE.exec(name)?.[1] ?? null;
}

export interface SyncPlan {
	/** Wanted keys with no file yet. */
	missing: string[];
	/** File names of ours that no block uses any more. */
	stale: string[];
}

export function planSync(wanted: Iterable<string>, presentNames: Iterable<string>): SyncPlan {
	const wantedSet = new Set(wanted);
	const presentKeys = new Set<string>();
	const stale: string[] = [];

	for (const name of presentNames) {
		const key = keyOfSharedFile(name);
		if (key === null) continue;
		presentKeys.add(key);
		if (!wantedSet.has(key)) stale.push(name);
	}

	const missing = [...wantedSet].filter((key) => !presentKeys.has(key));
	return { missing, stale };
}
