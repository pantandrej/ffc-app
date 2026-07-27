-- ============================================================================
-- FANTASYСТА — Модуль 10. Капитан назначает роли участников команды
-- Раньше у team_members не было UPDATE-политики вообще (роль нельзя было
-- поменять ни себе, ни другим) — этот модуль её добавляет, но только для
-- капитана команды: он может менять role_in_team любому участнику, включая
-- передачу капитанства. Остальные участники — только просмотр.
-- Выполнять в Supabase SQL Editor ПОСЛЕ Модуля 9.
-- ============================================================================

DROP POLICY IF EXISTS team_members_captain_update_role ON public.team_members;
CREATE POLICY team_members_captain_update_role ON public.team_members
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.team_members captain
      WHERE captain.team_id = team_members.team_id
        AND captain.profile_id = auth.uid()
        AND captain.role_in_team = 'captain'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.team_members captain
      WHERE captain.team_id = team_members.team_id
        AND captain.profile_id = auth.uid()
        AND captain.role_in_team = 'captain'
    )
  );

GRANT UPDATE ON public.team_members TO authenticated;

NOTIFY pgrst, 'reload schema';
