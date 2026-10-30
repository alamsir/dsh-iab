/**
 * dsh-iab — Chromium process management.
 *
 * **Isolation contract (never violates the user's own browser):**
 * - The plugin only ever launches *its own* process with its *own* profile
 *   directory under DSH home. It never attaches to a running Chrome/Edge, never
 *   opens a debugging port on the user's browser, and never kills a process it
 *   did not spawn.
 * - The profile lives at `<dshHome>/dsh-iab/chrome-profile`, and any configured
 *   path that resolves inside a real browser's user-data directory is refused.
 * - The window is headless by default. The user still sees and drives the page
 *   through the plugin's panel (a CDP screencast mirror), so no extra window
 *   appears on their desktop and nothing steals focus.
 * - A *dedicated* Chromium (Playwright's bundled build) is preferred over the
 *   user's system Chrome. System Chrome is used only as a last resort, and even
 *   then with the private profile above.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WINDOWS_BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const MAC_BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

const LINUX_BROWSERS = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

/** Real browser profile roots we must never write into. */
function foreignProfileRoots() {
  const roots = [
    join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data'),
    join(process.env.APPDATA ?? '', 'Google', 'Chrome', 'User Data'),
    join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
    join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
    join(homedir(), '.config', 'google-chrome'),
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'User Data'),
    join(homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
  ];
  return roots.filter((p) => p && p.length > sep.length);
}

const normalize = (p) => resolve(p).replace(/[\\/]+$/, '').toLowerCase();

/**
 * Whether a path is (or is inside) a real browser profile. Launching there would
 * share the user's cookies and risk corrupting their session — refuse it.
 */
export function isForeignProfile(path) {
  const target = normalize(path);
  return foreignProfileRoots().some((root) => {
    const normalized = normalize(root);
    return target === normalized || target.startsWith(normalized + sep);
  });
}

/** Dedicated Chromium builds already on the box (Playwright cache). Preferred. */
function bundledCandidates() {
  const roots = [
    process.env.DSH_IAB_BROWSERS,
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(process.env.LOCALAPPDATA ?? '', 'ms-playwright'),
    join(homedir(), 'AppData', 'Local', 'ms-playwright'),
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
  ].filter(Boolean);
  const out = [];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    try {
      for (const entry of readdirSync(root)) {
        if (!/^chromium(-\d+)?$/.test(entry)) continue;
        out.push(
          join(root, entry, 'chrome-win64', 'chrome.exe'),
          join(root, entry, 'chrome-win', 'chrome.exe'),
          join(root, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
          join(root, entry, 'chrome-linux', 'chrome'),
        );
      }
    } catch {
      /* unreadable cache dir */
    }
  }
  return out;
}

/**
 * Locate a Chromium binary.
 *
 * @returns {{ path: string, dedicated: boolean } | null}
 *   `dedicated` marks a private build (Playwright/Chromium) rather than the
 *   user's installed Chrome, which the caller may treat more strictly.
 */
export function findBrowser(configured) {
  const explicit = [configured, process.env.DSH_IAB_CHROME, process.env.CHROME_PATH]
    .filter((p) => typeof p === 'string' && p.length > 0);
  for (const candidate of explicit) {
    if (existsSync(candidate)) return { path: candidate, dedicated: false };
  }
  for (const candidate of bundledCandidates()) {
    if (existsSync(candidate)) return { path: candidate, dedicated: true };
  }
  const system = process.platform === 'win32' ? WINDOWS_BROWSERS
    : process.platform === 'darwin' ? MAC_BROWSERS : LINUX_BROWSERS;
  for (const candidate of system) {
    if (existsSync(candidate)) return { path: candidate, dedicated: false };
  }
  return null;
}

/** Default profile directory: inside DSH home so it survives plugin reinstalls. */
export function defaultProfileDir(dshHome) {
  return join(dshHome ?? join(homedir(), '.dsh'), 'dsh-iab', 'chrome-profile');
}

export class BrowserHost {
  #binary;
  #dedicated;
  #profileDir;
  #child = null;
  #port = null;
  #headed;
  #starting = null;
  #logger;
  #extraArgs;

  constructor({ binary, dedicated = false, profileDir, headed = false, logger, extraArgs = [] }) {
    this.#binary = binary;
    this.#dedicated = dedicated;
    this.#profileDir = profileDir;
    this.#headed = headed;
    this.#logger = logger;
    this.#extraArgs = extraArgs;
    if (profileDir && isForeignProfile(profileDir)) {
      throw new Error(
        `dsh-iab refuses to use "${profileDir}": it is a real browser profile. `
        + 'The plugin always runs an isolated profile so it cannot disturb your own browser.',
      );
    }
  }

  get profileDir() {
    return this.#profileDir;
  }

  get dedicated() {
    return this.#dedicated;
  }

  get headed() {
    return this.#headed;
  }

  /** The DevTools HTTP endpoint once the browser is up. */
  get endpoint() {
    return this.#port === null ? null : `http://127.0.0.1:${this.#port}`;
  }

  get running() {
    return this.#child !== null && this.#port !== null;
  }

  /**
   * Read the port file. Chromium writes it non-atomically, so a read can land
   * mid-write (`EBUSY` on Windows, a truncated body elsewhere) — retry instead
   * of failing the whole startup.
   */
  #readPort() {
    try {
      const [port] = readFileSync(join(this.#profileDir, 'DevToolsActivePort'), 'utf8').split('\n');
      const value = Number(port);
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * Start Chromium, or adopt the instance already running on this profile.
   * Concurrent callers share one startup attempt.
   */
  async ensureStarted() {
    if (this.running) return this.endpoint;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start() {
    if (!this.#binary || !existsSync(this.#binary)) {
      throw new Error(
        'dsh-iab found no Chromium. Install Google Chrome/Edge, or point DSH_IAB_CHROME at a '
        + 'chromium.exe. The plugin never reuses your everyday browser.',
      );
    }
    mkdirSync(this.#profileDir, { recursive: true });
    try {
      if (existsSync(join(this.#profileDir, 'DevToolsActivePort'))) {
        rmSync(join(this.#profileDir, 'DevToolsActivePort'), { force: true });
      }
    } catch {
      /* a locked stale file is retried by the wait loop below */
    }

    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${this.#profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--disable-background-networking',
      '--disable-sync',
      '--password-store=basic',
      '--use-mock-keychain',
      ...(this.#headed
        ? ['--window-size=1440,940', '--window-position=80,40']
        : ['--headless=new', '--disable-gpu', '--hide-scrollbars']),
      ...this.#extraArgs,
      'about:blank',
    ];

    this.#logger?.info?.(`dsh-iab: launching ${this.#binary} (${this.#headed ? 'headed' : 'headless'})`);
    // `stdio: 'ignore'` keeps the browser off our pipes: CDP attaches over TCP,
    // and an inherited pipe would die with the Host process.
    this.#child = spawn(this.#binary, args, { detached: false, stdio: 'ignore' });
    const child = this.#child;
    child.on('exit', (code) => {
      this.#logger?.info?.(`dsh-iab: chromium exited (${code})`);
      if (this.#child === child) {
        this.#child = null;
        this.#port = null;
      }
    });
    child.on('error', (error) => {
      this.#logger?.error?.(`dsh-iab: chromium failed to start: ${error?.message ?? error}`);
      if (this.#child === child) {
        this.#child = null;
        this.#port = null;
      }
    });

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const port = this.#readPort();
      if (port !== null) {
        this.#port = port;
        this.#logger?.info?.(`dsh-iab: chromium listening on ${port}`);
        return this.endpoint;
      }
      if (this.#child === null) throw new Error('Chromium exited before exposing a DevTools port.');
      await sleep(150);
    }
    this.#child = null;
    throw new Error('Timed out waiting for Chromium DevToolsActivePort.');
  }

  /**
   * Close the browser through CDP `Browser.close` so Chromium flushes cookies
   * and localStorage to the profile; killing the process risks an unclean
   * profile that Chromium may reset on the next launch. Only ever affects the
   * child we spawned.
   */
  async stop(connection) {
    try {
      await connection?.send('Browser.close');
    } catch {
      /* the socket usually dies during shutdown */
    }
    for (let i = 0; i < 60 && this.#child !== null; i += 1) await sleep(100);
    if (this.#child !== null) {
      try {
        this.#child.kill();
      } catch {
        /* already gone */
      }
    }
    this.#child = null;
    this.#port = null;
  }
}

/** Scratch dir used for one-shot browsing that must not keep any state. */
export function ephemeralProfileDir() {
  return join(tmpdir(), `dsh-iab-${process.pid}-${Date.now().toString(36)}`);
}
