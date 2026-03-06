PresetModPresetData = {}

local SHARED_CITY_STATE_BANS = {
  "CIVILIZATION_VILNIUS",
  "CIVILIZATION_ANTIOCH",
  "CIVILIZATION_AUCKLAND",
  "CIVILIZATION_YEREVAN",
  "CIVILIZATION_PRESLAV",
  "CIVILIZATION_LA_VENTA",
  "CIVILIZATION_CARDIFF",
  "CIVILIZATION_SAMARKAND",
  "CIVILIZATION_KUMASI",
}

local SHARED_NATURAL_WONDER_BANS = {
  "FEATURE_ZHANGYE_DANXIA",
  "FEATURE_MATTERHORN",
  "FEATURE_TORRES_DEL_PAINE",
  "FEATURE_BARRINGER_CRATER",
  "FEATURE_BIOLUMINESCENT_BAY",
  "FEATURE_CERRO_DE_POTOSI",
  "FEATURE_DALLOL",
  "FEATURE_GRAND_MESA",
  "FEATURE_KRAKATOA",
  "FEATURE_LAKE_VICTORIA",
  "FEATURE_LENCOIS_MARANHENSES",
  "FEATURE_OUNIANGA",
  "FEATURE_MOSI_OA_TUNYA",
  "FEATURE_MOTLATSE_CANYON",
  "FEATURE_KAILASH",
  "FEATURE_NAMIB",
  "FEATURE_OLD_FAITHFUL",
  "FEATURE_SINAI",
  "FEATURE_SALAR_DE_UYUNI",
  "FEATURE_WULINGYUAN",
  "FEATURE_SRI_PADA",
  "FEATURE_GIBRALTAR",
  "FEATURE_VREDEFORT_DOME",
  "FEATURE_BERMUDA_TRIANGLE",
}

local function make_goody_hut_values(tech_enabled)
  return {
    SAILORGC_FREQUENCY = 175,
    SAILORGC_BUILDER = 1,
    SAILORGC_EUREKA = 1,
    SAILORGC_EXPERIENCE = 0,
    SAILORGC_FAITH = 1,
    SAILORGC_GOLD = 1,
    SAILORGC_HEAL = 0,
    SAILORGC_INSPIRATIONS = 1,
    SAILORGC_POPULATION = 1,
    SAILORGC_RELIC = 1,
    SAILORGC_SCOUT = 1,
    SAILORGC_TECH = tech_enabled and 1 or 0,
    SAILORGC_TRADER = 1,
    SAILORGC_FAVOR = 0,
    SAILORGC_ENVOY = 0,
    SAILORGC_GOVERNOR = 0,
    SAILORGC_STRATEGIC = 0,
    SAILORGC_SETTLER = 0,
    SAILORGC_CIVIC = 0,
    SAILORGC_CITYSTATE = 0,
    SAILORGC_FORMATION = 0,
    SAILORGC_POLICY = 0,
    SAILORGC_RESOURCE = 0,
    SAILORGC_SIGHT = 0,
    SAILORGC_UI = 0,
    SAILORGC_UU = 0,
    SAILORGC_WONDER = 0,
    SAILORGC_SPY = 0,
    SAILORGC_PRODUCTION = 0,
    SAILORGC_TELEPORT = 0,
  }
end

local function make_game_values(tech_enabled)
  local values = make_goody_hut_values(tech_enabled)
  values.GAME_SPEED_TYPE = "GAMESPEED_ONLINE"
  values.GAME_REALISM = 0
  values.DISASTER_INTENSITY = 0
  return values
end

PresetModPresetData[11] = {
  Name = "PPL 1v1",
  GameValues = make_game_values(true),
  MapValues = {
    MAP_SCRIPT = "pangaea_ultima.lua",
    MapName = "Pangaea_Small_Ocean",
    MAP_SIZE = "MAPSIZE_DUEL",
    world_age = 1,
    resources = 3,
    BBSStratRes = 1,
    temperature = 2,
    rainfall = 2,
    sea_level = 1,
    BBSRidge = 0,
    BBSNatural = 2,
    BBM_Team_Spawn = 1,
  },
  ListsGame = {
    EXCLUDE_CITY_STATES = SHARED_CITY_STATE_BANS,
    EXCLUDE_NATURAL_WONDERS = SHARED_NATURAL_WONDER_BANS,
  },
  ListsMap = {},
}

PresetModPresetData[12] = {
  Name = "PPL 2v2",
  GameValues = make_game_values(false),
  MapValues = {
    MAP_SCRIPT = "pangaea_ultima.lua",
    MapName = "Pangaea_Small_Ocean",
    MAP_SIZE = "MAPSIZE_TINY",
    world_age = 1,
    resources = 3,
    BBSStratRes = 1,
    temperature = 2,
    rainfall = 2,
    sea_level = 1,
    BBSRidge = 0,
    BBSNatural = 2,
    BBM_Team_Spawn = 1,
  },
  ListsGame = {
    EXCLUDE_CITY_STATES = SHARED_CITY_STATE_BANS,
    EXCLUDE_NATURAL_WONDERS = SHARED_NATURAL_WONDER_BANS,
  },
  ListsMap = {},
}

PresetModPresetData[13] = {
  Name = "PPL 3v3",
  GameValues = make_game_values(false),
  MapValues = {
    MAP_SCRIPT = "pangaea_ultima.lua",
    MapName = "Pangaea_Small_Ocean",
    MAP_SIZE = "MAPSIZE_SMALL",
    world_age = 1,
    resources = 3,
    BBSStratRes = 1,
    temperature = 2,
    rainfall = 2,
    sea_level = 1,
    BBSRidge = 0,
    BBSNatural = 2,
    BBM_Team_Spawn = 1,
  },
  ListsGame = {
    EXCLUDE_CITY_STATES = SHARED_CITY_STATE_BANS,
    EXCLUDE_NATURAL_WONDERS = SHARED_NATURAL_WONDER_BANS,
  },
  ListsMap = {},
}
