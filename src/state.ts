/**
 * Verified-state memory: a bounded ring of the most recent verification
 * verdicts, rendered as a dynamic system-prompt context. After any verify_*
 * run the model reads this snapshot on every later turn — verification
 * becomes part of what the model "knows", not just a one-off tool reply.
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

export interface VerifiedState {
	record(entry: VerdictEntry): void
	/** Rendered snapshot; empty string contributes nothing to assembly. */
	render(): string
	readonly entries: readonly VerdictEntry[]
}

const MAX_ENTRIES = 6

export function createVerifiedState(max: number = MAX_ENTRIES): VerifiedState {
	const entries: VerdictEntry[] = []
	return {
		get entries() {
			return entries
		},
		record(entry) {
			entries.unshift(entry)
			if (entries.length > max) entries.length = max
		},
		render() {
			if (!entries.length) return ''
			const lines = entries.map(
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
	}
}
