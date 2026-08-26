-- ============================================================================
-- FANTASYСТА — Модуль 23. Подтягиваем настоящие имена из VK вместо vk{id}
-- vk-auth (Edge Function) уже сохраняет "Имя Фамилия" из VK в
-- auth.users.raw_user_meta_data->>'full_name' при каждом входе — просто
-- никогда не переносили это в fantasysta_profiles.username.
-- ============================================================================

-- 23.1 Разовый backfill: только для профилей, у которых username до сих пор
-- нетронутый синтетический "vk123456" (совпадает с локальной частью email) —
-- чтобы не перезаписать ручные переименования (Гаптузо, Клаудиньо и т.п.)
-- и не задеть обычные email-аккаунты.
UPDATE public.fantasysta_profiles fp
SET username = sub.full_name
FROM (
  SELECT au.id, trim(au.raw_user_meta_data->>'full_name') AS full_name
  FROM auth.users au
  WHERE au.raw_user_meta_data->>'full_name' IS NOT NULL
    AND trim(au.raw_user_meta_data->>'full_name') <> ''
) sub
WHERE fp.id = sub.id
  AND fp.username ~ '^vk[0-9]+$'
  AND NOT EXISTS (
    SELECT 1 FROM public.fantasysta_profiles fp2
    WHERE fp2.username = sub.full_name AND fp2.id <> fp.id
  );

-- 23.2 На будущее: при первом входе профиль сразу создаётся с именем из VK,
-- а не с vk{id} (email-логины — без изменений, как раньше).
CREATE OR REPLACE FUNCTION public.handle_new_fantasysta_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  vk_full_name  TEXT := NULLIF(trim(NEW.raw_user_meta_data->>'full_name'), '');
  base_username TEXT := COALESCE(vk_full_name, split_part(NEW.email, '@', 1));
BEGIN
  INSERT INTO public.fantasysta_profiles (id, username)
  VALUES (NEW.id, base_username);
  RETURN NEW;
EXCEPTION WHEN unique_violation THEN
  INSERT INTO public.fantasysta_profiles (id, username)
  VALUES (NEW.id, base_username || '_' || substr(NEW.id::text, 1, 6));
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
