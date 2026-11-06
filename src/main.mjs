import { startApp } from './app.mjs';

// 默认值由应用统一维护，也允许终端指定本机数据目录和端口。
const { origin } = await startApp({
  dataDir: process.env.JOB_SEARCH_DATA_DIR,
  port: Number(process.env.JOB_SEARCH_PORT ?? 3000),
});
console.log(`在浏览器打开 ${origin}`);
