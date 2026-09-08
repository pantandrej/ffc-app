-- ============================================================================
-- FANTASYСТА — Модуль 33. Блокировка сета — по клубу, не по всему туру
-- Раньше весь тур блокировался в момент ПЕРВОГО матча (любого клуба, любой
-- лиги) — начиная с этого момента сет было нельзя трогать вообще, хотя
-- 90% выбранных клубов ещё даже не играли. Теперь блокируется КАЖДЫЙ клуб
-- отдельно, в момент его собственного матча (первого, если их несколько за
-- тур — см. модуль 34 про суммирование результатов при двух матчах).
-- Клубы, которые ещё не играли, можно менять/переставлять Джокера в любой
-- момент тура, вплоть до их собственного матча.
-- ============================================================================

DROP POLICY IF EXISTS user_lineups_self_write ON public.user_lineups;
CREATE POLICY user_lineups_self_write ON public.user_lineups
  FOR ALL TO authenticated
  USING (
    profile_id = auth.uid()
    AND NOT EXISTS (
      SELECT 1
      FROM public.gameweeks gw
      JOIN public.club_fixtures cf
        ON (cf.home_club_id = user_lineups.club_id OR cf.away_club_id = user_lineups.club_id)
        AND cf.kickoff_at >= gw.starts_on::timestamptz
        AND cf.kickoff_at < (gw.ends_on::timestamptz + INTERVAL '1 day')
      WHERE gw.id = user_lineups.gameweek_id
        AND gw.starts_on IS NOT NULL
        AND cf.kickoff_at <= now()
    )
  )
  WITH CHECK (
    profile_id = auth.uid()
    AND NOT EXISTS (
      SELECT 1
      FROM public.gameweeks gw
      JOIN public.club_fixtures cf
        ON (cf.home_club_id = user_lineups.club_id OR cf.away_club_id = user_lineups.club_id)
        AND cf.kickoff_at >= gw.starts_on::timestamptz
        AND cf.kickoff_at < (gw.ends_on::timestamptz + INTERVAL '1 day')
      WHERE gw.id = user_lineups.gameweek_id
        AND gw.starts_on IS NOT NULL
        AND cf.kickoff_at <= now()
    )
  );

NOTIFY pgrst, 'reload schema';
