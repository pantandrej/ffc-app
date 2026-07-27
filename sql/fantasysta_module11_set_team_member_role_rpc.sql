-- ============================================================================
-- FANTASYСТА — Модуль 11. RPC для смены ролей участников (замена Модуля 10)
--
-- Почему не просто UPDATE через RLS-политику из Модуля 10: передача
-- капитанства требует ДВУХ изменений (старый капитан теряет роль, новый
-- получает) — если делать их двумя отдельными supabase.from().update()
-- вызовами, это ДВЕ разные транзакции: после первого вызова капитан уже
-- теряет право менять роли, и второй вызов упадёт по RLS. Атомарный upsert
-- (INSERT ... ON CONFLICT) тоже не годится — БДшный триггер
-- enforce_single_team_membership (Модуль 3) неверно ф03. блокирует
-- переустановку роли в СВОЕЙ ЖЕ команде, т.к. срабатывает на INSERT-путь
-- до проверки конфликта. Решение — одна SECURITY DEFINER функция, которая
-- делает обе UPDATE внутри одной транзакции и сама проверяет права.
-- Выполнять в Supabase SQL Editor ПОСЛЕ Модуля 9 (Модуль 10 можно пропустить).
-- ============================================================================

-- Заодно чиним сам триггер enforce_single_team_membership (Модуль 3): он должен
-- блокировать вступление в ДРУГУЮ команду, а не любой повторный INSERT/upsert
-- для уже существующего членства в ТОЙ ЖЕ команде.
CREATE OR REPLACE FUNCTION public.enforce_single_team_membership()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.team_members
    WHERE profile_id = NEW.profile_id AND team_id <> NEW.team_id
  ) THEN
    RAISE EXCEPTION 'Вы уже состоите в другой команде — сначала выйдите из неё';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_team_member_role(p_team_id UUID, p_target_profile_id UUID, p_role TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  is_captain      BOOLEAN;
  team_has_captain BOOLEAN;
BEGIN
  IF p_role IS NOT NULL AND p_role NOT IN ('captain', 'player_1', 'player_2') THEN
    RAISE EXCEPTION 'Недопустимая роль: %', p_role;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.team_members WHERE team_id = p_team_id AND profile_id = auth.uid()) THEN
    RAISE EXCEPTION 'Ты не состоишь в этой команде';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.team_members WHERE team_id = p_team_id AND profile_id = auth.uid() AND role_in_team = 'captain'
  ) INTO is_captain;
  SELECT EXISTS (
    SELECT 1 FROM public.team_members WHERE team_id = p_team_id AND role_in_team = 'captain'
  ) INTO team_has_captain;

  -- Пока в команде вообще нет капитана (например, старое членство до этой
  -- фичи) — ролями может распоряжаться любой участник, чтобы не зависнуть.
  IF NOT is_captain AND team_has_captain THEN
    RAISE EXCEPTION 'Только капитан команды может менять роли участников';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.team_members WHERE team_id = p_team_id AND profile_id = p_target_profile_id) THEN
    RAISE EXCEPTION 'Этот пользователь не состоит в команде';
  END IF;

  IF p_role IS NOT NULL THEN
    UPDATE public.team_members
    SET role_in_team = NULL
    WHERE team_id = p_team_id AND role_in_team = p_role AND profile_id <> p_target_profile_id;
  END IF;

  UPDATE public.team_members
  SET role_in_team = p_role
  WHERE team_id = p_team_id AND profile_id = p_target_profile_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_team_member_role(UUID, UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
