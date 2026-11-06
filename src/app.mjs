import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { HttpError, protectLocalRequest, readForm, redirect, sendHtml } from './http.mjs';
import { handleInterviewRequest, renderInterviewProgress } from './interview-pages.mjs';
import { createInterviewStore } from './interviews.mjs';
import { createResume } from './resume.mjs';
import { createScreening } from './screening.mjs';
import { createJobStore, openDatabase } from './store.mjs';
import { createSearchRoutes } from './search-http.mjs';
import { createOfficialDiscovery, createSearchRunner } from './search.mjs';
import { createSettings } from './settings.mjs';
import { createSubscriptionClient } from './subscription.mjs';
import { escapeHtml, renderHome, renderJob, renderPage } from './views.mjs';

const HOST = '127.0.0.1';
const DEFAULT_DATA_DIR = fileURLToPath(new URL('../.job-search-data/', import.meta.url));

function loopbackUrl(port) {
  return new URL(`http://${HOST}:${port}`);
}

export async function startApp({
  dataDir = DEFAULT_DATA_DIR, port = 3000, codexExecutable, readOfficialPage,
  subscription = createSubscriptionClient({ executable: codexExecutable }),
} = {}) {
  // 由本机进程持有数据库，浏览器关闭时不影响数据连接。
  const db = openDatabase(dataDir);
  const server = createServer();
  let search;
  let resume;

  try {
    const jobs = createJobStore(db);
    const interviews = createInterviewStore(db);
    const settings = createSettings(db);
    resume = createResume({ db, settings, subscription });
    const screening = createScreening({ resume, subscription });
    search = createSearchRunner({
      db, jobs, settings: { get: resume.getSearchSettings },
      discover: createOfficialDiscovery(subscription, readOfficialPage),
      processVerifiedJobs: screening.processVerifiedJobs,
    });
    const searchRoutes = createSearchRoutes({ settings, search, validateDirection: resume.validateDirection, screening });
    server.on('request', async (request, response) => {
      try {
        protectLocalRequest(request, response, loopbackUrl(request.socket.localPort));
        const path = request.url.split('?', 1)[0];
        if (!await resume.handle(request, response, path) && !await searchRoutes(request, response, path)) {
          await handleRequest(request, response, path, jobs, interviews, screening);
        }
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
    async close() {
      await Promise.all([
        new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
        search.close(),
        resume.close(),
      ]);
      db.close();
    },
  };
}

async function handleRequest(request, response, path, jobs, interviews, screening) {
  if (request.method === 'GET' && path === '/') {
    const visible = jobs.listJobs().map(screening.decorate)
      .filter(job => job.screening?.status !== 'excluded' || job.hasApplication);
    sendHtml(response, 200, renderHome(visible));
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
      sendHtml(response, 200, renderJob(screening.decorate(job), application, interviewProgress));
      return;
    }
  }

  const applicationPath = /^\/jobs\/([0-9a-f-]+)\/application$/.exec(path);
  if (request.method === 'POST' && applicationPath) {
    const job = jobs.getJob(applicationPath[1]);
    if (job) {
      if (screening.decorate(job).screening?.status === 'excluded' && !jobs.getApplication(job.id)) {
        throw new HttpError(409, '此职位已退出自动筛选结果');
      }
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
