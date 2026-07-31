/* eslint-disable style/comma-dangle, style/no-multiple-empty-lines, style/quote-props, style/quotes */
import type { CivBlitzModBbgAdjacencyMetadata, CivBlitzModCivilizationMetadata, CivBlitzModComponentMetadata, CivBlitzModLandmarkMetadata, CivBlitzModLeaderMetadata } from '../catalog-types.ts'

/**
 * Generated file. Do not edit directly.
 * Generated from Civ Blitz 413d329664183ab13b5f889df0bea62dc2131131 and @civup/game's persisted component IDs.
 */

export const componentCatalog = {
  "civblitz:civilizationAbility:america": {
    "category": "civilizationAbility",
    "displayName": "Founding Fathers",
    "civilizationType": "CIVILIZATION_AMERICA",
    "traitType": "TRAIT_CIVILIZATION_FOUNDING_FATHERS",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:arabia": {
    "category": "civilizationAbility",
    "displayName": "The Last Prophet",
    "civilizationType": "CIVILIZATION_ARABIA",
    "traitType": "TRAIT_CIVILIZATION_LAST_PROPHET",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:australia": {
    "category": "civilizationAbility",
    "displayName": "Land Down Under",
    "civilizationType": "CIVILIZATION_AUSTRALIA",
    "traitType": "TRAIT_CIVILIZATION_LAND_DOWN_UNDER",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:aztec": {
    "category": "civilizationAbility",
    "displayName": "Legend of the Five Suns",
    "civilizationType": "CIVILIZATION_AZTEC",
    "traitType": "TRAIT_CIVILIZATION_LEGEND_FIVE_SUNS",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:babylon": {
    "category": "civilizationAbility",
    "displayName": "Enuma Anu Enlil",
    "civilizationType": "CIVILIZATION_BABYLON_STK",
    "traitType": "TRAIT_CIVILIZATION_BABYLON",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "unsupportedReason": "The upstream Civ Blitz normal-card registry intentionally excludes Babylon's civilization ability because it is not safe to transplant."
  },
  "civblitz:civilizationAbility:brazil": {
    "category": "civilizationAbility",
    "displayName": "Amazon",
    "civilizationType": "CIVILIZATION_BRAZIL",
    "traitType": "TRAIT_CIVILIZATION_AMAZON",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:byzantium": {
    "category": "civilizationAbility",
    "displayName": "Taxis",
    "civilizationType": "CIVILIZATION_BYZANTIUM",
    "traitType": "TRAIT_CIVILIZATION_BYZANTIUM",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "unsupportedReason": "The upstream Civ Blitz normal-card registry intentionally excludes Byzantium's civilization ability because it is not safe to transplant."
  },
  "civblitz:civilizationAbility:canada": {
    "category": "civilizationAbility",
    "displayName": "Four Faces of Peace",
    "civilizationType": "CIVILIZATION_CANADA",
    "traitType": "TRAIT_CIVILIZATION_FACES_OF_PEACE",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:china": {
    "category": "civilizationAbility",
    "displayName": "Dynastic Cycle",
    "civilizationType": "CIVILIZATION_CHINA",
    "traitType": "TRAIT_CIVILIZATION_DYNASTIC_CYCLE",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:cree": {
    "category": "civilizationAbility",
    "displayName": "Nîhithaw",
    "civilizationType": "CIVILIZATION_CREE",
    "traitType": "TRAIT_CIVILIZATION_CREE_TRADE_GAIN_TILES",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:egypt": {
    "category": "civilizationAbility",
    "displayName": "Iteru",
    "civilizationType": "CIVILIZATION_EGYPT",
    "traitType": "TRAIT_CIVILIZATION_ITERU",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:england": {
    "category": "civilizationAbility",
    "displayName": "Workshop of the World",
    "civilizationType": "CIVILIZATION_ENGLAND",
    "traitType": "TRAIT_CIVILIZATION_INDUSTRIAL_REVOLUTION",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:ethiopia": {
    "category": "civilizationAbility",
    "displayName": "Aksumite Legacy",
    "civilizationType": "CIVILIZATION_ETHIOPIA",
    "traitType": "TRAIT_CIVILIZATION_ETHIOPIA",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:france": {
    "category": "civilizationAbility",
    "displayName": "Grand Tour",
    "civilizationType": "CIVILIZATION_FRANCE",
    "traitType": "TRAIT_CIVILIZATION_WONDER_TOURISM",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:gaul": {
    "category": "civilizationAbility",
    "displayName": "Hallstatt Culture",
    "civilizationType": "CIVILIZATION_GAUL",
    "traitType": "TRAIT_CIVILIZATION_GAUL",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:georgia": {
    "category": "civilizationAbility",
    "displayName": "Strength in Unity",
    "civilizationType": "CIVILIZATION_GEORGIA",
    "traitType": "TRAIT_CIVILIZATION_GOLDEN_AGE_QUESTS",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:germany": {
    "category": "civilizationAbility",
    "displayName": "Free Imperial Cities",
    "civilizationType": "CIVILIZATION_GERMANY",
    "traitType": "TRAIT_CIVILIZATION_IMPERIAL_FREE_CITIES",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:gran-colombia": {
    "category": "civilizationAbility",
    "displayName": "Ejército Patriota",
    "civilizationType": "CIVILIZATION_GRAN_COLOMBIA",
    "traitType": "TRAIT_CIVILIZATION_EJERCITO_PATRIOTA",
    "playerItemTypes": [],
    "grantTraitTypes": [
      "TRAIT_CIVILIZATION_COMANDANTE_GENERAL"
    ],
    "grantPlayerItemTypes": [
      "UNIT_COMANDANTE_GENERAL"
    ]
  },
  "civblitz:civilizationAbility:greece": {
    "category": "civilizationAbility",
    "displayName": "Plato's Republic",
    "civilizationType": "CIVILIZATION_GREECE",
    "traitType": "TRAIT_CIVILIZATION_PLATOS_REPUBLIC",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:hungary": {
    "category": "civilizationAbility",
    "displayName": "Pearl of the Danube",
    "civilizationType": "CIVILIZATION_HUNGARY",
    "traitType": "TRAIT_CIVILIZATION_PEARL_DANUBE",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:inca": {
    "category": "civilizationAbility",
    "displayName": "Mit’a",
    "civilizationType": "CIVILIZATION_INCA",
    "traitType": "TRAIT_CIVILIZATION_GREAT_MOUNTAINS",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:india": {
    "category": "civilizationAbility",
    "displayName": "Dharma",
    "civilizationType": "CIVILIZATION_INDIA",
    "traitType": "TRAIT_CIVILIZATION_DHARMA",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:indonesia": {
    "category": "civilizationAbility",
    "displayName": "Great Nusantara",
    "civilizationType": "CIVILIZATION_INDONESIA",
    "traitType": "TRAIT_CIVILIZATION_INDONESIA_NUSANTARA",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:japan": {
    "category": "civilizationAbility",
    "displayName": "Meiji Restoration",
    "civilizationType": "CIVILIZATION_JAPAN",
    "traitType": "TRAIT_CIVILIZATION_ADJACENT_DISTRICTS",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:khmer": {
    "category": "civilizationAbility",
    "displayName": "Grand Barays",
    "civilizationType": "CIVILIZATION_KHMER",
    "traitType": "TRAIT_CIVILIZATION_KHMER_BARAYS",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:kongo": {
    "category": "civilizationAbility",
    "displayName": "Nkisi",
    "civilizationType": "CIVILIZATION_KONGO",
    "traitType": "TRAIT_CIVILIZATION_NKISI",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:korea": {
    "category": "civilizationAbility",
    "displayName": "Three Kingdoms",
    "civilizationType": "CIVILIZATION_KOREA",
    "traitType": "TRAIT_CIVILIZATION_THREE_KINGDOMS",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:m-ori": {
    "category": "civilizationAbility",
    "displayName": "Mana",
    "civilizationType": "CIVILIZATION_MAORI",
    "traitType": "TRAIT_CIVILIZATION_MAORI_MANA",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:macedon": {
    "category": "civilizationAbility",
    "displayName": "Hellenistic Fusion",
    "civilizationType": "CIVILIZATION_MACEDON",
    "traitType": "TRAIT_CIVILIZATION_HELLENISTIC_FUSION",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:mali": {
    "category": "civilizationAbility",
    "displayName": "Songs of the Jeli",
    "civilizationType": "CIVILIZATION_MALI",
    "traitType": "TRAIT_CIVILIZATION_MALI_GOLD_DESERT",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:mapuche": {
    "category": "civilizationAbility",
    "displayName": "Toqui",
    "civilizationType": "CIVILIZATION_MAPUCHE",
    "traitType": "TRAIT_CIVILIZATION_MAPUCHE_TOQUI",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:maya": {
    "category": "civilizationAbility",
    "displayName": "Mayab",
    "civilizationType": "CIVILIZATION_MAYA",
    "traitType": "TRAIT_CIVILIZATION_MAYAB",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:mongolia": {
    "category": "civilizationAbility",
    "displayName": "Örtöö",
    "civilizationType": "CIVILIZATION_MONGOLIA",
    "traitType": "TRAIT_CIVILIZATION_MONGOLIAN_ORTOO",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:netherlands": {
    "category": "civilizationAbility",
    "displayName": "Grote Rivieren",
    "civilizationType": "CIVILIZATION_NETHERLANDS",
    "traitType": "TRAIT_CIVILIZATION_GROTE_RIVIEREN",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:norway": {
    "category": "civilizationAbility",
    "displayName": "Knarr",
    "civilizationType": "CIVILIZATION_NORWAY",
    "traitType": "TRAIT_CIVILIZATION_EARLY_OCEAN_NAVIGATION",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:nubia": {
    "category": "civilizationAbility",
    "displayName": "Ta-Seti",
    "civilizationType": "CIVILIZATION_NUBIA",
    "traitType": "TRAIT_CIVILIZATION_TA_SETI",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:ottomans": {
    "category": "civilizationAbility",
    "displayName": "Great Turkish Bombard",
    "civilizationType": "CIVILIZATION_OTTOMAN",
    "traitType": "TRAIT_CIVILIZATION_GREAT_TURKISH_BOMBARD",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:persia": {
    "category": "civilizationAbility",
    "displayName": "Satrapies",
    "civilizationType": "CIVILIZATION_PERSIA",
    "traitType": "TRAIT_CIVILIZATION_SATRAPIES",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:phoenicia": {
    "category": "civilizationAbility",
    "displayName": "Mediterranean Colonies",
    "civilizationType": "CIVILIZATION_PHOENICIA",
    "traitType": "TRAIT_CIVILIZATION_MEDITERRANEAN_COLONIES",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:poland": {
    "category": "civilizationAbility",
    "displayName": "Golden Liberty",
    "civilizationType": "CIVILIZATION_POLAND",
    "traitType": "TRAIT_CIVILIZATION_GOLDEN_LIBERTY",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:portugal": {
    "category": "civilizationAbility",
    "displayName": "Casa da Índia",
    "civilizationType": "CIVILIZATION_PORTUGAL",
    "traitType": "TRAIT_CIVILIZATION_PORTUGAL",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:rome": {
    "category": "civilizationAbility",
    "displayName": "All Roads Lead to Rome",
    "civilizationType": "CIVILIZATION_ROME",
    "traitType": "TRAIT_CIVILIZATION_ALL_ROADS_TO_ROME",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:russia": {
    "category": "civilizationAbility",
    "displayName": "Mother Russia",
    "civilizationType": "CIVILIZATION_RUSSIA",
    "traitType": "TRAIT_CIVILIZATION_MOTHER_RUSSIA",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:scotland": {
    "category": "civilizationAbility",
    "displayName": "Scottish Enlightenment",
    "civilizationType": "CIVILIZATION_SCOTLAND",
    "traitType": "TRAIT_CIVILIZATION_SCOTTISH_ENLIGHTENMENT",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:scythia": {
    "category": "civilizationAbility",
    "displayName": "People of the Steppe",
    "civilizationType": "CIVILIZATION_SCYTHIA",
    "traitType": "TRAIT_CIVILIZATION_EXTRA_LIGHT_CAVALRY",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:spain": {
    "category": "civilizationAbility",
    "displayName": "Treasure Fleet",
    "civilizationType": "CIVILIZATION_SPAIN",
    "traitType": "TRAIT_CIVILIZATION_TREASURE_FLEET",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:sumeria": {
    "category": "civilizationAbility",
    "displayName": "The Cradle of Civilization",
    "civilizationType": "CIVILIZATION_SUMERIA",
    "traitType": "TRAIT_CIVILIZATION_FIRST_CIVILIZATION",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:sweden": {
    "category": "civilizationAbility",
    "displayName": "Nobel Prize",
    "civilizationType": "CIVILIZATION_SWEDEN",
    "traitType": "TRAIT_CIVILIZATION_NOBEL_PRIZE",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:vietnam": {
    "category": "civilizationAbility",
    "displayName": "Nine Dragon River Delta",
    "civilizationType": "CIVILIZATION_VIETNAM",
    "traitType": "TRAIT_CIVILIZATION_VIETNAM",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:civilizationAbility:zulu": {
    "category": "civilizationAbility",
    "displayName": "Isibongo",
    "civilizationType": "CIVILIZATION_ZULU",
    "traitType": "TRAIT_CIVILIZATION_ZULU_ISIBONGO",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:acropolis": {
    "category": "infrastructure",
    "displayName": "Acropolis",
    "civilizationType": "CIVILIZATION_GREECE",
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_ACROPOLIS",
    "playerItemTypes": [
      "DISTRICT_ACROPOLIS"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:basilikoi-paides": {
    "category": "infrastructure",
    "displayName": "Basilikoi Paides",
    "civilizationType": "CIVILIZATION_MACEDON",
    "traitType": "TRAIT_CIVILIZATION_BUILDING_BASILIKOI_PAIDES",
    "playerItemTypes": [
      "BUILDING_BASILIKOI_PAIDES"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:bath": {
    "category": "infrastructure",
    "displayName": "Bath",
    "civilizationType": "CIVILIZATION_ROME",
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_BATH",
    "playerItemTypes": [
      "DISTRICT_BATH"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:ch-teau": {
    "category": "infrastructure",
    "displayName": "Château",
    "civilizationType": "CIVILIZATION_FRANCE",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_CHATEAU",
    "playerItemTypes": [
      "IMPROVEMENT_CHATEAU"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:chemamull": {
    "category": "infrastructure",
    "displayName": "Chemamull",
    "civilizationType": "CIVILIZATION_MAPUCHE",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_CHEMAMULL",
    "playerItemTypes": [
      "IMPROVEMENT_CHEMAMULL"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:copacabana": {
    "category": "infrastructure",
    "displayName": "Copacabana",
    "civilizationType": "CIVILIZATION_BRAZIL",
    "traitType": "TRAIT_CIVILIZATION_STREET_CARNIVAL",
    "playerItemTypes": [
      "DISTRICT_STREET_CARNIVAL",
      "DISTRICT_WATER_STREET_CARNIVAL"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:cothon": {
    "category": "infrastructure",
    "displayName": "Cothon",
    "civilizationType": "CIVILIZATION_PHOENICIA",
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_COTHON",
    "playerItemTypes": [
      "DISTRICT_COTHON"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:electronics-factory": {
    "category": "infrastructure",
    "displayName": "Electronics Factory",
    "civilizationType": "CIVILIZATION_JAPAN",
    "traitType": "TRAIT_CIVILIZATION_BUILDING_ELECTRONICS_FACTORY",
    "playerItemTypes": [
      "BUILDING_ELECTRONICS_FACTORY"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:feitoria": {
    "category": "infrastructure",
    "displayName": "Feitoria",
    "civilizationType": "CIVILIZATION_PORTUGAL",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_FEITORIA",
    "playerItemTypes": [
      "IMPROVEMENT_FEITORIA"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:film-studio": {
    "category": "infrastructure",
    "displayName": "Film Studio",
    "civilizationType": "CIVILIZATION_AMERICA",
    "traitType": "TRAIT_CIVILIZATION_BUILDING_FILM_STUDIO",
    "playerItemTypes": [
      "BUILDING_FILM_STUDIO"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:golf-course": {
    "category": "infrastructure",
    "displayName": "Golf Course",
    "civilizationType": "CIVILIZATION_SCOTLAND",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_GOLF_COURSE",
    "playerItemTypes": [
      "IMPROVEMENT_GOLF_COURSE"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:grand-bazaar": {
    "category": "infrastructure",
    "displayName": "Grand Bazaar",
    "civilizationType": "CIVILIZATION_OTTOMAN",
    "traitType": "TRAIT_CIVILIZATION_BUILDING_GRAND_BAZAAR",
    "playerItemTypes": [
      "BUILDING_GRAND_BAZAAR"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:great-wall": {
    "category": "infrastructure",
    "displayName": "Great Wall",
    "civilizationType": "CIVILIZATION_CHINA",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_GREAT_WALL",
    "playerItemTypes": [
      "IMPROVEMENT_GREAT_WALL"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:hacienda": {
    "category": "infrastructure",
    "displayName": "Hacienda",
    "civilizationType": "CIVILIZATION_GRAN_COLOMBIA",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_HACIENDA",
    "playerItemTypes": [
      "IMPROVEMENT_HACIENDA"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:hansa": {
    "category": "infrastructure",
    "displayName": "Hansa",
    "civilizationType": "CIVILIZATION_GERMANY",
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_HANSA",
    "playerItemTypes": [
      "DISTRICT_HANSA"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:hippodrome": {
    "category": "infrastructure",
    "displayName": "Hippodrome",
    "civilizationType": "CIVILIZATION_BYZANTIUM",
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_HIPPODROME",
    "playerItemTypes": [
      "DISTRICT_HIPPODROME"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:ice-hockey-rink": {
    "category": "infrastructure",
    "displayName": "Ice Hockey Rink",
    "civilizationType": "CIVILIZATION_CANADA",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_ICE_HOCKEY_RINK",
    "playerItemTypes": [
      "IMPROVEMENT_ICE_HOCKEY_RINK"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:ikanda": {
    "category": "infrastructure",
    "displayName": "Ikanda",
    "civilizationType": "CIVILIZATION_ZULU",
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_IKANDA",
    "playerItemTypes": [
      "DISTRICT_IKANDA"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:kampung": {
    "category": "infrastructure",
    "displayName": "Kampung",
    "civilizationType": "CIVILIZATION_INDONESIA",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_KAMPUNG",
    "playerItemTypes": [
      "IMPROVEMENT_KAMPUNG"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:kurgan": {
    "category": "infrastructure",
    "displayName": "Kurgan",
    "civilizationType": "CIVILIZATION_SCYTHIA",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_KURGAN",
    "playerItemTypes": [
      "IMPROVEMENT_KURGAN"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:lavra": {
    "category": "infrastructure",
    "displayName": "Lavra",
    "civilizationType": "CIVILIZATION_RUSSIA",
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_LAVRA",
    "playerItemTypes": [
      "DISTRICT_LAVRA"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:madrasa": {
    "category": "infrastructure",
    "displayName": "Madrasa",
    "civilizationType": "CIVILIZATION_ARABIA",
    "traitType": "TRAIT_CIVILIZATION_BUILDING_MADRASA",
    "playerItemTypes": [
      "BUILDING_MADRASA"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:marae": {
    "category": "infrastructure",
    "displayName": "Marae",
    "civilizationType": "CIVILIZATION_MAORI",
    "traitType": "TRAIT_CIVILIZATION_BUILDING_MARAE",
    "playerItemTypes": [
      "BUILDING_MARAE"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:mbanza": {
    "category": "infrastructure",
    "displayName": "Mbanza",
    "civilizationType": "CIVILIZATION_KONGO",
    "traitType": "TRAIT_CIVILIZATION_MBANZA",
    "playerItemTypes": [
      "DISTRICT_MBANZA"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:mekewap": {
    "category": "infrastructure",
    "displayName": "Mekewap",
    "civilizationType": "CIVILIZATION_CREE",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_MEKEWAP",
    "playerItemTypes": [
      "IMPROVEMENT_MEKEWAP"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:mission": {
    "category": "infrastructure",
    "displayName": "Mission",
    "civilizationType": "CIVILIZATION_SPAIN",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_MISSION",
    "playerItemTypes": [
      "IMPROVEMENT_MISSION"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:navigation-school": {
    "category": "infrastructure",
    "displayName": "Navigation School",
    "civilizationType": "CIVILIZATION_PORTUGAL",
    "traitType": "TRAIT_CIVILIZATION_BUILDING_NAVIGATION_SCHOOL",
    "playerItemTypes": [
      "BUILDING_NAVIGATION_SCHOOL"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:nubian-pyramid": {
    "category": "infrastructure",
    "displayName": "Nubian Pyramid",
    "civilizationType": "CIVILIZATION_NUBIA",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_PYRAMID",
    "playerItemTypes": [
      "IMPROVEMENT_PYRAMID"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:observatory": {
    "category": "infrastructure",
    "displayName": "Observatory",
    "civilizationType": "CIVILIZATION_MAYA",
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_OBSERVATORY",
    "playerItemTypes": [
      "DISTRICT_OBSERVATORY"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:open-air-museum": {
    "category": "infrastructure",
    "displayName": "Open-Air Museum",
    "civilizationType": "CIVILIZATION_SWEDEN",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_OPEN_AIR_MUSEUM",
    "playerItemTypes": [
      "IMPROVEMENT_OPEN_AIR_MUSEUM"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:oppidum": {
    "category": "infrastructure",
    "displayName": "Oppidum",
    "civilizationType": "CIVILIZATION_GAUL",
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_OPPIDUM",
    "playerItemTypes": [
      "DISTRICT_OPPIDUM"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:ordu": {
    "category": "infrastructure",
    "displayName": "Ordu",
    "civilizationType": "CIVILIZATION_MONGOLIA",
    "traitType": "TRAIT_CIVILIZATION_BUILDING_ORDU",
    "playerItemTypes": [
      "BUILDING_ORDU"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:outback-station": {
    "category": "infrastructure",
    "displayName": "Outback Station",
    "civilizationType": "CIVILIZATION_AUSTRALIA",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_OUTBACK_STATION",
    "playerItemTypes": [
      "IMPROVEMENT_OUTBACK_STATION"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:p": {
    "category": "infrastructure",
    "displayName": "Pā",
    "civilizationType": "CIVILIZATION_MAORI",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_MAORI_PA",
    "playerItemTypes": [
      "IMPROVEMENT_MAORI_PA"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:pairidaeza": {
    "category": "infrastructure",
    "displayName": "Pairidaeza",
    "civilizationType": "CIVILIZATION_PERSIA",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_PAIRIDAEZA",
    "playerItemTypes": [
      "IMPROVEMENT_PAIRIDAEZA"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:palgum": {
    "category": "infrastructure",
    "displayName": "Palgum",
    "civilizationType": "CIVILIZATION_BABYLON_STK",
    "traitType": "TRAIT_CIVILIZATION_BUILDING_PALGUM",
    "playerItemTypes": [
      "BUILDING_PALGUM"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:polder": {
    "category": "infrastructure",
    "displayName": "Polder",
    "civilizationType": "CIVILIZATION_NETHERLANDS",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_POLDER",
    "playerItemTypes": [
      "IMPROVEMENT_POLDER"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:prasat": {
    "category": "infrastructure",
    "displayName": "Prasat",
    "civilizationType": "CIVILIZATION_KHMER",
    "traitType": "TRAIT_CIVILIZATION_BUILDING_PRASAT",
    "playerItemTypes": [
      "BUILDING_PRASAT"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:qhapaq-an": {
    "category": "infrastructure",
    "displayName": "Qhapaq Ñan",
    "civilizationType": "CIVILIZATION_INCA",
    "traitType": "TRAIT_LEADER_PACHACUTI_IMPROVEMENT_MOUNTAIN_ROAD",
    "playerItemTypes": [
      "IMPROVEMENT_MOUNTAIN_ROAD"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:queens-bibliotheque": {
    "category": "infrastructure",
    "displayName": "Queen's Bibliotheque",
    "civilizationType": "CIVILIZATION_SWEDEN",
    "traitType": "TRAIT_LEADER_BUILDING_QUEENS_BIBLIOTHEQUE",
    "playerItemTypes": [
      "BUILDING_QUEENS_BIBLIOTHEQUE"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:rock-hewn-church": {
    "category": "infrastructure",
    "displayName": "Rock-Hewn Church",
    "civilizationType": "CIVILIZATION_ETHIOPIA",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_ROCK_HEWN_CHURCH",
    "playerItemTypes": [
      "IMPROVEMENT_ROCK_HEWN_CHURCH"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:royal-navy-dockyard": {
    "category": "infrastructure",
    "displayName": "Royal Navy Dockyard",
    "civilizationType": "CIVILIZATION_ENGLAND",
    "traitType": "TRAIT_CIVILIZATION_ROYAL_NAVY_DOCKYARD",
    "playerItemTypes": [
      "DISTRICT_ROYAL_NAVY_DOCKYARD"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:seowon": {
    "category": "infrastructure",
    "displayName": "Seowon",
    "civilizationType": "CIVILIZATION_KOREA",
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_SEOWON",
    "playerItemTypes": [
      "DISTRICT_SEOWON"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:sphinx": {
    "category": "infrastructure",
    "displayName": "Sphinx",
    "civilizationType": "CIVILIZATION_EGYPT",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_SPHINX",
    "playerItemTypes": [
      "IMPROVEMENT_SPHINX"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:stave-church": {
    "category": "infrastructure",
    "displayName": "Stave Church",
    "civilizationType": "CIVILIZATION_NORWAY",
    "traitType": "TRAIT_CIVILIZATION_BUILDING_STAVE_CHURCH",
    "playerItemTypes": [
      "BUILDING_STAVE_CHURCH"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:stepwell": {
    "category": "infrastructure",
    "displayName": "Stepwell",
    "civilizationType": "CIVILIZATION_INDIA",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_STEPWELL",
    "playerItemTypes": [
      "IMPROVEMENT_STEPWELL"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:street-carnival": {
    "category": "infrastructure",
    "displayName": "Street Carnival",
    "civilizationType": "CIVILIZATION_BRAZIL",
    "traitType": "TRAIT_CIVILIZATION_STREET_CARNIVAL",
    "playerItemTypes": [
      "DISTRICT_STREET_CARNIVAL",
      "DISTRICT_WATER_STREET_CARNIVAL"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:suguba": {
    "category": "infrastructure",
    "displayName": "Suguba",
    "civilizationType": "CIVILIZATION_MALI",
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_SUGUBA",
    "playerItemTypes": [
      "DISTRICT_SUGUBA"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:sukiennice": {
    "category": "infrastructure",
    "displayName": "Sukiennice",
    "civilizationType": "CIVILIZATION_POLAND",
    "traitType": "TRAIT_CIVILIZATION_BUILDING_SUKIENNICE",
    "playerItemTypes": [
      "BUILDING_SUKIENNICE"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:terrace-farm": {
    "category": "infrastructure",
    "displayName": "Terrace Farm",
    "civilizationType": "CIVILIZATION_INCA",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_TERRACE_FARM",
    "playerItemTypes": [
      "IMPROVEMENT_TERRACE_FARM"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:th-nh": {
    "category": "infrastructure",
    "displayName": "Thành",
    "civilizationType": "CIVILIZATION_VIETNAM",
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH",
    "playerItemTypes": [
      "DISTRICT_THANH"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:thermal-bath": {
    "category": "infrastructure",
    "displayName": "Thermal Bath",
    "civilizationType": "CIVILIZATION_HUNGARY",
    "traitType": "TRAIT_CIVILIZATION_BUILDING_THERMAL_BATH",
    "playerItemTypes": [
      "BUILDING_THERMAL_BATH"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:tlachtli": {
    "category": "infrastructure",
    "displayName": "Tlachtli",
    "civilizationType": "CIVILIZATION_AZTEC",
    "traitType": "TRAIT_CIVILIZATION_BUILDING_TLACHTLI",
    "playerItemTypes": [
      "BUILDING_TLACHTLI"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:tsikhe": {
    "category": "infrastructure",
    "displayName": "Tsikhe",
    "civilizationType": "CIVILIZATION_GEORGIA",
    "traitType": "TRAIT_CIVILIZATION_BUILDING_TSIKHE",
    "playerItemTypes": [
      "BUILDING_TSIKHE"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:infrastructure:ziggurat": {
    "category": "infrastructure",
    "displayName": "Ziggurat",
    "civilizationType": "CIVILIZATION_SUMERIA",
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_ZIGGURAT",
    "playerItemTypes": [
      "IMPROVEMENT_ZIGGURAT"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:leaderAbility:america-abraham-lincoln": {
    "category": "leaderAbility",
    "displayName": "Emancipation Proclamation",
    "civilizationType": "CIVILIZATION_AMERICA",
    "traitType": "TRAIT_LEADER_LINCOLN",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_ABRAHAM_LINCOLN"
  },
  "civblitz:leaderAbility:america-teddy-roosevelt-bull-moose": {
    "category": "leaderAbility",
    "displayName": "Antiquities and Parks",
    "civilizationType": "CIVILIZATION_AMERICA",
    "traitType": "TRAIT_LEADER_ANTIQUES_AND_PARKS",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_T_ROOSEVELT"
  },
  "civblitz:leaderAbility:america-teddy-roosevelt-rough-rider": {
    "category": "leaderAbility",
    "displayName": "Roosevelt Corollary",
    "civilizationType": "CIVILIZATION_AMERICA",
    "traitType": "TRAIT_LEADER_ROOSEVELT_COROLLARY",
    "playerItemTypes": [],
    "grantTraitTypes": [
      "TRAIT_LEADER_UNIT_AMERICAN_ROUGH_RIDER"
    ],
    "grantPlayerItemTypes": [
      "UNIT_AMERICAN_ROUGH_RIDER"
    ],
    "leaderType": "LEADER_T_ROOSEVELT_ROUGHRIDER"
  },
  "civblitz:leaderAbility:arabia-saladin-sultan": {
    "category": "leaderAbility",
    "displayName": "The Victorious",
    "civilizationType": "CIVILIZATION_ARABIA",
    "traitType": "TRAIT_LEADER_SALADIN_ALT",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_SALADIN_ALT"
  },
  "civblitz:leaderAbility:arabia-saladin-vizier": {
    "category": "leaderAbility",
    "displayName": "Righteousness of the Faith",
    "civilizationType": "CIVILIZATION_ARABIA",
    "traitType": "TRAIT_LEADER_RIGHTEOUSNESS_OF_FAITH",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_SALADIN"
  },
  "civblitz:leaderAbility:australia-john-curtin": {
    "category": "leaderAbility",
    "displayName": "Citadel of Civilization",
    "civilizationType": "CIVILIZATION_AUSTRALIA",
    "traitType": "TRAIT_LEADER_CITADEL_CIVILIZATION",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_JOHN_CURTIN"
  },
  "civblitz:leaderAbility:aztec-montezuma": {
    "category": "leaderAbility",
    "displayName": "Gifts for the Tlatoani",
    "civilizationType": "CIVILIZATION_AZTEC",
    "traitType": "TRAIT_LEADER_GIFTS_FOR_TLATOANI",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_MONTEZUMA"
  },
  "civblitz:leaderAbility:babylon-hammurabi": {
    "category": "leaderAbility",
    "displayName": "Ninu Ilu Sirum",
    "civilizationType": "CIVILIZATION_BABYLON_STK",
    "traitType": "TRAIT_LEADER_HAMMURABI",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_HAMMURABI"
  },
  "civblitz:leaderAbility:brazil-pedro-ii": {
    "category": "leaderAbility",
    "displayName": "Magnanimous",
    "civilizationType": "CIVILIZATION_BRAZIL",
    "traitType": "TRAIT_LEADER_MAGNANIMOUS",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_PEDRO"
  },
  "civblitz:leaderAbility:byzantium-basil-ii": {
    "category": "leaderAbility",
    "displayName": "Porphyrogénnētos",
    "civilizationType": "CIVILIZATION_BYZANTIUM",
    "traitType": "TRAIT_LEADER_BASIL",
    "playerItemTypes": [],
    "grantTraitTypes": [
      "TRAIT_LEADER_UNIT_BYZANTINE_TAGMA"
    ],
    "grantPlayerItemTypes": [
      "UNIT_BYZANTINE_TAGMA"
    ],
    "leaderType": "LEADER_BASIL"
  },
  "civblitz:leaderAbility:byzantium-theodora": {
    "category": "leaderAbility",
    "displayName": "Metanoia",
    "civilizationType": "CIVILIZATION_BYZANTIUM",
    "traitType": "TRAIT_LEADER_THEODORA",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_THEODORA"
  },
  "civblitz:leaderAbility:canada-wilfrid-laurier": {
    "category": "leaderAbility",
    "displayName": "The Last Best West",
    "civilizationType": "CIVILIZATION_CANADA",
    "traitType": "TRAIT_LEADER_LAST_BEST_WEST",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_LAURIER"
  },
  "civblitz:leaderAbility:china-kublai-khan-china": {
    "category": "leaderAbility",
    "displayName": "Gerege",
    "civilizationType": "CIVILIZATION_CHINA",
    "traitType": "TRAIT_LEADER_KUBLAI",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_KUBLAI_KHAN_CHINA"
  },
  "civblitz:leaderAbility:china-qin-mandate-of-heaven": {
    "category": "leaderAbility",
    "displayName": "The First Emperor",
    "civilizationType": "CIVILIZATION_CHINA",
    "traitType": "FIRST_EMPEROR_TRAIT",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_QIN"
  },
  "civblitz:leaderAbility:china-qin-unifier": {
    "category": "leaderAbility",
    "displayName": "Thirty-Six Stratagems",
    "civilizationType": "CIVILIZATION_CHINA",
    "traitType": "TRAIT_LEADER_QIN",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_QIN_ALT"
  },
  "civblitz:leaderAbility:china-wu-zetian": {
    "category": "leaderAbility",
    "displayName": "Manual of Entrapment",
    "civilizationType": "CIVILIZATION_CHINA",
    "traitType": "TRAIT_LEADER_WU_ZETIAN",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_WU_ZETIAN"
  },
  "civblitz:leaderAbility:china-yongle": {
    "category": "leaderAbility",
    "displayName": "Lijia",
    "civilizationType": "CIVILIZATION_CHINA",
    "traitType": "TRAIT_LEADER_YONGLE",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_YONGLE"
  },
  "civblitz:leaderAbility:cree-poundmaker": {
    "category": "leaderAbility",
    "displayName": "Favorable Terms",
    "civilizationType": "CIVILIZATION_CREE",
    "traitType": "TRAIT_LEADER_ALLIANCE_AND_TRADE",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_POUNDMAKER"
  },
  "civblitz:leaderAbility:egypt-cleopatra-egyptian": {
    "category": "leaderAbility",
    "displayName": "Mediterranean's Bride",
    "civilizationType": "CIVILIZATION_EGYPT",
    "traitType": "TRAIT_LEADER_MEDITERRANEAN",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_CLEOPATRA"
  },
  "civblitz:leaderAbility:egypt-cleopatra-ptolemaic": {
    "category": "leaderAbility",
    "displayName": "Arrival of Hapi",
    "civilizationType": "CIVILIZATION_EGYPT",
    "traitType": "TRAIT_LEADER_CLEOPATRA_ALT",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_CLEOPATRA_ALT"
  },
  "civblitz:leaderAbility:egypt-ramses-ii": {
    "category": "leaderAbility",
    "displayName": "Abu Simbel",
    "civilizationType": "CIVILIZATION_EGYPT",
    "traitType": "TRAIT_LEADER_RAMSES",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_RAMSES"
  },
  "civblitz:leaderAbility:england-eleanor-of-aquitaine-england": {
    "category": "leaderAbility",
    "displayName": "Court of Love",
    "civilizationType": "CIVILIZATION_ENGLAND",
    "traitType": "TRAIT_LEADER_ELEANOR_LOYALTY",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_ELEANOR_ENGLAND"
  },
  "civblitz:leaderAbility:england-elizabeth-i": {
    "category": "leaderAbility",
    "displayName": "Drake's Legacy",
    "civilizationType": "CIVILIZATION_ENGLAND",
    "traitType": "TRAIT_LEADER_ELIZABETH",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_ELIZABETH"
  },
  "civblitz:leaderAbility:england-victoria-age-of-empire": {
    "category": "leaderAbility",
    "displayName": "Pax Britannica",
    "civilizationType": "CIVILIZATION_ENGLAND",
    "traitType": "TRAIT_LEADER_PAX_BRITANNICA",
    "playerItemTypes": [],
    "grantTraitTypes": [
      "TRAIT_LEADER_UNIT_ENGLISH_REDCOAT"
    ],
    "grantPlayerItemTypes": [
      "UNIT_ENGLISH_REDCOAT"
    ],
    "leaderType": "LEADER_VICTORIA"
  },
  "civblitz:leaderAbility:england-victoria-age-of-steam": {
    "category": "leaderAbility",
    "displayName": "Age of Steam",
    "civilizationType": "CIVILIZATION_ENGLAND",
    "traitType": "TRAIT_LEADER_VICTORIA_ALT",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_VICTORIA_ALT"
  },
  "civblitz:leaderAbility:ethiopia-menelik-ii": {
    "category": "leaderAbility",
    "displayName": "Council of Ministers",
    "civilizationType": "CIVILIZATION_ETHIOPIA",
    "traitType": "TRAIT_LEADER_MENELIK",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_MENELIK"
  },
  "civblitz:leaderAbility:france-catherine-de-medici-black-queen": {
    "category": "leaderAbility",
    "displayName": "Catherine's Flying Squadron",
    "civilizationType": "CIVILIZATION_FRANCE",
    "traitType": "FLYING_SQUADRON_TRAIT",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_CATHERINE_DE_MEDICI"
  },
  "civblitz:leaderAbility:france-catherine-de-medici-magnificence": {
    "category": "leaderAbility",
    "displayName": "Catherine’s Magnificences",
    "civilizationType": "CIVILIZATION_FRANCE",
    "traitType": "TRAIT_LEADER_MAGNIFICENCES",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_CATHERINE_DE_MEDICI_ALT"
  },
  "civblitz:leaderAbility:france-eleanor-of-aquitaine-france": {
    "category": "leaderAbility",
    "displayName": "Court of Love",
    "civilizationType": "CIVILIZATION_FRANCE",
    "traitType": "TRAIT_LEADER_ELEANOR_LOYALTY",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_ELEANOR_FRANCE"
  },
  "civblitz:leaderAbility:gaul-ambiorix": {
    "category": "leaderAbility",
    "displayName": "King of the Eburones",
    "civilizationType": "CIVILIZATION_GAUL",
    "traitType": "TRAIT_LEADER_AMBIORIX",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_AMBIORIX"
  },
  "civblitz:leaderAbility:georgia-tamar": {
    "category": "leaderAbility",
    "displayName": "Glory of the World, Kingdom and Faith",
    "civilizationType": "CIVILIZATION_GEORGIA",
    "traitType": "TRAIT_LEADER_RELIGION_CITY_STATES",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_TAMAR"
  },
  "civblitz:leaderAbility:germany-frederick-barbarossa": {
    "category": "leaderAbility",
    "displayName": "Holy Roman Emperor",
    "civilizationType": "CIVILIZATION_GERMANY",
    "traitType": "TRAIT_LEADER_HOLY_ROMAN_EMPEROR",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_BARBAROSSA"
  },
  "civblitz:leaderAbility:germany-ludwig-ii": {
    "category": "leaderAbility",
    "displayName": "Swan King",
    "civilizationType": "CIVILIZATION_GERMANY",
    "traitType": "TRAIT_LEADER_LUDWIG",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_LUDWIG"
  },
  "civblitz:leaderAbility:gran-colombia-simon-bolivar": {
    "category": "leaderAbility",
    "displayName": "Campaña Admirable",
    "civilizationType": "CIVILIZATION_GRAN_COLOMBIA",
    "traitType": "TRAIT_LEADER_CAMPANA_ADMIRABLE",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_SIMON_BOLIVAR"
  },
  "civblitz:leaderAbility:greece-gorgo": {
    "category": "leaderAbility",
    "displayName": "Thermopylae",
    "civilizationType": "CIVILIZATION_GREECE",
    "traitType": "CULTURE_KILLS_TRAIT",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_GORGO"
  },
  "civblitz:leaderAbility:greece-pericles": {
    "category": "leaderAbility",
    "displayName": "Surrounded by Glory",
    "civilizationType": "CIVILIZATION_GREECE",
    "traitType": "TRAIT_LEADER_SURROUNDED_BY_GLORY",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_PERICLES"
  },
  "civblitz:leaderAbility:hungary-matthias-corvinus": {
    "category": "leaderAbility",
    "displayName": "Raven King",
    "civilizationType": "CIVILIZATION_HUNGARY",
    "traitType": "TRAIT_LEADER_RAVEN_KING",
    "playerItemTypes": [],
    "grantTraitTypes": [
      "TRAIT_LEADER_UNIT_MATTHIAS_BLACK_ARMY"
    ],
    "grantPlayerItemTypes": [
      "UNIT_HUNGARY_BLACK_ARMY"
    ],
    "leaderType": "LEADER_MATTHIAS_CORVINUS"
  },
  "civblitz:leaderAbility:inca-pachacuti": {
    "category": "leaderAbility",
    "displayName": "Qhapaq Ñan",
    "civilizationType": "CIVILIZATION_INCA",
    "traitType": "TRAIT_LEADER_PACHACUTI_IMPROVEMENT_MOUNTAIN_ROAD",
    "playerItemTypes": [
      "IMPROVEMENT_MOUNTAIN_ROAD"
    ],
    "grantTraitTypes": [
      "TRAIT_LEADER_PACHACUTI_QHAPAQ_NAN"
    ],
    "grantPlayerItemTypes": [
      "IMPROVEMENT_MOUNTAIN_ROAD"
    ],
    "leaderType": "LEADER_PACHACUTI"
  },
  "civblitz:leaderAbility:india-chandragupta": {
    "category": "leaderAbility",
    "displayName": "Arthashastra",
    "civilizationType": "CIVILIZATION_INDIA",
    "traitType": "TRAIT_LEADER_ARTHASHASTRA",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_CHANDRAGUPTA"
  },
  "civblitz:leaderAbility:india-gandhi": {
    "category": "leaderAbility",
    "displayName": "Satyagraha",
    "civilizationType": "CIVILIZATION_INDIA",
    "traitType": "TRAIT_LEADER_SATYAGRAHA",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_GANDHI"
  },
  "civblitz:leaderAbility:indonesia-gitarja": {
    "category": "leaderAbility",
    "displayName": "Exalted Goddess of the Three Worlds",
    "civilizationType": "CIVILIZATION_INDONESIA",
    "traitType": "TRAIT_LEADER_EXALTED_GODDESS",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_GITARJA"
  },
  "civblitz:leaderAbility:japan-hojo-tokimune": {
    "category": "leaderAbility",
    "displayName": "Divine Wind",
    "civilizationType": "CIVILIZATION_JAPAN",
    "traitType": "TRAIT_LEADER_DIVINE_WIND",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_HOJO"
  },
  "civblitz:leaderAbility:japan-tokugawa": {
    "category": "leaderAbility",
    "displayName": "Bakuhan",
    "civilizationType": "CIVILIZATION_JAPAN",
    "traitType": "TRAIT_LEADER_TOKUGAWA",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_TOKUGAWA"
  },
  "civblitz:leaderAbility:khmer-jayavarman-vii": {
    "category": "leaderAbility",
    "displayName": "Monasteries of the King",
    "civilizationType": "CIVILIZATION_KHMER",
    "traitType": "TRAIT_LEADER_MONASTERIES_KING",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_JAYAVARMAN"
  },
  "civblitz:leaderAbility:kongo-mvemba-a-nzinga": {
    "category": "leaderAbility",
    "displayName": "Religious Convert",
    "civilizationType": "CIVILIZATION_KONGO",
    "traitType": "TRAIT_LEADER_RELIGIOUS_CONVERT",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_MVEMBA"
  },
  "civblitz:leaderAbility:kongo-nzinga-mbande": {
    "category": "leaderAbility",
    "displayName": "Queen of Ndongo and Matamba",
    "civilizationType": "CIVILIZATION_KONGO",
    "traitType": "TRAIT_LEADER_NZINGA_MBANDE",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_NZINGA_MBANDE"
  },
  "civblitz:leaderAbility:korea-sejong": {
    "category": "leaderAbility",
    "displayName": "Hangul",
    "civilizationType": "CIVILIZATION_KOREA",
    "traitType": "TRAIT_LEADER_SEJONG",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_SEJONG"
  },
  "civblitz:leaderAbility:korea-seondeok": {
    "category": "leaderAbility",
    "displayName": "Hwarang",
    "civilizationType": "CIVILIZATION_KOREA",
    "traitType": "TRAIT_LEADER_HWARANG",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_SEONDEOK"
  },
  "civblitz:leaderAbility:macedon-alexander": {
    "category": "leaderAbility",
    "displayName": "To World's End",
    "civilizationType": "CIVILIZATION_MACEDON",
    "traitType": "TRAIT_LEADER_TO_WORLDS_END",
    "playerItemTypes": [],
    "grantTraitTypes": [
      "TRAIT_LEADER_UNIT_HETAIROI"
    ],
    "grantPlayerItemTypes": [
      "UNIT_MACEDONIAN_HETAIROI"
    ],
    "leaderType": "LEADER_ALEXANDER"
  },
  "civblitz:leaderAbility:mali-mansa-musa": {
    "category": "leaderAbility",
    "displayName": "Sahel Merchants",
    "civilizationType": "CIVILIZATION_MALI",
    "traitType": "TRAIT_LEADER_SAHEL_MERCHANTS",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_MANSA_MUSA"
  },
  "civblitz:leaderAbility:mali-sundiata-keita": {
    "category": "leaderAbility",
    "displayName": "Sogolon",
    "civilizationType": "CIVILIZATION_MALI",
    "traitType": "TRAIT_LEADER_SUNDIATA_KEITA",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_SUNDIATA_KEITA"
  },
  "civblitz:leaderAbility:maori-kupe": {
    "category": "leaderAbility",
    "displayName": "Kupe's Voyage",
    "civilizationType": "CIVILIZATION_MAORI",
    "traitType": "TRAIT_LEADER_KUPES_VOYAGE",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_KUPE"
  },
  "civblitz:leaderAbility:mapuche-lautaro": {
    "category": "leaderAbility",
    "displayName": "Swift Hawk",
    "civilizationType": "CIVILIZATION_MAPUCHE",
    "traitType": "TRAIT_LEADER_LAUTARO_ABILITY",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_LAUTARO"
  },
  "civblitz:leaderAbility:maya-lady-six-sky": {
    "category": "leaderAbility",
    "displayName": "Ix Mutal Ajaw",
    "civilizationType": "CIVILIZATION_MAYA",
    "traitType": "TRAIT_LEADER_MUTAL",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_LADY_SIX_SKY"
  },
  "civblitz:leaderAbility:mongolia-genghis-khan": {
    "category": "leaderAbility",
    "displayName": "Mongol Horde",
    "civilizationType": "CIVILIZATION_MONGOLIA",
    "traitType": "TRAIT_LEADER_GENGHIS_KHAN_ABILITY",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_GENGHIS_KHAN"
  },
  "civblitz:leaderAbility:mongolia-kublai-khan-mongolia": {
    "category": "leaderAbility",
    "displayName": "Gerege",
    "civilizationType": "CIVILIZATION_MONGOLIA",
    "traitType": "TRAIT_LEADER_KUBLAI",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_KUBLAI_KHAN_MONGOLIA"
  },
  "civblitz:leaderAbility:netherlands-wilhelmina": {
    "category": "leaderAbility",
    "displayName": "Radio Oranje",
    "civilizationType": "CIVILIZATION_NETHERLANDS",
    "traitType": "TRAIT_RADIO_ORANJE",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_WILHELMINA"
  },
  "civblitz:leaderAbility:norway-harald-hardrada-konge": {
    "category": "leaderAbility",
    "displayName": "Thunderbolt of the North",
    "civilizationType": "CIVILIZATION_NORWAY",
    "traitType": "TRAIT_LEADER_MELEE_COASTAL_RAIDS",
    "playerItemTypes": [],
    "grantTraitTypes": [
      "TRAIT_LEADER_UNIT_NORWEGIAN_LONGSHIP"
    ],
    "grantPlayerItemTypes": [
      "UNIT_NORWEGIAN_LONGSHIP"
    ],
    "leaderType": "LEADER_HARDRADA"
  },
  "civblitz:leaderAbility:norway-harald-hardrada-varangian": {
    "category": "leaderAbility",
    "displayName": "Varangian Guard",
    "civilizationType": "CIVILIZATION_NORWAY",
    "traitType": "TRAIT_LEADER_HARALD_ALT",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_HARALD_ALT"
  },
  "civblitz:leaderAbility:nubia-amanitore": {
    "category": "leaderAbility",
    "displayName": "Kandake of Meroë",
    "civilizationType": "CIVILIZATION_NUBIA",
    "traitType": "TRAIT_LEADER_KANDAKE_OF_MEROE",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_AMANITORE"
  },
  "civblitz:leaderAbility:ottomans-suleiman-kanuni": {
    "category": "leaderAbility",
    "displayName": "Grand Vizier",
    "civilizationType": "CIVILIZATION_OTTOMAN",
    "traitType": "TRAIT_LEADER_SULEIMAN_GOVERNOR",
    "playerItemTypes": [],
    "grantTraitTypes": [
      "TRAIT_LEADER_UNIT_SULEIMAN_JANISSARY"
    ],
    "grantPlayerItemTypes": [
      "UNIT_SULEIMAN_JANISSARY"
    ],
    "leaderType": "LEADER_SULEIMAN"
  },
  "civblitz:leaderAbility:ottomans-suleiman-muhtesem": {
    "category": "leaderAbility",
    "displayName": "The Magnificent",
    "civilizationType": "CIVILIZATION_OTTOMAN",
    "traitType": "TRAIT_LEADER_SULEIMAN_ALT",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_SULEIMAN_ALT"
  },
  "civblitz:leaderAbility:persia-cyrus": {
    "category": "leaderAbility",
    "displayName": "Fall of Babylon",
    "civilizationType": "CIVILIZATION_PERSIA",
    "traitType": "TRAIT_LEADER_FALL_BABYLON",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_CYRUS"
  },
  "civblitz:leaderAbility:persia-nader-shah": {
    "category": "leaderAbility",
    "displayName": "Sword of Persia",
    "civilizationType": "CIVILIZATION_PERSIA",
    "traitType": "TRAIT_LEADER_NADER_SHAH",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_NADER_SHAH"
  },
  "civblitz:leaderAbility:phoenicia-dido": {
    "category": "leaderAbility",
    "displayName": "Founder of Carthage",
    "civilizationType": "CIVILIZATION_PHOENICIA",
    "traitType": "TRAIT_LEADER_FOUNDER_CARTHAGE",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_DIDO"
  },
  "civblitz:leaderAbility:poland-jadwiga": {
    "category": "leaderAbility",
    "displayName": "Lithuanian Union",
    "civilizationType": "CIVILIZATION_POLAND",
    "traitType": "TRAIT_LEADER_LITHUANIAN_UNION",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_JADWIGA"
  },
  "civblitz:leaderAbility:portugal-joao-iii": {
    "category": "leaderAbility",
    "displayName": "Porta do Cerco",
    "civilizationType": "CIVILIZATION_PORTUGAL",
    "traitType": "TRAIT_LEADER_JOAO_III",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_JOAO_III"
  },
  "civblitz:leaderAbility:rome-julius-caesar": {
    "category": "leaderAbility",
    "displayName": "Veni, Vidi, Vici",
    "civilizationType": "CIVILIZATION_ROME",
    "traitType": "TRAIT_LEADER_CAESAR",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_JULIUS_CAESAR"
  },
  "civblitz:leaderAbility:rome-trajan": {
    "category": "leaderAbility",
    "displayName": "Trajan's Column",
    "civilizationType": "CIVILIZATION_ROME",
    "traitType": "TRAJANS_COLUMN_TRAIT",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_TRAJAN"
  },
  "civblitz:leaderAbility:russia-peter": {
    "category": "leaderAbility",
    "displayName": "The Grand Embassy",
    "civilizationType": "CIVILIZATION_RUSSIA",
    "traitType": "TRAIT_LEADER_GRAND_EMBASSY",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_PETER_GREAT"
  },
  "civblitz:leaderAbility:scotland-robert-the-bruce": {
    "category": "leaderAbility",
    "displayName": "Bannockburn",
    "civilizationType": "CIVILIZATION_SCOTLAND",
    "traitType": "TRAIT_LEADER_BANNOCKBURN",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_ROBERT_THE_BRUCE"
  },
  "civblitz:leaderAbility:scythia-tomyris": {
    "category": "leaderAbility",
    "displayName": "Killer of Cyrus",
    "civilizationType": "CIVILIZATION_SCYTHIA",
    "traitType": "TRAIT_LEADER_KILLER_OF_CYRUS",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_TOMYRIS"
  },
  "civblitz:leaderAbility:spain-philip-ii": {
    "category": "leaderAbility",
    "displayName": "El Escorial",
    "civilizationType": "CIVILIZATION_SPAIN",
    "traitType": "TRAIT_LEADER_EL_ESCORIAL",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_PHILIP_II"
  },
  "civblitz:leaderAbility:sumeria-gilgamesh": {
    "category": "leaderAbility",
    "displayName": "Adventures of Enkidu",
    "civilizationType": "CIVILIZATION_SUMERIA",
    "traitType": "TRAIT_LEADER_ADVENTURES_ENKIDU",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_GILGAMESH"
  },
  "civblitz:leaderAbility:sweden-kristina": {
    "category": "leaderAbility",
    "displayName": "Minerva of the North",
    "civilizationType": "CIVILIZATION_SWEDEN",
    "traitType": "TRAIT_LEADER_KRISTINA_AUTO_THEME",
    "playerItemTypes": [],
    "grantTraitTypes": [
      "TRAIT_LEADER_BUILDING_QUEENS_BIBLIOTHEQUE"
    ],
    "grantPlayerItemTypes": [
      "BUILDING_QUEENS_BIBLIOTHEQUE"
    ],
    "leaderType": "LEADER_KRISTINA"
  },
  "civblitz:leaderAbility:vietnam-ba-trieu": {
    "category": "leaderAbility",
    "displayName": "Drive Out The Aggressors",
    "civilizationType": "CIVILIZATION_VIETNAM",
    "traitType": "TRAIT_LEADER_TRIEU",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_LADY_TRIEU"
  },
  "civblitz:leaderAbility:zulu-shaka": {
    "category": "leaderAbility",
    "displayName": "Amabutho",
    "civilizationType": "CIVILIZATION_ZULU",
    "traitType": "TRAIT_LEADER_AMABUTHO",
    "playerItemTypes": [],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "leaderType": "LEADER_SHAKA"
  },
  "civblitz:unit:barbary-corsair": {
    "category": "unit",
    "displayName": "Barbary Corsair",
    "civilizationType": "CIVILIZATION_OTTOMAN",
    "traitType": "TRAIT_CIVILIZATION_UNIT_OTTOMAN_BARBARY_CORSAIR",
    "playerItemTypes": [
      "UNIT_OTTOMAN_BARBARY_CORSAIR"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:berserker": {
    "category": "unit",
    "displayName": "Berserker",
    "civilizationType": "CIVILIZATION_NORWAY",
    "traitType": "TRAIT_CIVILIZATION_UNIT_NORWEGIAN_BERSERKER",
    "playerItemTypes": [
      "UNIT_NORWEGIAN_BERSERKER"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:bireme": {
    "category": "unit",
    "displayName": "Bireme",
    "civilizationType": "CIVILIZATION_PHOENICIA",
    "traitType": "TRAIT_CIVILIZATION_UNIT_PHOENICIA_BIREME",
    "playerItemTypes": [
      "UNIT_PHOENICIA_BIREME"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:black-army": {
    "category": "unit",
    "displayName": "Black Army",
    "civilizationType": "CIVILIZATION_HUNGARY",
    "traitType": "TRAIT_LEADER_UNIT_MATTHIAS_BLACK_ARMY",
    "playerItemTypes": [
      "UNIT_HUNGARY_BLACK_ARMY"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:carolean": {
    "category": "unit",
    "displayName": "Carolean",
    "civilizationType": "CIVILIZATION_SWEDEN",
    "traitType": "TRAIT_CIVILIZATION_UNIT_SWEDEN_CAROLEAN",
    "playerItemTypes": [
      "UNIT_SWEDEN_CAROLEAN"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:comandante-general": {
    "category": "unit",
    "displayName": "Comandante General",
    "civilizationType": "CIVILIZATION_GRAN_COLOMBIA",
    "traitType": "TRAIT_CIVILIZATION_COMANDANTE_GENERAL",
    "playerItemTypes": [
      "UNIT_COMANDANTE_GENERAL"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:conquistador": {
    "category": "unit",
    "displayName": "Conquistador",
    "civilizationType": "CIVILIZATION_SPAIN",
    "traitType": "TRAIT_CIVILIZATION_UNIT_SPANISH_CONQUISTADOR",
    "playerItemTypes": [
      "UNIT_SPANISH_CONQUISTADOR"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:cossack": {
    "category": "unit",
    "displayName": "Cossack",
    "civilizationType": "CIVILIZATION_RUSSIA",
    "traitType": "TRAIT_CIVILIZATION_UNIT_RUSSIAN_COSSACK",
    "playerItemTypes": [
      "UNIT_RUSSIAN_COSSACK"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:crouching-tiger": {
    "category": "unit",
    "displayName": "Crouching Tiger",
    "civilizationType": "CIVILIZATION_CHINA",
    "traitType": "TRAIT_CIVILIZATION_UNIT_CHINESE_CROUCHING_TIGER",
    "playerItemTypes": [
      "UNIT_CHINESE_CROUCHING_TIGER"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:de-zeven-provinci-n": {
    "category": "unit",
    "displayName": "De Zeven Provinciën",
    "civilizationType": "CIVILIZATION_NETHERLANDS",
    "traitType": "TRAIT_CIVILIZATION_UNIT_DUTCH_ZEVEN_PROVINCIEN",
    "playerItemTypes": [
      "UNIT_DE_ZEVEN_PROVINCIEN"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:digger": {
    "category": "unit",
    "displayName": "Digger",
    "civilizationType": "CIVILIZATION_AUSTRALIA",
    "traitType": "TRAIT_CIVILIZATION_UNIT_DIGGER",
    "playerItemTypes": [
      "UNIT_DIGGER"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:domrey": {
    "category": "unit",
    "displayName": "Domrey",
    "civilizationType": "CIVILIZATION_KHMER",
    "traitType": "TRAIT_CIVILIZATION_UNIT_KHMER_DOMREY",
    "playerItemTypes": [
      "UNIT_KHMER_DOMREY"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:dromon": {
    "category": "unit",
    "displayName": "Dromon",
    "civilizationType": "CIVILIZATION_BYZANTIUM",
    "traitType": "TRAIT_CIVILIZATION_UNIT_BYZANTINE_DROMON",
    "playerItemTypes": [
      "UNIT_BYZANTINE_DROMON"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:eagle-warrior": {
    "category": "unit",
    "displayName": "Eagle Warrior",
    "civilizationType": "CIVILIZATION_AZTEC",
    "traitType": "TRAIT_CIVILIZATION_UNIT_AZTEC_EAGLE_WARRIOR",
    "playerItemTypes": [
      "UNIT_AZTEC_EAGLE_WARRIOR"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:gaesatae": {
    "category": "unit",
    "displayName": "Gaesatae",
    "civilizationType": "CIVILIZATION_GAUL",
    "traitType": "TRAIT_CIVILIZATION_UNIT_GAUL_GAESATAE",
    "playerItemTypes": [
      "UNIT_GAUL_GAESATAE"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:garde-imp-riale": {
    "category": "unit",
    "displayName": "Garde Impériale",
    "civilizationType": "CIVILIZATION_FRANCE",
    "traitType": "TRAIT_CIVILIZATION_UNIT_FRENCH_GARDE_IMPERIALE",
    "playerItemTypes": [
      "UNIT_FRENCH_GARDE_IMPERIALE"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:hetairos": {
    "category": "unit",
    "displayName": "Hetairos",
    "civilizationType": "CIVILIZATION_MACEDON",
    "traitType": "TRAIT_LEADER_UNIT_HETAIROI",
    "playerItemTypes": [
      "UNIT_MACEDONIAN_HETAIROI"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:highlander": {
    "category": "unit",
    "displayName": "Highlander",
    "civilizationType": "CIVILIZATION_SCOTLAND",
    "traitType": "TRAIT_CIVILIZATION_UNIT_SCOTTISH_HIGHLANDER",
    "playerItemTypes": [
      "UNIT_SCOTTISH_HIGHLANDER"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:hoplite": {
    "category": "unit",
    "displayName": "Hoplite",
    "civilizationType": "CIVILIZATION_GREECE",
    "traitType": "TRAIT_CIVILIZATION_UNIT_GREEK_HOPLITE",
    "playerItemTypes": [
      "UNIT_GREEK_HOPLITE"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:hulche": {
    "category": "unit",
    "displayName": "Hul'che",
    "civilizationType": "CIVILIZATION_MAYA",
    "traitType": "TRAIT_CIVILIZATION_HULCHE",
    "playerItemTypes": [
      "UNIT_MAYAN_HULCHE"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:husz-r": {
    "category": "unit",
    "displayName": "Huszár",
    "civilizationType": "CIVILIZATION_HUNGARY",
    "traitType": "TRAIT_CIVILIZATION_UNIT_HUNGARY_HUSZAR",
    "playerItemTypes": [
      "UNIT_HUNGARY_HUSZAR"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:hwacha": {
    "category": "unit",
    "displayName": "Hwacha",
    "civilizationType": "CIVILIZATION_KOREA",
    "traitType": "TRAIT_CIVILIZATION_UNIT_KOREAN_HWACHA",
    "playerItemTypes": [
      "UNIT_KOREAN_HWACHA"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:hypaspist": {
    "category": "unit",
    "displayName": "Hypaspist",
    "civilizationType": "CIVILIZATION_MACEDON",
    "traitType": "TRAIT_CIVILIZATION_UNIT_HYPASPIST",
    "playerItemTypes": [
      "UNIT_MACEDONIAN_HYPASPIST"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:immortal": {
    "category": "unit",
    "displayName": "Immortal",
    "civilizationType": "CIVILIZATION_PERSIA",
    "traitType": "TRAIT_CIVILIZATION_UNIT_IMMORTAL",
    "playerItemTypes": [
      "UNIT_PERSIAN_IMMORTAL"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:impi": {
    "category": "unit",
    "displayName": "Impi",
    "civilizationType": "CIVILIZATION_ZULU",
    "traitType": "TRAIT_CIVILIZATION_UNIT_ZULU_IMPI",
    "playerItemTypes": [
      "UNIT_ZULU_IMPI"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:janissary": {
    "category": "unit",
    "displayName": "Janissary",
    "civilizationType": "CIVILIZATION_OTTOMAN",
    "traitType": "TRAIT_LEADER_UNIT_SULEIMAN_JANISSARY",
    "playerItemTypes": [
      "UNIT_SULEIMAN_JANISSARY"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:jong": {
    "category": "unit",
    "displayName": "Jong",
    "civilizationType": "CIVILIZATION_INDONESIA",
    "traitType": "TRAIT_CIVILIZATION_UNIT_INDONESIAN_JONG",
    "playerItemTypes": [
      "UNIT_INDONESIAN_JONG"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:keshig": {
    "category": "unit",
    "displayName": "Keshig",
    "civilizationType": "CIVILIZATION_MONGOLIA",
    "traitType": "TRAIT_CIVILIZATION_UNIT_MONGOLIAN_KESHIG",
    "playerItemTypes": [
      "UNIT_MONGOLIAN_KESHIG"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:khevsur": {
    "category": "unit",
    "displayName": "Khevsur",
    "civilizationType": "CIVILIZATION_GEORGIA",
    "traitType": "TRAIT_CIVILIZATION_UNIT_GEORGIAN_KHEVSURETI",
    "playerItemTypes": [
      "UNIT_GEORGIAN_KHEVSURETI"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:legion": {
    "category": "unit",
    "displayName": "Legion",
    "civilizationType": "CIVILIZATION_ROME",
    "traitType": "TRAIT_CIVILIZATION_UNIT_ROMAN_LEGION",
    "playerItemTypes": [
      "UNIT_ROMAN_LEGION"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:llanero": {
    "category": "unit",
    "displayName": "Llanero",
    "civilizationType": "CIVILIZATION_GRAN_COLOMBIA",
    "traitType": "TRAIT_CIVILIZATION_LLANERO",
    "playerItemTypes": [
      "UNIT_COLOMBIAN_LLANERO"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:mal-n-raider": {
    "category": "unit",
    "displayName": "Malón Raider",
    "civilizationType": "CIVILIZATION_MAPUCHE",
    "traitType": "TRAIT_CIVILIZATION_UNIT_MAPUCHE_MALON_RAIDER",
    "playerItemTypes": [
      "UNIT_MAPUCHE_MALON_RAIDER"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:mamluk": {
    "category": "unit",
    "displayName": "Mamluk",
    "civilizationType": "CIVILIZATION_ARABIA",
    "traitType": "TRAIT_CIVILIZATION_UNIT_ARABIAN_MAMLUK",
    "playerItemTypes": [
      "UNIT_ARABIAN_MAMLUK"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:mandekalu-cavalry": {
    "category": "unit",
    "displayName": "Mandekalu Cavalry",
    "civilizationType": "CIVILIZATION_MALI",
    "traitType": "TRAIT_CIVILIZATION_UNIT_MALI_MANDEKALU_CAVALRY",
    "playerItemTypes": [
      "UNIT_MALI_MANDEKALU_CAVALRY"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:maryannu-chariot-archer": {
    "category": "unit",
    "displayName": "Maryannu Chariot Archer",
    "civilizationType": "CIVILIZATION_EGYPT",
    "traitType": "TRAIT_CIVILIZATION_UNIT_EGYPTIAN_CHARIOT_ARCHER",
    "playerItemTypes": [
      "UNIT_EGYPTIAN_CHARIOT_ARCHER"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:minas-geraes": {
    "category": "unit",
    "displayName": "Minas Geraes",
    "civilizationType": "CIVILIZATION_BRAZIL",
    "traitType": "TRAIT_CIVILIZATION_UNIT_BRAZILIAN_MINAS_GERAES",
    "playerItemTypes": [
      "UNIT_BRAZILIAN_MINAS_GERAES"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:mountie": {
    "category": "unit",
    "displayName": "Mountie",
    "civilizationType": "CIVILIZATION_CANADA",
    "traitType": "TRAIT_CIVILIZATION_UNIT_CANADA_MOUNTIE",
    "playerItemTypes": [
      "UNIT_CANADA_MOUNTIE"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:nau": {
    "category": "unit",
    "displayName": "Nau",
    "civilizationType": "CIVILIZATION_PORTUGAL",
    "traitType": "TRAIT_CIVILIZATION_UNIT_PORTUGUESE_NAU",
    "playerItemTypes": [
      "UNIT_PORTUGUESE_NAU"
    ],
    "grantTraitTypes": [
      "TRAIT_CIVILIZATION_IMPROVEMENT_FEITORIA"
    ],
    "grantPlayerItemTypes": [
      "IMPROVEMENT_FEITORIA"
    ]
  },
  "civblitz:unit:ngao-mbeba": {
    "category": "unit",
    "displayName": "Ngao Mbeba",
    "civilizationType": "CIVILIZATION_KONGO",
    "traitType": "TRAIT_CIVILIZATION_UNIT_KONGO_SHIELD_BEARER",
    "playerItemTypes": [
      "UNIT_KONGO_SHIELD_BEARER"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:okihtcitaw": {
    "category": "unit",
    "displayName": "Okihtcitaw",
    "civilizationType": "CIVILIZATION_CREE",
    "traitType": "TRAIT_CIVILIZATION_UNIT_CREE_OKIHTCITAW",
    "playerItemTypes": [
      "UNIT_CREE_OKIHTCITAW"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:oromo-cavalry": {
    "category": "unit",
    "displayName": "Oromo Cavalry",
    "civilizationType": "CIVILIZATION_ETHIOPIA",
    "traitType": "TRAIT_CIVILIZATION_UNIT_ETHIOPIAN_OROMO_CAVALRY",
    "playerItemTypes": [
      "UNIT_ETHIOPIAN_OROMO_CAVALRY"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:p-51-mustang": {
    "category": "unit",
    "displayName": "P-51 Mustang",
    "civilizationType": "CIVILIZATION_AMERICA",
    "traitType": "TRAIT_CIVILIZATION_UNIT_AMERICAN_P51",
    "playerItemTypes": [
      "UNIT_AMERICAN_P51"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "unsupportedReason": "The upstream Civ Blitz normal-card registry intentionally excludes the P-51 Mustang trait because it is not safe to transplant."
  },
  "civblitz:unit:p-tati-archer": {
    "category": "unit",
    "displayName": "Pítati Archer",
    "civilizationType": "CIVILIZATION_NUBIA",
    "traitType": "TRAIT_CIVILIZATION_UNIT_NUBIAN_PITATI",
    "playerItemTypes": [
      "UNIT_NUBIAN_PITATI"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:redcoat": {
    "category": "unit",
    "displayName": "Redcoat",
    "civilizationType": "CIVILIZATION_ENGLAND",
    "traitType": "TRAIT_LEADER_UNIT_ENGLISH_REDCOAT",
    "playerItemTypes": [
      "UNIT_ENGLISH_REDCOAT"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:rough-rider": {
    "category": "unit",
    "displayName": "Rough Rider",
    "civilizationType": "CIVILIZATION_AMERICA",
    "traitType": "TRAIT_LEADER_UNIT_AMERICAN_ROUGH_RIDER",
    "playerItemTypes": [
      "UNIT_AMERICAN_ROUGH_RIDER"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:sabum-kibittum": {
    "category": "unit",
    "displayName": "Sabum Kibittum",
    "civilizationType": "CIVILIZATION_BABYLON_STK",
    "traitType": "TRAIT_CIVILIZATION_UNIT_BABYLONIAN_SABUM_KIBITTUM",
    "playerItemTypes": [
      "UNIT_BABYLONIAN_SABUM_KIBITTUM"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:saka-horse-archer": {
    "category": "unit",
    "displayName": "Saka Horse Archer",
    "civilizationType": "CIVILIZATION_SCYTHIA",
    "traitType": "TRAIT_CIVILIZATION_UNIT_SCYTHIAN_HORSE_ARCHER",
    "playerItemTypes": [
      "UNIT_SCYTHIAN_HORSE_ARCHER"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:samurai": {
    "category": "unit",
    "displayName": "Samurai",
    "civilizationType": "CIVILIZATION_JAPAN",
    "traitType": "TRAIT_CIVILIZATION_UNIT_JAPANESE_SAMURAI",
    "playerItemTypes": [
      "UNIT_JAPANESE_SAMURAI"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:sea-dog": {
    "category": "unit",
    "displayName": "Sea Dog",
    "civilizationType": "CIVILIZATION_ENGLAND",
    "traitType": "TRAIT_CIVILIZATION_UNIT_ENGLISH_SEADOG",
    "playerItemTypes": [
      "UNIT_ENGLISH_SEADOG"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:tagma": {
    "category": "unit",
    "displayName": "Tagma",
    "civilizationType": "CIVILIZATION_BYZANTIUM",
    "traitType": "TRAIT_LEADER_UNIT_BYZANTINE_TAGMA",
    "playerItemTypes": [
      "UNIT_BYZANTINE_TAGMA"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:toa": {
    "category": "unit",
    "displayName": "Toa",
    "civilizationType": "CIVILIZATION_MAORI",
    "traitType": "TRAIT_CIVILIZATION_UNIT_MAORI_TOA",
    "playerItemTypes": [
      "UNIT_MAORI_TOA"
    ],
    "grantTraitTypes": [
      "TRAIT_CIVILIZATION_IMPROVEMENT_MAORI_PA"
    ],
    "grantPlayerItemTypes": [
      "IMPROVEMENT_MAORI_PA"
    ]
  },
  "civblitz:unit:u-boat": {
    "category": "unit",
    "displayName": "U-Boat",
    "civilizationType": "CIVILIZATION_GERMANY",
    "traitType": "TRAIT_CIVILIZATION_UNIT_GERMAN_UBOAT",
    "playerItemTypes": [
      "UNIT_GERMAN_UBOAT"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": [],
    "unsupportedReason": "The upstream Civ Blitz normal-card registry intentionally excludes the U-Boat trait because it is not safe to transplant."
  },
  "civblitz:unit:varu": {
    "category": "unit",
    "displayName": "Varu",
    "civilizationType": "CIVILIZATION_INDIA",
    "traitType": "TRAIT_CIVILIZATION_UNIT_INDIAN_VARU",
    "playerItemTypes": [
      "UNIT_INDIAN_VARU"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:viking-longship": {
    "category": "unit",
    "displayName": "Viking Longship",
    "civilizationType": "CIVILIZATION_NORWAY",
    "traitType": "TRAIT_LEADER_UNIT_NORWEGIAN_LONGSHIP",
    "playerItemTypes": [
      "UNIT_NORWEGIAN_LONGSHIP"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:voi-chi-n": {
    "category": "unit",
    "displayName": "Voi Chiến",
    "civilizationType": "CIVILIZATION_VIETNAM",
    "traitType": "TRAIT_CIVILIZATION_UNIT_VIETNAMESE_VOI_CHIEN",
    "playerItemTypes": [
      "UNIT_VIETNAMESE_VOI_CHIEN"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:war-cart": {
    "category": "unit",
    "displayName": "War-Cart",
    "civilizationType": "CIVILIZATION_SUMERIA",
    "traitType": "TRAIT_CIVILIZATION_UNIT_SUMERIAN_WAR_CART",
    "playerItemTypes": [
      "UNIT_SUMERIAN_WAR_CART"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:warakaq": {
    "category": "unit",
    "displayName": "Warak’aq",
    "civilizationType": "CIVILIZATION_INCA",
    "traitType": "TRAIT_CIVILIZATION_UNIT_INCA_WARAKAQ",
    "playerItemTypes": [
      "UNIT_INCA_WARAKAQ"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  },
  "civblitz:unit:winged-hussar": {
    "category": "unit",
    "displayName": "Winged Hussar",
    "civilizationType": "CIVILIZATION_POLAND",
    "traitType": "TRAIT_CIVILIZATION_UNIT_POLISH_HUSSAR",
    "playerItemTypes": [
      "UNIT_POLISH_HUSSAR"
    ],
    "grantTraitTypes": [],
    "grantPlayerItemTypes": []
  }
} as const satisfies Record<string, CivBlitzModComponentMetadata>

export const componentIdsByVersion = {
  "live": [
    "civblitz:civilizationAbility:america",
    "civblitz:civilizationAbility:arabia",
    "civblitz:civilizationAbility:australia",
    "civblitz:civilizationAbility:aztec",
    "civblitz:civilizationAbility:babylon",
    "civblitz:civilizationAbility:brazil",
    "civblitz:civilizationAbility:byzantium",
    "civblitz:civilizationAbility:canada",
    "civblitz:civilizationAbility:china",
    "civblitz:civilizationAbility:cree",
    "civblitz:civilizationAbility:egypt",
    "civblitz:civilizationAbility:england",
    "civblitz:civilizationAbility:ethiopia",
    "civblitz:civilizationAbility:france",
    "civblitz:civilizationAbility:gaul",
    "civblitz:civilizationAbility:georgia",
    "civblitz:civilizationAbility:germany",
    "civblitz:civilizationAbility:gran-colombia",
    "civblitz:civilizationAbility:greece",
    "civblitz:civilizationAbility:hungary",
    "civblitz:civilizationAbility:inca",
    "civblitz:civilizationAbility:india",
    "civblitz:civilizationAbility:indonesia",
    "civblitz:civilizationAbility:japan",
    "civblitz:civilizationAbility:khmer",
    "civblitz:civilizationAbility:kongo",
    "civblitz:civilizationAbility:korea",
    "civblitz:civilizationAbility:m-ori",
    "civblitz:civilizationAbility:macedon",
    "civblitz:civilizationAbility:mali",
    "civblitz:civilizationAbility:mapuche",
    "civblitz:civilizationAbility:maya",
    "civblitz:civilizationAbility:mongolia",
    "civblitz:civilizationAbility:netherlands",
    "civblitz:civilizationAbility:norway",
    "civblitz:civilizationAbility:nubia",
    "civblitz:civilizationAbility:ottomans",
    "civblitz:civilizationAbility:persia",
    "civblitz:civilizationAbility:phoenicia",
    "civblitz:civilizationAbility:poland",
    "civblitz:civilizationAbility:portugal",
    "civblitz:civilizationAbility:rome",
    "civblitz:civilizationAbility:russia",
    "civblitz:civilizationAbility:scotland",
    "civblitz:civilizationAbility:scythia",
    "civblitz:civilizationAbility:spain",
    "civblitz:civilizationAbility:sumeria",
    "civblitz:civilizationAbility:sweden",
    "civblitz:civilizationAbility:vietnam",
    "civblitz:civilizationAbility:zulu",
    "civblitz:infrastructure:acropolis",
    "civblitz:infrastructure:basilikoi-paides",
    "civblitz:infrastructure:bath",
    "civblitz:infrastructure:ch-teau",
    "civblitz:infrastructure:chemamull",
    "civblitz:infrastructure:copacabana",
    "civblitz:infrastructure:cothon",
    "civblitz:infrastructure:electronics-factory",
    "civblitz:infrastructure:feitoria",
    "civblitz:infrastructure:film-studio",
    "civblitz:infrastructure:golf-course",
    "civblitz:infrastructure:grand-bazaar",
    "civblitz:infrastructure:great-wall",
    "civblitz:infrastructure:hacienda",
    "civblitz:infrastructure:hansa",
    "civblitz:infrastructure:hippodrome",
    "civblitz:infrastructure:ice-hockey-rink",
    "civblitz:infrastructure:ikanda",
    "civblitz:infrastructure:kampung",
    "civblitz:infrastructure:kurgan",
    "civblitz:infrastructure:lavra",
    "civblitz:infrastructure:madrasa",
    "civblitz:infrastructure:marae",
    "civblitz:infrastructure:mbanza",
    "civblitz:infrastructure:mekewap",
    "civblitz:infrastructure:mission",
    "civblitz:infrastructure:navigation-school",
    "civblitz:infrastructure:nubian-pyramid",
    "civblitz:infrastructure:observatory",
    "civblitz:infrastructure:open-air-museum",
    "civblitz:infrastructure:oppidum",
    "civblitz:infrastructure:ordu",
    "civblitz:infrastructure:outback-station",
    "civblitz:infrastructure:p",
    "civblitz:infrastructure:pairidaeza",
    "civblitz:infrastructure:palgum",
    "civblitz:infrastructure:polder",
    "civblitz:infrastructure:prasat",
    "civblitz:infrastructure:qhapaq-an",
    "civblitz:infrastructure:queens-bibliotheque",
    "civblitz:infrastructure:rock-hewn-church",
    "civblitz:infrastructure:royal-navy-dockyard",
    "civblitz:infrastructure:seowon",
    "civblitz:infrastructure:sphinx",
    "civblitz:infrastructure:stave-church",
    "civblitz:infrastructure:stepwell",
    "civblitz:infrastructure:street-carnival",
    "civblitz:infrastructure:suguba",
    "civblitz:infrastructure:sukiennice",
    "civblitz:infrastructure:terrace-farm",
    "civblitz:infrastructure:th-nh",
    "civblitz:infrastructure:thermal-bath",
    "civblitz:infrastructure:tlachtli",
    "civblitz:infrastructure:tsikhe",
    "civblitz:infrastructure:ziggurat",
    "civblitz:leaderAbility:america-abraham-lincoln",
    "civblitz:leaderAbility:america-teddy-roosevelt-bull-moose",
    "civblitz:leaderAbility:america-teddy-roosevelt-rough-rider",
    "civblitz:leaderAbility:arabia-saladin-sultan",
    "civblitz:leaderAbility:arabia-saladin-vizier",
    "civblitz:leaderAbility:australia-john-curtin",
    "civblitz:leaderAbility:aztec-montezuma",
    "civblitz:leaderAbility:babylon-hammurabi",
    "civblitz:leaderAbility:brazil-pedro-ii",
    "civblitz:leaderAbility:byzantium-basil-ii",
    "civblitz:leaderAbility:byzantium-theodora",
    "civblitz:leaderAbility:canada-wilfrid-laurier",
    "civblitz:leaderAbility:china-kublai-khan-china",
    "civblitz:leaderAbility:china-qin-mandate-of-heaven",
    "civblitz:leaderAbility:china-qin-unifier",
    "civblitz:leaderAbility:china-wu-zetian",
    "civblitz:leaderAbility:china-yongle",
    "civblitz:leaderAbility:cree-poundmaker",
    "civblitz:leaderAbility:egypt-cleopatra-egyptian",
    "civblitz:leaderAbility:egypt-cleopatra-ptolemaic",
    "civblitz:leaderAbility:egypt-ramses-ii",
    "civblitz:leaderAbility:england-eleanor-of-aquitaine-england",
    "civblitz:leaderAbility:england-elizabeth-i",
    "civblitz:leaderAbility:england-victoria-age-of-empire",
    "civblitz:leaderAbility:england-victoria-age-of-steam",
    "civblitz:leaderAbility:ethiopia-menelik-ii",
    "civblitz:leaderAbility:france-catherine-de-medici-black-queen",
    "civblitz:leaderAbility:france-catherine-de-medici-magnificence",
    "civblitz:leaderAbility:france-eleanor-of-aquitaine-france",
    "civblitz:leaderAbility:gaul-ambiorix",
    "civblitz:leaderAbility:georgia-tamar",
    "civblitz:leaderAbility:germany-frederick-barbarossa",
    "civblitz:leaderAbility:germany-ludwig-ii",
    "civblitz:leaderAbility:gran-colombia-simon-bolivar",
    "civblitz:leaderAbility:greece-gorgo",
    "civblitz:leaderAbility:greece-pericles",
    "civblitz:leaderAbility:hungary-matthias-corvinus",
    "civblitz:leaderAbility:inca-pachacuti",
    "civblitz:leaderAbility:india-chandragupta",
    "civblitz:leaderAbility:india-gandhi",
    "civblitz:leaderAbility:indonesia-gitarja",
    "civblitz:leaderAbility:japan-hojo-tokimune",
    "civblitz:leaderAbility:japan-tokugawa",
    "civblitz:leaderAbility:khmer-jayavarman-vii",
    "civblitz:leaderAbility:kongo-mvemba-a-nzinga",
    "civblitz:leaderAbility:kongo-nzinga-mbande",
    "civblitz:leaderAbility:korea-sejong",
    "civblitz:leaderAbility:korea-seondeok",
    "civblitz:leaderAbility:macedon-alexander",
    "civblitz:leaderAbility:mali-mansa-musa",
    "civblitz:leaderAbility:mali-sundiata-keita",
    "civblitz:leaderAbility:maori-kupe",
    "civblitz:leaderAbility:mapuche-lautaro",
    "civblitz:leaderAbility:maya-lady-six-sky",
    "civblitz:leaderAbility:mongolia-genghis-khan",
    "civblitz:leaderAbility:mongolia-kublai-khan-mongolia",
    "civblitz:leaderAbility:netherlands-wilhelmina",
    "civblitz:leaderAbility:norway-harald-hardrada-konge",
    "civblitz:leaderAbility:norway-harald-hardrada-varangian",
    "civblitz:leaderAbility:nubia-amanitore",
    "civblitz:leaderAbility:ottomans-suleiman-kanuni",
    "civblitz:leaderAbility:ottomans-suleiman-muhtesem",
    "civblitz:leaderAbility:persia-cyrus",
    "civblitz:leaderAbility:persia-nader-shah",
    "civblitz:leaderAbility:phoenicia-dido",
    "civblitz:leaderAbility:poland-jadwiga",
    "civblitz:leaderAbility:portugal-joao-iii",
    "civblitz:leaderAbility:rome-julius-caesar",
    "civblitz:leaderAbility:rome-trajan",
    "civblitz:leaderAbility:russia-peter",
    "civblitz:leaderAbility:scotland-robert-the-bruce",
    "civblitz:leaderAbility:scythia-tomyris",
    "civblitz:leaderAbility:spain-philip-ii",
    "civblitz:leaderAbility:sumeria-gilgamesh",
    "civblitz:leaderAbility:sweden-kristina",
    "civblitz:leaderAbility:vietnam-ba-trieu",
    "civblitz:leaderAbility:zulu-shaka",
    "civblitz:unit:barbary-corsair",
    "civblitz:unit:berserker",
    "civblitz:unit:bireme",
    "civblitz:unit:black-army",
    "civblitz:unit:carolean",
    "civblitz:unit:comandante-general",
    "civblitz:unit:conquistador",
    "civblitz:unit:cossack",
    "civblitz:unit:crouching-tiger",
    "civblitz:unit:de-zeven-provinci-n",
    "civblitz:unit:digger",
    "civblitz:unit:domrey",
    "civblitz:unit:dromon",
    "civblitz:unit:eagle-warrior",
    "civblitz:unit:gaesatae",
    "civblitz:unit:garde-imp-riale",
    "civblitz:unit:hetairos",
    "civblitz:unit:highlander",
    "civblitz:unit:hoplite",
    "civblitz:unit:hulche",
    "civblitz:unit:husz-r",
    "civblitz:unit:hwacha",
    "civblitz:unit:hypaspist",
    "civblitz:unit:immortal",
    "civblitz:unit:impi",
    "civblitz:unit:janissary",
    "civblitz:unit:jong",
    "civblitz:unit:keshig",
    "civblitz:unit:khevsur",
    "civblitz:unit:legion",
    "civblitz:unit:llanero",
    "civblitz:unit:mal-n-raider",
    "civblitz:unit:mamluk",
    "civblitz:unit:mandekalu-cavalry",
    "civblitz:unit:maryannu-chariot-archer",
    "civblitz:unit:minas-geraes",
    "civblitz:unit:mountie",
    "civblitz:unit:nau",
    "civblitz:unit:ngao-mbeba",
    "civblitz:unit:okihtcitaw",
    "civblitz:unit:oromo-cavalry",
    "civblitz:unit:p-51-mustang",
    "civblitz:unit:p-tati-archer",
    "civblitz:unit:redcoat",
    "civblitz:unit:rough-rider",
    "civblitz:unit:sabum-kibittum",
    "civblitz:unit:saka-horse-archer",
    "civblitz:unit:samurai",
    "civblitz:unit:sea-dog",
    "civblitz:unit:tagma",
    "civblitz:unit:toa",
    "civblitz:unit:u-boat",
    "civblitz:unit:varu",
    "civblitz:unit:viking-longship",
    "civblitz:unit:voi-chi-n",
    "civblitz:unit:war-cart",
    "civblitz:unit:warakaq",
    "civblitz:unit:winged-hussar"
  ],
  "beta": [
    "civblitz:civilizationAbility:america",
    "civblitz:civilizationAbility:arabia",
    "civblitz:civilizationAbility:australia",
    "civblitz:civilizationAbility:aztec",
    "civblitz:civilizationAbility:babylon",
    "civblitz:civilizationAbility:brazil",
    "civblitz:civilizationAbility:byzantium",
    "civblitz:civilizationAbility:canada",
    "civblitz:civilizationAbility:china",
    "civblitz:civilizationAbility:cree",
    "civblitz:civilizationAbility:egypt",
    "civblitz:civilizationAbility:england",
    "civblitz:civilizationAbility:ethiopia",
    "civblitz:civilizationAbility:france",
    "civblitz:civilizationAbility:gaul",
    "civblitz:civilizationAbility:georgia",
    "civblitz:civilizationAbility:germany",
    "civblitz:civilizationAbility:gran-colombia",
    "civblitz:civilizationAbility:greece",
    "civblitz:civilizationAbility:hungary",
    "civblitz:civilizationAbility:inca",
    "civblitz:civilizationAbility:india",
    "civblitz:civilizationAbility:indonesia",
    "civblitz:civilizationAbility:japan",
    "civblitz:civilizationAbility:khmer",
    "civblitz:civilizationAbility:kongo",
    "civblitz:civilizationAbility:korea",
    "civblitz:civilizationAbility:m-ori",
    "civblitz:civilizationAbility:macedon",
    "civblitz:civilizationAbility:mali",
    "civblitz:civilizationAbility:mapuche",
    "civblitz:civilizationAbility:maya",
    "civblitz:civilizationAbility:mongolia",
    "civblitz:civilizationAbility:netherlands",
    "civblitz:civilizationAbility:norway",
    "civblitz:civilizationAbility:nubia",
    "civblitz:civilizationAbility:ottomans",
    "civblitz:civilizationAbility:persia",
    "civblitz:civilizationAbility:phoenicia",
    "civblitz:civilizationAbility:poland",
    "civblitz:civilizationAbility:portugal",
    "civblitz:civilizationAbility:rome",
    "civblitz:civilizationAbility:russia",
    "civblitz:civilizationAbility:scotland",
    "civblitz:civilizationAbility:scythia",
    "civblitz:civilizationAbility:spain",
    "civblitz:civilizationAbility:sumeria",
    "civblitz:civilizationAbility:sweden",
    "civblitz:civilizationAbility:vietnam",
    "civblitz:civilizationAbility:zulu",
    "civblitz:infrastructure:acropolis",
    "civblitz:infrastructure:basilikoi-paides",
    "civblitz:infrastructure:bath",
    "civblitz:infrastructure:ch-teau",
    "civblitz:infrastructure:chemamull",
    "civblitz:infrastructure:copacabana",
    "civblitz:infrastructure:cothon",
    "civblitz:infrastructure:electronics-factory",
    "civblitz:infrastructure:feitoria",
    "civblitz:infrastructure:film-studio",
    "civblitz:infrastructure:golf-course",
    "civblitz:infrastructure:grand-bazaar",
    "civblitz:infrastructure:great-wall",
    "civblitz:infrastructure:hacienda",
    "civblitz:infrastructure:hansa",
    "civblitz:infrastructure:hippodrome",
    "civblitz:infrastructure:ice-hockey-rink",
    "civblitz:infrastructure:ikanda",
    "civblitz:infrastructure:kampung",
    "civblitz:infrastructure:kurgan",
    "civblitz:infrastructure:lavra",
    "civblitz:infrastructure:madrasa",
    "civblitz:infrastructure:marae",
    "civblitz:infrastructure:mbanza",
    "civblitz:infrastructure:mekewap",
    "civblitz:infrastructure:mission",
    "civblitz:infrastructure:navigation-school",
    "civblitz:infrastructure:nubian-pyramid",
    "civblitz:infrastructure:observatory",
    "civblitz:infrastructure:open-air-museum",
    "civblitz:infrastructure:oppidum",
    "civblitz:infrastructure:ordu",
    "civblitz:infrastructure:outback-station",
    "civblitz:infrastructure:p",
    "civblitz:infrastructure:pairidaeza",
    "civblitz:infrastructure:palgum",
    "civblitz:infrastructure:polder",
    "civblitz:infrastructure:prasat",
    "civblitz:infrastructure:qhapaq-an",
    "civblitz:infrastructure:queens-bibliotheque",
    "civblitz:infrastructure:rock-hewn-church",
    "civblitz:infrastructure:royal-navy-dockyard",
    "civblitz:infrastructure:seowon",
    "civblitz:infrastructure:sphinx",
    "civblitz:infrastructure:stave-church",
    "civblitz:infrastructure:stepwell",
    "civblitz:infrastructure:street-carnival",
    "civblitz:infrastructure:suguba",
    "civblitz:infrastructure:sukiennice",
    "civblitz:infrastructure:terrace-farm",
    "civblitz:infrastructure:th-nh",
    "civblitz:infrastructure:thermal-bath",
    "civblitz:infrastructure:tlachtli",
    "civblitz:infrastructure:tsikhe",
    "civblitz:infrastructure:ziggurat",
    "civblitz:leaderAbility:america-abraham-lincoln",
    "civblitz:leaderAbility:america-teddy-roosevelt-bull-moose",
    "civblitz:leaderAbility:america-teddy-roosevelt-rough-rider",
    "civblitz:leaderAbility:arabia-saladin-sultan",
    "civblitz:leaderAbility:arabia-saladin-vizier",
    "civblitz:leaderAbility:australia-john-curtin",
    "civblitz:leaderAbility:aztec-montezuma",
    "civblitz:leaderAbility:babylon-hammurabi",
    "civblitz:leaderAbility:brazil-pedro-ii",
    "civblitz:leaderAbility:byzantium-basil-ii",
    "civblitz:leaderAbility:byzantium-theodora",
    "civblitz:leaderAbility:canada-wilfrid-laurier",
    "civblitz:leaderAbility:china-kublai-khan-china",
    "civblitz:leaderAbility:china-qin-mandate-of-heaven",
    "civblitz:leaderAbility:china-qin-unifier",
    "civblitz:leaderAbility:china-wu-zetian",
    "civblitz:leaderAbility:china-yongle",
    "civblitz:leaderAbility:cree-poundmaker",
    "civblitz:leaderAbility:egypt-cleopatra-egyptian",
    "civblitz:leaderAbility:egypt-cleopatra-ptolemaic",
    "civblitz:leaderAbility:egypt-ramses-ii",
    "civblitz:leaderAbility:england-eleanor-of-aquitaine-england",
    "civblitz:leaderAbility:england-elizabeth-i",
    "civblitz:leaderAbility:england-victoria-age-of-empire",
    "civblitz:leaderAbility:england-victoria-age-of-steam",
    "civblitz:leaderAbility:ethiopia-menelik-ii",
    "civblitz:leaderAbility:france-catherine-de-medici-black-queen",
    "civblitz:leaderAbility:france-catherine-de-medici-magnificence",
    "civblitz:leaderAbility:france-eleanor-of-aquitaine-france",
    "civblitz:leaderAbility:gaul-ambiorix",
    "civblitz:leaderAbility:georgia-tamar",
    "civblitz:leaderAbility:germany-frederick-barbarossa",
    "civblitz:leaderAbility:germany-ludwig-ii",
    "civblitz:leaderAbility:gran-colombia-simon-bolivar",
    "civblitz:leaderAbility:greece-gorgo",
    "civblitz:leaderAbility:greece-pericles",
    "civblitz:leaderAbility:hungary-matthias-corvinus",
    "civblitz:leaderAbility:inca-pachacuti",
    "civblitz:leaderAbility:india-chandragupta",
    "civblitz:leaderAbility:india-gandhi",
    "civblitz:leaderAbility:indonesia-gitarja",
    "civblitz:leaderAbility:japan-hojo-tokimune",
    "civblitz:leaderAbility:japan-tokugawa",
    "civblitz:leaderAbility:khmer-jayavarman-vii",
    "civblitz:leaderAbility:kongo-mvemba-a-nzinga",
    "civblitz:leaderAbility:kongo-nzinga-mbande",
    "civblitz:leaderAbility:korea-sejong",
    "civblitz:leaderAbility:korea-seondeok",
    "civblitz:leaderAbility:macedon-alexander",
    "civblitz:leaderAbility:mali-mansa-musa",
    "civblitz:leaderAbility:mali-sundiata-keita",
    "civblitz:leaderAbility:maori-kupe",
    "civblitz:leaderAbility:mapuche-lautaro",
    "civblitz:leaderAbility:maya-lady-six-sky",
    "civblitz:leaderAbility:mongolia-genghis-khan",
    "civblitz:leaderAbility:mongolia-kublai-khan-mongolia",
    "civblitz:leaderAbility:netherlands-wilhelmina",
    "civblitz:leaderAbility:norway-harald-hardrada-konge",
    "civblitz:leaderAbility:norway-harald-hardrada-varangian",
    "civblitz:leaderAbility:nubia-amanitore",
    "civblitz:leaderAbility:ottomans-suleiman-kanuni",
    "civblitz:leaderAbility:ottomans-suleiman-muhtesem",
    "civblitz:leaderAbility:persia-cyrus",
    "civblitz:leaderAbility:persia-nader-shah",
    "civblitz:leaderAbility:phoenicia-dido",
    "civblitz:leaderAbility:poland-jadwiga",
    "civblitz:leaderAbility:portugal-joao-iii",
    "civblitz:leaderAbility:rome-julius-caesar",
    "civblitz:leaderAbility:rome-trajan",
    "civblitz:leaderAbility:russia-peter",
    "civblitz:leaderAbility:scotland-robert-the-bruce",
    "civblitz:leaderAbility:scythia-tomyris",
    "civblitz:leaderAbility:spain-philip-ii",
    "civblitz:leaderAbility:sumeria-gilgamesh",
    "civblitz:leaderAbility:sweden-kristina",
    "civblitz:leaderAbility:vietnam-ba-trieu",
    "civblitz:leaderAbility:zulu-shaka",
    "civblitz:unit:barbary-corsair",
    "civblitz:unit:berserker",
    "civblitz:unit:bireme",
    "civblitz:unit:black-army",
    "civblitz:unit:carolean",
    "civblitz:unit:comandante-general",
    "civblitz:unit:conquistador",
    "civblitz:unit:cossack",
    "civblitz:unit:crouching-tiger",
    "civblitz:unit:de-zeven-provinci-n",
    "civblitz:unit:digger",
    "civblitz:unit:domrey",
    "civblitz:unit:dromon",
    "civblitz:unit:eagle-warrior",
    "civblitz:unit:gaesatae",
    "civblitz:unit:garde-imp-riale",
    "civblitz:unit:hetairos",
    "civblitz:unit:highlander",
    "civblitz:unit:hoplite",
    "civblitz:unit:hulche",
    "civblitz:unit:husz-r",
    "civblitz:unit:hwacha",
    "civblitz:unit:hypaspist",
    "civblitz:unit:immortal",
    "civblitz:unit:impi",
    "civblitz:unit:janissary",
    "civblitz:unit:jong",
    "civblitz:unit:keshig",
    "civblitz:unit:khevsur",
    "civblitz:unit:legion",
    "civblitz:unit:llanero",
    "civblitz:unit:mal-n-raider",
    "civblitz:unit:mamluk",
    "civblitz:unit:mandekalu-cavalry",
    "civblitz:unit:maryannu-chariot-archer",
    "civblitz:unit:minas-geraes",
    "civblitz:unit:mountie",
    "civblitz:unit:nau",
    "civblitz:unit:ngao-mbeba",
    "civblitz:unit:okihtcitaw",
    "civblitz:unit:oromo-cavalry",
    "civblitz:unit:p-51-mustang",
    "civblitz:unit:p-tati-archer",
    "civblitz:unit:redcoat",
    "civblitz:unit:rough-rider",
    "civblitz:unit:sabum-kibittum",
    "civblitz:unit:saka-horse-archer",
    "civblitz:unit:samurai",
    "civblitz:unit:sea-dog",
    "civblitz:unit:tagma",
    "civblitz:unit:toa",
    "civblitz:unit:u-boat",
    "civblitz:unit:varu",
    "civblitz:unit:viking-longship",
    "civblitz:unit:voi-chi-n",
    "civblitz:unit:war-cart",
    "civblitz:unit:warakaq",
    "civblitz:unit:winged-hussar"
  ]
} as const satisfies Record<'live' | 'beta', readonly string[]>

export const civilizationCatalog = {
  "CIVILIZATION_AMERICA": {
    "civilizationType": "CIVILIZATION_AMERICA",
    "name": "LOC_CIVILIZATION_AMERICA_NAME",
    "description": "LOC_CIVILIZATION_AMERICA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_AMERICA_ADJECTIVE",
    "ethnicity": "ETHNICITY_EURO",
    "capitalName": "LOC_CITY_NAME_WASHINGTON",
    "civilizationName": "LOC_CIVILIZATION_AMERICA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_AMERICA",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_FOUNDING_FATHERS_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_FOUNDING_FATHERS_EXPANSION2_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_AMERICA",
    "backgroundLeaderType": "LEADER_T_ROOSEVELT",
    "audio": "America",
    "cultures": [
      "America",
      "AncientWood"
    ],
    "unitCultures": [
      "European"
    ]
  },
  "CIVILIZATION_ARABIA": {
    "civilizationType": "CIVILIZATION_ARABIA",
    "name": "LOC_CIVILIZATION_ARABIA_NAME",
    "description": "LOC_CIVILIZATION_ARABIA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_ARABIA_ADJECTIVE",
    "ethnicity": "ETHNICITY_MEDIT",
    "capitalName": "LOC_CITY_NAME_CAIRO",
    "civilizationName": "LOC_CIVILIZATION_ARABIA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_ARABIA",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_LAST_PROPHET_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_LAST_PROPHET_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_ARABIA",
    "backgroundLeaderType": "LEADER_SALADIN",
    "audio": "Arabia",
    "cultures": [
      "Mughal",
      "AncientBrick",
      "ModernGlass",
      "RowHouse"
    ],
    "unitCultures": [
      "MiddleEastern"
    ]
  },
  "CIVILIZATION_AUSTRALIA": {
    "civilizationType": "CIVILIZATION_AUSTRALIA",
    "name": "LOC_CIVILIZATION_AUSTRALIA_NAME",
    "description": "LOC_CIVILIZATION_AUSTRALIA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_AUSTRALIA_ADJECTIVE",
    "ethnicity": "ETHNICITY_EURO",
    "capitalName": "LOC_CITY_NAME_CANBERRA",
    "civilizationName": "LOC_CIVILIZATION_AUSTRALIA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_AUSTRALIA",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_LAND_DOWN_UNDER_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_LAND_DOWN_UNDER_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_AUSTRALIA",
    "backgroundLeaderType": "LEADER_JOHN_CURTIN",
    "audio": "Australia",
    "cultures": [
      "AncientEarth",
      "NorthernEuropean",
      "ModernGlass"
    ],
    "unitCultures": [
      "European"
    ]
  },
  "CIVILIZATION_AZTEC": {
    "civilizationType": "CIVILIZATION_AZTEC",
    "name": "LOC_CIVILIZATION_AZTEC_NAME",
    "description": "LOC_CIVILIZATION_AZTEC_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_AZTEC_ADJECTIVE",
    "ethnicity": "",
    "capitalName": "LOC_CITY_NAME_TENOCHTITLAN",
    "civilizationName": "LOC_CIVILIZATION_AZTEC_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_AZTEC",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_LEGEND_FIVE_SUNS_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_LEGEND_FIVE_SUNS_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_AZTEC",
    "backgroundLeaderType": "LEADER_MONTEZUMA",
    "audio": "Aztec",
    "cultures": [
      "SouthAmerican",
      "AncientBrick",
      "Colonial"
    ],
    "unitCultures": [
      "SouthAmerican"
    ]
  },
  "CIVILIZATION_BABYLON_STK": {
    "civilizationType": "CIVILIZATION_BABYLON_STK",
    "name": "LOC_CIVILIZATION_BABYLON_STK_NAME",
    "description": "LOC_CIVILIZATION_BABYLON_STK_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_BABYLON_STK_ADJECTIVE",
    "ethnicity": "ETHNICITY_MEDIT",
    "capitalName": "LOC_CITY_NAME_BABYLON_STK",
    "civilizationName": "LOC_CIVILIZATION_BABYLON_STK_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_BABYLON_STK",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_BABYLON_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_BABYLON_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_BABYLON_STK",
    "backgroundLeaderType": "LEADER_HAMMURABI",
    "audio": "Babylon",
    "cultures": [
      "AncientBrick",
      "NorthAfrican",
      "RowHouse"
    ],
    "unitCultures": [
      "MiddleEastern"
    ]
  },
  "CIVILIZATION_BRAZIL": {
    "civilizationType": "CIVILIZATION_BRAZIL",
    "name": "LOC_CIVILIZATION_BRAZIL_NAME",
    "description": "LOC_CIVILIZATION_BRAZIL_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_BRAZIL_ADJECTIVE",
    "ethnicity": "ETHNICITY_SOUTHAM",
    "capitalName": "LOC_CITY_NAME_RIO_DE_JANEIRO",
    "civilizationName": "LOC_CIVILIZATION_BRAZIL_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_BRAZIL",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_AMAZON_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_AMAZON_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_BRAZIL",
    "backgroundLeaderType": "LEADER_PEDRO",
    "audio": "Brazil",
    "cultures": [
      "AncientBrick",
      "Colonial",
      "Brazil"
    ],
    "unitCultures": [
      "Mediterranean"
    ]
  },
  "CIVILIZATION_BYZANTIUM": {
    "civilizationType": "CIVILIZATION_BYZANTIUM",
    "name": "LOC_CIVILIZATION_BYZANTIUM_NAME",
    "description": "LOC_CIVILIZATION_BYZANTIUM_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_BYZANTIUM_ADJECTIVE",
    "ethnicity": "ETHNICITY_EURO",
    "capitalName": "LOC_CITY_NAME_CONSTANTINOPLE",
    "civilizationName": "LOC_CIVILIZATION_BYZANTIUM_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_BYZANTIUM",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_BYZANTIUM_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_BYZANTIUM_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_BYZANTIUM",
    "backgroundLeaderType": "LEADER_BASIL",
    "audio": "Byzantium",
    "cultures": [
      "AncientBrick",
      "Mediterranean"
    ],
    "unitCultures": [
      "European"
    ]
  },
  "CIVILIZATION_CANADA": {
    "civilizationType": "CIVILIZATION_CANADA",
    "name": "LOC_CIVILIZATION_CANADA_NAME",
    "description": "LOC_CIVILIZATION_CANADA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_CANADA_ADJECTIVE",
    "ethnicity": "ETHNICITY_EURO",
    "capitalName": "LOC_CITY_NAME_OTTAWA",
    "civilizationName": "LOC_CIVILIZATION_CANADA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_CANADA",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_FACES_OF_PEACE_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_FACES_OF_PEACE_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_CANADA",
    "backgroundLeaderType": "LEADER_LAURIER",
    "audio": "Canada",
    "cultures": [
      "America",
      "AncientWood"
    ],
    "unitCultures": [
      "European"
    ]
  },
  "CIVILIZATION_CHINA": {
    "civilizationType": "CIVILIZATION_CHINA",
    "name": "LOC_CIVILIZATION_CHINA_NAME",
    "description": "LOC_CIVILIZATION_CHINA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_CHINA_ADJECTIVE",
    "ethnicity": "ETHNICITY_ASIAN",
    "capitalName": "LOC_CITY_NAME_BEIJING",
    "civilizationName": "LOC_CIVILIZATION_CHINA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_CHINA",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_DYNASTIC_CYCLE_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_DYNASTIC_CYCLE_EXPANSION2_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_DYNASTIC_CYCLE",
    "backgroundLeaderType": "LEADER_KUBLAI_KHAN_CHINA",
    "audio": "China",
    "cultures": [
      "SoutheastAsian",
      "ModernGlass",
      "AncientWood"
    ],
    "unitCultures": [
      "Asian"
    ]
  },
  "CIVILIZATION_CREE": {
    "civilizationType": "CIVILIZATION_CREE",
    "name": "LOC_CIVILIZATION_CREE_NAME",
    "description": "LOC_CIVILIZATION_CREE_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_CREE_ADJECTIVE",
    "ethnicity": "ETHNICITY_SOUTHAM",
    "capitalName": "LOC_CITY_NAME_MIKISIW_WACIHK",
    "civilizationName": "LOC_CIVILIZATION_CREE_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_CREE",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_CREE_TRADE_GAIN_TILES_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_CREE_TRADE_GAIN_TILES_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_BRAZIL",
    "backgroundLeaderType": "LEADER_POUNDMAKER",
    "audio": "Cree",
    "cultures": [],
    "unitCultures": [
      "NativeAmerican"
    ]
  },
  "CIVILIZATION_EGYPT": {
    "civilizationType": "CIVILIZATION_EGYPT",
    "name": "LOC_CIVILIZATION_EGYPT_NAME",
    "description": "LOC_CIVILIZATION_EGYPT_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_EGYPT_ADJECTIVE",
    "ethnicity": "ETHNICITY_MEDIT",
    "capitalName": "LOC_CITY_NAME_RA_KEDET",
    "civilizationName": "LOC_CIVILIZATION_EGYPT_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_EGYPT",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_ITERU_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_ITERU_EXPANSION2_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_EGYPT",
    "backgroundLeaderType": "LEADER_CLEOPATRA",
    "audio": "Egypt",
    "cultures": [
      "NorthAfrican",
      "AncientBrick",
      "RowHouse"
    ],
    "unitCultures": [
      "MiddleEastern"
    ]
  },
  "CIVILIZATION_ENGLAND": {
    "civilizationType": "CIVILIZATION_ENGLAND",
    "name": "LOC_CIVILIZATION_ENGLAND_NAME",
    "description": "LOC_CIVILIZATION_ENGLAND_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_ENGLAND_ADJECTIVE",
    "ethnicity": "ETHNICITY_EURO",
    "capitalName": "LOC_CITY_NAME_LONDON",
    "civilizationName": "LOC_CIVILIZATION_ENGLAND_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_ENGLAND",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_INDUSTRIAL_REVOLUTION_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_INDUSTRIAL_REVOLUTION_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_ENGLAND",
    "backgroundLeaderType": "LEADER_ELEANOR_ENGLAND",
    "audio": "England",
    "cultures": [
      "ModernGlass",
      "AncientWood",
      "Scottish"
    ],
    "unitCultures": [
      "European"
    ]
  },
  "CIVILIZATION_ETHIOPIA": {
    "civilizationType": "CIVILIZATION_ETHIOPIA",
    "name": "LOC_CIVILIZATION_ETHIOPIA_NAME",
    "description": "LOC_CIVILIZATION_ETHIOPIA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_ETHIOPIA_ADJECTIVE",
    "ethnicity": "ETHNICITY_AFRICAN",
    "capitalName": "LOC_CITY_NAME_ADDIS_ABABA",
    "civilizationName": "LOC_CIVILIZATION_ETHIOPIA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_ETHIOPIA",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_ETHIOPIA_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_ETHIOPIA_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_ETHIOPIA",
    "backgroundLeaderType": "LEADER_MENELIK",
    "audio": "Ethiopia",
    "cultures": [
      "RowHouse",
      "AncientBrick"
    ],
    "unitCultures": [
      "African"
    ]
  },
  "CIVILIZATION_FRANCE": {
    "civilizationType": "CIVILIZATION_FRANCE",
    "name": "LOC_CIVILIZATION_FRANCE_NAME",
    "description": "LOC_CIVILIZATION_FRANCE_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_FRANCE_ADJECTIVE",
    "ethnicity": "ETHNICITY_EURO",
    "capitalName": "LOC_CITY_NAME_PARIS",
    "civilizationName": "LOC_CIVILIZATION_FRANCE_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_FRANCE",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_WONDER_TOURISM_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_WONDER_TOURISM_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_FRANCE",
    "backgroundLeaderType": "LEADER_CATHERINE_DE_MEDICI",
    "audio": "France",
    "cultures": [
      "AncientEarth"
    ],
    "unitCultures": [
      "European"
    ]
  },
  "CIVILIZATION_GAUL": {
    "civilizationType": "CIVILIZATION_GAUL",
    "name": "LOC_CIVILIZATION_GAUL_NAME",
    "description": "LOC_CIVILIZATION_GAUL_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_GAUL_ADJECTIVE",
    "ethnicity": "ETHNICITY_EURO",
    "capitalName": "LOC_CITY_NAME_ADUATUCA",
    "civilizationName": "LOC_CIVILIZATION_GAUL_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_GAUL",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_GAUL_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_GAUL_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_GAUL",
    "backgroundLeaderType": "LEADER_AMBIORIX",
    "audio": "Gaul",
    "cultures": [
      "CIVILIZATION_GAUL",
      "AncientEarth"
    ],
    "unitCultures": [
      "European"
    ]
  },
  "CIVILIZATION_GEORGIA": {
    "civilizationType": "CIVILIZATION_GEORGIA",
    "name": "LOC_CIVILIZATION_GEORGIA_NAME",
    "description": "LOC_CIVILIZATION_GEORGIA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_GEORGIA_ADJECTIVE",
    "ethnicity": "ETHNICITY_SOUTHAM",
    "capitalName": "LOC_CITY_NAME_TBILISI",
    "civilizationName": "LOC_CIVILIZATION_GEORGIA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_GEORGIA",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_GOLDEN_AGE_QUESTS_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_GOLDEN_AGE_QUESTS_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_BRAZIL",
    "backgroundLeaderType": "LEADER_TAMAR",
    "audio": "Georgia",
    "cultures": [
      "AncientEarth",
      "RowHouse",
      "Baltic"
    ],
    "unitCultures": [
      "Mediterranean"
    ]
  },
  "CIVILIZATION_GERMANY": {
    "civilizationType": "CIVILIZATION_GERMANY",
    "name": "LOC_CIVILIZATION_GERMANY_NAME",
    "description": "LOC_CIVILIZATION_GERMANY_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_GERMANY_ADJECTIVE",
    "ethnicity": "ETHNICITY_EURO",
    "capitalName": "LOC_CITY_NAME_AACHEN",
    "civilizationName": "LOC_CIVILIZATION_GERMANY_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_GERMANY",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_IMPERIAL_FREE_CITIES_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_IMPERIAL_FREE_CITIES_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_GERMANY",
    "backgroundLeaderType": "LEADER_BARBAROSSA",
    "audio": "Germany",
    "cultures": [
      "AncientEarth",
      "ModernGlass"
    ],
    "unitCultures": [
      "European"
    ]
  },
  "CIVILIZATION_GRAN_COLOMBIA": {
    "civilizationType": "CIVILIZATION_GRAN_COLOMBIA",
    "name": "LOC_CIVILIZATION_GRAN_COLOMBIA_NAME",
    "description": "LOC_CIVILIZATION_GRAN_COLOMBIA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_GRAN_COLOMBIA_ADJECTIVE",
    "ethnicity": "ETHNICITY_SOUTHAM",
    "capitalName": "LOC_CITY_NAME_BOGOTA",
    "civilizationName": "LOC_CIVILIZATION_GRAN_COLOMBIA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_GRAN_COLOMBIA",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_EJERCITO_PATRIOTA_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_EJERCITO_PATRIOTA_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_GRAN_COLOMBIA",
    "backgroundLeaderType": "LEADER_SIMON_BOLIVAR",
    "audio": "GranColumbia",
    "cultures": [
      "Colonial",
      "AncientBrick",
      "Brazil"
    ],
    "unitCultures": [
      "SouthAmerican",
      "Mediterranean"
    ]
  },
  "CIVILIZATION_GREECE": {
    "civilizationType": "CIVILIZATION_GREECE",
    "name": "LOC_CIVILIZATION_GREECE_NAME",
    "description": "LOC_CIVILIZATION_GREECE_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_GREECE_ADJECTIVE",
    "ethnicity": "ETHNICITY_MEDIT",
    "capitalName": "LOC_CITY_NAME_SPARTA",
    "civilizationName": "LOC_CIVILIZATION_GREECE_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_GREECE_GORGO",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_PLATOS_REPUBLIC_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_PLATOS_REPUBLIC_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_GREECE",
    "backgroundLeaderType": "LEADER_GORGO",
    "audio": "Greece",
    "cultures": [
      "Mediterranean",
      "AncientBrick"
    ],
    "unitCultures": [
      "Mediterranean"
    ]
  },
  "CIVILIZATION_HUNGARY": {
    "civilizationType": "CIVILIZATION_HUNGARY",
    "name": "LOC_CIVILIZATION_HUNGARY_NAME",
    "description": "LOC_CIVILIZATION_HUNGARY_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_HUNGARY_ADJECTIVE",
    "ethnicity": "ETHNICITY_EURO",
    "capitalName": "LOC_CITY_NAME_BUDA",
    "civilizationName": "LOC_CIVILIZATION_HUNGARY_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_HUNGARY",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_PEARL_DANUBE_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_PEARL_DANUBE_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_HUNGARY",
    "backgroundLeaderType": "LEADER_MATTHIAS_CORVINUS",
    "audio": "Hungary",
    "cultures": [
      "AncientEarth",
      "Baltic"
    ],
    "unitCultures": [
      "European"
    ]
  },
  "CIVILIZATION_INCA": {
    "civilizationType": "CIVILIZATION_INCA",
    "name": "LOC_CIVILIZATION_INCA_NAME",
    "description": "LOC_CIVILIZATION_INCA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_INCA_ADJECTIVE",
    "ethnicity": "ETHNICITY_SOUTHAM",
    "capitalName": "LOC_CITY_NAME_QUSQU",
    "civilizationName": "LOC_CIVILIZATION_INCA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_INCA",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_GREAT_MOUNTAINS_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_GREAT_MOUNTAINS_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_INCA",
    "backgroundLeaderType": "LEADER_PACHACUTI",
    "audio": "Inca",
    "cultures": [
      "SouthAmerican",
      "Colonial",
      "AncientBrick"
    ],
    "unitCultures": [
      "SouthAmerican"
    ]
  },
  "CIVILIZATION_INDIA": {
    "civilizationType": "CIVILIZATION_INDIA",
    "name": "LOC_CIVILIZATION_INDIA_NAME",
    "description": "LOC_CIVILIZATION_INDIA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_INDIA_ADJECTIVE",
    "ethnicity": "ETHNICITY_MEDIT",
    "capitalName": "LOC_CITY_NAME_PATNA",
    "civilizationName": "LOC_CIVILIZATION_INDIA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_INDIA_2",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_DHARMA_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_DHARMA_EXPANSION2_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_INDIA",
    "backgroundLeaderType": "LEADER_CHANDRAGUPTA",
    "audio": "India",
    "cultures": [
      "Mughal",
      "AncientBrick",
      "ModernGlass",
      "RowHouse"
    ],
    "unitCultures": [
      "Indian"
    ]
  },
  "CIVILIZATION_INDONESIA": {
    "civilizationType": "CIVILIZATION_INDONESIA",
    "name": "LOC_CIVILIZATION_INDONESIA_NAME",
    "description": "LOC_CIVILIZATION_INDONESIA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_INDONESIA_ADJECTIVE",
    "ethnicity": "",
    "capitalName": "LOC_CITY_NAME_MAJAPAHIT",
    "civilizationName": "LOC_CIVILIZATION_INDONESIA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_INDONESIA",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_INDONESIA_NUSANTARA_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_INDONESIA_NUSANTARA_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_INDONESIA",
    "backgroundLeaderType": "LEADER_GITARJA",
    "audio": "Indonesia",
    "cultures": [
      "AncientWood",
      "Colonial",
      "Indonesian"
    ],
    "unitCultures": [
      "SouthEastAsian"
    ]
  },
  "CIVILIZATION_JAPAN": {
    "civilizationType": "CIVILIZATION_JAPAN",
    "name": "LOC_CIVILIZATION_JAPAN_NAME",
    "description": "LOC_CIVILIZATION_JAPAN_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_JAPAN_ADJECTIVE",
    "ethnicity": "ETHNICITY_ASIAN",
    "capitalName": "LOC_CITY_NAME_KYOTO",
    "civilizationName": "LOC_CIVILIZATION_JAPAN_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_JAPAN",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_ADJACENT_DISTRICTS_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_ADJACENT_DISTRICTS_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_JAPAN",
    "backgroundLeaderType": "LEADER_HOJO",
    "audio": "Japan",
    "cultures": [
      "EastAsian",
      "ModernGlass",
      "AncientWood"
    ],
    "unitCultures": [
      "Asian"
    ]
  },
  "CIVILIZATION_KHMER": {
    "civilizationType": "CIVILIZATION_KHMER",
    "name": "LOC_CIVILIZATION_KHMER_NAME",
    "description": "LOC_CIVILIZATION_KHMER_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_KHMER_ADJECTIVE",
    "ethnicity": "",
    "capitalName": "LOC_CITY_NAME_ANGKOR_THOM",
    "civilizationName": "LOC_CIVILIZATION_KHMER_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_KHMER",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_KHMER_BARAYS_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_KHMER_BARAYS_EXPANSION2_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_KHMER",
    "backgroundLeaderType": "LEADER_JAYAVARMAN",
    "audio": "Khmer",
    "cultures": [
      "AncientWood",
      "Colonial",
      "Indonesian"
    ],
    "unitCultures": [
      "MiddleEastern"
    ]
  },
  "CIVILIZATION_KONGO": {
    "civilizationType": "CIVILIZATION_KONGO",
    "name": "LOC_CIVILIZATION_KONGO_NAME",
    "description": "LOC_CIVILIZATION_KONGO_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_KONGO_ADJECTIVE",
    "ethnicity": "ETHNICITY_AFRICAN",
    "capitalName": "LOC_CITY_NAME_MBANZA_KONGO",
    "civilizationName": "LOC_CIVILIZATION_KONGO_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_KONGO",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_NKISI_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_NKISI_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_KONGO",
    "backgroundLeaderType": "LEADER_MVEMBA",
    "audio": "Kongo",
    "cultures": [
      "SouthAfrican",
      "AncientEarth",
      "RowHouse"
    ],
    "unitCultures": [
      "African"
    ]
  },
  "CIVILIZATION_KOREA": {
    "civilizationType": "CIVILIZATION_KOREA",
    "name": "LOC_CIVILIZATION_KOREA_NAME",
    "description": "LOC_CIVILIZATION_KOREA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_KOREA_ADJECTIVE",
    "ethnicity": "ETHNICITY_ASIAN",
    "capitalName": "LOC_CITY_NAME_GYEONGJU",
    "civilizationName": "LOC_CIVILIZATION_KOREA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_KOREA",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_THREE_KINGDOMS_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_THREE_KINGDOMS_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_KOREA",
    "backgroundLeaderType": "LEADER_SEONDEOK",
    "audio": "Korea",
    "cultures": [
      "AncientWood",
      "ModernGlass"
    ],
    "unitCultures": [
      "Asian"
    ]
  },
  "CIVILIZATION_MACEDON": {
    "civilizationType": "CIVILIZATION_MACEDON",
    "name": "LOC_CIVILIZATION_MACEDON_NAME",
    "description": "LOC_CIVILIZATION_MACEDON_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_MACEDON_ADJECTIVE",
    "ethnicity": "",
    "capitalName": "LOC_CITY_NAME_PELLA",
    "civilizationName": "LOC_CIVILIZATION_MACEDON_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_MACEDON",
    "civilizationAbilityName": "LOC_TRAIT_LEADER_HELLENISTIC_FUSION_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_LEADER_HELLENISTIC_FUSION_EXPANSION1_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_MACEDON",
    "backgroundLeaderType": "LEADER_ALEXANDER",
    "audio": "Macedonia",
    "cultures": [
      "AncientBrick",
      "Mediterranean",
      "Colonial"
    ],
    "unitCultures": [
      "Mediterranean"
    ]
  },
  "CIVILIZATION_MALI": {
    "civilizationType": "CIVILIZATION_MALI",
    "name": "LOC_CIVILIZATION_MALI_NAME",
    "description": "LOC_CIVILIZATION_MALI_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_MALI_ADJECTIVE",
    "ethnicity": "ETHNICITY_AFRICAN",
    "capitalName": "LOC_CITY_NAME_NIANI",
    "civilizationName": "LOC_CIVILIZATION_MALI_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_MALI",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_MALI_GOLD_DESERT_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_MALI_GOLD_DESERT_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_MALI",
    "backgroundLeaderType": "LEADER_MANSA_MUSA",
    "audio": "Mali",
    "cultures": [
      "AncientEarth",
      "RowHouse",
      "SouthAfrican"
    ],
    "unitCultures": [
      "African"
    ]
  },
  "CIVILIZATION_MAORI": {
    "civilizationType": "CIVILIZATION_MAORI",
    "name": "LOC_CIVILIZATION_MAORI_NAME",
    "description": "LOC_CIVILIZATION_MAORI_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_MAORI_ADJECTIVE",
    "ethnicity": "ETHNICITY_SOUTHAM",
    "capitalName": "LOC_CITY_NAME_TE_HOKIANGA_NU_A_KUPE",
    "civilizationName": "LOC_CIVILIZATION_MAORI_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_MAORI",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_MAORI_MANA_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_MAORI_MANA_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_MAORI",
    "backgroundLeaderType": "LEADER_KUPE",
    "audio": "Maori",
    "cultures": [
      "Colonial",
      "Maori",
      "ModernGlass"
    ],
    "unitCultures": [
      "Maori"
    ]
  },
  "CIVILIZATION_MAPUCHE": {
    "civilizationType": "CIVILIZATION_MAPUCHE",
    "name": "LOC_CIVILIZATION_MAPUCHE_NAME",
    "description": "LOC_CIVILIZATION_MAPUCHE_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_MAPUCHE_ADJECTIVE",
    "ethnicity": "ETHNICITY_SOUTHAM",
    "capitalName": "LOC_CITY_NAME_NGULU_MAPU",
    "civilizationName": "LOC_CIVILIZATION_MAPUCHE_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_MAPUCHE",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_MAPUCHE_TOQUI_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_MAPUCHE_TOQUI_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_BRAZIL",
    "backgroundLeaderType": "LEADER_LAUTARO",
    "audio": "Mapuche",
    "cultures": [
      "Colonial"
    ],
    "unitCultures": [
      "SouthAmerican"
    ]
  },
  "CIVILIZATION_MAYA": {
    "civilizationType": "CIVILIZATION_MAYA",
    "name": "LOC_CIVILIZATION_MAYA_NAME",
    "description": "LOC_CIVILIZATION_MAYA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_MAYA_ADJECTIVE",
    "ethnicity": "ETHNICITY_SOUTHAM",
    "capitalName": "LOC_CITY_NAME_NARANJO",
    "civilizationName": "LOC_CIVILIZATION_MAYA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_MAYA",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_MAYAB_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_MAYAB_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_MAYA",
    "backgroundLeaderType": "LEADER_LADY_SIX_SKY",
    "audio": "Maya",
    "cultures": [
      "Colonial",
      "AncientBrick"
    ],
    "unitCultures": [
      "SouthAmerican"
    ]
  },
  "CIVILIZATION_MONGOLIA": {
    "civilizationType": "CIVILIZATION_MONGOLIA",
    "name": "LOC_CIVILIZATION_MONGOLIA_NAME",
    "description": "LOC_CIVILIZATION_MONGOLIA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_MONGOLIA_ADJECTIVE",
    "ethnicity": "ETHNICITY_ASIAN",
    "capitalName": "LOC_CITY_NAME_QARAQORUM",
    "civilizationName": "LOC_CIVILIZATION_MONGOLIA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_MONGOLIA",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_MONGOLIAN_ORTOO_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_MONGOLIAN_ORTOO_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_CHINA",
    "backgroundLeaderType": "LEADER_GENGHIS_KHAN",
    "audio": "Mongolia",
    "cultures": [
      "AncientWood",
      "SoutheastAsian"
    ],
    "unitCultures": [
      "Asian"
    ]
  },
  "CIVILIZATION_NETHERLANDS": {
    "civilizationType": "CIVILIZATION_NETHERLANDS",
    "name": "LOC_CIVILIZATION_NETHERLANDS_NAME",
    "description": "LOC_CIVILIZATION_NETHERLANDS_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_NETHERLANDS_ADJECTIVE",
    "ethnicity": "ETHNICITY_EURO",
    "capitalName": "LOC_CITY_NAME_AMSTERDAM",
    "civilizationName": "LOC_CIVILIZATION_NETHERLANDS_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_NETHERLANDS",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_GROTE_RIVIEREN_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_GROTE_RIVIEREN_EXPANSION2_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_EGYPT",
    "backgroundLeaderType": "LEADER_WILHELMINA",
    "audio": "Netherlands",
    "cultures": [
      "AncientEarth",
      "Scottish"
    ],
    "unitCultures": [
      "European"
    ]
  },
  "CIVILIZATION_NORWAY": {
    "civilizationType": "CIVILIZATION_NORWAY",
    "name": "LOC_CIVILIZATION_NORWAY_NAME",
    "description": "LOC_CIVILIZATION_NORWAY_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_NORWAY_ADJECTIVE",
    "ethnicity": "ETHNICITY_EURO",
    "capitalName": "LOC_CITY_NAME_NIDAROS",
    "civilizationName": "LOC_CIVILIZATION_NORWAY_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_NORWAY",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_EARLY_OCEAN_NAVIGATION_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_EARLY_OCEAN_NAVIGATION_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_NORWAY",
    "backgroundLeaderType": "LEADER_HARDRADA",
    "audio": "Norway",
    "cultures": [
      "AncientWood"
    ],
    "unitCultures": [
      "European"
    ]
  },
  "CIVILIZATION_NUBIA": {
    "civilizationType": "CIVILIZATION_NUBIA",
    "name": "LOC_CIVILIZATION_NUBIA_NAME",
    "description": "LOC_CIVILIZATION_NUBIA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_NUBIA_ADJECTIVE",
    "ethnicity": "ETHNICITY_AFRICAN",
    "capitalName": "LOC_CITY_NAME_MEROE",
    "civilizationName": "LOC_CIVILIZATION_NUBIA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_NUBIA",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_TA_SETI_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_TA_SETI_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_NUBIA",
    "backgroundLeaderType": "LEADER_AMANITORE",
    "audio": "Nubia",
    "cultures": [
      "AncientBrick",
      "Nubian",
      "RowHouse"
    ],
    "unitCultures": [
      "African",
      "African"
    ]
  },
  "CIVILIZATION_OTTOMAN": {
    "civilizationType": "CIVILIZATION_OTTOMAN",
    "name": "LOC_CIVILIZATION_OTTOMAN_NAME",
    "description": "LOC_CIVILIZATION_OTTOMAN_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_OTTOMAN_ADJECTIVE",
    "ethnicity": "ETHNICITY_MEDIT",
    "capitalName": "LOC_CITY_NAME_ISTANBUL",
    "civilizationName": "LOC_CIVILIZATION_OTTOMAN_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_OTTOMAN",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_GREAT_TURKISH_BOMBARD_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_GREAT_TURKISH_BOMBARD_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_OTTOMAN",
    "backgroundLeaderType": "LEADER_SULEIMAN",
    "audio": "Ottomans",
    "cultures": [
      "RowHouse",
      "ModernGlass",
      "Mughal",
      "AncientBrick"
    ],
    "unitCultures": [
      "MiddleEastern"
    ]
  },
  "CIVILIZATION_PERSIA": {
    "civilizationType": "CIVILIZATION_PERSIA",
    "name": "LOC_CIVILIZATION_PERSIA_NAME",
    "description": "LOC_CIVILIZATION_PERSIA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_PERSIA_ADJECTIVE",
    "ethnicity": "",
    "capitalName": "LOC_CITY_NAME_PASARGADAE",
    "civilizationName": "LOC_CIVILIZATION_PERSIA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_PERSIA",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_SATRAPIES_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_SATRAPIES_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_PERSIA",
    "backgroundLeaderType": "LEADER_CYRUS",
    "audio": "Persia",
    "cultures": [
      "AncientBrick",
      "RowHouse",
      "ModernGlass",
      "Mughal"
    ],
    "unitCultures": [
      "MiddleEastern"
    ]
  },
  "CIVILIZATION_PHOENICIA": {
    "civilizationType": "CIVILIZATION_PHOENICIA",
    "name": "LOC_CIVILIZATION_PHOENICIA_NAME",
    "description": "LOC_CIVILIZATION_PHOENICIA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_PHOENICIA_ADJECTIVE",
    "ethnicity": "ETHNICITY_MEDIT",
    "capitalName": "LOC_CITY_NAME_TYRE",
    "civilizationName": "LOC_CIVILIZATION_PHOENICIA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_PHOENICIA",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_MEDITERRANEAN_COLONIES_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_MEDITERRANEAN_COLONIES_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_PHOENICIA",
    "backgroundLeaderType": "LEADER_DIDO",
    "audio": "Phoenicia",
    "cultures": [
      "NorthAfrican",
      "RowHouse",
      "AncientBrick"
    ],
    "unitCultures": [
      "Mediterranean"
    ]
  },
  "CIVILIZATION_POLAND": {
    "civilizationType": "CIVILIZATION_POLAND",
    "name": "LOC_CIVILIZATION_POLAND_NAME",
    "description": "LOC_CIVILIZATION_POLAND_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_POLAND_ADJECTIVE",
    "ethnicity": "",
    "capitalName": "LOC_CITY_NAME_KRAKOW",
    "civilizationName": "LOC_CIVILIZATION_POLAND_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_POLAND",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_GOLDEN_LIBERTY_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_GOLDEN_LIBERTY_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_POLAND",
    "backgroundLeaderType": "LEADER_JADWIGA",
    "audio": "Poland",
    "cultures": [
      "Baltic",
      "AncientEarth",
      "RowHouse"
    ],
    "unitCultures": [
      "European"
    ]
  },
  "CIVILIZATION_PORTUGAL": {
    "civilizationType": "CIVILIZATION_PORTUGAL",
    "name": "LOC_CIVILIZATION_PORTUGAL_NAME",
    "description": "LOC_CIVILIZATION_PORTUGAL_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_PORTUGAL_ADJECTIVE",
    "ethnicity": "ETHNICITY_EURO",
    "capitalName": "LOC_CITY_NAME_LISBON_STK",
    "civilizationName": "LOC_CIVILIZATION_PORTUGAL_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_PORTUGAL",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_PORTUGAL_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_PORTUGAL_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_PORTUGAL",
    "backgroundLeaderType": "LEADER_JOAO_III",
    "audio": "Portugal",
    "cultures": [
      "ModernGlass",
      "AncientBrick",
      "Colonial"
    ],
    "unitCultures": [
      "Mediterranean"
    ]
  },
  "CIVILIZATION_ROME": {
    "civilizationType": "CIVILIZATION_ROME",
    "name": "LOC_CIVILIZATION_ROME_NAME",
    "description": "LOC_CIVILIZATION_ROME_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_ROME_ADJECTIVE",
    "ethnicity": "ETHNICITY_MEDIT",
    "capitalName": "LOC_CITY_NAME_ROME",
    "civilizationName": "LOC_CIVILIZATION_ROME_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_ROME",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_ALL_ROADS_TO_ROME_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_ALL_ROADS_TO_ROME_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_ROME",
    "backgroundLeaderType": "LEADER_TRAJAN",
    "audio": "Rome",
    "cultures": [
      "Mediterranean",
      "AncientBrick"
    ],
    "unitCultures": [
      "Mediterranean"
    ]
  },
  "CIVILIZATION_RUSSIA": {
    "civilizationType": "CIVILIZATION_RUSSIA",
    "name": "LOC_CIVILIZATION_RUSSIA_NAME",
    "description": "LOC_CIVILIZATION_RUSSIA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_RUSSIA_ADJECTIVE",
    "ethnicity": "ETHNICITY_EURO",
    "capitalName": "LOC_CITY_NAME_ST_PETERSBURG",
    "civilizationName": "LOC_CIVILIZATION_RUSSIA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_RUSSIA",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_MOTHER_RUSSIA_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_MOTHER_RUSSIA_EXPANSION2_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_RUSSIA",
    "backgroundLeaderType": "LEADER_PETER_GREAT",
    "audio": "Russia",
    "cultures": [
      "AncientEarth",
      "Baltic",
      "RowHouse"
    ],
    "unitCultures": [
      "European"
    ]
  },
  "CIVILIZATION_SCOTLAND": {
    "civilizationType": "CIVILIZATION_SCOTLAND",
    "name": "LOC_CIVILIZATION_SCOTLAND_NAME",
    "description": "LOC_CIVILIZATION_SCOTLAND_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_SCOTLAND_ADJECTIVE",
    "ethnicity": "ETHNICITY_EURO",
    "capitalName": "LOC_CITY_NAME_STIRLING",
    "civilizationName": "LOC_CIVILIZATION_SCOTLAND_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_SCOTLAND",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_SCOTTISH_ENLIGHTENMENT_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_SCOTTISH_ENLIGHTENMENT_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_FRANCE",
    "backgroundLeaderType": "LEADER_ROBERT_THE_BRUCE",
    "audio": "Scotland",
    "cultures": [
      "AncientEarth",
      "Scottish"
    ],
    "unitCultures": [
      "European"
    ]
  },
  "CIVILIZATION_SCYTHIA": {
    "civilizationType": "CIVILIZATION_SCYTHIA",
    "name": "LOC_CIVILIZATION_SCYTHIA_NAME",
    "description": "LOC_CIVILIZATION_SCYTHIA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_SCYTHIA_ADJECTIVE",
    "ethnicity": "ETHNICITY_MEDIT",
    "capitalName": "LOC_CITY_NAME_POKROVKA",
    "civilizationName": "LOC_CIVILIZATION_SCYTHIA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_SCYTHIA",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_EXTRA_LIGHT_CAVALRY_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_EXTRA_LIGHT_CAVALRY_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_SCYTHIA",
    "backgroundLeaderType": "LEADER_TOMYRIS",
    "audio": "Scythia",
    "cultures": [
      "Mughal",
      "AncientEarth",
      "RowHouse"
    ],
    "unitCultures": [
      "Mediterranean"
    ]
  },
  "CIVILIZATION_SPAIN": {
    "civilizationType": "CIVILIZATION_SPAIN",
    "name": "LOC_CIVILIZATION_SPAIN_NAME",
    "description": "LOC_CIVILIZATION_SPAIN_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_SPAIN_ADJECTIVE",
    "ethnicity": "ETHNICITY_EURO",
    "capitalName": "LOC_CITY_NAME_MADRID",
    "civilizationName": "LOC_CIVILIZATION_SPAIN_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_SPAIN",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_TREASURE_FLEET_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_TREASURE_FLEET_EXPANSION2_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_SPAIN",
    "backgroundLeaderType": "LEADER_PHILIP_II",
    "audio": "Spain",
    "cultures": [
      "AncientBrick",
      "ModernGlass",
      "Colonial",
      "Brazil"
    ],
    "unitCultures": [
      "European"
    ]
  },
  "CIVILIZATION_SUMERIA": {
    "civilizationType": "CIVILIZATION_SUMERIA",
    "name": "LOC_CIVILIZATION_SUMERIA_NAME",
    "description": "LOC_CIVILIZATION_SUMERIA_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_SUMERIA_ADJECTIVE",
    "ethnicity": "ETHNICITY_MEDIT",
    "capitalName": "LOC_CITY_NAME_URUK",
    "civilizationName": "LOC_CIVILIZATION_SUMERIA_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_SUMERIA",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_FIRST_CIVILIZATION_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_FIRST_CIVILIZATION_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_SUMERIA",
    "backgroundLeaderType": "LEADER_GILGAMESH",
    "audio": "Sumeria",
    "cultures": [
      "NorthAfrican",
      "AncientBrick",
      "RowHouse"
    ],
    "unitCultures": [
      "MiddleEastern"
    ]
  },
  "CIVILIZATION_SWEDEN": {
    "civilizationType": "CIVILIZATION_SWEDEN",
    "name": "LOC_CIVILIZATION_SWEDEN_NAME",
    "description": "LOC_CIVILIZATION_SWEDEN_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_SWEDEN_ADJECTIVE",
    "ethnicity": "ETHNICITY_EURO",
    "capitalName": "LOC_CITY_NAME_STOCKHOLM",
    "civilizationName": "LOC_CIVILIZATION_SWEDEN_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_SWEDEN",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_NOBEL_PRIZE_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_NOBEL_PRIZE_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_SWEDEN",
    "backgroundLeaderType": "LEADER_KRISTINA",
    "audio": "Sweden",
    "cultures": [
      "AncientWood"
    ],
    "unitCultures": [
      "European"
    ]
  },
  "CIVILIZATION_VIETNAM": {
    "civilizationType": "CIVILIZATION_VIETNAM",
    "name": "LOC_CIVILIZATION_VIETNAM_NAME",
    "description": "LOC_CIVILIZATION_VIETNAM_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_VIETNAM_ADJECTIVE",
    "ethnicity": "ETHNICITY_ASIAN",
    "capitalName": "LOC_CITY_HA_NOI",
    "civilizationName": "LOC_CIVILIZATION_VIETNAM_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_VIETNAM",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_VIETNAM_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_VIETNAM_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_VIETNAM",
    "backgroundLeaderType": "LEADER_LADY_TRIEU",
    "audio": "Vietnam",
    "cultures": [
      "AncientWood",
      "ModernGlass"
    ],
    "unitCultures": [
      "Asian"
    ]
  },
  "CIVILIZATION_ZULU": {
    "civilizationType": "CIVILIZATION_ZULU",
    "name": "LOC_CIVILIZATION_ZULU_NAME",
    "description": "LOC_CIVILIZATION_ZULU_DESCRIPTION",
    "adjective": "LOC_CIVILIZATION_ZULU_ADJECTIVE",
    "ethnicity": "ETHNICITY_AFRICAN",
    "capitalName": "LOC_CITY_NAME_ULUNDI",
    "civilizationName": "LOC_CIVILIZATION_ZULU_NAME",
    "civilizationIcon": "ICON_CIVILIZATION_ZULU",
    "civilizationAbilityName": "LOC_TRAIT_CIVILIZATION_ZULU_ISIBONGO_NAME",
    "civilizationAbilityDescription": "LOC_TRAIT_CIVILIZATION_ZULU_ISIBONGO_DESCRIPTION",
    "civilizationAbilityIcon": "ICON_CIVILIZATION_GERMANY",
    "backgroundLeaderType": "LEADER_SHAKA",
    "audio": "Zulu",
    "cultures": [
      "AncientEarth",
      "SouthAfrican",
      "RowHouse"
    ],
    "unitCultures": [
      "African"
    ]
  }
} as const satisfies Record<string, CivBlitzModCivilizationMetadata>

export const leaderCatalog = {
  "LEADER_ABRAHAM_LINCOLN": {
    "leaderType": "LEADER_ABRAHAM_LINCOLN",
    "leaderIcon": "ICON_LEADER_ABRAHAM_LINCOLN",
    "leaderAbilityName": "LOC_TRAIT_LEADER_LINCOLN_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_LINCOLN_EXPANSION_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_ABRAHAM_LINCOLN",
    "portrait": "LEADER_ABRAHAM_LINCOLN_NEUTRAL",
    "portraitBackground": "LEADER_ABRAHAM_LINCOLN_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_AMER_Lincoln",
      "xlpClass": "Leader",
      "xlpPath": "leader_lincoln.xlp",
      "blpPackage": "leaders/leader_lincoln",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Lincoln_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "America_Lin",
    "fallbackLeader": "FALLBACK_NEUTRAL_LINCOLN"
  },
  "LEADER_ALEXANDER": {
    "leaderType": "LEADER_ALEXANDER",
    "leaderIcon": "ICON_LEADER_ALEXANDER",
    "leaderAbilityName": "LOC_TRAIT_LEADER_TO_WORLDS_END_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_TO_WORLDS_END_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_ALEXANDER",
    "portrait": "LEADER_ALEXANDER_NEUTRAL",
    "portraitBackground": "LEADER_ALEXANDER_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_ALEXANDER",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Alexander.xlp",
      "blpPackage": "leaders/leader_alexander",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Alexander_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Macedonia",
    "fallbackLeader": "FALLBACK_NEUTRAL_ALEXANDER"
  },
  "LEADER_AMANITORE": {
    "leaderType": "LEADER_AMANITORE",
    "leaderIcon": "ICON_LEADER_AMANITORE",
    "leaderAbilityName": "LOC_TRAIT_LEADER_KANDAKE_OF_MEROE_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_KANDAKE_OF_MEROE_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_AMANITORE",
    "portrait": "LEADER_AMANITORE_NEUTRAL",
    "portraitBackground": "LEADER_AMANITORE_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_NUBI_Aminatore",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Amanitore.xlp",
      "blpPackage": "leaders/leader_amanitore",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Amanitore_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Nubia",
    "fallbackLeader": "FALLBACK_NEUTRAL_AMANITORE"
  },
  "LEADER_AMBIORIX": {
    "leaderType": "LEADER_AMBIORIX",
    "leaderIcon": "ICON_LEADER_AMBIORIX",
    "leaderAbilityName": "LOC_TRAIT_LEADER_AMBIORIX_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_AMBIORIX_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_AMBIORIX",
    "portrait": "LEADER_AMBIORIX_NEUTRAL",
    "portraitBackground": "LEADER_AMBIORIX_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_GAUL_Ambiorix",
      "xlpClass": "Leader",
      "xlpPath": "leader_ambiorix.xlp",
      "blpPackage": "leaders/leader_ambiorix",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Ambiorix_Light_Rig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Gaul",
    "fallbackLeader": "FALLBACK_NEUTRAL_AMBIORIX"
  },
  "LEADER_BARBAROSSA": {
    "leaderType": "LEADER_BARBAROSSA",
    "leaderIcon": "ICON_LEADER_BARBAROSSA",
    "leaderAbilityName": "LOC_TRAIT_LEADER_HOLY_ROMAN_EMPEROR_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_HOLY_ROMAN_EMPEROR_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_BARBAROSSA",
    "portrait": "LEADER_BARBAROSSA_NEUTRAL",
    "portraitBackground": "LEADER_BARBAROSSA_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_BARB",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Barbarossa.xlp",
      "blpPackage": "leaders/leader_barbarossa",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Barbarossa_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "GERMANY",
    "fallbackLeader": "FALLBACK_NEUTRAL_BARBAROSSA"
  },
  "LEADER_BASIL": {
    "leaderType": "LEADER_BASIL",
    "leaderIcon": "ICON_LEADER_BASIL",
    "leaderAbilityName": "LOC_TRAIT_LEADER_BASIL_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_BASIL_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_BASIL",
    "portrait": "LEADER_BASIL_NEUTRAL",
    "portraitBackground": "LEADER_BASIL_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_BYZA_BasilII",
      "xlpClass": "Leader",
      "xlpPath": "leader_basil.xlp",
      "blpPackage": "leaders/leader_basil",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Basil_Light_Rig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Byzantium",
    "fallbackLeader": "FALLBACK_NEUTRAL_BASIL"
  },
  "LEADER_CATHERINE_DE_MEDICI": {
    "leaderType": "LEADER_CATHERINE_DE_MEDICI",
    "leaderIcon": "ICON_LEADER_CATHERINE_DE_MEDICI",
    "leaderAbilityName": "LOC_TRAIT_LEADER_FLYING_SQUADRON_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_FLYING_SQUADRON_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_CATHERINE_DE_MEDICI",
    "portrait": "LEADER_CATHERINE_DE_MEDICI_NEUTRAL",
    "portraitBackground": "LEADER_CATHERINE_DE_MEDICI_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_CATHERINE",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Catherine.xlp",
      "blpPackage": "leaders/leader_catherine",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Catherine_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "FRANCE",
    "fallbackLeader": "FALLBACK_NEUTRAL_CATHERINE"
  },
  "LEADER_CATHERINE_DE_MEDICI_ALT": {
    "leaderType": "LEADER_CATHERINE_DE_MEDICI_ALT",
    "leaderIcon": "ICON_LEADER_CATHERINE_DE_MEDICI_ALT",
    "leaderAbilityName": "LOC_TRAIT_LEADER_MAGNIFICENCES_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_MAGNIFICENCES_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_CATHERINE_DE_MEDICI_ALT",
    "portrait": "LEADER_CATHERINE_DE_MEDICI_ALT_NEUTRAL",
    "portraitBackground": "LEADER_CATHERINE_DE_MEDICI_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_FRAN_CatherineDeMedici",
      "xlpClass": "Leader",
      "xlpPath": "leader_catherine_magnificent.xlp",
      "blpPackage": "leaders/leader_catherine_magnificent",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Catherine_Alt_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "FRANCE",
    "fallbackLeader": "FALLBACK_NEUTRAL_CATHERINE_M"
  },
  "LEADER_CHANDRAGUPTA": {
    "leaderType": "LEADER_CHANDRAGUPTA",
    "leaderIcon": "ICON_LEADER_CHANDRAGUPTA",
    "leaderAbilityName": "LOC_TRAIT_LEADER_ARTHASHASTRA_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_ARTHASHASTRA_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_GILGAMESH",
    "portrait": "LEADER_CHANDRAGUPTA_NEUTRAL",
    "portraitBackground": "LEADER_CHANDRAGUPTA_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_INDI_Chandragupda",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Chandragupta.xlp",
      "blpPackage": "leaders/leader_chandragupta",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Chandragupta_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "India2",
    "fallbackLeader": "FALLBACK_NEUTRAL_CHANDRAGUPTA"
  },
  "LEADER_CLEOPATRA": {
    "leaderType": "LEADER_CLEOPATRA",
    "leaderIcon": "ICON_LEADER_CLEOPATRA",
    "leaderAbilityName": "LOC_TRAIT_LEADER_MEDITERRANEAN_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_MEDITERRANEAN_EXPANSION2_DESCRIPTION",
    "leaderAbilityIcon": "LEADER_RAMSES",
    "portrait": "LEADER_CLEOPATRA_NEUTRAL",
    "portraitBackground": "LEADER_CLEOPATRA_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_CLEO",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Cleopatra.xlp",
      "blpPackage": "leaders/leader_cleopatra",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Cleopatra_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "EGYPT",
    "fallbackLeader": "FALLBACK_NEUTRAL_CLEOPATRA"
  },
  "LEADER_CLEOPATRA_ALT": {
    "leaderType": "LEADER_CLEOPATRA_ALT",
    "leaderIcon": "ICON_LEADER_CLEOPATRA_ALT",
    "leaderAbilityName": "LOC_TRAIT_LEADER_CLEOPATRA_ALT_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_CLEOPATRA_ALT_DESCRIPTION",
    "leaderAbilityIcon": "LEADER_CLEOPATRA",
    "portrait": "LEADER_CLEOPATRA_ALT_NEUTRAL",
    "portraitBackground": "LEADER_CLEOPATRA_ALT_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_EGYP_Cleo_Reskin",
      "xlpClass": "Leader",
      "xlpPath": "leader_cleopatra_alt.xlp",
      "blpPackage": "leaders/leader_cleopatra_alt",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Cleopatra_Alt_Light_Rig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "EGYPT",
    "fallbackLeader": "FALLBACK_NEUTRAL_CLEOPATRA_ALT"
  },
  "LEADER_CYRUS": {
    "leaderType": "LEADER_CYRUS",
    "leaderIcon": "ICON_LEADER_CYRUS",
    "leaderAbilityName": "LOC_TRAIT_LEADER_FALL_BABYLON_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_FALL_BABYLON_EXPANSION2_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_CYRUS",
    "portrait": "LEADER_CYRUS_NEUTRAL",
    "portraitBackground": "LEADER_CYRUS_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_CYRUS",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Cyrus.xlp",
      "blpPackage": "leaders/leader_cyrus",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Cyrus_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Persia",
    "fallbackLeader": "FALLBACK_NEUTRAL_CYRUS"
  },
  "LEADER_DIDO": {
    "leaderType": "LEADER_DIDO",
    "leaderIcon": "ICON_LEADER_DIDO",
    "leaderAbilityName": "LOC_TRAIT_LEADER_FOUNDER_CARTHAGE_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_FOUNDER_CARTHAGE_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_DIDO",
    "portrait": "LEADER_DIDO_NEUTRAL",
    "portraitBackground": "LEADER_DIDO_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_PHOE_Dido",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Dido.xlp",
      "blpPackage": "leaders/leader_dido",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Dido_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Phoenicia",
    "fallbackLeader": "FALLBACK_NEUTRAL_DIDO"
  },
  "LEADER_ELEANOR_ENGLAND": {
    "leaderType": "LEADER_ELEANOR_ENGLAND",
    "leaderIcon": "ICON_LEADER_ELEANOR_ENGLAND",
    "leaderAbilityName": "LOC_TRAIT_LEADER_ELEANOR_LOYALTY_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_ELEANOR_LOYALTY_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_ELEANOR_ENGLAND",
    "portrait": "LEADER_ELEANOR_ENGLAND_NEUTRAL",
    "portraitBackground": "LEADER_ELEANOR_ENGLAND_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_ENGL_Eleanor",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Eleanor_England.xlp",
      "blpPackage": "leaders/leader_Eleanor_England",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Eleanor_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "EleanorEngland",
    "fallbackLeader": "FALLBACK_NEUTRAL_ELEANOR_ENGLAND"
  },
  "LEADER_ELEANOR_FRANCE": {
    "leaderType": "LEADER_ELEANOR_FRANCE",
    "leaderIcon": "ICON_LEADER_ELEANOR_FRANCE",
    "leaderAbilityName": "LOC_TRAIT_LEADER_ELEANOR_LOYALTY_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_ELEANOR_LOYALTY_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_ELEANOR_FRANCE",
    "portrait": "LEADER_ELEANOR_FRANCE_NEUTRAL",
    "portraitBackground": "LEADER_ELEANOR_FRANCE_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_FRAN_Eleanor",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Eleanor_France.xlp",
      "blpPackage": "leaders/leader_Eleanor_France",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Eleanor_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "EleanorFrance",
    "fallbackLeader": "FALLBACK_NEUTRAL_ELEANOR_FRANCE"
  },
  "LEADER_ELIZABETH": {
    "leaderType": "LEADER_ELIZABETH",
    "leaderIcon": "ICON_LEADER_ELIZABETH",
    "leaderAbilityName": "LOC_TRAIT_LEADER_ELIZABETH_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_ELIZABETH_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_ELIZABETH",
    "portrait": "LEADER_ELIZABETH_NEUTRAL",
    "portraitBackground": "LEADER_ELIZABETH_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_ENGL_Elizabeth",
      "xlpClass": "Leader",
      "xlpPath": "leader_elizabeth.xlp",
      "blpPackage": "leaders/leader_elizabeth",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Elizabeth_Light_Rig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "UK",
    "fallbackLeader": "FALLBACK_NEUTRAL_ELIZABETH"
  },
  "LEADER_GANDHI": {
    "leaderType": "LEADER_GANDHI",
    "leaderIcon": "ICON_LEADER_GANDHI",
    "leaderAbilityName": "LOC_TRAIT_LEADER_SATYAGRAHA_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_SATYAGRAHA_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_GANDHI",
    "portrait": "LEADER_GANDHI_NEUTRAL",
    "portraitBackground": "LEADER_GANDHI_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_GANDHI",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Gandhi.xlp",
      "blpPackage": "/leaders/leader_gandhi",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Gandhi_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "INDIA",
    "fallbackLeader": "FALLBACK_NEUTRAL_GANDHI"
  },
  "LEADER_GENGHIS_KHAN": {
    "leaderType": "LEADER_GENGHIS_KHAN",
    "leaderIcon": "ICON_LEADER_GENGHIS_KHAN",
    "leaderAbilityName": "LOC_TRAIT_LEADER_GENGHIS_KHAN_ABILITY_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_GENGHIS_KHAN_ABILITY_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_QIN",
    "portrait": "LEADER_GENGHIS_KHAN_NEUTRAL",
    "portraitBackground": "LEADER_GENGHIS_KHAN_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_MONG_Khan",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Genghis_Khan.xlp",
      "blpPackage": "leaders/leader_genghis_khan",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "GenghisKhan_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Mongolia",
    "fallbackLeader": "FALLBACK_NEUTRAL_GENGHIS_KHAN"
  },
  "LEADER_GILGAMESH": {
    "leaderType": "LEADER_GILGAMESH",
    "leaderIcon": "ICON_LEADER_GILGAMESH",
    "leaderAbilityName": "LOC_TRAIT_LEADER_ADVENTURES_ENKIDU_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_ADVENTURES_ENKIDU_EXPANSION2_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_GILGAMESH",
    "portrait": "LEADER_GILGAMESH_NEUTRAL",
    "portraitBackground": "LEADER_GILGAMESH_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_GILG",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Gilgamesh.xlp",
      "blpPackage": "/leaders/leader_gilgamesh",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Gilgamesh_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "SUMERIA",
    "fallbackLeader": "FALLBACK_NEUTRAL_GILGAMESH"
  },
  "LEADER_GITARJA": {
    "leaderType": "LEADER_GITARJA",
    "leaderIcon": "ICON_LEADER_GITARJA",
    "leaderAbilityName": "LOC_TRAIT_LEADER_EXALTED_GODDESS_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_EXALTED_GODDESS_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_GITARJA",
    "portrait": "LEADER_GITARJA_NEUTRAL",
    "portraitBackground": "LEADER_GITARJA_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_INDO_Dyah",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Gitarja.xlp",
      "blpPackage": "leaders/leader_gitarja",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Gitaraja_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Indonesia",
    "fallbackLeader": "FALLBACK_NEUTRAL_GITARJA"
  },
  "LEADER_GORGO": {
    "leaderType": "LEADER_GORGO",
    "leaderIcon": "ICON_LEADER_GORGO",
    "leaderAbilityName": "LOC_TRAIT_LEADER_THERMOPYLAE_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_THERMOPYLAE_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_GORGO",
    "portrait": "LEADER_GORGO_NEUTRAL",
    "portraitBackground": "LEADER_GORGO_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_GORGO",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Gorgo.xlp",
      "blpPackage": "/leaders/leader_gorgo",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Gorgo_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "GREECE_GORGO",
    "fallbackLeader": "FALLBACK_NEUTRAL_GORGO"
  },
  "LEADER_HAMMURABI": {
    "leaderType": "LEADER_HAMMURABI",
    "leaderIcon": "ICON_LEADER_HAMMURABI",
    "leaderAbilityName": "LOC_TRAIT_LEADER_HAMMURABI_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_HAMMURABI_XP1_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_HAMMURABI",
    "portrait": "LEADER_HAMMURABI_NEUTRAL",
    "portraitBackground": "LEADER_HAMMURABI_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_BABY_Hammurabi",
      "xlpClass": "Leader",
      "xlpPath": "leader_hammurabi.xlp",
      "blpPackage": "leaders/leader_hammurabi",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Hammurabi_Light_Rig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Babylon",
    "fallbackLeader": "FALLBACK_NEUTRAL_HAMMURABI"
  },
  "LEADER_HARALD_ALT": {
    "leaderType": "LEADER_HARALD_ALT",
    "leaderIcon": "ICON_LEADER_HARALD_ALT",
    "leaderAbilityName": "LOC_TRAIT_LEADER_HARALD_ALT_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_HARALD_ALT_XP_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_HARALD_ALT",
    "portrait": "LEADER_HARALD_ALT_NEUTRAL",
    "portraitBackground": "LEADER_HARALD_ALT_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_NORW_Harald_Reskin",
      "xlpClass": "Leader",
      "xlpPath": "leader_harald_alt.xlp",
      "blpPackage": "leaders/leader_harald_alt",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Harald_Alt_Light_Rig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Norway",
    "fallbackLeader": "FALLBACK_NEUTRAL_HARALD_ALT"
  },
  "LEADER_HARDRADA": {
    "leaderType": "LEADER_HARDRADA",
    "leaderIcon": "ICON_LEADER_HARDRADA",
    "leaderAbilityName": "LOC_TRAIT_LEADER_THUNDERBOLT_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_THUNDERBOLT_EXPANSION2_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_HARDRADA",
    "portrait": "LEADER_HARDRADA_NEUTRAL",
    "portraitBackground": "LEADER_HARDRADA_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_HARALD",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Harald.xlp",
      "blpPackage": "leaders/leader_harald",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Harald_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "NORWAY",
    "fallbackLeader": "FALLBACK_NEUTRAL_HARDRADA"
  },
  "LEADER_HOJO": {
    "leaderType": "LEADER_HOJO",
    "leaderIcon": "ICON_LEADER_HOJO",
    "leaderAbilityName": "LOC_TRAIT_LEADER_DIVINE_WIND_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_DIVINE_WIND_EXPANSION2_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_HOJO",
    "portrait": "LEADER_HOJO_NEUTRAL",
    "portraitBackground": "LEADER_HOJO_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_HOJO",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Hojo.xlp",
      "blpPackage": "leaders/leader_hojo",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Hojo_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "JAPAN",
    "fallbackLeader": "FALLBACK_NEUTRAL_HOJO"
  },
  "LEADER_JADWIGA": {
    "leaderType": "LEADER_JADWIGA",
    "leaderIcon": "ICON_LEADER_JADWIGA",
    "leaderAbilityName": "LOC_TRAIT_LEADER_LITHUANIAN_UNION_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_LITHUANIAN_UNION_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_JADWIGA",
    "portrait": "LEADER_JADWIGA_NEUTRAL",
    "portraitBackground": "LEADER_JADWIGA_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_POLA_Jadwiga",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Jadwiga.xlp",
      "blpPackage": "leaders/leader_jadwiga",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Jadwiga_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "POLAND",
    "fallbackLeader": "FALLBACK_NEUTRAL_JADWIGA"
  },
  "LEADER_JAYAVARMAN": {
    "leaderType": "LEADER_JAYAVARMAN",
    "leaderIcon": "ICON_LEADER_JAYAVARMAN",
    "leaderAbilityName": "LOC_TRAIT_LEADER_MONASTERIES_KING_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_MONASTERIES_KING_EXPANSION2_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_JAYAVARMAN",
    "portrait": "LEADER_JAYAVARMAN_NEUTRAL",
    "portraitBackground": "LEADER_JAYAVARMAN_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_KHMER_Jayavarman",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Jayavarman.xlp",
      "blpPackage": "leaders/leader_jayavarman",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Jayavarman_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Khmer",
    "fallbackLeader": "FALLBACK_NEUTRAL_JAYAVARMAN"
  },
  "LEADER_JOAO_III": {
    "leaderType": "LEADER_JOAO_III",
    "leaderIcon": "ICON_LEADER_JOAO_III",
    "leaderAbilityName": "LOC_TRAIT_LEADER_JOAO_III_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_JOAO_III_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_JOAO_III",
    "portrait": "LEADER_JOAO_III_NEUTRAL",
    "portraitBackground": "LEADER_JOAO_III_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_PORT_Joao_III",
      "xlpClass": "Leader",
      "xlpPath": "leader_joao_iii.xlp",
      "blpPackage": "leaders/leader_joao",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Joao_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Portugal",
    "fallbackLeader": "FALLBACK_NEUTRAL_JOAO_III"
  },
  "LEADER_JOHN_CURTIN": {
    "leaderType": "LEADER_JOHN_CURTIN",
    "leaderIcon": "ICON_LEADER_JOHN_CURTIN",
    "leaderAbilityName": "LOC_TRAIT_LEADER_CITADEL_CIVILIZATION_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_CITADEL_CIVILIZATION_EXPANSION2_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_JOHN_CURTIN",
    "portrait": "LEADER_JOHN_CURTIN_NEUTRAL",
    "portraitBackground": "LEADER_JOHN_CURTIN_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_AUST_Curtain",
      "xlpClass": "Leader",
      "xlpPath": "Leader_John_Curtin.xlp",
      "blpPackage": "leaders/Leader_John_Curtin",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "John_Curtin_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "AUSTRALIA",
    "fallbackLeader": "FALLBACK_NEUTRAL_CURTAIN"
  },
  "LEADER_JULIUS_CAESAR": {
    "leaderType": "LEADER_JULIUS_CAESAR",
    "leaderIcon": "ICON_LEADER_JULIUS_CAESAR",
    "leaderAbilityName": "LOC_TRAIT_LEADER_CAESAR_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_CAESAR_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_JULIUS_CAESAR",
    "portrait": "LEADER_JULIUS_CAESAR_NEUTRAL",
    "portraitBackground": "LEADER_JULIUS_CAESAR_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_ROME_Julius",
      "xlpClass": "Leader",
      "xlpPath": "leader_julius_caesar.xlp",
      "blpPackage": "leaders/leader_julius_caesar",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Julius_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Rome_Cae",
    "fallbackLeader": "FALLBACK_NEUTRAL_JULIUS"
  },
  "LEADER_KRISTINA": {
    "leaderType": "LEADER_KRISTINA",
    "leaderIcon": "ICON_LEADER_KRISTINA",
    "leaderAbilityName": "LOC_TRAIT_LEADER_KRISTINA_AUTO_THEME_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_KRISTINA_AUTO_THEME_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_KRISTINA",
    "portrait": "LEADER_KRISTINA_NEUTRAL",
    "portraitBackground": "LEADER_KRISTINA_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_SWED_Kristina",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Kristina.xlp",
      "blpPackage": "leaders/leader_Kristina",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Kristina_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Sweden",
    "fallbackLeader": "FALLBACK_NEUTRAL_KRISTINA"
  },
  "LEADER_KUBLAI_KHAN_CHINA": {
    "leaderType": "LEADER_KUBLAI_KHAN_CHINA",
    "leaderIcon": "ICON_LEADER_KUBLAI_KHAN_CHINA",
    "leaderAbilityName": "LOC_TRAIT_LEADER_KUBLAI_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_KUBLAI_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_KUBLAI",
    "portrait": "LEADER_KUBLAI_KHAN_CHINA_NEUTRAL",
    "portraitBackground": "LEADER_KUBLAI_KHAN_CHINA_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_CHIN_Kublai_Khan",
      "xlpClass": "Leader",
      "xlpPath": "leader_kublai_china.xlp",
      "blpPackage": "leaders/leader_kublai_china",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Kublai_Khan_China_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "KublaiChina",
    "fallbackLeader": "FALLBACK_NEUTRAL_KUBLAI_KHAN_CHINA"
  },
  "LEADER_KUBLAI_KHAN_MONGOLIA": {
    "leaderType": "LEADER_KUBLAI_KHAN_MONGOLIA",
    "leaderIcon": "ICON_LEADER_KUBLAI_KHAN_MONGOLIA",
    "leaderAbilityName": "LOC_TRAIT_LEADER_KUBLAI_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_KUBLAI_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_KUBLAI",
    "portrait": "LEADER_KUBLAI_KHAN_MONGOLIA_NEUTRAL",
    "portraitBackground": "LEADER_KUBLAI_KHAN_MONGOLIA_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_MONG_Kublai_Khan",
      "xlpClass": "Leader",
      "xlpPath": "leader_kublai_mongolia.xlp",
      "blpPackage": "leaders/leader_kublai_mongolia",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Kublai_Khan_Mongolia_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "KublaiMongolia",
    "fallbackLeader": "FALLBACK_NEUTRAL_KUBLAI_KHAN_MONGOLIA"
  },
  "LEADER_KUPE": {
    "leaderType": "LEADER_KUPE",
    "leaderIcon": "ICON_LEADER_KUPE",
    "leaderAbilityName": "LOC_TRAIT_LEADER_KUPES_VOYAGE_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_KUPES_VOYAGE_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_KUPE",
    "portrait": "LEADER_KUPE_NEUTRAL",
    "portraitBackground": "LEADER_KUPE_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_MAOR_Kupe",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Kupe.xlp",
      "blpPackage": "leaders/leader_Kupe",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Kupe_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Maori",
    "fallbackLeader": "FALLBACK_NEUTRAL_KUPE"
  },
  "LEADER_LADY_SIX_SKY": {
    "leaderType": "LEADER_LADY_SIX_SKY",
    "leaderIcon": "ICON_LEADER_LADY_SIX_SKY",
    "leaderAbilityName": "LOC_TRAIT_LEADER_MUTAL_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_MUTAL_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_LADY_SIX_SKY",
    "portrait": "LEADER_LADY_SIX_SKY_NEUTRAL",
    "portraitBackground": "LEADER_LADY_SIX_SKY_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_MAYA_Lady_Six_Sky",
      "xlpClass": "Leader",
      "xlpPath": "leader_lady_six_sky.xlp",
      "blpPackage": "leaders/leader_lady_six_sky",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "LadySixSky_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Maya",
    "fallbackLeader": "FALLBACK_NEUTRAL_LADY_SIX_SKY"
  },
  "LEADER_LADY_TRIEU": {
    "leaderType": "LEADER_LADY_TRIEU",
    "leaderIcon": "ICON_LEADER_LADY_TRIEU",
    "leaderAbilityName": "LOC_TRAIT_LEADER_TRIEU_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_TRIEU_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_TRIEU",
    "portrait": "LEADER_LADY_TRIEU_NEUTRAL",
    "portraitBackground": "LEADER_LADY_TRIEU_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_VIET_Trieu",
      "xlpClass": "Leader",
      "xlpPath": "leader_lady_trieu.xlp",
      "blpPackage": "leaders/leader_lady_trieu",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Lady_Trieu_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Vietnam",
    "fallbackLeader": "FALLBACK_NEUTRAL_LADY_TRIEU"
  },
  "LEADER_LAURIER": {
    "leaderType": "LEADER_LAURIER",
    "leaderIcon": "ICON_LEADER_LAURIER",
    "leaderAbilityName": "LOC_TRAIT_LEADER_LAST_BEST_WEST_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_LAST_BEST_WEST_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_LAURIER",
    "portrait": "LEADER_LAURIER_NEUTRAL",
    "portraitBackground": "LEADER_LAURIER_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_CANA_Laurier",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Laurier.xlp",
      "blpPackage": "leaders/leader_Laurier",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Laurier_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Canada",
    "fallbackLeader": "FALLBACK_NEUTRAL_LAURIER"
  },
  "LEADER_LAUTARO": {
    "leaderType": "LEADER_LAUTARO",
    "leaderIcon": "ICON_LEADER_LAUTARO",
    "leaderAbilityName": "LOC_TRAIT_LEADER_LAUTARO_ABILITY_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_LAUTARO_ABILITY_DESCRIPTION_ALT",
    "leaderAbilityIcon": "ICON_LEADER_PEDRO",
    "portrait": "LEADER_LAUTARO_NEUTRAL",
    "portraitBackground": "LEADER_LAUTARO_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_MAPU_Lautaro",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Lautaro.xlp",
      "blpPackage": "leaders/leader_lautaro",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Lautaro_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Mapuche",
    "fallbackLeader": "FALLBACK_NEUTRAL_LAUTARO"
  },
  "LEADER_LUDWIG": {
    "leaderType": "LEADER_LUDWIG",
    "leaderIcon": "ICON_LEADER_LUDWIG",
    "leaderAbilityName": "LOC_TRAIT_LEADER_LUDWIG_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_LUDWIG_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_LUDWIG",
    "portrait": "LEADER_LUDWIG_NEUTRAL",
    "portraitBackground": "LEADER_LUDWIG_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_BAVA_Ludwig II",
      "xlpClass": "Leader",
      "xlpPath": "leader_ludwig_ii.xlp",
      "blpPackage": "leaders/leader_ludwig_ii",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Ludwig_II_Light_Rig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Germany_Lud",
    "fallbackLeader": "FALLBACK_NEUTRAL_LUDWIG"
  },
  "LEADER_MANSA_MUSA": {
    "leaderType": "LEADER_MANSA_MUSA",
    "leaderIcon": "ICON_LEADER_MANSA_MUSA",
    "leaderAbilityName": "LOC_TRAIT_LEADER_SAHEL_MERCHANTS_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_SAHEL_MERCHANTS_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_MANSA_MUSA",
    "portrait": "LEADER_MANSA_MUSA_NEUTRAL",
    "portraitBackground": "LEADER_MANSA_MUSA_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_MALI_Mansa",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Mansa_Musa.xlp",
      "blpPackage": "leaders/leader_mansa_musa",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Mansamusa_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Mali",
    "fallbackLeader": "FALLBACK_NEUTRAL_MANSA_MUSA"
  },
  "LEADER_MATTHIAS_CORVINUS": {
    "leaderType": "LEADER_MATTHIAS_CORVINUS",
    "leaderIcon": "ICON_LEADER_MATTHIAS_CORVINUS",
    "leaderAbilityName": "LOC_TRAIT_LEADER_RAVEN_KING_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_RAVEN_KING_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_MATTHIAS_CORVINUS",
    "portrait": "LEADER_MATTHIAS_CORVINUS_NEUTRAL",
    "portraitBackground": "LEADER_MATTHIAS_CORVINUS_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_HUNG_Matthias",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Matthias.xlp",
      "blpPackage": "leaders/leader_Matthias",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Matthias_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Hungary",
    "fallbackLeader": "FALLBACK_NEUTRAL_MATTHIAS_CORVINUS"
  },
  "LEADER_MENELIK": {
    "leaderType": "LEADER_MENELIK",
    "leaderIcon": "ICON_LEADER_MENELIK",
    "leaderAbilityName": "LOC_TRAIT_LEADER_MENELIK_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_MENELIK_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_MENELIK",
    "portrait": "LEADER_MENELIK_NEUTRAL",
    "portraitBackground": "LEADER_MENELIK_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_ETHI_MenelikII",
      "xlpClass": "Leader",
      "xlpPath": "leader_menelikii.xlp",
      "blpPackage": "leaders/leader_menelikii",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "MenelikII_Light_Rig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Ethiopia",
    "fallbackLeader": "FALLBACK_NEUTRAL_MENELIK"
  },
  "LEADER_MONTEZUMA": {
    "leaderType": "LEADER_MONTEZUMA",
    "leaderIcon": "ICON_LEADER_MONTEZUMA",
    "leaderAbilityName": "LOC_TRAIT_LEADER_GIFTS_FOR_TLATOANI_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_GIFTS_FOR_TLATOANI_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_MONTEZUMA",
    "portrait": "LEADER_MONTEZUMA_NEUTRAL",
    "portraitBackground": "LEADER_MONTEZUMA_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_MONTAZUMA",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Montezuma.xlp",
      "blpPackage": "leaders/leader_montezuma",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Montezuma_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "AZTEC",
    "fallbackLeader": "FALLBACK_NEUTRAL_MONTEZUMA"
  },
  "LEADER_MVEMBA": {
    "leaderType": "LEADER_MVEMBA",
    "leaderIcon": "ICON_LEADER_MVEMBA",
    "leaderAbilityName": "LOC_TRAIT_LEADER_RELIGIOUS_CONVERT_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_RELIGIOUS_CONVERT_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_MVEMBA",
    "portrait": "LEADER_MVEMBA_NEUTRAL",
    "portraitBackground": "LEADER_MVEMBA_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_AFON",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Mvemba.xlp",
      "blpPackage": "leaders/leader_mvemba",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Mvemba_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "KONGO",
    "fallbackLeader": "FALLBACK_NEUTRAL_MVEMBA"
  },
  "LEADER_NADER_SHAH": {
    "leaderType": "LEADER_NADER_SHAH",
    "leaderIcon": "ICON_LEADER_NADER_SHAH",
    "leaderAbilityName": "LOC_TRAIT_LEADER_NADER_SHAH_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_NADER_SHAH_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_NADER_SHAH",
    "portrait": "LEADER_NADER_SHAH_NEUTRAL",
    "portraitBackground": "LEADER_NADER_SHAH_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_IRAN_SHAH",
      "xlpClass": "Leader",
      "xlpPath": "leader_nader_shah.xlp",
      "blpPackage": "/leaders/leader_nader_shah",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Shah_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Iran",
    "fallbackLeader": "FALLBACK_NEUTRAL_NADERSHAH"
  },
  "LEADER_NZINGA_MBANDE": {
    "leaderType": "LEADER_NZINGA_MBANDE",
    "leaderIcon": "ICON_LEADER_NZINGA_MBANDE",
    "leaderAbilityName": "LOC_TRAIT_LEADER_NZINGA_MBANDE_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_NZINGA_MBANDE_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_NZINGA_MBANDE",
    "portrait": "LEADER_NZINGA_MBANDE_NEUTRAL",
    "portraitBackground": "LEADER_NZINGA_MBANDE_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_KONG_Mbande",
      "xlpClass": "Leader",
      "xlpPath": "leader_mbande.xlp",
      "blpPackage": "leaders/leader_mbande",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Mbande_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Ambundu",
    "fallbackLeader": "FALLBACK_NEUTRAL_MBANDE"
  },
  "LEADER_PACHACUTI": {
    "leaderType": "LEADER_PACHACUTI",
    "leaderIcon": "ICON_LEADER_PACHACUTI",
    "leaderAbilityName": "LOC_TRAIT_LEADER_PACHACUTI_QHAPAQ_NAN_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_PACHACUTI_QHAPAQ_NAN_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_PACHACUTI",
    "portrait": "LEADER_PACHACUTI_NEUTRAL",
    "portraitBackground": "LEADER_PACHACUTI_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_INCA_Pachacuti",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Pachacuti.xlp",
      "blpPackage": "leaders/leader_pachacuti",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Pachacuti_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Inca",
    "fallbackLeader": "FALLBACK_NEUTRAL_PACHACUTI"
  },
  "LEADER_PEDRO": {
    "leaderType": "LEADER_PEDRO",
    "leaderIcon": "ICON_LEADER_PEDRO",
    "leaderAbilityName": "LOC_TRAIT_LEADER_MAGNANIMOUS_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_MAGNANIMOUS_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_PEDRO",
    "portrait": "LEADER_PEDRO_NEUTRAL",
    "portraitBackground": "LEADER_PEDRO_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_PEDRO",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Pedro.xlp",
      "blpPackage": "leaders/leader_pedro",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Pedro_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "BRAZIL",
    "fallbackLeader": "FALLBACK_NEUTRAL_PEDRO"
  },
  "LEADER_PERICLES": {
    "leaderType": "LEADER_PERICLES",
    "leaderIcon": "ICON_LEADER_PERICLES",
    "leaderAbilityName": "LOC_TRAIT_LEADER_SURROUNDED_BY_GLORY_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_SURROUNDED_BY_GLORY_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_PERICLES",
    "portrait": "LEADER_PERICLES_NEUTRAL",
    "portraitBackground": "LEADER_PERICLES_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_PERICLES",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Pericles.xlp",
      "blpPackage": "leaders/leader_pericles",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Pericles_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "GREECE",
    "fallbackLeader": "FALLBACK_NEUTRAL_PERICLES"
  },
  "LEADER_PETER_GREAT": {
    "leaderType": "LEADER_PETER_GREAT",
    "leaderIcon": "ICON_LEADER_PETER_GREAT",
    "leaderAbilityName": "LOC_TRAIT_LEADER_GRAND_EMBASSY_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_GRAND_EMBASSY_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_PETER_GREAT",
    "portrait": "LEADER_PETER_GREAT_NEUTRAL",
    "portraitBackground": "LEADER_PETER_GREAT_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_PETER",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Peter.xlp",
      "blpPackage": "leaders/leader_peter",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Peter_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "RUSSIA",
    "fallbackLeader": "FALLBACK_NEUTRAL_PETER_GREAT"
  },
  "LEADER_PHILIP_II": {
    "leaderType": "LEADER_PHILIP_II",
    "leaderIcon": "ICON_LEADER_PHILIP_II",
    "leaderAbilityName": "LOC_TRAIT_LEADER_EL_ESCORIAL_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_EL_ESCORIAL_EXPANSION2_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_PHILIP_II",
    "portrait": "LEADER_PHILIP_II_NEUTRAL",
    "portraitBackground": "LEADER_PHILIP_II_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_PHILLIP",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Phillip.xlp",
      "blpPackage": "leaders/leader_phillip",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Phillip_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "SPAIN",
    "fallbackLeader": "FALLBACK_NEUTRAL_PHILLIP"
  },
  "LEADER_POUNDMAKER": {
    "leaderType": "LEADER_POUNDMAKER",
    "leaderIcon": "ICON_LEADER_POUNDMAKER",
    "leaderAbilityName": "LOC_LEADER_POUNDMAKER_ABILITY_NAME",
    "leaderAbilityDescription": "LOC_LEADER_POUNDMAKER_ABILITY_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_PETER",
    "portrait": "LEADER_POUNDMAKER_NEUTRAL",
    "portraitBackground": "LEADER_POUNDMAKER_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_CREE_Poundmaker",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Poundmaker.xlp",
      "blpPackage": "leaders/leader_poundmaker",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Poundmaker_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Cree",
    "fallbackLeader": "FALLBACK_NEUTRAL_POUNDMAKER"
  },
  "LEADER_QIN": {
    "leaderType": "LEADER_QIN",
    "leaderIcon": "ICON_LEADER_QIN",
    "leaderAbilityName": "LOC_TRAIT_LEADER_FIRST_EMPEROR_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_FIRST_EMPEROR_EXPANSION2_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_QIN",
    "portrait": "LEADER_QIN_NEUTRAL",
    "portraitBackground": "LEADER_QIN_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_QIN",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Qin.xlp",
      "blpPackage": "/leaders/leader_qin",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Qin_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "CHINA",
    "fallbackLeader": "FALLBACK_NEUTRAL_QIN"
  },
  "LEADER_QIN_ALT": {
    "leaderType": "LEADER_QIN_ALT",
    "leaderIcon": "ICON_LEADER_QIN_ALT",
    "leaderAbilityName": "LOC_TRAIT_LEADER_QIN_ALT_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_QIN_ALT_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_QIN_ALT",
    "portrait": "LEADER_QIN_ALT_NEUTRAL",
    "portraitBackground": "LEADER_QIN_ALT_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_CHIN_QinAlt",
      "xlpClass": "Leader",
      "xlpPath": "leader_qin_alt.xlp",
      "blpPackage": "/leaders/leader_qin_alt",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Qin_Alt_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "CHINA",
    "fallbackLeader": "FALLBACK_NEUTRAL_QINALT"
  },
  "LEADER_RAMSES": {
    "leaderType": "LEADER_RAMSES",
    "leaderIcon": "ICON_LEADER_RAMSES",
    "leaderAbilityName": "LOC_TRAIT_LEADER_RAMSES_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_RAMSES_DESCRIPTION",
    "leaderAbilityIcon": "LEADER_CLEOPATRA_ALT",
    "portrait": "LEADER_RAMSES_NEUTRAL",
    "portraitBackground": "LEADER_RAMSES_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_EGYP_RamesII",
      "xlpClass": "Leader",
      "xlpPath": "leader_ramses_ii.xlp",
      "blpPackage": "leaders/leader_ramses_ii",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Ramses_II_Light_Rig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Egypt_RAM",
    "fallbackLeader": "FALLBACK_NEUTRAL_RAMSES"
  },
  "LEADER_ROBERT_THE_BRUCE": {
    "leaderType": "LEADER_ROBERT_THE_BRUCE",
    "leaderIcon": "ICON_LEADER_ROBERT_THE_BRUCE",
    "leaderAbilityName": "LOC_TRAIT_LEADER_BANNOCKBURN_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_BANNOCKBURN_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_CATHERINE_DE_MEDICI",
    "portrait": "LEADER_ROBERT_THE_BRUCE_NEUTRAL",
    "portraitBackground": "LEADER_ROBERT_THE_BRUCE_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_SCOT_Bruce",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Robert_The_Bruce.xlp",
      "blpPackage": "leaders/leader_robert_the_bruce",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "RobertTheBruce_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Scotland",
    "fallbackLeader": "FALLBACK_NEUTRAL_ROBERT_THE_BRUCE"
  },
  "LEADER_SALADIN": {
    "leaderType": "LEADER_SALADIN",
    "leaderIcon": "ICON_LEADER_SALADIN",
    "leaderAbilityName": "LOC_TRAIT_LEADER_RIGHTEOUSNESS_OF_FAITH_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_RIGHTEOUSNESS_OF_FAITH_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_SALADIN",
    "portrait": "LEADER_SALADIN_NEUTRAL",
    "portraitBackground": "LEADER_SALADIN_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_SALADIN",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Saladin.xlp",
      "blpPackage": "/leaders/leader_saladin",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Saladin_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "ARABIA",
    "fallbackLeader": "FALLBACK_NEUTRAL_SALADIN"
  },
  "LEADER_SALADIN_ALT": {
    "leaderType": "LEADER_SALADIN_ALT",
    "leaderIcon": "ICON_LEADER_SALADIN_ALT",
    "leaderAbilityName": "LOC_TRAIT_LEADER_SALADIN_ALT_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_SALADIN_ALT_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_SALADIN_ALT",
    "portrait": "LEADER_SALADIN_ALT_NEUTRAL",
    "portraitBackground": "LEADER_SALADIN_ALT_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_ARAB_SaladinAlt",
      "xlpClass": "Leader",
      "xlpPath": "leader_saladin_alt.xlp",
      "blpPackage": "leaders/leader_saladin_alt",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Saladin_Alt_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "ARABIA",
    "fallbackLeader": "FALLBACK_NEUTRAL_SALADIN_ALT"
  },
  "LEADER_SEJONG": {
    "leaderType": "LEADER_SEJONG",
    "leaderIcon": "ICON_LEADER_SEJONG",
    "leaderAbilityName": "LOC_TRAIT_LEADER_SEJONG_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_SEJONG_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_SEJONG",
    "portrait": "LEADER_SEJONG_NEUTRAL",
    "portraitBackground": "LEADER_SEJONG_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_KORE_Sejong",
      "xlpClass": "Leader",
      "xlpPath": "leader_sejong.xlp",
      "blpPackage": "leaders/leader_sejong",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Sejong_Light_Rig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Korea_SEJ",
    "fallbackLeader": "FALLBACK_NEUTRAL_SEJONG"
  },
  "LEADER_SEONDEOK": {
    "leaderType": "LEADER_SEONDEOK",
    "leaderIcon": "ICON_LEADER_SEONDEOK",
    "leaderAbilityName": "LOC_TRAIT_LEADER_HWARANG_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_HWARANG_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_PEDRO",
    "portrait": "LEADER_SEONDEOK_NEUTRAL",
    "portraitBackground": "LEADER_SEONDEOK_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_KORE_Seondeok",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Seondeok.xlp",
      "blpPackage": "leaders/leader_seondeok",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Seondeok_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Korea",
    "fallbackLeader": "FALLBACK_NEUTRAL_SEONDEOK"
  },
  "LEADER_SHAKA": {
    "leaderType": "LEADER_SHAKA",
    "leaderIcon": "ICON_LEADER_SHAKA",
    "leaderAbilityName": "LOC_TRAIT_LEADER_AMABUTHO_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_AMABUTHO_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_BARBAROSSA",
    "portrait": "LEADER_SHAKA_NEUTRAL",
    "portraitBackground": "LEADER_SHAKA_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_ZULU_Shaka",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Shaka.xlp",
      "blpPackage": "leaders/leader_shaka",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Shaka_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Zulu",
    "fallbackLeader": "FALLBACK_NEUTRAL_SHAKA"
  },
  "LEADER_SIMON_BOLIVAR": {
    "leaderType": "LEADER_SIMON_BOLIVAR",
    "leaderIcon": "ICON_LEADER_SIMON_BOLIVAR",
    "leaderAbilityName": "LOC_TRAIT_LEADER_CAMPANA_ADMIRABLE_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_CAMPANA_ADMIRABLE_DESCRIPTION_XP1",
    "leaderAbilityIcon": "ICON_LEADER_SIMON_BOLIVAR",
    "portrait": "LEADER_SIMON_BOLIVAR_NEUTRAL",
    "portraitBackground": "LEADER_SIMON_BOLIVAR_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_COLOM_Simon_Bolivar",
      "xlpClass": "Leader",
      "xlpPath": "leader_simon_bolivar.xlp",
      "blpPackage": "leaders/leader_simon_bolivar",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "SimonBolivar_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "GranColumbia",
    "fallbackLeader": "FALLBACK_NEUTRAL_SIMON_BOLIVAR"
  },
  "LEADER_SULEIMAN": {
    "leaderType": "LEADER_SULEIMAN",
    "leaderIcon": "ICON_LEADER_SULEIMAN",
    "leaderAbilityName": "LOC_TRAIT_LEADER_SULEIMAN_GOVERNOR_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_SULEIMAN_GOVERNOR_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_SULEIMAN",
    "portrait": "LEADER_SULEIMAN_NEUTRAL",
    "portraitBackground": "LEADER_SULEIMAN_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_OTTO_Suleiman",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Suleiman.xlp",
      "blpPackage": "leaders/leader_Suleiman",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Suleiman_Light_Rig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Ottomans",
    "fallbackLeader": "FALLBACK_NEUTRAL_SULEIMAN"
  },
  "LEADER_SULEIMAN_ALT": {
    "leaderType": "LEADER_SULEIMAN_ALT",
    "leaderIcon": "ICON_LEADER_SULEIMAN_ALT",
    "leaderAbilityName": "LOC_TRAIT_LEADER_SULEIMAN_ALT_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_SULEIMAN_ALT_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_SULEIMAN_ALT",
    "portrait": "LEADER_SULEIMAN_ALT_NEUTRAL",
    "portraitBackground": "LEADER_SULEIMAN_ALT_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_OTTO_Suleiman_Reskin",
      "xlpClass": "Leader",
      "xlpPath": "leader_suleiman_alt.xlp",
      "blpPackage": "/leaders/leader_suleiman_alt",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Suleiman_Alt_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Ottomans",
    "fallbackLeader": "FALLBACK_NEUTRAL_SULEIMANALT"
  },
  "LEADER_SUNDIATA_KEITA": {
    "leaderType": "LEADER_SUNDIATA_KEITA",
    "leaderIcon": "ICON_LEADER_SUNDIATA_KEITA",
    "leaderAbilityName": "LOC_TRAIT_LEADER_SUNDIATA_KEITA_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_SUNDIATA_KEITA_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_SUNDIATA_KEITA",
    "portrait": "LEADER_SUNDIATA_KEITA_NEUTRAL",
    "portraitBackground": "LEADER_SUNDIATA_KEITA_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_MALI_Sundiata Keita",
      "xlpClass": "Leader",
      "xlpPath": "leader_sundiata_keita.xlp",
      "blpPackage": "leaders/leader_sundiata_keita",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Sundiata_Keita_Light_Rig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Mali_SUN",
    "fallbackLeader": "FALLBACK_NEUTRAL_SUNDIATA_KEITA"
  },
  "LEADER_TAMAR": {
    "leaderType": "LEADER_TAMAR",
    "leaderIcon": "ICON_LEADER_TAMAR",
    "leaderAbilityName": "LOC_TRAIT_LEADER_RELIGION_CITY_STATES_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_RELIGION_CITY_STATES_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_PEDRO",
    "portrait": "LEADER_TAMAR_NEUTRAL",
    "portraitBackground": "LEADER_TAMAR_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_GEOR_Tamar",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Tamar.xlp",
      "blpPackage": "leaders/leader_tamar",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Tamar_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Georgia",
    "fallbackLeader": "FALLBACK_NEUTRAL_TAMAR"
  },
  "LEADER_THEODORA": {
    "leaderType": "LEADER_THEODORA",
    "leaderIcon": "ICON_LEADER_THEODORA",
    "leaderAbilityName": "LOC_TRAIT_LEADER_THEODORA_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_THEODORA_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_THEODORA",
    "portrait": "LEADER_THEODORA_NEUTRAL",
    "portraitBackground": "LEADER_THEODORA_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_BYZA_Theodora",
      "xlpClass": "Leader",
      "xlpPath": "leader_theodora.xlp",
      "blpPackage": "leaders/leader_theodora",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Theodora_Light_Rig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Byzantine",
    "fallbackLeader": "FALLBACK_NEUTRAL_THEODORA"
  },
  "LEADER_TOKUGAWA": {
    "leaderType": "LEADER_TOKUGAWA",
    "leaderIcon": "ICON_LEADER_TOKUGAWA",
    "leaderAbilityName": "LOC_TRAIT_LEADER_TOKUGAWA_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_TOKUGAWA_XP_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_TOKUGAWA",
    "portrait": "LEADER_TOKUGAWA_NEUTRAL",
    "portraitBackground": "LEADER_TOKUGAWA_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_JAPA_Tokugawa",
      "xlpClass": "Leader",
      "xlpPath": "leader_tokugawa.xlp",
      "blpPackage": "/leaders/leader_tokugawa",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Tokugawa_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Japan_TOK",
    "fallbackLeader": "FALLBACK_NEUTRAL_TOKUGAWA"
  },
  "LEADER_TOMYRIS": {
    "leaderType": "LEADER_TOMYRIS",
    "leaderIcon": "ICON_LEADER_TOMYRIS",
    "leaderAbilityName": "LOC_TRAIT_LEADER_KILLER_OF_CYRUS_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_KILLER_OF_CYRUS_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_TOMYRIS",
    "portrait": "LEADER_TOMYRIS_NEUTRAL",
    "portraitBackground": "LEADER_TOMYRIS_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_TOMYRIS",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Tomyris.xlp",
      "blpPackage": "/leaders/leader_tomyris",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Tomyris_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "SCYTHIA",
    "fallbackLeader": "FALLBACK_NEUTRAL_TOMYRIS"
  },
  "LEADER_TRAJAN": {
    "leaderType": "LEADER_TRAJAN",
    "leaderIcon": "ICON_LEADER_TRAJAN",
    "leaderAbilityName": "LOC_TRAIT_LEADER_TRAJANS_COLUMN_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_TRAJANS_COLUMN_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_TRAJAN",
    "portrait": "LEADER_TRAJAN_NEUTRAL",
    "portraitBackground": "LEADER_TRAJAN_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_TRAJAN",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Trajan.xlp",
      "blpPackage": "/leaders/leader_trajan",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Trajan_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "ROME",
    "fallbackLeader": "FALLBACK_NEUTRAL_TRAJAN"
  },
  "LEADER_T_ROOSEVELT": {
    "leaderType": "LEADER_T_ROOSEVELT",
    "leaderIcon": "ICON_LEADER_T_ROOSEVELT",
    "leaderAbilityName": "LOC_TRAIT_LEADER_ANTIQUES_AND_PARKS_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_ANTIQUES_AND_PARKS_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_T_ROOSEVELT",
    "portrait": "LEADER_T_ROOSEVELT_NEUTRAL",
    "portraitBackground": "LEADER_T_ROOSEVELT_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_THEO",
      "xlpClass": "Leader",
      "xlpPath": "Leader_T_Roosevelt.xlp",
      "blpPackage": "leaders/leader_t_roosevelt",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Teddy_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "AMERICA",
    "fallbackLeader": "FALLBACK_NEUTRAL_ROOSEVELT"
  },
  "LEADER_T_ROOSEVELT_ROUGHRIDER": {
    "leaderType": "LEADER_T_ROOSEVELT_ROUGHRIDER",
    "leaderIcon": "ICON_LEADER_T_ROOSEVELT_ROUGHRIDER",
    "leaderAbilityName": "LOC_TRAIT_LEADER_ROOSEVELT_COROLLARY_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_ROOSEVELT_COROLLARY_ROUGH_RIDER_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_T_ROOSEVELT_ROUGHRIDER",
    "portrait": "LEADER_T_ROOSEVELT_ROUGHRIDER_NEUTRAL",
    "portraitBackground": "LEADER_T_ROOSEVELT_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_AMER_TheodoreRoughRider",
      "xlpClass": "Leader",
      "xlpPath": "leader_teddy_roughrider.xlp",
      "blpPackage": "leaders/leader_teddy_roughrider",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Teddy_Roughrider_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "AMERICA",
    "fallbackLeader": "FALLBACK_NEUTRAL_ROOSEVELT_RR"
  },
  "LEADER_VICTORIA": {
    "leaderType": "LEADER_VICTORIA",
    "leaderIcon": "ICON_LEADER_VICTORIA",
    "leaderAbilityName": "LOC_TRAIT_LEADER_PAX_BRITANNICA_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_CIVILIZATION_PAX_BRITANNICA_EXPANSION2_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_VICTORIA",
    "portrait": "LEADER_VICTORIA_NEUTRAL",
    "portraitBackground": "LEADER_VICTORIA_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "ART_LEADER_VICTORIA",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Victoria.xlp",
      "blpPackage": "leaders/leader_victoria",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Victoria_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "ENGLAND",
    "fallbackLeader": "FALLBACK_NEUTRAL_VICTORIA"
  },
  "LEADER_VICTORIA_ALT": {
    "leaderType": "LEADER_VICTORIA_ALT",
    "leaderIcon": "ICON_LEADER_VICTORIA_ALT",
    "leaderAbilityName": "LOC_TRAIT_LEADER_VICTORIA_ALT_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_VICTORIA_ALT_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_VICTORIA_ALT",
    "portrait": "LEADER_VICTORIA_ALT_NEUTRAL",
    "portraitBackground": "LEADER_VICTORIA_ALT_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_ENGL_Victoria_Reskin",
      "xlpClass": "Leader",
      "xlpPath": "leader_victoria_alt.xlp",
      "blpPackage": "leaders/leader_victoria_alt",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Victoria_Alt_Light_Rig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "England",
    "fallbackLeader": "FALLBACK_NEUTRAL_VICTORIAALT"
  },
  "LEADER_WILHELMINA": {
    "leaderType": "LEADER_WILHELMINA",
    "leaderIcon": "ICON_LEADER_WILHELMINA",
    "leaderAbilityName": "LOC_TRAIT_RADIO_ORANJE_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_RADIO_ORANJE_DESCRIPTION",
    "leaderAbilityIcon": "LEADER_CLEOPATRA",
    "portrait": "LEADER_WILHELMINA_NEUTRAL",
    "portraitBackground": "LEADER_WILHELMINA_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_NETH_Wilhelmina",
      "xlpClass": "Leader",
      "xlpPath": "Leader_Whilhelmina.xlp",
      "blpPackage": "leaders/leader_whilhelmina",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Wilhelmina_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "Leader_LightRigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_2",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "Netherlands",
    "fallbackLeader": "FALLBACK_NEUTRAL_WILHELMINA"
  },
  "LEADER_WU_ZETIAN": {
    "leaderType": "LEADER_WU_ZETIAN",
    "leaderIcon": "ICON_LEADER_WU_ZETIAN",
    "leaderAbilityName": "LOC_TRAIT_LEADER_WU_ZETIAN_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_WU_ZETIAN_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_WU_ZETIAN",
    "portrait": "LEADER_WU_ZETIAN_NEUTRAL",
    "portraitBackground": "LEADER_WU_ZETIAN_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_CHIN_WuZetian",
      "xlpClass": "Leader",
      "xlpPath": "leader_wu_zetian.xlp",
      "blpPackage": "/leaders/leader_wu_zetian",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Wu_Zetian_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "China_WU",
    "fallbackLeader": "FALLBACK_NEUTRAL_WUZETIAN"
  },
  "LEADER_YONGLE": {
    "leaderType": "LEADER_YONGLE",
    "leaderIcon": "ICON_LEADER_YONGLE",
    "leaderAbilityName": "LOC_TRAIT_LEADER_YONGLE_NAME",
    "leaderAbilityDescription": "LOC_TRAIT_LEADER_YONGLE_XP_DESCRIPTION",
    "leaderAbilityIcon": "ICON_LEADER_YONGLE",
    "portrait": "LEADER_YONGLE_NEUTRAL",
    "portraitBackground": "LEADER_YONGLE_BACKGROUND",
    "leaderEntry": {
      "parameterName": "Leader_BLP_Entry",
      "name": "LEAD_CHIN_Yongle",
      "xlpClass": "Leader",
      "xlpPath": "leader_yongle.xlp",
      "blpPackage": "/leaders/leader_yongle",
      "libraryName": "Leader"
    },
    "lightrigEntry": {
      "parameterName": "Leader_Lightrig_BLP_Entry",
      "name": "Yongle_LightRig",
      "xlpClass": "LeaderLighting",
      "xlpPath": "leader_lightrigs.xlp",
      "blpPackage": "leaders/light_rigs",
      "libraryName": "LeaderLighting"
    },
    "colorKeyEntry": {
      "parameterName": "Leader_ColorKey_BLP_Entry",
      "name": "Leader_Colorkey_1",
      "xlpClass": "ColorKey",
      "xlpPath": "ColorKeys.xlp",
      "blpPackage": "ColorKeys",
      "libraryName": "ColorKey"
    },
    "audio": "China_YON",
    "fallbackLeader": "FALLBACK_NEUTRAL_YONGLE"
  }
} as const satisfies Record<string, CivBlitzModLeaderMetadata>

export const landmarkCatalog = [
  {
    "collection": "BuildingVariants",
    "name": "DISTRICT_INDUSTRIAL_ZONE",
    "subjectName": "BUILDING_ELECTRONICS_FACTORY",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_PRD_Modern_Japan_04ElectronicsFactory",
      "xlpClass": "TileBase",
      "xlpPath": "hero_buildings.xlp",
      "blpPackage": "landmarks/hero_buildings",
      "libraryName": "TileBase"
    },
    "entryName": "04AModern Age Factory (Japan)",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_BUILDING_ELECTRONICS_FACTORY"
  },
  {
    "collection": "BuildingVariants",
    "name": "DISTRICT_ENCAMPMENT",
    "subjectName": "BUILDING_ORDU",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Ordu",
      "xlpClass": "TileBase",
      "xlpPath": "Tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "Ordu",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_BUILDING_ORDU"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_MBANZA",
    "subjectName": "EMPTY",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_Mbanza_Base_01",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "BaseVariants001",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_MBANZA"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_MBANZA",
    "subjectName": "MALL",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_Mbanza_HB_01",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "DIS Mbanza Mall",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_MBANZA"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_MBANZA",
    "subjectName": "MARKET",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_Mbanza_HB_01",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "DIS Mbanza Market",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_MBANZA"
  },
  {
    "collection": "Eras",
    "name": "LM_POLDER",
    "subjectName": "",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "IMP_Polder",
      "xlpClass": "TileBase",
      "xlpPath": "IMP_Polder.xlp",
      "blpPackage": "IMP_Polder",
      "libraryName": "TileBase"
    },
    "entryName": "IMP_Polder",
    "flatten": false,
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_POLDER"
  },
  {
    "collection": "Eras",
    "name": "LM_POLDER",
    "subjectName": "",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "IMP_Polder02",
      "xlpClass": "TileBase",
      "xlpPath": "IMP_Polder.xlp",
      "blpPackage": "IMP_Polder",
      "libraryName": "TileBase"
    },
    "entryName": "IMP_Polder02",
    "flatten": false,
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_POLDER"
  },
  {
    "collection": "Eras",
    "name": "LM_POLDER_TLP",
    "subjectName": "",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "IMP_Polder_TLP",
      "xlpClass": "TileBase",
      "xlpPath": "IMP_Polder.xlp",
      "blpPackage": "IMP_Polder",
      "libraryName": "TileBase"
    },
    "entryName": "IMP_Polder_TLP",
    "flatten": false,
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_POLDER"
  },
  {
    "collection": "Eras",
    "name": "LM_POLDER_TLP",
    "subjectName": "",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "IMP_Polder02_TLP",
      "xlpClass": "TileBase",
      "xlpPath": "IMP_Polder.xlp",
      "blpPackage": "IMP_Polder",
      "libraryName": "TileBase"
    },
    "entryName": "IMP_Polder02_TLP",
    "flatten": false,
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_POLDER"
  },
  {
    "collection": "Eras",
    "name": "LM_GOLF_COURSE",
    "subjectName": "",
    "era": "ARTERA_INDUSTRIAL",
    "asset": {
      "parameterName": "Asset",
      "name": "IMP_Golf_Course_IND",
      "xlpClass": "TileBase",
      "xlpPath": "IMP_Golf_Course.xlp",
      "blpPackage": "IMP_Golf_Course",
      "libraryName": "TileBase"
    },
    "entryName": "Eras",
    "flatten": false,
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_GOLF_COURSE"
  },
  {
    "collection": "Eras",
    "name": "LM_GOLF_COURSE",
    "subjectName": "",
    "era": "ARTERA_MODERN",
    "asset": {
      "parameterName": "Asset",
      "name": "IMP_Golf_Course",
      "xlpClass": "TileBase",
      "xlpPath": "IMP_Golf_Course.xlp",
      "blpPackage": "IMP_Golf_Course",
      "libraryName": "TileBase"
    },
    "entryName": "Eras001",
    "flatten": false,
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_GOLF_COURSE"
  },
  {
    "collection": "Eras",
    "name": "LM_GOLF_COURSE",
    "subjectName": "",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "IMP_Golf_Course_CLA",
      "xlpClass": "TileBase",
      "xlpPath": "IMP_Golf_Course.xlp",
      "blpPackage": "IMP_Golf_Course",
      "libraryName": "TileBase"
    },
    "entryName": "Eras002",
    "flatten": false,
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_GOLF_COURSE"
  },
  {
    "collection": "Eras",
    "name": "LM_MEKEWAP",
    "subjectName": "",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "IMP_Cree_Mekawap",
      "xlpClass": "TileBase",
      "xlpPath": "IMP_Cree_Mekewap.xlp",
      "blpPackage": "IMP_Cree_Mekewap",
      "libraryName": "TileBase"
    },
    "entryName": "IMP_Cree_Mekewap",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_MEKEWAP"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "EMPTY",
    "era": "ARTERA_MODERN",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Base_01",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "BARRACKS",
    "era": "ARTERA_MODERN",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Base_02",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants001",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "STABLE",
    "era": "ARTERA_MODERN",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Base_02",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants002",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "STABLE, ARMORY",
    "era": "ARTERA_MODERN",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Base_03",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants003",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "BARRACKS, ARMORY",
    "era": "ARTERA_MODERN",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Base_03",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants004",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "BARRACKS, ARMORY, BUILDING_MILITARY_ACADEMY",
    "era": "ARTERA_MODERN",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Base_04",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants005",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "STABLE, ARMORY, BUILDING_MILITARY_ACADEMY",
    "era": "ARTERA_MODERN",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Base_04",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants006",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "EMPTY",
    "era": "ARTERA_INDUSTRIAL",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Industrial_Base_01",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants007",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "BARRACKS",
    "era": "ARTERA_INDUSTRIAL",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Industrial_Base_02",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants008",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "STABLE",
    "era": "ARTERA_INDUSTRIAL",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Industrial_Base_02",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants009",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "BARRACKS, ARMORY",
    "era": "ARTERA_INDUSTRIAL",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Industrial_Base_03",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants010",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "STABLE, ARMORY",
    "era": "ARTERA_INDUSTRIAL",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Industrial_Base_03",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants011",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "BARRACKS, ARMORY, BUILDING_MILITARY_ACADEMY",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Industrial_Base_04",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants012",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "STABLE, ARMORY, BUILDING_MILITARY_ACADEMY",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Industrial_Base_04",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants013",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "EMPTY",
    "era": "ARTERA_CLASSICAL",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Classical_Base_01",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants014",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "BARRACKS",
    "era": "ARTERA_CLASSICAL",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Classical_Base_02",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants015",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "STABLE",
    "era": "ARTERA_CLASSICAL",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Classical_Base_02",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants016",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "BARRACKS, ARMORY",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Classical_Base_03",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants017",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "STABLE, ARMORY",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Classical_Base_03",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants018",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "EMPTY",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Ancient_Base_01",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants019",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "BARRACKS",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Ancient_Base_02",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants020",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THANH",
    "subjectName": "STABLE",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Thanh_Ancient_Base_02",
      "xlpClass": "TileBase",
      "xlpPath": "tilebases.xlp",
      "blpPackage": "landmarks/tilebases",
      "libraryName": "TileBase"
    },
    "entryName": "KublaiKhan_Vietnam_BaseVariants021",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_DISTRICT_THANH"
  },
  {
    "collection": "BuildingVariants",
    "name": "DISTRICT_CITY_CENTER",
    "subjectName": "BUILDING_PALGUM",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_CTY_Palgum_AN",
      "xlpClass": "TileBase",
      "xlpPath": "hero_buildings.xlp",
      "blpPackage": "landmarks/hero_buildings",
      "libraryName": "TileBase"
    },
    "entryName": "Palgum",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_BUILDING_PALGUM"
  },
  {
    "collection": "BuildingVariants",
    "name": "DISTRICT_ENCAMPMENT",
    "subjectName": "BUILDING_BASILIKOI_PAIDES",
    "era": "ARTERA_MODERN",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Basilikoi_MOD",
      "xlpClass": "TileBase",
      "xlpPath": "hero_buildings.xlp",
      "blpPackage": "landmarks/hero_buildings",
      "libraryName": "TileBase"
    },
    "entryName": "BASILIKOI_PAIDES001001",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_BUILDING_BASILIKOI_PAIDES"
  },
  {
    "collection": "BuildingVariants",
    "name": "DISTRICT_ENCAMPMENT",
    "subjectName": "BUILDING_BASILIKOI_PAIDES",
    "era": "ARTERA_CLASSICAL",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Basilikoi_CLA",
      "xlpClass": "TileBase",
      "xlpPath": "hero_buildings.xlp",
      "blpPackage": "landmarks/hero_buildings",
      "libraryName": "TileBase"
    },
    "entryName": "BASILIKOI_PAIDES",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_BUILDING_BASILIKOI_PAIDES"
  },
  {
    "collection": "BuildingVariants",
    "name": "DISTRICT_ENCAMPMENT",
    "subjectName": "BUILDING_BASILIKOI_PAIDES",
    "era": "ARTERA_INDUSTRIAL",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Basilikoi_IND",
      "xlpClass": "TileBase",
      "xlpPath": "hero_buildings.xlp",
      "blpPackage": "landmarks/hero_buildings",
      "libraryName": "TileBase"
    },
    "entryName": "BASILIKOI_PAIDES001",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_BUILDING_BASILIKOI_PAIDES"
  },
  {
    "collection": "BuildingVariants",
    "name": "DISTRICT_ENCAMPMENT",
    "subjectName": "BUILDING_BASILIKOI_PAIDES",
    "era": "ARTERA_ANCIENT",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_ENC_Basilikoi_ANC",
      "xlpClass": "TileBase",
      "xlpPath": "hero_buildings.xlp",
      "blpPackage": "landmarks/hero_buildings",
      "libraryName": "TileBase"
    },
    "entryName": "BASILIKOI_PAIDES002",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_BUILDING_BASILIKOI_PAIDES"
  },
  {
    "collection": "Eras",
    "name": "LM_PAIRIDAEZA",
    "subjectName": "",
    "era": "ARTERA_ANCIENT",
    "asset": {
      "parameterName": "Asset",
      "name": "IMP_Pairidaeza_Ancient",
      "xlpClass": "TileBase",
      "xlpPath": "IMP_Pairidaeza.xlp",
      "blpPackage": "IMP_Pairidaeza",
      "libraryName": "TileBase"
    },
    "entryName": "Eras",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_PAIRIDAEZA"
  },
  {
    "collection": "Eras",
    "name": "LM_PAIRIDAEZA",
    "subjectName": "",
    "era": "ARTERA_INDUSTRIAL",
    "asset": {
      "parameterName": "Asset",
      "name": "IMP_Pairidaeza_Industrial",
      "xlpClass": "TileBase",
      "xlpPath": "IMP_Pairidaeza.xlp",
      "blpPackage": "IMP_Pairidaeza",
      "libraryName": "TileBase"
    },
    "entryName": "Eras001",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_PAIRIDAEZA"
  },
  {
    "collection": "Eras",
    "name": "LM_PAIRIDAEZA",
    "subjectName": "",
    "era": "ARTERA_MODERN",
    "asset": {
      "parameterName": "Asset",
      "name": "IMP_Pairidaeza_Modern",
      "xlpClass": "TileBase",
      "xlpPath": "IMP_Pairidaeza.xlp",
      "blpPackage": "IMP_Pairidaeza",
      "libraryName": "TileBase"
    },
    "entryName": "Eras002",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_PAIRIDAEZA"
  },
  {
    "collection": "Eras",
    "name": "LM_PAIRIDAEZA",
    "subjectName": "",
    "era": "ARTERA_CLASSICAL",
    "asset": {
      "parameterName": "Asset",
      "name": "IMP_Pairidaeza",
      "xlpClass": "TileBase",
      "xlpPath": "IMP_Pairidaeza.xlp",
      "blpPackage": "IMP_Pairidaeza",
      "libraryName": "TileBase"
    },
    "entryName": "Eras003",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_PAIRIDAEZA"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THEATER",
    "subjectName": "MARAE",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_THR_CLA_MAR02",
      "xlpClass": "TileBase",
      "xlpPath": "Districts.xlp",
      "blpPackage": "Districts",
      "libraryName": "TileBase"
    },
    "entryName": "Classical,w/Marae",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_BUILDING_MARAE"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THEATER",
    "subjectName": "MARAE, MUSEUM_ART",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_THR_REN_MAR03ART",
      "xlpClass": "TileBase",
      "xlpPath": "Districts.xlp",
      "blpPackage": "Districts",
      "libraryName": "TileBase"
    },
    "entryName": "02CRenaissance,w/Marae,Art Museum",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_BUILDING_MARAE"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THEATER",
    "subjectName": "MARAE",
    "era": "ARTERA_MODERN",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_THR_MOD_MAR02",
      "xlpClass": "TileBase",
      "xlpPath": "Districts.xlp",
      "blpPackage": "Districts",
      "libraryName": "TileBase"
    },
    "entryName": "04AModern,w/Marae",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_BUILDING_MARAE"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THEATER",
    "subjectName": "MARAE, MUSEUM_ART",
    "era": "ARTERA_MODERN",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_THR_MOD_MAR03ART",
      "xlpClass": "TileBase",
      "xlpPath": "Districts.xlp",
      "blpPackage": "Districts",
      "libraryName": "TileBase"
    },
    "entryName": "04AModern,w/Marae,Art Museum",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_BUILDING_MARAE"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THEATER",
    "subjectName": "MARAE, MUSEUM_ART, BROADCAST CENTER",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_THR_MOD_MAR04ART",
      "xlpClass": "TileBase",
      "xlpPath": "Districts.xlp",
      "blpPackage": "Districts",
      "libraryName": "TileBase"
    },
    "entryName": "04AModern,w/Marae,Art Museum,Broadcast Center",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_BUILDING_MARAE"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THEATER",
    "subjectName": "MARAE",
    "era": "ARTERA_INDUSTRIAL",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_THR_IND_MAR02",
      "xlpClass": "TileBase",
      "xlpPath": "Districts.xlp",
      "blpPackage": "Districts",
      "libraryName": "TileBase"
    },
    "entryName": "03Industrial,w/Marae",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_BUILDING_MARAE"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THEATER",
    "subjectName": "MARAE, MUSEUM_ART",
    "era": "ARTERA_INDUSTRIAL",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_THR_IND_MAR03ART",
      "xlpClass": "TileBase",
      "xlpPath": "Districts.xlp",
      "blpPackage": "Districts",
      "libraryName": "TileBase"
    },
    "entryName": "03Industrial,w/Marae,Art Museum",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_BUILDING_MARAE"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THEATER",
    "subjectName": "MARAE, MUSEUM_NAT",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_THR_REN_MAR03NAT",
      "xlpClass": "TileBase",
      "xlpPath": "Districts.xlp",
      "blpPackage": "Districts",
      "libraryName": "TileBase"
    },
    "entryName": "02CRenaissance,w/Marae,NatHist Museum",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_BUILDING_MARAE"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THEATER",
    "subjectName": "MARAE, MUSEUM_NAT",
    "era": "ARTERA_INDUSTRIAL",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_THR_IND_MAR03NAT",
      "xlpClass": "TileBase",
      "xlpPath": "Districts.xlp",
      "blpPackage": "Districts",
      "libraryName": "TileBase"
    },
    "entryName": "03Industrial,w/Marae,NatHist Museum",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_BUILDING_MARAE"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THEATER",
    "subjectName": "MARAE, MUSEUM_NAT",
    "era": "ARTERA_MODERN",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_THR_MOD_MAR03NAT",
      "xlpClass": "TileBase",
      "xlpPath": "Districts.xlp",
      "blpPackage": "Districts",
      "libraryName": "TileBase"
    },
    "entryName": "04AModern,w/Marae,NatHist Museum",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_BUILDING_MARAE"
  },
  {
    "collection": "BaseVariants",
    "name": "DISTRICT_THEATER",
    "subjectName": "MARAE, MUSEUM_NAT, BROADCAST CENTER",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "DIS_THR_MOD_MAR04NAT",
      "xlpClass": "TileBase",
      "xlpPath": "Districts.xlp",
      "blpPackage": "Districts",
      "libraryName": "TileBase"
    },
    "entryName": "04AModern,w/Marae,NatHist Museum,Broadcast Center",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_BUILDING_MARAE"
  },
  {
    "collection": "Eras",
    "name": "LM_PYRAMID",
    "subjectName": "",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "IMP_Nubian_Pyramids",
      "xlpClass": "TileBase",
      "xlpPath": "IMP_Nubian_Pyramids.xlp",
      "blpPackage": "IMP_Nubian_Pyramids",
      "libraryName": "TileBase"
    },
    "entryName": "Eras001",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_PYRAMID"
  },
  {
    "collection": "Eras",
    "name": "LM_KAMPUNG",
    "subjectName": "",
    "era": "DEFAULT",
    "asset": {
      "parameterName": "Asset",
      "name": "IMP_Khmer_Stilthouse",
      "xlpClass": "TileBase",
      "xlpPath": "IMP_Khmer_StiltHouse.xlp",
      "blpPackage": "IMP_Khmer_StiltHouse",
      "libraryName": "TileBase"
    },
    "entryName": "Eras",
    "flatten": true,
    "traitType": "TRAIT_CIVILIZATION_IMPROVEMENT_KAMPUNG"
  }
] as const satisfies readonly CivBlitzModLandmarkMetadata[]

export const bbgAdjacencyCatalog = [
  {
    "yieldChangeId": "BBG_Campus_Arabia_HS",
    "civilizationTrait": "TRAIT_CIVILIZATION_LAST_PROPHET"
  },
  {
    "yieldChangeId": "BBG_HS_Arabia_Campus",
    "civilizationTrait": "TRAIT_CIVILIZATION_LAST_PROPHET"
  },
  {
    "yieldChangeId": "BBG_AOS_ADJENCY_IZ_RND",
    "leaderTrait": "TRAIT_LEADER_VICTORIA_ALT"
  },
  {
    "yieldChangeId": "BBG_MBANDE_COMMERCIAL_HUB_MBANZA",
    "leaderTrait": "TRAIT_LEADER_NZINGA_MBANDE"
  },
  {
    "yieldChangeId": "BBG_MBANDE_THEATRE_MBANZA",
    "leaderTrait": "TRAIT_LEADER_NZINGA_MBANDE"
  },
  {
    "yieldChangeId": "BBG_Seowon_Culture",
    "leaderTrait": "TRAIT_LEADER_SEJONG"
  },
  {
    "yieldChangeId": "BBG_SUGUBA_HOLY_SITE_MANSA",
    "leaderTrait": "TRAIT_LEADER_SAHEL_MERCHANTS"
  },
  {
    "yieldChangeId": "BBG_SUGUBA_THEATER_SUNDIATA",
    "leaderTrait": "TRAIT_LEADER_SUNDIATA_KEITA"
  }
] as const satisfies readonly CivBlitzModBbgAdjacencyMetadata[]

