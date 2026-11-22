CREATE OR REPLACE FUNCTION apply_standard_policies (target_table TEXT) returns void AS $$
BEGIN
    -- enable row level security
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', target_table);

    -- drop and create the updated_at trigger
    EXECUTE format('DROP TRIGGER IF EXISTS %I_set_updated_at ON %I;', target_table, target_table);
    EXECUTE format('CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at();', target_table, target_table);

    -- drop existing policies to prevent conflicts
    EXECUTE format('DROP POLICY IF EXISTS %I_select_scope ON %I;', target_table, target_table);
    EXECUTE format('DROP POLICY IF EXISTS %I_insert_scope ON %I;', target_table, target_table);
    EXECUTE format('DROP POLICY IF EXISTS %I_update_scope ON %I;', target_table, target_table);
    EXECUTE format('DROP POLICY IF EXISTS %I_delete_scope ON %I;', target_table, target_table);

    -- create select, insert, update, delete policies
    EXECUTE format('CREATE POLICY %I_select_scope ON %I FOR SELECT TO authenticated USING (user_id = uid());', target_table, target_table);
    EXECUTE format('CREATE POLICY %I_insert_scope ON %I FOR INSERT TO authenticated WITH CHECK (user_id = uid());', target_table, target_table);
    EXECUTE format('CREATE POLICY %I_update_scope ON %I FOR UPDATE TO authenticated USING (user_id = uid()) WITH CHECK (user_id = uid());', target_table, target_table);
    EXECUTE format('CREATE POLICY %I_delete_scope ON %I FOR DELETE TO authenticated USING (user_id = uid());', target_table, target_table);
END;
$$ language plpgsql;

GRANT USAGE ON schema public TO anon, authenticated;

GRANT SELECT ON users TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON
    monitors,
    monitor_runs,
    notification_config,
    user_settings TO authenticated;


SELECT
    apply_standard_policies ('monitors');

SELECT
    apply_standard_policies ('monitor_runs');

SELECT
    apply_standard_policies ('notification_config');

SELECT
    apply_standard_policies ('user_settings');

--------------------------------------------------------------------------------
-- Evidence and agent state: captures, changes, monitor_state, macros,
-- run_steps, provider_connections, monitor_secrets
--
-- Services and server code write these; owners read them. Owners may update
-- only the feedback columns granted below. secrets, virtual_keys and
-- digest_items are server-only and get no grants at all.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_owner_read_policies (target_table TEXT) returns void AS $$
BEGIN
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', target_table);

    EXECUTE format('DROP TRIGGER IF EXISTS %I_set_updated_at ON %I;', target_table, target_table);
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = target_table AND column_name = 'updated_at'
    ) THEN
        EXECUTE format('CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at();', target_table, target_table);
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS %I_select_scope ON %I;', target_table, target_table);
    EXECUTE format('DROP POLICY IF EXISTS %I_update_scope ON %I;', target_table, target_table);

    EXECUTE format('CREATE POLICY %I_select_scope ON %I FOR SELECT TO authenticated USING (user_id = uid());', target_table, target_table);
    -- Column grants decide what an update may touch; the policy decides which rows.
    EXECUTE format('CREATE POLICY %I_update_scope ON %I FOR UPDATE TO authenticated USING (user_id = uid()) WITH CHECK (user_id = uid());', target_table, target_table);
END;
$$ language plpgsql;

GRANT SELECT ON
    captures,
    changes,
    monitor_state,
    macros,
    run_steps,
    provider_connections,
    monitor_secrets TO authenticated;

GRANT UPDATE (user_feedback, viewed_at) ON changes TO authenticated;

SELECT
    apply_owner_read_policies ('captures');

SELECT
    apply_owner_read_policies ('changes');

SELECT
    apply_owner_read_policies ('monitor_state');

SELECT
    apply_owner_read_policies ('macros');

SELECT
    apply_owner_read_policies ('run_steps');

SELECT
    apply_owner_read_policies ('provider_connections');

SELECT
    apply_owner_read_policies ('monitor_secrets');

ALTER TABLE secrets ENABLE ROW LEVEL SECURITY;

ALTER TABLE virtual_keys ENABLE ROW LEVEL SECURITY;

ALTER TABLE digest_items ENABLE ROW LEVEL SECURITY;
