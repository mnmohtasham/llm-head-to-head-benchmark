import { describe, expect, it } from 'vitest';
import { hostKeys } from '../src/hosts';

describe('hostKeys', () => {
  it('counts loopback and host.docker.internal as this computer', async () => {
    const keys = await hostKeys([
      { id: 'loop', baseUrl: 'http://127.0.0.1:8888' },
      { id: 'name', baseUrl: 'http://localhost:1234' },
      { id: 'docker', baseUrl: 'http://host.docker.internal:8888' },
      { id: 'lan', baseUrl: 'http://192.0.2.10:8888' },
      { id: 'lan-too', baseUrl: 'http://192.0.2.10:1234' },
    ]);
    expect(keys.loop).toBe('this computer');
    expect(keys.name).toBe('this computer');
    expect(keys.docker).toBe('this computer');
    expect(keys.lan).toBe('192.0.2.10');
    expect(keys['lan-too']).toBe(keys.lan);
  });
});
