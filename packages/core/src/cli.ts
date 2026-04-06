#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as readline from "node:readline";
import yaml from "js-yaml";
import { normalizePluginSpec, resolvePluginImportUrl } from "./plugins/resolve-plugin.js";

const DATA_DIR = join(homedir(), ".nichijou");
const PID_FILE = join(DATA_DIR, "nichijou.pid");
const LOG_DIR = join(DATA_DIR, "logs");
const LOG_FILE = join(LOG_DIR, "nichijou.log");
const ERR_FILE = join(LOG_DIR, "nichijou.err");

mkdirSync(LOG_DIR, { recursive: true });

function loadDotEnv(): void {
  const candidates = [
    join(process.cwd(), ".env"),
    join(DATA_DIR, ".env"),
  ];
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx < 1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    } catch { /* ignore */ }
    break;
  }
}

loadDotEnv();

/** 与 serve() 一致：--port > PORT 环境变量 > config.yaml > 3000 */
function getDefaultPortFromConfig(): number {
  const configPath = join(DATA_DIR, "config.yaml");
  if (!existsSync(configPath)) return 3000;
  try {
    const content = readFileSync(configPath, "utf-8");
    const parsed = yaml.load(content) as { port?: number } | undefined;
    if (typeof parsed?.port === "number" && !Number.isNaN(parsed.port)) return parsed.port;
  } catch { /* ignore */ }
  return 3000;
}

function resolveEffectivePortForDisplay(cliPortArg?: string): string {
  if (cliPortArg) return cliPortArg;
  if (process.env.PORT) return process.env.PORT;
  return String(getDefaultPortFromConfig());
}

const args = process.argv.slice(2);
const command = args[0] ?? "help";

// Internal: background server entry point (spawned by `nichijou start`)
if (command === "__serve__") {
  serve().catch((err) => {
    console.error(`[${new Date().toISOString()}] 启动失败:`, err);
    removePid();
    process.exit(1);
  });
} else {
  const COMMANDS: Record<string, () => Promise<void> | void> = {
    start: cmdStart,
    stop: cmdStop,
    restart: cmdRestart,
    status: cmdStatus,
    dev: cmdDev,
    repl: cmdRepl,
    logs: cmdLogs,
    plugin: cmdPlugin,
    help: cmdHelp,
    version: cmdVersion,
  };

  const handler = COMMANDS[command];
  if (handler) {
    Promise.resolve(handler()).catch((err) => {
      console.error(`错误: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    });
  } else {
    console.error(`未知命令: ${command}`);
    cmdHelp();
    process.exit(1);
  }
}

// ─── Commands ────────────────────────────────────────

function cmdHelp(): void {
  console.log(`
🏠 Nichijou Loop - 家庭 AI 管家

用法: nichijou <command>

命令:
  start                  后台启动管家服务
  stop                   停止管家服务
  restart                重启管家服务
  status                 查看服务状态
  dev                    前台启动（开发模式，日志直接输出）
  repl                   交互式对话模式
  logs                   查看运行日志
  plugin list            查看 config 中的 plugins 与本地解析状态
  plugin install <pkg>   安装到 ~/.nichijou/plugins 并写入 plugins
  plugin remove <pkg>    从配置移除并 npm uninstall
  help                   显示此帮助
  version                显示版本号

选项:
  --port <port>          指定端口号（默认 3000）

示例:
  nichijou start                        # 后台启动
  nichijou start --port 8080            # 指定端口启动
  nichijou dev                          # 前台启动
  nichijou plugin list                  # 查看已安装插件
  nichijou plugin install @scope/pkg  # 或 file:/绝对路径/插件包
  nichijou status                       # 检查运行状态
`);
}

function cmdVersion(): void {
  console.log("nichijou-loop v0.1.0");
}

// ─── Daemon management ──────────────────────────────

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  if (isNaN(pid)) return null;
  return pid;
}

function writePid(pid: number): void {
  writeFileSync(PID_FILE, String(pid), "utf-8");
}

function removePid(): void {
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getRunningPid(): number | null {
  const pid = readPid();
  if (pid && isProcessRunning(pid)) return pid;
  if (pid) removePid();
  return null;
}

async function cmdStart(): Promise<void> {
  const existing = getRunningPid();
  if (existing) {
    console.log(`管家已在运行中 (PID: ${existing})`);
    console.log(`使用 'nichijou restart' 重启，或 'nichijou stop' 停止`);
    return;
  }

  const portIdx = args.indexOf("--port");
  const cliPort = portIdx >= 0 && args[portIdx + 1] ? args[portIdx + 1] : undefined;

  const serverScript = getServerScriptPath();
  const env = { ...process.env };
  if (cliPort) env.PORT = cliPort;

  const out = (await import("node:fs")).openSync(LOG_FILE, "a");
  const err = (await import("node:fs")).openSync(ERR_FILE, "a");

  const child = spawn(process.execPath, [serverScript, "__serve__"], {
    detached: true,
    stdio: ["ignore", out, err],
    env,
  });

  child.unref();

  if (child.pid) {
    writePid(child.pid);
    const displayPort = resolveEffectivePortForDisplay(cliPort);
    console.log(`🏠 管家已后台启动 (PID: ${child.pid})`);
    console.log(`   端口: ${displayPort}`);
    console.log(`   日志: ${LOG_FILE}`);
    console.log(`   停止: nichijou stop`);
  } else {
    console.error("启动失败");
    process.exit(1);
  }
}

async function cmdStop(): Promise<void> {
  const pid = getRunningPid();
  if (!pid) {
    console.log("管家未在运行");
    return;
  }

  console.log(`正在停止管家 (PID: ${pid})...`);
  process.kill(pid, "SIGTERM");

  // Wait for process to exit (max 10s)
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (!isProcessRunning(pid)) {
      removePid();
      console.log("管家已停止");
      return;
    }
  }

  // Force kill
  try {
    process.kill(pid, "SIGKILL");
  } catch { /* already dead */ }
  removePid();
  console.log("管家已强制停止");
}

async function cmdRestart(): Promise<void> {
  const pid = getRunningPid();
  if (pid) {
    await cmdStop();
    await sleep(1000);
  }
  await cmdStart();
}

function cmdStatus(): void {
  const pid = getRunningPid();
  if (!pid) {
    console.log("管家状态: 未运行");
    return;
  }

  console.log(`管家状态: 运行中`);
  console.log(`  PID: ${pid}`);
  console.log(`  端口: ${resolveEffectivePortForDisplay()}`);
  console.log(`  PID 文件: ${PID_FILE}`);
  console.log(`  日志: ${LOG_FILE}`);

  try {
    const pInfo = execSync(`ps -p ${pid} -o etime=,rss= 2>/dev/null`, { encoding: "utf-8" }).trim();
    const parts = pInfo.split(/\s+/);
    if (parts.length >= 2) {
      console.log(`  运行时间: ${parts[0]!.trim()}`);
      console.log(`  内存: ${Math.round(parseInt(parts[1]!, 10) / 1024)} MB`);
    }
  } catch { /* ps not available */ }
}

function cmdLogs(): void {
  if (!existsSync(LOG_FILE)) {
    console.log("暂无日志");
    return;
  }

  const tailLines = 50;
  try {
    const content = execSync(`tail -n ${tailLines} "${LOG_FILE}"`, { encoding: "utf-8" });
    console.log(content);
  } catch {
    const content = readFileSync(LOG_FILE, "utf-8");
    const lines = content.split("\n");
    console.log(lines.slice(-tailLines).join("\n"));
  }
}

// ─── Plugin management ──────────────────────────────

async function cmdPlugin(): Promise<void> {
  const sub = args[1];
  if (!sub || sub === "list") {
    await cmdPluginList();
  } else if (sub === "install") {
    const pkg = args[2];
    if (!pkg) {
      console.error("用法: nichijou plugin install <package-name>");
      process.exit(1);
    }
    await cmdPluginInstall(pkg);
  } else if (sub === "remove" || sub === "uninstall") {
    const pkg = args[2];
    if (!pkg) {
      console.error("用法: nichijou plugin remove <package-name>");
      process.exit(1);
    }
    await cmdPluginRemove(pkg);
  } else {
    console.error(`未知子命令: plugin ${sub}`);
    console.log("可用子命令: list, install, remove");
    process.exit(1);
  }
}

async function cmdPluginList(): Promise<void> {
  const configPath = join(DATA_DIR, "config.yaml");
  const pluginDir = join(DATA_DIR, "plugins");

  console.log("\n📦 插件列表（由 ~/.nichijou/config.yaml 的 plugins 字段决定加载项）\n");

  let configured: string[] = [];
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      const config = yaml.load(content) as Record<string, unknown>;
      configured = (config.plugins as string[]) ?? [];
    } catch { /* ignore */ }
  }

  if (configured.length === 0) {
    console.log("当前未配置 plugins，服务启动时不会加载任何插件。\n");
    console.log("  · 编辑 config.yaml，例如: plugins: [\"@nichijou/plugin-weather\"]");
    console.log("  · 或执行: nichijou plugin install <包名>（会安装到 ~/.nichijou/plugins 并写入配置）\n");
  } else {
    console.log("已配置项（✅ 表示在 ~/.nichijou/plugins 下可解析）:\n");
    for (const spec of configured) {
      let mark = "❌";
      try {
        resolvePluginImportUrl(spec, pluginDir);
        mark = "✅";
      } catch {
        // 未安装或路径无效
      }
      console.log(`  ${mark}  ${spec}`);
    }
    console.log("");
  }

  console.log("命令:");
  console.log("  nichijou plugin install <pkg>   # npm 包名，或 file:/本地路径/到插件包");
  console.log("  nichijou plugin remove <pkg>    # 从配置移除并 npm uninstall");
  console.log("安装或修改配置后需 nichijou restart（或 dev 前台重启）。\n");
}

async function cmdPluginInstall(pkg: string): Promise<void> {
  console.log(`📦 安装插件: ${pkg}`);

  const pluginDir = join(DATA_DIR, "plugins");
  if (!existsSync(pluginDir)) {
    mkdirSync(pluginDir, { recursive: true });
  }

  const pkgJsonPath = join(pluginDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(pkgJsonPath, JSON.stringify({ name: "nichijou-plugins", private: true, type: "module", dependencies: {} }, null, 2));
  }

  try {
    console.log("正在下载...");
    execSync(`npm install ${pkg}`, { cwd: pluginDir, stdio: "pipe", encoding: "utf-8" });
  } catch (err) {
    console.error(`安装失败: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const configPath = join(DATA_DIR, "config.yaml");
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = (yaml.load(readFileSync(configPath, "utf-8")) as Record<string, unknown>) ?? {};
    } catch { /* ignore */ }
  }
  const plugins = (config.plugins as string[]) ?? [];
  const nameToStore = normalizePluginSpec(pkg);
  if (!plugins.includes(nameToStore)) {
    plugins.push(nameToStore);
    config.plugins = plugins;
    writeFileSync(configPath, yaml.dump(config, { lineWidth: 120 }));
  }

  try {
    resolvePluginImportUrl(nameToStore, pluginDir);
  } catch (e) {
    console.warn("警告: 已写入配置但解析入口失败:", e instanceof Error ? e.message : e);
  }

  console.log(`✅ 插件 ${pkg} 安装成功`);
  console.log("需要重启服务以加载新插件: nichijou restart");
}

async function cmdPluginRemove(pkg: string): Promise<void> {
  console.log(`📦 移除插件: ${pkg}`);

  const pluginDir = join(DATA_DIR, "plugins");
  if (existsSync(join(pluginDir, "package.json"))) {
    try {
      execSync(`npm uninstall ${pkg}`, { cwd: pluginDir, stdio: "pipe", encoding: "utf-8" });
    } catch { /* ignore */ }
  }

  const configPath = join(DATA_DIR, "config.yaml");
  const norm = normalizePluginSpec(pkg);
  if (existsSync(configPath)) {
    try {
      const config = (yaml.load(readFileSync(configPath, "utf-8")) as Record<string, unknown>) ?? {};
      const plugins = ((config.plugins as string[]) ?? []).filter(
        (p) => p !== pkg && normalizePluginSpec(p) !== norm,
      );
      config.plugins = plugins;
      writeFileSync(configPath, yaml.dump(config, { lineWidth: 120 }));
    } catch { /* ignore */ }
  }

  console.log(`✅ 插件 ${pkg} 已从配置移除`);
  console.log("需要重启服务以生效: nichijou restart");
}

// ─── Foreground / dev mode ──────────────────────────

async function cmdDev(): Promise<void> {
  const existing = getRunningPid();
  if (existing) {
    console.log(`管家已在后台运行 (PID: ${existing})，请先 'nichijou stop'`);
    return;
  }

  const { ButlerService } = await import("./butler.js");
  const { NichijouServer } = await import("./server.js");

  console.log("🏠 Nichijou Loop - 家庭 AI 管家 (开发模式)");
  console.log("==========================================\n");

  const butler = new ButlerService();
  const config = butler.config.get();

  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 && args[portIdx + 1]
    ? parseInt(args[portIdx + 1]!, 10)
    : process.env.PORT
      ? parseInt(process.env.PORT, 10)
      : config.port;

  let family = butler.familyManager.getFamily();
  if (!family) {
    family = butler.familyManager.createFamily("我的家");
    console.log(`创建了默认家庭「${family.name}」`);
  }

  await butler.registerPlugins();
  await butler.initWeChatChannel();
  butler.reminderScheduler.start();
  butler.actionExecutor.start();

  const server = new NichijouServer(butler);
  await server.start(port);

  console.log(`\n管家已就绪！`);
  if (!config.setupCompleted) {
    console.log(`首次使用请访问 http://localhost:${port} 完成设置`);
  }
  console.log(`按 Ctrl+C 停止\n`);

  process.on("SIGINT", async () => {
    console.log("\n正在关闭...");
    await butler.shutdown();
    process.exit(0);
  });
}

// ─── REPL mode ──────────────────────────────────────

async function cmdRepl(): Promise<void> {
  const { ButlerService } = await import("./butler.js");
  type AgentEventType = import("@nichijou/agent").AgentEvent;

  console.log("🏠 Nichijou Loop - 家庭 AI 管家 (REPL)");
  console.log("=======================================");

  const butler = new ButlerService();
  const config = butler.config.get();

  let family = butler.familyManager.getFamily();
  if (!family) {
    family = butler.familyManager.createFamily("我的家");
    console.log(`\n创建了家庭「${family.name}」`);
  }

  let members = butler.familyManager.getMembers();
  let currentMember = members[0];
  if (!currentMember) {
    currentMember = butler.familyManager.addMember("用户");
    console.log(`创建了成员「${currentMember.name}」(管理员)`);
  }

  console.log(`\n当前家庭：${family.name}`);
  console.log(`当前成员：${currentMember.name}`);
  console.log(`LLM: ${config.llm.baseUrl} (${config.llm.model})`);
  console.log(`\n输入消息与管家对话，输入 /quit 退出\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question(`${currentMember!.name}> `, async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        prompt();
        return;
      }

      if (trimmed === "/quit" || trimmed === "/exit") {
        console.log("\n再见！");
        await butler.shutdown();
        rl.close();
        process.exit(0);
      }

      if (trimmed === "/members") {
        members = butler.familyManager.getMembers();
        console.log("\n家庭成员：");
        for (const m of members) {
          const marker = m.id === currentMember!.id ? " ← 当前" : "";
          console.log(`  - ${m.name} (${m.role})${marker}`);
        }
        console.log();
        prompt();
        return;
      }

      if (trimmed === "/status") {
        const usage = butler.db.getTokenUsage(new Date().toISOString().slice(0, 10));
        console.log(`\nToken 用量(今日): prompt=${usage.promptTokens} completion=${usage.completionTokens}`);
        console.log();
        prompt();
        return;
      }

      try {
        process.stdout.write("\n管家: ");
        const onEvent = (event: AgentEventType) => {
          if (event.type === "text_delta") {
            process.stdout.write(event.delta);
          } else if (event.type === "tool_start") {
            process.stdout.write(`\n  [调用工具: ${event.toolName}]`);
          } else if (event.type === "tool_end") {
            process.stdout.write(` → ${event.isError ? "❌" : "✅"}\n`);
          }
        };

        await butler.chat(currentMember!.id, trimmed, onEvent);
        console.log("\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\n错误: ${msg}\n`);
      }

      prompt();
    });
  };

  prompt();
}

// ─── Internal: background server process ────────────

/** This is the actual server entry point, spawned by `nichijou start`. */
async function serve(): Promise<void> {
  const { ButlerService } = await import("./butler.js");
  const { NichijouServer } = await import("./server.js");

  const butler = new ButlerService();
  const config = butler.config.get();

  const envLlmPatch: Record<string, string> = {};
  if (process.env.LLM_BASE_URL) envLlmPatch.baseUrl = process.env.LLM_BASE_URL;
  if (process.env.LLM_API_KEY) envLlmPatch.apiKey = process.env.LLM_API_KEY;
  if (process.env.LLM_MODEL) envLlmPatch.model = process.env.LLM_MODEL;
  if (Object.keys(envLlmPatch).length > 0) {
    butler.config.update({ llm: { ...config.llm, ...envLlmPatch } } as any);
    butler.refreshProvider();
    console.log(`[Env] .env LLM 配置已加载`);
  }

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : config.port;

  let family = butler.familyManager.getFamily();
  if (!family) {
    family = butler.familyManager.createFamily("我的家");
  }

  await butler.registerPlugins();
  await butler.initWeChatChannel();
  butler.reminderScheduler.start();
  butler.actionExecutor.start();

  const server = new NichijouServer(butler);
  await server.start(port);

  console.log(`[${new Date().toISOString()}] 管家已启动 (port=${port})`);

  const shutdown = async () => {
    console.log(`[${new Date().toISOString()}] 正在关闭...`);
    await butler.shutdown();
    removePid();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// ─── Helpers ────────────────────────────────────────

function getServerScriptPath(): string {
  return new URL(import.meta.url).pathname;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
