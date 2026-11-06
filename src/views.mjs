import { sourceLabels } from './job-sources.mjs';

// HTML 文本和属性中的外部输入统一转义。
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

export function renderPage(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · 求职</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { box-sizing: border-box; max-width: 54rem; margin: 0 auto; padding: 1.5rem; line-height: 1.65; }
    h1, h2, pre { overflow-wrap: anywhere; }
    section { border: 1px solid GrayText; border-radius: .5rem; margin-block: 1rem; padding: 1rem; }
    section > :first-child { margin-top: 0; }
    form { display: grid; gap: .5rem; }
    textarea, button { font: inherit; }
    textarea { padding: .5rem; resize: vertical; }
    button { justify-self: start; padding: .25rem .75rem; cursor: pointer; }
    pre { white-space: pre-wrap; margin-bottom: 0; }
  </style>
</head>
<body>
  <header><a href="/">求职</a></header>
  <main>${body}</main>
</body>
</html>`;
}

// fields 由调用方构造 HTML，用户输入应先转义。
export function renderPostForm(action, label, fields = '') {
  return `<form action="${escapeHtml(action)}" method="post">
    ${fields}
    <button type="submit">${escapeHtml(label)}</button>
  </form>`;
}

function jobTitle(jd) {
  // 以第一行有效文字作为列表标题，正文继续保留原样。
  const firstLine = jd.trimStart().split(/[\r\n]/, 1)[0].trimEnd();
  const characters = [...firstLine];
  return characters.length > 120 ? `${characters.slice(0, 120).join('')}…` : firstLine;
}

function discoveryDates({ firstDiscoveredAt, changedAt }) {
  const date = timestamp => `<time datetime="${escapeHtml(timestamp)}">${escapeHtml(timestamp)}</time>`;
  return `${firstDiscoveredAt ? ` · 首次发现于 ${date(firstDiscoveredAt)}` : ''}${changedAt ? ` · JD 更新于 ${date(changedAt)}` : ''}`;
}

export function renderHome(jobs) {
  const jobList = jobs.map(job =>
    `<li><a href="/jobs/${escapeHtml(job.id)}">${escapeHtml(jobTitle(job.jd))}</a>${discoveryDates(job)}</li>`).join('\n');

  return renderPage('职位', `
<h1>职位</h1>
<p><a href="/search">职位搜索与 Agent 设置</a></p>
<section>
  <h2>已保存职位</h2>
  ${jobList ? `<ul>${jobList}</ul>` : '<p>还没有保存的职位。</p>'}
</section>
<section>
  <h2>手动导入</h2>
  ${renderPostForm('/jobs', '保存职位', `
    <label for="jd">JD 正文</label>
    <textarea id="jd" name="jd" rows="10" required></textarea>`)}
</section>`);
}

export function renderJob(job, application, interviewProgress = '') {
  const { id, jd, sources, conflicts, sourceJds, manualJds } = job;
  const title = job.title || jobTitle(jd);
  const sourceContent = sources?.length
    ? `<section><h2>JD 来源</h2><ul>${sources.map(source =>
      `<li><a href="${escapeHtml(source.url)}">${sourceLabels[source.kind]}</a> · ${escapeHtml(source.locator ?? title)}</li>`).join('')}</ul></section>`
    : '';
  const conflicting = conflicts?.length
    ? `<p><strong>待确认</strong> · 来源间的${escapeHtml(conflicts.join('、'))}不一致，请核对各出处。</p>`
    : '';
  const originalJds = sourceJds?.length > 1 ? sourceJds.map(({ source, jd }) => `<details>
    <summary>${sourceLabels[source.kind]} · ${escapeHtml(source.locator ?? title)}</summary>
    <pre><code>${escapeHtml(jd)}</code></pre>
  </details>`).join('') : '';
  const manual = sources?.length && manualJds?.length ? `<section><h2>手动导入的 JD</h2>
    ${manualJds.map(text => `<pre><code>${escapeHtml(text)}</code></pre>`).join('')}
  </section>` : '';
  const applicationContent = application
    ? `<ul><li>已投递</li></ul>${interviewProgress}`
    : renderPostForm(`/jobs/${id}/application`, '确认已投递');

  return renderPage(title, `
<h1>${escapeHtml(title)}</h1>
${job.firstDiscoveredAt ? `<p>公开搜索${discoveryDates(job)}</p>` : ''}
${sourceContent}
${conflicting}
<section>
  <h2>投递</h2>
  ${applicationContent}
</section>
<section>
  <h2>JD 正文</h2>
  <pre><code>${escapeHtml(jd)}</code></pre>
  ${originalJds}
</section>
${manual}`);
}
