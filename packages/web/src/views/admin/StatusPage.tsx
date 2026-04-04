import { useEffect, useState } from "react";
import { api } from "../../api";

interface StatusData {
  setupCompleted: boolean;
  llm: { baseUrl: string; model: string };
  channels: Record<string, { connected: boolean; totalMembers?: number; connectedMembers?: number; expiredMembers?: string[] }>;
  tokenUsage: { promptTokens: number; completionTokens: number };
}

interface SystemInfo {
  hostname: string;
  platform: string;
  osRelease: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  memTotal: number;
  memUsed: number;
  memFree: number;
  diskTotal: number;
  diskUsed: number;
  diskFree: number;
  loadAvg: number[];
  sysUptime: number;
  processUptime: number;
  nodeVersion: string;
  pid: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0B";
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分钟`;
  return `${m} 分钟`;
}

function getPlatformLabel(p: string): string {
  const labels: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
  return labels[p] ?? p;
}

export function StatusPage() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null);

  useEffect(() => {
    loadStatus();
    loadSystemInfo();
    const interval = setInterval(() => { loadStatus(); loadSystemInfo(); }, 10000);
    return () => clearInterval(interval);
  }, []);

  async function loadStatus() {
    const data = await api.getStatus();
    setStatus(data as StatusData);
  }

  async function loadSystemInfo() {
    try {
      const data = await api.getSystemInfo();
      setSysInfo(data);
    } catch { /* ignore */ }
  }

  if (!status) return <div className="text-stone-400">加载中...</div>;

  const memPct = sysInfo ? Math.round((sysInfo.memUsed / sysInfo.memTotal) * 100) : 0;
  const diskPct = sysInfo && sysInfo.diskTotal > 0 ? Math.round((sysInfo.diskUsed / sysInfo.diskTotal) * 100) : 0;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-stone-800">系统状态</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Device Info */}
        {sysInfo && (
          <div className="bg-white rounded-xl border border-stone-200 p-6 md:col-span-2">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-medium text-stone-500">运行设备</h3>
              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium bg-green-50 text-green-700">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                运行中
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-6">
              <div>
                <p className="text-xs text-stone-400 mb-1">主机名</p>
                <p className="text-base font-semibold text-stone-800">{sysInfo.hostname}</p>
              </div>
              <div>
                <p className="text-xs text-stone-400 mb-1">操作系统</p>
                <p className="text-base font-semibold text-stone-800">
                  {getPlatformLabel(sysInfo.platform)} ({sysInfo.arch})
                </p>
              </div>
              <div>
                <p className="text-xs text-stone-400 mb-1">Node.js</p>
                <p className="text-base font-semibold text-stone-800">{sysInfo.nodeVersion}</p>
              </div>
              <div>
                <p className="text-xs text-stone-400 mb-1">进程 PID</p>
                <p className="text-base font-semibold text-stone-800">{sysInfo.pid}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-6">
              <div>
                <p className="text-xs text-stone-400 mb-1">CPU</p>
                <p className="text-sm font-medium text-stone-700">{sysInfo.cpuModel}</p>
                <p className="text-xs text-stone-400 mt-0.5">{sysInfo.cpuCores} 核</p>
              </div>
              <div>
                <p className="text-xs text-stone-400 mb-1">系统负载 (1/5/15min)</p>
                <p className="text-sm font-medium text-stone-700">
                  {sysInfo.loadAvg.map((l) => l.toFixed(2)).join(" / ")}
                </p>
              </div>
              <div>
                <p className="text-xs text-stone-400 mb-1">系统运行时间</p>
                <p className="text-sm font-medium text-stone-700">{formatUptime(sysInfo.sysUptime)}</p>
              </div>
              <div>
                <p className="text-xs text-stone-400 mb-1">管家运行时间</p>
                <p className="text-sm font-medium text-stone-700">{formatUptime(sysInfo.processUptime)}</p>
              </div>
            </div>

            {/* Memory & Disk bars */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-stone-500">内存</span>
                  <span className="text-xs text-stone-500">
                    {formatBytes(sysInfo.memUsed)} / {formatBytes(sysInfo.memTotal)} ({memPct}%)
                  </span>
                </div>
                <div className="w-full h-2.5 bg-stone-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${memPct > 85 ? "bg-red-400" : memPct > 60 ? "bg-amber-400" : "bg-green-400"}`}
                    style={{ width: `${memPct}%` }}
                  />
                </div>
              </div>
              {sysInfo.diskTotal > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs text-stone-500">磁盘</span>
                    <span className="text-xs text-stone-500">
                      {formatBytes(sysInfo.diskUsed)} / {formatBytes(sysInfo.diskTotal)} ({diskPct}%)
                    </span>
                  </div>
                  <div className="w-full h-2.5 bg-stone-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${diskPct > 90 ? "bg-red-400" : diskPct > 70 ? "bg-amber-400" : "bg-green-400"}`}
                      style={{ width: `${diskPct}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* LLM Status */}
        <div className="bg-white rounded-xl border border-stone-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-stone-500">LLM 模型</h3>
            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium bg-green-50 text-green-700">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              可用
            </span>
          </div>
          <p className="text-lg font-semibold text-stone-800">{status.llm.model}</p>
          <p className="text-sm text-stone-500 mt-1">{status.llm.baseUrl}</p>
        </div>

        {/* Token Usage */}
        <div className="bg-white rounded-xl border border-stone-200 p-6">
          <h3 className="text-sm font-medium text-stone-500 mb-4">今日 Token 用量</h3>
          <div className="flex gap-8">
            <div>
              <p className="text-2xl font-bold text-stone-800">{status.tokenUsage.promptTokens.toLocaleString()}</p>
              <p className="text-xs text-stone-400 mt-1">Prompt</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-stone-800">{status.tokenUsage.completionTokens.toLocaleString()}</p>
              <p className="text-xs text-stone-400 mt-1">Completion</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-amber-600">
                {(status.tokenUsage.promptTokens + status.tokenUsage.completionTokens).toLocaleString()}
              </p>
              <p className="text-xs text-stone-400 mt-1">总计</p>
            </div>
          </div>
        </div>

        {/* WeChat Channels */}
        <div className="bg-white rounded-xl border border-stone-200 p-6">
          <h3 className="text-sm font-medium text-stone-500 mb-4">微信通道</h3>
          {Object.entries(status.channels).length === 0 ? (
            <p className="text-sm text-stone-400">暂无通道连接</p>
          ) : (
            Object.entries(status.channels).map(([id, ch]) => (
              <div key={id} className="flex items-center justify-between py-2">
                <span className="text-sm text-stone-700">{id}</span>
                <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${
                  ch.connected ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${ch.connected ? "bg-green-500" : "bg-red-500"}`} />
                  {ch.connected ? `${ch.connectedMembers}/${ch.totalMembers} 在线` : "离线"}
                </span>
              </div>
            ))
          )}
        </div>

        {/* System */}
        <div className="bg-white rounded-xl border border-stone-200 p-6">
          <h3 className="text-sm font-medium text-stone-500 mb-4">系统信息</h3>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-stone-500">初始设置</span>
              <span className={status.setupCompleted ? "text-green-600" : "text-amber-600"}>
                {status.setupCompleted ? "已完成" : "未完成"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-stone-500">运行环境</span>
              <span className="text-stone-700">{sysInfo ? `Node.js ${sysInfo.nodeVersion}` : "Node.js"}</span>
            </div>
            {sysInfo && (
              <>
                <div className="flex justify-between">
                  <span className="text-stone-500">运行设备</span>
                  <span className="text-stone-700">{sysInfo.hostname}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-stone-500">管家 PID</span>
                  <span className="text-stone-700">{sysInfo.pid}</span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
