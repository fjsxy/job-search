import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicLookup } from '../src/public-page.mjs';

function resolveFixture(localAddresses, publicAddresses) {
  const lookup = createPublicLookup({
    localLookup: (_hostname, _options, callback) =>
      callback(null, localAddresses.map(address => ({ address, family: 4 }))),
    resolver: { resolve4: (_hostname, callback) => {
      assert.ok(publicAddresses, '普通公网或内网地址不应触发公网 DNS 回退');
      callback(null, publicAddresses);
    } },
  });
  return new Promise((resolve, reject) => {
    lookup('careers.example.org', {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

test('官网连接只使用已检查的公网 IP，代理占位地址仅触发公网 DNS 回退', async () => {
  assert.deepEqual(await resolveFixture(['198.18.236.218'], ['47.103.10.244']), {
    address: '47.103.10.244', family: 4,
  });
  assert.deepEqual(await resolveFixture(['47.103.10.244']), { address: '47.103.10.244', family: 4 });
  await assert.rejects(resolveFixture(['198.18.236.218'], ['127.0.0.1']), /不是公网地址/);
  await assert.rejects(resolveFixture(['198.18.236.218'], ['198.18.0.1']), /不是公网地址/);
  await assert.rejects(resolveFixture(['47.103.10.244', '192.168.2.1']), /不是公网地址/);
});
