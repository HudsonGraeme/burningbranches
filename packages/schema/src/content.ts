/**
 * Lockfiles and build output are not sections of a codebase, they are machine noise that
 * churns on its own schedule. Data files are deliberately kept: for plenty of repositories
 * the data genuinely is the project.
 */
const LOCKFILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'npm-shrinkwrap.json',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
  'flake.lock',
  'pubspec.lock',
  'gradle.lockfile',
  'packages.lock.json',
]);

const GENERATED_DIRS = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'Pods',
  'DerivedData',
  'obj',
  'Debug',
  'Release',
  '.vs',
  'cmake-build-debug',
  'cmake-build-release',
]);

/**
 * Directories whose name alone is ambiguous. `bin` and `target` hold real source in plenty
 * of projects, so they only count as build output when followed by a build profile.
 */
const GENERATED_PAIRS = new Set(['target/debug', 'target/release', 'bin/Debug', 'bin/Release']);

const GENERATED_FILE = /\.(min\.js|min\.css|map|pb\.go|pb\.cc|generated\.[a-z]+|pdb|o|obj|class|pyc)$/i;

export function isLockfile(path: string): boolean {
  return LOCKFILES.has(path.slice(path.lastIndexOf('/') + 1));
}

export function isGenerated(path: string): boolean {
  if (isLockfile(path)) return true;
  if (GENERATED_FILE.test(path)) return true;
  const parts = path.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (GENERATED_DIRS.has(parts[i]!)) return true;
    if (i + 1 < parts.length - 1 && GENERATED_PAIRS.has(`${parts[i]}/${parts[i + 1]}`)) return true;
  }
  return false;
}

/**
 * Git allows a path far longer than anything a person writes, and paths come from whoever
 * owns the repository. Capping keeps one repository from shipping a manifest padded with
 * kilobyte filenames.
 */
export const MAX_PATH_LENGTH = 260;

/**
 * Control characters and bidirectional overrides are stripped before any repository owned
 * string is shown. React already prevents markup from executing; this prevents a filename
 * from reordering itself on screen to read as something it is not.
 */
const UNSAFE_DISPLAY = new RegExp(
  [
    '[\\u0000-\\u001f\\u007f-\\u009f]', // C0 and C1 controls
    '[\\u200b-\\u200f]', // zero width and directional marks
    '[\\u202a-\\u202e]', // bidi embedding and override
    '[\\u2066-\\u2069]', // bidi isolates
    '[\\ufeff]', // zero width no-break space
  ].join('|'),
  'g',
);

export function displayText(value: string): string {
  return value.replace(UNSAFE_DISPLAY, '');
}

/**
 * No single file may claim more than this share of the world. A fifteen megabyte log in an
 * otherwise small repository would otherwise erase every other plot on the map.
 */
export const MAX_PLOT_SHARE = 0.06;

/**
 * Scales weights down until none exceeds the cap, redistributing the surplus across the
 * rest. The ordering of significance is preserved; only the extreme is pulled back in.
 */
export function capWeights(weights: number[], maxShare = MAX_PLOT_SHARE): number[] {
  if (weights.length <= 1) return weights.slice();
  const capped = weights.slice();

  for (let pass = 0; pass < 8; pass++) {
    const total = capped.reduce((sum, value) => sum + value, 0);
    if (total <= 0) break;
    const ceiling = total * maxShare;
    let changed = false;
    for (let i = 0; i < capped.length; i++) {
      if (capped[i]! > ceiling) {
        capped[i] = ceiling;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return capped;
}
