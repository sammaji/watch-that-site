DO $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;

  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;

CREATE OR REPLACE FUNCTION uid () returns TEXT language sql stable AS $$
  select nullif(current_setting('request.jwt.claims', true)::json->>'user_id', '')
$$;

CREATE OR REPLACE FUNCTION jwt_role () returns TEXT language sql stable AS $$
  select coalesce(nullif(current_setting('request.jwt.claims', true)::json->>'role', ''), 'anon')
$$;

CREATE OR REPLACE FUNCTION set_updated_at () returns trigger language plpgsql AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;
