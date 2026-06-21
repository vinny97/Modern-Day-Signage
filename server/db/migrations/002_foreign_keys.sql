-- Enforce new relational writes without rejecting historical imports that may
-- still contain orphan rows. Validate these constraints after the orphan audit.
CREATE OR REPLACE FUNCTION screentinker_add_fk(
  constraint_name text, source_table regclass, source_column text,
  target_table regclass, target_column text, delete_action text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = constraint_name) THEN
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %s(%I) ON DELETE %s NOT VALID',
      source_table, constraint_name, source_column, target_table, target_column, delete_action
    );
  END IF;
END;
$$;

SELECT screentinker_add_fk('fk_org_members_org', 'organization_members', 'organization_id', 'organizations', 'id', 'CASCADE');
SELECT screentinker_add_fk('fk_org_members_user', 'organization_members', 'user_id', 'users', 'id', 'CASCADE');
SELECT screentinker_add_fk('fk_workspaces_org', 'workspaces', 'organization_id', 'organizations', 'id', 'CASCADE');
SELECT screentinker_add_fk('fk_workspace_members_workspace', 'workspace_members', 'workspace_id', 'workspaces', 'id', 'CASCADE');
SELECT screentinker_add_fk('fk_workspace_members_user', 'workspace_members', 'user_id', 'users', 'id', 'CASCADE');
SELECT screentinker_add_fk('fk_devices_workspace', 'devices', 'workspace_id', 'workspaces', 'id', 'CASCADE');
SELECT screentinker_add_fk('fk_devices_user', 'devices', 'user_id', 'users', 'id', 'SET NULL');
SELECT screentinker_add_fk('fk_content_workspace', 'content', 'workspace_id', 'workspaces', 'id', 'CASCADE');
SELECT screentinker_add_fk('fk_content_user', 'content', 'user_id', 'users', 'id', 'SET NULL');
SELECT screentinker_add_fk('fk_layouts_workspace', 'layouts', 'workspace_id', 'workspaces', 'id', 'CASCADE');
SELECT screentinker_add_fk('fk_layout_zones_layout', 'layout_zones', 'layout_id', 'layouts', 'id', 'CASCADE');
SELECT screentinker_add_fk('fk_widgets_workspace', 'widgets', 'workspace_id', 'workspaces', 'id', 'CASCADE');
SELECT screentinker_add_fk('fk_playlists_workspace', 'playlists', 'workspace_id', 'workspaces', 'id', 'CASCADE');
SELECT screentinker_add_fk('fk_playlist_items_playlist', 'playlist_items', 'playlist_id', 'playlists', 'id', 'CASCADE');
SELECT screentinker_add_fk('fk_playlist_items_content', 'playlist_items', 'content_id', 'content', 'id', 'SET NULL');
SELECT screentinker_add_fk('fk_playlist_items_widget', 'playlist_items', 'widget_id', 'widgets', 'id', 'SET NULL');
SELECT screentinker_add_fk('fk_device_groups_workspace', 'device_groups', 'workspace_id', 'workspaces', 'id', 'CASCADE');
SELECT screentinker_add_fk('fk_group_members_group', 'device_group_members', 'group_id', 'device_groups', 'id', 'CASCADE');
SELECT screentinker_add_fk('fk_group_members_device', 'device_group_members', 'device_id', 'devices', 'id', 'CASCADE');
SELECT screentinker_add_fk('fk_video_walls_workspace', 'video_walls', 'workspace_id', 'workspaces', 'id', 'CASCADE');
SELECT screentinker_add_fk('fk_wall_devices_wall', 'video_wall_devices', 'wall_id', 'video_walls', 'id', 'CASCADE');
SELECT screentinker_add_fk('fk_wall_devices_device', 'video_wall_devices', 'device_id', 'devices', 'id', 'CASCADE');
SELECT screentinker_add_fk('fk_kiosk_pages_workspace', 'kiosk_pages', 'workspace_id', 'workspaces', 'id', 'CASCADE');
SELECT screentinker_add_fk('fk_white_labels_workspace', 'white_labels', 'workspace_id', 'workspaces', 'id', 'CASCADE');

DROP FUNCTION screentinker_add_fk(text, regclass, text, regclass, text, text);
