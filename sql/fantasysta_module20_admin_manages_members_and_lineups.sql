-- ============================================================================
-- FANTASYСТА — Модуль 20. Админ управляет участниками команд и их сетами
-- Нужно для ботов/подставных аккаунтов (ChatGPT, Claude и т.п.), которые не
-- могут сами залогиниться — админ добавляет их в команду и вносит их выбор
-- клубов от их имени.
-- ============================================================================

-- Админ может добавить ЛЮБОГО игрока в ЛЮБУЮ команду (в дополнение к
-- самостоятельному вступлению через team_members_self_insert).
DROP POLICY IF EXISTS team_members_admin_insert ON public.team_members;
CREATE POLICY team_members_admin_insert ON public.team_members
  FOR INSERT TO authenticated
  WITH CHECK (public.is_fantasysta_admin());

DROP POLICY IF EXISTS team_members_admin_delete ON public.team_members;
CREATE POLICY team_members_admin_delete ON public.team_members
  FOR DELETE TO authenticated
  USING (public.is_fantasysta_admin());

-- Админ может писать/менять/удалять сет ЛЮБОГО игрока (в дополнение к
-- самостоятельному управлению своим же сетом через user_lineups_self_write).
DROP POLICY IF EXISTS user_lineups_admin_write ON public.user_lineups;
CREATE POLICY user_lineups_admin_write ON public.user_lineups
  FOR ALL TO authenticated
  USING (public.is_fantasysta_admin())
  WITH CHECK (public.is_fantasysta_admin());

NOTIFY pgrst, 'reload schema';
