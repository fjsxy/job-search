const MINUTE_MS = 60_000;
const BEIJING_TIME = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const SYSTEM_CLOCK = { now: Date.now, setTimeout, clearTimeout };

export function startSearchSchedule(search, clock = SYSTEM_CLOCK) {
  let timer;

  function check() {
    const now = clock.now();
    const { year, month, day, hour, minute } = Object.fromEntries(
      BEIJING_TIME.formatToParts(now).map(({ type, value }) => [type, value]),
    );
    try {
      // 启动或唤醒后只看北京当天，错过的历史日期直接跳过。
      if (Number(hour) * 60 + Number(minute) >= 9 * 60 + 30) {
        search.start({ scheduledDate: `${year}-${month}-${day}` });
      }
    } catch (error) {
      console.error('检查定时搜索失败', error);
    }
    // 对齐下一分钟，定期检查实际时钟，避免休眠或系统校时后按旧时间触发。
    timer = clock.setTimeout(check, MINUTE_MS - now % MINUTE_MS);
  }

  check();
  return () => clock.clearTimeout(timer);
}
