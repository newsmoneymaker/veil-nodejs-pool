/**
 * Block reward of Veil mainnet as the consensus rules give it to miners (veil/budget.cpp, BudgetParams::GetBlockRewards).
 * The budget, foundation and founder payments of "super blocks" are separate outputs and are not part of it.
 * Amounts are in atomic units (1 VEIL = 1e8).
 **/
const VEIL_BASE = 100000000;
const SUPPLY_STOP = 9816000;

/**
 * Reward of a miner in the block at the given height, in atomic units.
 **/
exports.minerReward = function (height) {
	if (!(height > 0) || height > SUPPLY_STOP) return 0;
	if (height <= 518399) return 50 * VEIL_BASE;
	if (height <= 1036799) return 40 * VEIL_BASE;
	if (height <= 1555199) return 30 * VEIL_BASE;
	if (height <= 2073599) return 20 * VEIL_BASE;
	return 10 * VEIL_BASE;
};
