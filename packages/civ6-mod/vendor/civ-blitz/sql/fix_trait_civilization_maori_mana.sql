-- Make the civ start in the ocean... unless another mod disabled it for Kupe
INSERT OR REPLACE INTO Leaders_XP2 (LeaderType, OceanStart)
SELECT 'LEADER_IMP_<modName>', OceanStart FROM Leaders_XP2
WHERE LeaderType = 'LEADER_KUPE';