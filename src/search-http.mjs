import { HttpError, readForm, redirect, sendHtml } from './http.mjs';
import { escapeHtml, renderPage, renderPostForm, screeningLabel } from './views.mjs';

function statusLabel(status) {
  return { running: '进行中', failed: '失败', completed: '已完成', restricted: '未完成（访问受限）' }[status];
}

export function createSearchRoutes({ settings, search, validateDirection, screening }) {
  return async (request, response, path) => {
    if (request.method === 'GET' && path === '/search') {
      const { direction, fastMode } = settings.get();
      const runs = search.listRuns().map(run =>
        `<li><a href="/search/runs/${run.id}">${statusLabel(run.status)} · ${run.fastMode ? 'Fast' : 'Standard'}</a></li>`).join('');
      sendHtml(response, 200, renderPage('官网搜索', `
        <h1>官网搜索</h1>
        <section><h2>公开搜索的岗位方向</h2>
        <p><a href="/settings/resume">设置简历并提取候选方向</a>。请只填写用于公开搜索的岗位方向。</p>
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
        <section><h2>公司社招官网</h2>
        ${renderPostForm('/search/runs', '开始官网搜索')}
        <h3>最近搜索</h3><ul>${runs}</ul></section>`));
      return true;
    }
    if (request.method === 'POST' && path === '/search/direction') {
      const direction = (await readForm(request)).get('direction')?.trim();
      validateDirection(direction);
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
    const verified = run.result?.verified.map(screening.decorate).filter(job => job.screening?.status !== 'excluded');
    sendHtml(response, 200, renderPage('搜索结果', `
      <h1>官网搜索结果</h1>
      <p>公司社招官网 · ${statusLabel(run.status)} · ${run.fastMode ? 'Fast' : 'Standard'}</p>
      <p><a href="/search/runs/${run.id}">刷新状态</a> · <a href="/search">返回官网搜索</a></p>
      ${run.error ? `<p>${escapeHtml(run.error)}</p>` : ''}
      ${run.result ? `<section><h2>已核实 JD</h2>
        ${verified.length ? `<ul>${verified.map(job => `<li><a href="/jobs/${job.id}">${escapeHtml(job.title)}</a>${screeningLabel(job) ? ` · ${screeningLabel(job)}` : ''} · <a href="${escapeHtml(job.source.url)}">官网原文</a></li>`).join('')}</ul>` : '<p>本次没有核实的 JD 进入筛选列表。</p>'}
      </section>
      <section><h2>待核验职位</h2>
        ${run.result.leads.length ? `<ul>${run.result.leads.map(lead => `<li><a href="${escapeHtml(lead.source.url)}">${escapeHtml(lead.title)}</a></li>`).join('')}</ul>` : '<p>本次没有待核验的线索。</p>'}
      </section>` : ''}
      ${run.status === 'running' ? '<p>关闭页面后搜索仍会继续。</p>' : renderPostForm('/search/runs', '重新搜索')}`));
    return true;
  };
}
