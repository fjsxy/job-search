import { HttpError, readForm, redirect, sendHtml } from './http.mjs';
import { escapeHtml, renderPage, renderPostForm } from './views.mjs';

const ROUND_NAMES = ['一面', '二面', '三面', '四面', '五面', '六面', '七面', '八面', '九面', '十面'];
const RESULT_NAMES = { passed: '通过', failed: '不通过' };

function roundName(roundNumber) {
  return ROUND_NAMES[roundNumber - 1] ?? `第${roundNumber}面`;
}

function showTime(scheduledAt) {
  return `${scheduledAt.replace('T', ' ')}（北京时间）`;
}

function roundFields({ scheduledAt = null, result = null } = {}) {
  const resultOptions = Object.entries(RESULT_NAMES).map(([value, label]) =>
    `<option value="${value}"${result === value ? ' selected' : ''}>${label}</option>`).join('');

  return `
    <p>至少填写预约时间或面试结果中的一项。</p>
    <label for="scheduledAt">预约时间（北京时间）</label>
    <input id="scheduledAt" name="scheduledAt" type="datetime-local" value="${escapeHtml(scheduledAt ?? '')}">
    <label for="result">结果</label>
    <select id="result" name="result">
      <option value="">待记录</option>${resultOptions}
    </select>`;
}

function readRoundFields(form) {
  const scheduledAt = form.get('scheduledAt') || null;
  const result = form.get('result') || null;
  if (scheduledAt) {
    // 以 UTC 校验日历字段是否存在，存储和展示仍使用用户输入的北京时间。
    const localMinutes = /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$/;
    const date = new Date(`${scheduledAt}Z`);
    if (!localMinutes.test(scheduledAt) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 16) !== scheduledAt) {
      throw new HttpError(400, '请输入有效的预约时间');
    }
  }
  if (result && !Object.hasOwn(RESULT_NAMES, result)) {
    throw new HttpError(400, '请选择有效的面试结果');
  }
  if (!scheduledAt && !result) {
    throw new HttpError(400, '请填写预约时间或选择面试结果');
  }
  return { scheduledAt, result };
}

export function renderInterviewProgress(jobId, rounds) {
  // 以序号最大的轮次为当前进度，历史轮次仍可单独打开。
  const latest = rounds.at(-1);
  let progress = '尚无面试记录';
  if (latest) {
    const status = latest.result ? RESULT_NAMES[latest.result] : ` · ${showTime(latest.scheduledAt)}`;
    progress = `${roundName(latest.roundNumber)}${status}`;
  }

  const path = `/jobs/${jobId}/application/interviews`;
  const history = rounds.map((round) => `<li><a href="${escapeHtml(`${path}/${round.id}`)}">${roundName(round.roundNumber)}</a>${
    round.scheduledAt ? ` · ${escapeHtml(showTime(round.scheduledAt))}` : ''}${
    round.result ? ` · ${RESULT_NAMES[round.result]}` : ''}</li>`).join('\n');

  return `
  <h3>面试进度</h3>
  <p>当前进度：${escapeHtml(progress)}</p>
  ${history ? `<ol>${history}</ol>` : ''}
  <h3>新增面试轮次</h3>
  ${renderPostForm(path, '新增轮次', roundFields())}`;
}

function renderInterviewRound(jobId, round) {
  const jobPath = `/jobs/${jobId}`;
  const name = roundName(round.roundNumber);
  return renderPage(name, `
<h1>${name}</h1>
<p><a href="${escapeHtml(jobPath)}">返回投递详情</a></p>
<section>
  <h2>编辑面试轮次</h2>
  ${renderPostForm(`${jobPath}/application/interviews/${round.id}`, '保存轮次', roundFields(round))}
</section>`);
}

export async function handleInterviewRequest(request, response, path, jobs, interviews) {
  const match = /^\/jobs\/([0-9a-f-]+)\/application\/interviews(?:\/([0-9a-f-]+))?$/.exec(path);
  if (!match) {
    return false;
  }
  const [, jobId, roundId] = match;
  const application = jobs.getApplication(jobId);
  if (!application) {
    throw new HttpError(404, '投递不存在');
  }

  if (request.method === 'GET' && roundId) {
    const round = interviews.getRound(application.id, roundId);
    if (!round) {
      throw new HttpError(404, '面试轮次不存在');
    }
    sendHtml(response, 200, renderInterviewRound(jobId, round));
    return true;
  }

  if (request.method === 'POST') {
    const fields = readRoundFields(await readForm(request));
    if (roundId) {
      if (!interviews.updateRound(application.id, roundId, fields)) {
        throw new HttpError(404, '面试轮次不存在');
      }
    } else {
      interviews.addRound(application.id, fields);
    }
    redirect(response, `/jobs/${jobId}`);
    return true;
  }
  return false;
}
