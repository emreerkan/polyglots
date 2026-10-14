import { describe, expect, it } from 'vitest'
import { spawnPlan } from '../src/spawn-plan.js'

// Node refuses to spawn a .bat or .cmd without a shell since the fix for
// CVE-2024-27980: wp on Windows is wp.bat, and an npm-installed claude is
// claude.cmd.
describe('spawnPlan', () => {
  it('runs a .bat on Windows through the shell, with every argument quoted', () => {
    expect(spawnPlan('C:\\tools\\wp.bat', ['i18n', 'C:\\out.pot'], 'win32')).toEqual({
      file: '"C:\\tools\\wp.bat" "i18n" "C:\\out.pot"',
      args: [],
      shell: true,
    })
  })
  // claude's --json-schema is inline JSON. Doubled quotes are what the
  // program's own argument parser reads as one quote, and they keep every
  // character of the value inside a quoted stretch, where cmd.exe does not
  // act on & | < >.
  it('doubles the quotes inside an argument for a .cmd', () => {
    expect(spawnPlan('C:\\npm\\claude.cmd', ['--json-schema', '{"a":"b & c"}'], 'win32')).toEqual({
      file: '"C:\\npm\\claude.cmd" "--json-schema" "{""a"":""b & c""}"',
      args: [],
      shell: true,
    })
  })
  // cmd.exe expands %NAME% inside quotes, so a path a person names freely
  // reaches it through a variable, which it expands once and never again.
  it('passes one argument through an environment variable when asked', () => {
    const plug = 'C:\\100%PATH%\\plug'
    expect(spawnPlan('C:\\tools\\wp.bat', ['make-pot', plug, 'out.pot'], 'win32', { name: 'POLYGLOTS_LINT_SRC', value: plug })).toEqual({
      file: '"C:\\tools\\wp.bat" "make-pot" "%POLYGLOTS_LINT_SRC%" "out.pot"',
      args: [],
      shell: true,
      env: { POLYGLOTS_LINT_SRC: plug },
    })
  })
  it('runs an .exe on Windows, and anything elsewhere, directly', () => {
    expect(spawnPlan('C:\\php\\php.exe', ['a b'], 'win32')).toEqual({ file: 'C:\\php\\php.exe', args: ['a b'], shell: false })
    expect(spawnPlan('/usr/local/bin/wp', ['a b'], 'darwin')).toEqual({ file: '/usr/local/bin/wp', args: ['a b'], shell: false })
  })
})
