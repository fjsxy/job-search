import { lookup, Resolver } from 'node:dns';
import { get } from 'node:https';
import { BlockList, isIP } from 'node:net';

const MAX_BYTES = 2 * 1024 * 1024;
const privateRanges = new BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
]) privateRanges.addSubnet(address, bits);

const proxyRanges = new BlockList();
proxyRanges.addSubnet('198.18.0.0', 15);
const publicResolver = new Resolver({ timeout: 2000, tries: 1 });
publicResolver.setServers(['1.1.1.1', '8.8.8.8']);

export function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
        || !url.hostname.includes('.') || isIP(url.hostname)
        || /(?:^|\.)(?:localhost|local|internal|test|invalid|onion)\.?$/i.test(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

// 关键：TLS 实际连接使用这次 DNS 检查的 IPv4 地址，不做第二次查询。
export function createPublicLookup({ localLookup = lookup, resolver = publicResolver } = {}) {
  return (hostname, _options, callback) => {
    const check = (addresses) => {
      if (!addresses.length || addresses.some(address => privateRanges.check(address))) {
        return callback(new Error('来源不是公网地址'));
      }
      callback(null, addresses[0], 4);
    };
    localLookup(hostname, { family: 4, all: true }, (error, results) => {
      if (error) return callback(error);
      const addresses = results.map(({ address }) => address);
      if (addresses.length && addresses.every(address => proxyRanges.check(address))) {
        // 部分本机代理用 198.18/15 返回占位地址。只在这种情况下改查公网 DNS，
        // 验证并连接实际公网地址，永远不向占位网段发请求。
        resolver.resolve4(hostname, (dnsError, publicAddresses) =>
          dnsError ? callback(dnsError) : check(publicAddresses));
        return;
      }
      check(addresses);
    });
  };
}

const lookupPublic = createPublicLookup();

export async function readPublicPage(value, signal) {
  const url = publicUrl(value);
  if (!url) return null;
  const timeout = AbortSignal.timeout(8000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await new Promise((resolve, reject) => {
      const request = get(url, {
        signal: deadline, agent: false, family: 4, autoSelectFamily: false, lookup: lookupPublic,
        rejectUnauthorized: true,
        headers: { Accept: 'text/html', 'Accept-Encoding': 'identity' },
      }, resolve);
      request.on('error', reject);
    });
    // 不跟随重定向，不执行网页代码或加载任何子资源。
    if (response.statusCode !== 200 || !/^text\/html\b/i.test(response.headers['content-type'] ?? '')
        || !['identity', undefined].includes(response.headers['content-encoding'])
        || Number(response.headers['content-length']) > MAX_BYTES) {
      response.destroy();
      return null;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > MAX_BYTES) return null;
      chunks.push(chunk);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return null;
  }
}
