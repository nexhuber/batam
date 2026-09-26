import { readFileSync } from 'node:fs';

const [path, timezone] = process.argv.slice(2);
if (!['UTC', 'Asia/Ho_Chi_Minh'].includes(timezone)) throw new Error('Unsupported cron timezone');
const jobs = JSON.parse(readFileSync(path, 'utf8'));
const ids = new Set();
for (const job of jobs) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(job.id) || ids.has(job.id)) throw new Error('Invalid or duplicate cron ID');
  ids.add(job.id);
  if (job.timezone !== 'Asia/Ho_Chi_Minh') throw new Error('Unsupported job timezone');
  for (const value of [job.schedule, job.utcSchedule]) {
    if (typeof value !== 'string' || !/^[\d*,/\-]+(?: [\d*,/\-]+){4}$/.test(value)) throw new Error('Invalid cron expression');
  }
  console.log(`${timezone === 'UTC' ? job.utcSchedule : job.schedule}\t${job.id}`);
}
