/**
 * System metrics collector for reiwa.
 *
 * Produces the SAME `SystemHealthResponse` shape as rezeis-admin's
 * `SystemHealthService`, so the admin dashboard can render reiwa's host +
 * process metrics with the exact same widget. Ported from
 * rezeis-admin/src/modules/dashboard/services/system-health.service.ts.
 *
 * Linux uses `/proc` + `df`; non-Linux falls back gracefully. CPU usage is a
 * delta between successive calls (module-level state) — the first call after
 * boot reports 0% and stabilises once the admin starts polling.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';

export interface CpuCoreInfo {
  readonly core: number;
  readonly usagePercent: number;
}

export interface NetworkInterfaceSnapshot {
  readonly name: string;
  readonly rxBytes: number;
  readonly txBytes: number;
}

export interface VpsHealthSnapshot {
  readonly cpuUsagePercent: number;
  readonly cpuCores: readonly CpuCoreInfo[];
  readonly cpuCoreCount: number;
  readonly cpuModel: string;
  readonly ramUsedBytes: number;
  readonly ramTotalBytes: number;
  readonly ramUsagePercent: number;
  readonly diskUsedBytes: number;
  readonly diskTotalBytes: number;
  readonly diskUsagePercent: number;
  readonly uptimeSeconds: number;
  readonly loadAverage: readonly [number, number, number];
  readonly network: readonly NetworkInterfaceSnapshot[];
}

export interface ProcessHealthSnapshot {
  readonly cpuUsagePercent: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly heapTotalBytes: number;
  readonly externalBytes: number;
  readonly uptimeSeconds: number;
  readonly nodeVersion: string;
  readonly pid: number;
  readonly eventLoopLagMs: number;
}

export interface SystemHealthResponse {
  readonly timestamp: string;
  readonly vps: VpsHealthSnapshot;
  readonly process: ProcessHealthSnapshot;
}

// ── CPU delta state (module-level; reiwa is a single process) ────────────────
let previousCpuTimes: { idle: number; total: number }[] = [];
let previousCpuTimestamp = 0;

export async function collectSystemHealth(): Promise<SystemHealthResponse> {
  const [vps, processHealth] = await Promise.all([getVpsHealth(), getProcessHealth()]);
  return { timestamp: new Date().toISOString(), vps, process: processHealth };
}

async function getVpsHealth(): Promise<VpsHealthSnapshot> {
  const cpuCores = getCpuUsage();
  const cpuUsagePercent =
    cpuCores.length > 0
      ? Math.round((cpuCores.reduce((s, c) => s + c.usagePercent, 0) / cpuCores.length) * 10) / 10
      : 0;

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const disk = getDiskUsage();
  const loadAvg = os.loadavg() as [number, number, number];
  const network = getNetworkStats();
  const cpuInfo = os.cpus();

  return {
    cpuUsagePercent,
    cpuCores,
    cpuCoreCount: cpuInfo.length,
    cpuModel: cpuInfo[0]?.model ?? 'Unknown',
    ramUsedBytes: usedMem,
    ramTotalBytes: totalMem,
    ramUsagePercent: Math.round((usedMem / totalMem) * 1000) / 10,
    diskUsedBytes: disk.used,
    diskTotalBytes: disk.total,
    diskUsagePercent: disk.total > 0 ? Math.round((disk.used / disk.total) * 1000) / 10 : 0,
    uptimeSeconds: Math.floor(os.uptime()),
    loadAverage: [
      Math.round(loadAvg[0] * 100) / 100,
      Math.round(loadAvg[1] * 100) / 100,
      Math.round(loadAvg[2] * 100) / 100,
    ],
    network,
  };
}

async function getProcessHealth(): Promise<ProcessHealthSnapshot> {
  const memUsage = process.memoryUsage();
  const cpuUsage = process.cpuUsage();
  const eventLoopLagMs = await measureEventLoopLag();

  const totalCpuMicroseconds = cpuUsage.user + cpuUsage.system;
  const uptimeMs = process.uptime() * 1000;
  const cpuPercent =
    uptimeMs > 0 ? Math.round((totalCpuMicroseconds / 1000 / uptimeMs) * 1000) / 10 : 0;

  return {
    cpuUsagePercent: Math.min(cpuPercent, 100),
    rssBytes: memUsage.rss,
    heapUsedBytes: memUsage.heapUsed,
    heapTotalBytes: memUsage.heapTotal,
    externalBytes: memUsage.external,
    uptimeSeconds: Math.floor(process.uptime()),
    nodeVersion: process.version,
    pid: process.pid,
    eventLoopLagMs,
  };
}

function getCpuUsage(): CpuCoreInfo[] {
  const cpus = os.cpus();
  const now = Date.now();
  const currentTimes = cpus.map((cpu) => {
    const t = cpu.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });

  if (previousCpuTimes.length === 0 || now - previousCpuTimestamp < 50) {
    previousCpuTimes = currentTimes;
    previousCpuTimestamp = now;
    return cpus.map((_, i) => ({ core: i, usagePercent: 0 }));
  }

  const result: CpuCoreInfo[] = cpus.map((_, i) => {
    const prev = previousCpuTimes[i];
    const curr = currentTimes[i];
    if (!prev || !curr) return { core: i, usagePercent: 0 };
    const totalDelta = curr.total - prev.total;
    const idleDelta = curr.idle - prev.idle;
    if (totalDelta === 0) return { core: i, usagePercent: 0 };
    const usage = ((totalDelta - idleDelta) / totalDelta) * 100;
    return { core: i, usagePercent: Math.round(usage * 10) / 10 };
  });

  previousCpuTimes = currentTimes;
  previousCpuTimestamp = now;
  return result;
}

function getDiskUsage(): { used: number; total: number } {
  try {
    if (process.platform === 'win32') {
      const output = execSync('wmic logicaldisk get size,freespace /format:csv', {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const lines = output.trim().split('\n').filter((l) => l.trim().length > 0);
      let totalSize = 0;
      let totalFree = 0;
      for (const line of lines.slice(1)) {
        const parts = line.trim().split(',');
        if (parts.length >= 3) {
          const free = Number.parseInt(parts[1] ?? '', 10);
          const size = Number.parseInt(parts[2] ?? '', 10);
          if (!Number.isNaN(free) && !Number.isNaN(size) && size > 0) {
            totalFree += free;
            totalSize += size;
          }
        }
      }
      return { used: totalSize - totalFree, total: totalSize };
    }

    const output = execSync('df -B1 / | tail -1', { encoding: 'utf-8', timeout: 5000 });
    const parts = output.trim().split(/\s+/);
    const total = Number.parseInt(parts[1] ?? '', 10);
    const used = Number.parseInt(parts[2] ?? '', 10);
    if (!Number.isNaN(total) && !Number.isNaN(used)) return { used, total };
  } catch {
    // fall through to zeros
  }
  return { used: 0, total: 0 };
}

function getNetworkStats(): NetworkInterfaceSnapshot[] {
  try {
    if (process.platform === 'linux') {
      const content = readFileSync('/proc/net/dev', 'utf-8');
      const lines = content.split('\n').slice(2);
      const interfaces: NetworkInterfaceSnapshot[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [name, ...stats] = trimmed.split(/[:\s]+/);
        if (!name || name === 'lo') continue;
        const rxBytes = Number.parseInt(stats[0] ?? '', 10);
        const txBytes = Number.parseInt(stats[8] ?? '', 10);
        if (!Number.isNaN(rxBytes) && !Number.isNaN(txBytes)) {
          interfaces.push({ name, rxBytes, txBytes });
        }
      }
      return interfaces;
    }
  } catch {
    // fall through to interface names
  }

  const netInterfaces = os.networkInterfaces();
  return Object.keys(netInterfaces)
    .filter((name) => name !== 'lo')
    .map((name) => ({ name, rxBytes: 0, txBytes: 0 }));
}

function measureEventLoopLag(): Promise<number> {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    setImmediate(() => {
      const end = process.hrtime.bigint();
      const lagNs = Number(end - start);
      resolve(Math.round((lagNs / 1_000_000) * 100) / 100);
    });
  });
}
