-- MAYA_REQUIREMENTS set is used for adding +1 housing to farms.
-- Add <modName> as another Civ that should receive this bonus.
INSERT OR REPLACE INTO Requirements (RequirementId, RequirementType)
VALUES ('PLAYER_IS_MAYA_<modName>', 'REQUIREMENT_PLAYER_TYPE_MATCHES');

INSERT OR REPLACE INTO RequirementArguments (RequirementId, Name, Value)
VALUES ('PLAYER_IS_MAYA_<modName>', 'CivilizationType', 'CIVILIZATION_IMP_<modName>');

UPDATE RequirementSets
SET RequirementSetType = 'REQUIREMENTSET_TEST_ANY'
WHERE RequirementSetId = 'MAYA_REQUIREMENTS';

INSERT OR REPLACE INTO RequirementSetRequirements (RequirementSetId, RequirementId)
VALUES ('MAYA_REQUIREMENTS', 'PLAYER_IS_MAYA_<modName>');