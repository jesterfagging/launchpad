//! Integer-only policy calculations. U256 is deliberately local: no floating point,
//! unchecked narrowing, external math program, or caller-controlled economics.
use super::{err, need, Error, ProgramError, SUPPLY};
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
    let lo=Wide::high(20_000_000_000u128.checked_mul(scale).ok_or(err(Error::Math))?).div(den)?.0.sqrt();
    let hi=Wide::high(50_000_000_000u128.checked_mul(scale).ok_or(err(Error::Math))?).div(den)?.0.sqrt();
    need(lo>=4_295_048_016&&hi<=79_226_673_521_066_979_257_578_248_091&&hi>lo,Error::Policy)?;
    let budget=floor(Wide::mul(SUPPLY as u128,hi),Wide::of(lo.checked_add(hi).ok_or(err(Error::Math))?))?;
    let product=Wide::mul(lo,hi);let delta=hi-lo;
    let liquidity=floor(product.times(budget)?,Wide::of(delta))?;
    need(liquidity>0,Error::Math)?;
    let sale=small(ceil(Wide::mul(liquidity,delta),product)?)?;
    let reserve=SUPPLY.checked_sub(sale).ok_or(err(Error::Math))?;
    let quote=small(floor(Wide::mul(liquidity,delta),Wide::high(1))?)?;
    need(sale>0&&reserve>0&&quote>0,Error::Policy)?;
    // Graduation reserve ratio must match DAMM endpoint within five basis points.
    let actual=Wide::high(quote as u128);let expected=Wide::mul(hi,hi).times(reserve as u128)?;
    let difference=if actual.cmp(&expected)==core::cmp::Ordering::Less{expected.subtract(actual)}else{actual.subtract(expected)};
    need(difference.times(10_000)?.cmp(&expected.times(5)?)!=core::cmp::Ordering::Greater,Error::Policy)?;
    Ok(Geometry{min:lo,max:hi,liquidity,sale,reserve,quote})
}
#[cfg(test)]
mod tests{
 use super::*;
 #[test]fn wide_division(){for(a,b)in[(1,3),(u64::MAX as u128,71),(u128::MAX,u128::MAX-1),(u128::MAX,1)]{let n=Wide::mul(a,b);assert_eq!(n.div(Wide::of(b)).unwrap().0.narrow().unwrap(),a);}assert_eq!(Wide::high(1).sqrt(),1u128<<64);}
 #[test]fn policy_sol_and_usdc(){for(p,d)in[(150_000_000,9),(1_000_000,6),(100_000_000_000,8),(1,6)]{let g=geometry(p,d).unwrap();assert_eq!(g.sale+g.reserve,SUPPLY);assert!(g.max>g.min&&g.quote>0);assert!(g.reserve>387_000_000_000_000&&g.reserve<388_000_000_000_000);}assert!(geometry(0,9).is_err());assert!(geometry(1,19).is_err());}
 // Fixed outputs from @meteora-ag/cp-amm-sdk 1.4.10 cover coarse decimals,
 // tiny quote USD values, 18 decimals and references beyond JS safe integers.
 #[test]fn official_sdk_geometry_vectors(){
 let cases=[
(1000000,6,Geometry{min:82496347424711897,max:130438178253327822,liquidity:137493912374519628439785053979218,sale:612574113277206,reserve:387425886722794,quote:19371294336}),
(118170000,9,Geometry{min:239983345068544928,max:379446985461369515,liquidity:399972241780907632522324097680253,sale:612574113277206,reserve:387425886722794,quote:163927344809}),
(100000000000,8,Geometry{min:2608763565066556,max:4124817371235594,liquidity:4347939275110920643072482199858,sale:612574113277206,reserve:387425886722794,quote:19371294}),
(250125000,6,Geometry{min:5216223237290027,max:8247573106866718,liquidity:8693705395483365264855181902299,sale:612574113277206,reserve:387425886722794,quote:77446454}),
(1000,3,Geometry{min:82496347424711897,max:130438178253327822,liquidity:137493912374519628439785053979218,sale:612574113277206,reserve:387425886722794,quote:19371294336}),
(1,6,Geometry{min:82496347424711897175,max:130438178253327822123,liquidity:137493912374519629010237570450985898,sale:612574113277206,reserve:387425886722794,quote:19371294336139627}),
(12345678,12,Geometry{min:23478873048232822693,max:37123357863178057321,liquidity:39131455080387981009587653832014203,sale:612574113277206,reserve:387425886722794,quote:1569074969891457}),
(100000000000,18,Geometry{min:260876356506655644246,max:412481737123559485879,liquidity:434793927511092109174381598191301880,sale:612574113277206,reserve:387425886722794,quote:193712943361396274}),
(1000000,0,Geometry{min:82496347424711,max:130438178253327,liquidity:137493912374517276333501537578,sale:612574113277207,reserve:387425886722793,quote:19371}),
(1000000000000000001,18,Geometry{min:82496347424711897,max:130438178253327822,liquidity:137493912374519628439785053979218,sale:612574113277206,reserve:387425886722794,quote:19371294336}),
];
 for(price,decimals,expected)in cases{assert_eq!(geometry(price,decimals).unwrap(),expected);}
 for(price,decimals)in[(10_000_000_000,0),(1,18),(100_000,18),(u64::MAX,0)]{assert!(geometry(price,decimals).is_err());}
 }

}
