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

const SCRIPT_REL_PATH = 'tools/scraper/discover_taxonomy.py';

class TaxonomyDiscoveryRun extends EventEmitter {
  readonly startedAt = new Date().toISOString();
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

  constructor() {
    super();
    this.donePromise = new Promise<TaxonomyResult>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
  }

  start(): void {
    const pythonPath = path.isAbsolute(config.pythonPath)
      ? config.pythonPath
      : path.resolve(config.projectRoot, config.pythonPath);
    const fullScript = path.resolve(config.projectRoot, SCRIPT_REL_PATH);

    console.log(`[Taxonomy] Running: ${pythonPath} ${fullScript}`);
    this.proc = spawn(pythonPath, [fullScript], {
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

let currentRun: TaxonomyDiscoveryRun | null = null;

/**
 * Returns the in-flight run if one is currently active, otherwise null.
 * Lets a second caller attach to an existing discovery rather than starting
 * a parallel Chromium instance.
 */
export function getActiveDiscovery(): TaxonomyDiscoveryRun | null {
  if (currentRun && !currentRun.finished()) return currentRun;
  return null;
}

/**
 * Start a new discovery, or return the in-flight one if it's still running.
 * Either way, the caller gets a handle they can subscribe to.
 */
export function startOrAttachDiscovery(): { run: TaxonomyDiscoveryRun; isNew: boolean } {
  const active = getActiveDiscovery();
  if (active) return { run: active, isNew: false };
  const run = new TaxonomyDiscoveryRun();
  currentRun = run;
  run.start();
  // Clean the slot once finished so the next caller starts a fresh run.
  run.done().catch(() => {}).finally(() => {
    if (currentRun === run) currentRun = null;
  });
  return { run, isNew: true };
}
