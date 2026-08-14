import { describe, it, expect, vi } from 'vitest';
import { buildOnboardSteps } from '../onboard-branch.js';

describe('onboard branch', () => {
  it('creates a profile, records the id, then requests the stream', async () => {
    const calls: string[] = [];
    const deps = {
      createProfile: vi.fn(async () => { calls.push('create'); return 'knew1'; }),
      recordProfileId: vi.fn(async (_id: string, pid: string) => { calls.push(`record:${pid}`); }),
      spawnStream: vi.fn(async () => { calls.push('spawn'); return 'https://t.example'; }),
      setReady: vi.fn(async (_id: string, url: string) => { calls.push(`ready:${url}`); }),
    };
    await buildOnboardSteps({ accountId: 'a1', country: 'GB', proxyJson: '{}' }, deps);
    expect(calls).toEqual(['create', 'record:knew1', 'spawn', 'ready:https://t.example']);
  });

  it('passes country and proxyJson through to createProfile', async () => {
    const createProfile = vi.fn(async () => 'p1');
    const deps = {
      createProfile,
      recordProfileId: vi.fn(async () => {}),
      spawnStream: vi.fn(async () => 'https://t.example'),
      setReady: vi.fn(async () => {}),
    };
    await buildOnboardSteps({ accountId: 'a1', country: 'AU', proxyJson: '{"proxy_host":"x"}' }, deps);
    expect(createProfile).toHaveBeenCalledWith('AU', '{"proxy_host":"x"}');
  });

  it('propagates a failure from any step without calling the next one', async () => {
    const calls: string[] = [];
    const deps = {
      createProfile: vi.fn(async () => { calls.push('create'); return 'knew1'; }),
      recordProfileId: vi.fn(async () => { calls.push('record'); throw new Error('db down'); }),
      spawnStream: vi.fn(async () => { calls.push('spawn'); return 'https://t.example'; }),
      setReady: vi.fn(async () => { calls.push('ready'); }),
    };
    await expect(
      buildOnboardSteps({ accountId: 'a1', country: 'GB', proxyJson: '{}' }, deps),
    ).rejects.toThrow('db down');
    expect(calls).toEqual(['create', 'record']);
  });
});
