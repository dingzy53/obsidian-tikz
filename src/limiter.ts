/**
 * Bounded-concurrency task runner. Pure module: no `import "obsidian"`.
 *
 * Opening a note with dozens of uncached diagrams would otherwise start one
 * TeX process per diagram at once; the contention makes each one slower and
 * pushes them toward the compile timeout.
 */

export class Limiter {
	private active = 0;
	private readonly waiting: (() => void)[] = [];

	constructor(private max: number) {
		this.max = Math.max(1, Math.floor(max));
	}

	/** Takes effect immediately for queued tasks; running ones are never cut short. */
	setMax(max: number): void {
		this.max = Math.max(1, Math.floor(max));
		this.drain();
	}

	get running(): number {
		return this.active;
	}

	get queued(): number {
		return this.waiting.length;
	}

	/** Runs `task` once a slot is free. Rejections propagate and free the slot. */
	run<T>(task: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const start = (): void => {
				this.active++;
				let pending: Promise<T>;
				try {
					pending = task();
				} catch (error) {
					// Without this, a synchronous throw would leak the slot (and,
					// when started from another task's cleanup, escape unhandled).
					pending = Promise.reject(error);
				}
				pending.then(resolve, reject).finally(() => {
					this.active--;
					this.drain();
				});
			};
			this.waiting.push(start);
			this.drain();
		});
	}

	private drain(): void {
		while (this.active < this.max && this.waiting.length > 0) {
			this.waiting.shift()?.();
		}
	}
}

/**
 * Resolves the "maximum parallel compiles" setting. 0 means automatic: half the
 * logical cores (LuaLaTeX is memory-hungry), at least one and at most four.
 */
export function resolveConcurrency(setting: number, cpuCount: number): number {
	if (Number.isFinite(setting) && setting >= 1) return Math.floor(setting);
	return Math.min(4, Math.max(1, Math.floor(cpuCount / 2)));
}
