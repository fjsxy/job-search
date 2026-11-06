import { parse } from 'parse5';
import { verifiedJobFacts } from './job-criteria.mjs';
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
const idLabel = /^(?:(?:职位|岗位|招聘)编号|Job ID)\s*[:：]\s*/i;
const otherSection = /^(?:加分项|优先条件|投递方式|薪资待遇|职位亮点|工作福利|公司介绍|关于我们|Apply\b|Preferred Qualifications\b)/i;

function flatten(root) {
  const lines = [];
  let line = '';
  const flush = tag => {
    const text = line.replace(/\s+/gu, ' ').trim();
    if (text) lines.push({ text, tag });
    line = '';
  };
  // 按块级节点保留原文行，忽略脚本、导航和模板中的字符串。
  const queue = [{ node: root }];
  while (queue.length) {
    const { node, end } = queue.pop();
    if (skipped.has(node.tagName)) continue;
    if (end || node.tagName === 'br') {
      flush(node.tagName);
      continue;
    }
    if (node.nodeName === '#text') line += node.value;
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
    scope, metadata: scope.slice(0, dutiesAt).map(line => line.text),
    duties: section(dutiesAt, requirementsAt, dutiesLabel),
    requirements: section(requirementsAt, end < 0 ? undefined : end, requirementsLabel),
  };
}

function includesOriginal(lines, items) {
  const observed = lines.map(comparable);
  return Array.isArray(items) && items.length > 0 && items.every(item =>
    typeof item === 'string' && comparable(item).length >= 4 && observed.some(line => line.includes(comparable(item))));
}

function findPosition(document, candidate) {
  const title = normalize(candidate.title);
  const nodes = [document];
  while (nodes.length) {
    const node = nodes.pop();
    if (skipped.has(node.tagName)) continue;
    if (heading.test(node.tagName) && normalize(flatten(node).map(line => line.text).join(' ')) === title) {
      // 从标题往上找能覆盖职责和要求的最小容器；同页其他岗位的内容不参与核对。
      let parent = node.parentNode;
      for (let depth = 0; parent && depth < 12; depth++, parent = parent.parentNode) {
        const lines = flatten(parent);
        const titleIndex = lines.findIndex(line => normalize(line.text) === title);
        if (titleIndex < 0) continue;
        const job = sections(lines, titleIndex);
        if (job && includesOriginal(job.duties, candidate.duties)
            && includesOriginal(job.requirements, candidate.requirements)) return job;
      }
    }
    for (const child of node.childNodes ?? []) nodes.push(child);
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

export function createOfficialVerifier(readPage = readPublicPage) {
  return async (candidate, webEvidence, signal) => {
    const url = publicUrl(candidate?.url)?.href;
    const title = typeof candidate?.title === 'string' && candidate.title.trim().slice(0, 200);
    if (!url || !title) return null;
    const webMatches = webEvidence.flatMap(event => (Array.isArray(event.results) ? event.results : [])
      .filter(result => publicUrl(result?.url)?.href === url).map(result => ({ action: event.action?.type, result })));
    if (!webMatches.length) return null;
    const source = { kind: 'official', url, jobKey: null };
    const lead = { title, source };
    if (!candidate.duties?.length || !candidate.requirements?.length) return { lead };
    const opened = webMatches.some(({ action, result }) =>
      (['open_page', 'find_in_page'].includes(action) || /^turn\d+view\d+$/.test(result.ref_id))
      && Number(/^Total lines:\s*(\d+)$/u.exec(result.snippet)?.[1]) > 1);
    if (!opened) return { lead };
    const html = await readPage(url, signal);
    if (!html) return { lead, restricted: true };

    const document = parse(html);
    const job = findPosition(document, candidate);
    if (!job) return { lead };
    const branding = (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? '').trim();
    const { employerEvidence, ...facts } = verifiedJobFacts(job.scope.slice(1).map(line => line.text), candidate);
    const cityEvidence = citedLine(candidate.city, facts.locations);
    const districtEvidence = citedLine(candidate.district, facts.locations);
    const salaryEvidence = citedLine(candidate.salaryQuote, facts.salaries);
    source.publisherEvidence = branding || null;
    source.jobKey = citedId(candidate.jobKey, url, job.metadata);
    source.verifiedAt = new Date().toISOString();
    source.locator = title;
    const { duties, requirements } = job;
    const jdLines = [title, ...job.metadata.slice(1), '岗位职责', ...duties, '任职要求', ...requirements];
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
