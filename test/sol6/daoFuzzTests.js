const TestToken = artifacts.require('TestToken.sol')
const DAOContract = artifacts.require('MockKyberDaoMoreGetters.sol')
// using mock contract here, as we need to read the hasInited value
const KyberStaking = artifacts.require('KyberStaking.sol')

const Helper = require('../helper.js')
const {precisionUnits, zeroBN, zeroAddress, BPS} = require('../helper.js')
const BN = web3.utils.BN
const {expectRevert} = require('@openzeppelin/test-helpers')
const {DEPOSIT, DELEGATE, WITHDRAW, NO_ACTION} = require('../../scripts/simulator/stakingActionsGenerator.js')
const {
  CREATE_CAMPAIGN,
  CANCEL_CAMPAIGN,
  GET_REWARD,
  VOTE,
  CAMPAIGN_TYPE_GENERAL,
  CAMPAIGN_TYPE_NETWORK_FEE,
  CAMPAIGN_TYPE_FEE_BRR
} = require('../../scripts/simulator/daoActionsGenerator.js')

const DaoSimulator = require('../../scripts/simulator/simulator_dao.js')
const StakeGenerator = require('../../scripts/simulator/stakingActionsGenerator.js')
const DaoGenerator = require('../../scripts/simulator/daoActionsGenerator.js')

let kncToken
let tokenDecimals = new BN(18)
let admin
let daoSetter
let stakingContract
let feeHandler
let daoContract
let totalKNC
let currentBlockTime

const POWER_128 = new BN(2).pow(new BN(128))

//dao-related variable
let startTime
let epochPeriod = 500 // each iteration we add 10s -> each epoch is about 50 iterations
let minCampPeriod = 0
let latestNetworkFee = 25
let latestRewardBps = new BN(3000) // 30%
let latestRebateBps = new BN(2000) // 20%
let link = web3.utils.fromAscii('https://kyberswap.com')

let NUM_RUNS = 250
// let NUM_RUNS = 5000

// statistic about operation
// for operation, failing means the generated operation is revert
// for campaign, failing means the winning option is 0
let score = {
  deposit: {success: 0, fail: 0},
  delegate: {success: 0, fail: 0},
  withdraw: {success: 0, fail: 0},
  submitNewCampaign: {success: 0, fail: 0},
  cancelCampaign: {success: 0, fail: 0},
  vote: {success: 0, fail: 0},
  noAction: {success: 0, fail: 0},
  successCampaign: {success: 0, fail: 0}
}

contract('KyberDAO fuzz', function (accounts) {
  before('one time init: Stakers, KyberStaking, KNC token', async () => {
    admin = accounts[1]
    daoSetter = accounts[2]
    campCreator = accounts[3]
    stakers = accounts.slice(1) // first account used to mint KNC tokens
    kncToken = await TestToken.new('kyber Crystals', 'KNC', tokenDecimals)
    kncAddress = kncToken.address

    // prepare kyber staking
    firstBlockTimestamp = await Helper.getCurrentBlockTime()

    startTime = (await firstBlockTimestamp) + 10

    daoContract = await DAOContract.new(
      epochPeriod,
      startTime,
      kncToken.address,
      minCampPeriod,
      latestNetworkFee,
      latestRewardBps,
      latestRebateBps,
      campCreator
    )

    stakingContract = await KyberStaking.at(await daoContract.staking())
    // 10k KNC token
    let kncTweiDepositAmount = new BN(10000).mul(precisionUnits)
    let maxAllowance = new BN(2).pow(new BN(255))
    totalKNC = new BN(0)
    for (let i = 0; i < stakers.length; i++) {
      await kncToken.transfer(stakers[i], kncTweiDepositAmount)
      let expectedResult = await kncToken.balanceOf(stakers[i])
      Helper.assertEqual(expectedResult, kncTweiDepositAmount, 'staker did not receive tokens')
      await kncToken.approve(stakingContract.address, maxAllowance, {from: stakers[i]})
      expectedResult = await kncToken.allowance(stakers[i], stakingContract.address)
      Helper.assertEqual(expectedResult, maxAllowance, 'staker did not give sufficient allowance')
      totalKNC = totalKNC.add(kncTweiDepositAmount)
    }
    // burn the rest of knc, so the random campaign can be success
    await kncToken.burn(await kncToken.balanceOf(accounts[0]))

    Helper.assertEqual(totalKNC, await kncToken.totalSupply(), 'total token in account is not match with total suppy')
    //set time for the simulator
    DaoSimulator.setTime(startTime, epochPeriod)
  })

  it('fuzz testing', async () => {
    let currentEpoch = new BN(0)
    let loop
    for (loop = 0; loop < NUM_RUNS; loop++) {
      let currentBlockTime = (await Helper.getCurrentBlockTime()) + 10
      let nextEpoch = DaoGenerator.getEpochNumber(epochPeriod, startTime, currentBlockTime)
      if (!nextEpoch.eq(currentEpoch)) {
        await Helper.mineNewBlockAt(currentBlockTime)
        await checkWinningCampaign(daoContract, currentBlockTime, currentEpoch)
        await checkAllStakerReward(daoContract, stakingContract, stakers, currentEpoch, false)
        currentEpoch = nextEpoch
        if (currentEpoch.toNumber() % 5 == 0) printResult(loop)
        continue
      }

      let operation = DaoGenerator.genNextOp(loop, NUM_RUNS)
      switch (operation) {
        case DEPOSIT:
          await deposit(currentBlockTime, currentEpoch)
          break
        case DELEGATE:
          await delegate(currentBlockTime, currentEpoch)
          break
        case WITHDRAW:
          await withdraw(currentBlockTime, currentEpoch)
          break
        case CREATE_CAMPAIGN:
          await submitNewCampaign(currentBlockTime, currentEpoch)
          break
        case CANCEL_CAMPAIGN:
          await cancelCampaign(currentBlockTime, currentEpoch)
          break
        case VOTE:
          await vote(currentBlockTime, currentEpoch)
          break
        case GET_REWARD:
          await checkAllStakerReward(daoContract, stakingContract, stakers, currentEpoch, true)
          break
        case NO_ACTION:
          console.log('do nothing for this epoch...')
          // Advance time by a bit
          await Helper.mineNewBlockAt(currentBlockTime)
          score.noAction = incrementScoreCount(true, score.noAction)
          break
        default:
          console.log('unexpected operation: ' + operation)
          break
      }
    }
    printResult(loop)
  })

  function printResult (loop) {
    console.log(`${Helper.Color.FgRed}%s${Helper.Color.Reset}`, `--- FUZZ RESULTS ---`)
    console.log(`Operation: ${loop}`)
    console.log(`Do nothing: ${score.noAction.success}`)
    console.log(`Deposit: success = ${score.deposit.success}, fails = ${score.deposit.fail}`)
    console.log(`Delegate: success = ${score.delegate.success}, fails = ${score.delegate.fail}`)
    console.log(`Withdrawals: success = ${score.withdraw.success}, fails = ${score.withdraw.fail}`)
    console.log(
      `SubmitNewCampaign: success = ${score.submitNewCampaign.success}, fails = ${score.submitNewCampaign.fail}`
    )
    console.log(`CancelCampaign: success = ${score.cancelCampaign.success}, fails = ${score.cancelCampaign.fail}`)
    console.log(`Vote: success = ${score.vote.success}, fails = ${score.vote.fail}`)
    console.log(
      `Campaign has winning option: success = ${score.successCampaign.success}, fails = ${score.successCampaign.fail}`
    )
    console.log(`${Helper.Color.FgRed}%s${Helper.Color.Reset}`, `--------------------`)
  }

  async function deposit (currentBlockTime, epoch) {
    result = await StakeGenerator.genDeposit(kncToken, stakers)
    result.delegatedAddress = await stakingContract.getLatestRepresentative(result.staker)
    console.log(result.msg)
    console.log(`Deposit: staker ${result.staker}, amount: ${result.amount}`)
    await Helper.setNextBlockTimestamp(currentBlockTime)

    // do deposit
    if (result.isValid) {
      await stakingContract.deposit(result.amount, {from: result.staker})
      // check that deposit does not affect dao data
      await assertEqualEpochVoteData(daoContract, epoch)
    } else {
      await expectRevert.unspecified(stakingContract.deposit(result.amount, {from: result.staker}))
    }
    score.deposit = incrementScoreCount(result.isValid, score.deposit)
  }

  async function delegate (currentBlockTime, epoch) {
    result = await StakeGenerator.genDelegate(stakers)
    console.log(result.msg)
    console.log(`Delegate: staker ${result.staker}, address: ${result.dAddress}`)

    await Helper.setNextBlockTimestamp(currentBlockTime)
    await stakingContract.delegate(result.dAddress, {from: result.staker})
    // check that delegate does not affect dao data
    await assertEqualEpochVoteData(daoContract, epoch)
    score.delegate = incrementScoreCount(true, score.delegate)
  }

  async function withdraw (currentBlockTime, epoch) {
    result = await StakeGenerator.genWithdraw(stakingContract, stakers)
    result.delegatedAddress = await stakingContract.getLatestRepresentative(result.staker)
    console.log(result.msg)
    console.log(`Withdrawal: staker ${result.staker}, amount: ${result.amount}`)
    await Helper.setNextBlockTimestamp(currentBlockTime)
    if (result.isValid) {
      let beforeStake = await stakingContract.getStake(result.staker, epoch)
      await stakingContract.withdraw(result.amount, {from: result.staker})
      let afterState = await stakingContract.getStake(result.staker, epoch)
      // if the withdraw only change the stage for the next epoch, not the current one,
      // the vote data will be unchanged
      if (afterState.lt(beforeStake)) {
        console.log('after stake for current epoch is smaller than before stake, handle withdrawal')
        representative = await stakingContract.getRepresentative(result.staker, epoch)
        DaoSimulator.handlewithdraw(representative, beforeStake.sub(afterState), epoch, currentBlockTime)
      }
      // assert campaignVoteData match for both cases: handle withdraw or not
      await assertEqualEpochVoteData(daoContract, epoch)
    } else {
      await expectRevert.unspecified(stakingContract.withdraw(result.amount, {from: result.staker}))
    }
    score.withdraw = incrementScoreCount(result.isValid, score.withdraw)
  }

  async function submitNewCampaign (currentBlockTime, epoch) {
    let result = await DaoGenerator.genSubmitNewCampaign(daoContract, epochPeriod, startTime, currentBlockTime, epoch)
    if (result == undefined) return
    await Helper.setNextBlockTimestamp(currentBlockTime)
    console.log(`submit new campaign: ${result.msg}`)
    if (result.isValid) {
      await daoContract.submitNewCampaign(
        result.campaignType,
        result.startTimestamp,
        result.endTimestamp,
        result.minPercentageInPrecision,
        result.cInPrecision,
        result.tInPrecision,
        result.options,
        link,
        {from: campCreator}
      )

      DaoSimulator.submitCampaign(
        result.campaignType,
        result.startTimestamp,
        result.endTimestamp,
        result.minPercentageInPrecision,
        result.cInPrecision,
        result.tInPrecision,
        result.options,
        totalKNC
      )
    } else {
      await expectRevert(
        daoContract.submitNewCampaign(
          result.campaignType,
          result.startTimestamp,
          result.endTimestamp,
          result.minPercentageInPrecision,
          result.cInPrecision,
          result.tInPrecision,
          result.options,
          link,
          {from: campCreator}
        ),
        result.msg
      )
    }
    score.submitNewCampaign = incrementScoreCount(result.isValid, score.submitNewCampaign)
  }

  async function cancelCampaign (currentBlockTime, epoch) {
    result = await DaoGenerator.genCancelCampaign(daoContract, currentBlockTime, epoch)
    if (result == undefined) return
    console.log(`cancel new campaign: ${result.msg}`)
    await Helper.setNextBlockTimestamp(currentBlockTime)
    if (result.isValid) {
      await daoContract.cancelCampaign(result.campaignID, {from: campCreator})
      DaoSimulator.cancelCampaign(result.campaignID)
    } else {
      await expectRevert(daoContract.cancelCampaign(result.campaignID, {from: campCreator}), result.msg)
    }
    score.cancelCampaign = incrementScoreCount(result.isValid, score.cancelCampaign)
  }

  async function vote (currentBlockTime, epoch) {
    result = await DaoGenerator.genVote(daoContract, currentBlockTime, epoch, stakers)
    if (result == undefined) {
      // if no campaign to vote then submit one in this iteration
      await submitNewCampaign(currentBlockTime, epoch)
      return
    }
    console.log(`vote: ${result.msg}`)
    await Helper.setNextBlockTimestamp(currentBlockTime)
    if (result.isValid) {
      await daoContract.vote(result.campaignID, result.option, {from: result.staker})
      let stakerData = await stakingContract.getStakerData(result.staker, epoch)
      let totalStake =
        stakerData.representative == result.staker
          ? stakerData.stake.add(stakerData.delegatedStake)
          : stakerData.delegatedStake
      DaoSimulator.vote(result.campaignID, result.option, result.staker, totalStake, epoch)
      await assertEqualCampaignVoteData(daoContract, result.campaignID)
    } else {
      await expectRevert(daoContract.vote(result.campaignID, result.option, {from: campCreator}), result.msg)
    }
    score.vote = incrementScoreCount(result.isValid, score.vote)
  }

  async function checkWinningCampaign (daoContract, currentBlockTime, epoch) {
    let campaignIDs = await daoContract.getListCampaignIDs(epoch)
    if (campaignIDs.length == 0) {
      console.log(`${Helper.Color.FgCyan}%s${Helper.Color.Reset}`, 'No campaign to checkWinningCampaign')
      return
    }
    console.log(`${Helper.Color.FgCyan}%s${Helper.Color.Reset}`, 'CheckWinningCampaign')
    for (const campaignID of campaignIDs) {
      let data = await daoContract.getCampaignWinningOptionAndValue(campaignID)
      let [expectedOptionID, expectedValue, campaignType] = DaoSimulator.getCampaignWinningOptionAndValue(campaignID)
      console.log(`campaign ID=${campaignID} optionID=${expectedOptionID} value=${expectedValue}`)
      Helper.assertEqual(data.optionID, expectedOptionID, 'unexpected option ID')
      Helper.assertEqual(data.value, expectedValue, 'unexpected option ID')

      if (campaignType == CAMPAIGN_TYPE_NETWORK_FEE) {
        let actualNetworkFeeBps = await daoContract.getLatestNetworkFeeData()
        if (expectedOptionID.eq(new BN(0))) {
          Helper.assertEqual(latestNetworkFee, actualNetworkFeeBps.feeInBps, 'unexpected network fee')
        } else {
          Helper.assertEqual(expectedValue, actualNetworkFeeBps.feeInBps, 'unexpected network fee')
          // pull network fee to cache
          // Otherwise if the next epoch has no winning campaign, the change will not be recorded
          await daoContract.getLatestNetworkFeeDataWithCache()
          latestNetworkFee = expectedValue
          console.log(
            `${Helper.Color.FgCyan}%s${Helper.Color.Reset}`,
            `change network fee to ${actualNetworkFeeBps.feeInBps}`
          )
        }
      }

      if (campaignType == CAMPAIGN_TYPE_FEE_BRR) {
        let actualBrrData = await daoContract.getLatestBRRData()
        if (expectedOptionID.eq(new BN(0))) {
          Helper.assertEqual(latestRewardBps, actualBrrData.rewardInBps, 'unexpected rewardInBps')
          Helper.assertEqual(latestRebateBps, actualBrrData.rebateInBps, 'unexpected rebateInBps')
          Helper.assertEqual(
            BPS.sub(latestRewardBps).sub(latestRebateBps),
            actualBrrData.burnInBps,
            'unexpected burnInBps'
          )
        } else {
          let newRebateBps = expectedValue.div(POWER_128)
          let newRewardBps = expectedValue.sub(expectedValue.div(POWER_128).mul(POWER_128))
          Helper.assertEqual(newRewardBps, actualBrrData.rewardInBps, 'unexpected rewardInBps')
          Helper.assertEqual(newRebateBps, actualBrrData.rebateInBps, 'unexpected rebateInBps')
          Helper.assertEqual(BPS.sub(newRewardBps).sub(newRebateBps), actualBrrData.burnInBps, 'unexpected burnInBps')
          //pull brr data to cache
          // Otherwise if the next epoch has no winning campaign, the change will not be recorded
          await daoContract.getLatestBRRDataWithCache()
          latestRewardBps = newRewardBps
          latestRebateBps = newRebateBps
          console.log(
            `${Helper.Color.FgCyan}%s${Helper.Color.Reset}`,
            `change brr data to rewardBps=${newRewardBps} rebateBps=${newRebateBps}`
          )
        }
      }
      score.successCampaign = incrementScoreCount(!data.optionID.eq(new BN(0)), score.successCampaign)
    }
  }

  async function checkAllStakerReward (daoContract, stakingContract, stakers, epoch, isCurrentOrPastEpoch) {
    let totalPoint = new BN(0)
    let actualTotalPoint = await daoContract.getTotalEpochPoints(epoch)
    let simulatedTotalPoint = DaoSimulator.getTotalEpochPoints(epoch)
    Helper.assertEqual(actualTotalPoint, simulatedTotalPoint, 'unexpected total points')
    for (let i = 0; i < stakers.length; i++) {
      staker = stakers[i]
      if (isCurrentOrPastEpoch) {
        rewardPercentage = await daoContract.getCurrentEpochRewardPercentageInPrecision(staker)
      } else {
        rewardPercentage = await daoContract.getPastEpochRewardPercentageInPrecision(staker, epoch)
      }
      let numVotes = DaoSimulator.getStakerVoteCount(staker, epoch)

      if (numVotes.eq(zeroBN)) {
        Helper.assertEqual(rewardPercentage, zeroBN, 'rewardPercentage should be zero')
        continue
      }
      // here we use getStakerData instead of getStakerRawData to avoid data is not init
      stakerData = await stakingContract.getStakerData(staker, epoch)
      let totalStake =
        stakerData.representative == staker
          ? stakerData.stake.add(stakerData.delegatedStake)
          : stakerData.delegatedStake
      totalPoint = totalPoint.add(numVotes.mul(totalStake))
      if (totalPoint.eq(zeroBN)) {
        Helper.assertEqual(rewardPercentage, zeroBN, 'rewardPercentage should be zero')
        continue
      }
      let expectedRewardPercentage = numVotes
        .mul(totalStake)
        .mul(precisionUnits)
        .div(new BN(actualTotalPoint))
      Helper.assertEqual(rewardPercentage, expectedRewardPercentage, 'unexpected reward percentage')
    }
    Helper.assertEqual(totalPoint, simulatedTotalPoint, 'total point from each staker should match')
  }
})

async function assertEqualEpochVoteData (daoContract, epoch) {
  let campaignIDs = await daoContract.getListCampaignIDs(epoch)
  for (const campaignID of campaignIDs) {
    await assertEqualCampaignVoteData(daoContract, campaignID)
  }

  let totalEpochPoint = await daoContract.getTotalEpochPoints(epoch)
  Helper.assertEqual(totalEpochPoint, DaoSimulator.totalEpochPoints[epoch], 'unmatch total epoch point')
}

async function assertEqualCampaignVoteData (daoContract, campaignID) {
  let campaignVoteData = await daoContract.getCampaignVoteCountData(campaignID)
  assert(campaignID in DaoSimulator.campaignData, 'campaign ID not exist in simulator data')
  let simulateVoteData = DaoSimulator.campaignData[campaignID].campaignVoteData

  Helper.assertEqual(campaignVoteData.totalVoteCount, simulateVoteData.totalVotes, 'unexpected total votes')
  Helper.assertEqualArray(campaignVoteData.voteCounts, simulateVoteData.votePerOption, 'unexpected votePerOption')
}

function incrementScoreCount (isValid, score) {
  if (isValid) {
    score.success += 1
  } else {
    score.fail += 1
  }
  return score
}
