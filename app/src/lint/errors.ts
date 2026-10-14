// Thrown when the lint cannot start: no make-pot, a make-pot that failed, a
// download that failed or did not verify, a settings file that does not
// parse. The command prints the message and each detail line and exits 2,
// which a CI job reads as "nothing was checked", never as "the strings have
// errors".
export class LintNotStarted extends Error {
  constructor(
    message: string,
    readonly detail: readonly string[] = [],
  ) {
    super(message)
    this.name = 'LintNotStarted'
  }
}
