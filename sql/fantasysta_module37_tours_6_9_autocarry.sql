-- ============================================================================
-- FANTASYСТА — Модуль 37. Туры 6-9 заранее + автоперенос состава
-- Туры заведены заранее с реальными датами (тур 6: 14-19 окт, 7: 20-26 окт,
-- 8: 27 окт-2 ноя, 9 (финал групп): 3-8 ноя). Приложение теперь показывает
-- "текущим" последний НАЧАВШИЙСЯ тур (starts_on <= сегодня), а не просто
-- максимальный id — иначе заготовленный тур 9 затмил бы идущий тур.
-- Состав игрока переносится в новый тур автоматически, как только тур
-- начался (раньше это делалось вручную при заведении тура).
-- ============================================================================
INSERT INTO public.gameweeks (id, status, starts_on, ends_on, transfer_deadline) VALUES
  (6, 'upcoming', '2026-10-14', '2026-10-19', '2026-10-14 00:00:00+00'),
  (7, 'upcoming', '2026-10-20', '2026-10-26', '2026-10-20 00:00:00+00'),
  (8, 'upcoming', '2026-10-27', '2026-11-02', '2026-10-27 00:00:00+00'),
  (9, 'upcoming', '2026-11-03', '2026-11-08', '2026-11-03 00:00:00+00')
ON CONFLICT (id) DO UPDATE SET starts_on = excluded.starts_on, ends_on = excluded.ends_on;

CREATE OR REPLACE FUNCTION public.carry_forward_lineups()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  INSERT INTO public.user_lineups (profile_id, gameweek_id, club_id, is_club_captain)
  SELECT p.profile_id, g.id, p.club_id, p.is_club_captain
  FROM public.gameweeks g
  JOIN public.user_lineups p ON p.gameweek_id = g.id - 1
  WHERE g.starts_on <= current_date
    AND NOT EXISTS (
      SELECT 1 FROM public.user_lineups x
      WHERE x.profile_id = p.profile_id AND x.gameweek_id = g.id)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.unschedule('carry_forward_lineups') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='carry_forward_lineups');
SELECT cron.schedule('carry_forward_lineups', '5 * * * *', 'select public.carry_forward_lineups()');
