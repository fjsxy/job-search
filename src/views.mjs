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

export function screeningLabel({ screening }) {
  return { matched: '符合筛选条件', pending: '待确认', excluded: '已退出自动筛选' }[screening?.status] ?? '';
}

function renderScreening(job) {
  const { screening } = job;
  if (!screening) return '';
  const { matchStatus, pending, excluded, evidence, employerSource, matchNote } = screening;
  const labels = [...pending, ...excluded];
  if (matchStatus === 'pending') labels.push(matchNote || '简历匹配待确认');
  if (matchStatus === 'unmatched') labels.push('核心职责或必备能力与简历不匹配');
  return `<section><h2>筛选与匹配</h2>
    <p>${screeningLabel(job)}</p>
    ${labels.length ? `<ul>${labels.map(label => `<li>${escapeHtml(label)}</li>`).join('')}</ul>` : ''}
    ${employerSource ? `<p><a href="${escapeHtml(employerSource)}">招聘主体归属依据</a></p>` : ''}
    ${evidence.length ? `<h3>简历匹配依据</h3><dl>${evidence.map(item => `<dt>${item.kind === 'duty' ? '核心职责' : '必备能力'}</dt>
      <dd>JD：<q>${escapeHtml(item.jdQuote)}</q></dd><dd>简历：<q>${escapeHtml(item.resumeQuote)}</q></dd>`).join('')}</dl>` : ''}
  </section>`;
}

export function renderHome(jobs) {
  const jobList = jobs.map(job =>
    `<li><a href="/jobs/${escapeHtml(job.id)}">${escapeHtml(job.title || jobTitle(job.jd))}</a>${screeningLabel(job) ? ` · ${screeningLabel(job)}` : ''}</li>`).join('\n');

  return renderPage('职位', `
<h1>职位</h1>
<p><a href="/search">官网搜索与 Agent 设置</a> · <a href="/settings/resume">简历与求职方向</a></p>
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
  const { id, jd, source } = job;
  const title = job.title || jobTitle(jd);
  const sourceContent = source
    ? `<section><h2>JD 来源</h2><p><a href="${escapeHtml(source.url)}">公司社招官网</a> · ${escapeHtml(source.locator ?? title)}</p></section>`
    : '';
  const applicationContent = application
    ? `<ul><li>已投递</li></ul>${interviewProgress}`
    : job.screening?.status === 'excluded' ? '<p>此职位已退出自动筛选结果。</p>'
    : renderPostForm(`/jobs/${id}/application`, '确认已投递');

  return renderPage(title, `
<h1>${escapeHtml(title)}</h1>
${sourceContent}
${renderScreening(job)}
<section>
  <h2>投递</h2>
  ${applicationContent}
</section>
<section>
  <h2>JD 正文</h2>
  <pre><code>${escapeHtml(jd)}</code></pre>
</section>`);
}
