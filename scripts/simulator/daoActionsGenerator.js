const BN = web3.utils.BN
const {zeroBN, zeroAddress} = require('../../test/helper.js')
const Helper = require('../../test/helper.js')

const {DEPOSIT, DELEGATE, WITHDRAW, NO_ACTION} = require('./stakingActionsGenerator.js')
const {BASE, genRandomBN, genRandomSeed} = require('./generatorHelper.js')

const CREATE_CAMPAIGN = 'submit_new_campaign'
const CANCEL_CAMPAIGN = 'cancel_campaign'
const VOTE = 'vote'
const CLAIM_REWARD = 'claim_reward'

const CAMPAIGN_TYPE_GENERAL = 0
const CAMPAIGN_TYPE_NETWORK_FEE = 1
const CAMPAIGN_TYPE_FEE_BRR = 2

const precision = new BN(10).pow(new BN(18))
const MAX_EPOCH_CAMPAIGNS = 10

const POWER_128 = new BN(2).pow(new BN(128))
const BRR_OPTIONS = [new BN(2000), new BN(3000).mul(POWER_128), new BN(3000).mul(POWER_128).add(new BN(2000))]

module.exports = {CREATE_CAMPAIGN, CANCEL_CAMPAIGN, VOTE, CLAIM_REWARD, CAMPAIGN_TYPE_GENERAL, CAMPAIGN_TYPE_NETWORK_FEE, CAMPAIGN_TYPE_FEE_BRR}

module.exports.genNextOp = function genNextOp (loop, numRuns) {
  let rand = genRandomSeed(7, BASE)
  let depositWeight
  let withdrawWeight
  let delegateWeight
  // weighted operations
  // at the start, should have more deposits, then taper off
  let startRatio = loop / numRuns
  if (startRatio < 0.003) {
    depositWeight = 70
    withdrawWeight = 75
    delegateWeight = 90
    createCampaignWeight = 100
    cancelCampaignWeight = 100
    voteWeight = 100
    claimReward = 100
  } else {
    depositWeight = 10
    withdrawWeight = 20
    delegateWeight = 30
    createCampaignWeight = 40
    cancelCampaignWeight = 45
    voteWeight = 90
    claimReward = 95
  }

  if (rand < depositWeight) return DEPOSIT
  if (rand < withdrawWeight) return WITHDRAW
  if (rand < delegateWeight) return DELEGATE
  if (rand < createCampaignWeight) return CREATE_CAMPAIGN
  if (rand < cancelCampaignWeight) return CANCEL_CAMPAIGN
  if (rand < voteWeight) return VOTE
  if (rand < claimReward) return CLAIM_REWARD

  return NO_ACTION
}

// random - campaignType, start-time, minPercentageInPrecision, cInPrecision
// not random - start-end epoch, campaign period, epoch-option, tInPrecision, options

module.exports.genSubmitNewCampaign = async (daoContract, epochPeriod, startTime, currentBlockTime, epoch) => {
  rand = genRandomSeed(32, 100)
  // let currentBlockTime = (await Helper.getCurrentBlockTime()) + 10
  // let epoch = getEpochNumber(epochPeriod, startTime, currentBlockTime)
  let startTimestamp = genRandomBN(new BN(currentBlockTime), new BN(startTime + epochPeriod * epoch + epochPeriod / 2))

  let startEpoch = getEpochNumber(epochPeriod, startTime, startTimestamp)
  let listCampaignIDs = await daoContract.getListCampaignIDs(startEpoch)
  if (listCampaignIDs.length == MAX_EPOCH_CAMPAIGNS) {
    console.log('number campaign is max, skipping submitNewCampaign')
    return undefined
  }

  if (rand >= 97) {
    return {
      campaignType: CAMPAIGN_TYPE_GENERAL,
      startTimestamp: currentBlockTime - 1,
      endTimestamp: currentBlockTime - 1,
      minPercentageInPrecision: precision,
      cInPrecision: precision,
      tInPrecision: precision,
      options: [new BN(1), new BN(2)],
      isValid: false,
      msg: "validateParams: can't start in the past"
    }
  }

  let endTimestamp = startTimestamp.add(new BN(epochPeriod / 2))
  let endEpoch = getEpochNumber(epochPeriod, startTime, endTimestamp)
  let result = {
    campaignType: CAMPAIGN_TYPE_GENERAL,
    startTimestamp: startTimestamp,
    endTimestamp: startTimestamp.add(new BN(epochPeriod / 2)),
    minPercentageInPrecision: precision,
    cInPrecision: precision,
    tInPrecision: precision,
    options: [new BN(1), new BN(2)],
    isValid: true,
    msg: 'create general campaign at epoch ' + startEpoch
  }
  if (!startEpoch.eq(endEpoch)) {
    result.isValid = false
    result.msg = 'validateParams: start & end not same epoch'
    return result
  }
  // minPercentageInPrecision is random (0, precision/5)
  result.minPercentageInPrecision = genRandomBN(new BN(0), precision.div(new BN(5)))
  result.cInPrecision = genRandomBN(result.minPercentageInPrecision, precision.div(new BN(2)))
  result.tInPrecision = precision
  if (rand < 33) {
    result.campaignType = CAMPAIGN_TYPE_NETWORK_FEE
    result.options = [new BN(0), new BN(200), new BN(4999)]
    campID = await daoContract.networkFeeCampaigns(startEpoch)
    if (!new BN(campID).eq(new BN(0))) {
      console.log('already have campID ' + campID + ' for epoch' + startEpoch)
      result.isValid = false
      result.msg = 'validateParams: already had network fee campaign for this epoch'
    } else {
      result.msg = 'create network fee campaign at epoch ' + startEpoch
    }
  } else if (rand < 66) {
    result.campaignType = CAMPAIGN_TYPE_FEE_BRR
    result.options = BRR_OPTIONS
    campID = await daoContract.brrCampaigns(startEpoch)
    if (!new BN(campID).eq(new BN(0))) {
      console.log('already have campID ' + campID + ' for epoch' + startEpoch)
      result.isValid = false
      result.msg = 'validateParams: already had brr campaign for this epoch'
    } else {
      result.msg = 'create new brr campaign at epoch ' + startEpoch
    }
  }

  return result
}

module.exports.getEpochNumber = getEpochNumber
function getEpochNumber (epochPeriod, startTime, timestamp) {
  if (new BN(timestamp).lt(new BN(startTime))) return new BN(0)
  return new BN(timestamp)
    .sub(new BN(startTime))
    .div(new BN(epochPeriod))
    .add(new BN(1))
}

// random select a campaignID from current epoch
module.exports.genCancelCampaign = async (daoContract, currentBlockTime, epoch) => {
  let campaigns = await daoContract.getListCampaignIDs(epoch)
  if (campaigns.length == 0) {
    console.log(`there is no campain in epoch ${epoch} to cancel`)
    return undefined
  }
  let campaignID = campaigns[genRandomSeed(32, campaigns.length)]
  let campaignDetails = await daoContract.getCampaignDetails(campaignID)
  if (campaignDetails.startTimestamp <= currentBlockTime) {
    return {
      blockTime: currentBlockTime,
      isValid: false,
      msg: 'cancelCampaign: campaign already started',
      campaignID
    }
  }

  return {
    blockTime: currentBlockTime,
    isValid: true,
    msg: `cancel Campaign ${campaignID} in epoch ${epoch}`,
    campaignID
  }
}

// random select a campaign ID from this epoch and select random option
module.exports.genVote = async (daoContract, currentBlockTime, epoch, stakers) => {
  let campaigns = await daoContract.getListCampaignIDs(epoch)
  if (campaigns.length == 0) {
    console.log(`there is no campain in epoch ${epoch} to vote`)
    return undefined
  }
  let campaignID = campaigns[genRandomSeed(32, campaigns.length)]
  let campaignDetails = await daoContract.getCampaignDetails(campaignID)

  let staker = stakers[genRandomSeed(32, stakers.length)]

  let option = genRandomSeed(32, campaignDetails.options.length)
  let result = {
    staker,
    campaignID,
    option: new BN(option + 1),
    isValid: true,
    msg: ''
  }
  if (campaignDetails.startTimestamp > currentBlockTime) {
    result.isValid = false
    result.msg = 'vote: campaign not started'
    return result
  }

  if (campaignDetails.endTimestamp < currentBlockTime) {
    result.isValid = false
    result.msg = 'vote: campaign already ended'
    return result
  }

  result.msg = `success campaignID=${campaignID} option=${option + 1}`
  return result
}
