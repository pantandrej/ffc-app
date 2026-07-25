-- ============================================================================
-- FANTASYСТА — Модуль 3. RLS для регистрации/вступления в команды
-- Дополняет Модуль 2: там для teams/team_members были только SELECT-политики,
-- создать команду или вступить в неё было физически нельзя ни одним ключом,
-- кроме service_role. Этот скрипт открывает ровно то, что нужно для экрана
-- регистрации команды — без инвайт-кодов, "открытые" (< 3 человек) команды
-- виден всем и можно вступить в один клик.
-- Выполнять в Supabase SQL Editor ПОСЛЕ Модуля 2.
-- ============================================================================

-- Создать команду может любой авторизованный, но только указывая себя автором.
DROP POLICY IF EXISTS teams_authenticated_insert ON public.teams;
CREATE POLICY teams_authenticated_insert ON public.teams
  FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

-- Вступить в команду — добавить СЕБЯ в team_members. Лимит в 3 человека
-- и так проверяет триггер trg_enforce_team_member_limit из Модуля 2.
DROP POLICY IF EXISTS team_members_self_insert ON public.team_members;
CREATE POLICY team_members_self_insert ON public.team_members
  FOR INSERT TO authenticated
  WITH CHECK (profile_id = auth.uid());

-- Выйти из команды — убрать себя из team_members.
DROP POLICY IF EXISTS team_members_self_delete ON public.team_members;
CREATE POLICY team_members_self_delete ON public.team_members
  FOR DELETE TO authenticated
  USING (profile_id = auth.uid());

GRANT INSERT ON public.teams TO authenticated;
GRANT INSERT, DELETE ON public.team_members TO authenticated;

-- Не было в исходном ТЗ, но без этого один человек может незаметно вступить
-- сразу в несколько команд через прямой запрос к API (мимо интерфейса) —
-- вся игровая логика (баланс, пул, капитан) рассчитана на "1 человек = 1 команда".
CREATE OR REPLACE FUNCTION public.enforce_single_team_membership()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.team_members WHERE profile_id = NEW.profile_id) THEN
    RAISE EXCEPTION 'Вы уже состоите в другой команде — сначала выйдите из неё';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_single_team_membership ON public.team_members;
CREATE TRIGGER trg_enforce_single_team_membership
  BEFORE INSERT ON public.team_members
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_single_team_membership();

NOTIFY pgrst, 'reload schema';
