import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL = 'gpt-6.1-sol';
const REASONING_EFFORT = 'xhigh';
const LOGIN_CONFIG = ['-c', 'forced_login_method="chatgpt"', '-c', 'cli_auth_credentials_store="file"'];
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'memories', 'multi_agent',
  'multi_agent_v2', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
  'computer_use', 'image_generation', 'skill_search', 'tool_suggest',
  'remote_plugin', 'view_image',
];
const CODE_MODE_DISABLED = 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';

export class SubscriptionError extends Error {}

export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../.job-search-data/', import.meta.url));

export function subscriptionHome(dataDir = DEFAULT_DATA_DIR, override) {
  return resolve(override ?? join(dataDir, 'codex'));
}

async function prepareCodexHome(codexHome) {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const directory = await lstat(codexHome);
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0
      || (process.getuid && directory.uid !== process.getuid())) {
    throw new SubscriptionError('专用登录目录必须由当前用户独占，请检查目录权限');
  }
  // 关键：Codex 即使忽略用户配置也会加载其运行目录下的全局 AGENTS。
  for (const filename of ['AGENTS.override.md', 'AGENTS.md']) {
    try {
      await lstat(join(codexHome, filename));
      throw new SubscriptionError('专用登录目录含有 AGENTS 指令，请移除后再运行 Agent');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

// 只继承登录和运行 CLI 必需的系统路径，避免环境变量改写认证、端点和工具。
function cliEnvironment(codexHome) {
  const env = { CODEX_HOME: codexHome, RUST_LOG: 'error' };
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'LC_CTYPE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function command(executable, args, { codexHome, cwd, input, signal, timeout, login = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: cliEnvironment(codexHome), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let failure;
    let forceStop;
    const stop = (message) => {
      if (failure) return;
      failure = new SubscriptionError(message);
      child.kill('SIGTERM');
      forceStop = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    const cancel = () => stop('订阅任务已停止，可重跑');
    const timer = setTimeout(() => stop('订阅调用超时，可重跑'), timeout);
    const collect = (part) => {
      if (failure) return;
      output += part;
      if (output.length > 4_000_000) stop('订阅返回内容过大，可重跑');
    };

    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', login ? collect : () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('error', () => { failure ??= new SubscriptionError('无法启动 Codex CLI，请检查安装'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(forceStop);
      signal?.removeEventListener('abort', cancel);
      if (failure) reject(failure);
      else resolve({ code, output });
    });
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
  });
}

function readResult({ code, output }, webSearch) {
  try {
    const events = output.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    const tools = [];
    const message = events.findLast(event => event.type === 'item.completed' && event.item?.type === 'agent_message')?.item.text;
    if (code !== 0 || !message || !events.some(event => event.type === 'turn.completed')
        || events.some(event => ['turn.failed', 'error'].includes(event.type))) {
      throw new SubscriptionError('订阅调用未完整完成，请检查连接或用量后重跑');
    }
    for (const event of events) {
      const item = event.item;
      if (!item && ['thread.started', 'turn.started', 'turn.completed'].includes(event.type)) continue;
      if (item && ['item.started', 'item.updated', 'item.completed'].includes(event.type)) {
        if (['agent_message', 'reasoning'].includes(item.type)) continue;
        if (event.type === 'item.completed' && !webSearch && item.type === 'error' && item.message === CODE_MODE_DISABLED) continue;
        if (webSearch && item.type === 'web_search') {
          if (event.type === 'item.completed') tools.push(item);
          continue;
        }
      }
      throw new SubscriptionError('订阅任务发生非预期工具活动，结果未采纳');
    }
    return { value: JSON.parse(message), webEvidence: tools };
  } catch (error) {
    if (error instanceof SubscriptionError) throw error;
    throw new SubscriptionError('订阅返回的结果无法读取，可重跑');
  }
}

// 将本应用的订阅登录保存在专用目录，终端交互由 Codex CLI 负责。
export async function loginForSubscription({ codexHome = subscriptionHome(), executable = 'codex' } = {}) {
  await prepareCodexHome(codexHome);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['login', ...LOGIN_CONFIG], {
      cwd: codexHome, env: cliEnvironment(codexHome), stdio: 'inherit',
    });
    child.once('error', () => reject(new SubscriptionError('无法启动 Codex CLI，请检查安装')));
    child.once('close', code => resolve(code ?? 1));
  });
}

export function createSubscriptionClient({ executable = 'codex', codexHome = subscriptionHome() } = {}) {
  return {
    // 私有任务默认禁用公开搜索。调用方仅提供该任务所需的提示词和输出 schema。
    async run({ prompt, schema, fastMode = true, webSearch = false, signal }) {
      await prepareCodexHome(codexHome);
      const cwd = await mkdtemp(join(tmpdir(), 'job-search-agent-'));
      try {
        const login = await command(executable, ['login', 'status', ...LOGIN_CONFIG], {
          codexHome, cwd, signal, timeout: 10_000, login: true,
        });
        if (login.code !== 0 || !/\bLogged in using ChatGPT\b/.test(login.output)) {
          throw new SubscriptionError('请在终端执行 make login 并使用 ChatGPT 登录');
        }
        const schemaPath = join(cwd, 'output.json');
        await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
        const args = [
          'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
          '--sandbox', 'read-only', '--json', '--color', 'never', '-m', MODEL,
          '-c', 'model_provider="openai"', ...LOGIN_CONFIG,
          '-c', 'project_doc_max_bytes=0', '-c', 'mcp_servers={}',
          '-c', `model_reasoning_effort="${REASONING_EFFORT}"`,
          '--enable', 'fast_mode', '-c', `service_tier="${fastMode ? 'fast' : 'default'}"`,
          '-c', `web_search="${webSearch ? 'live' : 'disabled'}"`, '--output-schema', schemaPath,
        ];
        for (const feature of DISABLED_FEATURES) args.push('--disable', feature);
        // CLI 0.166 的公开搜索由 code-mode host 暴露，私有任务仍关闭该能力。
        args.push(webSearch ? '--enable' : '--disable', 'code_mode_host', '-');
        const result = await command(executable, args, { codexHome, cwd, input: prompt, signal, timeout: 480_000 });
        return readResult(result, webSearch);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}
