pragma solidity 0.6.6;

import "../utils/Utils5.sol";
import "../utils/zeppelin/ReentrancyGuard.sol";
import "../IKyberDao.sol";
import "../IKyberFeeHandler.sol";
import "../IKyberNetworkProxy.sol";
import "../ISimpleKyberProxy.sol";
import "../IBurnableToken.sol";
import "./ISanityRate.sol";
import "../utils/zeppelin/SafeMath.sol";
import "./DaoOperator.sol";

/**
 * @title IKyberProxy
 *  This interface combines two interfaces.
 *  It is needed since we use one function from each of the interfaces.
 *
 */
interface IKyberProxy is IKyberNetworkProxy, ISimpleKyberProxy {
    // empty block
}


/**
 * @title kyberFeeHandler
 *
 * @dev kyberFeeHandler works tightly with contracts kyberNetwork and kyberDao.
 *      Some events are moved to interface, for easier usage
 * @dev Terminology:
 *          Epoch - Voting campaign time frame in kyberDao.
 *              kyberDao voting campaigns are in the scope of epochs.
 *          BRR - Burn / Reward / Rebate. kyberNetwork fee is used for 3 purposes:
 *              Burning KNC
 *              Reward an address that staked knc in kyberStaking contract. AKA - stakers
 *              Rebate reserves for supporting trades.
 * @dev Code flow:
 *      1. Accumulating && claiming Fees. Per trade on kyberNetwork, it calls handleFees() function which
 *          internally accounts for network & platform fees from the trade. Fee distribution:
 *              rewards: accumulated per epoch. can be claimed by the kyberDao after epoch is concluded.
 *              rebates: accumulated per rebate wallet, can be claimed any time.
 *              Burn: accumulated in the contract. Burned value and interval limited with safe check using
                    sanity rate.
 *              Platfrom fee: accumulated per platform wallet, can be claimed any time.
 *      2. Network Fee distribution: Per epoch kyberFeeHandler contract reads BRR distribution percentage 
 *          from kyberDao. When the data expires, kyberFeeHandler reads updated values.
 */
contract KyberFeeHandler is IKyberFeeHandler, Utils5, DaoOperator, ReentrancyGuard {
    using SafeMath for uint256;

    uint256 internal constant DEFAULT_REWARD_BPS = 3000;
    uint256 internal constant DEFAULT_REBATE_BPS = 3000;
    uint256 internal constant SANITY_RATE_DIFF_BPS = 1000; // 10%

    struct BRRData {
        uint64 expiryTimestamp;
        uint32 epoch;
        uint16 rewardBps;
        uint16 rebateBps;
    }

    IKyberDao public kyberDao;
    IKyberProxy public kyberProxy;
    address public kyberNetwork;
    IERC20 public immutable knc;

    uint256 public immutable burnBlockInterval;
    uint256 public lastBurnBlock;

    BRRData public brrAndEpochData;
    address public daoSetter;

    /// @dev amount of eth to burn for each burn knc call
    uint256 public weiToBurn = 2 ether;

    mapping(address => uint256) public feePerPlatformWallet;
    mapping(address => uint256) public rebatePerWallet;
    mapping(uint256 => uint256) public rewardsPerEpoch;
    mapping(uint256 => uint256) public rewardsPaidPerEpoch;
    uint256 public totalPayoutBalance; // total balance in the contract that is for rebate, reward, platform fee

    /// @dev use to get rate of KNC/ETH to check if rate to burn knc is normal
    /// @dev index 0 is currently used contract address, indexes > 0 are older versions
    ISanityRate[] internal sanityRateContract;

    event FeeDistributed(
        address indexed platformWallet,
        uint256 platformFeeWei,
        uint256 rewardWei,
        uint256 rebateWei,
        address[] rebateWallets,
        uint256[] rebatePercentBpsPerWallet,
        uint256 burnAmtWei
    );

    event BRRUpdated(
        uint256 rewardBps,
        uint256 rebateBps,
        uint256 burnBps,
        uint256 expiryTimestamp,
        uint256 indexed epoch
    );

    event EthReceived(uint256 amount);
    event KyberDaoAddressSet(IKyberDao kyberDao);
    event BurnConfigSet(ISanityRate sanityRate, uint256 weiToBurn);
    event RewardsRemovedToBurn(uint256 indexed epoch, uint256 rewardsWei);
    event KyberNetworkUpdated(address kyberNetwork);
    event KyberProxyUpdated(IKyberProxy kyberProxy);

    constructor(
        address _daoSetter,
        IKyberProxy _kyberProxy,
        address _kyberNetwork,
        IERC20 _knc,
        uint256 _burnBlockInterval,
        address _daoOperator
    ) public DaoOperator(_daoOperator) {
        require(_daoSetter != address(0), "daoSetter 0");
        require(_kyberProxy != IKyberProxy(0), "kyberNetworkProxy 0");
        require(_kyberNetwork != address(0), "kyberNetwork 0");
        require(_knc != IERC20(0), "knc 0");
        require(_burnBlockInterval != 0, "_burnBlockInterval 0");

        daoSetter = _daoSetter;
        kyberProxy = _kyberProxy;
        kyberNetwork = _kyberNetwork;
        knc = _knc;
        burnBlockInterval = _burnBlockInterval;

        //start with epoch 0
        updateBRRData(DEFAULT_REWARD_BPS, DEFAULT_REBATE_BPS, now, 0);
    }

    modifier onlyKyberDao {
        require(msg.sender == address(kyberDao), "only kyberDao");
        _;
    }

    modifier onlyKyberNetwork {
        require(msg.sender == address(kyberNetwork), "only kyberNetwork");
        _;
    }

    modifier onlyNonContract {
        require(tx.origin == msg.sender, "only non-contract");
        _;
    }

    receive() external payable {
        emit EthReceived(msg.value);
    }

    /// @dev handleFees function is called per trade on kyberNetwork. unless the trade is not involving any fees.
    /// @param rebateWallets a list of rebate wallets that will get rebate for this trade.
    /// @param rebateBpsPerWallet percentage of rebate for each wallet, out of total rebate.
    /// @param platformWallet Wallet address that will receive the platfrom fee.
    /// @param platformFeeWei Fee amount in wei the platfrom wallet is entitled to.
    function handleFees(
        address[] calldata rebateWallets,
        uint256[] calldata rebateBpsPerWallet,
        address platformWallet,
        uint256 platformFeeWei
    ) external payable override onlyKyberNetwork nonReentrant {
        require(msg.value >= platformFeeWei, "msg.value low");

        // handle platform fee
        feePerPlatformWallet[platformWallet] = feePerPlatformWallet[platformWallet].add(
            platformFeeWei
        );

        uint256 feeBRRWei = msg.value.sub(platformFeeWei);

        if (feeBRRWei == 0) {
            // only platform fee paid
            totalPayoutBalance = totalPayoutBalance.add(platformFeeWei);
            emit FeeDistributed(
                platformWallet,
                platformFeeWei,
                0,
                0,
                rebateWallets,
                rebateBpsPerWallet,
                0
            );
            return;
        }

        uint256 rebateWei;
        uint256 rewardWei;
        uint256 epoch;

        // Decoding BRR data
        (rewardWei, rebateWei, epoch) = getRRWeiValues(feeBRRWei);

        rebateWei = updateRebateValues(rebateWei, rebateWallets, rebateBpsPerWallet);

        rewardsPerEpoch[epoch] = rewardsPerEpoch[epoch].add(rewardWei);

        // update total balance of rewards, rebates, fee
        totalPayoutBalance = totalPayoutBalance.add(platformFeeWei).add(rewardWei).add(rebateWei);

        uint burnAmountWei = feeBRRWei.sub(rewardWei).sub(rebateWei);
        emit FeeDistributed(
            platformWallet,
            platformFeeWei,
            rewardWei,
            rebateWei,
            rebateWallets,
            rebateBpsPerWallet,
            burnAmountWei
        );
    }

    /// @dev only kyberDao can claim staker rewards.
    /// @param staker address.
    /// @param percentageInPrecision the relative part of the reward the staker is entitled 
    ///             to for this epoch.
    ///             units Precision: 10 ** 18 = 100%
    /// @param epoch for which epoch the staker is claiming the reward
    function claimStakerReward(
        address staker,
        uint256 percentageInPrecision,
        uint256 epoch
    ) external override onlyKyberDao returns(uint256 amountWei) {
        // Amount of reward to be sent to staker
        require(percentageInPrecision <= PRECISION, "percentage too high");
        amountWei = rewardsPerEpoch[epoch].mul(percentageInPrecision).div(PRECISION);

        // redundant check, can't happen
        assert(totalPayoutBalance >= amountWei);
        assert(rewardsPaidPerEpoch[epoch].add(amountWei) <= rewardsPerEpoch[epoch]);
        
        rewardsPaidPerEpoch[epoch] = rewardsPaidPerEpoch[epoch].add(amountWei);
        totalPayoutBalance = totalPayoutBalance.sub(amountWei);

        // send reward to staker
        (bool success, ) = staker.call{value: amountWei}("");
        require(success, "staker rewards transfer failed");

        emit RewardPaid(staker, epoch, amountWei);
    }

    /// @dev claim reabate per reserve wallet. called by any address
    /// @param rebateWallet the wallet to claim rebates for. Total accumulated rebate sent to this wallet.
    /// @return amountWei amount of rebate claimed
    function claimReserveRebate(address rebateWallet) 
        external 
        override 
        nonReentrant 
        returns (uint256 amountWei) 
    {
        require(rebatePerWallet[rebateWallet] > 1, "no rebate to claim");
        // Get total amount of rebate accumulated
        amountWei = rebatePerWallet[rebateWallet].sub(1);

        // redundant check, can't happen
        assert(totalPayoutBalance >= amountWei);
        totalPayoutBalance = totalPayoutBalance.sub(amountWei);

        rebatePerWallet[rebateWallet] = 1; // avoid zero to non zero storage cost

        // send rebate to rebate wallet
        (bool success, ) = rebateWallet.call{value: amountWei}("");
        require(success, "rebate transfer failed");

        emit RebatePaid(rebateWallet, amountWei);

        return amountWei;
    }

    /// @dev claim accumulated fee per platform wallet. Called by any address
    /// @param platformWallet the wallet to claim fee for. Total accumulated fee sent to this wallet.
    /// @return amountWei amount of fee claimed
    function claimPlatformFee(address platformWallet)
        external
        override
        nonReentrant
        returns (uint256 amountWei)
    {
        require(feePerPlatformWallet[platformWallet] > 1, "no fee to claim");
        // Get total amount of fees accumulated
        amountWei = feePerPlatformWallet[platformWallet].sub(1);

        // redundant check, can't happen
        assert(totalPayoutBalance >= amountWei);
        totalPayoutBalance = totalPayoutBalance.sub(amountWei);

        feePerPlatformWallet[platformWallet] = 1; // avoid zero to non zero storage cost

        (bool success, ) = platformWallet.call{value: amountWei}("");
        require(success, "platform fee transfer failed");

        emit PlatformFeePaid(platformWallet, amountWei);
        return amountWei;
    }

    /// @dev set kyberDao contract address once and set setter address to zero.
    /// @param _kyberDao kyberDao address.
    function setDaoContract(IKyberDao _kyberDao) external {
        require(msg.sender == daoSetter, "only daoSetter");
        require(_kyberDao != IKyberDao(0));
        kyberDao = _kyberDao;
        emit KyberDaoAddressSet(kyberDao);

        daoSetter = address(0);
    }

    /// @dev set new kyberNetwork address by daoOperator
    /// @param _kyberNetwork new kyberNetwork contract
    function setNetworkContract(address _kyberNetwork) external onlyDaoOperator {
        require(_kyberNetwork != address(0), "kyberNetwork 0");
        if (_kyberNetwork != kyberNetwork) {
            kyberNetwork = _kyberNetwork;
            emit KyberNetworkUpdated(kyberNetwork);
        }
    }

    /// @dev Allow to set kyberNetworkProxy address by daoOperator
    /// @param _newProxy new kyberNetworkProxy contract
    function setKyberProxy(IKyberProxy _newProxy) external onlyDaoOperator {
        require(_newProxy != IKyberProxy(0), "kyberNetworkProxy 0");
        if (_newProxy != kyberProxy) {
            kyberProxy = _newProxy;
            emit KyberProxyUpdated(_newProxy);
        }
    }

    /// @dev set knc sanity rate contract and amount wei to burn
    /// @param _sanityRate new sanity rate contract
    /// @param _weiToBurn new amount of wei to burn
    function setBurnConfigParams(ISanityRate _sanityRate, uint256 _weiToBurn)
        external
        onlyDaoOperator
    {
        require(_weiToBurn > 0, "_weiToBurn is 0");

        if (sanityRateContract.length == 0 || (_sanityRate != sanityRateContract[0])) {
            // it is a new sanity rate contract
            if (sanityRateContract.length == 0) {
                sanityRateContract.push(_sanityRate);
            } else {
                sanityRateContract.push(sanityRateContract[0]);
                sanityRateContract[0] = _sanityRate;
            }
        }

        weiToBurn = _weiToBurn;

        emit BurnConfigSet(_sanityRate, _weiToBurn);
    }


    /// @dev Burn knc. The burn amount is limited. Forces block delay between burn calls.
    /// @dev only none ontract can call this function
    /// @return kncBurnAmount amount of knc burned
    function burnKnc() external onlyNonContract returns (uint256 kncBurnAmount) {
        // check if current block > last burn block number + num block interval
        require(block.number > lastBurnBlock + burnBlockInterval, "wait more blocks to burn");

        // update last burn block number
        lastBurnBlock = block.number;

        // Get amount to burn, if greater than weiToBurn, burn only weiToBurn per function call.
        uint256 balance = address(this).balance;

        // redundant check, can't happen
        assert(balance >= totalPayoutBalance);
        uint256 srcAmount = balance.sub(totalPayoutBalance);
        srcAmount = srcAmount > weiToBurn ? weiToBurn : srcAmount;

        // Get rate
        uint256 kyberEthKncRate = kyberProxy.getExpectedRateAfterFee(
            ETH_TOKEN_ADDRESS,
            knc,
            srcAmount,
            0,
            ""
        );
        validateEthToKncRateToBurn(kyberEthKncRate);

        // Buy some knc and burn
        kncBurnAmount = kyberProxy.swapEtherToToken{value: srcAmount}(
            knc,
            kyberEthKncRate
        );

        require(IBurnableToken(address(knc)).burn(kncBurnAmount), "knc burn failed");

        emit KncBurned(kncBurnAmount, srcAmount);
        return kncBurnAmount;
    }

    /// @dev if no one voted for an epoch (like epoch 0), no one gets rewards - should burn it.
    ///         Will move the epoch reward amount to burn amount. So can later be burned.
    ///         calls kyberDao contract to check if there were any votes for this epoch.
    /// @param epoch epoch number to check.
    function makeEpochRewardBurnable(uint256 epoch) external {
        require(kyberDao != IKyberDao(0), "kyberDao not set");

        require(kyberDao.shouldBurnRewardForEpoch(epoch), "should not burn reward");

        uint256 rewardAmount = rewardsPerEpoch[epoch];
        require(rewardAmount > 0, "reward is 0");

        // redundant check, can't happen
        require(totalPayoutBalance >= rewardAmount, "total reward less than epoch reward");
        totalPayoutBalance = totalPayoutBalance.sub(rewardAmount);

        rewardsPerEpoch[epoch] = 0;

        emit RewardsRemovedToBurn(epoch, rewardAmount);
    }

    /// @notice should be called off chain
    /// @dev returns list of sanity rate contracts
    /// @dev index 0 is currently used contract address, indexes > 0 are older versions
    function getSanityRateContracts() external view returns (ISanityRate[] memory sanityRates) {
        sanityRates = sanityRateContract;
    }

    /// @dev return latest knc/eth rate from sanity rate contract
    function getLatestSanityRate() external view returns (uint256 kncToEthSanityRate) {
        if (sanityRateContract.length > 0 && sanityRateContract[0] != ISanityRate(0)) {
            kncToEthSanityRate = sanityRateContract[0].latestAnswer();
        } else {
            kncToEthSanityRate = 0; 
        }
    }

    function getBRR()
        public
        returns (
            uint256 rewardBps,
            uint256 rebateBps,
            uint256 epoch
        )
    {
        uint256 expiryTimestamp;
        (rewardBps, rebateBps, expiryTimestamp, epoch) = readBRRData();

        // Check current timestamp
        if (now > expiryTimestamp && kyberDao != IKyberDao(0)) {
            uint256 burnBps;

            (burnBps, rewardBps, rebateBps, epoch, expiryTimestamp) = kyberDao
                .getLatestBRRDataWithCache();
            require(burnBps.add(rewardBps).add(rebateBps) == BPS, "Bad BRR values");
            
            emit BRRUpdated(rewardBps, rebateBps, burnBps, expiryTimestamp, epoch);

            // Update brrAndEpochData
            updateBRRData(rewardBps, rebateBps, expiryTimestamp, epoch);
        }
    }

    function readBRRData()
        public
        view
        returns (
            uint256 rewardBps,
            uint256 rebateBps,
            uint256 expiryTimestamp,
            uint256 epoch
        )
    {
        rewardBps = uint256(brrAndEpochData.rewardBps);
        rebateBps = uint256(brrAndEpochData.rebateBps);
        epoch = uint256(brrAndEpochData.epoch);
        expiryTimestamp = uint256(brrAndEpochData.expiryTimestamp);
    }

    function updateBRRData(
        uint256 reward,
        uint256 rebate,
        uint256 expiryTimestamp,
        uint256 epoch
    ) internal {
        // reward and rebate combined values <= BPS. Tested in getBRR.
        require(expiryTimestamp < 2**64, "expiry timestamp overflow");
        require(epoch < 2**32, "epoch overflow");

        brrAndEpochData.rewardBps = uint16(reward);
        brrAndEpochData.rebateBps = uint16(rebate);
        brrAndEpochData.expiryTimestamp = uint64(expiryTimestamp);
        brrAndEpochData.epoch = uint32(epoch);
    }

    function getRRWeiValues(uint256 RRAmountWei)
        internal
        returns (
            uint256 rewardWei,
            uint256 rebateWei,
            uint256 epoch
        )
    {
        // Decoding BRR data
        uint256 rewardInBps;
        uint256 rebateInBps;
        (rewardInBps, rebateInBps, epoch) = getBRR();

        rebateWei = RRAmountWei.mul(rebateInBps).div(BPS);
        rewardWei = RRAmountWei.mul(rewardInBps).div(BPS);
    }

    function updateRebateValues(
        uint256 rebateWei,
        address[] memory rebateWallets,
        uint256[] memory rebateBpsPerWallet
    ) internal returns (uint256 totalRebatePaidWei) {
        uint256 totalRebateBps;
        uint256 walletRebateWei;

        for (uint256 i = 0; i < rebateWallets.length; i++) {
            require(rebateWallets[i] != address(0), "rebate wallet address 0");

            walletRebateWei = rebateWei.mul(rebateBpsPerWallet[i]).div(BPS);
            rebatePerWallet[rebateWallets[i]] = rebatePerWallet[rebateWallets[i]].add(
                walletRebateWei
            );

            // a few wei could be left out due to rounding down. so count only paid wei
            totalRebatePaidWei = totalRebatePaidWei.add(walletRebateWei);
            totalRebateBps = totalRebateBps.add(rebateBpsPerWallet[i]);
        }

        require(totalRebateBps <= BPS, "rebates more then 100%");
    }

    function validateEthToKncRateToBurn(uint256 rateEthToKnc) internal view {
        require(rateEthToKnc <= MAX_RATE, "ethToKnc rate out of bounds");
        require(rateEthToKnc > 0, "ethToKnc rate is 0");
        require(sanityRateContract.length > 0, "no sanity rate contract");
        require(sanityRateContract[0] != ISanityRate(0), "sanity rate is 0x0, burning is blocked");

        // get latest knc/eth rate from sanity contract
        uint256 kncToEthRate = sanityRateContract[0].latestAnswer();
        require(kncToEthRate > 0, "sanity rate is 0");
        require(kncToEthRate <= MAX_RATE, "sanity rate out of bounds");

        uint256 sanityEthToKncRate = PRECISION.mul(PRECISION).div(kncToEthRate);

        // rate shouldn't be SANITY_RATE_DIFF_BPS lower than sanity rate
        require(
            rateEthToKnc.mul(BPS) >= sanityEthToKncRate.mul(BPS.sub(SANITY_RATE_DIFF_BPS)),
            "kyberNetwork eth to knc rate too low"
        );
    }
}