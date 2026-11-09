import { describe, expect, it } from 'vitest';
import { httpUrl } from './sessions.js';

describe('httpUrl', () => {
  it('passes http(s) URLs and nothing else', () => {
    expect(httpUrl('https://github.com/o/r/pull/1')).toBe('https://github.com/o/r/pull/1');
    expect(httpUrl('http://localhost:3000/x')).toBe('http://localhost:3000/x');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'httpx://a', '128', 'http', null])
      expect(httpUrl(bad), String(bad)).toBeNull();
  });
});
