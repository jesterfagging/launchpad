//! Finite DAMM v2 range -> PumpSwap. Controller PDA owns every redeemable
//! position and launch reserve. There is deliberately no rescue/EOA withdrawal.
use super::*;
use super::damm_math::{geometry,Geometry,graduation_fee};
const DAMM:Pubkey=pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const DAMM_AUTH:Pubkey=pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
const DMAGIC:&[u8;8]=b"CRVDAMM1";
const DLEN:usize=512;
const POOL_DISC:[u8;8]=[241,154,109,4,17,177,109,188];
const POSITION_DISC:[u8;8]=[170,188,143,228,122,64,247,208];
const FEE_NUMERATOR:u64=12_500_000; // 125 bps gross, quote-only, no compounding.
fn u128at(d:&[u8],o:usize)->Result<u128,ProgramError>{Ok(u128::from_le_bytes(d.get(o..o+16).ok_or(err(Error::State))?.try_into().unwrap()))}
#[derive(Clone,Debug)]
struct DState{phase:u8,bump:u8,decimals:u8,creator:Pubkey,base:Pubkey,quote:Pubkey,quote_program:Pubkey,pool:Pubkey,position:Pubkey,nft:Pubkey,nft_account:Pubkey,g:Geometry,price:u64,created:u64,rent_floor:u64,pump:Pubkey,burned:u64,migrated_quote:u64,migrated_base:u64,fees:u64,index:u16,graduation_fee_paid:u64}
impl DState{
 fn load(p:&Pubkey,a:&AccountInfo)->Result<Self,ProgramError>{need(a.owner==p,Error::State)?;let d=a.try_borrow_data()?;need(d.len()==DLEN&&&d[..8]==DMAGIC&&(d[8]==0||d[8]==2),Error::State)?;let base=keyat(&d,48)?;need(*a.key==Pubkey::find_program_address(&[b"damm",base.as_ref()],p).0,Error::Accounts)?;
  Ok(Self{phase:d[8],bump:d[9],decimals:d[10],creator:keyat(&d,16)?,base,quote:keyat(&d,80)?,quote_program:keyat(&d,112)?,pool:keyat(&d,144)?,position:keyat(&d,176)?,nft:keyat(&d,208)?,nft_account:keyat(&d,240)?,g:Geometry{min:u128at(&d,272)?,max:u128at(&d,288)?,liquidity:u128at(&d,304)?,sale:u64at(&d,320)?,reserve:u64at(&d,328)?,quote:u64at(&d,336)?},price:u64at(&d,344)?,created:u64at(&d,352)?,rent_floor:u64at(&d,360)?,pump:keyat(&d,368)?,burned:u64at(&d,400)?,migrated_quote:u64at(&d,408)?,migrated_base:u64at(&d,416)?,fees:u64at(&d,424)?,index:u16::from_le_bytes(d[432..434].try_into().unwrap()),graduation_fee_paid:u64at(&d,440)?})
 }
 fn save(&self,a:&AccountInfo)->ProgramResult{let mut d=a.try_borrow_mut_data()?;need(d.len()==DLEN,Error::State)?;d.fill(0);d[..8].copy_from_slice(DMAGIC);d[8]=self.phase;d[9]=self.bump;d[10]=self.decimals;
  for(o,k)in[(16,self.creator),(48,self.base),(80,self.quote),(112,self.quote_program),(144,self.pool),(176,self.position),(208,self.nft),(240,self.nft_account),(368,self.pump)]{d[o..o+32].copy_from_slice(k.as_ref());}
  for(o,v)in[(272,self.g.min),(288,self.g.max),(304,self.g.liquidity)]{d[o..o+16].copy_from_slice(&v.to_le_bytes());}
  for(o,v)in[(320,self.g.sale),(328,self.g.reserve),(336,self.g.quote),(344,self.price),(352,self.created),(360,self.rent_floor),(400,self.burned),(408,self.migrated_quote),(416,self.migrated_base),(424,self.fees),(440,self.graduation_fee_paid)]{d[o..o+8].copy_from_slice(&v.to_le_bytes());}d[432..434].copy_from_slice(&self.index.to_le_bytes());Ok(())
 }
}
fn dkey(seeds:&[&[u8]])->Pubkey{Pubkey::find_program_address(seeds,&DAMM).0}
fn pool_key(base:&Pubkey,quote:&Pubkey)->Pubkey{let(a,b)=if base.to_bytes()>quote.to_bytes(){(base,quote)}else{(quote,base)};dkey(&[b"cpool",a.as_ref(),b.as_ref()])}
fn badge(a:&AccountInfo,m:&Pubkey)->ProgramResult{need(*a.key==dkey(&[b"token_badge",m.as_ref()]),Error::Accounts)?;if a.data_is_empty(){return system_wallet(a);}need(a.owner==&DAMM,Error::Accounts)?;let d=a.try_borrow_data()?;need(d.len()==168&&d[..8]==[116,219,204,229,249,116,255,150]&&keyat(&d,8)?==*m,Error::Mint)}
fn quote_mint(m:&AccountInfo,t:&AccountInfo,decimals:u8)->ProgramResult{
 need(*t.key==TOKEN||*t.key==TOKEN22,Error::Mint)?;program(t,t.key)?;need(m.owner==t.key&&decimals<=18,Error::Mint)?;let d=m.try_borrow_data()?;need(d.len()>=82&&d[44]==decimals&&d[45]==1,Error::Mint)?;
 if *t.key==TOKEN{return need(d.len()==82,Error::Mint);}
 if d.len()==82{return Ok(());}need(d.len()>=166&&d[165]==1,Error::Mint)?;
 let mut o=166;while o<d.len(){if d[o..].iter().all(|x|*x==0){break;}need(o+4<=d.len(),Error::Mint)?;let ty=u16::from_le_bytes(d[o..o+2].try_into().unwrap());let size=u16::from_le_bytes(d[o+2..o+4].try_into().unwrap())as usize;o+=4;let e=d.get(o..o+size).ok_or(err(Error::Mint))?;
  // The migration venue must support every admitted quote. Only ordinary
  // Token-2022 mints and metadata extensions have passed PumpSwap creation
  // simulation. A DAMM badge cannot make an unsupported Pump quote compatible.
  match ty{
   18=>need(size==64,Error::Mint)?,
   19=>need(size>=80&&keyat(e,32)?==*m.key,Error::Mint)?,
   _=>return Err(err(Error::Policy)),
  }o=o.checked_add(size).ok_or(err(Error::Math))?;
 }Ok(())
}
fn transfer_quote_seed<'a>(t:&AccountInfo<'a>,from:&AccountInfo<'a>,m:&AccountInfo<'a>,to:&AccountInfo<'a>,payer:&AccountInfo<'a>,decimals:u8)->ProgramResult{
 need(*from.key==ata(payer.key,m.key,t.key),Error::Accounts)?;need(token_account(from,m.key,payer.key,t.key)?>=1,Error::Insolvent)?;
 let mut data=vec![12];data.extend_from_slice(&1u64.to_le_bytes());data.push(decimals);
 invoke(&Instruction{program_id:*t.key,accounts:vec![AccountMeta::new(*from.key,false),AccountMeta::new_readonly(*m.key,false),AccountMeta::new(*to.key,false),AccountMeta::new_readonly(*payer.key,true)],data},&[from.clone(),m.clone(),to.clone(),payer.clone(),t.clone()])
}
fn fixed_accounts(p:&Pubkey,s:&DState,auth:&AccountInfo,base:&AccountInfo,ba:&AccountInfo,quote:&AccountInfo,qt:&AccountInfo)->ProgramResult{
 let(k,b)=Pubkey::find_program_address(&[b"damm-vault",s.base.as_ref()],p);need(*auth.key==k&&b==s.bump&&*base.key==s.base&&*quote.key==s.quote&&*qt.key==s.quote_program&&*ba.key==ata(&k,&s.base,&TOKEN),Error::Accounts)?;system_wallet(auth)?;quote_mint(quote,qt,s.decimals)?;
 let supply=u64at(&base.try_borrow_data()?,36)?;need(supply<=SUPPLY,Error::Mint)?;mint(base,None,supply)?;token_account(ba,base.key,auth.key,&TOKEN)?;Ok(())
}
fn venue(s:&DState,auth:&AccountInfo,prg:&AccountInfo,authority:&AccountInfo,pool:&AccountInfo,pos:&AccountInfo,nft:&AccountInfo,na:&AccountInfo,av:&AccountInfo,bv:&AccountInfo,event:&AccountInfo)->ProgramResult{
 program(prg,&DAMM)?;need(*authority.key==DAMM_AUTH&&*pool.key==s.pool&&pool.owner==&DAMM&&*pool.key==pool_key(&s.base,&s.quote)&&*pos.key==s.position&&pos.owner==&DAMM&&*pos.key==dkey(&[b"position",s.nft.as_ref()])&&*nft.key==s.nft&&*na.key==s.nft_account&&*na.key==dkey(&[b"position_nft_account",s.nft.as_ref()])&&*av.key==dkey(&[b"token_vault",s.base.as_ref(),pool.key.as_ref()])&&*bv.key==dkey(&[b"token_vault",s.quote.as_ref(),pool.key.as_ref()])&&*event.key==dkey(&[b"__event_authority"]),Error::Accounts)?;
 need(token_account(na,&s.nft,auth.key,&TOKEN22)?==1,Error::Unauthorized)?;
 token_account(av,&s.base,&DAMM_AUTH,&TOKEN)?;token_account(bv,&s.quote,&DAMM_AUTH,&s.quote_program)?;
 let d=pool.try_borrow_data()?;need(d.len()>=1112&&d[..8]==POOL_DISC&&keyat(&d,168)?==s.base&&keyat(&d,200)?==s.quote&&keyat(&d,232)?==*av.key&&keyat(&d,264)?==*bv.key&&keyat(&d,648)?==*auth.key&&u128at(&d,424)?==s.g.min&&u128at(&d,440)?==s.g.max&&d[484]==1&&d[696]==1,Error::State)?;
 need(u64at(&d,8)?==FEE_NUMERATOR&&d[16]==0&&d[22..24]==[0;2]&&u64at(&d,24)?==0&&u64at(&d,32)?==0&&d[54..56]==[0;2]&&d[56]==0,Error::Policy)?;
 let pd=pos.try_borrow_data()?;need(pd.len()>=408&&pd[..8]==POSITION_DISC&&keyat(&pd,8)?==s.pool&&keyat(&pd,40)?==s.nft&&u128at(&pd,168)?==0&&u128at(&pd,184)?==0&&pd[392..396]==[0;4],Error::State)?;
 need(u128at(&pd,152)?==if s.phase==2{0}else{s.g.liquidity},Error::State)
}
// Opcode 6: see the JS client for the immutable 26-account / 89-byte ABI.
pub(super) fn initialize(p:&Pubkey,a:&[AccountInfo],d:&[u8])->ProgramResult{
 need(a.len()==26&&d.len()==89,Error::Accounts)?;
 let[payer,state,auth,base,ba,quote,qa,config,relayer,sys,tok,tok22,qt,associated,damm,da,pool,pos,nft,na,av,bv,event,ab,bb,payer_quote]=<&[AccountInfo;26]>::try_from(a).unwrap();
 program(sys,&system_program::id())?;program(tok,&TOKEN)?;program(tok22,&TOKEN22)?;program(associated,&ATA)?;program(damm,&DAMM)?;system_wallet(payer)?;system_wallet(auth)?;
 // Admin-only launch is enforced by the executable, independently of the web API.
 need(*payer.key==ADMIN&&payer.is_signer,Error::Unauthorized)?;
 let(relay,enabled)=configuration(p,config)?;need(enabled&&relayer.is_signer&&*relayer.key==relay&&payer.is_signer,Error::Unauthorized)?;
 let price=u64at(d,0)?;let expiry=u64at(d,8)?;let decimals=d[16];let now=u64::try_from(Clock::get()?.unix_timestamp).map_err(|_|err(Error::Policy))?;
 need(expiry>=now&&expiry<=add(now,300)?,Error::Policy)?;quote_mint(quote,qt,decimals)?;need(base.key!=quote.key,Error::Policy)?;
 let g=geometry(price,decimals)?;
 need(u128at(d,17)?==g.min&&u128at(d,33)?==g.max&&u128at(d,49)?==g.liquidity&&u64at(d,65)?==g.sale&&u64at(d,73)?==g.reserve&&u64at(d,81)?==g.quote,Error::Policy)?;
 let(sk,sb)=Pubkey::find_program_address(&[b"damm",base.key.as_ref()],p);let(ak,vb)=Pubkey::find_program_address(&[b"damm-vault",base.key.as_ref()],p);let(nk,nb)=Pubkey::find_program_address(&[b"damm-nft",base.key.as_ref()],p);
 need(*state.key==sk&&*auth.key==ak&&*nft.key==nk&&*pool.key==pool_key(base.key,quote.key)&&*da.key==DAMM_AUTH&&*pos.key==dkey(&[b"position",nft.key.as_ref()])&&*na.key==dkey(&[b"position_nft_account",nft.key.as_ref()])&&*av.key==dkey(&[b"token_vault",base.key.as_ref(),pool.key.as_ref()])&&*bv.key==dkey(&[b"token_vault",quote.key.as_ref(),pool.key.as_ref()])&&*event.key==dkey(&[b"__event_authority"]),Error::Accounts)?;
 for account in [state,pool,pos,nft,na,av,bv]{system_wallet(account)?;}
 badge(ab,base.key)?;badge(bb,quote.key)?;mint(base,Some(auth.key),0)?;
 let rent=Rent::get()?;xfer_sol(payer,state,sys,rent.minimum_balance(DLEN).saturating_sub(state.lamports()),&[])?;
 let ss:&[&[u8]]=&[b"damm",base.key.as_ref(),&[sb]];
 invoke_signed(&system_instruction::allocate(state.key,DLEN as u64),&[state.clone(),sys.clone()],&[ss])?;
 invoke_signed(&system_instruction::assign(state.key,p),&[state.clone(),sys.clone()],&[ss])?;
 // Temporary setup ceiling is refunded atomically after initialization. Only the
 // explicitly declared migration rent subsidy remains, never quote principal.
 let floor=rent.minimum_balance(0);
 xfer_sol(payer,auth,sys,add(100_000_000,floor)?.saturating_sub(auth.lamports()),&[])?;
 create_ata(payer,ba,auth,base,sys,tok,associated,&[])?;create_ata(payer,qa,auth,quote,sys,qt,associated,&[])?;
 need(token_account(ba,base.key,auth.key,&TOKEN)?==0,Error::State)?;
 token_account(qa,quote.key,auth.key,qt.key)?;
 let vs:&[&[u8]]=&[b"damm-vault",base.key.as_ref(),&[vb]];let ns:&[&[u8]]=&[b"damm-nft",base.key.as_ref(),&[nb]];
 token_ix(tok,7,SUPPLY,&[base.clone(),ba.clone(),auth.clone()],vs)?;
 invoke_signed(&Instruction{program_id:TOKEN,accounts:vec![AccountMeta::new(*base.key,false),AccountMeta::new_readonly(*auth.key,true)],data:vec![6,0,0]},&[base.clone(),auth.clone(),tok.clone()],&[vs])?;mint(base,None,SUPPLY)?;
 if *quote.key==WSOL{need(*qt.key==TOKEN&&decimals==9,Error::Mint)?;invoke(&Instruction{program_id:TOKEN,accounts:vec![AccountMeta::new(*qa.key,false)],data:vec![17]},&[qa.clone(),tok.clone()])?;if token_account(qa,quote.key,auth.key,qt.key)?==0{xfer_sol(auth,qa,sys,1,vs)?;invoke(&Instruction{program_id:TOKEN,accounts:vec![AccountMeta::new(*qa.key,false)],data:vec![17]},&[qa.clone(),tok.clone()])?;}}
 // DAMM takes one physical raw quote unit even though active tracked quote is zero.
 if *quote.key!=WSOL&&token_account(qa,quote.key,auth.key,qt.key)?==0{transfer_quote_seed(qt,payer_quote,quote,qa,payer,decimals)?;}
 need(*payer_quote.key==ata(payer.key,quote.key,qt.key),Error::Accounts)?;
 // DAMM initializes a lower-bound pool with one raw quote unit in its vault,
 // even though its active quote principal is zero. Seed SPL quotes atomically
 // from the creator; native SOL is wrapped from the setup subsidy above.
 if token_account(qa,quote.key,auth.key,qt.key)?==0 {
  need(token_account(payer_quote,quote.key,payer.key,qt.key)?>=1,Error::Insolvent)?;
  let mut transfer=vec![12];transfer.extend_from_slice(&1u64.to_le_bytes());transfer.push(decimals);
  invoke(&Instruction{program_id:*qt.key,accounts:vec![AccountMeta::new(*payer_quote.key,false),AccountMeta::new_readonly(*quote.key,false),AccountMeta::new(*qa.key,false),AccountMeta::new_readonly(*payer.key,true)],data:transfer},&[payer_quote.clone(),quote.clone(),qa.clone(),payer.clone(),qt.clone()])?;
 }
 let seed_quote=token_account(qa,quote.key,auth.key,qt.key)?;need(seed_quote>=1,Error::Insolvent)?;
 // Fixed time-scheduler base fee: zero periods/frequency/reduction, mode 0.
 // Dynamic fees disabled, no compounding, no alpha vault, timestamp activation.
 let mut data=vec![20,161,241,24,189,221,180,2];data.extend_from_slice(&FEE_NUMERATOR.to_le_bytes());data.extend_from_slice(&[0;19]);data.extend_from_slice(&[0;4]);
 data.extend_from_slice(&g.min.to_le_bytes());data.extend_from_slice(&g.max.to_le_bytes());data.push(0);data.extend_from_slice(&g.liquidity.to_le_bytes());data.extend_from_slice(&g.min.to_le_bytes());data.extend_from_slice(&[1,1,0]);
 let ai=vec![auth.clone(),nft.clone(),na.clone(),auth.clone(),da.clone(),pool.clone(),pos.clone(),base.clone(),quote.clone(),av.clone(),bv.clone(),ba.clone(),qa.clone(),tok.clone(),qt.clone(),tok22.clone(),sys.clone(),event.clone(),damm.clone(),ab.clone(),bb.clone()];
 let metas=ai.iter().enumerate().map(|(i,x)|if [1,2,3,5,6,9,10,11,12].contains(&i){AccountMeta::new(*x.key,i==1||i==3)}else{AccountMeta::new_readonly(*x.key,false)}).collect();
 invoke_signed(&Instruction{program_id:DAMM,accounts:metas,data},&ai,&[vs,ns])?;
 let s=DState{phase:0,bump:vb,decimals,creator:*payer.key,base:*base.key,quote:*quote.key,quote_program:*qt.key,pool:*pool.key,position:*pos.key,nft:*nft.key,nft_account:*na.key,g,price,created:now,rent_floor:floor,pump:Pubkey::default(),burned:0,migrated_quote:0,migrated_base:0,fees:0,index:0,graduation_fee_paid:0};
 venue(&s,auth,damm,da,pool,pos,nft,na,av,bv,event)?;
 {let pd=pool.try_borrow_data()?;need(u128at(&pd,360)?==g.liquidity&&u128at(&pd,456)?==g.min&&u64at(&pd,680)?==g.sale&&u64at(&pd,688)?==0,Error::Cpi)?;}
 need(token_account(ba,base.key,auth.key,&TOKEN)?==g.reserve&&token_account(qa,quote.key,auth.key,qt.key)?==seed_quote-1&&token_account(bv,quote.key,da.key,qt.key)?>=1&&token_account(av,base.key,da.key,&TOKEN)?==g.sale ,Error::Cpi)?;
 let retained=add(floor,MIGRATION_RENT)?;need(auth.lamports()>=retained,Error::Insolvent)?;xfer_sol(auth,payer,sys,auth.lamports()-retained,vs)?;
 s.save(state)
}
// Common DAMM withdrawal/fee account mapping. A concrete canonical entrypoint is
// the only CPI allowed; caller-supplied instruction bytes are never forwarded.
fn damm_position_cpi<'a>(auth:&AccountInfo<'a>,pool:&AccountInfo<'a>,pos:&AccountInfo<'a>,a_out:&AccountInfo<'a>,b_out:&AccountInfo<'a>,av:&AccountInfo<'a>,bv:&AccountInfo<'a>,base:&AccountInfo<'a>,quote:&AccountInfo<'a>,na:&AccountInfo<'a>,tok:&AccountInfo<'a>,qt:&AccountInfo<'a>,event:&AccountInfo<'a>,damm:&AccountInfo<'a>,da:&AccountInfo<'a>,data:Vec<u8>,withdraw:bool,seeds:&[&[u8]])->ProgramResult{
 let ai=vec![da.clone(),pool.clone(),pos.clone(),a_out.clone(),b_out.clone(),av.clone(),bv.clone(),base.clone(),quote.clone(),na.clone(),auth.clone(),tok.clone(),qt.clone(),event.clone(),damm.clone()];
 let metas=ai.iter().enumerate().map(|(i,x)|if [2,3,4,5,6].contains(&i)||(i==1&&withdraw){AccountMeta::new(*x.key,false)}else{AccountMeta::new_readonly(*x.key,i==10)}).collect();
 invoke_signed(&Instruction{program_id:DAMM,accounts:metas,data},&ai,&[seeds])
}
// Opcode 7: payer is permissionless; the chosen index only selects a fresh
// canonical PumpSwap address. Every economic amount is fixed in immutable state.
pub(super) fn migrate(p:&Pubkey,a:&[AccountInfo],d:&[u8])->ProgramResult{
 need(a.len()==31&&d.len()==2,Error::Accounts)?;
 let[payer,state,auth,base,ba,quote,qa,damm,da,dp,pos,nft,na,av,bv,de,pump,global,pool,lp,la,pa,pb,sys,tok,tok22,qt,associated,pe,treasury,tqa]=<&[AccountInfo;31]>::try_from(a).unwrap();
 let mut s=DState::load(p,state)?;fixed_accounts(p,&s,auth,base,ba,quote,qt)?;need(payer.is_signer,Error::Unauthorized)?;system_wallet(payer)?;
 program(sys,&system_program::id())?;program(tok,&TOKEN)?;program(tok22,&TOKEN22)?;program(associated,&ATA)?;program(pump,&PUMP)?;
 need(*global.key==GLOBAL&&global.owner==&PUMP&&*qa.key==ata(auth.key,quote.key,qt.key),Error::Accounts)?;
 need(*treasury.key==TREASURY&&*tqa.key==ata(&TREASURY,quote.key,qt.key),Error::Accounts)?;system_wallet(treasury)?;
 let fee=graduation_fee(s.g.quote)?;let net_quote=sub(s.g.quote,fee)?;need(fee>0&&net_quote>0,Error::Policy)?;
 let index:[u8;2]=d.try_into().unwrap();let expected=Pubkey::find_program_address(&[b"pool",&index,auth.key.as_ref(),base.key.as_ref(),quote.key.as_ref()],&PUMP).0;
 need(*pool.key==expected&&*lp.key==Pubkey::find_program_address(&[b"pool_lp_mint",pool.key.as_ref()],&PUMP).0&&*la.key==ata(auth.key,lp.key,&TOKEN22)&&*pa.key==ata(pool.key,base.key,&TOKEN)&&*pb.key==ata(pool.key,quote.key,qt.key)&&*pe.key==Pubkey::find_program_address(&[b"__event_authority"],&PUMP).0,Error::Accounts)?;
 if s.phase==2{need(s.pump==*pool.key&&s.index==u16::from_le_bytes(index)&&s.burned>0&&s.graduation_fee_paid==fee&&s.migrated_quote==net_quote&&s.migrated_base==s.g.reserve&&pool.owner==&PUMP,Error::State)?;return Ok(());}
 need(s.phase==0,Error::Phase)?;venue(&s,auth,damm,da,dp,pos,nft,na,av,bv,de)?;
 // The immutable upper sqrt-price gates graduation. Pool bookkeeping can retain
 // base rounding dust after ceil deposits and floor swap outputs; it is not
 // redeemable principal at this endpoint. Exact CPI balance deltas below still
 // require our position to withdraw zero base and precisely its quote budget.
 {let pd=dp.try_borrow_data()?;need(u128at(&pd,456)?==s.g.max&&u128at(&pd,360)?>=s.g.liquidity,Error::Phase)?;}
 for x in [pool,lp,la]{system_wallet(x)?;}
 let seeds:&[&[u8]]=&[b"damm-vault",base.key.as_ref(),&[s.bump]];
 // No relayer-dependent reserve access. A keeper may subsidize rent but can
 // neither choose payout amounts nor receive assets from the controller.
 xfer_sol(payer,auth,sys,add(s.rent_floor,MIGRATION_RENT)?.saturating_sub(auth.lamports()),&[])?;
 create_ata(auth,qa,auth,quote,sys,qt,associated,seeds)?;create_ata(auth,pa,pool,base,sys,tok,associated,seeds)?;create_ata(auth,pb,pool,quote,sys,qt,associated,seeds)?;create_ata(auth,tqa,treasury,quote,sys,qt,associated,seeds)?;
 need(token_account(pa,base.key,pool.key,&TOKEN)?==0&&token_account(pb,quote.key,pool.key,qt.key)?==0,Error::Policy)?;
 if *quote.key==WSOL{invoke(&Instruction{program_id:TOKEN,accounts:vec![AccountMeta::new(*qa.key,false)],data:vec![17]},&[qa.clone(),tok.clone()])?;}
 let treasury_before=token_account(tqa,quote.key,&TREASURY,qt.key)?;
 let before_a=token_account(ba,base.key,auth.key,&TOKEN)?;let before_b=token_account(qa,quote.key,auth.key,qt.key)?;need(before_a>=s.g.reserve,Error::Insolvent)?;
 let mut data=vec![80,85,209,72,24,206,177,108];data.extend_from_slice(&s.g.liquidity.to_le_bytes());data.extend_from_slice(&0u64.to_le_bytes());data.extend_from_slice(&s.g.quote.to_le_bytes());
 damm_position_cpi(auth,dp,pos,ba,qa,av,bv,base,quote,na,tok,qt,de,damm,da,data,true,seeds)?;
 need(token_account(ba,base.key,auth.key,&TOKEN)?==before_a&&token_account(qa,quote.key,auth.key,qt.key)?==add(before_b,s.g.quote)?&&u128at(&pos.try_borrow_data()?,152)?==0,Error::Cpi)?;
 // Graduation fee and pool creation are one atomic instruction. Principal is
 // fixed by the signed launch geometry; donations and trading fees are excluded.
 let mut fee_data=vec![12];fee_data.extend_from_slice(&fee.to_le_bytes());fee_data.push(s.decimals);
 invoke_signed(&Instruction{program_id:*qt.key,accounts:vec![AccountMeta::new(*qa.key,false),AccountMeta::new_readonly(*quote.key,false),AccountMeta::new(*tqa.key,false),AccountMeta::new_readonly(*auth.key,true)],data:fee_data},&[qa.clone(),quote.clone(),tqa.clone(),auth.clone(),qt.clone()],&[seeds])?;
 need(token_account(tqa,quote.key,&TREASURY,qt.key)?==add(treasury_before,fee)?&&token_account(qa,quote.key,auth.key,qt.key)?==add(before_b,net_quote)?,Error::Cpi)?;
 // Every reserved base token and the net quote principal seed PumpSwap.
 // No base tokens are burned or stranded by the graduation fee.
 let mut data=vec![233,146,209,142,207,104,64,188];data.extend_from_slice(&index);data.extend_from_slice(&s.g.reserve.to_le_bytes());data.extend_from_slice(&net_quote.to_le_bytes());data.extend_from_slice(&[0;32]);data.extend_from_slice(&[0;2]);data.extend_from_slice(&0u64.to_le_bytes());data.extend_from_slice(&[0;2]);
 let ai=vec![pool.clone(),global.clone(),auth.clone(),base.clone(),quote.clone(),lp.clone(),ba.clone(),qa.clone(),la.clone(),pa.clone(),pb.clone(),sys.clone(),tok22.clone(),tok.clone(),qt.clone(),associated.clone(),pe.clone(),pump.clone()];
 let metas=ai.iter().enumerate().map(|(i,x)|if [0,2,5,6,7,8,9,10].contains(&i){AccountMeta::new(*x.key,i==2)}else{AccountMeta::new_readonly(*x.key,false)}).collect();
 invoke_signed(&Instruction{program_id:PUMP,accounts:metas,data},&ai,&[seeds])?;
 need(pool.owner==&PUMP&&lp.owner==&TOKEN22,Error::Cpi)?;
 need(token_account(ba,base.key,auth.key,&TOKEN)?==sub(before_a,s.g.reserve)?&&token_account(qa,quote.key,auth.key,qt.key)?==before_b&&token_account(pa,base.key,pool.key,&TOKEN)?==s.g.reserve&&token_account(pb,quote.key,pool.key,qt.key)?==net_quote,Error::Cpi)?;
 {let pd=pool.try_borrow_data()?;need(pd.len()>=271&&pd[..8]==POOL_DISC&&keyat(&pd,11)?==*auth.key&&keyat(&pd,43)?==s.base&&keyat(&pd,75)?==s.quote&&keyat(&pd,107)?==*lp.key&&keyat(&pd,139)?==*pa.key&&keyat(&pd,171)?==*pb.key&&pd[211..243]==[0;32]&&pd[243]==0&&pd[244]==0&&u128at(&pd,245)?==0&&u64at(&pd,261)?==0&&pd[269]==0&&pd[270]==0,Error::Cpi)?;}
 let received=token_account(la,lp.key,auth.key,&TOKEN22)?;let minimum=isqrt((s.g.reserve as u128).checked_mul(net_quote as u128).ok_or(err(Error::Math))?);
 need(minimum>1000&&received>=minimum-1000&&u64at(&lp.try_borrow_data()?,36)?==received,Error::Cpi)?;
 token_ix(tok22,8,received,&[la.clone(),lp.clone(),auth.clone()],seeds)?;
 need(token_account(la,lp.key,auth.key,&TOKEN22)?==0&&u64at(&lp.try_borrow_data()?,36)?==0,Error::Cpi)?;
 need(auth.lamports()>=s.rent_floor,Error::Insolvent)?;
 s.phase=2;s.pump=*pool.key;s.burned=received;s.migrated_quote=net_quote;s.migrated_base=s.g.reserve;s.graduation_fee_paid=fee;s.index=u16::from_le_bytes(index);s.save(state)
}
// Opcode 8: claim the controller-owned position's quote fees to the fixed
// protocol treasury. It cannot claim principal, arbitrary NFTs, or creator fees.
pub(super) fn claim_fees(p:&Pubkey,a:&[AccountInfo],d:&[u8])->ProgramResult{
 need(a.len()==21&&d.is_empty(),Error::Accounts)?;
 let[payer,state,auth,base,ba,quote,tqa,damm,da,pool,pos,nft,na,av,bv,event,treasury,sys,tok,qt,associated]=<&[AccountInfo;21]>::try_from(a).unwrap();
 let mut s=DState::load(p,state)?;need(s.phase==0||s.phase==2,Error::Phase)?;fixed_accounts(p,&s,auth,base,ba,quote,qt)?;venue(&s,auth,damm,da,pool,pos,nft,na,av,bv,event)?;
 program(sys,&system_program::id())?;program(tok,&TOKEN)?;program(associated,&ATA)?;need(payer.is_signer&&*treasury.key==TREASURY&&*tqa.key==ata(treasury.key,quote.key,qt.key),Error::Accounts)?;
 create_ata(payer,tqa,treasury,quote,sys,qt,associated,&[])?;
 let a_before=token_account(ba,base.key,auth.key,&TOKEN)?;let b_before=token_account(tqa,quote.key,treasury.key,qt.key)?;
 let principal_before={let pd=pool.try_borrow_data()?;(u128at(&pd,360)?,u128at(&pd,456)?,u64at(&pd,680)?,u64at(&pd,688)?)};
 let seeds:&[&[u8]]=&[b"damm-vault",base.key.as_ref(),&[s.bump]];
 damm_position_cpi(auth,pool,pos,ba,tqa,av,bv,base,quote,na,tok,qt,event,damm,da,vec![180,38,154,17,133,33,162,211],false,seeds)?;
 let principal_after={let pd=pool.try_borrow_data()?;(u128at(&pd,360)?,u128at(&pd,456)?,u64at(&pd,680)?,u64at(&pd,688)?)};
 need(principal_before==principal_after&&token_account(ba,base.key,auth.key,&TOKEN)?==a_before,Error::Cpi)?;
 let claimed=sub(token_account(tqa,quote.key,treasury.key,qt.key)?,b_before)?;s.fees=add(s.fees,claimed)?;s.save(state)
}
