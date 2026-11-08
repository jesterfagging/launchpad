import {CREATOR_FEE_POLICY,CREATOR_FEE_RATE_PPM,HOLDER_CREATOR_FEE_POLICY,creatorFeeForLaunch,effectiveCreatorFeeRate} from '../public/creator-fee-schedule.mjs';
import {protocolLiquiditySnapshot} from './launchpad-protocol-liquidity.mjs';

export const PROTOCOL_POLICY_VERSION=3;
export const protocolPolicyTarget=(launch={})=>{const fee=creatorFeeForLaunch(launch.input||launch);return {upgradeVersion:PROTOCOL_POLICY_VERSION,curveFeeBps:100,lpPolicy:'platform_locked',platformLpPercent:75,creatorFeePolicy:fee.policy,creatorFeeRatePpm:fee.ratePpm};};
export function validProtocolPolicyTarget(value,launch){
  if(!value||value.curveFeeBps!==100||value.lpPolicy!=='platform_locked'||value.platformLpPercent!==75)return false;
  // Already-authorized flat-fee upgrades retain their exact saved terms.
  if(value.upgradeVersion===2)return value.creatorFeePolicy===CREATOR_FEE_POLICY&&value.creatorFeeRatePpm===CREATOR_FEE_RATE_PPM;
  if(value.upgradeVersion!==PROTOCOL_POLICY_VERSION)return false;
  const fee=launch?creatorFeeForLaunch(launch.input||launch):null;
  return fee?value.creatorFeePolicy===fee.policy&&value.creatorFeeRatePpm===fee.ratePpm:(value.creatorFeePolicy===CREATOR_FEE_POLICY&&value.creatorFeeRatePpm===CREATOR_FEE_RATE_PPM)||(value.creatorFeePolicy===HOLDER_CREATOR_FEE_POLICY&&value.creatorFeeRatePpm===0);
}
export function currentProtocolPolicy(launch){
  try{
    const lp=protocolLiquiditySnapshot(launch.review?.protocolFees),fee=creatorFeeForLaunch(launch.input);
    return launch.review?.platformFeeBps===100&&lp.lpPolicy==='platform_locked'&&lp.platformLpPercent===75&&effectiveCreatorFeeRate(launch)===fee.ratePpm&&(launch.creatorFees?.policy||launch.review?.creatorFeePolicy)===fee.policy;
  }catch{return false;}
}
