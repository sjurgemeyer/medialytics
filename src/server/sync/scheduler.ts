import type { SyncService } from './service.js';

// Runs a sync now and then every `intervalMinutes`; 0 disables the timer (sync only on request)
export const startSyncSchedule = (sync: SyncService, intervalMinutes: number): (() => void) => {
    void sync.run();
    if (intervalMinutes <= 0) return () => undefined;
    const timer = setInterval(() => {
        if (!sync.isRunning()) void sync.run();
    }, intervalMinutes * 60_000);
    timer.unref();
    return () => clearInterval(timer);
};
