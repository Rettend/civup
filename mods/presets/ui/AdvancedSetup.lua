include("PresetModAdvancedSetupOriginal")
include("preset_mod_preset_data")
print("Presets: advanced setup wrapper loaded")

local SP_PRESET_PARAMETER_ID = "PRESET_MOD_MPH_PRESET_SP"
local g_LastAppliedPreset = nil
local g_IsApplyingPreset = false
local g_SharedStateRoot = ExposedMembers
if type(g_SharedStateRoot) ~= "table" then
  ExposedMembers = {}
  g_SharedStateRoot = ExposedMembers
end
local g_GlobalState = g_SharedStateRoot.PresetModAdvancedSetupState
if type(g_GlobalState) ~= "table" then
  g_GlobalState = {}
  g_SharedStateRoot.PresetModAdvancedSetupState = g_GlobalState
end

local function clone_array(values)
  local out = {}
  if type(values) ~= "table" then return out end
  for i, value in ipairs(values) do
    out[i] = value
  end
  return out
end

local function clone_list_map(values)
  local out = {}
  if type(values) ~= "table" then return out end
  for key, value in pairs(values) do
    if type(key) == "string" and key ~= "" then
      if type(value) == "table" then out[key] = clone_array(value)
      else out[key] = value end
    end
  end
  return out
end

local function get_preset_data(preset_id)
  if type(PresetModPresetData) ~= "table" then return nil end
  return PresetModPresetData[preset_id] or PresetModPresetData[tonumber(preset_id)]
end

local function apply_values(values, setter)
  if type(values) ~= "table" then return end
  for key, value in pairs(values) do
    if type(key) == "string" and key ~= "" then
      local ok, err = pcall(function()
        setter(key, value)
      end)
      if not ok then
        print("Presets: failed to apply key '" .. tostring(key) .. "': " .. tostring(err))
      end
    end
  end
end

local function set_map_value(key, value)
  if key == "MAP_SCRIPT" then
    local desired = tostring(value or "")
    if MapConfiguration and MapConfiguration.SetValue then
      local current_value = MapConfiguration.GetValue and MapConfiguration.GetValue("MAP_SCRIPT") or nil
      if tostring(current_value or ""):lower() ~= desired:lower() then
        MapConfiguration.SetValue("MAP_SCRIPT", value)
      end
    end
    if MapConfiguration and MapConfiguration.SetScript then
      local current_script = MapConfiguration.GetScript and MapConfiguration.GetScript() or nil
      if tostring(current_script or ""):lower() ~= desired:lower() then
        MapConfiguration.SetScript(value)
      end
    end
    return
  end

  MapConfiguration.SetValue(key, value)
end

local function apply_map_values(values)
  if type(values) ~= "table" then return end
  if not MapConfiguration or not MapConfiguration.SetValue then return end

  local script = values.MAP_SCRIPT
  if script ~= nil then
    local ok, err = pcall(function()
      set_map_value("MAP_SCRIPT", script)
    end)
    if not ok then
      print("Presets: failed to apply key 'MAP_SCRIPT': " .. tostring(err))
    end
  end

  for key, value in pairs(values) do
    if type(key) == "string" and key ~= "" and key ~= "MAP_SCRIPT" then
      local ok, err = pcall(function()
        set_map_value(key, value)
      end)
      if not ok then
        print("Presets: failed to apply key '" .. tostring(key) .. "': " .. tostring(err))
      end
    end
  end
end

local function apply_preset_extras(preset_id)
  local preset = get_preset_data(preset_id)
  if type(preset) ~= "table" then return false end

  g_IsApplyingPreset = true

  if GameConfiguration and GameConfiguration.SetValue then
    apply_values(clone_list_map(preset.GameValues), function(key, value)
      GameConfiguration.SetValue(key, value)
    end)

    apply_values(clone_list_map(preset.ListsGame), function(key, value)
      GameConfiguration.SetValue(key, value)
    end)
  end

  if MapConfiguration then
    apply_map_values(clone_list_map(preset.MapValues))

    apply_values(clone_list_map(preset.ListsMap), function(key, value)
      MapConfiguration.SetValue(key, value)
    end)
  end

  g_IsApplyingPreset = false

  local map_script = nil
  local map_value = nil
  if MapConfiguration and MapConfiguration.GetScript then
    map_script = MapConfiguration.GetScript()
  end
  if MapConfiguration and MapConfiguration.GetValue then
    map_value = MapConfiguration.GetValue("MAP_SCRIPT")
    if map_script == nil then
      map_script = map_value
    end
  end
  local sea_level = MapConfiguration and MapConfiguration.GetValue and MapConfiguration.GetValue("sea_level") or nil
  local rainfall = MapConfiguration and MapConfiguration.GetValue and MapConfiguration.GetValue("rainfall") or nil
  local disaster = GameConfiguration and GameConfiguration.GetValue and GameConfiguration.GetValue("DISASTER_INTENSITY") or nil
  local realism = GameConfiguration and GameConfiguration.GetValue and GameConfiguration.GetValue("GAME_REALISM") or nil
  print("Presets: SP snapshot preset=" .. tostring(preset_id)
    .. " map=" .. tostring(map_script)
    .. " map_value=" .. tostring(map_value)
    .. " sea=" .. tostring(sea_level)
    .. " rain=" .. tostring(rainfall)
    .. " disaster=" .. tostring(disaster)
    .. " realism=" .. tostring(realism))
  print("Presets: applied SP list overrides -> " .. tostring(preset_id))
  return true
end

local function check_preset()
  if g_IsApplyingPreset then return end

  local current = GameConfiguration and GameConfiguration.GetValue and GameConfiguration.GetValue("MPH_PRESET") or nil
  if current == nil then return end

  local preset = get_preset_data(current)
  if type(preset) ~= "table" then
    g_LastAppliedPreset = nil
    return
  end

  local should_apply = g_LastAppliedPreset ~= current
  if not should_apply then return end
  if apply_preset_extras(current) then
    g_LastAppliedPreset = current
  end
end

local g_BaseOnSetParameterValue = OnSetParameterValue
if g_GlobalState.WrappedOnSetParameterValue ~= nil and g_BaseOnSetParameterValue == g_GlobalState.WrappedOnSetParameterValue then
  g_BaseOnSetParameterValue = g_GlobalState.BaseOnSetParameterValue
end
if g_BaseOnSetParameterValue then
  function OnSetParameterValue(pid, value)
    g_BaseOnSetParameterValue(pid, value)
    if pid == SP_PRESET_PARAMETER_ID or pid == "MPH_PRESET" then
      check_preset()
    end
  end
  g_GlobalState.BaseOnSetParameterValue = g_BaseOnSetParameterValue
  g_GlobalState.WrappedOnSetParameterValue = OnSetParameterValue
end

if Events and Events.GameConfigChanged and Events.GameConfigChanged.Remove and g_GlobalState.CheckPresetListener then
  pcall(function()
    Events.GameConfigChanged.Remove(g_GlobalState.CheckPresetListener)
  end)
end
if Events and Events.GameConfigChanged and Events.GameConfigChanged.Add then
  Events.GameConfigChanged.Add(check_preset)
  g_GlobalState.CheckPresetListener = check_preset
end

local g_OldOnShutdown = OnShutdown
if g_OldOnShutdown then
  function OnShutdown(...)
    if Events and Events.GameConfigChanged and Events.GameConfigChanged.Remove and g_GlobalState.CheckPresetListener then
      pcall(function()
        Events.GameConfigChanged.Remove(g_GlobalState.CheckPresetListener)
      end)
    end
    g_OldOnShutdown(...)
  end
end

check_preset()
