// Marks the package's bin files executable after tsc has written them.
//
// clean-dist empties dist/ before every build, so tsc writes cli.js as a new
// file with the default mode, 644. npm sets the bit itself when it installs
// or links a package, which is why a user's install never noticed, but a
// checkout linked once with npm link kept a symlink to that file and got
// "permission denied" after the next build, release builds included. Read
// from package.json rather than naming dist/cli.js, so a renamed or added
// bin is covered without anyone remembering this script exists.
import { chmod, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** chmod 755 every file the package.json in dir names under bin. */
export async function markBinsExecutable(dir) {
  const { bin } = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  const files = typeof bin === 'string' ? [bin] : Object.values(bin ?? {})
  for (const file of files) await chmod(join(dir, file), 0o755)
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await markBinsExecutable(join(dirname(fileURLToPath(import.meta.url)), '..'))
}
