import { startApp } from './app.mjs';

// 默认值由应用统一维护，也允许终端指定本机数据目录和端口。
const app = await startApp({
  dataDir: process.env.JOB_SEARCH_DATA_DIR,
  codexHome: process.env.JOB_SEARCH_CODEX_DIR,
  port: Number(process.env.JOB_SEARCH_PORT ?? 3000),
});
console.log(`在浏览器打开 ${app.origin}`);

// 退出时等待后台任务取消并释放数据库及订阅进程。
const stop = async () => {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  await app.close();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
