import { defaultTreeAdapter, parse } from 'parse5';
import { namedRecruiters, verifiedJobFacts } from './job-criteria.mjs';
import { officialPublisher } from './official-publisher.mjs';
import { belongsToSource } from './job-sources.mjs';
import { publicUrl, readPublicPage } from './public-page.mjs';

const skipped = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'nav']);
const lineBreak = new Set([
  'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li', 'main', 'ol', 'p', 'section',
  'table', 'td', 'th', 'tr', 'ul',
]);
const normalize = text => text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
const comparable = text => normalize(text).replace(/^(?:[•·]|\d+[.)、])\s*/u, '');
const heading = /^(?:h[1-6])$/;
const dutiesLabel = /^(?:(?:岗位|工作|职位)?职责|(?:Key )?Responsibilities?)(?=\s*[:：]|$)/i;
const requirementsLabel = /^(?:(?:职位|岗位|任职|招聘|工作)?要求|(?:Minimum |Job )?(?:Qualifications|Requirements))(?=\s*[:：]|$)/i;
const recruitingId = /^(?:招聘编号|招聘方(?:职位|岗位)编号)\s*[:：]\s*/i;
const officialLinkLabel = /^(?:公司)?(?:招聘官网职位|官网职位|官网原文|官方职位链接)(?:\s*[:：]|$)/u;
const idLabel = /^(?:(?:职位|岗位|招聘)编号|Job ID)\s*[:：]\s*/i;
const otherSection = /^(?:加分项|优先条件|投递方式|薪资待遇|职位亮点|工作福利|公司介绍|关于我们|Apply\b|Preferred Qualifications\b)/i;

function hidden(node) {
  return node.attrs?.some(({ name, value }) => name === 'hidden' || (name === 'aria-hidden' && value === 'true'));
}

function parsePublicHtml(html) {
  // 关键：HTML 解析也会遍历开放元素栈，必须在构建 DOM 时限制深度。
  const exceeded = new Error('公开页面结构超限');
  let depth = 0;
  let elements = 0;
  try {
    return parse(html, { treeAdapter: {
      ...defaultTreeAdapter,
      createElement(...args) {
        if (++elements > 50_000) throw exceeded;
        return defaultTreeAdapter.createElement(...args);
      },
      onItemPush() { if (++depth > 256) throw exceeded; },
      onItemPop() { depth--; },
    } });
  } catch (error) {
    if (error === exceeded) return null;
    throw error;
  }
}

function spend(budget, node) {
  // 文本也计入预算，避免反复归一化同一段很长的文本。
  budget.remaining -= node.nodeName === '#text' ? 1 + Math.ceil(node.value.length / 64) : 1;
  return budget.remaining >= 0;
}

function flatten(root, budget) {
  const lines = [];
  let line = '';
  let links = [];
  const flush = tag => {
    const text = line.replace(/\s+/gu, ' ').trim();
    if (text) lines.push({ text, tag, links });
    line = '';
    links = [];
  };
  // 按块级节点保留原文行，忽略脚本、导航和模板中的字符串。
  const queue = [{ node: root }];
  while (queue.length) {
    const { node, end } = queue.pop();
    if (!spend(budget, node)) return null;
    if (skipped.has(node.tagName) || hidden(node)) continue;
    if (end || node.tagName === 'br') {
      flush(node.tagName);
      continue;
    }
    if (node.nodeName === '#text') line += node.value;
    if (node.tagName === 'a') {
      const href = node.attrs.find(attr => attr.name === 'href')?.value;
      if (href) links.push(href);
    }
    if (lineBreak.has(node.tagName)) {
      flush();
      queue.push({ node, end: true });
    }
    for (const child of [...(node.childNodes ?? [])].reverse()) queue.push({ node: child });
  }
  flush();
  return lines;
}

function sections(lines, titleIndex) {
  const tag = lines[titleIndex].tag;
  const first = lines.slice(titleIndex + 1).findIndex(line => heading.test(line.tag) && heading.test(tag) && line.tag <= tag);
  const scope = lines.slice(titleIndex, first < 0 ? undefined : titleIndex + first + 1);
  const dutiesAt = scope.findIndex(({ text }) => dutiesLabel.test(text));
  const requirementsAt = scope.findIndex(({ text }) => requirementsLabel.test(text));
  if (dutiesAt < 1 || requirementsAt <= dutiesAt) return null;
  // 标题与正文之间的其他标题可能属于另一岗位，无法确定归属时保留为待核验。
  if (scope.slice(1, dutiesAt).some(line => heading.test(line.tag))
      || scope.slice(dutiesAt + 1, requirementsAt).some(line => heading.test(line.tag))) return null;
  const end = scope.findIndex(({ tag, text }, index) => index > requirementsAt && (heading.test(tag) || otherSection.test(text)));
  const section = (from, to, label) => {
    const headerText = scope[from].text.replace(label, '').replace(/^\s*[:：]\s*/u, '').trim();
    return [headerText, ...scope.slice(from + 1, to).map(line => line.text)].filter(Boolean);
  };
  return {
    scope, metadata: scope.slice(0, dutiesAt),
    duties: section(dutiesAt, requirementsAt, dutiesLabel),
    requirements: section(requirementsAt, end < 0 ? undefined : end, requirementsLabel),
  };
}

function includesOriginal(lines, items) {
  const observed = lines.map(comparable);
  return Array.isArray(items) && items.length > 0 && items.every(item =>
    typeof item === 'string' && comparable(item).length >= 4 && observed.some(line => line.includes(comparable(item))));
}

function findPosition(document, candidate, budget) {
  const title = normalize(candidate.title);
  const nodes = [document];
  const headings = [];
  while (nodes.length) {
    const node = nodes.pop();
    if (!spend(budget, node)) return null;
    if (skipped.has(node.tagName) || hidden(node)) continue;
    if (heading.test(node.tagName)) {
      const lines = flatten(node, budget);
      if (!lines) return null;
      if (normalize(lines.map(line => line.text).join(' ')) === title) headings.push(node);
    }
    for (const child of node.childNodes ?? []) nodes.push(child);
  }
  const ambiguousTitle = headings.length > 1;
  const visited = new Set();
  // 共享祖先只扫描一次。不同祖先深度重叠时也有总扫描预算，超限保留待核验。
  for (const node of headings) {
    // 从标题往上找能覆盖职责和要求的最小容器；同页同名职位须有独立的招聘编号。
    let parent = node.parentNode;
    for (let depth = 0; parent && depth < 12; depth++, parent = parent.parentNode) {
      if (visited.has(parent)) continue;
      visited.add(parent);
      const lines = flatten(parent, budget);
      if (!lines) return null;
      const matchingTitles = lines.flatMap((line, index) => normalize(line.text) === title ? [index] : []);
      if (matchingTitles.length !== 1) continue;
      const job = sections(lines, matchingTitles[0]);
      if (ambiguousTitle && !job?.metadata.some(({ text }) =>
        idLabel.test(text) && text.replace(idLabel, '').trim() === candidate.jobKey)) continue;
      if (job && includesOriginal(job.duties, candidate.duties)
          && includesOriginal(job.requirements, candidate.requirements)) return { ...job, ambiguousTitle };
    }
  }
  return null;
}

function citedLine(value, lines) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) return null;
  return lines.find(line => normalize(line).includes(normalize(value))) ?? null;
}

function citedId(value, url, lines) {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,100}$/i.test(value)) return null;
  const source = new URL(url);
  if (source.pathname.split('/').includes(value) || [...source.searchParams.values()].includes(value)) return value;
  return lines.some(line => idLabel.test(line) && line.replace(idLabel, '') === value) ? value : null;
}

function isAccessWall(branding, lines) {
  // 只识别阻止读取职位的提示。投递进度、账号等功能的登录说明不算验证墙。
  const wall = /^(?:please[\s,:;.!-]+)?(?:请(?:先)?完成(?:安全|人机)验证|安全验证|访问受限|访问异常|验证后继续|无权访问|access denied\b|verify (?:that )?you(?: are|['’]re) human\b|checking your browser\b)/iu;
  const jdLogin = /^(?:请(?:先)?登录(?:后|以)?|登录后(?:方可|才能|才可)?|(?:您|你)?(?:需要|必须|须)(?:先)?登录(?:后)?(?:方可|才能|才可))[\s,;:。.!-]*(?:再)?(?:查看|访问|阅读)\s*(?:完整|全部)?(?:该|本)?(?:职位|岗位|招聘)(?:详情|描述|信息|正文|$)/u;
  const englishLogin = /^(?:please[\s,:;.!-]+)?(?:log[\s-]?in|sign[\s-]?in)[\s,;:.!-]+(?:to\s+)?(?:view|read|access|see)\s+(?:the\s+|this\s+)?(?:full\s+)?(?:job|position|vacancy)(?:\s+(?:details?|description|posting)\b|[.!]?$)/iu;
  const title = normalize(branding);
  const loginPage = /^(?:(?:请先)?登录|log in|login|sign in)\s*(?:$|[|·–—-])/iu.test(title);
  const browserChallenge = /^just a moment\b/iu.test(title)
    && lines.some(line => /^(?:please )?enable javascript and cookies to continue\b/iu.test(line));
  return !lines.length || loginPage || browserChallenge
    || [title, ...lines].some(line => {
      const text = normalize(line);
      return wall.test(text) || jdLogin.test(text) || englishLogin.test(text);
    });
}

export function createOfficialVerifier(readPage = readPublicPage) {
  return async (candidate, webEvidence, signal, kind) => {
    const link = publicUrl(candidate?.url);
    const url = link?.href;
    const title = typeof candidate?.title === 'string' && candidate.title.trim().slice(0, 200);
    if (!url || !title || !belongsToSource(kind, link)) return null;
    const webMatches = webEvidence.flatMap(event => (Array.isArray(event.results) ? event.results : [])
      .filter(result => publicUrl(result?.url)?.href === url).map(result => ({ action: event.action?.type, result })));
    if (!webMatches.length) return null;
    const source = { kind, url, jobKey: null };
    const lead = { title, source };
    const hasOriginal = candidate.duties?.length && candidate.requirements?.length;
    const opened = webMatches.some(({ action, result }) =>
      (['open_page', 'find_in_page'].includes(action) || /^turn\d+view\d+$/.test(result.ref_id))
      && Number(/^Total lines:\s*(\d+)$/u.exec(result.snippet)?.[1]) > 1);
    const html = await readPage(url, signal);
    if (!html) return { lead, restricted: opened || kind !== 'official' };

    const document = parsePublicHtml(html);
    if (!document) return { lead };
    const head = document.childNodes.find(node => node.tagName === 'html')?.childNodes.find(node => node.tagName === 'head');
    const branding = head?.childNodes.find(node => node.tagName === 'title')?.childNodes[0]?.value?.trim() ?? '';
    const budget = { remaining: 200_000 };
    const wholePage = flatten(document, budget);
    if (!wholePage) return { lead };
    const visible = wholePage.map(line => line.text);
    const job = opened && hasOriginal && findPosition(document, candidate, budget);
    if (!job) return { lead, restricted: isAccessWall(branding, visible) };

    const metadata = job.metadata.map(line => line.text);
    const recruiters = namedRecruiters(metadata);
    const { employerEvidence, ...facts } = verifiedJobFacts(job.scope.slice(1).map(line => line.text), candidate);
    const publisher = kind === 'official'
      ? officialPublisher({ document, link, branding, lines: visible, recruiters })
      : null;
    if (kind === 'official' && !publisher) return { lead };
    source.officialPublisherDomain = publisher ?? undefined;
    source.publisherRecruiter = recruiters.length === 1 ? recruiters[0] : null;
    const cityEvidence = citedLine(candidate.city, facts.locations);
    const districtEvidence = citedLine(candidate.district, facts.locations);
    const salaryEvidence = citedLine(candidate.salaryQuote, facts.salaries);
    source.publisherEvidence = branding || null;
    source.jobKey = citedId(candidate.jobKey, url, metadata);
    source.ambiguousTitle = job.ambiguousTitle;
    const idLabelForSource = kind === 'official' ? idLabel : recruitingId;
    const publisherIds = [...new Set(metadata.filter(line => idLabelForSource.test(line))
      .map(line => line.replace(idLabelForSource, '').trim())
      .filter(id => /^[a-z0-9_-]{1,100}$/i.test(id)))];
    source.publisherJobKey = publisherIds.length === 1 ? publisherIds[0] : null;
    // 只有范围明确的官网详情可用于跨源合并。招聘帖的引用必须位于该岗位的正文区。
    source.officialPosition = kind === 'official' && wholePage.filter(line => dutiesLabel.test(line.text)).length === 1
      && wholePage.filter(line => requirementsLabel.test(line.text)).length === 1
      && /\/(?:positions?|job[_-]?detail|jobs?|vacanc(?:y|ies)|careers?|recruit(?:ment)?)\/[^/]+/i.test(link.pathname);
    const officialLinks = [...new Set(job.metadata.filter(line => officialLinkLabel.test(line.text))
      .flatMap(line => line.links).map(publicUrl)
      .filter(link => link && belongsToSource('official', link)).map(link => link.href))];
    source.citedOfficialUrl = kind !== 'official' && officialLinks.length === 1 ? officialLinks[0] : null;
    source.verifiedAt = new Date().toISOString();
    source.locator = title;
    const { duties, requirements } = job;
    const jdLines = [title, ...metadata.slice(1), '岗位职责', ...duties, '任职要求', ...requirements];
    for (const line of [employerEvidence, ...facts.locations, ...facts.salaries]) {
      if (line && !jdLines.includes(line)) jdLines.push(line);
    }
    const jd = jdLines.join('\n');
    return { verified: {
      title, employer: employerEvidence ? facts.employers[0] : null,
      city: cityEvidence ? candidate.city.trim() : null,
      district: districtEvidence ? candidate.district.trim() : null,
      salaryQuote: salaryEvidence, employerEvidence, cityEvidence, districtEvidence,
      duties, requirements, jd, source, facts,
    } };
  };
}
