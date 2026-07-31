-- Fixes to integrate Better Balanced Game mod with Civ Blitz.
-- While writing this, the following is assumed:
-- * This script is ran last, i.e. after all BBG and Civ Blitz files related to traits,
-- * The script should be a no-op if BBG is not installed (hence the awkward CROSS JOINs),
-- * Some of the related fixes have been implemented into each CivTraits.sql file and Leader.sql file.

----------------------------------------------------------------------------------------------------
-- Arabia:
-- Add Holy Site <-> Campus adjacency bonuses also to these districts' replacements

-- 1. Replacement districts add +1 to HS and Campus
INSERT OR REPLACE INTO Adjacency_YieldChanges(ID, Description, YieldType, YieldChange, AdjacentDistrict)
SELECT 'BBG_Campus_Arabia_' || CivUniqueDistrictType, Description, YieldType, YieldChange, CivUniqueDistrictType
FROM DistrictReplaces CROSS JOIN Adjacency_YieldChanges
WHERE ID = 'BBG_Campus_Arabia_HS' AND ReplacesDistrictType = 'DISTRICT_HOLY_SITE';

INSERT OR REPLACE INTO Adjacency_YieldChanges(ID, Description, YieldType, YieldChange, AdjacentDistrict)
SELECT 'BBG_HS_Arabia_' || CivUniqueDistrictType, Description, YieldType, YieldChange, CivUniqueDistrictType
FROM DistrictReplaces CROSS JOIN Adjacency_YieldChanges
WHERE ID = 'BBG_HS_Arabia_Campus' AND ReplacesDistrictType = 'DISTRICT_CAMPUS';

INSERT OR REPLACE INTO District_Adjacencies(DistrictType, YieldChangeId)
SELECT 'DISTRICT_HOLY_SITE', ID
FROM Adjacency_YieldChanges WHERE ID LIKE 'BBG_HS_Arabia_%';

INSERT OR REPLACE INTO District_Adjacencies(DistrictType, YieldChangeId)
SELECT 'DISTRICT_CAMPUS', ID
FROM Adjacency_YieldChanges WHERE ID LIKE 'BBG_Campus_Arabia_%';

-- 2. Replacement districts receive these modifiers too
INSERT OR REPLACE INTO District_Adjacencies(DistrictType, YieldChangeId)
SELECT CivUniqueDistrictType, YieldChangeId
FROM DistrictReplaces CROSS JOIN District_Adjacencies
WHERE YieldChangeId LIKE 'BBG_Campus_Arabia_%' AND ReplacesDistrictType = 'DISTRICT_CAMPUS';

INSERT OR REPLACE INTO District_Adjacencies(DistrictType, YieldChangeId)
SELECT CivUniqueDistrictType, YieldChangeId
FROM DistrictReplaces CROSS JOIN District_Adjacencies
WHERE YieldChangeId LIKE 'BBG_HS_Arabia_%' AND ReplacesDistrictType = 'DISTRICT_HOLY_SITE';

-- 3. Disable exclusion based on traits other than *the* Civ traits
DELETE FROM ExcludedAdjacencies
WHERE YieldChangeId IN ('BBG_HS_Arabia_Campus', 'BBG_Campus_Arabia_HS')
  AND TraitType IN (
    SELECT TraitType FROM Units WHERE TraitType IS NOT NULL
    UNION
    SELECT TraitType FROM Districts WHERE TraitType IS NOT NULL
    UNION
    SELECT TraitType FROM Improvements WHERE TraitType IS NOT NULL
    UNION
    SELECT TraitType FROM Buildings WHERE TraitType IS NOT NULL
);

-- 4. The original adjacency already has all Civ-based exclusions. Let's add them to the new adjacency bonuses.
INSERT OR REPLACE INTO ExcludedAdjacencies(TraitType, YieldChangeId)
SELECT TraitType, District_Adjacencies.YieldChangeId
FROM ExcludedAdjacencies CROSS JOIN District_Adjacencies
WHERE ExcludedAdjacencies.YieldChangeId = 'BBG_HS_Arabia_Campus'
AND District_Adjacencies.YieldChangeId LIKE 'BBG_HS_Arabia_%';

INSERT OR REPLACE INTO ExcludedAdjacencies(TraitType, YieldChangeId)
SELECT TraitType, District_Adjacencies.YieldChangeId
FROM ExcludedAdjacencies CROSS JOIN District_Adjacencies
WHERE ExcludedAdjacencies.YieldChangeId = 'BBG_Campus_Arabia_HS'
AND District_Adjacencies.YieldChangeId LIKE 'BBG_Campus_Arabia_%';