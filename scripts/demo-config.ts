/** The two fake machines the demo and the browser tests use. The keys only unlock the mocks. */
export const DEMO_APP_PORT = 3000;
export const DEMO_MOCK_PORTS = [18881, 18882] as const;

export const DEMO_MACHINES = [
  {
    name: 'Mock Mac Studio',
    profile: 'mac-mlx',
    apiKey: 'sk-unsloth-demo-mac-00000000000000000001',
    notes: 'Fake Unsloth: Apple M3 Ultra, 512 GB',
    color: '#e8a33d',
  },
  {
    name: 'Mock Linux RTX',
    profile: 'linux-cuda',
    apiKey: 'sk-unsloth-demo-linux-000000000000000002',
    notes: 'Fake Unsloth: NVIDIA RTX 5090, 32 GB',
    color: '#c6dbe0',
  },
] as const;
