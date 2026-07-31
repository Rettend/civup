-- Add a new modifier to Temples: +1 influence if they're owned by LEADER_IMP_<modName>.

INSERT OR IGNORE INTO Requirements (RequirementId, RequirementType)
VALUES ('REQUIRES_PLAYER_IS_<modName>', 'REQUIREMENT_PLAYER_LEADER_TYPE_MATCHES');

INSERT OR IGNORE INTO RequirementArguments (RequirementId, Name, Value)
VALUES ('REQUIRES_PLAYER_IS_<modName>', 'LeaderType', 'LEADER_IMP_<modName>');

INSERT OR IGNORE INTO RequirementSets (RequirementSetId, RequirementSetType)
VALUES ('PLAYER_IS_HARALD_ALT_CIV_BLITZ', 'REQUIREMENTSET_TEST_ANY');

INSERT OR REPLACE INTO RequirementSetRequirements (RequirementSetId, RequirementId)
VALUES ('PLAYER_IS_HARALD_ALT_CIV_BLITZ', 'REQUIRES_PLAYER_IS_<modName>');

INSERT OR IGNORE INTO Modifiers (ModifierId, ModifierType, SubjectRequirementSetId)
VALUES ('STAVE_CHURCH_INFLUENCEPOINTS_CIV_BLITZ', 'MODIFIER_PLAYER_ADJUST_INFLUENCE_POINTS_PER_TURN', 'PLAYER_IS_HARALD_ALT_CIV_BLITZ');

INSERT OR IGNORE INTO ModifierArguments (ModifierId, Name, Value)
VALUES ('STAVE_CHURCH_INFLUENCEPOINTS_CIV_BLITZ', 'Amount', '1');

INSERT OR IGNORE INTO BuildingModifiers (BuildingType, ModifierId)
VALUES ('BUILDING_TEMPLE', 'STAVE_CHURCH_INFLUENCEPOINTS_CIV_BLITZ');

INSERT OR IGNORE INTO BuildingModifiers (BuildingType, ModifierId)
SELECT CivUniqueBuildingType, 'STAVE_CHURCH_INFLUENCEPOINTS_CIV_BLITZ'
FROM BuildingReplaces
WHERE ReplacesBuildingType = 'BUILDING_TEMPLE';