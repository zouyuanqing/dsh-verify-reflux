/**
 * Verified-state memory, scoped per agent/session.
 *
 * Keys are the executing Agent object (the harness's own scope routing key)
 * or the literal 'root' for scope-less assemblies. WeakMap keyed by the live
 * agent means finished sessions are garbage-collected with their verdicts —
 * no cross-session leakage, no manual eviction.
 */

export interface VerdictEntry {
	/** Wall-clock time of the verdict (already formatted by caller). */
	readonly time: string
	/** Which wire tool produced it. */
	readonly tool: 'verify_select' | 'verify_check' | 'verify_track'
	/** One-line human-readable verdict. */
	readonly summary: string
	/** Judge-tier provenance badge, when the run used a non-template tier. */
	readonly via?: string
}

export type StateKey = object | 'root'

const MAX_ENTRIES = 6

export function keyOf(scope: unknown): StateKey {
	if (scope && typeof scope === 'object') return scope
	return 'root'
}

export interface VerifiedStateRegistry {
	record(key: StateKey, entry: VerdictEntry): void
	/** Rendered snapshot for one scope; empty string contributes nothing. */
	renderFor(key: StateKey): string
	/** Whether this scope has run any verification (gates pre-turn deepthink). */
	hasEngaged(key: StateKey): boolean
	/** Number of settled verdicts for one scope (provenance metadata). */
	count(key: StateKey): number
}

export function createVerifiedStateRegistry(max: number = MAX_ENTRIES): VerifiedStateRegistry {
	const byObject = new WeakMap<object, VerdictEntry[]>()
	const root: VerdictEntry[] = []
	const bucketFor = (key: StateKey): VerdictEntry[] =>
		key === 'root' ? root : byObject.get(key)!
	const ensure = (key: StateKey): VerdictEntry[] => {
		if (key === 'root') return root
		let b = byObject.get(key)
		if (!b) {
			b = []
			byObject.set(key, b)
		}
		return b
	}
	return {
		record(key, entry) {
			const b = ensure(key)
			b.unshift(entry)
			if (b.length > max) b.length = max
		},
		renderFor(key) {
			const b = bucketFor(key)
			if (!b || !b.length) return ''
			const lines = b.map(
				(e) => `- [${e.time}] ${e.tool}: ${e.summary}${e.via ? ` (${e.via})` : ''}`,
			)
			return [
				'<verified_state>',
				'Latest probabilistic verification verdicts — treat as settled ground',
				'unless the underlying code changed since:',
				...lines,
				'</verified_state>',
			].join('\n')
		},
		hasEngaged(key) {
			const b = bucketFor(key)
			return !!b && b.length > 0
		},
		count(key) {
			const b = bucketFor(key)
			return b ? b.length : 0
		},
	}
}
