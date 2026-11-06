import { loginForSubscription, subscriptionHome } from './subscription.mjs';

// 登录和服务启动共用同一个专用目录，个人 Codex 会话无需改动。
try {
  const codexHome = subscriptionHome(process.env.JOB_SEARCH_DATA_DIR, process.env.JOB_SEARCH_CODEX_DIR);
  process.exitCode = await loginForSubscription({ codexHome });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
