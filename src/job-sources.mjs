import { verifiedJobFacts } from './job-criteria.mjs';
import { publicUrl } from './public-page.mjs';

// 来源 ID 会持久化在搜索结果和职位记录中，标签供浏览器页面使用。
export const sourceLabels = Object.freeze({
  official: '公司社招官网', maimai: '脉脉', boss: 'BOSS 直聘',
});

const domains = { maimai: 'maimai.cn', boss: 'zhipin.com' };

function onDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

export function belongsToSource(kind, url) {
  const host = url.hostname.replace(/\.$/, '');
  // 官网 URL 在此只做预筛，归属须由原站内容另行核对。
  if (kind === 'official') return !Object.values(domains).some(domain => onDomain(host, domain));
  if (!onDomain(host, domains[kind])) return false;
  if (kind === 'maimai') {
    return (url.pathname === '/jobs/job_detail' && (url.searchParams.get('ejid') || url.searchParams.get('jid')))
      || (url.pathname === '/article/detail' && (url.searchParams.get('fid') || url.searchParams.get('efid')));
  }
  return /^\/job_detail\/[^/]+\.html$/.test(url.pathname);
}

export function sourceQuery(kind) {
  return domains[kind] ? `site:${domains[kind]}` : null;
}

export function hasSourceSearch(kind, evidence) {
  return evidence.some(({ action }) => action?.type === 'search'
    && (!domains[kind] || [action.query, ...(action.queries ?? [])].some(query => {
      const sites = String(query ?? '').toLowerCase().matchAll(/(?:^|\s)site:([a-z0-9.-]+)(?=\s|$)/g);
      return [...sites].some(([, host]) => onDomain(host, domains[kind]));
    })));
}

function comparisonUrl(value, kind) {
  const url = new URL(value);
  url.hostname = url.hostname.replace(/\.$/, '');
  // 只归一化已知的跟踪字段，未知参数、脉脉的 ejid/jid 和锚点可能标识职位。
  for (const name of [...url.searchParams.keys()]) {
    if (/^utm_(?:source|medium|campaign|term|content|id)$/i.test(name)
        || (kind === 'maimai' && ['fr', '_share_channel'].includes(name))) url.searchParams.delete(name);
  }
  if (kind === 'boss' && ['m.zhipin.com', 'www.zhipin.com'].includes(url.hostname)) {
    url.hostname = 'www.zhipin.com';
  }
  url.searchParams.sort();
  return url.href;
}

function employerKey(value) {
  return value?.normalize('NFKC').trim();
}

function officialIdentity(employer, value) {
  return employer && value ? JSON.stringify([employer, comparisonUrl(value, 'official')]) : null;
}

export function manualIdentity(jd) {
  // 仅从粘贴内容的职位元数据读取明确标记。职责文本、标题和正文相似度不能建立同一性。
  const header = jd.split(/\r?\n/u, 24).slice(1)
    .map(line => line.normalize('NFKC').trim());
  const section = header.findIndex(line => /^(?:岗位|工作|职位)?职责(?:\s*:|$)/u.test(line));
  const lines = section < 0 ? header : header.slice(0, section);
  const oneValue = pattern => {
    const values = [...new Set(lines.filter(line => pattern.test(line)).map(line => line.replace(pattern, '').trim()))];
    return values.length === 1 && values[0] ? values[0] : null;
  };
  const employers = verifiedJobFacts(lines).employers;
  const employer = employers.length === 1 ? employers[0] : null;
  const id = oneValue(/^(?:招聘编号|招聘方(?:职位|岗位)编号)\s*:\s*/u);
  const url = publicUrl(oneValue(/^(?:JD 来源|公司社招官网|官网职位|官网原文|官方职位链接)\s*:\s*/iu));
  if (employer && /^[a-z0-9_-]{1,100}$/i.test(id ?? '')) {
    return { publisher: JSON.stringify([employer, id]), owned: null };
  }
  return { publisher: null, owned: url && belongsToSource('official', url) ? officialIdentity(employer, url.href) : null };
}

export function observationKeys(job) {
  const { kind, url, jobKey, locator, publisherJobKey, officialPosition, citedOfficialUrl, ambiguousTitle, officialPublisher } = job.source;
  const normalized = comparisonUrl(url, kind);
  const link = new URL(normalized);
  const dedicated = kind === 'boss' || (kind === 'maimai' && link.pathname === '/jobs/job_detail');
  const employer = employerKey(job.employer);
  const verifiedPublisher = kind !== 'official' || Boolean(officialPublisher);
  // 官网与招聘帖可能在一个 URL 放多条 JD。按确实有证据的职位定位区分。
  const scope = dedicated ? [] : [locator, ambiguousTitle ? jobKey : null];
  return {
    source: JSON.stringify([kind, normalized, ...scope]),
    publisher: verifiedPublisher && employer && publisherJobKey ? JSON.stringify([employer, publisherJobKey]) : null,
    owned: verifiedPublisher && officialPosition ? officialIdentity(employer, url) : null,
    cited: officialIdentity(employer, citedOfficialUrl),
  };
}

export const activityLabels = { new: '首次发现', changed: 'JD 已更新' };

export function jobActivity(job, runId) {
  if (runId && job.firstRunId === runId) return 'new';
  if (runId && job.changedRunId === runId) return 'changed';
  return null;
}
