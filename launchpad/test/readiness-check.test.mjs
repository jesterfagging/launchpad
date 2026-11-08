import test from 'node:test';
import assert from 'node:assert/strict';
import { assessReadiness } from '../scripts/check-readiness.mjs';

test('readiness does not pass free capacity as a 1000-user trading profile', () => {
  const result = assessReadiness({});
  assert.equal(result.configuration, 'needs_attention');
  assert.equal(result.targetOnlineUsers, 1000);
  assert.equal(result.capacity.rpcRequestsPerSecond, 8);
  assert.ok(result.checks.some(row => !row.passed));
  assert.match(result.limitation, /not provider entitlement/);
});

test('readiness validates a declared estimate without exposing credentials', () => {
  const env = { LAUNCHPAD_PUBLIC_URL: 'https://launch.example', LAUNCHPAD_PUBLIC_RPC_URL: 'https://rpc.example/private-secret', LAUNCHPAD_PUBLIC_JUPITER_KEY: 'routing-secret', LAUNCHPAD_PUBLIC_RPC_RPS: '40', LAUNCHPAD_PUBLIC_SEND_RPS: '4', LAUNCHPAD_PUBLIC_JUPITER_RPS: '8', LAUNCHPAD_MAX_USERS: '1000' };
  const light = assessReadiness(env, 30);
  assert.equal(light.configuration, 'meets_declared_estimate');
  assert.deepEqual(light.estimated, { rpcRequestsPerSecond: 30, sendRequestsPerSecond: 1, jupiterRequestsPerSecond: 2 });
  assert.equal(assessReadiness(env, 100).configuration, 'needs_attention');
  assert.doesNotMatch(JSON.stringify(light), /private-secret|routing-secret|rpc\.example/);
});

test('readiness rejects misleading origin, account capacity and trade targets', () => {
  const result = assessReadiness({ LAUNCHPAD_PUBLIC_URL: 'https://launch.example/path', LAUNCHPAD_MAX_USERS: '100' }, 30);
  assert.equal(result.checks.find(row => row.name === 'HTTPS origin').passed, false);
  assert.equal(result.checks.find(row => row.name === 'Account capacity').passed, false);
  for (const target of [0, -1, NaN, 1.5, 10001]) assert.throws(() => assessReadiness({}, target), /whole-number/);
});
