// "Текущий" тур — не просто самый новый по id (туры заводятся заранее с
// датами), а последний из тех, что уже начались. Пока ни один не начался —
// самый первый.
export function pickCurrentGameweek(gameweeks, today = new Date()) {
  if (!gameweeks || gameweeks.length === 0) return null;
  const todayStr = today.toISOString().slice(0, 10);
  const started = gameweeks.filter(g => g.starts_on && g.starts_on <= todayStr);
  if (started.length === 0) return gameweeks[0];
  return started[started.length - 1];
}
