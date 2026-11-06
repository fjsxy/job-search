import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { HttpError, protectLocalRequest, readForm, redirect, sendHtml } from './http.mjs';
import { handleInterviewRequest, renderInterviewProgress } from './interview-pages.mjs';
import { createInterviewStore } from './interviews.mjs';
import { createJobStore, openDatabase } from './store.mjs';
import { escapeHtml, renderHome, renderJob, renderPage } from './views.mjs';

const HOST = '127.0.0.1';
const DEFAULT_DATA_DIR = fileURLToPath(new URL('../.job-search-data/', import.meta.url));

function loopbackUrl(port) {
  return new URL(`http://${HOST}:${port}`);
}

export async function startApp({ dataDir = DEFAULT_DATA_DIR, port = 3000 } = {}) {
  // 由本机进程持有数据库，浏览器关闭时不影响数据连接。
  const db = openDatabase(dataDir);
  const server = createServer();
  server.once('close', () => db.close());

  try {
    const jobs = createJobStore(db);
    const interviews = createInterviewStore(db);
    server.on('request', async (request, response) => {
      try {
        protectLocalRequest(request, response, loopbackUrl(request.socket.localPort));
        await handleRequest(request, response, jobs, interviews);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        const message = status === 500 ? '本机服务处理失败，请重试' : error.message;
        sendHtml(response, status, renderPage(message, `<p>${escapeHtml(message)}</p>`));
      }
    });
    server.listen(port, HOST);
    await once(server, 'listening');
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    origin: loopbackUrl(server.address().port).origin,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function handleRequest(request, response, jobs, interviews) {
  const path = request.url.split('?', 1)[0];
  if (request.method === 'GET' && path === '/') {
    sendHtml(response, 200, renderHome(jobs.listJobs()));
    return;
  }

  if (request.method === 'POST' && path === '/jobs') {
    const form = await readForm(request);
    const jd = form.get('jd');
    if (!jd?.trim()) {
      throw new HttpError(400, '请输入 JD 正文');
    }
    // 手动导入不经过自动筛选，保存后直接进入职位详情。
    const id = jobs.addManualJob(jd);
    redirect(response, `/jobs/${id}`);
    return;
  }

  const jobPath = /^\/jobs\/([0-9a-f-]+)$/.exec(path);
  if (request.method === 'GET' && jobPath) {
    const job = jobs.getJob(jobPath[1]);
    if (job) {
      const application = jobs.getApplication(job.id);
      const interviewProgress = application && renderInterviewProgress(job.id, interviews.listRounds(application.id));
      sendHtml(response, 200, renderJob(job, application, interviewProgress));
      return;
    }
  }

  const applicationPath = /^\/jobs\/([0-9a-f-]+)\/application$/.exec(path);
  if (request.method === 'POST' && applicationPath) {
    const job = jobs.getJob(applicationPath[1]);
    if (job) {
      jobs.registerApplication(job.id);
      redirect(response, `/jobs/${job.id}`);
      return;
    }
  }

  if (await handleInterviewRequest(request, response, path, jobs, interviews)) {
    return;
  }

  throw new HttpError(404, '页面不存在');
}
