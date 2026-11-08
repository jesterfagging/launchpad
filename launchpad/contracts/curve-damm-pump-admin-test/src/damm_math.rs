//! Integer-only policy calculations. U256 is deliberately local: no floating point,
//! unchecked narrowing, external math program, or caller-controlled economics.
use super::{err, need, Error, ProgramError, SUPPLY};
pub(super) const GRADUATION_FEE_NUMERATOR: u64 = 322_369_073;
pub(super) const GRADUATION_FEE_DENOMINATOR: u64 = 1_000_000_000;
pub(super) fn graduation_fee(quote: u64) -> Result<u64, ProgramError> {
 small(floor(Wide::mul(quote as u128, GRADUATION_FEE_NUMERATOR as u128), Wide::of(GRADUATION_FEE_DENOMINATOR as u128))?)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Wide(pub [u64; 4]);
impl Wide {
    pub fn of(n: u128) -> Self { Self([n as u64, (n >> 64) as u64, 0, 0]) }
    pub fn high(n: u128) -> Self { Self([0, 0, n as u64, (n >> 64) as u64]) }
    pub fn cmp(&self, b: &Self) -> core::cmp::Ordering {
        for i in (0..4).rev() { let c=self.0[i].cmp(&b.0[i]); if c!=core::cmp::Ordering::Equal{return c;} }
        core::cmp::Ordering::Equal
    }
    fn subtract(self, b: Self) -> Self {
        let mut out=[0u64;4]; let mut borrow=false;
        for i in 0..4 { let (a,c)=self.0[i].overflowing_sub(b.0[i]); let (v,d)=a.overflowing_sub(borrow as u64);out[i]=v;borrow=c||d; }
        Self(out)
    }
    fn shift_bit(self, bit: bool) -> (Self,bool) {
        let mut out=[0u64;4]; let overflow=self.0[3]>>63!=0;
        for i in (0..4).rev(){out[i]=(self.0[i]<<1)|if i>0{self.0[i-1]>>63}else{bit as u64};}
        (Self(out),overflow)
    }
    pub fn mul(a:u128,b:u128)->Self {
        // Full 128x128 product fits exactly in 256 bits.
        Self::of(a).times(b).expect("128 bit product fits U256")
    }
    pub fn times(self,b:u128)->Result<Self,ProgramError>{
        let rhs=[b as u64,(b>>64)as u64];let mut out=[0u64;6];
        for i in 0..4 {let mut carry=0u128;for j in 0..2{
            let n=(self.0[i]as u128)*(rhs[j]as u128)+(out[i+j]as u128)+carry;
            out[i+j]=n as u64;carry=n>>64;
        }let mut k=i+2;while carry>0 {need(k<6,Error::Math)?;let n=out[k]as u128+carry;out[k]=n as u64;carry=n>>64;k+=1;}}
        need(out[4]==0&&out[5]==0,Error::Math)?;Ok(Self([out[0],out[1],out[2],out[3]]))
    }
    pub fn div(self,d:Self)->Result<(Self,Self),ProgramError>{
        need(d!=Self::of(0),Error::Math)?;let mut q=Self::of(0);let mut r=Self::of(0);
        for i in (0..256).rev(){let (next,overflow)=r.shift_bit(((self.0[i/64]>>(i%64))&1)!=0);r=next;
            if overflow||r.cmp(&d)!=core::cmp::Ordering::Less {r=r.subtract(d);q.0[i/64]|=1u64<<(i%64);}}
        Ok((q,r))
    }
    pub fn narrow(self)->Result<u128,ProgramError>{need(self.0[2]==0&&self.0[3]==0,Error::Math)?;Ok(self.0[0]as u128|((self.0[1]as u128)<<64))}
    pub fn sqrt(self)->u128 {let mut root=0u128;for i in (0..128).rev(){let c=root|(1u128<<i);if Self::mul(c,c).cmp(&self)!=core::cmp::Ordering::Greater{root=c;}}root}
}
fn floor(n:Wide,d:Wide)->Result<u128,ProgramError>{n.div(d)?.0.narrow()}
fn ceil(n:Wide,d:Wide)->Result<u128,ProgramError>{let(q,r)=n.div(d)?;q.narrow()?.checked_add((r!=Wide::of(0))as u128).ok_or(err(Error::Math))}
fn small(n:u128)->Result<u64,ProgramError>{u64::try_from(n).map_err(|_|err(Error::Math))}
#[derive(Debug,Clone,Copy,PartialEq,Eq)]
pub(super) struct Geometry {pub min:u128,pub max:u128,pub liquidity:u128,pub sale:u64,pub reserve:u64,pub quote:u64}
pub(super) fn geometry(price:u64,decimals:u8)->Result<Geometry,ProgramError>{
    need(price>0&&decimals<=18,Error::Policy)?;
    let scale=10u128.checked_pow(decimals as u32).ok_or(err(Error::Math))?;
    let den=Wide::mul(price as u128,SUPPLY as u128);
    let lo=Wide::high(50_000_000u128.checked_mul(scale).ok_or(err(Error::Math))?).div(den)?.0.sqrt();
    let hi=Wide::high(100_000_000u128.checked_mul(scale).ok_or(err(Error::Math))?).div(den)?.0.sqrt();
    need(lo>=4_295_048_016&&hi<=79_226_673_521_066_979_257_578_248_091&&hi>lo,Error::Policy)?;
    let fee_den=GRADUATION_FEE_DENOMINATOR as u128;
    let retained=(GRADUATION_FEE_DENOMINATOR-GRADUATION_FEE_NUMERATOR) as u128;
    let budget_den=hi.checked_mul(fee_den).and_then(|n|lo.checked_mul(retained).and_then(|m|n.checked_add(m))).ok_or(err(Error::Math))?;
    let budget=floor(Wide::mul(SUPPLY as u128,hi).times(fee_den)?,Wide::of(budget_den))?;
    let product=Wide::mul(lo,hi);let delta=hi-lo;
    let liquidity=floor(product.times(budget)?,Wide::of(delta))?;
    need(liquidity>0,Error::Math)?;
    let sale=small(ceil(Wide::mul(liquidity,delta),product)?)?;
    let reserve=SUPPLY.checked_sub(sale).ok_or(err(Error::Math))?;
    let quote=small(floor(Wide::mul(liquidity,delta),Wide::high(1))?)?;
    need(sale>0&&reserve>0&&quote>0,Error::Policy)?;
    // Graduation reserve ratio must match DAMM endpoint within five basis points.
    let net_quote=quote.checked_sub(graduation_fee(quote)?).ok_or(err(Error::Math))?;
    let actual=Wide::high(net_quote as u128);let expected=Wide::mul(hi,hi).times(reserve as u128)?;
    let difference=if actual.cmp(&expected)==core::cmp::Ordering::Less{expected.subtract(actual)}else{actual.subtract(expected)};
    need(difference.times(10_000)?.cmp(&expected.times(5)?)!=core::cmp::Ordering::Greater,Error::Policy)?;
    Ok(Geometry{min:lo,max:hi,liquidity,sale,reserve,quote})
}
#[cfg(test)]
mod tests {
 use super::*;
 include!("math_test_vectors.rs");
 #[test]fn micro_policy_boundaries(){
  for (price,decimals) in [(150_000_000,9),(1_000_000,6),(100_000_000_000,8),(1,6)] {
   let g=geometry(price,decimals).unwrap();
   assert_eq!(g.sale+g.reserve,SUPPLY);
   assert!(g.reserve>323_000_000_000_000&&g.reserve<324_000_000_000_000);
  }
  for (price,decimals) in [(0,9),(1,19),(1_000_000,0),(10_000_000_000,0),(u64::MAX,0)] {
   assert!(geometry(price,decimals).is_err());
  }
 }
 #[test]fn fee_floor_is_exact(){
  for gross in [0u64,1,3,4,47_804_700,22_135_943_622,u64::MAX] {
   let expected=((gross as u128)*322_369_073u128/1_000_000_000u128)as u64;
   assert_eq!(graduation_fee(gross).unwrap(),expected);
  }
 }
 #[test]fn wide_division(){
  for(a,b)in[(1,3),(u64::MAX as u128,71),(u128::MAX,u128::MAX-1),(u128::MAX,1)] {
   assert_eq!(Wide::mul(a,b).div(Wide::of(b)).unwrap().0.narrow().unwrap(),a);
  }
  assert_eq!(Wide::high(1).sqrt(),1u128<<64);
 }
}
