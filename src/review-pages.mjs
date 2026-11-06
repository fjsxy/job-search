import { isAbsolute } from 'node:path';
import { HttpError, readBody, readForm, redirect } from './http.mjs';
import { escapeHtml, renderPostForm } from './views.mjs';

const MAX_TRANSCRIPT_BYTES = 256 * 1024;

async function readTranscript(request) {
  const contentType = request.headers['content-type'];
  if (!/^multipart\/form-data\s*;/i.test(contentType ?? '')) {
    throw new HttpError(415, '请选择 .txt 或 .md 转写稿上传');
  }
  // 先限制请求体，再使用 Node.js 的标准 multipart 解码器读取单个文件。
  const body = await readBody(request, MAX_TRANSCRIPT_BYTES + 16 * 1024);
  const form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData()
    .catch(() => { throw new HttpError(400, '无法读取上传的转写稿'); });
  const files = form.getAll('transcript');
  const [file] = files;
  if (files.length !== 1 || typeof file === 'string' || !/\.(txt|md)$/i.test(file.name)) {
    throw new HttpError(400, '请选择一个 .txt 或 .md 转写稿');
  }
  if (file.size > MAX_TRANSCRIPT_BYTES) {
    throw new HttpError(413, '转写稿不可超过 256 KiB');
  }
  let transcript;
  try {
    transcript = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new HttpError(400, '请使用 UTF-8 编码的转写稿');
  }
  if (!transcript.trim() || transcript.includes('\0')) {
    throw new HttpError(400, '请选择有正文的文本转写稿');
  }
  return { filename: file.name, transcript };
}

export function renderInterviewReview(roundPath, roundId, reviews) {
  const directory = reviews.getDirectory();
  const draft = reviews.get(roundId);
  const running = draft?.status === 'running';
  const confirmation = directory && ['draft', 'failed'].includes(draft?.status)
    ? renderPostForm(`${roundPath}/review`, draft.status === 'failed' ? '确认重试复盘' : '确认提交本稿并生成复盘',
      `<input type="hidden" name="version" value="${escapeHtml(draft.version)}">`)
    : '';
  return `
<section>
  <h2>面试复盘</h2>
  <h3>复盘保存目录</h3>
  <p>请先保存本机已有目录的绝对路径，再确认提交。设置适用于所有轮次，复盘使用确认提交时的目录。</p>
  ${renderPostForm(`${roundPath}/review-directory`, '保存目录', `
    <label for="review-directory">本机目录</label>
    <input id="review-directory" name="directory" type="text" value="${escapeHtml(directory)}" required>`)}
  ${running ? '' : `
  <h3>上传转写稿</h3>
  <p>支持 UTF-8 编码的 .txt 或 .md，最大 256 KiB。上传后可以预览，确认前仅保存在本机。</p>
  <form action="${escapeHtml(`${roundPath}/transcript`)}" method="post" enctype="multipart/form-data">
    <label for="transcript">转写稿文件</label>
    <input id="transcript" name="transcript" type="file" accept=".txt,.md" required>
    <button type="submit">上传并预览</button>
  </form>`}
  ${draft ? `
  <h3>转写稿预览 · ${escapeHtml(draft.filename)}</h3>
  <pre><code>${escapeHtml(draft.transcript)}</code></pre>` : ''}
  ${running ? `<p>复盘生成中。关闭页面后仍会继续。<a href="${escapeHtml(roundPath)}">刷新状态</a></p>` : ''}
  ${draft?.status === 'insufficient' ? `<p>上下文不足，已停止整轮复盘。请补齐以下片段后重新上传并确认。</p>
  <ul>${draft.missingContext.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
  ${draft?.message ? `<p>${escapeHtml(draft.message)}</p>` : ''}
  ${draft?.reportPath ? `<p>复盘文件已保存至 <code>${escapeHtml(draft.reportPath)}</code></p>` : ''}
  ${confirmation}
</section>`;
}

export async function handleReviewPost(request, response, roundPath, roundId, action, reviews) {
  if (action === 'transcript') {
    reviews.upload(roundId, await readTranscript(request));
  } else {
    const form = await readForm(request);
    if (action === 'review-directory') {
      const directory = form.get('directory');
      if (!directory || !isAbsolute(directory) || directory.includes('\0')) {
        throw new HttpError(400, '请输入本机目录的绝对路径');
      }
      reviews.setDirectory(directory);
    } else {
      reviews.start(roundId, form.get('version'));
    }
  }
  redirect(response, roundPath);
}
