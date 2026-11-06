import { domainToUnicode } from 'node:url';
import { parse as parseDomain } from 'tldts';

const publisherLabel = /^(?:发布方|发布者|发布单位|信息发布方|来源|文章来源|信息来源|Posted by|Published by)\s*[:：]\s*/iu;
const reprint = /^(?:[【[]\s*)?(?:(?:本文|本帖|本岗位|本职位|以下信息)[^。；]{0,60})?(?:转载|转发|转自|搬运|代招|reposted\b|republished\b)/iu;
const boardBrand = /招聘网(?:站)?|招聘信息平台|求职平台|人才网|职位聚合|\bjob\s*(?:board|aggregator)\b/iu;
const genericBrand = /^(?:科技|信息|技术|网络|软件|信息科技|网络科技|招聘|官网|公司|首页|集团|人才|岗位|职位|社会招聘|加入我们|人才招聘|www|jobs?|careers?|recruit(?:ment)?|hr|work|hire|hiring|talent|zhaopin|home|official)$/iu;
const officialSubdomain = /^(?:www|talent|careers?|jobs?|join|recruit(?:ment)?|hr|zhaopin|official)$/iu;
const legalRegion = /^(?:中国|北京|上海|杭州|深圳|广州|南京|苏州|成都|武汉|宁波|合肥)(?:市)?\s*/u;
const brandSuffix = /^\s*(?:网络科技|信息科技|科技|网络|信息|技术)?(?:集团)?(?:控股)?(?:股份)?(?:有限责任公司|有限公司|公司)?\s*(?:招聘官网|公司官网|社会招聘|人才招聘|校园招聘|招聘|官网|加入我们|职位详情)?$/u;
const key = text => text.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
const tokens = value => key(value).split(/[^a-z0-9-]+/u).filter(Boolean).join(' ');
const attribute = (node, name) => node.attrs?.find(attr => attr.name === name)?.value;

function containsName(text, name, isTitle = false) {
  const normalized = key(name);
  if (!/[\p{L}\p{N}]/u.test(normalized)) return false;
  // 域名品牌须为独立标识。中文公司名称只允许明确的地域前缀及公司或招聘后缀。
  if (/[\p{Script=Han}]/u.test(normalized)) {
    const label = key(text);
    const parts = isTitle ? label.split(/\s*[|·:–—]\s*|\s+-\s+/u) : [label];
    return parts.some(part => [part, part.replace(legalRegion, '')].some(value =>
      value.startsWith(normalized) && brandSuffix.test(value.slice(normalized.length))));
  }
  const nameTokens = tokens(normalized);
  return Boolean(nameTokens) && ` ${tokens(text)} `.includes(` ${nameTokens} `);
}

function homeBrands(document, url) {
  const brands = new Set();
  const nodes = [{ node: document, homeLink: false }];
  while (nodes.length) {
    const { node, homeLink } = nodes.pop();
    if (['head', 'script', 'style', 'template', 'noscript'].includes(node.tagName)
      || attribute(node, 'hidden') !== undefined || attribute(node, 'aria-hidden') === 'true') continue;
    let isHome = homeLink;
    const href = node.tagName === 'a' && attribute(node, 'href');
    if (href) {
      const link = URL.parse(href, url);
      isHome = link?.origin === url.origin && /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/?)?$/i.test(link.pathname);
    }
    const alt = isHome && node.tagName === 'img' && attribute(node, 'alt')?.trim();
    if (alt && alt.length <= 80 && !genericBrand.test(alt)) brands.add(alt);
    for (const child of node.childNodes ?? []) nodes.push({ node: child, homeLink: isHome });
  }
  return [...brands];
}

export function officialPublisher({ document, link, branding, lines, recruiters }) {
  // 关键：正文能核对只证明网页含有 JD，仍须用原站的标识核对发布方。
  if (/(?:转载|转发|转自|搬运|代招|\brepost(?:ed)?\b|\brepublished\b)/iu.test(branding)
      || lines.some(line => reprint.test(line)) || boardBrand.test(branding)) return null;

  // 公共后缀可能有多段（如 com.cn）。共享托管的注册域或子域都不能证明公司归属。
  const domain = parseDomain(link.hostname, { allowPrivateDomains: true });
  if (!domain.domain || !domain.isIcann || domain.isPrivate) return null;
  // 通用子域可能提供自助发布，例如 sites.google.com；不能继承注册域的官网身份。
  if (domain.subdomain && !officialSubdomain.test(domain.subdomain)) return null;
  const brand = domainToUnicode(domain.domainWithoutSuffix);
  if (brand.length < (/^[\p{Script=Han}]+$/u.test(brand) ? 2 : 3) || genericBrand.test(brand) || !containsName(branding, brand, true)) return null;

  const declared = lines.filter(line => publisherLabel.test(line)).map(line => line.replace(publisherLabel, ''));
  const hiringNames = new Set(recruiters.map(key));
  const publisherNames = new Set(declared.map(key));
  if (hiringNames.size > 1 || publisherNames.size > 1) return null;
  const [recruiter] = hiringNames;
  const [publisher] = publisherNames;
  if ((recruiter && publisher && recruiter !== publisher) || boardBrand.test(publisher ?? '')) return null;
  const authority = recruiter ?? publisher;
  const logos = homeBrands(document, link);
  if (logos.some(logo => boardBrand.test(logo))) return null;

  // 关键：同页标题和站标可以互相抄录，品牌必须还与独立注册域匹配。
  if (authority) return containsName(authority, brand) ? domain.domain : null;
  const careers = /招聘|岗位|职位|加入我们|\b(?:career|careers|jobs?|vacanc(?:y|ies))\b/iu;
  return careers.test(branding) && logos.some(logo => containsName(logo, brand)) ? domain.domain : null;
}
