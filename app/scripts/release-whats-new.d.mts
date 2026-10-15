// Types for release-whats-new.mjs, so its test is checked like the rest. The
// script stays plain ESM because release.mjs runs it with bare node, no tsx.
export function cutWhatsNew(text: string, version: string): { text: string; cut: boolean }
