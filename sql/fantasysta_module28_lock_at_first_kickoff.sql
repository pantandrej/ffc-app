-- ============================================================================
-- FANTASYСТА — Модуль 28. Блокировка сета — по первому матчу тура, не по дате
-- Раньше сет блокировался в полночь дня starts_on (весь день пятницы уже был
-- заблокирован, хотя первый матч мог быть вечером). Теперь порог — момент
-- kickoff_at САМОГО РАННЕГО матча тура (по всем 5 лигам), который лежит в
-- club_fixtures в датах тура. Если матч потом перенесут (kickoff_at
-- обновится триггером mark_club_fixture_postponed), порог сам сдвинется.
-- Если на тур ещё не занесли календарь — откатываемся на старое правило
-- (начало дня starts_on), чтобы не открыть сет без ограничений по ошибке.
-- ============================================================================

DROP POLICY IF EXISTS user_lineups_self_write ON public.user_lineups;
CREATE POLICY user_lineups_self_write ON public.user_lineups
  FOR ALL TO authenticated
  USING (
    profile_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.gameweeks gw
      WHERE gw.id = user_lineups.gameweek_id
        AND (
          gw.starts_on IS NULL
          OR now() < COALESCE(
               (SELECT MIN(cf.kickoff_at) FROM public.club_fixtures cf
                WHERE cf.kickoff_at >= gw.starts_on::timestamptz
                  AND cf.kickoff_at < (gw.ends_on::timestamptz + INTERVAL '1 day')),
               gw.starts_on::timestamptz
             )
        )
    )
  )
  WITH CHECK (
    profile_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.gameweeks gw
      WHERE gw.id = user_lineups.gameweek_id
        AND (
          gw.starts_on IS NULL
          OR now() < COALESCE(
               (SELECT MIN(cf.kickoff_at) FROM public.club_fixtures cf
                WHERE cf.kickoff_at >= gw.starts_on::timestamptz
                  AND cf.kickoff_at < (gw.ends_on::timestamptz + INTERVAL '1 day')),
               gw.starts_on::timestamptz
             )
        )
    )
  );

NOTIFY pgrst, 'reload schema';
