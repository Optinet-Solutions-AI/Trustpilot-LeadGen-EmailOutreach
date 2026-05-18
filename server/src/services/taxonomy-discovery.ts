/**
 * Taxonomy discovery orchestrator — spawns tools/scraper/discover_taxonomy.py
 * and streams its PROGRESS:taxonomy_* lines back to callers.
 *
 * Single-flight: only one discovery runs at a time. Concurrent callers attach
 * to the same in-flight stream and receive the same events.
 *
 * Mirrors the spawn pattern in scrape-runner.ts so the Python environment,
 * encoding, and process-group semantics behave identically.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { config } from '../config.js';

export interface TaxonomyProgressEvent {
  stage: string;
  detail: string;
  timestamp: string;
}

export interface TaxonomyResult {
  categories: number;
  countries: number;
}

// Trustpilot has a legacy single-purpose script. Every other platform
// flows through the unified plugin CLI which takes --platform + --action.
const TRUSTPILOT_SCRIPT = 'tools/scraper/discover_taxonomy.py';
const UNIFIED_PLUGIN_SCRIPT = 'tools/scraper/run.py';

class TaxonomyDiscoveryRun extends EventEmitter {
  readonly startedAt = new Date().toISOString();
  readonly platform: string;
  private proc: ChildProcess | null = null;
  private buffer = '';
  private stderr = '';
  private resolved = false;
  private result: TaxonomyResult | null = null;
  private error: Error | null = null;
  readonly events: TaxonomyProgressEvent[] = [];
  private donePromise: Promise<TaxonomyResult>;
  private resolveDone!: (r: TaxonomyResult) => void;
  private rejectDone!: (e: Error) => void;

  constructor(platform: string) {
    super();
    this.platform = platform;
    this.donePromise = new Promise<TaxonomyResult>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
  }

  start(): void {
    const pythonPath = path.isAbsolute(config.pythonPath)
      ? config.pythonPath
      : path.resolve(config.projectRoot, config.pythonPath);

    // Trustpilot still has its standalone script; everything else
    // (TripAdvisor, Yelp, future plugins) goes through run.py which
    // calls platform.discover_taxonomy() under the hood.
    let scriptArgs: string[];
    if (this.platform === 'trustpilot') {
      scriptArgs = [path.resolve(config.projectRoot, TRUSTPILOT_SCRIPT)];
    } else {
      scriptArgs = [
        path.resolve(config.projectRoot, UNIFIED_PLUGIN_SCRIPT),
        '--platform', this.platform,
        '--action', 'discover-taxonomy',
      ];
    }

    console.log(`[Taxonomy:${this.platform}] Running: ${pythonPath} ${scriptArgs.join(' ')}`);
    this.proc = spawn(pythonPath, scriptArgs, {
      cwd: config.projectRoot,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        this.handleLine(line);
      }
    });
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf-8');
    });
    this.proc.on('error', (err) => this.finish(err));
    this.proc.on('close', (code) => {
      if (this.resolved) return;
      if (code === 0 && this.result) {
        this.finish(null);
      } else {
        const msg = this.error?.message
          || `Taxonomy discovery exited with code ${code}${this.stderr ? `: ${this.stderr.trim().slice(-500)}` : ''}`;
        this.finish(new Error(msg));
      }
    });
  }

  private handleLine(line: string): void {
    if (!line) return;
    // Mirrors PROGRESS:taxonomy_{stage}:{detail} emitted by the Python tool.
    const match = line.match(/^PROGRESS:taxonomy_([^:]+):(.*)$/);
    if (!match) {
      // Non-progress stdout: useful for debugging but not streamed to clients.
      console.log(`[Taxonomy] ${line}`);
      return;
    }
    const stage = match[1];
    const detail = match[2];
    const event: TaxonomyProgressEvent = {
      stage,
      detail,
      timestamp: new Date().toISOString(),
    };
    this.events.push(event);
    this.emit('progress', event);

    if (stage === 'done') {
      const [catsRaw, ctysRaw] = detail.split('|');
      this.result = {
        categories: parseInt(catsRaw, 10) || 0,
        countries: parseInt(ctysRaw, 10) || 0,
      };
    } else if (stage === 'error') {
      this.error = new Error(detail || 'Discovery reported an error');
    }
  }

  private finish(err: Error | null): void {
    if (this.resolved) return;
    this.resolved = true;
    if (err) {
      this.emit('error', err);
      this.rejectDone(err);
    } else if (this.result) {
      this.emit('done', this.result);
      this.resolveDone(this.result);
    } else {
      const fallback = new Error('Taxonomy discovery finished without reporting a result');
      this.emit('error', fallback);
      this.rejectDone(fallback);
    }
  }

  done(): Promise<TaxonomyResult> {
    return this.donePromise;
  }

  finished(): boolean {
    return this.resolved;
  }
}

// Per-platform single-flight. A Trustpilot refresh and a Yelp refresh can
// run concurrently — they hit different services and write to different
// keys in platform_categories. Within a single platform, parallel callers
// attach to the same run.
const runsByPlatform = new Map<string, TaxonomyDiscoveryRun>();

/**
 * Returns the in-flight run for `platform` if one is currently active,
 * otherwise null. Lets a second caller attach to an existing discovery
 * rather than starting a parallel subprocess.
 */
export function getActiveDiscovery(platform: string): TaxonomyDiscoveryRun | null {
  const run = runsByPlatform.get(platform);
  if (run && !run.finished()) return run;
  return null;
}

/**
 * Return any in-flight discovery, regardless of platform — used by the
 * `/taxonomy/status` peek endpoint which doesn't take a platform arg.
 */
export function getAnyActiveDiscovery(): TaxonomyDiscoveryRun | null {
  for (const run of runsByPlatform.values()) {
    if (!run.finished()) return run;
  }
  return null;
}

/**
 * Start a new discovery for `platform`, or return the in-flight one if
 * it's still running. Either way, the caller gets a handle they can
 * subscribe to.
 */
export function startOrAttachDiscovery(platform: string): { run: TaxonomyDiscoveryRun; isNew: boolean } {
  const active = getActiveDiscovery(platform);
  if (active) return { run: active, isNew: false };
  const run = new TaxonomyDiscoveryRun(platform);
  runsByPlatform.set(platform, run);
  run.start();
  // Clean the slot once finished so the next caller starts a fresh run.
  run.done().catch(() => {}).finally(() => {
    if (runsByPlatform.get(platform) === run) runsByPlatform.delete(platform);
  });
  return { run, isNew: true };
}
