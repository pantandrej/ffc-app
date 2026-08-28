-- ============================================================================
-- FANTASYСТА — Модуль 24. Запрет менять сет после начала тура
-- Раньше user_lineups_self_write разрешал игроку писать/менять/удалять свой
-- сет в любой момент — можно было докрутить состав уже по ходу тура, глядя на
-- реальные результаты матчей. Теперь редактирование своего сета разрешено,
-- только пока тур ещё не начался (today < gameweeks.starts_on). Админ
-- (user_lineups_admin_write, модуль 20) по-прежнему может править сет любого
-- игрока в любой момент — нужно ботам/подставным аккаунтам.
-- ============================================================================

DROP POLICY IF EXISTS user_lineups_self_write ON public.user_lineups;
CREATE POLICY user_lineups_self_write ON public.user_lineups
  FOR ALL TO authenticated
  USING (
    profile_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.gameweeks gw
      WHERE gw.id = user_lineups.gameweek_id
        AND (gw.starts_on IS NULL OR gw.starts_on > (now() AT TIME ZONE 'Europe/Moscow')::date)
    )
  )
  WITH CHECK (
    profile_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.gameweeks gw
      WHERE gw.id = user_lineups.gameweek_id
        AND (gw.starts_on IS NULL OR gw.starts_on > (now() AT TIME ZONE 'Europe/Moscow')::date)
    )
  );

NOTIFY pgrst, 'reload schema';
