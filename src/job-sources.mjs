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

export function observationKeys(job) {
  const { kind, url, jobKey, locator, publisherJobKey, officialPosition, citedOfficialUrl, ambiguousTitle } = job.source;
  const normalized = comparisonUrl(url, kind);
  const link = new URL(normalized);
  const dedicated = kind === 'boss' || (kind === 'maimai' && link.pathname === '/jobs/job_detail');
  const employer = job.employer?.normalize('NFKC').trim();
  const officialKey = value => employer && value ? JSON.stringify([employer, comparisonUrl(value, 'official')]) : null;
  // 官网与招聘帖可能在一个 URL 放多条 JD。按确实有证据的职位定位区分。
  const scope = dedicated ? [] : [locator, ambiguousTitle ? jobKey : null];
  return {
    source: JSON.stringify([kind, normalized, ...scope]),
    publisher: employer && publisherJobKey ? JSON.stringify([employer, publisherJobKey]) : null,
    owned: officialPosition ? officialKey(url) : null,
    cited: officialKey(citedOfficialUrl),
  };
}

export const activityLabels = { new: '首次发现', changed: 'JD 已更新' };

export function jobActivity(job, runId) {
  if (runId && job.firstRunId === runId) return 'new';
  if (runId && job.changedRunId === runId) return 'changed';
  return null;
}
