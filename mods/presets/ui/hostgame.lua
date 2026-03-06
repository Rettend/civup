include("MPHHostGameOriginal")
include("preset_mod_preset_data")
print("Presets: hostgame wrapper loaded")

local g_OldCheckPreset = CheckPreset
local g_OldOnSetParameterValue = OnSetParameterValue
local g_OldOnSetParameterValues = OnSetParameterValues
local g_OldRefresh = Refresh
local g_LastAppliedPreset = nil
local g_IsApplyingPreset = false
local g_PresetFilterWrapper = nil
local g_SetParameterHookTarget = nil

local function sort_key(value)
  if type(value) == "number" then
    return value
  end

  local parsed = tonumber(value)
  if parsed ~= nil then
    return parsed
  end

  return 99999
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

local function inject_preset_values(values)
  if type(values) ~= "table" then
    values = {}
  end

  local seen = {}
  for _, entry in ipairs(values) do
    if entry and entry.Value ~= nil then
      seen[tostring(entry.Value)] = true
    end
  end

  for preset_id, preset in pairs(PresetModPresetData or {}) do
    local key = tostring(preset_id)
    if not seen[key] then
      local label = tostring((preset and preset.Name) or ("Preset " .. key))
      local description = tostring((preset and preset.Description) or label)
      table.insert(values, {
        Value = preset_id,
        Name = label,
        RawDescription = description,
        SortIndex = sort_key(preset_id),
        QueryId = "PresetModPresetData",
        QueryIndex = preset_id,
      })
      seen[key] = true
    end
  end

  table.sort(values, function(a, b)
    local ai = sort_key(a and (a.SortIndex or a.Value))
    local bi = sort_key(b and (b.SortIndex or b.Value))
    if ai ~= bi then
      return ai < bi
    end
    return tostring(a and a.Name or "") < tostring(b and b.Name or "")
  end)

  return values
end

local function is_mph_preset_parameter(parameter)
  if type(parameter) ~= "table" then return false end
  local parameter_id = tostring(parameter.ParameterId or "")
  local configuration_id = tostring(parameter.ConfigurationId or "")
  local domain = tostring(parameter.Domain or "")
  return parameter_id == "MPH_PRESET" or configuration_id == "MPH_PRESET" or domain == "MphPreset"
end

local function install_parameter_filter_hook()
  if type(SetupParameters) ~= "table" then return false end
  local current_filter = SetupParameters.Parameter_FilterValues
  if type(current_filter) ~= "function" then return false end
  if g_PresetFilterWrapper ~= nil and current_filter == g_PresetFilterWrapper then
    return true
  end

  local old_filter = current_filter
  g_PresetFilterWrapper = function(self, parameter, values)
    local filtered = old_filter(self, parameter, values)
    if is_mph_preset_parameter(parameter) then
      local injected = inject_preset_values(filtered)
      print("Presets: injected MPH preset values -> " .. tostring(#(injected or {})))
      return injected
    end
    return filtered
  end

  SetupParameters.Parameter_FilterValues = g_PresetFilterWrapper
  print("Presets: installed SetupParameters MPH preset filter hook")
  return true
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

local function extract_selected_value(value)
  if type(value) == "table" then
    return value.Value or value[1]
  end
  return value
end

local function set_game_value(key, value)
  GameConfiguration.SetValue(key, value)
end

local function try_set_map_parameter_via_setup(value)
  if type(g_GameParameters) ~= "table" then return false end
  if type(g_GameParameters.SetParameterValue) ~= "function" then return false end
  local parameters = g_GameParameters.Parameters
  if type(parameters) ~= "table" then return false end
  local map_parameter = parameters.Map
  if type(map_parameter) ~= "table" then return false end

  local desired = tostring(value or ""):lower()
  local current = map_parameter.Value
  if type(current) == "table" then
    current = current.Value
  end
  if tostring(current or ""):lower() == desired then
    return true
  end

  if type(map_parameter.Values) == "table" then
    for _, option in ipairs(map_parameter.Values) do
      local option_value = option and option.Value or nil
      if tostring(option_value or ""):lower() == desired then
        g_GameParameters:SetParameterValue(map_parameter, option)
        print("Presets: map set through setup parameter -> " .. tostring(option_value))
        return true
      end
    end
  end

  return false
end

local function set_map_value(key, value)
  if key == "MAP_SCRIPT" then
    if try_set_map_parameter_via_setup(value) then
      return
    end

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

local function apply_exclusion_fallbacks(preset_id)
  local numeric = tonumber(preset_id)
  if numeric ~= 11 and numeric ~= 12 and numeric ~= 13 then
    return
  end

  if type(PPLGamemode_Natural_Wonders) == "function" then
    local ok, err = pcall(PPLGamemode_Natural_Wonders)
    if not ok then
      print("Presets: natural wonder fallback failed: " .. tostring(err))
    end
  end

  if type(PPLGamemode_CS) == "function" then
    local ok, err = pcall(PPLGamemode_CS)
    if not ok then
      print("Presets: city-state fallback failed: " .. tostring(err))
    end
  end
end

local function get_list_size(value)
  if type(value) ~= "table" then return 0 end
  local count = 0
  for _index, _item in ipairs(value) do
    count = count + 1
  end
  return count
end

local function debug_log_preset_snapshot(preset_id)
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
  local bbs_ridge = MapConfiguration and MapConfiguration.GetValue and MapConfiguration.GetValue("BBSRidge") or nil
  local bbs_strat = MapConfiguration and MapConfiguration.GetValue and MapConfiguration.GetValue("BBSStratRes") or nil
  local disaster = GameConfiguration and GameConfiguration.GetValue and GameConfiguration.GetValue("DISASTER_INTENSITY") or nil
  local realism = GameConfiguration and GameConfiguration.GetValue and GameConfiguration.GetValue("GAME_REALISM") or nil
  local hut_frequency = GameConfiguration and GameConfiguration.GetValue and GameConfiguration.GetValue("SAILORGC_FREQUENCY") or nil
  local hut_eureka = GameConfiguration and GameConfiguration.GetValue and GameConfiguration.GetValue("SAILORGC_EUREKA") or nil
  local hut_experience = GameConfiguration and GameConfiguration.GetValue and GameConfiguration.GetValue("SAILORGC_EXPERIENCE") or nil
  local hut_heal = GameConfiguration and GameConfiguration.GetValue and GameConfiguration.GetValue("SAILORGC_HEAL") or nil
  local hut_tech = GameConfiguration and GameConfiguration.GetValue and GameConfiguration.GetValue("SAILORGC_TECH") or nil
  local hut_trader = GameConfiguration and GameConfiguration.GetValue and GameConfiguration.GetValue("SAILORGC_TRADER") or nil
  local hut_favor = GameConfiguration and GameConfiguration.GetValue and GameConfiguration.GetValue("SAILORGC_FAVOR") or nil
  local hut_envoy = GameConfiguration and GameConfiguration.GetValue and GameConfiguration.GetValue("SAILORGC_ENVOY") or nil
  local exclude_cs = GameConfiguration and GameConfiguration.GetValue and GameConfiguration.GetValue("EXCLUDE_CITY_STATES") or nil
  local exclude_nw = GameConfiguration and GameConfiguration.GetValue and GameConfiguration.GetValue("EXCLUDE_NATURAL_WONDERS") or nil

  print("Presets: snapshot preset=" .. tostring(preset_id)
    .. " map=" .. tostring(map_script)
    .. " map_value=" .. tostring(map_value)
    .. " sea=" .. tostring(sea_level)
    .. " rain=" .. tostring(rainfall)
    .. " ridge=" .. tostring(bbs_ridge)
    .. " strat=" .. tostring(bbs_strat)
    .. " disaster=" .. tostring(disaster)
    .. " realism=" .. tostring(realism)
    .. " hut_freq=" .. tostring(hut_frequency)
    .. " hut_eureka=" .. tostring(hut_eureka)
    .. " hut_exp=" .. tostring(hut_experience)
    .. " hut_heal=" .. tostring(hut_heal)
    .. " hut_tech=" .. tostring(hut_tech)
    .. " hut_trader=" .. tostring(hut_trader)
    .. " hut_favor=" .. tostring(hut_favor)
    .. " hut_envoy=" .. tostring(hut_envoy)
    .. " cs_excluded=" .. tostring(get_list_size(exclude_cs))
    .. " nw_excluded=" .. tostring(get_list_size(exclude_nw)))
end

local function apply_preset_extras(preset_id)
  local preset = get_preset_data(preset_id)
  if type(preset) ~= "table" then return false end

  g_IsApplyingPreset = true

  if GameConfiguration and GameConfiguration.SetValue then
    apply_values(clone_list_map(preset.GameValues), function(key, value)
      set_game_value(key, value)
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

  apply_exclusion_fallbacks(preset_id)

  g_IsApplyingPreset = false

  if Network and Network.BroadcastGameConfig then
    pcall(function()
      Network.BroadcastGameConfig()
    end)
  end
  if type(GameSetup_RefreshParameters) == "function" then
    pcall(function()
      GameSetup_RefreshParameters()
    end)
  end

  debug_log_preset_snapshot(preset_id)
  print("Presets: applied list overrides -> " .. tostring(preset_id))
  return true
end

local function maybe_apply_from_selected_value(pid, value)
  if tostring(pid or "") ~= "MPH_PRESET" then
    return false
  end

  local selected = extract_selected_value(value)

  local preset = get_preset_data(selected)
  if type(preset) ~= "table" then
    return false
  end

  if apply_preset_extras(selected) then
    g_LastAppliedPreset = selected
    print("Presets: applied immediately from selection pid=" .. tostring(pid) .. " value=" .. tostring(selected))
    return true
  end

  return false
end

local function install_game_parameter_hooks()
  if type(g_GameParameters) ~= "table" then return false end
  if g_SetParameterHookTarget == g_GameParameters then return true end
  if g_GameParameters.__PresetModHookInstalled then
    g_SetParameterHookTarget = g_GameParameters
    return true
  end
  if type(g_GameParameters.SetParameterValue) ~= "function" then return false end

  local base_set_parameter_value = g_GameParameters.SetParameterValue
  g_GameParameters.SetParameterValue = function(self, parameter, value, ...)
    local result = base_set_parameter_value(self, parameter, value, ...)
    local pid = tostring(parameter and (parameter.ParameterId or parameter.ConfigurationId) or "")
    if pid == "MPH_PRESET" then
      maybe_apply_from_selected_value("MPH_PRESET", extract_selected_value(value))
    end
    return result
  end

  if type(g_GameParameters.SetParameterValues) == "function" then
    local base_set_parameter_values = g_GameParameters.SetParameterValues
    g_GameParameters.SetParameterValues = function(self, parameter, values, ...)
      local result = base_set_parameter_values(self, parameter, values, ...)
      local pid = tostring(parameter and (parameter.ParameterId or parameter.ConfigurationId) or "")
      if pid == "MPH_PRESET" and type(values) == "table" then
        maybe_apply_from_selected_value("MPH_PRESET", values[1])
      end
      return result
    end
  end

  g_GameParameters.__PresetModHookInstalled = true
  g_SetParameterHookTarget = g_GameParameters
  print("Presets: installed g_GameParameters hooks")
  return true
end

local function should_reapply_preset(preset_id, preset)
  if g_LastAppliedPreset ~= preset_id then
    return true
  end

  return false
end

function CheckPreset()
  install_parameter_filter_hook()
  install_game_parameter_hooks()
  if g_IsApplyingPreset then return end

  if g_OldCheckPreset then
    g_OldCheckPreset()
  end

  local current = GameConfiguration and GameConfiguration.GetValue and GameConfiguration.GetValue("MPH_PRESET") or nil
  if current == nil then return end

  local preset = get_preset_data(current)
  if type(preset) ~= "table" then
    g_LastAppliedPreset = nil
    return
  end

  if not should_reapply_preset(current, preset) then return end
  if apply_preset_extras(current) then
    g_LastAppliedPreset = current
  end
end

if g_OldOnSetParameterValue then
  function OnSetParameterValue(pid, value)
    install_parameter_filter_hook()
    install_game_parameter_hooks()
    g_OldOnSetParameterValue(pid, value)
    if not maybe_apply_from_selected_value(pid, value) and pid == "MPH_PRESET" then
      CheckPreset()
    end
  end
end

if g_OldOnSetParameterValues then
  function OnSetParameterValues(pid, values)
    install_parameter_filter_hook()
    install_game_parameter_hooks()
    g_OldOnSetParameterValues(pid, values)
    if tostring(pid or "") == "MPH_PRESET" then
      local selected = values
      if type(values) == "table" then
        selected = values[1]
      end
      if not maybe_apply_from_selected_value(pid, selected) then
        CheckPreset()
      end
    end
  end
end

if g_OldRefresh then
  function Refresh(...)
    g_OldRefresh(...)
    install_parameter_filter_hook()
    install_game_parameter_hooks()
  end
end

if Events and Events.GameConfigChanged and Events.GameConfigChanged.Remove and Events.GameConfigChanged.Add then
  if g_OldCheckPreset then
    pcall(function()
      Events.GameConfigChanged.Remove(g_OldCheckPreset)
    end)
  end
  Events.GameConfigChanged.Add(CheckPreset)
end

CheckPreset()
