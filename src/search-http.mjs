import { HttpError, readForm, redirect, sendHtml } from './http.mjs';
import { activityLabels, sourceLabels } from './job-sources.mjs';
import { escapeHtml, renderPage, renderPostForm } from './views.mjs';

function statusLabel(status) {
  return { running: '进行中', failed: '失败', partial: '部分来源失败', completed: '已完成', restricted: '未完成（访问受限）' }[status];
}

export function createSearchRoutes({ settings, search }) {
  return async (request, response, path) => {
    if (request.method === 'GET' && path === '/search') {
      const { direction, fastMode } = settings.get();
      const runs = search.listRuns().map(run =>
        `<li><a href="/search/runs/${run.id}">${statusLabel(run.status)} · ${run.fastMode ? 'Fast' : 'Standard'}</a></li>`).join('');
      sendHtml(response, 200, renderPage('职位搜索', `
        <h1>职位搜索</h1>
        <section><h2>公开搜索的岗位方向</h2>
        <p>请只填写用于公开搜索的岗位方向，不要填写简历或个人信息。</p>
        ${renderPostForm('/search/direction', '确认岗位方向', `
          <label for="direction">岗位方向</label>
          <textarea id="direction" name="direction" maxlength="500" rows="3" required>${escapeHtml(direction)}</textarea>`)}
        </section>
        <section><h2>Agent 速度</h2>
        <p>当前使用 ${fastMode ? 'Fast' : 'Standard'}，适用于所有 Agent 任务。</p>
        ${renderPostForm('/settings/agent-speed', '保存速度', `
          <label for="speed">Agent 速度</label>
          <select id="speed" name="speed">
            <option value="fast"${fastMode ? ' selected' : ''}>Fast</option>
            <option value="standard"${!fastMode ? ' selected' : ''}>Standard</option>
          </select>`)}
        </section>
        <section><h2>公司社招官网、脉脉和 BOSS 直聘</h2>
        ${renderPostForm('/search/runs', '开始搜索')}
        <h3>最近搜索</h3><ul>${runs}</ul></section>`));
      return true;
    }
    if (request.method === 'POST' && path === '/search/direction') {
      const direction = (await readForm(request)).get('direction')?.trim();
      if (!direction || direction.length > 500 || direction.includes('\0')) {
        throw new HttpError(400, '请输入不超过 500 字的岗位方向');
      }
      settings.saveDirection(direction);
      redirect(response, '/search');
      return true;
    }
    if (request.method === 'POST' && path === '/settings/agent-speed') {
      const speed = (await readForm(request)).get('speed');
      if (speed !== 'fast' && speed !== 'standard') throw new HttpError(400, '请选择有效的 Agent 速度');
      settings.saveSpeed(speed === 'fast');
      redirect(response, '/search');
      return true;
    }
    if (request.method === 'POST' && path === '/search/runs') {
      const { id, error } = search.start();
      if (error) throw new HttpError(400, error);
      redirect(response, `/search/runs/${id}`);
      return true;
    }
    const runPath = /^\/search\/runs\/([0-9a-f-]+)$/.exec(path);
    if (request.method !== 'GET' || !runPath) return false;
    const run = search.getRun(runPath[1]);
    if (!run) return false;
    sendHtml(response, 200, renderPage('搜索结果', `
      <h1>职位搜索结果</h1>
      <p>搜索 · ${statusLabel(run.status)} · ${run.fastMode ? 'Fast' : 'Standard'}</p>
      <p><a href="/search/runs/${run.id}">刷新状态</a> · <a href="/search">返回职位搜索</a></p>
      ${run.result ? renderSources(run) : ''}
      ${run.error ? `<p>${escapeHtml(run.error)}</p>` : ''}
      ${run.result ? renderResults(run.result) : ''}
      ${run.status === 'running' ? '<p>关闭页面后搜索仍会继续。</p>' : renderPostForm('/search/runs', '重新搜索')}`));
    return true;
  };
}

function renderSources({ result, status }) {
  // 早期的官网搜索历史只有一个来源，旧结果仍可打开。
  const sources = result.sources ?? [{
    kind: 'official', status, verifiedCount: result.verified.length, leadCount: result.leads.length,
  }];
  const rows = sources.map(({ kind, status, verifiedCount, leadCount, error }) => {
    const counts = status === 'completed' && !verifiedCount && !leadCount ? ' · 零结果'
      : status === 'failed' ? '' : ` · ${verifiedCount} 条已核实 JD，${leadCount} 条待核验`;
    return `<li>${sourceLabels[kind]} · ${statusLabel(status)}${counts}${error ? ` · ${escapeHtml(error)}` : ''}</li>`;
  }).join('');
  return `<section><h2>来源状态</h2><ul>${rows}</ul></section>`;
}

function renderResults({ verified, leads }) {
  const rows = verified.map(job => {
    const activity = job.activity ? ` · ${activityLabels[job.activity]}` : '';
    const conflicts = job.conflicts?.length ? ` · 待确认（${escapeHtml(job.conflicts.join('、'))}）` : '';
    const links = (job.sources ?? [job.source]).map(source =>
      `<a href="${escapeHtml(source.url)}">${sourceLabels[source.kind]}原文</a>`).join(' · ');
    return `<li><a href="/jobs/${job.id}">${escapeHtml(job.title)}</a>${activity}${conflicts} · ${links}</li>`;
  }).join('');
  const leadRows = leads.map(lead =>
    `<li><a href="${escapeHtml(lead.source.url)}">${escapeHtml(lead.title)}</a> · ${sourceLabels[lead.source.kind]}</li>`).join('');
  return `<section><h2>已核实 JD</h2>
    ${rows ? `<ul>${rows}</ul>` : '<p>本次没有核实的 JD。</p>'}
  </section>
  <section><h2>待核验职位</h2>
    ${leadRows ? `<ul>${leadRows}</ul>` : '<p>本次没有待核验的线索。</p>'}
  </section>`;
}
