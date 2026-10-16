// The builder rebuilds its file and reruns the tester a moment after the
// last keystroke, not on every one. That wait is only safe if anything that
// hands the file out can end it early: Download, Copy and Send read the YAML
// the last refresh built, and a click within the wait after an edit would
// otherwise ship the file from before it. flush() runs the pending refresh at
// once and cancels the timer, so it is not run a second time; with nothing
// pending the file is already current and flush() does nothing.
export function debounce(run: () => void, ms: number): { schedule: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        run();
      }, ms);
    },
    flush() {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      run();
    },
  };
}
