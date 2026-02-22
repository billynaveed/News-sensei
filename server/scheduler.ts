import cron, { type ScheduledTask } from 'node-cron';
import { storage } from './storage';
import { scanForLeads } from './scanner';
import { scanForIpoFilings } from './ipo-scanner';

let hourlyTask: ScheduledTask | null = null;
let dailyTask: ScheduledTask | null = null;
let weeklyTask: ScheduledTask | null = null;
let ipoTask: ScheduledTask | null = null;

/**
 * Starts the scan scheduler based on current settings
 */
export async function startScheduler(): Promise<void> {
  console.log('Starting scan scheduler...');

  // Stop any existing tasks
  stopScheduler();

  const settings = await storage.getSettings();
  if (!settings) {
    console.log('No settings found, scheduler not started');
    return;
  }

  const frequency = settings.scanFrequency || 'manual';

  if (frequency === 'manual') {
    console.log('Scan frequency set to manual, scheduler not started');
    return;
  }

  // Always schedule IPO scan every 2 hours
  ipoTask = cron.schedule('0 */2 * * *', async () => {
    console.log('Running scheduled IPO scan...');
    try {
      const result = await scanForIpoFilings();
      console.log(`IPO scan complete: ${result.newFilings} new filings found`);
    } catch (error) {
      console.error('Error in scheduled IPO scan:', error);
    }
  });
  console.log('IPO scan scheduler started (runs every 2 hours)');

  console.log(`Configuring scheduler for ${frequency} scans`);

  switch (frequency) {
    case 'hourly':
      // Run at the start of every hour
      hourlyTask = cron.schedule('0 * * * *', async () => {
        console.log('Running scheduled hourly scan...');
        try {
          const result = await scanForLeads();
          console.log(`Hourly scan complete: ${result.newLeads} new leads found`);
        } catch (error) {
          console.error('Error in scheduled hourly scan:', error);
        }
      });
      console.log('Hourly scan scheduler started (runs at :00 of every hour)');
      break;

    case 'daily':
      // Run every day at 9:00 AM
      dailyTask = cron.schedule('0 9 * * *', async () => {
        console.log('Running scheduled daily scan...');
        try {
          const result = await scanForLeads();
          console.log(`Daily scan complete: ${result.newLeads} new leads found`);
        } catch (error) {
          console.error('Error in scheduled daily scan:', error);
        }
      });
      console.log('Daily scan scheduler started (runs at 9:00 AM every day)');
      break;

    case 'weekly':
      // Run every Monday at 9:00 AM
      weeklyTask = cron.schedule('0 9 * * 1', async () => {
        console.log('Running scheduled weekly scan...');
        try {
          const result = await scanForLeads();
          console.log(`Weekly scan complete: ${result.newLeads} new leads found`);
        } catch (error) {
          console.error('Error in scheduled weekly scan:', error);
        }
      });
      console.log('Weekly scan scheduler started (runs at 9:00 AM every Monday)');
      break;
  }
}

/**
 * Stops all running scheduled tasks
 */
export function stopScheduler(): void {
  if (hourlyTask) {
    hourlyTask.stop();
    hourlyTask = null;
  }
  if (dailyTask) {
    dailyTask.stop();
    dailyTask = null;
  }
  if (weeklyTask) {
    weeklyTask.stop();
    weeklyTask = null;
  }
  if (ipoTask) {
    ipoTask.stop();
    ipoTask = null;
  }
}

/**
 * Restarts the scheduler with updated settings
 */
export async function restartScheduler(): Promise<void> {
  console.log('Restarting scheduler with updated settings...');
  await startScheduler();
}
