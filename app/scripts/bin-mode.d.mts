// Types for bin-mode.mjs, so its test is checked like the rest. The script
// stays plain ESM because the build runs it with bare node, no tsx.
export function markBinsExecutable(dir: string): Promise<void>
